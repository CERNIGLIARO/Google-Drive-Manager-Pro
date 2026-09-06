/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Core/Main.gs
 * Version : 2.0.0
 *
 * RÔLE
 * ----
 * Point d'entrée central de Google Drive Manager PRO V2.
 *
 * Ce fichier gère :
 * - initialisation de l'application ;
 * - menu Google Sheets ;
 * - ouverture de l'interface ;
 * - API publique appelée depuis HTML avec google.script.run ;
 * - création des jobs ;
 * - démarrage / pause / reprise / annulation ;
 * - récupération du statut ;
 * - récupération des logs ;
 * - récupération des résultats ;
 * - diagnostic système ;
 * - tests d'autorisation ;
 * - nettoyage technique ;
 * - routage vers les modules métier.
 *
 * DÉPENDANCES
 * -----------
 * Core/Config.gs
 * Core/Utils.gs
 * Core/Logger.gs
 * Core/State.gs
 * Core/Queue.gs
 * Core/Engine.gs
 *
 * MODULES
 * -------
 * Modules/Explorer.gs
 * Modules/Analysis.gs
 * Modules/Move.gs
 * Modules/Copy.gs
 * Modules/Duplicates.gs
 * Modules/Archive.gs
 * Modules/Rename.gs
 * Modules/FolderTools.gs
 *
 * IMPORTANT
 * ---------
 * - Main.gs ne contient pas la logique métier.
 * - Main.gs sert d'interface entre l'UI, le Core et les Modules.
 * - Aucun fichier Google Drive n'est supprimé automatiquement.
 **************************************************************************************************/

'use strict';


/**************************************************************************************************
 * NOM DU FICHIER HTML PRINCIPAL
 *
 * Il pourra être remplacé ultérieurement par le nom définitif du fichier UI sans toucher au reste
 * du Core.
 **************************************************************************************************/

const GDM_MAIN_HTML_FILE = 'Dashboard';


/**************************************************************************************************
 * MENU GOOGLE SHEETS
 **************************************************************************************************/

function onOpen() {

  try {

    SpreadsheetApp
      .getUi()
      .createMenu('🧰 DRIVE MANAGER PRO')
      .addItem(
        '🚀 Ouvrir Google Drive Manager PRO',
        'GDM_openDashboard'
      )
      .addSeparator()
      .addItem(
        '✅ Autoriser / tester',
        'GDM_authorizeAndTest'
      )
      .addItem(
        '🔍 Diagnostic système',
        'GDM_showSystemDiagnostic'
      )
      .addSeparator()
      .addItem(
        '▶ Continuer le job courant',
        'GDM_continueCurrentJob'
      )
      .addItem(
        '⏸ Mettre en pause',
        'GDM_pauseCurrentJob'
      )
      .addItem(
        '⛔ Annuler le job courant',
        'GDM_cancelCurrentJob'
      )
      .addSeparator()
      .addItem(
        '🧹 Nettoyage technique',
        'GDM_cleanupTechnicalData'
      )
      .addToUi();

  } catch (error) {

    try {
      console.error(
        '[GDM PRO] Erreur onOpen : ' +
        GDM_Utils.getErrorMessage(error)
      );
    } catch (ignored) {}
  }
}


/**************************************************************************************************
 * INSTALLATION
 **************************************************************************************************/

function onInstall() {
  onOpen();
}


/**************************************************************************************************
 * API CENTRALE
 **************************************************************************************************/

