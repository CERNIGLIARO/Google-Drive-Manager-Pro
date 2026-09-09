/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Analysis.gs
 * Version : 2.1.0
 *
 * CORRECTIF "GROS DRIVE" / ANTI-BLOCAGE
 * --------------------------------------
 * Cette version corrige principalement les blocages liés au stockage Apps Script :
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
        recursive: recursive,
        depth: 0
      },

      // Une tâche dossier ne doit jamais tourner indéfiniment.
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

    var result = this.getResult(jobId);

    if (!result) {
      // Recrée un résultat minimal au lieu de faire échouer toutes les tâches restantes.
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

    var folderName = this.safeGetName_(folder) || task.itemName || folderId;

    // Le compteur dossier est toujours incrémenté une seule fois pour cette tâche.
    result.totals.folders++;

    var directFiles = 0;
    var directFolders = 0;
    var newTasks = [];

    /**********************************************************************************************
     * FICHIERS DIRECTS
     **********************************************************************************************/
    try {

      var files = folder.getFiles();

      while (true) {

        var hasFile = false;

        try {
          hasFile = files.hasNext();
        } catch (filesIteratorError) {

          this.addError_(result, filesIteratorError, {
            itemId: folderId,
            itemName: folderName,
            type: 'FILES_ITERATOR'
          });

          break;
        }

        if (!hasFile) {
          break;
        }

        var file;

        try {
          file = files.next();
        } catch (fileNextError) {

          this.addError_(result, fileNextError, {
            itemId: folderId,
            itemName: folderName,
            type: 'FILE_NEXT'
          });

          // Impossible de garantir que l'itérateur progressera après cette erreur.
          break;
        }

        directFiles++;

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
        }
      }

    } catch (filesOpenError) {

      this.addError_(result, filesOpenError, {
        itemId: folderId,
        itemName: folderName,
        type: 'FILES_OPEN'
      });
    }


    /**********************************************************************************************
     * SOUS-DOSSIERS
     **********************************************************************************************/
    try {

      var folders = folder.getFolders();

      while (true) {

        var hasFolder = false;

        try {
          hasFolder = folders.hasNext();
        } catch (foldersIteratorError) {

          this.addError_(result, foldersIteratorError, {
            itemId: folderId,
            itemName: folderName,
            type: 'FOLDERS_ITERATOR'
          });

          break;
        }

        if (!hasFolder) {
          break;
        }

        var child;

        try {
          child = folders.next();
        } catch (folderNextError) {

          this.addError_(result, folderNextError, {
            itemId: folderId,
            itemName: folderName,
            type: 'FOLDER_NEXT'
          });

          break;
        }

        directFolders++;

        if (!recursive) {
          continue;
        }

        try {

          var childId = child.getId();
          var childName = child.getName();

          newTasks.push({
            module: GDM_MODULES.ANALYSIS,
            action: GDM_ACTIONS.ANALYZE_FOLDER,
            itemId: childId,
            itemName: childName,
            payload: {
              folderId: childId,
              recursive: true,
              depth:
                Math.max(
                  0,
                  GDM_Utils.toInteger(payload.depth, 0)
                ) + 1
            },
            maxRetries: 1
          });

        } catch (childInfoError) {

          this.addError_(result, childInfoError, {
            itemId: this.safeGetId_(child),
            itemName: this.safeGetName_(child),
            folderId: folderId,
            folderName: folderName,
            type: 'CHILD_FOLDER_INFO'
          });
        }
      }

    } catch (foldersOpenError) {

      this.addError_(result, foldersOpenError, {
        itemId: folderId,
        itemName: folderName,
        type: 'FOLDERS_OPEN'
      });
    }


    /**********************************************************************************************
     * DOSSIER VIDE
     **********************************************************************************************/
    if (
      GDM_Config.get('ANALYSIS.DETECT_EMPTY_FOLDERS', true) &&
      directFiles === 0 &&
      directFolders === 0
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


    /**********************************************************************************************
     * SAUVEGARDE AVANT D'AJOUTER LES SOUS-DOSSIERS
     *
     * Le résultat est volontairement compacté afin d'éviter la saturation PropertiesService.
     **********************************************************************************************/
    result.updatedAt = GDM_Utils.nowIso();

    this.saveResultSafely_(jobId, result);


    /**********************************************************************************************
     * AJOUT DES SOUS-DOSSIERS À LA QUEUE
     **********************************************************************************************/
    if (recursive && newTasks.length) {

      try {

        var added = GDM_Queue.addInBatches(
          jobId,
          newTasks,
          GDM_Config.get('QUEUE.MAX_ITEMS_PER_BATCH', 250)
        );

        var addedCount = added && added.length
          ? added.length
          : newTasks.length;

        var latestState = GDM_State.require(jobId);

        GDM_State.setTotalKnown(
          jobId,
          Number(latestState.totalKnown || 0) + addedCount
        );

      } catch (queueAddError) {

        // Important : on enregistre l'erreur, mais on ne lance pas une boucle infinie de retry.
        result = this.getResult(jobId) || result;

        this.addError_(result, queueAddError, {
          itemId: folderId,
          itemName: folderName,
          type: 'QUEUE_ADD'
        });

        result.updatedAt = GDM_Utils.nowIso();
        this.saveResultSafely_(jobId, result);

        return {
          ok: true,
          skipped: false,
          message:
            'Dossier analysé, mais certains sous-dossiers n’ont pas pu être ajoutés à la file : ' +
            folderName,
          data: {
            folderId: folderId,
            files: directFiles,
            subfolders: directFolders,
            queuedFolders: 0
          }
        };
      }
    }

    return {
      ok: true,
      skipped: false,
      message: 'Dossier analysé : ' + folderName,
      data: {
        folderId: folderId,
        files: directFiles,
        subfolders: directFolders,
        queuedFolders: newTasks.length
      }
    };
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
      version: '2.1.0',
      readOnly: true,
      antiStorageOverflow: true,
      resultStoreSeparated: true,
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
