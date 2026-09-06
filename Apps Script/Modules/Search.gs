/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Modules/Search.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Recherche rapide, filtrée et sûre dans Google Drive.
 *
 * CE MODULE GÈRE
 * --------------
 * - recherche dans tout Mon Drive ;
 * - recherche dans un dossier précis ;
 * - recherche récursive dans les sous-dossiers ;
 * - fichiers et/ou dossiers ;
 * - nom exact ou nom contenant un texte ;
 * - extensions ;
 * - types MIME ;
 * - tailles minimale et maximale ;
 * - dates de création et de modification ;
 * - fichiers volumineux ;
 * - anciens fichiers ;
 * - tri des résultats ;
 * - limites de sécurité pour les gros Drive ;
 * - continuation des recherches globales via les continuation tokens Apps Script.
 *
 * CONCEPTION GROS DRIVE
 * ---------------------
 * - Une recherche globale utilise DriveApp.searchFiles() / DriveApp.searchFolders().
 * - Une recherche dans un dossier parcourt uniquement le dossier demandé.
 * - Aucun tableau contenant l'intégralité du Drive n'est créé.
 * - Les résultats et le nombre d'éléments inspectés sont plafonnés.
 * - Le module s'arrête volontairement avant la limite maximale d'exécution Apps Script.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 *
 * SÉCURITÉ
 * --------
 * - Lecture seule.
 * - Aucun fichier n'est déplacé, renommé, copié ou supprimé.
 * - Aucun dossier n'est modifié.
 **************************************************************************************************/
'use strict';