const GDM_Main = Object.freeze({


  /************************************************************************************************
   * INFORMATIONS APPLICATION
   ************************************************************************************************/

  getAppInfo: function() {

    return {
      ok: true,

      app:
        GDM_Config.getAppInfo(),

      config:
        GDM_Config.getPublicConfig(),

      currentJob:
        GDM_State.getCurrent
          ? GDM_State.getCurrent()
          : null,

      currentJobSummary:
        GDM_State.getCurrentJobId()
          ? GDM_State.getSummary(
              GDM_State.getCurrentJobId()
            )
          : null
    };
  },


  /************************************************************************************************
   * INITIALISATION DE L'INTERFACE
   ************************************************************************************************/

  initialize: function() {

    var currentJobId =
      GDM_State.getCurrentJobId();

    var currentState = null;
    var queue = null;

    if (currentJobId) {

      currentState =
        GDM_State.getSummary(
          currentJobId
        );

      queue =
        GDM_Queue.getMeta(
          currentJobId
        );
    }

    return {
      ok: true,

      app:
        GDM_Config.getAppInfo(),

      config:
        GDM_Config.getPublicConfig(),

      currentJobId:
        currentJobId || '',

      state:
        currentState,

      queue:
        queue,

      modules:
        GDM_Engine.getModuleStatus()
    };
  },


  /************************************************************************************************
   * CRÉATION STANDARD D'UN JOB
   ************************************************************************************************/

  createJob: function(options) {

    options = options || {};

    var moduleName =
      GDM_Utils.requireString(
        options.module,
        'module'
      );

    var action =
      GDM_Utils.requireString(
        options.action,
        'action'
      );

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

    var state =
      GDM_State.create({
        module:
          moduleName,

        action:
          action,

        source:
          options.source || null,

        destination:
          options.destination || null,

        parameters:
          options.parameters || {},

        totalKnown:
          options.totalKnown || 0,

        metadata:
          options.metadata || {},

        setCurrent:
          true,

        message:
          options.message ||
          'Job créé.'
      });

    GDM_Queue.create(
      state.jobId
    );

    return {
      ok: true,

      jobId:
        state.jobId,

      state:
        GDM_State.getSummary(
          state.jobId
        ),

      queue:
        GDM_Queue.getMeta(
          state.jobId
        )
    };
  },


  /************************************************************************************************
   * AJOUT DE TÂCHES
   ************************************************************************************************/

  addTasks: function(
    jobId,
    tasks
  ) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    tasks =
      GDM_Utils.ensureArray(
        tasks
      );

    var added =
      GDM_Queue.addInBatches(
        jobId,
        tasks,
        GDM_Config.get(
          'QUEUE.MAX_ITEMS_PER_BATCH',
          250
        )
      );

    GDM_State.setTotalKnown(
      jobId,
      GDM_Queue.count(
        jobId
      )
    );

    return {
      ok: true,

      jobId:
        jobId,

      added:
        added.length,

      queue:
        GDM_Queue.getMeta(
          jobId
        ),

      state:
        GDM_State.getSummary(
          jobId
        )
    };
  },


  /************************************************************************************************
   * DÉMARRAGE
   ************************************************************************************************/

  startJob: function(
    jobId,
    options
  ) {

    options = options || {};

    return GDM_Engine.start(
      jobId,
      options
    );
  },


  startJobAsync: function(jobId) {

    return GDM_Engine.start(
      jobId,
      {
        async: true
      }
    );
  },


  /************************************************************************************************
   * UN LOT
   ************************************************************************************************/

  continueJob: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message:
          'Aucun job à continuer.'
      };
    }

    return GDM_Engine.runOneBatch(
      jobId
    );
  },


  /************************************************************************************************
   * PAUSE
   ************************************************************************************************/

  pauseJob: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message:
          'Aucun job actif.'
      };
    }

    return {
      ok: true,

      state:
        GDM_Engine.pause(
          jobId
        )
    };
  },


  /************************************************************************************************
   * REPRISE
   ************************************************************************************************/

  resumeJob: function(
    jobId,
    asyncMode
  ) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message:
          'Aucun job à reprendre.'
      };
    }

    return GDM_Engine.resume(
      jobId,
      {
        async:
          GDM_Utils.toBoolean(
            asyncMode,
            false
          )
      }
    );
  },


  /************************************************************************************************
   * ANNULATION
   ************************************************************************************************/

  cancelJob: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    if (!jobId) {
      return {
        ok: false,
        message:
          'Aucun job actif.'
      };
    }

    return {
      ok: true,

      state:
        GDM_Engine.cancel(
          jobId
        )
    };
  },


  /************************************************************************************************
   * STATUT
   ************************************************************************************************/

  getJobStatus: function(jobId) {

    jobId =
      jobId ||
      GDM_State.getCurrentJobId();

    if (!jobId) {

      return {
        ok: true,
        active: false,
        jobId: '',
        state: null,
        queue: null
      };
    }

    var state =
      GDM_State.getSummary(
        jobId
      );

    if (!state) {

      return {
        ok: false,
        active: false,
        jobId:
          jobId,

        message:
          'Job introuvable.'
      };
    }

    return {
      ok: true,

      active:
        state.status ===
          GDM_JOB_STATUS.PENDING ||
        state.status ===
          GDM_JOB_STATUS.RUNNING ||
        state.status ===
          GDM_JOB_STATUS.PAUSED,

      jobId:
        jobId,

      state:
        state,

      queue:
        GDM_Queue.getMeta(
          jobId
        )
    };
  },


  /************************************************************************************************
   * JOB COURANT
   ************************************************************************************************/

  getCurrentJob: function() {

    var jobId =
      GDM_State.getCurrentJobId();

    if (!jobId) {

      return {
        ok: true,
        jobId: '',
        state: null,
        queue: null
      };
    }

    return this.getJobStatus(
      jobId
    );
  },


  /************************************************************************************************
   * RÉSULTATS
   ************************************************************************************************/

  getJobResult: function(jobId) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    return {
      ok: true,

      jobId:
        jobId,

      state:
        GDM_State.getSummary(
          jobId
        ),

      result:
        GDM_State.getResult(
          jobId
        )
    };
  },


  /************************************************************************************************
   * LOGS
   ************************************************************************************************/

  getJobLogs: function(
    jobId,
    options
  ) {

    jobId =
      GDM_Utils.requireString(
        jobId,
        'jobId'
      );

    options =
      options || {};

    return {
      ok: true,

      jobId:
        jobId,

      stats:
        GDM_Logger.getStats(
          jobId
        ),

      logs:
        GDM_Logger.getLogs(
          jobId,
          options
        )
    };
  },


  /************************************************************************************************
   * LISTE DES JOBS
   ************************************************************************************************/

  listJobs: function(options) {

    return {
      ok: true,

      jobs:
        GDM_State.list(
          options || {}
        )
    };
  },


  /************************************************************************************************
   * RÉCUPÉRATION APRÈS INTERRUPTION
   ************************************************************************************************/

  recoverJob: function(jobId) {

    return GDM_Engine.recover(
      jobId
    );
  },


  /************************************************************************************************
   * EXPLORER
   ************************************************************************************************/

  getRootFolder: function() {

    this.requireModule_(
      'GDM_Explorer',
      GDM_MODULES.EXPLORER
    );

    if (
      typeof GDM_Explorer.getRoot !==
      'function'
    ) {
      throw new Error(
        'GDM_Explorer.getRoot() est indisponible.'
      );
    }

    return GDM_Explorer.getRoot();
  },


  getFolder: function(folderId) {

    this.requireModule_(
      'GDM_Explorer',
      GDM_MODULES.EXPLORER
    );

    if (
      typeof GDM_Explorer.getFolder !==
      'function'
    ) {
      throw new Error(
        'GDM_Explorer.getFolder() est indisponible.'
      );
    }

    return GDM_Explorer.getFolder(
      folderId
    );
  },


  getFolderChildren: function(
    folderId,
    options
  ) {

    this.requireModule_(
      'GDM_Explorer',
      GDM_MODULES.EXPLORER
    );

    if (
      typeof GDM_Explorer.getChildren !==
      'function'
    ) {
      throw new Error(
        'GDM_Explorer.getChildren() est indisponible.'
      );
    }

    return GDM_Explorer.getChildren(
      folderId,
      options || {}
    );
  },


  /************************************************************************************************
   * LANCEMENT ANALYSE
   ************************************************************************************************/

  startAnalysis: function(options) {

    this.requireModule_(
      'GDM_Analysis',
      GDM_MODULES.ANALYSIS
    );

    if (
      typeof GDM_Analysis.start !==
      'function'
    ) {
      throw new Error(
        'GDM_Analysis.start() est indisponible.'
      );
    }

    return GDM_Analysis.start(
      options || {}
    );
  },


  /************************************************************************************************
   * LANCEMENT DÉPLACEMENT
   ************************************************************************************************/

  startMove: function(options) {

    this.requireModule_(
      'GDM_Move',
      GDM_MODULES.MOVE
    );

    if (
      typeof GDM_Move.start !==
      'function'
    ) {
      throw new Error(
        'GDM_Move.start() est indisponible.'
      );
    }

    return GDM_Move.start(
      options || {}
    );
  },


  previewMove: function(options) {

    this.requireModule_(
      'GDM_Move',
      GDM_MODULES.MOVE
    );

    if (
      typeof GDM_Move.preview !==
      'function'
    ) {
      throw new Error(
        'GDM_Move.preview() est indisponible.'
      );
    }

    return GDM_Move.preview(
      options || {}
    );
  },


  /************************************************************************************************
   * LANCEMENT COPIE
   ************************************************************************************************/

  startCopy: function(options) {

    this.requireModule_(
      'GDM_Copy',
      GDM_MODULES.COPY
    );

    if (
      typeof GDM_Copy.start !==
      'function'
    ) {
      throw new Error(
        'GDM_Copy.start() est indisponible.'
      );
    }

    return GDM_Copy.start(
      options || {}
    );
  },


  /************************************************************************************************
   * DOUBLONS
   ************************************************************************************************/

  startDuplicates: function(options) {

    this.requireModule_(
      'GDM_Duplicates',
      GDM_MODULES.DUPLICATES
    );

    if (
      typeof GDM_Duplicates.start !==
      'function'
    ) {
      throw new Error(
        'GDM_Duplicates.start() est indisponible.'
      );
    }

    return GDM_Duplicates.start(
      options || {}
    );
  },


  /************************************************************************************************
   * ARCHIVAGE
   ************************************************************************************************/

  startArchive: function(options) {

    this.requireModule_(
      'GDM_Archive',
      GDM_MODULES.ARCHIVE
    );

    if (
      typeof GDM_Archive.start !==
      'function'
    ) {
      throw new Error(
        'GDM_Archive.start() est indisponible.'
      );
    }

    return GDM_Archive.start(
      options || {}
    );
  },


  /************************************************************************************************
   * RENOMMAGE
   ************************************************************************************************/

  previewRename: function(options) {

    this.requireModule_(
      'GDM_Rename',
      GDM_MODULES.RENAME
    );

    if (
      typeof GDM_Rename.preview !==
      'function'
    ) {
      throw new Error(
        'GDM_Rename.preview() est indisponible.'
      );
    }

    return GDM_Rename.preview(
      options || {}
    );
  },


  startRename: function(options) {

    this.requireModule_(
      'GDM_Rename',
      GDM_MODULES.RENAME
    );

    if (
      typeof GDM_Rename.start !==
      'function'
    ) {
      throw new Error(
        'GDM_Rename.start() est indisponible.'
      );
    }

    return GDM_Rename.start(
      options || {}
    );
  },


  /************************************************************************************************
   * OUTILS DOSSIERS
   ************************************************************************************************/

  folderTools: function(
    action,
    options
  ) {

    this.requireModule_(
      'GDM_FolderTools',
      GDM_MODULES.FOLDER_TOOLS
    );

    if (
      typeof GDM_FolderTools.execute !==
      'function'
    ) {
      throw new Error(
        'GDM_FolderTools.execute() est indisponible.'
      );
    }

    return GDM_FolderTools.execute(
      action,
      options || {}
    );
  },


  /************************************************************************************************
   * AUTORISATIONS
   ************************************************************************************************/

  authorizeAndTest: function() {

    var tests = [];

    /*
     * Google Drive
     */
    tests.push(
      this.runTest_(
        'Google Drive',
        function() {
          var root =
            DriveApp.getRootFolder();

          return Boolean(
            root.getId()
          );
        }
      )
    );

    /*
     * Google Sheets
     */
    tests.push(
      this.runTest_(
        'Google Sheets',
        function() {
          var active =
            SpreadsheetApp
              .getActiveSpreadsheet();

          /*
           * Le projet peut éventuellement être autonome.
           * L'accès à SpreadsheetApp reste testé sans obliger
           * l'existence d'une feuille liée.
           */
          return active
            ? Boolean(active.getId())
            : true;
        }
      )
    );

    /*
     * PropertiesService
     */
    tests.push(
      this.runTest_(
        'PropertiesService',
        function() {

          var key =
            'GDMV2_AUTH_TEST';

          var properties =
            PropertiesService
              .getScriptProperties();

          properties.setProperty(
            key,
            'OK'
          );

          var ok =
            properties.getProperty(
              key
            ) === 'OK';

          properties.deleteProperty(
            key
          );

          return ok;
        }
      )
    );

    /*
     * LockService
     */
    tests.push(
      this.runTest_(
        'LockService',
        function() {

          var lock =
            LockService
              .getScriptLock();

          var ok =
            lock.tryLock(
              1000
            );

          if (ok) {
            lock.releaseLock();
          }

          return ok;
        }
      )
    );

    /*
     * Utilities
     */
    tests.push(
      this.runTest_(
        'Utilities',
        function() {
          return Boolean(
            Utilities.getUuid()
          );
        }
      )
    );

    var ok = true;

    for (
      var i = 0;
      i < tests.length;
      i++
    ) {
      if (
        tests[i].ok !== true
      ) {
        ok = false;
        break;
      }
    }

    return {
      ok: ok,

      app:
        GDM_Config.getAppInfo(),

      tests:
        tests
    };
  },


  /************************************************************************************************
   * DIAGNOSTIC COMPLET
   ************************************************************************************************/

  diagnostic: function() {

    var results = [];

    results.push(
      this.safeValidate_(
        'Config',
        function() {
          return GDM_Config.validate();
        }
      )
    );

    results.push(
      this.safeValidate_(
        'Utils',
        function() {
          return GDM_Utils.validate();
        }
      )
    );

    results.push(
      this.safeValidate_(
        'Logger',
        function() {
          return GDM_Logger.validate();
        }
      )
    );

    results.push(
      this.safeValidate_(
        'State',
        function() {
          return GDM_State.validate();
        }
      )
    );

    results.push(
      this.safeValidate_(
        'Queue',
        function() {
          return GDM_Queue.validate();
        }
      )
    );

    results.push(
      this.safeValidate_(
        'Engine',
        function() {
          return GDM_Engine.validate();
        }
      )
    );

    var modules =
      GDM_Engine.getModuleStatus();

    var allCoreOk = true;

    for (
      var i = 0;
      i < results.length;
      i++
    ) {

      if (
        results[i].ok !== true
      ) {
        allCoreOk = false;
      }
    }

    return {
      ok:
        allCoreOk,

      app:
        GDM_Config.getAppInfo(),

      authorization:
        this.authorizeAndTest(),

      core:
        results,

      modules:
        modules,

      currentJob:
        GDM_Engine.getStatus(
          GDM_State.getCurrentJobId()
        ),

      timestamp:
        GDM_Utils.nowIso()
    };
  },


  /************************************************************************************************
   * NETTOYAGE TECHNIQUE
   ************************************************************************************************/

  cleanup: function(options) {

    options =
      options || {};

    var days =
      GDM_Utils.toPositiveInteger(
        options.days,
        GDM_Config.get(
          'STATE.CLEAN_COMPLETED_JOBS_AFTER_DAYS',
          30
        )
      );

    var oldJobs =
      GDM_State.cleanupOldJobs(
        days
      );

    var triggersRemoved = 0;

    if (
      GDM_Utils.toBoolean(
        options.cleanupTriggers,
        true
      )
    ) {
      triggersRemoved =
        GDM_Engine.cleanupOwnTriggers_();
    }

    return {
      ok: true,

      oldJobs:
        oldJobs,

      triggersRemoved:
        triggersRemoved
    };
  },


  /************************************************************************************************
   * MODULE REQUIRE
   ************************************************************************************************/

  requireModule_: function(
    globalName,
    moduleName
  ) {

    var available = false;

    switch (
      globalName
    ) {

      case 'GDM_Explorer':
        available =
          typeof GDM_Explorer !==
          'undefined';
        break;

      case 'GDM_Analysis':
        available =
          typeof GDM_Analysis !==
          'undefined';
        break;

      case 'GDM_Move':
        available =
          typeof GDM_Move !==
          'undefined';
        break;

      case 'GDM_Copy':
        available =
          typeof GDM_Copy !==
          'undefined';
        break;

      case 'GDM_Duplicates':
        available =
          typeof GDM_Duplicates !==
          'undefined';
        break;

      case 'GDM_Archive':
        available =
          typeof GDM_Archive !==
          'undefined';
        break;

      case 'GDM_Rename':
        available =
          typeof GDM_Rename !==
          'undefined';
        break;

      case 'GDM_FolderTools':
        available =
          typeof GDM_FolderTools !==
          'undefined';
        break;
    }

    if (!available) {
      throw new Error(
        'Module ' +
        moduleName +
        ' indisponible.'
      );
    }

    return true;
  },


  /************************************************************************************************
   * HELPERS DE TEST
   ************************************************************************************************/

  runTest_: function(
    name,
    callback
  ) {

    try {

      var result =
        callback();

      return {
        name:
          name,

        ok:
          result === true,

        message:
          result === true
            ? 'OK'
            : 'Échec'
      };

    } catch (error) {

      return {
        name:
          name,

        ok:
          false,

        message:
          GDM_Utils.getErrorMessage(
            error
          )
      };
    }
  },


  safeValidate_: function(
    name,
    callback
  ) {

    try {

      var result =
        callback();

      return {
        name:
          name,

        ok:
          Boolean(
            result &&
            result.ok
          ),

        result:
          result
      };

    } catch (error) {

      return {
        name:
          name,

        ok:
          false,

        error:
          GDM_Utils.getErrorMessage(
            error
          )
      };
    }
  }

});


