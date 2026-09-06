/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier     : Queue.gs
 * Version     : 1.0.0
 * Etat        : STABLE
 * Dépendances : aucune
 * Utilisé par : Engine.gs
 * Auteur      : Antonio + OpenAI
 * ======================================================================
 */

class GDMQueue {

  constructor() {

    this.items = [];
    this.index = 0;

  }

  /**
   * Ajouter un élément
   */
  push(item) {

    this.items.push(item);

  }

  /**
   * Ajouter plusieurs éléments
   */
  pushMany(array) {

    if (!Array.isArray(array))
      return;

    for (const item of array) {

      this.items.push(item);

    }

  }

  /**
   * Lire le prochain élément
   */
  pop() {

    if (this.isEmpty())
      return null;

    const item = this.items[this.index];

    this.index++;

    // Libération mémoire automatique
    if (this.index >= 1000) {

      this.items = this.items.slice(this.index);

      this.index = 0;

    }

    return item;

  }

  /**
   * Voir le prochain élément sans le retirer
   */
  peek() {

    if (this.isEmpty())
      return null;

    return this.items[this.index];

  }

  /**
   * Nombre restant
   */
  remaining() {

    return this.items.length - this.index;

  }

  /**
   * Nombre total
   */
  total() {

    return this.items.length;

  }

  /**
   * File vide ?
   */
  isEmpty() {

    return this.remaining() <= 0;

  }

  /**
   * Réinitialisation
   */
  clear() {

    this.items = [];
    this.index = 0;

  }

  /**
   * Statistiques
   */
  stats() {

    return {

      total: this.total(),

      processed: this.index,

      remaining: this.remaining(),

      percent: this.total() === 0
        ? 100
        : Math.round((this.index / this.total()) * 100)

    };

  }

}