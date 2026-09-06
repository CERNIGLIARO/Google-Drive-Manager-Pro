/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Utils.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Fonctions utilitaires communes à tout Google Drive Manager PRO V2.
 *
 * Ce fichier centralise :
 * - validations ;
 * - normalisation ;
 * - gestion des tailles ;
 * - gestion des dates ;
 * - extraction d'extensions ;
 * - génération d'identifiants ;
 * - sérialisation JSON ;
 * - sécurisation des noms ;
 * - gestion des erreurs ;
 * - helpers Google Drive ;
 * - helpers pour les traitements par lots.
 *
 * IMPORTANT
 * ---------
 * - Aucune logique métier spécifique à Analysis, Move, Copy, etc.
 * - Aucun accès direct à l'interface HTML.
 * - Aucune suppression de fichier.
 **************************************************************************************************/

'use strict';


const GDM_Utils = Object.freeze({


  /************************************************************************************************
   * CHAÎNES DE CARACTÈRES
   ************************************************************************************************/

  toString: function(value, defaultValue) {
    if (value === null || typeof value === 'undefined') {
      return typeof defaultValue === 'undefined'
        ? ''
        : String(defaultValue);
    }

    return String(value);
  },


  trim: function(value) {
    return this.toString(value).trim();
  },


  normalizeWhitespace: function(value) {
    return this
      .toString(value)
      .replace(/\s+/g, ' ')
      .trim();
  },


  normalizeName: function(value) {
    return this
      .normalizeWhitespace(value)
      .toLowerCase();
  },


  isEmpty: function(value) {
    return this.trim(value) === '';
  },


  startsWith: function(value, prefix) {
    value = this.toString(value);
    prefix = this.toString(prefix);

    return value.indexOf(prefix) === 0;
  },


  endsWith: function(value, suffix) {
    value = this.toString(value);
    suffix = this.toString(suffix);

    if (!suffix) {
      return true;
    }

    return value.slice(-suffix.length) === suffix;
  },


  contains: function(value, search, caseSensitive) {
    value = this.toString(value);
    search = this.toString(search);

    if (!caseSensitive) {
      value = value.toLowerCase();
      search = search.toLowerCase();
    }

    return value.indexOf(search) !== -1;
  },


  truncate: function(value, maxLength) {
    value = this.toString(value);

    maxLength = this.toPositiveInteger(
      maxLength,
      GDM_Config.get('LOG.MAX_MESSAGE_LENGTH', 2000)
    );

    if (value.length <= maxLength) {
      return value;
    }

    return value.substring(0, Math.max(0, maxLength - 3)) + '...';
  },


  sanitizeFileName: function(name) {
    var value = this.normalizeWhitespace(name);

    value = value.replace(/[\u0000-\u001F\u007F]/g, '');
    value = value.replace(/[\\/:*?"<>|]/g, '-');
    value = value.replace(/\.+$/g, '');
    value = value.trim();

    if (!value) {
      value = 'Sans nom';
    }

    return value;
  },


  sanitizeFolderName: function(name) {
    return this.sanitizeFileName(name);
  },


  /************************************************************************************************
   * NOMBRES
   ************************************************************************************************/

  toNumber: function(value, defaultValue) {
    var number = Number(value);

    if (!isFinite(number)) {
      return typeof defaultValue === 'undefined'
        ? 0
        : Number(defaultValue);
    }

    return number;
  },


  toInteger: function(value, defaultValue) {
    var number = parseInt(value, 10);

    if (!isFinite(number)) {
      return typeof defaultValue === 'undefined'
        ? 0
        : parseInt(defaultValue, 10) || 0;
    }

    return number;
  },


  toPositiveInteger: function(value, defaultValue) {
    var number = this.toInteger(value, defaultValue);

    if (number < 1) {
      number = this.toInteger(defaultValue, 1);
    }

    if (number < 1) {
      number = 1;
    }

    return number;
  },


  clamp: function(value, min, max) {
    value = this.toNumber(value, 0);
    min = this.toNumber(min, value);
    max = this.toNumber(max, value);

    if (value < min) {
      return min;
    }

    if (value > max) {
      return max;
    }

    return value;
  },


  /************************************************************************************************
   * BOOLÉENS
   ************************************************************************************************/

  toBoolean: function(value, defaultValue) {
    if (typeof value === 'boolean') {
      return value;
    }

    if (value === null || typeof value === 'undefined') {
      return Boolean(defaultValue);
    }

    var normalized = String(value)
      .toLowerCase()
      .trim();

    if (
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'yes' ||
      normalized === 'oui' ||
      normalized === 'on'
    ) {
      return true;
    }

    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'no' ||
      normalized === 'non' ||
      normalized === 'off'
    ) {
      return false;
    }

    return Boolean(defaultValue);
  },


  /************************************************************************************************
   * TABLEAUX / OBJETS
   ************************************************************************************************/

  ensureArray: function(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (value === null || typeof value === 'undefined') {
      return [];
    }

    return [value];
  },


  unique: function(values) {
    values = this.ensureArray(values);

    var seen = {};
    var result = [];

    for (var i = 0; i < values.length; i++) {
      var key = String(values[i]);

      if (!seen[key]) {
        seen[key] = true;
        result.push(values[i]);
      }
    }

    return result;
  },


  uniqueStrings: function(values, caseInsensitive) {
    values = this.ensureArray(values);

    var seen = {};
    var result = [];

    for (var i = 0; i < values.length; i++) {
      var value = this.trim(values[i]);

      if (!value) {
        continue;
      }

      var key = caseInsensitive
        ? value.toLowerCase()
        : value;

      if (!seen[key]) {
        seen[key] = true;
        result.push(value);
      }
    }

    return result;
  },


  clone: function(value) {
    if (value === null || typeof value === 'undefined') {
      return value;
    }

    return JSON.parse(JSON.stringify(value));
  },


  merge: function(target, source) {
    target = target || {};
    source = source || {};

    var result = {};

    var key;

    for (key in target) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        result[key] = target[key];
      }
    }

    for (key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        result[key] = source[key];
      }
    }

    return result;
  },


  chunkArray: function(values, chunkSize) {
    values = this.ensureArray(values);

    chunkSize = this.toPositiveInteger(chunkSize, 100);

    var chunks = [];

    for (var i = 0; i < values.length; i += chunkSize) {
      chunks.push(values.slice(i, i + chunkSize));
    }

    return chunks;
  },


  /************************************************************************************************
   * JSON
   ************************************************************************************************/

  safeJsonParse: function(value, defaultValue) {
    if (value === null || typeof value === 'undefined' || value === '') {
      return typeof defaultValue === 'undefined'
        ? null
        : defaultValue;
    }

    if (typeof value !== 'string') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      return typeof defaultValue === 'undefined'
        ? null
        : defaultValue;
    }
  },


  safeJsonStringify: function(value, defaultValue) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return typeof defaultValue === 'undefined'
        ? '{}'
        : String(defaultValue);
    }
  },


  /************************************************************************************************
   * DATES
   ************************************************************************************************/

  now: function() {
    return new Date();
  },


  nowIso: function() {
    return new Date().toISOString();
  },


  toDate: function(value) {
    if (value instanceof Date) {
      return value;
    }

    if (!value) {
      return null;
    }

    var date = new Date(value);

    if (isNaN(date.getTime())) {
      return null;
    }

    return date;
  },


  toIso: function(value) {
    var date = this.toDate(value);

    if (!date) {
      return '';
    }

    return date.toISOString();
  },


  formatDateTime: function(value) {
    var date = this.toDate(value);

    if (!date) {
      return '';
    }

    var timezone = GDM_Config.get(
      'APP.TIMEZONE',
      Session.getScriptTimeZone() || 'Europe/Brussels'
    );

    return Utilities.formatDate(
      date,
      timezone,
      'dd/MM/yyyy HH:mm:ss'
    );
  },


  formatDate: function(value) {
    var date = this.toDate(value);

    if (!date) {
      return '';
    }

    var timezone = GDM_Config.get(
      'APP.TIMEZONE',
      Session.getScriptTimeZone() || 'Europe/Brussels'
    );

    return Utilities.formatDate(
      date,
      timezone,
      'dd/MM/yyyy'
    );
  },


  daysAgo: function(days) {
    days = this.toPositiveInteger(days, 1);

    return new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    );
  },


  isOlderThanDays: function(dateValue, days) {
    var date = this.toDate(dateValue);

    if (!date) {
      return false;
    }

    days = this.toPositiveInteger(days, 1);

    var threshold = Date.now() - days * 24 * 60 * 60 * 1000;

    return date.getTime() < threshold;
  },


  elapsedMs: function(startTime) {
    if (startTime instanceof Date) {
      return Date.now() - startTime.getTime();
    }

    return Date.now() - Number(startTime || Date.now());
  },


  /************************************************************************************************
   * TAILLES DE FICHIERS
   ************************************************************************************************/

  mbToBytes: function(mb) {
    return this.toNumber(mb, 0) * 1024 * 1024;
  },


  gbToBytes: function(gb) {
    return this.toNumber(gb, 0) * 1024 * 1024 * 1024;
  },


  bytesToMB: function(bytes) {
    return this.toNumber(bytes, 0) / 1024 / 1024;
  },


  bytesToGB: function(bytes) {
    return this.toNumber(bytes, 0) / 1024 / 1024 / 1024;
  },


  formatBytes: function(bytes, decimals) {
    bytes = this.toNumber(bytes, 0);

    if (bytes <= 0) {
      return '0 octet';
    }

    decimals = typeof decimals === 'undefined'
      ? 2
      : Math.max(0, this.toInteger(decimals, 2));

    var units = [
      'octets',
      'Ko',
      'Mo',
      'Go',
      'To',
      'Po'
    ];

    var index = Math.floor(
      Math.log(bytes) / Math.log(1024)
    );

    index = Math.min(index, units.length - 1);

    var value = bytes / Math.pow(1024, index);

    return Number(value.toFixed(decimals)) + ' ' + units[index];
  },


  /************************************************************************************************
   * EXTENSIONS / TYPES
   ************************************************************************************************/

  getExtension: function(fileName) {
    var name = this.trim(fileName);

    if (!name) {
      return '';
    }

    var lastDot = name.lastIndexOf('.');

    if (
      lastDot <= 0 ||
      lastDot === name.length - 1
    ) {
      return '';
    }

    return name
      .substring(lastDot + 1)
      .toLowerCase()
      .trim();
  },


  removeExtension: function(fileName) {
    var name = this.trim(fileName);

    var lastDot = name.lastIndexOf('.');

    if (lastDot <= 0) {
      return name;
    }

    return name.substring(0, lastDot);
  },


  hasExtension: function(fileName) {
    return this.getExtension(fileName) !== '';
  },


  normalizeExtension: function(extension) {
    return this
      .toString(extension)
      .toLowerCase()
      .replace(/^\./, '')
      .trim();
  },


  normalizeExtensions: function(extensions) {
    var values = this.ensureArray(extensions);

    var result = [];

    for (var i = 0; i < values.length; i++) {
      var ext = this.normalizeExtension(values[i]);

      if (ext) {
        result.push(ext);
      }
    }

    return this.uniqueStrings(result, true);
  },


  isGoogleMimeType: function(mimeType) {
    mimeType = this.trim(mimeType);

    return this.startsWith(
      mimeType,
      'application/vnd.google-apps.'
    );
  },


  isFolderMimeType: function(mimeType) {
    return this.trim(mimeType) === GDM_MIME.FOLDER;
  },


  isShortcutMimeType: function(mimeType) {
    return this.trim(mimeType) === GDM_MIME.SHORTCUT;
  },


  getFileCategory: function(fileName) {
    return GDM_Config.getCategoryByExtension(
      this.getExtension(fileName)
    );
  },


  /************************************************************************************************
   * IDENTIFIANTS
   ************************************************************************************************/

  generateId: function(prefix) {
    prefix = this.trim(prefix) || 'GDM';

    var uuid = Utilities.getUuid()
      .replace(/-/g, '')
      .toUpperCase();

    var timestamp = Date.now();

    return prefix + '_' + timestamp + '_' + uuid;
  },


  generateJobId: function() {
    return this.generateId('JOB');
  },


  generateTaskId: function() {
    return this.generateId('TASK');
  },


  isValidId: function(id) {
    var value = this.trim(id);

    return value.length > 5;
  },


  /************************************************************************************************
   * GOOGLE DRIVE
   ************************************************************************************************/

  getRootFolderId: function() {
    return DriveApp.getRootFolder().getId();
  },


  getFolderOrRoot: function(folderId) {
    folderId = this.trim(folderId);

    if (!folderId) {
      return DriveApp.getRootFolder();
    }

    var root = DriveApp.getRootFolder();

    if (folderId === root.getId()) {
      return root;
    }

    return DriveApp.getFolderById(folderId);
  },


  getFolderSafe: function(folderId) {
    folderId = this.trim(folderId);

    if (!folderId) {
      return null;
    }

    try {
      return DriveApp.getFolderById(folderId);
    } catch (error) {
      return null;
    }
  },


  getFileSafe: function(fileId) {
    fileId = this.trim(fileId);

    if (!fileId) {
      return null;
    }

    try {
      return DriveApp.getFileById(fileId);
    } catch (error) {
      return null;
    }
  },


  folderExists: function(folderId) {
    return this.getFolderSafe(folderId) !== null;
  },


  fileExists: function(fileId) {
    return this.getFileSafe(fileId) !== null;
  },


  getDriveFileUrl: function(fileId) {
    fileId = this.trim(fileId);

    if (!fileId) {
      return '';
    }

    return 'https://drive.google.com/open?id=' +
      encodeURIComponent(fileId);
  },


  getDriveFolderUrl: function(folderId) {
    folderId = this.trim(folderId);

    if (!folderId) {
      return '';
    }

    return 'https://drive.google.com/drive/folders/' +
      encodeURIComponent(folderId);
  },


  getFirstParentId: function(item) {
    if (!item || typeof item.getParents !== 'function') {
      return '';
    }

    try {
      var parents = item.getParents();

      if (parents.hasNext()) {
        return parents.next().getId();
      }
    } catch (error) {
      return '';
    }

    return '';
  },


  getFirstParentInfo: function(item) {
    if (!item || typeof item.getParents !== 'function') {
      return {
        id: '',
        name: ''
      };
    }

    try {
      var parents = item.getParents();

      if (parents.hasNext()) {
        var folder = parents.next();

        return {
          id: folder.getId(),
          name: folder.getName()
        };
      }
    } catch (error) {
      // Retour standard ci-dessous.
    }

    return {
      id: '',
      name: ''
    };
  },


  /************************************************************************************************
   * CONVERSION DRIVEAPP → OBJET SÉRIALISABLE
   ************************************************************************************************/

  fileToObject: function(file) {
    if (!file) {
      return null;
    }

    var id = '';
    var name = '';
    var mimeType = '';
    var size = 0;
    var created = null;
    var updated = null;
    var url = '';
    var description = '';

    try {
      id = file.getId();
    } catch (e1) {}

    try {
      name = file.getName();
    } catch (e2) {}

    try {
      mimeType = file.getMimeType();
    } catch (e3) {}

    try {
      size = Number(file.getSize()) || 0;
    } catch (e4) {}

    try {
      created = file.getDateCreated();
    } catch (e5) {}

    try {
      updated = file.getLastUpdated();
    } catch (e6) {}

    try {
      url = file.getUrl();
    } catch (e7) {
      url = this.getDriveFileUrl(id);
    }

    try {
      description = file.getDescription() || '';
    } catch (e8) {}

    var parent = this.getFirstParentInfo(file);

    return {
      id: id,
      name: name,
      mimeType: mimeType,
      size: size,
      sizeFormatted: this.formatBytes(size),
      extension: this.getExtension(name),
      url: url,
      created: this.toIso(created),
      updated: this.toIso(updated),
      parentId: parent.id,
      parentName: parent.name,
      description: description
    };
  },


  folderToObject: function(folder) {
    if (!folder) {
      return null;
    }

    var id = '';
    var name = '';
    var url = '';

    try {
      id = folder.getId();
    } catch (e1) {}

    try {
      name = folder.getName();
    } catch (e2) {}

    try {
      url = folder.getUrl();
    } catch (e3) {
      url = this.getDriveFolderUrl(id);
    }

    var parent = this.getFirstParentInfo(folder);

    return {
      id: id,
      name: name,
      url: url,
      parentId: parent.id,
      parentName: parent.name
    };
  },


  /************************************************************************************************
   * VALIDATIONS
   ************************************************************************************************/

  requireString: function(value, fieldName) {
    var normalized = this.trim(value);

    if (!normalized) {
      throw new Error(
        'Le champ "' +
        this.toString(fieldName, 'inconnu') +
        '" est obligatoire.'
      );
    }

    return normalized;
  },


  requireFolderId: function(folderId, fieldName) {
    folderId = this.requireString(
      folderId,
      fieldName || 'folderId'
    );

    if (!this.folderExists(folderId)) {
      throw new Error(
        'Dossier Google Drive introuvable ou inaccessible : ' +
        folderId
      );
    }

    return folderId;
  },


  requireFileId: function(fileId, fieldName) {
    fileId = this.requireString(
      fileId,
      fieldName || 'fileId'
    );

    if (!this.fileExists(fileId)) {
      throw new Error(
        'Fichier Google Drive introuvable ou inaccessible : ' +
        fileId
      );
    }

    return fileId;
  },


  validateModule: function(moduleName) {
    moduleName = this.trim(moduleName);

    if (!GDM_Config.isValidModule(moduleName)) {
      throw new Error(
        'Module Google Drive Manager PRO V2 invalide : ' +
        moduleName
      );
    }

    return moduleName;
  },


  validateJobStatus: function(status) {
    status = this.trim(status).toUpperCase();

    if (!GDM_Config.isValidJobStatus(status)) {
      throw new Error(
        'Statut de job invalide : ' +
        status
      );
    }

    return status;
  },


  /************************************************************************************************
   * ERREURS
   ************************************************************************************************/

  errorToObject: function(error, context) {
    context = context || {};

    var message = '';

    if (error && error.message) {
      message = error.message;
    } else {
      message = this.toString(error);
    }

    var stack = '';

    if (error && error.stack) {
      stack = String(error.stack);
    }

    return {
      timestamp: this.nowIso(),
      module: this.trim(context.module),
      action: this.trim(context.action),
      jobId: this.trim(context.jobId),
      taskId: this.trim(context.taskId),
      itemId: this.trim(context.itemId),
      itemName: this.trim(context.itemName),
      message: this.truncate(message, 2000),
      code: this.trim(context.code),
      stack: this.truncate(stack, 5000)
    };
  },


  createError: function(message, code, details) {
    var error = new Error(
      this.toString(message, 'Erreur inconnue')
    );

    error.code = this.trim(code);

    if (typeof details !== 'undefined') {
      error.details = details;
    }

    return error;
  },


  getErrorMessage: function(error) {
    if (!error) {
      return 'Erreur inconnue.';
    }

    if (error.message) {
      return String(error.message);
    }

    return String(error);
  },


  /************************************************************************************************
   * RÉSULTATS STANDARD
   ************************************************************************************************/

  createResult: function(options) {
    options = options || {};

    return {
      ok: typeof options.ok === 'boolean'
        ? options.ok
        : true,

      module: this.trim(options.module),

      action: this.trim(options.action),

      jobId: this.trim(options.jobId),

      processed: this.toInteger(options.processed, 0),

      success: this.toInteger(options.success, 0),

      skipped: this.toInteger(options.skipped, 0),

      errors: this.toInteger(options.errors, 0),

      message: this.toString(options.message),

      data: typeof options.data === 'undefined'
        ? {}
        : options.data
    };
  },


  createErrorResult: function(error, options) {
    options = options || {};

    return this.createResult({
      ok: false,
      module: options.module,
      action: options.action,
      jobId: options.jobId,
      processed: options.processed || 0,
      success: options.success || 0,
      skipped: options.skipped || 0,
      errors: Math.max(
        1,
        this.toInteger(options.errors, 1)
      ),
      message: this.getErrorMessage(error),
      data: {
        error: this.errorToObject(
          error,
          options
        )
      }
    });
  },


  /************************************************************************************************
   * TEMPS D'EXÉCUTION / MOTEUR
   ************************************************************************************************/

  createRuntimeContext: function() {
    var startTime = Date.now();

    return {
      startedAt: startTime,
      softLimitMs: GDM_Config.getSoftExecutionLimit()
    };
  },


  runtimeExpired: function(runtimeContext) {
    if (!runtimeContext) {
      return false;
    }

    var startedAt = Number(
      runtimeContext.startedAt || Date.now()
    );

    var limit = Number(
      runtimeContext.softLimitMs ||
      GDM_Config.getSoftExecutionLimit()
    );

    return Date.now() - startedAt >= limit;
  },


  remainingRuntimeMs: function(runtimeContext) {
    if (!runtimeContext) {
      return GDM_Config.getSoftExecutionLimit();
    }

    var startedAt = Number(
      runtimeContext.startedAt || Date.now()
    );

    var limit = Number(
      runtimeContext.softLimitMs ||
      GDM_Config.getSoftExecutionLimit()
    );

    return Math.max(
      0,
      limit - (Date.now() - startedAt)
    );
  },


  shouldStop: function(runtimeContext, processedCount) {
    if (this.runtimeExpired(runtimeContext)) {
      return true;
    }

    var maxItems = GDM_Config.get(
      'RUNTIME.MAX_SCAN_ITEMS_PER_RUN',
      5000
    );

    if (
      typeof processedCount !== 'undefined' &&
      Number(processedCount) >= Number(maxItems)
    ) {
      return true;
    }

    return false;
  },


  /************************************************************************************************
   * SLEEP / RETRY
   ************************************************************************************************/

  sleep: function(milliseconds) {
    milliseconds = Math.max(
      0,
      this.toInteger(milliseconds, 0)
    );

    if (milliseconds > 0) {
      Utilities.sleep(milliseconds);
    }
  },


  retry: function(callback, options) {
    options = options || {};

    if (typeof callback !== 'function') {
      throw new Error(
        'GDM_Utils.retry : callback invalide.'
      );
    }

    var maxRetries = Math.max(
      0,
      this.toInteger(
        options.maxRetries,
        GDM_Config.get('QUEUE.MAX_RETRIES', 3)
      )
    );

    var delayMs = Math.max(
      0,
      this.toInteger(
        options.delayMs,
        GDM_Config.get('QUEUE.RETRY_DELAY_MS', 1000)
      )
    );

    var lastError = null;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return callback(attempt);
      } catch (error) {
        lastError = error;

        if (attempt >= maxRetries) {
          throw error;
        }

        if (delayMs > 0) {
          Utilities.sleep(delayMs);
        }
      }
    }

    throw lastError || new Error(
      'Échec de l’opération après plusieurs tentatives.'
    );
  },


  /************************************************************************************************
   * TRI
   ************************************************************************************************/

  sortByName: function(items) {
    items = this.ensureArray(items);

    items.sort(function(a, b) {
      var nameA = String(
        a && a.name ? a.name : ''
      ).toLowerCase();

      var nameB = String(
        b && b.name ? b.name : ''
      ).toLowerCase();

      return nameA.localeCompare(nameB);
    });

    return items;
  },


  sortBySizeDescending: function(items) {
    items = this.ensureArray(items);

    items.sort(function(a, b) {
      return Number(
        b && b.size ? b.size : 0
      ) - Number(
        a && a.size ? a.size : 0
      );
    });

    return items;
  },


  /************************************************************************************************
   * PROPERTIES SERVICE
   ************************************************************************************************/

  getProperties: function() {
    return PropertiesService.getScriptProperties();
  },


  getProperty: function(key, defaultValue) {
    key = this.trim(key);

    if (!key) {
      return defaultValue;
    }

    var value = this.getProperties().getProperty(key);

    if (value === null) {
      return defaultValue;
    }

    return value;
  },


  setProperty: function(key, value) {
    key = this.requireString(
      key,
      'propertyKey'
    );

    this.getProperties().setProperty(
      key,
      this.toString(value)
    );

    return true;
  },


  deleteProperty: function(key) {
    key = this.trim(key);

    if (!key) {
      return false;
    }

    this.getProperties().deleteProperty(key);

    return true;
  },


  getJsonProperty: function(key, defaultValue) {
    return this.safeJsonParse(
      this.getProperty(key, ''),
      defaultValue
    );
  },


  setJsonProperty: function(key, value) {
    return this.setProperty(
      key,
      this.safeJsonStringify(value, '{}')
    );
  },


  /************************************************************************************************
   * VERROUS
   ************************************************************************************************/

  withScriptLock: function(callback, timeoutMs) {
    if (typeof callback !== 'function') {
      throw new Error(
        'GDM_Utils.withScriptLock : callback invalide.'
      );
    }

    timeoutMs = this.toPositiveInteger(
      timeoutMs,
      GDM_Config.get('LOCK.WAIT_TIMEOUT_MS', 10000)
    );

    var lock = LockService.getScriptLock();

    var acquired = lock.tryLock(timeoutMs);

    if (!acquired) {
      throw new Error(
        'Impossible d’obtenir le verrou Google Drive Manager PRO.'
      );
    }

    try {
      return callback();
    } finally {
      try {
        lock.releaseLock();
      } catch (error) {
        // Rien à faire.
      }
    }
  },


  /************************************************************************************************
   * CONFLITS DE NOM
   ************************************************************************************************/

  splitNameAndExtension: function(fileName) {
    var name = this.trim(fileName);

    var extension = this.getExtension(name);

    if (!extension) {
      return {
        baseName: name,
        extension: ''
      };
    }

    return {
      baseName: name.substring(
        0,
        name.length - extension.length - 1
      ),
      extension: extension
    };
  },


  buildUniqueName: function(originalName, existsCallback) {
    originalName = this.sanitizeFileName(originalName);

    if (typeof existsCallback !== 'function') {
      return originalName;
    }

    if (!existsCallback(originalName)) {
      return originalName;
    }

    var parts = this.splitNameAndExtension(
      originalName
    );

    var counter = 2;

    while (counter < 10000) {
      var candidate = parts.baseName +
        ' (' +
        counter +
        ')' +
        (
          parts.extension
            ? '.' + parts.extension
            : ''
        );

      if (!existsCallback(candidate)) {
        return candidate;
      }

      counter++;
    }

    return parts.baseName +
      '_' +
      Date.now() +
      (
        parts.extension
          ? '.' + parts.extension
          : ''
      );
  },


  /************************************************************************************************
   * VALIDATION DU FICHIER UTILS
   ************************************************************************************************/

  validate: function() {
    var errors = [];

    try {
      if (this.formatBytes(1024) !== '1 Ko') {
        errors.push(
          'formatBytes() retourne un résultat inattendu.'
        );
      }
    } catch (error1) {
      errors.push(
        'Erreur formatBytes(): ' +
        this.getErrorMessage(error1)
      );
    }

    try {
      if (this.getExtension('document.pdf') !== 'pdf') {
        errors.push(
          'getExtension() ne fonctionne pas correctement.'
        );
      }
    } catch (error2) {
      errors.push(
        'Erreur getExtension(): ' +
        this.getErrorMessage(error2)
      );
    }

    try {
      if (!this.isFolderMimeType(GDM_MIME.FOLDER)) {
        errors.push(
          'isFolderMimeType() ne fonctionne pas correctement.'
        );
      }
    } catch (error3) {
      errors.push(
        'Erreur MIME folder : ' +
        this.getErrorMessage(error3)
      );
    }

    try {
      var testId = this.generateJobId();

      if (!testId || testId.indexOf('JOB_') !== 0) {
        errors.push(
          'generateJobId() ne fonctionne pas correctement.'
        );
      }
    } catch (error4) {
      errors.push(
        'Erreur generateJobId(): ' +
        this.getErrorMessage(error4)
      );
    }

    return {
      ok: errors.length === 0,
      file: 'Core/Utils.gs',
      version: GDM_APP.VERSION,
      errors: errors
    };
  }

});