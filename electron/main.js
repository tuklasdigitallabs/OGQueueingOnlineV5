// main.js (UPDATED: boots into Launcher window, Display opens on-demand)

const {
  app,
  BrowserWindow,
  dialog,
  powerSaveBlocker,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
  shell, // ✅ NEW
} = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

// ✅ Allow audio autoplay in kiosk without user gesture
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch(
  "disable-features",
  "PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies"
);
// ✅ Extra nudge for some builds (harmless if ignored)
app.commandLine.appendSwitch("disable-site-isolation-trials");

// Start your local Express server
const { startServer } = require("../server/server");

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  try {
    dialog.showErrorBox(
      "QSys Already Running",
      "Another QSys instance is already running.\n\nPlease close the existing QSys window first before opening a new one."
    );
  } catch {}
  app.quit();
  try { app.exit(0); } catch {}
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);

    if (ent.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (ent.isFile()) {
      if (!exists(d)) fs.copyFileSync(s, d);
    }
  }
}

/**
 * PROD base directory: store persistent data in ProgramData
 */
function getBaseDir() {
  const programData = process.env.PROGRAMDATA || "C:\\ProgramData";
  return path.join(programData, "QSysLocal");
}

function getOldDevDataDir() {
  return path.join(__dirname, "..", "data");
}

function migrateDevDataIfNeeded(baseDir) {
  try {
    const marker = path.join(baseDir, ".migrated_from_dev");
    if (exists(marker)) return;

    const oldDir = getOldDevDataDir();
    if (!exists(oldDir)) {
      fs.writeFileSync(marker, String(Date.now()), "utf8");
      return;
    }

    const oldEntries = fs.readdirSync(oldDir);
    if (!oldEntries || oldEntries.length === 0) {
      fs.writeFileSync(marker, String(Date.now()), "utf8");
      return;
    }

    copyDirRecursive(oldDir, baseDir);
    fs.writeFileSync(marker, String(Date.now()), "utf8");
    console.log(`[QSysLocal] Migrated dev data from: ${oldDir} -> ${baseDir}`);
  } catch (e) {
    console.error("[QSysLocal] Data migration failed:", e);
  }
}

function loadConfig(baseDir) {
  const cfgPath = path.join(baseDir, "config.json");

  if (!fs.existsSync(cfgPath)) {
    const defaultCfg = {
      port: 3000,
      branchCode: "DEV",
      displayMode: "landscape",
      kioskUrlLandscape: "/display-landscape.html",
      kioskUrlPortrait: "/display-portrait.html",
      kioskUrl: "/display",
      kioskUrlForce: "",
    };
    fs.writeFileSync(cfgPath, JSON.stringify(defaultCfg, null, 2), "utf8");
    return defaultCfg;
  }

  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    const fallback = {
      port: 3000,
      branchCode: "DEV",
      displayMode: "landscape",
      kioskUrlLandscape: "/display-landscape.html",
      kioskUrlPortrait: "/display-portrait.html",
      kioskUrl: "/display",
    };
    fs.writeFileSync(cfgPath, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }
}

function saveConfig(baseDir, cfg) {
  const cfgPath = path.join(baseDir, "config.json");
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[QSysLocal] Failed to save config:", e);
    return false;
  }
}

function normalizeDisplayMode(mode) {
  const m = String(mode || "").trim().toLowerCase();
  return m === "portrait" ? "portrait" : "landscape";
}

function resolveKioskUrl(cfg) {
  const forced = String(cfg?.kioskUrlForce || "").trim();
  if (forced) return forced;
  return "/display";
}

let win = null; // kiosk display window
let launcherWin = null; // ✅ NEW: launcher window
let isQuitting = false;
let tray = null;
let baseDirGlobal = null;
let cfgGlobal = null;
let currentDisplayId = null;
let displaySpeechProc = null;

// ===== Force to "Screen 2" (sorted index 1) =====
function getScreen2Bounds() {
  const displays = screen.getAllDisplays();

  const sorted = [...displays].sort((a, b) => {
    if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x;
    return a.bounds.y - b.bounds.y;
  });

  if (sorted.length >= 2) return sorted[1].bounds;
  return screen.getPrimaryDisplay().bounds;
}

