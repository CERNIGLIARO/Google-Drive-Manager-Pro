/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Archive.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Archivage progressif de fichiers Google Drive selon des critères configurables.
 *
 * CE MODULE GÈRE
 * --------------
 * - archivage d'un dossier ou de Mon Drive ;
 * - analyse récursive ;
 * - archivage selon l'âge du fichier ;
 * - filtres par extension ;
 * - filtres par type MIME ;
 * - filtre sur le nom ;
 * - filtres par taille ;
 * - conservation optionnelle de l'arborescence ;
 * - traitement par lots ;
 * - continuation des très gros dossiers ;
 * - reprise automatique via Queue + Engine ;
 * - statistiques d'archivage ;
 * - gestion des erreurs fichier par fichier.
 *
 * PRINCIPE
 * --------
 * ARCHIVER = DÉPLACER vers un dossier d'archive.
 *
 * Aucun fichier n'est supprimé.
 *
 * CONCEPTION GROS DRIVE
 * ---------------------
 * Le module ne charge jamais tout Google Drive en mémoire.
 *
 * Chaque dossier est parcouru en deux phases :
 *
 * FILES
 *   ↓
 * fichiers correspondant aux critères
 *   ↓
 * tâches ARCHIVE_FILE
 *
 * FOLDERS
 *   ↓
 * sous-dossiers
 *   ↓
 * nouvelles tâches SCAN_FOLDER
 *
 * DriveApp.getContinuationToken() permet de continuer les très gros dossiers sans recommencer.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 * Core/State.gs
 * Core/Queue.gs
 * Core/Engine.gs
 *
 * SÉCURITÉ
 * --------
 * - Aucun fichier n'est supprimé.
 * - Le dossier d'archive est exclu du scan.
 * - Source et destination ne peuvent pas être identiques.
 * - Une erreur sur un fichier n'arrête pas tout le traitement.
 **************************************************************************************************/

'use strict';


