/**
 * GOOGLE DRIVE TOOLBOX V9.1 — FIX AUTORISATIONS
 * =====================================
 *
 * Un seul projet Apps Script pour :
 * - analyser un dossier / Mon Drive sans tout charger en mémoire ;
 * - déplacer ou classer des fichiers par type ;
 * - copier un dossier complet en conservant l'arborescence ;
 * - rechercher les doublons POTENTIELS (nom + taille + type) ;
 * - déplacer les doublons trouvés en gardant le plus ancien ;
 * - déplacer un dossier complet vers un autre dossier ;
 * - archiver automatiquement les fichiers anciens ;
 * - renommer des fichiers en masse avec aperçu ;
 * - suivre / arrêter / reprendre les gros travaux.
 *
 * IMPORTANT
 * ---------
 * Cette V9 utilise UNIQUEMENT DriveApp.
 * Le service avancé "Drive API" n'est PAS nécessaire.
 *
 * Les gros travaux sont découpés en lots et repris automatiquement
 * avec les jetons de continuation FileIterator / FolderIterator.
 *
 * Aucun fichier n'est supprimé.
 */

const TBX = {
  PROP_STATE: 'GD_TOOLBOX_V9_STATE',
  PROP_LAST_DUP_REPORT: 'GD_TOOLBOX_V9_LAST_DUP_REPORT',
  TRIGGER_FUNCTION: 'continuerJobToolboxV9',

  QUEUE_PREFIX: '_GD9_Q_',
  DUPDATA_PREFIX: '_GD9_DUPDATA_',

  RUN_MAX_MS: 250000,          // ~4 min 10 s
  TRIGGER_DELAY_MS: 30000,     // ~30 s entre lots
  MAX_FILES_PER_RUN: 1800,
  SAVE_EVERY_FILES: 40,

  PREVIEW_MAX_FILES: 2500,
  PREVIEW_MAX_ROWS: 300,
  PREVIEW_MAX_FOLDERS: 150,

  ANALYSIS_TOP: 200,
  LARGE_FILE_MB: 100,
  OLD_FILE_DAYS: 365,

  DUP_SCAN_BUFFER: 150,
  DUP_GROUP_CHUNK: 500,

  MIME_FOLDER: 'application/vnd.google-apps.folder'
};


/* =====================================================================
 * MENU
 * ===================================================================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧰 GOOGLE DRIVE V9')
    .addItem('🔐 Autoriser / tester V9.1', 'autoriserEtTesterV9')
    .addItem('🧪 Tester les déclencheurs automatiques', 'testerDeclencheursV9')
    .addItem('🧭 Ouvrir le tableau de bord', 'ouvrirTableauDeBordV9')
    .addSeparator()
    .addItem('▶ Continuer maintenant (1 lot)', 'continuerMaintenantV9')
    .addItem('📊 Statut du travail en cours', 'afficherStatutV9')
    .addItem('▶ Reprendre le travail', 'reprendreJobV9')
    .addItem('⛔ Arrêter le travail', 'arreterJobV9')
    .addSeparator()
    .addItem('🧹 Nettoyer les feuilles techniques V9', 'nettoyerTechniqueV9')
    .addToUi();
}


/* =====================================================================
 * AUTORISATIONS
 * ===================================================================== */

function autoriserEtTesterV9() {
  const ui = SpreadsheetApp.getUi();
  const lignes = [];
  let toutOk = true;

  function test_(nom, fn) {
    try {
      fn();
      lignes.push('✅ ' + nom + ' : OK');
    } catch (e) {
      toutOk = false;
      lignes.push('❌ ' + nom + ' : ' + erreurV9_(e));
    }
  }

  /*
   * IMPORTANT :
   * On NE crée PLUS de déclencheur dans cette fonction.
   * C'était inutile pour autoriser le projet et c'était la cause la plus
   * probable de l'erreur serveur générique pendant "Autoriser / tester".
   */
  test_('Google Sheets', function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('Aucun Google Sheets actif.');
    ss.getId();
    ss.getName();
  });

  test_('Google Drive', function() {
    const root = DriveApp.getRootFolder();
    root.getId();
    // Un appel léger supplémentaire pour valider réellement l'accès Drive.
    const folders = root.getFolders();
    if (folders.hasNext()) {
      folders.next().getId();
    }
  });

  test_('PropertiesService', function() {
    const props = PropertiesService.getUserProperties();
    props.setProperty('GD9_TEST', new Date().toISOString());
    props.getProperty('GD9_TEST');
    props.deleteProperty('GD9_TEST');
  });

  test_('LockService', function() {
    const lock = LockService.getUserLock();
    if (lock.tryLock(1000)) {
      lock.releaseLock();
    }
  });

  test_('Utilities', function() {
    Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm:ss'
    );
  });

  const titre = toutOk
    ? 'V9.1 — Autorisations OK'
    : 'V9.1 — Diagnostic des autorisations';

  const suite = toutOk
    ? '\n\nTu peux ouvrir le tableau de bord.'
    : '\n\nUne ligne ❌ indique exactement le service qui bloque.';

  ui.alert(
    titre,
    lignes.join('\n') + suite,
    ui.ButtonSet.OK
  );

  // Très important : ne jamais relancer l'erreur ici.
  // Ainsi Google Sheets n'affiche plus un second message serveur générique.
  return {
    ok: toutOk,
    details: lignes
  };
}


/**
 * Test séparé des déclencheurs automatiques.
 * Il n'est PAS exécuté pendant l'autorisation de base.
 */
function testerDeclencheursV9() {
  const ui = SpreadsheetApp.getUi();

  try {
    supprimerDeclencheursTestV9_();

    const trigger = ScriptApp
      .newTrigger('noopV9_')
      .timeBased()
      .after(60000)
      .create();

    ScriptApp.deleteTrigger(trigger);

    ui.alert(
      'V9.1 — Déclencheurs',
      '✅ Création et suppression d’un déclencheur : OK.\n\n' +
      'Les travaux massifs pourront reprendre automatiquement.',
      ui.ButtonSet.OK
    );

    return { ok: true };

  } catch (e) {
    const message = erreurV9_(e);

    ui.alert(
      'V9.1 — Déclencheurs',
      '❌ Le test des déclencheurs a échoué :\n\n' +
      message +
      '\n\nLe reste de la Toolbox peut fonctionner. ' +
      'Tu peux utiliser "Continuer maintenant (1 lot)" si nécessaire.',
      ui.ButtonSet.OK
    );

    return {
      ok: false,
      error: message
    };
  }
}


function supprimerDeclencheursTestV9_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'noopV9_') {
      ScriptApp.deleteTrigger(t);
    }
  });
}


function continuerMaintenantV9() {
  const ui = SpreadsheetApp.getUi();

  try {
    continuerJobToolboxV9();

    const r = getStatutV9();

    if (!r.exists) {
      ui.alert(
        'V9.1',
        'Aucun travail en cours.',
        ui.ButtonSet.OK
      );
      return;
    }

    ui.alert(
      'V9.1 — Lot terminé',
      'Type : ' + r.type +
      '\nPhase : ' + r.phase +
      '\nFichiers analysés : ' + r.scanned +
      '\nCorrespondants : ' + r.matched +
      '\nDéplacés / copiés : ' + r.acted +
      '\nErreurs : ' + r.errors +
      (r.lastError ? '\n\nDernière erreur : ' + r.lastError : ''),
      ui.ButtonSet.OK
    );

  } catch (e) {
    ui.alert(
      'V9.1 — Erreur',
      erreurV9_(e),
      ui.ButtonSet.OK
    );
  }
}

function noopV9_() {}


/* =====================================================================
 * TABLEAU DE BORD
 * ===================================================================== */

function ouvrirTableauDeBordV9() {
  const html = HtmlService
    .createHtmlOutputFromFile('DriveToolbox')
    .setWidth(960)
    .setHeight(820);

  SpreadsheetApp.getUi().showModalDialog(
    html,
    'Google Drive Toolbox V9 — TOUT EN UN'
  );
}


/* =====================================================================
 * SÉLECTEUR DE DOSSIER
 * ===================================================================== */

function getFolderPickerDataV9(folderId) {
  try {
    const root = DriveApp.getRootFolder();
    const rootId = root.getId();

    let folder;

    if (!folderId || String(folderId) === String(rootId)) {
      folder = root;
      folderId = rootId;
    } else {
      folder = DriveApp.getFolderById(String(folderId));
    }

    let parentId = null;

    if (String(folderId) !== String(rootId)) {
      const parents = folder.getParents();

      if (parents.hasNext()) {
        parentId = parents.next().getId();
      }
    }

    const folders = [];
    const it = folder.getFolders();

    while (it.hasNext()) {
      const f = it.next();

      folders.push({
        id: f.getId(),
        name: f.getName()
      });
    }

    folders.sort(function(a, b) {
      return String(a.name).localeCompare(String(b.name));
    });

    return {
      ok: true,
      id: folderId,
      name:
        String(folderId) === String(rootId)
          ? 'Mon Drive'
          : folder.getName(),
      parentId: parentId,
      rootId: rootId,
      folders: folders
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e),
      id: '',
      name: 'Erreur',
      parentId: null,
      rootId: '',
      folders: []
    };
  }
}


/* =====================================================================
 * APERÇU DES FICHIERS À DÉPLACER
 * ===================================================================== */

function apercuDeplacementV9(options) {
  try {
    const o = normaliserMoveOptionsV9_(options);
    validerMoveOptionsV9_(o);

    const source = dossierV9_(o.sourceId);
    const destination = dossierV9_(o.destinationId);

    const sourceName = nomDossierV9_(source, o.sourceId);
    const destinationName = nomDossierV9_(destination, o.destinationId);

    const sheet = nouvelleFeuilleV9_('APERÇU MOVE V9 ');
    const headers = [
      'Nom',
      'Type',
      'Extension',
      'Dossier actuel',
      'Destination prévue',
      'Lien'
    ];

    sheet.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold')
      .setBackground('#d9ead3');

    const queue = [{
      id: o.sourceId,
      label: sourceName
    }];

    let scanned = 0;
    let matched = 0;
    let folders = 0;
    let row = 2;
    let buffer = [];

    while (
      queue.length &&
      scanned < TBX.PREVIEW_MAX_FILES &&
      folders < TBX.PREVIEW_MAX_FOLDERS
    ) {
      const current = queue.shift();
      folders++;

      let folder;

      try {
        folder = dossierV9_(current.id);
      } catch (_) {
        continue;
      }

      const files = folder.getFiles();

      while (
        files.hasNext() &&
        scanned < TBX.PREVIEW_MAX_FILES
      ) {
        const file = files.next();
        scanned++;

        if (file.getId() === SpreadsheetApp.getActiveSpreadsheet().getId()) {
          continue;
        }

        if (!fichierCorrespondV9_(file, o.types, o.extensionSet)) {
          continue;
        }

        matched++;

        if (
          row - 2 + buffer.length <
          TBX.PREVIEW_MAX_ROWS
        ) {
          const cat = categorieV9_(file);

          buffer.push([
            file.getName(),
            nomCategorieV9_(cat),
            extensionV9_(file.getName()),
            current.label,
            o.action === 'sortByType'
              ? destinationName + ' / ' + nomDossierCategorieV9_(cat)
              : destinationName,
            urlFichierV9_(file)
          ]);
        }

        if (buffer.length >= 100) {
          sheet.getRange(row, 1, buffer.length, headers.length)
            .setValues(buffer);

          row += buffer.length;
          buffer = [];
        }
      }

      if (o.recursive) {
        const subs = folder.getFolders();

        while (
          subs.hasNext() &&
          folders + queue.length <
          TBX.PREVIEW_MAX_FOLDERS
        ) {
          const sub = subs.next();

          if (
            ignorerSousDossierMoveV9_(
              sub.getId(),
              sub.getName(),
              o
            )
          ) {
            continue;
          }

          queue.push({
            id: sub.getId(),
            label: current.label + '/' + sub.getName()
          });
        }
      }
    }

    if (buffer.length) {
      sheet.getRange(row, 1, buffer.length, headers.length)
        .setValues(buffer);
    }

    sheet.insertRowsBefore(1, 5);

    sheet.getRange('A1')
      .setValue('APERÇU V9 — AUCUN FICHIER DÉPLACÉ')
      .setFontSize(16)
      .setFontWeight('bold');

    sheet.getRange('A2').setValue('Source');
    sheet.getRange('B2').setValue(sourceName);

    sheet.getRange('A3').setValue('Destination');
    sheet.getRange('B3').setValue(destinationName);

    sheet.getRange('D2').setValue('Fichiers analysés');
    sheet.getRange('E2').setValue(scanned);

    sheet.getRange('D3').setValue('Correspondants');
    sheet.getRange('E3').setValue(matched);

    formatV9_(sheet);

    return {
      ok: true,
      scanned: scanned,
      matched: matched,
      sheetName: sheet.getName(),
      limited:
        scanned >= TBX.PREVIEW_MAX_FILES ||
        folders >= TBX.PREVIEW_MAX_FOLDERS ||
        matched > TBX.PREVIEW_MAX_ROWS
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };
  }
}


