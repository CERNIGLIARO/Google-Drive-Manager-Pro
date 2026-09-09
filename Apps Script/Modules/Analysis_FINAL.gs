/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Analysis.gs
 * Version : 2.3.0
 *
 * STABILISATION "GROS DRIVE" / CONTINUATION TOKENS
 * --------------------------------------
 * Cette version corrige les blocages de scan ET les risques de saturation du stockage :
 * - chaque gros dossier est découpé en petits lots avec continuationToken DriveApp ;
 * - une tâche Analysis ne garde jamais le moteur plusieurs minutes sur un seul dossier ;
 * - le résultat détaillé de l'analyse n'est plus stocké avec la Queue/State/Logs dans ScriptProperties ;
 * - il utilise DocumentProperties (avec repli ScriptProperties si nécessaire) ;
 * - les listes détaillées sont limitées ;
 * - la taille JSON est automatiquement compactée avant sauvegarde ;
 * - les erreurs de lecture d'un fichier ou dossier sont isolées et n'arrêtent plus toute l'analyse ;
 * - les anciennes données Analysis stockées dans ScriptProperties sont nettoyées au démarrage ;
 * - une fonction d'urgence permet de supprimer proprement un ancien job bloqué.
 *
 * IMPORTANT
 * ---------
 * - Lecture seule : aucun fichier Google Drive n'est déplacé, renommé ou supprimé.
 * - Compatible avec l'architecture existante :
 *   Config.gs / Utils.gs / Logger.gs / State.gs / Queue.gs / Engine.gs.
 **************************************************************************************************/
'use strict';


