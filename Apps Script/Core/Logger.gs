/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Logger.gs
 * STABILISATION 2026-09
 *
 * Objectifs :
 * - réduire drastiquement les écritures PropertiesService ;
 * - ne plus persister les événements très bavards (QUEUE_UPDATED / ITEM_PROCESSED) ;
 * - limiter les logs persistants à 120 entrées ;
 * - stocker les logs dans DocumentProperties (repli ScriptProperties) ;
 * - lire encore les anciens logs ScriptProperties pour compatibilité ;
 * - conserver l'API publique existante de GDM_Logger.
 **************************************************************************************************/
'use strict';

var GDM_LOG_MEMORY = {};

const GDM_Logger = Object.freeze({

  PERSIST_MAX_: 80,

  log: function(level, message, context) {
    context = context || {};
    level = this.normalizeLevel_(level);
    var entry = this.createEntry_(level, message, context);
    this.addToMemory_(entry);

    if (GDM_Config.get('LOG.CONSOLE_ENABLED', true)) {
      this.writeConsole_(entry);
    }

    if (
      GDM_Config.get('LOG.STORE_IN_PROPERTIES', true) &&
      this.shouldPersist_(entry)
    ) {
      this.persist_(entry);
    }
    return entry;
  },

  debug: function(message, context) {
    return this.log(GDM_Config.get('LOG.LEVELS.DEBUG', 'DEBUG'), message, context);
  },

  info: function(message, context) {
    return this.log(GDM_Config.get('LOG.LEVELS.INFO', 'INFO'), message, context);
  },

  warn: function(message, context) {
    return this.log(GDM_Config.get('LOG.LEVELS.WARN', 'WARN'), message, context);
  },

  error: function(messageOrError, context) {
    context = context || {};
    var message = '';
    if (messageOrError && typeof messageOrError === 'object') {
      message = GDM_Utils.getErrorMessage(messageOrError);
      context.error = GDM_Utils.errorToObject(messageOrError, context);
    } else {
      message = GDM_Utils.toString(messageOrError);
    }
    return this.log(GDM_Config.get('LOG.LEVELS.ERROR', 'ERROR'), message, context);
  },

  event: function(eventName, context) {
    context = context || {};
    eventName = GDM_Utils.trim(eventName);
    if (!eventName) throw new Error('GDM_Logger.event : eventName obligatoire.');
    context.event = eventName;
    return this.info(context.message ? context.message : eventName, context);
  },

  jobCreated: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.JOB_CREATED','JOB_CREATED'), this.withJob_(jobId, context)); },
  jobStarted: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.JOB_STARTED','JOB_STARTED'), this.withJob_(jobId, context)); },
  jobPaused: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.JOB_PAUSED','JOB_PAUSED'), this.withJob_(jobId, context)); },
  jobResumed: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.JOB_RESUMED','JOB_RESUMED'), this.withJob_(jobId, context)); },
  jobCompleted: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.JOB_COMPLETED','JOB_COMPLETED'), this.withJob_(jobId, context)); },
  jobCancelled: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.JOB_CANCELLED','JOB_CANCELLED'), this.withJob_(jobId, context)); },

  jobError: function(jobId, error, context) {
    context = this.withJob_(jobId, context);
    context.event = GDM_Config.get('LOG.EVENTS.JOB_ERROR', 'JOB_ERROR');
    return this.error(error, context);
  },

  scanStarted: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.SCAN_STARTED','SCAN_STARTED'), this.withJob_(jobId, context)); },
  scanCompleted: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.SCAN_COMPLETED','SCAN_COMPLETED'), this.withJob_(jobId, context)); },
  itemProcessed: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.ITEM_PROCESSED','ITEM_PROCESSED'), this.withJob_(jobId, context)); },
  itemSkipped: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.ITEM_SKIPPED','ITEM_SKIPPED'), this.withJob_(jobId, context)); },

  itemError: function(jobId, error, context) {
    context = this.withJob_(jobId, context);
    context.event = GDM_Config.get('LOG.EVENTS.ITEM_ERROR', 'ITEM_ERROR');
    return this.error(error, context);
  },

  queueCreated: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.QUEUE_CREATED','QUEUE_CREATED'), this.withJob_(jobId, context)); },
  queueUpdated: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.QUEUE_UPDATED','QUEUE_UPDATED'), this.withJob_(jobId, context)); },
  queueCompleted: function(jobId, context) { return this.event(GDM_Config.get('LOG.EVENTS.QUEUE_COMPLETED','QUEUE_COMPLETED'), this.withJob_(jobId, context)); },

  getLogs: function(jobId, options) {
    options = options || {};
    jobId = GDM_Utils.trim(jobId);
    if (!jobId) return [];

    var logs = this.readPersistent_(jobId).slice();
    var memory = GDM_LOG_MEMORY[jobId] || [];
    var ids = {};
    for (var i = 0; i < logs.length; i++) if (logs[i] && logs[i].id) ids[logs[i].id] = true;
    for (var j = 0; j < memory.length; j++) {
      if (!memory[j] || !memory[j].id || ids[memory[j].id]) continue;
      ids[memory[j].id] = true;
      logs.push(memory[j]);
    }
    logs.sort(function(a,b){ return String(a.timestamp || '').localeCompare(String(b.timestamp || '')); });
    logs = this.filterLogs_(logs, options);
    var offset = Math.max(0, GDM_Utils.toInteger(options.offset, 0));
    var limit = GDM_Utils.toPositiveInteger(options.limit, GDM_Config.get('UI.LOG_PAGE_SIZE', 100));
    return logs.slice(offset, offset + limit);
  },

  getAllLogs: function(jobId) {
    return this.getLogs(jobId, { offset: 0, limit: Math.min(this.PERSIST_MAX_, GDM_Config.get('LOG.STORE_MAX_ENTRIES', 500)) });
  },

  count: function(jobId) {
    jobId = GDM_Utils.trim(jobId);
    return jobId ? this.readPersistent_(jobId).length : 0;
  },

  getLast: function(jobId) {
    var logs = this.getAllLogs(jobId);
    return logs.length ? logs[logs.length - 1] : null;
  },

  getErrors: function(jobId) {
    return this.getLogs(jobId, { level: 'ERROR', offset: 0, limit: this.PERSIST_MAX_ });
  },

  clear: function(jobId) {
    jobId = GDM_Utils.trim(jobId);
    if (!jobId) return false;
    delete GDM_LOG_MEMORY[jobId];
    this.deletePersistent_(jobId);
    return true;
  },

  clearMemory: function(jobId) {
    jobId = GDM_Utils.trim(jobId);
    if (!jobId) return false;
    delete GDM_LOG_MEMORY[jobId];
    return true;
  },

  getStats: function(jobId) {
    var logs = this.getAllLogs(jobId);
    var stats = { total: logs.length, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    for (var i = 0; i < logs.length; i++) {
      var level = this.normalizeLevel_(logs[i].level);
      if (typeof stats[level] === 'number') stats[level]++;
    }
    return stats;
  },

  createEntry_: function(level, message, context) {
    context = context || {};
    return {
      id: GDM_Utils.generateId('LOG'),
      timestamp: GDM_Utils.nowIso(),
      level: level,
      event: GDM_Utils.trim(context.event),
      module: GDM_Utils.trim(context.module),
      action: GDM_Utils.trim(context.action),
      jobId: GDM_Utils.trim(context.jobId),
      taskId: GDM_Utils.trim(context.taskId),
      itemId: GDM_Utils.trim(context.itemId),
      itemName: GDM_Utils.trim(context.itemName),
      message: GDM_Utils.truncate(
        GDM_Utils.toString(message),
        Math.min(1000, GDM_Config.get('LOG.MAX_MESSAGE_LENGTH', 2000))
      ),
      data: typeof context.data === 'undefined' ? null : this.compactData_(context.data),
      error: context.error ? this.compactData_(context.error) : null
    };
  },

  addToMemory_: function(entry) {
    var jobId = entry.jobId || '_GLOBAL_';
    if (!GDM_LOG_MEMORY[jobId]) GDM_LOG_MEMORY[jobId] = [];
    GDM_LOG_MEMORY[jobId].push(entry);
    var max = Math.min(200, GDM_Config.get('LOG.MAX_MEMORY_LOGS', 500));
    if (GDM_LOG_MEMORY[jobId].length > max) GDM_LOG_MEMORY[jobId] = GDM_LOG_MEMORY[jobId].slice(-max);
  },

  shouldPersist_: function(entry) {
    var level = this.normalizeLevel_(entry.level);
    if (level === 'ERROR' || level === 'WARN') return true;
    var eventName = GDM_Utils.trim(entry.event).toUpperCase();
    if (!eventName) {
      // Les INFO/DEBUG sans événement restent dans la console/mémoire seulement.
      return false;
    }
    // Événements très fréquents : ne pas les persister.
    if (eventName === 'QUEUE_UPDATED' || eventName === 'ITEM_PROCESSED') return false;
    // Les éléments ignorés peuvent être nombreux : la State les compte déjà.
    if (eventName === 'ITEM_SKIPPED') return false;
    return true;
  },

  persist_: function(entry) {
    var jobId = entry.jobId || '_GLOBAL_';
    try {
      GDM_Utils.withScriptLock(function() {
        var logs = GDM_Logger.readPersistentPrimary_(jobId);
        logs.push(entry);
        var maxEntries = Math.min(
          GDM_Logger.PERSIST_MAX_,
          Math.max(20, GDM_Utils.toInteger(GDM_Config.get('LOG.STORE_MAX_ENTRIES', 500), 500))
        );
        if (logs.length > maxEntries) logs = logs.slice(-maxEntries);
        GDM_Logger.writePersistentUnlocked_(jobId, logs);
      }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
    } catch (error) {
      if (GDM_Config.get('LOG.CONSOLE_ENABLED', true)) {
        console.warn('[GDM Logger] Sauvegarde log ignorée : ' + GDM_Utils.getErrorMessage(error));
      }
    }
  },

  readPersistent_: function(jobId) {
    jobId = GDM_Utils.trim(jobId) || '_GLOBAL_';
    var primary = this.readPersistentPrimary_(jobId);
    if (primary.length) return primary;
    // Compatibilité : lire l'ancien stockage ScriptProperties si le nouveau est vide.
    var primaryStore = this.getLogStore_();

    try {
      var docStore = PropertiesService.getDocumentProperties();
      if (docStore && docStore !== primaryStore) {
        var docLogs = this.readPersistentFromStore_(docStore, jobId);
        if (docLogs.length) return docLogs.slice(-this.PERSIST_MAX_);
      }
    } catch (ignoredDocLegacy) {}

    try {
      var scriptStore = PropertiesService.getScriptProperties();
      if (scriptStore !== primaryStore) {
        var legacy = this.readPersistentFromStore_(scriptStore, jobId);
        if (legacy.length) return legacy.slice(-this.PERSIST_MAX_);
      }
    } catch (ignoredScriptLegacy) {}

    return [];
  },

  readPersistentPrimary_: function(jobId) {
    return this.readPersistentFromStore_(this.getLogStore_(), jobId);
  },

  readPersistentFromStore_: function(store, jobId) {
    var baseKey = GDM_Config.logKey(jobId);
    var metaRaw = store.getProperty(baseKey + '_META');
    if (!metaRaw) {
      var direct = store.getProperty(baseKey);
      var parsed = direct ? GDM_Utils.safeJsonParse(direct, []) : [];
      return Array.isArray(parsed) ? parsed : [];
    }
    var meta = GDM_Utils.safeJsonParse(metaRaw, {});
    var count = Math.max(0, GDM_Utils.toInteger(meta.chunkCount, 0));
    var json = '';
    for (var i = 0; i < count; i++) {
      var part = store.getProperty(baseKey + '_PART_' + i);
      if (part !== null) json += part;
    }
    var logs = GDM_Utils.safeJsonParse(json, []);
    return Array.isArray(logs) ? logs : [];
  },

  writePersistent_: function(jobId, logs) {
    return GDM_Utils.withScriptLock(function() {
      return GDM_Logger.writePersistentUnlocked_(jobId, logs);
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  writePersistentUnlocked_: function(jobId, logs) {
    jobId = GDM_Utils.trim(jobId) || '_GLOBAL_';
    logs = Array.isArray(logs) ? logs.slice(-this.PERSIST_MAX_) : [];
    var store = this.getLogStore_();
    var baseKey = GDM_Config.logKey(jobId);
    var json = GDM_Utils.safeJsonStringify(logs, '[]');
    var chunkSize = Math.min(8000, Math.max(1000, GDM_Utils.toInteger(GDM_Config.get('STATE.PROPERTY_CHUNK_SIZE', 7000), 7000)));
    var chunks = [];
    for (var i = 0; i < json.length; i += chunkSize) chunks.push(json.substring(i, i + chunkSize));
    if (!chunks.length) chunks.push('[]');

    // Si malgré le cap le log devient trop gros, réduire encore avant d'écrire.
    if (chunks.length > 30) {
      logs = logs.slice(-50);
      json = GDM_Utils.safeJsonStringify(logs, '[]');
      chunks = [];
      for (var r = 0; r < json.length; r += chunkSize) chunks.push(json.substring(r, r + chunkSize));
      if (!chunks.length) chunks.push('[]');
    }

    var oldMeta = GDM_Utils.safeJsonParse(store.getProperty(baseKey + '_META'), {});
    var oldCount = Math.max(0, GDM_Utils.toInteger(oldMeta.chunkCount, 0));
    for (var c = 0; c < chunks.length; c++) store.setProperty(baseKey + '_PART_' + c, chunks[c]);
    for (var d = chunks.length; d < oldCount; d++) store.deleteProperty(baseKey + '_PART_' + d);
    store.setProperty(baseKey + '_META', JSON.stringify({ chunkCount: chunks.length, entries: logs.length, updatedAt: GDM_Utils.nowIso() }));
    store.deleteProperty(baseKey);
    return true;
  },

  deletePersistent_: function(jobId) {
    jobId = GDM_Utils.trim(jobId) || '_GLOBAL_';
    var stores = [];
    try { var user = PropertiesService.getUserProperties(); if (user) stores.push(user); } catch (ignoredUser) {}
    try { var doc = PropertiesService.getDocumentProperties(); if (doc) stores.push(doc); } catch (ignoredDoc) {}
    try { stores.push(PropertiesService.getScriptProperties()); } catch (ignoredScript) {}
    var baseKey = GDM_Config.logKey(jobId);
    for (var s = 0; s < stores.length; s++) {
      var store = stores[s];
      var meta = GDM_Utils.safeJsonParse(store.getProperty(baseKey + '_META'), {});
      var count = Math.max(0, GDM_Utils.toInteger(meta.chunkCount, 0));
      for (var i = 0; i < count; i++) store.deleteProperty(baseKey + '_PART_' + i);
      store.deleteProperty(baseKey + '_META');
      store.deleteProperty(baseKey);
    }
    return true;
  },

  getLogStore_: function() {
    /*
     * Les logs sont volontairement isolés dans UserProperties :
     * State reste dans ScriptProperties et Queue/Analysis dans DocumentProperties.
     * On évite ainsi que les logs remplissent le même quota que la queue.
     */
    try {
      var user = PropertiesService.getUserProperties();
      if (user) return user;
    } catch (ignoredUser) {}

    try {
      var doc = PropertiesService.getDocumentProperties();
      if (doc) return doc;
    } catch (ignoredDoc) {}

    return PropertiesService.getScriptProperties();
  },

  filterLogs_: function(logs, options) {
    options = options || {};
    var level = GDM_Utils.trim(options.level).toUpperCase();
    var eventName = GDM_Utils.trim(options.event);
    var moduleName = GDM_Utils.trim(options.module);
    var action = GDM_Utils.trim(options.action);
    var search = GDM_Utils.trim(options.search).toLowerCase();
    return (Array.isArray(logs) ? logs : []).filter(function(log) {
      if (level && String(log.level || '').toUpperCase() !== level) return false;
      if (eventName && String(log.event || '') !== eventName) return false;
      if (moduleName && String(log.module || '') !== moduleName) return false;
      if (action && String(log.action || '') !== action) return false;
      if (search) {
        var haystack = [log.message, log.itemName, log.itemId, log.event, log.module, log.action].join(' ').toLowerCase();
        if (haystack.indexOf(search) < 0) return false;
      }
      return true;
    });
  },

  normalizeLevel_: function(level) {
    level = GDM_Utils.trim(level).toUpperCase();
    if (level === 'DEBUG' || level === 'WARN' || level === 'ERROR') return level;
    return 'INFO';
  },

  withJob_: function(jobId, context) {
    var out = {};
    context = context || {};
    Object.keys(context).forEach(function(k){ out[k] = context[k]; });
    out.jobId = GDM_Utils.trim(jobId);
    return out;
  },

  compactData_: function(value) {
    var serial;
    try { serial = JSON.parse(JSON.stringify(value)); }
    catch (ignored) { serial = GDM_Utils.toString(value); }
    var json = GDM_Utils.safeJsonStringify(serial, 'null');
    if (json.length <= 4000) return serial;
    return { truncated: true, preview: json.substring(0, 3800) };
  },

  makeSerializable_: function(value) { return this.compactData_(value); },

  writeConsole_: function(entry) {
    var prefix = '[' + entry.level + ']';
    var text = prefix + ' ' + (entry.timestamp || '') + ' - ' + (entry.message || '');
    if (entry.level === 'ERROR') console.error(text);
    else if (entry.level === 'WARN') console.warn(text);
    else console.log(text);
  },

  validate: function() {
    return {
      ok: true,
      file: 'Core/Logger.gs',
      persistentMax: this.PERSIST_MAX_,
      noisyEventsPersisted: false,
      storage: 'UserProperties avec repli Document/ScriptProperties'
    };
  }
});

/** Diagnostic lecture seule du stockage de logs du job courant. */
function GDM_loggerHealthCheck() {
  var jobId = GDM_State.getCurrentJobId();
  if (!jobId) return { ok: true, message: 'Aucun job courant.' };
  var logs = GDM_Logger.getAllLogs(jobId);
  return {
    ok: true,
    jobId: jobId,
    persistentEntries: GDM_Logger.count(jobId),
    visibleEntries: logs.length,
    stats: GDM_Logger.getStats(jobId),
    last: logs.length ? logs[logs.length - 1] : null
  };
}
