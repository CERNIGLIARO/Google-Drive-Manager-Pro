# Changelog

## 2.2.0 — 2026-09-21

- suppression du doublon de maintenance/reset et conservation d'une seule implémentation canonique ;
- ajout d'un bouton **Récupérer** dans le Dashboard pour remettre en état un job interrompu ;
- auto-réparation des jobs orphelins dont la queue technique a disparu ;
- nettoyage automatique des anciens états, queues, logs et triggers orphelins ;
- copie rendue idempotente lors des reprises afin d'éviter les doublons de fichiers et sous-dossiers ;
- recherche dans un dossier rendue reprenable via continuation sérialisable ;
- recherche de dossiers vides découpée en lots reprenables et pagination automatique depuis le Dashboard ;
- version applicative portée à **2.2.0**.

