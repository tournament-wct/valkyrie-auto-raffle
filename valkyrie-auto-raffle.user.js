// ==UserScript==
// @name         Valkyrie Auto-Raffle (Stake → Valkyrie Studio)
// @namespace    oracle-labs.valkyrie
// @version      1.8.1
// @description  Capture les bets de ta session Stake et, quand le jeu + le multiplicateur correspondent à une raffle Valkyrie Studio, envoie automatiquement le bet dans la raffle.
// @author       Oracle Labs
// @match        https://stake.com/*
// @match        https://stake.bet/*
// @match        https://stake.games/*
// @match        https://stake.us/*
// @include      /^https?:\/\/(www\.)?stake\.[a-z.]+\/.*/
// @connect      valkyriestudio.gg
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_setClipboard
// @run-at       document-start
// @noframes
// @updateURL    https://raw.githubusercontent.com/tournament-wct/valkyrie-auto-raffle/main/valkyrie-auto-raffle.user.js
// @downloadURL  https://raw.githubusercontent.com/tournament-wct/valkyrie-auto-raffle/main/valkyrie-auto-raffle.user.js
// ==/UserScript==
//
// Ce script est PASSIF : il lit uniquement ce que ta propre session Stake reçoit déjà
// dans le navigateur (aucun mot de passe, aucun accès au compte). Il poste ensuite les
// IDs de bets à l'API publique de Valkyrie Studio, exactement comme le fait le Raffle
// Automator. Chaque personne fait tourner le script sur SA session : chacun n'envoie
// que ses propres bets, et Valkyrie crédite l'entrée au propriétaire du bet.

