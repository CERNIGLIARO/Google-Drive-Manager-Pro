/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Engine.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Moteur central d'exécution de Google Drive Manager PRO V2.
 *
 * Ce fichier gère :
 * - exécution des jobs ;
 * - traitement progressif des queues ;
 * - dispatch des tâches vers les modules métier ;
 * - contrôle du temps d'exécution Apps Script ;
 * - reprise automatique ;
 * - déclencheurs temporels ;
 * - pause ;
 * - annulation ;
 * - retries ;
 * - checkpoints ;
 * - synchronisation State / Queue / Logger ;
 * - finalisation des jobs ;
 * - récupération après interruption.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 * Core/State.gs
 * Core/Queue.gs
 *
 * MODULES ATTENDUS
 * ---------------
 * Modules/Explorer.gs
 * Modules/Analysis.gs
 * Modules/Move.gs
 * Modules/Copy.gs
 * Modules/Duplicates.gs
 * Modules/Archive.gs
 * Modules/Rename.gs
 * Modules/FolderTools.gs
 *
 * CONTRAT MODULE
 * --------------
 * Chaque module métier utilisé par Engine.gs doit exposer :
 *
 * GDM_Module.processTask(task, context)
 *
 * Retour conseillé :
 *
 * {
 *   ok: true,
 *   skipped: false,
 *   message: '',
 *   data: {}
 * }
 *
 * IMPORTANT
 * ---------
 * - Engine.gs ne contient pas la logique métier des modules.
 * - Aucun fichier Drive n'est supprimé par ce fichier.
 * - Les traitements longs passent obligatoirement par Queue + State.
 **************************************************************************************************/

'use strict';