/* =====================================================================
 * DÉMARRAGE DES JOBS
 * ===================================================================== */

/**
 * Analyse complète ciblée.
 */
function demarrerAnalyseV9(options) {
  const o = options || {};

  const sourceId = String(o.sourceId || '');

  if (!sourceId) {
    return {
      ok: false,
      error: 'Choisis un dossier à analyser.'
    };
  }

  return demarrerJobAvecQueueV9_(
    'ANALYZE',
    {
      sourceId: sourceId,
      recursive: o.recursive !== false,
      largeFileMB:
        Number(o.largeFileMB || TBX.LARGE_FILE_MB),
      oldFileDays:
        Number(o.oldFileDays || TBX.OLD_FILE_DAYS)
    }
  );
}


/**
 * Déplacer / classer par type.
 */
function demarrerDeplacementV9(options) {
  try {
    const o = normaliserMoveOptionsV9_(options);
    validerMoveOptionsV9_(o);

    return demarrerJobAvecQueueV9_(
      'MOVE',
      o
    );

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };
  }
}


/**
 * Archiver les fichiers plus anciens que N jours vers un dossier destination.
 * Le traitement reste massif / reprenable et ne supprime rien.
 */
function demarrerArchivageV9(options) {
  try {
    options = options || {};

    const sourceId = String(options.sourceId || '');
    const destinationId = String(options.destinationId || '');
    const olderThanDays = Math.max(1, Number(options.olderThanDays || 365));

    if (!sourceId) throw new Error('Choisis le dossier source à archiver.');
    if (!destinationId) throw new Error('Choisis le dossier destination des archives.');
    if (sourceId === destinationId) throw new Error('La source et la destination doivent être différentes.');

    return demarrerJobAvecQueueV9_(
      'ARCHIVE',
      {
        sourceId: sourceId,
        destinationId: destinationId,
        recursive: options.recursive !== false,
        olderThanDays: olderThanDays
      }
    );

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };
  }
}


/**
 * Renommer des fichiers en masse.
 * Options :
 * - prefix : texte ajouté au début ;
 * - suffix : texte ajouté avant l'extension ;
 * - searchText / replaceText : rechercher/remplacer ;
 * - extensions : filtre facultatif d'extensions.
 */
function demarrerRenommageV9(options) {
  try {
    options = options || {};

    const sourceId = String(options.sourceId || '');
    const prefix = String(options.prefix || '');
    const suffix = String(options.suffix || '');
    const searchText = String(options.searchText || '');
    const replaceText = String(options.replaceText || '');
    const extensions = String(options.extensions || '');

    if (!sourceId) throw new Error('Choisis le dossier source à renommer.');

    if (!prefix && !suffix && !searchText) {
      throw new Error('Indique au moins un préfixe, un suffixe ou un texte à remplacer.');
    }

    return demarrerJobAvecQueueV9_(
      'RENAME',
      {
        sourceId: sourceId,
        recursive: options.recursive !== false,
        prefix: prefix,
        suffix: suffix,
        searchText: searchText,
        replaceText: replaceText,
        extensions: extensions
      }
    );

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };
  }
}


/**
 * Déplacer UN DOSSIER COMPLET vers un autre dossier.
 * C'est une opération de métadonnées : pas besoin de parcourir tous les fichiers.
 */
function deplacerDossierCompletV9(options) {
  try {
    options = options || {};

    const sourceId = String(options.sourceId || '');
    const destinationId = String(options.destinationId || '');

    if (!sourceId) throw new Error('Choisis le dossier à déplacer.');
    if (!destinationId) throw new Error('Choisis le dossier destination.');

    const rootId = DriveApp.getRootFolder().getId();

    if (sourceId === rootId) {
      throw new Error('Mon Drive lui-même ne peut pas être déplacé.');
    }

    if (sourceId === destinationId) {
      throw new Error('Le dossier source et la destination doivent être différents.');
    }

    const source = dossierV9_(sourceId);
    const destination = dossierV9_(destinationId);

    const sourceName = source.getName();
    const destinationName = nomDossierV9_(destination, destinationId);

    source.moveTo(destination);

    return {
      ok: true,
      message:
        'Dossier "' + sourceName + '" déplacé dans "' + destinationName + '".'
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };
  }
}


/**
 * Aperçu de renommage : aucun nom n'est modifié.
 */
function apercuRenommageV9(options) {
  try {
    options = options || {};

    const sourceId = String(options.sourceId || '');
    const prefix = String(options.prefix || '');
    const suffix = String(options.suffix || '');
    const searchText = String(options.searchText || '');
    const replaceText = String(options.replaceText || '');
    const extensionSet = extensionsSetV9_(options.extensions || '');
    const recursive = options.recursive !== false;

    if (!sourceId) throw new Error('Choisis le dossier source.');
    if (!prefix && !suffix && !searchText) {
      throw new Error('Indique au moins un préfixe, un suffixe ou un texte à remplacer.');
    }

    const source = dossierV9_(sourceId);
    const sourceName = nomDossierV9_(source, sourceId);

    const sheet = nouvelleFeuilleV9_('APERÇU RENAME V9 ');
    const headers = ['Ancien nom', 'Nouveau nom', 'Dossier', 'Lien'];

    sheet.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold')
      .setBackground('#d9ead3');

    const queue = [{id: sourceId, path: sourceName}];
    let foldersDone = 0;
    let scanned = 0;
    let matched = 0;
    let row = 2;
    let buffer = [];

    while (
      queue.length &&
      foldersDone < TBX.PREVIEW_MAX_FOLDERS &&
      scanned < TBX.PREVIEW_MAX_FILES
    ) {
      const current = queue.shift();
      foldersDone++;

      let folder;
      try {
        folder = dossierV9_(current.id);
      } catch (_) {
        continue;
      }

      const files = folder.getFiles();

      while (files.hasNext() && scanned < TBX.PREVIEW_MAX_FILES) {
        const file = files.next();
        scanned++;

        const ext = extensionV9_(file.getName());

        if (Object.keys(extensionSet).length && !extensionSet[ext]) {
          continue;
        }

        const newName = calculerNouveauNomV9_(
          file.getName(),
          prefix,
          suffix,
          searchText,
          replaceText
        );

        if (!newName || newName === file.getName()) continue;

        matched++;

        if (row - 2 + buffer.length < TBX.PREVIEW_MAX_ROWS) {
          buffer.push([
            file.getName(),
            newName,
            current.path,
            urlFichierV9_(file)
          ]);
        }

        if (buffer.length >= 100) {
          sheet.getRange(row, 1, buffer.length, headers.length).setValues(buffer);
          row += buffer.length;
          buffer = [];
        }
      }

      if (recursive) {
        const subs = folder.getFolders();

        while (
          subs.hasNext() &&
          foldersDone + queue.length < TBX.PREVIEW_MAX_FOLDERS
        ) {
          const sub = subs.next();

          queue.push({
            id: sub.getId(),
            path: current.path + '/' + sub.getName()
          });
        }
      }
    }

    if (buffer.length) {
      sheet.getRange(row, 1, buffer.length, headers.length).setValues(buffer);
    }

    sheet.insertRowsBefore(1, 4);

    sheet.getRange('A1')
      .setValue('APERÇU RENOMMAGE V9 — AUCUN FICHIER MODIFIÉ')
      .setFontSize(16)
      .setFontWeight('bold');

    sheet.getRange('A2').setValue('Fichiers analysés');
    sheet.getRange('B2').setValue(scanned);
    sheet.getRange('C2').setValue('À renommer');
    sheet.getRange('D2').setValue(matched);

    formatV9_(sheet);

    return {
      ok: true,
      scanned: scanned,
      matched: matched,
      sheetName: sheet.getName(),
      limited:
        scanned >= TBX.PREVIEW_MAX_FILES ||
        foldersDone >= TBX.PREVIEW_MAX_FOLDERS ||
        matched > TBX.PREVIEW_MAX_ROWS
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };
  }
}


/**
 * Copier un dossier complet.
 */
function demarrerCopieV9(options) {
  try {
    const o = normaliserCopyOptionsV9_(options);
    validerCopyOptionsV9_(o);

    return demarrerJobCopieV9_(o);

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };
  }
}


/**
 * Rechercher les doublons POTENTIELS.
 */
function demarrerDoublonsV9(options) {
  const o = options || {};

  const sourceId = String(o.sourceId || '');

  if (!sourceId) {
    return {
      ok: false,
      error: 'Choisis le dossier à analyser pour les doublons.'
    };
  }

  return demarrerJobAvecQueueV9_(
    'DUP_SCAN',
    {
      sourceId: sourceId,
      recursive: o.recursive !== false
    }
  );
}


/**
 * Déplacer les doublons identifiés dans le dernier rapport.
 * Le plus ancien de chaque groupe reste en place.
 */
