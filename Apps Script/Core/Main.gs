/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier     : Main.gs
 * Version     : 1.0.0
 * Etat        : STABLE
 * Dépendances : Config.gs
 * Utilisé par : Tous les modules
 * Auteur      : Antonio + OpenAI
 * ======================================================================
 */

const GDM_Main = {

  VERSION: GDM.VERSION,

  APP_NAME: GDM.NAME,

  /**
   * Initialisation
   */
  initialize() {

    GDM_Logger.info(
      "MAIN",
      "INITIALIZE",
      "Initialisation de Google Drive Manager PRO"
    );

  },

  /**
   * Vérification
   */
  checkEnvironment() {

    return {

      version: this.VERSION,

      timezone: Session.getScriptTimeZone(),

      user: Session.getActiveUser().getEmail()

    };

  }

};


/**
 * ======================================================================
 * MENU
 * ======================================================================
 */

function onOpen() {

  SpreadsheetApp.getUi()

    .createMenu("🚀 Google Drive Manager")

    .addItem(
      "📊 Analyse",
      "GDM_Menu_Analysis"
    )

    .addItem(
      "📂 Déplacer",
      "GDM_Menu_Move"
    )

    .addItem(
      "📄 Copier",
      "GDM_Menu_Copy"
    )

    .addItem(
      "🔁 Doublons",
      "GDM_Menu_Duplicate"
    )

    .addSeparator()

    .addItem(
      "⚙ Paramètres",
      "GDM_Menu_Settings"
    )

    .addSeparator()

    .addItem(
      "📋 Journal",
      "GDM_Menu_Log"
    )

    .addToUi();

}


/**
 * ======================================================================
 * MENUS
 * ======================================================================
 */

function GDM_Menu_Analysis() {

  SpreadsheetApp.getUi()

    .alert(

      "Module Analyse bientôt disponible."

    );

}


function GDM_Menu_Move() {

  SpreadsheetApp.getUi()

    .alert(

      "Module Déplacement bientôt disponible."

    );

}


function GDM_Menu_Copy() {

  SpreadsheetApp.getUi()

    .alert(

      "Module Copie bientôt disponible."

    );

}


function GDM_Menu_Duplicate() {

  SpreadsheetApp.getUi()

    .alert(

      "Module Doublons bientôt disponible."

    );

}


function GDM_Menu_Settings() {

  SpreadsheetApp.getUi()

    .alert(

      "Module Paramètres bientôt disponible."

    );

}


function GDM_Menu_Log() {

  SpreadsheetApp.getUi()

    .alert(

      "Journal disponible prochainement."

    );

}