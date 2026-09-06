/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/FolderTools.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Outils de gestion des dossiers Google Drive.
 *
 * CE MODULE GÈRE
 * --------------
 * - création d'un dossier ;
 * - création d'une arborescence ;
 * - création de plusieurs chemins de dossiers ;
 * - déplacement d'un dossier ;
 * - renommage d'un dossier ;
 * - détection des dossiers vides ;
 * - vérification des déplacements ;
 * - prévention des boucles ;
 * - prévention du déplacement dans soi-même ;
 * - prévention du déplacement dans un descendant ;
 * - récupération d'informations sur un dossier.
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
 * - Aucun dossier n'est supprimé.
 * - Mon Drive ne peut pas être renommé ou déplacé.
 * - Un dossier ne peut pas être déplacé dans lui-même.
 * - Un dossier ne peut pas être déplacé dans l'un de ses descendants.
 **************************************************************************************************/

'use strict';


const GDM_FolderTools = Object.freeze({


  /************************************************************************************************
   * TYPES D'ACTIONS INTERNES
   ************************************************************************************************/

  ACTION_FIND_EMPTY_: 'FIND_EMPTY_FOLDERS',

  ACTION_FOLDER_INFO_: 'FOLDER_INFO',


  /************************************************************************************************
   * ROUTEUR PRINCIPAL
   *
   * Utilisé par Core/Main.gs :
   *
   * GDM_FolderTools.execute(action, options)
   ************************************************************************************************/

  execute: function(action, options) {

    action =
      GDM_Utils
        .trim(
          action
        )
        .toUpperCase();


    options =
      options ||
      {};


    switch (action) {


      /********************************************************************************************
       * CRÉER DOSSIER
       ********************************************************************************************/

      case GDM_ACTIONS.CREATE_FOLDER:

      case 'CREATE_FOLDER':

        return this.createFolder(
          options
        );


      /********************************************************************************************
       * CRÉER ARBORESCENCE
       ********************************************************************************************/

      case GDM_ACTIONS.CREATE_FOLDER_TREE:

      case 'CREATE_FOLDER_TREE':

        return this.createFolderTree(
          options
        );


      /********************************************************************************************
       * DÉPLACER DOSSIER
       ********************************************************************************************/

      case GDM_ACTIONS.MOVE_FOLDER:

      case 'MOVE_FOLDER':

        return this.moveFolder(
          options
        );


      /********************************************************************************************
       * RENOMMER DOSSIER
       ********************************************************************************************/

      case GDM_ACTIONS.RENAME_FOLDER:

      case 'RENAME_FOLDER':

        return this.renameFolder(
          options
        );


      /********************************************************************************************
       * DOSSIERS VIDES
       ********************************************************************************************/

      case this.ACTION_FIND_EMPTY_:

      case 'EMPTY_FOLDERS':

      case 'FIND_EMPTY':

        return this.findEmptyFolders(
          options
        );


      /********************************************************************************************
       * INFORMATIONS
       ********************************************************************************************/

      case this.ACTION_FOLDER_INFO_:

      case 'INFO':

        return this.getFolderInfo(
          options.folderId
        );


      default:

        throw new Error(
          'FolderTools : action inconnue : ' +
          action
        );
    }
  },


  /************************************************************************************************
   * PROCESS TASK
   *
   * Permet également à Engine.gs d'utiliser FolderTools si nécessaire.
   ************************************************************************************************/

  processTask: function(task, context) {

    task =
      task ||
      {};


    context =
      context ||
      {};


    var payload =
      task.payload ||
      {};


    switch (
      task.action
    ) {


      case GDM_ACTIONS.CREATE_FOLDER:

        return {

          ok:
            true,

          skipped:
            false,

          message:
            'Dossier créé.',

          data:
            this.createFolder(
              payload
            )
        };


      case GDM_ACTIONS.CREATE_FOLDER_TREE:

        return {

          ok:
            true,

          skipped:
            false,

          message:
            'Arborescence créée.',

          data:
            this.createFolderTree(
              payload
            )
        };


      case GDM_ACTIONS.MOVE_FOLDER:

        return {

          ok:
            true,

          skipped:
            false,

          message:
            'Dossier déplacé.',

          data:
            this.moveFolder(
              payload
            )
        };


      case GDM_ACTIONS.RENAME_FOLDER:

        return {

          ok:
            true,

          skipped:
            false,

          message:
            'Dossier renommé.',

          data:
            this.renameFolder(
              payload
            )
        };


      default:

        throw new Error(
          'FolderTools.processTask : action inconnue : ' +
          GDM_Utils.toString(
            task.action
          )
        );
    }
  },


  /************************************************************************************************
   * CRÉER UN DOSSIER
   ************************************************************************************************/

  createFolder: function(options) {

    options =
      options ||
      {};


    var parentFolder =
      GDM_Utils.getFolderOrRoot(
        options.parentFolderId ||
        options.folderId ||
        ''
      );


    var folderName =
      GDM_Utils.sanitizeFolderName(
        GDM_Utils.requireString(
          options.name ||
          options.folderName,
          'folderName'
        )
      );


    var reuseExisting =
      typeof options.reuseExisting ===
        'undefined'
        ? true
        : GDM_Utils.toBoolean(
            options.reuseExisting,
            true
          );


    /**********************************************************************************************
     * DOSSIER EXISTANT
     **********************************************************************************************/

    var existing =
      parentFolder.getFoldersByName(
        folderName
      );


    if (
      existing.hasNext()
    ) {

      var existingFolder =
        existing.next();


      if (
        reuseExisting
      ) {

        return {

          ok:
            true,

          created:
            false,

          reused:
            true,

          folder:
            this.folderToObject_(
              existingFolder
            )
        };
      }


      folderName =
        this.buildUniqueFolderName_(
          parentFolder,
          folderName
        );
    }


    /**********************************************************************************************
     * CRÉATION
     **********************************************************************************************/

    var folder =
      parentFolder.createFolder(
        folderName
      );


    try {

      GDM_Logger.info(
        'Dossier créé : ' +
        folderName,
        {

          module:
            GDM_MODULES.FOLDER_TOOLS,

          action:
            GDM_ACTIONS.CREATE_FOLDER,

          itemId:
            folder.getId(),

          itemName:
            folderName,

          data: {

            parentFolderId:
              parentFolder.getId()
          }
        }
      );

    } catch (ignored) {}


    return {

      ok:
        true,

      created:
        true,

      reused:
        false,

      folder:
        this.folderToObject_(
          folder
        )
    };
  },


  /************************************************************************************************
   * CRÉER UNE ARBORESCENCE
   *
   * FORMATS ACCEPTÉS
   * ----------------
   *
   * 1) Un seul chemin :
   *
   * {
   *   parentFolderId: "...",
   *   path: "Clients/2026/Factures"
   * }
   *
   * 2) Plusieurs chemins :
   *
   * {
   *   parentFolderId: "...",
   *   paths: [
   *     "Clients/2026/Factures",
   *     "Clients/2026/Devis",
   *     "Chantiers/Photos"
   *   ]
   * }
   ************************************************************************************************/

  createFolderTree: function(options) {

    options =
      options ||
      {};


    var parentFolder =
      GDM_Utils.getFolderOrRoot(
        options.parentFolderId ||
        options.folderId ||
        ''
      );


    var paths = [];


    if (
      options.path
    ) {

      paths.push(
        options.path
      );
    }


    if (
      Array.isArray(
        options.paths
      )
    ) {

      for (
        var p = 0;
        p < options.paths.length;
        p++
      ) {

        paths.push(
          options.paths[p]
        );
      }
    }


    paths =
      GDM_Utils.uniqueStrings(
        paths,
        false
      );


    if (
      !paths.length
    ) {

      throw new Error(
        'Aucun chemin de dossier fourni.'
      );
    }


    var maxFolders =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'FOLDER_TOOLS.MAX_FOLDERS_PER_OPERATION',
          1000
        ),
        1000
      );


    var created = [];

    var reused = [];

    var finalFolders = [];

    var processedFolders = 0;


    /**********************************************************************************************
     * CHAQUE CHEMIN
     **********************************************************************************************/

    for (
      var i = 0;
      i < paths.length;
      i++
    ) {

      var parts =
        this.normalizePath_(
          paths[i]
        );


      if (
        !parts.length
      ) {

        continue;
      }


      var current =
        parentFolder;


      for (
        var j = 0;
        j < parts.length;
        j++
      ) {

        processedFolders++;


        if (
          processedFolders >
          maxFolders
        ) {

          throw new Error(
            'Limite de création d’arborescence atteinte : ' +
            maxFolders +
            ' dossiers maximum par opération.'
          );
        }


        var folderName =
          GDM_Utils.sanitizeFolderName(
            parts[j]
          );


        var iterator =
          current.getFoldersByName(
            folderName
          );


        if (
          iterator.hasNext()
        ) {

          current =
            iterator.next();


          reused.push({

            id:
              current.getId(),

            name:
              current.getName()
          });


        } else {

          current =
            current.createFolder(
              folderName
            );


          created.push({

            id:
              current.getId(),

            name:
              current.getName(),

            parentId:
              this.getFirstParentId_(
                current
              )
          });
        }
      }


      finalFolders.push(
        this.folderToObject_(
          current
        )
      );
    }


    return {

      ok:
        true,

      root: {

        id:
          parentFolder.getId(),

        name:
          this.getDisplayName_(
            parentFolder
          )
      },

      requestedPaths:
        paths,

      createdCount:
        created.length,

      reusedCount:
        reused.length,

      created:
        created,

      reused:
        reused,

      finalFolders:
        finalFolders
    };
  },


  /************************************************************************************************
   * DÉPLACER UN DOSSIER
   ************************************************************************************************/

  moveFolder: function(options) {

    options =
      options ||
      {};


    var folderId =
      GDM_Utils.requireFolderId(
        options.folderId ||
        options.sourceFolderId,
        'folderId'
      );


    var destinationFolderId =
      GDM_Utils.requireFolderId(
        options.destinationFolderId,
        'destinationFolderId'
      );


    var validation =
      this.validateMove(
        folderId,
        destinationFolderId
      );


    if (
      !validation.ok
    ) {

      throw new Error(
        validation.message
      );
    }


    var folder =
      DriveApp.getFolderById(
        folderId
      );


    var destinationFolder =
      DriveApp.getFolderById(
        destinationFolderId
      );


    var oldParent =
      GDM_Utils.getFirstParentInfo(
        folder
      );


    /**********************************************************************************************
     * DÉJÀ AU BON ENDROIT
     **********************************************************************************************/

    if (
      oldParent.id ===
      destinationFolderId
    ) {

      return {

        ok:
          true,

        moved:
          false,

        skipped:
          true,

        message:
          'Le dossier se trouve déjà dans cette destination.',

        folder:
          this.folderToObject_(
            folder
          )
      };
    }


    /**********************************************************************************************
     * CONFLIT NOM
     **********************************************************************************************/

    var preventConflict =
      typeof options.preventConflict ===
        'undefined'
        ? true
        : GDM_Utils.toBoolean(
            options.preventConflict,
            true
          );


    if (
      preventConflict &&
      this.folderNameConflict_(
        destinationFolder,
        folder.getName(),
        folderId
      )
    ) {

      throw new Error(
        'Un dossier nommé "' +
        folder.getName() +
        '" existe déjà dans la destination.'
      );
    }


    /**********************************************************************************************
     * DÉPLACEMENT
     **********************************************************************************************/

    folder.moveTo(
      destinationFolder
    );


    try {

      GDM_Logger.info(
        'Dossier déplacé : ' +
        folder.getName(),
        {

          module:
            GDM_MODULES.FOLDER_TOOLS,

          action:
            GDM_ACTIONS.MOVE_FOLDER,

          itemId:
            folderId,

          itemName:
            folder.getName(),

          data: {

            oldParentId:
              oldParent.id,

            destinationFolderId:
              destinationFolderId
          }
        }
      );

    } catch (ignored) {}


    return {

      ok:
        true,

      moved:
        true,

      folderId:
        folderId,

      folderName:
        folder.getName(),

      oldParent: {

        id:
          oldParent.id,

        name:
          oldParent.name
      },

      destination: {

        id:
          destinationFolder.getId(),

        name:
          destinationFolder.getName()
      }
    };
  },


  /************************************************************************************************
   * VALIDATION DÉPLACEMENT
   ************************************************************************************************/

  validateMove: function(
    folderId,
    destinationFolderId
  ) {

    folderId =
      GDM_Utils.trim(
        folderId
      );


    destinationFolderId =
      GDM_Utils.trim(
        destinationFolderId
      );


    if (
      !folderId ||
      !destinationFolderId
    ) {

      return {

        ok:
          false,

        code:
          'MISSING_ID',

        message:
          'Le dossier source et la destination sont obligatoires.'
      };
    }


    var rootId =
      DriveApp
        .getRootFolder()
        .getId();


    /**********************************************************************************************
     * MON DRIVE
     **********************************************************************************************/

    if (
      folderId ===
      rootId
    ) {

      return {

        ok:
          false,

        code:
          'ROOT_MOVE_FORBIDDEN',

        message:
          'Mon Drive ne peut pas être déplacé.'
      };
    }


    /**********************************************************************************************
     * SOI-MÊME
     **********************************************************************************************/

    if (
      GDM_Config.get(
        'FOLDER_TOOLS.PREVENT_MOVE_INTO_SELF',
        true
      ) &&
      folderId ===
      destinationFolderId
    ) {

      return {

        ok:
          false,

        code:
          'MOVE_INTO_SELF',

        message:
          'Un dossier ne peut pas être déplacé dans lui-même.'
      };
    }


    var folder =
      GDM_Utils.getFolderSafe(
        folderId
      );


    var destination =
      GDM_Utils.getFolderSafe(
        destinationFolderId
      );


    if (!folder) {

      return {

        ok:
          false,

        code:
          'SOURCE_NOT_FOUND',

        message:
          'Dossier source introuvable.'
      };
    }


    if (!destination) {

      return {

        ok:
          false,

        code:
          'DESTINATION_NOT_FOUND',

        message:
          'Dossier destination introuvable.'
      };
    }


    /**********************************************************************************************
     * DESCENDANT
     **********************************************************************************************/

    if (
      GDM_Config.get(
        'FOLDER_TOOLS.PREVENT_MOVE_INTO_DESCENDANT',
        true
      ) &&
      this.isDescendantOf_(
        destination,
        folderId
      )
    ) {

      return {

        ok:
          false,

        code:
          'MOVE_INTO_DESCENDANT',

        message:
          'Impossible de déplacer un dossier dans l’un de ses propres sous-dossiers.'
      };
    }


    return {

      ok:
        true,

      code:
        'OK',

      message:
        'Déplacement autorisé.'
    };
  },


  /************************************************************************************************
   * RENOMMER UN DOSSIER
   ************************************************************************************************/

  renameFolder: function(options) {

    options =
      options ||
      {};


    var folderId =
      GDM_Utils.requireFolderId(
        options.folderId,
        'folderId'
      );


    var rootId =
      DriveApp
        .getRootFolder()
        .getId();


    if (
      folderId ===
      rootId
    ) {

      throw new Error(
        'Mon Drive ne peut pas être renommé.'
      );
    }


    var folder =
      DriveApp.getFolderById(
        folderId
      );


    var oldName =
      folder.getName();


    var newName =
      GDM_Utils.sanitizeFolderName(
        GDM_Utils.requireString(
          options.newName ||
          options.name,
          'newName'
        )
      );


    if (
      oldName ===
      newName
    ) {

      return {

        ok:
          true,

        renamed:
          false,

        skipped:
          true,

        folderId:
          folderId,

        oldName:
          oldName,

        newName:
          newName,

        message:
          'Le nom est déjà identique.'
      };
    }


    /**********************************************************************************************
     * CONFLIT
     **********************************************************************************************/

    var parent =
      GDM_Utils.getFirstParentInfo(
        folder
      );


    if (
      parent.id &&
      this.folderNameConflict_(
        DriveApp.getFolderById(
          parent.id
        ),
        newName,
        folderId
      )
    ) {

      if (
        GDM_Utils.toBoolean(
          options.autoUniqueName,
          false
        )
      ) {

        newName =
          this.buildUniqueFolderName_(
            DriveApp.getFolderById(
              parent.id
            ),
            newName
          );

      } else {

        throw new Error(
          'Un dossier nommé "' +
          newName +
          '" existe déjà dans ce dossier parent.'
        );
      }
    }


    /**********************************************************************************************
     * RENOMMAGE
     **********************************************************************************************/

    folder.setName(
      newName
    );


    try {

      GDM_Logger.info(
        'Dossier renommé : ' +
        oldName +
        ' → ' +
        newName,
        {

          module:
            GDM_MODULES.FOLDER_TOOLS,

          action:
            GDM_ACTIONS.RENAME_FOLDER,

          itemId:
            folderId,

          itemName:
            newName
        }
      );

    } catch (ignored) {}


    return {

      ok:
        true,

      renamed:
        true,

      folderId:
        folderId,

      oldName:
        oldName,

      newName:
        newName,

      parentId:
        parent.id,

      parentName:
        parent.name
    };
  },


  /************************************************************************************************
   * TROUVER LES DOSSIERS VIDES
   *
   * Lecture seule.
   ************************************************************************************************/

  findEmptyFolders: function(options) {

    options =
      options ||
      {};


    var sourceFolder =
      GDM_Utils.getFolderOrRoot(
        options.folderId ||
        options.sourceFolderId ||
        ''
      );


    var recursive =
      typeof options.recursive ===
        'undefined'
        ? true
        : GDM_Utils.toBoolean(
            options.recursive,
            true
          );


    var maxResults =
      GDM_Utils.toPositiveInteger(
        options.limit,
        GDM_Config.get(
          'UI.RESULT_MAX_ROWS',
          5000
        )
      );


    var maxFolders =
      GDM_Utils.toPositiveInteger(
        options.maxScannedFolders,
        GDM_Config.get(
          'FOLDER_TOOLS.MAX_FOLDERS_PER_OPERATION',
          1000
        )
      );


    var includeSource =
      GDM_Utils.toBoolean(
        options.includeSource,
        false
      );


    var pending = [
      {
        folder:
          sourceFolder,

        depth:
          0
      }
    ];


    var emptyFolders = [];

    var scanned = 0;

    var truncated = false;


    while (
      pending.length
    ) {

      if (
        scanned >=
        maxFolders
      ) {

        truncated =
          true;

        break;
      }


      if (
        emptyFolders.length >=
        maxResults
      ) {

        truncated =
          true;

        break;
      }


      var currentEntry =
        pending.shift();


      var current =
        currentEntry.folder;


      scanned++;


      /********************************************************************************************
       * TEST VIDE
       ********************************************************************************************/

      var hasFile =
        current
          .getFiles()
          .hasNext();


      var foldersIterator =
        current.getFolders();


      var children = [];


      while (
        foldersIterator.hasNext()
      ) {

        children.push(
          foldersIterator.next()
        );
      }


      var isEmpty =
        !hasFile &&
        children.length === 0;


      if (
        isEmpty &&
        (
          includeSource ||
          current.getId() !==
          sourceFolder.getId()
        )
      ) {

        emptyFolders.push({

          id:
            current.getId(),

          name:
            this.getDisplayName_(
              current
            ),

          depth:
            currentEntry.depth,

          parentId:
            this.getFirstParentId_(
              current
            ),

          url:
            GDM_Utils.getDriveFolderUrl(
              current.getId()
            )
        });
      }


      /********************************************************************************************
       * DESCENTE
       ********************************************************************************************/

      if (recursive) {

        for (
          var c = 0;
          c < children.length;
          c++
        ) {

          pending.push({

            folder:
              children[c],

            depth:
              currentEntry.depth + 1
          });
        }
      }
    }


    return {

      ok:
        true,

      source: {

        id:
          sourceFolder.getId(),

        name:
          this.getDisplayName_(
            sourceFolder
          )
      },

      recursive:
        recursive,

      scannedFolders:
        scanned,

      emptyCount:
        emptyFolders.length,

      truncated:
        truncated,

      folders:
        emptyFolders
    };
  },


  /************************************************************************************************
   * INFORMATIONS DOSSIER
   ************************************************************************************************/

  getFolderInfo: function(folderId) {

    var folder =
      GDM_Utils.getFolderOrRoot(
        folderId
      );


    var rootId =
      DriveApp
        .getRootFolder()
        .getId();


    var parent =
      GDM_Utils.getFirstParentInfo(
        folder
      );


    var fileCount = 0;

    var folderCount = 0;


    var files =
      folder.getFiles();


    while (
      files.hasNext()
    ) {

      files.next();

      fileCount++;
    }


    var folders =
      folder.getFolders();


    while (
      folders.hasNext()
    ) {

      folders.next();

      folderCount++;
    }


    return {

      ok:
        true,

      folder: {

        id:
          folder.getId(),

        name:
          this.getDisplayName_(
            folder
          ),

        url:
          GDM_Utils.getDriveFolderUrl(
            folder.getId()
          ),

        isRoot:
          folder.getId() ===
          rootId,

        parentId:
          parent.id,

        parentName:
          parent.name,

        directFiles:
          fileCount,

        directFolders:
          folderCount,

        directItems:
          fileCount +
          folderCount,

        empty:
          fileCount === 0 &&
          folderCount === 0
      }
    };
  },


  /************************************************************************************************
   * CRÉER UN CHEMIN UNIQUE
   ************************************************************************************************/

  createPath: function(
    parentFolderId,
    path
  ) {

    return this.createFolderTree({

      parentFolderId:
        parentFolderId,

      path:
        path
    });
  },


  /************************************************************************************************
   * RÉCUPÉRER / CRÉER UN SOUS-DOSSIER
   ************************************************************************************************/

  getOrCreateFolder: function(
    parentFolderId,
    folderName
  ) {

    var result =
      this.createFolder({

        parentFolderId:
          parentFolderId,

        folderName:
          folderName,

        reuseExisting:
          true
      });


    return result.folder;
  },


  /************************************************************************************************
   * VÉRIFIER SI UN DOSSIER EST DESCENDANT
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
   * CONFLIT DE NOM
   ************************************************************************************************/

  folderNameConflict_: function(
    parentFolder,
    requestedName,
    currentFolderId
  ) {

    var iterator =
      parentFolder.getFoldersByName(
        requestedName
      );


    while (
      iterator.hasNext()
    ) {

      var folder =
        iterator.next();


      if (
        !currentFolderId ||
        folder.getId() !==
        currentFolderId
      ) {

        return true;
      }
    }


    return false;
  },


  /************************************************************************************************
   * NOM DE DOSSIER UNIQUE
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
      !this.folderNameConflict_(
        parentFolder,
        requestedName,
        ''
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
        !this.folderNameConflict_(
          parentFolder,
          candidate,
          ''
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
   * NORMALISER UN CHEMIN
   ************************************************************************************************/

  normalizePath_: function(path) {

    path =
      GDM_Utils.toString(
        path
      );


    path =
      path.replace(
        /\\/g,
        '/'
      );


    var raw =
      path.split(
        '/'
      );


    var parts = [];


    for (
      var i = 0;
      i < raw.length;
      i++
    ) {

      var part =
        GDM_Utils.normalizeWhitespace(
          raw[i]
        );


      if (!part) {

        continue;
      }


      parts.push(
        part
      );
    }


    var maxDepth =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'FOLDER_TOOLS.MAX_TREE_DEPTH',
          50
        ),
        50
      );


    if (
      parts.length >
      maxDepth
    ) {

      throw new Error(
        'Arborescence trop profonde : ' +
        parts.length +
        ' niveaux. Maximum autorisé : ' +
        maxDepth +
        '.'
      );
    }


    return parts;
  },


  /************************************************************************************************
   * CONVERTIR DOSSIER EN OBJET
   ************************************************************************************************/

  folderToObject_: function(folder) {

    if (!folder) {

      return null;
    }


    var parent =
      GDM_Utils.getFirstParentInfo(
        folder
      );


    return {

      id:
        folder.getId(),

      name:
        this.getDisplayName_(
          folder
        ),

      url:
        GDM_Utils.getDriveFolderUrl(
          folder.getId()
        ),

      parentId:
        parent.id,

      parentName:
        parent.name
    };
  },


  /************************************************************************************************
   * NOM AFFICHÉ
   ************************************************************************************************/

  getDisplayName_: function(folder) {

    var rootId =
      DriveApp
        .getRootFolder()
        .getId();


    if (
      folder.getId() ===
      rootId
    ) {

      return GDM_Config.get(
        'APP.ROOT_LABEL',
        'Mon Drive'
      );
    }


    return folder.getName();
  },


  /************************************************************************************************
   * PARENT ID
   ************************************************************************************************/

  getFirstParentId_: function(folder) {

    var parent =
      GDM_Utils.getFirstParentInfo(
        folder
      );


    return parent.id ||
      '';
  },


  /************************************************************************************************
   * VALIDATION MODULE
   ************************************************************************************************/

  validate: function() {

    var errors = [];


    /**********************************************************************************************
     * ACCÈS ROOT
     **********************************************************************************************/

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
        'Erreur Google Drive : ' +
        GDM_Utils.getErrorMessage(
          error1
        )
      );
    }


    /**********************************************************************************************
     * NORMALISATION PATH
     **********************************************************************************************/

    try {

      var parts =
        this.normalizePath_(
          'Clients/2026/Factures'
        );


      if (
        parts.length !== 3
      ) {

        errors.push(
          'normalizePath_() retourne un résultat incorrect.'
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur normalizePath_() : ' +
        GDM_Utils.getErrorMessage(
          error2
        )
      );
    }


    /**********************************************************************************************
     * VALIDATION AUTO-MOVE
     **********************************************************************************************/

    try {

      var rootId =
        DriveApp
          .getRootFolder()
          .getId();


      var validation =
        this.validateMove(
          rootId,
          rootId
        );


      if (
        validation.ok !==
        false
      ) {

        errors.push(
          'La protection de Mon Drive ne fonctionne pas.'
        );
      }

    } catch (error3) {

      errors.push(
        'Erreur validateMove() : ' +
        GDM_Utils.getErrorMessage(
          error3
        )
      );
    }


    return {

      ok:
        errors.length === 0,

      file:
        'Modules/FolderTools.gs',

      version:
        GDM_APP.VERSION,

      deletesFiles:
        false,

      deletesFolders:
        false,

      protections: {

        preventMoveIntoSelf:
          GDM_Config.get(
            'FOLDER_TOOLS.PREVENT_MOVE_INTO_SELF',
            true
          ),

        preventMoveIntoDescendant:
          GDM_Config.get(
            'FOLDER_TOOLS.PREVENT_MOVE_INTO_DESCENDANT',
            true
          ),

        detectMoveLoops:
          GDM_Config.get(
            'FOLDER_TOOLS.DETECT_MOVE_LOOPS',
            true
          )
      },

      errors:
        errors
    };
  }

});