/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Rename.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Renommage progressif de fichiers et dossiers Google Drive.
 *
 * MODES DISPONIBLES
 * -----------------
 * - PREFIX    : ajoute un texte au début du nom ;
 * - SUFFIX    : ajoute un texte à la fin du nom ;
 * - REPLACE   : remplace une chaîne par une autre ;
 * - NORMALIZE : nettoie les espaces et caractères problématiques ;
 * - NUMBER    : ajoute une numérotation automatique.
 *
 * CE MODULE GÈRE
 * --------------
 * - aperçu avant renommage ;
 * - fichiers ;
 * - dossiers ;
 * - dossier sélectionné ou Mon Drive ;
 * - analyse récursive ;
 * - traitement progressif Queue + Engine ;
 * - reprise automatique ;
 * - protection contre les noms vides ;
 * - prévention des conflits ;
 * - conservation de l'extension des fichiers ;
 * - numérotation progressive ;
 * - statistiques et erreurs.
 *
 * SÉCURITÉ
 * --------
 * - Aucun fichier n'est supprimé.
 * - Aucun fichier n'est déplacé.
 * - Le dossier racine "Mon Drive" n'est jamais renommé.
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


const GDM_Rename = Object.freeze({


  /************************************************************************************************
   * MODES
   ************************************************************************************************/

  MODE_PREFIX_: 'PREFIX',

  MODE_SUFFIX_: 'SUFFIX',

  MODE_REPLACE_: 'REPLACE',

  MODE_NORMALIZE_: 'NORMALIZE',

  MODE_NUMBER_: 'NUMBER',


  /************************************************************************************************
   * OPÉRATIONS INTERNES
   ************************************************************************************************/

  OP_SCAN_FOLDER_: 'SCAN_FOLDER',

  OP_RENAME_FILE_: 'RENAME_FILE',

  OP_RENAME_FOLDER_: 'RENAME_FOLDER',


  /************************************************************************************************
   * STOCKAGE
   ************************************************************************************************/

  RESULT_PREFIX_: 'GDMV2_RENAME_RESULT_',


  /************************************************************************************************
   * LANCEMENT
   ************************************************************************************************/

  start: function(options) {

    options = options || {};


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


    var parameters =
      this.normalizeOptions_(
        options
      );


    /**********************************************************************************************
     * JOB
     **********************************************************************************************/

    var state =
      GDM_State.create({

        module:
          GDM_MODULES.RENAME,

        action:
          GDM_ACTIONS.RENAME_FILE,

        source: {

          id:
            sourceFolderId,

          name:
            sourceFolderName
        },

        parameters:
          parameters,

        totalKnown:
          1,

        setCurrent:
          true,

        message:
          'Renommage préparé.'
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

        parameters:
          parameters
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
          GDM_MODULES.RENAME,

        action:
          GDM_ACTIONS.RENAME_FILE,

        itemId:
          sourceFolderId,

        itemName:
          sourceFolderName,

        payload: {

          operation:
            this.OP_SCAN_FOLDER_,

          folderId:
            sourceFolderId,

          recursive:
            parameters.recursive,

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
          sourceFolderId,

        name:
          sourceFolderName
      },

      parameters:
        parameters,

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
   * APERÇU
   ************************************************************************************************/

  preview: function(options) {

    options = options || {};


    var sourceFolder =
      GDM_Utils.getFolderOrRoot(
        options.sourceFolderId ||
        options.folderId ||
        ''
      );


    var parameters =
      this.normalizeOptions_(
        options
      );


    var maxRows =
      GDM_Utils.toPositiveInteger(
        options.limit,
        GDM_Config.get(
          'RENAME.PREVIEW_MAX_ROWS',
          2000
        )
      );


    var rows = [];

    var foldersToScan = [
      sourceFolder
    ];


    var sequence =
      parameters.numberStart;


    var scannedFiles = 0;

    var scannedFolders = 0;

    var truncated = false;


    while (
      foldersToScan.length &&
      rows.length < maxRows
    ) {

      var folder =
        foldersToScan.shift();


      /********************************************************************************************
       * FICHIERS
       ********************************************************************************************/

      if (
        parameters.includeFiles
      ) {

        var files =
          folder.getFiles();


        while (
          files.hasNext()
        ) {

          if (
            rows.length >= maxRows
          ) {

            truncated =
              true;

            break;
          }


          var file =
            files.next();


          scannedFiles++;


          if (
            !this.matchesFile_(
              file,
              parameters
            )
          ) {

            continue;
          }


          var oldName =
            file.getName();


          var newName =
            this.buildNewName_(
              oldName,
              parameters,
              sequence,
              true
            );


          if (
            parameters.mode ===
            this.MODE_NUMBER_
          ) {

            sequence++;
          }


          if (
            oldName ===
            newName
          ) {

            continue;
          }


          rows.push({

            type:
              'FILE',

            id:
              file.getId(),

            oldName:
              oldName,

            newName:
              newName,

            folderId:
              folder.getId(),

            folderName:
              folder.getName(),

            conflict:
              this.fileNameConflict_(
                folder,
                newName,
                file.getId()
              )
          });
        }
      }


      /********************************************************************************************
       * SOUS-DOSSIERS
       ********************************************************************************************/

      var folders =
        folder.getFolders();


      while (
        folders.hasNext()
      ) {

        var child =
          folders.next();


        scannedFolders++;


        if (
          parameters.includeFolders &&
          rows.length < maxRows
        ) {

          var oldFolderName =
            child.getName();


          var newFolderName =
            this.buildNewName_(
              oldFolderName,
              parameters,
              sequence,
              false
            );


          if (
            parameters.mode ===
            this.MODE_NUMBER_
          ) {

            sequence++;
          }


          if (
            oldFolderName !==
            newFolderName
          ) {

            rows.push({

              type:
                'FOLDER',

              id:
                child.getId(),

              oldName:
                oldFolderName,

              newName:
                newFolderName,

              folderId:
                folder.getId(),

              folderName:
                folder.getName(),

              conflict:
                this.folderNameConflict_(
                  folder,
                  newFolderName,
                  child.getId()
                )
            });
          }
        }


        if (
          parameters.recursive
        ) {

          foldersToScan.push(
            child
          );
        }
      }


      if (
        rows.length >= maxRows
      ) {

        truncated =
          true;

        break;
      }
    }


    return {

      ok:
        true,

      mode:
        parameters.mode,

      scannedFiles:
        scannedFiles,

      scannedFolders:
        scannedFolders,

      returned:
        rows.length,

      truncated:
        truncated,

      rows:
        rows
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
      );


    switch (
      operation
    ) {

      case this.OP_SCAN_FOLDER_:

        return this.processScanFolder_(
          task,
          context
        );


      case this.OP_RENAME_FILE_:

        return this.processRenameFile_(
          task,
          context
        );


      case this.OP_RENAME_FOLDER_:

        return this.processRenameFolder_(
          task,
          context
        );
    }


    if (
      task.action ===
      GDM_ACTIONS.RENAME_FOLDER
    ) {

      return this.processRenameFolder_(
        task,
        context
      );
    }


    if (
      task.action ===
      GDM_ACTIONS.RENAME_FILE
    ) {

      return this.processRenameFile_(
        task,
        context
      );
    }


    throw new Error(
      'Rename : tâche inconnue.'
    );
  },


  /************************************************************************************************
   * SCAN DOSSIER
   ************************************************************************************************/

  processScanFolder_: function(
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
      this.normalizeOptions_(
        state.parameters ||
        {}
      );


    var result =
      this.readResult_(
        jobId
      );


    if (!result) {

      throw new Error(
        'Résultat Rename introuvable.'
      );
    }


    var tasks = [];

    var scannedFiles = 0;

    var scannedFolders = 0;


    /**********************************************************************************************
     * FICHIERS
     **********************************************************************************************/

    if (
      parameters.includeFiles
    ) {

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
            parameters
          )
        ) {

          continue;
        }


        var sequence =
          Number(
            result.nextSequence ||
            parameters.numberStart
          );


        var newName =
          this.buildNewName_(
            file.getName(),
            parameters,
            sequence,
            true
          );


        if (
          parameters.mode ===
          this.MODE_NUMBER_
        ) {

          result.nextSequence =
            sequence + 1;
        }


        if (
          file.getName() ===
          newName
        ) {

          result.counters.unchanged++;

          continue;
        }


        tasks.push({

          module:
            GDM_MODULES.RENAME,

          action:
            GDM_ACTIONS.RENAME_FILE,

          itemId:
            file.getId(),

          itemName:
            file.getName(),

          payload: {

            operation:
              this.OP_RENAME_FILE_,

            fileId:
              file.getId(),

            parentFolderId:
              folderId,

            oldName:
              file.getName(),

            newName:
              newName
          }
        });
      }
    }


    /**********************************************************************************************
     * SOUS-DOSSIERS
     **********************************************************************************************/

    var folders =
      folder.getFolders();


    while (
      folders.hasNext()
    ) {

      var child =
        folders.next();


      scannedFolders++;


      /*
       * Le scan du sous-dossier est ajouté avant son éventuel renommage.
       * L'identifiant Drive reste stable même si son nom change ensuite.
       */
      if (
        parameters.recursive
      ) {

        tasks.push({

          module:
            GDM_MODULES.RENAME,

          action:
            GDM_ACTIONS.RENAME_FILE,

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


      if (
        parameters.includeFolders
      ) {

        var folderSequence =
          Number(
            result.nextSequence ||
            parameters.numberStart
          );


        var newFolderName =
          this.buildNewName_(
            child.getName(),
            parameters,
            folderSequence,
            false
          );


        if (
          parameters.mode ===
          this.MODE_NUMBER_
        ) {

          result.nextSequence =
            folderSequence + 1;
        }


        if (
          child.getName() ===
          newFolderName
        ) {

          result.counters.unchanged++;

          continue;
        }


        tasks.push({

          module:
            GDM_MODULES.RENAME,

          action:
            GDM_ACTIONS.RENAME_FOLDER,

          itemId:
            child.getId(),

          itemName:
            child.getName(),

          payload: {

            operation:
              this.OP_RENAME_FOLDER_,

            folderId:
              child.getId(),

            parentFolderId:
              folderId,

            oldName:
              child.getName(),

            newName:
              newFolderName
          }
        });
      }
    }


    /**********************************************************************************************
     * STATISTIQUES
     **********************************************************************************************/

    result.counters.scannedFiles +=
      scannedFiles;


    result.counters.scannedFolders +=
      scannedFolders;


    result.updatedAt =
      GDM_Utils.nowIso();


    this.writeResult_(
      jobId,
      result
    );


    /**********************************************************************************************
     * QUEUE
     **********************************************************************************************/

    this.addTasksAndIncreaseTotal_(
      jobId,
      tasks
    );


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Dossier analysé pour renommage : ' +
        folder.getName(),

      data: {

        folderId:
          folderId,

        scannedFiles:
          scannedFiles,

        scannedFolders:
          scannedFolders,

        tasksAdded:
          tasks.length
      }
    };
  },


  /************************************************************************************************
   * RENOMMER FICHIER
   ************************************************************************************************/

  processRenameFile_: function(
    task,
    context
  ) {

    var jobId =
      task.jobId ||
      context.jobId;


    var payload =
      task.payload ||
      {};


    /*
     * Une tâche RENAME_FILE peut aussi être la tâche interne SCAN_FOLDER.
     */
    if (
      payload.operation ===
      this.OP_SCAN_FOLDER_
    ) {

      return this.processScanFolder_(
        task,
        context
      );
    }


    var fileId =
      GDM_Utils.requireFileId(
        payload.fileId ||
        task.itemId,
        'fileId'
      );


    var file =
      DriveApp.getFileById(
        fileId
      );


    var oldName =
      file.getName();


    var newName =
      GDM_Utils.trim(
        payload.newName
      );


    var state =
      GDM_State.require(
        jobId
      );


    var parameters =
      this.normalizeOptions_(
        state.parameters ||
        {}
      );


    if (!newName) {

      throw new Error(
        'Le nouveau nom du fichier est vide.'
      );
    }


    if (
      parameters.preventEmptyName &&
      !GDM_Utils.trim(
        newName
      )
    ) {

      throw new Error(
        'Le nouveau nom ne peut pas être vide.'
      );
    }


    if (
      oldName ===
      newName
    ) {

      return {

        ok:
          true,

        skipped:
          true,

        message:
          'Nom inchangé.'
      };
    }


    var parent =
      GDM_Utils.getFirstParentInfo(
        file
      );


    if (
      parameters.preventConflicts &&
      parent.id
    ) {

      var parentFolder =
        DriveApp.getFolderById(
          parent.id
        );


      if (
        this.fileNameConflict_(
          parentFolder,
          newName,
          fileId
        )
      ) {

        this.incrementResultCounter_(
          jobId,
          'conflicts'
        );


        return {

          ok:
            true,

          skipped:
            true,

          message:
            'Renommage ignoré : un fichier portant déjà ce nom existe.',

          data: {

            fileId:
              fileId,

            oldName:
              oldName,

            newName:
              newName
          }
        };
      }
    }


    file.setName(
      newName
    );


    this.incrementResultCounter_(
      jobId,
      'renamedFiles'
    );


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Fichier renommé : ' +
        oldName +
        ' → ' +
        newName,

      data: {

        fileId:
          fileId,

        oldName:
          oldName,

        newName:
          newName
      }
    };
  },


  /************************************************************************************************
   * RENOMMER DOSSIER
   ************************************************************************************************/

  processRenameFolder_: function(
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


    var rootId =
      DriveApp
        .getRootFolder()
        .getId();


    if (
      folderId ===
      rootId
    ) {

      return {

        ok:
          true,

        skipped:
          true,

        message:
          'Mon Drive ne peut pas être renommé.'
      };
    }


    var folder =
      DriveApp.getFolderById(
        folderId
      );


    var oldName =
      folder.getName();


    var newName =
      GDM_Utils.trim(
        payload.newName
      );


    var state =
      GDM_State.require(
        jobId
      );


    var parameters =
      this.normalizeOptions_(
        state.parameters ||
        {}
      );


    if (!newName) {

      throw new Error(
        'Le nouveau nom du dossier est vide.'
      );
    }


    if (
      oldName ===
      newName
    ) {

      return {

        ok:
          true,

        skipped:
          true,

        message:
          'Nom du dossier inchangé.'
      };
    }


    var parent =
      GDM_Utils.getFirstParentInfo(
        folder
      );


    if (
      parameters.preventConflicts &&
      parent.id
    ) {

      var parentFolder =
        DriveApp.getFolderById(
          parent.id
        );


      if (
        this.folderNameConflict_(
          parentFolder,
          newName,
          folderId
        )
      ) {

        this.incrementResultCounter_(
          jobId,
          'conflicts'
        );


        return {

          ok:
            true,

          skipped:
            true,

          message:
            'Renommage ignoré : un dossier portant déjà ce nom existe.'
        };
      }
    }


    folder.setName(
      newName
    );


    this.incrementResultCounter_(
      jobId,
      'renamedFolders'
    );


    return {

      ok:
        true,

      skipped:
        false,

      message:
        'Dossier renommé : ' +
        oldName +
        ' → ' +
        newName,

      data: {

        folderId:
          folderId,

        oldName:
          oldName,

        newName:
          newName
      }
    };
  },


  /************************************************************************************************
   * PARAMÈTRES
   ************************************************************************************************/

  normalizeOptions_: function(options) {

    options =
      options || {};


    var mode =
      GDM_Utils
        .trim(
          options.mode ||
          options.renameMode
        )
        .toUpperCase();


    if (
      [
        this.MODE_PREFIX_,
        this.MODE_SUFFIX_,
        this.MODE_REPLACE_,
        this.MODE_NORMALIZE_,
        this.MODE_NUMBER_
      ].indexOf(
        mode
      ) === -1
    ) {

      mode =
        this.MODE_PREFIX_;
    }


    return {

      mode:
        mode,

      recursive:
        typeof options.recursive ===
          'undefined'
          ? GDM_Config.get(
              'RENAME.INCLUDE_SUBFOLDERS_DEFAULT',
              false
            )
          : GDM_Utils.toBoolean(
              options.recursive,
              false
            ),

      includeFiles:
        typeof options.includeFiles ===
          'undefined'
          ? true
          : GDM_Utils.toBoolean(
              options.includeFiles,
              true
            ),

      includeFolders:
        GDM_Utils.toBoolean(
          options.includeFolders,
          false
        ),

      prefix:
        GDM_Utils.toString(
          options.prefix
        ),

      suffix:
        GDM_Utils.toString(
          options.suffix
        ),

      search:
        GDM_Utils.toString(
          options.search ||
          options.find ||
          options.replaceFrom
        ),

      replacement:
        GDM_Utils.toString(
          options.replacement ||
          options.replaceWith
        ),

      caseSensitiveReplace:
        typeof options.caseSensitiveReplace ===
          'undefined'
          ? GDM_Config.get(
              'RENAME.CASE_SENSITIVE_REPLACE',
              false
            )
          : GDM_Utils.toBoolean(
              options.caseSensitiveReplace,
              false
            ),

      trimNames:
        typeof options.trimNames ===
          'undefined'
          ? GDM_Config.get(
              'RENAME.TRIM_NAMES',
              true
            )
          : GDM_Utils.toBoolean(
              options.trimNames,
              true
            ),

      preventEmptyName:
        typeof options.preventEmptyName ===
          'undefined'
          ? GDM_Config.get(
              'RENAME.PREVENT_EMPTY_NAME',
              true
            )
          : GDM_Utils.toBoolean(
              options.preventEmptyName,
              true
            ),

      preventConflicts:
        typeof options.preventConflicts ===
          'undefined'
          ? GDM_Config.get(
              'RENAME.PREVENT_CONFLICTS',
              true
            )
          : GDM_Utils.toBoolean(
              options.preventConflicts,
              true
            ),

      preserveExtension:
        typeof options.preserveExtension ===
          'undefined'
          ? true
          : GDM_Utils.toBoolean(
              options.preserveExtension,
              true
            ),

      numberStart:
        Math.max(
          0,
          GDM_Utils.toInteger(
            options.numberStart,
            1
          )
        ),

      numberPadding:
        Math.max(
          1,
          GDM_Utils.toInteger(
            options.numberPadding,
            3
          )
        ),

      numberSeparator:
        typeof options.numberSeparator ===
          'undefined'
          ? '_'
          : GDM_Utils.toString(
              options.numberSeparator
            ),

      numberPosition:
        GDM_Utils
          .trim(
            options.numberPosition
          )
          .toUpperCase() ===
          'SUFFIX'
            ? 'SUFFIX'
            : 'PREFIX',

      extensions:
        GDM_Utils.normalizeExtensions(
          options.extensions ||
          []
        ),

      nameContains:
        GDM_Utils.trim(
          options.nameContains
        )
    };
  },


  /************************************************************************************************
   * CONSTRUIRE LE NOUVEAU NOM
   ************************************************************************************************/

  buildNewName_: function(
    oldName,
    parameters,
    sequence,
    isFile
  ) {

    oldName =
      GDM_Utils.toString(
        oldName
      );


    var baseName =
      oldName;


    var extension = '';


    if (
      isFile &&
      parameters.preserveExtension
    ) {

      var parts =
        GDM_Utils.splitNameAndExtension(
          oldName
        );


      baseName =
        parts.baseName;


      extension =
        parts.extension;
    }


    var newBase =
      baseName;


    switch (
      parameters.mode
    ) {

      case this.MODE_PREFIX_:

        newBase =
          parameters.prefix +
          baseName;

        break;


      case this.MODE_SUFFIX_:

        newBase =
          baseName +
          parameters.suffix;

        break;


      case this.MODE_REPLACE_:

        newBase =
          this.replaceText_(
            baseName,
            parameters.search,
            parameters.replacement,
            parameters.caseSensitiveReplace
          );

        break;


      case this.MODE_NORMALIZE_:

        newBase =
          GDM_Utils.normalizeWhitespace(
            baseName
          );

        newBase =
          GDM_Utils.sanitizeFileName(
            newBase
          );

        break;


      case this.MODE_NUMBER_:

        var number =
          this.padNumber_(
            sequence,
            parameters.numberPadding
          );


        if (
          parameters.numberPosition ===
          'SUFFIX'
        ) {

          newBase =
            baseName +
            parameters.numberSeparator +
            number;

        } else {

          newBase =
            number +
            parameters.numberSeparator +
            baseName;
        }

        break;
    }


    if (
      parameters.trimNames
    ) {

      newBase =
        GDM_Utils.trim(
          newBase
        );
    }


    newBase =
      GDM_Utils.sanitizeFileName(
        newBase
      );


    if (
      parameters.preventEmptyName &&
      !newBase
    ) {

      throw new Error(
        'Le renommage produirait un nom vide.'
      );
    }


    if (
      isFile &&
      parameters.preserveExtension &&
      extension
    ) {

      return newBase +
        '.' +
        extension;
    }


    return newBase;
  },


  /************************************************************************************************
   * REMPLACEMENT TEXTE
   ************************************************************************************************/

  replaceText_: function(
    value,
    search,
    replacement,
    caseSensitive
  ) {

    value =
      GDM_Utils.toString(
        value
      );


    search =
      GDM_Utils.toString(
        search
      );


    replacement =
      GDM_Utils.toString(
        replacement
      );


    if (!search) {

      return value;
    }


    var escaped =
      search.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );


    var flags =
      caseSensitive
        ? 'g'
        : 'gi';


    return value.replace(
      new RegExp(
        escaped,
        flags
      ),
      replacement
    );
  },


  /************************************************************************************************
   * NUMÉROTATION
   ************************************************************************************************/

  padNumber_: function(
    value,
    padding
  ) {

    var text =
      String(
        Math.max(
          0,
          Number(
            value || 0
          )
        )
      );


    while (
      text.length <
      padding
    ) {

      text =
        '0' +
        text;
    }


    return text;
  },


  /************************************************************************************************
   * FILTRE FICHIER
   ************************************************************************************************/

  matchesFile_: function(
    file,
    parameters
  ) {

    var name =
      file.getName();


    if (
      parameters.extensions.length
    ) {

      var extension =
        GDM_Utils.getExtension(
          name
        );


      if (
        parameters.extensions.indexOf(
          extension
        ) === -1
      ) {

        return false;
      }
    }


    if (
      parameters.nameContains &&
      !GDM_Utils.contains(
        name,
        parameters.nameContains,
        false
      )
    ) {

      return false;
    }


    return true;
  },


  /************************************************************************************************
   * CONFLITS FICHIER
   ************************************************************************************************/

  fileNameConflict_: function(
    parentFolder,
    requestedName,
    currentFileId
  ) {

    var iterator =
      parentFolder.getFilesByName(
        requestedName
      );


    while (
      iterator.hasNext()
    ) {

      var file =
        iterator.next();


      if (
        file.getId() !==
        currentFileId
      ) {

        return true;
      }
    }


    return false;
  },


  /************************************************************************************************
   * CONFLITS DOSSIER
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
        folder.getId() !==
        currentFolderId
      ) {

        return true;
      }
    }


    return false;
  },


  /************************************************************************************************
   * AJOUT TÂCHES
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

    var result = {

      schemaVersion:
        1,

      jobId:
        jobId,

      module:
        GDM_MODULES.RENAME,

      source: {

        id:
          options.sourceFolderId,

        name:
          options.sourceFolderName
      },

      parameters:
        options.parameters,

      nextSequence:
        Number(
          options.parameters.numberStart ||
          1
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

        scannedFolders:
          0,

        renamedFiles:
          0,

        renamedFolders:
          0,

        unchanged:
          0,

        conflicts:
          0,

        errors:
          0
      }
    };


    this.writeResult_(
      jobId,
      result
    );


    return result;
  },


  /************************************************************************************************
   * INCRÉMENTER COMPTEUR
   ************************************************************************************************/

  incrementResultCounter_: function(
    jobId,
    counter
  ) {

    return this.updateResult_(
      jobId,
      function(result) {

        if (
          typeof result.counters[
            counter
          ] ===
          'undefined'
        ) {

          result.counters[
            counter
          ] = 0;
        }


        result.counters[
          counter
        ]++;


        result.updatedAt =
          GDM_Utils.nowIso();


        return result;
      }
    );
  },


  /************************************************************************************************
   * RÉSULTAT PUBLIC
   ************************************************************************************************/

  getResult: function(jobId) {

    var result =
      this.readResult_(
        jobId
      );


    if (!result) {

      return null;
    }


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
   * FINALISER
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
   * CLÉ STOCKAGE
   ************************************************************************************************/

  getResultKey_: function(jobId) {

    return this.RESULT_PREFIX_ +
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );
  },


  /************************************************************************************************
   * LECTURE
   ************************************************************************************************/

  readResult_: function(jobId) {

    return this.readChunked_(
      this.getResultKey_(
        jobId
      )
    );
  },


  /************************************************************************************************
   * ÉCRITURE
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
   * UPDATE RÉSULTAT
   ************************************************************************************************/

  updateResult_: function(
    jobId,
    callback
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        var key =
          GDM_Rename.getResultKey_(
            jobId
          );


        var result =
          GDM_Rename.readChunked_(
            key
          );


        if (!result) {

          throw new Error(
            'Résultat Rename introuvable.'
          );
        }


        result =
          callback(
            result
          ) ||
          result;


        GDM_Rename.writeChunkedUnlocked_(
          key,
          result
        );


        return result;

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

        return GDM_Rename.writeChunkedUnlocked_(
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


    var propertiesMeta =
      GDM_Utils.safeJsonParse(
        properties.getProperty(
          baseKey +
          '_META'
        ),
        {}
      );


    var oldCount =
      GDM_Utils.toInteger(
        propertiesMeta.chunkCount,
        0
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
      GDM_Utils.toInteger(
        meta.chunkCount,
        0
      );


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
   * VALIDATION
   ************************************************************************************************/

  validate: function() {

    var errors = [];


    try {

      var params =
        this.normalizeOptions_({

          mode:
            'PREFIX',

          prefix:
            'DD_'
        });


      var test =
        this.buildNewName_(
          'facture.pdf',
          params,
          1,
          true
        );


      if (
        test !==
        'DD_facture.pdf'
      ) {

        errors.push(
          'Mode PREFIX incorrect : ' +
          test
        );
      }

    } catch (error1) {

      errors.push(
        'Erreur PREFIX : ' +
        GDM_Utils.getErrorMessage(
          error1
        )
      );
    }


    try {

      var params2 =
        this.normalizeOptions_({

          mode:
            'NUMBER',

          numberStart:
            1,

          numberPadding:
            3
        });


      var test2 =
        this.buildNewName_(
          'photo.jpg',
          params2,
          1,
          true
        );


      if (
        test2 !==
        '001_photo.jpg'
      ) {

        errors.push(
          'Mode NUMBER incorrect : ' +
          test2
        );
      }

    } catch (error2) {

      errors.push(
        'Erreur NUMBER : ' +
        GDM_Utils.getErrorMessage(
          error2
        )
      );
    }


    return {

      ok:
        errors.length === 0,

      file:
        'Modules/Rename.gs',

      version:
        GDM_APP.VERSION,

      deletesFiles:
        false,

      movesFiles:
        false,

      modes: [
        this.MODE_PREFIX_,
        this.MODE_SUFFIX_,
        this.MODE_REPLACE_,
        this.MODE_NORMALIZE_,
        this.MODE_NUMBER_
      ],

      errors:
        errors
    };
  }

});


/**************************************************************************************************
 * API GLOBALE POUR L'INTERFACE
 **************************************************************************************************/

function GDM_apiGetRenameResult(jobId) {

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
      GDM_Rename.getResult(
        jobId
      )
  };
}