const GDM_Analysis = Object.freeze({

  RESULT_PREFIX_: 'GDMV2_ANALYSIS_RESULT_',

  // On garde une marge confortable sous la limite globale de 500 Ko de PropertiesService.
  MAX_RESULT_JSON_CHARS_: 180000,

  // Limites de détails : les compteurs restent complets, seules les listes affichables sont tronquées.
  MAX_DETAIL_ROWS_: 250,
  MAX_ERROR_ROWS_: 100,
  MAX_MAP_KEYS_: 300,

  // Scanner un gros dossier en petites portions. Le batch est volontairement plafonné
  // pour que chaque tâche rende la main au moteur bien avant la limite Apps Script.
  PHASE_FILES_: 'FILES',
  PHASE_FOLDERS_: 'FOLDERS',
  MAX_BATCH_SIZE_: 100,
  TASK_SOFT_LIMIT_MS_: 40000,


  /************************************************************************************************
   * LANCER UNE ANALYSE
   ************************************************************************************************/
  start: function(options) {

    options = options || {};

    // Nettoyage des anciens résultats Analysis afin de ne pas remplir le magasin de propriétés.
    // Cela ne touche à AUCUN fichier Drive.
    try {
      this.cleanupAllAnalysisResultStorage_();
    } catch (ignoredCleanup) {}

    var rootFolder = GDM_Utils.getFolderOrRoot(
      options.folderId ||
      options.sourceFolderId ||
      ''
    );

    var sourceFolderId = rootFolder.getId();

    var sourceFolderName =
      sourceFolderId === DriveApp.getRootFolder().getId()
        ? GDM_Config.get('APP.ROOT_LABEL', 'Mon Drive')
        : rootFolder.getName();

    var recursive =
      typeof options.recursive === 'undefined'
        ? GDM_Config.get('ANALYSIS.INCLUDE_SUBFOLDERS_DEFAULT', true)
        : GDM_Utils.toBoolean(options.recursive, true);

    var largeFileMB = Math.max(
      1,
      GDM_Utils.toNumber(
        options.largeFileMB,
        GDM_Config.get('ANALYSIS.LARGE_FILE_MB', 100)
      )
    );

    var oldFileDays = Math.max(
      1,
      GDM_Utils.toInteger(
        options.oldFileDays,
        GDM_Config.get('ANALYSIS.OLD_FILE_DAYS', 365)
      )
    );

    var state = GDM_State.create({
      module: GDM_MODULES.ANALYSIS,
      action:
        sourceFolderId === DriveApp.getRootFolder().getId()
          ? GDM_ACTIONS.ANALYZE_DRIVE
          : GDM_ACTIONS.ANALYZE_FOLDER,

      source: {
        id: sourceFolderId,
        name: sourceFolderName
      },

      parameters: {
        recursive: recursive,
        largeFileMB: largeFileMB,
        oldFileDays: oldFileDays
      },

      totalKnown: 1,
      setCurrent: true,
      message: 'Analyse préparée.'
    });

    var jobId = state.jobId;

    this.initializeResult_(jobId, {
      source: {
        id: sourceFolderId,
        name: sourceFolderName
      },
      recursive: recursive,
      largeFileMB: largeFileMB,
      oldFileDays: oldFileDays
    });

    GDM_Queue.create(jobId);

    GDM_Queue.add(jobId, {
      module: GDM_MODULES.ANALYSIS,
      action: GDM_ACTIONS.ANALYZE_FOLDER,
      itemId: sourceFolderId,
      itemName: sourceFolderName,
      payload: {
        folderId: sourceFolderId,
        folderName: sourceFolderName,
        recursive: recursive,
        depth: 0,
        phase: this.PHASE_FILES_,
        continuationToken: '',
        folderCounted: false,
        hasAnyFile: false,
        hasAnyFolder: false
      },

      // Une tâche de scan est courte et ne doit pas être répétée en boucle.
      maxRetries: 1
    });

    GDM_State.setTotalKnown(jobId, 1);

    try {
      GDM_Logger.scanStarted(jobId, {
        module: GDM_MODULES.ANALYSIS,
        action: state.action,
        itemId: sourceFolderId,
        itemName: sourceFolderName,
        message: 'Analyse de "' + sourceFolderName + '" démarrée.'
      });
    } catch (ignoredLog) {}

    var asyncMode =
      typeof options.async === 'undefined'
        ? true
        : GDM_Utils.toBoolean(options.async, true);

    var engineResult = GDM_Engine.start(jobId, {
      async: asyncMode
    });

    return {
      ok: true,
      jobId: jobId,
      source: {
        id: sourceFolderId,
        name: sourceFolderName
      },
      recursive: recursive,
      state: GDM_State.getSummary(jobId),
      queue: GDM_Queue.getMeta(jobId),
      engine: engineResult
    };
  },


  /************************************************************************************************
   * ROUTAGE D'UNE TÂCHE
   ************************************************************************************************/
  processTask: function(task, context) {

    task = task || {};
    context = context || {};

    switch (task.action) {

      case GDM_ACTIONS.ANALYZE_FOLDER:
        return this.processFolderTask_(task, context);

      case GDM_ACTIONS.ANALYZE_ITEM:
        return this.processFileTask_(task, context);

      default:
        return {
          ok: true,
          skipped: true,
          message: 'Analysis : action inconnue ignorée : ' +
            GDM_Utils.toString(task.action)
        };
    }
  },


  /************************************************************************************************
   * ANALYSE D'UN DOSSIER
   *
   * PRINCIPE :
   * - toutes les erreurs Drive sont capturées localement ;
   * - le dossier fautif est marqué comme traité/ignoré au lieu de repartir en boucle ;
   * - les sous-dossiers valides deviennent des tâches séparées.
   ************************************************************************************************/
  processFolderTask_: function(task, context) {

    var jobId = task.jobId || context.jobId;
    var payload = task.payload || {};

    var folderId = GDM_Utils.requireString(
      payload.folderId || task.itemId,
      'folderId'
    );

    var state = GDM_State.require(jobId);
    var parameters = state.parameters || {};

    var recursive =
      typeof payload.recursive === 'undefined'
        ? GDM_Utils.toBoolean(parameters.recursive, true)
        : GDM_Utils.toBoolean(payload.recursive, true);

    var phase =
      GDM_Utils.trim(payload.phase || this.PHASE_FILES_).toUpperCase();

    if (
      phase !== this.PHASE_FILES_ &&
      phase !== this.PHASE_FOLDERS_
    ) {
      phase = this.PHASE_FILES_;
    }

    var result = this.getResult(jobId);

    if (!result) {
      result = this.initializeResult_(jobId, {
        source: state.source || {},
        recursive: recursive,
        largeFileMB: parameters.largeFileMB,
        oldFileDays: parameters.oldFileDays
      });
    }

    var folder;

    try {
      folder = DriveApp.getFolderById(folderId);
    } catch (folderAccessError) {

      this.addError_(result, folderAccessError, {
        itemId: folderId,
        itemName: task.itemName || '',
        type: 'FOLDER_ACCESS'
      });

      result.updatedAt = GDM_Utils.nowIso();
      this.saveResultSafely_(jobId, result);

      return {
        ok: true,
        skipped: true,
        message: 'Dossier inaccessible ignoré : ' +
          (task.itemName || folderId)
      };
    }

    var folderName =
      this.safeGetName_(folder) ||
      payload.folderName ||
      task.itemName ||
      folderId;

    /*
     * Un dossier logique est compté une seule fois.
     * Les tâches de continuation portent folderCounted=true.
     */
    if (payload.folderCounted !== true) {
      result.totals.folders++;
      payload.folderCounted = true;
    }

    if (phase === this.PHASE_FILES_) {
      return this.processFolderFilesPhase_(
        jobId,
        task,
        folder,
        folderName,
        payload,
        recursive,
        result
      );
    }

    return this.processFolderFoldersPhase_(
      jobId,
      task,
      folder,
      folderName,
      payload,
      recursive,
      result
    );
  },


  /************************************************************************************************
   * PHASE FILES
   *
   * Lit au maximum MAX_BATCH_SIZE_ fichiers ET s'arrête après TASK_SOFT_LIMIT_MS_.
   * Si le dossier contient encore des fichiers, on sauvegarde le continuationToken et la
   * prochaine tâche reprend exactement au même endroit.
   ************************************************************************************************/
  processFolderFilesPhase_: function(
    jobId,
    task,
    folder,
    folderName,
    payload,
    recursive,
    result
  ) {

    var iterator;

    try {
      iterator = payload.continuationToken
        ? DriveApp.continueFileIterator(payload.continuationToken)
        : folder.getFiles();
    } catch (iteratorOpenError) {

      this.addError_(result, iteratorOpenError, {
        itemId: folder.getId(),
        itemName: folderName,
        type: 'FILES_ITERATOR_OPEN'
      });

      result.updatedAt = GDM_Utils.nowIso();
      this.saveResultSafely_(jobId, result);

      return {
        ok: true,
        skipped: true,
        message: 'Impossible de poursuivre les fichiers du dossier : ' + folderName
      };
    }

    var batchSize = this.getBatchSize_();
    var startedAtMs = Date.now();
    var scanned = 0;
    var localErrors = 0;
    var hasAnyFile = payload.hasAnyFile === true;
    var folderId = folder.getId();

    while (
      scanned < batchSize &&
      (Date.now() - startedAtMs) < this.TASK_SOFT_LIMIT_MS_
    ) {

      var hasNext = false;

      try {
        hasNext = iterator.hasNext();
      } catch (hasNextError) {

        this.addError_(result, hasNextError, {
          itemId: folderId,
          itemName: folderName,
          type: 'FILES_HAS_NEXT'
        });

        localErrors++;
        break;
      }

      if (!hasNext) {
        break;
      }

      var file;

      try {
        file = iterator.next();
      } catch (nextError) {

        this.addError_(result, nextError, {
          itemId: folderId,
          itemName: folderName,
          type: 'FILE_NEXT'
        });

        localErrors++;
        break;
      }

      scanned++;
      hasAnyFile = true;

      try {
        this.analyzeFile_(result, file, folder);
      } catch (fileError) {

        this.addError_(result, fileError, {
          itemId: this.safeGetId_(file),
          itemName: this.safeGetName_(file),
          folderId: folderId,
          folderName: folderName,
          type: 'FILE_ANALYSIS'
        });

        localErrors++;
      }
    }

    var hasMoreFiles = false;

    try {
      hasMoreFiles = iterator.hasNext();
    } catch (remainingError) {

      this.addError_(result, remainingError, {
        itemId: folderId,
        itemName: folderName,
        type: 'FILES_REMAINING'
      });

      localErrors++;
    }

    var nextTasks = [];

    if (hasMoreFiles) {

      var token = '';

      try {
        token = iterator.getContinuationToken();
      } catch (tokenError) {

        this.addError_(result, tokenError, {
          itemId: folderId,
          itemName: folderName,
          type: 'FILE_CONTINUATION_TOKEN'
        });

        result.updatedAt = GDM_Utils.nowIso();
        this.saveResultSafely_(jobId, result);

        return {
          ok: true,
          skipped: true,
          message: 'Continuation impossible pour les fichiers du dossier : ' + folderName
        };
      }

      nextTasks.push(
        this.buildScanTask_({
          folderId: folderId,
          folderName: folderName,
          recursive: recursive,
          depth: payload.depth,
          phase: this.PHASE_FILES_,
          continuationToken: token,
          folderCounted: true,
          hasAnyFile: hasAnyFile,
          hasAnyFolder: payload.hasAnyFolder === true
        })
      );

    } else {

      /*
       * Même en mode non récursif, la phase FOLDERS est utile pour savoir si un
       * dossier sans fichiers est réellement vide. Elle ne crée simplement pas
       * de tâches enfants lorsque recursive=false.
       */
      if (
        recursive ||
        GDM_Config.get('ANALYSIS.DETECT_EMPTY_FOLDERS', true)
      ) {

        nextTasks.push(
          this.buildScanTask_({
            folderId: folderId,
            folderName: folderName,
            recursive: recursive,
            depth: payload.depth,
            phase: this.PHASE_FOLDERS_,
            continuationToken: '',
            folderCounted: true,
            hasAnyFile: hasAnyFile,
            hasAnyFolder: payload.hasAnyFolder === true
          })
        );
      }
    }

    result.updatedAt = GDM_Utils.nowIso();
    this.saveResultSafely_(jobId, result);

    var added = this.addUniqueTasksAndIncreaseTotal_(
      jobId,
      nextTasks
    );

    return {
      ok: true,
      skipped: false,
      message:
        'Fichiers analysés : ' +
        folderName +
        ' (' +
        scanned +
        ' dans ce lot' +
        (hasMoreFiles ? ', suite planifiée' : '') +
        ')',
      data: {
        folderId: folderId,
        phase: this.PHASE_FILES_,
        scanned: scanned,
        errors: localErrors,
        continuation: hasMoreFiles,
        tasksAdded: added
      }
    };
  },


  /************************************************************************************************
   * PHASE FOLDERS
   *
   * Parcourt les sous-dossiers par petits lots. Chaque sous-dossier devient une tâche Analysis
   * autonome. Un très gros nombre de sous-dossiers est également repris par continuationToken.
   ************************************************************************************************/
  processFolderFoldersPhase_: function(
    jobId,
    task,
    folder,
    folderName,
    payload,
    recursive,
    result
  ) {

    var iterator;

    try {
      iterator = payload.continuationToken
        ? DriveApp.continueFolderIterator(payload.continuationToken)
        : folder.getFolders();
    } catch (iteratorOpenError) {

      this.addError_(result, iteratorOpenError, {
        itemId: folder.getId(),
        itemName: folderName,
        type: 'FOLDERS_ITERATOR_OPEN'
      });

      result.updatedAt = GDM_Utils.nowIso();
      this.saveResultSafely_(jobId, result);

      return {
        ok: true,
        skipped: true,
        message: 'Impossible de poursuivre les sous-dossiers : ' + folderName
      };
    }

    var batchSize = this.getBatchSize_();
    var startedAtMs = Date.now();
    var scannedFolders = 0;
    var localErrors = 0;
    var folderId = folder.getId();

    var hasAnyFile = payload.hasAnyFile === true;
    var hasAnyFolder = payload.hasAnyFolder === true;
    var nextTasks = [];

    while (
      scannedFolders < batchSize &&
      (Date.now() - startedAtMs) < this.TASK_SOFT_LIMIT_MS_
    ) {

      var hasNext = false;

      try {
        hasNext = iterator.hasNext();
      } catch (hasNextError) {

        this.addError_(result, hasNextError, {
          itemId: folderId,
          itemName: folderName,
          type: 'FOLDERS_HAS_NEXT'
        });

        localErrors++;
        break;
      }

      if (!hasNext) {
        break;
      }

      var child;

      try {
        child = iterator.next();
      } catch (nextError) {

        this.addError_(result, nextError, {
          itemId: folderId,
          itemName: folderName,
          type: 'FOLDER_NEXT'
        });

        localErrors++;
        break;
      }

      scannedFolders++;
      hasAnyFolder = true;

      if (!recursive) {
        continue;
      }

      try {
        nextTasks.push(
          this.buildScanTask_({
            folderId: child.getId(),
            folderName: child.getName(),
            recursive: true,
            depth:
              Math.max(
                0,
                GDM_Utils.toInteger(payload.depth, 0)
              ) + 1,
            phase: this.PHASE_FILES_,
            continuationToken: '',
            folderCounted: false,
            hasAnyFile: false,
            hasAnyFolder: false
          })
        );
      } catch (childInfoError) {

        this.addError_(result, childInfoError, {
          itemId: this.safeGetId_(child),
          itemName: this.safeGetName_(child),
          folderId: folderId,
          folderName: folderName,
          type: 'CHILD_FOLDER_INFO'
        });

        localErrors++;
      }
    }

    var hasMoreFolders = false;

    try {
      hasMoreFolders = iterator.hasNext();
    } catch (remainingError) {

      this.addError_(result, remainingError, {
        itemId: folderId,
        itemName: folderName,
        type: 'FOLDERS_REMAINING'
      });

      localErrors++;
    }

    if (hasMoreFolders) {

      var token = '';

      try {
        token = iterator.getContinuationToken();
      } catch (tokenError) {

        this.addError_(result, tokenError, {
          itemId: folderId,
          itemName: folderName,
          type: 'FOLDER_CONTINUATION_TOKEN'
        });

        result.updatedAt = GDM_Utils.nowIso();
        this.saveResultSafely_(jobId, result);

        return {
          ok: true,
          skipped: true,
          message: 'Continuation impossible pour les sous-dossiers : ' + folderName
        };
      }

      nextTasks.push(
        this.buildScanTask_({
          folderId: folderId,
          folderName: folderName,
          recursive: recursive,
          depth: payload.depth,
          phase: this.PHASE_FOLDERS_,
          continuationToken: token,
          folderCounted: true,
          hasAnyFile: hasAnyFile,
          hasAnyFolder: hasAnyFolder
        })
      );

    } else {

      if (
        GDM_Config.get('ANALYSIS.DETECT_EMPTY_FOLDERS', true) &&
        !hasAnyFile &&
        !hasAnyFolder
      ) {

        result.counters.emptyFolders++;

        this.pushLimited_(
          result.emptyFolders,
          {
            id: folderId,
            name: folderName,
            url: GDM_Utils.getDriveFolderUrl(folderId)
          },
          this.getResultListLimit_(),
          result.truncated,
          'emptyFolders'
        );
      }
    }

    result.updatedAt = GDM_Utils.nowIso();
    this.saveResultSafely_(jobId, result);

    var added = this.addUniqueTasksAndIncreaseTotal_(
      jobId,
      nextTasks
    );

    return {
      ok: true,
      skipped: false,
      message:
        'Sous-dossiers analysés : ' +
        folderName +
        ' (' +
        scannedFolders +
        ' dans ce lot' +
        (hasMoreFolders ? ', suite planifiée' : '') +
        ')',
      data: {
        folderId: folderId,
        phase: this.PHASE_FOLDERS_,
        scannedFolders: scannedFolders,
        errors: localErrors,
        continuation: hasMoreFolders,
        tasksAdded: added
      }
    };
  },


  /************************************************************************************************
   * CONSTRUIRE UNE TÂCHE DE SCAN
   ************************************************************************************************/
  buildScanTask_: function(options) {

    options = options || {};

    var folderId =
      GDM_Utils.requireString(
        options.folderId,
        'folderId'
      );

    var phase =
      GDM_Utils.trim(
        options.phase || this.PHASE_FILES_
      ).toUpperCase();

    var continuationToken =
      GDM_Utils.toString(
        options.continuationToken || ''
      );

    return {
      taskId: this.makeStableScanTaskId_(
        folderId,
        phase,
        continuationToken
      ),
      module: GDM_MODULES.ANALYSIS,
      action: GDM_ACTIONS.ANALYZE_FOLDER,
      itemId: folderId,
      itemName:
        GDM_Utils.toString(
          options.folderName || folderId
        ),
      payload: {
        folderId: folderId,
        folderName:
          GDM_Utils.toString(
            options.folderName || ''
          ),
        recursive:
          GDM_Utils.toBoolean(
            options.recursive,
            true
          ),
        depth:
          Math.max(
            0,
            GDM_Utils.toInteger(
              options.depth,
              0
            )
          ),
        phase: phase,
        continuationToken: continuationToken,
        folderCounted: options.folderCounted === true,
        hasAnyFile: options.hasAnyFile === true,
        hasAnyFolder: options.hasAnyFolder === true
      },
      maxRetries: 1
    };
  },


  /************************************************************************************************
   * ID STABLE POUR ÉVITER DE DOUBLER UNE CONTINUATION EN CAS DE REPRISE TECHNIQUE
   ************************************************************************************************/
  makeStableScanTaskId_: function(
    folderId,
    phase,
    continuationToken
  ) {

    var raw = [
      GDM_Utils.toString(folderId),
      GDM_Utils.toString(phase),
      GDM_Utils.toString(continuationToken)
    ].join('|');

    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5,
      raw,
      Utilities.Charset.UTF_8
    );

    var hex = '';

    for (var i = 0; i < digest.length; i++) {

      var value = digest[i];

      if (value < 0) {
        value += 256;
      }

      var part = value.toString(16);

      if (part.length < 2) {
        part = '0' + part;
      }

      hex += part;
    }

    return 'GDM_AN_' + hex.substring(0, 24);
  },


  /************************************************************************************************
   * AJOUTER DES TÂCHES SANS DOUBLON + AJUSTER totalKnown
   ************************************************************************************************/
  addUniqueTasksAndIncreaseTotal_: function(
    jobId,
    tasks
  ) {

    tasks = GDM_Utils.ensureArray(tasks);

    if (!tasks.length) {
      return 0;
    }

    var existingIds = {};

    try {
      var queue = GDM_Queue.get(jobId);

      if (
        queue &&
        Array.isArray(queue.tasks)
      ) {

        for (
          var i = 0;
          i < queue.tasks.length;
          i++
        ) {

          if (queue.tasks[i].taskId) {
            existingIds[
              queue.tasks[i].taskId
            ] = true;
          }
        }
      }
    } catch (ignoredQueueRead) {}

    var unique = [];

    for (
      var j = 0;
      j < tasks.length;
      j++
    ) {

      var task = tasks[j];

      if (
        task.taskId &&
        existingIds[task.taskId]
      ) {
        continue;
      }

      if (task.taskId) {
        existingIds[task.taskId] = true;
      }

      unique.push(task);
    }

    if (!unique.length) {
      return 0;
    }

    var added = GDM_Queue.addInBatches(
      jobId,
      unique,
      Math.min(
        100,
        GDM_Config.get(
          'QUEUE.MAX_ITEMS_PER_BATCH',
          250
        )
      )
    );

    var addedCount =
      added && added.length
        ? added.length
        : unique.length;

    var latestState =
      GDM_State.require(jobId);

    GDM_State.setTotalKnown(
      jobId,
      Number(latestState.totalKnown || 0) +
      addedCount
    );

    return addedCount;
  },


  /************************************************************************************************
   * TAILLE DU LOT ANALYSIS
   ************************************************************************************************/
  getBatchSize_: function() {

    var configured =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'ANALYSIS.BATCH_SIZE',
          this.MAX_BATCH_SIZE_
        ),
        this.MAX_BATCH_SIZE_
      );

    return Math.max(
      10,
      Math.min(
        configured,
        this.MAX_BATCH_SIZE_
      )
    );
  },


  /************************************************************************************************
   * ANALYSE D'UN FICHIER ISOLÉ
   ************************************************************************************************/
  processFileTask_: function(task, context) {

    var jobId = task.jobId || context.jobId;
    var fileId = (task.payload && task.payload.fileId) || task.itemId;

    fileId = GDM_Utils.requireString(fileId, 'fileId');

    var result = this.getResult(jobId);

    if (!result) {
      var state = GDM_State.require(jobId);

      result = this.initializeResult_(jobId, {
        source: state.source || {},
        recursive: state.parameters && state.parameters.recursive,
        largeFileMB: state.parameters && state.parameters.largeFileMB,
        oldFileDays: state.parameters && state.parameters.oldFileDays
      });
    }

    try {

      var file = DriveApp.getFileById(fileId);

      this.analyzeFile_(result, file, null);

      result.updatedAt = GDM_Utils.nowIso();
      this.saveResultSafely_(jobId, result);

      return {
        ok: true,
        skipped: false,
        message: 'Fichier analysé : ' + this.safeGetName_(file),
        data: {
          fileId: fileId
        }
      };

    } catch (error) {

      this.addError_(result, error, {
        itemId: fileId,
        itemName: task.itemName || '',
        type: 'FILE_TASK'
      });

      result.updatedAt = GDM_Utils.nowIso();
      this.saveResultSafely_(jobId, result);

      return {
        ok: true,
        skipped: true,
        message: 'Fichier inaccessible ignoré : ' +
          (task.itemName || fileId)
      };
    }
  },


  /************************************************************************************************
   * ANALYSE D'UN FICHIER
   ************************************************************************************************/
  analyzeFile_: function(result, file, parentFolder) {

    var fileId = file.getId();
    var fileName = file.getName();
    var mimeType = file.getMimeType();

    var size = 0;

    try {
      size = Number(file.getSize()) || 0;
    } catch (ignoredSize) {}

    var updated = null;

    try {
      updated = file.getLastUpdated();
    } catch (ignoredDate) {}

    var extension = GDM_Utils.getExtension(fileName);

    var parentId = '';
    var parentName = '';

    if (parentFolder) {

      parentId = this.safeGetId_(parentFolder);
      parentName = this.safeGetName_(parentFolder);

    } else {

      try {
        var parent = GDM_Utils.getFirstParentInfo(file);
        parentId = parent && parent.id ? parent.id : '';
        parentName = parent && parent.name ? parent.name : '';
      } catch (ignoredParent) {}
    }

    result.totals.files++;
    result.totals.bytes += size;

    /**********************************************************************************************
     * EXTENSION
     **********************************************************************************************/
    var extensionKey = extension || '(sans extension)';

    if (!result.extensions[extensionKey]) {
      result.extensions[extensionKey] = {
        files: 0,
        bytes: 0
      };
    }

    result.extensions[extensionKey].files++;
    result.extensions[extensionKey].bytes += size;


    /**********************************************************************************************
     * MIME
     **********************************************************************************************/
    var mimeKey = mimeType || '(inconnu)';

    if (!result.mimeTypes[mimeKey]) {
      result.mimeTypes[mimeKey] = {
        files: 0,
        bytes: 0
      };
    }

    result.mimeTypes[mimeKey].files++;
    result.mimeTypes[mimeKey].bytes += size;


    /**********************************************************************************************
     * OBJET FICHIER COMPACT
     **********************************************************************************************/
    var fileObject = {
      id: fileId,
      name: fileName,
      extension: extension,
      mimeType: mimeType,
      size: size,
      sizeFormatted: GDM_Utils.formatBytes(size),
      updated: GDM_Utils.toIso(updated),
      folderId: parentId,
      folderName: parentName
    };

    // URL seulement si elle est lisible.
    try {
      fileObject.url = file.getUrl();
    } catch (ignoredUrl) {
      fileObject.url = '';
    }


    /**********************************************************************************************
     * GROS FICHIERS
     **********************************************************************************************/
    if (GDM_Config.get('ANALYSIS.DETECT_LARGE_FILES', true)) {

      var largeLimit = GDM_Utils.mbToBytes(
        result.parameters.largeFileMB
      );

      if (size >= largeLimit) {

        result.counters.largeFiles++;

        result.largeFiles.push(fileObject);

        result.largeFiles.sort(function(a, b) {
          return Number(b.size || 0) - Number(a.size || 0);
        });

        var topLimit = Math.min(
          this.getResultListLimit_(),
          GDM_Utils.toPositiveInteger(
            GDM_Config.get('ANALYSIS.TOP_FILES', 200),
            200
          )
        );

        if (result.largeFiles.length > topLimit) {
          result.largeFiles = result.largeFiles.slice(0, topLimit);
          result.truncated.largeFiles = true;
        }
      }
    }


    /**********************************************************************************************
     * ANCIENS FICHIERS
     **********************************************************************************************/
    if (
      GDM_Config.get('ANALYSIS.DETECT_OLD_FILES', true) &&
      updated &&
      GDM_Utils.isOlderThanDays(
        updated,
        result.parameters.oldFileDays
      )
    ) {

      result.counters.oldFiles++;

      this.pushLimited_(
        result.oldFiles,
        fileObject,
        this.getResultListLimit_(),
        result.truncated,
        'oldFiles'
      );
    }


    /**********************************************************************************************
     * SANS EXTENSION
     **********************************************************************************************/
    if (
      GDM_Config.get('ANALYSIS.DETECT_NO_EXTENSION', true) &&
      !extension &&
      !GDM_Utils.isGoogleMimeType(mimeType)
    ) {

      result.counters.noExtensionFiles++;

      this.pushLimited_(
        result.noExtensionFiles,
        fileObject,
        this.getResultListLimit_(),
        result.truncated,
        'noExtensionFiles'
      );
    }


    /**********************************************************************************************
     * RACCOURCIS
     **********************************************************************************************/
    if (
      GDM_Config.get('ANALYSIS.DETECT_SHORTCUTS', true) &&
      GDM_Utils.isShortcutMimeType(mimeType)
    ) {

      result.counters.shortcuts++;

      this.pushLimited_(
        result.shortcuts,
        fileObject,
        this.getResultListLimit_(),
        result.truncated,
        'shortcuts'
      );
    }
  },


  /************************************************************************************************
   * INITIALISATION DU RÉSULTAT
   ************************************************************************************************/
  initializeResult_: function(jobId, options) {

    options = options || {};

    var result = {

      schemaVersion: 2,
      jobId: jobId,
      module: GDM_MODULES.ANALYSIS,

      source: {
        id:
          options.source && options.source.id
            ? options.source.id
            : '',
        name:
          options.source && options.source.name
            ? options.source.name
            : ''
      },

      parameters: {
        recursive: GDM_Utils.toBoolean(
          options.recursive,
          true
        ),
        largeFileMB: GDM_Utils.toNumber(
          options.largeFileMB,
          GDM_Config.get('ANALYSIS.LARGE_FILE_MB', 100)
        ),
        oldFileDays: GDM_Utils.toInteger(
          options.oldFileDays,
          GDM_Config.get('ANALYSIS.OLD_FILE_DAYS', 365)
        )
      },

      startedAt: GDM_Utils.nowIso(),
      updatedAt: GDM_Utils.nowIso(),
      finishedAt: '',

      totals: {
        files: 0,
        folders: 0,
        bytes: 0
      },

      counters: {
        largeFiles: 0,
        oldFiles: 0,
        emptyFolders: 0,
        noExtensionFiles: 0,
        shortcuts: 0,
        errors: 0
      },

      extensions: {},
      mimeTypes: {},

      largeFiles: [],
      oldFiles: [],
      emptyFolders: [],
      noExtensionFiles: [],
      shortcuts: [],
      errors: [],

      truncated: {
        largeFiles: false,
        oldFiles: false,
        emptyFolders: false,
        noExtensionFiles: false,
        shortcuts: false,
        errors: false,
        extensions: false,
        mimeTypes: false
      },

      storage: {
        mode: 'DOCUMENT_PROPERTIES',
        compacted: false
      }
    };

    this.saveResultSafely_(jobId, result);

    return result;
  },


  /************************************************************************************************
   * RÉSULTAT PUBLIC
   ************************************************************************************************/
  getResult: function(jobId) {

    jobId = GDM_Utils.trim(jobId);

    if (!jobId) {
      return null;
    }

    var result = this.readResult_(jobId);

    // Compatibilité : si un ancien résultat 2.0 existe encore dans ScriptProperties.
    if (!result) {
      result = this.readLegacyScriptResult_(jobId);
    }

    if (!result) {
      return null;
    }

    result.summary = {
      totalSizeFormatted: GDM_Utils.formatBytes(
        result.totals && result.totals.bytes
          ? result.totals.bytes
          : 0
      ),
      files: Number(
        result.totals && result.totals.files
          ? result.totals.files
          : 0
      ),
      folders: Number(
        result.totals && result.totals.folders
          ? result.totals.folders
          : 0
      ),
      errors: Number(
        result.counters && result.counters.errors
          ? result.counters.errors
          : 0
      )
    };

    return result;
  },


  /************************************************************************************************
   * STATUT + RÉSULTAT
   ************************************************************************************************/
  getStatus: function(jobId) {

    jobId = GDM_Utils.requireString(jobId, 'jobId');

    return {
      ok: true,
      jobId: jobId,
      state: GDM_State.getSummary(jobId),
      queue: GDM_Queue.getMeta(jobId),
      analysis: this.getResult(jobId)
    };
  },


  /************************************************************************************************
   * FINALISER LE RÉSULTAT
   ************************************************************************************************/
  finalizeResult: function(jobId) {

    var result = this.getResult(jobId);

    if (!result) {
      return null;
    }

    result.finishedAt = GDM_Utils.nowIso();
    result.updatedAt = result.finishedAt;

    this.saveResultSafely_(jobId, result);

    try {
      GDM_Logger.scanCompleted(jobId, {
        module: GDM_MODULES.ANALYSIS,
        action: GDM_ACTIONS.ANALYZE_FOLDER,
        message: 'Analyse terminée.',
        data: {
          files: result.totals.files,
          folders: result.totals.folders,
          bytes: result.totals.bytes,
          errors: result.counters.errors
        }
      });
    } catch (ignoredLog) {}

    return result;
  },


  /************************************************************************************************
   * SUPPRESSION DU RÉSULTAT TECHNIQUE
   ************************************************************************************************/
  deleteResult: function(jobId) {

    var key = this.getResultKey_(jobId);

    var deleted = false;

    try {
      deleted = this.deleteChunkedFromStore_(
        this.getResultStore_(),
        key
      ) || deleted;
    } catch (ignoredDoc) {}

    try {
      deleted = this.deleteChunkedFromStore_(
        PropertiesService.getScriptProperties(),
        key
      ) || deleted;
    } catch (ignoredScript) {}

    return deleted;
  },


  /************************************************************************************************
   * ERREURS
   ************************************************************************************************/
  addError_: function(result, error, context) {

    if (!result.counters) {
      result.counters = {};
    }

    result.counters.errors =
      Number(result.counters.errors || 0) + 1;

    this.pushLimited_(
      result.errors,
      GDM_Utils.errorToObject(
        error,
        context || {}
      ),
      this.MAX_ERROR_ROWS_,
      result.truncated,
      'errors'
    );
  },


  /************************************************************************************************
   * LISTE LIMITÉE
   ************************************************************************************************/
  pushLimited_: function(
    array,
    value,
    limit,
    truncatedObject,
    truncatedKey
  ) {

    array = array || [];
    limit = Math.max(1, Number(limit || 1));

    if (array.length < limit) {
      array.push(value);
      return true;
    }

    if (truncatedObject && truncatedKey) {
      truncatedObject[truncatedKey] = true;
    }

    return false;
  },


  getResultListLimit_: function() {

    return Math.min(
      this.MAX_DETAIL_ROWS_,
      GDM_Utils.toPositiveInteger(
        GDM_Config.get('UI.RESULT_MAX_ROWS', 5000),
        this.MAX_DETAIL_ROWS_
      )
    );
  },


  /************************************************************************************************
   * CLÉ RÉSULTAT
   ************************************************************************************************/
  getResultKey_: function(jobId) {

    return this.RESULT_PREFIX_ +
      GDM_Utils.requireString(jobId, 'jobId');
  },


  /************************************************************************************************
   * MAGASIN RÉSULTAT
   *
   * DocumentProperties est volontairement séparé de ScriptProperties :
   * Queue / State / Logs restent dans ScriptProperties.
   ************************************************************************************************/
  getResultStore_: function() {

    try {
      var documentStore =
        PropertiesService.getDocumentProperties();

      if (documentStore) {
        return documentStore;
      }
    } catch (ignored) {}

    // Repli si le projet n'est pas lié à un document.
    return PropertiesService.getScriptProperties();
  },


  /************************************************************************************************
   * SAUVEGARDE SÉCURISÉE
   ************************************************************************************************/
  saveResultSafely_: function(jobId, result) {

    var compacted = this.compactResultForStorage_(result);

    try {
      return this.saveResult_(jobId, compacted);

    } catch (firstError) {

      // Deuxième tentative encore plus compacte.
      compacted.storage = compacted.storage || {};
      compacted.storage.compacted = true;
      compacted.storage.lastStorageWarning =
        GDM_Utils.getErrorMessage(firstError);

      this.forceEmergencyCompact_(compacted);

      try {
        return this.saveResult_(jobId, compacted);

      } catch (secondError) {

        // Dernier secours : garder uniquement les totaux et regroupements essentiels.
        var minimal = this.buildMinimalResult_(compacted);

        return this.saveResult_(jobId, minimal);
      }
    }
  },


  saveResult_: function(jobId, result) {

    var key = this.getResultKey_(jobId);

    return this.writeChunkedToStore_(
      this.getResultStore_(),
      key,
      result
    );
  },


  readResult_: function(jobId) {

    return this.readChunkedFromStore_(
      this.getResultStore_(),
      this.getResultKey_(jobId)
    );
  },


  readLegacyScriptResult_: function(jobId) {

    try {
      return this.readChunkedFromStore_(
        PropertiesService.getScriptProperties(),
        this.getResultKey_(jobId)
      );
    } catch (ignored) {
      return null;
    }
  },


  /************************************************************************************************
   * COMPACTAGE AUTOMATIQUE
   ************************************************************************************************/
  compactResultForStorage_: function(result) {

    result = result || {};

    result.truncated = result.truncated || {};

    this.limitArray_(
      result,
      'largeFiles',
      Math.min(
        this.getResultListLimit_(),
        GDM_Utils.toPositiveInteger(
          GDM_Config.get('ANALYSIS.TOP_FILES', 200),
          200
        )
      )
    );

    this.limitArray_(result, 'oldFiles', this.getResultListLimit_());
    this.limitArray_(result, 'emptyFolders', this.getResultListLimit_());
    this.limitArray_(result, 'noExtensionFiles', this.getResultListLimit_());
    this.limitArray_(result, 'shortcuts', this.getResultListLimit_());
    this.limitArray_(result, 'errors', this.MAX_ERROR_ROWS_);

    result.extensions = this.compactMap_(
      result.extensions || {},
      this.MAX_MAP_KEYS_,
      result.truncated,
      'extensions'
    );

    result.mimeTypes = this.compactMap_(
      result.mimeTypes || {},
      this.MAX_MAP_KEYS_,
      result.truncated,
      'mimeTypes'
    );

    var json = GDM_Utils.safeJsonStringify(result, '{}');

    var rounds = 0;

    while (
      json.length > this.MAX_RESULT_JSON_CHARS_ &&
      rounds < 8
    ) {

      rounds++;

      this.halveArray_(result, 'oldFiles');
      this.halveArray_(result, 'emptyFolders');
      this.halveArray_(result, 'noExtensionFiles');
      this.halveArray_(result, 'shortcuts');

      // Les gros fichiers restent prioritaires mais peuvent aussi être réduits.
      if (rounds >= 2) {
        this.halveArray_(result, 'largeFiles');
      }

      if (rounds >= 3) {
        this.halveArray_(result, 'errors');
      }

      if (rounds >= 4) {

        result.extensions = this.compactMap_(
          result.extensions || {},
          100,
          result.truncated,
          'extensions'
        );

        result.mimeTypes = this.compactMap_(
          result.mimeTypes || {},
          100,
          result.truncated,
          'mimeTypes'
        );
      }

      json = GDM_Utils.safeJsonStringify(result, '{}');
    }

    result.storage = result.storage || {};
    result.storage.mode =
      this.getResultStore_() === PropertiesService.getScriptProperties()
        ? 'SCRIPT_PROPERTIES_FALLBACK'
        : 'DOCUMENT_PROPERTIES';

    result.storage.compacted =
      result.storage.compacted === true ||
      rounds > 0;

    result.storage.approxJsonChars = json.length;

    return result;
  },


  forceEmergencyCompact_: function(result) {

    var tiny = 25;

    this.limitArray_(result, 'largeFiles', tiny);
    this.limitArray_(result, 'oldFiles', tiny);
    this.limitArray_(result, 'emptyFolders', tiny);
    this.limitArray_(result, 'noExtensionFiles', tiny);
    this.limitArray_(result, 'shortcuts', tiny);
    this.limitArray_(result, 'errors', 20);

    result.extensions = this.compactMap_(
      result.extensions || {},
      75,
      result.truncated,
      'extensions'
    );

    result.mimeTypes = this.compactMap_(
      result.mimeTypes || {},
      75,
      result.truncated,
      'mimeTypes'
    );

    return result;
  },


  buildMinimalResult_: function(result) {

    return {
      schemaVersion: result.schemaVersion || 2,
      jobId: result.jobId || '',
      module: GDM_MODULES.ANALYSIS,
      source: result.source || {},
      parameters: result.parameters || {},
      startedAt: result.startedAt || '',
      updatedAt: GDM_Utils.nowIso(),
      finishedAt: result.finishedAt || '',
      totals: result.totals || {
        files: 0,
        folders: 0,
        bytes: 0
      },
      counters: result.counters || {
        largeFiles: 0,
        oldFiles: 0,
        emptyFolders: 0,
        noExtensionFiles: 0,
        shortcuts: 0,
        errors: 0
      },
      extensions: this.compactMap_(
        result.extensions || {},
        50,
        null,
        ''
      ),
      mimeTypes: this.compactMap_(
        result.mimeTypes || {},
        50,
        null,
        ''
      ),
      largeFiles: (result.largeFiles || []).slice(0, 20),
      oldFiles: [],
      emptyFolders: [],
      noExtensionFiles: [],
      shortcuts: [],
      errors: (result.errors || []).slice(0, 10),
      truncated: {
        largeFiles: true,
        oldFiles: true,
        emptyFolders: true,
        noExtensionFiles: true,
        shortcuts: true,
        errors: true,
        extensions: true,
        mimeTypes: true
      },
      storage: {
        mode: 'MINIMAL_EMERGENCY',
        compacted: true
      }
    };
  },


  limitArray_: function(result, key, limit) {

    if (!Array.isArray(result[key])) {
      result[key] = [];
      return;
    }

    if (result[key].length > limit) {
      result[key] = result[key].slice(0, limit);
      result.truncated = result.truncated || {};
      result.truncated[key] = true;
    }
  },


  halveArray_: function(result, key) {

    if (!Array.isArray(result[key])) {
      result[key] = [];
      return;
    }

    if (result[key].length > 1) {

      result[key] = result[key].slice(
        0,
        Math.max(
          1,
          Math.floor(result[key].length / 2)
        )
      );

      result.truncated = result.truncated || {};
      result.truncated[key] = true;
    }
  },


  compactMap_: function(map, limit, truncatedObject, truncatedKey) {

    map = map || {};
    var keys = Object.keys(map);

    if (keys.length <= limit) {
      return map;
    }

    keys.sort(function(a, b) {

      var av = map[a] || {};
      var bv = map[b] || {};

      return Number(bv.files || 0) - Number(av.files || 0);
    });

    var out = {};

    for (var i = 0; i < limit; i++) {
      out[keys[i]] = map[keys[i]];
    }

    if (truncatedObject && truncatedKey) {
      truncatedObject[truncatedKey] = true;
    }

    return out;
  },


  /************************************************************************************************
   * STOCKAGE FRACTIONNÉ
   ************************************************************************************************/
  writeChunkedToStore_: function(store, baseKey, value) {

    var self = this;

    return GDM_Utils.withScriptLock(
      function() {

        var json = GDM_Utils.safeJsonStringify(
          value,
          '{}'
        );

        var chunkSize = Math.min(
          8000,
          GDM_Utils.toPositiveInteger(
            GDM_Config.get(
              'STATE.PROPERTY_CHUNK_SIZE',
              7000
            ),
            7000
          )
        );

        var chunks = [];

        for (
          var i = 0;
          i < json.length;
          i += chunkSize
        ) {
          chunks.push(
            json.substring(
              i,
              i + chunkSize
            )
          );
        }

        if (!chunks.length) {
          chunks = ['{}'];
        }

        var oldMeta = GDM_Utils.safeJsonParse(
          store.getProperty(
            baseKey + '_META'
          ),
          {}
        );

        var oldCount = Math.max(
          0,
          GDM_Utils.toInteger(
            oldMeta.chunkCount,
            0
          )
        );

        // On écrase d'abord les morceaux existants.
        for (
          var c = 0;
          c < chunks.length;
          c++
        ) {
          store.setProperty(
            baseKey + '_PART_' + c,
            chunks[c]
          );
        }

        // Puis on enlève les anciens morceaux devenus inutiles.
        for (
          var oldIndex = chunks.length;
          oldIndex < oldCount;
          oldIndex++
        ) {
          store.deleteProperty(
            baseKey + '_PART_' + oldIndex
          );
        }

        store.setProperty(
          baseKey + '_META',
          JSON.stringify({
            chunkCount: chunks.length,
            length: json.length,
            updatedAt: GDM_Utils.nowIso()
          })
        );

        store.deleteProperty(baseKey);

        return true;
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  readChunkedFromStore_: function(store, baseKey) {

    if (!store) {
      return null;
    }

    var metaRaw = store.getProperty(
      baseKey + '_META'
    );

    if (!metaRaw) {

      var direct = store.getProperty(baseKey);

      return direct
        ? GDM_Utils.safeJsonParse(
            direct,
            null
          )
        : null;
    }

    var meta = GDM_Utils.safeJsonParse(
      metaRaw,
      {}
    );

    var count = Math.max(
      0,
      GDM_Utils.toInteger(
        meta.chunkCount,
        0
      )
    );

    if (!count) {
      return null;
    }

    var json = '';

    for (
      var i = 0;
      i < count;
      i++
    ) {

      var part = store.getProperty(
        baseKey + '_PART_' + i
      );

      if (part === null) {
        return null;
      }

      json += part;
    }

    return GDM_Utils.safeJsonParse(
      json,
      null
    );
  },


  deleteChunkedFromStore_: function(store, baseKey) {

    if (!store) {
      return false;
    }

    var meta = GDM_Utils.safeJsonParse(
      store.getProperty(
        baseKey + '_META'
      ),
      {}
    );

    var count = Math.max(
      0,
      GDM_Utils.toInteger(
        meta.chunkCount,
        0
      )
    );

    for (
      var i = 0;
      i < count;
      i++
    ) {
      store.deleteProperty(
        baseKey + '_PART_' + i
      );
    }

    store.deleteProperty(
      baseKey + '_META'
    );

    store.deleteProperty(baseKey);

    return true;
  },


  /************************************************************************************************
   * NETTOYAGE DES ANCIENS RÉSULTATS ANALYSIS
   *
   * Ne supprime aucun fichier Drive.
   ************************************************************************************************/
  cleanupAllAnalysisResultStorage_: function() {

    var stores = [];

    try {
      var doc = PropertiesService.getDocumentProperties();
      if (doc) {
        stores.push(doc);
      }
    } catch (ignoredDoc) {}

    try {
      stores.push(
        PropertiesService.getScriptProperties()
      );
    } catch (ignoredScript) {}

    var totalDeleted = 0;

    for (
      var s = 0;
      s < stores.length;
      s++
    ) {

      var store = stores[s];
      var all = store.getProperties();
      var keys = Object.keys(all);

      for (
        var i = 0;
        i < keys.length;
        i++
      ) {

        if (
          keys[i].indexOf(
            this.RESULT_PREFIX_
          ) === 0
        ) {
          store.deleteProperty(keys[i]);
          totalDeleted++;
        }
      }
    }

    return {
      ok: true,
      deletedProperties: totalDeleted
    };
  },


  /************************************************************************************************
   * HELPERS SÛRS
   ************************************************************************************************/
  safeGetId_: function(item) {

    try {
      return item.getId();
    } catch (ignored) {
      return '';
    }
  },


  safeGetName_: function(item) {

    try {
      return item.getName();
    } catch (ignored) {
      return '';
    }
  },


  /************************************************************************************************
   * VALIDATION
   ************************************************************************************************/
  validate: function() {

    var errors = [];

    try {

      var root = DriveApp.getRootFolder();

      if (!root || !root.getId()) {
        errors.push(
          'Impossible d’accéder à Mon Drive.'
        );
      }

    } catch (error1) {

      errors.push(
        'Erreur accès Google Drive : ' +
        GDM_Utils.getErrorMessage(error1)
      );
    }

    try {

      var store = this.getResultStore_();

      if (!store) {
        errors.push(
          'Aucun magasin Properties disponible.'
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur PropertiesService : ' +
        GDM_Utils.getErrorMessage(error2)
      );
    }

    return {
      ok: errors.length === 0,
      file: 'Modules/Analysis.gs',
      version: '2.3.0',
      readOnly: true,
      antiStorageOverflow: true,
      resultStoreSeparated: true,
      continuationTokens: true,
      maxBatchSize: this.MAX_BATCH_SIZE_,
      taskSoftLimitMs: this.TASK_SOFT_LIMIT_MS_,
      maxDetailRows: this.MAX_DETAIL_ROWS_,
      maxResultJsonChars: this.MAX_RESULT_JSON_CHARS_,
      errors: errors
    };
  }

});


/**************************************************************************************************
 * API GLOBALE POUR L'INTERFACE
 **************************************************************************************************/
function GDM_apiGetAnalysisResult(jobId) {

  return {
    ok: true,
    jobId: jobId,
    state: GDM_State.getSummary(jobId),
    queue: GDM_Queue.getMeta(jobId),
    result: GDM_Analysis.getResult(jobId)
  };
}


/**************************************************************************************************
 * DIAGNOSTIC RAPIDE ANALYSIS 2.3
 **************************************************************************************************/
function GDM_analysisHealthCheck() {

  var jobId = '';

  try {
    jobId = GDM_State.getCurrentJobId() || '';
  } catch (ignoredCurrent) {}

  return {
    ok: true,
    version: '2.3.0',
    jobId: jobId,
    validation: GDM_Analysis.validate(),
    state: jobId ? GDM_State.getSummary(jobId) : null,
    queue: jobId && GDM_Queue.exists(jobId)
      ? GDM_Queue.getMeta(jobId)
      : null,
    currentItem: jobId
      ? (GDM_State.get(jobId) || {}).currentItem || null
      : null
  };
}


/**************************************************************************************************
 * OUTIL D'URGENCE : ARRÊTER ET NETTOYER LE JOB COURANT BLOQUÉ
 *
 * À exécuter UNE SEULE FOIS dans Apps Script après avoir remplacé Analysis.gs.
 *
 * Cette fonction :
 * - annule le moteur courant ;
 * - supprime ses déclencheurs de reprise ;
 * - supprime Queue / State / Logs / résultats techniques du job ;
 * - supprime les anciens résultats Analysis stockés dans PropertiesService ;
 * - NE SUPPRIME AUCUN FICHIER GOOGLE DRIVE.
 **************************************************************************************************/
function GDM_analysisEmergencyResetCurrentJob() {

  var jobId = '';

  try {
    jobId = GDM_State.getCurrentJobId() || '';
  } catch (ignoredCurrent) {}

  if (jobId) {

    try {
      GDM_Engine.cancel(jobId);
    } catch (ignoredCancel) {}

    try {
      GDM_Engine.removeResumeTriggers(jobId);
    } catch (ignoredTriggers) {}

    // Laisse un court instant au traitement actif pour voir l'annulation.
    try {
      Utilities.sleep(1500);
    } catch (ignoredSleep) {}

    try {
      GDM_Queue.delete(jobId);
    } catch (ignoredQueue) {}

    try {
      if (
        typeof GDM_Logger !== 'undefined' &&
        typeof GDM_Logger.clear === 'function'
      ) {
        GDM_Logger.clear(jobId);
      }
    } catch (ignoredLogs) {}

    try {
      GDM_Analysis.deleteResult(jobId);
    } catch (ignoredAnalysisResult) {}

    try {
      GDM_State.delete(jobId, {
        deleteResult: true
      });
    } catch (ignoredState) {}
  }

  var cleanup = {
    ok: true,
    deletedProperties: 0
  };

  try {
    cleanup =
      GDM_Analysis.cleanupAllAnalysisResultStorage_();
  } catch (ignoredCleanup) {}

  return {
    ok: true,
    message:
      'Ancien job d’analyse arrêté et stockage technique nettoyé. Vous pouvez lancer une nouvelle analyse.',
    oldJobId: jobId,
    analysisStorageCleanup: cleanup
  };
}
