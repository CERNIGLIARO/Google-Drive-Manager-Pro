/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier     : State.gs
 * Version     : 1.0.0
 * Etat        : STABLE
 * Dépendances : Config.gs
 * Utilisé par : Tous les modules
 * Auteur      : Antonio + OpenAI
 * ======================================================================
 */

const GDM_State = {

  PREFIX: "GDM_",


  /**
   * Sauvegarde une valeur
   */
  set(key, value) {

    PropertiesService
      .getScriptProperties()
      .setProperty(
        this.PREFIX + key,
        JSON.stringify(value)
      );

  },


  /**
   * Lecture d'une valeur
   */
  get(key, defaultValue = null) {

    const value = PropertiesService
      .getScriptProperties()
      .getProperty(
        this.PREFIX + key
      );

    if (!value)
      return defaultValue;

    try {

      return JSON.parse(value);

    } catch (e) {

      return defaultValue;

    }

  },


  /**
   * Supprime une valeur
   */
  remove(key) {

    PropertiesService
      .getScriptProperties()
      .deleteProperty(
        this.PREFIX + key
      );

  },


  /**
   * Teste si une clé existe
   */
  exists(key) {

    return PropertiesService
      .getScriptProperties()
      .getProperty(
        this.PREFIX + key
      ) !== null;

  },


  /**
   * Retourne toutes les valeurs GDM
   */
  all() {

    const props = PropertiesService
      .getScriptProperties()
      .getProperties();

    const result = {};

    Object.keys(props).forEach(k => {

      if (k.startsWith(this.PREFIX)) {

        result[k] = JSON.parse(props[k]);

      }

    });

    return result;

  },


  /**
   * Nettoyage complet
   */
  clear() {

    const props = PropertiesService
      .getScriptProperties()
      .getProperties();

    Object.keys(props).forEach(k => {

      if (k.startsWith(this.PREFIX)) {

        PropertiesService
          .getScriptProperties()
          .deleteProperty(k);

      }

    });

  }

};