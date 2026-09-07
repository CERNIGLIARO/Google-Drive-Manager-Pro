/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Main.gs
 * Version : 2.0.1
 *
 * Point d'entrée principal de Google Drive Manager PRO V2.
 *
 * Dépendances :
 * - Core/Config.gs
 * - Core/Utils.gs
 * - Core/Logger.gs
 * - Core/State.gs
 * - Core/Queue.gs
 * - Core/Engine.gs
 * - Modules/Explorer.gs
 * - Modules/Analysis.gs
 * - Modules/Move.gs
 * - Modules/Copy.gs
 * - Modules/Duplicates.gs
 * - Modules/Archive.gs
 * - Modules/Rename.gs
 * - Modules/FolderTools.gs
 * - UI/Dashboard.html
 *
 * MODIFICATION :
 * - Dashboard agrandi à 1400 x 850 px.
 **************************************************************************************************/
'use strict';

const GDM_MAIN_HTML_FILE = 'Dashboard';
const GDM_DASHBOARD_WIDTH = 1400;
const GDM_DASHBOARD_HEIGHT = 850;

/**************************************************************************************************
 * MENU GOOGLE SHEETS
 **************************************************************************************************/
function onOpen() {
  try {
    SpreadsheetApp
      .getUi()
      .createMenu('🧰 DRIVE MANAGER PRO')
      .addItem('🏠 Ouvrir Drive Manager PRO', 'GDM_openDashboard')
      .addSeparator()
      .addItem('✅ Autoriser / Tester', 'GDM_authorizeAndTest')
      .addItem('🩺 Diagnostic système', 'GDM_showSystemDiagnostic')
      .addSeparator()
      .addItem('▶ Continuer maintenant', 'GDM_continueCurrentJob')
      .addItem('⏸ Mettre en pause', 'GDM_pauseCurrentJob')
      .addItem('⛔ Annuler le traitement', 'GDM_cancelCurrentJob')
      .addSeparator()
      .addItem('🧹 Nettoyer les données techniques', 'GDM_cleanupTechnicalData')
      .addToUi();
  } catch (error) {
    console.error(error);
  }
}

function onInstall() {
  onOpen();
}

/**************************************************************************************************
 * MAIN
 **************************************************************************************************/
