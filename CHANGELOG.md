# Changelog

## 2.3.0 — 2026-09-21

- **FAST ANALYSIS** : analyse des fichiers via Google Drive API v3 avancée ;
- jusqu'à 250 éléments lus par requête au lieu de multiples appels DriveApp par fichier ;
- récupération groupée de l'id, du nom, du type MIME, de la taille, de la date et des parents ;
- scan fichiers + sous-dossiers dans une seule page API ;
- pagination Drive API v3 et reprise automatique conservées ;
- détection des dossiers vides conservée sur plusieurs pages ;
- repli automatique vers l'ancien moteur DriveApp si l'API avancée est indisponible au démarrage ;
- service avancé Drive v3 activé dans `appsscript.json` ;
- version applicative portée à **2.3.0**.

## 2.2.0 — 2026-09-21

- suppression du doublon de maintenance/reset et conservation d'une seule implémentation canonique ;
- ajout d'un bouton **Récupérer** dans le Dashboard pour remettre en état un job interrompu ;
- auto-réparation des jobs orphelins dont la queue technique a disparu ;
- nettoyage automatique des anciens états, queues, logs et triggers orphelins ;
- copie rendue idempotente lors des reprises afin d'éviter les doublons de fichiers et sous-dossiers ;
- recherche dans un dossier rendue reprenable via continuation sérialisable ;
- recherche de dossiers vides découpée en lots reprenables et pagination automatique depuis le Dashboard ;
- version applicative portée à **2.2.0**.

