/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Copy.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Copie progressive de dossiers et fichiers Google Drive.
 *
 * Ce module gère :
 * - copie d'un dossier complet ;
 * - copie récursive des sous-dossiers ;
 * - préservation de l'arborescence ;
 * - création du dossier racine de destination ;
 * - copie progressive via Queue + Engine ;
 * - reprise après interruption Apps Script ;
 * - gestion des erreurs fichier par fichier ;
 * - statistiques de copie ;
 * - protection contre la copie d'un dossier dans lui-même ;
 * - protection contre la copie vers un descendant du dossier source.
 *
 * CONCEPTION GROS DRIVE
 * ---------------------
 * La copie ne parcourt jamais tout le Drive avant de commencer.
 *
 * Chaque dossier devient une tâche COPY_FOLDER.
 *
 * Lorsqu'une tâche COPY_FOLDER est exécutée :
 * - le dossier destination correspondant est connu ;
 * - les fichiers directs deviennent des tâches COPY_FILE ;
 * - les sous-dossiers sont créés ;
 * - chaque sous-dossier devient une nouvelle tâche COPY_FOLDER.
 *
 * La queue grandit progressivement et peut être reprise automatiquement.
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
 * SÉCURITÉ
 * --------
 * - Aucun fichier source n'est modifié.
 * - Aucun fichier source n'est supprimé.
 * - Aucun dossier source n'est déplacé.
 **************************************************************************************************/

'use strict';


