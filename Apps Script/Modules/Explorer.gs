/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Explorer.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Exploration et navigation dans Google Drive.
 *
 * Ce module gère :
 * - Mon Drive ;
 * - lecture d'un dossier ;
 * - liste des sous-dossiers ;
 * - liste des fichiers ;
 * - navigation parent / enfants ;
 * - fil d'Ariane ;
 * - informations détaillées d'un dossier ;
 * - vérification d'existence des fichiers et dossiers ;
 * - recherche d'un dossier enfant par nom ;
 * - conversion en objets sérialisables pour l'interface.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 *
 * IMPORTANT
 * ---------
 * - Module entièrement en lecture seule.
 * - Aucun déplacement.
 * - Aucune copie.
 * - Aucun renommage.
 * - Aucune suppression.
 * - Utilise principalement DriveApp pour une compatibilité maximale.
 **************************************************************************************************/

'use strict';


const GDM_Explorer = Object.freeze({


  /************************************************************************************************
   * MON DRIVE
   ************************************************************************************************/

  getRoot: function() {

    try {

      var root =
        DriveApp.getRootFolder();

      return {
        ok: true,

        folder:
          this.buildFolderObject_(
            root,
            true
          )
      };

    } catch (error) {

      GDM_Logger.error(
        error,
        {
          module:
            GDM_MODULES.EXPLORER,

          action:
            GDM_ACTIONS.GET_FOLDER_INFO
        }
      );

      return GDM_Utils.createErrorResult(
        error,
        {
          module:
            GDM_MODULES.EXPLORER,

          action:
            GDM_ACTIONS.GET_FOLDER_INFO
        }
      );
    }
  },


  /************************************************************************************************
   * DOSSIER
   ************************************************************************************************/

  getFolder: function(folderId) {

    try {

      var folder =
        GDM_Utils.getFolderOrRoot(
          folderId
        );

      return {
        ok: true,

        folder:
          this.buildFolderObject_(
            folder,
            true
          )
      };

    } catch (error) {

      return GDM_Utils.createErrorResult(
        error,
        {
          module:
            GDM_MODULES.EXPLORER,

          action:
            GDM_ACTIONS.GET_FOLDER_INFO,

          itemId:
            folderId
        }
      );
    }
  },


  /************************************************************************************************
   * INFORMATIONS DOSSIER
   ************************************************************************************************/

  getFolderInfo: function(folderId) {

    var folder =
      GDM_Utils.getFolderOrRoot(
        folderId
      );

    return this.buildFolderObject_(
      folder,
      true
    );
  },


  /************************************************************************************************
   * ENFANTS D'UN DOSSIER
   ************************************************************************************************/

  getChildren: function(
    folderId,
    options
  ) {

    options =
      options || {};

    var folder =
      GDM_Utils.getFolderOrRoot(
        folderId
      );

    var includeFolders =
      typeof options.includeFolders ===
        'undefined'
        ? GDM_Config.get(
            'EXPLORER.INCLUDE_FOLDERS_BY_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.includeFolders,
            true
          );

    var includeFiles =
      typeof options.includeFiles ===
        'undefined'
        ? GDM_Config.get(
            'EXPLORER.INCLUDE_FILES_BY_DEFAULT',
            true
          )
        : GDM_Utils.toBoolean(
            options.includeFiles,
            true
          );

    var maxFolders =
      GDM_Utils.toPositiveInteger(
        options.maxFolders,
        GDM_Config.get(
          'EXPLORER.MAX_FOLDERS_RETURNED',
          1000
        )
      );

    var maxFiles =
      GDM_Utils.toPositiveInteger(
        options.maxFiles,
        GDM_Config.get(
          'EXPLORER.MAX_FILES_RETURNED',
          1000
        )
      );

    var folders = [];
    var files = [];

    var foldersTruncated =
      false;

    var filesTruncated =
      false;


    /**********************************************************************************************
     * SOUS-DOSSIERS
     **********************************************************************************************/

    if (includeFolders) {

      var folderIterator =
        folder.getFolders();

      var folderCount = 0;

      while (
        folderIterator.hasNext()
      ) {

        if (
          folderCount >=
          maxFolders
        ) {
          foldersTruncated =
            true;

          break;
        }

        var childFolder =
          folderIterator.next();

        folders.push(
          this.buildFolderObject_(
            childFolder,
            false
          )
        );

        folderCount++;
      }

      if (
        GDM_Config.get(
          'EXPLORER.SORT_FOLDERS',
          true
        )
      ) {
        GDM_Utils.sortByName(
          folders
        );
      }
    }


    /**********************************************************************************************
     * FICHIERS
     **********************************************************************************************/

    if (includeFiles) {

      var fileIterator =
        folder.getFiles();

      var fileCount = 0;

      while (
        fileIterator.hasNext()
      ) {

        if (
          fileCount >=
          maxFiles
        ) {
          filesTruncated =
            true;

          break;
        }

        var file =
          fileIterator.next();

        files.push(
          this.buildFileObject_(
            file
          )
        );

        fileCount++;
      }

      if (
        GDM_Config.get(
          'EXPLORER.SORT_FILES',
          true
        )
      ) {
        GDM_Utils.sortByName(
          files
        );
      }
    }


    var current =
      this.buildFolderObject_(
        folder,
        true
      );

    return {
      ok: true,

      folder:
        current,

      folders:
        folders,

      files:
        files,

      counts: {
        folders:
          folders.length,

        files:
          files.length
      },

      truncated: {
        folders:
          foldersTruncated,

        files:
          filesTruncated
      }
    };
  },


  /************************************************************************************************
   * SOUS-DOSSIERS UNIQUEMENT
   ************************************************************************************************/

  getFolders: function(
    folderId,
    options
  ) {

    options =
      options || {};

    options.includeFolders =
      true;

    options.includeFiles =
      false;

    var result =
      this.getChildren(
        folderId,
        options
      );

    return result.folders || [];
  },


  /************************************************************************************************
   * FICHIERS UNIQUEMENT
   ************************************************************************************************/

  getFiles: function(
    folderId,
    options
  ) {

    options =
      options || {};

    options.includeFolders =
      false;

    options.includeFiles =
      true;

    var result =
      this.getChildren(
        folderId,
        options
      );

    return result.files || [];
  },


  /************************************************************************************************
   * DOSSIER PARENT
   ************************************************************************************************/

  getParent: function(folderId) {

    var folder =
      GDM_Utils.getFolderOrRoot(
        folderId
      );

    var root =
      DriveApp.getRootFolder();

    if (
      folder.getId() ===
      root.getId()
    ) {
      return null;
    }

    var parents =
      folder.getParents();

    if (
      !parents.hasNext()
    ) {
      return null;
    }

    return this.buildFolderObject_(
      parents.next(),
      false
    );
  },


  /************************************************************************************************
   * FIL D'ARIANE
   ************************************************************************************************/

  getBreadcrumb: function(
    folderId,
    maxDepth
  ) {

    var folder =
      GDM_Utils.getFolderOrRoot(
        folderId
      );

    maxDepth =
      GDM_Utils.toPositiveInteger(
        maxDepth,
        GDM_Config.get(
          'FOLDER_TOOLS.MAX_TREE_DEPTH',
          50
        )
      );

    var root =
      DriveApp.getRootFolder();

    var rootId =
      root.getId();

    var breadcrumb = [];

    var current =
      folder;

    var depth = 0;

    var visited = {};


    while (
      current &&
      depth < maxDepth
    ) {

      var currentId =
        current.getId();

      if (
        visited[
          currentId
        ]
      ) {
        break;
      }

      visited[
        currentId
      ] = true;

      breadcrumb.unshift({
        id:
          currentId,

        name:
          currentId ===
            rootId
            ? GDM_Config.get(
                'APP.ROOT_LABEL',
                'Mon Drive'
              )
            : current.getName(),

        url:
          GDM_Utils.getDriveFolderUrl(
            currentId
          )
      });


      if (
        currentId ===
        rootId
      ) {
        break;
      }

      var parents =
        current.getParents();

      if (
        !parents.hasNext()
      ) {
        break;
      }

      current =
        parents.next();

      depth++;
    }


    /*
     * Si la chaîne de parents ne permet pas d'atteindre explicitement
     * Mon Drive, on ajoute quand même Mon Drive en tête pour l'interface.
     */
    if (
      !breadcrumb.length ||
      breadcrumb[0].id !==
        rootId
    ) {

      breadcrumb.unshift({
        id:
          rootId,

        name:
          GDM_Config.get(
            'APP.ROOT_LABEL',
            'Mon Drive'
          ),

        url:
          GDM_Utils.getDriveFolderUrl(
            rootId
          )
      });
    }

    return breadcrumb;
  },


  /************************************************************************************************
   * EXISTENCE
   ************************************************************************************************/

  folderExists: function(folderId) {
    return GDM_Utils.folderExists(
      folderId
    );
  },


  fileExists: function(fileId) {
    return GDM_Utils.fileExists(
      fileId
    );
  },


  /************************************************************************************************
   * FICHIER PAR ID
   ************************************************************************************************/

  getFile: function(fileId) {

    fileId =
      GDM_Utils.requireString(
        fileId,
        'fileId'
      );

    var file =
      DriveApp.getFileById(
        fileId
      );

    return {
      ok: true,

      file:
        this.buildFileObject_(
          file
        )
    };
  },


  /************************************************************************************************
   * RECHERCHER UN SOUS-DOSSIER PAR NOM
   ************************************************************************************************/

  findChildFolderByName: function(
    parentFolderId,
    folderName
  ) {

    var parent =
      GDM_Utils.getFolderOrRoot(
        parentFolderId
      );

    folderName =
      GDM_Utils.requireString(
        folderName,
        'folderName'
      );

    var iterator =
      parent.getFoldersByName(
        folderName
      );

    if (
      !iterator.hasNext()
    ) {
      return null;
    }

    return this.buildFolderObject_(
      iterator.next(),
      false
    );
  },


  /************************************************************************************************
   * RECHERCHER UN FICHIER PAR NOM DANS UN DOSSIER
   ************************************************************************************************/

  findChildFilesByName: function(
    parentFolderId,
    fileName,
    limit
  ) {

    var parent =
      GDM_Utils.getFolderOrRoot(
        parentFolderId
      );

    fileName =
      GDM_Utils.requireString(
        fileName,
        'fileName'
      );

    limit =
      GDM_Utils.toPositiveInteger(
        limit,
        100
      );

    var iterator =
      parent.getFilesByName(
        fileName
      );

    var files = [];

    while (
      iterator.hasNext() &&
      files.length < limit
    ) {

      files.push(
        this.buildFileObject_(
          iterator.next()
        )
      );
    }

    return files;
  },


  /************************************************************************************************
   * CHEMIN HUMAIN D'UN DOSSIER
   ************************************************************************************************/

  getFolderPath: function(folderId) {

    var breadcrumb =
      this.getBreadcrumb(
        folderId
      );

    var names = [];

    for (
      var i = 0;
      i < breadcrumb.length;
      i++
    ) {
      names.push(
        breadcrumb[i].name
      );
    }

    return names.join(
      ' / '
    );
  },


  /************************************************************************************************
   * DOSSIER VIDE
   ************************************************************************************************/

  isFolderEmpty: function(folderId) {

    var folder =
      GDM_Utils.getFolderOrRoot(
        folderId
      );

    var files =
      folder.getFiles();

    if (
      files.hasNext()
    ) {
      return false;
    }

    var folders =
      folder.getFolders();

    return !folders.hasNext();
  },


  /************************************************************************************************
   * NOMBRE DIRECT D'ÉLÉMENTS
   *
   * Ne descend pas dans les sous-dossiers.
   ************************************************************************************************/

  countDirectChildren: function(folderId) {

    var folder =
      GDM_Utils.getFolderOrRoot(
        folderId
      );

    var filesCount = 0;
    var foldersCount = 0;

    var files =
      folder.getFiles();

    while (
      files.hasNext()
    ) {
      files.next();
      filesCount++;
    }

    var folders =
      folder.getFolders();

    while (
      folders.hasNext()
    ) {
      folders.next();
      foldersCount++;
    }

    return {
      files:
        filesCount,

      folders:
        foldersCount,

      total:
        filesCount +
        foldersCount
    };
  },


  /************************************************************************************************
   * PROCESS TASK
   *
   * Permet au Core/Engine.gs d'appeler Explorer via la queue si nécessaire.
   ************************************************************************************************/

  processTask: function(
    task,
    context
  ) {

    task =
      task || {};

    context =
      context || {};

    var payload =
      task.payload ||
      {};

    switch (
      task.action
    ) {


      /********************************************************************************************
       * EXPLORE_FOLDER
       ********************************************************************************************/

      case GDM_ACTIONS.EXPLORE_FOLDER:

        return {
          ok: true,

          skipped: false,

          message:
            'Dossier exploré.',

          data:
            this.getChildren(
              payload.folderId ||
              task.itemId,
              payload.options ||
              {}
            )
        };


      /********************************************************************************************
       * GET_FOLDER_INFO
       ********************************************************************************************/

      case GDM_ACTIONS.GET_FOLDER_INFO:

        return {
          ok: true,

          skipped: false,

          message:
            'Informations du dossier récupérées.',

          data:
            this.getFolderInfo(
              payload.folderId ||
              task.itemId
            )
        };


      /********************************************************************************************
       * GET_FOLDER_CHILDREN
       ********************************************************************************************/

      case GDM_ACTIONS.GET_FOLDER_CHILDREN:

        return {
          ok: true,

          skipped: false,

          message:
            'Contenu du dossier récupéré.',

          data:
            this.getChildren(
              payload.folderId ||
              task.itemId,
              payload.options ||
              {}
            )
        };


      default:

        throw new Error(
          'Explorer : action inconnue : ' +
          GDM_Utils.toString(
            task.action
          )
        );
    }
  },


  /************************************************************************************************
   * OBJET DOSSIER
   ************************************************************************************************/

  buildFolderObject_: function(
    folder,
    includeParent
  ) {

    if (!folder) {
      return null;
    }

    var id =
      folder.getId();

    var rootId =
      DriveApp
        .getRootFolder()
        .getId();

    var isRoot =
      id ===
      rootId;

    var parentId = '';
    var parentName = '';

    if (
      includeParent &&
      !isRoot
    ) {

      try {

        var parents =
          folder.getParents();

        if (
          parents.hasNext()
        ) {

          var parent =
            parents.next();

          parentId =
            parent.getId();

          parentName =
            parentId ===
              rootId
              ? GDM_Config.get(
                  'APP.ROOT_LABEL',
                  'Mon Drive'
                )
              : parent.getName();
        }

      } catch (
        ignoredParent
      ) {}
    }


    var name =
      isRoot
        ? GDM_Config.get(
            'APP.ROOT_LABEL',
            'Mon Drive'
          )
        : folder.getName();


    return {
      id:
        id,

      name:
        name,

      url:
        GDM_Utils.getDriveFolderUrl(
          id
        ),

      isRoot:
        isRoot,

      parentId:
        parentId,

      parentName:
        parentName
    };
  },


  /************************************************************************************************
   * OBJET FICHIER
   ************************************************************************************************/

  buildFileObject_: function(file) {

    if (!file) {
      return null;
    }

    var object =
      GDM_Utils.fileToObject(
        file
      );

    if (!object) {
      return null;
    }

    object.category =
      GDM_Config
        .getCategoryByExtension(
          object.extension
        ).LABEL;

    object.isGoogleFile =
      GDM_Utils.isGoogleMimeType(
        object.mimeType
      );

    object.isShortcut =
      GDM_Utils.isShortcutMimeType(
        object.mimeType
      );

    return object;
  },


  /************************************************************************************************
   * VALIDATION DU MODULE
   ************************************************************************************************/

  validate: function() {

    var errors = [];

    try {

      var root =
        this.getRoot();

      if (
        !root ||
        root.ok !== true ||
        !root.folder ||
        !root.folder.id
      ) {
        errors.push(
          'Impossible de récupérer Mon Drive.'
        );
      }

    } catch (error1) {

      errors.push(
        'Erreur getRoot() : ' +
        GDM_Utils.getErrorMessage(
          error1
        )
      );
    }


    try {

      var rootId =
        DriveApp
          .getRootFolder()
          .getId();

      if (
        !this.folderExists(
          rootId
        )
      ) {
        errors.push(
          'folderExists() ne reconnaît pas Mon Drive.'
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur folderExists() : ' +
        GDM_Utils.getErrorMessage(
          error2
        )
      );
    }


    try {

      var children =
        this.getChildren(
          '',
          {
            includeFolders:
              true,

            includeFiles:
              true,

            maxFolders:
              5,

            maxFiles:
              5
          }
        );

      if (
        !children ||
        children.ok !== true ||
        !Array.isArray(
          children.folders
        ) ||
        !Array.isArray(
          children.files
        )
      ) {
        errors.push(
          'getChildren() retourne un format incorrect.'
        );
      }

    } catch (error3) {

      errors.push(
        'Erreur getChildren() : ' +
        GDM_Utils.getErrorMessage(
          error3
        )
      );
    }


    return {
      ok:
        errors.length === 0,

      file:
        'Modules/Explorer.gs',

      version:
        GDM_APP.VERSION,

      readOnly:
        true,

      errors:
        errors
    };
  }

});