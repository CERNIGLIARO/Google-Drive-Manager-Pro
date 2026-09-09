/**************************************************************************************************
 * Google Drive Manager PRO V2
 * Fichier : Maintenance_Reset.gs
 * Version : 1.0.0
 *
 * RESET TECHNIQUE COMPLET
 * -----------------------
 * À utiliser lorsque Google Drive Manager PRO reste bloqué sur un ancien job
 * ou lorsque Google affiche :
 *
 *   "Vous avez dépassé le quota de stockage des propriétés"
 *
 * IMPORTANT :
 * - NE SUPPRIME AUCUN fichier Google Drive.
 * - NE DÉPLACE AUCUN fichier.
 * - NE RENOMME AUCUN fichier.
 * - Supprime uniquement les données techniques GDM stockées dans PropertiesService
 *   et les déclencheurs installables de Google Drive Manager PRO.
 *
 * Cette fonction est volontairement autonome :
 * elle n'appelle PAS GDM_State, GDM_Queue, GDM_Logger ou GDM_Engine.
 * Elle peut donc fonctionner même si leur stockage est saturé.
 **************************************************************************************************/
'use strict';


/**
 * FONCTION À EXÉCUTER UNE SEULE FOIS POUR REPARTIR À ZÉRO.
 */
function GDM_RESET_COMPLET_A_ZERO() {

  var report = {
    ok: true,
    startedAt: new Date().toISOString(),
    triggersDeleted: 0,
    scriptPropertiesDeleted: 0,
    documentPropertiesDeleted: 0,
    userPropertiesDeleted: 0,
    approxCharsFreed: 0,
    warnings: []
  };

  // 1) Supprimer d'abord les déclencheurs automatiques GDM.
  try {
    report.triggersDeleted = GDM_resetDeleteTriggers_();
  } catch (e1) {
    report.warnings.push('Triggers : ' + String(e1));
  }

  // 2) Nettoyer les propriétés techniques GDM dans ScriptProperties.
  try {
    var scriptResult = GDM_resetCleanStore_(
      PropertiesService.getScriptProperties()
    );

    report.scriptPropertiesDeleted = scriptResult.deleted;
    report.approxCharsFreed += scriptResult.charsFreed;
  } catch (e2) {
    report.warnings.push('ScriptProperties : ' + String(e2));
  }

  // 3) Nettoyer DocumentProperties.
  try {
    var docStore = PropertiesService.getDocumentProperties();

    if (docStore) {
      var docResult = GDM_resetCleanStore_(docStore);

      report.documentPropertiesDeleted = docResult.deleted;
      report.approxCharsFreed += docResult.charsFreed;
    }
  } catch (e3) {
    report.warnings.push('DocumentProperties : ' + String(e3));
  }

  // 4) Nettoyer UserProperties.
  try {
    var userStore = PropertiesService.getUserProperties();

    if (userStore) {
      var userResult = GDM_resetCleanStore_(userStore);

      report.userPropertiesDeleted = userResult.deleted;
      report.approxCharsFreed += userResult.charsFreed;
    }
  } catch (e4) {
    report.warnings.push('UserProperties : ' + String(e4));
  }

  // 5) Petite attente puis seconde passe.
  // Cela enlève d'éventuelles propriétés recréées juste après la première passe.
  try {
    Utilities.sleep(1500);
  } catch (ignoredSleep) {}

  try {
    var scriptSecond = GDM_resetCleanStore_(
      PropertiesService.getScriptProperties()
    );

    report.scriptPropertiesDeleted += scriptSecond.deleted;
    report.approxCharsFreed += scriptSecond.charsFreed;
  } catch (e5) {
    report.warnings.push('Deuxième passe ScriptProperties : ' + String(e5));
  }

  try {
    var docStoreSecond = PropertiesService.getDocumentProperties();

    if (docStoreSecond) {
      var docSecond = GDM_resetCleanStore_(docStoreSecond);

      report.documentPropertiesDeleted += docSecond.deleted;
      report.approxCharsFreed += docSecond.charsFreed;
    }
  } catch (e6) {
    report.warnings.push('Deuxième passe DocumentProperties : ' + String(e6));
  }

  try {
    report.triggersDeleted += GDM_resetDeleteTriggers_();
  } catch (e7) {
    report.warnings.push('Deuxième passe triggers : ' + String(e7));
  }

  report.finishedAt = new Date().toISOString();

  report.message =
    'Reset GDM terminé. Aucun fichier Google Drive n’a été supprimé. ' +
    'Rechargez maintenant le Google Sheet avec Ctrl+F5 puis ouvrez Drive Manager PRO.';

  console.log(JSON.stringify(report, null, 2));

  return report;
}


