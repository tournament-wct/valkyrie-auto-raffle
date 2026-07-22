# 🏴‍☠️ Valkyrie Auto-Raffle

Userscript qui inscrit automatiquement **tes** bets Stake dans les **raffles de Valkyrie Studio**.

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

- Le script écoute le trafic que **ta** session Stake reçoit déjà (fetch / XHR / WebSocket) pour repérer les bets — y compris les slots tiers dont le résultat arrive par WebSocket.
- Il récupère la liste des **raffles actives** sur l'API publique de Valkyrie et en déduit les **jeux à suivre**.
- Pour chaque bet, il vérifie **3 conditions** avant d'envoyer :
  1. **C'est ton bet** (pas celui d'un autre joueur vu dans un feed).
  2. **Le jeu a une raffle active** (les autres providers — Limbo, Dice… — sont ignorés).
  3. **Le multiplicateur correspond** :
     - mode `min` → multiplicateur ≥ seuil
     - mode `max` → multiplicateur ≤ seuil
     - mode `exact` → multiplicateur = seuil
- Si tout est bon, il envoie le bet à Valkyrie. La décision finale (éligibilité, mise minimale en USD, timing) est **validée côté serveur Valkyrie** — le script se fie à sa réponse.
- Anti-doublon persistant + délai entre deux envois pour rester correct avec le serveur.

---

## 📊 Le panneau

| Indicateur | Signification |
|---|---|
| **Raffles actives** | Nombre de raffles en cours chez Valkyrie |
| **Ton compte** | Ton pseudo, détecté depuis ta session (tant qu'il est « — », aucun filtrage par joueur) |
| **Jeu courant** | Le jeu **Valkyrie** détecté sur lequel tu joues |
| **Trafic réseau** | Tout le trafic vu passer (tes jeux, feeds des autres, chat…) — simple témoin « la capture est vivante » |
| **Bets capturés** | Tes bets retenus (jeux Valkyrie uniquement) |
| **Correspondances** | Bets qui collent à une raffle (bon jeu + multi) |
| **Entrés ✅** | Bets réellement inscrits dans une raffle |
| **Refusés ⛔** | Bets envoyés mais refusés par Valkyrie (raison dans le journal) |
| **Autres joueurs ⊘** | Bets d'autres joueurs (vus dans les feeds) ignorés |

**« Sur ce jeu, tu vises »** — pendant que tu joues un slot Valkyrie, le panneau liste en temps réel les raffles de ce jeu avec leur seuil (`≥ 300x`, `= 50x`, `≤ …`), pour voir direct ce que tu chasses.

Dans le journal, chaque envoi affiche clairement le résultat :

- `✅ ENTRÉ dans « … »` → le bet est dans la raffle
- `✅ Déjà dedans « … »` → il y était déjà
- `⛔ Refusé — « … » : <raison>` → pas rentré, avec le message exact de Valkyrie

---

## 🎛️ Les boutons du panneau

- **⏸ Pause / ▶ Reprendre** — suspend les envois à tout moment.
- **↺ Reset** — remet les compteurs à zéro (sans toucher à l'anti-doublon).
- **✍️ Saisie manuelle** — colle un bet id et choisis une raffle pour forcer un envoi (utile pour rattraper un bet manqué par la capture).
- **📋 Historique** — la liste de tes bets entrés (heure, raffle, jeu, multi, id), gardée entre les sessions.
- **📤 Exporter** — copie tout l'historique (JSON) dans le presse-papier.

Le panneau se déplace (glisse la barre du haut) et se réduit (le « — » en haut à droite). Quand un bet est réellement **entré**, une **notification navigateur + un petit son** te préviennent.

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
- **Les gros seuils sont rares** : si une raffle demande 300x, les entrées seront rares par nature — c'est normal, le script attend qu'un vrai hit tombe.
- **Automatisation = zone grise vis-à-vis des CGU de Stake.** À utiliser en connaissance de cause, à tes risques.
- Projet **non affilié** à Stake ni à Valkyrie Studio.

---

## 🛠️ Configuration

En haut du fichier, quelques constantes ajustables :

| Constante | Rôle | Défaut |
|---|---|---|
| `ONLY_VALKYRIE_GAMES` | Ne traiter que les jeux ayant une raffle active | `true` |
| `ONLY_OWN_BETS` | Ne traiter que tes bets (ignore ceux des autres) | `true` |
| `NOTIFY_ON_ENTRY` | Notif navigateur + son quand un bet est entré | `true` |
| `SUBMIT_DELAY_MS` | Délai entre deux envois | `450` |
| `RAFFLE_REFRESH_MS` | Fréquence de rafraîchissement des raffles | `60000` |

---

## 🔄 Publier une mise à jour (pour le mainteneur)

1. Modifie le fichier `valkyrie-auto-raffle.user.js`.
2. **Incrémente `@version`** en haut (c'est ce qui déclenche la MAJ chez tout le monde).
3. Commit + push. Tampermonkey détecte la nouvelle version au prochain contrôle.
