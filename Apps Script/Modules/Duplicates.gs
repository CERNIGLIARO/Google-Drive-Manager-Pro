/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Duplicates.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Détection progressive des fichiers potentiellement en double dans Google Drive.
 *
 * MÉTHODES DISPONIBLES
 * --------------------
 * - NAME      : même nom ;
 * - SIZE      : même taille ;
 * - NAME_SIZE : même nom + même taille.
 *
 * Le mode NAME_SIZE est utilisé par défaut car il réduit fortement les faux positifs.
 *
 * CE MODULE GÈRE
 * --------------
 * - analyse d'un dossier ou de Mon Drive ;
 * - analyse récursive ;
 * - traitement progressif ;
 * - continuation des gros dossiers ;
 * - indexation par signature ;
 * - groupes de doublons ;
 * - taille potentiellement récupérable ;
 * - limitation du nombre de résultats conservés ;
 * - gestion des erreurs fichier par fichier ;
 * - reprise via Queue + Engine.
 *
 * SÉCURITÉ
 * --------
 * - Lecture seule.
 * - Aucun fichier n'est supprimé.
 * - Aucun fichier n'est déplacé.
 * - Aucun fichier n'est renommé.
 *
 * IMPORTANT
 * ---------
 * Un "doublon" détecté est un doublon potentiel selon la méthode choisie.
 * Le module ne réalise volontairement aucune suppression automatique.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 * Core/State.gs
 * Core/Queue.gs
 * Core/Engine.gs
 **************************************************************************************************/

'use strict';