const GDM_Main = Object.freeze({

  getAppInfo: function() {
    return {
      name: GDM_APP.NAME,
      shortName: GDM_APP.SHORT_NAME,
      version: GDM_APP.VERSION,
      buildDate: GDM_APP.BUILD_DATE,
      environment: GDM_APP.ENVIRONMENT,
      timezone: GDM_Config.get('APP.TIMEZONE', 'Europe/Brussels'),
      safeMode: GDM_Config.get('APP.SAFE_MODE', true),
      automaticDelete: GDM_Config.get('APP.ALLOW_AUTOMATIC_DELETE', false)
    };
  },

  initialize: function() {
    var currentJobId = GDM_State.getCurrentJobId();
    var state = null;
    var queue = null;

    if (currentJobId) {
      state = GDM_State.getSummary(currentJobId);

      if (GDM_Queue.exists(currentJobId)) {
        queue = GDM_Queue.getMeta(currentJobId);
      }
    }

    return {
      ok: true,
      app: {
        NAME: GDM_APP.NAME,
        SHORT_NAME: GDM_APP.SHORT_NAME,
        VERSION: GDM_APP.VERSION,
        BUILD_DATE: GDM_APP.BUILD_DATE,
        ENVIRONMENT: GDM_APP.ENVIRONMENT
      },
      config: GDM_Config.getPublicConfig(),
      currentJobId: currentJobId || '',
      state: state,
      queue: queue,
      modules: GDM_Engine.getModuleStatus()
    };
  },

  createJob: function(options) {
    options = options || {};

    var moduleName = this.requireModule_(options.module);
    var action = GDM_Utils.requireString(options.action, 'action');

    var state = GDM_State.create({
      module: moduleName,
      action: action,
      source: options.source || {},
      destination: options.destination || {},
      parameters: options.parameters || {},
      totalKnown: Number(options.totalKnown || 0),
      metadata: options.metadata || {},
      setCurrent: true,
      message: options.message || 'Job créé.'
    });

    GDM_Queue.create(state.jobId);

    try {
      GDM_Logger.jobCreated(state.jobId, {
        module: moduleName,
        action: action,
        message: options.message || 'Job créé.'
      });
    } catch (ignored) {}

    return {
      ok: true,
      jobId: state.jobId,
      state: GDM_State.getSummary(state.jobId),
      queue: GDM_Queue.getMeta(state.jobId)
    };
  },

  addTasks: function(jobId, tasks) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');
    tasks = GDM_Utils.ensureArray(tasks);

    if (!tasks.length) {
      return {
        ok: true,
        jobId: jobId,
        added: 0
      };
    }

    GDM_Queue.ensure(jobId);

    GDM_Queue.addInBatches(
      jobId,
      tasks,
      GDM_Config.get('QUEUE.MAX_ITEMS_PER_BATCH', 250)
    );

    var state = GDM_State.require(jobId);

    GDM_State.setTotalKnown(
      jobId,
      Number(state.totalKnown || 0) + tasks.length
    );

    return {
      ok: true,
      jobId: jobId,
      added: tasks.length,
      queue: GDM_Queue.getMeta(jobId)
    };
  },

  startJob: function(jobId, options) {
    return GDM_Engine.start(jobId, options || {});
  },

  startJobAsync: function(jobId) {
    return GDM_Engine.start(jobId, { async: true });
  },

  continueJob: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message: 'Aucun traitement en cours.'
      };
    }

    return GDM_Engine.runOneBatch(jobId);
  },

  pauseJob: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message: 'Aucun traitement en cours.'
      };
    }

    return {
      ok: true,
      jobId: jobId,
      state: GDM_Engine.pause(jobId)
    };
  },

  resumeJob: function(jobId, asyncMode) {
    jobId = jobId || GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message: 'Aucun traitement en cours.'
      };
    }

    return GDM_Engine.resume(jobId, {
      async: typeof asyncMode === 'undefined'
        ? true
        : GDM_Utils.toBoolean(asyncMode, true)
    });
  },

  cancelJob: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message: 'Aucun traitement en cours.'
      };
    }

    return {
      ok: true,
      jobId: jobId,
      state: GDM_Engine.cancel(jobId)
    };
  },

  getCurrentJob: function() {
    var jobId = GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: true,
        jobId: '',
        state: null,
        queue: null,
        result: null
      };
    }

    var state = GDM_State.getSummary(jobId);
    var queue = null;

    if (GDM_Queue.exists(jobId)) {
      queue = GDM_Queue.getMeta(jobId);
    }

    return {
      ok: true,
      jobId: jobId,
      state: state,
      queue: queue,
      result: GDM_State.getResult(jobId)
    };
  },

  getJobStatus: function(jobId) {
    jobId = jobId || GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: true,
        jobId: '',
        state: null,
        queue: null
      };
    }

    return {
      ok: true,
      jobId: jobId,
      engine: GDM_Engine.getStatus(jobId),
      state: GDM_State.getSummary(jobId),
      queue: GDM_Queue.exists(jobId)
        ? GDM_Queue.getMeta(jobId)
        : null
    };
  },

  getJobResult: function(jobId) {
    jobId = GDM_Utils.requireString(jobId, 'jobId');

    return {
      ok: true,
      jobId: jobId,
      state: GDM_State.getSummary(jobId),
      result: GDM_State.getResult(jobId)
    };
  },

  getJobLogs: function(jobId, options) {
    jobId = jobId || GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: true,
        jobId: '',
        logs: []
      };
    }

    options = options || {};

    var logs = GDM_Logger.getLogs(jobId, options);

    if (
      logs &&
      !Array.isArray(logs) &&
      Array.isArray(logs.logs)
    ) {
      logs = logs.logs;
    }

    if (!Array.isArray(logs)) {
      logs = [];
    }

    var limit = GDM_Utils.toPositiveInteger(
      options.limit,
      GDM_Config.get('UI.LOG_PAGE_SIZE', 100)
    );

    if (logs.length > limit) {
      logs = logs.slice(logs.length - limit);
    }

    return {
      ok: true,
      jobId: jobId,
      count: logs.length,
      logs: logs
    };
  },

  listJobs: function(options) {
    options = options || {};
    var jobs = GDM_State.list(options);

    return {
      ok: true,
      count: jobs ? jobs.length : 0,
      jobs: jobs || []
    };
  },

  recoverJob: function(jobId) {
    return GDM_Engine.recover(jobId);
  },

  getRootFolder: function() {
    return GDM_Explorer.getRoot();
  },

  getFolder: function(folderId) {
    return GDM_Explorer.getFolder(folderId);
  },

  getFolderChildren: function(folderId, options) {
    return GDM_Explorer.getChildren(folderId, options || {});
  },

  startAnalysis: function(options) {
    options = options || {};
    this.requireModule_(GDM_MODULES.ANALYSIS);
    return GDM_Analysis.start(options);
  },

  previewMove: function(options) {
    this.requireModule_(GDM_MODULES.MOVE);
    return GDM_Move.preview(options || {});
  },

  startMove: function(options) {
    this.requireModule_(GDM_MODULES.MOVE);
    return GDM_Move.start(options || {});
  },

  startCopy: function(options) {
    this.requireModule_(GDM_MODULES.COPY);
    return GDM_Copy.start(options || {});
  },

  startDuplicates: function(options) {
    this.requireModule_(GDM_MODULES.DUPLICATES);
    return GDM_Duplicates.start(options || {});
  },

  startArchive: function(options) {
    this.requireModule_(GDM_MODULES.ARCHIVE);
    return GDM_Archive.start(options || {});
  },

  previewRename: function(options) {
    this.requireModule_(GDM_MODULES.RENAME);
    return GDM_Rename.preview(options || {});
  },

  startRename: function(options) {
    this.requireModule_(GDM_MODULES.RENAME);
    return GDM_Rename.start(options || {});
  },

  folderTools: function(action, options) {
    this.requireModule_(GDM_MODULES.FOLDER_TOOLS);
    return GDM_FolderTools.execute(action, options || {});
  },

  authorizeAndTest: function() {
    var tests = [];

    tests.push(
      this.runTest_('Google Drive', function() {
        var root = DriveApp.getRootFolder();
        return Boolean(root && root.getId());
      })
    );

    tests.push(
      this.runTest_('Google Sheets', function() {
        var ss = SpreadsheetApp.getActive();
        return Boolean(ss);
      })
    );

    tests.push(
      this.runTest_('PropertiesService', function() {
        var properties = PropertiesService.getScriptProperties();

        properties.setProperty('GDMV2_AUTH_TEST', 'OK');
        var value = properties.getProperty('GDMV2_AUTH_TEST');
        properties.deleteProperty('GDMV2_AUTH_TEST');

        return value === 'OK';
      })
    );

    tests.push(
      this.runTest_('LockService', function() {
        var lock = LockService.getScriptLock();

        if (!lock.tryLock(2000)) {
          return false;
        }

        lock.releaseLock();
        return true;
      })
    );

    tests.push(
      this.runTest_('Utilities', function() {
        return Boolean(Utilities.getUuid());
      })
    );

    var ok = tests.every(function(test) {
      return test.ok;
    });

    return {
      ok: ok,
      tests: tests,
      message: ok
        ? 'Toutes les autorisations principales sont opérationnelles.'
        : 'Une ou plusieurs autorisations doivent être vérifiées.'
    };
  },

  diagnostic: function() {
    var core = [];
    var modules = [];

    core.push(
      this.safeValidate_('Config.gs', function() {
        return GDM_Config.validate();
      })
    );

    core.push(
      this.safeValidate_('Utils.gs', function() {
        return GDM_Utils.validate();
      })
    );

    core.push(
      this.safeValidate_('Logger.gs', function() {
        return GDM_Logger.validate();
      })
    );

    core.push(
      this.safeValidate_('State.gs', function() {
        return GDM_State.validate();
      })
    );

    core.push(
      this.safeValidate_('Queue.gs', function() {
        return GDM_Queue.validate();
      })
    );

    core.push(
      this.safeValidate_('Engine.gs', function() {
        return GDM_Engine.validate();
      })
    );

    modules.push(
      this.safeValidate_('Explorer.gs', function() {
        return GDM_Explorer.validate();
      })
    );

    modules.push(
      this.safeValidate_('Analysis.gs', function() {
        return GDM_Analysis.validate();
      })
    );

    modules.push(
      this.safeValidate_('Move.gs', function() {
        return GDM_Move.validate();
      })
    );

    modules.push(
      this.safeValidate_('Copy.gs', function() {
        return GDM_Copy.validate();
      })
    );

    modules.push(
      this.safeValidate_('Duplicates.gs', function() {
        return GDM_Duplicates.validate();
      })
    );

    modules.push(
      this.safeValidate_('Archive.gs', function() {
        return GDM_Archive.validate();
      })
    );

    modules.push(
      this.safeValidate_('Rename.gs', function() {
        return GDM_Rename.validate();
      })
    );

    modules.push(
      this.safeValidate_('FolderTools.gs', function() {
        return GDM_FolderTools.validate();
      })
    );

    var all = core.concat(modules);

    var ok = all.every(function(item) {
      return item.ok;
    });

    return {
      ok: ok,
      timestamp: GDM_Utils.nowIso(),
      app: this.getAppInfo(),
      core: core,
      modules: modules,
      engineModules: GDM_Engine.getModuleStatus(),
      currentJob: this.getCurrentJob(),
      message: ok
        ? 'Google Drive Manager PRO est opérationnel.'
        : 'Des erreurs ont été détectées dans le diagnostic.'
    };
  },

  cleanup: function(options) {
    options = options || {};

    var days = GDM_Utils.toPositiveInteger(
      options.completedJobsOlderThanDays,
      GDM_Config.get('STATE.CLEAN_COMPLETED_JOBS_AFTER_DAYS', 30)
    );

    var stateCleanup = GDM_State.cleanupOldJobs(days);
    var removedTriggers = 0;

    try {
      removedTriggers = GDM_Engine.cleanupOwnTriggers_();
    } catch (ignoredTriggerCleanup) {}

    return {
      ok: true,
      completedJobsOlderThanDays: days,
      stateCleanup: stateCleanup,
      removedOrphanTriggers: removedTriggers
    };
  },

  requireModule_: function(moduleName) {
    moduleName = GDM_Utils.requireString(moduleName, 'module');

    if (!GDM_Config.isValidModule(moduleName)) {
      throw new Error('Module invalide : ' + moduleName);
    }

    return moduleName;
  },

  runTest_: function(name, callback) {
    try {
      var value = callback();

      return {
        name: name,
        ok: value !== false,
        message: value === false ? 'Échec.' : 'OK'
      };
    } catch (error) {
      return {
        name: name,
        ok: false,
        message: GDM_Utils.getErrorMessage(error)
      };
    }
  },

  safeValidate_: function(name, callback) {
    try {
      var result = callback();
      result = result || {};

      return {
        name: name,
        ok: result.ok === true,
        details: result,
        message: result.ok === true
          ? 'OK'
          : (
              Array.isArray(result.errors) && result.errors.length
                ? result.errors.join(' | ')
                : 'Erreur'
            )
      };
    } catch (error) {
      return {
        name: name,
        ok: false,
        details: null,
        message: GDM_Utils.getErrorMessage(error)
      };
    }
  }
});

