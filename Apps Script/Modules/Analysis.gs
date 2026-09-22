/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Analysis.gs
 * Version : 2.6.2
 *
 * V2.6.2 - PACKED TURBO / ANTI-QUOTA
 * --------------------------------------
 * Cette version conserve toutes les sécurités "gros Drive" et ajoute un moteur rapide :
 * - lecture des métadonnées par pages via Drive API v3 (jusqu'à 1000 éléments par requête) ;
 * - mode Turbo : plusieurs dossiers/pages sont traités en mémoire avant une seule sauvegarde ;
 * - V2.6.1 : le frontier restant est compacté dans UNE seule tâche de continuation ;
 * - une page renvoie id, nom, type MIME, taille, date et parents en une seule requête ;
 * - repli automatique vers DriveApp si l'API avancée n'est pas disponible au démarrage ;
 * - l'ancien moteur DriveApp + continuationToken reste conservé comme secours ;
 * - chaque gros dossier reste découpé en petits lots et repris automatiquement ;
 * - une tâche Analysis ne garde jamais le moteur plusieurs minutes sur un seul dossier ;
 * - le résultat détaillé de l'analyse n'est plus stocké avec la Queue/State/Logs dans ScriptProperties ;
 * - il utilise DocumentProperties (avec repli ScriptProperties si nécessaire) ;
 * - les listes détaillées sont limitées ;
 * - la taille JSON est automatiquement compactée avant sauvegarde ;
 * - les erreurs de lecture d'un fichier ou dossier sont isolées et n'arrêtent plus toute l'analyse ;
 * - les anciennes données Analysis sont nettoyées intelligemment : le job actif et les analyses récentes sont conservés ;
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

  // V2.6.2 : marge renforcée dans DocumentProperties.
  // Les compteurs restent complets ; seules les listes détaillées sont compactées.
  MAX_RESULT_JSON_CHARS_: 120000,

  // Limites de détails : les compteurs restent complets, seules les listes affichables sont tronquées.
  MAX_DETAIL_ROWS_: 250,
  MAX_ERROR_ROWS_: 100,
  MAX_MAP_KEYS_: 300,

  // Scanner un gros dossier en petites portions. Le batch est volontairement plafonné
  // pour que chaque tâche rende la main au moteur bien avant la limite Apps Script.
  PHASE_FAST_: 'FAST',
  PHASE_FILES_: 'FILES',
  PHASE_FOLDERS_: 'FOLDERS',
  MAX_BATCH_SIZE_: 100,
  FAST_MAX_PAGE_SIZE_: 1000,
  TASK_SOFT_LIMIT_MS_: 40000,


  /************************************************************************************************
   * LANCER UNE ANALYSE
   ************************************************************************************************/
  start: function(options) {

    options = options || {};

    // Refuser immédiatement un second traitement avant toute création de dossier
    // ou modification de stockage liée au nouveau job.
    GDM_State.assertNoActiveJob_(options);

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

    var fastMode =
      this.shouldUseFastMode_();

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
        oldFileDays: oldFileDays,
        fastMode: fastMode
      },

      totalKnown: 1,
      setCurrent: true,
      message: 'Analyse préparée.'
    });

    var jobId = state.jobId;

    /*
     * Le nettoyage intervient APRÈS la création du job.
     * Ainsi, si un autre traitement est actif, State.create() refuse le nouveau job
     * avant que l'on touche aux résultats d'analyse existants.
     */
    try {
      this.cleanupAllAnalysisResultStorage_({
        preserveCurrent: true,
        keepRecent: GDM_Config.get(
          'ANALYSIS.KEEP_RECENT_RESULTS',
          1
        )
      });
    } catch (ignoredCleanup) {}

    this.initializeResult_(jobId, {
      source: {
        id: sourceFolderId,
        name: sourceFolderName
      },
      recursive: recursive,
      largeFileMB: largeFileMB,
      oldFileDays: oldFileDays,
      fastMode: fastMode
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
        phase:
          fastMode
            ? this.PHASE_FAST_
            : this.PHASE_FILES_,
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
      fastMode: fastMode,
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
      phase !== this.PHASE_FAST_ &&
      phase !== this.PHASE_FILES_ &&
      phase !== this.PHASE_FOLDERS_
    ) {
      phase =
        this.shouldUseFastMode_()
          ? this.PHASE_FAST_
          : this.PHASE_FILES_;
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

    if (
      phase === this.PHASE_FAST_
    ) {
      return this.processFastFolderPage_(
        jobId,
        task,
        payload,
        recursive,
        result
      );
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
   * FAST ANALYSIS TURBO - DRIVE API V3
   *
   * V2.6 :
   * - une page peut contenir jusqu'à 1000 éléments ;
   * - plusieurs pages/dossiers sont traités dans la MEME tâche ;
   * - résultat + queue ne sont sauvegardés qu'une seule fois à la fin du lot Turbo ;
   * - les travaux restants sont remis en queue avec des taskId stables ;
   * - le fallback DriveApp reste disponible dossier par dossier.
   ************************************************************************************************/
  processFastFolderPage_: function(
    jobId,
    task,
    payload,
    recursive,
    result
  ) {

    var initialFolderId =
      GDM_Utils.requireString(
        payload.folderId ||
        task.itemId,
        'folderId'
      );

    var initialFolderName =
      GDM_Utils.toString(
        payload.folderName ||
        task.itemName ||
        initialFolderId
      );

    /*
     * V2.6.1 PACKED FRONTIER :
     * une continuation Turbo peut transporter tous les dossiers restant à parcourir
     * dans une seule tâche. Cela évite une Queue de plusieurs centaines d'entrées.
     */
    var workQueue =
      this.unpackTurboFrontier_(
        payload.turboFrontier
      );

    if (
      !workQueue.length
    ) {
      workQueue.push({
        folderId:
          initialFolderId,
        folderName:
          initialFolderName,
        depth:
          Math.max(
            0,
            GDM_Utils.toInteger(
              payload.depth,
              0
            )
          ),
        pageToken:
          GDM_Utils.toString(
            payload.continuationToken ||
            ''
          ),
        folderCounted:
          payload.folderCounted === true,
        hasAnyFile:
          payload.hasAnyFile === true,
        hasAnyFolder:
          payload.hasAnyFolder === true
      });
    }

    var fallbackTasks = [];
    var maxPages =
      this.getTurboMaxPages_();

    var softLimitMs =
      this.getTurboSoftLimitMs_();

    var startedAtMs =
      Date.now();

    var processedPages = 0;
    var newlyCountedFolders = 0;
    var scannedFiles = 0;
    var scannedFolders = 0;
    var scannedItems = 0;
    var localErrors = 0;
    var fallbacks = 0;

    while (
      workQueue.length &&
      processedPages < maxPages &&
      (
        Date.now() -
        startedAtMs
      ) < softLimitMs
    ) {

      var work =
        workQueue.shift();

      if (
        !work.folderCounted
      ) {
        result.totals.folders++;
        work.folderCounted = true;
        newlyCountedFolders++;
      }

      var response;

      try {

        var listOptions = {
          q:
            "'" +
            work.folderId +
            "' in parents and trashed = false",
          pageSize:
            this.getFastPageSize_(),
          spaces:
            'drive',
          supportsAllDrives:
            true,
          includeItemsFromAllDrives:
            true,
          fields:
            'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails)'
        };

        if (
          work.pageToken
        ) {
          listOptions.pageToken =
            work.pageToken;
        }

        response =
          Drive.Files.list(
            listOptions
          );

      } catch (fastError) {

        /*
         * Sur la première page du dossier, on peut basculer vers DriveApp
         * sans doubler les compteurs. Les autres travaux Turbo continuent.
         */
        if (
          !work.pageToken &&
          GDM_Config.get(
            'ANALYSIS.FAST_FALLBACK_TO_DRIVEAPP',
            true
          )
        ) {

          try {
            GDM_Logger.warn(
              'FAST ANALYSIS indisponible. Repli DriveApp.',
              {
                jobId:
                  jobId,
                module:
                  GDM_MODULES.ANALYSIS,
                action:
                  GDM_ACTIONS.ANALYZE_FOLDER,
                itemId:
                  work.folderId,
                itemName:
                  work.folderName,
                data: {
                  error:
                    GDM_Utils.getErrorMessage(
                      fastError
                    )
                }
              }
            );
          } catch (ignoredLog) {}

          fallbackTasks.push(
            this.buildScanTask_({
              folderId:
                work.folderId,
              folderName:
                work.folderName,
              recursive:
                recursive,
              depth:
                work.depth,
              phase:
                this.PHASE_FILES_,
              continuationToken:
                '',
              folderCounted:
                true,
              hasAnyFile:
                work.hasAnyFile,
              hasAnyFolder:
                work.hasAnyFolder
            })
          );

          fallbacks++;
          continue;
        }

        /*
         * Si l'erreur arrive sur une continuation, on laisse Engine réessayer
         * la tâche originale. Aucun résultat Turbo n'a encore été persisté.
         */
        throw fastError;
      }

      processedPages++;

      var items =
        response &&
        Array.isArray(
          response.files
        )
          ? response.files
          : [];

      scannedItems +=
        items.length;

      for (
        var i = 0;
        i < items.length;
        i++
      ) {

        var item =
          items[i] ||
          {};

        var mimeType =
          GDM_Utils.toString(
            item.mimeType
          );

        if (
          mimeType ===
          GDM_MIME.FOLDER
        ) {

          scannedFolders++;
          work.hasAnyFolder = true;

          if (
            recursive
          ) {
            workQueue.push({
              folderId:
                item.id,
              folderName:
                item.name ||
                item.id,
              depth:
                work.depth + 1,
              pageToken:
                '',
              folderCounted:
                false,
              hasAnyFile:
                false,
              hasAnyFolder:
                false
            });
          }

          continue;
        }

        scannedFiles++;
        work.hasAnyFile = true;

        try {

          this.analyzeFileMetadata_(
            result,
            item,
            work.folderId,
            work.folderName
          );

        } catch (fileError) {

          this.addError_(
            result,
            fileError,
            {
              itemId:
                item.id || '',
              itemName:
                item.name || '',
              folderId:
                work.folderId,
              folderName:
                work.folderName,
              type:
                'FAST_TURBO_FILE_ANALYSIS'
            }
          );

          localErrors++;
        }
      }

      var nextPageToken =
        GDM_Utils.toString(
          response &&
          response.nextPageToken
            ? response.nextPageToken
            : ''
        );

      if (
        nextPageToken
      ) {

        /*
         * Priorité à la page suivante du même dossier.
         * Cela termine un gros dossier avant de descendre dans ses enfants.
         */
        workQueue.unshift({
          folderId:
            work.folderId,
          folderName:
            work.folderName,
          depth:
            work.depth,
          pageToken:
            nextPageToken,
          folderCounted:
            true,
          hasAnyFile:
            work.hasAnyFile,
          hasAnyFolder:
            work.hasAnyFolder
        });

      } else if (
        GDM_Config.get(
          'ANALYSIS.DETECT_EMPTY_FOLDERS',
          true
        ) &&
        !work.hasAnyFile &&
        !work.hasAnyFolder
      ) {

        result.counters.emptyFolders++;

        this.pushLimited_(
          result.emptyFolders,
          {
            id:
              work.folderId,
            name:
              work.folderName,
            url:
              GDM_Utils.getDriveFolderUrl(
                work.folderId
              )
          },
          this.getResultListLimit_(),
          result.truncated,
          'emptyFolders'
        );
      }
    }

    /*
     * V2.6.1 :
     * au lieu d'ajouter un task Queue PAR dossier restant, on emballe tout le
     * frontier dans UNE seule tâche de continuation. C'est le gain principal
     * lorsque l'arborescence contient des centaines de petits dossiers.
     */
    var deferredTasks =
      fallbackTasks.slice();

    if (
      workQueue.length
    ) {

      var packedFrontier =
        this.packTurboFrontier_(
          workQueue
        );

      var firstPending =
        workQueue[0];

      deferredTasks.push(
        this.buildScanTask_({
          taskId:
            this.makeStableTurboFrontierTaskId_(
              packedFrontier
            ),
          folderId:
            firstPending.folderId,
          folderName:
            firstPending.folderName,
          recursive:
            recursive,
          depth:
            firstPending.depth,
          phase:
            this.PHASE_FAST_,
          continuationToken:
            firstPending.pageToken,
          folderCounted:
            firstPending.folderCounted,
          hasAnyFile:
            firstPending.hasAnyFile,
          hasAnyFolder:
            firstPending.hasAnyFolder,
          turboFrontier:
            packedFrontier
        })
      );
    }

    result.updatedAt =
      GDM_Utils.nowIso();

    /*
     * POINT CLE TURBO :
     * une seule sauvegarde du résultat pour tout le lot.
     */
    this.saveResultSafely_(
      jobId,
      result
    );

    /*
     * Une seule phase d'ajout Queue pour tous les travaux restants.
     */
    var added =
      this.addUniqueTasksAndIncreaseTotal_(
        jobId,
        deferredTasks
      );

    var elapsedMs =
      Date.now() -
      startedAtMs;

    return {
      ok: true,
      skipped: false,
      message:
        'TURBO : ' +
        processedPages +
        ' page(s), ' +
        scannedFiles +
        ' fichier(s), ' +
        scannedFolders +
        ' sous-dossier(s) en ' +
        Math.round(
          elapsedMs /
          100
        ) /
        10 +
        ' s',
      data: {
        folderId:
          initialFolderId,
        phase:
          this.PHASE_FAST_,
        fastMode:
          true,
        turboMode:
          true,
        turboMaxPagesPerTask:
          maxPages,
        turboSoftLimitMs:
          softLimitMs,
        pagesProcessed:
          processedPages,
        foldersCounted:
          newlyCountedFolders,
        scanned:
          scannedItems,
        scannedFiles:
          scannedFiles,
        scannedFolders:
          scannedFolders,
        errors:
          localErrors,
        fallbacks:
          fallbacks,
        pendingWork:
          workQueue.length,
        packedFrontier:
          workQueue.length > 0,
        queueTasksCreated:
          deferredTasks.length,
        tasksAdded:
          added,
        elapsedMs:
          elapsedMs
      }
    };
  },


  getTurboMaxPages_: function() {

    if (
      GDM_Config.get(
        'ANALYSIS.TURBO_MODE',
        true
      ) !== true
    ) {
      return 1;
    }

    return Math.max(
      1,
      Math.min(
        100,
        GDM_Utils.toPositiveInteger(
          GDM_Config.get(
            'ANALYSIS.TURBO_MAX_PAGES_PER_TASK',
            30
          ),
          30
        )
      )
    );
  },


  getTurboSoftLimitMs_: function() {

    return Math.max(
      5000,
      Math.min(
        this.TASK_SOFT_LIMIT_MS_,
        GDM_Utils.toPositiveInteger(
          GDM_Config.get(
            'ANALYSIS.TURBO_SOFT_LIMIT_MS',
            30000
          ),
          30000
        )
      )
    );
  },


  shouldUseFastMode_: function() {

    if (
      GDM_Config.get(
        'ANALYSIS.FAST_MODE',
        true
      ) !== true
    ) {
      return false;
    }

    try {
      return (
        typeof Drive !==
          'undefined' &&
        Drive &&
        Drive.Files &&
        typeof Drive.Files.list ===
          'function'
      );
    } catch (ignored) {
      return false;
    }
  },


  getFastPageSize_: function() {

    return Math.max(
      50,
      Math.min(
        this.FAST_MAX_PAGE_SIZE_,
        GDM_Utils.toPositiveInteger(
          GDM_Config.get(
            'ANALYSIS.FAST_PAGE_SIZE',
            250
          ),
          250
        )
      )
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
      taskId:
        GDM_Utils.trim(
          options.taskId
        ) ||
        this.makeStableScanTaskId_(
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
        hasAnyFolder: options.hasAnyFolder === true,
        turboFrontier:
          Array.isArray(
            options.turboFrontier
          )
            ? options.turboFrontier
            : null
      },
      // Un timeout/reprise technique ne doit pas abandonner trop vite un gros lot Turbo.
      maxRetries:
        phase === this.PHASE_FAST_
          ? 4
          : 1
    };
  },


  /************************************************************************************************
   * FRONTIER TURBO COMPACT
   *
   * Format de chaque entrée :
   * [folderId, folderName, depth, pageToken, folderCounted, hasAnyFile, hasAnyFolder]
   ************************************************************************************************/
  packTurboFrontier_: function(
    workQueue
  ) {

    workQueue =
      Array.isArray(
        workQueue
      )
        ? workQueue
        : [];

    var packed = [];

    for (
      var i = 0;
      i < workQueue.length;
      i++
    ) {

      var work =
        workQueue[i] ||
        {};

      if (
        !work.folderId
      ) {
        continue;
      }

      packed.push([
        GDM_Utils.toString(
          work.folderId
        ),
        GDM_Utils.toString(
          work.folderName
        ),
        Math.max(
          0,
          GDM_Utils.toInteger(
            work.depth,
            0
          )
        ),
        GDM_Utils.toString(
          work.pageToken
        ),
        work.folderCounted === true
          ? 1
          : 0,
        work.hasAnyFile === true
          ? 1
          : 0,
        work.hasAnyFolder === true
          ? 1
          : 0
      ]);
    }

    return packed;
  },


  unpackTurboFrontier_: function(
    packed
  ) {

    if (
      !Array.isArray(
        packed
      )
    ) {
      return [];
    }

    var workQueue = [];

    for (
      var i = 0;
      i < packed.length;
      i++
    ) {

      var row =
        packed[i];

      if (
        !Array.isArray(
          row
        ) ||
        !row[0]
      ) {
        continue;
      }

      workQueue.push({
        folderId:
          GDM_Utils.toString(
            row[0]
          ),
        folderName:
          GDM_Utils.toString(
            row[1] ||
            row[0]
          ),
        depth:
          Math.max(
            0,
            GDM_Utils.toInteger(
              row[2],
              0
            )
          ),
        pageToken:
          GDM_Utils.toString(
            row[3] ||
            ''
          ),
        folderCounted:
          Number(
            row[4] ||
            0
          ) === 1,
        hasAnyFile:
          Number(
            row[5] ||
            0
          ) === 1,
        hasAnyFolder:
          Number(
            row[6] ||
            0
          ) === 1
      });
    }

    return workQueue;
  },


  makeStableTurboFrontierTaskId_: function(
    packedFrontier
  ) {

    var raw =
      'TURBO_FRONTIER|' +
      GDM_Utils.safeJsonStringify(
        packedFrontier,
        '[]'
      );

    var digest =
      Utilities.computeDigest(
        Utilities.DigestAlgorithm.MD5,
        raw,
        Utilities.Charset.UTF_8
      );

    var hex = '';

    for (
      var i = 0;
      i < digest.length;
      i++
    ) {

      var value =
        digest[i];

      if (
        value < 0
      ) {
        value += 256;
      }

      var part =
        value.toString(
          16
        );

      if (
        part.length < 2
      ) {
        part =
          '0' +
          part;
      }

      hex += part;
    }

    return (
      'GDM_AN_TURBO_' +
      hex.substring(
        0,
        20
      )
    );
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

    /*
     * PERFORMANCE 2.6 :
     * GDM_Queue.addMany() déduplique déjà les taskId.
     * L'ancienne version relisait toute la queue ici puis la relisait encore
     * dans addMany(), ce qui doublait le coût PropertiesService à chaque page.
     */
    var added = GDM_Queue.addInBatches(
      jobId,
      tasks,
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
        : 0;

    if (!addedCount) {
      return 0;
    }

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

    var parentId = '';
    var parentName = '';

    if (parentFolder) {
      parentId =
        this.safeGetId_(
          parentFolder
        );

      parentName =
        this.safeGetName_(
          parentFolder
        );
    } else {
      try {
        var parent =
          GDM_Utils.getFirstParentInfo(
            file
          );

        parentId =
          parent &&
          parent.id
            ? parent.id
            : '';

        parentName =
          parent &&
          parent.name
            ? parent.name
            : '';
      } catch (ignoredParent) {}
    }

    var size = 0;

    try {
      size =
        Number(
          file.getSize()
        ) || 0;
    } catch (ignoredSize) {}

    var updated = null;

    try {
      updated =
        file.getLastUpdated();
    } catch (ignoredDate) {}

    var url = '';

    try {
      url =
        file.getUrl();
    } catch (ignoredUrl) {}

    return this.analyzeFileData_(
      result,
      {
        id:
          file.getId(),
        name:
          file.getName(),
        mimeType:
          file.getMimeType(),
        size:
          size,
        updated:
          updated,
        folderId:
          parentId,
        folderName:
          parentName,
        url:
          url
      }
    );
  },


  analyzeFileMetadata_: function(
    result,
    item,
    parentFolderId,
    parentFolderName
  ) {

    item =
      item ||
      {};

    return this.analyzeFileData_(
      result,
      {
        id:
          GDM_Utils.toString(
            item.id
          ),
        name:
          GDM_Utils.toString(
            item.name
          ),
        mimeType:
          GDM_Utils.toString(
            item.mimeType
          ),
        size:
          Number(
            item.size || 0
          ) || 0,
        updated:
          item.modifiedTime
            ? GDM_Utils.toDate(
                item.modifiedTime
              )
            : null,
        folderId:
          GDM_Utils.toString(
            parentFolderId
          ),
        folderName:
          GDM_Utils.toString(
            parentFolderName
          ),
        url:
          GDM_Utils.getDriveFileUrl(
            item.id
          )
      }
    );
  },


  analyzeFileData_: function(
    result,
    data
  ) {

    data =
      data ||
      {};

    var fileId =
      GDM_Utils.toString(
        data.id
      );

    var fileName =
      GDM_Utils.toString(
        data.name
      );

    var mimeType =
      GDM_Utils.toString(
        data.mimeType
      );

    var size =
      Number(
        data.size || 0
      ) || 0;

    var updated =
      GDM_Utils.toDate(
        data.updated
      );

    var extension =
      GDM_Utils.getExtension(
        fileName
      );

    var parentId =
      GDM_Utils.toString(
        data.folderId
      );

    var parentName =
      GDM_Utils.toString(
        data.folderName
      );

    result.totals.files++;
    result.totals.bytes += size;

    var extensionKey =
      extension ||
      '(sans extension)';

    if (
      !result.extensions[
        extensionKey
      ]
    ) {
      result.extensions[
        extensionKey
      ] = {
        files: 0,
        bytes: 0
      };
    }

    result.extensions[
      extensionKey
    ].files++;

    result.extensions[
      extensionKey
    ].bytes += size;

    var mimeKey =
      mimeType ||
      '(inconnu)';

    if (
      !result.mimeTypes[
        mimeKey
      ]
    ) {
      result.mimeTypes[
        mimeKey
      ] = {
        files: 0,
        bytes: 0
      };
    }

    result.mimeTypes[
      mimeKey
    ].files++;

    result.mimeTypes[
      mimeKey
    ].bytes += size;

    var fileObject = {
      id:
        fileId,
      name:
        fileName,
      extension:
        extension,
      mimeType:
        mimeType,
      size:
        size,
      sizeFormatted:
        GDM_Utils.formatBytes(
          size
        ),
      updated:
        GDM_Utils.toIso(
          updated
        ),
      folderId:
        parentId,
      folderName:
        parentName,
      url:
        GDM_Utils.toString(
          data.url
        ) ||
        GDM_Utils.getDriveFileUrl(
          fileId
        )
    };

    if (
      GDM_Config.get(
        'ANALYSIS.DETECT_LARGE_FILES',
        true
      )
    ) {

      var largeLimit =
        GDM_Utils.mbToBytes(
          result.parameters.largeFileMB
        );

      if (
        size >=
        largeLimit
      ) {

        result.counters.largeFiles++;

        result.largeFiles.push(
          fileObject
        );

        result.largeFiles.sort(
          function(a, b) {
            return Number(
              b.size || 0
            ) -
            Number(
              a.size || 0
            );
          }
        );

        var topLimit =
          Math.min(
            this.getResultListLimit_(),
            GDM_Utils.toPositiveInteger(
              GDM_Config.get(
                'ANALYSIS.TOP_FILES',
                200
              ),
              200
            )
          );

        if (
          result.largeFiles.length >
          topLimit
        ) {
          result.largeFiles =
            result.largeFiles.slice(
              0,
              topLimit
            );

          result.truncated.largeFiles =
            true;
        }
      }
    }

    if (
      GDM_Config.get(
        'ANALYSIS.DETECT_OLD_FILES',
        true
      ) &&
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

    if (
      GDM_Config.get(
        'ANALYSIS.DETECT_NO_EXTENSION',
        true
      ) &&
      !extension &&
      !GDM_Utils.isGoogleMimeType(
        mimeType
      )
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

    if (
      GDM_Config.get(
        'ANALYSIS.DETECT_SHORTCUTS',
        true
      ) &&
      GDM_Utils.isShortcutMimeType(
        mimeType
      )
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

    return fileObject;
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
        ),
        fastMode:
          GDM_Utils.toBoolean(
            options.fastMode,
            this.shouldUseFastMode_()
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

        /*
         * PERFORMANCE 2.6 :
         * écrire tous les morceaux + la méta en une seule opération réseau.
         * setProperty() bloc par bloc était très coûteux sur les résultats volumineux.
         */
        var batch = {};

        for (
          var c = 0;
          c < chunks.length;
          c++
        ) {
          batch[
            baseKey + '_PART_' + c
          ] = chunks[c];
        }

        batch[
          baseKey + '_META'
        ] = JSON.stringify({
          chunkCount: chunks.length,
          length: json.length,
          updatedAt: GDM_Utils.nowIso()
        });

        store.setProperties(
          batch,
          false
        );

        // Puis on enlève uniquement les anciens morceaux devenus inutiles.
        for (
          var oldIndex = chunks.length;
          oldIndex < oldCount;
          oldIndex++
        ) {
          store.deleteProperty(
            baseKey + '_PART_' + oldIndex
          );
        }

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

    /*
     * PERFORMANCE 2.6 :
     * une seule lecture PropertiesService pour la méta et tous les morceaux.
     */
    var all = store.getProperties();

    var metaRaw = all[
      baseKey + '_META'
    ];

    if (!metaRaw) {

      var direct = all[baseKey];

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

      var part = all[
        baseKey + '_PART_' + i
      ];

      if (typeof part === 'undefined') {
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
  cleanupAllAnalysisResultStorage_: function(options) {

    options = options || {};

    var preserveCurrent =
      GDM_Utils.toBoolean(
        options.preserveCurrent,
        false
      );

    var keepRecent =
      Math.max(
        0,
        GDM_Utils.toInteger(
          options.keepRecent,
          0
        )
      );

    var currentJobId = '';

    if (preserveCurrent) {
      try {
        currentJobId =
          GDM_State.getCurrentJobId() || '';
      } catch (ignoredCurrent) {}
    }

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
    var preserved = {};

    for (
      var s = 0;
      s < stores.length;
      s++
    ) {

      var store = stores[s];
      var all = store.getProperties();
      var keys = Object.keys(all);
      var groups = {};

      for (
        var i = 0;
        i < keys.length;
        i++
      ) {

        var key = keys[i];

        if (
          key.indexOf(
            this.RESULT_PREFIX_
          ) !== 0
        ) {
          continue;
        }

        var baseKey =
          key
            .replace(
              /_PART_\d+$/,
              ''
            )
            .replace(
              /_META$/,
              ''
            );

        if (!groups[baseKey]) {
          groups[baseKey] = {
            baseKey: baseKey,
            keys: [],
            updatedAt: ''
          };
        }

        groups[baseKey].keys.push(key);

        if (/_META$/.test(key)) {
          var meta =
            GDM_Utils.safeJsonParse(
              all[key],
              {}
            );

          groups[baseKey].updatedAt =
            meta.updatedAt ||
            groups[baseKey].updatedAt ||
            '';
        } else if (key === baseKey) {
          var direct =
            GDM_Utils.safeJsonParse(
              all[key],
              {}
            );

          groups[baseKey].updatedAt =
            direct.updatedAt ||
            direct.finishedAt ||
            direct.startedAt ||
            groups[baseKey].updatedAt ||
            '';
        }
      }

      var groupList =
        Object.keys(groups)
          .map(function(baseKey) {
            return groups[baseKey];
          })
          .sort(function(a, b) {
            return String(b.updatedAt || '')
              .localeCompare(
                String(a.updatedAt || '')
              );
          });

      var keep = {};

      if (currentJobId) {
        keep[
          this.RESULT_PREFIX_ +
          currentJobId
        ] = true;
      }

      var keptHistorical = 0;

      for (
        var g = 0;
        g < groupList.length &&
        keptHistorical < keepRecent;
        g++
      ) {

        var candidate =
          groupList[g].baseKey;

        if (keep[candidate]) {
          continue;
        }

        keep[candidate] = true;
        keptHistorical++;
      }

      for (
        var x = 0;
        x < groupList.length;
        x++
      ) {

        var group =
          groupList[x];

        if (keep[group.baseKey]) {
          preserved[group.baseKey] = true;
          continue;
        }

        for (
          var k = 0;
          k < group.keys.length;
          k++
        ) {
          store.deleteProperty(
            group.keys[k]
          );
          totalDeleted++;
        }
      }
    }

    return {
      ok: true,
      deletedProperties: totalDeleted,
      preservedResultGroups:
        Object.keys(preserved).length,
      keepRecent: keepRecent,
      currentJobId: currentJobId
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
      version: '2.6.2',
      readOnly: true,
      fastAnalysis: true,
      fastModeAvailable: this.shouldUseFastMode_(),
      fastPageSize: this.getFastPageSize_(),
      turboMode: GDM_Config.get('ANALYSIS.TURBO_MODE', true) === true,
      turboMaxPagesPerTask: this.getTurboMaxPages_(),
      turboSoftLimitMs: this.getTurboSoftLimitMs_(),
      turboPackedFrontier:
        GDM_Config.get(
          'ANALYSIS.TURBO_PACK_FRONTIER',
          true
        ) === true,
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
 * DIAGNOSTIC RAPIDE ANALYSIS 2.5
 **************************************************************************************************/
function GDM_analysisHealthCheck() {

  var jobId = '';

  try {
    jobId = GDM_State.getCurrentJobId() || '';
  } catch (ignoredCurrent) {}

  return {
    ok: true,
    version: '2.6.2',
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