const GDM_Duplicates = Object.freeze({


  /************************************************************************************************
   * CONSTANTES INTERNES
   ************************************************************************************************/

  METHOD_NAME_: 'NAME',

  METHOD_SIZE_: 'SIZE',

  METHOD_NAME_SIZE_: 'NAME_SIZE',

  OP_SCAN_FOLDER_: 'SCAN_FOLDER',

  PHASE_FILES_: 'FILES',

  PHASE_FOLDERS_: 'FOLDERS',

  RESULT_PREFIX_: 'GDMV2_DUP_RESULT_',

  INDEX_PREFIX_: 'GDMV2_DUP_INDEX_',

  INDEX_BUCKETS_: 64,


  /************************************************************************************************
   * LANCEMENT
   ************************************************************************************************/

  start: function(options) {

    options = options || {};


    var rootFolder =
      GDM_Utils.getFolderOrRoot(
        options.folderId ||
        options.sourceFolderId ||
        ''
      );


    var rootFolderId =
      rootFolder.getId();


    var rootDriveId =
      DriveApp
        .getRootFolder()
        .getId();


    var rootFolderName =
      rootFolderId === rootDriveId
        ? GDM_Config.get(
            'APP.ROOT_LABEL',
            'Mon Drive'
          )
        : rootFolder.getName();


    var recursive =
      typeof options.recursive === 'undefined'
        ? GDM_Config.get(
            'DUPLICATES.INCLUDE_SUBFOLDERS_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.recursive,
            true
          );


    var method =
      this.normalizeMethod_(
        options.method ||
        GDM_Config.get(
          'DUPLICATES.DEFAULT_METHOD',
          'NAME_SIZE'
        )
      );


    /**********************************************************************************************
     * JOB
     **********************************************************************************************/

    var state =
      GDM_State.create({

        module:
          GDM_MODULES.DUPLICATES,

        action:
          GDM_ACTIONS.FIND_DUPLICATES,

        source: {
          id:
            rootFolderId,

          name:
            rootFolderName
        },

        parameters: {

          recursive:
            recursive,

          method:
            method,

          ignoreZeroByteFiles:
            typeof options.ignoreZeroByteFiles === 'undefined'
              ? GDM_Config.get(
                  'DUPLICATES.IGNORE_ZERO_BYTE_FILES',
                  false
                )
              : GDM_Utils.toBoolean(
                  options.ignoreZeroByteFiles,
                  false
                ),

          caseInsensitiveNames:
            typeof options.caseInsensitiveNames === 'undefined'
              ? GDM_Config.get(
                  'DUPLICATES.CASE_INSENSITIVE_NAMES',
                  true
                )
              : GDM_Utils.toBoolean(
                  options.caseInsensitiveNames,
                  true
                ),

          normalizeWhitespace:
            typeof options.normalizeWhitespace === 'undefined'
              ? GDM_Config.get(
                  'DUPLICATES.NORMALIZE_WHITESPACE',
                  true
                )
              : GDM_Utils.toBoolean(
                  options.normalizeWhitespace,
                  true
                )
        },

        totalKnown:
          1,

        setCurrent:
          true,

        message:
          'Recherche de doublons préparée.'
      });


    var jobId =
      state.jobId;


    /**********************************************************************************************
     * RÉSULTAT INITIAL
     **********************************************************************************************/

    this.initializeResult_(
      jobId,
      {
        sourceFolderId:
          rootFolderId,

        sourceFolderName:
          rootFolderName,

        recursive:
          recursive,

        method:
          method
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
          GDM_MODULES.DUPLICATES,

        action:
          GDM_ACTIONS.INDEX_DUPLICATE,

        itemId:
          rootFolderId,

        itemName:
          rootFolderName,

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            rootFolderId,

          recursive:
            recursive,

          phase:
            this.PHASE_FILES_,

          continuationToken:
            '',

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
            GDM_MODULES.DUPLICATES,

          action:
            GDM_ACTIONS.FIND_DUPLICATES,

          itemId:
            rootFolderId,

          itemName:
            rootFolderName,

          message:
            'Recherche de doublons démarrée.'
        }
      );

    } catch (ignored) {}


    /**********************************************************************************************
     * DÉMARRAGE
     **********************************************************************************************/

    var asyncMode =
      typeof options.async === 'undefined'
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

      ok:
        true,

      jobId:
        jobId,

      source: {
        id:
          rootFolderId,

        name:
          rootFolderName
      },

      recursive:
        recursive,

      method:
        method,

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


    if (
      task.action ===
        GDM_ACTIONS.INDEX_DUPLICATE ||
      task.action ===
        GDM_ACTIONS.FIND_DUPLICATES
    ) {

      return this.processScanTask_(
        task,
        context
      );
    }


    throw new Error(
      'Duplicates : action inconnue : ' +
      GDM_Utils.toString(
        task.action
      )
    );
  },


  /************************************************************************************************
   * TRAITEMENT D'UN DOSSIER
   *
   * Pour les très gros dossiers, DriveApp.getContinuationToken() permet de reprendre le parcours
   * sans recommencer au début du dossier.
   ************************************************************************************************/

  processScanTask_: function(
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
      GDM_Utils.requireFolderId(
        payload.folderId ||
        task.itemId,
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
      typeof payload.recursive === 'undefined'
        ? GDM_Utils.toBoolean(
            parameters.recursive,
            true
          )
        : GDM_Utils.toBoolean(
            payload.recursive,
            true
          );


    var phase =
      GDM_Utils.trim(
        payload.phase
      ).toUpperCase() ||
      this.PHASE_FILES_;


    var batchSize =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'DUPLICATES.BATCH_SIZE',
          300
        ),
        300
      );


    /**********************************************************************************************
     * PHASE FICHIERS
     **********************************************************************************************/

    if (
      phase ===
      this.PHASE_FILES_
    ) {

      return this.scanFiles_(
        jobId,
        folder,
        payload,
        parameters,
        recursive,
        batchSize
      );
    }


    /**********************************************************************************************
     * PHASE DOSSIERS
     **********************************************************************************************/

    if (
      phase ===
      this.PHASE_FOLDERS_
    ) {

      return this.scanFolders_(
        jobId,
        folder,
        payload,
        recursive,
        batchSize
      );
    }


    throw new Error(
      'Phase Duplicates inconnue : ' +
      phase
    );
  },


  /************************************************************************************************
   * SCAN DES FICHIERS D'UN DOSSIER
   ************************************************************************************************/

  scanFiles_: function(
    jobId,
    folder,
    payload,
    parameters,
    recursive,
    batchSize
  ) {

    var iterator;


    if (
      payload.continuationToken
    ) {

      iterator =
        DriveApp.continueFileIterator(
          payload.continuationToken
        );

    } else {

      iterator =
        folder.getFiles();
    }


    var result =
      this.readResult_(
        jobId
      );


    if (!result) {

      throw new Error(
        'Résultat Duplicates introuvable : ' +
        jobId
      );
    }


    var touchedBuckets = {};

    var scanned = 0;

    var indexed = 0;

    var ignored = 0;


    while (
      iterator.hasNext() &&
      scanned < batchSize
    ) {

      var file =
        iterator.next();


      scanned++;


      try {

        if (
          !this.isEligibleFile_(
            file,
            parameters
          )
        ) {

          ignored++;

          result.counters.ignoredFiles++;

          continue;
        }


        this.indexFile_(
          jobId,
          file,
          folder,
          parameters,
          result,
          touchedBuckets
        );


        indexed++;


      } catch (error) {

        result.counters.errors++;


        this.pushLimitedError_(
          result,
          GDM_Utils.errorToObject(
            error,
            {

              module:
                GDM_MODULES.DUPLICATES,

              action:
                GDM_ACTIONS.INDEX_DUPLICATE,

              itemId:
                this.safeGetId_(file),

              itemName:
                this.safeGetName_(file)
            }
          )
        );
      }
    }


    result.counters.scannedFiles +=
      scanned;


    result.counters.indexedFiles +=
      indexed;


    result.updatedAt =
      GDM_Utils.nowIso();


    /**********************************************************************************************
     * SAUVEGARDER LES BUCKETS MODIFIÉS
     **********************************************************************************************/

    var bucketIds =
      Object.keys(
        touchedBuckets
      );


    for (
      var b = 0;
      b < bucketIds.length;
      b++
    ) {

      var bucketId =
        bucketIds[b];


      this.writeIndexBucket_(
        jobId,
        bucketId,
        touchedBuckets[
          bucketId
        ]
      );
    }


    this.writeResult_(
      jobId,
      result
    );


    /**********************************************************************************************
     * LE DOSSIER CONTIENT ENCORE DES FICHIERS
     **********************************************************************************************/

    var newTasks = [];


    if (
      iterator.hasNext()
    ) {

      newTasks.push({

        module:
          GDM_MODULES.DUPLICATES,

        action:
          GDM_ACTIONS.INDEX_DUPLICATE,

        itemId:
          folder.getId(),

        itemName:
          folder.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            folder.getId(),

          recursive:
            recursive,

          phase:
            this.PHASE_FILES_,

          continuationToken:
            iterator.getContinuationToken(),

          depth:
            Math.max(
              0,
              GDM_Utils.toInteger(
                payload.depth,
                0
              )
            )
        }
      });


    } else if (recursive) {

      /*
       * Les fichiers directs sont terminés.
       * On passe maintenant aux sous-dossiers.
       */

      newTasks.push({

        module:
          GDM_MODULES.DUPLICATES,

        action:
          GDM_ACTIONS.INDEX_DUPLICATE,

        itemId:
          folder.getId(),

        itemName:
          folder.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            folder.getId(),

          recursive:
            true,

          phase:
            this.PHASE_FOLDERS_,

          continuationToken:
            '',

          depth:
            Math.max(
              0,
              GDM_Utils.toInteger(
                payload.depth,
                0
              )
            )
        }
      });
    }


    this.addTasksAndIncreaseTotal_(
      jobId,
      newTasks
    );


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Fichiers analysés : ' +
        folder.getName(),

      data: {

        folderId:
          folder.getId(),

        scanned:
          scanned,

        indexed:
          indexed,

        ignored:
          ignored,

        continuation:
          newTasks.length > 0
      }
    };
  },


  /************************************************************************************************
   * SCAN DES SOUS-DOSSIERS
   ************************************************************************************************/

  scanFolders_: function(
    jobId,
    folder,
    payload,
    recursive,
    batchSize
  ) {

    if (!recursive) {

      return {

        ok:
          true,

        skipped:
          false,

        message:
          'Analyse non récursive terminée.'
      };
    }


    var iterator;


    if (
      payload.continuationToken
    ) {

      iterator =
        DriveApp.continueFolderIterator(
          payload.continuationToken
        );

    } else {

      iterator =
        folder.getFolders();
    }


    var tasks = [];

    var scannedFolders = 0;


    while (
      iterator.hasNext() &&
      scannedFolders < batchSize
    ) {

      var child =
        iterator.next();


      scannedFolders++;


      tasks.push({

        module:
          GDM_MODULES.DUPLICATES,

        action:
          GDM_ACTIONS.INDEX_DUPLICATE,

        itemId:
          child.getId(),

        itemName:
          child.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            child.getId(),

          recursive:
            true,

          phase:
            this.PHASE_FILES_,

          continuationToken:
            '',

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


    /**********************************************************************************************
     * CONTINUATION DE LA LISTE DES SOUS-DOSSIERS
     **********************************************************************************************/

    if (
      iterator.hasNext()
    ) {

      tasks.push({

        module:
          GDM_MODULES.DUPLICATES,

        action:
          GDM_ACTIONS.INDEX_DUPLICATE,

        itemId:
          folder.getId(),

        itemName:
          folder.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            folder.getId(),

          recursive:
            true,

          phase:
            this.PHASE_FOLDERS_,

          continuationToken:
            iterator.getContinuationToken(),

          depth:
            Math.max(
              0,
              GDM_Utils.toInteger(
                payload.depth,
                0
              )
            )
        }
      });
    }


    this.addTasksAndIncreaseTotal_(
      jobId,
      tasks
    );


    var result =
      this.readResult_(
        jobId
      );


    if (result) {

      result.counters.scannedFolders +=
        scannedFolders;


      result.updatedAt =
        GDM_Utils.nowIso();


      this.writeResult_(
        jobId,
        result
      );
    }


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Sous-dossiers indexés : ' +
        folder.getName(),

      data: {

        folderId:
          folder.getId(),

        folders:
          scannedFolders,

        tasksAdded:
          tasks.length
      }
    };
  },


  /************************************************************************************************
   * INDEXER UN FICHIER
   ************************************************************************************************/

  indexFile_: function(
    jobId,
    file,
    parentFolder,
    parameters,
    result,
    touchedBuckets
  ) {

    var fileInfo =
      this.buildFileInfo_(
        file,
        parentFolder
      );


    var signature =
      this.buildSignature_(
        fileInfo,
        parameters
      );


    var hash =
      this.hash_(
        signature
      );


    var bucketId =
      this.getBucketId_(
        hash
      );


    if (
      !Object.prototype.hasOwnProperty.call(
        touchedBuckets,
        bucketId
      )
    ) {

      touchedBuckets[
        bucketId
      ] =
        this.readIndexBucket_(
          jobId,
          bucketId
        ) || {};
    }


    var bucket =
      touchedBuckets[
        bucketId
      ];


    var entry =
      bucket[
        hash
      ];


    /**********************************************************************************************
     * PREMIER FICHIER DE CETTE SIGNATURE
     **********************************************************************************************/

    if (!entry) {

      bucket[
        hash
      ] = {

        signature:
          signature,

        count:
          1,

        first:
          fileInfo
      };


      return;
    }


    /**********************************************************************************************
     * PROTECTION THÉORIQUE CONTRE COLLISION DE HASH
     **********************************************************************************************/

    if (
      entry.signature !==
      signature
    ) {

      /*
       * SHA-256 rend ce cas extrêmement improbable.
       * On crée une clé secondaire afin de rester exact.
       */

      var collisionKey =
        hash +
        '_' +
        this.hash_(
          signature +
          '|COLLISION'
        ).substring(
          0,
          12
        );


      entry =
        bucket[
          collisionKey
        ];


      if (!entry) {

        bucket[
          collisionKey
        ] = {

          signature:
            signature,

          count:
            1,

          first:
            fileInfo
        };


        return;
      }


      hash =
        collisionKey;
    }


    /**********************************************************************************************
     * DOUBLON TROUVÉ
     **********************************************************************************************/

    entry.count =
      Number(
        entry.count || 1
      ) + 1;


    result.counters.duplicateFiles++;


    /**********************************************************************************************
     * DEUXIÈME FICHIER : CRÉATION DU GROUPE
     **********************************************************************************************/

    if (
      entry.count === 2
    ) {

      this.createDuplicateGroup_(
        result,
        hash,
        signature,
        entry.first,
        fileInfo
      );


      result.counters.duplicateGroups++;


      /*
       * Taille potentiellement récupérable :
       * pour un groupe de doublons identiques selon signature,
       * chaque copie supplémentaire représente une taille récupérable potentielle.
       *
       * Pour NAME uniquement, cette estimation est indicative.
       */
      result.counters.potentialRecoverableBytes +=
        Number(
          fileInfo.size || 0
        );


      return;
    }


    /**********************************************************************************************
     * TROISIÈME FICHIER ET SUIVANTS
     **********************************************************************************************/

    this.appendToDuplicateGroup_(
      result,
      hash,
      fileInfo
    );


    result.counters.potentialRecoverableBytes +=
      Number(
        fileInfo.size || 0
      );
  },


  /************************************************************************************************
   * CRÉER UN GROUPE
   ************************************************************************************************/

  createDuplicateGroup_: function(
    result,
    hash,
    signature,
    firstFile,
    secondFile
  ) {

    var maxGroups =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'DUPLICATES.MAX_GROUPS_IN_RESULT',
          5000
        ),
        5000
      );


    if (
      result.groups.length >=
      maxGroups
    ) {

      result.truncated.groups =
        true;

      return;
    }


    var index =
      result.groups.length;


    result.groups.push({

      hash:
        hash,

      signature:
        signature,

      count:
        2,

      totalBytes:
        Number(
          firstFile.size || 0
        ) +
        Number(
          secondFile.size || 0
        ),

      potentialRecoverableBytes:
        Number(
          secondFile.size || 0
        ),

      files: [
        firstFile,
        secondFile
      ],

      truncated:
        false
    });


    result.groupLookup[
      hash
    ] =
      index;
  },


  /************************************************************************************************
   * AJOUTER À UN GROUPE
   ************************************************************************************************/

  appendToDuplicateGroup_: function(
    result,
    hash,
    fileInfo
  ) {

    if (
      typeof result.groupLookup[
        hash
      ] ===
      'undefined'
    ) {

      /*
       * Le groupe peut ne pas être mémorisé si MAX_GROUPS_IN_RESULT
       * a été atteint.
       */

      result.truncated.groups =
        true;

      return;
    }


    var index =
      result.groupLookup[
        hash
      ];


    var group =
      result.groups[
        index
      ];


    if (!group) {
      return;
    }


    group.count++;


    group.totalBytes +=
      Number(
        fileInfo.size || 0
      );


    group.potentialRecoverableBytes +=
      Number(
        fileInfo.size || 0
      );


    var maxFiles =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'DUPLICATES.MAX_FILES_PER_GROUP',
          500
        ),
        500
      );


    if (
      group.files.length <
      maxFiles
    ) {

      group.files.push(
        fileInfo
      );

    } else {

      group.truncated =
        true;

      result.truncated.files =
        true;
    }
  },


  /************************************************************************************************
   * ÉLIGIBILITÉ
   ************************************************************************************************/

  isEligibleFile_: function(
    file,
    parameters
  ) {

    var size =
      this.getFileSize_(
        file
      );


    if (
      GDM_Utils.toBoolean(
        parameters.ignoreZeroByteFiles,
        false
      ) &&
      size === 0
    ) {

      return false;
    }


    return true;
  },


  /************************************************************************************************
   * SIGNATURE
   ************************************************************************************************/

  buildSignature_: function(
    fileInfo,
    parameters
  ) {

    var method =
      this.normalizeMethod_(
        parameters.method
      );


    var name =
      GDM_Utils.toString(
        fileInfo.name
      );


    if (
      GDM_Utils.toBoolean(
        parameters.normalizeWhitespace,
        true
      )
    ) {

      name =
        GDM_Utils.normalizeWhitespace(
          name
        );
    }


    if (
      GDM_Utils.toBoolean(
        parameters.caseInsensitiveNames,
        true
      )
    ) {

      name =
        name.toLowerCase();
    }


    var size =
      Number(
        fileInfo.size || 0
      );


    switch (
      method
    ) {

      case this.METHOD_NAME_:

        return 'N|' +
          name;


      case this.METHOD_SIZE_:

        return 'S|' +
          size;


      case this.METHOD_NAME_SIZE_:

        return 'NS|' +
          name +
          '|' +
          size;


      default:

        throw new Error(
          'Méthode de doublons inconnue : ' +
          method
        );
    }
  },


  /************************************************************************************************
   * NORMALISER MÉTHODE
   ************************************************************************************************/

  normalizeMethod_: function(method) {

    method =
      GDM_Utils
        .trim(
          method
        )
        .toUpperCase()
        .replace(
          /[\s+\-]/g,
          '_'
        );


    if (
      method ===
        'NAME_AND_SIZE' ||
      method ===
        'NAME__SIZE'
    ) {

      method =
        this.METHOD_NAME_SIZE_;
    }


    if (
      method !==
        this.METHOD_NAME_ &&
      method !==
        this.METHOD_SIZE_ &&
      method !==
        this.METHOD_NAME_SIZE_
    ) {

      method =
        this.METHOD_NAME_SIZE_;
    }


    return method;
  },


  /************************************************************************************************
   * OBJET FICHIER
   ************************************************************************************************/

  buildFileInfo_: function(
    file,
    parentFolder
  ) {

    var size =
      this.getFileSize_(
        file
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


    return {

      id:
        file.getId(),

      name:
        file.getName(),

      size:
        size,

      sizeFormatted:
        GDM_Utils.formatBytes(
          size
        ),

      extension:
        GDM_Utils.getExtension(
          file.getName()
        ),

      mimeType:
        file.getMimeType(),

      parentId:
        parentId,

      parentName:
        parentName,

      updated:
        this.safeDateIso_(
          file
        ),

      url:
        file.getUrl()
    };
  },


  /************************************************************************************************
   * HASH SHA-256
   ************************************************************************************************/

  hash_: function(value) {

    var digest =
      Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        GDM_Utils.toString(
          value
        ),
        Utilities.Charset.UTF_8
      );


    var hex = '';


    for (
      var i = 0;
      i < digest.length;
      i++
    ) {

      var byte =
        digest[i];


      if (
        byte < 0
      ) {
        byte += 256;
      }


      var part =
        byte.toString(
          16
        );


      if (
        part.length === 1
      ) {
        part =
          '0' +
          part;
      }


      hex +=
        part;
    }


    return hex;
  },


  /************************************************************************************************
   * BUCKET
   ************************************************************************************************/

  getBucketId_: function(hash) {

    var number =
      parseInt(
        hash.substring(
          0,
          8
        ),
        16
      );


    if (
      !isFinite(
        number
      )
    ) {

      number = 0;
    }


    return String(
      number %
      this.INDEX_BUCKETS_
    );
  },


  /************************************************************************************************
   * RÉSULTAT INITIAL
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
        GDM_MODULES.DUPLICATES,

      source: {

        id:
          options.sourceFolderId ||
          '',

        name:
          options.sourceFolderName ||
          ''
      },

      method:
        options.method ||
        this.METHOD_NAME_SIZE_,

      recursive:
        GDM_Utils.toBoolean(
          options.recursive,
          true
        ),

      startedAt:
        GDM_Utils.nowIso(),

      updatedAt:
        GDM_Utils.nowIso(),

      finishedAt:
        '',

      counters: {

        scannedFiles:
          0,

        indexedFiles:
          0,

        scannedFolders:
          0,

        ignoredFiles:
          0,

        duplicateGroups:
          0,

        duplicateFiles:
          0,

        potentialRecoverableBytes:
          0,

        errors:
          0
      },

      groups: [],

      /*
       * Permet de retrouver rapidement un groupe sans parcourir
       * tout le tableau à chaque nouveau doublon.
       */
      groupLookup: {},

      errors: [],

      truncated: {

        groups:
          false,

        files:
          false,

        errors:
          false
      }
    };


    this.writeResult_(
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


    /*
     * groupLookup est uniquement technique.
     * On ne l'envoie pas à l'interface.
     */

    delete result.groupLookup;


    result.summary = {

      scannedFiles:
        Number(
          result.counters.scannedFiles ||
          0
        ),

      duplicateGroups:
        Number(
          result.counters.duplicateGroups ||
          0
        ),

      duplicateFiles:
        Number(
          result.counters.duplicateFiles ||
          0
        ),

      potentialRecoverableBytes:
        Number(
          result.counters.potentialRecoverableBytes ||
          0
        ),

      potentialRecoverableFormatted:
        GDM_Utils.formatBytes(
          Number(
            result.counters.potentialRecoverableBytes ||
            0
          )
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
   * STATUT
   ************************************************************************************************/

  getStatus: function(jobId) {

    return {

      ok:
        true,

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
        this.getResult(
          jobId
        )
    };
  },


  /************************************************************************************************
   * FINALISATION
   ************************************************************************************************/

  finalizeResult: function(jobId) {

    var result =
      this.readResult_(
        jobId
      );


    if (!result) {
      return null;
    }


    result.finishedAt =
      GDM_Utils.nowIso();


    result.updatedAt =
      result.finishedAt;


    this.writeResult_(
      jobId,
      result
    );


    try {

      GDM_Logger.scanCompleted(
        jobId,
        {

          module:
            GDM_MODULES.DUPLICATES,

          action:
            GDM_ACTIONS.FIND_DUPLICATES,

          message:
            'Recherche de doublons terminée.',

          data: {

            scannedFiles:
              result.counters.scannedFiles,

            duplicateGroups:
              result.counters.duplicateGroups,

            duplicateFiles:
              result.counters.duplicateFiles
          }
        }
      );

    } catch (ignored) {}


    return this.getResult(
      jobId
    );
  },


  /************************************************************************************************
   * AJOUT DES TÂCHES
   ************************************************************************************************/

  addTasksAndIncreaseTotal_: function(
    jobId,
    tasks
  ) {

    tasks =
      GDM_Utils.ensureArray(
        tasks
      );


    if (!tasks.length) {
      return 0;
    }


    GDM_Queue.addInBatches(
      jobId,
      tasks,
      GDM_Config.get(
        'QUEUE.MAX_ITEMS_PER_BATCH',
        250
      )
    );


    var state =
      GDM_State.require(
        jobId
      );


    GDM_State.setTotalKnown(
      jobId,
      Number(
        state.totalKnown || 0
      ) +
      tasks.length
    );


    return tasks.length;
  },


  /************************************************************************************************
   * ERREURS LIMITÉES
   ************************************************************************************************/

  pushLimitedError_: function(
    result,
    error
  ) {

    var maxErrors =
      Math.min(
        1000,
        GDM_Utils.toPositiveInteger(
          GDM_Config.get(
            'UI.RESULT_MAX_ROWS',
            5000
          ),
          5000
        )
      );


    if (
      result.errors.length <
      maxErrors
    ) {

      result.errors.push(
        error
      );

    } else {

      result.truncated.errors =
        true;
    }
  },


  /************************************************************************************************
   * INDEX : LECTURE BUCKET
   ************************************************************************************************/

  readIndexBucket_: function(
    jobId,
    bucketId
  ) {

    var key =
      this.getIndexBucketKey_(
        jobId,
        bucketId
      );


    return this.readChunked_(
      key
    ) || {};
  },


  /************************************************************************************************
   * INDEX : ÉCRITURE BUCKET
   ************************************************************************************************/

  writeIndexBucket_: function(
    jobId,
    bucketId,
    data
  ) {

    return this.writeChunked_(
      this.getIndexBucketKey_(
        jobId,
        bucketId
      ),
      data || {}
    );
  },


  /************************************************************************************************
   * CLÉ BUCKET
   ************************************************************************************************/

  getIndexBucketKey_: function(
    jobId,
    bucketId
  ) {

    return this.INDEX_PREFIX_ +
      GDM_Utils.requireString(
        jobId,
        'jobId'
      ) +
      '_' +
      GDM_Utils.toString(
        bucketId
      );
  },


  /************************************************************************************************
   * SUPPRIMER L'INDEX TECHNIQUE
   *
   * Aucun fichier Google Drive n'est supprimé.
   ************************************************************************************************/

  clearIndex: function(jobId) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );


    var removed = 0;


    for (
      var i = 0;
      i < this.INDEX_BUCKETS_;
      i++
    ) {

      if (
        this.deleteChunked_(
          this.getIndexBucketKey_(
            jobId,
            String(i)
          )
        )
      ) {

        removed++;
      }
    }


    return {

      ok:
        true,

      jobId:
        jobId,

      bucketsProcessed:
        removed
    };
  },


  /************************************************************************************************
   * SUPPRIMER LES DONNÉES TECHNIQUES DU MODULE
   ************************************************************************************************/

  cleanup: function(jobId) {

    this.clearIndex(
      jobId
    );


    this.deleteChunked_(
      this.getResultKey_(
        jobId
      )
    );


    return {

      ok:
        true,

      jobId:
        jobId
    };
  },


  /************************************************************************************************
   * CLÉ RÉSULTAT
   ************************************************************************************************/

  getResultKey_: function(jobId) {

    return this.RESULT_PREFIX_ +
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );
  },


  /************************************************************************************************
   * LIRE RÉSULTAT
   ************************************************************************************************/

  readResult_: function(jobId) {

    return this.readChunked_(
      this.getResultKey_(
        jobId
      )
    );
  },


  /************************************************************************************************
   * ÉCRIRE RÉSULTAT
   ************************************************************************************************/

  writeResult_: function(
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


  /************************************************************************************************
   * STOCKAGE FRACTIONNÉ
   ************************************************************************************************/

  writeChunked_: function(
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
        1,
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
        'Données Duplicates trop volumineuses pour le stockage technique.'
      );
    }


    var previousMeta =
      GDM_Utils.safeJsonParse(
        properties.getProperty(
          baseKey +
          '_META'
        ),
        {}
      );


    var previousCount =
      Math.max(
        0,
        GDM_Utils.toInteger(
          previousMeta.chunkCount,
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
      old < previousCount;
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


  /************************************************************************************************
   * LECTURE FRACTIONNÉE
   ************************************************************************************************/

  readChunked_: function(baseKey) {

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
   * SUPPRESSION FRACTIONNÉE
   ************************************************************************************************/

  deleteChunked_: function(baseKey) {

    var properties =
      PropertiesService
        .getScriptProperties();


    var meta =
      GDM_Utils.safeJsonParse(
        properties.getProperty(
          baseKey +
          '_META'
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
      baseKey +
      '_META'
    );


    properties.deleteProperty(
      baseKey
    );


    return true;
  },


  /************************************************************************************************
   * HELPERS
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


  safeDateIso_: function(file) {

    try {

      return GDM_Utils.toIso(
        file.getLastUpdated()
      );

    } catch (ignored) {

      return '';
    }
  },


  safeGetId_: function(file) {

    try {

      return file.getId();

    } catch (ignored) {

      return '';
    }
  },


  safeGetName_: function(file) {

    try {

      return file.getName();

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

      if (
        this.normalizeMethod_(
          'name+size'
        ) !==
        this.METHOD_NAME_SIZE_
      ) {

        errors.push(
          'Normalisation NAME_SIZE incorrecte.'
        );
      }


      if (
        this.normalizeMethod_(
          'size'
        ) !==
        this.METHOD_SIZE_
      ) {

        errors.push(
          'Normalisation SIZE incorrecte.'
        );
      }

    } catch (error1) {

      errors.push(
        'Erreur méthode : ' +
        GDM_Utils.getErrorMessage(
          error1
        )
      );
    }


    try {

      var hash =
        this.hash_(
          'Google Drive Manager PRO'
        );


      if (
        !hash ||
        hash.length !== 64
      ) {

        errors.push(
          'Hash SHA-256 incorrect.'
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur SHA-256 : ' +
        GDM_Utils.getErrorMessage(
          error2
        )
      );
    }


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

    } catch (error3) {

      errors.push(
        'Erreur Google Drive : ' +
        GDM_Utils.getErrorMessage(
          error3
        )
      );
    }


    return {

      ok:
        errors.length === 0,

      file:
        'Modules/Duplicates.gs',

      version:
        GDM_APP.VERSION,

      readOnly:
        true,

      deletesFiles:
        false,

      methods: [
        this.METHOD_NAME_,
        this.METHOD_SIZE_,
        this.METHOD_NAME_SIZE_
      ],

      errors:
        errors
    };
  }

});


/**************************************************************************************************
 * API GLOBALE POUR L'INTERFACE
 **************************************************************************************************/

function GDM_apiGetDuplicatesResult(jobId) {

  return {

    ok:
      true,

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
      GDM_Duplicates.getResult(
        jobId
      )
  };
}