/**************************************************************************************************
 * OUVERTURE DU DASHBOARD
 **************************************************************************************************/

function GDM_openDashboard() {

  try {

    var html =
      HtmlService
        .createHtmlOutputFromFile(
          GDM_MAIN_HTML_FILE
        )
        .setTitle(
          GDM_APP.NAME
        )
        .setWidth(
          1200
        )
        .setHeight(
          800
        );

    SpreadsheetApp
      .getUi()
      .showModalDialog(
        html,
        'Google Drive Manager PRO V2'
      );

  } catch (error) {

    SpreadsheetApp
      .getUi()
      .alert(
        'Google Drive Manager PRO',
        'Impossible d’ouvrir le Dashboard.\n\n' +
        GDM_Utils.getErrorMessage(
          error
        ),
        SpreadsheetApp
          .getUi()
          .ButtonSet.OK
      );
  }
}


/**************************************************************************************************
 * AUTORISER / TESTER
 **************************************************************************************************/

function GDM_authorizeAndTest() {

  var result =
    GDM_Main.authorizeAndTest();

  var lines = [
    'Google Drive Manager PRO V2',
    '',
    result.ok
      ? '✅ Autorisations OK'
      : '⚠️ Une ou plusieurs autorisations ont échoué.',
    ''
  ];

  for (
    var i = 0;
    i < result.tests.length;
    i++
  ) {

    lines.push(
      (
        result.tests[i].ok
          ? '✅ '
          : '❌ '
      ) +
      result.tests[i].name +
      ' : ' +
      result.tests[i].message
    );
  }

  SpreadsheetApp
    .getUi()
    .alert(
      'Google Drive Manager PRO V2',
      lines.join('\n'),
      SpreadsheetApp
        .getUi()
        .ButtonSet.OK
    );

  return result;
}


