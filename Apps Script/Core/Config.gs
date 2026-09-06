/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Config.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Configuration centrale et unique de Google Drive Manager PRO V2.
 *
 * IMPORTANT
 * ---------
 * - Architecture du projet figée.
 * - Ce fichier ne contient aucune logique métier.
 * - Aucun module ne doit recréer ses propres constantes globales.
 * - Les traitements lourds doivent respecter les limites définies ici.
 * - Conçu pour les gros Google Drive et une consommation mémoire réduite.
 * - Aucune suppression automatique de fichier.
 **************************************************************************************************/

'use strict';


/**************************************************************************************************
 * IDENTITÉ DE L'APPLICATION
 **************************************************************************************************/

const GDM_APP = Object.freeze({
  NAME: 'Google Drive Manager PRO',
  SHORT_NAME: 'GDM PRO',
  VERSION: '2.0.0',
  MAJOR_VERSION: 2,
  BUILD_DATE: '2026-09-06',
  ENVIRONMENT: 'production'
});


/**************************************************************************************************
 * STATUTS STANDARD DES JOBS
 **************************************************************************************************/

const GDM_JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR'
});


/**************************************************************************************************
 * STATUTS DES TÂCHES DE QUEUE
 **************************************************************************************************/

const GDM_QUEUE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
  ERROR: 'ERROR',
  CANCELLED: 'CANCELLED'
});


/**************************************************************************************************
 * MODULES OFFICIELS
 **************************************************************************************************/

const GDM_MODULES = Object.freeze({
  EXPLORER: 'Explorer',
  ANALYSIS: 'Analysis',
  MOVE: 'Move',
  COPY: 'Copy',
  DUPLICATES: 'Duplicates',
  ARCHIVE: 'Archive',
  RENAME: 'Rename',
  FOLDER_TOOLS: 'FolderTools'
});


/**************************************************************************************************
 * ACTIONS OFFICIELLES
 **************************************************************************************************/

const GDM_ACTIONS = Object.freeze({

  // Explorer
  EXPLORE_FOLDER: 'EXPLORE_FOLDER',
  GET_FOLDER_INFO: 'GET_FOLDER_INFO',
  GET_FOLDER_CHILDREN: 'GET_FOLDER_CHILDREN',

  // Analysis
  ANALYZE_DRIVE: 'ANALYZE_DRIVE',
  ANALYZE_FOLDER: 'ANALYZE_FOLDER',
  ANALYZE_ITEM: 'ANALYZE_ITEM',

  // Move
  MOVE_FILE: 'MOVE_FILE',
  MOVE_FOLDER: 'MOVE_FOLDER',
  CLASSIFY_FILE: 'CLASSIFY_FILE',

  // Copy
  COPY_FILE: 'COPY_FILE',
  COPY_FOLDER: 'COPY_FOLDER',

  // Duplicates
  FIND_DUPLICATES: 'FIND_DUPLICATES',
  INDEX_DUPLICATE: 'INDEX_DUPLICATE',

  // Archive
  ARCHIVE_FILE: 'ARCHIVE_FILE',

  // Rename
  RENAME_FILE: 'RENAME_FILE',
  RENAME_FOLDER: 'RENAME_FOLDER',

  // FolderTools
  CREATE_FOLDER: 'CREATE_FOLDER',
  CREATE_FOLDER_TREE: 'CREATE_FOLDER_TREE'
});


/**************************************************************************************************
 * TYPES MIME GOOGLE
 **************************************************************************************************/

const GDM_MIME = Object.freeze({

  FOLDER: 'application/vnd.google-apps.folder',
  SHORTCUT: 'application/vnd.google-apps.shortcut',

  GOOGLE_DOC: 'application/vnd.google-apps.document',
  GOOGLE_SHEET: 'application/vnd.google-apps.spreadsheet',
  GOOGLE_SLIDE: 'application/vnd.google-apps.presentation',
  GOOGLE_FORM: 'application/vnd.google-apps.form',
  GOOGLE_DRAWING: 'application/vnd.google-apps.drawing',
  GOOGLE_SCRIPT: 'application/vnd.google-apps.script',
  GOOGLE_SITE: 'application/vnd.google-apps.site',

  PDF: 'application/pdf',

  ZIP: 'application/zip',
  RAR: 'application/vnd.rar',
  SEVEN_ZIP: 'application/x-7z-compressed',

  CSV: 'text/csv',
  TXT: 'text/plain',

  JPEG: 'image/jpeg',
  PNG: 'image/png',
  GIF: 'image/gif',
  WEBP: 'image/webp',

  MP4: 'video/mp4',
  MPEG: 'video/mpeg',

  MP3: 'audio/mpeg',

  DOC: 'application/msword',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',

  XLS: 'application/vnd.ms-excel',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  PPT: 'application/vnd.ms-powerpoint',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
});


