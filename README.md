# 🏴‍☠️ Valkyrie Auto-Raffle

Userscript qui inscrit automatiquement tes bets Stake dans les **raffles de Valkyrie Studio**.

Il lit passivement les bets que tu places pendant ta session, et dès qu'un bet correspond à une raffle active (bon jeu + multiplicateur atteint), il l'envoie tout seul. Chacun fait tourner le script sur **sa propre session** : tu n'envoies que tes propres bets, et Valkyrie crédite l'entrée au propriétaire du bet.

---

## 🚀 Installation

1. Installe l'extension **[Tampermonkey](https://www.tampermonkey.net/)** (Chrome, Firefox, Edge, Brave…).
2. Clique sur ce lien — Tampermonkey ouvrira la page d'installation :

   **➡️ [Installer / Mettre à jour le script](https://raw.githubusercontent.com/tournament-wct/valkyrie-auto-raffle/main/valkyrie-auto-raffle.user.js)**

3. Clique **Installer** dans Tampermonkey. C'est tout.
4. Va sur Stake, joue normalement : un petit panneau apparaît en bas à droite.

> Les mises à jour arrivent automatiquement : quand une nouvelle version est publiée, Tampermonkey te la propose (ou l'installe selon tes réglages).

---

## ⚙️ Comment ça marche

- Le script écoute le trafic que **ta** session Stake reçoit déjà (fetch / XHR / WebSocket) pour repérer les bets, y compris les slots tiers dont le résultat arrive par WebSocket.
- Il récupère la liste des **raffles actives** sur l'API publique de Valkyrie.
- Pour chaque bet, il compare le **jeu** et le **multiplicateur** aux raffles :
  - mode `min` → multiplicateur ≥ seuil
  - mode `max` → multiplicateur ≤ seuil
  - mode `exact` → multiplicateur = seuil
- Si ça correspond, il envoie le bet à Valkyrie. La décision finale (éligibilité, mise minimale en USD, timing) est **validée côté serveur Valkyrie** — le script se fie à sa réponse.
- Anti-doublon persistant + délai entre deux envois pour rester correct avec le serveur.

---

## 📊 Le panneau

| Indicateur | Signification |
|---|---|
| **Raffles actives** | Nombre de raffles en cours chez Valkyrie |
| **Jeu courant** | Le jeu détecté sur lequel tu joues |
| **Flux capté** | Compteur qui monte = la capture fonctionne (indicateur « c'est vivant ») |
| **Bets capturés** | Nombre de bets vus sur ta session |
| **Correspondances** | Bets qui collent à une raffle (bon jeu + multi) |
| **Entrés ✅** | Bets réellement inscrits dans une raffle |
| **Refusés ⛔** | Bets envoyés mais refusés par Valkyrie (avec la raison dans le journal) |

Dans le journal en bas du panneau, chaque envoi affiche clairement le résultat :

- `✅ ENTRÉ dans « … »` → le bet est dans la raffle
- `✅ Déjà dedans « … »` → il y était déjà
- `⛔ Refusé — « … » : <raison>` → pas rentré, avec le message exact de Valkyrie

Le panneau est déplaçable (glisse la barre du haut) et réductible (le « — » en haut à droite). Bouton **Pause** pour suspendre les envois à tout moment.

---

## 🔒 Vie privée & sécurité

- **Passif** : le script ne fait que **lire** ce que ta session reçoit déjà. Il ne demande jamais ton mot de passe et n'accède pas à ton compte.
- Il ne communique qu'avec **valkyriestudio.gg** (pour lire les raffles et y envoyer des IDs de bets). Rien d'autre ne sort.
- **Tes bets restent les tiens** : le script ne voit et n'envoie que ce qui passe par ta propre session, pas ceux des autres.
- Le code est **volontairement non minifié et lisible** — tu peux (et devrais) vérifier ce qu'il fait avant de l'installer.

---

## ⚠️ À savoir

- **Fragile aux changements de Stake** : si Stake modifie son API, la capture peut casser le temps qu'un correctif soit publié.
- **Passif = l'onglet doit être actif** : si l'onglet Stake est en veille, des bets peuvent être manqués. Le filet de sécurité reste l'export de fichier + le Raffle Automator pour réconcilier après coup.
- **Les gros seuils sont rares** : si une raffle demande 300x, les entrées seront rares par nature — c'est normal, le script attend qu'un vrai hit tombe.
- **Automatisation = zone grise vis-à-vis des CGU de Stake.** À utiliser en connaissance de cause, à tes risques.
- Projet **non affilié** à Stake ni à Valkyrie Studio.

---

## 🛠️ Configuration (optionnel)

En haut du fichier, quelques constantes ajustables :

- `SUBMIT_DELAY_MS` — délai entre deux envois (450 ms par défaut)
- `RAFFLE_REFRESH_MS` — fréquence de rafraîchissement des raffles (60 s)

---

## 🔄 Publier une mise à jour (pour le mainteneur)

1. Modifie le fichier `valkyrie-auto-raffle.user.js`.
2. **Incrémente `@version`** en haut (c'est ce qui déclenche la MAJ chez tout le monde).
3. Commit + push. Tampermonkey détecte la nouvelle version au prochain contrôle.