/**************************************************************************************************
 * DIAGNOSTIC SYSTÈME
 **************************************************************************************************/

function GDM_showSystemDiagnostic() {

  var result =
    GDM_Main.diagnostic();

  var lines = [
    'Google Drive Manager PRO V2',
    '',
    result.ok
      ? '✅ Core opérationnel'
      : '⚠️ Erreur détectée dans le Core.',
    ''
  ];

  for (
    var i = 0;
    i < result.core.length;
    i++
  ) {

    var component =
      result.core[i];

    lines.push(
      (
        component.ok
          ? '✅ '
          : '❌ '
      ) +
      component.name
    );
  }

  lines.push('');
  lines.push('Modules :');

  var moduleNames =
    Object.keys(
      result.modules
    );

  for (
    var m = 0;
    m < moduleNames.length;
    m++
  ) {

    var moduleName =
      moduleNames[m];

    lines.push(
      (
        result.modules[moduleName]
          ? '✅ '
          : '⏳ '
      ) +
      moduleName
    );
  }

  SpreadsheetApp
    .getUi()
    .alert(
      'Diagnostic Google Drive Manager PRO',
      lines.join('\n'),
      SpreadsheetApp
        .getUi()
        .ButtonSet.OK
    );

  return result;
}


/**************************************************************************************************
 * CONTINUER LE JOB COURANT
 **************************************************************************************************/

