/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier     : Utils.gs
 * Version     : 1.0.0
 * Etat        : STABLE
 * Dépendances : Config.gs
 * Utilisé par : Tous les modules
 * Auteur      : Antonio + OpenAI
 * ======================================================================
 */

const GDM_Utils = {

  /**
   * Retourne la date actuelle
   */
  now() {
    return new Date();
  },

  /**
   * Formate une date
   */
  formatDate(date) {

    if (!date) return "";

    return Utilities.formatDate(
      new Date(date),
      GDM.TIMEZONE,
      GDM.DATE_FORMAT
    );

  },

  /**
   * Convertit une taille en texte lisible
   */
  formatSize(bytes) {

    bytes = Number(bytes || 0);

    if (bytes < 1024)
      return bytes + " o";

    if (bytes < 1024 * 1024)
      return (bytes / 1024).toFixed(2) + " Ko";

    if (bytes < 1024 * 1024 * 1024)
      return (bytes / 1024 / 1024).toFixed(2) + " Mo";

    if (bytes < 1024 * 1024 * 1024 * 1024)
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + " Go";

    return (bytes / 1024 / 1024 / 1024 / 1024).toFixed(2) + " To";

  },

  /**
   * Retourne l'extension
   */
  extension(filename) {

    if (!filename)
      return "";

    const pos = filename.lastIndexOf(".");

    if (pos < 0)
      return "";

    return filename.substring(pos + 1).toLowerCase();

  },

  /**
   * Nom sans extension
   */
  baseName(filename) {

    if (!filename)
      return "";

    const pos = filename.lastIndexOf(".");

    if (pos < 0)
      return filename;

    return filename.substring(0, pos);

  },

  /**
   * Vérifie si une valeur est vide
   */
  isEmpty(value) {

    return (
      value === null ||
      value === undefined ||
      value === ""
    );

  },

  /**
   * Génère un identifiant
   */
  uuid() {

    return Utilities.getUuid();

  },

  /**
   * Pause
   */
  sleep(ms) {

    Utilities.sleep(ms);

  },

  /**
   * Journal console
   */
  log(message) {

    if (GDM.DEBUG) {

      Logger.log(message);

    }

  },

  /**
   * Tronque un texte
   */
  truncate(text, max) {

    if (!text)
      return "";

    if (text.length <= max)
      return text;

    return text.substring(0, max) + "...";

  },

  /**
   * Nombre aléatoire
   */
  random(min, max) {

    return Math.floor(
      Math.random() * (max - min + 1)
    ) + min;

  },

  /**
   * Vérifie une extension
   */
  hasExtension(filename, extensions) {

    const ext = this.extension(filename);

    return extensions.indexOf(ext) >= 0;

  }

};