/**************************************************************************************************
 * CONFIGURATION GLOBALE
 **************************************************************************************************/

const GDM_CONFIG = Object.freeze({

  /**********************************************************************************************
   * APPLICATION
   **********************************************************************************************/

  APP: Object.freeze({
    NAME: GDM_APP.NAME,
    VERSION: GDM_APP.VERSION,

    TIMEZONE: 'Europe/Brussels',

    ROOT_LABEL: 'Mon Drive',

    DEBUG: false,

    ENABLE_CONSOLE_LOG: true,

    SAFE_MODE: true,

    // Aucune suppression automatique dans PRO V2.
    ALLOW_AUTOMATIC_DELETE: false
  }),


  /**********************************************************************************************
   * EXÉCUTION APPS SCRIPT
   *
   * On arrête volontairement le travail avant la limite Apps Script afin de pouvoir
   * enregistrer proprement State + Queue.
   **********************************************************************************************/

  RUNTIME: Object.freeze({

    // 4 min 30 maximum de travail demandé à notre moteur.
    MAX_EXECUTION_MS: 270000,

    // Le moteur commence à se fermer proprement avant cette limite.
    SOFT_STOP_MS: 240000,

    // Marge de sécurité.
    SAFETY_MARGIN_MS: 30000,

    // Pause minimale entre certaines reprises automatiques.
    RESUME_DELAY_MS: 5000,

    // Nombre maximum de tâches métier exécutées pendant un passage Engine.
    MAX_TASKS_PER_RUN: 250,

    // Nombre maximum d'éléments explorés dans une exécution.
    MAX_SCAN_ITEMS_PER_RUN: 5000,

    // Sauvegarde de progression périodique.
    STATE_SAVE_EVERY_ITEMS: 25,

    // Vérification d'annulation.
    CANCEL_CHECK_EVERY_ITEMS: 10,

    // Flush des logs.
    LOG_FLUSH_EVERY_ITEMS: 25
  }),


  /**********************************************************************************************
   * QUEUE
   **********************************************************************************************/

  QUEUE: Object.freeze({

    MAX_ITEMS_PER_BATCH: 250,

    MAX_ITEMS_PER_RUN: 250,

    PROPERTY_CHUNK_SIZE: 7000,

    MAX_RETRIES: 3,

    RETRY_DELAY_MS: 1000,

    AUTO_RESUME: true,

    AUTO_RESUME_DELAY_MS: 5000,

    KEEP_COMPLETED_TASKS: false,

    KEEP_ERROR_TASKS: true
  }),


  /**********************************************************************************************
   * EXPLORER
   **********************************************************************************************/

  EXPLORER: Object.freeze({

    MAX_FOLDERS_RETURNED: 1000,

    MAX_FILES_RETURNED: 1000,

    SORT_FOLDERS: true,

    SORT_FILES: true,

    INCLUDE_TRASHED: false,

    INCLUDE_FILES_BY_DEFAULT: true,

    INCLUDE_FOLDERS_BY_DEFAULT: true
  }),


  /**********************************************************************************************
   * ANALYSE
   **********************************************************************************************/

  ANALYSIS: Object.freeze({

    LARGE_FILE_MB: 100,

    OLD_FILE_DAYS: 365,

    TOP_FILES: 200,

    BUFFER_SIZE: 300,

    BATCH_SIZE: 250,

    MAX_ITEMS_PER_RUN: 5000,

    INCLUDE_SUBFOLDERS_DEFAULT: true,

    DETECT_EMPTY_FOLDERS: true,

    DETECT_SHORTCUTS: true,

    DETECT_NO_EXTENSION: true,

    DETECT_LARGE_FILES: true,

    DETECT_OLD_FILES: true,

    GROUP_BY_EXTENSION: true,

    GROUP_BY_MIME: true
  }),


  /**********************************************************************************************
   * DÉPLACEMENT / CLASSEMENT
   **********************************************************************************************/

  MOVE: Object.freeze({

    BATCH_SIZE: 100,

    MAX_MOVES_PER_RUN: 250,

    MAX_SCANNED_PER_RUN: 5000,

    PREVIEW_MAX_ROWS: 2000,

    INCLUDE_SUBFOLDERS_DEFAULT: true,

    CREATE_DESTINATION_FOLDERS: true,

    SKIP_IF_ALREADY_IN_DESTINATION: true,

    STOP_ON_ITEM_ERROR: false,

    ALLOW_FOLDER_MOVE: true,

    ALLOW_FILE_MOVE: true
  }),


  /**********************************************************************************************
   * COPIE
   **********************************************************************************************/

  COPY: Object.freeze({

    BATCH_SIZE: 75,

    MAX_COPIES_PER_RUN: 200,

    INCLUDE_SUBFOLDERS_DEFAULT: true,

    PRESERVE_STRUCTURE: true,

    CREATE_ROOT_FOLDER: true,

    STOP_ON_ITEM_ERROR: false,

    SKIP_UNREADABLE_FILES: true
  }),


  /**********************************************************************************************
   * DOUBLONS
   **********************************************************************************************/

  DUPLICATES: Object.freeze({

    BATCH_SIZE: 300,

    MAX_ITEMS_PER_RUN: 5000,

    DEFAULT_METHOD: 'NAME_SIZE',

    INCLUDE_SUBFOLDERS_DEFAULT: true,

    IGNORE_ZERO_BYTE_FILES: false,

    CASE_INSENSITIVE_NAMES: true,

    NORMALIZE_WHITESPACE: true,

    MAX_GROUPS_IN_RESULT: 5000,

    MAX_FILES_PER_GROUP: 500
  }),


  /**********************************************************************************************
   * ARCHIVAGE
   **********************************************************************************************/

  ARCHIVE: Object.freeze({

    DEFAULT_OLDER_THAN_DAYS: 365,

    BATCH_SIZE: 100,

    MAX_ARCHIVES_PER_RUN: 250,

    INCLUDE_SUBFOLDERS_DEFAULT: true,

    PRESERVE_STRUCTURE_DEFAULT: false,

    STOP_ON_ITEM_ERROR: false
  }),


  /**********************************************************************************************
   * RENOMMAGE
   **********************************************************************************************/

  RENAME: Object.freeze({

    BATCH_SIZE: 100,

    MAX_RENAMES_PER_RUN: 250,

    PREVIEW_MAX_ROWS: 2000,

    INCLUDE_SUBFOLDERS_DEFAULT: false,

    CASE_SENSITIVE_REPLACE: false,

    TRIM_NAMES: true,

    PREVENT_EMPTY_NAME: true,

    PREVENT_CONFLICTS: true,

    STOP_ON_ITEM_ERROR: false
  }),


  /**********************************************************************************************
   * OUTILS DOSSIERS
   **********************************************************************************************/

  FOLDER_TOOLS: Object.freeze({

    MAX_TREE_DEPTH: 50,

    MAX_FOLDERS_PER_OPERATION: 1000,

    DETECT_MOVE_LOOPS: true,

    PREVENT_MOVE_INTO_SELF: true,

    PREVENT_MOVE_INTO_DESCENDANT: true
  }),


  /**********************************************************************************************
   * LOGS
   **********************************************************************************************/

  LOG: Object.freeze({

    LEVELS: Object.freeze({
      DEBUG: 'DEBUG',
      INFO: 'INFO',
      WARN: 'WARN',
      ERROR: 'ERROR'
    }),

    EVENTS: Object.freeze({
      JOB_CREATED: 'JOB_CREATED',
      JOB_STARTED: 'JOB_STARTED',
      JOB_PAUSED: 'JOB_PAUSED',
      JOB_RESUMED: 'JOB_RESUMED',
      JOB_COMPLETED: 'JOB_COMPLETED',
      JOB_CANCELLED: 'JOB_CANCELLED',
      JOB_ERROR: 'JOB_ERROR',

      SCAN_STARTED: 'SCAN_STARTED',
      SCAN_COMPLETED: 'SCAN_COMPLETED',

      ITEM_PROCESSED: 'ITEM_PROCESSED',
      ITEM_SKIPPED: 'ITEM_SKIPPED',
      ITEM_ERROR: 'ITEM_ERROR',

      QUEUE_CREATED: 'QUEUE_CREATED',
      QUEUE_UPDATED: 'QUEUE_UPDATED',
      QUEUE_COMPLETED: 'QUEUE_COMPLETED'
    }),

    MAX_MEMORY_LOGS: 500,

    MAX_MESSAGE_LENGTH: 2000,

    STORE_IN_PROPERTIES: true,

    STORE_MAX_ENTRIES: 500,

    CONSOLE_ENABLED: true
  }),


  /**********************************************************************************************
   * STATE / PROPERTIES SERVICE
   **********************************************************************************************/

  STATE: Object.freeze({

    PREFIX: 'GDMV2_',

    PROPERTY_CHUNK_SIZE: 7000,

    MAX_CHUNKS: 100,

    AUTO_SAVE: true,

    SAVE_EVERY_ITEMS: 25,

    CLEAN_COMPLETED_JOBS_AFTER_DAYS: 30
  }),


  /**********************************************************************************************
   * CLÉS PROPERTIES SERVICE
   **********************************************************************************************/

  STORAGE_KEYS: Object.freeze({

    CURRENT_JOB_ID: 'GDMV2_CURRENT_JOB_ID',

    JOB_PREFIX: 'GDMV2_JOB_',

    JOB_STATE_PREFIX: 'GDMV2_STATE_',

    QUEUE_PREFIX: 'GDMV2_QUEUE_',

    QUEUE_META_PREFIX: 'GDMV2_QUEUE_META_',

    LOG_PREFIX: 'GDMV2_LOG_',

    RESULT_PREFIX: 'GDMV2_RESULT_',

    TRIGGER_PREFIX: 'GDMV2_TRIGGER_',

    SETTINGS: 'GDMV2_SETTINGS'
  }),


  /**********************************************************************************************
   * LOCK SERVICE
   **********************************************************************************************/

  LOCK: Object.freeze({

    WAIT_TIMEOUT_MS: 10000,

    ENGINE_LOCK_TIMEOUT_MS: 5000,

    STATE_LOCK_TIMEOUT_MS: 5000
  }),


  /**********************************************************************************************
   * DÉCLENCHEURS
   **********************************************************************************************/

  TRIGGERS: Object.freeze({

    ENABLED: true,

    HANDLER_FUNCTION: 'GDM_engineTrigger',

    RESUME_DELAY_MS: 5000,

    DELETE_OLD_TRIGGER_BEFORE_CREATE: true,

    MAX_PROJECT_TRIGGERS: 15
  }),


  /**********************************************************************************************
   * TYPES DE FICHIERS UTILISÉS POUR LE CLASSEMENT
   **********************************************************************************************/

  FILE_CATEGORIES: Object.freeze({

    PDF: Object.freeze({
      LABEL: 'PDF',
      FOLDER: 'PDF',
      EXTENSIONS: ['pdf']
    }),

    IMAGES: Object.freeze({
      LABEL: 'Images',
      FOLDER: 'Images',
      EXTENSIONS: [
        'jpg',
        'jpeg',
        'png',
        'gif',
        'bmp',
        'tif',
        'tiff',
        'webp',
        'heic',
        'svg'
      ]
    }),

    EXCEL: Object.freeze({
      LABEL: 'Excel',
      FOLDER: 'Excel',
      EXTENSIONS: [
        'xls',
        'xlsx',
        'xlsm',
        'xlsb',
        'ods',
        'csv'
      ]
    }),

    WORD: Object.freeze({
      LABEL: 'Word',
      FOLDER: 'Word',
      EXTENSIONS: [
        'doc',
        'docx',
        'docm',
        'odt',
        'rtf'
      ]
    }),

    POWERPOINT: Object.freeze({
      LABEL: 'PowerPoint',
      FOLDER: 'PowerPoint',
      EXTENSIONS: [
        'ppt',
        'pptx',
        'pptm',
        'odp'
      ]
    }),

    ARCHIVES: Object.freeze({
      LABEL: 'Archives',
      FOLDER: 'Archives',
      EXTENSIONS: [
        'zip',
        'rar',
        '7z',
        'tar',
        'gz',
        'bz2'
      ]
    }),

    VIDEOS: Object.freeze({
      LABEL: 'Vidéos',
      FOLDER: 'Vidéos',
      EXTENSIONS: [
        'mp4',
        'mov',
        'avi',
        'mkv',
        'wmv',
        'mpeg',
        'mpg',
        'webm'
      ]
    }),

    AUDIO: Object.freeze({
      LABEL: 'Audio',
      FOLDER: 'Audio',
      EXTENSIONS: [
        'mp3',
        'wav',
        'aac',
        'flac',
        'm4a',
        'ogg',
        'wma'
      ]
    }),

    TEXT: Object.freeze({
      LABEL: 'Textes',
      FOLDER: 'Textes',
      EXTENSIONS: [
        'txt',
        'md',
        'log'
      ]
    }),

    CAD: Object.freeze({
      LABEL: 'CAO / Plans',
      FOLDER: 'Plans',
      EXTENSIONS: [
        'dwg',
        'dxf',
        'dws',
        'dwt',
        'ifc',
        'rvt',
        'skp'
      ]
    }),

    OTHER: Object.freeze({
      LABEL: 'Autres',
      FOLDER: 'Autres',
      EXTENSIONS: []
    })
  }),


  /**********************************************************************************************
   * GOOGLE WORKSPACE
   **********************************************************************************************/

  GOOGLE_TYPES: Object.freeze({

    DOCUMENT: Object.freeze({
      MIME: GDM_MIME.GOOGLE_DOC,
      LABEL: 'Google Docs'
    }),

    SPREADSHEET: Object.freeze({
      MIME: GDM_MIME.GOOGLE_SHEET,
      LABEL: 'Google Sheets'
    }),

    PRESENTATION: Object.freeze({
      MIME: GDM_MIME.GOOGLE_SLIDE,
      LABEL: 'Google Slides'
    }),

    FORM: Object.freeze({
      MIME: GDM_MIME.GOOGLE_FORM,
      LABEL: 'Google Forms'
    }),

    DRAWING: Object.freeze({
      MIME: GDM_MIME.GOOGLE_DRAWING,
      LABEL: 'Google Drawings'
    })
  }),


  /**********************************************************************************************
   * LIMITES D'AFFICHAGE UI
   **********************************************************************************************/

  UI: Object.freeze({

    FOLDER_PICKER_MAX_ITEMS: 1000,

    RESULT_PAGE_SIZE: 100,

    RESULT_MAX_ROWS: 5000,

    PREVIEW_MAX_ROWS: 2000,

    LOG_PAGE_SIZE: 100,

    POLL_INTERVAL_MS: 2000
  })
});