function GDM_continueCurrentJob() {

  var jobId =
    GDM_State.getCurrentJobId();

  if (!jobId) {

    SpreadsheetApp
      .getUi()
      .alert(
        'Google Drive Manager PRO',
        'Aucun job actif.',
        SpreadsheetApp
          .getUi()
          .ButtonSet.OK
      );

    return null;
  }

  var result =
    GDM_Main.continueJob(
      jobId
    );

  SpreadsheetApp
    .getActiveSpreadsheet()
    .toast(
      result.completed
        ? 'Traitement terminé.'
        : 'Lot traité.',
      'Google Drive Manager PRO',
      5
    );

  return result;
}


/**************************************************************************************************
 * PAUSE DU JOB COURANT
 **************************************************************************************************/

function GDM_pauseCurrentJob() {

  var jobId =
    GDM_State.getCurrentJobId();

  if (!jobId) {

    SpreadsheetApp
      .getUi()
      .alert(
        'Google Drive Manager PRO',
        'Aucun job actif.',
        SpreadsheetApp
          .getUi()
          .ButtonSet.OK
      );

    return null;
  }

  var result =
    GDM_Main.pauseJob(
      jobId
    );

  SpreadsheetApp
    .getActiveSpreadsheet()
    .toast(
      'Mise en pause demandée.',
      'Google Drive Manager PRO',
      5
    );

  return result;
}