function forceWindowToScreen2(bw) {
  if (!bw || bw.isDestroyed()) return;
  const b = getScreen2Bounds();

  bw.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, false);
  bw.setFullScreen(true);
}

function getDisplayTargetList() {
  const displays = [...screen.getAllDisplays()].sort((a, b) => {
    if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x;
    return a.bounds.y - b.bounds.y;
  });
  return displays.map((d, idx) => ({
    id: Number(d.id),
    label: `Screen ${idx + 1}${d.primary ? " (Primary)" : ""} - ${d.bounds.width}x${d.bounds.height} @ ${d.bounds.x},${d.bounds.y}`,
    bounds: { ...d.bounds },
    primary: !!d.primary,
  }));
}

function getDisplayBoundsById(displayId) {
  const normalized = Number(displayId);
  if (Number.isFinite(normalized)) {
    const match = screen.getAllDisplays().find((d) => Number(d.id) === normalized);
    if (match) return match.bounds;
  }
  return getScreen2Bounds();
}

function forceWindowToDisplay(bw, displayId) {
  if (!bw || bw.isDestroyed()) return;
  const b = getDisplayBoundsById(displayId);
  bw.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, false);
  bw.setFullScreen(true);
}

function stopDisplaySpeech() {
  try {
    if (displaySpeechProc && !displaySpeechProc.killed) displaySpeechProc.kill();
  } catch {}
  displaySpeechProc = null;
}

function escapePowerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function buildDisplaySpeechText({ text, code } = {}) {
  const custom = String(text || "").trim();
  if (custom) return custom;

  const compact = String(code || "")
    .trim()
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

function speakDisplayText({ text, code } = {}) {
  const spokenText = buildDisplaySpeechText({ text, code });
  if (!spokenText) return { ok: false, error: "Missing announcement text" };

  stopDisplaySpeech();

  const command = [
    "Add-Type -AssemblyName System.Speech",
    "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$speaker.Volume = 100",
    "$speaker.Rate = 0",
    `$speaker.Speak(${escapePowerShellString(spokenText)})`,
  ].join("; ");

  try {
    displaySpeechProc = execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      { windowsHide: true },
      () => {
        displaySpeechProc = null;
      }
    );
    return { ok: true, text: spokenText };
  } catch (error) {
    displaySpeechProc = null;
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * ✅ TOP-LEVEL helpers (tray + server endpoints need these)
 */
function ensureKioskWindow() {
  if (win && !win.isDestroyed()) return win;
  if (!cfgGlobal) return null;

  const kioskUrl = resolveKioskUrl(cfgGlobal);
  createKioskWindow(cfgGlobal.port, kioskUrl);

  if (win && !win.isDestroyed()) return win;
  return null;
}

function showKioskWindow() {
  const w = ensureKioskWindow();
  if (!w || w.isDestroyed()) return;

  forceWindowToDisplay(w, currentDisplayId);
  w.show();
  w.focus();
}

function ensureLauncherWindow() {
  if (launcherWin && !launcherWin.isDestroyed()) return launcherWin;
  if (!cfgGlobal) return null;
  createLauncherWindow(cfgGlobal.port);
  if (launcherWin && !launcherWin.isDestroyed()) return launcherWin;
  return null;
}

function showLauncherWindow() {
  const w = ensureLauncherWindow();
  if (!w || w.isDestroyed()) return;
  w.show();
  w.focus();
}

ipcMain.on("kiosk-close", () => {
  if (win && !win.isDestroyed()) win.hide();
});

ipcMain.on("kiosk-toggle-fullscreen", () => {
  if (!win || win.isDestroyed()) return;
  win.setFullScreen(!win.isFullScreen());
});

ipcMain.on("kiosk-enter-fullscreen", () => {
  if (!win || win.isDestroyed()) return;
  win.setFullScreen(true);
});

ipcMain.on("kiosk-move-mode", () => {
  if (!win || win.isDestroyed()) return;
  win.setFullScreen(false);
  win.setKiosk(false);
  win.setAlwaysOnTop(false);
  win.focus();
});

ipcMain.on("kiosk-lock-screen2", () => {
  if (!win || win.isDestroyed()) return;
  forceWindowToScreen2(win);
  win.setKiosk(true);
});

// ✅ NEW: Launcher actions (buttons call these)
ipcMain.on("launcher-open", (_evt, target) => {
  if (!cfgGlobal) return;
  const base = `http://127.0.0.1:${cfgGlobal.port}`;

  if (target === "staff") return shell.openExternal(`${base}/staff`);
  if (target === "admin") return shell.openExternal(`${base}/admin`);
  if (target === "guest") return shell.openExternal(`${base}/guest`);
  if (target === "display") return showKioskWindow();
  if (target === "shutdown") {
    isQuitting = true;
    stopDisplaySpeech();
    return app.quit();
  }

  // fallback
  return shell.openExternal(base);
});

function createKioskWindow(port, kioskUrl) {
  win = new BrowserWindow({
    fullscreen: false,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,

    icon: path.join(__dirname, "../server/public/assets/icons/Yakiniku-Like-logo.ico"),

    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  win.webContents.setAudioMuted(false);

  const url = `http://127.0.0.1:${port}${kioskUrl}`;
  win.loadURL(url);

  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.once("ready-to-show", () => {
    forceWindowToDisplay(win, currentDisplayId);
    win.show();
  });

  const reforce = () => forceWindowToDisplay(win, currentDisplayId);
  screen.on("display-added", reforce);
  screen.on("display-removed", reforce);
  screen.on("display-metrics-changed", reforce);

  win.on("closed", () => (win = null));
}

// ✅ NEW: create launcher window (loads /static/launcher.html via Express)
function createLauncherWindow(port) {
  launcherWin = new BrowserWindow({
    width: 900,
    height: 600,
    resizable: false,
    frame: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../server/public/assets/icons/Yakiniku-Like-logo.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // ✅ Load launcher via local server (avoids filesystem path issues)
  const url = `http://127.0.0.1:${port}/static/launcher.html`;
  launcherWin.loadURL(url);

  launcherWin.on("closed", () => {
    launcherWin = null;
  });
}

function reloadDisplayWindow() {
  if (!win || win.isDestroyed()) return false;
  if (!cfgGlobal) return false;
  const kioskUrl = resolveKioskUrl(cfgGlobal);
  const url = `http://127.0.0.1:${cfgGlobal.port}${kioskUrl}`;
  win.loadURL(url);
  return true;
}

function setDisplayMode(mode) {
  const newMode = normalizeDisplayMode(mode);
  if (!cfgGlobal || !baseDirGlobal) return { ok: false, error: "Config not initialized" };

  cfgGlobal.displayMode = newMode;
  cfgGlobal.kioskUrl = resolveKioskUrl(cfgGlobal);

  const saved = saveConfig(baseDirGlobal, cfgGlobal);
  if (!saved) return { ok: false, error: "Failed to save config" };

  const reloaded = reloadDisplayWindow();
  return { ok: true, mode: newMode, reloaded };
}

function createTray() {
  if (tray) return;

  const iconPath = path.join(__dirname, "../server/public/assets/icons/Yakiniku-Like-logo.ico");
  let icon = undefined;
  try {
    if (fs.existsSync(iconPath)) icon = nativeImage.createFromPath(iconPath);
  } catch {}

  tray = new Tray(icon || nativeImage.createEmpty());

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Launcher",
      click: () => showLauncherWindow(),
    },
    {
      label: "Open Staff Login (Browser)",
      click: () => {
        if (!cfgGlobal) return;
        shell.openExternal(`http://127.0.0.1:${cfgGlobal.port}/staff`);
      },
    },
    {
      label: "Open Admin Login (Browser)",
      click: () => {
        if (!cfgGlobal) return;
        shell.openExternal(`http://127.0.0.1:${cfgGlobal.port}/admin`);
      },
    },
    { type: "separator" },
    {
      label: "Show Display",
      click: () => showKioskWindow(),
    },
    {
      label: "Hide Display",
      click: () => {
        if (win && !win.isDestroyed()) win.hide();
      },
    },
    { type: "separator" },
    {
      label: "Quit QSys",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("QSys Local");
  tray.setContextMenu(menu);

  // Double-click: show launcher (not display)
  tray.on("double-click", () => showLauncherWindow());
}

const http = require("http");

function waitForServer(port, timeoutMs = 20000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 }, () => {
        resolve(true);
      });

      req.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) return reject(new Error("Server did not become healthy"));
        setTimeout(tick, 350);
      });

      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - startedAt > timeoutMs) return reject(new Error("Server health timed out"));
        setTimeout(tick, 350);
      });
    };

    tick();
  });
}

