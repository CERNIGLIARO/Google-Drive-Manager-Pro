/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Analysis.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Analyse progressive de Google Drive ou d'un dossier sélectionné.
 *
 * Ce module analyse :
 * - nombre de fichiers ;
 * - nombre de dossiers ;
 * - taille totale connue ;
 * - extensions ;
 * - types MIME ;
 * - gros fichiers ;
 * - anciens fichiers ;
 * - dossiers vides ;
 * - fichiers sans extension ;
 * - raccourcis ;
 * - erreurs rencontrées.
 *
 * CONCEPTION GROS DRIVE
 * ---------------------
 * L'analyse ne charge jamais tout Google Drive en mémoire.
 *
 * Chaque dossier devient une tâche indépendante :
 *
 * ANALYZE_FOLDER
 *      ↓
 * fichiers directs
 *      ↓
 * sous-dossiers
 *      ↓
 * nouvelles tâches dans Queue
 *
 * L'analyse peut donc reprendre automatiquement après interruption Apps Script.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 * Core/State.gs
 * Core/Queue.gs
 * Core/Engine.gs
 * Modules/Explorer.gs
 *
 * IMPORTANT
 * ---------
 * - Module 100 % lecture seule.
 * - Aucun fichier n'est déplacé.
 * - Aucun fichier n'est renommé.
 * - Aucun fichier n'est supprimé.
 **************************************************************************************************/

'use strict';


