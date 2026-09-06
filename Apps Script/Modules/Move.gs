/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Move.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Déplacement et classement progressif de fichiers dans Google Drive.
 *
 * Ce module gère :
 * - déplacement de fichiers vers un dossier ;
 * - classement automatique par type / extension ;
 * - filtres par extension ;
 * - filtres par type MIME ;
 * - filtre sur le nom ;
 * - filtres de taille ;
 * - analyse récursive des sous-dossiers ;
 * - aperçu avant déplacement ;
 * - création automatique des dossiers de classement ;
 * - gestion des conflits ;
 * - traitement progressif par Queue + Engine ;
 * - reprise automatique après interruption Apps Script.
 *
 * CONCEPTION GROS DRIVE
 * ---------------------
 * Les dossiers sont parcourus progressivement.
 *
 * Une tâche CLASSIFY_FILE avec payload.operation = SCAN_FOLDER
 * explore un dossier et ajoute :
 *
 * - de nouvelles tâches SCAN_FOLDER pour les sous-dossiers ;
 * - des tâches MOVE_FILE pour les fichiers correspondants.
 *
 * Aucun tableau contenant l'intégralité du Drive n'est créé.
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
 * - Aucun fichier n'est supprimé.
 * - La source et la destination doivent être différentes.
 * - Le dossier destination est ignoré pendant un scan récursif.
 * - Les fichiers déjà présents dans la destination peuvent être ignorés.
 **************************************************************************************************/

'use strict';