/**************************************************************************************************
 * OUVRIR DASHBOARD
 **************************************************************************************************/
function GDM_openDashboard() {
  try {
    var html = HtmlService
      .createTemplateFromFile(GDM_MAIN_HTML_FILE)
      .evaluate()
      .setWidth(GDM_DASHBOARD_WIDTH)
      .setHeight(GDM_DASHBOARD_HEIGHT)
      .setTitle(GDM_APP.NAME);

    SpreadsheetApp
      .getUi()
      .showModalDialog(
        html,
        '🧰 ' + GDM_APP.NAME
      );
  } catch (error) {
    SpreadsheetApp
      .getUi()
      .alert(
        'Google Drive Manager PRO',
        'Impossible d’ouvrir le Dashboard.\n\n' +
          GDM_Utils.getErrorMessage(error),
        SpreadsheetApp.getUi().ButtonSet.OK
      );
  }
}

/**************************************************************************************************
 * MENU : AUTORISER
 **************************************************************************************************/
function GDM_authorizeAndTest() {
  var result = GDM_Main.authorizeAndTest();
  var lines = [];

  for (var i = 0; i < result.tests.length; i++) {
    var test = result.tests[i];

    lines.push(
      (test.ok ? '✅ ' : '❌ ') +
      test.name +
      ' : ' +
      test.message
    );
  }

  SpreadsheetApp
    .getUi()
    .alert(
      'Google Drive Manager PRO',
      lines.join('\n'),
      SpreadsheetApp.getUi().ButtonSet.OK
    );

  return result;
}

