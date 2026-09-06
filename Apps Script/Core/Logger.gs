/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Logger.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Système centralisé de journalisation de Google Drive Manager PRO V2.
 *
 * Ce fichier gère :
 * - logs DEBUG / INFO / WARN / ERROR ;
 * - événements des jobs ;
 * - événements de la queue ;
 * - erreurs détaillées ;
 * - stockage temporaire en mémoire ;
 * - stockage persistant dans PropertiesService ;
 * - limitation automatique du nombre de logs ;
 * - récupération des logs d'un job ;
 * - nettoyage des logs ;
 * - export sérialisable vers l'interface.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 *
 * IMPORTANT
 * ---------
 * - Aucun module ne doit créer son propre système de logs.
 * - Logger.gs ne contient aucune logique métier.
 * - Logger.gs ne supprime jamais de fichiers Google Drive.
 **************************************************************************************************/

'use strict';


/**************************************************************************************************
 * MÉMOIRE TEMPORAIRE DES LOGS
 *
 * Cette variable n'est valable que pendant l'exécution Apps Script courante.
 * Les logs importants sont également sauvegardés via PropertiesService.
 **************************************************************************************************/

var GDM_LOG_MEMORY = {};


/**************************************************************************************************
 * LOGGER
 **************************************************************************************************/

