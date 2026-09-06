/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier     : Logger.gs
 * Version     : 1.0.0
 * Etat        : STABLE
 * Dépendances : Config.gs, Utils.gs
 * Utilisé par : Tous les modules
 * Auteur      : Antonio + OpenAI
 * ======================================================================
 */

const GDM_Logger = {

  /**
   * Retourne ou crée la feuille Journal
   */
  sheet() {

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    let sh = ss.getSheetByName(GDM.LOG_SHEET);

    if (!sh) {

      sh = ss.insertSheet(GDM.LOG_SHEET);

      sh.getRange(1,1,1,8).setValues([[
        "Date",
        "Niveau",
        "Module",
        "Action",
        "Objet",
        "Résultat",
        "Durée (ms)",
        "Message"
      ]]);

      sh.setFrozenRows(1);

      sh.getRange("A1:H1")
        .setBackground("#1F4E78")
        .setFontColor("white")
        .setFontWeight("bold");

      sh.setColumnWidths(1,8,140);

    }

    return sh;

  },

  /**
   * Ajoute une ligne dans le journal
   */
  write(level,module,action,object,result,duration,message){

    const sh=this.sheet();

    sh.appendRow([

      GDM_Utils.formatDate(new Date()),

      level,

      module,

      action,

      object,

      result,

      duration,

      message

    ]);

    this.cleanup();

  },

  /**
   * Information
   */
  info(module,action,message){

    this.write(

      "INFO",

      module,

      action,

      "",

      "OK",

      "",

      message

    );

  },

  /**
   * Succès
   */
  success(module,action,object,duration){

    this.write(

      "SUCCESS",

      module,

      action,

      object,

      "OK",

      duration,

      ""

    );

  },

  /**
   * Avertissement
   */
  warning(module,action,message){

    this.write(

      "WARNING",

      module,

      action,

      "",

      "",

      "",

      message

    );

  },

  /**
   * Erreur
   */
  error(module,action,error){

    this.write(

      "ERROR",

      module,

      action,

      "",

      "FAILED",

      "",

      String(error)

    );

  },

  /**
   * Nettoyage automatique
   */
  cleanup(){

    const sh=this.sheet();

    const rows=sh.getLastRow();

    if(rows<=GDM.MAX_LOG_LINES)
      return;

    const remove=rows-GDM.MAX_LOG_LINES;

    sh.deleteRows(2,remove);

  },

  /**
   * Vide complètement le journal
   */
  clear(){

    const sh=this.sheet();

    if(sh.getLastRow()>1){

      sh.deleteRows(2,sh.getLastRow()-1);

    }

  }

};