const GDM_Move = Object.freeze({


  /************************************************************************************************
   * MODES
   ************************************************************************************************/

  MODE_MOVE_: 'MOVE',

  MODE_CLASSIFY_: 'CLASSIFY',


  /************************************************************************************************
   * OPÉRATIONS INTERNES
   ************************************************************************************************/

  OP_SCAN_FOLDER_: 'SCAN_FOLDER',

  OP_MOVE_FILE_: 'MOVE_FILE',


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


    /**********************************************************************************************
     * MODE
     **********************************************************************************************/

    var mode =
      GDM_Utils.trim(
        options.mode
      ).toUpperCase();


    if (
      !mode
    ) {

      mode =
        GDM_Utils.toBoolean(
          options.classifyByType,
          false
        )
          ? this.MODE_CLASSIFY_
          : this.MODE_MOVE_;
    }


    if (
      mode !==
        this.MODE_MOVE_ &&
      mode !==
        this.MODE_CLASSIFY_
    ) {

      throw new Error(
        'Mode de déplacement invalide : ' +
        mode
      );
    }


    /**********************************************************************************************
     * PARAMÈTRES
     **********************************************************************************************/

    var recursive =
      typeof options.recursive ===
        'undefined'
        ? GDM_Config.get(
            'MOVE.INCLUDE_SUBFOLDERS_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.recursive,
            true
          );


    var filters =
      this.normalizeFilters_(
        options.filters ||
        options
      );


    var createDestinationFolders =
      typeof options.createDestinationFolders ===
        'undefined'
        ? GDM_Config.get(
            'MOVE.CREATE_DESTINATION_FOLDERS',
            true
          )
        : GDM_Utils.toBoolean(
            options.createDestinationFolders,
            true
          );


    /**********************************************************************************************
     * JOB
     **********************************************************************************************/

    var state =
      GDM_State.create({
        module:
          GDM_MODULES.MOVE,

        action:
          mode ===
            this.MODE_CLASSIFY_
              ? GDM_ACTIONS.CLASSIFY_FILE
              : GDM_ACTIONS.MOVE_FILE,

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
          mode:
            mode,

          recursive:
            recursive,

          filters:
            filters,

          createDestinationFolders:
            createDestinationFolders
        },

        totalKnown:
          1,

        setCurrent:
          true,

        message:
          'Déplacement préparé.'
      });


    var jobId =
      state.jobId;


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
          GDM_MODULES.MOVE,

        action:
          GDM_ACTIONS.CLASSIFY_FILE,

        itemId:
          sourceFolderId,

        itemName:
          sourceFolder.getName(),

        payload: {
          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            sourceFolderId,

          destinationFolderId:
            destinationFolderId,

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
        'Déplacement préparé.',
        {
          jobId:
            jobId,

          module:
            GDM_MODULES.MOVE,

          action:
            state.action,

          data: {
            sourceFolderId:
              sourceFolderId,

            destinationFolderId:
              destinationFolderId,

            mode:
              mode,

            recursive:
              recursive
          }
        }
      );

    } catch (ignored) {}


    /**********************************************************************************************
     * ENGINE
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

      mode:
        mode,

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

      filters:
        filters,

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
   * APERÇU
   *
   * Lecture seule.
   *
   * L'aperçu est volontairement limité afin de ne pas saturer la mémoire.
   ************************************************************************************************/

  preview: function(options) {

    options = options || {};


    var sourceFolder =
      GDM_Utils.getFolderOrRoot(
        options.sourceFolderId ||
        options.folderId ||
        ''
      );


    var destinationFolderId =
      GDM_Utils.requireFolderId(
        options.destinationFolderId,
        'destinationFolderId'
      );


    if (
      sourceFolder.getId() ===
      destinationFolderId
    ) {

      throw new Error(
        'Le dossier source et la destination doivent être différents.'
      );
    }


    var destinationFolder =
      DriveApp.getFolderById(
        destinationFolderId
      );


    var mode =
      GDM_Utils.trim(
        options.mode
      ).toUpperCase();


    if (!mode) {

      mode =
        GDM_Utils.toBoolean(
          options.classifyByType,
          false
        )
          ? this.MODE_CLASSIFY_
          : this.MODE_MOVE_;
    }


    var recursive =
      typeof options.recursive ===
        'undefined'
        ? GDM_Config.get(
            'MOVE.INCLUDE_SUBFOLDERS_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.recursive,
            true
          );


    var filters =
      this.normalizeFilters_(
        options.filters ||
        options
      );


    var maxRows =
      GDM_Utils.toPositiveInteger(
        options.limit,
        GDM_Config.get(
          'MOVE.PREVIEW_MAX_ROWS',
          2000
        )
      );


    var maxScanned =
      GDM_Utils.toPositiveInteger(
        options.maxScanned,
        GDM_Config.get(
          'MOVE.MAX_SCANNED_PER_RUN',
          5000
        )
      );


    var result = [];

    var foldersToScan = [
      sourceFolder
    ];


    var scanned = 0;

    var matched = 0;

    var truncated = false;


    while (
      foldersToScan.length &&
      scanned < maxScanned &&
      result.length < maxRows
    ) {

      var folder =
        foldersToScan.shift();


      /*
       * Ne jamais scanner la destination si elle se trouve dans la source.
       */
      if (
        folder.getId() ===
        destinationFolderId
      ) {
        continue;
      }


      var files =
        folder.getFiles();


      while (
        files.hasNext()
      ) {

        if (
          scanned >=
            maxScanned ||
          result.length >=
            maxRows
        ) {

          truncated =
            true;

          break;
        }


        var file =
          files.next();


        scanned++;


        if (
          !this.matchesFile_(
            file,
            filters
          )
        ) {
          continue;
        }


        matched++;


        var destination =
          this.resolveDestinationInfo_(
            file,
            destinationFolder,
            mode
          );


        result.push({
          fileId:
            file.getId(),

          fileName:
            file.getName(),

          extension:
            GDM_Utils.getExtension(
              file.getName()
            ),

          mimeType:
            file.getMimeType(),

          size:
            this.getFileSize_(
              file
            ),

          sizeFormatted:
            GDM_Utils.formatBytes(
              this.getFileSize_(
                file
              )
            ),

          sourceFolderId:
            folder.getId(),

          sourceFolderName:
            folder.getName(),

          destinationFolderId:
            destination.id,

          destinationFolderName:
            destination.name,

          category:
            destination.category,

          alreadyInDestination:
            this.fileHasParent_(
              file,
              destination.id
            )
        });
      }


      if (
        recursive &&
        result.length < maxRows &&
        scanned < maxScanned
      ) {

        var folders =
          folder.getFolders();


        while (
          folders.hasNext()
        ) {

          var child =
            folders.next();


          if (
            child.getId() ===
            destinationFolderId
          ) {
            continue;
          }


          foldersToScan.push(
            child
          );
        }
      }
    }


    if (
      foldersToScan.length ||
      scanned >= maxScanned ||
      result.length >= maxRows
    ) {

      truncated =
        true;
    }


    return {
      ok: true,

      mode:
        mode,

      source: {
        id:
          sourceFolder.getId(),

        name:
          sourceFolder.getName()
      },

      destination: {
        id:
          destinationFolderId,

        name:
          destinationFolder.getName()
      },

      filters:
        filters,

      recursive:
        recursive,

      scanned:
        scanned,

      matched:
        matched,

      returned:
        result.length,

      truncated:
        truncated,

      rows:
        result
    };
  },


  /************************************************************************************************
   * PROCESS TASK
   ************************************************************************************************/

  processTask: function(
    task,
    context
  ) {

    task =
      task || {};

    context =
      context || {};


    var operation =
      task.payload &&
      task.payload.operation
        ? task.payload.operation
        : '';


    if (
      task.action ===
        GDM_ACTIONS.CLASSIFY_FILE &&
      operation ===
        this.OP_SCAN_FOLDER_
    ) {

      return this.processScanFolder_(
        task,
        context
      );
    }


    if (
      task.action ===
        GDM_ACTIONS.MOVE_FILE ||
      operation ===
        this.OP_MOVE_FILE_
    ) {

      return this.processMoveFile_(
        task,
        context
      );
    }


    throw new Error(
      'Move : tâche inconnue : ' +
      GDM_Utils.toString(
        task.action
      ) +
      ' / ' +
      GDM_Utils.toString(
        operation
      )
    );
  },


  /************************************************************************************************
   * SCAN D'UN DOSSIER
   ************************************************************************************************/

  processScanFolder_: function(
    task,
    context
  ) {

    var jobId =
      task.jobId ||
      context.jobId;


    var state =
      GDM_State.require(
        jobId
      );


    var parameters =
      state.parameters ||
      {};


    var payload =
      task.payload ||
      {};


    var folderId =
      GDM_Utils.requireFolderId(
        payload.folderId ||
        task.itemId,
        'folderId'
      );


    var destinationFolderId =
      GDM_Utils.requireFolderId(
        payload.destinationFolderId ||
        (
          state.destination &&
          state.destination.id
        ),
        'destinationFolderId'
      );


    /*
     * Le dossier de destination est ignoré lors d'un scan récursif.
     */
    if (
      folderId ===
      destinationFolderId
    ) {

      return {
        ok: true,

        skipped: true,

        message:
          'Dossier destination ignoré pendant le scan.'
      };
    }


    var folder =
      DriveApp.getFolderById(
        folderId
      );


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


    var filters =
      this.normalizeFilters_(
        parameters.filters ||
        {}
      );


    var newTasks = [];

    var scannedFiles = 0;

    var matchedFiles = 0;

    var childFolders = 0;


    /**********************************************************************************************
     * FICHIERS
     **********************************************************************************************/

    var files =
      folder.getFiles();


    while (
      files.hasNext()
    ) {

      var file =
        files.next();


      scannedFiles++;


      if (
        !this.matchesFile_(
          file,
          filters
        )
      ) {
        continue;
      }


      matchedFiles++;


      newTasks.push({
        module:
          GDM_MODULES.MOVE,

        action:
          GDM_ACTIONS.MOVE_FILE,

        itemId:
          file.getId(),

        itemName:
          file.getName(),

        payload: {
          operation:
            this.OP_MOVE_FILE_,

          fileId:
            file.getId(),

          sourceFolderId:
            folderId,

          destinationFolderId:
            destinationFolderId
        }
      });
    }


    /**********************************************************************************************
     * SOUS-DOSSIERS
     **********************************************************************************************/

    if (recursive) {

      var folders =
        folder.getFolders();


      while (
        folders.hasNext()
      ) {

        var child =
          folders.next();


        if (
          child.getId() ===
          destinationFolderId
        ) {
          continue;
        }


        childFolders++;


        newTasks.push({
          module:
            GDM_MODULES.MOVE,

          action:
            GDM_ACTIONS.CLASSIFY_FILE,

          itemId:
            child.getId(),

          itemName:
            child.getName(),

          payload: {
            operation:
              this.OP_SCAN_FOLDER_,

            folderId:
              child.getId(),

            destinationFolderId:
              destinationFolderId,

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
     * AJOUT QUEUE
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


    return {
      ok: true,

      skipped: false,

      message:
        'Dossier analysé pour déplacement : ' +
        folder.getName(),

      data: {
        folderId:
          folderId,

        scannedFiles:
          scannedFiles,

        matchedFiles:
          matchedFiles,

        childFolders:
          childFolders,

        tasksAdded:
          newTasks.length
      }
    };
  },


  /************************************************************************************************
   * DÉPLACER UN FICHIER
   ************************************************************************************************/

  processMoveFile_: function(
    task,
    context
  ) {

    var jobId =
      task.jobId ||
      context.jobId;


    var state =
      GDM_State.require(
        jobId
      );


    var parameters =
      state.parameters ||
      {};


    var payload =
      task.payload ||
      {};


    var fileId =
      GDM_Utils.requireFileId(
        payload.fileId ||
        task.itemId,
        'fileId'
      );


    var destinationRootId =
      GDM_Utils.requireFolderId(
        payload.destinationFolderId ||
        (
          state.destination &&
          state.destination.id
        ),
        'destinationFolderId'
      );


    var file =
      DriveApp.getFileById(
        fileId
      );


    var destinationRoot =
      DriveApp.getFolderById(
        destinationRootId
      );


    var mode =
      GDM_Utils.trim(
        parameters.mode
      ).toUpperCase() ||
      this.MODE_MOVE_;


    var destination =
      this.resolveDestinationFolder_(
        file,
        destinationRoot,
        mode,
        GDM_Utils.toBoolean(
          parameters.createDestinationFolders,
          true
        )
      );


    /**********************************************************************************************
     * DÉJÀ DANS LA DESTINATION
     **********************************************************************************************/

    if (
      GDM_Config.get(
        'MOVE.SKIP_IF_ALREADY_IN_DESTINATION',
        true
      ) &&
      this.fileHasParent_(
        file,
        destination.getId()
      )
    ) {

      return {
        ok: true,

        skipped: true,

        message:
          'Fichier déjà présent dans la destination.',

        data: {
          fileId:
            fileId,

          destinationFolderId:
            destination.getId()
        }
      };
    }


    /**********************************************************************************************
     * DÉPLACEMENT
     **********************************************************************************************/

    var oldParent =
      GDM_Utils.getFirstParentInfo(
        file
      );


    file.moveTo(
      destination
    );


    return {
      ok: true,

      skipped: false,

      message:
        'Fichier déplacé : ' +
        file.getName(),

      data: {
        fileId:
          fileId,

        fileName:
          file.getName(),

        oldFolderId:
          oldParent.id,

        oldFolderName:
          oldParent.name,

        destinationFolderId:
          destination.getId(),

        destinationFolderName:
          destination.getName(),

        mode:
          mode
      }
    };
  },


  /************************************************************************************************
   * DESTINATION DU FICHIER
   ************************************************************************************************/

  resolveDestinationFolder_: function(
    file,
    destinationRoot,
    mode,
    createFolders
  ) {

    if (
      mode !==
      this.MODE_CLASSIFY_
    ) {

      return destinationRoot;
    }


    var extension =
      GDM_Utils.getExtension(
        file.getName()
      );


    var folderName =
      GDM_Config.getDestinationFolderByExtension(
        extension
      );


    /*
     * Google Workspace n'a parfois aucune extension.
     */
    if (
      !extension &&
      GDM_Utils.isGoogleMimeType(
        file.getMimeType()
      )
    ) {

      folderName =
        this.getGoogleWorkspaceFolderName_(
          file.getMimeType()
        );
    }


    var existing =
      destinationRoot.getFoldersByName(
        folderName
      );


    if (
      existing.hasNext()
    ) {

      return existing.next();
    }


    if (!createFolders) {

      return destinationRoot;
    }


    return destinationRoot.createFolder(
      folderName
    );
  },


  /************************************************************************************************
   * DESTINATION POUR APERÇU
   *
   * Ne crée aucun dossier.
   ************************************************************************************************/

  resolveDestinationInfo_: function(
    file,
    destinationRoot,
    mode
  ) {

    if (
      mode !==
      this.MODE_CLASSIFY_
    ) {

      return {
        id:
          destinationRoot.getId(),

        name:
          destinationRoot.getName(),

        category:
          'Destination'
      };
    }


    var extension =
      GDM_Utils.getExtension(
        file.getName()
      );


    var category =
      GDM_Config.getCategoryByExtension(
        extension
      );


    var folderName =
      category.FOLDER;


    if (
      !extension &&
      GDM_Utils.isGoogleMimeType(
        file.getMimeType()
      )
    ) {

      folderName =
        this.getGoogleWorkspaceFolderName_(
          file.getMimeType()
        );
    }


    var iterator =
      destinationRoot.getFoldersByName(
        folderName
      );


    if (
      iterator.hasNext()
    ) {

      var folder =
        iterator.next();


      return {
        id:
          folder.getId(),

        name:
          folder.getName(),

        category:
          category.LABEL
      };
    }


    return {
      id: '',

      name:
        folderName,

      category:
        category.LABEL,

      willBeCreated:
        true
    };
  },


  /************************************************************************************************
   * GOOGLE WORKSPACE
   ************************************************************************************************/

  getGoogleWorkspaceFolderName_: function(
    mimeType
  ) {

    switch (
      mimeType
    ) {

      case GDM_MIME.GOOGLE_DOC:
        return 'Google Docs';

      case GDM_MIME.GOOGLE_SHEET:
        return 'Google Sheets';

      case GDM_MIME.GOOGLE_SLIDE:
        return 'Google Slides';

      case GDM_MIME.GOOGLE_FORM:
        return 'Google Forms';

      case GDM_MIME.GOOGLE_DRAWING:
        return 'Google Drawings';

      default:
        return 'Google Workspace';
    }
  },


  /************************************************************************************************
   * FILTRES
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


    /*
     * Possibilité de fournir les tailles en Mo.
     */
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
        maxSize
    };
  },


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
      size <
        filters.minSize
    ) {

      return false;
    }


    /**********************************************************************************************
     * TAILLE MAX
     **********************************************************************************************/

    if (
      filters.maxSize > 0 &&
      size >
        filters.maxSize
    ) {

      return false;
    }


    return true;
  },


  /************************************************************************************************
   * PARENT
   ************************************************************************************************/

  fileHasParent_: function(
    file,
    folderId
  ) {

    folderId =
      GDM_Utils.trim(
        folderId
      );


    if (
      !file ||
      !folderId
    ) {

      return false;
    }


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
   * TAILLE
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
   * VALIDATION
   ************************************************************************************************/

  validate: function() {

    var errors = [];


    try {

      var filters =
        this.normalizeFilters_({
          extensions: [
            '.PDF',
            'jpg'
          ],

          nameContains:
            'facture',

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
        filters.minSize !==
        1048576
      ) {

        errors.push(
          'Conversion minSizeMB incorrecte.'
        );
      }

    } catch (error1) {

      errors.push(
        'Erreur filtres Move : ' +
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
        'Modules/Move.gs',

      version:
        GDM_APP.VERSION,

      destructive:
        false,

      deletesFiles:
        false,

      errors:
        errors
    };
  }

});