const GDM_Archive = Object.freeze({


  /************************************************************************************************
   * CONSTANTES INTERNES
   ************************************************************************************************/

  OP_SCAN_FOLDER_: 'SCAN_FOLDER',

  OP_ARCHIVE_FILE_: 'ARCHIVE_FILE',

  PHASE_FILES_: 'FILES',

  PHASE_FOLDERS_: 'FOLDERS',

  RESULT_PREFIX_: 'GDMV2_ARCHIVE_RESULT_',


  /************************************************************************************************
   * LANCEMENT
   ************************************************************************************************/

  start: function(options) {

    options = options || {};


    /**********************************************************************************************
     * SOURCE
     **********************************************************************************************/

    var sourceFolder =
      GDM_Utils.getFolderOrRoot(
        options.sourceFolderId ||
        options.folderId ||
        ''
      );


    var sourceFolderId =
      sourceFolder.getId();


    var rootId =
      DriveApp
        .getRootFolder()
        .getId();


    var sourceFolderName =
      sourceFolderId === rootId
        ? GDM_Config.get(
            'APP.ROOT_LABEL',
            'Mon Drive'
          )
        : sourceFolder.getName();


    /**********************************************************************************************
     * DESTINATION ARCHIVE
     **********************************************************************************************/

    var archiveFolderId =
      GDM_Utils.requireFolderId(
        options.archiveFolderId ||
        options.destinationFolderId,
        'archiveFolderId'
      );


    var archiveFolder =
      DriveApp.getFolderById(
        archiveFolderId
      );


    if (
      sourceFolderId ===
      archiveFolderId
    ) {

      throw new Error(
        'Le dossier source et le dossier d’archive doivent être différents.'
      );
    }


    /**********************************************************************************************
     * PARAMÈTRES
     **********************************************************************************************/

    var recursive =
      typeof options.recursive ===
        'undefined'
        ? GDM_Config.get(
            'ARCHIVE.INCLUDE_SUBFOLDERS_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.recursive,
            true
          );


    var preserveStructure =
      typeof options.preserveStructure ===
        'undefined'
        ? GDM_Config.get(
            'ARCHIVE.PRESERVE_STRUCTURE_DEFAULT',
            false
          )
        : GDM_Utils.toBoolean(
            options.preserveStructure,
            false
          );


    var olderThanDays =
      typeof options.olderThanDays ===
        'undefined'
        ? GDM_Config.get(
            'ARCHIVE.DEFAULT_OLDER_THAN_DAYS',
            365
          )
        : Math.max(
            0,
            GDM_Utils.toInteger(
              options.olderThanDays,
              0
            )
          );


    var filters =
      this.normalizeFilters_(
        options.filters ||
        options
      );


    filters.olderThanDays =
      olderThanDays;


    /**********************************************************************************************
     * JOB
     **********************************************************************************************/

    var state =
      GDM_State.create({

        module:
          GDM_MODULES.ARCHIVE,

        action:
          GDM_ACTIONS.ARCHIVE_FILE,

        source: {

          id:
            sourceFolderId,

          name:
            sourceFolderName
        },

        destination: {

          id:
            archiveFolderId,

          name:
            archiveFolder.getName()
        },

        parameters: {

          recursive:
            recursive,

          preserveStructure:
            preserveStructure,

          archiveRootFolderId:
            archiveFolderId,

          olderThanDays:
            olderThanDays,

          filters:
            filters
        },

        totalKnown:
          1,

        setCurrent:
          true,

        message:
          'Archivage préparé.'
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
          sourceFolderId,

        sourceFolderName:
          sourceFolderName,

        archiveFolderId:
          archiveFolderId,

        archiveFolderName:
          archiveFolder.getName(),

        recursive:
          recursive,

        preserveStructure:
          preserveStructure,

        filters:
          filters
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
          GDM_MODULES.ARCHIVE,

        action:
          GDM_ACTIONS.ARCHIVE_FILE,

        itemId:
          sourceFolderId,

        itemName:
          sourceFolderName,

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            sourceFolderId,

          archiveRootFolderId:
            archiveFolderId,

          archiveDestinationFolderId:
            archiveFolderId,

          recursive:
            recursive,

          preserveStructure:
            preserveStructure,

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


    /**********************************************************************************************
     * LOG
     **********************************************************************************************/

    try {

      GDM_Logger.scanStarted(
        jobId,
        {

          module:
            GDM_MODULES.ARCHIVE,

          action:
            GDM_ACTIONS.ARCHIVE_FILE,

          itemId:
            sourceFolderId,

          itemName:
            sourceFolderName,

          message:
            'Recherche des fichiers à archiver démarrée.',

          data: {

            archiveFolderId:
              archiveFolderId,

            olderThanDays:
              olderThanDays,

            recursive:
              recursive,

            preserveStructure:
              preserveStructure
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

      ok:
        true,

      jobId:
        jobId,

      source: {

        id:
          sourceFolderId,

        name:
          sourceFolderName
      },

      archive: {

        id:
          archiveFolderId,

        name:
          archiveFolder.getName(),

        url:
          GDM_Utils.getDriveFolderUrl(
            archiveFolderId
          )
      },

      recursive:
        recursive,

      preserveStructure:
        preserveStructure,

      filters:
        filters,

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


    var payload =
      task.payload ||
      {};


    var operation =
      GDM_Utils.trim(
        payload.operation
      ).toUpperCase();


    if (
      operation ===
      this.OP_SCAN_FOLDER_
    ) {

      return this.processScanFolder_(
        task,
        context
      );
    }


    if (
      operation ===
        this.OP_ARCHIVE_FILE_ ||
      task.action ===
        GDM_ACTIONS.ARCHIVE_FILE
    ) {

      return this.processArchiveFile_(
        task,
        context
      );
    }


    throw new Error(
      'Archive : opération inconnue : ' +
      GDM_Utils.toString(
        operation
      )
    );
  },


  /************************************************************************************************
   * SCAN DOSSIER
   ************************************************************************************************/

  processScanFolder_: function(
    task,
    context
  ) {

    var payload =
      task.payload ||
      {};


    var phase =
      GDM_Utils.trim(
        payload.phase
      ).toUpperCase() ||
      this.PHASE_FILES_;


    if (
      phase ===
      this.PHASE_FILES_
    ) {

      return this.scanFiles_(
        task,
        context
      );
    }


    if (
      phase ===
      this.PHASE_FOLDERS_
    ) {

      return this.scanFolders_(
        task,
        context
      );
    }


    throw new Error(
      'Archive : phase inconnue : ' +
      phase
    );
  },


  /************************************************************************************************
   * SCAN DES FICHIERS
   ************************************************************************************************/

  scanFiles_: function(
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


    var archiveRootFolderId =
      GDM_Utils.requireFolderId(
        payload.archiveRootFolderId ||
        parameters.archiveRootFolderId ||
        (
          state.destination &&
          state.destination.id
        ),
        'archiveRootFolderId'
      );


    var archiveDestinationFolderId =
      GDM_Utils.requireFolderId(
        payload.archiveDestinationFolderId ||
        archiveRootFolderId,
        'archiveDestinationFolderId'
      );


    /*
     * Ne jamais scanner le dossier racine d'archive.
     */
    if (
      folderId ===
      archiveRootFolderId
    ) {

      return {

        ok:
          true,

        skipped:
          true,

        message:
          'Dossier d’archive exclu du scan.'
      };
    }


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


    var preserveStructure =
      typeof payload.preserveStructure ===
        'undefined'
        ? GDM_Utils.toBoolean(
            parameters.preserveStructure,
            false
          )
        : GDM_Utils.toBoolean(
            payload.preserveStructure,
            false
          );


    var filters =
      this.normalizeFilters_(
        parameters.filters ||
        {}
      );


    filters.olderThanDays =
      Math.max(
        0,
        GDM_Utils.toInteger(
          parameters.olderThanDays,
          filters.olderThanDays || 0
        )
      );


    var batchSize =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'ARCHIVE.BATCH_SIZE',
          100
        ),
        100
      );


    /**********************************************************************************************
     * ITÉRATEUR
     **********************************************************************************************/

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


    var scanned = 0;

    var matched = 0;

    var ignored = 0;

    var tasks = [];


    while (
      iterator.hasNext() &&
      scanned < batchSize
    ) {

      var file =
        iterator.next();


      scanned++;


      try {

        /*
         * Si le fichier est déjà directement dans le dossier d'archive
         * correspondant, il n'est pas remis dans la queue.
         */
        if (
          this.fileHasParent_(
            file,
            archiveDestinationFolderId
          )
        ) {

          ignored++;

          continue;
        }


        if (
          !this.matchesFile_(
            file,
            filters
          )
        ) {

          ignored++;

          continue;
        }


        matched++;


        tasks.push({

          module:
            GDM_MODULES.ARCHIVE,

          action:
            GDM_ACTIONS.ARCHIVE_FILE,

          itemId:
            file.getId(),

          itemName:
            file.getName(),

          payload: {

            operation:
              this.OP_ARCHIVE_FILE_,

            fileId:
              file.getId(),

            sourceFolderId:
              folderId,

            archiveRootFolderId:
              archiveRootFolderId,

            destinationFolderId:
              archiveDestinationFolderId
          }
        });


      } catch (error) {

        this.recordScanError_(
          jobId,
          error,
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
     * CONTINUATION DES FICHIERS
     **********************************************************************************************/

    if (
      iterator.hasNext()
    ) {

      tasks.push({

        module:
          GDM_MODULES.ARCHIVE,

        action:
          GDM_ACTIONS.ARCHIVE_FILE,

        itemId:
          folderId,

        itemName:
          folder.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            folderId,

          archiveRootFolderId:
            archiveRootFolderId,

          archiveDestinationFolderId:
            archiveDestinationFolderId,

          recursive:
            recursive,

          preserveStructure:
            preserveStructure,

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
       * Le prochain passage traite les sous-dossiers.
       */

      tasks.push({

        module:
          GDM_MODULES.ARCHIVE,

        action:
          GDM_ACTIONS.ARCHIVE_FILE,

        itemId:
          folderId,

        itemName:
          folder.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            folderId,

          archiveRootFolderId:
            archiveRootFolderId,

          archiveDestinationFolderId:
            archiveDestinationFolderId,

          recursive:
            true,

          preserveStructure:
            preserveStructure,

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
      tasks
    );


    this.updateResult_(
      jobId,
      function(result) {

        result.counters.scannedFiles +=
          scanned;


        result.counters.matchedFiles +=
          matched;


        result.counters.ignoredFiles +=
          ignored;


        result.updatedAt =
          GDM_Utils.nowIso();


        return result;
      }
    );


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Fichiers contrôlés pour archivage : ' +
        folder.getName(),

      data: {

        folderId:
          folderId,

        scanned:
          scanned,

        matched:
          matched,

        ignored:
          ignored,

        tasksAdded:
          tasks.length
      }
    };
  },


  /************************************************************************************************
   * SCAN DES SOUS-DOSSIERS
   ************************************************************************************************/

  scanFolders_: function(
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


    var archiveRootFolderId =
      GDM_Utils.requireFolderId(
        payload.archiveRootFolderId,
        'archiveRootFolderId'
      );


    var archiveDestinationFolderId =
      GDM_Utils.requireFolderId(
        payload.archiveDestinationFolderId ||
        archiveRootFolderId,
        'archiveDestinationFolderId'
      );


    var preserveStructure =
      GDM_Utils.toBoolean(
        payload.preserveStructure,
        false
      );


    var recursive =
      GDM_Utils.toBoolean(
        payload.recursive,
        true
      );


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


    var batchSize =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'ARCHIVE.BATCH_SIZE',
          100
        ),
        100
      );


    /**********************************************************************************************
     * ITÉRATEUR DOSSIERS
     **********************************************************************************************/

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

    var archiveFoldersCreated = 0;


    var archiveDestinationFolder =
      DriveApp.getFolderById(
        archiveDestinationFolderId
      );


    while (
      iterator.hasNext() &&
      scannedFolders < batchSize
    ) {

      var child =
        iterator.next();


      var childId =
        child.getId();


      /*
       * Le dossier d'archive et toute sa branche ne doivent jamais
       * revenir dans le scan.
       */
      if (
        childId ===
        archiveRootFolderId
      ) {

        continue;
      }


      if (
        this.isDescendantOf_(
          child,
          archiveRootFolderId
        )
      ) {

        continue;
      }


      scannedFolders++;


      var childArchiveDestinationId =
        archiveRootFolderId;


      /********************************************************************************************
       * CONSERVATION DE L'ARBORESCENCE
       ********************************************************************************************/

      if (preserveStructure) {

        var archiveChild =
          this.getOrCreateChildFolder_(
            archiveDestinationFolder,
            child.getName()
          );


        childArchiveDestinationId =
          archiveChild.folder.getId();


        if (
          archiveChild.created
        ) {

          archiveFoldersCreated++;
        }
      }


      tasks.push({

        module:
          GDM_MODULES.ARCHIVE,

        action:
          GDM_ACTIONS.ARCHIVE_FILE,

        itemId:
          childId,

        itemName:
          child.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            childId,

          archiveRootFolderId:
            archiveRootFolderId,

          archiveDestinationFolderId:
            preserveStructure
              ? childArchiveDestinationId
              : archiveRootFolderId,

          recursive:
            true,

          preserveStructure:
            preserveStructure,

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
     * CONTINUATION DES DOSSIERS
     **********************************************************************************************/

    if (
      iterator.hasNext()
    ) {

      tasks.push({

        module:
          GDM_MODULES.ARCHIVE,

        action:
          GDM_ACTIONS.ARCHIVE_FILE,

        itemId:
          folderId,

        itemName:
          folder.getName(),

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            folderId,

          archiveRootFolderId:
            archiveRootFolderId,

          archiveDestinationFolderId:
            archiveDestinationFolderId,

          recursive:
            true,

          preserveStructure:
            preserveStructure,

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


    this.updateResult_(
      jobId,
      function(result) {

        result.counters.scannedFolders +=
          scannedFolders;


        result.counters.archiveFoldersCreated +=
          archiveFoldersCreated;


        result.updatedAt =
          GDM_Utils.nowIso();


        return result;
      }
    );


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Sous-dossiers contrôlés : ' +
        folder.getName(),

      data: {

        folderId:
          folderId,

        scannedFolders:
          scannedFolders,

        archiveFoldersCreated:
          archiveFoldersCreated,

        tasksAdded:
          tasks.length
      }
    };
  },


  /************************************************************************************************
   * ARCHIVER UN FICHIER
   ************************************************************************************************/

  processArchiveFile_: function(
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


    /**********************************************************************************************
     * DÉJÀ ARCHIVÉ
     **********************************************************************************************/

    if (
      this.fileHasParent_(
        file,
        destinationFolderId
      )
    ) {

      return {

        ok:
          true,

        skipped:
          true,

        message:
          'Fichier déjà présent dans le dossier d’archive.',

        data: {

          fileId:
            fileId,

          destinationFolderId:
            destinationFolderId
        }
      };
    }


    var originalParent =
      GDM_Utils.getFirstParentInfo(
        file
      );


    var size =
      this.getFileSize_(
        file
      );


    /**********************************************************************************************
     * DÉPLACEMENT
     **********************************************************************************************/

    file.moveTo(
      destinationFolder
    );


    /**********************************************************************************************
     * STATISTIQUES
     **********************************************************************************************/

    this.updateResult_(
      jobId,
      function(result) {

        result.counters.archivedFiles++;


        result.counters.archivedBytes +=
          size;


        result.updatedAt =
          GDM_Utils.nowIso();


        return result;
      }
    );


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Fichier archivé : ' +
        file.getName(),

      data: {

        fileId:
          fileId,

        fileName:
          file.getName(),

        size:
          size,

        sizeFormatted:
          GDM_Utils.formatBytes(
            size
          ),

        sourceFolderId:
          originalParent.id,

        sourceFolderName:
          originalParent.name,

        destinationFolderId:
          destinationFolderId,

        destinationFolderName:
          destinationFolder.getName()
      }
    };
  },


  /************************************************************************************************
   * NORMALISATION DES FILTRES
   ************************************************************************************************/

  normalizeFilters_: function(filters) {

    filters =
      filters || {};


    var minSize =
      Math.max(
        0,
        GDM_Utils.toNumber(
          filters.minSize,
          0
        )
      );


    var maxSize =
      Math.max(
        0,
        GDM_Utils.toNumber(
          filters.maxSize,
          0
        )
      );


    if (
      typeof filters.minSizeMB !==
      'undefined'
    ) {

      minSize =
        GDM_Utils.mbToBytes(
          filters.minSizeMB
        );
    }


    if (
      typeof filters.maxSizeMB !==
      'undefined'
    ) {

      maxSize =
        GDM_Utils.mbToBytes(
          filters.maxSizeMB
        );
    }


    return {

      olderThanDays:
        Math.max(
          0,
          GDM_Utils.toInteger(
            filters.olderThanDays,
            0
          )
        ),

      extensions:
        GDM_Utils.normalizeExtensions(
          filters.extensions ||
          filters.extension ||
          []
        ),

      mimeTypes:
        GDM_Utils.uniqueStrings(
          filters.mimeTypes ||
          filters.mimeType ||
          [],
          false
        ),

      nameContains:
        GDM_Utils.trim(
          filters.nameContains ||
          filters.search ||
          ''
        ),

      minSize:
        minSize,

      maxSize:
        maxSize,

      beforeDate:
        GDM_Utils.toIso(
          filters.beforeDate
        ),

      afterDate:
        GDM_Utils.toIso(
          filters.afterDate
        )
    };
  },


  /************************************************************************************************
   * VÉRIFICATION D'UN FICHIER
   ************************************************************************************************/

  matchesFile_: function(
    file,
    filters
  ) {

    filters =
      this.normalizeFilters_(
        filters
      );


    var fileName =
      file.getName();


    var extension =
      GDM_Utils.getExtension(
        fileName
      );


    var mimeType =
      file.getMimeType();


    var size =
      this.getFileSize_(
        file
      );


    var updated =
      this.getLastUpdated_(
        file
      );


    /**********************************************************************************************
     * ÂGE
     **********************************************************************************************/

    if (
      filters.olderThanDays > 0
    ) {

      if (
        !updated ||
        !GDM_Utils.isOlderThanDays(
          updated,
          filters.olderThanDays
        )
      ) {

        return false;
      }
    }


    /**********************************************************************************************
     * EXTENSION
     **********************************************************************************************/

    if (
      filters.extensions.length &&
      filters.extensions.indexOf(
        extension
      ) === -1
    ) {

      return false;
    }


    /**********************************************************************************************
     * MIME
     **********************************************************************************************/

    if (
      filters.mimeTypes.length &&
      filters.mimeTypes.indexOf(
        mimeType
      ) === -1
    ) {

      return false;
    }


    /**********************************************************************************************
     * NOM
     **********************************************************************************************/

    if (
      filters.nameContains &&
      !GDM_Utils.contains(
        fileName,
        filters.nameContains,
        false
      )
    ) {

      return false;
    }


    /**********************************************************************************************
     * TAILLE MIN
     **********************************************************************************************/

    if (
      filters.minSize > 0 &&
      size < filters.minSize
    ) {

      return false;
    }


    /**********************************************************************************************
     * TAILLE MAX
     **********************************************************************************************/

    if (
      filters.maxSize > 0 &&
      size > filters.maxSize
    ) {

      return false;
    }


    /**********************************************************************************************
     * DATE AVANT
     **********************************************************************************************/

    if (
      filters.beforeDate
    ) {

      var before =
        GDM_Utils.toDate(
          filters.beforeDate
        );


      if (
        !updated ||
        !before ||
        updated.getTime() >=
          before.getTime()
      ) {

        return false;
      }
    }


    /**********************************************************************************************
     * DATE APRÈS
     **********************************************************************************************/

    if (
      filters.afterDate
    ) {

      var after =
        GDM_Utils.toDate(
          filters.afterDate
        );


      if (
        !updated ||
        !after ||
        updated.getTime() <=
          after.getTime()
      ) {

        return false;
      }
    }


    return true;
  },


  /************************************************************************************************
   * DOSSIER ARCHIVE : CRÉER OU RÉUTILISER
   ************************************************************************************************/

  getOrCreateChildFolder_: function(
    parentFolder,
    folderName
  ) {

    folderName =
      GDM_Utils.sanitizeFolderName(
        folderName
      );


    var existing =
      parentFolder.getFoldersByName(
        folderName
      );


    if (
      existing.hasNext()
    ) {

      return {

        folder:
          existing.next(),

        created:
          false
      };
    }


    return {

      folder:
        parentFolder.createFolder(
          folderName
        ),

      created:
        true
    };
  },


  /************************************************************************************************
   * VÉRIFIER SI UN DOSSIER EST DANS L'ARBORESCENCE DE L'ARCHIVE
   ************************************************************************************************/

  isDescendantOf_: function(
    folder,
    ancestorFolderId
  ) {

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
   * PARENT DU FICHIER
   ************************************************************************************************/

  fileHasParent_: function(
    file,
    folderId
  ) {

    try {

      var parents =
        file.getParents();


      while (
        parents.hasNext()
      ) {

        if (
          parents.next().getId() ===
          folderId
        ) {

          return true;
        }
      }

    } catch (ignored) {}


    return false;
  },


  /************************************************************************************************
   * AJOUT TÂCHES + TOTAL
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
        GDM_MODULES.ARCHIVE,

      source: {

        id:
          options.sourceFolderId ||
          '',

        name:
          options.sourceFolderName ||
          ''
      },

      archive: {

        id:
          options.archiveFolderId ||
          '',

        name:
          options.archiveFolderName ||
          ''
      },

      parameters: {

        recursive:
          GDM_Utils.toBoolean(
            options.recursive,
            true
          ),

        preserveStructure:
          GDM_Utils.toBoolean(
            options.preserveStructure,
            false
          ),

        filters:
          options.filters ||
          {}
      },

      startedAt:
        GDM_Utils.nowIso(),

      updatedAt:
        GDM_Utils.nowIso(),

      finishedAt:
        '',

      counters: {

        scannedFiles:
          0,

        scannedFolders:
          0,

        matchedFiles:
          0,

        ignoredFiles:
          0,

        archivedFiles:
          0,

        archivedBytes:
          0,

        archiveFoldersCreated:
          0,

        errors:
          0
      },

      errors: [],

      truncated: {

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


    result.summary = {

      scannedFiles:
        Number(
          result.counters.scannedFiles ||
          0
        ),

      matchedFiles:
        Number(
          result.counters.matchedFiles ||
          0
        ),

      archivedFiles:
        Number(
          result.counters.archivedFiles ||
          0
        ),

      archivedBytes:
        Number(
          result.counters.archivedBytes ||
          0
        ),

      archivedSizeFormatted:
        GDM_Utils.formatBytes(
          Number(
            result.counters.archivedBytes ||
            0
          )
        ),

      archiveFoldersCreated:
        Number(
          result.counters.archiveFoldersCreated ||
          0
        ),

      errors:
        Number(
          result.counters.errors ||
          0
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
   * ENREGISTRER UNE ERREUR DE SCAN
   ************************************************************************************************/

  recordScanError_: function(
    jobId,
    error,
    context
  ) {

    this.updateResult_(
      jobId,
      function(result) {

        result.counters.errors++;


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
            GDM_Utils.errorToObject(
              error,
              context ||
              {}
            )
          );

        } else {

          result.truncated.errors =
            true;
        }


        result.updatedAt =
          GDM_Utils.nowIso();


        return result;
      }
    );
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
   * LECTURE RÉSULTAT
   ************************************************************************************************/

  readResult_: function(jobId) {

    return this.readChunked_(
      this.getResultKey_(
        jobId
      )
    );
  },


  /************************************************************************************************
   * ÉCRITURE RÉSULTAT
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
   * UPDATE RÉSULTAT SÉCURISÉ
   ************************************************************************************************/

  updateResult_: function(
    jobId,
    callback
  ) {

    if (
      typeof callback !==
      'function'
    ) {

      throw new Error(
        'GDM_Archive.updateResult_ : callback invalide.'
      );
    }


    return GDM_Utils.withScriptLock(
      function() {

        var key =
          GDM_Archive.getResultKey_(
            jobId
          );


        var result =
          GDM_Archive.readChunked_(
            key
          );


        if (!result) {

          throw new Error(
            'Résultat Archive introuvable : ' +
            jobId
          );
        }


        result =
          callback(
            result
          ) ||
          result;


        GDM_Archive.writeChunkedUnlocked_(
          key,
          result
        );


        return GDM_Archive.clone_(
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

        return GDM_Archive.writeChunkedUnlocked_(
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
        'Résultat Archive trop volumineux pour PropertiesService.'
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
      old <
        previousCount;
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
   * SUPPRIMER LE RÉSULTAT TECHNIQUE
   ************************************************************************************************/

  deleteResult: function(jobId) {

    return this.deleteChunked_(
      this.getResultKey_(
        jobId
      )
    );
  },


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


  getLastUpdated_: function(file) {

    try {

      return file.getLastUpdated();

    } catch (ignored) {

      return null;
    }
  },


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

      var filters =
        this.normalizeFilters_({

          extensions: [
            '.PDF',
            'xlsx'
          ],

          olderThanDays:
            365,

          minSizeMB:
            1
        });


      if (
        filters.extensions.indexOf(
          'pdf'
        ) === -1
      ) {

        errors.push(
          'Normalisation des extensions incorrecte.'
        );
      }


      if (
        filters.olderThanDays !==
        365
      ) {

        errors.push(
          'olderThanDays incorrect.'
        );
      }


      if (
        filters.minSize !==
        1048576
      ) {

        errors.push(
          'Conversion minSizeMB incorrecte.'
        );
      }

    } catch (error1) {

      errors.push(
        'Erreur filtres Archive : ' +
        GDM_Utils.getErrorMessage(
          error1
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

    } catch (error2) {

      errors.push(
        'Erreur Google Drive : ' +
        GDM_Utils.getErrorMessage(
          error2
        )
      );
    }


    return {

      ok:
        errors.length === 0,

      file:
        'Modules/Archive.gs',

      version:
        GDM_APP.VERSION,

      action:
        'MOVE_TO_ARCHIVE',

      deletesFiles:
        false,

      errors:
        errors
    };
  }

});


/**************************************************************************************************
 * API GLOBALE POUR L'INTERFACE
 **************************************************************************************************/

function GDM_apiGetArchiveResult(jobId) {

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
      GDM_Archive.getResult(
        jobId
      )
  };
}