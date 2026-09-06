/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Queue.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Gestion centralisée des files de tâches de Google Drive Manager PRO V2.
 *
 * Ce fichier gère :
 * - création d'une queue pour un job ;
 * - ajout de tâches ;
 * - ajout massif par lots ;
 * - récupération de la prochaine tâche ;
 * - statut PENDING / RUNNING / COMPLETED / SKIPPED / ERROR / CANCELLED ;
 * - tentatives et retries ;
 * - statistiques de queue ;
 * - sauvegarde persistante dans PropertiesService ;
 * - stockage fractionné pour les grosses queues ;
 * - reprise après interruption Apps Script ;
 * - nettoyage des tâches terminées.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 * Core/State.gs
 *
 * IMPORTANT
 * ---------
 * - Queue.gs ne contient aucune logique métier.
 * - Le traitement réel des tâches est effectué par Engine.gs et les Modules.
 * - Aucun fichier Google Drive n'est supprimé ici.
 **************************************************************************************************/

'use strict';


const GDM_Queue = Object.freeze({


  /************************************************************************************************
   * CRÉATION
   ************************************************************************************************/

  create: function(jobId, options) {

    options = options || {};

    jobId = GDM_Utils.requireString(
      jobId,
      'jobId'
    );

    if (!GDM_State.exists(jobId)) {
      throw new Error(
        'Impossible de créer la queue : job introuvable : ' +
        jobId
      );
    }

    if (this.exists(jobId)) {
      if (
        GDM_Utils.toBoolean(
          options.replace,
          false
        )
      ) {
        this.delete(jobId);
      } else {
        return this.getMeta(jobId);
      }
    }

    var now = GDM_Utils.nowIso();

    var queue = {
      schemaVersion: 1,

      jobId: jobId,

      createdAt: now,

      updatedAt: now,

      cursor: 0,

      tasks: []
    };

    this.writeQueue_(
      jobId,
      queue
    );

    this.writeMeta_(
      jobId,
      {
        jobId: jobId,

        createdAt: now,

        updatedAt: now,

        total: 0,

        pending: 0,

        running: 0,

        completed: 0,

        skipped: 0,

        errors: 0,

        cancelled: 0,

        cursor: 0,

        done: false
      }
    );

    try {
      GDM_Logger.queueCreated(
        jobId,
        {
          message: 'Queue créée.'
        }
      );
    } catch (ignored) {}

    return this.getMeta(
      jobId
    );
  },


  /************************************************************************************************
   * EXISTENCE
   ************************************************************************************************/

  exists: function(jobId) {

    jobId = GDM_Utils.trim(
      jobId
    );

    if (!jobId) {
      return false;
    }

    var key =
      GDM_Config.queueMetaKey(
        jobId
      );

    var properties =
      PropertiesService
        .getScriptProperties();

    return (
      properties.getProperty(
        key + '_META'
      ) !== null ||
      properties.getProperty(
        key
      ) !== null
    );
  },


  ensure: function(jobId) {

    if (!this.exists(jobId)) {
      this.create(jobId);
    }

    return this.getMeta(jobId);
  },


  /************************************************************************************************
   * AJOUT D'UNE TÂCHE
   ************************************************************************************************/

  add: function(jobId, task) {

    task = task || {};

    var results =
      this.addMany(
        jobId,
        [task]
      );

    return results.length
      ? results[0]
      : null;
  },


  addMany: function(jobId, tasks) {

    jobId = GDM_Utils.requireString(
      jobId,
      'jobId'
    );

    tasks = GDM_Utils.ensureArray(
      tasks
    );

    if (!tasks.length) {
      return [];
    }

    this.ensure(jobId);

    var added = GDM_Utils.withScriptLock(
      function() {

        var queue =
          GDM_Queue.readQueue_(
            jobId
          );

        if (!queue) {
          throw new Error(
            'Queue introuvable : ' +
            jobId
          );
        }

        var createdTasks = [];

        for (
          var i = 0;
          i < tasks.length;
          i++
        ) {

          var normalized =
            GDM_Queue.normalizeTask_(
              jobId,
              tasks[i]
            );

          queue.tasks.push(
            normalized
          );

          createdTasks.push(
            GDM_Queue.clone_(
              normalized
            )
          );
        }

        queue.updatedAt =
          GDM_Utils.nowIso();

        GDM_Queue.writeQueueUnlocked_(
          jobId,
          queue
        );

        GDM_Queue.rebuildMetaUnlocked_(
          jobId,
          queue
        );

        return createdTasks;
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );

    try {
      GDM_Logger.queueUpdated(
        jobId,
        {
          message:
            added.length +
            ' tâche(s) ajoutée(s) à la queue.',

          data: {
            added:
              added.length
          }
        }
      );
    } catch (ignored) {}

    return added;
  },


  /************************************************************************************************
   * AJOUT PAR LOTS
   ************************************************************************************************/

  addInBatches: function(
    jobId,
    tasks,
    batchSize
  ) {

    tasks =
      GDM_Utils.ensureArray(
        tasks
      );

    batchSize =
      GDM_Utils.toPositiveInteger(
        batchSize,
        GDM_Config.get(
          'QUEUE.MAX_ITEMS_PER_BATCH',
          250
        )
      );

    var added = [];

    for (
      var i = 0;
      i < tasks.length;
      i += batchSize
    ) {

      var batch =
        tasks.slice(
          i,
          i + batchSize
        );

      var result =
        this.addMany(
          jobId,
          batch
        );

      for (
        var j = 0;
        j < result.length;
        j++
      ) {
        added.push(
          result[j]
        );
      }
    }

    return added;
  },


  /************************************************************************************************
   * LECTURE
   ************************************************************************************************/

  get: function(jobId) {

    var queue =
      this.readQueue_(
        jobId
      );

    return queue
      ? this.clone_(queue)
      : null;
  },


  getTasks: function(
    jobId,
    options
  ) {

    options = options || {};

    var queue =
      this.readQueue_(
        jobId
      );

    if (!queue) {
      return [];
    }

    var status =
      GDM_Utils.trim(
        options.status
      ).toUpperCase();

    var action =
      GDM_Utils.trim(
        options.action
      );

    var moduleName =
      GDM_Utils.trim(
        options.module
      );

    var result = [];

    for (
      var i = 0;
      i < queue.tasks.length;
      i++
    ) {

      var task =
        queue.tasks[i];

      if (
        status &&
        task.status !== status
      ) {
        continue;
      }

      if (
        action &&
        task.action !== action
      ) {
        continue;
      }

      if (
        moduleName &&
        task.module !==
          moduleName
      ) {
        continue;
      }

      result.push(
        this.clone_(task)
      );
    }

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
        100
      );

    return result.slice(
      offset,
      offset + limit
    );
  },


  getTask: function(
    jobId,
    taskId
  ) {

    var queue =
      this.readQueue_(
        jobId
      );

    if (!queue) {
      return null;
    }

    taskId =
      GDM_Utils.trim(
        taskId
      );

    for (
      var i = 0;
      i < queue.tasks.length;
      i++
    ) {
      if (
        queue.tasks[i].taskId ===
        taskId
      ) {
        return this.clone_(
          queue.tasks[i]
        );
      }
    }

    return null;
  },


  /************************************************************************************************
   * PROCHAINE TÂCHE
   ************************************************************************************************/

  getNextPending: function(jobId) {

    jobId = GDM_Utils.requireString(
      jobId,
      'jobId'
    );

    var result =
      GDM_Utils.withScriptLock(
        function() {

          var queue =
            GDM_Queue.readQueue_(
              jobId
            );

          if (!queue) {
            return null;
          }

          if (
            !Array.isArray(
              queue.tasks
            ) ||
            !queue.tasks.length
          ) {
            return null;
          }

          var startIndex =
            Math.max(
              0,
              GDM_Utils.toInteger(
                queue.cursor,
                0
              )
            );

          /*
           * Recherche depuis le curseur.
           */
          for (
            var i = startIndex;
            i < queue.tasks.length;
            i++
          ) {

            if (
              queue.tasks[i].status ===
              GDM_QUEUE_STATUS.PENDING
            ) {

              queue.cursor = i;

              queue.updatedAt =
                GDM_Utils.nowIso();

              GDM_Queue.writeQueueUnlocked_(
                jobId,
                queue
              );

              return GDM_Queue.clone_(
                queue.tasks[i]
              );
            }
          }

          /*
           * Sécurité : si le curseur a sauté une ancienne tâche pending.
           */
          for (
            var j = 0;
            j < startIndex;
            j++
          ) {

            if (
              queue.tasks[j].status ===
              GDM_QUEUE_STATUS.PENDING
            ) {

              queue.cursor = j;

              queue.updatedAt =
                GDM_Utils.nowIso();

              GDM_Queue.writeQueueUnlocked_(
                jobId,
                queue
              );

              return GDM_Queue.clone_(
                queue.tasks[j]
              );
            }
          }

          return null;
        },
        GDM_Config.get(
          'LOCK.STATE_LOCK_TIMEOUT_MS',
          5000
        )
      );

    return result;
  },


  /************************************************************************************************
   * CLAIM D'UNE TÂCHE
   *
   * Passe une tâche PENDING → RUNNING.
   ************************************************************************************************/

  claimNext: function(jobId) {

    jobId = GDM_Utils.requireString(
      jobId,
      'jobId'
    );

    return GDM_Utils.withScriptLock(
      function() {

        var queue =
          GDM_Queue.readQueue_(
            jobId
          );

        if (
          !queue ||
          !Array.isArray(
            queue.tasks
          )
        ) {
          return null;
        }

        var start =
          Math.max(
            0,
            Number(
              queue.cursor || 0
            )
          );

        var index = -1;

        for (
          var i = start;
          i < queue.tasks.length;
          i++
        ) {
          if (
            queue.tasks[i].status ===
            GDM_QUEUE_STATUS.PENDING
          ) {
            index = i;
            break;
          }
        }

        if (index === -1) {

          for (
            var j = 0;
            j < start;
            j++
          ) {
            if (
              queue.tasks[j].status ===
              GDM_QUEUE_STATUS.PENDING
            ) {
              index = j;
              break;
            }
          }
        }

        if (index === -1) {
          return null;
        }

        var task =
          queue.tasks[
            index
          ];

        task.status =
          GDM_QUEUE_STATUS.RUNNING;

        task.startedAt =
          GDM_Utils.nowIso();

        task.updatedAt =
          task.startedAt;

        task.attempts =
          Number(
            task.attempts || 0
          ) + 1;

        queue.cursor =
          index;

        queue.updatedAt =
          GDM_Utils.nowIso();

        GDM_Queue.writeQueueUnlocked_(
          jobId,
          queue
        );

        GDM_Queue.rebuildMetaUnlocked_(
          jobId,
          queue
        );

        return GDM_Queue.clone_(
          task
        );
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  /************************************************************************************************
   * MISE À JOUR D'UNE TÂCHE
   ************************************************************************************************/

  updateTask: function(
    jobId,
    taskId,
    patch
  ) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    taskId =
      GDM_Utils.requireString(
        taskId,
        'taskId'
      );

    patch = patch || {};

    return GDM_Utils.withScriptLock(
      function() {

        var queue =
          GDM_Queue.readQueue_(
            jobId
          );

        if (!queue) {
          throw new Error(
            'Queue introuvable : ' +
            jobId
          );
        }

        var found = false;
        var updatedTask = null;

        for (
          var i = 0;
          i < queue.tasks.length;
          i++
        ) {

          if (
            queue.tasks[i].taskId !==
            taskId
          ) {
            continue;
          }

          found = true;

          var task =
            queue.tasks[i];

          var keys =
            Object.keys(
              patch
            );

          for (
            var k = 0;
            k < keys.length;
            k++
          ) {

            var key =
              keys[k];

            if (
              key === 'taskId' ||
              key === 'jobId' ||
              key === 'createdAt'
            ) {
              continue;
            }

            if (
              key === 'status'
            ) {

              var status =
                GDM_Utils.trim(
                  patch[key]
                ).toUpperCase();

              if (
                !GDM_Queue.isValidStatus_(
                  status
                )
              ) {
                throw new Error(
                  'Statut de tâche invalide : ' +
                  status
                );
              }

              task.status =
                status;

            } else {

              task[key] =
                GDM_Queue.makeSerializable_(
                  patch[key]
                );
            }
          }

          task.updatedAt =
            GDM_Utils.nowIso();

          updatedTask =
            GDM_Queue.clone_(
              task
            );

          break;
        }

        if (!found) {
          throw new Error(
            'Tâche introuvable : ' +
            taskId
          );
        }

        queue.updatedAt =
          GDM_Utils.nowIso();

        GDM_Queue.advanceCursor_(
          queue
        );

        GDM_Queue.writeQueueUnlocked_(
          jobId,
          queue
        );

        GDM_Queue.rebuildMetaUnlocked_(
          jobId,
          queue
        );

        return updatedTask;
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  /************************************************************************************************
   * TÂCHE TERMINÉE
   ************************************************************************************************/

  completeTask: function(
    jobId,
    taskId,
    result
  ) {

    return this.updateTask(
      jobId,
      taskId,
      {
        status:
          GDM_QUEUE_STATUS.COMPLETED,

        result:
          typeof result ===
            'undefined'
            ? null
            : result,

        finishedAt:
          GDM_Utils.nowIso(),

        lastError:
          null
      }
    );
  },


  skipTask: function(
    jobId,
    taskId,
    reason
  ) {

    return this.updateTask(
      jobId,
      taskId,
      {
        status:
          GDM_QUEUE_STATUS.SKIPPED,

        message:
          GDM_Utils.toString(
            reason,
            'Tâche ignorée.'
          ),

        finishedAt:
          GDM_Utils.nowIso()
      }
    );
  },


  cancelTask: function(
    jobId,
    taskId,
    reason
  ) {

    return this.updateTask(
      jobId,
      taskId,
      {
        status:
          GDM_QUEUE_STATUS.CANCELLED,

        message:
          GDM_Utils.toString(
            reason,
            'Tâche annulée.'
          ),

        finishedAt:
          GDM_Utils.nowIso()
      }
    );
  },


  /************************************************************************************************
   * ERREUR / RETRY
   ************************************************************************************************/

  failTask: function(
    jobId,
    taskId,
    error
  ) {

    var task =
      this.getTask(
        jobId,
        taskId
      );

    if (!task) {
      throw new Error(
        'Tâche introuvable : ' +
        taskId
      );
    }

    var maxRetries =
      GDM_Config.get(
        'QUEUE.MAX_RETRIES',
        3
      );

    var attempts =
      Number(
        task.attempts || 0
      );

    var errorObject =
      GDM_Utils.errorToObject(
        error,
        {
          jobId: jobId,
          taskId: taskId,
          module: task.module,
          action: task.action,
          itemId: task.itemId,
          itemName: task.itemName
        }
      );

    /*
     * Une première tentative est déjà comptée.
     * Si attempts <= maxRetries, on peut remettre en PENDING.
     */
    if (
      attempts <=
      Number(maxRetries)
    ) {

      return this.updateTask(
        jobId,
        taskId,
        {
          status:
            GDM_QUEUE_STATUS.PENDING,

          lastError:
            errorObject,

          message:
            'Nouvelle tentative planifiée.',

          startedAt:
            '',

          finishedAt:
            ''
        }
      );
    }

    return this.updateTask(
      jobId,
      taskId,
      {
        status:
          GDM_QUEUE_STATUS.ERROR,

        lastError:
          errorObject,

        message:
          GDM_Utils.getErrorMessage(
            error
          ),

        finishedAt:
          GDM_Utils.nowIso()
      }
    );
  },


  /************************************************************************************************
   * REMISE EN ATTENTE DES TÂCHES BLOQUÉES
   ************************************************************************************************/

  resetRunningTasks: function(jobId) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    return GDM_Utils.withScriptLock(
      function() {

        var queue =
          GDM_Queue.readQueue_(
            jobId
          );

        if (!queue) {
          return 0;
        }

        var count = 0;

        for (
          var i = 0;
          i < queue.tasks.length;
          i++
        ) {

          var task =
            queue.tasks[i];

          if (
            task.status !==
            GDM_QUEUE_STATUS.RUNNING
          ) {
            continue;
          }

          task.status =
            GDM_QUEUE_STATUS.PENDING;

          task.updatedAt =
            GDM_Utils.nowIso();

          task.startedAt = '';

          count++;
        }

        if (
          count > 0
        ) {

          queue.updatedAt =
            GDM_Utils.nowIso();

          GDM_Queue.advanceCursor_(
            queue
          );

          GDM_Queue.writeQueueUnlocked_(
            jobId,
            queue
          );

          GDM_Queue.rebuildMetaUnlocked_(
            jobId,
            queue
          );
        }

        return count;
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  /************************************************************************************************
   * ANNULATION GLOBALE
   ************************************************************************************************/

  cancelPending: function(
    jobId,
    reason
  ) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    return GDM_Utils.withScriptLock(
      function() {

        var queue =
          GDM_Queue.readQueue_(
            jobId
          );

        if (!queue) {
          return 0;
        }

        var count = 0;

        var now =
          GDM_Utils.nowIso();

        for (
          var i = 0;
          i < queue.tasks.length;
          i++
        ) {

          var task =
            queue.tasks[i];

          if (
            task.status !==
              GDM_QUEUE_STATUS.PENDING &&
            task.status !==
              GDM_QUEUE_STATUS.RUNNING
          ) {
            continue;
          }

          task.status =
            GDM_QUEUE_STATUS.CANCELLED;

          task.message =
            GDM_Utils.toString(
              reason,
              'Job annulé.'
            );

          task.finishedAt =
            now;

          task.updatedAt =
            now;

          count++;
        }

        queue.updatedAt =
          now;

        GDM_Queue.writeQueueUnlocked_(
          jobId,
          queue
        );

        GDM_Queue.rebuildMetaUnlocked_(
          jobId,
          queue
        );

        return count;
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  /************************************************************************************************
   * STATISTIQUES
   ************************************************************************************************/

  getMeta: function(jobId) {

    jobId =
      GDM_Utils.trim(
        jobId
      );

    if (!jobId) {
      return null;
    }

    var meta =
      this.readMeta_(
        jobId
      );

    if (meta) {
      return this.clone_(
        meta
      );
    }

    var queue =
      this.readQueue_(
        jobId
      );

    if (!queue) {
      return null;
    }

    return this.rebuildMeta_(
      jobId,
      queue
    );
  },


  count: function(
    jobId,
    status
  ) {

    var meta =
      this.getMeta(
        jobId
      );

    if (!meta) {
      return 0;
    }

    if (!status) {
      return Number(
        meta.total || 0
      );
    }

    status =
      GDM_Utils.trim(
        status
      ).toUpperCase();

    switch (status) {

      case GDM_QUEUE_STATUS.PENDING:
        return Number(
          meta.pending || 0
        );

      case GDM_QUEUE_STATUS.RUNNING:
        return Number(
          meta.running || 0
        );

      case GDM_QUEUE_STATUS.COMPLETED:
        return Number(
          meta.completed || 0
        );

      case GDM_QUEUE_STATUS.SKIPPED:
        return Number(
          meta.skipped || 0
        );

      case GDM_QUEUE_STATUS.ERROR:
        return Number(
          meta.errors || 0
        );

      case GDM_QUEUE_STATUS.CANCELLED:
        return Number(
          meta.cancelled || 0
        );

      default:
        return 0;
    }
  },


  hasPending: function(jobId) {

    var meta =
      this.getMeta(
        jobId
      );

    return Boolean(
      meta &&
      Number(
        meta.pending || 0
      ) > 0
    );
  },


  hasRunning: function(jobId) {

    var meta =
      this.getMeta(
        jobId
      );

    return Boolean(
      meta &&
      Number(
        meta.running || 0
      ) > 0
    );
  },


  isDone: function(jobId) {

    var meta =
      this.getMeta(
        jobId
      );

    if (!meta) {
      return true;
    }

    return (
      Number(
        meta.pending || 0
      ) === 0 &&
      Number(
        meta.running || 0
      ) === 0
    );
  },


  /************************************************************************************************
   * NETTOYAGE DES TÂCHES TERMINÉES
   ************************************************************************************************/

  compact: function(jobId) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    return GDM_Utils.withScriptLock(
      function() {

        var queue =
          GDM_Queue.readQueue_(
            jobId
          );

        if (!queue) {
          return {
            removed: 0,
            remaining: 0
          };
        }

        var keepCompleted =
          GDM_Config.get(
            'QUEUE.KEEP_COMPLETED_TASKS',
            false
          );

        var keepErrors =
          GDM_Config.get(
            'QUEUE.KEEP_ERROR_TASKS',
            true
          );

        var before =
          queue.tasks.length;

        var remaining = [];

        for (
          var i = 0;
          i < queue.tasks.length;
          i++
        ) {

          var task =
            queue.tasks[i];

          if (
            task.status ===
              GDM_QUEUE_STATUS.COMPLETED &&
            !keepCompleted
          ) {
            continue;
          }

          if (
            task.status ===
              GDM_QUEUE_STATUS.SKIPPED &&
            !keepCompleted
          ) {
            continue;
          }

          if (
            task.status ===
              GDM_QUEUE_STATUS.CANCELLED &&
            !keepCompleted
          ) {
            continue;
          }

          if (
            task.status ===
              GDM_QUEUE_STATUS.ERROR &&
            !keepErrors
          ) {
            continue;
          }

          remaining.push(
            task
          );
        }

        queue.tasks =
          remaining;

        queue.cursor = 0;

        GDM_Queue.advanceCursor_(
          queue
        );

        queue.updatedAt =
          GDM_Utils.nowIso();

        GDM_Queue.writeQueueUnlocked_(
          jobId,
          queue
        );

        GDM_Queue.rebuildMetaUnlocked_(
          jobId,
          queue
        );

        return {
          removed:
            before -
            remaining.length,

          remaining:
            remaining.length
        };
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  /************************************************************************************************
   * SUPPRESSION TECHNIQUE
   *
   * Ne supprime aucun fichier Drive.
   ************************************************************************************************/

  delete: function(jobId) {

    jobId =
      GDM_Utils.trim(
        jobId
      );

    if (!jobId) {
      return false;
    }

    this.deleteChunked_(
      GDM_Config.queueKey(
        jobId
      )
    );

    this.deleteChunked_(
      GDM_Config.queueMetaKey(
        jobId
      )
    );

    return true;
  },


  /************************************************************************************************
   * NORMALISATION D'UNE TÂCHE
   ************************************************************************************************/

  normalizeTask_: function(
    jobId,
    task
  ) {

    task = task || {};

    var moduleName =
      GDM_Utils.trim(
        task.module
      );

    var action =
      GDM_Utils.trim(
        task.action
      );

    if (!moduleName) {
      var state =
        GDM_State.get(
          jobId
        );

      if (state) {
        moduleName =
          state.module;
      }
    }

    if (!action) {
      var state2 =
        GDM_State.get(
          jobId
        );

      if (state2) {
        action =
          state2.action;
      }
    }

    if (!moduleName) {
      throw new Error(
        'Module obligatoire pour une tâche.'
      );
    }

    if (
      !GDM_Config.isValidModule(
        moduleName
      )
    ) {
      throw new Error(
        'Module invalide : ' +
        moduleName
      );
    }

    if (!action) {
      throw new Error(
        'Action obligatoire pour une tâche.'
      );
    }

    var now =
      GDM_Utils.nowIso();

    return {

      taskId:
        GDM_Utils.trim(
          task.taskId
        ) ||
        GDM_Utils.generateTaskId(),

      jobId:
        jobId,

      module:
        moduleName,

      action:
        action,

      status:
        GDM_QUEUE_STATUS.PENDING,

      priority:
        Math.max(
          0,
          GDM_Utils.toInteger(
            task.priority,
            0
          )
        ),

      itemId:
        GDM_Utils.toString(
          task.itemId ||
          task.fileId ||
          task.folderId ||
          ''
        ),

      itemName:
        GDM_Utils.toString(
          task.itemName ||
          task.name ||
          ''
        ),

      payload:
        this.makeSerializable_(
          task.payload ||
          {}
        ),

      attempts: 0,

      maxRetries:
        Math.max(
          0,
          GDM_Utils.toInteger(
            task.maxRetries,
            GDM_Config.get(
              'QUEUE.MAX_RETRIES',
              3
            )
          )
        ),

      result: null,

      lastError: null,

      message: '',

      createdAt:
        now,

      startedAt: '',

      finishedAt: '',

      updatedAt:
        now
    };
  },


  /************************************************************************************************
   * META
   ************************************************************************************************/

  rebuildMeta_: function(
    jobId,
    queue
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        return GDM_Queue.rebuildMetaUnlocked_(
          jobId,
          queue
        );
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  rebuildMetaUnlocked_: function(
    jobId,
    queue
  ) {

    queue =
      queue ||
      this.readQueue_(
        jobId
      );

    if (!queue) {
      return null;
    }

    var meta = {

      jobId:
        jobId,

      createdAt:
        queue.createdAt || '',

      updatedAt:
        GDM_Utils.nowIso(),

      total:
        queue.tasks.length,

      pending: 0,

      running: 0,

      completed: 0,

      skipped: 0,

      errors: 0,

      cancelled: 0,

      cursor:
        Number(
          queue.cursor || 0
        ),

      done: false
    };

    for (
      var i = 0;
      i < queue.tasks.length;
      i++
    ) {

      switch (
        queue.tasks[i].status
      ) {

        case GDM_QUEUE_STATUS.PENDING:
          meta.pending++;
          break;

        case GDM_QUEUE_STATUS.RUNNING:
          meta.running++;
          break;

        case GDM_QUEUE_STATUS.COMPLETED:
          meta.completed++;
          break;

        case GDM_QUEUE_STATUS.SKIPPED:
          meta.skipped++;
          break;

        case GDM_QUEUE_STATUS.ERROR:
          meta.errors++;
          break;

        case GDM_QUEUE_STATUS.CANCELLED:
          meta.cancelled++;
          break;
      }
    }

    meta.done =
      meta.pending === 0 &&
      meta.running === 0;

    this.writeMetaUnlocked_(
      jobId,
      meta
    );

    return this.clone_(
      meta
    );
  },


  /************************************************************************************************
   * CURSEUR
   ************************************************************************************************/

  advanceCursor_: function(queue) {

    if (
      !queue ||
      !Array.isArray(
        queue.tasks
      )
    ) {
      return;
    }

    var current =
      Math.max(
        0,
        Number(
          queue.cursor || 0
        )
      );

    var found = -1;

    for (
      var i = current;
      i < queue.tasks.length;
      i++
    ) {

      if (
        queue.tasks[i].status ===
        GDM_QUEUE_STATUS.PENDING
      ) {
        found = i;
        break;
      }
    }

    if (found === -1) {

      for (
        var j = 0;
        j < current;
        j++
      ) {

        if (
          queue.tasks[j].status ===
          GDM_QUEUE_STATUS.PENDING
        ) {
          found = j;
          break;
        }
      }
    }

    queue.cursor =
      found === -1
        ? queue.tasks.length
        : found;
  },


  /************************************************************************************************
   * STOCKAGE QUEUE
   ************************************************************************************************/

  readQueue_: function(jobId) {

    return this.readChunked_(
      GDM_Config.queueKey(
        jobId
      )
    );
  },


  writeQueue_: function(
    jobId,
    queue
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        return GDM_Queue.writeQueueUnlocked_(
          jobId,
          queue
        );
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  writeQueueUnlocked_: function(
    jobId,
    queue
  ) {

    return this.writeChunkedUnlocked_(
      GDM_Config.queueKey(
        jobId
      ),
      queue
    );
  },


  /************************************************************************************************
   * STOCKAGE META
   ************************************************************************************************/

  readMeta_: function(jobId) {

    return this.readChunked_(
      GDM_Config.queueMetaKey(
        jobId
      )
    );
  },


  writeMeta_: function(
    jobId,
    meta
  ) {

    return GDM_Utils.withScriptLock(
      function() {

        return GDM_Queue.writeMetaUnlocked_(
          jobId,
          meta
        );
      },
      GDM_Config.get(
        'LOCK.STATE_LOCK_TIMEOUT_MS',
        5000
      )
    );
  },


  writeMetaUnlocked_: function(
    jobId,
    meta
  ) {

    return this.writeChunkedUnlocked_(
      GDM_Config.queueMetaKey(
        jobId
      ),
      meta
    );
  },


  /************************************************************************************************
   * STOCKAGE FRACTIONNÉ
   ************************************************************************************************/

  readChunked_: function(baseKey) {

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

    var chunkCount =
      Math.max(
        0,
        GDM_Utils.toInteger(
          meta.chunkCount,
          0
        )
      );

    if (
      chunkCount <= 0
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


  writeChunkedUnlocked_: function(
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
            'QUEUE.PROPERTY_CHUNK_SIZE',
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

    if (!chunks.length) {
      chunks.push(
        '{}'
      );
    }

    if (
      chunks.length >
      maxChunks
    ) {
      throw new Error(
        'Queue trop volumineuse pour PropertiesService : ' +
        chunks.length +
        ' morceaux.'
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
      old <
        previousCount;
      old++
    ) {

      properties.deleteProperty(
        baseKey +
        '_PART_' +
        old
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

    properties.deleteProperty(
      baseKey
    );

    return true;
  },


  deleteChunked_: function(baseKey) {

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
   * HELPERS
   ************************************************************************************************/

  isValidStatus_: function(status) {

    var values = [
      GDM_QUEUE_STATUS.PENDING,
      GDM_QUEUE_STATUS.RUNNING,
      GDM_QUEUE_STATUS.COMPLETED,
      GDM_QUEUE_STATUS.SKIPPED,
      GDM_QUEUE_STATUS.ERROR,
      GDM_QUEUE_STATUS.CANCELLED
    ];

    return values.indexOf(
      status
    ) !== -1;
  },


  makeSerializable_: function(value) {

    if (
      value === null ||
      typeof value ===
        'undefined'
    ) {
      return value === undefined
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


  clone_: function(value) {

    if (
      value === null ||
      typeof value ===
        'undefined'
    ) {
      return value;
    }

    return JSON.parse(
      JSON.stringify(
        value
      )
    );
  },


  /************************************************************************************************
   * VALIDATION
   ************************************************************************************************/

  validate: function() {

    var errors = [];

    var testJobId =
      'QUEUE_TEST_' +
      Date.now();

    try {

      GDM_State.create({
        jobId:
          testJobId,

        module:
          GDM_MODULES.ANALYSIS,

        action:
          GDM_ACTIONS.ANALYZE_FOLDER,

        setCurrent:
          false
      });

      this.create(
        testJobId
      );

      var task1 =
        this.add(
          testJobId,
          {
            module:
              GDM_MODULES.ANALYSIS,

            action:
              GDM_ACTIONS.ANALYZE_ITEM,

            itemId:
              'TEST_1',

            itemName:
              'Test 1',

            payload: {
              test: true
            }
          }
        );

      var task2 =
        this.add(
          testJobId,
          {
            module:
              GDM_MODULES.ANALYSIS,

            action:
              GDM_ACTIONS.ANALYZE_ITEM,

            itemId:
              'TEST_2',

            itemName:
              'Test 2'
          }
        );

      if (
        !task1 ||
        !task2
      ) {
        errors.push(
          'Ajout des tâches impossible.'
        );
      }

      var meta1 =
        this.getMeta(
          testJobId
        );

      if (
        !meta1 ||
        meta1.total !== 2 ||
        meta1.pending !== 2
      ) {
        errors.push(
          'Statistiques initiales incorrectes.'
        );
      }

      var claimed =
        this.claimNext(
          testJobId
        );

      if (
        !claimed ||
        claimed.status !==
          GDM_QUEUE_STATUS.RUNNING
      ) {
        errors.push(
          'claimNext() ne fonctionne pas.'
        );
      }

      if (claimed) {
        this.completeTask(
          testJobId,
          claimed.taskId,
          {
            ok: true
          }
        );
      }

      var meta2 =
        this.getMeta(
          testJobId
        );

      if (
        !meta2 ||
        meta2.completed !== 1 ||
        meta2.pending !== 1
      ) {
        errors.push(
          'Mise à jour de la queue incorrecte.'
        );
      }

    } catch (error) {

      errors.push(
        'Erreur Queue.gs : ' +
        GDM_Utils.getErrorMessage(
          error
        )
      );

    } finally {

      try {
        this.delete(
          testJobId
        );
      } catch (ignoredQueue) {}

      try {
        GDM_State.delete(
          testJobId,
          {
            deleteResult: true
          }
        );
      } catch (ignoredState) {}

      try {
        GDM_Logger.clear(
          testJobId
        );
      } catch (ignoredLogger) {}
    }

    return {
      ok:
        errors.length === 0,

      file:
        'Core/Queue.gs',

      version:
        GDM_APP.VERSION,

      errors:
        errors
    };
  }

});