function demarrerDeplacementDoublonsV9(options) {
  const o = options || {};
  const destinationId = String(o.destinationId || '');

  if (!destinationId) {
    return {
      ok: false,
      error: 'Choisis le dossier destination des doublons.'
    };
  }

  const props = PropertiesService.getUserProperties();
  const reportName = props.getProperty(TBX.PROP_LAST_DUP_REPORT);

  if (!reportName) {
    return {
      ok: false,
      error:
        'Aucun rapport de doublons V9 disponible. Lance d’abord une recherche de doublons.'
    };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = ss.getSheetByName(reportName);

  if (!report) {
    return {
      ok: false,
      error:
        'Le dernier rapport de doublons est introuvable.'
    };
  }

  return demarrerJobMoveDuplicatesV9_(
    reportName,
    destinationId
  );
}


/* =====================================================================
 * CRÉATION GÉNÉRIQUE D'UN JOB AVEC FILE DE DOSSIERS
 * ===================================================================== */

function demarrerJobAvecQueueV9_(type, options) {
  const lock = LockService.getUserLock();
  lock.waitLock(30000);

  try {
    verifierAucunJobActifV9_();

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const source = dossierV9_(options.sourceId);
    const sourceName = nomDossierV9_(
      source,
      options.sourceId
    );

    let destinationName = '';
    let destinationId = '';

    if (type === 'MOVE' || type === 'ARCHIVE') {
      const destination = dossierV9_(
        options.destinationId
      );

      destinationId =
        options.destinationId;

      destinationName =
        nomDossierV9_(
          destination,
          options.destinationId
        );
    }

    const jobId = idJobV9_();

    const queueSheet =
      ss.insertSheet(
        (
          TBX.QUEUE_PREFIX +
          jobId
        ).substring(0, 99)
      );

    queueSheet.getRange(1, 1, 1, 6)
      .setValues([[
        'FolderId',
        'Nom',
        'Statut',
        'FileToken',
        'FolderToken',
        'Chemin'
      ]]);

    queueSheet.getRange(2, 1, 1, 6)
      .setValues([[
        options.sourceId,
        sourceName,
        'PENDING',
        '',
        '',
        sourceName
      ]]);

    queueSheet.hideSheet();

    const statusSheet =
      nouvelleFeuilleV9_(
        (
          type === 'ANALYZE'
            ? 'ANALYSE V9 '
            : type === 'MOVE'
            ? 'MOVE V9 '
            : type === 'ARCHIVE'
            ? 'ARCHIVE V9 '
            : type === 'RENAME'
            ? 'RENAME V9 '
            : 'DOUBLONS V9 '
        )
      );

    statusSheet.getRange('A1')
      .setValue(
        type === 'ANALYZE'
          ? 'ANALYSE GOOGLE DRIVE — V9'
          : type === 'MOVE'
          ? 'DÉPLACEMENT / CLASSEMENT — V9'
          : type === 'ARCHIVE'
          ? 'ARCHIVAGE DES FICHIERS ANCIENS — V9'
          : type === 'RENAME'
          ? 'RENOMMAGE EN MASSE — V9'
          : 'RECHERCHE DE DOUBLONS POTENTIELS — V9'
      )
      .setFontSize(16)
      .setFontWeight('bold');

    statusSheet.getRange('A2').setValue('Source');
    statusSheet.getRange('B2').setValue(sourceName);

    if (type === 'MOVE' || type === 'ARCHIVE') {
      statusSheet.getRange('A3').setValue('Destination');
      statusSheet.getRange('B3').setValue(destinationName);
    }

    statusSheet.getRange('A5:B15')
      .setValues([
        ['Type de travail', type],
        ['Phase', 'EN COURS'],
        ['Dossiers traités', 0],
        ['Fichiers analysés', 0],
        ['Fichiers correspondants', 0],
        ['Fichiers déplacés / copiés', 0],
        ['Ignorés', 0],
        ['Erreurs', 0],
        ['Dernière mise à jour', new Date()],
        ['Dernière erreur', ''],
        ['Job ID', jobId]
      ]);

    statusSheet.getRange('A5:A15')
      .setFontWeight('bold');

    const state = {
      version: 9,
      jobId: jobId,
      type: type,
      phase: 'RUNNING',

      spreadsheetId: ss.getId(),
      queueSheetName: queueSheet.getName(),
      statusSheetName: statusSheet.getName(),

      sourceId: options.sourceId,
      sourceName: sourceName,
      recursive: options.recursive !== false,

      destinationId: destinationId,
      destinationName: destinationName,

      queueRow: 2,
      currentStep: 'FILES',

      scanned: 0,
      matched: 0,
      acted: 0,
      skipped: 0,
      errors: 0,
      foldersDone: 0,

      options: options,
      targets: {},

      lastError: '',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (type === 'ANALYZE') {
      state.analysis = {
        totalBytes: 0,
        fileCount: 0,
        folderCount: 0,
        sharedCount: 0,
        shortcutCount: 0,
        noExtensionCount: 0,
        emptyFolderCount: 0,
        types: {},
        topLarge: [],
        topOld: [],
        emptyFolders: []
      };
    }

    if (type === 'DUP_SCAN') {
      const dupData =
        ss.insertSheet(
          (
            TBX.DUPDATA_PREFIX +
            jobId
          ).substring(0, 99)
        );

      dupData.getRange(1, 1, 1, 8)
        .setValues([[
          'Key',
          'FileId',
          'Name',
          'Size',
          'MimeType',
          'ParentId',
          'Modified',
          'Url'
        ]]);

      dupData.hideSheet();

      state.dupDataSheetName =
        dupData.getName();

      state.dupBuffer = [];
    }

    sauvegarderEtatV9_(state);
    supprimerDeclencheursV9_();
    programmerSuiteV9_();
    majStatutV9_(state);

    return {
      ok: true,
      message:
        'Travail V9 démarré. Il continuera automatiquement par lots.',
      statusSheetName:
        statusSheet.getName(),
      jobId: jobId
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };

  } finally {
    lock.releaseLock();
  }
}


/* =====================================================================
 * DÉMARRAGE COPIE
 * ===================================================================== */

function demarrerJobCopieV9_(o) {
  const lock = LockService.getUserLock();
  lock.waitLock(30000);

  try {
    verifierAucunJobActifV9_();

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const source =
      dossierV9_(o.sourceId);

    const destParent =
      dossierV9_(o.destinationParentId);

    const sourceName =
      nomDossierV9_(
        source,
        o.sourceId
      );

    const destParentName =
      nomDossierV9_(
        destParent,
        o.destinationParentId
      );

    let destRoot;

    if (o.createRootFolder) {
      const rootName =
        o.rootFolderName ||
        (
          sourceName +
          ' - Copie ' +
          Utilities.formatDate(
            new Date(),
            Session.getScriptTimeZone(),
            'dd-MM-yyyy HH-mm'
          )
        );

      destRoot =
        destParent.createFolder(
          rootName
        );

    } else {
      destRoot =
        destParent;
    }

    if (
      String(destRoot.getId()) ===
      String(o.sourceId)
    ) {
      throw new Error(
        'La destination finale ne peut pas être le dossier source.'
      );
    }

    const jobId =
      idJobV9_();

    const queueSheet =
      ss.insertSheet(
        (
          TBX.QUEUE_PREFIX +
          jobId
        ).substring(0, 99)
      );

    queueSheet.getRange(1, 1, 1, 7)
      .setValues([[
        'SourceFolderId',
        'DestinationFolderId',
        'Nom',
        'Statut',
        'FileToken',
        'FolderToken',
        'Chemin'
      ]]);

    queueSheet.getRange(2, 1, 1, 7)
      .setValues([[
        o.sourceId,
        destRoot.getId(),
        sourceName,
        'PENDING',
        '',
        '',
        sourceName
      ]]);

    queueSheet.hideSheet();

    const statusSheet =
      nouvelleFeuilleV9_(
        'COPIE V9 '
      );

    statusSheet.getRange('A1')
      .setValue(
        'COPIE COMPLÈTE GOOGLE DRIVE — V9'
      )
      .setFontSize(16)
      .setFontWeight('bold');

    statusSheet.getRange('A2')
      .setValue('Source');

    statusSheet.getRange('B2')
      .setValue(sourceName);

    statusSheet.getRange('A3')
      .setValue('Destination');

    statusSheet.getRange('B3')
      .setValue(
        destParentName +
        ' / ' +
        nomDossierV9_(
          destRoot,
          destRoot.getId()
        )
      );

    statusSheet.getRange('A5:B15')
      .setValues([
        ['Type de travail', 'COPY'],
        ['Phase', 'EN COURS'],
        ['Dossiers traités', 0],
        ['Fichiers analysés', 0],
        ['Fichiers correspondants', 0],
        ['Fichiers déplacés / copiés', 0],
        ['Ignorés', 0],
        ['Erreurs', 0],
        ['Dernière mise à jour', new Date()],
        ['Dernière erreur', ''],
        ['Job ID', jobId]
      ]);

    statusSheet.getRange('A5:A15')
      .setFontWeight('bold');

    const state = {
      version: 9,
      jobId: jobId,
      type: 'COPY',
      phase: 'RUNNING',

      spreadsheetId:
        ss.getId(),

      queueSheetName:
        queueSheet.getName(),

      statusSheetName:
        statusSheet.getName(),

      sourceId:
        o.sourceId,

      sourceName:
        sourceName,

      destinationId:
        destRoot.getId(),

      destinationName:
        nomDossierV9_(
          destRoot,
          destRoot.getId()
        ),

      queueRow: 2,
      currentStep: 'FILES',

      scanned: 0,
      matched: 0,
      acted: 0,
      skipped: 0,
      errors: 0,
      foldersDone: 0,

      options: o,

      lastError: '',
      startedAt:
        new Date().toISOString(),
      updatedAt:
        new Date().toISOString()
    };

    sauvegarderEtatV9_(state);
    supprimerDeclencheursV9_();
    programmerSuiteV9_();
    majStatutV9_(state);

    return {
      ok: true,
      message:
        'Copie V9 démarrée. Elle continuera automatiquement par lots.',
      statusSheetName:
        statusSheet.getName(),
      destinationRootName:
        state.destinationName,
      jobId:
        jobId
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };

  } finally {
    lock.releaseLock();
  }
}


/* =====================================================================
 * DÉMARRAGE DÉPLACEMENT DES DOUBLONS
 * ===================================================================== */

function demarrerJobMoveDuplicatesV9_(
  reportName,
  destinationId
) {
  const lock =
    LockService.getUserLock();

  lock.waitLock(30000);

  try {
    verifierAucunJobActifV9_();

    const ss =
      SpreadsheetApp
        .getActiveSpreadsheet();

    const dest =
      dossierV9_(destinationId);

    const statusSheet =
      nouvelleFeuilleV9_(
        'MOVE DOUBLONS V9 '
      );

    statusSheet.getRange('A1')
      .setValue(
        'DÉPLACEMENT DES DOUBLONS POTENTIELS — V9'
      )
      .setFontSize(16)
      .setFontWeight('bold');

    statusSheet.getRange('A2')
      .setValue(
        'Rapport source'
      );

    statusSheet.getRange('B2')
      .setValue(
        reportName
      );

    statusSheet.getRange('A3')
      .setValue(
        'Destination'
      );

    statusSheet.getRange('B3')
      .setValue(
        nomDossierV9_(
          dest,
          destinationId
        )
      );

    const jobId =
      idJobV9_();

    statusSheet.getRange('A5:B15')
      .setValues([
        ['Type de travail', 'MOVE_DUP'],
        ['Phase', 'EN COURS'],
        ['Dossiers traités', 0],
        ['Fichiers analysés', 0],
        ['Fichiers correspondants', 0],
        ['Fichiers déplacés / copiés', 0],
        ['Ignorés', 0],
        ['Erreurs', 0],
        ['Dernière mise à jour', new Date()],
        ['Dernière erreur', ''],
        ['Job ID', jobId]
      ]);

    statusSheet.getRange('A5:A15')
      .setFontWeight('bold');

    const state = {
      version: 9,
      jobId: jobId,
      type: 'MOVE_DUP',
      phase: 'RUNNING',

      spreadsheetId:
        ss.getId(),

      statusSheetName:
        statusSheet.getName(),

      dupReportName:
        reportName,

      destinationId:
        destinationId,

      destinationName:
        nomDossierV9_(
          dest,
          destinationId
        ),

      reportRow: 2,

      scanned: 0,
      matched: 0,
      acted: 0,
      skipped: 0,
      errors: 0,
      foldersDone: 0,

      lastError: '',
      startedAt:
        new Date().toISOString(),
      updatedAt:
        new Date().toISOString()
    };

    sauvegarderEtatV9_(state);
    supprimerDeclencheursV9_();
    programmerSuiteV9_();
    majStatutV9_(state);

    return {
      ok: true,
      message:
        'Déplacement des doublons démarré. Le plus ancien de chaque groupe reste en place.',
      statusSheetName:
        statusSheet.getName(),
      jobId:
        jobId
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };

  } finally {
    lock.releaseLock();
  }
}


/* =====================================================================
 * MOTEUR PRINCIPAL
 * ===================================================================== */

function continuerJobToolboxV9() {
  const lock =
    LockService.getUserLock();

  if (!lock.tryLock(5000)) {
    return;
  }

  try {
    supprimerDeclencheursV9_();

    let state =
      chargerEtatV9_();

    if (!state) {
      return;
    }

    if (
      ['DONE', 'STOPPED', 'ERROR']
        .indexOf(state.phase) !== -1
    ) {
      return;
    }

    if (state.type === 'COPY') {
      state =
        traiterCopieV9_(state);

    } else if (
      state.type === 'MOVE_DUP'
    ) {
      state =
        traiterMoveDuplicatesV9_(state);

    } else if (
      state.type === 'DUP_SCAN' &&
      state.phase === 'DUP_SORT'
    ) {
      state =
        trierDoublonsV9_(state);

    } else if (
      state.type === 'DUP_SCAN' &&
      state.phase === 'DUP_GROUP'
    ) {
      state =
        grouperDoublonsV9_(state);

    } else {
      state =
        traiterQueueDossiersV9_(state);
    }

    sauvegarderEtatV9_(state);
    majStatutV9_(state);

    if (
      state.phase === 'RUNNING' ||
      state.phase === 'DUP_SORT' ||
      state.phase === 'DUP_GROUP'
    ) {
      programmerSuiteV9_();

    } else {
      supprimerDeclencheursV9_();
    }

  } catch (e) {
    let state =
      chargerEtatV9_() ||
      {};

    state.phase =
      'ERROR';

    state.lastError =
      erreurV9_(e);

    state.updatedAt =
      new Date().toISOString();

    sauvegarderEtatV9_(state);

    try {
      majStatutV9_(state);
    } catch (_) {}

  } finally {
    lock.releaseLock();
  }
}


/* =====================================================================
 * TRAITEMENT GÉNÉRIQUE : ANALYSE / MOVE / DUP_SCAN
 * ===================================================================== */

function traiterQueueDossiersV9_(state) {
  const ss =
    SpreadsheetApp.openById(
      state.spreadsheetId
    );

  const queueSheet =
    ss.getSheetByName(
      state.queueSheetName
    );

  if (!queueSheet) {
    throw new Error(
      'La feuille technique de file d’attente est introuvable.'
    );
  }

  const deadline =
    Date.now() +
    TBX.RUN_MAX_MS;

  let actionsThisRun =
    0;

  while (
    state.phase === 'RUNNING' &&
    Date.now() <
      deadline - 8000 &&
    actionsThisRun <
      TBX.MAX_FILES_PER_RUN
  ) {
    const lastRow =
      queueSheet.getLastRow();

    if (
      state.queueRow >
      lastRow
    ) {
      if (
        state.type ===
        'DUP_SCAN'
      ) {
        viderBufferDupV9_(
          state,
          ss
        );

        state.phase =
          'DUP_SORT';

      } else {
        state.phase =
          'DONE';

        if (
          state.type ===
          'ANALYZE'
        ) {
          finaliserAnalyseV9_(
            state
          );
        }
      }

      state.updatedAt =
        new Date().toISOString();

      break;
    }

    const rowData =
      queueSheet
        .getRange(
          state.queueRow,
          1,
          1,
          6
        )
        .getValues()[0];

    const folderId =
      String(
        rowData[0] || ''
      );

    const folderName =
      String(
        rowData[1] ||
        'Dossier'
      );

    const status =
      String(
        rowData[2] || ''
      );

    let fileToken =
      String(
        rowData[3] || ''
      );

    let folderToken =
      String(
        rowData[4] || ''
      );

    const path =
      String(
        rowData[5] ||
        folderName
      );

    if (
      !folderId ||
      status === 'DONE' ||
      status === 'SKIP'
    ) {
      state.queueRow++;
      state.currentStep =
        'FILES';
      continue;
    }

    let folder;

    try {
      folder =
        dossierV9_(
          folderId
        );

    } catch (e) {
      queueSheet
        .getRange(
          state.queueRow,
          3
        )
        .setValue(
          'ERROR'
        );

      state.errors++;
      state.lastError =
        'Dossier "' +
        folderName +
        '" : ' +
        erreurV9_(e);

      state.queueRow++;
      state.currentStep =
        'FILES';

      continue;
    }


    /* -------------------------------------------------------------
     * FICHIERS
     * ------------------------------------------------------------- */

    if (
      state.currentStep ===
      'FILES'
    ) {
      let files;

      try {
        files =
          fileToken
            ? DriveApp.continueFileIterator(
                fileToken
              )
            : folder.getFiles();

      } catch (e) {
        fileToken =
          '';

        files =
          folder.getFiles();

        state.lastError =
          'Jeton fichier réinitialisé dans "' +
          folderName +
          '" : ' +
          erreurV9_(e);
      }

      let sinceSave =
        0;

      let directFileCount =
        0;

      while (
        files.hasNext() &&
        Date.now() <
          deadline - 10000 &&
        actionsThisRun <
          TBX.MAX_FILES_PER_RUN
      ) {
        const file =
          files.next();

        directFileCount++;
        state.scanned++;
        sinceSave++;

        try {
          if (
            state.type ===
            'MOVE'
          ) {
            const o =
              state.options || {};

            if (
              file.getId() ===
              state.spreadsheetId
            ) {
              state.skipped++;

            } else if (
              fichierCorrespondV9_(
                file,
                o.types || [],
                extensionsSetV9_(
                  o.extensions || ''
                )
              )
            ) {
              state.matched++;

              const category =
                categorieV9_(file);

              const target =
                cibleMoveV9_(
                  state,
                  category
                );

              if (
                parentEstV9_(
                  file,
                  target.getId()
                )
              ) {
                state.skipped++;

              } else {
                file.moveTo(
                  target
                );

                state.acted++;
                actionsThisRun++;
              }
            }

          } else if (
            state.type ===
            'ARCHIVE'
          ) {
            const cutoff =
              Date.now() -
              Math.max(
                1,
                Number(
                  (state.options && state.options.olderThanDays) ||
                  365
                )
              ) *
              86400000;

            const updated =
              file.getLastUpdated();

            if (
              file.getId() ===
              state.spreadsheetId
            ) {
              state.skipped++;

            } else if (
              updated &&
              updated.getTime() <
              cutoff
            ) {
              state.matched++;

              const target =
                dossierV9_(
                  state.destinationId
                );

              if (
                parentEstV9_(
                  file,
                  target.getId()
                )
              ) {
                state.skipped++;

              } else {
                file.moveTo(
                  target
                );

                state.acted++;
                actionsThisRun++;
              }
            }

          } else if (
            state.type ===
            'RENAME'
          ) {
            const ro =
              state.options || {};

            const allowed =
              extensionsSetV9_(
                ro.extensions || ''
              );

            const ext =
              extensionV9_(
                file.getName()
              );

            if (
              Object.keys(
                allowed
              ).length &&
              !allowed[ext]
            ) {
              // filtre extension : fichier ignoré
            } else {
              const newName =
                calculerNouveauNomV9_(
                  file.getName(),
                  String(ro.prefix || ''),
                  String(ro.suffix || ''),
                  String(ro.searchText || ''),
                  String(ro.replaceText || '')
                );

              if (
                newName &&
                newName !==
                file.getName()
              ) {
                state.matched++;

                file.setName(
                  newName
                );

                state.acted++;
                actionsThisRun++;
              }
            }

          } else if (
            state.type ===
            'ANALYZE'
          ) {
            analyserFichierV9_(
              state,
              file,
              path
            );

          } else if (
            state.type ===
            'DUP_SCAN'
          ) {
            ajouterFichierDupV9_(
              state,
              file,
              folderId
            );

            if (
              state.dupBuffer &&
              state.dupBuffer.length >=
                TBX.DUP_SCAN_BUFFER
            ) {
              viderBufferDupV9_(
                state,
                ss
              );
            }
          }

        } catch (e) {
          state.errors++;

          state.lastError =
            'Fichier "' +
            nomFichierV9_(
              file
            ) +
            '" : ' +
            erreurV9_(e);
        }

        if (
          sinceSave >=
          TBX.SAVE_EVERY_FILES
        ) {
          let token =
            '';

          try {
            token =
              files.hasNext()
                ? files.getContinuationToken()
                : '';
          } catch (_) {}

          queueSheet
            .getRange(
              state.queueRow,
              4
            )
            .setValue(
              token
            );

          state.updatedAt =
            new Date().toISOString();

          sauvegarderEtatV9_(
            state
          );

          majStatutV9_(
            state
          );

          sinceSave =
            0;
        }
      }

      if (
        files.hasNext()
      ) {
        queueSheet
          .getRange(
            state.queueRow,
            4
          )
          .setValue(
            files.getContinuationToken()
          );

        state.updatedAt =
          new Date().toISOString();

        return state;
      }

      queueSheet
        .getRange(
          state.queueRow,
          4
        )
        .setValue('');

      state.currentStep =
        'FOLDERS';

      if (
        state.type ===
        'ANALYZE'
      ) {
        // On note temporairement si le dossier n'a aucun fichier direct.
        state._currentDirectFiles =
          directFileCount;
      }

      sauvegarderEtatV9_(
        state
      );
    }


    /* -------------------------------------------------------------
     * SOUS-DOSSIERS
     * ------------------------------------------------------------- */

    if (
      state.currentStep ===
      'FOLDERS'
    ) {
      let directSubCount =
        0;

      if (
        state.recursive !==
        false
      ) {
        let folders;

        try {
          folders =
            folderToken
              ? DriveApp.continueFolderIterator(
                  folderToken
                )
              : folder.getFolders();

        } catch (e) {
          folderToken =
            '';

          folders =
            folder.getFolders();

          state.lastError =
            'Jeton dossier réinitialisé dans "' +
            folderName +
            '" : ' +
            erreurV9_(e);
        }

        const newRows =
          [];

        while (
          folders.hasNext() &&
          Date.now() <
            deadline - 10000
        ) {
          const sub =
            folders.next();

          directSubCount++;

          try {
            if (
              (state.type === 'MOVE' || state.type === 'ARCHIVE') &&
              ignorerSousDossierMoveEtatV9_(
                sub.getId(),
                sub.getName(),
                state
              )
            ) {
              continue;
            }

            newRows.push([
              sub.getId(),
              sub.getName(),
              'PENDING',
              '',
              '',
              path +
                '/' +
                sub.getName()
            ]);

            if (
              newRows.length >=
              100
            ) {
              ajouterQueueGenericV9_(
                queueSheet,
                newRows.splice(
                  0,
                  newRows.length
                )
              );

              const token =
                folders.hasNext()
                  ? folders.getContinuationToken()
                  : '';

              queueSheet
                .getRange(
                  state.queueRow,
                  5
                )
                .setValue(
                  token
                );

              sauvegarderEtatV9_(
                state
              );
            }

          } catch (e) {
            state.errors++;
            state.lastError =
              'Sous-dossier de "' +
              folderName +
              '" : ' +
              erreurV9_(e);
          }
        }

        if (
          newRows.length
        ) {
          ajouterQueueGenericV9_(
            queueSheet,
            newRows
          );
        }

        if (
          folders.hasNext()
        ) {
          queueSheet
            .getRange(
              state.queueRow,
              5
            )
            .setValue(
              folders.getContinuationToken()
            );

          state.updatedAt =
            new Date().toISOString();

          return state;
        }
      }

      if (
        state.type ===
        'ANALYZE'
      ) {
        analyserDossierVideV9_(
          state,
          folder,
          path,
          state._currentDirectFiles || 0,
          directSubCount
        );

        delete state._currentDirectFiles;
      }

      queueSheet
        .getRange(
          state.queueRow,
          3,
          1,
          3
        )
        .setValues([[
          'DONE',
          '',
          ''
        ]]);

      state.foldersDone++;
      state.queueRow++;
      state.currentStep =
        'FILES';

      state.updatedAt =
        new Date().toISOString();

      sauvegarderEtatV9_(
        state
      );

      majStatutV9_(
        state
      );
    }
  }

  return state;
}


/* =====================================================================
 * COPIE MASSIVE
 * ===================================================================== */

function traiterCopieV9_(state) {
  const ss =
    SpreadsheetApp.openById(
      state.spreadsheetId
    );

  const queueSheet =
    ss.getSheetByName(
      state.queueSheetName
    );

  if (!queueSheet) {
    throw new Error(
      'La feuille technique de copie est introuvable.'
    );
  }

  const deadline =
    Date.now() +
    TBX.RUN_MAX_MS;

  let copiedThisRun =
    0;

  while (
    state.phase === 'RUNNING' &&
    Date.now() <
      deadline - 8000 &&
    copiedThisRun <
      TBX.MAX_FILES_PER_RUN
  ) {
    const lastRow =
      queueSheet.getLastRow();

    if (
      state.queueRow >
      lastRow
    ) {
      state.phase =
        'DONE';

      break;
    }

    const rowData =
      queueSheet
        .getRange(
          state.queueRow,
          1,
          1,
          7
        )
        .getValues()[0];

    const sourceFolderId =
      String(
        rowData[0] || ''
      );

    const destinationFolderId =
      String(
        rowData[1] || ''
      );

    const folderName =
      String(
        rowData[2] ||
        'Dossier'
      );

    const status =
      String(
        rowData[3] || ''
      );

    let fileToken =
      String(
        rowData[4] || ''
      );

    let folderToken =
      String(
        rowData[5] || ''
      );

    const path =
      String(
        rowData[6] ||
        folderName
      );

    if (
      !sourceFolderId ||
      !destinationFolderId ||
      status === 'DONE' ||
      status === 'SKIP'
    ) {
      state.queueRow++;
      state.currentStep =
        'FILES';

      continue;
    }

    let sourceFolder;
    let destinationFolder;

    try {
      sourceFolder =
        dossierV9_(
          sourceFolderId
        );

      destinationFolder =
        dossierV9_(
          destinationFolderId
        );

    } catch (e) {
      queueSheet
        .getRange(
          state.queueRow,
          4
        )
        .setValue(
          'ERROR'
        );

      state.errors++;
      state.lastError =
        'Dossier "' +
        folderName +
        '" : ' +
        erreurV9_(e);

      state.queueRow++;
      state.currentStep =
        'FILES';

      continue;
    }

    if (
      state.currentStep ===
      'FILES'
    ) {
      let files;

      try {
        files =
          fileToken
            ? DriveApp.continueFileIterator(
                fileToken
              )
            : sourceFolder.getFiles();

      } catch (e) {
        fileToken =
          '';

        files =
          sourceFolder.getFiles();

        state.lastError =
          'Jeton fichier réinitialisé dans "' +
          folderName +
          '" : ' +
          erreurV9_(e);
      }

      let sinceSave =
        0;

      while (
        files.hasNext() &&
        Date.now() <
          deadline - 10000 &&
        copiedThisRun <
          TBX.MAX_FILES_PER_RUN
      ) {
        const file =
          files.next();

        state.scanned++;
        state.matched++;
        sinceSave++;

        try {
          if (
            !state.options.includeActiveSpreadsheet &&
            file.getId() ===
              state.spreadsheetId
          ) {
            state.skipped++;

          } else {
            file.makeCopy(
              file.getName(),
              destinationFolder
            );

            state.acted++;
            copiedThisRun++;
          }

        } catch (e) {
          state.errors++;

          state.lastError =
            'Fichier "' +
            nomFichierV9_(
              file
            ) +
            '" : ' +
            erreurV9_(e);
        }

        if (
          sinceSave >=
          TBX.SAVE_EVERY_FILES
        ) {
          const token =
            files.hasNext()
              ? files.getContinuationToken()
              : '';

          queueSheet
            .getRange(
              state.queueRow,
              5
            )
            .setValue(
              token
            );

          sauvegarderEtatV9_(
            state
          );

          majStatutV9_(
            state
          );

          sinceSave =
            0;
        }
      }

      if (
        files.hasNext()
      ) {
        queueSheet
          .getRange(
            state.queueRow,
            5
          )
          .setValue(
            files.getContinuationToken()
          );

        return state;
      }

      queueSheet
        .getRange(
          state.queueRow,
          5
        )
        .setValue('');

      state.currentStep =
        'FOLDERS';
    }

    if (
      state.currentStep ===
      'FOLDERS'
    ) {
      if (
        state.options.copySubfolders !==
        false
      ) {
        let folders;

        try {
          folders =
            folderToken
              ? DriveApp.continueFolderIterator(
                  folderToken
                )
              : sourceFolder.getFolders();

        } catch (e) {
          folderToken =
            '';

          folders =
            sourceFolder.getFolders();

          state.lastError =
            'Jeton dossier réinitialisé dans "' +
            folderName +
            '" : ' +
            erreurV9_(e);
        }

        const newRows =
          [];

        while (
          folders.hasNext() &&
          Date.now() <
            deadline - 10000
        ) {
          const sub =
            folders.next();

          try {
            const newSub =
              destinationFolder
                .createFolder(
                  sub.getName()
                );

            newRows.push([
              sub.getId(),
              newSub.getId(),
              sub.getName(),
              'PENDING',
              '',
              '',
              path +
                '/' +
                sub.getName()
            ]);

            if (
              newRows.length >=
              100
            ) {
              ajouterQueueCopyV9_(
                queueSheet,
                newRows.splice(
                  0,
                  newRows.length
                )
              );

              const token =
                folders.hasNext()
                  ? folders.getContinuationToken()
                  : '';

              queueSheet
                .getRange(
                  state.queueRow,
                  6
                )
                .setValue(
                  token
                );

              sauvegarderEtatV9_(
                state
              );
            }

          } catch (e) {
            state.errors++;

            state.lastError =
              'Sous-dossier de "' +
              folderName +
              '" : ' +
              erreurV9_(e);
          }
        }

        if (
          newRows.length
        ) {
          ajouterQueueCopyV9_(
            queueSheet,
            newRows
          );
        }

        if (
          folders.hasNext()
        ) {
          queueSheet
            .getRange(
              state.queueRow,
              6
            )
            .setValue(
              folders.getContinuationToken()
            );

          return state;
        }
      }

      queueSheet
        .getRange(
          state.queueRow,
          4,
          1,
          3
        )
        .setValues([[
          'DONE',
          '',
          ''
        ]]);

      state.foldersDone++;
      state.queueRow++;
      state.currentStep =
        'FILES';

      sauvegarderEtatV9_(
        state
      );

      majStatutV9_(
        state
      );
    }
  }

  return state;
}


/* =====================================================================
 * ANALYSE
 * ===================================================================== */

function analyserFichierV9_(
  state,
  file,
  path
) {
  const a =
    state.analysis;

  const size =
    Number(
      file.getSize() ||
      0
    );

  const mime =
    String(
      file.getMimeType() ||
      ''
    );

  const category =
    nomCategorieV9_(
      categorieV9_(
        file
      )
    );

  a.fileCount++;
  a.totalBytes +=
    size;

  if (!a.types[category]) {
    a.types[category] = {
      count: 0,
      size: 0
    };
  }

  a.types[category].count++;
  a.types[category].size +=
    size;

  try {
    if (file.isShareableByEditors()) {
      // Indicateur léger ; ce n'est pas la liste exhaustive des partages.
      a.sharedCount++;
    }
  } catch (_) {}

  if (
    mime ===
    'application/vnd.google-apps.shortcut'
  ) {
    a.shortcutCount++;
  }

  if (
    !extensionV9_(
      file.getName()
    ) &&
    mime.indexOf(
      'application/vnd.google-apps.'
    ) !== 0
  ) {
    a.noExtensionCount++;
  }

  const largeLimit =
    Number(
      state.options.largeFileMB ||
      TBX.LARGE_FILE_MB
    ) *
    1024 *
    1024;

  if (
    size >=
    largeLimit
  ) {
    a.topLarge.push({
      name: file.getName(),
      size: size,
      modified:
        dateIsoV9_(
          file.getLastUpdated()
        ),
      path: path,
      url: urlFichierV9_(file)
    });

    limiterTopLargeV9_(
      a.topLarge
    );
  }

  const oldMs =
    Number(
      state.options.oldFileDays ||
      TBX.OLD_FILE_DAYS
    ) *
    86400000;

  const updated =
    file.getLastUpdated();

  if (
    updated &&
    updated.getTime() <
      Date.now() -
        oldMs
  ) {
    a.topOld.push({
      name: file.getName(),
      size: size,
      modified:
        dateIsoV9_(
          updated
        ),
      path: path,
      url: urlFichierV9_(file)
    });

    limiterTopOldV9_(
      a.topOld
    );
  }

  state.matched =
    a.fileCount;
}


function analyserDossierVideV9_(
  state,
  folder,
  path,
  directFiles,
  directSubs
) {
  const a =
    state.analysis;

  a.folderCount++;

  if (
    directFiles === 0 &&
    directSubs === 0
  ) {
    a.emptyFolderCount++;

    if (
      a.emptyFolders.length <
      TBX.ANALYSIS_TOP
    ) {
      a.emptyFolders.push({
        name:
          folder.getName(),
        path:
          path,
        id:
          folder.getId()
      });
    }
  }
}


function limiterTopLargeV9_(
  arr
) {
  if (
    arr.length >
    TBX.ANALYSIS_TOP *
      2
  ) {
    arr.sort(
      function(a, b) {
        return (
          b.size -
          a.size
        );
      }
    );

    arr.splice(
      TBX.ANALYSIS_TOP
    );
  }
}


function limiterTopOldV9_(
  arr
) {
  if (
    arr.length >
    TBX.ANALYSIS_TOP *
      2
  ) {
    arr.sort(
      function(a, b) {
        return (
          new Date(a.modified) -
          new Date(b.modified)
        );
      }
    );

    arr.splice(
      TBX.ANALYSIS_TOP
    );
  }
}


function finaliserAnalyseV9_(
  state
) {
  const ss =
    SpreadsheetApp.openById(
      state.spreadsheetId
    );

  const sheet =
    ss.getSheetByName(
      state.statusSheetName
    );

  if (!sheet) {
    return;
  }

  const a =
    state.analysis;

  a.topLarge.sort(
    function(x, y) {
      return y.size -
        x.size;
    }
  );

  a.topOld.sort(
    function(x, y) {
      return (
        new Date(x.modified) -
        new Date(y.modified)
      );
    }
  );

  a.topLarge =
    a.topLarge.slice(
      0,
      TBX.ANALYSIS_TOP
    );

  a.topOld =
    a.topOld.slice(
      0,
      TBX.ANALYSIS_TOP
    );

  let row =
    18;

  row =
    sectionV9_(
      sheet,
      row,
      'RÉSUMÉ',
      [
        [
          'Indicateur',
          'Valeur'
        ],
        [
          'Fichiers',
          a.fileCount
        ],
        [
          'Dossiers',
          a.folderCount
        ],
        [
          'Taille totale',
          formatBytesV9_(
            a.totalBytes
          )
        ],
        [
          'Dossiers vides',
          a.emptyFolderCount
        ],
        [
          'Raccourcis',
          a.shortcutCount
        ],
        [
          'Sans extension',
          a.noExtensionCount
        ]
      ]
    );

  const typesRows = [
    [
      'Type',
      'Nombre',
      'Taille'
    ]
  ];

  Object.keys(
    a.types
  )
    .sort(
      function(x, y) {
        return (
          a.types[y].size -
          a.types[x].size
        );
      }
    )
    .forEach(
      function(t) {
        typesRows.push([
          t,
          a.types[t].count,
          formatBytesV9_(
            a.types[t].size
          )
        ]);
      }
    );

  row =
    sectionV9_(
      sheet,
      row,
      'RÉPARTITION PAR TYPE',
      typesRows
    );

  const largeRows = [
    [
      'Nom',
      'Taille',
      'Modification',
      'Chemin',
      'Lien'
    ]
  ];

  a.topLarge.forEach(
    function(x) {
      largeRows.push([
        x.name,
        formatBytesV9_(
          x.size
        ),
        x.modified,
        x.path,
        x.url
      ]);
    }
  );

  row =
    sectionV9_(
      sheet,
      row,
      'PLUS GROS FICHIERS',
      largeRows
    );

  const oldRows = [
    [
      'Nom',
      'Taille',
      'Modification',
      'Chemin',
      'Lien'
    ]
  ];

  a.topOld.forEach(
    function(x) {
      oldRows.push([
        x.name,
        formatBytesV9_(
          x.size
        ),
        x.modified,
        x.path,
        x.url
      ]);
    }
  );

  row =
    sectionV9_(
      sheet,
      row,
      'FICHIERS ANCIENS',
      oldRows
    );

  const emptyRows = [
    [
      'Dossier',
      'Chemin',
      'ID'
    ]
  ];

  a.emptyFolders.forEach(
    function(x) {
      emptyRows.push([
        x.name,
        x.path,
        x.id
      ]);
    }
  );

  sectionV9_(
    sheet,
    row,
    'DOSSIERS VIDES',
    emptyRows
  );

  formatV9_(
    sheet
  );
}


/* =====================================================================
 * DOUBLONS POTENTIELS
 * ===================================================================== */

/**
 * La V9 n'ouvre jamais le contenu du fichier.
 * La signature est :
 * NOM NORMALISÉ + TAILLE + TYPE MIME.
 *
 * Donc le rapport est volontairement nommé "doublons potentiels".
 */
function ajouterFichierDupV9_(
  state,
  file,
  parentId
) {
  state.dupBuffer =
    state.dupBuffer ||
    [];

  const name =
    file.getName();

  const size =
    Number(
      file.getSize() ||
      0
    );

  const mime =
    String(
      file.getMimeType() ||
      ''
    );

  const key =
    normaliserNomDupV9_(
      name
    ) +
    '|' +
    size +
    '|' +
    mime;

  const updated =
    file.getLastUpdated();

  state.dupBuffer.push([
    key,
    file.getId(),
    name,
    size,
    mime,
    parentId,
    updated,
    urlFichierV9_(file)
  ]);

  state.matched++;
}


function viderBufferDupV9_(
  state,
  ss
) {
  if (
    !state.dupBuffer ||
    !state.dupBuffer.length
  ) {
    return;
  }

  const sheet =
    ss.getSheetByName(
      state.dupDataSheetName
    );

  if (!sheet) {
    throw new Error(
      'La feuille technique des doublons est introuvable.'
    );
  }

  sheet.getRange(
    sheet.getLastRow() + 1,
    1,
    state.dupBuffer.length,
    8
  ).setValues(
    state.dupBuffer
  );

  state.dupBuffer =
    [];
}


function trierDoublonsV9_(
  state
) {
  const ss =
    SpreadsheetApp.openById(
      state.spreadsheetId
    );

  const dataSheet =
    ss.getSheetByName(
      state.dupDataSheetName
    );

  if (!dataSheet) {
    throw new Error(
      'La feuille technique des doublons est introuvable.'
    );
  }

  const lastRow =
    dataSheet.getLastRow();

  if (
    lastRow <= 1
  ) {
    state.phase =
      'DONE';

    finaliserRapportDoublonsVideV9_(
      state
    );

    return state;
  }

  dataSheet.getRange(
    2,
    1,
    lastRow - 1,
    8
  ).sort([
    {
      column: 1,
      ascending: true
    },
    {
      column: 7,
      ascending: true
    }
  ]);

  const report =
    nouvelleFeuilleV9_(
      'RAPPORT DOUBLONS V9 '
    );

  report.getRange(1, 1, 1, 10)
    .setValues([[
      'Groupe',
      'Action conseillée',
      'Nom',
      'Taille',
      'Type',
      'Modification',
      'Lien',
      'FileId',
      'ParentId',
      'Clé'
    ]]);

  report.getRange(1, 1, 1, 10)
    .setFontWeight('bold')
    .setBackground('#d9ead3');

  state.dupReportName =
    report.getName();

  state.dupGroupRow =
    2;

  state.dupGroupNumber =
    0;

  state.dupPending =
    [];

  state.phase =
    'DUP_GROUP';

  PropertiesService
    .getUserProperties()
    .setProperty(
      TBX.PROP_LAST_DUP_REPORT,
      report.getName()
    );

  return state;
}


function grouperDoublonsV9_(
  state
) {
  const ss =
    SpreadsheetApp.openById(
      state.spreadsheetId
    );

  const dataSheet =
    ss.getSheetByName(
      state.dupDataSheetName
    );

  const report =
    ss.getSheetByName(
      state.dupReportName
    );

  if (
    !dataSheet ||
    !report
  ) {
    throw new Error(
      'Les feuilles de doublons sont introuvables.'
    );
  }

  const deadline =
    Date.now() +
    TBX.RUN_MAX_MS;

  const lastRow =
    dataSheet.getLastRow();

  while (
    state.dupGroupRow <=
      lastRow &&
    Date.now() <
      deadline - 10000
  ) {
    const count =
      Math.min(
        TBX.DUP_GROUP_CHUNK,
        lastRow -
          state.dupGroupRow +
          1
      );

    const rows =
      dataSheet
        .getRange(
          state.dupGroupRow,
          1,
          count,
          8
        )
        .getValues();

    for (
      let i = 0;
      i < rows.length;
      i++
    ) {
      const r =
        rows[i];

      const key =
        String(
          r[0] || ''
        );

      if (
        !state.dupPending.length
      ) {
        state.dupPending = [
          r
        ];

      } else if (
        String(
          state.dupPending[0][0]
        ) === key
      ) {
        state.dupPending.push(
          r
        );

      } else {
        ecrireGroupeDoublonsV9_(
          state,
          report,
          state.dupPending
        );

        state.dupPending = [
          r
        ];
      }

      state.dupGroupRow++;
    }

    sauvegarderEtatV9_(
      state
    );
  }

  if (
    state.dupGroupRow >
    lastRow
  ) {
    ecrireGroupeDoublonsV9_(
      state,
      report,
      state.dupPending
    );

    state.dupPending =
      [];

    state.phase =
      'DONE';

    report.insertRowsBefore(
      1,
      4
    );

    report.getRange('A1')
      .setValue(
        'DOUBLONS POTENTIELS — NOM + TAILLE + TYPE'
      )
      .setFontSize(16)
      .setFontWeight('bold');

    report.getRange('A2')
      .setValue(
        'Important'
      );

    report.getRange('B2')
      .setValue(
        'Ce rapport ne compare pas le contenu binaire. Vérifie avant de déplacer.'
      );

    report.getRange('A3')
      .setValue(
        'Groupes trouvés'
      );

    report.getRange('B3')
      .setValue(
        state.dupGroupNumber || 0
      );

    formatV9_(
      report
    );

    PropertiesService
      .getUserProperties()
      .setProperty(
        TBX.PROP_LAST_DUP_REPORT,
        report.getName()
      );
  }

  return state;
}


function ecrireGroupeDoublonsV9_(
  state,
  report,
  groupRows
) {
  if (
    !groupRows ||
    groupRows.length <= 1
  ) {
    return;
  }

  state.dupGroupNumber++;

  const out =
    [];

  for (
    let i = 0;
    i < groupRows.length;
    i++
  ) {
    const r =
      groupRows[i];

    out.push([
      state.dupGroupNumber,
      i === 0
        ? 'GARDER (le plus ancien)'
        : 'DÉPLACER',
      r[2],
      formatBytesV9_(
        Number(
          r[3] || 0
        )
      ),
      r[4],
      r[6],
      r[7],
      r[1],
      r[5],
      r[0]
    ]);
  }

  report.getRange(
    report.getLastRow() + 1,
    1,
    out.length,
    10
  ).setValues(
    out
  );
}


function finaliserRapportDoublonsVideV9_(
  state
) {
  const report =
    nouvelleFeuilleV9_(
      'RAPPORT DOUBLONS V9 '
    );

  report.getRange('A1')
    .setValue(
      'DOUBLONS POTENTIELS'
    )
    .setFontSize(16)
    .setFontWeight('bold');

  report.getRange('A3')
    .setValue(
      'Aucun fichier à comparer.'
    );

  state.dupReportName =
    report.getName();

  PropertiesService
    .getUserProperties()
    .setProperty(
      TBX.PROP_LAST_DUP_REPORT,
      report.getName()
    );
}


/* =====================================================================
 * DÉPLACER LES DOUBLONS DU RAPPORT
 * ===================================================================== */

function traiterMoveDuplicatesV9_(
  state
) {
  const ss =
    SpreadsheetApp.openById(
      state.spreadsheetId
    );

  const report =
    ss.getSheetByName(
      state.dupReportName
    );

  if (!report) {
    throw new Error(
      'Le rapport de doublons est introuvable.'
    );
  }

  const destination =
    dossierV9_(
      state.destinationId
    );

  const deadline =
    Date.now() +
    TBX.RUN_MAX_MS;

  let movedThisRun =
    0;

  const lastRow =
    report.getLastRow();

  while (
    state.reportRow <=
      lastRow &&
    Date.now() <
      deadline - 10000 &&
    movedThisRun <
      TBX.MAX_FILES_PER_RUN
  ) {
    const count =
      Math.min(
        200,
        lastRow -
          state.reportRow +
          1
      );

    const rows =
      report
        .getRange(
          state.reportRow,
          1,
          count,
          10
        )
        .getValues();

    for (
      let i = 0;
      i < rows.length;
      i++
    ) {
      if (
        Date.now() >=
        deadline - 10000
      ) {
        break;
      }

      const action =
        String(
          rows[i][1] || ''
        );

      const fileId =
        String(
          rows[i][7] || ''
        );

      state.scanned++;

      if (
        action !== 'DÉPLACER' ||
        !fileId
      ) {
        state.skipped++;
        state.reportRow++;
        continue;
      }

      state.matched++;

      try {
        const file =
          DriveApp.getFileById(
            fileId
          );

        if (
          parentEstV9_(
            file,
            state.destinationId
          )
        ) {
          state.skipped++;

        } else {
          file.moveTo(
            destination
          );

          state.acted++;
          movedThisRun++;
        }

      } catch (e) {
        state.errors++;

        state.lastError =
          'Doublon FileId ' +
          fileId +
          ' : ' +
          erreurV9_(e);
      }

      state.reportRow++;

      if (
        movedThisRun >=
        TBX.MAX_FILES_PER_RUN
      ) {
        break;
      }
    }

    sauvegarderEtatV9_(
      state
    );

    majStatutV9_(
      state
    );
  }

  if (
    state.reportRow >
    lastRow
  ) {
    state.phase =
      'DONE';
  }

  return state;
}


/* =====================================================================
 * MOVE / CLASSEMENT
 * ===================================================================== */

function normaliserMoveOptionsV9_(
  options
) {
  options =
    options ||
    {};

  return {
    sourceId:
      String(
        options.sourceId || ''
      ),

    destinationId:
      String(
        options.destinationId || ''
      ),

    recursive:
      options.recursive !==
      false,

    action:
      options.action ===
      'sortByType'
        ? 'sortByType'
        : 'move',

    types:
      Array.isArray(
        options.types
      )
        ? options.types
        : [],

    extensions:
      String(
        options.extensions || ''
      ),

    extensionSet:
      extensionsSetV9_(
        options.extensions || ''
      )
  };
}


function validerMoveOptionsV9_(
  o
) {
  if (!o.sourceId) {
    throw new Error(
      'Choisis un dossier source.'
    );
  }

  if (!o.destinationId) {
    throw new Error(
      'Choisis un dossier destination.'
    );
  }

  if (
    o.action === 'move' &&
    String(o.sourceId) ===
      String(o.destinationId)
  ) {
    throw new Error(
      'Pour un déplacement simple, source et destination doivent être différents.'
    );
  }

  if (
    !o.types.length &&
    !Object.keys(
      o.extensionSet
    ).length
  ) {
    throw new Error(
      'Sélectionne au moins un type ou une extension.'
    );
  }
}


function cibleMoveV9_(
  state,
  category
) {
  if (
    state.options.action !==
    'sortByType'
  ) {
    return dossierV9_(
      state.destinationId
    );
  }

  state.targets =
    state.targets ||
    {};

  if (
    state.targets[category]
  ) {
    try {
      return dossierV9_(
        state.targets[category]
      );
    } catch (_) {
      delete state.targets[
        category
      ];
    }
  }

  const destination =
    dossierV9_(
      state.destinationId
    );

  const name =
    nomDossierCategorieV9_(
      category
    );

  const found =
    destination
      .getFoldersByName(
        name
      );

  let folder;

  if (
    found.hasNext()
  ) {
    folder =
      found.next();

  } else {
    folder =
      destination
        .createFolder(
          name
        );
  }

  state.targets[category] =
    folder.getId();

  sauvegarderEtatV9_(
    state
  );

  return folder;
}


function ignorerSousDossierMoveV9_(
  subId,
  subName,
  o
) {
  if (
    String(subId) ===
      String(o.destinationId) &&
    String(subId) !==
      String(o.sourceId)
  ) {
    return true;
  }

  if (
    o.action ===
      'sortByType' &&
    String(o.sourceId) ===
      String(o.destinationId) &&
    estDossierCategorieV9_(
      subName
    )
  ) {
    return true;
  }

  return false;
}


function ignorerSousDossierMoveEtatV9_(
  subId,
  subName,
  state
) {
  return ignorerSousDossierMoveV9_(
    subId,
    subName,
    {
      sourceId:
        state.sourceId,
      destinationId:
        state.destinationId,
      action:
        (state.options && state.options.action) || 'move'
    }
  );
}


/* =====================================================================
 * COPIE OPTIONS
 * ===================================================================== */

function normaliserCopyOptionsV9_(
  options
) {
  options =
    options ||
    {};

  return {
    sourceId:
      String(
        options.sourceId || ''
      ),

    destinationParentId:
      String(
        options.destinationParentId || ''
      ),

    createRootFolder:
      options.createRootFolder !==
      false,

    rootFolderName:
      String(
        options.rootFolderName || ''
      ).trim(),

    copySubfolders:
      options.copySubfolders !==
      false,

    includeActiveSpreadsheet:
      options.includeActiveSpreadsheet ===
      true
  };
}


function validerCopyOptionsV9_(
  o
) {
  if (!o.sourceId) {
    throw new Error(
      'Choisis le dossier source.'
    );
  }

  if (!o.destinationParentId) {
    throw new Error(
      'Choisis le dossier destination.'
    );
  }

  if (
    !o.createRootFolder &&
    String(o.sourceId) ===
      String(
        o.destinationParentId
      )
  ) {
    throw new Error(
      'La destination directe ne peut pas être le dossier source.'
    );
  }
}


/* =====================================================================
 * TYPES / EXTENSIONS
 * ===================================================================== */

function fichierCorrespondV9_(
  file,
  types,
  extensionSet
) {
  const category =
    categorieV9_(
      file
    );

  const ext =
    extensionV9_(
      file.getName()
    );

  if (
    types.indexOf(
      'ALL'
    ) !== -1
  ) {
    return true;
  }

  if (
    types.indexOf(
      category
    ) !== -1
  ) {
    return true;
  }

  if (
    ext &&
    extensionSet[ext]
  ) {
    return true;
  }

  return false;
}


function categorieV9_(
  file
) {
  const mime =
    String(
      file.getMimeType() ||
      ''
    ).toLowerCase();

  const ext =
    extensionV9_(
      file.getName()
    );

  if (
    mime ===
      'application/pdf' ||
    ext === 'pdf'
  ) {
    return 'PDF';
  }

  if (
    mime.indexOf(
      'image/'
    ) === 0 ||
    [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'heic',
      'heif',
      'bmp',
      'tif',
      'tiff',
      'svg'
    ].indexOf(ext) !== -1
  ) {
    return 'IMAGE';
  }

  if (
    mime.indexOf(
      'video/'
    ) === 0 ||
    [
      'mp4',
      'mov',
      'avi',
      'mkv',
      'wmv',
      'm4v',
      'webm'
    ].indexOf(ext) !== -1
  ) {
    return 'VIDEO';
  }

  if (
    mime.indexOf(
      'audio/'
    ) === 0 ||
    [
      'mp3',
      'wav',
      'flac',
      'aac',
      'm4a',
      'ogg',
      'wma'
    ].indexOf(ext) !== -1
  ) {
    return 'AUDIO';
  }

  if (
    mime ===
    'application/vnd.google-apps.document'
  ) {
    return 'GOOGLE_DOCS';
  }

  if (
    mime ===
    'application/vnd.google-apps.spreadsheet'
  ) {
    return 'GOOGLE_SHEETS';
  }

  if (
    mime ===
    'application/vnd.google-apps.presentation'
  ) {
    return 'GOOGLE_SLIDES';
  }

  if (
    mime.indexOf(
      'application/vnd.google-apps.'
    ) === 0
  ) {
    return 'GOOGLE_OTHER';
  }

  if (
    [
      'doc',
      'docx',
      'odt',
      'rtf'
    ].indexOf(ext) !== -1
  ) {
    return 'WORD';
  }

  if (
    [
      'xls',
      'xlsx',
      'xlsm',
      'xlsb',
      'ods',
      'csv'
    ].indexOf(ext) !== -1
  ) {
    return 'EXCEL';
  }

  if (
    [
      'ppt',
      'pptx',
      'odp'
    ].indexOf(ext) !== -1
  ) {
    return 'POWERPOINT';
  }

  if (
    [
      'zip',
      'rar',
      '7z',
      'tar',
      'gz',
      'bz2'
    ].indexOf(ext) !== -1
  ) {
    return 'ARCHIVE';
  }

  if (
    [
      'dwg',
      'dxf',
      'ifc',
      'rvt',
      'rfa',
      'skp',
      'pln'
    ].indexOf(ext) !== -1
  ) {
    return 'CAD_BIM';
  }

  if (
    [
      'eml',
      'msg'
    ].indexOf(ext) !== -1
  ) {
    return 'EMAIL';
  }

  if (
    !ext &&
    mime.indexOf(
      'application/vnd.google-apps.'
    ) !== 0
  ) {
    return 'NO_EXTENSION';
  }

  return 'OTHER';
}


function nomCategorieV9_(
  key
) {
  const map = {
    PDF: 'PDF',
    IMAGE: 'Image',
    VIDEO: 'Vidéo',
    AUDIO: 'Audio',
    WORD: 'Word',
    EXCEL: 'Excel / CSV',
    POWERPOINT: 'PowerPoint',
    ARCHIVE: 'Archive',
    CAD_BIM: 'CAO / BIM',
    EMAIL: 'E-mail',
    GOOGLE_DOCS: 'Google Docs',
    GOOGLE_SHEETS: 'Google Sheets',
    GOOGLE_SLIDES: 'Google Slides',
    GOOGLE_OTHER: 'Autre Google',
    NO_EXTENSION: 'Sans extension',
    OTHER: 'Autre'
  };

  return (
    map[key] ||
    'Autre'
  );
}


function nomDossierCategorieV9_(
  key
) {
  const map = {
    PDF: '01 - PDF',
    IMAGE: '02 - Images',
    VIDEO: '03 - Vidéos',
    AUDIO: '04 - Audio',
    WORD: '05 - Word',
    EXCEL: '06 - Excel',
    POWERPOINT: '07 - PowerPoint',
    GOOGLE_DOCS: '08 - Google Docs',
    GOOGLE_SHEETS: '09 - Google Sheets',
    GOOGLE_SLIDES: '10 - Google Slides',
    ARCHIVE: '11 - Archives',
    CAD_BIM: '12 - Plans CAO BIM',
    EMAIL: '13 - E-mails',
    GOOGLE_OTHER: '14 - Autres Google',
    NO_EXTENSION: '98 - Sans extension',
    OTHER: '99 - Autres'
  };

  return (
    map[key] ||
    '99 - Autres'
  );
}


function estDossierCategorieV9_(
  name
) {
  const names = [
    '01 - PDF',
    '02 - Images',
    '03 - Vidéos',
    '04 - Audio',
    '05 - Word',
    '06 - Excel',
    '07 - PowerPoint',
    '08 - Google Docs',
    '09 - Google Sheets',
    '10 - Google Slides',
    '11 - Archives',
    '12 - Plans CAO BIM',
    '13 - E-mails',
    '14 - Autres Google',
    '98 - Sans extension',
    '99 - Autres'
  ];

  return (
    names.indexOf(
      String(name || '')
    ) !== -1
  );
}



/* =====================================================================
 * RENOMMAGE EN MASSE
 * ===================================================================== */

function calculerNouveauNomV9_(
  oldName,
  prefix,
  suffix,
  searchText,
  replaceText
) {
  oldName = String(oldName || '');
  prefix = String(prefix || '');
  suffix = String(suffix || '');
  searchText = String(searchText || '');
  replaceText = String(replaceText || '');

  if (!oldName) return oldName;

  const dot = oldName.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < oldName.length - 1;

  let base = hasExtension
    ? oldName.substring(0, dot)
    : oldName;

  const ext = hasExtension
    ? oldName.substring(dot)
    : '';

  if (searchText) {
    base = base.split(searchText).join(replaceText);
  }

  return prefix + base + suffix + ext;
}


/* =====================================================================
 * STATUT / ARRÊT / REPRISE
 * ===================================================================== */

function getStatutV9() {
  const state =
    chargerEtatV9_();

  if (!state) {
    return {
      ok: true,
      exists: false,
      message:
        'Aucun travail V9 enregistré.'
    };
  }

  return {
    ok: true,
    exists: true,

    type:
      state.type || '',

    phase:
      state.phase || '',

    foldersDone:
      state.foldersDone || 0,

    scanned:
      state.scanned || 0,

    matched:
      state.matched || 0,

    acted:
      state.acted || 0,

    skipped:
      state.skipped || 0,

    errors:
      state.errors || 0,

    sourceName:
      state.sourceName || '',

    destinationName:
      state.destinationName || '',

    statusSheetName:
      state.statusSheetName || '',

    lastError:
      state.lastError || '',

    triggerError:
      PropertiesService
        .getUserProperties()
        .getProperty('GD9_TRIGGER_ERROR') || '',

    updatedAt:
      state.updatedAt || ''
  };
}


function afficherStatutV9() {
  const ui =
    SpreadsheetApp.getUi();

  const r =
    getStatutV9();

  if (!r.exists) {
    ui.alert(
      'V9',
      'Aucun travail V9 enregistré.',
      ui.ButtonSet.OK
    );
    return;
  }

  ui.alert(
    'Statut V9',
    'Type : ' +
      r.type +
      '\n' +
      'Phase : ' +
      r.phase +
      '\n' +
      'Dossiers traités : ' +
      r.foldersDone +
      '\n' +
      'Fichiers analysés : ' +
      r.scanned +
      '\n' +
      'Correspondants : ' +
      r.matched +
      '\n' +
      'Déplacés / copiés : ' +
      r.acted +
      '\n' +
      'Ignorés : ' +
      r.skipped +
      '\n' +
      'Erreurs : ' +
      r.errors +
      (
        r.lastError
          ? '\n\nDernière erreur : ' +
            r.lastError
          : ''
      ),
    ui.ButtonSet.OK
  );
}


function arreterJobV9() {
  const lock =
    LockService.getUserLock();

  lock.waitLock(30000);

  try {
    const state =
      chargerEtatV9_();

    if (!state) {
      return {
        ok: true,
        message:
          'Aucun travail V9 à arrêter.'
      };
    }

    state.phase =
      'STOPPED';

    state.updatedAt =
      new Date().toISOString();

    sauvegarderEtatV9_(
      state
    );

    supprimerDeclencheursV9_();

    majStatutV9_(
      state
    );

    return {
      ok: true,
      message:
        'Travail V9 arrêté. Aucun fichier n’a été supprimé.'
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };

  } finally {
    lock.releaseLock();
  }
}


function reprendreJobV9() {
  const lock =
    LockService.getUserLock();

  lock.waitLock(30000);

  try {
    const state =
      chargerEtatV9_();

    if (!state) {
      return {
        ok: false,
        error:
          'Aucun travail V9 à reprendre.'
      };
    }

    if (
      state.phase ===
      'DONE'
    ) {
      return {
        ok: false,
        error:
          'Ce travail est déjà terminé.'
      };
    }

    state.phase =
      state.type ===
        'DUP_SCAN' &&
      state.dupReportName
        ? 'DUP_GROUP'
        : 'RUNNING';

    state.lastError =
      '';

    state.updatedAt =
      new Date().toISOString();

    sauvegarderEtatV9_(
      state
    );

    supprimerDeclencheursV9_();
    programmerSuiteV9_();
    majStatutV9_(
      state
    );

    return {
      ok: true,
      message:
        'Reprise V9 programmée.'
    };

  } catch (e) {
    return {
      ok: false,
      error: erreurV9_(e)
    };

  } finally {
    lock.releaseLock();
  }
}


/* =====================================================================
 * MAJ STATUT
 * ===================================================================== */

function majStatutV9_(
  state
) {
  if (
    !state ||
    !state.spreadsheetId ||
    !state.statusSheetName
  ) {
    return;
  }

  const ss =
    SpreadsheetApp.openById(
      state.spreadsheetId
    );

  const sheet =
    ss.getSheetByName(
      state.statusSheetName
    );

  if (!sheet) {
    return;
  }

  sheet.getRange('B5:B15')
    .setValues([
      [state.type || ''],
      [state.phase || ''],
      [state.foldersDone || 0],
      [state.scanned || 0],
      [state.matched || 0],
      [state.acted || 0],
      [state.skipped || 0],
      [state.errors || 0],
      [new Date()],
      [state.lastError || ''],
      [state.jobId || '']
    ]);
}


/* =====================================================================
 * NETTOYAGE
 * ===================================================================== */

function nettoyerTechniqueV9() {
  const ui =
    SpreadsheetApp.getUi();

  const state =
    chargerEtatV9_();

  if (
    state &&
    (
      state.phase ===
        'RUNNING' ||
      state.phase ===
        'DUP_SORT' ||
      state.phase ===
        'DUP_GROUP'
    )
  ) {
    ui.alert(
      'V9',
      'Un travail est en cours. Arrête-le avant de nettoyer.',
      ui.ButtonSet.OK
    );
    return;
  }

  const answer =
    ui.alert(
      'Nettoyage V9',
      'Supprimer uniquement les feuilles techniques cachées _GD9_Q_ et _GD9_DUPDATA_ ?\n' +
      'Aucun fichier Google Drive ne sera supprimé.',
      ui.ButtonSet.YES_NO
    );

  if (
    answer !==
    ui.Button.YES
  ) {
    return;
  }

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();

  ss.getSheets()
    .forEach(
      function(sheet) {
        const name =
          sheet.getName();

        if (
          name.indexOf(
            TBX.QUEUE_PREFIX
          ) === 0 ||
          name.indexOf(
            TBX.DUPDATA_PREFIX
          ) === 0
        ) {
          ss.deleteSheet(
            sheet
          );
        }
      }
    );

  PropertiesService
    .getUserProperties()
    .deleteProperty(
      TBX.PROP_STATE
    );

  supprimerDeclencheursV9_();

  ui.alert(
    'V9',
    'Nettoyage terminé.',
    ui.ButtonSet.OK
  );
}


/* =====================================================================
 * ÉTAT / TRIGGERS
 * ===================================================================== */

function verifierAucunJobActifV9_() {
  const state =
    chargerEtatV9_();

  if (
    state &&
    state.phase &&
    [
      'RUNNING',
      'DUP_SORT',
      'DUP_GROUP'
    ].indexOf(
      state.phase
    ) !== -1
  ) {
    throw new Error(
      'Un autre travail V9 est déjà en cours. Arrête-le ou attends sa fin.'
    );
  }
}


function chargerEtatV9_() {
  const raw =
    PropertiesService
      .getUserProperties()
      .getProperty(
        TBX.PROP_STATE
      );

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(
      raw
    );

  } catch (_) {
    return null;
  }
}


function sauvegarderEtatV9_(
  state
) {
  PropertiesService
    .getUserProperties()
    .setProperty(
      TBX.PROP_STATE,
      JSON.stringify(
        state
      )
    );
}


function supprimerDeclencheursV9_() {
  ScriptApp
    .getProjectTriggers()
    .forEach(
      function(t) {
        if (
          t.getHandlerFunction() ===
          TBX.TRIGGER_FUNCTION
        ) {
          ScriptApp.deleteTrigger(
            t
          );
        }
      }
    );
}


function programmerSuiteV9_() {
  supprimerDeclencheursV9_();

  try {
    ScriptApp
      .newTrigger(
        TBX.TRIGGER_FUNCTION
      )
      .timeBased()
      .after(
        TBX.TRIGGER_DELAY_MS
      )
      .create();

    PropertiesService
      .getUserProperties()
      .deleteProperty('GD9_TRIGGER_ERROR');

    return true;

  } catch (e) {
    /*
     * Ne bloque PAS le travail si Google refuse temporairement
     * la création du déclencheur.
     * Le travail reste sauvegardé et peut être repris manuellement.
     */
    PropertiesService
      .getUserProperties()
      .setProperty(
        'GD9_TRIGGER_ERROR',
        erreurV9_(e)
      );

    return false;
  }
}


/* =====================================================================
 * FILES / SHEETS UTILITAIRES
 * ===================================================================== */

function ajouterQueueGenericV9_(
  sheet,
  rows
) {
  if (
    !rows ||
    !rows.length
  ) {
    return;
  }

  sheet.getRange(
    sheet.getLastRow() + 1,
    1,
    rows.length,
    6
  ).setValues(
    rows
  );
}


function ajouterQueueCopyV9_(
  sheet,
  rows
) {
  if (
    !rows ||
    !rows.length
  ) {
    return;
  }

  sheet.getRange(
    sheet.getLastRow() + 1,
    1,
    rows.length,
    7
  ).setValues(
    rows
  );
}


function dossierV9_(
  id
) {
  const root =
    DriveApp.getRootFolder();

  if (
    String(id) ===
    String(
      root.getId()
    )
  ) {
    return root;
  }

  return DriveApp.getFolderById(
    String(id)
  );
}


function nomDossierV9_(
  folder,
  id
) {
  try {
    return (
      String(id) ===
      String(
        DriveApp
          .getRootFolder()
          .getId()
      )
    )
      ? 'Mon Drive'
      : folder.getName();

  } catch (_) {
    return 'Dossier';
  }
}


function parentEstV9_(
  file,
  folderId
) {
  try {
    const parents =
      file.getParents();

    while (
      parents.hasNext()
    ) {
      if (
        String(
          parents.next()
            .getId()
        ) ===
        String(
          folderId
        )
      ) {
        return true;
      }
    }

  } catch (_) {}

  return false;
}


function nomFichierV9_(
  file
) {
  try {
    return (
      file.getName() ||
      'Fichier'
    );
  } catch (_) {
    return 'Fichier';
  }
}


function urlFichierV9_(
  file
) {
  try {
    return (
      file.getUrl() ||
      ''
    );
  } catch (_) {
    return '';
  }
}


function extensionV9_(
  name
) {
  name =
    String(
      name || ''
    );

  const pos =
    name.lastIndexOf('.');

  if (
    pos <= 0 ||
    pos ===
      name.length - 1
  ) {
    return '';
  }

  return name
    .substring(
      pos + 1
    )
    .toLowerCase();
}


function extensionsSetV9_(
  value
) {
  const set =
    Object.create(
      null
    );

  String(
    value || ''
  )
    .toLowerCase()
    .split(
      /[\s,;]+/
    )
    .map(
      function(x) {
        return x
          .replace(
            /^\./,
            ''
          )
          .trim();
      }
    )
    .filter(Boolean)
    .forEach(
      function(x) {
        set[x] =
          true;
      }
    );

  return set;
}


function normaliserNomDupV9_(
  name
) {
  return String(
    name || ''
  )
    .trim()
    .toLowerCase()
    .replace(
      /\s+/g,
      ' '
    );
}


function nouvelleFeuilleV9_(
  prefix
) {
  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();

  const stamp =
    Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'dd-MM-yyyy HH-mm-ss'
    );

  let base =
    (
      prefix +
      stamp
    ).substring(
      0,
      92
    );

  let name =
    base;

  let n =
    2;

  while (
    ss.getSheetByName(
      name
    )
  ) {
    name =
      (
        base.substring(
          0,
          85
        ) +
        ' (' +
        n++ +
        ')'
      ).substring(
        0,
        99
      );
  }

  return ss.insertSheet(
    name
  );
}