/**************************************************************************************************
 * API PUBLIQUE CONFIG
 *
 * Les autres fichiers utilisent :
 *
 * GDM_Config.get('ANALYSIS.LARGE_FILE_MB')
 * GDM_Config.get('RUNTIME.MAX_EXECUTION_MS')
 * GDM_Config.getSection('MOVE')
 * GDM_Config.getPublicConfig()
 **************************************************************************************************/

const GDM_Config = Object.freeze({

  /**
   * Retourne une valeur de configuration via un chemin.
   *
   * Exemple :
   * GDM_Config.get('ANALYSIS.LARGE_FILE_MB');
   */
  get: function(path, defaultValue) {

    if (!path) {
      return typeof defaultValue === 'undefined'
        ? null
        : defaultValue;
    }

    var parts = String(path).split('.');
    var current = GDM_CONFIG;

    for (var i = 0; i < parts.length; i++) {

      var key = parts[i];

      if (
        current === null ||
        typeof current === 'undefined' ||
        typeof current[key] === 'undefined'
      ) {
        return typeof defaultValue === 'undefined'
          ? null
          : defaultValue;
      }

      current = current[key];
    }

    return current;
  },


  /**
   * Retourne une section complète.
   */
  getSection: function(sectionName) {

    if (!sectionName) {
      return null;
    }

    var key = String(sectionName).trim().toUpperCase();

    return typeof GDM_CONFIG[key] === 'undefined'
      ? null
      : GDM_CONFIG[key];
  },


  /**
   * Retourne la configuration complète.
   */
  getAll: function() {
    return GDM_CONFIG;
  },


  /**
   * Retourne les informations de l'application.
   */
  getAppInfo: function() {

    return {
      name: GDM_APP.NAME,
      shortName: GDM_APP.SHORT_NAME,
      version: GDM_APP.VERSION,
      majorVersion: GDM_APP.MAJOR_VERSION,
      buildDate: GDM_APP.BUILD_DATE,
      environment: GDM_APP.ENVIRONMENT
    };
  },


  /**
   * Retourne la configuration pouvant être envoyée sans problème à l'interface HTML.
   */
  getPublicConfig: function() {

    return {
      app: this.getAppInfo(),

      analysis: {
        largeFileMB: GDM_CONFIG.ANALYSIS.LARGE_FILE_MB,
        oldFileDays: GDM_CONFIG.ANALYSIS.OLD_FILE_DAYS,
        recursive: GDM_CONFIG.ANALYSIS.INCLUDE_SUBFOLDERS_DEFAULT
      },

      move: {
        recursive: GDM_CONFIG.MOVE.INCLUDE_SUBFOLDERS_DEFAULT,
        previewMaxRows: GDM_CONFIG.MOVE.PREVIEW_MAX_ROWS
      },

      copy: {
        recursive: GDM_CONFIG.COPY.INCLUDE_SUBFOLDERS_DEFAULT
      },

      archive: {
        olderThanDays: GDM_CONFIG.ARCHIVE.DEFAULT_OLDER_THAN_DAYS,
        recursive: GDM_CONFIG.ARCHIVE.INCLUDE_SUBFOLDERS_DEFAULT
      },

      rename: {
        recursive: GDM_CONFIG.RENAME.INCLUDE_SUBFOLDERS_DEFAULT,
        previewMaxRows: GDM_CONFIG.RENAME.PREVIEW_MAX_ROWS
      },

      ui: {
        resultPageSize: GDM_CONFIG.UI.RESULT_PAGE_SIZE,
        previewMaxRows: GDM_CONFIG.UI.PREVIEW_MAX_ROWS,
        pollIntervalMs: GDM_CONFIG.UI.POLL_INTERVAL_MS
      },

      statuses: {
        pending: GDM_JOB_STATUS.PENDING,
        running: GDM_JOB_STATUS.RUNNING,
        paused: GDM_JOB_STATUS.PAUSED,
        completed: GDM_JOB_STATUS.COMPLETED,
        cancelled: GDM_JOB_STATUS.CANCELLED,
        error: GDM_JOB_STATUS.ERROR
      }
    };
  },


  /**
   * Convertit le seuil "gros fichier" en octets.
   */
  getLargeFileBytes: function() {

    return Number(GDM_CONFIG.ANALYSIS.LARGE_FILE_MB) *
      1024 *
      1024;
  },


  /**
   * Retourne la limite de temps réelle utilisée par Engine.gs.
   */
  getSoftExecutionLimit: function() {

    return Number(GDM_CONFIG.RUNTIME.SOFT_STOP_MS);
  },


  /**
   * Vérifie qu'un statut de job est reconnu.
   */
  isValidJobStatus: function(status) {

    if (!status) {
      return false;
    }

    var value = String(status).toUpperCase();

    var keys = Object.keys(GDM_JOB_STATUS);

    for (var i = 0; i < keys.length; i++) {
      if (GDM_JOB_STATUS[keys[i]] === value) {
        return true;
      }
    }

    return false;
  },


  /**
   * Vérifie qu'un module appartient à l'architecture officielle.
   */
  isValidModule: function(moduleName) {

    if (!moduleName) {
      return false;
    }

    var value = String(moduleName);

    var keys = Object.keys(GDM_MODULES);

    for (var i = 0; i < keys.length; i++) {
      if (GDM_MODULES[keys[i]] === value) {
        return true;
      }
    }

    return false;
  },


  /**
   * Retourne une catégorie à partir d'une extension.
   */
  getCategoryByExtension: function(extension) {

    var ext = String(extension || '')
      .toLowerCase()
      .replace(/^\./, '')
      .trim();

    if (!ext) {
      return GDM_CONFIG.FILE_CATEGORIES.OTHER;
    }

    var categories = GDM_CONFIG.FILE_CATEGORIES;
    var keys = Object.keys(categories);

    for (var i = 0; i < keys.length; i++) {

      var category = categories[keys[i]];

      if (!category.EXTENSIONS || !category.EXTENSIONS.length) {
        continue;
      }

      if (category.EXTENSIONS.indexOf(ext) !== -1) {
        return category;
      }
    }

    return GDM_CONFIG.FILE_CATEGORIES.OTHER;
  },


  /**
   * Retourne le nom du dossier automatique pour une extension.
   */
  getDestinationFolderByExtension: function(extension) {

    var category = this.getCategoryByExtension(extension);

    return category && category.FOLDER
      ? category.FOLDER
      : GDM_CONFIG.FILE_CATEGORIES.OTHER.FOLDER;
  },


  /**
   * Génère la clé PropertiesService d'un job.
   */
  jobKey: function(jobId) {

    return GDM_CONFIG.STORAGE_KEYS.JOB_PREFIX +
      String(jobId || '');
  },


  /**
   * Génère la clé State d'un job.
   */
  stateKey: function(jobId) {

    return GDM_CONFIG.STORAGE_KEYS.JOB_STATE_PREFIX +
      String(jobId || '');
  },


  /**
   * Génère la clé Queue d'un job.
   */
  queueKey: function(jobId) {

    return GDM_CONFIG.STORAGE_KEYS.QUEUE_PREFIX +
      String(jobId || '');
  },


  /**
   * Génère la clé de métadonnées Queue.
   */
  queueMetaKey: function(jobId) {

    return GDM_CONFIG.STORAGE_KEYS.QUEUE_META_PREFIX +
      String(jobId || '');
  },


  /**
   * Génère la clé de logs.
   */
  logKey: function(jobId) {

    return GDM_CONFIG.STORAGE_KEYS.LOG_PREFIX +
      String(jobId || '');
  },


  /**
   * Génère la clé du résultat final.
   */
  resultKey: function(jobId) {

    return GDM_CONFIG.STORAGE_KEYS.RESULT_PREFIX +
      String(jobId || '');
  },


  /**
   * Validation générale de Config.gs.
   *
   * Peut être appelée depuis Main.gs pendant les tests système.
   */
  validate: function() {

    var errors = [];

    if (!GDM_APP.NAME) {
      errors.push('APP.NAME manquant.');
    }

    if (!GDM_APP.VERSION) {
      errors.push('APP.VERSION manquante.');
    }

    if (
      GDM_CONFIG.RUNTIME.SOFT_STOP_MS <= 0 ||
      GDM_CONFIG.RUNTIME.MAX_EXECUTION_MS <= 0
    ) {
      errors.push('Limites Runtime invalides.');
    }

    if (
      GDM_CONFIG.RUNTIME.SOFT_STOP_MS >=
      GDM_CONFIG.RUNTIME.MAX_EXECUTION_MS
    ) {
      errors.push(
        'SOFT_STOP_MS doit être inférieur à MAX_EXECUTION_MS.'
      );
    }

    if (GDM_CONFIG.QUEUE.MAX_RETRIES < 0) {
      errors.push('QUEUE.MAX_RETRIES invalide.');
    }

    if (GDM_CONFIG.ANALYSIS.LARGE_FILE_MB <= 0) {
      errors.push('ANALYSIS.LARGE_FILE_MB invalide.');
    }

    if (GDM_CONFIG.ANALYSIS.OLD_FILE_DAYS <= 0) {
      errors.push('ANALYSIS.OLD_FILE_DAYS invalide.');
    }

    if (GDM_CONFIG.MOVE.MAX_MOVES_PER_RUN <= 0) {
      errors.push('MOVE.MAX_MOVES_PER_RUN invalide.');
    }

    if (GDM_CONFIG.COPY.MAX_COPIES_PER_RUN <= 0) {
      errors.push('COPY.MAX_COPIES_PER_RUN invalide.');
    }

    if (GDM_CONFIG.STATE.PROPERTY_CHUNK_SIZE <= 0) {
      errors.push('STATE.PROPERTY_CHUNK_SIZE invalide.');
    }

    if (GDM_CONFIG.APP.ALLOW_AUTOMATIC_DELETE === true) {
      errors.push(
        'ALLOW_AUTOMATIC_DELETE doit rester false dans Google Drive Manager PRO V2.'
      );
    }

    return {
      ok: errors.length === 0,
      file: 'Core/Config.gs',
      app: GDM_APP.NAME,
      version: GDM_APP.VERSION,
      errors: errors
    };
  }
});