const GDM_Logger = Object.freeze({


  /************************************************************************************************
   * API PRINCIPALE
   ************************************************************************************************/

  log: function(level, message, context) {

    context = context || {};

    level = this.normalizeLevel_(level);

    var entry = this.createEntry_(
      level,
      message,
      context
    );

    this.addToMemory_(entry);

    if (
      GDM_Config.get(
        'LOG.CONSOLE_ENABLED',
        true
      )
    ) {
      this.writeConsole_(entry);
    }

    if (
      GDM_Config.get(
        'LOG.STORE_IN_PROPERTIES',
        true
      )
    ) {
      this.persist_(entry);
    }

    return entry;
  },


  debug: function(message, context) {
    return this.log(
      GDM_Config.get(
        'LOG.LEVELS.DEBUG',
        'DEBUG'
      ),
      message,
      context
    );
  },


  info: function(message, context) {
    return this.log(
      GDM_Config.get(
        'LOG.LEVELS.INFO',
        'INFO'
      ),
      message,
      context
    );
  },


  warn: function(message, context) {
    return this.log(
      GDM_Config.get(
        'LOG.LEVELS.WARN',
        'WARN'
      ),
      message,
      context
    );
  },


  error: function(messageOrError, context) {

    context = context || {};

    var message = '';

    if (
      messageOrError &&
      typeof messageOrError === 'object'
    ) {
      message = GDM_Utils.getErrorMessage(
        messageOrError
      );

      context.error = GDM_Utils.errorToObject(
        messageOrError,
        context
      );
    } else {
      message = GDM_Utils.toString(
        messageOrError
      );
    }

    return this.log(
      GDM_Config.get(
        'LOG.LEVELS.ERROR',
        'ERROR'
      ),
      message,
      context
    );
  },


  /************************************************************************************************
   * ÉVÉNEMENTS
   ************************************************************************************************/

  event: function(eventName, context) {

    context = context || {};

    eventName = GDM_Utils.trim(eventName);

    if (!eventName) {
      throw new Error(
        'GDM_Logger.event : eventName obligatoire.'
      );
    }

    context.event = eventName;

    var message = context.message
      ? context.message
      : eventName;

    return this.info(
      message,
      context
    );
  },


  jobCreated: function(jobId, context) {
    context = this.withJob_(jobId, context);

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.JOB_CREATED',
        'JOB_CREATED'
      ),
      context
    );
  },


  jobStarted: function(jobId, context) {
    context = this.withJob_(jobId, context);

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.JOB_STARTED',
        'JOB_STARTED'
      ),
      context
    );
  },


  jobPaused: function(jobId, context) {
    context = this.withJob_(jobId, context);

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.JOB_PAUSED',
        'JOB_PAUSED'
      ),
      context
    );
  },


  jobResumed: function(jobId, context) {
    context = this.withJob_(jobId, context);

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.JOB_RESUMED',
        'JOB_RESUMED'
      ),
      context
    );
  },


  jobCompleted: function(jobId, context) {
    context = this.withJob_(jobId, context);

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.JOB_COMPLETED',
        'JOB_COMPLETED'
      ),
      context
    );
  },


  jobCancelled: function(jobId, context) {
    context = this.withJob_(jobId, context);

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.JOB_CANCELLED',
        'JOB_CANCELLED'
      ),
      context
    );
  },


  jobError: function(jobId, error, context) {

    context = this.withJob_(
      jobId,
      context
    );

    context.event = GDM_Config.get(
      'LOG.EVENTS.JOB_ERROR',
      'JOB_ERROR'
    );

    return this.error(
      error,
      context
    );
  },


  scanStarted: function(jobId, context) {

    context = this.withJob_(
      jobId,
      context
    );

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.SCAN_STARTED',
        'SCAN_STARTED'
      ),
      context
    );
  },


  scanCompleted: function(jobId, context) {

    context = this.withJob_(
      jobId,
      context
    );

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.SCAN_COMPLETED',
        'SCAN_COMPLETED'
      ),
      context
    );
  },


  itemProcessed: function(jobId, context) {

    context = this.withJob_(
      jobId,
      context
    );

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.ITEM_PROCESSED',
        'ITEM_PROCESSED'
      ),
      context
    );
  },


  itemSkipped: function(jobId, context) {

    context = this.withJob_(
      jobId,
      context
    );

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.ITEM_SKIPPED',
        'ITEM_SKIPPED'
      ),
      context
    );
  },


  itemError: function(jobId, error, context) {

    context = this.withJob_(
      jobId,
      context
    );

    context.event = GDM_Config.get(
      'LOG.EVENTS.ITEM_ERROR',
      'ITEM_ERROR'
    );

    return this.error(
      error,
      context
    );
  },


  queueCreated: function(jobId, context) {

    context = this.withJob_(
      jobId,
      context
    );

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.QUEUE_CREATED',
        'QUEUE_CREATED'
      ),
      context
    );
  },


  queueUpdated: function(jobId, context) {

    context = this.withJob_(
      jobId,
      context
    );

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.QUEUE_UPDATED',
        'QUEUE_UPDATED'
      ),
      context
    );
  },


  queueCompleted: function(jobId, context) {

    context = this.withJob_(
      jobId,
      context
    );

    return this.event(
      GDM_Config.get(
        'LOG.EVENTS.QUEUE_COMPLETED',
        'QUEUE_COMPLETED'
      ),
      context
    );
  },


  /************************************************************************************************
   * RÉCUPÉRATION
   ************************************************************************************************/

  getLogs: function(jobId, options) {

    options = options || {};

    jobId = GDM_Utils.trim(jobId);

    if (!jobId) {
      return [];
    }

    var logs = [];

    var persistentLogs =
      this.readPersistent_(jobId);

    for (
      var i = 0;
      i < persistentLogs.length;
      i++
    ) {
      logs.push(persistentLogs[i]);
    }

    var memoryLogs =
      GDM_LOG_MEMORY[jobId] || [];

    for (
      var j = 0;
      j < memoryLogs.length;
      j++
    ) {
      var memoryEntry =
        memoryLogs[j];

      var found = false;

      for (
        var k = 0;
        k < logs.length;
        k++
      ) {
        if (
          logs[k].id ===
          memoryEntry.id
        ) {
          found = true;
          break;
        }
      }

      if (!found) {
        logs.push(memoryEntry);
      }
    }

    logs.sort(function(a, b) {
      return String(
        a.timestamp || ''
      ).localeCompare(
        String(
          b.timestamp || ''
        )
      );
    });

    logs =
      this.filterLogs_(
        logs,
        options
      );

    var offset =
      Math.max(
        0,
        GDM_Utils.toInteger(
          options.offset,
          0
        )
      );

    var limit =
      GDM_Utils.toPositiveInteger(
        options.limit,
        GDM_Config.get(
          'UI.LOG_PAGE_SIZE',
          100
        )
      );

    return logs.slice(
      offset,
      offset + limit
    );
  },


  getAllLogs: function(jobId) {

    return this.getLogs(
      jobId,
      {
        offset: 0,
        limit: GDM_Config.get(
          'LOG.STORE_MAX_ENTRIES',
          500
        )
      }
    );
  },


  count: function(jobId) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      return 0;
    }

    return this.readPersistent_(
      jobId
    ).length;
  },


  getLast: function(jobId) {

    var logs =
      this.getAllLogs(jobId);

    if (!logs.length) {
      return null;
    }

    return logs[
      logs.length - 1
    ];
  },


  getErrors: function(jobId) {

    return this.getLogs(
      jobId,
      {
        level: 'ERROR',
        offset: 0,
        limit: GDM_Config.get(
          'LOG.STORE_MAX_ENTRIES',
          500
        )
      }
    );
  },


  /************************************************************************************************
   * NETTOYAGE
   ************************************************************************************************/

  clear: function(jobId) {

    jobId =
      GDM_Utils.trim(jobId);

    if (!jobId) {
      return false;
    }

    delete GDM_LOG_MEMORY[
      jobId
    ];

    this.deletePersistent_(
      jobId
    );

    return true;
  },


  clearMemory: function(jobId) {

    jobId =
      GDM_Utils.trim(jobId);

    if (!jobId) {
      return false;
    }

    delete GDM_LOG_MEMORY[
      jobId
    ];

    return true;
  },


  /************************************************************************************************
   * CRÉATION D'UNE ENTRÉE
   ************************************************************************************************/

  createEntry_: function(
    level,
    message,
    context
  ) {

    context = context || {};

    var entry = {

      id:
        GDM_Utils.generateId(
          'LOG'
        ),

      timestamp:
        GDM_Utils.nowIso(),

      level:
        level,

      event:
        GDM_Utils.trim(
          context.event
        ),

      module:
        GDM_Utils.trim(
          context.module
        ),

      action:
        GDM_Utils.trim(
          context.action
        ),

      jobId:
        GDM_Utils.trim(
          context.jobId
        ),

      taskId:
        GDM_Utils.trim(
          context.taskId
        ),

      itemId:
        GDM_Utils.trim(
          context.itemId
        ),

      itemName:
        GDM_Utils.trim(
          context.itemName
        ),

      message:
        GDM_Utils.truncate(
          GDM_Utils.toString(
            message
          ),
          GDM_Config.get(
            'LOG.MAX_MESSAGE_LENGTH',
            2000
          )
        ),

      data:
        typeof context.data ===
        'undefined'
          ? null
          : this.makeSerializable_(
              context.data
            ),

      error:
        context.error
          ? this.makeSerializable_(
              context.error
            )
          : null
    };

    return entry;
  },


  /************************************************************************************************
   * MÉMOIRE
   ************************************************************************************************/

  addToMemory_: function(entry) {

    var jobId =
      entry.jobId ||
      '_GLOBAL_';

    if (
      !GDM_LOG_MEMORY[
        jobId
      ]
    ) {
      GDM_LOG_MEMORY[
        jobId
      ] = [];
    }

    GDM_LOG_MEMORY[
      jobId
    ].push(entry);

    var maxLogs =
      GDM_Config.get(
        'LOG.MAX_MEMORY_LOGS',
        500
      );

    if (
      GDM_LOG_MEMORY[
        jobId
      ].length >
      maxLogs
    ) {
      GDM_LOG_MEMORY[
        jobId
      ] =
        GDM_LOG_MEMORY[
          jobId
        ].slice(
          -maxLogs
        );
    }
  },


  /************************************************************************************************
   * STOCKAGE PERSISTANT
   ************************************************************************************************/

  persist_: function(entry) {

    var jobId =
      entry.jobId ||
      '_GLOBAL_';

    try {

      GDM_Utils.withScriptLock(
        function() {

          var logs =
            GDM_Logger.readPersistent_(
              jobId
            );

          logs.push(
            entry
          );

          var maxEntries =
            GDM_Config.get(
              'LOG.STORE_MAX_ENTRIES',
              500
            );

          if (
            logs.length >
            maxEntries
          ) {
            logs =
              logs.slice(
                -maxEntries
              );
          }

          GDM_Logger.writePersistent_(
            jobId,
            logs
          );
        },
        GDM_Config.get(
          'LOCK.STATE_LOCK_TIMEOUT_MS',
          5000
        )
      );

    } catch (error) {

      if (
        GDM_Config.get(
          'LOG.CONSOLE_ENABLED',
          true
        )
      ) {
        console.warn(
          '[GDM Logger] Impossible de sauvegarder les logs : ' +
          GDM_Utils.getErrorMessage(
            error
          )
        );
      }
    }
  },


  readPersistent_: function(jobId) {

    jobId =
      GDM_Utils.trim(jobId);

    if (!jobId) {
      jobId = '_GLOBAL_';
    }

    var baseKey =
      GDM_Config.logKey(
        jobId
      );

    var properties =
      PropertiesService
        .getScriptProperties();

    var metaRaw =
      properties.getProperty(
        baseKey + '_META'
      );

    if (!metaRaw) {

      var legacy =
        properties.getProperty(
          baseKey
        );

      if (!legacy) {
        return [];
      }

      return GDM_Utils.safeJsonParse(
        legacy,
        []
      ) || [];
    }

    var meta =
      GDM_Utils.safeJsonParse(
        metaRaw,
        {}
      );

    var chunkCount =
      GDM_Utils.toInteger(
        meta.chunkCount,
        0
      );

    if (
      chunkCount <= 0
    ) {
      return [];
    }

    var json = '';

    for (
      var i = 0;
      i < chunkCount;
      i++
    ) {

      var part =
        properties.getProperty(
          baseKey +
          '_PART_' +
          i
        );

      if (
        part !== null
      ) {
        json += part;
      }
    }

    var logs =
      GDM_Utils.safeJsonParse(
        json,
        []
      );

    return Array.isArray(logs)
      ? logs
      : [];
  },


  writePersistent_: function(
    jobId,
    logs
  ) {

    jobId =
      GDM_Utils.trim(jobId);

    if (!jobId) {
      jobId = '_GLOBAL_';
    }

    logs =
      Array.isArray(logs)
        ? logs
        : [];

    var baseKey =
      GDM_Config.logKey(
        jobId
      );

    var properties =
      PropertiesService
        .getScriptProperties();

    var json =
      GDM_Utils.safeJsonStringify(
        logs,
        '[]'
      );

    var chunkSize =
      GDM_Config.get(
        'STATE.PROPERTY_CHUNK_SIZE',
        7000
      );

    chunkSize =
      Math.max(
        1000,
        GDM_Utils.toInteger(
          chunkSize,
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

    if (
      chunks.length === 0
    ) {
      chunks.push(
        '[]'
      );
    }

    var previousMeta =
      GDM_Utils.safeJsonParse(
        properties.getProperty(
          baseKey + '_META'
        ),
        {}
      );

    var previousCount =
      GDM_Utils.toInteger(
        previousMeta.chunkCount,
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
      var oldIndex =
        chunks.length;
      oldIndex <
        previousCount;
      oldIndex++
    ) {
      properties.deleteProperty(
        baseKey +
        '_PART_' +
        oldIndex
      );
    }

    properties.setProperty(
      baseKey + '_META',
      JSON.stringify({
        chunkCount:
          chunks.length,

        entries:
          logs.length,

        updatedAt:
          GDM_Utils.nowIso()
      })
    );

    properties.deleteProperty(
      baseKey
    );

    return true;
  },


  deletePersistent_: function(
    jobId
  ) {

    jobId =
      GDM_Utils.trim(jobId);

    if (!jobId) {
      jobId = '_GLOBAL_';
    }

    var baseKey =
      GDM_Config.logKey(
        jobId
      );

    var properties =
      PropertiesService
        .getScriptProperties();

    var meta =
      GDM_Utils.safeJsonParse(
        properties.getProperty(
          baseKey + '_META'
        ),
        {}
      );

    var count =
      GDM_Utils.toInteger(
        meta.chunkCount,
        0
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
      baseKey + '_META'
    );

    properties.deleteProperty(
      baseKey
    );

    return true;
  },


  /************************************************************************************************
   * FILTRES
   ************************************************************************************************/

  filterLogs_: function(
    logs,
    options
  ) {

    options =
      options || {};

    var level =
      GDM_Utils.trim(
        options.level
      ).toUpperCase();

    var eventName =
      GDM_Utils.trim(
        options.event
      );

    var moduleName =
      GDM_Utils.trim(
        options.module
      );

    var action =
      GDM_Utils.trim(
        options.action
      );

    var search =
      GDM_Utils.trim(
        options.search
      ).toLowerCase();

    var result = [];

    for (
      var i = 0;
      i < logs.length;
      i++
    ) {

      var entry =
        logs[i];

      if (
        level &&
        String(
          entry.level || ''
        ).toUpperCase() !==
        level
      ) {
        continue;
      }

      if (
        eventName &&
        entry.event !==
        eventName
      ) {
        continue;
      }

      if (
        moduleName &&
        entry.module !==
        moduleName
      ) {
        continue;
      }

      if (
        action &&
        entry.action !==
        action
      ) {
        continue;
      }

      if (
        search
      ) {
        var haystack =
          (
            String(
              entry.message || ''
            ) +
            ' ' +
            String(
              entry.itemName || ''
            ) +
            ' ' +
            String(
              entry.itemId || ''
            )
          ).toLowerCase();

        if (
          haystack.indexOf(
            search
          ) === -1
        ) {
          continue;
        }
      }

      result.push(
        entry
      );
    }

    return result;
  },


  /************************************************************************************************
   * CONSOLE
   ************************************************************************************************/

  writeConsole_: function(entry) {

    var prefix =
      '[GDM PRO][' +
      entry.level +
      ']';

    if (
      entry.module
    ) {
      prefix +=
        '[' +
        entry.module +
        ']';
    }

    if (
      entry.action
    ) {
      prefix +=
        '[' +
        entry.action +
        ']';
    }

    if (
      entry.jobId
    ) {
      prefix +=
        '[' +
        entry.jobId +
        ']';
    }

    var message =
      prefix +
      ' ' +
      entry.message;

    try {

      switch (
        entry.level
      ) {

        case 'ERROR':
          console.error(
            message
          );
          break;

        case 'WARN':
          console.warn(
            message
          );
          break;

        case 'DEBUG':
          console.log(
            message
          );
          break;

        default:
          console.log(
            message
          );
      }

    } catch (error) {

      try {
        Logger.log(
          message
        );
      } catch (
        ignored
      ) {}
    }
  },


  /************************************************************************************************
   * HELPERS INTERNES
   ************************************************************************************************/

  normalizeLevel_: function(level) {

    level =
      GDM_Utils.trim(
        level
      ).toUpperCase();

    var levels =
      GDM_Config.get(
        'LOG.LEVELS',
        {}
      ) || {};

    var allowed = [
      levels.DEBUG || 'DEBUG',
      levels.INFO || 'INFO',
      levels.WARN || 'WARN',
      levels.ERROR || 'ERROR'
    ];

    if (
      allowed.indexOf(
        level
      ) === -1
    ) {
      level = 'INFO';
    }

    return level;
  },


  withJob_: function(
    jobId,
    context
  ) {

    context =
      context || {};

    var copy =
      GDM_Utils.merge(
        {},
        context
      );

    copy.jobId =
      GDM_Utils.trim(
        jobId
      );

    return copy;
  },


  makeSerializable_: function(
    value
  ) {

    if (
      value === null ||
      typeof value ===
      'undefined'
    ) {
      return null;
    }

    try {
      return JSON.parse(
        JSON.stringify(
          value
        )
      );
    } catch (
      error
    ) {
      return GDM_Utils.toString(
        value
      );
    }
  },


  /************************************************************************************************
   * DIAGNOSTIC
   ************************************************************************************************/

  getStats: function(jobId) {

    var logs =
      this.getAllLogs(
        jobId
      );

    var stats = {
      total: 0,
      debug: 0,
      info: 0,
      warn: 0,
      error: 0
    };

    for (
      var i = 0;
      i < logs.length;
      i++
    ) {

      stats.total++;

      var level =
        String(
          logs[i].level || ''
        ).toUpperCase();

      switch (
        level
      ) {

        case 'DEBUG':
          stats.debug++;
          break;

        case 'WARN':
          stats.warn++;
          break;

        case 'ERROR':
          stats.error++;
          break;

        default:
          stats.info++;
      }
    }

    return stats;
  },


  /************************************************************************************************
   * VALIDATION LOGGER
   ************************************************************************************************/

  validate: function() {

    var errors = [];

    var testJobId =
      'LOGGER_TEST_' +
      Date.now();

    try {

      var entry =
        this.info(
          'Test Logger.gs',
          {
            jobId:
              testJobId,

            module:
              'Logger',

            action:
              'VALIDATE'
          }
        );

      if (
        !entry ||
        !entry.id
      ) {
        errors.push(
          'Création d’une entrée de log impossible.'
        );
      }

      var logs =
        this.getAllLogs(
          testJobId
        );

      if (
        !logs.length
      ) {
        errors.push(
          'Lecture des logs impossible.'
        );
      }

    } catch (
      error
    ) {

      errors.push(
        'Erreur Logger : ' +
        GDM_Utils.getErrorMessage(
          error
        )
      );

    } finally {

      try {
        this.clear(
          testJobId
        );
      } catch (
        cleanupError
      ) {
        errors.push(
          'Nettoyage du test Logger impossible : ' +
          GDM_Utils.getErrorMessage(
            cleanupError
          )
        );
      }
    }

    return {
      ok:
        errors.length === 0,

      file:
        'Core/Logger.gs',

      version:
        GDM_APP.VERSION,

      errors:
        errors
    };
  }

});