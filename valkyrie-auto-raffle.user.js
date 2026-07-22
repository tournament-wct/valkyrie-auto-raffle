// ==UserScript==
// @name         Valkyrie Auto-Raffle (Stake → Valkyrie Studio)
// @namespace    oracle-labs.valkyrie
// @version      1.0.0
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
  const LOG_PREFIX = "[Valkyrie AR]";
  const SENT_STORE_KEY = "valk_sent_pairs_v1";
  const MSG_MARK = "__valk_payload__";

  /* ======================= ÉTAT ======================= */

  let activeRaffles = [];
  const seenBets = new Map();
  const submitQueue = [];
  let queueRunning = false;
  let paused = false;
  let currentGame = null;

  const stats = { payloads: 0, captured: 0, matched: 0, sent: 0, conflict: 0, failed: 0 };

  let sentPairs = new Set();
  try { sentPairs = new Set(JSON.parse(GM_getValue(SENT_STORE_KEY, "[]"))); } catch (e) { sentPairs = new Set(); }
  function rememberPair(key) {
    sentPairs.add(key);
    if (sentPairs.size > 5000) sentPairs = new Set([...sentPairs].slice(-3000));
    try { GM_setValue(SENT_STORE_KEY, JSON.stringify([...sentPairs])); } catch (e) {}
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
      log(`✅ ${activeRaffles.length} raffle(s) active(s) chargée(s).`);
      updatePanel();
    } catch (e) {
      log("⚠️ Impossible de charger les raffles Valkyrie : " + (e.message || e));
    }
  }

  /* ======================= EXTRACTION DES BETS ======================= */

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

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

  function looksLikeBetId(v) { return typeof v === "string" && /^(casino|sports|house|ext|sport):/i.test(v); }

  // Valkyrie veut un id de forme "casino:NNNN" / "house:NNNN" (= l'iid), PAS l'UUID interne.
  // Le bet est souvent emboîté : l'iid se trouve sur le nœud OU sur son parent (wrapper).
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
      out.push({
        id: uuid,
        betInput: pickBetInput(node, parent) || uuid,
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

  function processPayload(obj) {
    if (!obj || typeof obj !== "object") return;

    const g = findGameContext(obj, 0);
    if (g && g.name && (!currentGame || currentGame.name !== g.name)) {
      currentGame = g;
      updatePanel();
    }

    const found = [];
    extractBets(obj, found, 0, null);
    for (const bet of found) handleBet(bet);
  }

  function handleBet(bet) {
    if (!bet.id) return;
    const prev = seenBets.get(bet.id);
    const isNew = !prev;
    const multiResolved = prev && (prev.multiplier === 0 || prev.multiplier == null) && bet.multiplier > 0;
    if (!isNew && !multiResolved) {
      if (prev && !prev.game && bet.game) prev.game = bet.game;
      return;
    }

    if (!bet.game && currentGame && currentGame.name) bet.game = currentGame.name;
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
    // La mise min (USD) n'est pas vérifiée ici : le serveur Valkyrie tranche.
    if (mode === "max") return bet.multiplier <= th;
    if (mode === "exact") return Math.abs(bet.multiplier - th) < 1e-9;
    return bet.multiplier >= th; // "min"
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

  /* ======================= HOOK INJECTÉ DANS LA PAGE ======================= */

  function valkPageHook(MARK) {
    function forward(text) {
      if (typeof text !== "string" || !text) return;
      if (text.indexOf("ultiplier") === -1 && text.indexOf("payout") === -1) return;
      try { window.postMessage({ [MARK]: true, t: text }, "*"); } catch (e) {}
    }
    try {
      var of = window.fetch;
      if (of) window.fetch = function () {
        return of.apply(this, arguments).then(function (resp) {
          try { resp.clone().text().then(forward).catch(function () {}); } catch (e) {}
          return resp;
        });
      };
    } catch (e) {}
    try {
      var os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        xhr.addEventListener("load", function () {
          try { if (xhr.responseType === "" || xhr.responseType === "text") forward(xhr.responseText); } catch (e) {}
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
          if (typeof d === "string") forward(d);
          else if (typeof Blob !== "undefined" && d instanceof Blob) { d.text().then(forward).catch(function () {}); }
          else if (d instanceof ArrayBuffer) { try { forward(new TextDecoder("utf-8").decode(d)); } catch (e) {} }
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
    processPayload(obj);
    updatePanel();
  }

  /* ======================= PANNEAU ======================= */

  let panelEl = null, logEl = null;

  function buildPanel() {
    GM_addStyle(`
      #valk-panel{position:fixed;bottom:14px;right:14px;z-index:2147483647;width:300px;
        background:#12100e;border:1px solid #33291f;border-radius:12px;color:#e9e2d6;
        font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}
      #valk-panel .vh{display:flex;align-items:center;justify-content:space-between;
        padding:9px 11px;background:#1b1712;border-bottom:1px solid #33291f;cursor:move}
      #valk-panel .vh b{color:#e0a86b;font-weight:600;letter-spacing:.3px}
      #valk-panel .vh .vx{cursor:pointer;color:#8a7c6a;padding:0 4px}
      #valk-panel .vbody{padding:10px 11px}
      #valk-panel .vgrid{display:grid;grid-template-columns:1fr auto;gap:3px 10px;margin-bottom:8px}
      #valk-panel .vgrid span{color:#8a7c6a}
      #valk-panel .vgrid b{color:#e9e2d6;font-weight:600;text-align:right}
      #valk-panel .vlog{max-height:150px;overflow-y:auto;border-top:1px solid #33291f;padding-top:7px;
        font-size:10.5px;color:#b9ad9c}
      #valk-panel .vlog div{padding:1px 0;word-break:break-word}
      #valk-panel .vbtn{margin-top:8px;width:100%;padding:6px;border:1px solid #33291f;border-radius:7px;
        background:#1b1712;color:#e9e2d6;cursor:pointer;font:inherit}
      #valk-panel .vbtn:hover{border-color:#e0a86b}
    `);
    panelEl = document.createElement("div");
    panelEl.id = "valk-panel";
    panelEl.innerHTML = `
      <div class="vh"><b>🏴‍☠️ Valkyrie Auto-Raffle</b><span class="vx" title="réduire">—</span></div>
      <div class="vbody">
        <div class="vgrid">
          <span>Raffles actives</span><b data-k="raffles">—</b>
          <span>Jeu courant</span><b data-k="game">—</b>
          <span>Flux capté</span><b data-k="payloads">0</b>
          <span>Bets capturés</span><b data-k="captured">0</b>
          <span>Correspondances</span><b data-k="matched">0</b>
          <span>Entrés ✅</span><b data-k="entered">0</b>
          <span>Refusés ⛔</span><b data-k="refused">0</b>
        </div>
        <div class="vlog"></div>
        <button class="vbtn" data-act="pause">⏸ Mettre en pause</button>
      </div>`;
    document.body.appendChild(panelEl);
    logEl = panelEl.querySelector(".vlog");

    const body = panelEl.querySelector(".vbody");
    panelEl.querySelector(".vx").addEventListener("click", () => {
      body.style.display = body.style.display === "none" ? "" : "none";
    });
    panelEl.querySelector('[data-act="pause"]').addEventListener("click", (e) => {
      paused = !paused;
      e.target.textContent = paused ? "▶ Reprendre" : "⏸ Mettre en pause";
      if (!paused) runQueue();
    });
    makeDraggable(panelEl, panelEl.querySelector(".vh"));
    updatePanel();
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("vx")) return;
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

  function updatePanel() {
    if (!panelEl) return;
    const set = (k, v) => { const n = panelEl.querySelector(`[data-k="${k}"]`); if (n) n.textContent = v; };
    set("raffles", activeRaffles.length || "—");
    set("game", currentGame && currentGame.name ? currentGame.name : "—");
    set("payloads", stats.payloads);
    set("captured", stats.captured);
    set("matched", stats.matched);
    set("entered", stats.sent + stats.conflict);
    set("refused", stats.failed);
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
    log("Démarré. En attente de bets…");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__valk = {
    stats, seenBets,
    currentGame: () => currentGame,
    activeRaffles: () => activeRaffles,
    dumpBets: () => console.table([...seenBets.values()]),
    reloadRaffles: loadActiveRaffles,
  };
})();
