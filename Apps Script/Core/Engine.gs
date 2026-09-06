/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier     : Engine.gs
 * Version     : 1.0.0
 * Etat        : STABLE
 * Auteur      : Antonio + OpenAI
 * ======================================================================
 */

class GDMEngine {

  constructor() {

    this.task = null;
    this.running = false;
    this.startTime = null;
    this.endTime = null;

  }

  /**
   * Initialisation d'une tâche
   */
  start(task) {

    this.task = task;

    this.running = true;

    this.startTime = new Date();

    GDM_State.set("CURRENT_TASK", task);

    GDM_Logger.info(
      "ENGINE",
      "START",
      task.module
    );

    return true;

  }

  /**
   * Arrêt
   */
  stop() {

    this.running = false;

    this.endTime = new Date();

    GDM_Logger.info(
      "ENGINE",
      "STOP",
      this.task ? this.task.module : ""
    );

    GDM_State.remove("CURRENT_TASK");

  }

  /**
   * Pause
   */
  pause() {

    this.running = false;

    GDM_State.set("PAUSED", true);

    GDM_Logger.info(
      "ENGINE",
      "PAUSE",
      ""
    );

  }

  /**
   * Reprise
   */
  resume() {

    this.running = true;

    GDM_State.remove("PAUSED");

    GDM_Logger.info(
      "ENGINE",
      "RESUME",
      ""
    );

  }

  /**
   * Progression
   */
  progress(current, total) {

    const percent = total === 0
      ? 0
      : Math.round((current / total) * 100);

    GDM_State.set("PROGRESS", {

      current,

      total,

      percent

    });

    return percent;

  }

  /**
   * Etat
   */
  status() {

    return {

      running: this.running,

      task: this.task,

      started: this.startTime,

      ended: this.endTime,

      progress: GDM_State.get("PROGRESS", {})

    };

  }

}