const GDM_Engine = Object.freeze({


  /************************************************************************************************
   * DÉMARRAGE D'UN JOB
   ************************************************************************************************/

  start: function(jobId, options) {

    options = options || {};

    jobId = GDM_Utils.requireString(
      jobId,
      'jobId'
    );

    var state = GDM_State.require(
      jobId
    );

    if (
      state.status ===
        GDM_JOB_STATUS.COMPLETED ||
      state.status ===
        GDM_JOB_STATUS.CANCELLED
    ) {
      throw new Error(
        'Impossible de démarrer un job déjà terminé ou annulé.'
      );
    }

    GDM_State.setCurrentJobId(
      jobId
    );

    /*
     * Si une précédente exécution s'est interrompue alors qu'une tâche
     * était RUNNING, celle-ci revient en PENDING.
     */
    GDM_Queue.resetRunningTasks(
      jobId
    );

    if (
      state.status ===
      GDM_JOB_STATUS.PAUSED
    ) {
      GDM_State.resume(
        jobId,
        'Reprise du traitement.'
      );
    } else if (
      state.status !==
      GDM_JOB_STATUS.RUNNING
    ) {
      GDM_State.start(
        jobId,
        'Traitement démarré.'
      );
    }

    if (
      GDM_Utils.toBoolean(
        options.async,
        false
      )
    ) {
      this.scheduleResume(
        jobId,
        GDM_Utils.toInteger(
          options.delayMs,
          GDM_Config.get(
            'TRIGGERS.RESUME_DELAY_MS',
            5000
          )
        )
      );

      return {
        ok: true,
        jobId: jobId,
        scheduled: true,
        state: GDM_State.getSummary(
          jobId
        )
      };
    }

    return this.run(
      jobId,
      options
    );
  },


  /************************************************************************************************
   * EXÉCUTION PRINCIPALE
   ************************************************************************************************/

  run: function(jobId, options) {

    options = options || {};

    jobId = GDM_Utils.requireString(
      jobId,
      'jobId'
    );

    var lock =
      LockService.getScriptLock();

    var lockTimeout =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'LOCK.ENGINE_LOCK_TIMEOUT_MS',
          5000
        ),
        5000
      );

    if (
      !lock.tryLock(
        lockTimeout
      )
    ) {
      return {
        ok: false,
        jobId: jobId,
        busy: true,
        message:
          'Le moteur Google Drive Manager PRO est déjà en cours d’exécution.'
      };
    }

    try {
      return this.runUnlocked_(
        jobId,
        options
      );
    } finally {
      try {
        lock.releaseLock();
      } catch (ignored) {}
    }
  },


  /************************************************************************************************
   * EXÉCUTION SANS LOCK
   ************************************************************************************************/

  runUnlocked_: function(jobId, options) {

    options = options || {};

    var runtime =
      GDM_Utils.createRuntimeContext();

    var maxTasks =
      GDM_Utils.toPositiveInteger(
        options.maxTasks,
        GDM_Config.get(
          'RUNTIME.MAX_TASKS_PER_RUN',
          250
        )
      );

    var checkpointEvery =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'RUNTIME.STATE_SAVE_EVERY_ITEMS',
          25
        ),
        25
      );

    var cancelCheckEvery =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'RUNTIME.CANCEL_CHECK_EVERY_ITEMS',
          10
        ),
        10
      );

    var state =
      GDM_State.require(
        jobId
      );

    if (
      state.status ===
      GDM_JOB_STATUS.CANCELLED
    ) {
      return this.buildRunResult_(
        jobId,
        0,
        'Job déjà annulé.'
      );
    }

    if (
      state.status ===
      GDM_JOB_STATUS.COMPLETED
    ) {
      return this.buildRunResult_(
        jobId,
        0,
        'Job déjà terminé.'
      );
    }

    if (
      state.pauseRequested === true ||
      state.status ===
        GDM_JOB_STATUS.PAUSED
    ) {
      return this.buildRunResult_(
        jobId,
        0,
        'Job en pause.'
      );
    }

    GDM_State.setCurrentJobId(
      jobId
    );

    if (
      state.status !==
      GDM_JOB_STATUS.RUNNING
    ) {
      GDM_State.start(
        jobId,
        'Traitement en cours.'
      );
    }

    /*
     * Nettoyage des triggers de reprise déjà consommés.
     */
    this.cleanupOwnTriggers_();

    var processedThisRun = 0;
    var terminalThisRun = 0;
    var retriesThisRun = 0;

    while (
      processedThisRun < maxTasks
    ) {

      /*
       * Arrêt avant la limite Apps Script.
       */
      if (
        GDM_Utils.runtimeExpired(
          runtime
        )
      ) {
        break;
      }

      /*
       * Vérification périodique pause / annulation.
       */
      if (
        processedThisRun === 0 ||
        processedThisRun %
          cancelCheckEvery ===
          0
      ) {

        var freshState =
          GDM_State.get(
            jobId
          );

        if (!freshState) {
          throw new Error(
            'État du job introuvable pendant l’exécution.'
          );
        }

        if (
          freshState.cancelRequested ===
            true ||
          freshState.status ===
            GDM_JOB_STATUS.CANCELLED
        ) {

          GDM_Queue.cancelPending(
            jobId,
            'Job annulé.'
          );

          if (
            freshState.status !==
            GDM_JOB_STATUS.CANCELLED
          ) {
            GDM_State.cancel(
              jobId,
              'Traitement annulé.'
            );
          }

          return this.buildRunResult_(
            jobId,
            processedThisRun,
            'Traitement annulé.'
          );
        }

        if (
          freshState.pauseRequested ===
            true ||
          freshState.status ===
            GDM_JOB_STATUS.PAUSED
        ) {

          if (
            freshState.status !==
            GDM_JOB_STATUS.PAUSED
          ) {
            GDM_State.pause(
              jobId,
              'Traitement mis en pause.'
            );
          }

          return this.buildRunResult_(
            jobId,
            processedThisRun,
            'Traitement en pause.'
          );
        }
      }

      /*
       * Prend la prochaine tâche PENDING et la passe RUNNING.
       */
      var task =
        GDM_Queue.claimNext(
          jobId
        );

      if (!task) {
        break;
      }

      processedThisRun++;

      GDM_State.setCurrentItem(
        jobId,
        {
          id:
            task.itemId,

          name:
            task.itemName,

          taskId:
            task.taskId
        }
      );

      var executionResult;

      try {

        executionResult =
          this.executeTask_(
            task,
            {
              jobId: jobId,
              runtime: runtime,
              state:
                GDM_State.get(
                  jobId
                )
            }
          );

        executionResult =
          this.normalizeModuleResult_(
            executionResult
          );

        if (
          executionResult.skipped ===
          true
        ) {

          GDM_Queue.skipTask(
            jobId,
            task.taskId,
            executionResult.message ||
              'Élément ignoré.'
          );

          GDM_State.increment(
            jobId,
            {
              processed: 1,
              skipped: 1
            }
          );

          terminalThisRun++;

          try {
            GDM_Logger.itemSkipped(
              jobId,
              {
                taskId:
                  task.taskId,

                module:
                  task.module,

                action:
                  task.action,

                itemId:
                  task.itemId,

                itemName:
                  task.itemName,

                message:
                  executionResult.message ||
                  'Élément ignoré.'
              }
            );
          } catch (ignoredSkipLog) {}

        } else if (
          executionResult.ok ===
          false
        ) {

          throw new Error(
            executionResult.message ||
            'Le module a retourné une erreur.'
          );

        } else {

          GDM_Queue.completeTask(
            jobId,
            task.taskId,
            executionResult
          );

          GDM_State.increment(
            jobId,
            {
              processed: 1,
              success: 1
            }
          );

          terminalThisRun++;

          try {
            GDM_Logger.itemProcessed(
              jobId,
              {
                taskId:
                  task.taskId,

                module:
                  task.module,

                action:
                  task.action,

                itemId:
                  task.itemId,

                itemName:
                  task.itemName,

                message:
                  executionResult.message ||
                  'Élément traité.'
              }
            );
          } catch (ignoredSuccessLog) {}
        }

      } catch (error) {

        var failedTask =
          GDM_Queue.failTask(
            jobId,
            task.taskId,
            error
          );

        /*
         * Si la tâche revient en PENDING, ce n'est pas encore
         * une erreur terminale du job.
         */
        if (
          failedTask &&
          failedTask.status ===
            GDM_QUEUE_STATUS.PENDING
        ) {

          retriesThisRun++;

          try {
            GDM_Logger.warn(
              'Nouvelle tentative planifiée.',
              {
                jobId:
                  jobId,

                taskId:
                  task.taskId,

                module:
                  task.module,

                action:
                  task.action,

                itemId:
                  task.itemId,

                itemName:
                  task.itemName,

                data: {
                  attempt:
                    failedTask.attempts
                }
              }
            );
          } catch (ignoredRetryLog) {}

        } else {

          terminalThisRun++;

          GDM_State.increment(
            jobId,
            {
              processed: 1,
              errors: 1
            }
          );

          GDM_State.update(
            jobId,
            {
              lastError:
                GDM_Utils.errorToObject(
                  error,
                  {
                    jobId:
                      jobId,

                    taskId:
                      task.taskId,

                    module:
                      task.module,

                    action:
                      task.action,

                    itemId:
                      task.itemId,

                    itemName:
                      task.itemName
                  }
                )
            }
          );

          try {
            GDM_Logger.itemError(
              jobId,
              error,
              {
                taskId:
                  task.taskId,

                module:
                  task.module,

                action:
                  task.action,

                itemId:
                  task.itemId,

                itemName:
                  task.itemName
              }
            );
          } catch (ignoredErrorLog) {}
        }
      }

      /*
       * Checkpoint périodique.
       */
      if (
        terminalThisRun > 0 &&
        terminalThisRun %
          checkpointEvery ===
          0
      ) {

        var checkpointState =
          GDM_State.get(
            jobId
          );

        if (checkpointState) {
          GDM_State.checkpoint(
            jobId,
            {
              processed:
                checkpointState.processed,

              totalKnown:
                checkpointState.totalKnown,

              success:
                checkpointState.success,

              skipped:
                checkpointState.skipped,

              errors:
                checkpointState.errors,

              currentItem:
                checkpointState.currentItem,

              currentItemId:
                checkpointState.currentItemId,

              currentTaskId:
                checkpointState.currentTaskId,

              message:
                'Traitement en cours.'
            }
          );
        }
      }
    }

    /*
     * Vérification de la queue après le lot.
     */
    var meta =
      GDM_Queue.getMeta(
        jobId
      );

    if (
      !meta ||
      meta.done === true
    ) {
      return this.finalizeJob_(
        jobId,
        processedThisRun
      );
    }

    /*
     * Si des tâches restent, le job est conservé pour reprise.
     */
    GDM_State.checkpoint(
      jobId,
      {
        message:
          'Lot terminé. Reprise nécessaire.'
      }
    );

    if (
      GDM_Config.get(
        'QUEUE.AUTO_RESUME',
        true
      ) &&
      GDM_Config.get(
        'TRIGGERS.ENABLED',
        true
      )
    ) {
      this.scheduleResume(
        jobId,
        GDM_Config.get(
          'QUEUE.AUTO_RESUME_DELAY_MS',
          5000
        )
      );
    }

    return {
      ok: true,

      jobId:
        jobId,

      completed:
        false,

      processedThisRun:
        processedThisRun,

      terminalThisRun:
        terminalThisRun,

      retriesThisRun:
        retriesThisRun,

      remaining:
        Number(
          meta.pending || 0
        ) +
        Number(
          meta.running || 0
        ),

      scheduled:
        GDM_Config.get(
          'QUEUE.AUTO_RESUME',
          true
        ),

      state:
        GDM_State.getSummary(
          jobId
        ),

      queue:
        meta
    };
  },


  /************************************************************************************************
   * EXÉCUTION D'UNE TÂCHE
   ************************************************************************************************/

  executeTask_: function(
    task,
    context
  ) {

    if (!task) {
      throw new Error(
        'Engine : tâche vide.'
      );
    }

    context =
      context || {};

    context.task =
      task;

    switch (
      task.module
    ) {

      case GDM_MODULES.EXPLORER:

        if (
          typeof GDM_Explorer ===
            'undefined' ||
          typeof GDM_Explorer.processTask !==
            'function'
        ) {
          throw new Error(
            'Module Explorer non disponible ou processTask() absent.'
          );
        }

        return GDM_Explorer.processTask(
          task,
          context
        );


      case GDM_MODULES.ANALYSIS:

        if (
          typeof GDM_Analysis ===
            'undefined' ||
          typeof GDM_Analysis.processTask !==
            'function'
        ) {
          throw new Error(
            'Module Analysis non disponible ou processTask() absent.'
          );
        }

        return GDM_Analysis.processTask(
          task,
          context
        );


      case GDM_MODULES.MOVE:

        if (
          typeof GDM_Move ===
            'undefined' ||
          typeof GDM_Move.processTask !==
            'function'
        ) {
          throw new Error(
            'Module Move non disponible ou processTask() absent.'
          );
        }

        return GDM_Move.processTask(
          task,
          context
        );


      case GDM_MODULES.COPY:

        if (
          typeof GDM_Copy ===
            'undefined' ||
          typeof GDM_Copy.processTask !==
            'function'
        ) {
          throw new Error(
            'Module Copy non disponible ou processTask() absent.'
          );
        }

        return GDM_Copy.processTask(
          task,
          context
        );


      case GDM_MODULES.DUPLICATES:

        if (
          typeof GDM_Duplicates ===
            'undefined' ||
          typeof GDM_Duplicates.processTask !==
            'function'
        ) {
          throw new Error(
            'Module Duplicates non disponible ou processTask() absent.'
          );
        }

        return GDM_Duplicates.processTask(
          task,
          context
        );


      case GDM_MODULES.ARCHIVE:

        if (
          typeof GDM_Archive ===
            'undefined' ||
          typeof GDM_Archive.processTask !==
            'function'
        ) {
          throw new Error(
            'Module Archive non disponible ou processTask() absent.'
          );
        }

        return GDM_Archive.processTask(
          task,
          context
        );


      case GDM_MODULES.RENAME:

        if (
          typeof GDM_Rename ===
            'undefined' ||
          typeof GDM_Rename.processTask !==
            'function'
        ) {
          throw new Error(
            'Module Rename non disponible ou processTask() absent.'
          );
        }

        return GDM_Rename.processTask(
          task,
          context
        );


      case GDM_MODULES.FOLDER_TOOLS:

        if (
          typeof GDM_FolderTools ===
            'undefined' ||
          typeof GDM_FolderTools.processTask !==
            'function'
        ) {
          throw new Error(
            'Module FolderTools non disponible ou processTask() absent.'
          );
        }

        return GDM_FolderTools.processTask(
          task,
          context
        );


      default:

        throw new Error(
          'Engine : module inconnu : ' +
          GDM_Utils.toString(
            task.module
          )
        );
    }
  },


  /************************************************************************************************
   * NORMALISATION DU RETOUR MODULE
   ************************************************************************************************/

  normalizeModuleResult_: function(
    result
  ) {

    if (
      result === null ||
      typeof result ===
        'undefined'
    ) {
      return {
        ok: true,
        skipped: false,
        message: '',
        data: {}
      };
    }

    if (
      typeof result ===
      'boolean'
    ) {
      return {
        ok: result,
        skipped: false,
        message: '',
        data: {}
      };
    }

    if (
      typeof result !==
      'object'
    ) {
      return {
        ok: true,
        skipped: false,
        message:
          GDM_Utils.toString(
            result
          ),
        data: {}
      };
    }

    return {
      ok:
        typeof result.ok ===
          'boolean'
          ? result.ok
          : true,

      skipped:
        result.skipped === true,

      message:
        GDM_Utils.toString(
          result.message
        ),

      data:
        typeof result.data ===
          'undefined'
          ? {}
          : result.data,

      result:
        typeof result.result ===
          'undefined'
          ? null
          : result.result
    };
  },


  /************************************************************************************************
   * FINALISATION
   ************************************************************************************************/

  finalizeJob_: function(
    jobId,
    processedThisRun
  ) {

    var queue =
      GDM_Queue.getMeta(
        jobId
      );

    var currentState =
      GDM_State.require(
        jobId
      );

    /*
     * Un job peut être techniquement terminé tout en ayant des erreurs
     * sur certains fichiers. On conserve COMPLETED : les compteurs
     * indiquent clairement le nombre d'erreurs.
     */
    var result = {
      ok:
        Number(
          currentState.errors || 0
        ) === 0,

      module:
        currentState.module,

      action:
        currentState.action,

      jobId:
        jobId,

      processed:
        Number(
          currentState.processed || 0
        ),

      success:
        Number(
          currentState.success || 0
        ),

      skipped:
        Number(
          currentState.skipped || 0
        ),

      errors:
        Number(
          currentState.errors || 0
        ),

      message:
        Number(
          currentState.errors || 0
        ) > 0
          ? 'Traitement terminé avec erreur(s).'
          : 'Traitement terminé avec succès.',

      data: {
        queue:
          queue
      }
    };

    GDM_State.saveResult(
      jobId,
      result
    );

    GDM_State.complete(
      jobId,
      result.message
    );

    try {
      GDM_Logger.queueCompleted(
        jobId,
        {
          module:
            currentState.module,

          action:
            currentState.action,

          message:
            'Queue terminée.',

          data:
            queue
        }
      );
    } catch (ignored) {}

    if (
      GDM_Config.get(
        'QUEUE.KEEP_COMPLETED_TASKS',
        false
      ) === false
    ) {
      try {
        GDM_Queue.compact(
          jobId
        );
      } catch (ignoredCompact) {}
    }

    this.removeResumeTriggers();

    return {
      ok: true,

      jobId:
        jobId,

      completed:
        true,

      processedThisRun:
        processedThisRun,

      state:
        GDM_State.getSummary(
          jobId
        ),

      result:
        result
    };
  },


  /************************************************************************************************
   * PAUSE
   ************************************************************************************************/

  pause: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    var state =
      GDM_State.require(
        jobId
      );

    if (
      state.status ===
        GDM_JOB_STATUS.COMPLETED ||
      state.status ===
        GDM_JOB_STATUS.CANCELLED
    ) {
      return state;
    }

    GDM_State.requestPause(
      jobId
    );

    this.removeResumeTriggers();

    return GDM_State.get(
      jobId
    );
  },


  /************************************************************************************************
   * REPRISE
   ************************************************************************************************/

  resume: function(jobId, options) {

    options = options || {};

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    var state =
      GDM_State.require(
        jobId
      );

    if (
      state.status ===
        GDM_JOB_STATUS.COMPLETED ||
      state.status ===
        GDM_JOB_STATUS.CANCELLED
    ) {
      throw new Error(
        'Ce job ne peut plus être repris.'
      );
    }

    GDM_Queue.resetRunningTasks(
      jobId
    );

    GDM_State.setCurrentJobId(
      jobId
    );

    if (
      state.status ===
        GDM_JOB_STATUS.PAUSED ||
      state.pauseRequested ===
        true
    ) {
      GDM_State.resume(
        jobId,
        'Reprise du traitement.'
      );
    }

    if (
      GDM_Utils.toBoolean(
        options.async,
        false
      )
    ) {
      this.scheduleResume(
        jobId
      );

      return {
        ok: true,
        jobId: jobId,
        scheduled: true
      };
    }

    return this.run(
      jobId,
      options
    );
  },


  /************************************************************************************************
   * ANNULATION
   ************************************************************************************************/

  cancel: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    var state =
      GDM_State.require(
        jobId
      );

    if (
      state.status ===
      GDM_JOB_STATUS.COMPLETED
    ) {
      return state;
    }

    GDM_State.requestCancel(
      jobId
    );

    GDM_Queue.cancelPending(
      jobId,
      'Job annulé par l’utilisateur.'
    );

    this.removeResumeTriggers();

    return GDM_State.cancel(
      jobId,
      'Traitement annulé par l’utilisateur.'
    );
  },


  /************************************************************************************************
   * EXÉCUTION D'UN SEUL LOT MANUEL
   ************************************************************************************************/

  runOneBatch: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    return this.run(
      jobId,
      {
        maxTasks:
          GDM_Config.get(
            'QUEUE.MAX_ITEMS_PER_BATCH',
            250
          )
      }
    );
  },


  /************************************************************************************************
   * TRIGGER DE REPRISE
   ************************************************************************************************/

  scheduleResume: function(
    jobId,
    delayMs
  ) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    if (
      !GDM_Config.get(
        'TRIGGERS.ENABLED',
        true
      )
    ) {
      return {
        ok: false,
        scheduled: false,
        reason:
          'Déclencheurs désactivés.'
      };
    }

    var state =
      GDM_State.require(
        jobId
      );

    if (
      state.status ===
        GDM_JOB_STATUS.COMPLETED ||
      state.status ===
        GDM_JOB_STATUS.CANCELLED ||
      state.status ===
        GDM_JOB_STATUS.ERROR
    ) {
      return {
        ok: false,
        scheduled: false,
        reason:
          'Job terminé.'
      };
    }

    GDM_State.setCurrentJobId(
      jobId
    );

    delayMs =
      Math.max(
        1000,
        GDM_Utils.toInteger(
          delayMs,
          GDM_Config.get(
            'TRIGGERS.RESUME_DELAY_MS',
            5000
          )
        )
      );

    if (
      GDM_Config.get(
        'TRIGGERS.DELETE_OLD_TRIGGER_BEFORE_CREATE',
        true
      )
    ) {
      this.removeResumeTriggers();
    }

    var maxTriggers =
      GDM_Utils.toPositiveInteger(
        GDM_Config.get(
          'TRIGGERS.MAX_PROJECT_TRIGGERS',
          15
        ),
        15
      );

    var existing =
      ScriptApp.getProjectTriggers();

    if (
      existing.length >=
      maxTriggers
    ) {
      this.cleanupOwnTriggers_();

      existing =
        ScriptApp.getProjectTriggers();

      if (
        existing.length >=
        maxTriggers
      ) {
        throw new Error(
          'Nombre maximum de déclencheurs Apps Script atteint.'
        );
      }
    }

    var handler =
      GDM_Config.get(
        'TRIGGERS.HANDLER_FUNCTION',
        'GDM_engineTrigger'
      );

    var trigger =
      ScriptApp
        .newTrigger(
          handler
        )
        .timeBased()
        .after(
          delayMs
        )
        .create();

    var triggerId = '';

    try {
      triggerId =
        trigger.getUniqueId();
    } catch (ignoredId) {}

    var propertyKey =
      GDM_Config.get(
        'STORAGE_KEYS.TRIGGER_PREFIX',
        'GDMV2_TRIGGER_'
      ) +
      jobId;

    PropertiesService
      .getScriptProperties()
      .setProperty(
        propertyKey,
        JSON.stringify({
          jobId:
            jobId,

          triggerId:
            triggerId,

          createdAt:
            GDM_Utils.nowIso(),

          delayMs:
            delayMs
        })
      );

    return {
      ok: true,

      scheduled: true,

      jobId:
        jobId,

      triggerId:
        triggerId,

      delayMs:
        delayMs
    };
  },


  /************************************************************************************************
   * SUPPRESSION DES TRIGGERS DE REPRISE
   ************************************************************************************************/

  removeResumeTriggers: function() {

    var handler =
      GDM_Config.get(
        'TRIGGERS.HANDLER_FUNCTION',
        'GDM_engineTrigger'
      );

    var triggers =
      ScriptApp.getProjectTriggers();

    var removed = 0;

    for (
      var i = 0;
      i < triggers.length;
      i++
    ) {

      var trigger =
        triggers[i];

      var functionName = '';

      try {
        functionName =
          trigger.getHandlerFunction();
      } catch (ignoredHandler) {}

      if (
        functionName !==
        handler
      ) {
        continue;
      }

      try {
        ScriptApp.deleteTrigger(
          trigger
        );

        removed++;
      } catch (ignoredDelete) {}
    }

    this.clearTriggerProperties_();

    return removed;
  },


  /************************************************************************************************
   * NETTOYAGE DES TRIGGERS PROPRES AU MOTEUR
   ************************************************************************************************/

  cleanupOwnTriggers_: function() {

    var handler =
      GDM_Config.get(
        'TRIGGERS.HANDLER_FUNCTION',
        'GDM_engineTrigger'
      );

    var triggers =
      ScriptApp.getProjectTriggers();

    /*
     * On conserve au maximum un trigger GDM en attente.
     */
    var own = [];

    for (
      var i = 0;
      i < triggers.length;
      i++
    ) {

      try {
        if (
          triggers[i].getHandlerFunction() ===
          handler
        ) {
          own.push(
            triggers[i]
          );
        }
      } catch (ignored) {}
    }

    if (
      own.length <= 1
    ) {
      return 0;
    }

    var removed = 0;

    for (
      var j = 1;
      j < own.length;
      j++
    ) {
      try {
        ScriptApp.deleteTrigger(
          own[j]
        );

        removed++;
      } catch (ignoredDelete) {}
    }

    return removed;
  },


  clearTriggerProperties_: function() {

    var properties =
      PropertiesService
        .getScriptProperties();

    var all =
      properties.getProperties();

    var prefix =
      GDM_Config.get(
        'STORAGE_KEYS.TRIGGER_PREFIX',
        'GDMV2_TRIGGER_'
      );

    var keys =
      Object.keys(
        all
      );

    for (
      var i = 0;
      i < keys.length;
      i++
    ) {

      if (
        keys[i].indexOf(
          prefix
        ) === 0
      ) {
        properties.deleteProperty(
          keys[i]
        );
      }
    }
  },


  /************************************************************************************************
   * CALLBACK DU TRIGGER
   ************************************************************************************************/

  triggerRun: function() {

    var jobId =
      GDM_State.getCurrentJobId();

    if (!jobId) {
      this.removeResumeTriggers();

      return {
        ok: false,
        message:
          'Aucun job courant.'
      };
    }

    var state =
      GDM_State.get(
        jobId
      );

    if (!state) {
      GDM_State.clearCurrentJobId();

      this.removeResumeTriggers();

      return {
        ok: false,
        message:
          'Job introuvable.'
      };
    }

    if (
      state.status ===
        GDM_JOB_STATUS.COMPLETED ||
      state.status ===
        GDM_JOB_STATUS.CANCELLED ||
      state.status ===
        GDM_JOB_STATUS.ERROR
    ) {
      this.removeResumeTriggers();

      return {
        ok: true,
        completed: true,
        jobId:
          jobId
      };
    }

    if (
      state.pauseRequested ===
        true ||
      state.status ===
        GDM_JOB_STATUS.PAUSED
    ) {
      this.removeResumeTriggers();

      return {
        ok: true,
        paused: true,
        jobId:
          jobId
      };
    }

    return this.run(
      jobId
    );
  },


  /************************************************************************************************
   * RÉCUPÉRATION APRÈS INTERRUPTION
   ************************************************************************************************/

  recover: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    var state =
      GDM_State.require(
        jobId
      );

    if (
      state.status ===
        GDM_JOB_STATUS.COMPLETED ||
      state.status ===
        GDM_JOB_STATUS.CANCELLED
    ) {
      return {
        ok: true,
        jobId: jobId,
        recovered: false,
        state: state
      };
    }

    var reset =
      GDM_Queue.resetRunningTasks(
        jobId
      );

    GDM_State.setCurrentJobId(
      jobId
    );

    if (
      state.status ===
      GDM_JOB_STATUS.RUNNING
    ) {
      GDM_State.checkpoint(
        jobId,
        {
          message:
            'Job récupéré après interruption.'
        }
      );
    }

    return {
      ok: true,

      jobId:
        jobId,

      recovered:
        true,

      resetRunningTasks:
        reset,

      state:
        GDM_State.get(
          jobId
        ),

      queue:
        GDM_Queue.getMeta(
          jobId
        )
    };
  },


  /************************************************************************************************
   * STATUT GLOBAL
   ************************************************************************************************/

  getStatus: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        active: false,
        jobId: '',
        state: null,
        queue: null
      };
    }

    return {
      active: true,

      jobId:
        jobId,

      state:
        GDM_State.getSummary(
          jobId
        ),

      queue:
        GDM_Queue.getMeta(
          jobId
        )
    };
  },


  /************************************************************************************************
   * RÉSULTAT STANDARD D'UN RUN
   ************************************************************************************************/

  buildRunResult_: function(
    jobId,
    processedThisRun,
    message
  ) {

    return {
      ok: true,

      jobId:
        jobId,

      processedThisRun:
        Number(
          processedThisRun || 0
        ),

      message:
        GDM_Utils.toString(
          message
        ),

      state:
        GDM_State.getSummary(
          jobId
        ),

      queue:
        GDM_Queue.getMeta(
          jobId
        )
    };
  },


  /************************************************************************************************
   * DIAGNOSTIC DES MODULES
   ************************************************************************************************/

  getModuleStatus: function() {

    return {
      Explorer:
        typeof GDM_Explorer !==
          'undefined' &&
        typeof GDM_Explorer.processTask ===
          'function',

      Analysis:
        typeof GDM_Analysis !==
          'undefined' &&
        typeof GDM_Analysis.processTask ===
          'function',

      Move:
        typeof GDM_Move !==
          'undefined' &&
        typeof GDM_Move.processTask ===
          'function',

      Copy:
        typeof GDM_Copy !==
          'undefined' &&
        typeof GDM_Copy.processTask ===
          'function',

      Duplicates:
        typeof GDM_Duplicates !==
          'undefined' &&
        typeof GDM_Duplicates.processTask ===
          'function',

      Archive:
        typeof GDM_Archive !==
          'undefined' &&
        typeof GDM_Archive.processTask ===
          'function',

      Rename:
        typeof GDM_Rename !==
          'undefined' &&
        typeof GDM_Rename.processTask ===
          'function',

      FolderTools:
        typeof GDM_FolderTools !==
          'undefined' &&
        typeof GDM_FolderTools.processTask ===
          'function'
    };
  },


  /************************************************************************************************
   * VALIDATION DU MOTEUR
   ************************************************************************************************/

  validate: function() {

    var errors = [];

    try {

      if (
        typeof GDM_State ===
        'undefined'
      ) {
        errors.push(
          'GDM_State indisponible.'
        );
      }

      if (
        typeof GDM_Queue ===
        'undefined'
      ) {
        errors.push(
          'GDM_Queue indisponible.'
        );
      }

      if (
        typeof GDM_Logger ===
        'undefined'
      ) {
        errors.push(
          'GDM_Logger indisponible.'
        );
      }

      if (
        typeof GDM_Utils ===
        'undefined'
      ) {
        errors.push(
          'GDM_Utils indisponible.'
        );
      }

      var softLimit =
        GDM_Config.getSoftExecutionLimit();

      if (
        Number(
          softLimit
        ) <= 0
      ) {
        errors.push(
          'Limite d’exécution invalide.'
        );
      }

      var handler =
        GDM_Config.get(
          'TRIGGERS.HANDLER_FUNCTION',
          ''
        );

      if (
        handler !==
        'GDM_engineTrigger'
      ) {
        errors.push(
          'Le handler de déclencheur attendu est GDM_engineTrigger.'
        );
      }

    } catch (error) {

      errors.push(
        'Erreur Engine.gs : ' +
        GDM_Utils.getErrorMessage(
          error
        )
      );
    }

    return {
      ok:
        errors.length === 0,

      file:
        'Core/Engine.gs',

      version:
        GDM_APP.VERSION,

      modules:
        this.getModuleStatus(),

      errors:
        errors
    };
  }

});


