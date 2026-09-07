/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Engine.gs
 * Version : 2.0.2
 *
 * CORRECTION 2.0.2
 * ----------------
 * - corrige l'accumulation des déclencheurs GDM_engineTrigger ;
 * - garantit qu'il n'existe jamais plus d'un déclencheur de reprise du moteur ;
 * - supprime aussi les anciens déclencheurs orphelins sans mapping ;
 * - réduit le risque de dépassement de durée Apps Script ;
 * - conserve la reprise, la pause, l'annulation et la file existante.
 *
 * IMPORTANT
 * ---------
 * Ce fichier remplace entièrement Core/Engine.gs.
 **************************************************************************************************/
'use strict';

const GDM_Engine = Object.freeze({

  RUN_LOCK_PREFIX_: 'GDMV2_ENGINE_RUN_',
  SAFE_MAX_TASKS_PER_RUN_: 50,
  SAFE_HARD_RUNTIME_MS_: 180000,

  /************************************************************************************************
   * DÉMARRER
   ************************************************************************************************/
  start: function(jobId, options) {
    options = options || {};
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    var state = GDM_State.require(jobId);

    if (
      state.status === GDM_JOB_STATUS.COMPLETED ||
      state.status === GDM_JOB_STATUS.CANCELLED ||
      state.status === GDM_JOB_STATUS.ERROR
    ) {
      throw new Error('Impossible de démarrer un job terminé.');
    }

    GDM_State.setCurrentJobId(jobId);
    GDM_Queue.resetRunningTasks(jobId);

    if (state.status === GDM_JOB_STATUS.PAUSED) {
      GDM_State.resume(jobId, 'Reprise du traitement.');
    } else if (state.status !== GDM_JOB_STATUS.RUNNING) {
      GDM_State.start(jobId, 'Traitement démarré.');
    }

    if (GDM_Utils.toBoolean(options.async, false)) {
      var scheduled = this.scheduleResume(jobId, options.delayMs);
      return {
        ok: true,
        jobId: jobId,
        scheduled: scheduled.scheduled === true,
        state: GDM_State.getSummary(jobId),
        queue: GDM_Queue.getMeta(jobId)
      };
    }

    return this.run(jobId, options);
  },

  /************************************************************************************************
   * EXÉCUTION PRINCIPALE
   ************************************************************************************************/
  run: function(jobId, options) {
    options = options || {};
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    var token = this.acquireRunToken_(jobId);

    if (!token) {
      return {
        ok: false,
        busy: true,
        jobId: jobId,
        message: 'Ce job est déjà en cours d’exécution.'
      };
    }

    try {
      return this.runUnlocked_(jobId, options, token);
    } catch (error) {
      this.handleRunError_(jobId, error);
      throw error;
    } finally {
      this.releaseRunToken_(jobId, token);
    }
  },

  /************************************************************************************************
   * BOUCLE D'EXÉCUTION
   ************************************************************************************************/
  runUnlocked_: function(jobId, options, token) {
    options = options || {};

    var runtime = GDM_Utils.createRuntimeContext();
    var configuredMaxTasks = GDM_Utils.toPositiveInteger(
      options.maxTasks,
      GDM_Config.get('RUNTIME.MAX_TASKS_PER_RUN', 250)
    );

    var maxTasks = Math.min(
      configuredMaxTasks,
      GDM_Utils.toPositiveInteger(
        GDM_Config.get('RUNTIME.SAFE_MAX_TASKS_PER_RUN', this.SAFE_MAX_TASKS_PER_RUN_),
        this.SAFE_MAX_TASKS_PER_RUN_
      )
    );

    var configuredRuntime = GDM_Utils.toPositiveInteger(
      GDM_Config.get('RUNTIME.MAX_EXECUTION_MS', 270000),
      270000
    );

    var hardRuntime = Math.min(
      configuredRuntime,
      GDM_Utils.toPositiveInteger(
        GDM_Config.get('RUNTIME.SAFE_HARD_RUNTIME_MS', this.SAFE_HARD_RUNTIME_MS_),
        this.SAFE_HARD_RUNTIME_MS_
      )
    );

    var hardDeadline = Date.now() + hardRuntime;

    var cancelCheckEvery = GDM_Utils.toPositiveInteger(
      GDM_Config.get('RUNTIME.CANCEL_CHECK_EVERY_ITEMS', 10),
      10
    );

    var heartbeatEvery = Math.max(5, cancelCheckEvery);
    var state = GDM_State.require(jobId);

    if (
      state.status === GDM_JOB_STATUS.COMPLETED ||
      state.status === GDM_JOB_STATUS.CANCELLED ||
      state.status === GDM_JOB_STATUS.ERROR
    ) {
      return this.buildRunResult_(jobId, 0, 'Job déjà terminé.');
    }

    if (state.pauseRequested === true || state.status === GDM_JOB_STATUS.PAUSED) {
      return this.buildRunResult_(jobId, 0, 'Job en pause.');
    }

    GDM_State.setCurrentJobId(jobId);

    if (state.status !== GDM_JOB_STATUS.RUNNING) {
      GDM_State.start(jobId, 'Traitement en cours.');
    }

    var processedThisRun = 0;
    var successThisRun = 0;
    var skippedThisRun = 0;
    var errorsThisRun = 0;
    var retriesThisRun = 0;

    while (processedThisRun < maxTasks) {
      if (Date.now() >= hardDeadline || GDM_Utils.runtimeExpired(runtime)) {
        break;
      }

      if (processedThisRun === 0 || processedThisRun % cancelCheckEvery === 0) {
        var controlState = GDM_State.get(jobId);

        if (!controlState) {
          throw new Error('État du job introuvable.');
        }

        if (
          controlState.cancelRequested === true ||
          controlState.status === GDM_JOB_STATUS.CANCELLED
        ) {
          GDM_Queue.cancelPending(jobId, 'Job annulé.');

          if (controlState.status !== GDM_JOB_STATUS.CANCELLED) {
            GDM_State.cancel(jobId, 'Traitement annulé.');
          }

          this.removeResumeTriggers(jobId);
          return this.buildRunResult_(jobId, processedThisRun, 'Traitement annulé.');
        }

        if (
          controlState.pauseRequested === true ||
          controlState.status === GDM_JOB_STATUS.PAUSED
        ) {
          if (controlState.status !== GDM_JOB_STATUS.PAUSED) {
            GDM_State.pause(jobId, 'Traitement mis en pause.');
          }

          this.removeResumeTriggers(jobId);
          return this.buildRunResult_(jobId, processedThisRun, 'Traitement en pause.');
        }
      }

      if (processedThisRun === 0 || processedThisRun % heartbeatEvery === 0) {
        this.refreshRunToken_(jobId, token);
      }

      var task = GDM_Queue.claimNext(jobId);
      if (!task) {
        break;
      }

      processedThisRun++;

      try {
        GDM_State.setCurrentItem(jobId, {
          id: task.itemId || '',
          name: task.itemName || '',
          taskId: task.taskId || ''
        });
      } catch (ignoredCurrentItem) {}

      try {
        var moduleResult = this.executeTask_(task, {
          jobId: jobId,
          runtime: runtime,
          state: GDM_State.get(jobId)
        });

        moduleResult = this.normalizeModuleResult_(moduleResult);

        if (moduleResult.ok === false) {
          throw new Error(moduleResult.message || 'Le module a retourné une erreur.');
        }

        if (moduleResult.skipped === true) {
          GDM_Queue.skipTask(
            jobId,
            task.taskId,
            moduleResult.message || 'Élément ignoré.'
          );

          GDM_State.increment(jobId, { processed: 1, skipped: 1 });
          skippedThisRun++;

          try {
            GDM_Logger.itemSkipped(jobId, {
              taskId: task.taskId,
              module: task.module,
              action: task.action,
              itemId: task.itemId,
              itemName: task.itemName,
              message: moduleResult.message || 'Élément ignoré.'
            });
          } catch (ignoredSkipLog) {}

          continue;
        }

        GDM_Queue.completeTask(jobId, task.taskId, moduleResult);
        GDM_State.increment(jobId, { processed: 1, success: 1 });
        successThisRun++;

      } catch (taskError) {
        var failedTask = GDM_Queue.failTask(jobId, task.taskId, taskError);

        if (failedTask && failedTask.status === GDM_QUEUE_STATUS.PENDING) {
          retriesThisRun++;

          try {
            GDM_Logger.warn('Nouvelle tentative planifiée.', {
              jobId: jobId,
              taskId: task.taskId,
              module: task.module,
              action: task.action,
              itemId: task.itemId,
              itemName: task.itemName,
              data: { attempts: failedTask.attempts }
            });
          } catch (ignoredRetryLog) {}

          continue;
        }

        GDM_State.increment(jobId, { processed: 1, errors: 1 });
        errorsThisRun++;

        try {
          GDM_State.setLastError(
            jobId,
            GDM_Utils.errorToObject(taskError, {
              module: task.module,
              action: task.action,
              itemId: task.itemId,
              itemName: task.itemName
            })
          );
        } catch (ignoredStateError) {}

        try {
          GDM_Logger.itemError(jobId, taskError, {
            taskId: task.taskId,
            module: task.module,
            action: task.action,
            itemId: task.itemId,
            itemName: task.itemName
          });
        } catch (ignoredLoggerError) {}
      }
    }

    if (GDM_Queue.isDone(jobId)) {
      return this.finalizeJob_(jobId, {
        processedThisRun: processedThisRun,
        successThisRun: successThisRun,
        skippedThisRun: skippedThisRun,
        errorsThisRun: errorsThisRun,
        retriesThisRun: retriesThisRun
      });
    }

    GDM_State.checkpoint(jobId, {
      message: 'Lot terminé. Reprise automatique en attente.'
    });

    var scheduled = false;

    if (
      GDM_Config.get('QUEUE.AUTO_RESUME', true) &&
      GDM_Config.get('TRIGGERS.ENABLED', true)
    ) {
      var scheduleResult = this.scheduleResume(
        jobId,
        GDM_Config.get('QUEUE.AUTO_RESUME_DELAY_MS', 5000)
      );
      scheduled = scheduleResult.scheduled === true;
    }

    return {
      ok: true,
      jobId: jobId,
      completed: false,
      processedThisRun: processedThisRun,
      successThisRun: successThisRun,
      skippedThisRun: skippedThisRun,
      errorsThisRun: errorsThisRun,
      retriesThisRun: retriesThisRun,
      scheduled: scheduled,
      state: GDM_State.getSummary(jobId),
      queue: GDM_Queue.getMeta(jobId)
    };
  },

  /************************************************************************************************
   * DISPATCH MODULE
   ************************************************************************************************/
  executeTask_: function(task, context) {
    if (!task) {
      throw new Error('Engine : tâche vide.');
    }

    switch (task.module) {
      case GDM_MODULES.EXPLORER:
        if (typeof GDM_Explorer === 'undefined' || typeof GDM_Explorer.processTask !== 'function') {
          throw new Error('Module Explorer indisponible.');
        }
        return GDM_Explorer.processTask(task, context);

      case GDM_MODULES.ANALYSIS:
        if (typeof GDM_Analysis === 'undefined' || typeof GDM_Analysis.processTask !== 'function') {
          throw new Error('Module Analysis indisponible.');
        }
        return GDM_Analysis.processTask(task, context);

      case GDM_MODULES.MOVE:
        if (typeof GDM_Move === 'undefined' || typeof GDM_Move.processTask !== 'function') {
          throw new Error('Module Move indisponible.');
        }
        return GDM_Move.processTask(task, context);

      case GDM_MODULES.COPY:
        if (typeof GDM_Copy === 'undefined' || typeof GDM_Copy.processTask !== 'function') {
          throw new Error('Module Copy indisponible.');
        }
        return GDM_Copy.processTask(task, context);

      case GDM_MODULES.DUPLICATES:
        if (typeof GDM_Duplicates === 'undefined' || typeof GDM_Duplicates.processTask !== 'function') {
          throw new Error('Module Duplicates indisponible.');
        }
        return GDM_Duplicates.processTask(task, context);

      case GDM_MODULES.ARCHIVE:
        if (typeof GDM_Archive === 'undefined' || typeof GDM_Archive.processTask !== 'function') {
          throw new Error('Module Archive indisponible.');
        }
        return GDM_Archive.processTask(task, context);

      case GDM_MODULES.RENAME:
        if (typeof GDM_Rename === 'undefined' || typeof GDM_Rename.processTask !== 'function') {
          throw new Error('Module Rename indisponible.');
        }
        return GDM_Rename.processTask(task, context);

      case GDM_MODULES.FOLDER_TOOLS:
        if (typeof GDM_FolderTools === 'undefined' || typeof GDM_FolderTools.processTask !== 'function') {
          throw new Error('Module FolderTools indisponible.');
        }
        return GDM_FolderTools.processTask(task, context);

      default:
        throw new Error('Module inconnu : ' + GDM_Utils.toString(task.module));
    }
  },

  /************************************************************************************************
   * NORMALISER RÉSULTAT MODULE
   ************************************************************************************************/
  normalizeModuleResult_: function(result) {
    if (result === null || typeof result === 'undefined') {
      return { ok: true, skipped: false, message: '', data: {} };
    }

    if (typeof result === 'boolean') {
      return { ok: result, skipped: false, message: '', data: {} };
    }

    if (typeof result !== 'object') {
      return {
        ok: true,
        skipped: false,
        message: GDM_Utils.toString(result),
        data: {}
      };
    }

    return {
      ok: typeof result.ok === 'boolean' ? result.ok : true,
      skipped: result.skipped === true,
      message: GDM_Utils.toString(result.message),
      data: typeof result.data === 'undefined' ? {} : result.data
    };
  },

  /************************************************************************************************
   * FINALISER JOB
   ************************************************************************************************/
  finalizeJob_: function(jobId, runStats) {
    runStats = runStats || {};

    var state = GDM_State.require(jobId);
    var moduleResult = this.finalizeModuleResult_(state.module, jobId);
    var queue = GDM_Queue.getMeta(jobId);

    var standardResult = {
      ok: Number(state.errors || 0) === 0,
      module: state.module,
      action: state.action,
      jobId: jobId,
      processed: Number(state.processed || 0),
      success: Number(state.success || 0),
      skipped: Number(state.skipped || 0),
      errors: Number(state.errors || 0),
      message: Number(state.errors || 0) > 0
        ? 'Traitement terminé avec erreur(s).'
        : 'Traitement terminé avec succès.',
      data: {
        queue: queue,
        moduleResult: moduleResult
      }
    };

    GDM_State.saveResult(jobId, standardResult);
    GDM_State.complete(jobId, standardResult.message);
    this.removeResumeTriggers(jobId);

    try {
      GDM_Logger.jobCompleted(jobId, {
        module: state.module,
        action: state.action,
        message: standardResult.message,
        data: {
          processed: standardResult.processed,
          success: standardResult.success,
          skipped: standardResult.skipped,
          errors: standardResult.errors
        }
      });
    } catch (ignoredLog) {}

    if (GDM_Config.get('QUEUE.KEEP_COMPLETED_TASKS', false) === false) {
      try {
        GDM_Queue.compact(jobId);
      } catch (ignoredCompact) {}
    }

    return {
      ok: true,
      jobId: jobId,
      completed: true,
      processedThisRun: Number(runStats.processedThisRun || 0),
      successThisRun: Number(runStats.successThisRun || 0),
      skippedThisRun: Number(runStats.skippedThisRun || 0),
      errorsThisRun: Number(runStats.errorsThisRun || 0),
      retriesThisRun: Number(runStats.retriesThisRun || 0),
      state: GDM_State.getSummary(jobId),
      result: standardResult
    };
  },

  /************************************************************************************************
   * FINALISATION SPÉCIFIQUE MODULE
   ************************************************************************************************/
  finalizeModuleResult_: function(moduleName, jobId) {
    try {
      switch (moduleName) {
        case GDM_MODULES.ANALYSIS:
          if (typeof GDM_Analysis !== 'undefined' && typeof GDM_Analysis.finalizeResult === 'function') {
            return GDM_Analysis.finalizeResult(jobId);
          }
          break;

        case GDM_MODULES.COPY:
          if (typeof GDM_Copy !== 'undefined' && typeof GDM_Copy.finalizeResult === 'function') {
            return GDM_Copy.finalizeResult(jobId);
          }
          break;

        case GDM_MODULES.DUPLICATES:
          if (typeof GDM_Duplicates !== 'undefined' && typeof GDM_Duplicates.finalizeResult === 'function') {
            return GDM_Duplicates.finalizeResult(jobId);
          }
          break;

        case GDM_MODULES.ARCHIVE:
          if (typeof GDM_Archive !== 'undefined' && typeof GDM_Archive.finalizeResult === 'function') {
            return GDM_Archive.finalizeResult(jobId);
          }
          break;

        case GDM_MODULES.RENAME:
          if (typeof GDM_Rename !== 'undefined' && typeof GDM_Rename.finalizeResult === 'function') {
            return GDM_Rename.finalizeResult(jobId);
          }
          break;
      }
    } catch (error) {
      try {
        GDM_Logger.warn('Impossible de finaliser le résultat spécifique du module.', {
          jobId: jobId,
          module: moduleName,
          data: { error: GDM_Utils.getErrorMessage(error) }
        });
      } catch (ignored) {}
    }

    return null;
  },

  /************************************************************************************************
   * PAUSE
   ************************************************************************************************/
  pause: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    var state = GDM_State.require(jobId);

    if (
      state.status === GDM_JOB_STATUS.COMPLETED ||
      state.status === GDM_JOB_STATUS.CANCELLED ||
      state.status === GDM_JOB_STATUS.ERROR
    ) {
      return state;
    }

    GDM_State.requestPause(jobId);
    this.removeResumeTriggers(jobId);
    return GDM_State.get(jobId);
  },

  /************************************************************************************************
   * REPRISE
   ************************************************************************************************/
  resume: function(jobId, options) {
    options = options || {};
    jobId = jobId || GDM_State.getCurrentJobId();
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    var state = GDM_State.require(jobId);

    if (
      state.status === GDM_JOB_STATUS.COMPLETED ||
      state.status === GDM_JOB_STATUS.CANCELLED ||
      state.status === GDM_JOB_STATUS.ERROR
    ) {
      throw new Error('Ce job ne peut plus être repris.');
    }

    GDM_Queue.resetRunningTasks(jobId);

    try {
      GDM_State.clearPauseRequest(jobId);
    } catch (ignoredClearPause) {}

    if (state.status === GDM_JOB_STATUS.PAUSED || state.pauseRequested === true) {
      GDM_State.resume(jobId, 'Reprise du traitement.');
    }

    GDM_State.setCurrentJobId(jobId);

    if (GDM_Utils.toBoolean(options.async, false)) {
      return this.scheduleResume(jobId, options.delayMs);
    }

    return this.run(jobId, options);
  },

  /************************************************************************************************
   * ANNULATION
   ************************************************************************************************/
  cancel: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    var state = GDM_State.require(jobId);

    if (state.status === GDM_JOB_STATUS.COMPLETED) {
      return state;
    }

    GDM_State.requestCancel(jobId);
    GDM_Queue.cancelPending(jobId, 'Job annulé par l’utilisateur.');
    this.removeResumeTriggers(jobId);

    return GDM_State.cancel(jobId, 'Traitement annulé par l’utilisateur.');
  },

  /************************************************************************************************
   * UN LOT MANUEL
   *
   * Limité volontairement pour éviter le dépassement de durée Apps Script.
   ************************************************************************************************/
  runOneBatch: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();

    var configured = GDM_Utils.toPositiveInteger(
      GDM_Config.get('QUEUE.MAX_ITEMS_PER_BATCH', 250),
      250
    );

    return this.run(jobId, {
      maxTasks: Math.min(configured, this.SAFE_MAX_TASKS_PER_RUN_)
    });
  },

  /************************************************************************************************
   * PLANIFIER UNE REPRISE
   *
   * FIX 2.0.2 : AVANT chaque création, tous les anciens triggers GDM_engineTrigger
   * sont supprimés. Il ne peut donc plus y avoir 15 triggers accumulés.
   ************************************************************************************************/
  scheduleResume: function(jobId, delayMs) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    if (!GDM_Config.get('TRIGGERS.ENABLED', true)) {
      return {
        ok: false,
        scheduled: false,
        reason: 'Déclencheurs désactivés.'
      };
    }

    var state = GDM_State.require(jobId);

    if (
      state.status === GDM_JOB_STATUS.COMPLETED ||
      state.status === GDM_JOB_STATUS.CANCELLED ||
      state.status === GDM_JOB_STATUS.ERROR ||
      state.pauseRequested === true
    ) {
      return {
        ok: false,
        scheduled: false,
        reason: 'Le job ne nécessite pas de reprise.'
      };
    }

    delayMs = Math.max(
      1000,
      GDM_Utils.toInteger(
        delayMs,
        GDM_Config.get('TRIGGERS.RESUME_DELAY_MS', 5000)
      )
    );

    /*
     * CORRECTION PRINCIPALE : un seul trigger moteur dans tout le projet.
     * On supprime les anciens, même s'ils ont perdu leur mapping.
     */
    this.removeAllEngineTriggers_();
    this.cleanupTriggerProperties_();

    var handler = GDM_Config.get(
      'TRIGGERS.HANDLER_FUNCTION',
      'GDM_engineTrigger'
    );

    var trigger = ScriptApp
      .newTrigger(handler)
      .timeBased()
      .after(delayMs)
      .create();

    var triggerId = '';

    try {
      triggerId = trigger.getUniqueId();
    } catch (ignoredId) {}

    if (triggerId) {
      PropertiesService
        .getScriptProperties()
        .setProperty(
          this.getTriggerPropertyKey_(triggerId),
          JSON.stringify({
            jobId: jobId,
            triggerId: triggerId,
            createdAt: GDM_Utils.nowIso(),
            delayMs: delayMs
          })
        );
    }

    GDM_State.setCurrentJobId(jobId);

    return {
      ok: true,
      scheduled: true,
      jobId: jobId,
      triggerId: triggerId,
      delayMs: delayMs
    };
  },

  /************************************************************************************************
   * HANDLER TRIGGER
   ************************************************************************************************/
  triggerRun: function(event) {
    event = event || {};

    var triggerUid = GDM_Utils.trim(event.triggerUid);
    var jobId = '';
    var properties = PropertiesService.getScriptProperties();

    if (triggerUid) {
      var raw = properties.getProperty(this.getTriggerPropertyKey_(triggerUid));

      if (raw) {
        var triggerData = GDM_Utils.safeJsonParse(raw, {});
        jobId = GDM_Utils.trim(triggerData.jobId);
      }

      properties.deleteProperty(this.getTriggerPropertyKey_(triggerUid));
    }

    /*
     * Le déclencheur qui vient de s'exécuter peut encore apparaître dans la liste
     * Apps Script comme déclencheur désactivé. On nettoie immédiatement tous les
     * triggers du moteur avant de lancer le lot suivant.
     */
    this.removeAllEngineTriggers_();
    this.cleanupTriggerProperties_();

    if (!jobId) {
      jobId = GDM_State.getCurrentJobId();
    }

    if (!jobId) {
      return { ok: false, message: 'Aucun job à reprendre.' };
    }

    var state = GDM_State.get(jobId);

    if (!state) {
      return {
        ok: false,
        jobId: jobId,
        message: 'Job introuvable.'
      };
    }

    if (
      state.status === GDM_JOB_STATUS.COMPLETED ||
      state.status === GDM_JOB_STATUS.CANCELLED ||
      state.status === GDM_JOB_STATUS.ERROR
    ) {
      return { ok: true, jobId: jobId, completed: true };
    }

    if (state.pauseRequested === true || state.status === GDM_JOB_STATUS.PAUSED) {
      return { ok: true, jobId: jobId, paused: true };
    }

    /* Récupération d'une éventuelle tâche restée RUNNING après timeout. */
    try {
      GDM_Queue.resetRunningTasks(jobId);
    } catch (ignoredReset) {}

    return this.run(jobId, {
      maxTasks: this.SAFE_MAX_TASKS_PER_RUN_
    });
  },

  /************************************************************************************************
   * SUPPRIMER LES TRIGGERS D'UN JOB
   *
   * FIX : un trigger moteur sans mapping est considéré comme orphelin et supprimé.
   ************************************************************************************************/
  removeResumeTriggers: function(jobId) {
    var handler = GDM_Config.get(
      'TRIGGERS.HANDLER_FUNCTION',
      'GDM_engineTrigger'
    );

    var properties = PropertiesService.getScriptProperties();
    var triggers = ScriptApp.getProjectTriggers();
    var removed = 0;

    for (var i = 0; i < triggers.length; i++) {
      var trigger = triggers[i];
      var handlerName = '';

      try {
        handlerName = trigger.getHandlerFunction();
      } catch (ignoredHandler) {}

      if (handlerName !== handler) {
        continue;
      }

      var triggerId = '';
      var mappedJobId = '';

      try {
        triggerId = trigger.getUniqueId();
      } catch (ignoredId) {}

      if (triggerId) {
        var raw = properties.getProperty(this.getTriggerPropertyKey_(triggerId));
        if (raw) {
          var info = GDM_Utils.safeJsonParse(raw, {});
          mappedJobId = GDM_Utils.trim(info.jobId);
        }
      }

      /*
       * - jobId vide : supprimer tous les triggers moteur ;
       * - mapping vide : trigger orphelin, supprimer ;
       * - mapping = jobId : supprimer ;
       * - mapping d'un autre job : conserver.
       */
      if (jobId && mappedJobId && mappedJobId !== jobId) {
        continue;
      }

      try {
        ScriptApp.deleteTrigger(trigger);
        removed++;
      } catch (ignoredDelete) {}

      if (triggerId) {
        properties.deleteProperty(this.getTriggerPropertyKey_(triggerId));
      }
    }

    return removed;
  },

  /************************************************************************************************
   * SUPPRIMER TOUS LES TRIGGERS DU MOTEUR
   ************************************************************************************************/
  removeAllEngineTriggers_: function() {
    return this.removeResumeTriggers('');
  },

  /************************************************************************************************
   * NETTOYER LES TRIGGERS ORPHELINS / DUPLIQUÉS
   *
   * Cette méthode est également appelée depuis Main.cleanup().
   ************************************************************************************************/
  cleanupOwnTriggers_: function() {
    var handler = GDM_Config.get(
      'TRIGGERS.HANDLER_FUNCTION',
      'GDM_engineTrigger'
    );

    var properties = PropertiesService.getScriptProperties();
    var currentJobId = '';

    try {
      currentJobId = GDM_State.getCurrentJobId() || '';
    } catch (ignoredCurrentJob) {}

    var triggers = ScriptApp.getProjectTriggers();
    var valid = [];
    var removed = 0;

    for (var i = 0; i < triggers.length; i++) {
      var trigger = triggers[i];
      var handlerName = '';

      try {
        handlerName = trigger.getHandlerFunction();
      } catch (ignoredHandler) {}

      if (handlerName !== handler) {
        continue;
      }

      var triggerId = '';
      var mappedJobId = '';

      try {
        triggerId = trigger.getUniqueId();
      } catch (ignoredId) {}

      if (triggerId) {
        var raw = properties.getProperty(this.getTriggerPropertyKey_(triggerId));
        if (raw) {
          var info = GDM_Utils.safeJsonParse(raw, {});
          mappedJobId = GDM_Utils.trim(info.jobId);
        }
      }

      /* Sans mapping = ancien trigger consommé/orphelin. */
      if (!mappedJobId) {
        try {
          ScriptApp.deleteTrigger(trigger);
          removed++;
        } catch (ignoredDeleteOrphan) {}
        continue;
      }

      /* Mapping vers un ancien job différent du job courant. */
      if (currentJobId && mappedJobId !== currentJobId) {
        try {
          ScriptApp.deleteTrigger(trigger);
          removed++;
        } catch (ignoredDeleteOther) {}

        if (triggerId) {
          properties.deleteProperty(this.getTriggerPropertyKey_(triggerId));
        }
        continue;
      }

      valid.push({ trigger: trigger, triggerId: triggerId });
    }

    /* S'il en reste plusieurs, un seul est conservé. */
    for (var v = 1; v < valid.length; v++) {
      try {
        ScriptApp.deleteTrigger(valid[v].trigger);
        removed++;
      } catch (ignoredDeleteDuplicate) {}

      if (valid[v].triggerId) {
        properties.deleteProperty(this.getTriggerPropertyKey_(valid[v].triggerId));
      }
    }

    removed += this.cleanupTriggerProperties_();
    return removed;
  },

  /************************************************************************************************
   * NETTOYER LES PROPRIÉTÉS DE TRIGGERS QUI N'EXISTENT PLUS
   ************************************************************************************************/
  cleanupTriggerProperties_: function() {
    var handler = GDM_Config.get(
      'TRIGGERS.HANDLER_FUNCTION',
      'GDM_engineTrigger'
    );

    var activeTriggerIds = {};
    var triggers = ScriptApp.getProjectTriggers();

    for (var i = 0; i < triggers.length; i++) {
      try {
        if (triggers[i].getHandlerFunction() === handler) {
          activeTriggerIds[triggers[i].getUniqueId()] = true;
        }
      } catch (ignored) {}
    }

    var properties = PropertiesService.getScriptProperties();
    var all = properties.getProperties();
    var prefix = GDM_Config.get(
      'STORAGE_KEYS.TRIGGER_PREFIX',
      'GDMV2_TRIGGER_'
    );

    var keys = Object.keys(all);
    var removed = 0;

    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];

      if (key.indexOf(prefix) !== 0) {
        continue;
      }

      var triggerId = key.substring(prefix.length);

      if (!activeTriggerIds[triggerId]) {
        properties.deleteProperty(key);
        removed++;
      }
    }

    return removed;
  },

  /************************************************************************************************
   * CLÉ PROPRIÉTÉ TRIGGER
   ************************************************************************************************/
  getTriggerPropertyKey_: function(triggerId) {
    return GDM_Config.get(
      'STORAGE_KEYS.TRIGGER_PREFIX',
      'GDMV2_TRIGGER_'
    ) + triggerId;
  },

  /************************************************************************************************
   * RÉCUPÉRATION APRÈS INTERRUPTION
   ************************************************************************************************/
  recover: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    var state = GDM_State.require(jobId);

    if (
      state.status === GDM_JOB_STATUS.COMPLETED ||
      state.status === GDM_JOB_STATUS.CANCELLED
    ) {
      return {
        ok: true,
        recovered: false,
        jobId: jobId,
        state: state
      };
    }

    var reset = GDM_Queue.resetRunningTasks(jobId);
    this.forceReleaseRunToken_(jobId);
    this.cleanupOwnTriggers_();
    GDM_State.setCurrentJobId(jobId);

    GDM_State.checkpoint(jobId, {
      message: 'Job récupéré après interruption.'
    });

    return {
      ok: true,
      recovered: true,
      jobId: jobId,
      resetRunningTasks: reset,
      state: GDM_State.getSummary(jobId),
      queue: GDM_Queue.getMeta(jobId)
    };
  },

  /************************************************************************************************
   * STATUT
   ************************************************************************************************/
  getStatus: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        active: false,
        jobId: '',
        state: null,
        queue: null
      };
    }

    var state = GDM_State.getSummary(jobId);

    return {
      active: Boolean(
        state &&
        (
          state.status === GDM_JOB_STATUS.PENDING ||
          state.status === GDM_JOB_STATUS.RUNNING ||
          state.status === GDM_JOB_STATUS.PAUSED
        )
      ),
      jobId: jobId,
      state: state,
      queue: GDM_Queue.getMeta(jobId),
      engineBusy: this.hasActiveRunToken_(jobId)
    };
  },

  /************************************************************************************************
   * RÉSULTAT RUN
   ************************************************************************************************/
  buildRunResult_: function(jobId, processedThisRun, message) {
    return {
      ok: true,
      jobId: jobId,
      processedThisRun: Number(processedThisRun || 0),
      message: GDM_Utils.toString(message),
      state: GDM_State.getSummary(jobId),
      queue: GDM_Queue.getMeta(jobId)
    };
  },

  /************************************************************************************************
   * ERREUR MOTEUR
   ************************************************************************************************/
  handleRunError_: function(jobId, error) {
    try {
      GDM_State.setLastError(
        jobId,
        GDM_Utils.errorToObject(error, {
          module: 'Engine',
          action: 'RUN'
        })
      );
    } catch (ignoredState) {}

    try {
      GDM_Logger.error(error, {
        jobId: jobId,
        module: 'Engine',
        action: 'RUN'
      });
    } catch (ignoredLog) {}

    /*
     * Une erreur d'infrastructure ne condamne pas automatiquement le job.
     * Si la queue contient encore du travail, une seule reprise est planifiée.
     */
    try {
      var state = GDM_State.get(jobId);

      if (
        state &&
        state.status === GDM_JOB_STATUS.RUNNING &&
        GDM_Queue.hasPending(jobId) &&
        state.cancelRequested !== true &&
        state.pauseRequested !== true
      ) {
        this.scheduleResume(
          jobId,
          GDM_Config.get('TRIGGERS.RESUME_DELAY_MS', 5000)
        );
      }
    } catch (ignoredSchedule) {}
  },

  /************************************************************************************************
   * VERROU LOGIQUE PAR JOB
   ************************************************************************************************/
  acquireRunToken_: function(jobId) {
    var self = this;

    return GDM_Utils.withScriptLock(function() {
      var properties = PropertiesService.getScriptProperties();
      var key = self.RUN_LOCK_PREFIX_ + jobId;
      var existing = GDM_Utils.safeJsonParse(
        properties.getProperty(key),
        null
      );

      var now = Date.now();

      if (existing && Number(existing.expiresAt || 0) > now) {
        return null;
      }

      var token = Utilities.getUuid();
      var ttl = GDM_Utils.toPositiveInteger(
        GDM_Config.get('RUNTIME.MAX_EXECUTION_MS', 270000),
        270000
      ) + 120000;

      properties.setProperty(
        key,
        JSON.stringify({
          token: token,
          jobId: jobId,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + ttl
        })
      );

      return token;
    }, GDM_Config.get('LOCK.ENGINE_LOCK_TIMEOUT_MS', 5000));
  },

  /************************************************************************************************
   * RAFRAÎCHIR VERROU
   ************************************************************************************************/
  refreshRunToken_: function(jobId, token) {
    var self = this;

    try {
      return GDM_Utils.withScriptLock(function() {
        var properties = PropertiesService.getScriptProperties();
        var key = self.RUN_LOCK_PREFIX_ + jobId;
        var existing = GDM_Utils.safeJsonParse(
          properties.getProperty(key),
          null
        );

        if (!existing || existing.token !== token) {
          return false;
        }

        var now = Date.now();
        var ttl = GDM_Utils.toPositiveInteger(
          GDM_Config.get('RUNTIME.MAX_EXECUTION_MS', 270000),
          270000
        ) + 120000;

        existing.updatedAt = now;
        existing.expiresAt = now + ttl;

        properties.setProperty(key, JSON.stringify(existing));
        return true;
      }, GDM_Config.get('LOCK.ENGINE_LOCK_TIMEOUT_MS', 5000));
    } catch (ignored) {
      return false;
    }
  },

  /************************************************************************************************
   * LIBÉRER VERROU
   ************************************************************************************************/
  releaseRunToken_: function(jobId, token) {
    var self = this;

    try {
      return GDM_Utils.withScriptLock(function() {
        var properties = PropertiesService.getScriptProperties();
        var key = self.RUN_LOCK_PREFIX_ + jobId;
        var existing = GDM_Utils.safeJsonParse(
          properties.getProperty(key),
          null
        );

        if (existing && existing.token === token) {
          properties.deleteProperty(key);
          return true;
        }

        return false;
      }, GDM_Config.get('LOCK.ENGINE_LOCK_TIMEOUT_MS', 5000));
    } catch (ignored) {
      return false;
    }
  },

  /************************************************************************************************
   * FORCER LIBÉRATION
   ************************************************************************************************/
  forceReleaseRunToken_: function(jobId) {
    try {
      PropertiesService
        .getScriptProperties()
        .deleteProperty(this.RUN_LOCK_PREFIX_ + jobId);
      return true;
    } catch (ignored) {
      return false;
    }
  },

  /************************************************************************************************
   * VERROU ACTIF ?
   ************************************************************************************************/
  hasActiveRunToken_: function(jobId) {
    try {
      var existing = GDM_Utils.safeJsonParse(
        PropertiesService
          .getScriptProperties()
          .getProperty(this.RUN_LOCK_PREFIX_ + jobId),
        null
      );

      if (!existing) {
        return false;
      }

      if (Number(existing.expiresAt || 0) <= Date.now()) {
        this.forceReleaseRunToken_(jobId);
        return false;
      }

      return true;
    } catch (ignored) {
      return false;
    }
  },

  /************************************************************************************************
   * STATUT MODULES
   ************************************************************************************************/
  getModuleStatus: function() {
    return {
      Explorer: typeof GDM_Explorer !== 'undefined',
      Analysis:
        typeof GDM_Analysis !== 'undefined' &&
        typeof GDM_Analysis.processTask === 'function',
      Move:
        typeof GDM_Move !== 'undefined' &&
        typeof GDM_Move.processTask === 'function',
      Copy:
        typeof GDM_Copy !== 'undefined' &&
        typeof GDM_Copy.processTask === 'function',
      Duplicates:
        typeof GDM_Duplicates !== 'undefined' &&
        typeof GDM_Duplicates.processTask === 'function',
      Archive:
        typeof GDM_Archive !== 'undefined' &&
        typeof GDM_Archive.processTask === 'function',
      Rename:
        typeof GDM_Rename !== 'undefined' &&
        typeof GDM_Rename.processTask === 'function',
      FolderTools:
        typeof GDM_FolderTools !== 'undefined' &&
        typeof GDM_FolderTools.processTask === 'function'
    };
  },

  /************************************************************************************************
   * VALIDATION
   ************************************************************************************************/
  validate: function() {
    var errors = [];

    try {
      if (typeof GDM_State === 'undefined') {
        errors.push('GDM_State indisponible.');
      }

      if (typeof GDM_Queue === 'undefined') {
        errors.push('GDM_Queue indisponible.');
      }

      if (typeof GDM_Utils === 'undefined') {
        errors.push('GDM_Utils indisponible.');
      }

      if (typeof GDM_Logger === 'undefined') {
        errors.push('GDM_Logger indisponible.');
      }

      var handler = GDM_Config.get('TRIGGERS.HANDLER_FUNCTION', '');

      if (handler !== 'GDM_engineTrigger') {
        errors.push('Handler trigger incorrect.');
      }
    } catch (error) {
      errors.push(GDM_Utils.getErrorMessage(error));
    }

    return {
      ok: errors.length === 0,
      file: 'Core/Engine.gs',
      version: '2.0.2',
      longScriptLock: false,
      singleResumeTrigger: true,
      safeMaxTasksPerRun: this.SAFE_MAX_TASKS_PER_RUN_,
      safeHardRuntimeMs: this.SAFE_HARD_RUNTIME_MS_,
      modules: this.getModuleStatus(),
      errors: errors
    };
  }
});

/**************************************************************************************************
 * HANDLER GLOBAL DU TRIGGER
 **************************************************************************************************/
function GDM_engineTrigger(e) {
  try {
    return GDM_Engine.triggerRun(e || {});
  } catch (error) {
    try {
      var jobId = GDM_State.getCurrentJobId();

      if (jobId) {
        GDM_Logger.error(error, {
          jobId: jobId,
          module: 'Engine',
          action: 'TRIGGER_RUN'
        });
      }
    } catch (ignored) {}

    throw error;
  }
}