const GDM_Analysis = Object.freeze({


  /************************************************************************************************
   * STOCKAGE
   ************************************************************************************************/

  RESULT_PREFIX_: 'GDMV2_ANALYSIS_RESULT_',


  /************************************************************************************************
   * LANCER UNE ANALYSE
   ************************************************************************************************/

  start: function(options) {

    options = options || {};

    var rootFolder =
      GDM_Utils.getFolderOrRoot(
        options.folderId ||
        options.sourceFolderId ||
        ''
      );

    var sourceFolderId =
      rootFolder.getId();

    var sourceFolderName =
      sourceFolderId ===
      DriveApp.getRootFolder().getId()
        ? GDM_Config.get(
            'APP.ROOT_LABEL',
            'Mon Drive'
          )
        : rootFolder.getName();


    var recursive =
      typeof options.recursive ===
        'undefined'
        ? GDM_Config.get(
            'ANALYSIS.INCLUDE_SUBFOLDERS_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.recursive,
            true
          );


    var largeFileMB =
      Math.max(
        1,
        GDM_Utils.toNumber(
          options.largeFileMB,
          GDM_Config.get(
            'ANALYSIS.LARGE_FILE_MB',
            100
          )
        )
      );


    var oldFileDays =
      Math.max(
        1,
        GDM_Utils.toInteger(
          options.oldFileDays,
          GDM_Config.get(
            'ANALYSIS.OLD_FILE_DAYS',
            365
          )
        )
      );


    /**********************************************************************************************
     * CRÉATION JOB
     **********************************************************************************************/

    var state =
      GDM_State.create({
        module:
          GDM_MODULES.ANALYSIS,

        action:
          sourceFolderId ===
            DriveApp.getRootFolder().getId()
              ? GDM_ACTIONS.ANALYZE_DRIVE
              : GDM_ACTIONS.ANALYZE_FOLDER,

        source: {
          id:
            sourceFolderId,

          name:
            sourceFolderName
        },

        parameters: {
          recursive:
            recursive,

          largeFileMB:
            largeFileMB,

          oldFileDays:
            oldFileDays
        },

        totalKnown:
          1,

        setCurrent:
          true,

        message:
          'Analyse préparée.'
      });


    var jobId =
      state.jobId;


    /**********************************************************************************************
     * INITIALISER LE RÉSULTAT
     **********************************************************************************************/

    this.initializeResult_(
      jobId,
      {
        source: {
          id:
            sourceFolderId,

          name:
            sourceFolderName
        },

        recursive:
          recursive,

        largeFileMB:
          largeFileMB,

        oldFileDays:
          oldFileDays
      }
    );


    /**********************************************************************************************
     * QUEUE
     **********************************************************************************************/

    GDM_Queue.create(
      jobId
    );


    GDM_Queue.add(
      jobId,
      {
        module:
          GDM_MODULES.ANALYSIS,

        action:
          GDM_ACTIONS.ANALYZE_FOLDER,

        itemId:
          sourceFolderId,

        itemName:
          sourceFolderName,

        payload: {
          folderId:
            sourceFolderId,

          recursive:
            recursive,

          depth:
            0
        }
      }
    );


    GDM_State.setTotalKnown(
      jobId,
      1
    );


    try {

      GDM_Logger.scanStarted(
        jobId,
        {
          module:
            GDM_MODULES.ANALYSIS,

          action:
            state.action,

          itemId:
            sourceFolderId,

          itemName:
            sourceFolderName,

          message:
            'Analyse de "' +
            sourceFolderName +
            '" démarrée.'
        }
      );

    } catch (ignored) {}


    /**********************************************************************************************
     * ASYNCHRONE PAR DÉFAUT
     **********************************************************************************************/

    var asyncMode =
      typeof options.async ===
        'undefined'
        ? true
        : GDM_Utils.toBoolean(
            options.async,
            true
          );


    var engineResult =
      GDM_Engine.start(
        jobId,
        {
          async:
            asyncMode
        }
      );


    return {
      ok: true,

      jobId:
        jobId,

      source: {
        id:
          sourceFolderId,

        name:
          sourceFolderName
      },

      recursive:
        recursive,

      state:
        GDM_State.getSummary(
          jobId
        ),

      queue:
        GDM_Queue.getMeta(
          jobId
        ),

      engine:
        engineResult
    };
  },


  /************************************************************************************************
   * PROCESS TASK
   ************************************************************************************************/

  processTask: function(task, context) {

    task =
      task || {};

    context =
      context || {};

    switch (
      task.action
    ) {

      case GDM_ACTIONS.ANALYZE_FOLDER:

        return this.processFolderTask_(
          task,
          context
        );


      case GDM_ACTIONS.ANALYZE_ITEM:

        return this.processFileTask_(
          task,
          context
        );


      default:

        throw new Error(
          'Analysis : action inconnue : ' +
          GDM_Utils.toString(
            task.action
          )
        );
    }
  },


  /************************************************************************************************
   * ANALYSE D'UN DOSSIER
   ************************************************************************************************/

  processFolderTask_: function(
    task,
    context
  ) {

    var jobId =
      task.jobId ||
      context.jobId;

    var payload =
      task.payload ||
      {};

    var folderId =
      payload.folderId ||
      task.itemId;

    folderId =
      GDM_Utils.requireString(
        folderId,
        'folderId'
      );


    var folder =
      DriveApp.getFolderById(
        folderId
      );


    var state =
      GDM_State.require(
        jobId
      );


    var parameters =
      state.parameters ||
      {};


    var recursive =
      typeof payload.recursive ===
        'undefined'
        ? GDM_Utils.toBoolean(
            parameters.recursive,
            true
          )
        : GDM_Utils.toBoolean(
            payload.recursive,
            true
          );


    var result =
      this.getResult(
        jobId
      );


    if (!result) {

      throw new Error(
        'Résultat d’analyse introuvable pour le job ' +
        jobId
      );
    }


    /**********************************************************************************************
     * STATISTIQUES DU DOSSIER
     **********************************************************************************************/

    result.totals.folders++;

    var directFiles = 0;
    var directFolders = 0;


    /**********************************************************************************************
     * FICHIERS DIRECTS
     **********************************************************************************************/

    var files =
      folder.getFiles();


    while (
      files.hasNext()
    ) {

      var file =
        files.next();

      directFiles++;

      try {

        this.analyzeFile_(
          result,
          file,
          folder
        );

      } catch (fileError) {

        this.addError_(
          result,
          fileError,
          {
            itemId:
              this.safeGetId_(file),

            itemName:
              this.safeGetName_(file),

            folderId:
              folderId,

            folderName:
              folder.getName()
          }
        );
      }
    }


    /**********************************************************************************************
     * SOUS-DOSSIERS
     **********************************************************************************************/

    var folders =
      folder.getFolders();

    var newTasks = [];


    while (
      folders.hasNext()
    ) {

      var child =
        folders.next();

      directFolders++;


      if (recursive) {

        newTasks.push({
          module:
            GDM_MODULES.ANALYSIS,

          action:
            GDM_ACTIONS.ANALYZE_FOLDER,

          itemId:
            child.getId(),

          itemName:
            child.getName(),

          payload: {
            folderId:
              child.getId(),

            recursive:
              true,

            depth:
              Math.max(
                0,
                GDM_Utils.toInteger(
                  payload.depth,
                  0
                )
              ) + 1
          }
        });
      }
    }


    /**********************************************************************************************
     * DOSSIER VIDE
     **********************************************************************************************/

    if (
      GDM_Config.get(
        'ANALYSIS.DETECT_EMPTY_FOLDERS',
        true
      ) &&
      directFiles === 0 &&
      directFolders === 0
    ) {

      result.counters.emptyFolders++;

      this.pushLimited_(
        result.emptyFolders,
        {
          id:
            folderId,

          name:
            folder.getName(),

          url:
            GDM_Utils.getDriveFolderUrl(
              folderId
            )
        },
        this.getResultListLimit_(),
        result.truncated,
        'emptyFolders'
      );
    }


    /**********************************************************************************************
     * AJOUTER LES SOUS-DOSSIERS À LA QUEUE
     **********************************************************************************************/

    if (
      recursive &&
      newTasks.length
    ) {

      GDM_Queue.addInBatches(
        jobId,
        newTasks,
        GDM_Config.get(
          'QUEUE.MAX_ITEMS_PER_BATCH',
          250
        )
      );


      var latestState =
        GDM_State.require(
          jobId
        );


      GDM_State.setTotalKnown(
        jobId,
        Number(
          latestState.totalKnown || 0
        ) +
        newTasks.length
      );
    }


    /**********************************************************************************************
     * ENREGISTRER LE RÉSULTAT
     **********************************************************************************************/

    result.updatedAt =
      GDM_Utils.nowIso();


    this.saveResult_(
      jobId,
      result
    );


    return {
      ok: true,

      skipped: false,

      message:
        'Dossier analysé : ' +
        folder.getName(),

      data: {
        folderId:
          folderId,

        files:
          directFiles,

        subfolders:
          directFolders,

        queuedFolders:
          newTasks.length
      }
    };
  },


  /************************************************************************************************
   * ANALYSE D'UN FICHIER ISOLÉ
   *
   * Disponible pour de futurs scénarios où chaque fichier devient une tâche.
   ************************************************************************************************/

  processFileTask_: function(
    task,
    context
  ) {

    var jobId =
      task.jobId ||
      context.jobId;

    var fileId =
      (
        task.payload &&
        task.payload.fileId
      ) ||
      task.itemId;


    fileId =
      GDM_Utils.requireString(
        fileId,
        'fileId'
      );


    var file =
      DriveApp.getFileById(
        fileId
      );


    var result =
      this.getResult(
        jobId
      );


    if (!result) {

      throw new Error(
        'Résultat d’analyse introuvable.'
      );
    }


    this.analyzeFile_(
      result,
      file,
      null
    );


    result.updatedAt =
      GDM_Utils.nowIso();


    this.saveResult_(
      jobId,
      result
    );


    return {
      ok: true,

      message:
        'Fichier analysé : ' +
        file.getName(),

      data: {
        fileId:
          fileId
      }
    };
  },


  /************************************************************************************************
   * ANALYSE D'UN FICHIER
   ************************************************************************************************/

  analyzeFile_: function(
    result,
    file,
    parentFolder
  ) {

    var fileId =
      file.getId();

    var fileName =
      file.getName();

    var mimeType =
      file.getMimeType();

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


    var extension =
      GDM_Utils.getExtension(
        fileName
      );


    var parentId = '';
    var parentName = '';


    if (parentFolder) {

      parentId =
        parentFolder.getId();

      parentName =
        parentFolder.getName();

    } else {

      var parent =
        GDM_Utils.getFirstParentInfo(
          file
        );

      parentId =
        parent.id;

      parentName =
        parent.name;
    }


    /**********************************************************************************************
     * TOTAL
     **********************************************************************************************/

    result.totals.files++;

    result.totals.bytes +=
      size;


    /**********************************************************************************************
     * EXTENSION
     **********************************************************************************************/

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
    ].bytes +=
      size;


    /**********************************************************************************************
     * MIME
     **********************************************************************************************/

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
    ].bytes +=
      size;


    /**********************************************************************************************
     * OBJET FICHIER MINIMAL
     **********************************************************************************************/

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
        file.getUrl()
    };


    /**********************************************************************************************
     * GROS FICHIERS
     **********************************************************************************************/

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
          GDM_Utils.toPositiveInteger(
            GDM_Config.get(
              'ANALYSIS.TOP_FILES',
              200
            ),
            200
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


    /**********************************************************************************************
     * ANCIENS FICHIERS
     **********************************************************************************************/

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


    /**********************************************************************************************
     * SANS EXTENSION
     **********************************************************************************************/

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


    /**********************************************************************************************
     * RACCOURCIS
     **********************************************************************************************/

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
  },


  /************************************************************************************************
   * INITIALISATION DU RÉSULTAT
   ************************************************************************************************/

  initializeResult_: function(
    jobId,
    options
  ) {

    options =
      options || {};


    var result = {

      schemaVersion:
        1,

      jobId:
        jobId,

      module:
        GDM_MODULES.ANALYSIS,

      source: {
        id:
          options.source &&
          options.source.id
            ? options.source.id
            : '',

        name:
          options.source &&
          options.source.name
            ? options.source.name
            : ''
      },

      parameters: {
        recursive:
          GDM_Utils.toBoolean(
            options.recursive,
            true
          ),

        largeFileMB:
          GDM_Utils.toNumber(
            options.largeFileMB,
            GDM_Config.get(
              'ANALYSIS.LARGE_FILE_MB',
              100
            )
          ),

        oldFileDays:
          GDM_Utils.toInteger(
            options.oldFileDays,
            GDM_Config.get(
              'ANALYSIS.OLD_FILE_DAYS',
              365
            )
          )
      },

      startedAt:
        GDM_Utils.nowIso(),

      updatedAt:
        GDM_Utils.nowIso(),

      finishedAt:
        '',

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
        errors: false
      }
    };


    this.saveResult_(
      jobId,
      result
    );


    return result;
  },


  /************************************************************************************************
   * RÉSULTAT PUBLIC
   ************************************************************************************************/

  getResult: function(jobId) {

    jobId =
      GDM_Utils.trim(
        jobId
      );

    if (!jobId) {
      return null;
    }


    var result =
      this.readResult_(
        jobId
      );


    if (!result) {
      return null;
    }


    /*
     * Ajout d'informations calculées sans modifier le stockage.
     */
    result.summary = {
      totalSizeFormatted:
        GDM_Utils.formatBytes(
          result.totals &&
          result.totals.bytes
            ? result.totals.bytes
            : 0
        ),

      files:
        Number(
          result.totals &&
          result.totals.files
            ? result.totals.files
            : 0
        ),

      folders:
        Number(
          result.totals &&
          result.totals.folders
            ? result.totals.folders
            : 0
        )
    };


    var state =
      GDM_State.get(
        jobId
      );


    if (
      state &&
      state.status ===
        GDM_JOB_STATUS.COMPLETED &&
      !result.finishedAt
    ) {

      result.finishedAt =
        state.finishedAt ||
        GDM_Utils.nowIso();
    }


    return result;
  },


  /************************************************************************************************
   * STATUT + RÉSULTAT
   ************************************************************************************************/

  getStatus: function(jobId) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );


    return {
      ok: true,

      jobId:
        jobId,

      state:
        GDM_State.getSummary(
          jobId
        ),

      queue:
        GDM_Queue.getMeta(
          jobId
        ),

      analysis:
        this.getResult(
          jobId
        )
    };
  },


  /************************************************************************************************
   * FINALISER LE RÉSULTAT D'ANALYSE
   *
   * Peut être appelée par l'interface ou par le futur système de finalisation module.
   ************************************************************************************************/

  finalizeResult: function(jobId) {

    var result =
      this.getResult(
        jobId
      );


    if (!result) {
      return null;
    }


    result.finishedAt =
      GDM_Utils.nowIso();


    result.updatedAt =
      result.finishedAt;


    this.saveResult_(
      jobId,
      result
    );


    try {

      GDM_Logger.scanCompleted(
        jobId,
        {
          module:
            GDM_MODULES.ANALYSIS,

          action:
            GDM_ACTIONS.ANALYZE_FOLDER,

          message:
            'Analyse terminée.',

          data: {
            files:
              result.totals.files,

            folders:
              result.totals.folders,

            bytes:
              result.totals.bytes,

            errors:
              result.counters.errors
          }
        }
      );

    } catch (ignored) {}


    return result;
  },


  /************************************************************************************************
   * SUPPRIMER LE RÉSULTAT TECHNIQUE
   *
   * Ne supprime aucun fichier Google Drive.
   ************************************************************************************************/

  deleteResult: function(jobId) {

    var key =
      this.getResultKey_(
        jobId
      );


    return this.deleteChunked_(
      key
    );
  },


  /************************************************************************************************
   * ERREURS
   ************************************************************************************************/

  addError_: function(
    result,
    error,
    context
  ) {

    result.counters.errors++;


    this.pushLimited_(
      result.errors,
      GDM_Utils.errorToObject(
        error,
        context || {}
      ),
      Math.min(
        this.getResultListLimit_(),
        1000
      ),
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

    if (
      array.length <
      limit
    ) {

      array.push(
        value
      );

      return true;
    }


    if (
      truncatedObject &&
      truncatedKey
    ) {

      truncatedObject[
        truncatedKey
      ] = true;
    }


    return false;
  },


  getResultListLimit_: function() {

    return GDM_Utils.toPositiveInteger(
      GDM_Config.get(
        'UI.RESULT_MAX_ROWS',
        5000
      ),
      5000
    );
  },


  /************************************************************************************************
   * STOCKAGE DU RÉSULTAT
   ************************************************************************************************/

  getResultKey_: function(jobId) {

    return this.RESULT_PREFIX_ +
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );
  },


  saveResult_: function(
    jobId,
    result
  ) {

    var key =
      this.getResultKey_(
        jobId
      );


    return this.writeChunked_(
      key,
      result
    );
  },


  readResult_: function(jobId) {

    var key =
      this.getResultKey_(
        jobId
      );


    return this.readChunked_(
      key
    );
  },


  /************************************************************************************************
   * STOCKAGE FRACTIONNÉ
   ************************************************************************************************/

  writeChunked_: function(
    baseKey,
    value
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        var properties =
          PropertiesService
            .getScriptProperties();


        var json =
          GDM_Utils.safeJsonStringify(
            value,
            '{}'
          );


        var chunkSize =
          Math.max(
            1000,
            GDM_Utils.toInteger(
              GDM_Config.get(
                'STATE.PROPERTY_CHUNK_SIZE',
                7000
              ),
              7000
            )
          );


        /*
         * Ce résultat peut être plus volumineux que State/Queue.
         * On autorise davantage de morceaux tout en restant raisonnable.
         */
        var maxChunks =
          Math.max(
            100,
            GDM_Utils.toInteger(
              GDM_Config.get(
                'STATE.MAX_CHUNKS',
                100
              ),
              100
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
          chunks.push(
            '{}'
          );
        }


        if (
          chunks.length >
          maxChunks
        ) {

          throw new Error(
            'Résultat d’analyse trop volumineux pour PropertiesService (' +
            chunks.length +
            ' morceaux).'
          );
        }


        var oldMeta =
          GDM_Utils.safeJsonParse(
            properties.getProperty(
              baseKey + '_META'
            ),
            {}
          );


        var oldCount =
          Math.max(
            0,
            GDM_Utils.toInteger(
              oldMeta.chunkCount,
              0
            )
          );


        for (
          var c = 0;
          c < chunks.length;
          c++
        ) {

          properties.setProperty(
            baseKey +
            '_PART_' +
            c,
            chunks[c]
          );
        }


        for (
          var oldIndex =
            chunks.length;
          oldIndex <
            oldCount;
          oldIndex++
        ) {

          properties.deleteProperty(
            baseKey +
            '_PART_' +
            oldIndex
          );
        }


        properties.setProperty(
          baseKey + '_META',
          JSON.stringify({
            chunkCount:
              chunks.length,

            length:
              json.length,

            updatedAt:
              GDM_Utils.nowIso()
          })
        );


        properties.deleteProperty(
          baseKey
        );


        return true;

      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  readChunked_: function(baseKey) {

    var properties =
      PropertiesService
        .getScriptProperties();


    var metaRaw =
      properties.getProperty(
        baseKey + '_META'
      );


    if (!metaRaw) {

      var direct =
        properties.getProperty(
          baseKey
        );


      return direct
        ? GDM_Utils.safeJsonParse(
            direct,
            null
          )
        : null;
    }


    var meta =
      GDM_Utils.safeJsonParse(
        metaRaw,
        {}
      );


    var count =
      Math.max(
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

      var part =
        properties.getProperty(
          baseKey +
          '_PART_' +
          i
        );


      if (
        part === null
      ) {
        return null;
      }


      json += part;
    }


    return GDM_Utils.safeJsonParse(
      json,
      null
    );
  },


  deleteChunked_: function(baseKey) {

    return GDM_Utils.withScriptLock(
      function() {

        var properties =
          PropertiesService
            .getScriptProperties();


        var meta =
          GDM_Utils.safeJsonParse(
            properties.getProperty(
              baseKey + '_META'
            ),
            {}
          );


        var count =
          Math.max(
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

          properties.deleteProperty(
            baseKey +
            '_PART_' +
            i
          );
        }


        properties.deleteProperty(
          baseKey + '_META'
        );


        properties.deleteProperty(
          baseKey
        );


        return true;

      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
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
   * VALIDATION DU MODULE
   ************************************************************************************************/

  validate: function() {

    var errors = [];


    try {

      var root =
        DriveApp.getRootFolder();


      if (
        !root ||
        !root.getId()
      ) {

        errors.push(
          'Impossible d’accéder à Mon Drive.'
        );
      }

    } catch (error1) {

      errors.push(
        'Erreur accès Google Drive : ' +
        GDM_Utils.getErrorMessage(
          error1
        )
      );
    }


    try {

      var testResult = {
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

        parameters: {
          largeFileMB: 100,
          oldFileDays: 365
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
          errors: false
        }
      };


      if (
        typeof testResult.totals.files !==
        'number'
      ) {

        errors.push(
          'Structure de résultat incorrecte.'
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur structure Analysis : ' +
        GDM_Utils.getErrorMessage(
          error2
        )
      );
    }


    return {
      ok:
        errors.length === 0,

      file:
        'Modules/Analysis.gs',

      version:
        GDM_APP.VERSION,

      readOnly:
        true,

      errors:
        errors
    };
  }

});


/**************************************************************************************************
 * API GLOBALE OPTIONNELLE POUR L'INTERFACE
 *
 * Permet d'obtenir le résultat détaillé de l'analyse sans utiliser le résultat générique Engine.
 **************************************************************************************************/

function GDM_apiGetAnalysisResult(jobId) {

  return {
    ok: true,

    jobId:
      jobId,

    state:
      GDM_State.getSummary(
        jobId
      ),

    queue:
      GDM_Queue.getMeta(
        jobId
      ),

    result:
      GDM_Analysis.getResult(
        jobId
      )
  };
}