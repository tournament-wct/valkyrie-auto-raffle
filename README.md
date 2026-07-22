# 🏴‍☠️ Valkyrie Auto-Raffle

Userscript qui inscrit automatiquement **tes** bets Stake dans les **raffles de Valkyrie Studio** — et te prévient quand tu gagnes.

Il lit passivement les bets que tu places pendant ta session, et dès qu'un de **tes** bets correspond à une raffle active (bon jeu + multiplicateur atteint), il l'envoie tout seul. Chacun fait tourner le script sur **sa propre session** : tu n'envoies que tes propres bets, et Valkyrie crédite l'entrée au propriétaire du bet.

---

## 🚀 Installation

1. Installe l'extension **[Tampermonkey](https://www.tampermonkey.net/)** (Chrome, Firefox, Edge, Brave…).
2. Clique sur ce lien — Tampermonkey ouvrira la page d'installation :

   **➡️ [Installer / Mettre à jour le script](https://raw.githubusercontent.com/tournament-wct/valkyrie-auto-raffle/main/valkyrie-auto-raffle.user.js)**

3. Clique **Installer** dans Tampermonkey.
4. Va sur Stake, joue normalement : un petit panneau apparaît en bas à droite.

> Les mises à jour arrivent automatiquement : quand une nouvelle version est publiée, Tampermonkey te la propose (ou l'installe selon tes réglages).

---

## ⚙️ Comment ça marche

- Le script écoute le trafic que **ta** session Stake reçoit déjà (fetch / XHR / WebSocket) pour repérer les bets — y compris les slots tiers dont le résultat arrive par WebSocket, et **plusieurs slots en même temps**.
- Il récupère la liste des **raffles actives et tirées** sur l'API publique de Valkyrie.
- Pour chaque bet, il vérifie **3 conditions** avant d'envoyer :
  1. **C'est ton bet** (pas celui d'un autre joueur vu dans un feed).
  2. **Le jeu a une raffle active** (les autres providers — Limbo, Dice… — sont ignorés).
  3. **Le multiplicateur correspond** :
     - mode `min` → multiplicateur ≥ seuil
     - mode `max` → multiplicateur ≤ seuil
     - mode `exact` → multiplicateur = seuil
- Si tout est bon, il envoie le bet à Valkyrie. La décision finale (éligibilité, **mise minimale en USD**, timing) est **validée côté serveur Valkyrie** — le script se fie à sa réponse, et affiche la raison exacte en cas de refus.
- Il surveille aussi en continu : les **nouvelles raffles** qui apparaissent, et les **raffles tirées** pour vérifier si ton pseudo figure parmi les gagnants.
- Anti-doublon persistant (un bet définitivement refusé n'est pas re-tenté) + délai entre deux envois pour rester correct avec le serveur.

---

## 📊 Le panneau

| Indicateur | Signification |
|---|---|
| **Raffles actives** | Nombre de raffles en cours chez Valkyrie |
| **Ton compte** | Ton pseudo, détecté depuis ta session (tant qu'il est « — », aucun filtrage par joueur ni vérif de gains) |
| **Jeu courant** | Le(s) jeu(x) Valkyrie détecté(s) — affiche plusieurs slots si tu en lances plusieurs |
| **Trafic réseau** | Tout le trafic vu passer (tes jeux, feeds des autres, chat…) — simple témoin « la capture est vivante » |
| **Bets capturés** | Tes bets retenus (jeux Valkyrie uniquement) |
| **Correspondances** | Bets qui collent à une raffle (bon jeu + multi) |
| **Entrés ✅** | Bets réellement inscrits dans une raffle |
| **Refusés ⛔** | Bets envoyés mais refusés par Valkyrie (raison dans le journal) |
| **Autres joueurs ⊘** | Bets d'autres joueurs (vus dans les feeds) ignorés |

**« Sur ce jeu, tu vises »** — pendant que tu joues, le panneau liste les raffles du jeu en cours avec leur **seuil de multi ET leur mise minimale** (`≥ 300x · mise ≥ $3.00`). Un menu **« Voir »** juste au-dessus permet de filtrer l'affichage sur un slot précis.

Dans le journal, chaque envoi affiche clairement le résultat :

- `✅ ENTRÉ dans « … »` → le bet est dans la raffle
- `↔️ Déjà tenté « … »` → déjà soumis
- `⛔ Refusé — « … » : <raison>` → pas rentré, avec le message exact de Valkyrie (ex. mise trop basse)
- `🆕 Nouvelle raffle : « … »` → une raffle vient d'apparaître
- `🎉 GAGNÉ ! « … »` → tu es gagnant d'une raffle tirée

---

## 🔔 Les alertes

En plus du journal, trois événements déclenchent une **notification navigateur + un son** :

- **✅ Entrée confirmée** dans une raffle
- **🆕 Nouvelle raffle** qui apparaît (le tout premier chargement du script ne notifie jamais — seules les vraies nouveautés comptent, pour ne pas spammer au démarrage)
- **🎉 Gain** : dès qu'une raffle est tirée et que ton pseudo figure parmi les gagnants, avec le montant. Chaque raffle n'est vérifiée qu'une seule fois, donc pas de doublon au reload.

---

## 🎛️ Les commandes du panneau

- **⏻ (en-tête)** — interrupteur **on/off persistant** : coupe le script et il reste OFF même après un rechargement (à la différence de Pause, temporaire).
- **— (en-tête)** — réduit / déplie le panneau.
- **⏸ Pause / ▶ Reprendre** — suspend les envois pour la session en cours.
- **↺ Reset** — remet les compteurs de session à zéro (sans toucher à l'anti-doublon ni aux stats à vie).
- **🔊 / 🔉 / 🔇** — volume du son de notification (fort → bas → muet), retenu entre les sessions.
- **✍️ Manuel** — colle un bet id et choisis une raffle pour forcer un envoi (rattraper un bet manqué).
- **📋 Historique** — la liste de tes bets entrés (heure, raffle, jeu, multi, id), gardée entre les sessions. **Cliquer une ligne ouvre la page des raffles Valkyrie** dans un nouvel onglet. Bouton **📤 Exporter** pour tout copier (JSON) dans le presse-papier.
- **📈 À vie** — compteurs **persistants** d'entrées et de refus, avec la **répartition des refus** (mise trop basse / mauvais jeu / timing / autre).

Le panneau se **déplace depuis n'importe où** (sauf sur les boutons, le champ de saisie, le journal et l'historique, pour ne pas gêner les clics et la copie), et **retient sa position** entre les sessions.

---

## 🔒 Vie privée & sécurité

- **Passif** : le script ne fait que **lire** ce que ta session reçoit déjà. Il ne demande jamais ton mot de passe et n'accède pas à ton compte.
- **Tes bets uniquement** : même si l'interception voit passer les bets des autres joueurs (feeds), le script n'envoie **que les tiens**.
- Il ne communique qu'avec **valkyriestudio.gg** (lire les raffles, y envoyer des IDs de bets). Rien d'autre ne sort.
- Le code est **volontairement non minifié et lisible** — tu peux (et devrais) vérifier ce qu'il fait avant de l'installer.

---

## ⚠️ À savoir

- **Fragile aux changements de Stake** : si Stake modifie son API, la capture peut casser le temps qu'un correctif soit publié.
- **Passif = l'onglet doit être actif** : si l'onglet Stake est en veille, des bets peuvent être manqués. Astuce : ouvrir ton **historique de bets** sur Stake fait re-vérifier ces bets contre les raffles actives.
- **Mise minimale par raffle** : chaque raffle a sa propre mise mini en USD. Un bet en dessous est refusé, quel que soit le multiplicateur — la mise mini est affichée dans « Sur ce jeu, tu vises ».
- **Le clic sur l'historique ouvre la page générale des raffles**, pas un lien direct vers CETTE raffle précise (le format d'un tel lien n'est pas connu à ce jour).
- **Les gros seuils sont rares** : si une raffle demande 300x, les entrées seront rares par nature.
- **Automatisation = zone grise vis-à-vis des CGU de Stake.** À utiliser en connaissance de cause, à tes risques.
- Projet **non affilié** à Stake ni à Valkyrie Studio.

---

## 🛠️ Configuration

En haut du fichier, quelques constantes ajustables :

| Constante | Rôle | Défaut |
|---|---|---|
| `ONLY_VALKYRIE_GAMES` | Ne traiter que les jeux ayant une raffle active | `true` |
| `ONLY_OWN_BETS` | Ne traiter que tes bets (ignore ceux des autres) | `true` |
| `NOTIFY_ON_ENTRY` | Notif + son quand un bet est entré | `true` |
| `NOTIFY_NEW_RAFFLE` | Notif + son quand une nouvelle raffle apparaît | `true` |
| `NOTIFY_WINS` | Notif + son quand tu gagnes une raffle tirée | `true` |
| `SUBMIT_DELAY_MS` | Délai entre deux envois | `450` |
| `RAFFLE_REFRESH_MS` | Fréquence de rafraîchissement des raffles (active/tirées, nouvelles, gains) | `60000` |
| `RECENT_GAME_MS` | Durée pendant laquelle un slot reste « actif » (multi-slots) | `45000` |
| `VOL_LEVELS` | Crans du bouton volume (fort → bas → muet) | `[1, 0.35, 0]` |
| `RAFFLES_PAGE_URL` | Page ouverte au clic sur une ligne d'historique | `valkyriestudio.gg/raffles` |

Le volume, l'interrupteur on/off et la position du panneau se règlent directement depuis le panneau et sont **mémorisés automatiquement**.

---
