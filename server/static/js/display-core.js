
// === DEBUG (Recall tracing) ===
const QSYS_DISPLAY_DEBUG_RECALL = true;
function dbgDisp(...args){
  if (!QSYS_DISPLAY_DEBUG_RECALL) return;
  try{ console.log("[DISPLAY-DBG]", ...args); }catch{}
}
/* QSys Display Core
   Shared logic for ALL display layouts (landscape + portrait).

   Rendering is delegated to window.DisplayUI:
     - DisplayUI.render(rows, state, helpers)
     - DisplayUI.getStatusEl()
     - DisplayUI.getAdPlayerEl()
     - DisplayUI.getChimeEl()

   Notes:
   - Keep DOM/layout decisions in DisplayUI.
   - Keep network/socket/media logic here.
*/
(function () {
  "use strict";

  try {
    const isInteractiveTarget = (target) => {
      try {
        return !!(target && typeof target.closest === "function" && target.closest("[data-display-interactive]"));
      } catch {
        return false;
      }
    };
    document.addEventListener("DOMContentLoaded", () => {
      try {
        document.body?.classList.add("display-locked");
      } catch {}
    }, { once: true });
    ["selectstart", "dragstart", "contextmenu", "mousedown", "dblclick"].forEach((eventName) => {
      document.addEventListener(eventName, (ev) => {
        if (isInteractiveTarget(ev.target)) return;
        ev.preventDefault();
      }, true);
    });
  } catch {}

  function dbg(msg, obj) {
    let plain = "";
    try {
      if (obj !== undefined) {
        if (typeof obj === "string") plain = obj;
        else plain = JSON.stringify(obj);
      }
    } catch {
      try {
        plain = String(obj);
      } catch {
        plain = "";
      }
    }
    try {
      console.log("[qsys-core]", msg, plain);
    } catch {}
  }

  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  const SETTINGS_KEY = "qsys_display_settings";
  const UI_SCALE_KEY = "qsys_ui_scale";
  const DISPLAY_TOKEN_STORAGE = "qsys_display_token";
  const UI_SCALE_MIN = 0.7;
  const UI_SCALE_MAX = 1.8;
  const UI_BASE_WIDTH = 1920;
  const UI_BASE_HEIGHT = 1080;

  function getDisplayToken() {
    dbg("getDisplayToken()", {
      storageKey: DISPLAY_TOKEN_STORAGE,
      hasValue: !!localStorage.getItem(DISPLAY_TOKEN_STORAGE),
    });
    try {
      return String(localStorage.getItem(DISPLAY_TOKEN_STORAGE) || "").trim();
    } catch {
      return "";
    }
  }

  function clearDisplayToken() {
    try {
      localStorage.removeItem(DISPLAY_TOKEN_STORAGE);
    } catch {}
  }

  function ensureDisplayTokenUI() {
    const existing = getDisplayToken();
    if (existing) return existing;

    const wrap = document.createElement("div");
    wrap.style.cssText = `
    position:fixed; inset:0; z-index:999999;
    background:rgba(0,0,0,0.85);
    display:flex; align-items:center; justify-content:center;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;

    wrap.innerHTML = `
    <div style="
      width:min(520px,92vw);
      background:#1c1c1c;
      border:1px solid #444;
      border-radius:16px;
      padding:18px;
      color:#fff;">
      
      <div style="font-size:20px;font-weight:900;margin-bottom:6px;">
        Pair Display
      </div>

      <div style="font-size:13px;opacity:.85;margin-bottom:14px;">
        This display is not paired yet.  
        Enter the 6-digit Pair Code from Setup to authorize this screen.
      </div>

      <input id="pairCodeInput"
        placeholder="Enter 6-digit Pair Code"
        style="
          width:100%;
          padding:12px;
          border-radius:10px;
          border:1px solid #555;
          background:#000;
          color:#fff;
          font-size:14px;
          outline:none;" />

      <div style="display:flex;gap:10px;margin-top:14px;">
        <button id="pairSave"
          style="flex:1;padding:10px;border-radius:10px;
                 background:#007a3f;border:0;color:#fff;
                 font-weight:900;cursor:pointer;">
          Pair
        </button>
        <button id="pairClear"
          style="padding:10px;border-radius:10px;
                 background:#333;border:0;color:#fff;
                 font-weight:700;cursor:pointer;">
          Clear
        </button>
      </div>

      <div id="pairMsg"
        style="margin-top:10px;font-size:12px;opacity:.8;"></div>
    </div>
  `;

    document.body.appendChild(wrap);

    const input = wrap.querySelector("#pairCodeInput");
    const msg = wrap.querySelector("#pairMsg");

    wrap.querySelector("#pairClear").onclick = () => {
      clearDisplayToken();
      input.value = "";
      msg.textContent = "Cleared saved pairing token.";
      input.focus();
    };

    wrap.querySelector("#pairSave").onclick = () => {
      const v = input.value.trim();
      if (!/^\d{6}$/.test(v)) {
        msg.textContent = "Enter a valid 6-digit code.";
        return;
      }
      msg.textContent = "Pairing...";
      fetch(withDisplayBranch("/api/display/pair/complete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: v }),
      })
        .then((r) => r.json().catch(() => null).then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok || !j || !j.ok || !j.token) {
            msg.textContent = (j && (j.error || j.message)) || "Pairing failed.";
            return;
          }
          localStorage.setItem(DISPLAY_TOKEN_STORAGE, String(j.token));
          msg.textContent = "Paired. Reloading...";
          setTimeout(() => location.reload(), 250);
        })
        .catch(() => {
          msg.textContent = "Pairing request failed.";
        });
    };

    setTimeout(() => input.focus(), 50);

    // Stop app until paired
    throw new Error("Display not paired");
  }

  function loadLocalSettings() {
    try {
      return safeJsonParse(localStorage.getItem(SETTINGS_KEY) || "{}", {});
    } catch {
      return {};
    }
  }

  function saveLocalSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s || {}));
    } catch {}
  }

  function getDisplayBranchCode() {
    try {
      const qs = new URLSearchParams(window.location.search || "");
      const qCode = String(qs.get("branchCode") || "").trim().toUpperCase();
      if (qCode) return qCode;
    } catch {}
    try {
      const parts = String(window.location.pathname || "").split("/").filter(Boolean);
      const idx = parts.findIndex((part) => String(part || "").toLowerCase() === "b");
      if (idx >= 0 && parts[idx + 1]) return String(parts[idx + 1] || "").trim().toUpperCase();
    } catch {}
    return "";
  }

  function withDisplayBranch(url) {
    const raw = String(url || "");
    const branchCode = getDisplayBranchCode();
    if (!branchCode || !raw.startsWith("/api/")) return raw;
    try {
      const u = new URL(raw, window.location.origin);
      if (!u.searchParams.get("branchCode")) u.searchParams.set("branchCode", branchCode);
      return u.pathname + u.search;
    } catch {
      const sep = raw.includes("?") ? "&" : "?";
      return `${raw}${sep}branchCode=${encodeURIComponent(branchCode)}`;
    }
  }

  // Exposed for onclick="toggleSettings()"
  window.toggleSettings = function toggleSettings() {
    const p = document.getElementById("settingsPanel");
    if (!p) return;
    p.style.display = p.style.display === "block" ? "none" : "block";
  };

  async function fetchAdminDisplaySettings() {
    try {
      const token = getDisplayToken();
      const url = token
        ? withDisplayBranch("/api/display/settings?token=" + encodeURIComponent(token))
        : withDisplayBranch("/api/display/settings");
      const r = await fetch(url, {
        cache: "no-store",
        headers: token ? { "x-display-token": token } : {},
      });
      if (r.status === 401 || r.status === 403) {
        clearDisplayToken();
        setTimeout(() => location.reload(), 200);
        return null;
      }
      const j = await r.json();
      if (!j || !j.ok) return null;
      return j.settings || {};
    } catch {
      return null;
    }
  }

  function applyDisplayLayoutFromSettings(settings) {
    const showVideo =
      String(settings?.["display.showVideo"] ?? "false") === "true";
    const orientation = String(
      settings?.["display.orientation"] ?? "landscape",
    );

    document.body.classList.toggle("mode-video", showVideo);
    document.body.classList.toggle("mode-grid", !showVideo);

    document.body.classList.toggle(
      "orient-portrait",
      orientation === "portrait",
    );
    document.body.classList.toggle(
      "orient-landscape",
      orientation !== "portrait",
    );
  }

  function isVideoMode() {
    return document.body.classList.contains("mode-video");
  }

  function stopVideo(adPlayer) {
    if (!adPlayer) return;
    try {
      adPlayer.pause();
    } catch {}
    try {
      adPlayer.removeAttribute("src");
      adPlayer.load();
    } catch {}
  }

  function getUiScale() {
    const v = Number(localStorage.getItem(UI_SCALE_KEY) || "1");
    if (!Number.isFinite(v)) return 1;
    return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, v));
  }

  function getViewportUiScaleCap() {
    const w = Math.max(1, Number(window.innerWidth) || UI_BASE_WIDTH);
    const h = Math.max(1, Number(window.innerHeight) || UI_BASE_HEIGHT);
    const fit = Math.min(w / UI_BASE_WIDTH, h / UI_BASE_HEIGHT);
    const capped = fit * 1.05;
    return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, capped));
  }

  function clampUiScale(v) {
    const raw = Number(v);
    const requested = Number.isFinite(raw) ? raw : 1;
    const hard = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, requested));
    return Math.min(hard, getViewportUiScaleCap());
  }

  function applyUiScale(v) {
    const scale = clampUiScale(v);
    document.documentElement.style.setProperty("--uiScale", String(scale));
    localStorage.setItem(UI_SCALE_KEY, String(scale));

    const lbl = document.getElementById("uiScaleLabel");
    if (lbl) lbl.textContent = `Scale: ${scale.toFixed(2)}x`;
    return scale;
  }

  function initUiScale() {
    const start = getUiScale();
    const applied = applyUiScale(start);

    const r = document.getElementById("uiScaleRange");
    if (r) {
      r.min = String(UI_SCALE_MIN);
      r.max = String(UI_SCALE_MAX);
      r.value = String(applied);
      r.addEventListener("input", () => {
        r.value = String(applyUiScale(r.value));
      });
      const onResize = () => {
        const wanted = Number(localStorage.getItem(UI_SCALE_KEY) || r.value || "1");
        r.value = String(applyUiScale(wanted));
      };
      window.addEventListener("resize", onResize, { passive: true });
    }
  }

  // ===== Chime handling (plays on newly CALLED tickets) =====
  // Chromium/Electron may block audio until a user gesture occurs.
  // We "unlock" once on first pointer/key interaction.
  let __audioUnlocked = false;
  let __lastAnnouncedCode = "";
  let __lastAnnouncedAt = 0;
  let __announceGeneration = 0;
  const __activeVoiceNodes = new Set();
  let __speechUtterance = null;

  function displayAudioBase() {
    try {
      if (typeof window.appUrl === "function") return window.appUrl("/static/assets/audio");
    } catch {}
    return "/static/assets/audio";
  }

  function unlockChimeOnce() {
    if (__audioUnlocked) return;
    const chime = window.DisplayUI?.getChimeEl?.();
    if (!chime) return;

    try {
      chime.muted = false;
      chime.volume = 1;
      chime.currentTime = 0;

      const p = chime.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          try {
            chime.pause();
          } catch {}
          try {
            chime.currentTime = 0;
          } catch {}
          __audioUnlocked = true;
        }).catch(() => {
          __audioUnlocked = false;
        });
      } else {
        __audioUnlocked = true;
      }
    } catch {
      __audioUnlocked = false;
    }

    try { warmVoiceCache(); } catch {}
  }

  function playChime() {
    const chime = window.DisplayUI?.getChimeEl?.();
    if (!chime) return;

    try {
      chime.muted = false;
      chime.volume = 1;
      chime.currentTime = 0;
      const p = chime.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }

  function stopCurrentAnnouncement() {
    __announceGeneration += 1;
    try {
      const chime = window.DisplayUI?.getChimeEl?.();
      if (chime) {
        chime.pause();
        chime.currentTime = 0;
      }
    } catch {}
    try {
      for (const node of __activeVoiceNodes) {
        try { node.stop(0); } catch {}
      }
      __activeVoiceNodes.clear();
    } catch {}
    try {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      __speechUtterance = null;
    } catch {}
  }

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  function buildSpeechTextFromCode(code) {
    const compact = String(code || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!compact) return "";
    const isPriority = compact.startsWith("P") && compact.length >= 3;
    const group = isPriority ? compact.slice(0, 2) : compact.slice(0, 1);
    const digits = (isPriority ? compact.slice(2) : compact.slice(1))
      .split("")
      .filter(Boolean)
      .join(" ");
    if (!digits) return `Now serving ${group}. Please proceed to the counter.`;
    return `Now serving ${group} ${digits}. Please proceed to the counter.`;
  }

  function speakWithSpeechSynthesis(code, generation) {
    return new Promise((resolve) => {
      try {
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
          resolve(false);
          return;
        }
        const text = buildSpeechTextFromCode(code);
        if (!text) {
          resolve(false);
          return;
        }
        const utter = new window.SpeechSynthesisUtterance(text);
        utter.rate = 0.95;
        utter.pitch = 1;
        utter.volume = 1;
        utter.onend = () => {
          if (generation === __announceGeneration) __speechUtterance = null;
          resolve(true);
        };
        utter.onerror = () => {
          if (generation === __announceGeneration) __speechUtterance = null;
          resolve(false);
        };
        __speechUtterance = utter;
        try { window.speechSynthesis.cancel(); } catch {}
        window.speechSynthesis.speak(utter);
      } catch {
        resolve(false);
      }
    });
  }

  async function playChimeThenVoice(code, generation){
    const c = String(code || "").trim();
    if (!c) return;
    __lastAnnouncedCode = c;
    __lastAnnouncedAt = Date.now();
    try { playChime(); } catch {}
    await sleep(1000);
    if (generation !== __announceGeneration) return;
    try { await playQueueVoice(c, generation); } catch {}
  }

  async function announceCode(code, opts){
    const c = String(code || "").trim();
    if (!c) return;
    const o = opts || {};
    const force = !!o.force;
    const now = Date.now();
    if (!force && c === __lastAnnouncedCode && (now - __lastAnnouncedAt) < 2500) {
      return;
    }
    stopCurrentAnnouncement();
    const gen = __announceGeneration;
    await playChimeThenVoice(c, gen);
  }

  // Optional renderer hook (used by landscape now-serving change detection).
  window.__qsysAnnounceNowServing = function(code, opts){
    return announceCode(code, opts);
  };

  // --------------------
  // Voice playback (gapless WebAudio + silence trim)
  // This removes "weird pauses" between letter and number clips caused by file-internal silence
  // and/or decode/loading gaps.
  // --------------------
  const __voiceBufCache = new Map();
  let __voiceCtx = null;

  function getVoiceCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!__voiceCtx) __voiceCtx = new AC();
    // Try to resume if suspended (autoplay policies). If it fails, playback will simply no-op.
    try { if (__voiceCtx.state === "suspended") __voiceCtx.resume().catch(() => {}); } catch {}
    return __voiceCtx;
  }

  async function fetchDecodeBuffer(src) {
    if (__voiceBufCache.has(src)) return __voiceBufCache.get(src);
    const ctx = getVoiceCtx();
    if (!ctx) return null;

    try {
      const r = await fetch(src, { cache: "force-cache" });
      const ab = await r.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab.slice(0));
      __voiceBufCache.set(src, buf);
      return buf;
    } catch {
      __voiceBufCache.set(src, null);
      return null;
    }
  }

  function trimSilence(buffer, threshold = 0.003, padMs = 12) {
    // Returns { buffer, start, duration } where start/duration are in seconds within the original buffer
    if (!buffer) return null;

    const sr = buffer.sampleRate;
    const pad = Math.max(0, padMs) / 1000;

    // Find max across channels at each sample to detect silence.
    const len = buffer.length;
    if (!len) return { buffer, start: 0, duration: 0 };

    let start = 0;
    let end = len - 1;

    // scan from start
    outerStart:
    for (let i = 0; i < len; i++) {
      let m = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const d = buffer.getChannelData(ch);
        const v = Math.abs(d[i]);
        if (v > m) m = v;
      }
      if (m > threshold) { start = i; break outerStart; }
    }

    // scan from end
    outerEnd:
    for (let i = len - 1; i >= 0; i--) {
      let m = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const d = buffer.getChannelData(ch);
        const v = Math.abs(d[i]);
        if (v > m) m = v;
      }
      if (m > threshold) { end = i; break outerEnd; }
    }

    // If everything is "silence", keep tiny slice
    if (end <= start) {
      return { buffer, start: 0, duration: Math.min(0.05, buffer.duration) };
    }

    let sSec = (start / sr) - pad;
    let eSec = (end / sr) + pad;
    if (sSec < 0) sSec = 0;
    if (eSec > buffer.duration) eSec = buffer.duration;

    const dur = Math.max(0, eSec - sSec);
    return { buffer, start: sSec, duration: dur };
  }

  async function playVoiceSequence(srcs, generation) {
    const ctx = getVoiceCtx();
    if (!ctx) return;

    // Ensure context is running
    try { if (ctx.state === "suspended") await ctx.resume(); } catch {}

    // Decode + trim all first so scheduling is accurate
    const parts = [];
    for (const src of srcs) {
      if (generation !== __announceGeneration) return;
      const buf = await fetchDecodeBuffer(src);
      const t = trimSilence(buf);
      if (t && t.duration > 0) parts.push({ src, ...t });
    }
    if (!parts.length) return;

    const startAt = ctx.currentTime + 0.02;
    let t0 = startAt;

    for (const p of parts) {
      if (generation !== __announceGeneration) return;
      try {
        const node = ctx.createBufferSource();
        node.buffer = p.buffer;
        node.connect(ctx.destination);
        __activeVoiceNodes.add(node);
        node.onended = () => __activeVoiceNodes.delete(node);
        node.start(t0, p.start, p.duration);
      } catch {}
      t0 += p.duration;
    }

    // Resolve after final scheduled playback
    const total = t0 - startAt;
    await new Promise((res) => setTimeout(res, Math.ceil(total * 1000) + 30));
  }

  // Warm the cache once the user interacts (avoids autoplay decode issues)
  function warmVoiceCache() {
    const base = displayAudioBase();
    const srcs = [
      `${base}/now_serving.mp3`,
      `${base}/proceed_to_counter.mp3`,
      // Common letters/groups
      `${base}/letters/A.mp3`, `${base}/letters/B.mp3`, `${base}/letters/C.mp3`, `${base}/letters/D.mp3`,
      `${base}/letters/PA.mp3`, `${base}/letters/PB.mp3`, `${base}/letters/PC.mp3`, `${base}/letters/PD.mp3`,
    ];
    for (let i = 0; i <= 9; i++) srcs.push(`${base}/numbers/${i}.mp3`);
    // Fire and forget
    srcs.forEach((s) => { fetchDecodeBuffer(s); });
  }




  async function playQueueVoice(code, generation) {
    if (!code) return;

    const base = displayAudioBase();
    const s = String(code).toUpperCase().replace("-", "");

    // Examples:
    // A12   â†’ letter=A, digits=1,2
    // PA03  â†’ letter=PA, digits=0,3

    const isPriority = s.startsWith("P");
    const letter = isPriority ? s.slice(0, 2) : s.slice(0, 1);
    const digits = (isPriority ? s.slice(2) : s.slice(1)).split("");

    const srcs = [
      `${base}/now_serving.mp3`,
      `${base}/letters/${letter}.mp3`,
      ...digits.map((d) => `${base}/numbers/${d}.mp3`),
      `${base}/proceed_to_counter.mp3`,
    ];

    try {
      await playVoiceSequence(srcs, generation);
      return;
    } catch {}
    try {
      await speakWithSpeechSynthesis(code, generation);
    } catch {}
  }

  // Attach unlock listeners once (safe even if audio element missing)
  window.addEventListener("pointerdown", unlockChimeOnce, {
    once: true,
    passive: true,
  });
  window.addEventListener("keydown", unlockChimeOnce, { once: true });
  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      try { unlockChimeOnce(); } catch {}
    }, 250);
  }, { once: true });

  // ===== Helpers for queue formatting =====
  function isPriorityRow(r) {
    return String(r?.groupCode || "").toUpperCase() === "P";
  }

  function paxToBucket(r) {
    const pax = Number(r?.pax);
    if (Number.isFinite(pax) && pax > 0) {
      if (pax <= 1) return "A";
      if (pax <= 3) return "B";
      if (pax <= 5) return "C";
      return "D";
    }

    const g = String(r?.groupCode || "").toUpperCase();
    if (g === "A" || g === "B" || g === "C" || g === "D") return g;

    return "B";
  }

  function pad2(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    return String(x).padStart(2, "0");
  }

  function displayGroupCode(r) {
    const g = String(r?.groupCode || "").toUpperCase();
    if (g === "P") return "P" + paxToBucket(r); // PA/PB/PC/PD
    return g; // A/B/C/D
  }

  function ticketText(r) {
    if (!r) return "";
    const qn = pad2(r.queueNum);
    if (!qn) return "";
    const gc = displayGroupCode(r);
    return `${gc}-${qn}`;
  }

  function sortByQueueNum(a, b) {
    return (a?.queueNum || 0) - (b?.queueNum || 0);
  }

  function pickCalledForBucket(rows, bucketCode) {
    const called = rows
      .filter((r) => String(r?.status || "").toUpperCase() === "CALLED")
      .filter((r) => paxToBucket(r) === bucketCode);

    if (!called.length) return null;

    const pri = called.filter(isPriorityRow).sort(sortByQueueNum);
    if (pri.length) return pri[0];

    const reg = called.filter((r) => !isPriorityRow(r)).sort(sortByQueueNum);
    return reg[0] || called[0];
  }

  // ===== State fetching =====
  async function loadState(ui, state) {
    const statusEl = ui.getStatusEl?.();
    try {
      const token = ensureDisplayTokenUI();

      const url = token
        ? withDisplayBranch("/api/display/state?token=" + encodeURIComponent(token))
        : withDisplayBranch("/api/display/state");
      dbg("loadState() fetch", {
        url,
        hasToken: !!token,
        tokenPreview: token ? token.slice(0, 3) + "***" + token.slice(-3) : "",
      });

      const r = await fetch(url, {
        cache: "no-store",
        headers: token ? { "x-display-token": token } : {},
      });

      // Attempt JSON; if not JSON, keep a small snippet
      let j = null;
      let text = "";
      try {
        j = await r.json();
      } catch {
        try {
          text = await r.text();
        } catch {}
      }

      if (!r.ok || !j || !j.ok) {
        if (r.status === 401 || r.status === 403) {
          clearDisplayToken();
          setTimeout(() => location.reload(), 200);
        }
        const reason =
          j && (j.error || j.message)
            ? j.error || j.message
            : r.status
              ? "HTTP " + r.status
              : "bad-state";
        throw new Error(reason + (text ? " - " + String(text).slice(0, 60) : ""));
      }

      try {
        const rows = Array.isArray(j.rows) ? j.rows : [];
        const counts = {
          total: rows.length,
          WAITING: 0,
          CALLED: 0,
          SERVING: 0,
          OTHER: 0,
          priWaiting: 0,
        };
        const priExamples = [];
        for (const x of rows) {
          const st = String(x?.status || "").toUpperCase();
          if (st === "WAITING") counts.WAITING++;
          else if (st === "CALLED") counts.CALLED++;
          else if (st === "SERVING") counts.SERVING++;
          else counts.OTHER++;

          if (st === "WAITING") {
            const gc = String(x?.groupCode || "").toUpperCase();
            const pr = String(x?.priority || "").toUpperCase();
            const isPri =
              gc === "P" ||
              gc.startsWith("P") ||
              pr.includes("SENIOR") ||
              pr.includes("PWD");
            if (isPri) {
              counts.priWaiting++;
              if (priExamples.length < 10) {
                priExamples.push({
                  groupCode: gc,
                  queueNum: x?.queueNum,
                  pax: x?.pax,
                  priority: x?.priority,
                  status: st,
                });
              }
            }
          }
        }
        dbg("loadState() rows summary", { counts, priExamples });
        const priLine = priExamples
          .map(
            (x) =>
              `${x.groupCode}-${String(x.queueNum).padStart(2, "0")} pax:${x.pax} pr:${x.priority || ""}`,
          )
          .join(" | ");
        dbg("loadState() priExamples line", priLine || "(none)");
      } catch (e) {
        dbg("loadState() rows summary failed", {
          err: String(e?.message || e),
        });
      }

      // Branch name (for top bar). Prefer API-provided name if present.
      try {
        const bn = String(
          j.branchName ||
            j.branch?.branchName ||
            j.branch?.name ||
            j.meta?.branchName ||
            "",
        ).trim();
        if (bn) state.branchName = bn;
      } catch {}

      const __rows = j.rows || [];
      ui.render(__rows, state, helpers);
      if (statusEl)
        statusEl.textContent = "Updated - " + new Date().toLocaleTimeString();
      return __rows;
    } catch (err) {
      // IMPORTANT: still render an empty frame so placeholders (.qEmpty) appear.
      try {
        ui.render([], state, helpers);
      } catch {}
      if (statusEl)
        statusEl.textContent =
          "State load failed: " + (err?.message || "unknown");
      return [];
    }
  }

  // ===== Playlist/video =====
  async function loadPlaylist(state) {
    try {
      // IMPORTANT: video playlist must respect the same pairing token as state
      let token = "";
      try {
        token = ensureDisplayTokenUI();
      } catch {
        state.playlist = [];
        return;
      }

      const url = token
        ? withDisplayBranch(`/api/media/list?token=${encodeURIComponent(token)}`)
        : withDisplayBranch("/api/media/list");
      const headers = token ? { "x-display-token": token } : {};

      const r = await fetch(url, { cache: "no-store", headers });
      const j = await r.json();

      if (j && j.ok && Array.isArray(j.files) && j.files.length) {
        // Filter out Dash init fragments if present
        state.playlist = j.files
          .filter((p) => !/dashinit/i.test(p))
          .map((p) => window.appUrl(p));
      } else {
        state.playlist = [
          "/static/media/" + encodeURIComponent("SaveInsta.App - 3095952121509722877.mp4"),
          "/static/media/" + encodeURIComponent("SaveInsta.App - 3101717398286427917_369353778.mp4"),
        ].map((p) => window.appUrl(p));
      }
    } catch {
      state.playlist = [
        "/static/media/" + encodeURIComponent("SaveInsta.App - 3095952121509722877.mp4"),
        "/static/media/" + encodeURIComponent("SaveInsta.App - 3101717398286427917_369353778.mp4"),
      ].map((p) => window.appUrl(p));
    }
  }

  async function playNextVideo(ui, state) {
    const players = ui.getAdPlayers?.();
    const a = players?.a;
    const b = players?.b;

    // Fallback to single player if needed
    const single = ui.getAdPlayerEl?.();
    if (!a || !b) {
      if (!single || !state.playlist.length) return;
      const src = state.playlist[state.vidIndex % state.playlist.length];
      state.vidIndex++;
      applyVideoSoundSetting(single, state.displaySettings);
      single.src = src;
      try {
        await single.play();
      } catch {
        setTimeout(() => playNextVideo(ui, state), 300);
      }
      return;
    }

    if (!state.playlist.length) return;

    // Decide which is active / next
    const active = a.classList.contains("isActive") ? a : b;
    const next = active === a ? b : a;

    const src = state.playlist[state.vidIndex % state.playlist.length];
    state.vidIndex++;

    applyVideoSoundSetting(next, state.displaySettings);

    // Prepare next video off-screen (hidden)
    next.classList.remove("isActive");
    next.src = src;

    // Wait until it can render frames, then play
    const ready = await new Promise((resolve) => {
      const ok = () => {
        cleanup();
        resolve(true);
      };
      const bad = () => {
        cleanup();
        resolve(false);
      };

      const cleanup = () => {
        next.removeEventListener("canplay", ok);
        next.removeEventListener("loadeddata", ok);
        next.removeEventListener("error", bad);
        next.removeEventListener("stalled", bad);
      };

      next.addEventListener("canplay", ok, { once: true });
      next.addEventListener("loadeddata", ok, { once: true });
      next.addEventListener("error", bad, { once: true });
      next.addEventListener("stalled", bad, { once: true });

      // If already ready (cached), resolve quickly
      try {
        if (next.readyState >= 2) {
          cleanup();
          resolve(true);
        }
      } catch {}
    });

    if (!ready) {
      // skip bad file quickly
      setTimeout(() => playNextVideo(ui, state), 200);
      return;
    }

    try {
      await next.play();
    } catch {
      setTimeout(() => playNextVideo(ui, state), 300);
      return;
    }

    // Crossfade: show next, hide active
    next.classList.add("isActive");
    active.classList.remove("isActive");

    // After fade, stop the old one (hidden so any reset won't flash)
    setTimeout(() => {
      try {
        active.pause();
      } catch {}
      try {
        active.removeAttribute("src");
      } catch {}
      // DO NOT call active.load() (that can trigger compositor work); leaving it is fine
    }, 220);
  }

  function applyVideoSoundSetting(adPlayer, displaySettings) {
    if (!adPlayer) return;
    const soundOn = !!displaySettings.videoSound;
    adPlayer.autoplay = true;
    adPlayer.playsInline = true;
    adPlayer.muted = !soundOn;
    adPlayer.volume = soundOn ? 1.0 : 0.0;
  }

  function startPlaylistRefresh(ui, state) {
  if (state.playlistTimer) return;
  state.playlistTimer = setInterval(
    async () => {
      if (!isVideoMode()) return;

      await loadPlaylist(state);
      if (!state.playlist.length) return;

      const players = ui.getAdPlayers?.();
      const a = players?.a;
      const b = players?.b;

      // Dual-player: check ACTIVE
      if (a && b) {
        const active = a.classList.contains("isActive") ? a : b;
        if (active.paused || !active.src) playNextVideo(ui, state);
        return;
      }

      // Single-player fallback
      const adPlayer = ui.getAdPlayerEl?.();
      if (adPlayer && (adPlayer.paused || !adPlayer.src)) {
        playNextVideo(ui, state);
      }
    },
    5 * 60 * 1000,
  );
}


  function stopPlaylistRefresh(state) {
    if (!state.playlistTimer) return;
    clearInterval(state.playlistTimer);
    state.playlistTimer = null;
  }

  async function ensureVideoPlayingNow(ui, state) {
  if (!isVideoMode()) return;

  const players = ui.getAdPlayers?.();
  const a = players?.a;
  const b = players?.b;

  // If dual players exist, check the ACTIVE one
  if (a && b) {
    const active = a.classList.contains("isActive") ? a : b;

    if (!state.playlist.length) await loadPlaylist(state);
    if (!state.playlist.length) return;

    if (active.paused || !active.src) playNextVideo(ui, state);
    return;
  }

  // Fallback to single player
  const adPlayer = ui.getAdPlayerEl?.();
  if (!adPlayer) return;

  if (!state.playlist.length) await loadPlaylist(state);
  if (!state.playlist.length) return;

  if (adPlayer.paused || !adPlayer.src) playNextVideo(ui, state);
}


  async function refreshDisplayLayout(ui, state) {
    const adminSettings = await fetchAdminDisplaySettings();
    if (adminSettings) applyDisplayLayoutFromSettings(adminSettings);

    const nowVideoMode = isVideoMode();

    if (nowVideoMode) {
      startPlaylistRefresh(ui, state);
      if (state.lastVideoMode === null || state.lastVideoMode === false) {
        await ensureVideoPlayingNow(ui, state);
      }
    } else {
      stopPlaylistRefresh(state);
      stopVideo(ui.getAdPlayerEl?.());
    }

    state.lastVideoMode = nowVideoMode;
  }

  // ===== Header label =====
  async function setNowServingHeader() {
    const el = document.getElementById("nowServingHeader");
    const bt = document.getElementById("branchTitle");

    if (el) el.textContent = "Now Serving";

    try {
      const r1 = await fetch(withDisplayBranch("/api/public/business-date"), { cache: "no-store" });
      const j1 = await r1.json();
      const name1 = String(j1.branchName || "").trim();
      if (name1) {
        if (el) el.textContent = `${name1}`;
        if (bt) bt.textContent = name1;
        return;
      }
    } catch {}

    try {
      const r2 = await fetch(withDisplayBranch("/api/public/branch"), { cache: "no-store" });
      const j2 = await r2.json();
      const name2 = String(j2.branch?.branchName || "").trim();
      if (name2) el.textContent = `${name2}`;
    } catch {}
  }

  // ===== Kiosk hooks (preload-provided) =====
  window.closeKiosk = function closeKiosk() {
    // Support both legacy (window.kiosk) and refactor bridge (window.qsysDisplay)
    if (window.kiosk?.close) return window.kiosk.close();
    if (window.qsysDisplay?.close) return window.qsysDisplay.close();
    // Silent no-op in kiosk displays that remove controls
    console.warn("Close not available: no preload bridge found.");
  };

  function wireKioskButtons() {
    const btnMove = document.getElementById("btnMove");
    const btnFull = document.getElementById("btnFull");
    const btnClose = document.getElementById("btnClose");

    btnMove?.addEventListener("click", () => {
      if (window.kiosk?.moveMode) return window.kiosk.moveMode();
      if (window.qsysDisplay?.move) return window.qsysDisplay.move();
      console.warn("Move not available: no preload bridge found.");
    });

    btnFull?.addEventListener("click", () => {
      if (window.kiosk?.enterFullscreen) return window.kiosk.enterFullscreen();
      if (window.qsysDisplay?.fullscreen)
        return window.qsysDisplay.fullscreen();
      console.warn("Fullscreen not available: no preload bridge found.");
    });

    btnClose?.addEventListener("click", () => {
      if (window.closeKiosk) return window.closeKiosk();
      if (window.kiosk?.close) return window.kiosk.close();
      if (window.qsysDisplay?.close) return window.qsysDisplay.close();
      console.warn("Close not available: no preload bridge found.");
    });
  }

  window.moveKiosk = function moveKiosk() {
    if (window.kiosk?.moveMode) return window.kiosk.moveMode();
    if (window.qsysDisplay?.move) return window.qsysDisplay.move();
    console.warn("Move not available: no preload bridge found.");
  };

  window.fullscreenKiosk = function fullscreenKiosk() {
    if (window.kiosk?.enterFullscreen) return window.kiosk.enterFullscreen();
    if (window.qsysDisplay?.fullscreen) return window.qsysDisplay.fullscreen();
    console.warn("Fullscreen not available: no preload bridge found.");
  };

  // ===== Shared helpers object passed into UI =====
  const helpers = {
    isPriorityRow,
    paxToBucket,
    pad2,
    displayGroupCode,
    ticketText,
    sortByQueueNum,
    pickCalledForBucket,
  };

  function boot() {
    const ui = window.DisplayUI;
    if (!ui || typeof ui.render !== "function") {
      // Fail loudly (better than silently doing nothing)
      try {
        const st = document.getElementById("status");
        if (st)
          st.textContent =
            "DisplayUI missing: load display-ui-landscape.js before display-core.js";
      } catch {}
      return;
    }

    const statusEl = ui.getStatusEl?.();
    const adPlayer = ui.getAdPlayerEl?.();

    const state = {
      lastNowServing: {},
      calledKeys: new Set(),
      didInitCalledSnapshot: false,
      displaySettings: loadLocalSettings(),
      playlist: [],
      vidIndex: 0,
      playlistTimer: null,
      lastVideoMode: null,
      lastBeat: Date.now(),
    };

    // Video sound toggle
    const videoSoundToggle = document.getElementById("videoSoundToggle");
    if (videoSoundToggle) {
      videoSoundToggle.checked = !!state.displaySettings.videoSound;
      videoSoundToggle.addEventListener("change", async () => {
        state.displaySettings.videoSound = videoSoundToggle.checked;
        saveLocalSettings(state.displaySettings);
        applyVideoSoundSetting(adPlayer, state.displaySettings);

        if (state.displaySettings.videoSound) {
          try {
            await adPlayer?.play?.();
          } catch {
            if (statusEl) {
              statusEl.textContent =
                "Video sound ON, but audio may be blocked/unsupported - " +
                new Date().toLocaleTimeString();
            }
          }
        }
      });
    }

    // Player looping
   // Player looping (DUAL players supported)
{
  const players = ui.getAdPlayers?.();
  const a = players?.a;
  const b = players?.b;

  if (a && b) {
    // Apply sound setting to BOTH
    applyVideoSoundSetting(a, state.displaySettings);
    applyVideoSoundSetting(b, state.displaySettings);

    const onEndOrError = (ev) => {
      const el = ev?.currentTarget;
      // Only advance when the ACTIVE player ends/errors
      if (el && el.classList.contains("isActive")) playNextVideo(ui, state);
    };

    a.addEventListener("ended", onEndOrError);
    a.addEventListener("error", onEndOrError);

    b.addEventListener("ended", onEndOrError);
    b.addEventListener("error", onEndOrError);
  } else if (adPlayer) {
    // Single-player fallback
    adPlayer.addEventListener("ended", () => playNextVideo(ui, state));
    adPlayer.addEventListener("error", () => playNextVideo(ui, state));
    applyVideoSoundSetting(adPlayer, state.displaySettings);
  }
}


    initUiScale();
    setNowServingHeader();
    wireKioskButtons();

    // Layout refresh loop
    refreshDisplayLayout(ui, state);
    setInterval(() => refreshDisplayLayout(ui, state), 2500);

    // Initial state (snapshot CALLED tickets so we don't chime on first load)
    loadState(ui, state).then((rows) => {
      try {
        const called = (rows || []).filter(
          (r) => String(r?.status || "").toUpperCase() === "CALLED",
        );
        const keys = called.map(
          (r) =>
            `${String(r?.groupCode || "").toUpperCase()}-${pad2(r?.queueNum)}`,
        );
        state.calledKeys = new Set(keys);
        state.didInitCalledSnapshot = true;
      } catch {}
    });

    // Socket
    const branchCode = getDisplayBranchCode();
    const socket = io({
      path: window.appUrl("/socket.io"),
      query: branchCode ? { branchCode } : undefined,
      transports: ["websocket", "polling"],
    });



  // Imperative recall: replay attention even if the CALLED ticket did not change
socket.on("display:recall", async (payload) => {
  const code = (payload && payload.code) ? payload.code : __lastAnnouncedCode;
  try { await announceCode(code, { force: true }); } catch {}
  try { window.DisplayUI?.forceHeroPulse?.(); } catch {}
});


dbgDisp("socket:init");
socket.on("connect", ()=>dbgDisp("socket:connect", {id: socket.id}));
socket.on("disconnect", (reason)=>dbgDisp("socket:disconnect", {reason}));
dbgDisp("socket:init");
socket.on("connect", ()=>dbgDisp("socket:connect", {id: socket.id}));
socket.on("disconnect", (reason)=>dbgDisp("socket:disconnect", {reason}));
socket.on("heartbeat", () => {
      state.lastBeat = Date.now();
    });

    // reload if heartbeat stops (display got stale)
    setInterval(() => {
      if (Date.now() - state.lastBeat > 30000) location.reload();
    }, 5000);

    socket.on("connect", () => {
      state.lastBeat = Date.now();
      if (statusEl) statusEl.textContent = "Connected - waiting for updates";
    });

    socket.on("disconnect", () => {
      if (statusEl) statusEl.textContent = "Disconnected - retrying...";
    });

    socket.on("state:changed", async (payload) => {
    dbgDisp("state:changed", payload);
      if (payload && payload.reason === "ADMIN_MEDIA_SOURCE_UPDATE") {
        console.log("[display] media source changed -> reloading");
        location.reload();
        return;
      }

      if (payload && payload.reason === "ADMIN_SETTINGS_UPDATE") {
        try { await refreshDisplayLayout(ui, state); } catch {}
      }

      const rows = await loadState(ui, state);

      // Chime + Voice: play once when a NEW CALLED ticket appears (compared to prior snapshot)
      try {
        const called = (rows || []).filter(
          (r) => String(r?.status || "").toUpperCase() === "CALLED",
        );

        const keyFor = (r) =>
          `${String(r?.groupCode || "").toUpperCase()}-${pad2(r?.queueNum)}`;

        const keys = called.map(keyFor);

        if (!state.didInitCalledSnapshot) {
          // First load: snapshot only (no audio)
          state.calledKeys = new Set(keys);
          state.didInitCalledSnapshot = true;
        } else {
          const prev = state.calledKeys || new Set();
          const newlyCalled = [];

          for (const r of called) {
            const k = keyFor(r);
            if (!prev.has(k)) newlyCalled.push(r);
          }

          // Update snapshot BEFORE playing, to avoid double audio on rapid events
          state.calledKeys = new Set(keys);

          if (newlyCalled.length) {
            // Speak ONLY the first newly-called ticket (avoid stacked announcements)
            const code = ticketText(newlyCalled[0]); // e.g., A-12, PB-03
            try { await announceCode(code); } catch {}
          }
        }
      } catch {}

try {
        await loadPlaylist(state);
        if (isVideoMode()) await ensureVideoPlayingNow(ui, state);
      } catch {}
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

