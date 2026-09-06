\# Google Drive Manager PRO



\# 01 - CORE



Version : 1.0.0



Auteur : Antonio Cernigliaro + OpenAI



Statut : En développement



\---



\# 1. Objectif



Le Core constitue le moteur principal de Google Drive Manager PRO.



Aucun module (Explorer, Analysis, Move, Copy...) ne doit contenir de logique technique qui appartient au Core.



Le Core est responsable de :



\- la configuration

\- les utilitaires

\- le journal

\- la sauvegarde de l'état

\- la file d'attente

\- le moteur d'exécution

\- l'initialisation

\- la gestion des erreurs



\---



\# 2. Architecture



Core



Config.gs



Utils.gs



Logger.gs



State.gs



Queue.gs



Engine.gs



Main.gs



\---



\# 3. Responsabilités



\## Config.gs



Contient toutes les constantes du logiciel.



Aucun autre fichier ne doit contenir de constantes.



\---



\## Utils.gs



Contient toutes les fonctions génériques :



\- formatage

\- conversions

\- dates

\- chaînes

\- tailles

\- identifiants

\- validation



Aucune logique métier.



\---



\## Logger.gs



Gestion centralisée des journaux.



Niveaux :



INFO



WARNING



ERROR



SUCCESS



Toutes les opérations passent par Logger.



\---



\## State.gs



Sauvegarde de la progression.



Permet de reprendre :



\- une analyse



\- une copie



\- un déplacement



\- un renommage



après interruption.



\---



\## Queue.gs



Gestion d'une file mémoire.



Doit être capable de gérer plusieurs centaines de milliers d'éléments.



La mémoire doit être libérée automatiquement.



\---



\## Engine.gs



Coordonne :



\- Scanner

\- Queue

\- Logger

\- State



Engine ne connaît jamais les modules.



Il exécute uniquement des tâches.



\---



\## Main.gs



Initialisation.



Menus.



Chargement.



Vérifications.



\---



\# 4. Règles



Le Core ne connaît jamais :



Explorer



Analysis



Move



Copy



Duplicate



Search



Rename



Archive



Le Core doit être totalement indépendant.



\---



\# 5. Objectifs



Le Core doit permettre :



✔ traitement de plusieurs millions de fichiers



✔ reprise automatique



✔ mémoire optimisée



✔ journal complet



✔ extensibilité



✔ maintenance simple



\---



\# 6. Version



Version actuelle :



1.0.0