(function () {
  "use strict";

  /* ======================= CONFIG ======================= */

  const VALKYRIE_BASE = "https://valkyriestudio.gg";
  const RAFFLES_API = VALKYRIE_BASE + "/api/raffles";
  const ENTER_API = VALKYRIE_BASE + "/api/raffles/enter";

  const SUBMIT_DELAY_MS = 450;
  const RAFFLE_REFRESH_MS = 60000;
  const ONLY_VALKYRIE_GAMES = true; // ne traiter que les bets dont le jeu a une raffle active
  const ONLY_OWN_BETS = true;       // ne traiter que TES bets (ignore ceux des autres joueurs vus dans les feeds)
  const NOTIFY_ON_ENTRY = true;     // notif navigateur + son quand un bet est ENTRÉ
  const RECENT_GAME_MS = 45000;     // durée pendant laquelle un jeu reste "actif" (gère plusieurs slots à la fois)
  const RAFFLES_PAGE_URL = "https://valkyriestudio.gg/raffles"; // page publique (format des liens par raffle inconnu)
  const NOTIFY_NEW_RAFFLE = true;   // alerte quand une nouvelle raffle apparaît
  const NOTIFY_WINS = true;         // alerte quand une raffle où tu es entré est tirée et que tu gagnes
  // Champs présents uniquement sur TON user (pas sur les users publics des feeds) : sert à détecter ton compte.
  const SELF_MARKERS = ["email", "balances", "vaultBalances", "vaultBalance", "kycStatus", "mfaEnabled", "hasVerifiedEmail", "activeClientSeed", "sessionCount"];
  const LOG_PREFIX = "[Valkyrie AR]";
  const SENT_STORE_KEY = "valk_sent_pairs_v1";
  const ENTRY_LOG_KEY = "valk_entries_v1";
  const MSG_MARK = "__valk_payload__";

  /* ======================= ÉTAT ======================= */

  let activeRaffles = [];
  let drawnRaffles = [];
  let targetGames = new Set(); // noms de jeux (normalisés) ayant une raffle active
  let knownRaffleIds = new Set(); // pour détecter les NOUVELLES raffles
  let firstRaffleLoad = true;
  let notifiedWinIds = new Set(); // raffles déjà vérifiées pour un gain (évite de re-notifier)
  try { knownRaffleIds = new Set(GM_getValue("valk_known_raffles", [])); } catch (e) {}
  try { notifiedWinIds = new Set(GM_getValue("valk_notified_wins", [])); } catch (e) {}
  function saveKnownRaffles() { try { GM_setValue("valk_known_raffles", [...knownRaffleIds]); } catch (e) {} }
  function saveNotifiedWins() { try { GM_setValue("valk_notified_wins", [...notifiedWinIds]); } catch (e) {} }
  const seenBets = new Map();
  const submitQueue = [];
  let queueRunning = false;
  let paused = false;
  const recentGames = new Map(); // normName -> { name, slug, t } : jeux Valkyrie actifs récemment
  let myUsername = null; // détecté depuis ta session ; null = pas encore connu (on ne filtre pas)

  const VOL_LEVELS = [1, 0.35, 0]; // fort → bas → muet
  let notifVolume = 1;
  try { const v = GM_getValue("valk_notif_vol", 1); if (typeof v === "number") notifVolume = v; } catch (e) {}
  function volIcon(v) { return v >= 1 ? "🔊" : v > 0 ? "🔉" : "🔇"; }

  let enabled = true;
  try { enabled = GM_getValue("valk_enabled", true) !== false; } catch (e) {}
  let viewFilter = null; // null = jeux actifs ; sinon nom normalisé d'un jeu à afficher

  let life = { entered: 0, refused: 0, reasons: { miseBasse: 0, mauvaisJeu: 0, timing: 0, autre: 0 } };
  try {
    const l = GM_getValue("valk_life", null);
    if (l && typeof l === "object") {
      life.entered = l.entered || 0; life.refused = l.refused || 0;
      if (l.reasons) for (const k in life.reasons) life.reasons[k] = l.reasons[k] || 0;
    }
  } catch (e) {}
  function saveLife() { try { GM_setValue("valk_life", life); } catch (e) {} }

  // Range un motif de refus dans une catégorie lisible.
  function categorizeRefusal(reason) {
    const s = String(reason || "").toLowerCase();
    if (/at least|needs at least|too small|too low|minimum|\bmise\b/.test(s)) return "miseBasse";
    if (/isn'?t on|not on|wrong game|pas sur/.test(s)) return "mauvaisJeu";
    if (/ended|expired|closed|not started|window|too late|too early|no longer|has ended/.test(s)) return "timing";
    return "autre";
  }

  const stats = { payloads: 0, captured: 0, matched: 0, sent: 0, conflict: 0, failed: 0, foreign: 0, unknownGame: 0 };

  let sentPairs = new Set();
  try { sentPairs = new Set(JSON.parse(GM_getValue(SENT_STORE_KEY, "[]"))); } catch (e) { sentPairs = new Set(); }
  function rememberPair(key) {
    sentPairs.add(key);
    if (sentPairs.size > 5000) sentPairs = new Set([...sentPairs].slice(-3000));
    try { GM_setValue(SENT_STORE_KEY, JSON.stringify([...sentPairs])); } catch (e) {}
  }

  let entries = [];
  try { entries = JSON.parse(GM_getValue(ENTRY_LOG_KEY, "[]")); } catch (e) { entries = []; }
  function recordEntry(o) {
    entries.unshift(o);
    if (entries.length > 500) entries.length = 500;
    try { GM_setValue(ENTRY_LOG_KEY, JSON.stringify(entries)); } catch (e) {}
    renderHistory();
  }

  /* ======================= RÉSEAU (cross-origin via GM) ======================= */

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: "GET", url, headers: { Accept: "application/json" },
        onload: resolve, onerror: reject, ontimeout: () => reject(new Error("timeout")) });
    });
  }
  function gmPost(url, bodyObj) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: "POST", url,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        data: JSON.stringify(bodyObj),
        onload: resolve, onerror: reject, ontimeout: () => reject(new Error("timeout")) });
    });
  }

  /* ======================= RAFFLES ACTIVES ======================= */

  async function loadActiveRaffles() {
    try {
      const r = await gmGet(RAFFLES_API);
      const data = JSON.parse(r.responseText);
      const list = Array.isArray(data) ? data : data.raffles || [];
      activeRaffles = list.filter((x) => (x.status || "active") === "active");
      drawnRaffles = list.filter((x) => x.status === "drawn");
      targetGames = new Set(activeRaffles.map((r) => norm(r.gameName)).filter(Boolean));
      log(`✅ ${activeRaffles.length} raffle(s) active(s) — ${targetGames.size} jeu(x) suivis.`);

      // Alerte "nouvelle raffle" : on ignore le tout premier chargement pour ne pas spammer
      // toutes les raffles déjà en cours au démarrage — seules les VRAIES nouvelles notifient.
      if (NOTIFY_NEW_RAFFLE) {
        const newOnes = activeRaffles.filter((x) => !knownRaffleIds.has(x.id));
        if (!firstRaffleLoad) {
          for (const nr of newOnes) {
            log(`🆕 Nouvelle raffle : « ${nr.name} » — ${nr.gameName} ${modeSymbol(nr)} ${nr.multiplierValue}x`);
            try {
              GM_notification({ title: "🆕 Nouvelle raffle Valkyrie !", text: `${nr.name}\n${nr.gameName} ${modeSymbol(nr)} ${nr.multiplierValue}x`, timeout: 9000 });
            } catch (e) {}
            beep();
          }
        }
        for (const x of list) knownRaffleIds.add(x.id);
        saveKnownRaffles();
      }
      firstRaffleLoad = false;

      checkWins();
      updatePanel();
      renderHunting();
      populateManualRaffles();
      populateViewMenu();
    } catch (e) {
      log("⚠️ Impossible de charger les raffles Valkyrie : " + (e.message || e));
    }
  }

  // Vérifie si l'une de tes entrées a gagné, en comparant les gagnants des raffles tirées
  // à ton pseudo détecté. On ne re-vérifie jamais deux fois la même raffle une fois traitée.
  function checkWins() {
    if (!NOTIFY_WINS || !myUsername || !drawnRaffles.length) return;
    const my = norm(myUsername);
    for (const raffle of drawnRaffles) {
      if (notifiedWinIds.has(raffle.id)) continue;
      notifiedWinIds.add(raffle.id);
      const winners = raffle.winners || [];
      const won = winners.filter((w) => norm(w.user) === my);
      if (won.length) {
        for (const w of won) {
          const payout = w.payout != null ? `$${Number(w.payout).toFixed(2)}` : "";
          log(`🎉 GAGNÉ ! « ${raffle.name} » — ${payout}`);
          try {
            GM_notification({ title: "🎉 Tu as gagné une raffle Valkyrie !", text: `${raffle.name}\n${payout}`.trim(), timeout: 12000 });
          } catch (e) {}
          beep();
        }
      }
    }
    saveNotifiedWins();
  }

  /* ======================= EXTRACTION DES BETS ======================= */

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function isTargetGame(name) { return !!name && targetGames.has(norm(name)); }

  // --- Gestion de plusieurs slots à la fois : on garde une fenêtre glissante de jeux actifs
  // (pour l'AFFICHAGE uniquement). Le jeu de "secours" utilisé pour attribuer un bet sans nom
  // de jeu, lui, NE PÉRIME PAS : certains jeux n'envoient leur nom qu'une fois au chargement,
  // pas à chaque tour — le périmer trop vite ferait ignorer silencieusement de vrais bets.
  // Valkyrie reste de toute façon juge final (elle rejette un bet mal attribué), donc mieux
  // vaut deviner large que rater une entrée légitime.
  let lastKnownGame = null;

  function pruneGames() {
    const cutoff = Date.now() - RECENT_GAME_MS;
    let changed = false;
    for (const [k, v] of recentGames) if (v.t < cutoff) { recentGames.delete(k); changed = true; }
    return changed;
  }
  function touchGame(g) {
    // Toujours mis à jour, quel que soit le jeu et même si les raffles ne sont pas encore
    // chargées : c'est ce qui sert de secours pour attribuer un bet sans nom de jeu. Un jeu
    // hors Valkyrie (Limbo…) attribué à un bet sera de toute façon filtré juste après par
    // isTargetGame — donc pas de risque à le retenir largement.
    lastKnownGame = { name: g.name, slug: g.slug || null };
  }
  function touchDisplayGame(g) {
    // Version filtrée, pour l'AFFICHAGE uniquement (n'affiche jamais un jeu hors Valkyrie).
    const key = norm(g.name);
    const existed = recentGames.has(key);
    recentGames.set(key, { name: g.name, slug: g.slug || null, t: Date.now() });
    const pruned = pruneGames();
    return !existed || pruned;
  }
  function activeGames() {
    pruneGames();
    return [...recentGames.values()].sort((a, b) => b.t - a.t);
  }
  function mostRecentGameName() {
    return lastKnownGame ? lastKnownGame.name : null;
  }

  function findGameContext(node, depth) {
    if (!node || typeof node !== "object" || depth > 7) return null;
    if (Array.isArray(node)) {
      for (const it of node) { const g = findGameContext(it, depth + 1); if (g) return g; }
      return null;
    }
    if (node.game && typeof node.game === "object" && node.game.name) {
      return { name: String(node.game.name), slug: node.game.slug ? String(node.game.slug) : null };
    }
    if (node.name && node.slug && (String(node.__typename || "").toLowerCase().indexOf("game") !== -1 || node.edge != null)) {
      return { name: String(node.name), slug: String(node.slug) };
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") { const g = findGameContext(v, depth + 1); if (g) return g; }
    }
    return null;
  }

  // Détecte TON compte : cherche un objet "user" qui porte des champs privés (solde, email…)
  // que seul ton propre user expose — jamais les users publics affichés dans les feeds.
  function detectSelf(node, depth) {
    if (!node || typeof node !== "object" || depth > 7) return null;
    if (Array.isArray(node)) {
      for (const it of node) { const s = detectSelf(it, depth + 1); if (s) return s; }
      return null;
    }
    const hasMarker = SELF_MARKERS.some((m) => m in node);
    if (hasMarker && typeof node.name === "string" && node.name) return node.name;
    if (node.user && typeof node.user === "object" && typeof node.user.name === "string" &&
        SELF_MARKERS.some((m) => m in node.user)) return node.user.name;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") { const s = detectSelf(v, depth + 1); if (s) return s; }
    }
    return null;
  }

  function looksLikeBetId(v) { return typeof v === "string" && /^(casino|sports|house|ext|sport):/i.test(v); }

  function pickBetInput(node, parent) {
    if (looksLikeBetId(node.iid)) return node.iid;
    for (const k in node) if (looksLikeBetId(node[k])) return node[k];
    if (parent) {
      if (looksLikeBetId(parent.iid)) return parent.iid;
      if (looksLikeBetId(parent.id)) return parent.id;
      for (const k in parent) if (looksLikeBetId(parent[k])) return parent[k];
    }
    if (node.iid != null) return String(node.iid);
    if (parent && parent.iid != null) return String(parent.iid);
    return null;
  }

  function extractBets(node, out, depth, parent) {
    if (!node || typeof node !== "object" || depth > 7) return;
    if (Array.isArray(node)) { for (const it of node) extractBets(it, out, depth + 1, parent); return; }

    const hasId = node.id != null || node.iid != null || node.betId != null;
    const mult = node.payoutMultiplier != null ? node.payoutMultiplier
               : node.multiplier != null ? node.multiplier : null;

    if (hasId && mult != null) {
      const game =
        (node.game && (node.game.name || node.game.title || node.game.slug)) ||
        node.gameName || node.gameTitle || (typeof node.game === "string" ? node.game : null);
      const uuid = String(node.id != null ? node.id : node.iid != null ? node.iid : node.betId);
      const user =
        (node.user && (node.user.name || node.user.username)) ||
        node.username || (parent && parent.user && (parent.user.name || parent.user.username)) || null;
      out.push({
        id: uuid,
        betInput: pickBetInput(node, parent) || uuid,
        user: user ? String(user) : null,
        game: game ? String(game) : null,
        multiplier: Number(mult),
        amount: node.amount != null ? Number(node.amount) : null,
        currency: node.currency || node.currencyName || null,
      });
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") extractBets(v, out, depth + 1, node);
    }
  }

  function processPayload(obj, url) {
    if (!obj || typeof obj !== "object") return;

    if (!myUsername) {
      const self = detectSelf(obj, 0);
      if (self) { myUsername = self; log(`👤 Compte détecté : ${myUsername} — seuls tes bets seront traités.`); updatePanel(); }
    }

    const g = findGameContext(obj, 0);
    if (g && g.name) {
      touchGame(g); // attribution : toujours à jour, quel que soit le jeu
      // Affichage ("jeu courant" / "tu chasses") : uniquement les jeux Valkyrie, pour ne pas
      // montrer un jeu hors sujet (Limbo, Dice…) qui prêterait à confusion.
      const gameRelevant = !ONLY_VALKYRIE_GAMES || isTargetGame(g.name);
      if (gameRelevant && touchDisplayGame(g)) {
        updatePanel();
        renderHunting();
      }
    }

    const found = [];
    extractBets(obj, found, 0, null);

    // Détection "liste de bets" (historique) : brique pour le futur rattrapage auto.
    // Ces bets passent par handleBet() → donc ouvrir ton historique Stake les re-vérifie déjà.
    if (found.length >= 4) {
      const onTarget = found.filter((b) => isTargetGame(b.game || (currentGame && currentGame.name))).length;
      log(`🔁 Liste de ${found.length} bets re-scannée (${onTarget} sur jeu(x) suivi(s)).`);
    }

    for (const bet of found) handleBet(bet);
  }

  function handleBet(bet) {
    if (!bet.id) return;
    if (!bet.game) { const rg = mostRecentGameName(); if (rg) bet.game = rg; }

    // Filtre "Valkyrie uniquement" : on ignore tout jeu sans raffle active.
    // (pas de garde sur targetGames.size : tant que les raffles ne sont pas chargées,
    //  rien n'est envoyable de toute façon, donc on peut ignorer sans risque.)
    if (ONLY_VALKYRIE_GAMES && !isTargetGame(bet.game)) {
      // Jeu totalement inconnu (jamais vu de contexte) : on le signale, car c'est le seul
      // cas où un bet légitime pourrait passer à la trappe silencieusement.
      if (!bet.game) {
        stats.unknownGame++;
        if (stats.unknownGame <= 5 || stats.unknownGame % 20 === 0) {
          log(`❓ Bet ignoré : jeu inconnu (aucun contexte de jeu détecté pour l'instant).`);
        }
        updatePanel();
      }
      return;
    }

    // Filtre "tes bets uniquement" : on ignore les bets attribués à un autre joueur
    // (vus dans les feeds). Tant que ton compte n'est pas connu, on ne bloque rien.
    if (ONLY_OWN_BETS && myUsername && bet.user && norm(bet.user) !== norm(myUsername)) {
      stats.foreign++;
      updatePanel();
      return;
    }

    const prev = seenBets.get(bet.id);
    const isNew = !prev;
    const multiResolved = prev && (prev.multiplier === 0 || prev.multiplier == null) && bet.multiplier > 0;
    if (!isNew && !multiResolved) {
      if (prev && !prev.game && bet.game) prev.game = bet.game;
      return;
    }

    seenBets.set(bet.id, bet);
    if (isNew) stats.captured++;
    considerBet(bet);
    updatePanel();
  }

  /* ======================= MATCHING + ENVOI ======================= */

  function matchesRaffle(bet, raffle) {
    const bg = norm(bet.game), rg = norm(raffle.gameName);
    if (!bg || !rg || bg !== rg) return false;
    if (bet.multiplier == null || isNaN(bet.multiplier)) return false;
    const th = raffle.multiplierValue;
    const mode = raffle.multiplierMode || "min";
    if (mode === "max") return bet.multiplier <= th;
    if (mode === "exact") return Math.abs(bet.multiplier - th) < 1e-9;
    return bet.multiplier >= th;
  }

  function considerBet(bet) {
    if (!enabled) return; // interrupteur persistant OFF : on ne soumet rien
    for (const raffle of activeRaffles) {
      if (!matchesRaffle(bet, raffle)) continue;
      const key = bet.id + "|" + raffle.id;
      if (sentPairs.has(key)) continue;
      stats.matched++;
      submitQueue.push({ bet, raffle, key });
    }
    if (submitQueue.length) runQueue();
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    while (submitQueue.length) {
      if (paused) break;
      await doSubmit(submitQueue.shift());
      await sleep(SUBMIT_DELAY_MS);
    }
    queueRunning = false;
  }

  async function doSubmit({ bet, raffle, key }) {
    const input = bet.betInput || bet.id;
    const tag = `« ${raffle.name} » (${bet.game} ${bet.multiplier}x)`;
    try {
      const r = await gmPost(ENTER_API, { raffleId: raffle.id, betInput: input });
      const body = (r.responseText || "").slice(0, 400);
      let j = null; try { j = JSON.parse(r.responseText); } catch (e) {}
      const reason = j && (j.error || j.message) ? (j.error || j.message) : "";
      const okStatus = r.status === 200 || r.status === 201;
      // Un 200 peut cacher une erreur/refus dans le corps : on ne compte "entré" que si le
      // corps ne signale aucune erreur ni échec explicite.
      const bodySaysFail = j && (j.error || j.success === false || j.entered === false || j.ok === false);

      // Diagnostic : on montre TOUJOURS la réponse brute de Valkyrie, pour lever les faux "entrés".
      console.log(`${LOG_PREFIX} 📥 ${input} → « ${raffle.name} » : HTTP ${r.status} — ${body}`);

      if (okStatus && !bodySaysFail) {
        stats.sent++; rememberPair(key);
        life.entered++; saveLife();
        log(`✅ ENTRÉ dans ${tag}`);
        recordEntry({ t: Date.now(), betInput: input, raffleId: raffle.id, raffle: raffle.name, game: bet.game, multi: bet.multiplier, status: "entré" });
        notifyEntry(bet, raffle);
      } else if (r.status === 409) {
        stats.conflict++; rememberPair(key);
        log(`↔️ Déjà tenté ${tag}${reason ? " : " + reason : ""}`);
      } else {
        stats.failed++;
        const cat = categorizeRefusal(reason);
        life.refused++; life.reasons[cat] = (life.reasons[cat] || 0) + 1; saveLife();
        // Un refus définitif (mise trop basse, mauvais jeu…) ne changera pas : on mémorise la
        // paire pour ne pas re-marteler Valkyrie si le même bet réapparaît. On ne mémorise PAS
        // les erreurs serveur (5xx) ni réseau, qui elles peuvent être transitoires.
        if (r.status < 500) rememberPair(key);
        log(`⛔ Refusé — ${tag}${reason ? " : " + reason : " (HTTP " + r.status + ")"}`);
      }
    } catch (e) {
      stats.failed++;
      log(`⛔ Erreur réseau — ${tag} : ${e.message || e}`);
    }
    updatePanel();
  }

  /* ======================= NOTIF + SON ======================= */

  function notifyEntry(bet, raffle) {
    if (!NOTIFY_ON_ENTRY) return;
    try {
      GM_notification({
        title: "🏴‍☠️ Bet entré dans une raffle !",
        text: `${raffle.name}\n${bet.game} · ${bet.multiplier}x`,
        timeout: 8000,
      });
    } catch (e) {}
    beep();
  }

  function beep() {
    if (!notifVolume) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      const peak = 0.3 * notifVolume;
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "sine"; o.frequency.value = f;
        const t0 = now + i * 0.14;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
        o.start(t0); o.stop(t0 + 0.14);
      });
    } catch (e) {}
  }

  /* ======================= HOOK INJECTÉ DANS LA PAGE ======================= */

  function valkPageHook(MARK) {
    function forward(text, url) {
      if (typeof text !== "string" || !text) return;
      if (text.indexOf("ultiplier") === -1 && text.indexOf("payout") === -1) return;
      try { window.postMessage({ [MARK]: true, t: text, u: url || "" }, "*"); } catch (e) {}
    }
    try {
      var of = window.fetch;
      if (of) window.fetch = function (input) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        return of.apply(this, arguments).then(function (resp) {
          try { resp.clone().text().then(function (t) { forward(t, url); }).catch(function () {}); } catch (e) {}
          return resp;
        });
      };
    } catch (e) {}
    try {
      var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__vu = u; return oo.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        xhr.addEventListener("load", function () {
          try { if (xhr.responseType === "" || xhr.responseType === "text") forward(xhr.responseText, xhr.__vu); } catch (e) {}
        });
        return os.apply(this, arguments);
      };
    } catch (e) {}
    try {
      var NativeWS = window.WebSocket;
      var P = function (url, protocols) {
        var ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
        ws.addEventListener("message", function (ev) {
          var d = ev.data;
          if (typeof d === "string") forward(d, url);
          else if (typeof Blob !== "undefined" && d instanceof Blob) { d.text().then(function (t) { forward(t, url); }).catch(function () {}); }
          else if (d instanceof ArrayBuffer) { try { forward(new TextDecoder("utf-8").decode(d), url); } catch (e) {} }
        });
        return ws;
      };
      P.prototype = NativeWS.prototype;
      P.CONNECTING = NativeWS.CONNECTING; P.OPEN = NativeWS.OPEN; P.CLOSING = NativeWS.CLOSING; P.CLOSED = NativeWS.CLOSED;
      window.WebSocket = P;
    } catch (e) {}
  }

  function injectPageHook() {
    try {
      const s = document.createElement("script");
      s.textContent = "(" + valkPageHook.toString() + ")(" + JSON.stringify(MSG_MARK) + ");";
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) {
      log("⚠️ Injection du hook page échouée : " + (e.message || e));
    }
  }

  function onPageMessage(e) {
    const data = e.data;
    if (!data || data[MSG_MARK] !== true || typeof data.t !== "string") return;
    stats.payloads++;
    let obj;
    try { obj = JSON.parse(data.t); } catch (err) { return; }
    processPayload(obj, data.u);
    updatePanel();
  }

  /* ======================= PANNEAU ======================= */

  let panelEl = null, logEl = null;

  function buildPanel() {
    GM_addStyle(`
      #valk-panel{position:fixed;bottom:14px;right:14px;z-index:2147483647;width:308px;
        background:#12100e;border:1px solid #33291f;border-radius:12px;color:#e9e2d6;
        font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}
      #valk-panel .vh{display:flex;align-items:center;justify-content:space-between;
        padding:9px 11px;background:#1b1712;border-bottom:1px solid #33291f;cursor:move}
      #valk-panel .vh b{color:#e0a86b;font-weight:600;letter-spacing:.3px}
      #valk-panel .vh .vx{cursor:pointer;color:#8a7c6a;padding:0 4px}
      #valk-panel .vhctrl{display:flex;align-items:center;gap:2px}
      #valk-panel .vpow{cursor:pointer;color:#7fdca8;padding:0 4px;font-weight:700}
      #valk-panel .vpow.off{color:#8a7c6a}
      #valk-panel.disabled .vh b::after{content:" · OFF";color:#e07a5f;font-weight:600}
      #valk-panel .vbody{padding:10px 11px;cursor:move}
      #valk-panel input,#valk-panel select,#valk-panel .vlog,#valk-panel .vhist{cursor:auto}
      #valk-panel{user-select:none}
      #valk-panel .vlog,#valk-panel .vhist,#valk-panel input,#valk-panel #valk-manual-res{user-select:text}
      #valk-panel .vgrid{display:grid;grid-template-columns:1fr auto;gap:3px 10px;margin-bottom:8px}
      #valk-panel .vgrid span{color:#8a7c6a}
      #valk-panel .vgrid b{color:#e9e2d6;font-weight:600;text-align:right}
      #valk-panel .vsec{margin:8px 0;border-top:1px solid #33291f;padding-top:8px}
      #valk-panel .vlabel{color:#8a7c6a;margin-bottom:4px}
      #valk-panel .vhunt div{color:#7fdca8;padding:1px 0}
      #valk-panel .vhunt .gname{color:#e0a86b;margin-top:5px;font-size:10px;font-weight:600}
      #valk-panel .vhunt .miss{color:#8a7c6a}
      #valk-panel .vlog{max-height:130px;overflow-y:auto;border-top:1px solid #33291f;padding-top:7px;
        margin-top:8px;font-size:10.5px;color:#b9ad9c}
      #valk-panel .vlog div{padding:1px 0;word-break:break-word}
      #valk-panel .vrow{display:flex;gap:8px;margin-top:8px}
      #valk-panel .vbtn{flex:1;padding:6px;border:1px solid #33291f;border-radius:7px;
        background:#1b1712;color:#e9e2d6;cursor:pointer;font:inherit}
      #valk-panel .vbtn:hover{border-color:#e0a86b}
      #valk-panel .vbtn-icon{flex:0 0 auto;padding:6px 11px}
      #valk-panel .vpanel{margin-top:8px;padding:8px;border:1px solid #33291f;border-radius:8px;background:#0f0d0b}
      #valk-panel .vpanel[hidden]{display:none}
      #valk-panel input,#valk-panel select{width:100%;box-sizing:border-box;margin-bottom:6px;padding:6px;
        border:1px solid #33291f;border-radius:6px;background:#1b1712;color:#e9e2d6;font:inherit}
      #valk-panel .vhist{max-height:120px;overflow-y:auto;font-size:10.5px}
      #valk-panel .vhist div{padding:2px 0;border-bottom:1px solid #221c15;color:#b9ad9c}
      #valk-panel .vhistrow{cursor:pointer}
      #valk-panel .vhistrow:hover{color:#e0a86b}
      #valk-panel .vmini{font-size:10px;color:#8a7c6a}
    `);
    panelEl = document.createElement("div");
    panelEl.id = "valk-panel";
    panelEl.innerHTML = `
      <div class="vh"><b>🏴‍☠️ Valkyrie Auto-Raffle</b><span class="vhctrl"><span class="vpow" data-act="power" title="Activer / désactiver">⏻</span><span class="vx" title="réduire">—</span></span></div>
      <div class="vbody">
        <div class="vgrid">
          <span>Raffles actives</span><b data-k="raffles">—</b>
          <span>Ton compte</span><b data-k="me">—</b>
          <span>Jeu courant</span><b data-k="game">—</b>
          <span>Trafic réseau</span><b data-k="payloads">0</b>
          <span>Bets capturés</span><b data-k="captured">0</b>
          <span>Correspondances</span><b data-k="matched">0</b>
          <span>Entrés ✅</span><b data-k="entered">0</b>
          <span>Refusés ⛔</span><b data-k="refused">0</b>
          <span>Autres joueurs ⊘</span><b data-k="foreign">0</b>
          <span>Jeu inconnu ❓</span><b data-k="unknownGame">0</b>
        </div>
        <div class="vsec">
          <select class="vsel" id="valk-view" style="margin-bottom:6px"><option value="">Voir : jeux actifs</option></select>
          <div class="vlabel">🎯 Sur ce jeu, tu vises :</div>
          <div class="vhunt" id="valk-hunt"><span class="miss">—</span></div>
        </div>
        <div class="vlog"></div>
        <div class="vrow">
          <button class="vbtn" data-act="pause">⏸ Pause</button>
          <button class="vbtn" data-act="reset">↺ Reset</button>
          <button class="vbtn vbtn-icon" data-act="vol" title="Volume des notifications">🔊</button>
        </div>
        <div class="vrow">
          <button class="vbtn" data-act="manual">✍️ Manuel</button>
          <button class="vbtn" data-act="history">📋 Historique</button>
          <button class="vbtn" data-act="life">📈 À vie</button>
        </div>
        <div class="vpanel" id="valk-manual" hidden>
          <input id="valk-manual-id" placeholder="colle un bet id (ex: casino:123…)" />
          <select id="valk-manual-raffle"></select>
          <button class="vbtn" data-act="manual-send" style="width:100%">Envoyer à la raffle</button>
          <div id="valk-manual-res" class="vmini" style="margin-top:6px"></div>
        </div>
        <div class="vpanel" id="valk-history" hidden>
          <div class="vhist" id="valk-hist-list"></div>
          <button class="vbtn" data-act="export" style="width:100%;margin-top:6px">📤 Exporter (presse-papier)</button>
        </div>
        <div class="vpanel" id="valk-life" hidden>
          <div id="valk-life-body" class="vmini"></div>
          <button class="vbtn" data-act="life-reset" style="width:100%;margin-top:6px">↺ Remettre à zéro (à vie)</button>
        </div>
      </div>`;
    document.body.appendChild(panelEl);
    logEl = panelEl.querySelector(".vlog");

    const body = panelEl.querySelector(".vbody");
    panelEl.querySelector(".vx").addEventListener("click", () => {
      body.style.display = body.style.display === "none" ? "" : "none";
    });
    panelEl.querySelector('[data-act="pause"]').addEventListener("click", (e) => {
      paused = !paused;
      e.target.textContent = paused ? "▶ Reprendre" : "⏸ Pause";
      if (!paused) runQueue();
    });
    panelEl.querySelector('[data-act="reset"]').addEventListener("click", () => {
      stats.payloads = 0; stats.captured = 0; stats.matched = 0;
      stats.sent = 0; stats.conflict = 0; stats.failed = 0; stats.foreign = 0; stats.unknownGame = 0;
      updatePanel();
      log("↺ Stats remises à zéro.");
    });
    const volBtn = panelEl.querySelector('[data-act="vol"]');
    volBtn.textContent = volIcon(notifVolume);
    volBtn.addEventListener("click", () => {
      let i = VOL_LEVELS.indexOf(notifVolume);
      notifVolume = VOL_LEVELS[(i + 1) % VOL_LEVELS.length];
      try { GM_setValue("valk_notif_vol", notifVolume); } catch (e) {}
      volBtn.textContent = volIcon(notifVolume);
      volBtn.title = "Volume des notifications : " + (notifVolume >= 1 ? "fort" : notifVolume > 0 ? "bas" : "muet");
      beep(); // aperçu du nouveau volume
    });
    panelEl.querySelector('[data-act="manual"]').addEventListener("click", () => {
      const p = panelEl.querySelector("#valk-manual"); p.hidden = !p.hidden;
    });
    panelEl.querySelector('[data-act="history"]').addEventListener("click", () => {
      const p = panelEl.querySelector("#valk-history"); p.hidden = !p.hidden;
      if (!p.hidden) renderHistory();
    });
    panelEl.querySelector('[data-act="manual-send"]').addEventListener("click", manualSend);
    panelEl.querySelector('[data-act="export"]').addEventListener("click", exportEntries);

    // Interrupteur on/off persistant
    panelEl.querySelector('[data-act="power"]').addEventListener("click", () => {
      enabled = !enabled;
      try { GM_setValue("valk_enabled", enabled); } catch (e) {}
      applyEnabled();
      log(enabled ? "▶ Script activé." : "■ Script désactivé (reste OFF après reload).");
      if (enabled) runQueue();
    });

    // Menu « Voir » : filtre l'affichage sur un jeu précis
    panelEl.querySelector("#valk-view").addEventListener("change", (e) => {
      viewFilter = e.target.value || null;
      renderHunting();
    });

    // Stats à vie
    panelEl.querySelector('[data-act="life"]').addEventListener("click", () => {
      const p = panelEl.querySelector("#valk-life"); p.hidden = !p.hidden;
      if (!p.hidden) renderLife();
    });
    panelEl.querySelector('[data-act="life-reset"]').addEventListener("click", () => {
      life = { entered: 0, refused: 0, reasons: { miseBasse: 0, mauvaisJeu: 0, timing: 0, autre: 0 } };
      saveLife(); renderLife();
    });

    // Restaure la position mémorisée
    try {
      const p = GM_getValue("valk_pos", null);
      if (p && p.left && p.top) { panelEl.style.left = p.left; panelEl.style.top = p.top; panelEl.style.right = "auto"; panelEl.style.bottom = "auto"; }
    } catch (e) {}

    makeDraggable(panelEl, panelEl);
    populateManualRaffles();
    populateViewMenu();
    applyEnabled();
    renderHunting();
    updatePanel();
  }

  function applyEnabled() {
    if (!panelEl) return;
    panelEl.classList.toggle("disabled", !enabled);
    const p = panelEl.querySelector('[data-act="power"]');
    if (p) { p.classList.toggle("off", !enabled); p.title = enabled ? "Actif — cliquer pour désactiver" : "Désactivé — cliquer pour activer"; }
  }

  function populateViewMenu() {
    if (!panelEl) return;
    const sel = panelEl.querySelector("#valk-view");
    if (!sel) return;
    const cur = sel.value;
    const names = [...new Set(activeRaffles.map((r) => r.gameName).filter(Boolean))];
    sel.innerHTML = `<option value="">Voir : jeux actifs</option>` +
      names.map((n) => `<option value="${norm(n)}">${n}</option>`).join("");
    if (cur && names.some((n) => norm(n) === cur)) sel.value = cur;
    else { sel.value = ""; viewFilter = null; }
  }

  function renderLife() {
    if (!panelEl) return;
    const el = panelEl.querySelector("#valk-life-body");
    if (!el) return;
    const r = life.reasons;
    el.innerHTML =
      `Entrés à vie : <b style="color:#7fdca8">${life.entered}</b><br>` +
      `Refusés à vie : <b style="color:#e07a5f">${life.refused}</b><br>` +
      `&nbsp;&nbsp;• mise trop basse : ${r.miseBasse}<br>` +
      `&nbsp;&nbsp;• mauvais jeu : ${r.mauvaisJeu}<br>` +
      `&nbsp;&nbsp;• timing / éligibilité : ${r.timing}<br>` +
      `&nbsp;&nbsp;• autre : ${r.autre}`;
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      // On peut attraper le panneau n'importe où, SAUF sur un élément interactif ou sur les
      // zones de texte à copier (journal, historique) — sinon la sélection déclenche le déplacement.
      if (e.target.closest && e.target.closest("button, input, select, textarea, option, a, .vx, .vlog, .vhist")) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      el.style.left = ox + (e.clientX - sx) + "px";
      el.style.top = oy + (e.clientY - sy) + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (drag) { drag = false; try { GM_setValue("valk_pos", { left: el.style.left, top: el.style.top }); } catch (e) {} }
    });
  }

  function modeSymbol(raffle) {
    const m = raffle.multiplierMode || "min";
    return m === "max" ? "≤" : m === "exact" ? "=" : "≥";
  }

  function renderHunting() {
    if (!panelEl) return;
    const el = panelEl.querySelector("#valk-hunt");
    if (!el) return;
    let games;
    if (viewFilter) {
      // Un jeu précis choisi dans le menu « Voir » (même si tu n'y joues pas en ce moment).
      const r0 = activeRaffles.find((r) => norm(r.gameName) === viewFilter);
      games = r0 ? [{ name: r0.gameName }] : [];
    } else {
      games = activeGames();
    }
    if (!games.length) { el.innerHTML = `<span class="miss">— (joue pour détecter le jeu)</span>`; return; }
    const multi = games.length > 1;
    const parts = [];
    for (const g of games) {
      const cg = norm(g.name);
      const matching = activeRaffles.filter((r) => norm(r.gameName) === cg);
      if (multi) parts.push(`<div class="gname">${g.name}</div>`);
      if (!matching.length) {
        parts.push(`<div class="miss">${multi ? "" : g.name + " — "}aucune raffle</div>`);
      } else {
        parts.push(matching.map((r) => {
          const minBet = r.minBetUsd != null ? ` · mise ≥ $${r.minBetUsd}` : "";
          return `<div>${modeSymbol(r)} ${r.multiplierValue}x${minBet} — ${r.name}</div>`;
        }).join(""));
      }
    }
    el.innerHTML = parts.join("");
  }

  function populateManualRaffles() {
    if (!panelEl) return;
    const sel = panelEl.querySelector("#valk-manual-raffle");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">— choisir une raffle —</option>` +
      activeRaffles.map((r) => `<option value="${r.id}">${r.name} · ${r.gameName}</option>`).join("");
    if (activeRaffles.some((r) => r.id === cur)) sel.value = cur;
  }

  async function manualSend() {
    const idEl = panelEl.querySelector("#valk-manual-id");
    const selEl = panelEl.querySelector("#valk-manual-raffle");
    const res = panelEl.querySelector("#valk-manual-res");
    const id = idEl.value.trim();
    const raffleId = selEl.value;
    if (!id) { res.textContent = "Colle un bet id."; return; }
    if (!raffleId) { res.textContent = "Choisis une raffle."; return; }
    const raffle = activeRaffles.find((r) => r.id === raffleId);
    res.textContent = "Envoi…";
    try {
      const r = await gmPost(ENTER_API, { raffleId, betInput: id });
      let reason = "";
      try { reason = JSON.parse(r.responseText).error || ""; } catch (e) {}
      if (r.status === 200 || r.status === 201) {
        res.textContent = `✅ Entré dans « ${raffle.name} »`;
        recordEntry({ t: Date.now(), betInput: id, raffleId, raffle: raffle.name, game: raffle.gameName, multi: null, status: "manuel" });
      } else if (r.status === 409) {
        res.textContent = "✅ Déjà dedans";
      } else {
        res.textContent = "⛔ " + (reason || "HTTP " + r.status);
      }
    } catch (e) {
      res.textContent = "⛔ " + (e.message || e);
    }
  }

  function renderHistory() {
    if (!panelEl) return;
    const list = panelEl.querySelector("#valk-hist-list");
    if (!list) return;
    if (!entries.length) { list.innerHTML = `<div class="vmini">Aucune entrée pour l'instant.</div>`; return; }
    list.innerHTML = entries.slice(0, 12).map((e, i) => {
      const time = new Date(e.t).toLocaleString();
      const mult = e.multi != null ? ` ${e.multi}x` : "";
      return `<div class="vhistrow" data-idx="${i}" title="Ouvrir la page des raffles Valkyrie">${time} · ${e.raffle}<br><span class="vmini">${e.game || "?"}${mult} · ${e.betInput}</span></div>`;
    }).join("");
    list.querySelectorAll(".vhistrow").forEach((row) => {
      row.addEventListener("click", () => {
        // Le format d'un lien direct vers UNE raffle n'est pas connu avec certitude :
        // on ouvre donc la page générale des raffles Valkyrie, qui elle est sûre.
        try { window.open(RAFFLES_PAGE_URL, "_blank"); } catch (e) {}
      });
    });
  }

  function exportEntries() {
    try {
      GM_setClipboard(JSON.stringify(entries, null, 2), "text");
      log(`📤 ${entries.length} entrée(s) copiée(s) dans le presse-papier.`);
    } catch (e) {
      console.log(LOG_PREFIX, "export :", JSON.stringify(entries));
      log("📤 Export dans la console (presse-papier indispo).");
    }
  }

  function updatePanel() {
    if (!panelEl) return;
    const set = (k, v) => { const n = panelEl.querySelector(`[data-k="${k}"]`); if (n) n.textContent = v; };
    set("raffles", activeRaffles.length || "—");
    set("me", myUsername || "—");
    const games = activeGames();
    set("game", games.length ? games.map((g) => g.name).join(" + ") : "—");
    set("payloads", stats.payloads);
    set("captured", stats.captured);
    set("matched", stats.matched);
    set("entered", stats.sent);
    set("refused", stats.failed);
    set("foreign", stats.foreign);
    set("unknownGame", stats.unknownGame);
  }

  function log(msg) {
    if (logEl) {
      const d = document.createElement("div");
      d.textContent = `${new Date().toLocaleTimeString()} · ${msg}`;
      logEl.prepend(d);
      while (logEl.children.length > 50) logEl.removeChild(logEl.lastChild);
    }
    console.log(LOG_PREFIX, msg);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ======================= DÉMARRAGE ======================= */

  window.addEventListener("message", onPageMessage);
  injectPageHook();

  function start() {
    buildPanel();
    loadActiveRaffles();
    setInterval(loadActiveRaffles, RAFFLE_REFRESH_MS);
    // Purge des jeux inactifs même sans nouveau trafic (sinon l'affichage resterait figé).
    setInterval(() => { if (pruneGames()) { updatePanel(); renderHunting(); } }, 5000);
    log("Démarré. En attente de bets…");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__valk = {
    stats, seenBets, entries,
    currentGame: () => activeGames(),
    activeGames: () => activeGames(),
    lastKnownGame: () => lastKnownGame,
    targetGames: () => [...targetGames],
    activeRaffles: () => activeRaffles,
    dumpBets: () => console.table([...seenBets.values()]),
    reloadRaffles: loadActiveRaffles,
  };
})();
