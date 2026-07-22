// ==UserScript==
// @name         Valkyrie Auto-Raffle (Stake → Valkyrie Studio)
// @namespace    oracle-labs.valkyrie
// @version      1.4.1
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
  // Champs présents uniquement sur TON user (pas sur les users publics des feeds) : sert à détecter ton compte.
  const SELF_MARKERS = ["email", "balances", "vaultBalances", "vaultBalance", "kycStatus", "mfaEnabled", "hasVerifiedEmail", "activeClientSeed", "sessionCount"];
  const LOG_PREFIX = "[Valkyrie AR]";
  const SENT_STORE_KEY = "valk_sent_pairs_v1";
  const ENTRY_LOG_KEY = "valk_entries_v1";
  const MSG_MARK = "__valk_payload__";

  /* ======================= ÉTAT ======================= */

  let activeRaffles = [];
  let targetGames = new Set(); // noms de jeux (normalisés) ayant une raffle active
  const seenBets = new Map();
  const submitQueue = [];
  let queueRunning = false;
  let paused = false;
  const recentGames = new Map(); // normName -> { name, slug, t } : jeux Valkyrie actifs récemment
  let myUsername = null; // détecté depuis ta session ; null = pas encore connu (on ne filtre pas)

  const stats = { payloads: 0, captured: 0, matched: 0, sent: 0, conflict: 0, failed: 0, foreign: 0 };

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
      targetGames = new Set(activeRaffles.map((r) => norm(r.gameName)).filter(Boolean));
      log(`✅ ${activeRaffles.length} raffle(s) active(s) — ${targetGames.size} jeu(x) suivis.`);
      updatePanel();
      renderHunting();
      populateManualRaffles();
    } catch (e) {
      log("⚠️ Impossible de charger les raffles Valkyrie : " + (e.message || e));
    }
  }

  /* ======================= EXTRACTION DES BETS ======================= */

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function isTargetGame(name) { return !!name && targetGames.has(norm(name)); }

  // --- Gestion de plusieurs slots à la fois : on garde une fenêtre glissante de jeux actifs ---
  function pruneGames() {
    const cutoff = Date.now() - RECENT_GAME_MS;
    let changed = false;
    for (const [k, v] of recentGames) if (v.t < cutoff) { recentGames.delete(k); changed = true; }
    return changed;
  }
  function touchGame(g) {
    const key = norm(g.name);
    const existed = recentGames.has(key);
    recentGames.set(key, { name: g.name, slug: g.slug || null, t: Date.now() });
    const pruned = pruneGames();
    return !existed || pruned; // vrai si l'ensemble des jeux affichés a changé
  }
  function activeGames() {
    pruneGames();
    return [...recentGames.values()].sort((a, b) => b.t - a.t);
  }
  function mostRecentGameName() {
    const g = activeGames()[0];
    return g ? g.name : null;
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
    // On ne suit le "jeu courant" que pour les jeux Valkyrie (ceux ayant une raffle).
    // Fenêtre glissante : gère plusieurs slots en même temps sans faire clignoter l'affichage.
    const gameRelevant = g && g.name && (!ONLY_VALKYRIE_GAMES || isTargetGame(g.name));
    if (gameRelevant && touchGame(g)) {
      updatePanel();
      renderHunting();
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
    if (ONLY_VALKYRIE_GAMES && !isTargetGame(bet.game)) return;

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
      let reason = "";
      try { const j = JSON.parse(r.responseText); reason = j.error || j.message || ""; } catch (e) {}

      if (r.status === 200 || r.status === 201) {
        stats.sent++; rememberPair(key);
        log(`✅ ENTRÉ dans ${tag}`);
        recordEntry({ t: Date.now(), betInput: input, raffle: raffle.name, game: bet.game, multi: bet.multiplier, status: "entré" });
        notifyEntry(bet, raffle);
      } else if (r.status === 409) {
        stats.conflict++; rememberPair(key);
        log(`✅ Déjà dedans ${tag}`);
      } else {
        stats.failed++;
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
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "sine"; o.frequency.value = f;
        const t0 = now + i * 0.14;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
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
      #valk-panel .vbody{padding:10px 11px;cursor:move}
      #valk-panel input,#valk-panel select,#valk-panel .vlog,#valk-panel .vhist{cursor:auto}
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
      #valk-panel .vpanel{margin-top:8px;padding:8px;border:1px solid #33291f;border-radius:8px;background:#0f0d0b}
      #valk-panel .vpanel[hidden]{display:none}
      #valk-panel input,#valk-panel select{width:100%;box-sizing:border-box;margin-bottom:6px;padding:6px;
        border:1px solid #33291f;border-radius:6px;background:#1b1712;color:#e9e2d6;font:inherit}
      #valk-panel .vhist{max-height:120px;overflow-y:auto;font-size:10.5px}
      #valk-panel .vhist div{padding:2px 0;border-bottom:1px solid #221c15;color:#b9ad9c}
      #valk-panel .vmini{font-size:10px;color:#8a7c6a}
    `);
    panelEl = document.createElement("div");
    panelEl.id = "valk-panel";
    panelEl.innerHTML = `
      <div class="vh"><b>🏴‍☠️ Valkyrie Auto-Raffle</b><span class="vx" title="réduire">—</span></div>
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
        </div>
        <div class="vsec">
          <div class="vlabel">🎯 Sur ce jeu, tu vises :</div>
          <div class="vhunt" id="valk-hunt"><span class="miss">—</span></div>
        </div>
        <div class="vlog"></div>
        <div class="vrow">
          <button class="vbtn" data-act="pause">⏸ Pause</button>
          <button class="vbtn" data-act="reset">↺ Reset</button>
        </div>
        <div class="vrow">
          <button class="vbtn" data-act="manual">✍️ Saisie manuelle</button>
          <button class="vbtn" data-act="history">📋 Historique</button>
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
      stats.sent = 0; stats.conflict = 0; stats.failed = 0; stats.foreign = 0;
      updatePanel();
      log("↺ Stats remises à zéro.");
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

    makeDraggable(panelEl, panelEl);
    populateManualRaffles();
    renderHunting();
    updatePanel();
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      // On peut attraper le panneau n'importe où, SAUF sur un élément interactif
      // (bouton, champ, liste déroulante, bouton de réduction), pour ne pas gêner clic/saisie.
      if (e.target.closest && e.target.closest("button, input, select, textarea, option, a, .vx")) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      el.style.left = ox + (e.clientX - sx) + "px";
      el.style.top = oy + (e.clientY - sy) + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => (drag = false));
  }

  function modeSymbol(raffle) {
    const m = raffle.multiplierMode || "min";
    return m === "max" ? "≤" : m === "exact" ? "=" : "≥";
  }

  function renderHunting() {
    if (!panelEl) return;
    const el = panelEl.querySelector("#valk-hunt");
    if (!el) return;
    const games = activeGames();
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
        parts.push(matching.map((r) => `<div>${modeSymbol(r)} ${r.multiplierValue}x — ${r.name}</div>`).join(""));
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
        recordEntry({ t: Date.now(), betInput: id, raffle: raffle.name, game: raffle.gameName, multi: null, status: "manuel" });
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
    list.innerHTML = entries.slice(0, 12).map((e) => {
      const time = new Date(e.t).toLocaleString();
      const mult = e.multi != null ? ` ${e.multi}x` : "";
      return `<div>${time} · ${e.raffle}<br><span class="vmini">${e.game || "?"}${mult} · ${e.betInput}</span></div>`;
    }).join("");
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
    set("entered", stats.sent + stats.conflict);
    set("refused", stats.failed);
    set("foreign", stats.foreign);
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
    targetGames: () => [...targetGames],
    activeRaffles: () => activeRaffles,
    dumpBets: () => console.table([...seenBets.values()]),
    reloadRaffles: loadActiveRaffles,
  };
})();
