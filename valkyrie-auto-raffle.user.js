// ==UserScript==
// @name         Valkyrie Auto-Raffle (Stake → Valkyrie Studio)
// @namespace    oracle-labs.valkyrie
// @version      0.7.0
// @description  Capture les bets de ta session Stake et, quand le jeu + le multiplicateur correspondent à une raffle Valkyrie Studio, les envoie automatiquement. Phase 1 : DRY_RUN = simulation, rien n'est envoyé.
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
// -- Auto-update : remplace <toi>/<repo> par ton dépôt GitHub (voir guide). Ces 2 lignes
//    DOIVENT rester à l'intérieur du bloc ==UserScript== pour que la MAJ auto fonctionne.
// @updateURL    https://raw.githubusercontent.com/<toi>/<repo>/main/valkyrie-auto-raffle.user.js
// @downloadURL  https://raw.githubusercontent.com/<toi>/<repo>/main/valkyrie-auto-raffle.user.js
// ==/UserScript==
//
// Ce script est PASSIF : il lit uniquement ce que ta propre session Stake reçoit déjà
// dans le navigateur (aucun mot de passe, aucun accès au compte). Il poste ensuite les
// IDs de bets à l'API publique de Valkyrie Studio, exactement comme le fait le Raffle
// Automator. Chaque personne fait tourner le script sur SA session : chacun n'envoie
// que ses propres bets, et Valkyrie crédite l'entrée au propriétaire du bet.
//
// v0.2.0 : interception injectée dans le VRAI contexte de la page (fetch/XHR/WebSocket),
//          car sous @grant le script tourne en bac à sable et ne voyait pas le trafic réel.
//          + gestion du mode "exact" + trames WebSocket binaires + diagnostic "Flux".
// v0.3.0 : traqueur de "jeu courant" (les bets ThirdPartyBet arrivent sans nom de jeu),
//          matching des noms normalise (Midas Multiplier = midas-multiplier), dump JSON complet.