/**************************************************************************************************
 * MENU : DIAGNOSTIC
 **************************************************************************************************/
function GDM_showSystemDiagnostic() {
  var result = GDM_Main.diagnostic();
  var lines = [];

  lines.push(
    result.ok
      ? '✅ Système opérationnel'
      : '⚠️ Des erreurs ont été détectées'
  );

  lines.push('');

  var all = result.core.concat(result.modules);

  for (var i = 0; i < all.length; i++) {
    lines.push(
      (all[i].ok ? '✅ ' : '❌ ') +
      all[i].name +
      (all[i].message ? ' — ' + all[i].message : '')
    );
  }

  SpreadsheetApp
    .getUi()
    .alert(
      'Diagnostic Drive Manager PRO',
      lines.join('\n'),
      SpreadsheetApp.getUi().ButtonSet.OK
    );

  return result;
}

/**************************************************************************************************
 * MENU : CONTINUER
 **************************************************************************************************/
function GDM_continueCurrentJob() {
  try {
    var result = GDM_Main.continueJob();

    SpreadsheetApp
      .getActive()
      .toast(
        result.message || 'Lot exécuté.',
        'Drive Manager PRO',
        5
      );

    return result;
  } catch (error) {
    SpreadsheetApp
      .getUi()
      .alert(
        'Erreur',
        GDM_Utils.getErrorMessage(error),
        SpreadsheetApp.getUi().ButtonSet.OK
      );
  }
}

