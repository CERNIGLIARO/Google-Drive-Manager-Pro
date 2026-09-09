/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Analysis.gs
 * Version : 2.2.0
 *
 * MODE RAPIDE + ANTI-BLOCAGE
 * --------------------------
 * Objectif : empêcher qu'un seul gros dossier monopolise une exécution Apps Script.
 *
 * Principe :
 * - les enfants d'un dossier sont lus via Google Drive API v3 par pages ;
 * - UNE tâche de queue traite UNE page (100 éléments par défaut) ;
 * - s'il reste des éléments, une tâche "continuation" est ajoutée avec nextPageToken ;
 * - les sous-dossiers deviennent chacun une nouvelle tâche ;
 * - aucune tâche Analysis ne doit parcourir des milliers de fichiers d'un seul coup ;
 * - le résultat détaillé est stocké séparément et compacté.
 *
 * IMPORTANT :
 * - lecture seule : aucun fichier Drive n'est déplacé, renommé ou supprimé ;
 * - aucun "Advanced Drive Service" à activer : UrlFetchApp + jeton OAuth Apps Script sont utilisés ;
 * - au premier lancement de cette version, Google peut demander une autorisation supplémentaire.
 **************************************************************************************************/
'use strict';


const GDM_Analysis = Object.freeze({

  RESULT_PREFIX_: 'GDMV2_ANALYSIS_RESULT_',

  // Nombre maximum d'éléments Drive traités par tâche.
  // 100 garde une très grande marge sous la limite Apps Script de 6 minutes.
  PAGE_SIZE_: 100,

  // Stockage résultat.
  MAX_RESULT_JSON_CHARS_: 180000,
  MAX_DETAIL_ROWS_: 250,
  MAX_ERROR_ROWS_: 100,
  MAX_MAP_KEYS_: 300,


  /************************************************************************************************
   * DÉMARRER UNE ANALYSE
   ************************************************************************************************/
  start: function(options) {

    options = options || {};

    // Nettoyage des anciens résultats Analysis uniquement.
    // AUCUN fichier Drive n'est supprimé.
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
        oldFileDays: oldFileDays,
        analysisPageSize: this.PAGE_SIZE_
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
        pageToken: '',
        continuation: false
      },
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
      pageSize: this.PAGE_SIZE_,
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
        return this.processFolderPageTask_(task, context);

      case GDM_ACTIONS.ANALYZE_ITEM:
        return this.processFileTask_(task, context);

      default:
        return {
          ok: true,
          skipped: true,
          message:
            'Analysis : action inconnue ignorée : ' +
            GDM_Utils.toString(task.action)
        };
    }
  },


  /************************************************************************************************
   * TRAITER UNE PAGE D'UN DOSSIER
   *
   * C'est la correction majeure 2.2.0 :
   * on ne boucle JAMAIS sur la totalité d'un gros dossier en une seule tâche.
   ************************************************************************************************/
  processFolderPageTask_: function(task, context) {

    var jobId = task.jobId || context.jobId;
    var payload = task.payload || {};

    var folderId = GDM_Utils.requireString(
      payload.folderId || task.itemId,
      'folderId'
    );

    var folderName =
      GDM_Utils.toString(
        payload.folderName ||
        task.itemName ||
        folderId
      );

    var pageToken =
      GDM_Utils.trim(payload.pageToken || '');

    var isContinuation =
      payload.continuation === true ||
      Boolean(pageToken);

    var state = GDM_State.require(jobId);
    var parameters = state.parameters || {};

    var recursive =
      typeof payload.recursive === 'undefined'
        ? GDM_Utils.toBoolean(parameters.recursive, true)
        : GDM_Utils.toBoolean(payload.recursive, true);

    var depth = Math.max(
      0,
      GDM_Utils.toInteger(payload.depth, 0)
    );

    var result = this.getResult(jobId);

    if (!result) {
      result = this.initializeResult_(jobId, {
        source: state.source || {},
        recursive: recursive,
        largeFileMB: parameters.largeFileMB,
        oldFileDays: parameters.oldFileDays
      });
    }

    // Un dossier n'est compté qu'à sa première page.
    if (!isContinuation) {
      result.totals.folders++;
    }

    var page;

    try {
      page = this.fetchChildrenPage_(
        folderId,
        pageToken,
        this.PAGE_SIZE_
      );

    } catch (apiError) {

      this.addError_(result, apiError, {
        itemId: folderId,
        itemName: folderName,
        pageToken: pageToken,
        type: 'DRIVE_API_LIST'
      });

      result.updatedAt = GDM_Utils.nowIso();
      this.saveResultSafely_(jobId, result);

      // Une erreur d'accès à ce dossier ne doit pas créer une boucle infinie.
      return {
        ok: true,
        skipped: true,
        message:
          'Dossier inaccessible ignoré : ' +
          folderName
      };
    }

    var items = Array.isArray(page.files)
      ? page.files
      : [];

    var newTasks = [];
    var directFiles = 0;
    var directFolders = 0;

    for (var i = 0; i < items.length; i++) {

      var item = items[i] || {};
      var mimeType = GDM_Utils.toString(item.mimeType);

      if (
        mimeType === 'application/vnd.google-apps.folder'
      ) {

        directFolders++;

        if (recursive) {

          newTasks.push({
            module: GDM_MODULES.ANALYSIS,
            action: GDM_ACTIONS.ANALYZE_FOLDER,
            itemId: item.id || '',
            itemName: item.name || '',
            payload: {
              folderId: item.id || '',
              folderName: item.name || '',
              recursive: true,
              depth: depth + 1,
              pageToken: '',
              continuation: false
            },
            maxRetries: 1
          });
        }

        continue;
      }

      directFiles++;

      try {
        this.analyzeFileMetadata_(
          result,
          item,
          {
            id: folderId,
            name: folderName
          }
        );

      } catch (fileError) {

        this.addError_(result, fileError, {
          itemId: item.id || '',
          itemName: item.name || '',
          folderId: folderId,
          folderName: folderName,
          type: 'FILE_METADATA_ANALYSIS'
        });
      }
    }


    /**********************************************************************************************
     * DOSSIER VIDE
     **********************************************************************************************/
    if (
      !isContinuation &&
      GDM_Config.get('ANALYSIS.DETECT_EMPTY_FOLDERS', true) &&
      items.length === 0 &&
      !page.nextPageToken
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
     * CONTINUATION DU MÊME DOSSIER
     *
     * Le nextPageToken devient une nouvelle petite tâche.
     **********************************************************************************************/
    if (page.nextPageToken) {

      newTasks.push({
        module: GDM_MODULES.ANALYSIS,
        action: GDM_ACTIONS.ANALYZE_FOLDER,
        itemId: folderId,
        itemName: folderName + ' (suite)',
        payload: {
          folderId: folderId,
          folderName: folderName,
          recursive: recursive,
          depth: depth,
          pageToken: page.nextPageToken,
          continuation: true
        },
        maxRetries: 1
      });
    }


    /**********************************************************************************************
     * SAUVEGARDE DU RÉSULTAT : UNE FOIS PAR PAGE
     **********************************************************************************************/
    result.updatedAt = GDM_Utils.nowIso();

    this.saveResultSafely_(jobId, result);


    /**********************************************************************************************
     * AJOUT DES TÂCHES DÉCOUVERTES
     **********************************************************************************************/
    if (newTasks.length) {

      try {

        var added = GDM_Queue.addInBatches(
          jobId,
          newTasks,
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
            : newTasks.length;

        var latestState = GDM_State.require(jobId);

        GDM_State.setTotalKnown(
          jobId,
          Number(latestState.totalKnown || 0) +
          addedCount
        );

      } catch (queueAddError) {

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
            'Page analysée, mais certaines tâches suivantes n’ont pas pu être ajoutées.',
          data: {
            folderId: folderId,
            files: directFiles,
            subfolders: directFolders,
            nextPage: Boolean(page.nextPageToken),
            queuedTasks: 0
          }
        };
      }
    }

    return {
      ok: true,
      skipped: false,
      message:
        'Page analysée : ' +
        folderName +
        ' (' +
        items.length +
        ' élément(s))',
      data: {
        folderId: folderId,
        files: directFiles,
        subfolders: directFolders,
        nextPage: Boolean(page.nextPageToken),
        queuedTasks: newTasks.length
      }
    };
  },


  /************************************************************************************************
   * DRIVE API V3 : LIRE UNE PAGE D'ENFANTS
   *
   * Aucun service avancé à activer.
   ************************************************************************************************/
  fetchChildrenPage_: function(
    folderId,
    pageToken,
    pageSize
  ) {

    folderId = GDM_Utils.requireString(
      folderId,
      'folderId'
    );

    pageToken = GDM_Utils.trim(pageToken || '');

    pageSize = Math.max(
      10,
      Math.min(
        200,
        GDM_Utils.toPositiveInteger(
          pageSize,
          this.PAGE_SIZE_
        )
      )
    );

    var q =
      "'" +
      folderId.replace(/'/g, "\\'") +
      "' in parents and trashed = false";

    var params = [
      'pageSize=' + encodeURIComponent(pageSize),
      'spaces=drive',
      'supportsAllDrives=true',
      'includeItemsFromAllDrives=true',
      'q=' + encodeURIComponent(q),
      'fields=' + encodeURIComponent(
        'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)'
      )
    ];

    if (pageToken) {
      params.push(
        'pageToken=' +
        encodeURIComponent(pageToken)
      );
    }

    var url =
      'https://www.googleapis.com/drive/v3/files?' +
      params.join('&');

    var response = UrlFetchApp.fetch(
      url,
      {
        method: 'get',
        headers: {
          Authorization:
            'Bearer ' +
            ScriptApp.getOAuthToken()
        },
        muteHttpExceptions: true
      }
    );

    var status =
      response.getResponseCode();

    var text =
      response.getContentText();

    var body =
      GDM_Utils.safeJsonParse(
        text,
        {}
      );

    if (
      status < 200 ||
      status >= 300
    ) {

      var apiMessage = '';

      try {
        apiMessage =
          body &&
          body.error &&
          body.error.message
            ? body.error.message
            : '';
      } catch (ignoredMessage) {}

      throw new Error(
        'Drive API HTTP ' +
        status +
        (
          apiMessage
            ? ' : ' + apiMessage
            : ''
        )
      );
    }

    return {
      files:
        Array.isArray(body.files)
          ? body.files
          : [],
      nextPageToken:
        GDM_Utils.trim(
          body.nextPageToken || ''
        )
    };
  },


  /************************************************************************************************
   * ANALYSE D'UN FICHIER ISOLÉ
   ************************************************************************************************/
  processFileTask_: function(task, context) {

    var jobId = task.jobId || context.jobId;

    var fileId =
      (task.payload && task.payload.fileId) ||
      task.itemId;

    fileId = GDM_Utils.requireString(
      fileId,
      'fileId'
    );

    var result = this.getResult(jobId);

    if (!result) {

      var state = GDM_State.require(jobId);

      result = this.initializeResult_(jobId, {
        source: state.source || {},
        recursive:
          state.parameters &&
          state.parameters.recursive,
        largeFileMB:
          state.parameters &&
          state.parameters.largeFileMB,
        oldFileDays:
          state.parameters &&
          state.parameters.oldFileDays
      });
    }

    try {

      var metadata =
        this.fetchFileMetadata_(fileId);

      this.analyzeFileMetadata_(
        result,
        metadata,
        {
          id: '',
          name: ''
        }
      );

      result.updatedAt =
        GDM_Utils.nowIso();

      this.saveResultSafely_(
        jobId,
        result
      );

      return {
        ok: true,
        skipped: false,
        message:
          'Fichier analysé : ' +
          GDM_Utils.toString(metadata.name),
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

      result.updatedAt =
        GDM_Utils.nowIso();

      this.saveResultSafely_(
        jobId,
        result
      );

      return {
        ok: true,
        skipped: true,
        message:
          'Fichier inaccessible ignoré : ' +
          (task.itemName || fileId)
      };
    }
  },


  /************************************************************************************************
   * DRIVE API V3 : MÉTADONNÉES D'UN FICHIER
   ************************************************************************************************/
  fetchFileMetadata_: function(fileId) {

    var url =
      'https://www.googleapis.com/drive/v3/files/' +
      encodeURIComponent(fileId) +
      '?supportsAllDrives=true&fields=' +
      encodeURIComponent(
        'id,name,mimeType,size,modifiedTime,webViewLink'
      );

    var response = UrlFetchApp.fetch(
      url,
      {
        method: 'get',
        headers: {
          Authorization:
            'Bearer ' +
            ScriptApp.getOAuthToken()
        },
        muteHttpExceptions: true
      }
    );

    var status =
      response.getResponseCode();

    var body =
      GDM_Utils.safeJsonParse(
        response.getContentText(),
        {}
      );

    if (
      status < 200 ||
      status >= 300
    ) {

      var message =
        body &&
        body.error &&
        body.error.message
          ? body.error.message
          : '';

      throw new Error(
        'Drive API HTTP ' +
        status +
        (
          message
            ? ' : ' + message
            : ''
        )
      );
    }

    return body;
  },


  /************************************************************************************************
   * ANALYSER LES MÉTADONNÉES D'UN FICHIER
   ************************************************************************************************/
  analyzeFileMetadata_: function(
    result,
    item,
    parent
  ) {

    item = item || {};
    parent = parent || {};

    var fileId =
      GDM_Utils.toString(item.id);

    var fileName =
      GDM_Utils.toString(item.name);

    var mimeType =
      GDM_Utils.toString(item.mimeType);

    var size =
      Number(item.size || 0);

    if (!isFinite(size) || size < 0) {
      size = 0;
    }

    var updated = null;

    if (item.modifiedTime) {
      var parsedDate =
        new Date(item.modifiedTime);

      if (
        !isNaN(parsedDate.getTime())
      ) {
        updated = parsedDate;
      }
    }

    var extension =
      GDM_Utils.getExtension(fileName);

    var parentId =
      GDM_Utils.toString(parent.id);

    var parentName =
      GDM_Utils.toString(parent.name);


    result.totals.files++;
    result.totals.bytes += size;


    /**********************************************************************************************
     * EXTENSION
     **********************************************************************************************/
    var extensionKey =
      extension ||
      '(sans extension)';

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
    var mimeKey =
      mimeType ||
      '(inconnu)';

    if (!result.mimeTypes[mimeKey]) {
      result.mimeTypes[mimeKey] = {
        files: 0,
        bytes: 0
      };
    }

    result.mimeTypes[mimeKey].files++;
    result.mimeTypes[mimeKey].bytes += size;


    /**********************************************************************************************
     * OBJET COMPACT
     **********************************************************************************************/
    var fileObject = {
      id: fileId,
      name: fileName,
      extension: extension,
      mimeType: mimeType,
      size: size,
      sizeFormatted:
        GDM_Utils.formatBytes(size),
      updated:
        updated
          ? GDM_Utils.toIso(updated)
          : '',
      folderId: parentId,
      folderName: parentName,
      url:
        GDM_Utils.toString(
          item.webViewLink
        )
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

      if (size >= largeLimit) {

        result.counters.largeFiles++;

        result.largeFiles.push(
          fileObject
        );

        result.largeFiles.sort(
          function(a, b) {
            return (
              Number(b.size || 0) -
              Number(a.size || 0)
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
   * INITIALISER RÉSULTAT
   ************************************************************************************************/
  initializeResult_: function(
    jobId,
    options
  ) {

    options = options || {};

    var result = {

      schemaVersion: 3,
      jobId: jobId,
      module: GDM_MODULES.ANALYSIS,

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
          ),
        pageSize:
          this.PAGE_SIZE_
      },

      startedAt:
        GDM_Utils.nowIso(),

      updatedAt:
        GDM_Utils.nowIso(),

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
        mode:
          'DOCUMENT_PROPERTIES',
        compacted: false
      }
    };

    this.saveResultSafely_(
      jobId,
      result
    );

    return result;
  },


  /************************************************************************************************
   * RÉSULTAT
   ************************************************************************************************/
  getResult: function(jobId) {

    jobId =
      GDM_Utils.trim(jobId);

    if (!jobId) {
      return null;
    }

    var result =
      this.readResult_(jobId);

    if (!result) {
      result =
        this.readLegacyScriptResult_(
          jobId
        );
    }

    if (!result) {
      return null;
    }

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
        ),
      errors:
        Number(
          result.counters &&
          result.counters.errors
            ? result.counters.errors
            : 0
        )
    };

    return result;
  },


  getStatus: function(jobId) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    return {
      ok: true,
      jobId: jobId,
      state:
        GDM_State.getSummary(jobId),
      queue:
        GDM_Queue.getMeta(jobId),
      analysis:
        this.getResult(jobId)
    };
  },


  /************************************************************************************************
   * FINALISER
   ************************************************************************************************/
  finalizeResult: function(jobId) {

    var result =
      this.getResult(jobId);

    if (!result) {
      return null;
    }

    result.finishedAt =
      GDM_Utils.nowIso();

    result.updatedAt =
      result.finishedAt;

    this.saveResultSafely_(
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

    } catch (ignoredLog) {}

    return result;
  },


  /************************************************************************************************
   * SUPPRIMER RÉSULTAT TECHNIQUE
   ************************************************************************************************/
  deleteResult: function(jobId) {

    var key =
      this.getResultKey_(jobId);

    var deleted = false;

    try {
      deleted =
        this.deleteChunkedFromStore_(
          this.getResultStore_(),
          key
        ) || deleted;
    } catch (ignoredDoc) {}

    try {
      deleted =
        this.deleteChunkedFromStore_(
          PropertiesService
            .getScriptProperties(),
          key
        ) || deleted;
    } catch (ignoredScript) {}

    return deleted;
  },


  /************************************************************************************************
   * ERREURS
   ************************************************************************************************/
  addError_: function(
    result,
    error,
    context
  ) {

    if (!result.counters) {
      result.counters = {};
    }

    result.counters.errors =
      Number(
        result.counters.errors || 0
      ) + 1;

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
   * LISTES LIMITÉES
   ************************************************************************************************/
  pushLimited_: function(
    array,
    value,
    limit,
    truncatedObject,
    truncatedKey
  ) {

    array = array || [];
    limit =
      Math.max(
        1,
        Number(limit || 1)
      );

    if (array.length < limit) {
      array.push(value);
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

    return Math.min(
      this.MAX_DETAIL_ROWS_,
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'UI.RESULT_MAX_ROWS',
          5000
        ),
        this.MAX_DETAIL_ROWS_
      )
    );
  },


  /************************************************************************************************
   * STOCKAGE
   ************************************************************************************************/
  getResultKey_: function(jobId) {

    return (
      this.RESULT_PREFIX_ +
      GDM_Utils.requireString(
        jobId,
        'jobId'
      )
    );
  },


  getResultStore_: function() {

    try {

      var store =
        PropertiesService
          .getDocumentProperties();

      if (store) {
        return store;
      }

    } catch (ignored) {}

    return PropertiesService
      .getScriptProperties();
  },


  saveResultSafely_: function(
    jobId,
    result
  ) {

    var compacted =
      this.compactResultForStorage_(
        result
      );

    try {

      return this.saveResult_(
        jobId,
        compacted
      );

    } catch (firstError) {

      compacted.storage =
        compacted.storage || {};

      compacted.storage.compacted =
        true;

      compacted.storage
        .lastStorageWarning =
        GDM_Utils.getErrorMessage(
          firstError
        );

      this.forceEmergencyCompact_(
        compacted
      );

      try {

        return this.saveResult_(
          jobId,
          compacted
        );

      } catch (secondError) {

        return this.saveResult_(
          jobId,
          this.buildMinimalResult_(
            compacted
          )
        );
      }
    }
  },


  saveResult_: function(
    jobId,
    result
  ) {

    return this.writeChunkedToStore_(
      this.getResultStore_(),
      this.getResultKey_(jobId),
      result
    );
  },


  readResult_: function(jobId) {

    return this.readChunkedFromStore_(
      this.getResultStore_(),
      this.getResultKey_(jobId)
    );
  },


  readLegacyScriptResult_: function(
    jobId
  ) {

    try {

      return this
        .readChunkedFromStore_(
          PropertiesService
            .getScriptProperties(),
          this.getResultKey_(jobId)
        );

    } catch (ignored) {

      return null;
    }
  },


  /************************************************************************************************
   * COMPACTAGE
   ************************************************************************************************/
  compactResultForStorage_: function(
    result
  ) {

    result = result || {};
    result.truncated =
      result.truncated || {};

    this.limitArray_(
      result,
      'largeFiles',
      Math.min(
        this.getResultListLimit_(),
        GDM_Utils.toPositiveInteger(
          GDM_Config.get(
            'ANALYSIS.TOP_FILES',
            200
          ),
          200
        )
      )
    );

    this.limitArray_(
      result,
      'oldFiles',
      this.getResultListLimit_()
    );

    this.limitArray_(
      result,
      'emptyFolders',
      this.getResultListLimit_()
    );

    this.limitArray_(
      result,
      'noExtensionFiles',
      this.getResultListLimit_()
    );

    this.limitArray_(
      result,
      'shortcuts',
      this.getResultListLimit_()
    );

    this.limitArray_(
      result,
      'errors',
      this.MAX_ERROR_ROWS_
    );

    result.extensions =
      this.compactMap_(
        result.extensions || {},
        this.MAX_MAP_KEYS_,
        result.truncated,
        'extensions'
      );

    result.mimeTypes =
      this.compactMap_(
        result.mimeTypes || {},
        this.MAX_MAP_KEYS_,
        result.truncated,
        'mimeTypes'
      );

    var json =
      GDM_Utils.safeJsonStringify(
        result,
        '{}'
      );

    var rounds = 0;

    while (
      json.length >
        this.MAX_RESULT_JSON_CHARS_ &&
      rounds < 8
    ) {

      rounds++;

      this.halveArray_(
        result,
        'oldFiles'
      );

      this.halveArray_(
        result,
        'emptyFolders'
      );

      this.halveArray_(
        result,
        'noExtensionFiles'
      );

      this.halveArray_(
        result,
        'shortcuts'
      );

      if (rounds >= 2) {
        this.halveArray_(
          result,
          'largeFiles'
        );
      }

      if (rounds >= 3) {
        this.halveArray_(
          result,
          'errors'
        );
      }

      if (rounds >= 4) {

        result.extensions =
          this.compactMap_(
            result.extensions || {},
            100,
            result.truncated,
            'extensions'
          );

        result.mimeTypes =
          this.compactMap_(
            result.mimeTypes || {},
            100,
            result.truncated,
            'mimeTypes'
          );
      }

      json =
        GDM_Utils.safeJsonStringify(
          result,
          '{}'
        );
    }

    result.storage =
      result.storage || {};

    result.storage.compacted =
      result.storage.compacted === true ||
      rounds > 0;

    result.storage
      .approxJsonChars =
      json.length;

    return result;
  },


  forceEmergencyCompact_: function(
    result
  ) {

    var tiny = 25;

    this.limitArray_(
      result,
      'largeFiles',
      tiny
    );

    this.limitArray_(
      result,
      'oldFiles',
      tiny
    );

    this.limitArray_(
      result,
      'emptyFolders',
      tiny
    );

    this.limitArray_(
      result,
      'noExtensionFiles',
      tiny
    );

    this.limitArray_(
      result,
      'shortcuts',
      tiny
    );

    this.limitArray_(
      result,
      'errors',
      20
    );

    result.extensions =
      this.compactMap_(
        result.extensions || {},
        75,
        result.truncated,
        'extensions'
      );

    result.mimeTypes =
      this.compactMap_(
        result.mimeTypes || {},
        75,
        result.truncated,
        'mimeTypes'
      );

    return result;
  },


  buildMinimalResult_: function(
    result
  ) {

    return {
      schemaVersion:
        result.schemaVersion || 3,
      jobId:
        result.jobId || '',
      module:
        GDM_MODULES.ANALYSIS,
      source:
        result.source || {},
      parameters:
        result.parameters || {},
      startedAt:
        result.startedAt || '',
      updatedAt:
        GDM_Utils.nowIso(),
      finishedAt:
        result.finishedAt || '',
      totals:
        result.totals || {
          files: 0,
          folders: 0,
          bytes: 0
        },
      counters:
        result.counters || {
          largeFiles: 0,
          oldFiles: 0,
          emptyFolders: 0,
          noExtensionFiles: 0,
          shortcuts: 0,
          errors: 0
        },
      extensions:
        this.compactMap_(
          result.extensions || {},
          50,
          null,
          ''
        ),
      mimeTypes:
        this.compactMap_(
          result.mimeTypes || {},
          50,
          null,
          ''
        ),
      largeFiles:
        (result.largeFiles || [])
          .slice(0, 20),
      oldFiles: [],
      emptyFolders: [],
      noExtensionFiles: [],
      shortcuts: [],
      errors:
        (result.errors || [])
          .slice(0, 10),
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
        mode:
          'MINIMAL_EMERGENCY',
        compacted: true
      }
    };
  },


  limitArray_: function(
    result,
    key,
    limit
  ) {

    if (!Array.isArray(result[key])) {
      result[key] = [];
      return;
    }

    if (
      result[key].length >
      limit
    ) {

      result[key] =
        result[key].slice(
          0,
          limit
        );

      result.truncated =
        result.truncated || {};

      result.truncated[key] =
        true;
    }
  },


  halveArray_: function(
    result,
    key
  ) {

    if (!Array.isArray(result[key])) {
      result[key] = [];
      return;
    }

    if (
      result[key].length >
      1
    ) {

      result[key] =
        result[key].slice(
          0,
          Math.max(
            1,
            Math.floor(
              result[key].length / 2
            )
          )
        );

      result.truncated =
        result.truncated || {};

      result.truncated[key] =
        true;
    }
  },


  compactMap_: function(
    map,
    limit,
    truncatedObject,
    truncatedKey
  ) {

    map = map || {};

    var keys =
      Object.keys(map);

    if (
      keys.length <= limit
    ) {
      return map;
    }

    keys.sort(
      function(a, b) {

        var av =
          map[a] || {};

        var bv =
          map[b] || {};

        return (
          Number(bv.files || 0) -
          Number(av.files || 0)
        );
      }
    );

    var out = {};

    for (
      var i = 0;
      i < limit;
      i++
    ) {
      out[keys[i]] =
        map[keys[i]];
    }

    if (
      truncatedObject &&
      truncatedKey
    ) {
      truncatedObject[
        truncatedKey
      ] = true;
    }

    return out;
  },


  /************************************************************************************************
   * STOCKAGE FRACTIONNÉ
   ************************************************************************************************/
  writeChunkedToStore_: function(
    store,
    baseKey,
    value
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        var json =
          GDM_Utils.safeJsonStringify(
            value,
            '{}'
          );

        var chunkSize =
          Math.min(
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

        var oldMeta =
          GDM_Utils.safeJsonParse(
            store.getProperty(
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
          store.setProperty(
            baseKey +
            '_PART_' +
            c,
            chunks[c]
          );
        }

        for (
          var oldIndex =
            chunks.length;
          oldIndex < oldCount;
          oldIndex++
        ) {
          store.deleteProperty(
            baseKey +
            '_PART_' +
            oldIndex
          );
        }

        store.setProperty(
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

        store.deleteProperty(
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


  readChunkedFromStore_: function(
    store,
    baseKey
  ) {

    if (!store) {
      return null;
    }

    var metaRaw =
      store.getProperty(
        baseKey + '_META'
      );

    if (!metaRaw) {

      var direct =
        store.getProperty(baseKey);

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
        store.getProperty(
          baseKey +
          '_PART_' +
          i
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


  deleteChunkedFromStore_: function(
    store,
    baseKey
  ) {

    if (!store) {
      return false;
    }

    var meta =
      GDM_Utils.safeJsonParse(
        store.getProperty(
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
      store.deleteProperty(
        baseKey +
        '_PART_' +
        i
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
   ************************************************************************************************/
  cleanupAllAnalysisResultStorage_: function() {

    var stores = [];

    try {

      var doc =
        PropertiesService
          .getDocumentProperties();

      if (doc) {
        stores.push(doc);
      }

    } catch (ignoredDoc) {}

    try {

      stores.push(
        PropertiesService
          .getScriptProperties()
      );

    } catch (ignoredScript) {}

    var totalDeleted = 0;

    for (
      var s = 0;
      s < stores.length;
      s++
    ) {

      var store =
        stores[s];

      var all =
        store.getProperties();

      var keys =
        Object.keys(all);

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

          store.deleteProperty(
            keys[i]
          );

          totalDeleted++;
        }
      }
    }

    return {
      ok: true,
      deletedProperties:
        totalDeleted
    };
  },


  /************************************************************************************************
   * VALIDATION
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

      if (
        typeof UrlFetchApp ===
        'undefined'
      ) {
        errors.push(
          'UrlFetchApp indisponible.'
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur UrlFetchApp : ' +
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
        '2.2.0',
      readOnly:
        true,
      paginatedDriveApi:
        true,
      pageSize:
        this.PAGE_SIZE_,
      antiBlocking:
        true,
      errors:
        errors
    };
  }

});


/**************************************************************************************************
 * API INTERFACE
 **************************************************************************************************/
function GDM_apiGetAnalysisResult(jobId) {

  return {
    ok: true,
    jobId: jobId,
    state:
      GDM_State.getSummary(jobId),
    queue:
      GDM_Queue.getMeta(jobId),
    result:
      GDM_Analysis.getResult(jobId)
  };
}


/**************************************************************************************************
 * AUTORISER / TESTER DRIVE API V3
 *
 * À exécuter manuellement UNE FOIS après remplacement de Analysis.gs.
 * Cela permet à Google d'afficher la fenêtre d'autorisation si UrlFetch nécessite un nouveau scope.
 **************************************************************************************************/
function GDM_analysisAuthorizeAndTestApi() {

  var rootId =
    DriveApp.getRootFolder().getId();

  var page =
    GDM_Analysis.fetchChildrenPage_(
      rootId,
      '',
      10
    );

  return {
    ok: true,
    message:
      'Drive API v3 autorisée et fonctionnelle.',
    testItems:
      page.files.length,
    hasNextPage:
      Boolean(page.nextPageToken)
  };
}


/**************************************************************************************************
 * DÉBLOCAGE DU JOB ACTUEL APRÈS PASSAGE EN 2.2.0
 *
 * IMPORTANT :
 * - ne supprime PAS le job ;
 * - conserve les éléments déjà terminés ;
 * - remet la tâche restée RUNNING en PENDING ;
 * - relance avec le nouveau traitement paginé.
 **************************************************************************************************/
function GDM_analysisResumeCurrentJobAfterUpgrade() {

  var jobId =
    GDM_State.getCurrentJobId();

  if (!jobId) {
    throw new Error(
      'Aucun traitement en cours.'
    );
  }

  try {
    GDM_Engine.removeResumeTriggers(
      jobId
    );
  } catch (ignoredTriggers) {}

  try {
    GDM_Engine.forceReleaseRunToken_(
      jobId
    );
  } catch (ignoredLock) {}

  var reset = 0;

  try {
    reset =
      GDM_Queue.resetRunningTasks(
        jobId
      );
  } catch (ignoredReset) {}

  try {
    GDM_State.clearPauseRequest(
      jobId
    );
  } catch (ignoredPause) {}

  try {

    var state =
      GDM_State.get(jobId);

    if (
      state &&
      state.status ===
        GDM_JOB_STATUS.PAUSED
    ) {

      GDM_State.resume(
        jobId,
        'Reprise après mise à niveau Analysis 2.2.'
      );

    } else if (
      state &&
      state.status !==
        GDM_JOB_STATUS.RUNNING
    ) {

      GDM_State.start(
        jobId,
        'Reprise après mise à niveau Analysis 2.2.'
      );
    }

  } catch (ignoredState) {}

  var run =
    GDM_Engine.runOneBatch(
      jobId
    );

  return {
    ok: true,
    jobId: jobId,
    resetRunningTasks:
      reset,
    run: run
  };
}


/**************************************************************************************************
 * REMISE À ZÉRO COMPLÈTE DU JOB ACTUEL
 *
 * À utiliser seulement si vous préférez recommencer l'analyse depuis zéro.
 * AUCUN fichier Google Drive n'est supprimé.
 **************************************************************************************************/
function GDM_analysisEmergencyResetCurrentJob() {

  var jobId = '';

  try {
    jobId =
      GDM_State.getCurrentJobId() ||
      '';
  } catch (ignoredCurrent) {}

  if (jobId) {

    try {
      GDM_Engine.cancel(jobId);
    } catch (ignoredCancel) {}

    try {
      GDM_Engine.removeResumeTriggers(
        jobId
      );
    } catch (ignoredTriggers) {}

    try {
      Utilities.sleep(1000);
    } catch (ignoredSleep) {}

    try {
      GDM_Queue.delete(jobId);
    } catch (ignoredQueue) {}

    try {

      if (
        typeof GDM_Logger !==
          'undefined' &&
        typeof GDM_Logger.clear ===
          'function'
      ) {
        GDM_Logger.clear(jobId);
      }

    } catch (ignoredLogs) {}

    try {
      GDM_Analysis.deleteResult(
        jobId
      );
    } catch (ignoredAnalysis) {}

    try {
      GDM_State.delete(
        jobId,
        {
          deleteResult: true
        }
      );
    } catch (ignoredState) {}
  }

  var cleanup = {
    ok: true,
    deletedProperties: 0
  };

  try {
    cleanup =
      GDM_Analysis
        .cleanupAllAnalysisResultStorage_();
  } catch (ignoredCleanup) {}

  return {
    ok: true,
    message:
      'Ancien job arrêté et stockage technique nettoyé. Aucun fichier Drive n’a été supprimé.',
    oldJobId:
      jobId,
    analysisStorageCleanup:
      cleanup
  };
}