const GDM_Copy = Object.freeze({


  /************************************************************************************************
   * LANCER UNE COPIE
   ************************************************************************************************/

  start: function(options) {

    options = options || {};


    /**********************************************************************************************
     * SOURCE
     **********************************************************************************************/

    var sourceFolderId =
      GDM_Utils.requireFolderId(
        options.sourceFolderId ||
        options.folderId,
        'sourceFolderId'
      );


    var sourceFolder =
      DriveApp.getFolderById(
        sourceFolderId
      );


    /**********************************************************************************************
     * DESTINATION
     **********************************************************************************************/

    var destinationFolderId =
      GDM_Utils.requireFolderId(
        options.destinationFolderId,
        'destinationFolderId'
      );


    var destinationFolder =
      DriveApp.getFolderById(
        destinationFolderId
      );


    if (
      sourceFolderId ===
      destinationFolderId
    ) {

      throw new Error(
        'Le dossier source et le dossier destination doivent être différents.'
      );
    }


    /*
     * Interdire la copie d'un dossier dans l'un de ses descendants.
     */
    if (
      this.isDescendant_(
        destinationFolder,
        sourceFolderId
      )
    ) {

      throw new Error(
        'Impossible de copier un dossier dans l’un de ses propres sous-dossiers.'
      );
    }


    /**********************************************************************************************
     * PARAMÈTRES
     **********************************************************************************************/

    var recursive =
      typeof options.recursive ===
        'undefined'
        ? GDM_Config.get(
            'COPY.INCLUDE_SUBFOLDERS_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.recursive,
            true
          );


    var createRootFolder =
      typeof options.createRootFolder ===
        'undefined'
        ? GDM_Config.get(
            'COPY.CREATE_ROOT_FOLDER',
            true
          )
        : GDM_Utils.toBoolean(
            options.createRootFolder,
            true
          );


    var newFolderName =
      GDM_Utils.trim(
        options.newFolderName
      );


    if (!newFolderName) {
      newFolderName =
        sourceFolder.getName();
    }


    newFolderName =
      GDM_Utils.sanitizeFolderName(
        newFolderName
      );


    /**********************************************************************************************
     * DOSSIER RACINE DE LA COPIE
     **********************************************************************************************/

    var createdRootFolder;


    if (createRootFolder) {

      var finalRootName =
        this.buildUniqueFolderName_(
          destinationFolder,
          newFolderName
        );


      createdRootFolder =
        destinationFolder.createFolder(
          finalRootName
        );

    } else {

      createdRootFolder =
        destinationFolder;
    }


    /**********************************************************************************************
     * JOB
     **********************************************************************************************/

    var state =
      GDM_State.create({
        module:
          GDM_MODULES.COPY,

        action:
          GDM_ACTIONS.COPY_FOLDER,

        source: {
          id:
            sourceFolderId,

          name:
            sourceFolder.getName()
        },

        destination: {
          id:
            destinationFolderId,

          name:
            destinationFolder.getName()
        },

        parameters: {
          recursive:
            recursive,

          createRootFolder:
            createRootFolder,

          newFolderName:
            newFolderName,

          createdRootFolderId:
            createdRootFolder.getId(),

          createdRootFolderName:
            createdRootFolder.getName()
        },

        totalKnown:
          1,

        setCurrent:
          true,

        message:
          'Copie préparée.'
      });


    var jobId =
      state.jobId;


    /**********************************************************************************************
     * RÉSULTAT INITIAL
     **********************************************************************************************/

    this.saveResult_(
      jobId,
      {
        jobId:
          jobId,

        sourceFolderId:
          sourceFolderId,

        sourceFolderName:
          sourceFolder.getName(),

        destinationFolderId:
          destinationFolderId,

        destinationFolderName:
          destinationFolder.getName(),

        createdRootFolderId:
          createdRootFolder.getId(),

        createdRootFolderName:
          createdRootFolder.getName(),

        foldersCreated:
          createRootFolder
            ? 1
            : 0,

        filesCopied:
          0,

        bytesCopied:
          0,

        errors:
          0,

        startedAt:
          GDM_Utils.nowIso(),

        updatedAt:
          GDM_Utils.nowIso(),

        finishedAt:
          ''
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
          GDM_MODULES.COPY,

        action:
          GDM_ACTIONS.COPY_FOLDER,

        itemId:
          sourceFolderId,

        itemName:
          sourceFolder.getName(),

        payload: {
          sourceFolderId:
            sourceFolderId,

          destinationFolderId:
            createdRootFolder.getId(),

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


    /**********************************************************************************************
     * LOG
     **********************************************************************************************/

    try {

      GDM_Logger.info(
        'Copie de dossier préparée.',
        {
          jobId:
            jobId,

          module:
            GDM_MODULES.COPY,

          action:
            GDM_ACTIONS.COPY_FOLDER,

          itemId:
            sourceFolderId,

          itemName:
            sourceFolder.getName(),

          data: {
            destinationFolderId:
              createdRootFolder.getId(),

            recursive:
              recursive
          }
        }
      );

    } catch (ignored) {}


    /**********************************************************************************************
     * DÉMARRAGE ENGINE
     **********************************************************************************************/

    var asyncMode =
      typeof options.async ===
        'undefined'
        ? true
        : GDM_Utils.toBoolean(
            options.async,
            true
          );


    var engine =
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
          sourceFolder.getName()
      },

      destination: {
        id:
          destinationFolderId,

        name:
          destinationFolder.getName()
      },

      createdRootFolder: {
        id:
          createdRootFolder.getId(),

        name:
          createdRootFolder.getName(),

        url:
          GDM_Utils.getDriveFolderUrl(
            createdRootFolder.getId()
          )
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
        engine
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

      case GDM_ACTIONS.COPY_FOLDER:

        return this.processFolder_(
          task,
          context
        );


      case GDM_ACTIONS.COPY_FILE:

        return this.processFile_(
          task,
          context
        );


      default:

        throw new Error(
          'Copy : action inconnue : ' +
          GDM_Utils.toString(
            task.action
          )
        );
    }
  },


  /************************************************************************************************
   * COPIE D'UN DOSSIER
   ************************************************************************************************/

  processFolder_: function(
    task,
    context
  ) {

    var jobId =
      task.jobId ||
      context.jobId;


    var payload =
      task.payload ||
      {};


    var sourceFolderId =
      GDM_Utils.requireFolderId(
        payload.sourceFolderId ||
        task.itemId,
        'sourceFolderId'
      );


    var destinationFolderId =
      GDM_Utils.requireFolderId(
        payload.destinationFolderId,
        'destinationFolderId'
      );


    var sourceFolder =
      DriveApp.getFolderById(
        sourceFolderId
      );


    var destinationFolder =
      DriveApp.getFolderById(
        destinationFolderId
      );


    var state =
      GDM_State.require(
        jobId
      );


    var recursive =
      typeof payload.recursive ===
        'undefined'
        ? GDM_Utils.toBoolean(
            state.parameters &&
            state.parameters.recursive,
            true
          )
        : GDM_Utils.toBoolean(
            payload.recursive,
            true
          );


    var newTasks = [];

    var directFiles = 0;

    var directFolders = 0;

    var foldersCreated = 0;


    /**********************************************************************************************
     * FICHIERS DIRECTS
     **********************************************************************************************/

    var files =
      sourceFolder.getFiles();


    while (
      files.hasNext()
    ) {

      var file =
        files.next();


      directFiles++;


      newTasks.push({
        module:
          GDM_MODULES.COPY,

        action:
          GDM_ACTIONS.COPY_FILE,

        itemId:
          file.getId(),

        itemName:
          file.getName(),

        payload: {
          fileId:
            file.getId(),

          destinationFolderId:
            destinationFolderId,

          sourceFolderId:
            sourceFolderId
        }
      });
    }


    /**********************************************************************************************
     * SOUS-DOSSIERS
     **********************************************************************************************/

    if (recursive) {

      var folders =
        sourceFolder.getFolders();


      while (
        folders.hasNext()
      ) {

        var child =
          folders.next();


        directFolders++;


        var childName =
          this.buildUniqueFolderName_(
            destinationFolder,
            child.getName()
          );


        var newDestinationFolder =
          destinationFolder.createFolder(
            childName
          );


        foldersCreated++;


        newTasks.push({
          module:
            GDM_MODULES.COPY,

          action:
            GDM_ACTIONS.COPY_FOLDER,

          itemId:
            child.getId(),

          itemName:
            child.getName(),

          payload: {
            sourceFolderId:
              child.getId(),

            destinationFolderId:
              newDestinationFolder.getId(),

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
     * AJOUTER LES TÂCHES
     **********************************************************************************************/

    if (
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


      var current =
        GDM_State.require(
          jobId
        );


      GDM_State.setTotalKnown(
        jobId,
        Number(
          current.totalKnown || 0
        ) +
        newTasks.length
      );
    }


    /**********************************************************************************************
     * STATISTIQUES
     **********************************************************************************************/

    if (
      foldersCreated > 0
    ) {

      this.updateResult_(
        jobId,
        function(result) {

          result.foldersCreated =
            Number(
              result.foldersCreated || 0
            ) +
            foldersCreated;


          result.updatedAt =
            GDM_Utils.nowIso();


          return result;
        }
      );
    }


    return {
      ok: true,

      skipped: false,

      message:
        'Dossier préparé pour copie : ' +
        sourceFolder.getName(),

      data: {
        sourceFolderId:
          sourceFolderId,

        destinationFolderId:
          destinationFolderId,

        directFiles:
          directFiles,

        directFolders:
          directFolders,

        foldersCreated:
          foldersCreated,

        tasksAdded:
          newTasks.length
      }
    };
  },


  /************************************************************************************************
   * COPIE D'UN FICHIER
   ************************************************************************************************/

  processFile_: function(
    task,
    context
  ) {

    var jobId =
      task.jobId ||
      context.jobId;


    var payload =
      task.payload ||
      {};


    var fileId =
      GDM_Utils.requireFileId(
        payload.fileId ||
        task.itemId,
        'fileId'
      );


    var destinationFolderId =
      GDM_Utils.requireFolderId(
        payload.destinationFolderId,
        'destinationFolderId'
      );


    var file =
      DriveApp.getFileById(
        fileId
      );


    var destinationFolder =
      DriveApp.getFolderById(
        destinationFolderId
      );


    var size =
      this.getFileSize_(
        file
      );


    var copy;


    try {

      /*
       * makeCopy conserve le contenu du fichier et crée un nouvel élément
       * dans le dossier destination.
       */
      copy =
        file.makeCopy(
          file.getName(),
          destinationFolder
        );

    } catch (error) {

      /*
       * Certains éléments Google Drive peuvent être non copiables en fonction
       * des permissions. Le comportement est laissé au système de retry Engine.
       */
      this.updateResult_(
        jobId,
        function(result) {

          result.errors =
            Number(
              result.errors || 0
            ) + 1;


          result.updatedAt =
            GDM_Utils.nowIso();


          return result;
        }
      );


      throw error;
    }


    /**********************************************************************************************
     * STATISTIQUES
     **********************************************************************************************/

    this.updateResult_(
      jobId,
      function(result) {

        result.filesCopied =
          Number(
            result.filesCopied || 0
          ) + 1;


        result.bytesCopied =
          Number(
            result.bytesCopied || 0
          ) +
          size;


        result.updatedAt =
          GDM_Utils.nowIso();


        return result;
      }
    );


    return {
      ok: true,

      skipped: false,

      message:
        'Fichier copié : ' +
        file.getName(),

      data: {
        sourceFileId:
          fileId,

        copiedFileId:
          copy.getId(),

        fileName:
          copy.getName(),

        destinationFolderId:
          destinationFolderId,

        size:
          size
      }
    };
  },


  /************************************************************************************************
   * RÉSULTAT
   ************************************************************************************************/

  getResult: function(jobId) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );


    var result =
      this.readResult_(
        jobId
      );


    if (!result) {
      return null;
    }


    result.bytesCopiedFormatted =
      GDM_Utils.formatBytes(
        Number(
          result.bytesCopied || 0
        )
      );


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
   * FINALISER LE RÉSULTAT
   ************************************************************************************************/

  finalizeResult: function(jobId) {

    return this.updateResult_(
      jobId,
      function(result) {

        result.finishedAt =
          GDM_Utils.nowIso();


        result.updatedAt =
          result.finishedAt;


        return result;
      }
    );
  },


  /************************************************************************************************
   * NOM UNIQUE DE DOSSIER
   ************************************************************************************************/

  buildUniqueFolderName_: function(
    parentFolder,
    requestedName
  ) {

    requestedName =
      GDM_Utils.sanitizeFolderName(
        requestedName
      );


    if (
      !this.folderNameExists_(
        parentFolder,
        requestedName
      )
    ) {

      return requestedName;
    }


    var counter = 2;


    while (
      counter < 10000
    ) {

      var candidate =
        requestedName +
        ' (' +
        counter +
        ')';


      if (
        !this.folderNameExists_(
          parentFolder,
          candidate
        )
      ) {

        return candidate;
      }


      counter++;
    }


    return requestedName +
      '_' +
      Date.now();
  },


  /************************************************************************************************
   * EXISTENCE D'UN NOM DE DOSSIER
   ************************************************************************************************/

  folderNameExists_: function(
    parentFolder,
    name
  ) {

    try {

      return parentFolder
        .getFoldersByName(
          name
        )
        .hasNext();

    } catch (error) {

      return false;
    }
  },


  /************************************************************************************************
   * VÉRIFIER SI UN DOSSIER EST DESCENDANT D'UN AUTRE
   ************************************************************************************************/

  isDescendant_: function(
    folder,
    ancestorFolderId
  ) {

    ancestorFolderId =
      GDM_Utils.trim(
        ancestorFolderId
      );


    if (
      !folder ||
      !ancestorFolderId
    ) {
      return false;
    }


    var current =
      folder;


    var visited = {};


    var maxDepth =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'FOLDER_TOOLS.MAX_TREE_DEPTH',
          50
        ),
        50
      );


    for (
      var depth = 0;
      depth < maxDepth;
      depth++
    ) {

      var currentId =
        current.getId();


      if (
        currentId ===
        ancestorFolderId
      ) {
        return true;
      }


      if (
        visited[
          currentId
        ]
      ) {
        return false;
      }


      visited[
        currentId
      ] = true;


      var parents =
        current.getParents();


      if (
        !parents.hasNext()
      ) {
        return false;
      }


      current =
        parents.next();
    }


    return false;
  },


  /************************************************************************************************
   * TAILLE FICHIER
   ************************************************************************************************/

  getFileSize_: function(file) {

    try {

      return Number(
        file.getSize()
      ) || 0;

    } catch (ignored) {

      return 0;
    }
  },


  /************************************************************************************************
   * STOCKAGE RÉSULTAT
   ************************************************************************************************/

  getResultKey_: function(jobId) {

    return 'GDMV2_COPY_RESULT_' +
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );
  },


  saveResult_: function(
    jobId,
    result
  ) {

    return this.writeChunked_(
      this.getResultKey_(
        jobId
      ),
      result
    );
  },


  readResult_: function(jobId) {

    return this.readChunked_(
      this.getResultKey_(
        jobId
      )
    );
  },


  updateResult_: function(
    jobId,
    callback
  ) {

    if (
      typeof callback !==
      'function'
    ) {

      throw new Error(
        'GDM_Copy.updateResult_ : callback invalide.'
      );
    }


    return GDM_Utils.withScriptLock(
      function() {

        var key =
          GDM_Copy.getResultKey_(
            jobId
          );


        var result =
          GDM_Copy.readChunkedUnlocked_(
            key
          );


        if (!result) {

          throw new Error(
            'Résultat Copy introuvable pour le job ' +
            jobId
          );
        }


        result =
          callback(
            result
          ) ||
          result;


        GDM_Copy.writeChunkedUnlocked_(
          key,
          result
        );


        return GDM_Copy.clone_(
          result
        );
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
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

        return GDM_Copy.writeChunkedUnlocked_(
          baseKey,
          value
        );

      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  writeChunkedUnlocked_: function(
    baseKey,
    value
  ) {

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


    var maxChunks =
      Math.max(
        10,
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
        'Résultat Copy trop volumineux pour PropertiesService.'
      );
    }


    var oldMeta =
      GDM_Utils.safeJsonParse(
        properties.getProperty(
          baseKey +
          '_META'
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
      var old =
        chunks.length;
      old < oldCount;
      old++
    ) {

      properties.deleteProperty(
        baseKey +
        '_PART_' +
        old
      );
    }


    properties.setProperty(
      baseKey +
      '_META',
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


  readChunked_: function(baseKey) {

    return this.readChunkedUnlocked_(
      baseKey
    );
  },


  readChunkedUnlocked_: function(baseKey) {

    var properties =
      PropertiesService
        .getScriptProperties();


    var metaRaw =
      properties.getProperty(
        baseKey +
        '_META'
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


      json +=
        part;
    }


    return GDM_Utils.safeJsonParse(
      json,
      null
    );
  },


  /************************************************************************************************
   * CLONE
   ************************************************************************************************/

  clone_: function(value) {

    if (
      value === null ||
      typeof value ===
        'undefined'
    ) {

      return value;
    }


    return JSON.parse(
      JSON.stringify(
        value
      )
    );
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
          'Accès Google Drive impossible.'
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

      var testName =
        GDM_Utils.sanitizeFolderName(
          'Test / Copy'
        );


      if (
        !testName
      ) {

        errors.push(
          'Normalisation de nom impossible.'
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur normalisation : ' +
        GDM_Utils.getErrorMessage(
          error2
        )
      );
    }


    return {
      ok:
        errors.length === 0,

      file:
        'Modules/Copy.gs',

      version:
        GDM_APP.VERSION,

      modifiesSource:
        false,

      deletesFiles:
        false,

      errors:
        errors
    };
  }

});


/**************************************************************************************************
 * API GLOBALE OPTIONNELLE
 **************************************************************************************************/

function GDM_apiGetCopyResult(jobId) {

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
      GDM_Copy.getResult(
        jobId
      )
  };
}