/**************************************************************************************************
 * ANNULATION DU JOB COURANT
 **************************************************************************************************/

function GDM_cancelCurrentJob() {

  var ui =
    SpreadsheetApp.getUi();

  var jobId =
    GDM_State.getCurrentJobId();

  if (!jobId) {

    ui.alert(
      'Google Drive Manager PRO',
      'Aucun job actif.',
      ui.ButtonSet.OK
    );

    return null;
  }

  var answer =
    ui.alert(
      'Annuler le traitement ?',
      'Le traitement en cours sera arrêté.\n\nLes opérations déjà terminées ne seront pas annulées.',
      ui.ButtonSet.YES_NO
    );

  if (
    answer !==
    ui.Button.YES
  ) {
    return {
      ok: false,
      cancelledByUser: true
    };
  }

  var result =
    GDM_Main.cancelJob(
      jobId
    );

  SpreadsheetApp
    .getActiveSpreadsheet()
    .toast(
      'Traitement annulé.',
      'Google Drive Manager PRO',
      5
    );

  return result;
}


/**************************************************************************************************
 * NETTOYAGE TECHNIQUE
 **************************************************************************************************/

function GDM_cleanupTechnicalData() {

  var result =
    GDM_Main.cleanup({
      cleanupTriggers: true
    });

  SpreadsheetApp
    .getUi()
    .alert(
      'Google Drive Manager PRO',
      'Nettoyage terminé.\n\n' +
      'Jobs supprimés : ' +
      result.oldJobs.deletedCount +
      '\n' +
      'Triggers supprimés : ' +
      result.triggersRemoved,
      SpreadsheetApp
        .getUi()
        .ButtonSet.OK
    );

  return result;
}