function probeExistingQSys(port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(body || "{}");
          const looksLikeQSys =
            !!json &&
            json.ok === true &&
            Number(json.port) === Number(port) &&
            typeof json.currentBusinessDate === "string" &&
            typeof json.todayManila === "string";
          resolve(looksLikeQSys ? json : null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 520,
    height: 320,
    frame: false,
    resizable: false,
    alwaysOnTop: false,
    show: true,
    backgroundColor: "#0b0f17",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const html = `
    <html><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
      body{margin:0; background:#0b0f17; color:#e5e7eb; font-family:system-ui,Segoe UI,Roboto,Arial; display:flex; align-items:center; justify-content:center; height:100vh;}
      .box{width:86%; padding:22px; border-radius:16px; background:#111827; border:1px solid rgba(255,255,255,.08); box-shadow:0 18px 40px rgba(0,0,0,.35);}
      .t{font-size:18px; font-weight:800; margin-bottom:8px;}
      .s{opacity:.75; font-size:13px; line-height:1.35}
      .bar{margin-top:14px; height:10px; border-radius:99px; background:rgba(255,255,255,.08); overflow:hidden;}
      .bar > div{height:100%; width:40%; background:rgba(245,158,11,.9); border-radius:99px; animation: m 1.1s ease-in-out infinite;}
      @keyframes m{0%{transform:translateX(-60%)}50%{transform:translateX(140%)}100%{transform:translateX(-60%)}}
    </style></head>
    <body>
      <div class="box">
        <div class="t">Starting QSys…</div>
        <div class="s">Initializing local server and loading launcher.</div>
        <div class="bar"><div></div></div>
      </div>
    </body></html>
  `;
  splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  return splash;
}

function showBlockingStartupError(message, details) {
  try {
    dialog.showMessageBoxSync({
      type: "error",
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
      title: "QSys Startup Error",
      message,
      detail: String(details || ""),
    });
  } catch {
    // Fallback for edge cases where dialog cannot be shown.
    try {
      dialog.showErrorBox("QSys Startup Error", `${message}\n\n${String(details || "")}`);
    } catch {}
  }
}

function showAlreadyRunningError(port, details) {
  const message = "QSys is already running on this PC.";
  const detail =
    "Please close the existing QSys instance first before opening a new one." +
    (details ? `\n\n${details}` : "") +
    `\n\nDetected local QSys server: http://127.0.0.1:${port}`;
  try {
    dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
      title: "QSys Already Running",
      message,
      detail,
    });
  } catch {
    try {
      dialog.showErrorBox("QSys Already Running", `${message}\n\n${detail}`);
    } catch {}
  }
}

function focusPrimaryWindow() {
  const preferred = [launcherWin, win].find((w) => w && !w.isDestroyed());
  if (!preferred) return;
  try {
    if (preferred.isMinimized()) preferred.restore();
  } catch {}
  try { preferred.show(); } catch {}
  try { preferred.focus(); } catch {}
}

app.on("second-instance", () => {
  focusPrimaryWindow();
});