function sectionV9_(
  sheet,
  startRow,
  title,
  rows
) {
  sheet.getRange(
    startRow,
    1
  )
    .setValue(
      title
    )
    .setFontWeight(
      'bold'
    )
    .setFontSize(
      13
    )
    .setBackground(
      '#d9ead3'
    );

  startRow++;

  if (
    !rows ||
    !rows.length
  ) {
    return (
      startRow +
      2
    );
  }

  const width =
    Math.max.apply(
      null,
      rows.map(
        function(r) {
          return r.length;
        }
      )
    );

  const normalized =
    rows.map(
      function(r) {
        const copy =
          r.slice();

        while (
          copy.length <
          width
        ) {
          copy.push('');
        }

        return copy;
      }
    );

  sheet.getRange(
    startRow,
    1,
    normalized.length,
    width
  ).setValues(
    normalized
  );

  sheet.getRange(
    startRow,
    1,
    1,
    width
  )
    .setFontWeight(
      'bold'
    )
    .setBackground(
      '#eeeeee'
    );

  return (
    startRow +
    normalized.length +
    2
  );
}


function formatV9_(
  sheet
) {
  const rows =
    sheet.getLastRow();

  const cols =
    sheet.getLastColumn();

  if (
    !rows ||
    !cols
  ) {
    return;
  }

  sheet.getRange(
    1,
    1,
    rows,
    cols
  ).setVerticalAlignment(
    'middle'
  );

  const max =
    Math.min(
      cols,
      12
    );

  for (
    let c = 1;
    c <= max;
    c++
  ) {
    try {
      sheet.autoResizeColumn(
        c
      );

      if (
        sheet.getColumnWidth(
          c
        ) > 380
      ) {
        sheet.setColumnWidth(
          c,
          380
        );
      }

    } catch (_) {}
  }
}