/**************************************************************************************************
 * API GLOBALE POUR google.script.run
 *
 * Les fonctions suivantes restent globales afin de pouvoir être appelées facilement depuis HTML.
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
  return GDM_Main.getJobStatus(
    jobId
  );
}


function GDM_apiGetJobLogs(
  jobId,
  options
) {
  return GDM_Main.getJobLogs(
    jobId,
    options || {}
  );
}


function GDM_apiGetJobResult(jobId) {
  return GDM_Main.getJobResult(
    jobId
  );
}


function GDM_apiContinueJob(jobId) {
  return GDM_Main.continueJob(
    jobId
  );
}


function GDM_apiPauseJob(jobId) {
  return GDM_Main.pauseJob(
    jobId
  );
}


function GDM_apiResumeJob(
  jobId,
  asyncMode
) {
  return GDM_Main.resumeJob(
    jobId,
    asyncMode
  );
}


function GDM_apiCancelJob(jobId) {
  return GDM_Main.cancelJob(
    jobId
  );
}


function GDM_apiGetRootFolder() {
  return GDM_Main.getRootFolder();
}


function GDM_apiGetFolder(folderId) {
  return GDM_Main.getFolder(
    folderId
  );
}


function GDM_apiGetFolderChildren(
  folderId,
  options
) {
  return GDM_Main.getFolderChildren(
    folderId,
    options || {}
  );
}


function GDM_apiStartAnalysis(options) {
  return GDM_Main.startAnalysis(
    options || {}
  );
}


function GDM_apiPreviewMove(options) {
  return GDM_Main.previewMove(
    options || {}
  );
}


function GDM_apiStartMove(options) {
  return GDM_Main.startMove(
    options || {}
  );
}


function GDM_apiStartCopy(options) {
  return GDM_Main.startCopy(
    options || {}
  );
}


function GDM_apiStartDuplicates(options) {
  return GDM_Main.startDuplicates(
    options || {}
  );
}


function GDM_apiStartArchive(options) {
  return GDM_Main.startArchive(
    options || {}
  );
}


function GDM_apiPreviewRename(options) {
  return GDM_Main.previewRename(
    options || {}
  );
}


function GDM_apiStartRename(options) {
  return GDM_Main.startRename(
    options || {}
  );
}


function GDM_apiFolderTools(
  action,
  options
) {
  return GDM_Main.folderTools(
    action,
    options || {}
  );
}


function GDM_apiDiagnostic() {
  return GDM_Main.diagnostic();
}