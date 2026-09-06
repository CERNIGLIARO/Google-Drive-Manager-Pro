/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier : Explorer.gs
 * Version : 1.0.0
 * ======================================================================
 */

const GDM_Explorer = {

  /**
   * Analyse un dossier
   */
  scan(folderId) {

    const folder = DriveApp.getFolderById(folderId);

    const result = {

      id: folder.getId(),

      name: folder.getName(),

      folders: 0,

      files: 0,

      size: 0,

      items: []

    };

    this.scanFolder(folder, result);

    return result;

  },

  /**
   * Analyse récursive
   */
  scanFolder(folder, result) {

    // Sous dossiers
    const folders = folder.getFolders();

    while (folders.hasNext()) {

      const sub = folders.next();

      result.folders++;

      result.items.push({

        type: "folder",

        id: sub.getId(),

        name: sub.getName()

      });

      this.scanFolder(sub, result);

    }

    // Fichiers
    const files = folder.getFiles();

    while (files.hasNext()) {

      const file = files.next();

      const size = Number(file.getSize());

      result.files++;

      result.size += size;

      result.items.push({

        type: "file",

        id: file.getId(),

        name: file.getName(),

        size: size,

        mime: file.getMimeType(),

        modified: file.getLastUpdated()

      });

    }

  },

  /**
   * Affiche un résumé
   */
  summary(folderId) {

    const r = this.scan(folderId);

    GDM_Logger.info(
      "EXPLORER",
      "SCAN",
      r.name
    );

    Logger.log("Dossier : " + r.name);
    Logger.log("Sous dossiers : " + r.folders);
    Logger.log("Fichiers : " + r.files);
    Logger.log("Taille : " + GDM_Utils.formatSize(r.size));

    return r;

  }

};