/**
 * Supprime UNIQUEMENT les propriétés techniques Google Drive Manager PRO.
 *
 * Les versions actuelles utilisent le préfixe GDMV2_.
 * Les anciens préfixes GDMV1_ et GDM_ sont également nettoyés.
 */
function GDM_resetCleanStore_(store) {

  if (!store) {
    return {
      deleted: 0,
      charsFreed: 0
    };
  }

  var all = store.getProperties();
  var keys = Object.keys(all);

  var deleted = 0;
  var charsFreed = 0;

  for (var i = 0; i < keys.length; i++) {

    var key = String(keys[i] || '');

    if (!GDM_resetIsGdmKey_(key)) {
      continue;
    }

    var value = all[key];

    charsFreed += key.length;

    if (
      value !== null &&
      typeof value !== 'undefined'
    ) {
      charsFreed += String(value).length;
    }

    try {
      store.deleteProperty(key);
      deleted++;
    } catch (deleteError) {
      console.log(
        'Impossible de supprimer ' +
        key +
        ' : ' +
        String(deleteError)
      );
    }
  }

  return {
    deleted: deleted,
    charsFreed: charsFreed
  };
}


/**
 * Reconnaît les clés appartenant au projet.
 */
function GDM_resetIsGdmKey_(key) {

  key = String(key || '');

  return (
    key.indexOf('GDMV2_') === 0 ||
    key.indexOf('GDMV1_') === 0 ||
    key.indexOf('GDM_') === 0
  );
}


/**
 * Supprime uniquement les déclencheurs installables créés par GDM.
 *
 * Les autres déclencheurs du projet ne sont pas supprimés.
 */
function GDM_resetDeleteTriggers_() {

  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;

  for (var i = 0; i < triggers.length; i++) {

    var trigger = triggers[i];
    var handler = '';

    try {
      handler = String(
        trigger.getHandlerFunction() || ''
      );
    } catch (ignoredHandler) {}

    var isGdmTrigger =
      handler.indexOf('GDM_') === 0 ||
      handler.indexOf('GDM') === 0;

    if (!isGdmTrigger) {
      continue;
    }

    try {
      ScriptApp.deleteTrigger(trigger);
      deleted++;
    } catch (deleteError) {
      console.log(
        'Impossible de supprimer le trigger ' +
        handler +
        ' : ' +
        String(deleteError)
      );
    }
  }

  return deleted;
}


/**
 * DIAGNOSTIC EN LECTURE SEULE.
 *
 * Cette fonction ne modifie rien.
 * Elle permet de vérifier si des données GDM restent après le reset.
 */
function GDM_DIAGNOSTIC_STOCKAGE() {

  var result = {
    script: null,
    document: null,
    user: null,
    triggers: []
  };

  try {
    result.script = GDM_resetStoreStats_(
      PropertiesService.getScriptProperties()
    );
  } catch (e1) {
    result.script = {
      error: String(e1)
    };
  }

  try {
    var docStore = PropertiesService.getDocumentProperties();

    if (docStore) {
      result.document = GDM_resetStoreStats_(docStore);
    }
  } catch (e2) {
    result.document = {
      error: String(e2)
    };
  }

  try {
    var userStore = PropertiesService.getUserProperties();

    if (userStore) {
      result.user = GDM_resetStoreStats_(userStore);
    }
  } catch (e3) {
    result.user = {
      error: String(e3)
    };
  }

  try {
    var triggers = ScriptApp.getProjectTriggers();

    for (var i = 0; i < triggers.length; i++) {
      var handler = '';

      try {
        handler = String(
          triggers[i].getHandlerFunction() || ''
        );
      } catch (ignoredHandler) {}

      result.triggers.push(handler);
    }
  } catch (e4) {
    result.triggersError = String(e4);
  }

  console.log(JSON.stringify(result, null, 2));

  return result;
}


/**
 * Statistiques d'un magasin de propriétés.
 */
function GDM_resetStoreStats_(store) {

  var all = store.getProperties();
  var keys = Object.keys(all);

  var totalKeys = keys.length;
  var gdmKeys = 0;
  var totalChars = 0;
  var gdmChars = 0;
  var remainingGdmKeys = [];

  for (var i = 0; i < keys.length; i++) {

    var key = String(keys[i] || '');
    var value =
      all[key] === null ||
      typeof all[key] === 'undefined'
        ? ''
        : String(all[key]);

    var chars = key.length + value.length;

    totalChars += chars;

    if (GDM_resetIsGdmKey_(key)) {
      gdmKeys++;
      gdmChars += chars;

      if (remainingGdmKeys.length < 50) {
        remainingGdmKeys.push(key);
      }
    }
  }

  return {
    totalKeys: totalKeys,
    totalCharsApprox: totalChars,
    gdmKeys: gdmKeys,
    gdmCharsApprox: gdmChars,
    remainingGdmKeys: remainingGdmKeys
  };
}
