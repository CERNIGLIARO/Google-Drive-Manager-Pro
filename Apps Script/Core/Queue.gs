/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Queue.gs
 * STABILISATION 2026-09
 *
 * Objectifs :
 * - respecter maxRetries propre à chaque tâche ;
 * - éviter les retries infinis des tâches RUNNING abandonnées ;
 * - compacter progressivement les tâches terminées ;
 * - conserver des statistiques cumulées après compactage ;
 * - isoler la grosse queue dans DocumentProperties (repli ScriptProperties) ;
 * - rester compatible avec l'API publique existante de GDM_Queue.
 **************************************************************************************************/
'use strict';

const GDM_Queue = Object.freeze({

  COMPACT_THRESHOLD_: 25,
  COMPACT_SIZE_CHARS_: 180000,

  create: function(jobId, options) {
    options = options || {};
    jobId = GDM_Utils.requireString(jobId, 'jobId');
    if (!GDM_State.exists(jobId)) {
      throw new Error('Impossible de créer la queue : job introuvable : ' + jobId);
    }
    if (this.exists(jobId)) {
      if (GDM_Utils.toBoolean(options.replace, false)) {
        this.delete(jobId);
      } else {
        return this.getMeta(jobId);
      }
    }
    var now = GDM_Utils.nowIso();
    var queue = {
      schemaVersion: 2,
      jobId: jobId,
      createdAt: now,
      updatedAt: now,
      cursor: 0,
      history: { completed: 0, skipped: 0, errors: 0, cancelled: 0 },
      tasks: []
    };
    this.writeQueue_(jobId, queue);
    this.rebuildMeta_(jobId, queue);
    try { GDM_Logger.queueCreated(jobId, { message: 'Queue créée.' }); } catch (ignored) {}
    return this.getMeta(jobId);
  },

  exists: function(jobId) {
    jobId = GDM_Utils.trim(jobId);
    if (!jobId) return false;
    return this.chunkExistsInAnyStore_(GDM_Config.queueKey(jobId)) ||
      this.chunkExistsInAnyStore_(GDM_Config.queueMetaKey(jobId));
  },

  ensure: function(jobId) {
    if (!this.exists(jobId)) this.create(jobId);
    return this.getMeta(jobId);
  },

  add: function(jobId, task) {
    var rows = this.addMany(jobId, [task || {}]);
    return rows.length ? rows[0] : null;
  },

  addMany: function(jobId, tasks) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');
    tasks = GDM_Utils.ensureArray(tasks);
    if (!tasks.length) return [];
    this.ensure(jobId);

    var added = GDM_Utils.withScriptLock(function() {
      var queue = GDM_Queue.readQueue_(jobId);
      if (!queue) throw new Error('Queue introuvable : ' + jobId);
      GDM_Queue.ensureQueueShape_(queue);

      var existing = {};
      for (var e = 0; e < queue.tasks.length; e++) {
        if (queue.tasks[e] && queue.tasks[e].taskId) existing[queue.tasks[e].taskId] = true;
      }

      var created = [];
      for (var i = 0; i < tasks.length; i++) {
        var normalized = GDM_Queue.normalizeTask_(jobId, tasks[i]);
        // Les taskId stables de Analysis empêchent les doublons lors d'une reprise.
        if (existing[normalized.taskId]) continue;
        existing[normalized.taskId] = true;
        queue.tasks.push(normalized);
        created.push(GDM_Queue.clone_(normalized));
      }

      if (created.length) {
        queue.updatedAt = GDM_Utils.nowIso();
        GDM_Queue.writeQueueUnlocked_(jobId, queue);
        GDM_Queue.rebuildMetaUnlocked_(jobId, queue);
      }
      return created;
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));

    if (added.length) {
      try {
        GDM_Logger.queueUpdated(jobId, {
          message: added.length + ' tâche(s) ajoutée(s) à la queue.',
          data: { added: added.length }
        });
      } catch (ignored) {}
    }
    return added;
  },

  addInBatches: function(jobId, tasks, batchSize) {
    tasks = GDM_Utils.ensureArray(tasks);
    batchSize = GDM_Utils.toPositiveInteger(
      batchSize,
      GDM_Config.get('QUEUE.MAX_ITEMS_PER_BATCH', 250)
    );
    // Une écriture géante est inutile : on borne les ajouts à 100 par transaction.
    batchSize = Math.min(batchSize, 100);
    var added = [];
    for (var i = 0; i < tasks.length; i += batchSize) {
      var part = this.addMany(jobId, tasks.slice(i, i + batchSize));
      for (var j = 0; j < part.length; j++) added.push(part[j]);
    }
    return added;
  },

  get: function(jobId) {
    var queue = this.readQueue_(jobId);
    return queue ? this.clone_(queue) : null;
  },

  getTasks: function(jobId, options) {
    options = options || {};
    var queue = this.readQueue_(jobId);
    if (!queue || !Array.isArray(queue.tasks)) return [];
    var status = GDM_Utils.trim(options.status).toUpperCase();
    var action = GDM_Utils.trim(options.action);
    var moduleName = GDM_Utils.trim(options.module);
    var rows = queue.tasks.filter(function(task) {
      if (status && task.status !== status) return false;
      if (action && task.action !== action) return false;
      if (moduleName && task.module !== moduleName) return false;
      return true;
    });
    var offset = Math.max(0, GDM_Utils.toInteger(options.offset, 0));
    var limit = GDM_Utils.toPositiveInteger(options.limit, rows.length || 1);
    return this.clone_(rows.slice(offset, offset + limit));
  },

  getTask: function(jobId, taskId) {
    taskId = GDM_Utils.trim(taskId);
    if (!taskId) return null;
    var queue = this.readQueue_(jobId);
    if (!queue || !Array.isArray(queue.tasks)) return null;
    for (var i = 0; i < queue.tasks.length; i++) {
      if (queue.tasks[i].taskId === taskId) return this.clone_(queue.tasks[i]);
    }
    return null;
  },

  getNextPending: function(jobId) {
    var queue = this.readQueue_(jobId);
    if (!queue || !Array.isArray(queue.tasks)) return null;
    var idx = this.findPendingIndex_(queue);
    return idx < 0 ? null : this.clone_(queue.tasks[idx]);
  },

  claimNext: function(jobId) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');
    return GDM_Utils.withScriptLock(function() {
      var queue = GDM_Queue.readQueue_(jobId);
      if (!queue || !Array.isArray(queue.tasks)) return null;
      GDM_Queue.ensureQueueShape_(queue);
      var idx = GDM_Queue.findPendingIndex_(queue);
      if (idx < 0) return null;

      var now = GDM_Utils.nowIso();
      var task = queue.tasks[idx];
      task.status = GDM_QUEUE_STATUS.RUNNING;
      task.attempts = Number(task.attempts || 0) + 1;
      task.startedAt = now;
      task.finishedAt = '';
      task.updatedAt = now;
      task.message = 'Traitement en cours.';
      queue.cursor = idx + 1;
      if (queue.cursor >= queue.tasks.length) queue.cursor = 0;
      queue.updatedAt = now;

      GDM_Queue.writeQueueUnlocked_(jobId, queue);
      GDM_Queue.rebuildMetaUnlocked_(jobId, queue);
      return GDM_Queue.clone_(task);
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  updateTask: function(jobId, taskId, patch) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');
    taskId = GDM_Utils.requireString(taskId, 'taskId');
    patch = patch || {};
    return GDM_Utils.withScriptLock(function() {
      var queue = GDM_Queue.readQueue_(jobId);
      if (!queue || !Array.isArray(queue.tasks)) throw new Error('Queue introuvable : ' + jobId);
      var found = -1;
      for (var i = 0; i < queue.tasks.length; i++) {
        if (queue.tasks[i].taskId === taskId) { found = i; break; }
      }
      if (found < 0) throw new Error('Tâche introuvable : ' + taskId);
      var task = queue.tasks[found];
      var allowed = [
        'status','priority','itemId','itemName','payload','attempts','maxRetries',
        'result','lastError','message','startedAt','finishedAt'
      ];
      for (var a = 0; a < allowed.length; a++) {
        var key = allowed[a];
        if (Object.prototype.hasOwnProperty.call(patch, key)) task[key] = GDM_Queue.makeSerializable_(patch[key]);
      }
      task.updatedAt = GDM_Utils.nowIso();
      queue.updatedAt = task.updatedAt;
      GDM_Queue.advanceCursor_(queue);
      GDM_Queue.writeQueueUnlocked_(jobId, queue);
      GDM_Queue.rebuildMetaUnlocked_(jobId, queue);
      return GDM_Queue.clone_(task);
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  completeTask: function(jobId, taskId, result) {
    return this.updateTask(jobId, taskId, {
      status: GDM_QUEUE_STATUS.COMPLETED,
      result: typeof result === 'undefined' ? null : result,
      message: result && result.message ? result.message : 'Tâche terminée.',
      finishedAt: GDM_Utils.nowIso()
    });
  },

  skipTask: function(jobId, taskId, reason) {
    return this.updateTask(jobId, taskId, {
      status: GDM_QUEUE_STATUS.SKIPPED,
      message: GDM_Utils.toString(reason, 'Tâche ignorée.'),
      finishedAt: GDM_Utils.nowIso()
    });
  },

  cancelTask: function(jobId, taskId, reason) {
    return this.updateTask(jobId, taskId, {
      status: GDM_QUEUE_STATUS.CANCELLED,
      message: GDM_Utils.toString(reason, 'Tâche annulée.'),
      finishedAt: GDM_Utils.nowIso()
    });
  },

  failTask: function(jobId, taskId, error) {
    var task = this.getTask(jobId, taskId);
    if (!task) throw new Error('Tâche introuvable : ' + taskId);
    var maxRetries = Math.max(
      0,
      GDM_Utils.toInteger(task.maxRetries, GDM_Config.get('QUEUE.MAX_RETRIES', 3))
    );
    var attempts = Number(task.attempts || 0);
    var errorObject = GDM_Utils.errorToObject(error, {
      jobId: jobId,
      taskId: taskId,
      module: task.module,
      action: task.action,
      itemId: task.itemId,
      itemName: task.itemName
    });
    if (attempts <= maxRetries) {
      return this.updateTask(jobId, taskId, {
        status: GDM_QUEUE_STATUS.PENDING,
        lastError: errorObject,
        message: 'Nouvelle tentative planifiée.',
        startedAt: '',
        finishedAt: ''
      });
    }
    return this.updateTask(jobId, taskId, {
      status: GDM_QUEUE_STATUS.ERROR,
      lastError: errorObject,
      message: GDM_Utils.getErrorMessage(error),
      finishedAt: GDM_Utils.nowIso()
    });
  },

  resetRunningTasks: function(jobId) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    var recovery = GDM_Utils.withScriptLock(function() {
      var queue = GDM_Queue.readQueue_(jobId);
      if (!queue) return { requeued: 0, abandoned: 0, lastError: null };
      GDM_Queue.ensureQueueShape_(queue);

      var requeued = 0;
      var abandoned = 0;
      var lastError = null;
      var now = GDM_Utils.nowIso();

      for (var i = 0; i < queue.tasks.length; i++) {
        var task = queue.tasks[i];
        if (task.status !== GDM_QUEUE_STATUS.RUNNING) continue;

        var maxRetries = Math.max(
          0,
          GDM_Utils.toInteger(
            task.maxRetries,
            GDM_Config.get('QUEUE.MAX_RETRIES', 3)
          )
        );
        var attempts = Number(task.attempts || 0);

        if (attempts <= maxRetries) {
          task.status = GDM_QUEUE_STATUS.PENDING;
          task.message = 'Tâche récupérée après interruption.';
          task.startedAt = '';
          task.finishedAt = '';
          requeued++;
        } else {
          abandoned++;
          task.status = GDM_QUEUE_STATUS.ERROR;
          task.message = 'Tâche abandonnée après interruptions répétées.';
          task.finishedAt = now;
          task.lastError = {
            name: 'RecoveredTimeoutError',
            message: 'La tâche a été interrompue plusieurs fois avant sa fin.',
            jobId: jobId,
            taskId: task.taskId || '',
            module: task.module || '',
            action: task.action || '',
            itemId: task.itemId || '',
            itemName: task.itemName || '',
            attempts: attempts,
            maxRetries: maxRetries
          };
          lastError = task.lastError;
        }

        task.updatedAt = now;
      }

      if (requeued || abandoned) {
        queue.updatedAt = now;
        GDM_Queue.advanceCursor_(queue);
        GDM_Queue.writeQueueUnlocked_(jobId, queue);
        GDM_Queue.rebuildMetaUnlocked_(jobId, queue);
      }

      return {
        requeued: requeued,
        abandoned: abandoned,
        lastError: lastError
      };
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));

    /*
     * Une tâche abandonnée par timeout est désormais terminale. Il faut donc
     * l'ajouter une seule fois aux compteurs State, hors du verrou Queue.
     */
    if (recovery && recovery.abandoned > 0) {
      try {
        GDM_State.increment(jobId, {
          processed: recovery.abandoned,
          errors: recovery.abandoned
        });

        if (recovery.lastError && typeof GDM_State.update === 'function') {
          GDM_State.update(jobId, {
            lastError: recovery.lastError,
            message: 'Une tâche a été abandonnée après plusieurs interruptions.'
          });
        }
      } catch (ignoredStateRecovery) {}

      try {
        GDM_Logger.warn(
          recovery.abandoned + ' tâche(s) abandonnée(s) après interruptions répétées.',
          { jobId: jobId, data: recovery }
        );
      } catch (ignoredRecoveryLog) {}
    }

    // Compatibilité : l'ancienne API renvoyait le nombre de tâches remises en attente.
    return recovery ? recovery.requeued : 0;
  },

  cancelPending: function(jobId, reason) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');
    return GDM_Utils.withScriptLock(function() {
      var queue = GDM_Queue.readQueue_(jobId);
      if (!queue) return 0;
      var now = GDM_Utils.nowIso();
      var count = 0;
      for (var i = 0; i < queue.tasks.length; i++) {
        var task = queue.tasks[i];
        if (task.status !== GDM_QUEUE_STATUS.PENDING && task.status !== GDM_QUEUE_STATUS.RUNNING) continue;
        task.status = GDM_QUEUE_STATUS.CANCELLED;
        task.message = GDM_Utils.toString(reason, 'Job annulé.');
        task.finishedAt = now;
        task.updatedAt = now;
        count++;
      }
      queue.updatedAt = now;
      GDM_Queue.advanceCursor_(queue);
      GDM_Queue.writeQueueUnlocked_(jobId, queue);
      GDM_Queue.rebuildMetaUnlocked_(jobId, queue);
      return count;
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  getMeta: function(jobId) {
    jobId = GDM_Utils.trim(jobId);
    if (!jobId) return null;
    var meta = this.readMeta_(jobId);
    if (meta) return this.clone_(meta);
    var queue = this.readQueue_(jobId);
    return queue ? this.rebuildMeta_(jobId, queue) : null;
  },

  count: function(jobId, status) {
    var meta = this.getMeta(jobId);
    if (!meta) return 0;
    if (!status) return Number(meta.total || 0);
    status = GDM_Utils.trim(status).toUpperCase();
    if (status === GDM_QUEUE_STATUS.PENDING) return Number(meta.pending || 0);
    if (status === GDM_QUEUE_STATUS.RUNNING) return Number(meta.running || 0);
    if (status === GDM_QUEUE_STATUS.COMPLETED) return Number(meta.completed || 0);
    if (status === GDM_QUEUE_STATUS.SKIPPED) return Number(meta.skipped || 0);
    if (status === GDM_QUEUE_STATUS.ERROR) return Number(meta.errors || 0);
    if (status === GDM_QUEUE_STATUS.CANCELLED) return Number(meta.cancelled || 0);
    return 0;
  },

  hasPending: function(jobId) { var m = this.getMeta(jobId); return !!(m && Number(m.pending || 0) > 0); },
  hasRunning: function(jobId) { var m = this.getMeta(jobId); return !!(m && Number(m.running || 0) > 0); },
  isDone: function(jobId) {
    var m = this.getMeta(jobId);
    return !m || (Number(m.pending || 0) === 0 && Number(m.running || 0) === 0);
  },

  compact: function(jobId) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');
    return GDM_Utils.withScriptLock(function() {
      var queue = GDM_Queue.readQueue_(jobId);
      if (!queue) return { removed: 0, remaining: 0 };
      GDM_Queue.ensureQueueShape_(queue);
      var keepCompleted = GDM_Config.get('QUEUE.KEEP_COMPLETED_TASKS', false) === true;
      var keepErrors = GDM_Config.get('QUEUE.KEEP_ERROR_TASKS', true) === true;
      var remaining = [];
      var removed = 0;
      for (var i = 0; i < queue.tasks.length; i++) {
        var task = queue.tasks[i];
        var remove = false;
        if (task.status === GDM_QUEUE_STATUS.COMPLETED && !keepCompleted) remove = true;
        if (task.status === GDM_QUEUE_STATUS.SKIPPED && !keepCompleted) remove = true;
        if (task.status === GDM_QUEUE_STATUS.CANCELLED && !keepCompleted) remove = true;
        if (task.status === GDM_QUEUE_STATUS.ERROR && !keepErrors) remove = true;
        if (remove) {
          removed++;
          GDM_Queue.incrementHistory_(queue, task.status);
        } else {
          remaining.push(task);
        }
      }
      queue.tasks = remaining;
      queue.cursor = 0;
      GDM_Queue.advanceCursor_(queue);
      queue.updatedAt = GDM_Utils.nowIso();
      GDM_Queue.writeQueueUnlocked_(jobId, queue);
      GDM_Queue.rebuildMetaUnlocked_(jobId, queue);
      return { removed: removed, remaining: remaining.length };
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  compactIfNeeded: function(jobId, threshold) {
    threshold = Math.max(1, GDM_Utils.toInteger(threshold, this.COMPACT_THRESHOLD_));
    var meta = this.getMeta(jobId);
    if (!meta) return { removed: 0, remaining: 0, skipped: true };
    var removable = Number(meta.liveCompleted || 0) + Number(meta.liveSkipped || 0) + Number(meta.liveCancelled || 0);
    if (GDM_Config.get('QUEUE.KEEP_ERROR_TASKS', true) === false) removable += Number(meta.liveErrors || 0);
    var queue = this.readQueue_(jobId);
    var chars = queue ? GDM_Utils.safeJsonStringify(queue, '{}').length : 0;
    if (removable < threshold && chars < this.COMPACT_SIZE_CHARS_) {
      return { removed: 0, remaining: queue && queue.tasks ? queue.tasks.length : 0, skipped: true };
    }
    return this.compact(jobId);
  },

  delete: function(jobId) {
    jobId = GDM_Utils.trim(jobId);
    if (!jobId) return false;
    this.deleteChunkedEverywhere_(GDM_Config.queueKey(jobId));
    this.deleteChunkedEverywhere_(GDM_Config.queueMetaKey(jobId));
    return true;
  },

  normalizeTask_: function(jobId, task) {
    task = task || {};
    var moduleName = GDM_Utils.trim(task.module);
    var action = GDM_Utils.trim(task.action);
    if (!moduleName || !action) {
      var state = GDM_State.get(jobId);
      if (state) {
        if (!moduleName) moduleName = state.module;
        if (!action) action = state.action;
      }
    }
    if (!moduleName) throw new Error('Module obligatoire pour une tâche.');
    if (typeof GDM_Config.isValidModule === 'function' && !GDM_Config.isValidModule(moduleName)) {
      throw new Error('Module invalide : ' + moduleName);
    }
    if (!action) throw new Error('Action obligatoire pour une tâche.');
    var now = GDM_Utils.nowIso();
    return {
      taskId: GDM_Utils.trim(task.taskId) || GDM_Utils.generateTaskId(),
      jobId: jobId,
      module: moduleName,
      action: action,
      status: GDM_QUEUE_STATUS.PENDING,
      priority: Math.max(0, GDM_Utils.toInteger(task.priority, 0)),
      itemId: GDM_Utils.toString(task.itemId || task.fileId || task.folderId || ''),
      itemName: GDM_Utils.toString(task.itemName || task.name || ''),
      payload: this.makeSerializable_(task.payload || {}),
      attempts: 0,
      maxRetries: Math.max(0, GDM_Utils.toInteger(task.maxRetries, GDM_Config.get('QUEUE.MAX_RETRIES', 3))),
      result: null,
      lastError: null,
      message: '',
      createdAt: now,
      startedAt: '',
      finishedAt: '',
      updatedAt: now
    };
  },

  ensureQueueShape_: function(queue) {
    queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
    queue.history = queue.history || { completed: 0, skipped: 0, errors: 0, cancelled: 0 };
    queue.history.completed = Number(queue.history.completed || 0);
    queue.history.skipped = Number(queue.history.skipped || 0);
    queue.history.errors = Number(queue.history.errors || 0);
    queue.history.cancelled = Number(queue.history.cancelled || 0);
    queue.cursor = Math.max(0, Number(queue.cursor || 0));
    return queue;
  },

  incrementHistory_: function(queue, status) {
    this.ensureQueueShape_(queue);
    if (status === GDM_QUEUE_STATUS.COMPLETED) queue.history.completed++;
    else if (status === GDM_QUEUE_STATUS.SKIPPED) queue.history.skipped++;
    else if (status === GDM_QUEUE_STATUS.ERROR) queue.history.errors++;
    else if (status === GDM_QUEUE_STATUS.CANCELLED) queue.history.cancelled++;
  },

  rebuildMeta_: function(jobId, queue) {
    return GDM_Utils.withScriptLock(function() {
      return GDM_Queue.rebuildMetaUnlocked_(jobId, queue);
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  rebuildMetaUnlocked_: function(jobId, queue) {
    queue = queue || this.readQueue_(jobId);
    if (!queue) return null;
    this.ensureQueueShape_(queue);
    var live = { pending: 0, running: 0, completed: 0, skipped: 0, errors: 0, cancelled: 0 };
    for (var i = 0; i < queue.tasks.length; i++) {
      var s = queue.tasks[i].status;
      if (s === GDM_QUEUE_STATUS.PENDING) live.pending++;
      else if (s === GDM_QUEUE_STATUS.RUNNING) live.running++;
      else if (s === GDM_QUEUE_STATUS.COMPLETED) live.completed++;
      else if (s === GDM_QUEUE_STATUS.SKIPPED) live.skipped++;
      else if (s === GDM_QUEUE_STATUS.ERROR) live.errors++;
      else if (s === GDM_QUEUE_STATUS.CANCELLED) live.cancelled++;
    }
    var h = queue.history;
    var meta = {
      jobId: jobId,
      createdAt: queue.createdAt || '',
      updatedAt: queue.updatedAt || GDM_Utils.nowIso(),
      total: live.pending + live.running + live.completed + live.skipped + live.errors + live.cancelled + h.completed + h.skipped + h.errors + h.cancelled,
      pending: live.pending,
      running: live.running,
      completed: live.completed + h.completed,
      skipped: live.skipped + h.skipped,
      errors: live.errors + h.errors,
      cancelled: live.cancelled + h.cancelled,
      liveCompleted: live.completed,
      liveSkipped: live.skipped,
      liveErrors: live.errors,
      liveCancelled: live.cancelled,
      compactedCompleted: h.completed,
      compactedSkipped: h.skipped,
      compactedErrors: h.errors,
      compactedCancelled: h.cancelled,
      cursor: queue.cursor || 0,
      liveTasks: queue.tasks.length,
      done: live.pending === 0 && live.running === 0
    };
    this.writeMetaUnlocked_(jobId, meta);
    return this.clone_(meta);
  },

  findPendingIndex_: function(queue) {
    if (!queue || !Array.isArray(queue.tasks) || !queue.tasks.length) return -1;
    var start = Math.max(0, Math.min(queue.tasks.length, Number(queue.cursor || 0)));
    for (var i = start; i < queue.tasks.length; i++) if (queue.tasks[i].status === GDM_QUEUE_STATUS.PENDING) return i;
    for (var j = 0; j < start; j++) if (queue.tasks[j].status === GDM_QUEUE_STATUS.PENDING) return j;
    return -1;
  },

  advanceCursor_: function(queue) {
    var found = this.findPendingIndex_(queue);
    queue.cursor = found < 0 ? 0 : found;
  },

  readQueue_: function(jobId) {
    var value = this.readChunkedFromPrimary_(GDM_Config.queueKey(jobId));
    if (!value) value = this.readChunkedFromLegacyScript_(GDM_Config.queueKey(jobId));
    if (value) this.ensureQueueShape_(value);
    return value;
  },

  writeQueue_: function(jobId, queue) {
    return GDM_Utils.withScriptLock(function() {
      return GDM_Queue.writeQueueUnlocked_(jobId, queue);
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  writeQueueUnlocked_: function(jobId, queue) {
    return this.writeChunkedUnlocked_(this.getQueueStore_(), GDM_Config.queueKey(jobId), queue);
  },

  readMeta_: function(jobId) {
    var value = this.readChunkedFromPrimary_(GDM_Config.queueMetaKey(jobId));
    if (!value) value = this.readChunkedFromLegacyScript_(GDM_Config.queueMetaKey(jobId));
    return value;
  },

  writeMeta_: function(jobId, meta) {
    return GDM_Utils.withScriptLock(function() {
      return GDM_Queue.writeMetaUnlocked_(jobId, meta);
    }, GDM_Config.get('LOCK.STATE_LOCK_TIMEOUT_MS', 5000));
  },

  writeMetaUnlocked_: function(jobId, meta) {
    return this.writeChunkedUnlocked_(this.getQueueStore_(), GDM_Config.queueMetaKey(jobId), meta);
  },

  getQueueStore_: function() {
    try {
      var doc = PropertiesService.getDocumentProperties();
      if (doc) return doc;
    } catch (ignored) {}
    return PropertiesService.getScriptProperties();
  },

  readChunkedFromPrimary_: function(baseKey) {
    return this.readChunkedFromStore_(this.getQueueStore_(), baseKey);
  },

  readChunkedFromLegacyScript_: function(baseKey) {
    var primary = this.getQueueStore_();
    var script = PropertiesService.getScriptProperties();
    if (primary === script) return null;
    return this.readChunkedFromStore_(script, baseKey);
  },

  readChunkedFromStore_: function(store, baseKey) {
    if (!store) return null;
    var metaRaw = store.getProperty(baseKey + '_META');
    if (!metaRaw) {
      var direct = store.getProperty(baseKey);
      return direct ? GDM_Utils.safeJsonParse(direct, null) : null;
    }
    var meta = GDM_Utils.safeJsonParse(metaRaw, {});
    var count = Math.max(0, GDM_Utils.toInteger(meta.chunkCount, 0));
    if (!count) return null;
    var json = '';
    for (var i = 0; i < count; i++) {
      var part = store.getProperty(baseKey + '_PART_' + i);
      if (part === null) return null;
      json += part;
    }
    return GDM_Utils.safeJsonParse(json, null);
  },

  writeChunkedUnlocked_: function(store, baseKey, value) {
    var json = GDM_Utils.safeJsonStringify(value, '{}');
    var chunkSize = Math.min(8000, Math.max(1000, GDM_Utils.toInteger(GDM_Config.get('STATE.PROPERTY_CHUNK_SIZE', 7000), 7000)));
    var chunks = [];
    for (var i = 0; i < json.length; i += chunkSize) chunks.push(json.substring(i, i + chunkSize));
    if (!chunks.length) chunks.push('{}');
    var maxChunks = Math.max(10, GDM_Utils.toInteger(GDM_Config.get('STATE.MAX_CHUNKS', 100), 100));
    if (chunks.length > maxChunks) {
      throw new Error('Queue trop volumineuse pour PropertiesService (' + chunks.length + ' blocs).');
    }
    var oldMeta = GDM_Utils.safeJsonParse(store.getProperty(baseKey + '_META'), {});
    var oldCount = Math.max(0, GDM_Utils.toInteger(oldMeta.chunkCount, 0));
    for (var c = 0; c < chunks.length; c++) store.setProperty(baseKey + '_PART_' + c, chunks[c]);
    for (var d = chunks.length; d < oldCount; d++) store.deleteProperty(baseKey + '_PART_' + d);
    store.setProperty(baseKey + '_META', JSON.stringify({ chunkCount: chunks.length, length: json.length, updatedAt: GDM_Utils.nowIso() }));
    store.deleteProperty(baseKey);
    return true;
  },

  chunkExistsInAnyStore_: function(baseKey) {
    if (this.chunkExistsInStore_(this.getQueueStore_(), baseKey)) return true;
    var script = PropertiesService.getScriptProperties();
    if (script !== this.getQueueStore_() && this.chunkExistsInStore_(script, baseKey)) return true;
    return false;
  },

  chunkExistsInStore_: function(store, baseKey) {
    return !!(store && (store.getProperty(baseKey + '_META') !== null || store.getProperty(baseKey) !== null));
  },

  deleteChunkedEverywhere_: function(baseKey) {
    var stores = [];
    try { var doc = PropertiesService.getDocumentProperties(); if (doc) stores.push(doc); } catch (ignoredDoc) {}
    try { stores.push(PropertiesService.getScriptProperties()); } catch (ignoredScript) {}
    for (var s = 0; s < stores.length; s++) this.deleteChunkedFromStore_(stores[s], baseKey);
  },

  deleteChunkedFromStore_: function(store, baseKey) {
    if (!store) return false;
    var meta = GDM_Utils.safeJsonParse(store.getProperty(baseKey + '_META'), {});
    var count = Math.max(0, GDM_Utils.toInteger(meta.chunkCount, 0));
    for (var i = 0; i < count; i++) store.deleteProperty(baseKey + '_PART_' + i);
    store.deleteProperty(baseKey + '_META');
    store.deleteProperty(baseKey);
    return true;
  },

  makeSerializable_: function(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (ignored) { return GDM_Utils.safeJsonParse(GDM_Utils.safeJsonStringify(value, '{}'), {}); }
  },

  clone_: function(value) {
    if (value === null || typeof value === 'undefined') return value;
    return JSON.parse(JSON.stringify(value));
  },

  validate: function() {
    var errors = [];
    try {
      if (typeof GDM_State === 'undefined') errors.push('GDM_State indisponible.');
      if (typeof PropertiesService === 'undefined') errors.push('PropertiesService indisponible.');
    } catch (e) { errors.push(GDM_Utils.getErrorMessage(e)); }
    return {
      ok: errors.length === 0,
      file: 'Core/Queue.gs',
      storage: 'DocumentProperties avec repli ScriptProperties',
      perTaskRetries: true,
      progressiveCompaction: true,
      errors: errors
    };
  }
});

/** Diagnostic lecture seule de la queue courante. */
function GDM_queueHealthCheck() {
  var jobId = GDM_State.getCurrentJobId();
  if (!jobId) return { ok: true, message: 'Aucun job courant.' };
  var queue = GDM_Queue.get(jobId);
  var meta = GDM_Queue.getMeta(jobId);
  var running = [];
  if (queue && Array.isArray(queue.tasks)) {
    for (var i = 0; i < queue.tasks.length; i++) {
      if (queue.tasks[i].status === GDM_QUEUE_STATUS.RUNNING) running.push(queue.tasks[i]);
    }
  }
  return {
    ok: true,
    jobId: jobId,
    meta: meta,
    runningTasks: running.slice(0, 10),
    approxQueueChars: queue ? GDM_Utils.safeJsonStringify(queue, '{}').length : 0
  };
}