/**************************************************************************************************
 * MENU : PAUSE
 **************************************************************************************************/
function GDM_pauseCurrentJob() {
  var result = GDM_Main.pauseJob();

  SpreadsheetApp
    .getActive()
    .toast(
      result.ok ? 'Pause demandée.' : result.message,
      'Drive Manager PRO',
      5
    );

  return result;
}

/**************************************************************************************************
 * MENU : ANNULER
 **************************************************************************************************/
function GDM_cancelCurrentJob() {
  var ui = SpreadsheetApp.getUi();

  var answer = ui.alert(
    'Annuler le traitement',
    'Voulez-vous vraiment annuler le traitement en cours ?\n\n' +
      'Les opérations déjà réalisées ne seront pas annulées.',
    ui.ButtonSet.YES_NO
  );

  if (answer !== ui.Button.YES) {
    return {
      ok: false,
      cancelled: false
    };
  }

  return GDM_Main.cancelJob();
}

/**************************************************************************************************
 * MENU : CLEANUP
 **************************************************************************************************/
function GDM_cleanupTechnicalData() {
  var result = GDM_Main.cleanup();

  SpreadsheetApp
    .getActive()
    .toast(
      'Nettoyage terminé.',
      'Drive Manager PRO',
      5
    );

  return result;
}

