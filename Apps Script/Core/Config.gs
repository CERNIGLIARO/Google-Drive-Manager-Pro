/**
 * ======================================================================
 * Google Drive Manager PRO
 * ----------------------------------------------------------------------
 * Fichier : Config.gs
 * Version : 1.0.0
 * Auteur  : OpenAI + Antonio
 * ----------------------------------------------------------------------
 * Configuration globale du projet
 * ======================================================================
 */

const GDM = {

  VERSION: "1.0.0",

  NAME: "Google Drive Manager PRO",

  COMPANY: "CERNIGLIARO",

  DEBUG: true,

  DATE_FORMAT: "dd/MM/yyyy HH:mm:ss",

  TIMEZONE: Session.getScriptTimeZone(),

  LOG_SHEET: "Journal",

  ANALYSIS_SHEET: "Analyse",

  SETTINGS_SHEET: "Paramètres",

  MAX_BATCH_FILES: 500,

  MAX_BATCH_FOLDERS: 100,

  MAX_LOG_LINES: 50000,

  MAX_ERRORS: 1000,

  BUFFER_SIZE: 250,

  COLORS: {

    SUCCESS: "#34A853",

    ERROR: "#EA4335",

    WARNING: "#FBBC05",

    INFO: "#4285F4"

  },

  MIME: {

    PDF: "application/pdf",

    XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

    XLS: "application/vnd.ms-excel",

    DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

    DOC: "application/msword",

    ZIP: "application/zip",

    CSV: "text/csv",

    TXT: "text/plain",

    JPG: "image/jpeg",

    PNG: "image/png",

    GIF: "image/gif",

    MP4: "video/mp4",

    MP3: "audio/mpeg",

    GOOGLE_DOC: MimeType.GOOGLE_DOCS,

    GOOGLE_SHEET: MimeType.GOOGLE_SHEETS,

    GOOGLE_SLIDE: MimeType.GOOGLE_SLIDES,

    GOOGLE_FORM: MimeType.GOOGLE_FORMS

  },

  EXTENSIONS: {

    IMAGE: ["jpg","jpeg","png","gif","bmp","webp"],

    VIDEO: ["mp4","avi","mov","mkv","wmv"],

    AUDIO: ["mp3","wav","flac","aac"],

    PDF: ["pdf"],

    ZIP: ["zip","rar","7z"],

    OFFICE: [

      "doc","docx",

      "xls","xlsx",

      "ppt","pptx",

      "csv"

    ]

  }

};