const GDM_Search = Object.freeze({

  MODULE_NAME_: 'Search',

  TYPE_FILE_: 'FILE',
  TYPE_FOLDER_: 'FOLDER',

  ACTION_SEARCH_: 'SEARCH',
  ACTION_FILES_: 'FILES',
  ACTION_FOLDERS_: 'FOLDERS',
  ACTION_QUICK_: 'QUICK',
  ACTION_BY_NAME_: 'BY_NAME',
  ACTION_BY_EXTENSION_: 'BY_EXTENSION',
  ACTION_LARGE_FILES_: 'LARGE_FILES',
  ACTION_OLD_FILES_: 'OLD_FILES',

  DEFAULT_LIMIT_: 500,
  MAX_LIMIT_: 5000,
  DEFAULT_MAX_SCANNED_: 10000,
  MAX_SCANNED_: 50000,
  DEFAULT_RUNTIME_MS_: 180000,
  MAX_RUNTIME_MS_: 220000,
  DEFAULT_OLD_DAYS_: 365,
  DEFAULT_LARGE_MB_: 100,
  DEFAULT_MAX_DEPTH_: 100,
  MAX_FOLDER_QUEUE_: 10000,


  /************************************************************************************************
   * ROUTEUR PRINCIPAL
   ************************************************************************************************/
  execute: function(action, options) {
    action = this.normalizeString_(action).toUpperCase();
    options = options || {};

    switch (action) {
      case this.ACTION_SEARCH_:
      case 'SEARCH_ALL':
        return this.search(options);

      case this.ACTION_FILES_:
      case 'SEARCH_FILES':
        return this.searchFiles(options);

      case this.ACTION_FOLDERS_:
      case 'SEARCH_FOLDERS':
        return this.searchFolders(options);

      case this.ACTION_QUICK_:
      case 'QUICK_SEARCH':
        return this.quickSearch(
          options.text || options.query || options.name || '',
          options
        );

      case this.ACTION_BY_NAME_:
      case 'SEARCH_BY_NAME':
        return this.findByName(
          options.name || options.text || options.query || '',
          options
        );

      case this.ACTION_BY_EXTENSION_:
      case 'SEARCH_BY_EXTENSION':
        return this.findByExtension(
          options.extension || options.ext || '',
          options
        );

      case this.ACTION_LARGE_FILES_:
      case 'FIND_LARGE_FILES':
        return this.findLargeFiles(options);

      case this.ACTION_OLD_FILES_:
      case 'FIND_OLD_FILES':
        return this.findOldFiles(options);

      default:
        throw new Error(
          'Search : action inconnue : ' +
          action
        );
    }
  },


  /************************************************************************************************
   * RECHERCHE GÉNÉRALE
   ************************************************************************************************/
  search: function(options) {
    options = this.normalizeOptions_(options || {});

    if (
      !options.includeFiles &&
      !options.includeFolders
    ) {
      return this.buildEmptyResult_(
        options,
        'Aucun type d’élément sélectionné.'
      );
    }

    var startedAt = new Date();
    var startMs = Date.now();

    var result;

    if (options.folderId) {
      result = this.searchFolderScope_(
        options,
        startMs
      );
    } else {
      result = this.searchGlobal_(
        options,
        startMs
      );
    }

    result.startedAt = startedAt.toISOString();
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - startMs;

    result.rows = this.sortRows_(
      result.rows || [],
      options.sortBy,
      options.sortDirection
    );

    if (result.rows.length > options.limit) {
      result.rows = result.rows.slice(
        0,
        options.limit
      );
      result.truncated = true;
    }

    result.returned = result.rows.length;
    result.summary = this.buildSummary_(
      result.rows
    );

    return result;
  },


  /************************************************************************************************
   * RECHERCHE FICHIERS UNIQUEMENT
   ************************************************************************************************/
  searchFiles: function(options) {
    options = this.cloneObject_(options || {});
    options.includeFiles = true;
    options.includeFolders = false;

    return this.search(options);
  },


  /************************************************************************************************
   * RECHERCHE DOSSIERS UNIQUEMENT
   ************************************************************************************************/
  searchFolders: function(options) {
    options = this.cloneObject_(options || {});
    options.includeFiles = false;
    options.includeFolders = true;

    return this.search(options);
  },


  /************************************************************************************************
   * RECHERCHE RAPIDE
   ************************************************************************************************/
  quickSearch: function(text, options) {
    options = this.cloneObject_(options || {});

    text = this.normalizeString_(text);

    if (!text) {
      throw new Error(
        'Veuillez saisir un texte à rechercher.'
      );
    }

    options.nameContains = text;

    if (
      typeof options.includeFiles ===
      'undefined'
    ) {
      options.includeFiles = true;
    }

    if (
      typeof options.includeFolders ===
      'undefined'
    ) {
      options.includeFolders = true;
    }

    return this.search(options);
  },


  /************************************************************************************************
   * RECHERCHE PAR NOM
   ************************************************************************************************/
  findByName: function(name, options) {
    options = this.cloneObject_(options || {});

    name = this.normalizeString_(name);

    if (!name) {
      throw new Error(
        'Le nom à rechercher est obligatoire.'
      );
    }

    if (
      this.toBoolean_(
        options.exact,
        false
      )
    ) {
      options.nameExact = name;
    } else {
      options.nameContains = name;
    }

    return this.search(options);
  },


  /************************************************************************************************
   * RECHERCHE PAR EXTENSION
   ************************************************************************************************/
  findByExtension: function(extension, options) {
    options = this.cloneObject_(options || {});

    extension = this.normalizeExtension_(
      extension
    );

    if (!extension) {
      throw new Error(
        'L’extension à rechercher est obligatoire.'
      );
    }

    options.extensions = [extension];
    options.includeFiles = true;
    options.includeFolders = false;

    return this.search(options);
  },


  /************************************************************************************************
   * FICHIERS VOLUMINEUX
   ************************************************************************************************/
  findLargeFiles: function(options) {
    options = this.cloneObject_(options || {});

    var minMb = this.toPositiveNumber_(
      options.minMb ||
      options.largeMb,
      this.getConfigNumber_(
        'ANALYSIS.LARGE_FILE_MB',
        this.DEFAULT_LARGE_MB_
      )
    );

    options.minSizeBytes =
      Math.floor(
        minMb * 1024 * 1024
      );

    options.includeFiles = true;
    options.includeFolders = false;
    options.sortBy = options.sortBy || 'size';
    options.sortDirection =
      options.sortDirection || 'DESC';

    return this.search(options);
  },


  /************************************************************************************************
   * ANCIENS FICHIERS
   ************************************************************************************************/
  findOldFiles: function(options) {
    options = this.cloneObject_(options || {});

    var days = this.toPositiveInteger_(
      options.days ||
      options.olderThanDays,
      this.getConfigNumber_(
        'ANALYSIS.OLD_FILE_DAYS',
        this.DEFAULT_OLD_DAYS_
      )
    );

    var before = new Date();
    before.setDate(
      before.getDate() - days
    );

    options.modifiedBefore = before;
    options.includeFiles = true;
    options.includeFolders = false;
    options.sortBy = options.sortBy || 'modifiedAt';
    options.sortDirection =
      options.sortDirection || 'ASC';

    return this.search(options);
  },


  /************************************************************************************************
   * RECHERCHE GLOBALE INDEXÉE GOOGLE DRIVE
   ************************************************************************************************/
  searchGlobal_: function(options, startMs) {
    var rows = [];
    var scannedFiles = 0;
    var scannedFolders = 0;
    var matchedFiles = 0;
    var matchedFolders = 0;
    var truncated = false;
    var stoppedByTime = false;
    var stoppedByScanLimit = false;

    var continuation = {
      scope: 'GLOBAL',
      stage: '',
      fileToken: '',
      folderToken: ''
    };

    var resume =
      options.resume &&
      typeof options.resume === 'object'
        ? options.resume
        : {};

    var stage =
      this.normalizeString_(
        resume.stage
      ).toUpperCase();

    if (
      stage !== 'FILES' &&
      stage !== 'FOLDERS'
    ) {
      stage = options.includeFiles
        ? 'FILES'
        : 'FOLDERS';
    }

    /**********************************************************************************************
     * FICHIERS
     **********************************************************************************************/
    if (
      options.includeFiles &&
      stage === 'FILES'
    ) {
      var fileIterator =
        this.getGlobalFileIterator_(
          options,
          resume.fileToken
        );

      while (fileIterator.hasNext()) {
        if (
          this.runtimeExpired_(
            startMs,
            options.maxRuntimeMs
          )
        ) {
          stoppedByTime = true;
          truncated = true;
          break;
        }

        if (
          scannedFiles + scannedFolders >=
          options.maxScanned
        ) {
          stoppedByScanLimit = true;
          truncated = true;
          break;
        }

        if (rows.length >= options.limit) {
          truncated = true;
          break;
        }

        var file = fileIterator.next();
        scannedFiles++;

        if (
          !this.matchesFile_(
            file,
            options
          )
        ) {
          continue;
        }

        matchedFiles++;
        rows.push(
          this.fileToRow_(
            file,
            null,
            options
          )
        );
      }

      if (
        fileIterator.hasNext()
      ) {
        continuation.stage = 'FILES';
        continuation.fileToken =
          this.safeContinuationToken_(
            fileIterator
          );
        truncated = true;
      } else if (
        options.includeFolders &&
        rows.length < options.limit &&
        !stoppedByTime &&
        !stoppedByScanLimit
      ) {
        stage = 'FOLDERS';
      } else {
        stage = '';
      }
    }

    /**********************************************************************************************
     * DOSSIERS
     **********************************************************************************************/
    if (
      options.includeFolders &&
      stage === 'FOLDERS' &&
      rows.length < options.limit &&
      !stoppedByTime &&
      !stoppedByScanLimit
    ) {
      var folderIterator =
        this.getGlobalFolderIterator_(
          options,
          resume.folderToken
        );

      while (folderIterator.hasNext()) {
        if (
          this.runtimeExpired_(
            startMs,
            options.maxRuntimeMs
          )
        ) {
          stoppedByTime = true;
          truncated = true;
          break;
        }

        if (
          scannedFiles + scannedFolders >=
          options.maxScanned
        ) {
          stoppedByScanLimit = true;
          truncated = true;
          break;
        }

        if (rows.length >= options.limit) {
          truncated = true;
          break;
        }

        var folder = folderIterator.next();
        scannedFolders++;

        if (
          !this.matchesFolder_(
            folder,
            options
          )
        ) {
          continue;
        }

        matchedFolders++;
        rows.push(
          this.folderToRow_(
            folder,
            null,
            options
          )
        );
      }

      if (
        folderIterator.hasNext()
      ) {
        continuation.stage = 'FOLDERS';
        continuation.folderToken =
          this.safeContinuationToken_(
            folderIterator
          );
        truncated = true;
      }
    }

    if (
      !continuation.stage
    ) {
      continuation = null;
    }

    return {
      ok: true,
      module: this.MODULE_NAME_,
      scope: 'GLOBAL',
      folderId: '',
      recursive: false,
      query: this.describeQuery_(options),
      scanned: scannedFiles + scannedFolders,
      scannedFiles: scannedFiles,
      scannedFolders: scannedFolders,
      matched: matchedFiles + matchedFolders,
      matchedFiles: matchedFiles,
      matchedFolders: matchedFolders,
      returned: rows.length,
      truncated: truncated,
      stoppedByTime: stoppedByTime,
      stoppedByScanLimit: stoppedByScanLimit,
      continuation: continuation,
      rows: rows
    };
  },


  /************************************************************************************************
   * RECHERCHE DANS UN DOSSIER
   ************************************************************************************************/
  searchFolderScope_: function(options, startMs) {
    var rootFolder =
      DriveApp.getFolderById(
        options.folderId
      );

    var rows = [];
    var scannedFiles = 0;
    var scannedFolders = 0;
    var matchedFiles = 0;
    var matchedFolders = 0;
    var truncated = false;
    var stoppedByTime = false;
    var stoppedByScanLimit = false;
    var stoppedByQueueLimit = false;

    var queue = [
      {
        folder: rootFolder,
        depth: 0,
        includeFolderRow: false
      }
    ];

    while (queue.length) {
      if (
        this.runtimeExpired_(
          startMs,
          options.maxRuntimeMs
        )
      ) {
        stoppedByTime = true;
        truncated = true;
        break;
      }

      if (
        scannedFiles + scannedFolders >=
        options.maxScanned
      ) {
        stoppedByScanLimit = true;
        truncated = true;
        break;
      }

      if (rows.length >= options.limit) {
        truncated = true;
        break;
      }

      var current = queue.shift();
      var folder = current.folder;
      var depth = current.depth;

      if (
        current.includeFolderRow &&
        options.includeFolders
      ) {
        scannedFolders++;

        if (
          this.matchesFolder_(
            folder,
            options
          )
        ) {
          matchedFolders++;
          rows.push(
            this.folderToRow_(
              folder,
              null,
              options
            )
          );

          if (rows.length >= options.limit) {
            truncated = true;
            break;
          }
        }
      }

      /********************************************************************************************
       * FICHIERS DIRECTS
       ********************************************************************************************/
      if (options.includeFiles) {
        var files = folder.getFiles();

        while (files.hasNext()) {
          if (
            this.runtimeExpired_(
              startMs,
              options.maxRuntimeMs
            )
          ) {
            stoppedByTime = true;
            truncated = true;
            break;
          }

          if (
            scannedFiles + scannedFolders >=
            options.maxScanned
          ) {
            stoppedByScanLimit = true;
            truncated = true;
            break;
          }

          if (rows.length >= options.limit) {
            truncated = true;
            break;
          }

          var file = files.next();
          scannedFiles++;

          if (
            !this.matchesFile_(
              file,
              options
            )
          ) {
            continue;
          }

          matchedFiles++;
          rows.push(
            this.fileToRow_(
              file,
              folder,
              options
            )
          );
        }

        if (
          stoppedByTime ||
          stoppedByScanLimit ||
          rows.length >= options.limit
        ) {
          break;
        }
      }

      /********************************************************************************************
       * SOUS-DOSSIERS
       ********************************************************************************************/
      if (
        options.recursive &&
        depth < options.maxDepth
      ) {
        var folders = folder.getFolders();

        while (folders.hasNext()) {
          if (
            this.runtimeExpired_(
              startMs,
              options.maxRuntimeMs
            )
          ) {
            stoppedByTime = true;
            truncated = true;
            break;
          }

          if (
            queue.length >=
            this.MAX_FOLDER_QUEUE_
          ) {
            stoppedByQueueLimit = true;
            truncated = true;
            break;
          }

          var child = folders.next();

          queue.push({
            folder: child,
            depth: depth + 1,
            includeFolderRow: true
          });
        }

        if (
          stoppedByTime ||
          stoppedByQueueLimit
        ) {
          break;
        }
      } else if (
        !options.recursive &&
        options.includeFolders
      ) {
        var directFolders = folder.getFolders();

        while (directFolders.hasNext()) {
          if (
            this.runtimeExpired_(
              startMs,
              options.maxRuntimeMs
            )
          ) {
            stoppedByTime = true;
            truncated = true;
            break;
          }

          if (
            scannedFiles + scannedFolders >=
            options.maxScanned
          ) {
            stoppedByScanLimit = true;
            truncated = true;
            break;
          }

          if (rows.length >= options.limit) {
            truncated = true;
            break;
          }

          var directFolder =
            directFolders.next();

          scannedFolders++;

          if (
            !this.matchesFolder_(
              directFolder,
              options
            )
          ) {
            continue;
          }

          matchedFolders++;
          rows.push(
            this.folderToRow_(
              directFolder,
              rootFolder,
              options
            )
          );
        }

        break;
      }
    }

    if (queue.length) {
      truncated = true;
    }

    return {
      ok: true,
      module: this.MODULE_NAME_,
      scope: 'FOLDER',
      folderId: rootFolder.getId(),
      folderName: rootFolder.getName(),
      recursive: options.recursive,
      query: this.describeQuery_(options),
      scanned: scannedFiles + scannedFolders,
      scannedFiles: scannedFiles,
      scannedFolders: scannedFolders,
      matched: matchedFiles + matchedFolders,
      matchedFiles: matchedFiles,
      matchedFolders: matchedFolders,
      returned: rows.length,
      truncated: truncated,
      stoppedByTime: stoppedByTime,
      stoppedByScanLimit: stoppedByScanLimit,
      stoppedByQueueLimit: stoppedByQueueLimit,
      continuation: null,
      rows: rows
    };
  },


  /************************************************************************************************
   * ITÉRATEUR GLOBAL FICHIERS
   ************************************************************************************************/
  getGlobalFileIterator_: function(options, continuationToken) {
    continuationToken =
      this.normalizeString_(
        continuationToken
      );

    if (continuationToken) {
      try {
        return DriveApp.continueFileIterator(
          continuationToken
        );
      } catch (ignored) {
        // Le token a pu expirer. On repart d'une recherche normale.
      }
    }

    return DriveApp.searchFiles(
      this.buildFileDriveQuery_(
        options
      )
    );
  },


  /************************************************************************************************
   * ITÉRATEUR GLOBAL DOSSIERS
   ************************************************************************************************/
  getGlobalFolderIterator_: function(options, continuationToken) {
    continuationToken =
      this.normalizeString_(
        continuationToken
      );

    if (continuationToken) {
      try {
        return DriveApp.continueFolderIterator(
          continuationToken
        );
      } catch (ignored) {
        // Le token a pu expirer. On repart d'une recherche normale.
      }
    }

    return DriveApp.searchFolders(
      this.buildFolderDriveQuery_(
        options
      )
    );
  },


  /************************************************************************************************
   * QUERY DRIVE POUR FICHIERS
   *
   * DriveApp utilise encore les noms de champs de l'API Drive v2 dans ses requêtes : title,
   * modifiedDate, createdDate, etc.
   ************************************************************************************************/
  buildFileDriveQuery_: function(options) {
    var parts = [];

    if (!options.includeTrashed) {
      parts.push('trashed = false');
    }

    if (options.nameExact) {
      parts.push(
        "title = '" +
        this.escapeDriveQueryValue_(
          options.nameExact
        ) +
        "'"
      );
    } else if (options.nameContains) {
      parts.push(
        "title contains '" +
        this.escapeDriveQueryValue_(
          options.nameContains
        ) +
        "'"
      );
    }

    if (
      options.mimeTypes.length === 1
    ) {
      parts.push(
        "mimeType = '" +
        this.escapeDriveQueryValue_(
          options.mimeTypes[0]
        ) +
        "'"
      );
    }

    return parts.length
      ? parts.join(' and ')
      : 'trashed = false';
  },


  /************************************************************************************************
   * QUERY DRIVE POUR DOSSIERS
   ************************************************************************************************/
  buildFolderDriveQuery_: function(options) {
    var parts = [];

    if (!options.includeTrashed) {
      parts.push('trashed = false');
    }

    if (options.nameExact) {
      parts.push(
        "title = '" +
        this.escapeDriveQueryValue_(
          options.nameExact
        ) +
        "'"
      );
    } else if (options.nameContains) {
      parts.push(
        "title contains '" +
        this.escapeDriveQueryValue_(
          options.nameContains
        ) +
        "'"
      );
    }

    return parts.length
      ? parts.join(' and ')
      : 'trashed = false';
  },


  /************************************************************************************************
   * FILTRES FICHIER
   ************************************************************************************************/
  matchesFile_: function(file, options) {
    var name = file.getName();
    var normalizedName =
      options.caseSensitive
        ? name
        : name.toLowerCase();

    if (options.nameExact) {
      var exact = options.caseSensitive
        ? options.nameExact
        : options.nameExact.toLowerCase();

      if (normalizedName !== exact) {
        return false;
      }
    }

    if (options.nameContains) {
      var contains = options.caseSensitive
        ? options.nameContains
        : options.nameContains.toLowerCase();

      if (
        normalizedName.indexOf(
          contains
        ) === -1
      ) {
        return false;
      }
    }

    if (options.nameStartsWith) {
      var starts = options.caseSensitive
        ? options.nameStartsWith
        : options.nameStartsWith.toLowerCase();

      if (
        normalizedName.indexOf(starts) !== 0
      ) {
        return false;
      }
    }

    if (options.nameEndsWith) {
      var ends = options.caseSensitive
        ? options.nameEndsWith
        : options.nameEndsWith.toLowerCase();

      if (
        normalizedName.length < ends.length ||
        normalizedName.slice(-ends.length) !== ends
      ) {
        return false;
      }
    }

    var extension =
      this.getExtension_(name);

    if (
      options.extensions.length &&
      options.extensions.indexOf(
        extension
      ) === -1
    ) {
      return false;
    }

    var mimeType = '';

    try {
      mimeType = file.getMimeType() || '';
    } catch (ignoredMime) {}

    if (
      options.mimeTypes.length &&
      options.mimeTypes.indexOf(
        mimeType
      ) === -1
    ) {
      return false;
    }

    if (
      !options.includeShortcuts &&
      mimeType ===
        'application/vnd.google-apps.shortcut'
    ) {
      return false;
    }

    var size = this.getFileSize_(file);

    if (
      options.minSizeBytes !== null &&
      size < options.minSizeBytes
    ) {
      return false;
    }

    if (
      options.maxSizeBytes !== null &&
      size > options.maxSizeBytes
    ) {
      return false;
    }

    var createdAt =
      this.safeDate_(
        function() {
          return file.getDateCreated();
        }
      );

    var modifiedAt =
      this.safeDate_(
        function() {
          return file.getLastUpdated();
        }
      );

    if (
      !this.matchesDateRange_(
        createdAt,
        options.createdAfter,
        options.createdBefore
      )
    ) {
      return false;
    }

    if (
      !this.matchesDateRange_(
        modifiedAt,
        options.modifiedAfter,
        options.modifiedBefore
      )
    ) {
      return false;
    }

    if (!options.includeTrashed) {
      try {
        if (file.isTrashed()) {
          return false;
        }
      } catch (ignoredTrash) {}
    }

    return true;
  },


  /************************************************************************************************
   * FILTRES DOSSIER
   ************************************************************************************************/
  matchesFolder_: function(folder, options) {
    var name = folder.getName();
    var normalizedName =
      options.caseSensitive
        ? name
        : name.toLowerCase();

    if (options.nameExact) {
      var exact = options.caseSensitive
        ? options.nameExact
        : options.nameExact.toLowerCase();

      if (normalizedName !== exact) {
        return false;
      }
    }

    if (options.nameContains) {
      var contains = options.caseSensitive
        ? options.nameContains
        : options.nameContains.toLowerCase();

      if (
        normalizedName.indexOf(
          contains
        ) === -1
      ) {
        return false;
      }
    }

    if (options.nameStartsWith) {
      var starts = options.caseSensitive
        ? options.nameStartsWith
        : options.nameStartsWith.toLowerCase();

      if (
        normalizedName.indexOf(starts) !== 0
      ) {
        return false;
      }
    }

    if (options.nameEndsWith) {
      var ends = options.caseSensitive
        ? options.nameEndsWith
        : options.nameEndsWith.toLowerCase();

      if (
        normalizedName.length < ends.length ||
        normalizedName.slice(-ends.length) !== ends
      ) {
        return false;
      }
    }

    var createdAt =
      this.safeDate_(
        function() {
          return typeof folder.getDateCreated === 'function'
            ? folder.getDateCreated()
            : null;
        }
      );

    var modifiedAt =
      this.safeDate_(
        function() {
          return typeof folder.getLastUpdated === 'function'
            ? folder.getLastUpdated()
            : null;
        }
      );

    if (
      !this.matchesDateRange_(
        createdAt,
        options.createdAfter,
        options.createdBefore
      )
    ) {
      return false;
    }

    if (
      !this.matchesDateRange_(
        modifiedAt,
        options.modifiedAfter,
        options.modifiedBefore
      )
    ) {
      return false;
    }

    if (!options.includeTrashed) {
      try {
        if (
          typeof folder.isTrashed === 'function' &&
          folder.isTrashed()
        ) {
          return false;
        }
      } catch (ignoredTrash) {}
    }

    return true;
  },


  /************************************************************************************************
   * FICHIER -> OBJET UI
   ************************************************************************************************/
  fileToRow_: function(file, knownParentFolder, options) {
    var name = file.getName();
    var size = this.getFileSize_(file);
    var mimeType = '';

    try {
      mimeType = file.getMimeType() || '';
    } catch (ignoredMime) {}

    var parent = knownParentFolder
      ? {
          id: knownParentFolder.getId(),
          name: knownParentFolder.getName()
        }
      : this.getFirstParentInfo_(file);

    var owner = this.getOwnerInfo_(file);

    var createdAt =
      this.safeDate_(
        function() {
          return file.getDateCreated();
        }
      );

    var modifiedAt =
      this.safeDate_(
        function() {
          return file.getLastUpdated();
        }
      );

    return {
      id: file.getId(),
      type: this.TYPE_FILE_,
      name: name,
      extension: this.getExtension_(name),
      mimeType: mimeType,
      size: size,
      sizeFormatted: this.formatBytes_(size),
      createdAt: this.dateToIso_(createdAt),
      modifiedAt: this.dateToIso_(modifiedAt),
      parentId: parent.id,
      parentName: parent.name,
      ownerName: owner.name,
      ownerEmail: owner.email,
      starred: this.safeBooleanCall_(
        function() {
          return file.isStarred();
        }
      ),
      trashed: this.safeBooleanCall_(
        function() {
          return file.isTrashed();
        }
      ),
      url: this.safeStringCall_(
        function() {
          return file.getUrl();
        },
        'https://drive.google.com/open?id=' +
          file.getId()
      )
    };
  },


  /************************************************************************************************
   * DOSSIER -> OBJET UI
   ************************************************************************************************/
  folderToRow_: function(folder, knownParentFolder, options) {
    var parent = knownParentFolder
      ? {
          id: knownParentFolder.getId(),
          name: knownParentFolder.getName()
        }
      : this.getFirstParentInfo_(folder);

    var createdAt =
      this.safeDate_(
        function() {
          return typeof folder.getDateCreated === 'function'
            ? folder.getDateCreated()
            : null;
        }
      );

    var modifiedAt =
      this.safeDate_(
        function() {
          return typeof folder.getLastUpdated === 'function'
            ? folder.getLastUpdated()
            : null;
        }
      );

    return {
      id: folder.getId(),
      type: this.TYPE_FOLDER_,
      name: folder.getName(),
      extension: '',
      mimeType: 'application/vnd.google-apps.folder',
      size: 0,
      sizeFormatted: '0 o',
      createdAt: this.dateToIso_(createdAt),
      modifiedAt: this.dateToIso_(modifiedAt),
      parentId: parent.id,
      parentName: parent.name,
      ownerName: '',
      ownerEmail: '',
      starred: this.safeBooleanCall_(
        function() {
          return typeof folder.isStarred === 'function'
            ? folder.isStarred()
            : false;
        }
      ),
      trashed: this.safeBooleanCall_(
        function() {
          return typeof folder.isTrashed === 'function'
            ? folder.isTrashed()
            : false;
        }
      ),
      url: this.safeStringCall_(
        function() {
          return typeof folder.getUrl === 'function'
            ? folder.getUrl()
            : '';
        },
        'https://drive.google.com/drive/folders/' +
          folder.getId()
      )
    };
  },


  /************************************************************************************************
   * NORMALISATION DES OPTIONS
   ************************************************************************************************/
  normalizeOptions_: function(options) {
    options = this.cloneObject_(options || {});

    var folderId = this.extractDriveId_(
      options.folderId ||
      options.sourceFolderId ||
      ''
    );

    var includeFiles =
      typeof options.includeFiles ===
      'undefined'
        ? true
        : this.toBoolean_(
            options.includeFiles,
            true
          );

    var includeFolders =
      typeof options.includeFolders ===
      'undefined'
        ? true
        : this.toBoolean_(
            options.includeFolders,
            true
          );

    var recursive =
      typeof options.recursive ===
      'undefined'
        ? true
        : this.toBoolean_(
            options.recursive,
            true
          );

    var limit = this.toPositiveInteger_(
      options.limit ||
      options.maxResults,
      this.getConfigNumber_(
        'SEARCH.MAX_RESULTS',
        this.DEFAULT_LIMIT_
      )
    );

    limit = Math.min(
      Math.max(1, limit),
      this.MAX_LIMIT_
    );

    var maxScanned =
      this.toPositiveInteger_(
        options.maxScanned ||
        options.scanLimit,
        this.getConfigNumber_(
          'RUNTIME.MAX_SCAN_ITEMS_PER_RUN',
          this.DEFAULT_MAX_SCANNED_
        )
      );

    maxScanned = Math.min(
      Math.max(limit, maxScanned),
      this.MAX_SCANNED_
    );

    var maxRuntimeMs =
      this.toPositiveInteger_(
        options.maxRuntimeMs,
        this.DEFAULT_RUNTIME_MS_
      );

    maxRuntimeMs = Math.min(
      Math.max(1000, maxRuntimeMs),
      this.MAX_RUNTIME_MS_
    );

    var minSizeBytes =
      this.normalizeSizeBytes_(
        options.minSizeBytes,
        options.minSizeMb
      );

    var maxSizeBytes =
      this.normalizeSizeBytes_(
        options.maxSizeBytes,
        options.maxSizeMb
      );

    var sortBy =
      this.normalizeString_(
        options.sortBy ||
        'name'
      );

    var sortDirection =
      this.normalizeString_(
        options.sortDirection ||
        options.direction ||
        'ASC'
      ).toUpperCase();

    if (
      sortDirection !== 'DESC'
    ) {
      sortDirection = 'ASC';
    }

    return {
      folderId: folderId,
      recursive: recursive,
      includeFiles: includeFiles,
      includeFolders: includeFolders,
      includeTrashed: this.toBoolean_(
        options.includeTrashed,
        false
      ),
      includeShortcuts:
        typeof options.includeShortcuts ===
        'undefined'
          ? true
          : this.toBoolean_(
              options.includeShortcuts,
              true
            ),
      caseSensitive: this.toBoolean_(
        options.caseSensitive,
        false
      ),
      nameExact: this.normalizeString_(
        options.nameExact ||
        (
          this.toBoolean_(
            options.exactName,
            false
          )
            ? options.name
            : ''
        )
      ),
      nameContains: this.normalizeString_(
        options.nameContains ||
        options.text ||
        options.query ||
        (
          !this.toBoolean_(
            options.exactName,
            false
          )
            ? options.name
            : ''
        ) ||
        ''
      ),
      nameStartsWith: this.normalizeString_(
        options.nameStartsWith || ''
      ),
      nameEndsWith: this.normalizeString_(
        options.nameEndsWith || ''
      ),
      extensions: this.normalizeExtensions_(
        options.extensions ||
        options.extension ||
        options.ext ||
        []
      ),
      mimeTypes: this.normalizeStrings_(
        options.mimeTypes ||
        options.mimeType ||
        [],
        true
      ),
      minSizeBytes: minSizeBytes,
      maxSizeBytes: maxSizeBytes,
      createdAfter: this.normalizeDate_(
        options.createdAfter ||
        options.createdFrom
      ),
      createdBefore: this.normalizeDate_(
        options.createdBefore ||
        options.createdTo
      ),
      modifiedAfter: this.normalizeDate_(
        options.modifiedAfter ||
        options.modifiedFrom
      ),
      modifiedBefore: this.normalizeDate_(
        options.modifiedBefore ||
        options.modifiedTo
      ),
      limit: limit,
      maxScanned: maxScanned,
      maxRuntimeMs: maxRuntimeMs,
      maxDepth: Math.min(
        this.toPositiveInteger_(
          options.maxDepth,
          this.DEFAULT_MAX_DEPTH_
        ),
        this.DEFAULT_MAX_DEPTH_
      ),
      sortBy: sortBy,
      sortDirection: sortDirection,
      resume:
        options.resume &&
        typeof options.resume === 'object'
          ? options.resume
          : null
    };
  },


  /************************************************************************************************
   * RÉSUMÉ
   ************************************************************************************************/
  buildSummary_: function(rows) {
    rows = rows || [];

    var files = 0;
    var folders = 0;
    var bytes = 0;
    var byExtension = {};
    var byMime = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};

      if (row.type === this.TYPE_FOLDER_) {
        folders++;
      } else {
        files++;
        bytes += Number(row.size || 0);

        var ext = row.extension || '(sans extension)';
        byExtension[ext] =
          Number(byExtension[ext] || 0) + 1;

        var mime = row.mimeType || '(inconnu)';
        byMime[mime] =
          Number(byMime[mime] || 0) + 1;
      }
    }

    return {
      files: files,
      folders: folders,
      total: files + folders,
      totalBytes: bytes,
      totalSizeFormatted:
        this.formatBytes_(bytes),
      byExtension: byExtension,
      byMime: byMime
    };
  },


  /************************************************************************************************
   * TRI
   ************************************************************************************************/
  sortRows_: function(rows, sortBy, direction) {
    rows = (rows || []).slice();

    sortBy =
      this.normalizeString_(sortBy) ||
      'name';

    direction =
      this.normalizeString_(direction).toUpperCase() ===
      'DESC'
        ? -1
        : 1;

    rows.sort(
      function(a, b) {
        var av = a ? a[sortBy] : '';
        var bv = b ? b[sortBy] : '';

        if (
          sortBy === 'size'
        ) {
          av = Number(av || 0);
          bv = Number(bv || 0);

          if (av < bv) return -1 * direction;
          if (av > bv) return 1 * direction;
          return 0;
        }

        if (
          sortBy === 'createdAt' ||
          sortBy === 'modifiedAt'
        ) {
          av = av
            ? new Date(av).getTime()
            : 0;
          bv = bv
            ? new Date(bv).getTime()
            : 0;

          if (av < bv) return -1 * direction;
          if (av > bv) return 1 * direction;
          return 0;
        }

        av = String(av || '').toLowerCase();
        bv = String(bv || '').toLowerCase();

        if (av < bv) return -1 * direction;
        if (av > bv) return 1 * direction;
        return 0;
      }
    );

    return rows;
  },


  /************************************************************************************************
   * DESCRIPTION DE LA RECHERCHE
   ************************************************************************************************/
  describeQuery_: function(options) {
    return {
      nameExact: options.nameExact,
      nameContains: options.nameContains,
      nameStartsWith: options.nameStartsWith,
      nameEndsWith: options.nameEndsWith,
      extensions: options.extensions.slice(),
      mimeTypes: options.mimeTypes.slice(),
      minSizeBytes: options.minSizeBytes,
      maxSizeBytes: options.maxSizeBytes,
      createdAfter: this.dateToIso_(
        options.createdAfter
      ),
      createdBefore: this.dateToIso_(
        options.createdBefore
      ),
      modifiedAfter: this.dateToIso_(
        options.modifiedAfter
      ),
      modifiedBefore: this.dateToIso_(
        options.modifiedBefore
      ),
      includeFiles: options.includeFiles,
      includeFolders: options.includeFolders,
      includeTrashed: options.includeTrashed,
      includeShortcuts: options.includeShortcuts,
      caseSensitive: options.caseSensitive,
      limit: options.limit,
      maxScanned: options.maxScanned,
      maxDepth: options.maxDepth,
      sortBy: options.sortBy,
      sortDirection: options.sortDirection
    };
  },


  /************************************************************************************************
   * RÉSULTAT VIDE
   ************************************************************************************************/
  buildEmptyResult_: function(options, message) {
    return {
      ok: true,
      module: this.MODULE_NAME_,
      scope: options.folderId
        ? 'FOLDER'
        : 'GLOBAL',
      folderId: options.folderId || '',
      recursive: options.recursive,
      query: this.describeQuery_(options),
      scanned: 0,
      scannedFiles: 0,
      scannedFolders: 0,
      matched: 0,
      matchedFiles: 0,
      matchedFolders: 0,
      returned: 0,
      truncated: false,
      stoppedByTime: false,
      stoppedByScanLimit: false,
      continuation: null,
      message: message || '',
      rows: [],
      summary: {
        files: 0,
        folders: 0,
        total: 0,
        totalBytes: 0,
        totalSizeFormatted: '0 o',
        byExtension: {},
        byMime: {}
      },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0
    };
  },


  /************************************************************************************************
   * PARENT
   ************************************************************************************************/
  getFirstParentInfo_: function(item) {
    try {
      var parents = item.getParents();

      if (parents.hasNext()) {
        var parent = parents.next();

        return {
          id: parent.getId(),
          name: parent.getName()
        };
      }
    } catch (ignored) {}

    return {
      id: '',
      name: ''
    };
  },


  /************************************************************************************************
   * PROPRIÉTAIRE
   ************************************************************************************************/
  getOwnerInfo_: function(file) {
    try {
      var owner = file.getOwner();

      if (!owner) {
        return {
          name: '',
          email: ''
        };
      }

      return {
        name:
          this.safeStringCall_(
            function() {
              return owner.getName();
            },
            ''
          ),
        email:
          this.safeStringCall_(
            function() {
              return owner.getEmail();
            },
            ''
          )
      };
    } catch (ignored) {
      return {
        name: '',
        email: ''
      };
    }
  },


  /************************************************************************************************
   * DATE RANGE
   ************************************************************************************************/
  matchesDateRange_: function(value, after, before) {
    if (!after && !before) {
      return true;
    }

    if (!value) {
      return false;
    }

    var time = value.getTime();

    if (
      after &&
      time < after.getTime()
    ) {
      return false;
    }

    if (
      before &&
      time > before.getTime()
    ) {
      return false;
    }

    return true;
  },


  /************************************************************************************************
   * DATES
   ************************************************************************************************/
  normalizeDate_: function(value) {
    if (!value) {
      return null;
    }

    if (
      Object.prototype.toString.call(value) ===
      '[object Date]'
    ) {
      return isNaN(value.getTime())
        ? null
        : new Date(value.getTime());
    }

    var date = new Date(value);

    return isNaN(date.getTime())
      ? null
      : date;
  },


  safeDate_: function(fn) {
    try {
      var value = fn();

      if (!value) {
        return null;
      }

      var date =
        Object.prototype.toString.call(value) ===
        '[object Date]'
          ? value
          : new Date(value);

      return isNaN(date.getTime())
        ? null
        : date;
    } catch (ignored) {
      return null;
    }
  },


  dateToIso_: function(date) {
    if (!date) {
      return '';
    }

    try {
      return date.toISOString();
    } catch (ignored) {
      return '';
    }
  },


  /************************************************************************************************
   * TAILLE
   ************************************************************************************************/
  getFileSize_: function(file) {
    try {
      var size = Number(
        file.getSize()
      );

      return isFinite(size) && size > 0
        ? size
        : 0;
    } catch (ignored) {
      return 0;
    }
  },


  normalizeSizeBytes_: function(bytes, megabytes) {
    if (
      bytes !== null &&
      typeof bytes !== 'undefined' &&
      bytes !== ''
    ) {
      var value = Number(bytes);

      if (
        isFinite(value) &&
        value >= 0
      ) {
        return Math.floor(value);
      }
    }

    if (
      megabytes !== null &&
      typeof megabytes !== 'undefined' &&
      megabytes !== ''
    ) {
      var mb = Number(megabytes);

      if (
        isFinite(mb) &&
        mb >= 0
      ) {
        return Math.floor(
          mb * 1024 * 1024
        );
      }
    }

    return null;
  },


  formatBytes_: function(bytes) {
    bytes = Number(bytes || 0);

    if (
      typeof GDM_Utils !== 'undefined' &&
      GDM_Utils &&
      typeof GDM_Utils.formatBytes === 'function'
    ) {
      try {
        return GDM_Utils.formatBytes(bytes);
      } catch (ignored) {}
    }

    if (!isFinite(bytes) || bytes <= 0) {
      return '0 o';
    }

    var units = [
      'o',
      'Ko',
      'Mo',
      'Go',
      'To',
      'Po'
    ];

    var index = Math.floor(
      Math.log(bytes) /
      Math.log(1024)
    );

    index = Math.min(
      Math.max(index, 0),
      units.length - 1
    );

    var value =
      bytes /
      Math.pow(1024, index);

    return (
      Math.round(value * 100) /
      100
    ) + ' ' + units[index];
  },


  /************************************************************************************************
   * EXTENSIONS
   ************************************************************************************************/
  getExtension_: function(name) {
    name = String(name || '');

    var index = name.lastIndexOf('.');

    if (
      index <= 0 ||
      index === name.length - 1
    ) {
      return '';
    }

    return name
      .slice(index + 1)
      .trim()
      .toLowerCase();
  },


  normalizeExtension_: function(value) {
    value = this.normalizeString_(value)
      .toLowerCase();

    while (
      value.indexOf('.') === 0
    ) {
      value = value.slice(1);
    }

    return value.trim();
  },


  normalizeExtensions_: function(value) {
    var list = this.ensureArray_(value);
    var result = [];
    var seen = {};

    for (var i = 0; i < list.length; i++) {
      var ext = this.normalizeExtension_(
        list[i]
      );

      if (!ext || seen[ext]) {
        continue;
      }

      seen[ext] = true;
      result.push(ext);
    }

    return result;
  },


  /************************************************************************************************
   * CHAÎNES
   ************************************************************************************************/
  normalizeStrings_: function(value, caseSensitive) {
    var list = this.ensureArray_(value);
    var result = [];
    var seen = {};

    for (var i = 0; i < list.length; i++) {
      var item = this.normalizeString_(
        list[i]
      );

      if (!item) {
        continue;
      }

      var key = caseSensitive
        ? item
        : item.toLowerCase();

      if (seen[key]) {
        continue;
      }

      seen[key] = true;
      result.push(item);
    }

    return result;
  },


  normalizeString_: function(value) {
    if (
      value === null ||
      typeof value === 'undefined'
    ) {
      return '';
    }

    return String(value).trim();
  },


  /************************************************************************************************
   * ID GOOGLE DRIVE
   ************************************************************************************************/
  extractDriveId_: function(value) {
    value = this.normalizeString_(value);

    if (!value) {
      return '';
    }

    var match = value.match(
      /[-\w]{20,}/
    );

    return match
      ? match[0]
      : value;
  },


  /************************************************************************************************
   * QUERY ESCAPE
   ************************************************************************************************/
  escapeDriveQueryValue_: function(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
  },


  /************************************************************************************************
   * CONTINUATION TOKEN
   ************************************************************************************************/
  safeContinuationToken_: function(iterator) {
    try {
      return iterator.getContinuationToken();
    } catch (ignored) {
      return '';
    }
  },


  /************************************************************************************************
   * RUNTIME
   ************************************************************************************************/
  runtimeExpired_: function(startMs, maxRuntimeMs) {
    return (
      Date.now() - startMs >=
      maxRuntimeMs
    );
  },


  /************************************************************************************************
   * CONFIG
   ************************************************************************************************/
  getConfigNumber_: function(path, fallback) {
    if (
      typeof GDM_Config !== 'undefined' &&
      GDM_Config &&
      typeof GDM_Config.get === 'function'
    ) {
      try {
        var value = Number(
          GDM_Config.get(
            path,
            fallback
          )
        );

        if (
          isFinite(value) &&
          value > 0
        ) {
          return value;
        }
      } catch (ignored) {}
    }

    return fallback;
  },


  /************************************************************************************************
   * CONVERSIONS
   ************************************************************************************************/
  toBoolean_: function(value, fallback) {
    if (
      typeof value === 'boolean'
    ) {
      return value;
    }

    if (
      value === null ||
      typeof value === 'undefined' ||
      value === ''
    ) {
      return !!fallback;
    }

    var text = String(value)
      .trim()
      .toLowerCase();

    if (
      text === 'true' ||
      text === '1' ||
      text === 'yes' ||
      text === 'oui' ||
      text === 'on'
    ) {
      return true;
    }

    if (
      text === 'false' ||
      text === '0' ||
      text === 'no' ||
      text === 'non' ||
      text === 'off'
    ) {
      return false;
    }

    return !!fallback;
  },


  toPositiveInteger_: function(value, fallback) {
    value = Number(value);

    if (
      !isFinite(value) ||
      value <= 0
    ) {
      return Math.max(
        1,
        Math.floor(
          Number(fallback) || 1
        )
      );
    }

    return Math.max(
      1,
      Math.floor(value)
    );
  },


  toPositiveNumber_: function(value, fallback) {
    value = Number(value);

    if (
      !isFinite(value) ||
      value <= 0
    ) {
      value = Number(fallback);
    }

    if (
      !isFinite(value) ||
      value <= 0
    ) {
      return 1;
    }

    return value;
  },


  /************************************************************************************************
   * ARRAYS / OBJETS
   ************************************************************************************************/
  ensureArray_: function(value) {
    if (
      value === null ||
      typeof value === 'undefined' ||
      value === ''
    ) {
      return [];
    }

    if (Array.isArray(value)) {
      return value.slice();
    }

    if (
      typeof value === 'string' &&
      value.indexOf(',') !== -1
    ) {
      return value.split(',');
    }

    return [value];
  },


  cloneObject_: function(value) {
    var clone = {};

    value = value || {};

    for (var key in value) {
      if (
        Object.prototype.hasOwnProperty.call(
          value,
          key
        )
      ) {
        clone[key] = value[key];
      }
    }

    return clone;
  },


  /************************************************************************************************
   * SAFE CALLS
   ************************************************************************************************/
  safeBooleanCall_: function(fn) {
    try {
      return fn() === true;
    } catch (ignored) {
      return false;
    }
  },


  safeStringCall_: function(fn, fallback) {
    try {
      var value = fn();

      return value === null ||
        typeof value === 'undefined'
          ? String(fallback || '')
          : String(value);
    } catch (ignored) {
      return String(fallback || '');
    }
  }
});


/**************************************************************************************************
 * API GLOBALE POUR google.script.run
 **************************************************************************************************/

function GDM_search(options) {
  return GDM_Search.search(
    options || {}
  );
}


function GDM_searchFiles(options) {
  return GDM_Search.searchFiles(
    options || {}
  );
}


function GDM_searchFolders(options) {
  return GDM_Search.searchFolders(
    options || {}
  );
}


function GDM_quickSearch(text, options) {
  return GDM_Search.quickSearch(
    text,
    options || {}
  );
}


function GDM_findByName(name, options) {
  return GDM_Search.findByName(
    name,
    options || {}
  );
}


function GDM_findByExtension(extension, options) {
  return GDM_Search.findByExtension(
    extension,
    options || {}
  );
}


function GDM_findLargeFiles(options) {
  return GDM_Search.findLargeFiles(
    options || {}
  );
}


function GDM_findOldFiles(options) {
  return GDM_Search.findOldFiles(
    options || {}
  );
}