/**************************************************************************************************
 * HANDLER GLOBAL APPS SCRIPT
 *
 * Cette fonction doit rester globale.
 * ScriptApp appelle cette fonction lors d'une reprise automatique.
 **************************************************************************************************/

function GDM_engineTrigger() {

  try {
    return GDM_Engine.triggerRun();
  } catch (error) {

    try {

      var jobId =
        GDM_State.getCurrentJobId();

      if (jobId) {

        GDM_Logger.error(
          error,
          {
            jobId:
              jobId,

            module:
              'Engine',

            action:
              'TRIGGER_RUN'
          }
        );

        /*
         * On ne passe pas immédiatement le job en ERROR :
         * une erreur temporaire Apps Script peut être récupérable.
         */
        var state =
          GDM_State.get(
            jobId
          );

        if (
          state &&
          state.status ===
            GDM_JOB_STATUS.RUNNING &&
          GDM_Queue.hasPending(
            jobId
          )
        ) {
          try {
            GDM_Engine.scheduleResume(
              jobId,
              GDM_Config.get(
                'TRIGGERS.RESUME_DELAY_MS',
                5000
              )
            );
          } catch (
            ignoredSchedule
          ) {}
        }
      }

    } catch (
      ignoredLogging
    ) {}

    throw error;
  }
}