app.whenReady().then(async () => {
  powerSaveBlocker.start("prevent-display-sleep");

  app.setLoginItemSettings({ openAtLogin: true });
  createTray();

  const splash = createSplashWindow();

  const baseDir = getBaseDir();
  baseDirGlobal = baseDir;
  ensureDir(baseDir);

  migrateDevDataIfNeeded(baseDir);

  const cfg = loadConfig(baseDir);
  cfg.displayMode = normalizeDisplayMode(cfg.displayMode);
  cfg.kioskUrl = resolveKioskUrl(cfg);
  cfgGlobal = cfg;

  const existingQSys = await probeExistingQSys(cfg.port);
  if (existingQSys) {
    if (splash && !splash.isDestroyed()) splash.close();
    focusPrimaryWindow();
    showAlreadyRunningError(
      cfg.port,
      existingQSys.branchName ? `Running branch: ${String(existingQSys.branchName).trim()}` : ""
    );
    isQuitting = true;
    setTimeout(() => app.quit(), 200);
    return;
  }

  const logsDir = path.join(baseDir, "logs");
  ensureDir(logsDir);

  startServer({
    baseDir,
    port: cfg.port,
    branchCode: cfg.branchCode,
  });

  try {
    await waitForServer(cfg.port, 25000);
  } catch (e) {
    console.error("[QSysLocal] Server failed to start:", e);

    if (splash && !splash.isDestroyed()) {
      splash.webContents
        .executeJavaScript(
          `document.querySelector('.s').textContent =
           'Server failed to start. Please restart the PC or reinstall.';`
        )
        .catch(() => {});
      splash.close();
    }

    showBlockingStartupError(
      "The local server failed to start.",
      "Try restarting the PC. If this keeps happening, reinstall QSys.\n\n" +
        `Details: ${String(e && e.message ? e.message : e)}`
    );

    isQuitting = true;
    setTimeout(() => app.quit(), 500);
    return;
  }

  if (splash && !splash.isDestroyed()) splash.close();

  // ✅ CHANGE: Open launcher first (Display opens only when asked)
  createLauncherWindow(cfg.port);

  // Allow server.js endpoints (staff app) to open/close display window
  global.QSYS_DISPLAY = {
    open: ({ displayId } = {}) => {
      currentDisplayId = Number.isFinite(Number(displayId)) ? Number(displayId) : null;
      const w = ensureKioskWindow();
      if (w && !w.isDestroyed()) {
        forceWindowToDisplay(w, currentDisplayId);
        w.show();
        w.focus();
        return { ok: true, on: true, displayId: currentDisplayId, displays: getDisplayTargetList() };
      }
      return { ok: false, error: "Display window not initialized" };
    },
    close: () => {
      if (win && !win.isDestroyed()) {
        win.hide();
        return { ok: true, on: false };
      }
      return { ok: true, on: false };
    },
    state: () => {
      const on = !!(win && !win.isDestroyed() && win.isVisible());
      return { ok: true, on, displayId: currentDisplayId, displays: getDisplayTargetList() };
    },
    targets: () => ({ ok: true, displays: getDisplayTargetList(), displayId: currentDisplayId }),
    attention: () => {
      try { shell.beep(); } catch {}
      try {
        setTimeout(() => {
          try { shell.beep(); } catch {}
        }, 180);
      } catch {}
      try {
        if (win && !win.isDestroyed()) {
          win.webContents
            .executeJavaScript(
              "(() => { try { window.DisplayUI?.forceHeroPulse?.(); return { ok: true }; } catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) }; } })();",
              true
            )
            .catch(() => {});
        }
      } catch {}
      return { ok: true };
    },
    announce: ({ text, code } = {}) => speakDisplayText({ text, code }),
    setMode: (mode) => setDisplayMode(mode),
    getMode: () => ({ ok: true, mode: normalizeDisplayMode(cfgGlobal?.displayMode) }),
  };
});

// Allow renderer/admin UI to switch display mode (portrait/landscape)
ipcMain.handle("display-set-mode", async (_evt, mode) => {
  return setDisplayMode(mode);
});

ipcMain.handle("display-get-mode", async () => {
  return { ok: true, mode: normalizeDisplayMode(cfgGlobal?.displayMode) };
});

app.on("window-all-closed", (e) => {
  // Keep running in tray unless user explicitly quits
  if (!isQuitting) {
    e.preventDefault();
    return;
  }
  app.quit();
});
