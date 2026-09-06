/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/State.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Gestion centralisée de l'état des jobs de Google Drive Manager PRO V2.
 *
 * Ce fichier gère :
 * - création des jobs ;
 * - sauvegarde persistante ;
 * - lecture des états ;
 * - mise à jour de progression ;
 * - compteurs processed / success / skipped / errors ;
 * - statut PENDING / RUNNING / PAUSED / COMPLETED / CANCELLED / ERROR ;
 * - élément actuellement traité ;
 * - job courant ;
 * - résultats persistants ;
 * - stockage fractionné dans PropertiesService ;
 * - reprise après interruption Apps Script ;
 * - nettoyage des anciens jobs terminés.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 *
 * IMPORTANT
 * ---------
 * - State.gs ne contient aucune logique métier.
 * - Les gros objets sont fractionnés dans PropertiesService.
 * - Les opérations d'écriture sont protégées par LockService.
 * - Aucun fichier Google Drive n'est supprimé par ce module.
 **************************************************************************************************/

'use strict';


const GDM_State = Object.freeze({


  /************************************************************************************************
   * CRÉATION D'UN JOB
   ************************************************************************************************/

  create: function(options) {

    options = options || {};

    var moduleName = GDM_Utils.trim(
      options.module
    );

    var action = GDM_Utils.trim(
      options.action
    );

    if (!moduleName) {
      throw new Error(
        'GDM_State.create : module obligatoire.'
      );
    }

    if (!GDM_Config.isValidModule(moduleName)) {
      throw new Error(
        'GDM_State.create : module invalide : ' +
        moduleName
      );
    }

    if (!action) {
      throw new Error(
        'GDM_State.create : action obligatoire.'
      );
    }

    var jobId = GDM_Utils.trim(
      options.jobId
    ) || GDM_Utils.generateJobId();

    if (this.exists(jobId)) {
      throw new Error(
        'Un job existe déjà avec cet identifiant : ' +
        jobId
      );
    }

    var now = GDM_Utils.nowIso();

    var state = {

      schemaVersion: 1,

      jobId: jobId,

      module: moduleName,

      action: action,

      status: GDM_JOB_STATUS.PENDING,

      source: this.makeSerializable_(
        options.source || null
      ),

      destination: this.makeSerializable_(
        options.destination || null
      ),

      parameters: this.makeSerializable_(
        options.parameters || {}
      ),

      processed: 0,

      totalKnown: Math.max(
        0,
        GDM_Utils.toInteger(
          options.totalKnown,
          0
        )
      ),

      success: 0,

      skipped: 0,

      errors: 0,

      currentItem: '',

      currentItemId: '',

      currentTaskId: '',

      progressPercent: 0,

      message: GDM_Utils.toString(
        options.message
      ),

      startedAt: '',

      finishedAt: '',

      createdAt: now,

      updatedAt: now,

      lastCheckpointAt: now,

      lastError: null,

      cancelRequested: false,

      pauseRequested: false,

      resumeCount: 0,

      metadata: this.makeSerializable_(
        options.metadata || {}
      )
    };

    this.writeState_(
      jobId,
      state
    );

    if (
      GDM_Utils.toBoolean(
        options.setCurrent,
        true
      )
    ) {
      this.setCurrentJobId(
        jobId
      );
    }

    try {
      GDM_Logger.jobCreated(
        jobId,
        {
          module: moduleName,
          action: action,
          message: 'Job créé.',
          data: {
            status: state.status
          }
        }
      );
    } catch (ignored) {}

    return this.cloneState_(
      state
    );
  },


  /************************************************************************************************
   * LECTURE
   ************************************************************************************************/

  get: function(jobId) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      return null;
    }

    var state = this.readState_(
      jobId
    );

    return state
      ? this.cloneState_(state)
      : null;
  },


  require: function(jobId) {

    var state = this.get(
      jobId
    );

    if (!state) {
      throw new Error(
        'Job introuvable : ' +
        GDM_Utils.toString(jobId)
      );
    }

    return state;
  },


  exists: function(jobId) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      return false;
    }

    var baseKey = GDM_Config.stateKey(
      jobId
    );

    var properties = PropertiesService
      .getScriptProperties();

    return (
      properties.getProperty(
        baseKey + '_META'
      ) !== null ||
      properties.getProperty(
        baseKey
      ) !== null
    );
  },


  /************************************************************************************************
   * JOB COURANT
   ************************************************************************************************/

  setCurrentJobId: function(jobId) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      throw new Error(
        'GDM_State.setCurrentJobId : jobId obligatoire.'
      );
    }

    PropertiesService
      .getScriptProperties()
      .setProperty(
        GDM_Config.get(
          'STORAGE_KEYS.CURRENT_JOB_ID',
          'GDMV2_CURRENT_JOB_ID'
        ),
        jobId
      );

    return jobId;
  },


  getCurrentJobId: function() {

    return GDM_Utils.trim(
      PropertiesService
        .getScriptProperties()
        .getProperty(
          GDM_Config.get(
            'STORAGE_KEYS.CURRENT_JOB_ID',
            'GDMV2_CURRENT_JOB_ID'
          )
        )
    );
  },


  getCurrent: function() {

    var jobId = this.getCurrentJobId();

    if (!jobId) {
      return null;
    }

    var state = this.get(
      jobId
    );

    if (!state) {
      this.clearCurrentJobId(
        jobId
      );

      return null;
    }

    return state;
  },


  clearCurrentJobId: function(expectedJobId) {

    var key = GDM_Config.get(
      'STORAGE_KEYS.CURRENT_JOB_ID',
      'GDMV2_CURRENT_JOB_ID'
    );

    var properties = PropertiesService
      .getScriptProperties();

    if (expectedJobId) {
      var current = properties.getProperty(
        key
      );

      if (
        current &&
        current !== String(expectedJobId)
      ) {
        return false;
      }
    }

    properties.deleteProperty(
      key
    );

    return true;
  },


  /************************************************************************************************
   * MISE À JOUR GÉNÉRALE
   ************************************************************************************************/

  update: function(jobId, patch) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      throw new Error(
        'GDM_State.update : jobId obligatoire.'
      );
    }

    patch = patch || {};

    var updated = GDM_Utils.withScriptLock(
      function() {

        var current = GDM_State.readState_(
          jobId
        );

        if (!current) {
          throw new Error(
            'Job introuvable : ' +
            jobId
          );
        }

        var next = GDM_State.applyPatch_(
          current,
          patch
        );

        next.updatedAt = GDM_Utils.nowIso();

        GDM_State.recalculateProgress_(
          next
        );

        GDM_State.writeStateUnlocked_(
          jobId,
          next
        );

        return next;
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );

    return this.cloneState_(
      updated
    );
  },


  /************************************************************************************************
   * STATUT
   ************************************************************************************************/

  setStatus: function(jobId, status, message) {

    status = GDM_Utils.trim(
      status
    ).toUpperCase();

    if (!GDM_Config.isValidJobStatus(status)) {
      throw new Error(
        'Statut de job invalide : ' +
        status
      );
    }

    var patch = {
      status: status
    };

    if (
      typeof message !==
      'undefined'
    ) {
      patch.message =
        GDM_Utils.toString(
          message
        );
    }

    if (
      status ===
      GDM_JOB_STATUS.RUNNING
    ) {
      var state = this.require(
        jobId
      );

      if (!state.startedAt) {
        patch.startedAt =
          GDM_Utils.nowIso();
      }

      patch.finishedAt = '';
      patch.pauseRequested = false;
    }

    if (
      status ===
        GDM_JOB_STATUS.COMPLETED ||
      status ===
        GDM_JOB_STATUS.CANCELLED ||
      status ===
        GDM_JOB_STATUS.ERROR
    ) {
      patch.finishedAt =
        GDM_Utils.nowIso();
    }

    return this.update(
      jobId,
      patch
    );
  },


  start: function(jobId, message) {

    var state = this.setStatus(
      jobId,
      GDM_JOB_STATUS.RUNNING,
      message || 'Traitement démarré.'
    );

    try {
      GDM_Logger.jobStarted(
        jobId,
        {
          module: state.module,
          action: state.action,
          message: state.message
        }
      );
    } catch (ignored) {}

    return state;
  },


  pause: function(jobId, message) {

    var state = this.update(
      jobId,
      {
        status: GDM_JOB_STATUS.PAUSED,
        pauseRequested: true,
        message:
          message ||
          'Traitement en pause.'
      }
    );

    try {
      GDM_Logger.jobPaused(
        jobId,
        {
          module: state.module,
          action: state.action,
          message: state.message
        }
      );
    } catch (ignored) {}

    return state;
  },


  resume: function(jobId, message) {

    var current = this.require(
      jobId
    );

    if (
      current.status ===
      GDM_JOB_STATUS.COMPLETED ||
      current.status ===
      GDM_JOB_STATUS.CANCELLED
    ) {
      throw new Error(
        'Impossible de reprendre un job terminé ou annulé.'
      );
    }

    var state = this.update(
      jobId,
      {
        status: GDM_JOB_STATUS.RUNNING,
        pauseRequested: false,
        cancelRequested: false,
        resumeCount:
          Number(
            current.resumeCount || 0
          ) + 1,
        message:
          message ||
          'Traitement repris.'
      }
    );

    try {
      GDM_Logger.jobResumed(
        jobId,
        {
          module: state.module,
          action: state.action,
          message: state.message,
          data: {
            resumeCount:
              state.resumeCount
          }
        }
      );
    } catch (ignored) {}

    return state;
  },


  complete: function(jobId, message) {

    var state = this.update(
      jobId,
      {
        status:
          GDM_JOB_STATUS.COMPLETED,

        progressPercent: 100,

        finishedAt:
          GDM_Utils.nowIso(),

        currentItem: '',

        currentItemId: '',

        currentTaskId: '',

        pauseRequested: false,

        cancelRequested: false,

        message:
          message ||
          'Traitement terminé.'
      }
    );

    this.clearCurrentJobId(
      jobId
    );

    try {
      GDM_Logger.jobCompleted(
        jobId,
        {
          module: state.module,
          action: state.action,
          message: state.message,
          data: {
            processed:
              state.processed,
            success:
              state.success,
            skipped:
              state.skipped,
            errors:
              state.errors
          }
        }
      );
    } catch (ignored) {}

    return state;
  },


  cancel: function(jobId, message) {

    var state = this.update(
      jobId,
      {
        status:
          GDM_JOB_STATUS.CANCELLED,

        cancelRequested: true,

        pauseRequested: false,

        finishedAt:
          GDM_Utils.nowIso(),

        currentItem: '',

        currentItemId: '',

        currentTaskId: '',

        message:
          message ||
          'Traitement annulé.'
      }
    );

    this.clearCurrentJobId(
      jobId
    );

    try {
      GDM_Logger.jobCancelled(
        jobId,
        {
          module: state.module,
          action: state.action,
          message: state.message
        }
      );
    } catch (ignored) {}

    return state;
  },


  fail: function(jobId, error, message) {

    var errorObject =
      GDM_Utils.errorToObject(
        error,
        {
          jobId: jobId
        }
      );

    var state = this.update(
      jobId,
      {
        status:
          GDM_JOB_STATUS.ERROR,

        finishedAt:
          GDM_Utils.nowIso(),

        currentItem: '',

        currentItemId: '',

        currentTaskId: '',

        lastError:
          errorObject,

        message:
          message ||
          GDM_Utils.getErrorMessage(
            error
          )
      }
    );

    this.clearCurrentJobId(
      jobId
    );

    try {
      GDM_Logger.jobError(
        jobId,
        error,
        {
          module: state.module,
          action: state.action,
          message: state.message
        }
      );
    } catch (ignored) {}

    return state;
  },


  /************************************************************************************************
   * DEMANDES D'ANNULATION / PAUSE
   ************************************************************************************************/

  requestCancel: function(jobId) {

    var state = this.update(
      jobId,
      {
        cancelRequested: true,
        message:
          'Annulation demandée.'
      }
    );

    return state;
  },


  requestPause: function(jobId) {

    return this.update(
      jobId,
      {
        pauseRequested: true,
        message:
          'Mise en pause demandée.'
      }
    );
  },


  clearPauseRequest: function(jobId) {

    return this.update(
      jobId,
      {
        pauseRequested: false
      }
    );
  },


  isCancelled: function(jobId) {

    var state = this.get(
      jobId
    );

    if (!state) {
      return false;
    }

    return (
      state.cancelRequested === true ||
      state.status ===
        GDM_JOB_STATUS.CANCELLED
    );
  },


  isPauseRequested: function(jobId) {

    var state = this.get(
      jobId
    );

    if (!state) {
      return false;
    }

    return (
      state.pauseRequested === true ||
      state.status ===
        GDM_JOB_STATUS.PAUSED
    );
  },


  isRunning: function(jobId) {

    var state = this.get(
      jobId
    );

    return Boolean(
      state &&
      state.status ===
        GDM_JOB_STATUS.RUNNING
    );
  },


  isTerminal: function(jobId) {

    var state = this.get(
      jobId
    );

    if (!state) {
      return false;
    }

    return this.isTerminalStatus_(
      state.status
    );
  },


  /************************************************************************************************
   * PROGRESSION
   ************************************************************************************************/

  checkpoint: function(jobId, data) {

    data = data || {};

    var patch = {
      lastCheckpointAt:
        GDM_Utils.nowIso()
    };

    if (
      typeof data.processed !==
      'undefined'
    ) {
      patch.processed =
        Math.max(
          0,
          GDM_Utils.toInteger(
            data.processed,
            0
          )
        );
    }

    if (
      typeof data.totalKnown !==
      'undefined'
    ) {
      patch.totalKnown =
        Math.max(
          0,
          GDM_Utils.toInteger(
            data.totalKnown,
            0
          )
        );
    }

    if (
      typeof data.success !==
      'undefined'
    ) {
      patch.success =
        Math.max(
          0,
          GDM_Utils.toInteger(
            data.success,
            0
          )
        );
    }

    if (
      typeof data.skipped !==
      'undefined'
    ) {
      patch.skipped =
        Math.max(
          0,
          GDM_Utils.toInteger(
            data.skipped,
            0
          )
        );
    }

    if (
      typeof data.errors !==
      'undefined'
    ) {
      patch.errors =
        Math.max(
          0,
          GDM_Utils.toInteger(
            data.errors,
            0
          )
        );
    }

    if (
      typeof data.currentItem !==
      'undefined'
    ) {
      patch.currentItem =
        GDM_Utils.toString(
          data.currentItem
        );
    }

    if (
      typeof data.currentItemId !==
      'undefined'
    ) {
      patch.currentItemId =
        GDM_Utils.toString(
          data.currentItemId
        );
    }

    if (
      typeof data.currentTaskId !==
      'undefined'
    ) {
      patch.currentTaskId =
        GDM_Utils.toString(
          data.currentTaskId
        );
    }

    if (
      typeof data.message !==
      'undefined'
    ) {
      patch.message =
        GDM_Utils.toString(
          data.message
        );
    }

    return this.update(
      jobId,
      patch
    );
  },


  increment: function(jobId, counters) {

    counters = counters || {};

    return GDM_Utils.withScriptLock(
      function() {

        var state =
          GDM_State.readState_(
            jobId
          );

        if (!state) {
          throw new Error(
            'Job introuvable : ' +
            jobId
          );
        }

        state.processed =
          Math.max(
            0,
            Number(
              state.processed || 0
            ) +
            Number(
              counters.processed || 0
            )
          );

        state.success =
          Math.max(
            0,
            Number(
              state.success || 0
            ) +
            Number(
              counters.success || 0
            )
          );

        state.skipped =
          Math.max(
            0,
            Number(
              state.skipped || 0
            ) +
            Number(
              counters.skipped || 0
            )
          );

        state.errors =
          Math.max(
            0,
            Number(
              state.errors || 0
            ) +
            Number(
              counters.errors || 0
            )
          );

        if (
          typeof counters.totalKnown !==
          'undefined'
        ) {
          state.totalKnown =
            Math.max(
              0,
              Number(
                counters.totalKnown || 0
              )
            );
        }

        if (
          typeof counters.currentItem !==
          'undefined'
        ) {
          state.currentItem =
            GDM_Utils.toString(
              counters.currentItem
            );
        }

        if (
          typeof counters.currentItemId !==
          'undefined'
        ) {
          state.currentItemId =
            GDM_Utils.toString(
              counters.currentItemId
            );
        }

        if (
          typeof counters.currentTaskId !==
          'undefined'
        ) {
          state.currentTaskId =
            GDM_Utils.toString(
              counters.currentTaskId
            );
        }

        state.updatedAt =
          GDM_Utils.nowIso();

        GDM_State.recalculateProgress_(
          state
        );

        GDM_State.writeStateUnlocked_(
          jobId,
          state
        );

        return GDM_State.cloneState_(
          state
        );
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  incrementProcessed: function(
    jobId,
    success,
    skipped,
    errors
  ) {

    return this.increment(
      jobId,
      {
        processed: 1,
        success:
          success ? 1 : 0,
        skipped:
          skipped ? 1 : 0,
        errors:
          errors ? 1 : 0
      }
    );
  },


  setTotalKnown: function(
    jobId,
    totalKnown
  ) {

    return this.update(
      jobId,
      {
        totalKnown:
          Math.max(
            0,
            GDM_Utils.toInteger(
              totalKnown,
              0
            )
          )
      }
    );
  },


  setCurrentItem: function(
    jobId,
    item
  ) {

    item = item || {};

    return this.update(
      jobId,
      {
        currentItem:
          GDM_Utils.toString(
            item.name ||
            item.label ||
            ''
          ),

        currentItemId:
          GDM_Utils.toString(
            item.id ||
            ''
          ),

        currentTaskId:
          GDM_Utils.toString(
            item.taskId ||
            ''
          )
      }
    );
  },


  setMessage: function(
    jobId,
    message
  ) {

    return this.update(
      jobId,
      {
        message:
          GDM_Utils.toString(
            message
          )
      }
    );
  },


  setLastError: function(
    jobId,
    error,
    context
  ) {

    context = context || {};

    context.jobId =
      jobId;

    return this.update(
      jobId,
      {
        lastError:
          GDM_Utils.errorToObject(
            error,
            context
          ),

        errors:
          this.require(
            jobId
          ).errors + 1
      }
    );
  },


  /************************************************************************************************
   * RÉSULTAT FINAL / PARTIEL
   ************************************************************************************************/

  saveResult: function(
    jobId,
    result
  ) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      throw new Error(
        'GDM_State.saveResult : jobId obligatoire.'
      );
    }

    var key =
      GDM_Config.resultKey(
        jobId
      );

    this.writeChunkedObject_(
      key,
      {
        jobId:
          jobId,

        updatedAt:
          GDM_Utils.nowIso(),

        result:
          this.makeSerializable_(
            result
          )
      }
    );

    return true;
  },


  getResult: function(jobId) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      return null;
    }

    var stored =
      this.readChunkedObject_(
        GDM_Config.resultKey(
          jobId
        )
      );

    if (!stored) {
      return null;
    }

    return typeof stored.result ===
      'undefined'
      ? stored
      : stored.result;
  },


  deleteResult: function(jobId) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      return false;
    }

    return this.deleteChunkedObject_(
      GDM_Config.resultKey(
        jobId
      )
    );
  },


  /************************************************************************************************
   * RÉSUMÉ POUR L'INTERFACE
   ************************************************************************************************/

  getSummary: function(jobId) {

    var state = this.get(
      jobId
    );

    if (!state) {
      return null;
    }

    return {
      jobId:
        state.jobId,

      module:
        state.module,

      action:
        state.action,

      status:
        state.status,

      processed:
        Number(
          state.processed || 0
        ),

      totalKnown:
        Number(
          state.totalKnown || 0
        ),

      success:
        Number(
          state.success || 0
        ),

      skipped:
        Number(
          state.skipped || 0
        ),

      errors:
        Number(
          state.errors || 0
        ),

      progressPercent:
        Number(
          state.progressPercent || 0
        ),

      currentItem:
        state.currentItem || '',

      currentItemId:
        state.currentItemId || '',

      message:
        state.message || '',

      createdAt:
        state.createdAt || '',

      startedAt:
        state.startedAt || '',

      updatedAt:
        state.updatedAt || '',

      finishedAt:
        state.finishedAt || '',

      cancelRequested:
        state.cancelRequested === true,

      pauseRequested:
        state.pauseRequested === true,

      resumeCount:
        Number(
          state.resumeCount || 0
        ),

      lastError:
        state.lastError || null
    };
  },


  /************************************************************************************************
   * SUPPRESSION DE L'ÉTAT TECHNIQUE
   *
   * Cette fonction supprime uniquement les données internes du job dans PropertiesService.
   * Elle ne supprime aucun fichier Google Drive.
   ************************************************************************************************/

  delete: function(
    jobId,
    options
  ) {

    options = options || {};

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      return false;
    }

    this.deleteChunkedObject_(
      GDM_Config.stateKey(
        jobId
      )
    );

    if (
      GDM_Utils.toBoolean(
        options.deleteResult,
        true
      )
    ) {
      this.deleteResult(
        jobId
      );
    }

    this.clearCurrentJobId(
      jobId
    );

    return true;
  },


  /************************************************************************************************
   * LISTE DES JOBS
   ************************************************************************************************/

  listJobIds: function() {

    var properties =
      PropertiesService
        .getScriptProperties()
        .getProperties();

    var prefix =
      GDM_Config.get(
        'STORAGE_KEYS.JOB_STATE_PREFIX',
        'GDMV2_STATE_'
      );

    var suffix = '_META';

    var ids = [];

    var keys =
      Object.keys(
        properties
      );

    for (
      var i = 0;
      i < keys.length;
      i++
    ) {

      var key =
        keys[i];

      if (
        key.indexOf(prefix) !== 0
      ) {
        continue;
      }

      if (
        key.slice(
          -suffix.length
        ) !== suffix
      ) {
        continue;
      }

      var jobId =
        key.substring(
          prefix.length,
          key.length -
          suffix.length
        );

      if (jobId) {
        ids.push(
          jobId
        );
      }
    }

    return GDM_Utils.uniqueStrings(
      ids,
      false
    );
  },


  list: function(options) {

    options = options || {};

    var ids =
      this.listJobIds();

    var result = [];

    for (
      var i = 0;
      i < ids.length;
      i++
    ) {

      var state =
        this.get(
          ids[i]
        );

      if (!state) {
        continue;
      }

      if (
        options.status &&
        state.status !==
          String(
            options.status
          ).toUpperCase()
      ) {
        continue;
      }

      if (
        options.module &&
        state.module !==
          String(
            options.module
          )
      ) {
        continue;
      }

      result.push(
        state
      );
    }

    result.sort(
      function(a, b) {
        return String(
          b.updatedAt || ''
        ).localeCompare(
          String(
            a.updatedAt || ''
          )
        );
      }
    );

    var limit =
      GDM_Utils.toPositiveInteger(
        options.limit,
        100
      );

    return result.slice(
      0,
      limit
    );
  },


  /************************************************************************************************
   * NETTOYAGE DES ANCIENS JOBS
   ************************************************************************************************/

  cleanupOldJobs: function(days) {

    days =
      GDM_Utils.toPositiveInteger(
        days,
        GDM_Config.get(
          'STATE.CLEAN_COMPLETED_JOBS_AFTER_DAYS',
          30
        )
      );

    var threshold =
      Date.now() -
      (
        days *
        24 *
        60 *
        60 *
        1000
      );

    var ids =
      this.listJobIds();

    var deleted = [];
    var skipped = [];

    for (
      var i = 0;
      i < ids.length;
      i++
    ) {

      var state =
        this.get(
          ids[i]
        );

      if (!state) {
        continue;
      }

      if (
        !this.isTerminalStatus_(
          state.status
        )
      ) {
        skipped.push(
          state.jobId
        );

        continue;
      }

      var referenceDate =
        GDM_Utils.toDate(
          state.finishedAt ||
          state.updatedAt ||
          state.createdAt
        );

      if (
        !referenceDate ||
        referenceDate.getTime() >
          threshold
      ) {
        skipped.push(
          state.jobId
        );

        continue;
      }

      this.delete(
        state.jobId,
        {
          deleteResult: true
        }
      );

      deleted.push(
        state.jobId
      );
    }

    return {
      ok: true,
      deleted: deleted,
      skipped: skipped,
      deletedCount:
        deleted.length,
      skippedCount:
        skipped.length
    };
  },


  /************************************************************************************************
   * STOCKAGE INTERNE
   ************************************************************************************************/

  readState_: function(jobId) {

    return this.readChunkedObject_(
      GDM_Config.stateKey(
        jobId
      )
    );
  },


  writeState_: function(
    jobId,
    state
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        return GDM_State.writeStateUnlocked_(
          jobId,
          state
        );
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  writeStateUnlocked_: function(
    jobId,
    state
  ) {

    return this.writeChunkedObjectUnlocked_(
      GDM_Config.stateKey(
        jobId
      ),
      state
    );
  },


  readChunkedObject_: function(
    baseKey
  ) {

    baseKey =
      GDM_Utils.trim(
        baseKey
      );

    if (!baseKey) {
      return null;
    }

    var properties =
      PropertiesService
        .getScriptProperties();

    var metaRaw =
      properties.getProperty(
        baseKey + '_META'
      );

    /*
     * Compatibilité avec une éventuelle ancienne écriture
     * non fractionnée.
     */
    if (!metaRaw) {

      var direct =
        properties.getProperty(
          baseKey
        );

      if (!direct) {
        return null;
      }

      return GDM_Utils.safeJsonParse(
        direct,
        null
      );
    }

    var meta =
      GDM_Utils.safeJsonParse(
        metaRaw,
        null
      );

    if (!meta) {
      return null;
    }

    var chunkCount =
      Math.max(
        0,
        GDM_Utils.toInteger(
          meta.chunkCount,
          0
        )
      );

    if (
      chunkCount === 0
    ) {
      return null;
    }

    var json = '';

    for (
      var i = 0;
      i < chunkCount;
      i++
    ) {

      var chunk =
        properties.getProperty(
          baseKey +
          '_PART_' +
          i
        );

      if (
        chunk === null
      ) {
        return null;
      }

      json += chunk;
    }

    return GDM_Utils.safeJsonParse(
      json,
      null
    );
  },


  writeChunkedObject_: function(
    baseKey,
    value
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        return GDM_State.writeChunkedObjectUnlocked_(
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


  writeChunkedObjectUnlocked_: function(
    baseKey,
    value
  ) {

    baseKey =
      GDM_Utils.requireString(
        baseKey,
        'baseKey'
      );

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

    if (
      chunks.length === 0
    ) {
      chunks.push(
        '{}'
      );
    }

    if (
      chunks.length >
      maxChunks
    ) {
      throw new Error(
        'Objet trop volumineux pour PropertiesService : ' +
        chunks.length +
        ' morceaux nécessaires, limite = ' +
        maxChunks +
        '.'
      );
    }

    var properties =
      PropertiesService
        .getScriptProperties();

    var previousMeta =
      GDM_Utils.safeJsonParse(
        properties.getProperty(
          baseKey + '_META'
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

    /*
     * Écriture des nouveaux morceaux.
     */
    for (
      var chunkIndex = 0;
      chunkIndex <
        chunks.length;
      chunkIndex++
    ) {
      properties.setProperty(
        baseKey +
        '_PART_' +
        chunkIndex,
        chunks[
          chunkIndex
        ]
      );
    }

    /*
     * Suppression des anciens morceaux devenus inutiles.
     */
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

        length:
          json.length,

        updatedAt:
          GDM_Utils.nowIso()
      })
    );

    /*
     * Nettoyage d'une éventuelle ancienne version non fractionnée.
     */
    properties.deleteProperty(
      baseKey
    );

    return true;
  },


  deleteChunkedObject_: function(
    baseKey
  ) {

    baseKey =
      GDM_Utils.trim(
        baseKey
      );

    if (!baseKey) {
      return false;
    }

    return GDM_Utils.withScriptLock(
      function() {

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
          baseKey + '_META'
        );

        properties.deleteProperty(
          baseKey
        );

        return true;
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  /************************************************************************************************
   * HELPERS INTERNES
   ************************************************************************************************/

  applyPatch_: function(
    state,
    patch
  ) {

    var result =
      this.cloneState_(
        state
      );

    var keys =
      Object.keys(
        patch || {}
      );

    for (
      var i = 0;
      i < keys.length;
      i++
    ) {

      var key =
        keys[i];

      if (
        key === 'jobId' ||
        key === 'createdAt' ||
        key === 'schemaVersion'
      ) {
        continue;
      }

      var value =
        patch[key];

      switch (key) {

        case 'processed':
        case 'totalKnown':
        case 'success':
        case 'skipped':
        case 'errors':
        case 'resumeCount':

          result[key] =
            Math.max(
              0,
              GDM_Utils.toInteger(
                value,
                0
              )
            );

          break;


        case 'cancelRequested':
        case 'pauseRequested':

          result[key] =
            GDM_Utils.toBoolean(
              value,
              false
            );

          break;


        case 'status':

          var status =
            GDM_Utils.trim(
              value
            ).toUpperCase();

          if (
            !GDM_Config.isValidJobStatus(
              status
            )
          ) {
            throw new Error(
              'Statut invalide : ' +
              status
            );
          }

          result.status =
            status;

          break;


        case 'source':
        case 'destination':
        case 'parameters':
        case 'metadata':
        case 'lastError':

          result[key] =
            this.makeSerializable_(
              value
            );

          break;


        default:

          result[key] =
            value;
      }
    }

    return result;
  },


  recalculateProgress_: function(
    state
  ) {

    var processed =
      Math.max(
        0,
        Number(
          state.processed || 0
        )
      );

    var total =
      Math.max(
        0,
        Number(
          state.totalKnown || 0
        )
      );

    if (
      state.status ===
      GDM_JOB_STATUS.COMPLETED
    ) {
      state.progressPercent =
        100;

      return state;
    }

    if (
      total <= 0
    ) {
      state.progressPercent =
        0;

      return state;
    }

    state.progressPercent =
      Math.min(
        100,
        Math.max(
          0,
          Number(
            (
              processed /
              total *
              100
            ).toFixed(2)
          )
        )
      );

    return state;
  },


  isTerminalStatus_: function(
    status
  ) {

    return (
      status ===
        GDM_JOB_STATUS.COMPLETED ||
      status ===
        GDM_JOB_STATUS.CANCELLED ||
      status ===
        GDM_JOB_STATUS.ERROR
    );
  },


  makeSerializable_: function(
    value
  ) {

    if (
      value === null ||
      typeof value ===
        'undefined'
    ) {
      return value ===
        undefined
        ? null
        : value;
    }

    try {
      return JSON.parse(
        JSON.stringify(
          value
        )
      );
    } catch (error) {
      return GDM_Utils.toString(
        value
      );
    }
  },


  cloneState_: function(
    state
  ) {

    if (!state) {
      return null;
    }

    return JSON.parse(
      JSON.stringify(
        state
      )
    );
  },


  /************************************************************************************************
   * VALIDATION DU MODULE
   ************************************************************************************************/

  validate: function() {

    var errors = [];

    var testJobId =
      'STATE_TEST_' +
      Date.now();

    try {

      var created =
        this.create({
          jobId:
            testJobId,

          module:
            GDM_MODULES.ANALYSIS,

          action:
            GDM_ACTIONS.ANALYZE_FOLDER,

          setCurrent:
            false,

          parameters: {
            test: true
          }
        });

      if (
        !created ||
        created.jobId !==
          testJobId
      ) {
        errors.push(
          'Création du job impossible.'
        );
      }

      var loaded =
        this.get(
          testJobId
        );

      if (!loaded) {
        errors.push(
          'Lecture du job impossible.'
        );
      }

      this.start(
        testJobId,
        'Test State démarré.'
      );

      this.increment(
        testJobId,
        {
          processed: 1,
          success: 1,
          totalKnown: 2
        }
      );

      var progress =
        this.get(
          testJobId
        );

      if (
        !progress ||
        progress.processed !== 1 ||
        progress.success !== 1
      ) {
        errors.push(
          'Mise à jour des compteurs impossible.'
        );
      }

      this.saveResult(
        testJobId,
        {
          test: true
        }
      );

      var result =
        this.getResult(
          testJobId
        );

      if (
        !result ||
        result.test !== true
      ) {
        errors.push(
          'Sauvegarde du résultat impossible.'
        );
      }

      this.complete(
        testJobId,
        'Test terminé.'
      );

      var completed =
        this.get(
          testJobId
        );

      if (
        !completed ||
        completed.status !==
          GDM_JOB_STATUS.COMPLETED
      ) {
        errors.push(
          'Passage en statut COMPLETED impossible.'
        );
      }

    } catch (error) {

      errors.push(
        'Erreur State.gs : ' +
        GDM_Utils.getErrorMessage(
          error
        )
      );

    } finally {

      try {

        this.delete(
          testJobId,
          {
            deleteResult: true
          }
        );

        try {
          GDM_Logger.clear(
            testJobId
          );
        } catch (ignored) {}

      } catch (
        cleanupError
      ) {

        errors.push(
          'Nettoyage du test State impossible : ' +
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
        'Core/State.gs',

      version:
        GDM_APP.VERSION,

      errors:
        errors
    };
  }

});