/**************************************************************************************************
 * API DASHBOARD
 **************************************************************************************************/
function GDM_apiInitialize() {
  return GDM_Main.initialize();
}

function GDM_apiGetAppInfo() {
  return GDM_Main.getAppInfo();
}

function GDM_apiGetCurrentJob() {
  return GDM_Main.getCurrentJob();
}

function GDM_apiGetJobStatus(jobId) {
  return GDM_Main.getJobStatus(jobId);
}

function GDM_apiGetJobLogs(jobId, options) {
  return GDM_Main.getJobLogs(jobId, options || {});
}

function GDM_apiGetJobResult(jobId) {
  return GDM_Main.getJobResult(jobId);
}

function GDM_apiListJobs(options) {
  return GDM_Main.listJobs(options || {});
}

function GDM_apiRecoverJob(jobId) {
  return GDM_Main.recoverJob(jobId);
}

/**************************************************************************************************
 * API JOB ACTIONS
 **************************************************************************************************/
function GDM_apiContinueJob(jobId) {
  return GDM_Main.continueJob(jobId);
}

function GDM_apiPauseJob(jobId) {
  return GDM_Main.pauseJob(jobId);
}

function GDM_apiResumeJob(jobId, asyncMode) {
  return GDM_Main.resumeJob(jobId, asyncMode);
}

function GDM_apiCancelJob(jobId) {
  return GDM_Main.cancelJob(jobId);
}

/**************************************************************************************************
 * API EXPLORER
 **************************************************************************************************/
function GDM_apiGetRootFolder() {
  return GDM_Main.getRootFolder();
}

function GDM_apiGetFolder(folderId) {
  return GDM_Main.getFolder(folderId);
}

function GDM_apiGetFolderChildren(folderId, options) {
  return GDM_Main.getFolderChildren(folderId, options || {});
}

/**************************************************************************************************
 * API ANALYSIS
 **************************************************************************************************/
function GDM_apiStartAnalysis(options) {
  return GDM_Main.startAnalysis(options || {});
}

/**************************************************************************************************
 * API MOVE
 **************************************************************************************************/
function GDM_apiPreviewMove(options) {
  return GDM_Main.previewMove(options || {});
}

function GDM_apiStartMove(options) {
  return GDM_Main.startMove(options || {});
}

/**************************************************************************************************
 * API COPY
 **************************************************************************************************/
function GDM_apiStartCopy(options) {
  return GDM_Main.startCopy(options || {});
}

/**************************************************************************************************
 * API DUPLICATES
 **************************************************************************************************/
function GDM_apiStartDuplicates(options) {
  return GDM_Main.startDuplicates(options || {});
}

/**************************************************************************************************
 * API ARCHIVE
 **************************************************************************************************/
function GDM_apiStartArchive(options) {
  return GDM_Main.startArchive(options || {});
}

/**************************************************************************************************
 * API RENAME
 **************************************************************************************************/
function GDM_apiPreviewRename(options) {
  return GDM_Main.previewRename(options || {});
}

function GDM_apiStartRename(options) {
  return GDM_Main.startRename(options || {});
}

/**************************************************************************************************
 * API FOLDER TOOLS
 **************************************************************************************************/
function GDM_apiFolderTools(action, options) {
  return GDM_Main.folderTools(action, options || {});
}

/**************************************************************************************************
 * API DIAGNOSTIC
 **************************************************************************************************/
function GDM_apiAuthorizeAndTest() {
  return GDM_Main.authorizeAndTest();
}

function GDM_apiDiagnostic() {
  return GDM_Main.diagnostic();
}

function GDM_apiCleanup(options) {
  return GDM_Main.cleanup(options || {});
}