function formatBytesV9_(
  bytes
) {
  bytes =
    Number(
      bytes
    ) || 0;

  if (!bytes) {
    return '0 o';
  }

  const units = [
    'o',
    'Ko',
    'Mo',
    'Go',
    'To',
    'Po'
  ];

  const index =
    Math.min(
      Math.floor(
        Math.log(
          bytes
        ) /
        Math.log(
          1024
        )
      ),
      units.length -
        1
    );

  return (
    (
      bytes /
      Math.pow(
        1024,
        index
      )
    ).toFixed(
      2
    ) +
    ' ' +
    units[index]
  );
}


function dateIsoV9_(
  d
) {
  if (!d) {
    return '';
  }

  return Utilities.formatDate(
    d,
    Session.getScriptTimeZone(),
    'dd/MM/yyyy HH:mm:ss'
  );
}


function idJobV9_() {
  return (
    Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'yyyyMMdd_HHmmss'
    ) +
    '_' +
    Math.floor(
      Math.random() *
        9000 +
        1000
    )
  );
}


function erreurV9_(
  e
) {
  if (!e) {
    return 'Erreur inconnue';
  }

  try {
    if (e.message) {
      return String(
        e.message
      );
    }

    return String(e);

  } catch (_) {
    return 'Erreur inconnue';
  }
}