(function () {
  "use strict";

  /* ======================= CONFIG ======================= */

  // Passe à false UNIQUEMENT quand la capture est validée sur du réel.
  const DRY_RUN = true;

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
  let debugSamples = 0;
  let currentGame = null; // { name, slug } déduit des payloads Stake, pour les bets sans jeu
  let jsonDumps = 0;
  let lastCapturedBet = null; // pour le bouton de test d'envoi réel

  const stats = { payloads: 0, captured: 0, matched: 0, simulated: 0, sent: 0, conflict: 0, failed: 0 };

  let sentPairs = new Set();
  const simulatedPairs = new Set(); // dédup en mémoire pour le mode SIMULATION (non persistée)
  try { sentPairs = new Set(JSON.parse(GM_getValue(SENT_STORE_KEY, "[]"))); } catch (e) { sentPairs = new Set(); }
  function rememberPair(key) {
    sentPairs.add(key);
    if (sentPairs.size > 5000) sentPairs = new Set([...sentPairs].slice(-3000));
    try { GM_setValue(SENT_STORE_KEY, JSON.stringify([...sentPairs])); } catch (e) {}
  }

  /* ======================= UTILS RÉSEAU (cross-origin via GM) ======================= */

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET", url, headers: { Accept: "application/json" },
        onload: resolve, onerror: reject, ontimeout: () => reject(new Error("timeout")),
      });
    });
  }
  function gmPost(url, bodyObj) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST", url,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        data: JSON.stringify(bodyObj),
        onload: resolve, onerror: reject, ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  /* ======================= RAFFLES ACTIVES ======================= */

  async function loadActiveRaffles() {
    try {
      const r = await gmGet(RAFFLES_API);
      const data = JSON.parse(r.responseText);
      const list = Array.isArray(data) ? data : data.raffles || [];
      activeRaffles = list.filter((x) => (x.status || "active") === "active");
      log(`✅ ${activeRaffles.length} raffle(s) active(s) chargée(s) depuis Valkyrie.`);
      if (activeRaffles.length) {
        console.log(LOG_PREFIX + " Raffles actives :",
          activeRaffles.map((x) => `${x.name} · ${x.gameName} · ${x.multiplierMode || "min"} ${x.multiplierValue}x`));
      }
      updatePanel();
      populateTestRaffles();
    } catch (e) {
      log("⚠️ Impossible de charger les raffles Valkyrie : " + (e.message || e));
    }
  }

  function populateTestRaffles() {
    if (!panelEl) return;
    const sel = panelEl.querySelector('[data-k="testraffle"]');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">— raffle pour test —</option>` +
      activeRaffles.map((r) => `<option value="${r.id}">${r.name}</option>`).join("");
    if (activeRaffles.some((r) => r.id === current)) sel.value = current;
  }

  /* ======================= EXTRACTION DES BETS ======================= */

  // Normalise un nom de jeu pour comparer : minuscules, sans espaces/tirets/ponctuation.
  // "Midas Multiplier" -> "midasmultiplier" ; "midas-multiplier" -> "midasmultiplier".
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  // Cherche un contexte de jeu (objet game { name, slug }) n'importe où dans un payload.
  // Sert à retrouver le nom du jeu quand le bet lui-même ne le porte pas (ThirdPartyBet).
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

  // Cherche un id de bet exploitable (forme "casino:NNNN") sur le nœud OU son parent.
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

  // Renvoie les champs "id"-like (non-objets) d'un nœud, pour le diagnostic.
  function idLikeFields(obj) {
    const o = {};
    if (obj) for (const k in obj) { if (/id/i.test(k) && typeof obj[k] !== "object") o[k] = obj[k]; }
    return o;
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
      const iid = node.iid != null ? String(node.iid) : null;
      // Valkyrie veut un id de forme "casino:NNNN" (= l'iid), PAS l'UUID interne.
      // On regarde le nœud ET son parent (le bet est souvent emboîté dans un wrapper).
      const betInput = pickBetInput(node, parent) || uuid;
      out.push({
        id: uuid,
        iid: iid,
        betInput: betInput,
        game: game ? String(game) : null,
        multiplier: Number(mult),
        amount: node.amount != null ? Number(node.amount) : null,
        currency: node.currency || node.currencyName || null,
        idFields: idLikeFields(node),
        parentIdFields: idLikeFields(parent),
        raw: node,
      });
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") extractBets(v, out, depth + 1, node);
    }
  }

  function processPayload(obj, source) {
    if (!obj || typeof obj !== "object") return;

    // Mémorise le dernier jeu vu (pour l'accrocher aux bets qui n'ont pas de nom de jeu).
    const g = findGameContext(obj, 0);
    if (g && g.name && (!currentGame || currentGame.name !== g.name)) {
      currentGame = g;
      console.log(`${LOG_PREFIX} 🎮 Jeu courant détecté : ${g.name}${g.slug ? " (" + g.slug + ")" : ""}`);
      updatePanel();
    }

    const found = [];
    extractBets(obj, found, 0, null);
    if (!found.length) {
      // Diagnostic : on montre quelques payloads "intéressants" mais sans bet reconnu,
      // pour pouvoir affiner l'extracteur sur la vraie forme des données Stake.
      if (debugSamples < 8) {
        debugSamples++;
        console.log(`${LOG_PREFIX} 🔍 payload sans bet reconnu (échantillon debug #${debugSamples}) :`, obj);
      }
      return;
    }
    for (const bet of found) handleBet(bet, source);
  }

  function handleBet(bet, source) {
    if (!bet.id) return;
    const prev = seenBets.get(bet.id);
    const isNew = !prev;
    const multiResolved = prev && (prev.multiplier === 0 || prev.multiplier == null) && bet.multiplier > 0;
    if (!isNew && !multiResolved) {
      if (prev && !prev.game && bet.game) prev.game = bet.game;
      return;
    }
    // Si le bet n'a pas de jeu, on lui accroche le jeu courant déduit du contexte.
    if (!bet.game && currentGame && currentGame.name) {
      bet.game = currentGame.name;
      bet.gameFromContext = true;
    }

    seenBets.set(bet.id, bet);
    lastCapturedBet = bet;
    if (isNew) {
      stats.captured++;
      console.log(`${LOG_PREFIX} 🎲 Bet capturé [${source}] :`,
        { id: bet.id, iid: bet.iid, betInput: bet.betInput, jeu: bet.game, jeu_deduit: !!bet.gameFromContext, multi: bet.multiplier, mise: bet.amount, devise: bet.currency });
      console.log(`${LOG_PREFIX}    champs dispo :`, Object.keys(bet.raw).join(", "));
      console.log(`${LOG_PREFIX}    id du bet :`, bet.idFields, "| id du parent :", bet.parentIdFields);
      // Dump JSON complet des premiers bets, pour voir TOUS les champs (le "..." de la console en cache).
      if (jsonDumps < 6) {
        jsonDumps++;
        try { console.log(`${LOG_PREFIX} 📋 raw JSON #${jsonDumps} :`, JSON.stringify(bet.raw)); } catch (e) {}
      }
    } else {
      console.log(`${LOG_PREFIX} 🔁 Multi résolu pour ${bet.id} → ${bet.multiplier}x`);
    }
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
    // La mise min de Valkyrie est en USD ; les bets Stake sont en devises variées.
    // On ne filtre donc PAS sur la mise ici : le serveur Valkyrie tranchera (409 si non éligible).
    if (mode === "max") return bet.multiplier <= th;
    if (mode === "exact") return Math.abs(bet.multiplier - th) < 1e-9;
    return bet.multiplier >= th; // "min"
  }

  function considerBet(bet) {
    for (const raffle of activeRaffles) {
      if (!matchesRaffle(bet, raffle)) continue;
      const key = bet.id + "|" + raffle.id;
      if (sentPairs.has(key) || simulatedPairs.has(key)) continue;
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
    const label = `bet ${input} (${bet.game} ${bet.multiplier}x) → « ${raffle.name} »`;
    if (DRY_RUN) {
      stats.simulated++;
      simulatedPairs.add(key);
      log(`🧪 [SIMULATION] Enverrait ${label}`);
      console.log(`${LOG_PREFIX} 🧪 [SIMULATION] POST ${ENTER_API}`, { raffleId: raffle.id, betInput: input });
      updatePanel();
      return;
    }
    try {
      const r = await gmPost(ENTER_API, { raffleId: raffle.id, betInput: input });
      if (r.status === 200 || r.status === 201) { stats.sent++; rememberPair(key); log(`✅ Envoyé : ${label}`); }
      else if (r.status === 409) { stats.conflict++; rememberPair(key); log(`↔️ Déjà présent : ${label}`); }
      else { stats.failed++; log(`❌ Échec (HTTP ${r.status}) : ${label}`); }
    } catch (e) {
      stats.failed++;
      log(`❌ Erreur réseau : ${label} — ${e.message || e}`);
    }
    updatePanel();
  }

  // Envoi RÉEL manuel (bouton), indépendant de DRY_RUN : sert à valider le format de
  // betInput et voir la réponse brute de Valkyrie sans attendre un gros multiplicateur.
  async function testSubmit() {
    if (!lastCapturedBet) { log("⚠️ Aucun bet capturé pour l'instant — joue un spin d'abord."); return; }
    const sel = panelEl && panelEl.querySelector('[data-k="testraffle"]');
    const raffleId = sel && sel.value;
    if (!raffleId) { log("⚠️ Choisis une raffle dans la liste pour le test."); return; }
    const raffle = activeRaffles.find((r) => r.id === raffleId);
    const input = lastCapturedBet.betInput || lastCapturedBet.id;
    log(`🧪 TEST RÉEL : POST ${input} → « ${raffle ? raffle.name : raffleId} »…`);
    try {
      const r = await gmPost(ENTER_API, { raffleId, betInput: input });
      log(`↳ Réponse HTTP ${r.status}`);
      console.log(`${LOG_PREFIX} 🧪 TEST — HTTP ${r.status} — corps de réponse :`, r.responseText);
    } catch (e) {
      log(`↳ Erreur réseau : ${e.message || e}`);
    }
  }

  /* ======================= HOOK INJECTÉ DANS LA PAGE ======================= */

  // Cette fonction est sérialisée puis injectée dans une balise <script> : elle tourne
  // dans le CONTEXTE RÉEL de la page (pas le bac à sable Tampermonkey), donc elle patche
  // le vrai fetch / XHR / WebSocket. Elle renvoie les payloads au script via postMessage.
  function valkPageHook(MARK) {
    function forward(text) {
      if (typeof text !== "string" || !text) return;
      if (text.indexOf("ultiplier") === -1 && text.indexOf("payout") === -1) return; // pré-filtre volume
      try { window.postMessage({ [MARK]: true, t: text }, "*"); } catch (e) {}
    }
    // fetch
    try {
      var of = window.fetch;
      if (of) window.fetch = function () {
        return of.apply(this, arguments).then(function (resp) {
          try { resp.clone().text().then(forward).catch(function () {}); } catch (e) {}
          return resp;
        });
      };
    } catch (e) {}
    // XHR
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
    // WebSocket (canal clé pour les slots : le multi final arrive par là)
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
    processPayload(obj, "page");
    updatePanel();
  }

  /* ======================= MINI PANNEAU ======================= */

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
      #valk-panel .vmode{display:inline-block;font-size:10px;padding:2px 7px;border-radius:20px;margin-bottom:8px}
      #valk-panel .vmode.dry{background:#3a2f14;color:#e8c37a}
      #valk-panel .vmode.live{background:#123020;color:#7fdca8}
      #valk-panel .vgrid{display:grid;grid-template-columns:1fr auto;gap:3px 10px;margin-bottom:8px}
      #valk-panel .vgrid span{color:#8a7c6a}
      #valk-panel .vgrid b{color:#e9e2d6;font-weight:600;text-align:right}
      #valk-panel .vlog{max-height:140px;overflow-y:auto;border-top:1px solid #33291f;padding-top:7px;
        font-size:10.5px;color:#b9ad9c}
      #valk-panel .vlog div{padding:1px 0;word-break:break-word}
      #valk-panel .vbtn{margin-top:8px;width:100%;padding:6px;border:1px solid #33291f;border-radius:7px;
        background:#1b1712;color:#e9e2d6;cursor:pointer;font:inherit}
      #valk-panel .vbtn:hover{border-color:#e0a86b}
      #valk-panel .vsel{margin-top:8px;width:100%;padding:6px;border:1px solid #33291f;border-radius:7px;
        background:#1b1712;color:#e9e2d6;font:inherit}
    `);
    panelEl = document.createElement("div");
    panelEl.id = "valk-panel";
    panelEl.innerHTML = `
      <div class="vh"><b>🏴‍☠️ Valkyrie Auto-Raffle</b><span class="vx" title="réduire">—</span></div>
      <div class="vbody">
        <span class="vmode ${DRY_RUN ? "dry" : "live"}">${DRY_RUN ? "🧪 SIMULATION (rien n'est envoyé)" : "🟢 ENVOI RÉEL"}</span>
        <div class="vgrid">
          <span>Raffles actives</span><b data-k="raffles">—</b>
          <span>Jeu courant</span><b data-k="game">—</b>
          <span>Flux capté (page)</span><b data-k="payloads">0</b>
          <span>Bets capturés</span><b data-k="captured">0</b>
          <span>Correspondances</span><b data-k="matched">0</b>
          <span>${DRY_RUN ? "Simulés" : "Envoyés"}</span><b data-k="done">0</b>
        </div>
        <div class="vlog"></div>
        <select class="vsel" data-k="testraffle"><option value="">— raffle pour test —</option></select>
        <button class="vbtn" data-act="test">🧪 Test envoi RÉEL (dernier bet)</button>
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
    panelEl.querySelector('[data-act="test"]').addEventListener("click", testSubmit);
    populateTestRaffles();
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
    set("done", DRY_RUN ? stats.simulated : stats.sent);
  }

  function log(msg) {
    if (logEl) {
      const d = document.createElement("div");
      d.textContent = `${new Date().toLocaleTimeString()} · ${msg}`;
      logEl.prepend(d);
      while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
    }
    console.log(LOG_PREFIX, msg);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ======================= DÉMARRAGE ======================= */

  // 1) On écoute les payloads renvoyés par le hook, et 2) on injecte le hook AVANT que
  //    la page ne se serve de fetch/XHR/WS (d'où @run-at document-start).
  window.addEventListener("message", onPageMessage);
  injectPageHook();

  function start() {
    buildPanel();
    loadActiveRaffles();
    setInterval(loadActiveRaffles, RAFFLE_REFRESH_MS);
    log(DRY_RUN ? "Démarré en SIMULATION — joue quelques bets pour voir la capture." : "Démarré en ENVOI RÉEL.");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__valk = {
    stats, seenBets,
    currentGame: () => currentGame,
    activeRaffles: () => activeRaffles,
    dumpBets: () => console.table([...seenBets.values()].map(({ raw, ...b }) => b)),
    reloadRaffles: loadActiveRaffles,
  };
})();
