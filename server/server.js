// server/server.js
// QSys Local (Offline) — Server
// NOTE: This is a full-file paste based on your provided server.js,
// with ONLY security-related additions + minimal wiring changes.
// Working queue logic is kept intact.

const express = require("express");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { randomUUID, createSign, createVerify, randomBytes, createHash } = require("crypto");
const bcrypt = require("bcryptjs");
let multer;
try {
  multer = require("multer");
} catch (error) {
  console.warn("[media] 'multer' is not installed. Falling back to built-in multipart parser.");
  multer = require("./lib/multer-fallback");
}
const { openDb } = require("./db");
const session = require("express-session");
const os = require("os");
const QRCode = require("qrcode");
const helmet = require("helmet");
const execFileAsync = promisify(execFile);

function normalizeBasePath(input) {
  const raw = String(input || "").trim();
  if (!raw || raw === "/") return "";

  let out = raw.startsWith("/") ? raw : `/${raw}`;
  out = out.replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out === "/" ? "" : out;
}

const APP_BASE_PATH = normalizeBasePath(process.env.APP_BASE_PATH || "");

function pathWithBase(p) {
  const next = String(p || "");
  if (!APP_BASE_PATH) return next || "/";
  if (!next || next === "/") return APP_BASE_PATH;
  return `${APP_BASE_PATH}${next.startsWith("/") ? next : `/${next}`}`;
}

function setPrivateSurfaceNoIndex(res) {
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
}

function setDisplayMediaHeaders(res) {
  // Display pages may run from the local Electron agent (http://127.0.0.1)
  // while media is served by the cloud app. Override Helmet's default
  // same-origin resource policy so Chromium can decode cross-origin videos.
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Accept-Ranges", "bytes");
}

function buildPrivateRobotsTxt() {
  return [
    "User-agent: *",
    `Disallow: ${pathWithBase("/staff")}`,
    `Disallow: ${pathWithBase("/staff-login")}`,
    `Disallow: ${pathWithBase("/admin")}`,
    `Disallow: ${pathWithBase("/admin-login")}`,
    `Disallow: ${pathWithBase("/super-admin")}`,
    `Disallow: ${pathWithBase("/super-admin-login")}`,
    `Disallow: ${pathWithBase("/super-admin-recover")}`,
    `Disallow: ${pathWithBase("/internal-tools")}`,
    `Disallow: ${pathWithBase("/provider-setup")}`,
    `Disallow: ${pathWithBase("/display")}`,
    `Disallow: ${pathWithBase("/display-landscape.html")}`,
    `Disallow: ${pathWithBase("/display-portrait.html")}`,
    "",
  ].join("\n");
}

function stripBasePathFromUrl(url) {
  const raw = String(url || "");
  if (!APP_BASE_PATH) return raw || "/";
  if (
    raw === APP_BASE_PATH ||
    raw.startsWith(`${APP_BASE_PATH}/`) ||
    raw.startsWith(`${APP_BASE_PATH}?`)
  ) {
    const stripped = raw.slice(APP_BASE_PATH.length) || "/";
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
  return raw || "/";
}

const ACTIVATION_STATUS_UNACTIVATED = "UNACTIVATED";
const ACTIVATION_STATUS_ACTIVATED = "ACTIVATED";
const ACTIVATION_STATUS_EXPIRED = "EXPIRED";
const LICENSE_STATUS_UNLICENSED = "UNLICENSED";
const LICENSE_STATUS_ACTIVE = "ACTIVE";
const LICENSE_STATUS_GRACE = "GRACE";
const LICENSE_STATUS_EXPIRED = "EXPIRED";
const LICENSE_STATUS_SUSPENDED = "SUSPENDED";
const LICENSE_STATUS_REVOKED = "REVOKED";
const BRANCH_CODE_PLACEHOLDER = "UNASSIGNED";
const DEFAULT_SUPER_ADMIN_USER = "rbz1988";
const DEFAULT_SUPER_ADMIN_PIN = "053787";
const SUPER_ADMIN_FEATURE_CATALOG = [
  { key: "operations.system_health", name: "System Health Dashboard", group: "Operations", description: "Shows branch status, activation state, database health, backup count, and key runtime information." },
  { key: "operations.support_bundle", name: "Support Bundle Export", group: "Operations", description: "Generates a local diagnostic bundle with system metadata, recent audit activity, and support details." },
  { key: "operations.auto_backup", name: "Automatic Local Backups", group: "Operations", description: "Creates scheduled database backups automatically in local storage without manual action." },
  { key: "operations.backup_restore", name: "Backup Restore Tool", group: "Operations", description: "Lets authorized users create manual backups, export them, open the backup folder, and restore the latest valid backup." },
  { key: "operations.integrity_check", name: "Database Integrity Check", group: "Operations", description: "Runs validation checks against the local database to detect corruption or structural issues." },
  { key: "operations.startup_self_test", name: "Startup Self-Test", group: "Operations", description: "Runs system checks during app startup to verify core dependencies before normal use." },
  { key: "licensing.advanced_dashboard", name: "Advanced License Dashboard", group: "Licensing", description: "Provides a deeper view of activation state, expiry, renewal timing, and license history." },
  { key: "licensing.renewal_reminders", name: "Renewal Reminder Workflow", group: "Licensing", description: "Surfaces structured renewal reminders as expiry approaches." },
  { key: "licensing.audit_history", name: "License Audit History", group: "Licensing", description: "Tracks license issuance, renewal, and related audit events over time." },
  { key: "licensing.branch_transfer", name: "Branch Transfer Tool", group: "Licensing", description: "Supports controlled license transfer or machine replacement workflows." },
  { key: "licensing.token_revocation", name: "Token Revocation Support", group: "Licensing", description: "Adds the ability to invalidate previously issued activation or renewal tokens." },
  { key: "licensing.one_time_tokens", name: "One-Time-Use Tokens", group: "Licensing", description: "Prevents reuse of activation or renewal tokens after successful application." },
  { key: "reporting.advanced_center", name: "Advanced Reports Center", group: "Reporting", description: "Adds a richer report workspace with expanded filters, summaries, and export options." },
  { key: "reporting.scheduled_csv", name: "Scheduled CSV Export", group: "Reporting", description: "Exports report data to CSV automatically on a scheduled basis." },
  { key: "reporting.pdf_daily_summary", name: "PDF Daily Summary Export", group: "Reporting", description: "Generates printable PDF daily summaries for branch operations and review." },
  { key: "reporting.audit_export", name: "Audit Trail Export", group: "Reporting", description: "Exports audit logs in a more structured support or compliance format." },
  { key: "reporting.historical_analytics", name: "Historical Analytics", group: "Reporting", description: "Provides longer-range trend analysis across stored queue history." },
  { key: "reporting.branch_trends", name: "Branch Performance Trends", group: "Reporting", description: "Highlights branch-level performance trends such as wait time and throughput changes." },
  { key: "queue.recovery_tools", name: "Queue Recovery Tools", group: "Queue Management", description: "Adds operational tools for recovering from accidental queue mistakes or interruptions." },
  { key: "queue.reopen_completed", name: "Reopen Completed Tickets", group: "Queue Management", description: "Allows previously completed tickets to be returned to an active workflow state." },
  { key: "queue.wait_forecast", name: "Wait-Time Forecasting", group: "Queue Management", description: "Estimates expected wait time based on recent queue activity and patterns." },
];

function activationError(message, http = 400) {
  const e = new Error(String(message || "Activation error"));
  e.http = Number(http) || 400;
  return e;
}

function base64UrlDecodeToBuffer(input) {
  const s = String(input || "").trim();
  if (!s) return Buffer.alloc(0);
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64");
}

function parseEpochLike(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const s = String(value || "").trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function isReservedBranchCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return code === "DEV" || code === BRANCH_CODE_PLACEHOLDER;
}


/* -------------------- helpers -------------------- */

function getLanIPv4() {
  const nets = os.networkInterfaces();
  const preferred = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net || net.family !== "IPv4" || net.internal) continue;
      // prefer private ranges
      if (
        net.address.startsWith("192.168.") ||
        net.address.startsWith("10.") ||
        (net.address.startsWith("172.") && (() => {
          const n = Number(net.address.split(".")[1] || -1);
          return n >= 16 && n <= 31;
        })())
      ) {
        preferred.push(net.address);
      }
    }
  }

  if (preferred.length) return preferred[0];

  // fallback: any non-internal IPv4
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net && net.family === "IPv4" && !net.internal) return net.address;
    }
  }

  return null;
}


function loadSchema(db) {
  const schemaPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) return;

  const sql = fs.readFileSync(schemaPath, "utf8");

  // Execute schema statements defensively.
  // This prevents crashes when schema.sql contains ALTER TABLE ADD COLUMN that
  // may already have been applied in an existing DB.
  const statements = sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    try {
      db.exec(stmt + ";");
    } catch (e) {
      const msg = String(e && (e.message || e) || "");
      // Ignore safe/idempotent errors commonly caused by re-running schema.
      const ignorable =
        msg.includes("duplicate column name") ||
        msg.includes("already exists");
      if (!ignorable) {
        console.error("[DB] Schema statement failed:", stmt);
        throw e;
      }
    }
  }
}


// ✅ Lightweight DB migration helpers (SQLite)
function tableHasColumn(db, tableName, colName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some(
    (c) => String(c.name).toLowerCase() === String(colName).toLowerCase()
  );
}

function ensureColumn(db, tableName, colName, colDefSql) {
  try {
    if (!tableHasColumn(db, tableName, colName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDefSql}`);
      console.log(`[DB] Added column ${tableName}.${colName}`);
    }
  } catch (e) {
    console.warn(
      `[DB] ensureColumn failed for ${tableName}.${colName}:`,
      e.message || e
    );
  }
}

function getActivationVerifier(baseDir) {
  const candidates = [
    String(process.env.QSYS_ACTIVATION_PUBLIC_KEY_PEM || "").trim(),
    path.join(baseDir || process.cwd(), "activation", "public_key.pem"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8");
      }
    } catch {}
  }
  return "";
}

function verifyActivationToken(token, { baseDir, expectedInstallId } = {}) {
  const raw = String(token || "").trim();
  if (!raw) throw activationError("Activation token is required.");

  const dot = raw.lastIndexOf(".");
  if (dot <= 0) throw activationError("Activation token format is invalid.");
  const body = raw.slice(0, dot);
  const signaturePart = raw.slice(dot + 1);
  const payloadJson = base64UrlDecodeToBuffer(body).toString("utf8");

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw activationError("Activation token payload is invalid.");
  }

  const verifierPem = getActivationVerifier(baseDir);
  if (!verifierPem) throw activationError("Activation public key is not configured.", 500);

  const verify = createVerify("RSA-SHA256");
  verify.update(body);
  verify.end();
  const sig = base64UrlDecodeToBuffer(signaturePart);
  if (!verify.verify(verifierPem, sig)) {
    throw activationError("Activation token signature is invalid.");
  }

  const installId = String(payload.installId || "").trim();
  if (!installId) throw activationError("Activation token is missing installId.");
  if (expectedInstallId && installId !== String(expectedInstallId).trim()) {
    throw activationError("Activation token installId does not match this installation.");
  }

  const branchCode = String(payload.branchCode || "").trim().toUpperCase();
  if (!branchCode || isReservedBranchCode(branchCode)) {
    throw activationError("Activation token branchCode is invalid.");
  }

  const issuedAt = parseEpochLike(payload.issuedAt);
  const expiresAt = parseEpochLike(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw activationError("Activation token timing fields are invalid.");
  }
  if (Date.now() > expiresAt) {
    throw activationError("Activation token is already expired.", 409);
  }

  return {
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    payload: {
      ...payload,
      branchCode,
      issuedAt,
      expiresAt,
      installId,
      issuer: String(payload.issuer || "provider").trim() || "provider",
      licenseId: String(payload.licenseId || "").trim(),
      branchName: String(payload.branchName || "").trim(),
    },
  };
}

// Manila "today" (YYYY-MM-DD) based on actual wall-clock time
function getTodayManila() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const manila = new Date(utcMs + 8 * 60 * 60000);
  const y = manila.getFullYear();
  const m = String(manila.getMonth() + 1).padStart(2, "0");
  const d = String(manila.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}


// Manila local time string: "01:19:12 PM" (12-hour with seconds)
function formatTimeManila(ms) {
  const now = new Date(typeof ms === "number" ? ms : Date.now());
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const manila = new Date(utcMs + 8 * 60 * 60000);

  let h = manila.getHours(); // 0-23
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;

  const hh = String(h).padStart(2, "0");
  const mm = String(manila.getMinutes()).padStart(2, "0");
  const ss = String(manila.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} ${ampm}`;
}

function normalizePriority(v) {
  const s = String(v || "NONE").toUpperCase().trim();
  if (s === "SENIOR" || s === "PWD" || s === "PREGNANT") return s;
  return "NONE";
}

function computeGroupCode({ priorityType, pax }) {
  const n = Number(pax || 1);
  if (n <= 1) return "A"; // 1 pax
  if (n <= 3) return "B"; // 2-3 pax
  if (n <= 5) return "C"; // 4-5 pax
  return "D"; // 6+
}

function normalizeGroup(v) {
  const g = String(v || "").toUpperCase().trim();
  return ["P", "A", "B", "C", "D"].includes(g) ? g : null;
}

function emitChanged(a, b, c, d) {
  // Supports both:
  //   emitChanged(reason, extra)
  // and legacy:
  //   emitChanged(app, db, reason, extra)
  let appRef = null;
  let reason = "STATE_CHANGED";
  let extra = {};

  if (typeof a === "string") {
    // (reason, extra)
    reason = a;
    extra = b;
    appRef = global.__app || null;
  } else {
    // (app, db, reason, extra)
    appRef = a || global.__app || null;
    reason = (typeof c === "string") ? c : "STATE_CHANGED";
    extra = d;
  }

  if (!extra || typeof extra !== "object" || Array.isArray(extra)) extra = {};

  const branchCode = String(extra.branchCode || "").trim().toUpperCase();
  if (branchCode) extra.branchCode = branchCode;

  // Socket.IO broadcast (Display + Staff realtime) – best effort, never crash
  try {
    const io = appRef ? appRef.get("io") : null;
    if (io) {
      io.emit("state:changed", { reason, at: Date.now(), ...extra });
    }
  } catch {}

  // SSE (Admin dashboard) – best effort, never crash
  try {
    const broadcast = appRef ? appRef.get("broadcast") : null;
    const computeOverview = appRef ? appRef.get("computeOverview") : null;
    if (broadcast && computeOverview) {
      broadcast("changed", (client) => {
        const clientBranchCode = String(client?.branchCode || "").trim().toUpperCase();
        if (branchCode && clientBranchCode && clientBranchCode !== branchCode) return null;
        return Object.assign({ reason }, extra);
      });
      broadcast("overview", (client) => {
        const clientBranchCode = String(client?.branchCode || branchCode || "").trim().toUpperCase();
        if (branchCode && clientBranchCode && clientBranchCode !== branchCode) return null;
        return computeOverview(clientBranchCode || branchCode || getBranchCode());
      });
    }
  } catch {}
}

// CSV helpers (no external libs)
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  // Excel auto-converts values like 2-3 / 4-5 into dates (3-Feb / 5-Apr). Force as text.
  if (typeof v === "string" && (v === "2-3" || v === "4-5")) v = `="${v}"`;
  const s = String(v);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(header, rows) {
  const out = [];
  out.push(header.map(csvEscape).join(","));
  for (const r of rows) out.push(r.map(csvEscape).join(","));
  return out.join("\n");
}

/* -------------------- admin overview (today stats) -------------------- */
// Single source of truth for Admin dashboard counters (realtime-safe)
function computeAdminTodayStats(db, branchCode, businessDate) {
  const groups = ["P", "A", "B", "C", "D"];
  const out = {};
  const bc = branchCode;

  groups.forEach(
    (g) =>
      (out[g] = {
        registered: 0,
        waiting: 0,
        called: 0,
        seated: 0,
        skipped: 0,
        overrides: 0,
        avgWaitMinutes: null,
      })
  );

      ["A", "B", "C", "D"].forEach((g) => {
      if (!out[g]) return;
      out[g].sub = {
        regular: { registered: 0, waiting: 0, called: 0, seated: 0, skipped: 0 },
        priority: { registered: 0, waiting: 0, called: 0, seated: 0, skipped: 0 },
      };
    });
  // counts by group+status
  const all = db
    .prepare(
      `SELECT groupCode, status, COUNT(*) AS n
     FROM queue_items
     WHERE branchCode=? AND businessDate=?
     GROUP BY groupCode, status`
    )
    .all(bc, businessDate);

  // total registered today = count all statuses
  const regRows = db
    .prepare(
      `SELECT groupCode, COUNT(*) AS n
     FROM queue_items
     WHERE branchCode=? AND businessDate=?
     GROUP BY groupCode`
    )
    .all(bc, businessDate);

  regRows.forEach((r) => {
    if (out[r.groupCode]) out[r.groupCode].registered = r.n;
  });

  all.forEach((r) => {
    if (!out[r.groupCode]) return;
    if (r.status === "WAITING") out[r.groupCode].waiting = r.n;
    if (r.status === "CALLED") out[r.groupCode].called = r.n;
    if (r.status === "SEATED") out[r.groupCode].seated = r.n;
    if (r.status === "SKIPPED") out[r.groupCode].skipped = r.n;
  });

    // --- Regular vs Priority counters (A-D only) ---
  const prioRegs = db.prepare(`
    SELECT
      groupCode,
      CASE
        WHEN TRIM(COALESCE(priorityType,'')) = '' THEN 0
        WHEN UPPER(TRIM(priorityType)) = 'NONE' THEN 0
        ELSE 1
      END AS isPrio,
      COUNT(*) AS n
    FROM queue_items
    WHERE branchCode=? AND businessDate=? AND groupCode IN ('A','B','C','D')
    GROUP BY groupCode, isPrio
  `).all(bc, businessDate);

  prioRegs.forEach((r) => {
    const g = r.groupCode;
    if (!out[g] || !out[g].sub) return;
    const bucket = r.isPrio ? "priority" : "regular";
    out[g].sub[bucket].registered = r.n;
  });

  const prioCounts = db.prepare(`
    SELECT
      groupCode,
      status,
      CASE
        WHEN TRIM(COALESCE(priorityType,'')) = '' THEN 0
        WHEN UPPER(TRIM(priorityType)) = 'NONE' THEN 0
        ELSE 1
      END AS isPrio,
      COUNT(*) AS n
    FROM queue_items
    WHERE branchCode=? AND businessDate=? AND groupCode IN ('A','B','C','D')
    GROUP BY groupCode, status, isPrio
  `).all(bc, businessDate);

  prioCounts.forEach((r) => {
    const g = r.groupCode;
    if (!out[g] || !out[g].sub) return;
    const bucket = r.isPrio ? "priority" : "regular";

    if (r.status === "WAITING") out[g].sub[bucket].waiting = r.n;
    if (r.status === "CALLED") out[g].sub[bucket].called = r.n;
    if (r.status === "SEATED") out[g].sub[bucket].seated = r.n;
    if (r.status === "SKIPPED") out[g].sub[bucket].skipped = r.n;
  });


  // overrides today (from audit logs)
  const overrideRows = db
    .prepare(
      `SELECT payload FROM audit_logs
     WHERE action='QUEUE_CALL_OVERRIDE' AND payload LIKE ?`
    )
    .all(`%"businessDate":"${businessDate}"%`);

  overrideRows.forEach((r) => {
    try {
      const p = JSON.parse(r.payload || "{}");
      if (p.groupCode && out[p.groupCode]) out[p.groupCode].overrides += 1;
    } catch {}
  });

  const overrideCount = overrideRows.length;

  // avg wait today (calledAt - createdAtLocal) for tickets with calledAt
  const waits = db
    .prepare(
      `SELECT groupCode, createdAtLocal, calledAt
     FROM queue_items
     WHERE branchCode=? AND businessDate=? AND calledAt IS NOT NULL`
    )
    .all(bc, businessDate);

  const waitAgg = {};
  groups.forEach((g) => (waitAgg[g] = { sum: 0, cnt: 0 }));

  waits.forEach((r) => {
    if (!waitAgg[r.groupCode]) return;
    const ms = Number(r.calledAt) - Number(r.createdAtLocal);
    if (!Number.isFinite(ms) || ms < 0) return;
    waitAgg[r.groupCode].sum += ms / 60000;
    waitAgg[r.groupCode].cnt += 1;
  });

  groups.forEach((g) => {
    if (waitAgg[g].cnt)
      out[g].avgWaitMinutes = Math.round((waitAgg[g].sum / waitAgg[g].cnt) * 10) / 10;
  });

  return { ok: true, businessDate, groups: out, overrideCount, updatedAt: Date.now() };
}

/* -------------------- system_state (business date) -------------------- */

function getState(db, key) {
  const row = db
    .prepare(`SELECT value FROM system_state WHERE key=? LIMIT 1`)
    .get(key);
  return row ? row.value : null;
}

function setState(db, key, value) {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO system_state(key, value, updatedAt)
    VALUES(?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt
  `
  ).run(key, String(value), now);
}

function ensureBusinessDate(db, appRef = null) {
  const today = getTodayManila();
  let cur = getState(db, "currentBusinessDate");
  if (!cur) {
    setState(db, "currentBusinessDate", today);
    cur = today;
  } else if (cur !== today) {
    setState(db, "currentBusinessDate", today);
    syncDefaultBranchBusinessDate(db, today);
    setState(db, "lastAutoRolloverAt", Date.now());
    try { emitChanged(appRef || global.__app || null, db, "AUTO_ROLLOVER"); } catch {}
    console.log(`[QSysLocal] Auto rollover business date: ${cur} -> ${today}`);
    cur = today;
  }
  return cur;
}

function syncDefaultBranchBusinessDate(db, businessDate) {
  try {
    const branchId = String(getOrBootstrapDefaultBranchId(db) || "").trim();
    if (!branchId) return;
    db.prepare(
      `INSERT INTO branch_business_dates(branchId, businessDate, updatedAt)
       VALUES(?,?,?)
       ON CONFLICT(branchId) DO UPDATE SET businessDate=excluded.businessDate, updatedAt=excluded.updatedAt`
    ).run(branchId, String(businessDate || ""), Date.now());
  } catch {}
}

function maybeAutoRolloverBusinessDate(db, app) {
  ensureBusinessDate(db, app);
}

/* -------------------- admin schema (create if missing) -------------------- */
function ensureAdminSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        payload TEXT,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS branch_config (
        id INTEGER PRIMARY KEY,
        branchCode TEXT NOT NULL,
        branchName TEXT NOT NULL,
        timezone TEXT DEFAULT 'Asia/Manila',
        createdAt INTEGER,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS roles (
        roleId TEXT PRIMARY KEY,
        roleName TEXT NOT NULL,
        isSystem INTEGER DEFAULT 0,
        createdAt INTEGER,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS permissions (
        permKey TEXT PRIMARY KEY,
        permName TEXT NOT NULL,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS role_permissions (
        roleId TEXT NOT NULL,
        permKey TEXT NOT NULL,
        allowed INTEGER DEFAULT 0,
        updatedAt INTEGER,
        PRIMARY KEY (roleId, permKey)
      );

      CREATE TABLE IF NOT EXISTS users (
        userId TEXT PRIMARY KEY,
        fullName TEXT NOT NULL,
        pinHash TEXT NOT NULL,
        roleId TEXT NOT NULL,
        isActive INTEGER DEFAULT 1,
        createdAt INTEGER,
        updatedAt INTEGER,
        lastLoginAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS daily_group_stats (
        businessDate TEXT NOT NULL,
        branchCode TEXT NOT NULL,
        groupCode TEXT NOT NULL,
        registeredCount INTEGER DEFAULT 0,
        calledCount INTEGER DEFAULT 0,
        seatedCount INTEGER DEFAULT 0,
        skippedCount INTEGER DEFAULT 0,
        overrideCalledCount INTEGER DEFAULT 0,
        waitSumMinutes REAL DEFAULT 0,
        waitCount INTEGER DEFAULT 0,
        updatedAt INTEGER,
        PRIMARY KEY (businessDate, branchCode, groupCode)
      );
    `);
  } catch (e) {
    console.warn("[DB] ensureAdminSchema warning:", e.message || e);
  }
}

function ensureActivationState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS installation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      installId TEXT NOT NULL,
      activatedAt INTEGER,
      activatedBy TEXT,
      activationLicenseId TEXT,
      licenseIssuedAt INTEGER,
      licenseExpiresAt INTEGER,
      lastRenewedAt INTEGER,
      activationBranchCode TEXT,
      activationTokenHash TEXT,
      activationPayload TEXT,
      updatedAt INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  let installId = "";
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key='install.id' LIMIT 1`).get();
    installId = String(row?.value || "").trim();
  } catch {}
  if (!installId) {
    installId = randomUUID();
    db.prepare(
      `INSERT INTO app_settings(key, value, updatedAt)
       VALUES('install.id', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`,
    ).run(installId, now);
  }

  const row = db.prepare(`SELECT id FROM installation_state WHERE id=1`).get();
  if (!row) {
    db.prepare(
      `INSERT INTO installation_state(
        id, status, installId, activatedAt, activatedBy, activationLicenseId,
        licenseIssuedAt, licenseExpiresAt, lastRenewedAt, activationBranchCode,
        activationTokenHash, activationPayload, updatedAt
      ) VALUES(1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(ACTIVATION_STATUS_UNACTIVATED, installId, now);
  } else {
    db.prepare(`UPDATE installation_state SET installId=?, updatedAt=? WHERE id=1`).run(installId, now);
  }
}

function ensureActivationTokenTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activation_token_usage (
      tokenHash TEXT PRIMARY KEY,
      installId TEXT,
      branchCode TEXT,
      licenseId TEXT,
      issuer TEXT,
      action TEXT NOT NULL,
      consumedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activation_token_revocations (
      tokenHash TEXT PRIMARY KEY,
      installId TEXT,
      branchCode TEXT,
      licenseId TEXT,
      reason TEXT,
      revokedBy TEXT,
      revokedAt INTEGER NOT NULL
    );
  `);
}

function ensureOnlineLicenseSchema(db) {
  ensureColumn(db, "installation_state", "licenseKey", "TEXT");
  ensureColumn(db, "installation_state", "validationStatus", "TEXT NOT NULL DEFAULT 'UNLICENSED'");
  ensureColumn(db, "installation_state", "validationSource", "TEXT");
  ensureColumn(db, "installation_state", "lastValidatedAt", "INTEGER");
  ensureColumn(db, "installation_state", "lastValidationAttemptAt", "INTEGER");
  ensureColumn(db, "installation_state", "validationError", "TEXT");
  ensureColumn(db, "installation_state", "graceUntil", "INTEGER");
  ensureColumn(db, "installation_state", "providerAccountId", "TEXT");
  ensureColumn(db, "installation_state", "providerOrgId", "TEXT");
  ensureColumn(db, "installation_state", "providerLicenseId", "TEXT");
  ensureColumn(db, "installation_state", "licensePlanCode", "TEXT");
  ensureColumn(db, "installation_state", "licenseFeaturesJson", "TEXT");
  ensureColumn(db, "installation_state", "licenseSnapshotJson", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_license_state (
      branchId TEXT PRIMARY KEY,
      branchCode TEXT NOT NULL,
      status TEXT NOT NULL,
      licenseId TEXT,
      entitled INTEGER NOT NULL DEFAULT 0,
      issuedAt INTEGER,
      expiresAt INTEGER,
      lastValidatedAt INTEGER,
      graceUntil INTEGER,
      source TEXT,
      snapshotJson TEXT,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branch_license_state_code ON branch_license_state(branchCode);

    CREATE TABLE IF NOT EXISTS license_validation_events (
      id TEXT PRIMARY KEY,
      installId TEXT NOT NULL,
      licenseKeyMasked TEXT,
      requestType TEXT NOT NULL,
      resultStatus TEXT NOT NULL,
      httpStatus INTEGER,
      errorCode TEXT,
      errorMessage TEXT,
      validatedAt INTEGER NOT NULL,
      expiresAt INTEGER,
      graceUntil INTEGER,
      snapshotJson TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_license_validation_events_validatedAt
      ON license_validation_events(validatedAt DESC);
  `);
}

function ensureSuperAdminLicenseRegistrySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS super_admin_licenses (
      id TEXT PRIMARY KEY,
      licenseNumber TEXT NOT NULL UNIQUE,
      licenseKey TEXT NOT NULL UNIQUE,
      branchId TEXT NOT NULL,
      branchCode TEXT NOT NULL,
      branchName TEXT NOT NULL,
      status TEXT NOT NULL,
      issuedAt INTEGER,
      activatedAt INTEGER,
      expiresAt INTEGER,
      deactivatedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      createdBy TEXT,
      updatedBy TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_super_admin_licenses_branchId ON super_admin_licenses(branchId);
    CREATE INDEX IF NOT EXISTS idx_super_admin_licenses_status ON super_admin_licenses(status);

    CREATE TABLE IF NOT EXISTS super_admin_license_events (
      id TEXT PRIMARY KEY,
      licenseId TEXT NOT NULL,
      licenseNumber TEXT NOT NULL,
      action TEXT NOT NULL,
      fromStatus TEXT,
      toStatus TEXT,
      actorUserId TEXT,
      actorName TEXT,
      note TEXT,
      payloadJson TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_super_admin_license_events_licenseId ON super_admin_license_events(licenseId);
    CREATE INDEX IF NOT EXISTS idx_super_admin_license_events_createdAt ON super_admin_license_events(createdAt DESC);
  `);
}

function ensureMultiBranchFoundationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      orgId TEXT PRIMARY KEY,
      orgCode TEXT NOT NULL UNIQUE,
      orgName TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      branchId TEXT PRIMARY KEY,
      orgId TEXT NOT NULL,
      branchCode TEXT NOT NULL,
      branchName TEXT NOT NULL,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL,
      isDefault INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(orgId, branchCode)
    );
    CREATE INDEX IF NOT EXISTS idx_branches_orgId ON branches(orgId);

    CREATE TABLE IF NOT EXISTS user_branch_access (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      branchId TEXT NOT NULL,
      roleScope TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE(userId, branchId)
    );
    CREATE INDEX IF NOT EXISTS idx_user_branch_access_branchId ON user_branch_access(branchId);
    CREATE TRIGGER IF NOT EXISTS trg_user_branch_access_staff_single_insert
    BEFORE INSERT ON user_branch_access
    WHEN upper(coalesce(NEW.roleScope,'')) IN ('STAFF','SUPERVISOR')
      AND EXISTS (
        SELECT 1
        FROM user_branch_access
        WHERE userId = NEW.userId
          AND branchId <> NEW.branchId
      )
    BEGIN
      SELECT RAISE(ABORT, 'STAFF_SINGLE_BRANCH_REQUIRED');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_user_branch_access_staff_single_update
    BEFORE UPDATE OF userId, branchId, roleScope ON user_branch_access
    WHEN upper(coalesce(NEW.roleScope,'')) IN ('STAFF','SUPERVISOR')
      AND EXISTS (
        SELECT 1
        FROM user_branch_access
        WHERE userId = NEW.userId
          AND branchId <> NEW.branchId
          AND id <> NEW.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'STAFF_SINGLE_BRANCH_REQUIRED');
    END;

    CREATE TABLE IF NOT EXISTS branch_business_dates (
      branchId TEXT PRIMARY KEY,
      businessDate TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branch_settings (
      branchId TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (branchId, key)
    );

    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      scopeType TEXT NOT NULL,
      branchId TEXT,
      branchCode TEXT,
      fileName TEXT NOT NULL,
      storedName TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      mimeType TEXT,
      sizeBytes INTEGER NOT NULL DEFAULT 0,
      isActive INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_assets_scopeType ON media_assets(scopeType);
    CREATE INDEX IF NOT EXISTS idx_media_assets_branchId ON media_assets(branchId);
  `);
}

function upsertUserBranchAccess(db, { userId, branchId, roleScope }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO user_branch_access(id, userId, branchId, roleScope, createdAt)
     VALUES(?,?,?,?,?)
     ON CONFLICT(userId, branchId) DO UPDATE SET roleScope=excluded.roleScope`
  ).run(randomUUID(), String(userId || ""), String(branchId || ""), String(roleScope || "STAFF").trim().toUpperCase(), now);
}

function bootstrapDefaultOrganizationAndBranch(db) {
  const now = Date.now();
  const cfg = db.prepare(`SELECT branchCode, branchName, timezone FROM branch_config WHERE id=1`).get() || {};
  const branchCode = String(cfg.branchCode || BRANCH_CODE_PLACEHOLDER).trim().toUpperCase() || BRANCH_CODE_PLACEHOLDER;
  const branchName = String(cfg.branchName || "").trim() || "Unassigned Branch";
  const timezone = String(cfg.timezone || "Asia/Manila").trim() || "Asia/Manila";
  const businessDate = ensureBusinessDate(db);

  const settingsUpsert = db.prepare(
    `INSERT INTO app_settings(key, value, updatedAt)
     VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
  );

  let org = db.prepare(`SELECT orgId FROM organizations WHERE orgCode='DEFAULT' LIMIT 1`).get();
  if (!org?.orgId) {
    const fallbackOrg = db.prepare(`SELECT orgId FROM organizations ORDER BY createdAt ASC LIMIT 1`).get();
    if (fallbackOrg?.orgId) {
      org = fallbackOrg;
      db.prepare(`UPDATE organizations SET orgCode='DEFAULT', orgName=?, status='ACTIVE', updatedAt=? WHERE orgId=?`).run(
        branchName,
        now,
        org.orgId
      );
    } else {
      org = { orgId: randomUUID() };
      db.prepare(
        `INSERT INTO organizations(orgId, orgCode, orgName, status, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?)`
      ).run(org.orgId, "DEFAULT", branchName, "ACTIVE", now, now);
    }
  } else {
    db.prepare(`UPDATE organizations SET orgName=?, status='ACTIVE', updatedAt=? WHERE orgId=?`).run(branchName, now, org.orgId);
  }

  let branch = db.prepare(`SELECT branchId FROM branches WHERE orgId=? AND branchCode=? LIMIT 1`).get(org.orgId, branchCode);
  if (!branch?.branchId) {
    const defaultBranch = db.prepare(`SELECT branchId FROM branches WHERE orgId=? AND isDefault=1 LIMIT 1`).get(org.orgId);
    if (defaultBranch?.branchId) {
      branch = defaultBranch;
      db.prepare(
        `UPDATE branches
         SET branchCode=?, branchName=?, timezone=?, status='ACTIVE', isDefault=1, updatedAt=?
         WHERE branchId=?`
      ).run(branchCode, branchName, timezone, now, branch.branchId);
    } else {
      branch = { branchId: randomUUID() };
      db.prepare(
        `INSERT INTO branches(branchId, orgId, branchCode, branchName, timezone, status, isDefault, createdAt, updatedAt)
         VALUES(?,?,?,?,?,'ACTIVE',1,?,?)`
      ).run(branch.branchId, org.orgId, branchCode, branchName, timezone, now, now);
    }
  } else {
    db.prepare(
      `UPDATE branches
       SET branchName=?, timezone=?, status='ACTIVE', isDefault=1, updatedAt=?
       WHERE branchId=?`
    ).run(branchName, timezone, now, branch.branchId);
  }

  db.prepare(`UPDATE branches SET isDefault=CASE WHEN branchId=? THEN 1 ELSE 0 END WHERE orgId=?`).run(branch.branchId, org.orgId);

  db.prepare(
    `INSERT INTO branch_business_dates(branchId, businessDate, updatedAt)
     VALUES(?,?,?)
     ON CONFLICT(branchId) DO UPDATE SET businessDate=excluded.businessDate, updatedAt=excluded.updatedAt`
  ).run(branch.branchId, businessDate, now);

  settingsUpsert.run("multibranch.defaultOrgId", org.orgId, now);
  settingsUpsert.run("multibranch.defaultBranchId", branch.branchId, now);

  const users = db.prepare(`SELECT userId, roleId FROM users`).all();
  for (const user of users) {
    upsertUserBranchAccess(db, {
      userId: user.userId,
      branchId: branch.branchId,
      roleScope: user.roleId,
    });
  }

  return {
    orgId: org.orgId,
    branchId: branch.branchId,
    branchCode,
    branchName,
    timezone,
    businessDate,
  };
}

function getOrBootstrapDefaultBranchId(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key='multibranch.defaultBranchId' LIMIT 1`).get();
  const branchId = String(row?.value || "").trim();
  if (branchId) return branchId;
  return String(bootstrapDefaultOrganizationAndBranch(db).branchId || "").trim();
}

/* -------------------- Admin seeds -------------------- */
function ensureAdminSeeds(db, opts = {}) {
  const now = Date.now();
  const disableDefaultAdminSeed = !!opts.disableDefaultAdminSeed;

  // roles must be individually upserted so older DBs also gain SUPER_ADMIN.
  const upsertRole = db.prepare(
    `INSERT INTO roles(roleId, roleName, isSystem, createdAt, updatedAt)
     VALUES(?,?,?,?,?)
     ON CONFLICT(roleId) DO UPDATE SET
       roleName=excluded.roleName,
       isSystem=excluded.isSystem,
       updatedAt=excluded.updatedAt`
  );
  upsertRole.run("STAFF", "Staff", 1, now, now);
  upsertRole.run("SUPERVISOR", "Supervisor", 1, now, now);
  upsertRole.run("ADMIN", "Admin", 1, now, now);
  upsertRole.run("SUPER_ADMIN", "Super Admin", 1, now, now);

  // permissions catalog
  const permCount = db.prepare(`SELECT COUNT(*) AS n FROM permissions`).get()?.n || 0;
  if (permCount === 0) {
    const perms = [
      ["QUEUE_CALL_NEXT", "Call Next", "Call next ticket in queue order"],
      ["QUEUE_CALL_OVERRIDE", "Override Call", "Call a specific ticket out of order"],
      ["QUEUE_SEAT", "Seat Called", "Mark the currently called ticket as seated"],
      ["QUEUE_SKIP", "Skip", "Skip the called ticket or next waiting ticket"],
      ["QUEUE_CLEAR_CALLED", "Clear Called", "Return called ticket to waiting"],
      ["DAY_CLOSE", "Close Day", "Close business day / rollover business date"],
      ["REPORT_EXPORT_CSV", "Export CSV", "Generate CSV reports"],
      ["DATA_UPLOAD", "Upload Data", "Upload local data when internet is available"],
      ["USERS_MANAGE", "Manage Users", "Create/disable users and reset PINs"],
      ["SETTINGS_MANAGE", "Manage Settings", "Update branch/app settings"],
      ["AUDIT_VIEW", "View Audit Logs", "View audit logs"],
      ["PERMISSIONS_MANAGE", "Manage Permissions", "Edit role permissions matrix"],
    ];
    const insPerm = db.prepare(
      `INSERT INTO permissions(permKey, permName, description) VALUES(?,?,?)`
    );
    for (const p of perms) insPerm.run(p[0], p[1], p[2]);
  }

  // role_permissions defaults (only if empty)
  const rpCount = db.prepare(`SELECT COUNT(*) AS n FROM role_permissions`).get()?.n || 0;
  if (rpCount === 0) {
    const allPerms = db
      .prepare(`SELECT permKey FROM permissions`)
      .all()
      .map((r) => r.permKey);
    const ins = db.prepare(
      `INSERT INTO role_permissions(roleId, permKey, allowed, updatedAt) VALUES(?,?,?,?)`
    );

    function allow(roleId, permKey) {
      ins.run(roleId, permKey, 1, now);
    }

    // STAFF: minimal
    allow("STAFF", "QUEUE_CALL_NEXT");

    // SUPERVISOR: ops + override
    ["QUEUE_CALL_NEXT", "QUEUE_CALL_OVERRIDE", "QUEUE_SEAT", "QUEUE_SKIP", "QUEUE_CLEAR_CALLED", "AUDIT_VIEW"].forEach(
      (k) => allow("SUPERVISOR", k)
    );

    // ADMIN: all
    for (const k of allPerms) allow("ADMIN", k);
  }

  // ---- seed first ADMIN user if none exists ----
  const adminCount =
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE upper(roleId)='ADMIN'`).get()?.n || 0;

  if (adminCount === 0 && !disableDefaultAdminSeed) {
    const fullName = "admin";
    const pin = "000000"; // requested default PIN for fresh installs
    const pinHash = bcrypt.hashSync(pin, 10);
    const userId = randomUUID();

    db.prepare(
      `INSERT INTO users(userId, fullName, pinHash, roleId, isActive, createdAt, updatedAt)
       VALUES(?,?,?,?,1,?,?)`
    ).run(userId, fullName, pinHash, "ADMIN", now, now);

    console.log(`[QSysLocal] Seeded ADMIN user: username=admin pin=000000`);
  }
  if (adminCount === 0 && disableDefaultAdminSeed) {
    console.warn("[QSysLocal] Default ADMIN seed is disabled in production. Create an admin user explicitly.");
  }

  const requestedFullName = String(process.env.QSYS_SUPER_ADMIN_USER || "").trim() || DEFAULT_SUPER_ADMIN_USER;
  const requestedPin = String(process.env.QSYS_SUPER_ADMIN_PIN || "").trim() || DEFAULT_SUPER_ADMIN_PIN;
  if (requestedFullName && /^\d{6}$/.test(requestedPin)) {
    const existing = db.prepare(
      `SELECT userId FROM users WHERE upper(roleId)='SUPER_ADMIN' ORDER BY createdAt ASC LIMIT 1`
    ).get();
    const pinHash = bcrypt.hashSync(requestedPin, 10);
    if (existing?.userId) {
      db.prepare(
        `UPDATE users
         SET fullName=?, pinHash=?, roleId='SUPER_ADMIN', isActive=1, updatedAt=?
         WHERE userId=?`
      ).run(requestedFullName, pinHash, now, existing.userId);
    } else {
      db.prepare(
        `INSERT INTO users(userId, fullName, pinHash, roleId, isActive, createdAt, updatedAt)
         VALUES(?,?,?,?,1,?,?)`
      ).run(randomUUID(), requestedFullName, pinHash, "SUPER_ADMIN", now, now);
    }
  }

  // Ensure branch_config row exists (id=1), safe defaults
  const bc = db.prepare(`SELECT id FROM branch_config WHERE id=1`).get();
  if (!bc) {
    db.prepare(
      `INSERT INTO branch_config(id, branchCode, branchName, timezone, createdAt, updatedAt)
       VALUES(1, ?, ?, 'Asia/Manila', ?, ?)`
    ).run(BRANCH_CODE_PLACEHOLDER, "Unassigned Branch", now, now);
  }
}


/* -------------------- server -------------------- */

function startServer({ baseDir, port = 3000, branchCode = "DEV" }) {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const db = openDb(baseDir);
  loadSchema(db);

  // Ensure required tables exist even if schema.sql is older
  ensureAdminSchema(db);
  ensureActivationState(db);
  ensureActivationTokenTables(db);
  ensureOnlineLicenseSchema(db);
  ensureSuperAdminLicenseRegistrySchema(db);
  ensureMultiBranchFoundationSchema(db);

  // ✅ Ensure optional note column exists for override calls
  ensureColumn(db, "queue_items", "calledNote", "TEXT");
  // ✅ Track re-calls after the initial call
  ensureColumn(db, "queue_items", "next_calls", "TEXT");
  ensureColumn(db, "installation_state", "licenseIssuedAt", "INTEGER");
  ensureColumn(db, "installation_state", "licenseExpiresAt", "INTEGER");
  ensureColumn(db, "installation_state", "lastRenewedAt", "INTEGER");

  // Priority numbering is handled via queueNum with independent counters per bucket
  // for Regular vs Priority (Priority = priorityType != 'NONE').

  // Ensure system has a business date persisted
  ensureBusinessDate(db);

  // Ensure admin tables have baseline data
  try {
    ensureAdminSeeds(db, { disableDefaultAdminSeed: isProduction });
    bootstrapDefaultOrganizationAndBranch(db);
    ensureExistingDefaultBranchLicense();
  } catch (e) {
    console.warn("[AdminSeeds] warning:", e.message || e);
  }

  const app = express();
  // Expose Express app for helpers (emitChanged, etc.)
  global.__app = app;
  app.set("query parser", "simple");
  app.set("trust proxy", true);
  app.use(helmet({
    hsts: false,
    contentSecurityPolicy: false,
  }));
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send(buildPrivateRobotsTxt());
  });
  if (APP_BASE_PATH) {
    app.get(pathWithBase("/robots.txt"), (_req, res) => {
      res.type("text/plain").send(buildPrivateRobotsTxt());
    });
  }

  // Persistent SQLite session store (avoids default MemoryStore limitations).
  class SQLiteSessionStore extends session.Store {
    constructor(dbRef, opts = {}) {
      super();
      this.db = dbRef;
      this.defaultTtlMs = Math.max(60 * 1000, Number(opts.defaultTtlMs) || 1000 * 60 * 60 * 12);
      this.ensureTable();
      setInterval(() => this.pruneExpired(), 10 * 60 * 1000).unref?.();
    }

    ensureTable() {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS http_sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expiresAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_http_sessions_expiresAt ON http_sessions(expiresAt);`);
    }

    getExpiryMs(sess) {
      try {
        const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : 0;
        if (Number.isFinite(exp) && exp > Date.now()) return exp;
      } catch {}
      try {
        const maxAge = Number(sess?.cookie?.maxAge || 0);
        if (Number.isFinite(maxAge) && maxAge > 0) return Date.now() + maxAge;
      } catch {}
      return Date.now() + this.defaultTtlMs;
    }

    get(sid, cb) {
      try {
        const row = this.db
          .prepare(`SELECT sess, expiresAt FROM http_sessions WHERE sid=? LIMIT 1`)
          .get(String(sid || ""));
        if (!row) return cb(null, null);
        if (Number(row.expiresAt || 0) <= Date.now()) {
          this.destroy(sid, () => cb(null, null));
          return;
        }
        return cb(null, JSON.parse(String(row.sess || "{}")));
      } catch (e) {
        return cb(e);
      }
    }

    set(sid, sess, cb) {
      try {
        const now = Date.now();
        const expiresAt = this.getExpiryMs(sess);
        this.db
          .prepare(
            `INSERT INTO http_sessions(sid, sess, expiresAt, updatedAt)
             VALUES(?,?,?,?)
             ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expiresAt=excluded.expiresAt, updatedAt=excluded.updatedAt`,
          )
          .run(String(sid || ""), JSON.stringify(sess || {}), expiresAt, now);
        return cb && cb(null);
      } catch (e) {
        return cb && cb(e);
      }
    }

    destroy(sid, cb) {
      try {
        this.db.prepare(`DELETE FROM http_sessions WHERE sid=?`).run(String(sid || ""));
        return cb && cb(null);
      } catch (e) {
        return cb && cb(e);
      }
    }

    touch(sid, sess, cb) {
      try {
        const now = Date.now();
        const expiresAt = this.getExpiryMs(sess);
        this.db
          .prepare(`UPDATE http_sessions SET expiresAt=?, updatedAt=? WHERE sid=?`)
          .run(expiresAt, now, String(sid || ""));
        return cb && cb(null);
      } catch (e) {
        return cb && cb(e);
      }
    }

    pruneExpired() {
      try {
        this.db.prepare(`DELETE FROM http_sessions WHERE expiresAt <= ?`).run(Date.now());
      } catch {}
    }
  }

  const sessionStore = new SQLiteSessionStore(db, { defaultTtlMs: 1000 * 60 * 60 * 12 });
  app.set("basePath", APP_BASE_PATH);

  if (APP_BASE_PATH) {
    app.use((req, _res, next) => {
      req.url = stripBasePathFromUrl(req.url || "/");
      next();
    });
  }

  // ✅ Session (SECURITY ADDON)
  const configuredSessionSecret = String(process.env.SESSION_SECRET || "").trim();
  if (isProduction && !configuredSessionSecret) {
    throw new Error("[SECURITY] SESSION_SECRET must be set in production.");
  }
  const sessionSecret = configuredSessionSecret || randomBytes(32).toString("hex");
  if (!configuredSessionSecret) {
    console.warn("[SECURITY] SESSION_SECRET not set. Using ephemeral secret for this process.");
  }
  function createScopedSessionMiddleware(name) {
    return session({
      name,
      secret: sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: String(process.env.NODE_ENV || "").toLowerCase() === "production",
        maxAge: 1000 * 60 * 60 * 12,
      },
    });
  }

  const staffSessionMiddleware = createScopedSessionMiddleware("qsys_staff.sid");
  const adminSessionMiddleware = createScopedSessionMiddleware("qsys_admin.sid");
  const superAdminSessionMiddleware = createScopedSessionMiddleware("qsys_super.sid");
  const legacySessionMiddleware = createScopedSessionMiddleware("qsys_legacy.sid");

  function detectSessionScope(req) {
    const rawUrl = String(req?.originalUrl || req?.url || "");
    const p = stripBasePathFromUrl(rawUrl);
    if (
      p === "/super-admin" ||
      p === "/super-admin-login" ||
      p === "/super-admin-recover" ||
      p === "/internal-tools" ||
      p.startsWith("/api/super-admin/")
    ) return "super-admin";
    if (
      p === "/admin" ||
      p === "/admin-login" ||
      p === "/admin-diagnostics" ||
      p === "/admin-session-diagnostics" ||
      /^\/b\/[^/]+\/admin(?:\/|$)/i.test(p) ||
      /^\/b\/[^/]+\/admin-diagnostics(?:\/|$)/i.test(p) ||
      /^\/b\/[^/]+\/admin-session-diagnostics(?:\/|$)/i.test(p) ||
      /^\/b\/[^/]+\/admin-login(?:\/|$)/i.test(p) ||
      p.startsWith("/api/admin/")
    ) return "admin";
    if (
      p === "/staff" ||
      p === "/staff-login" ||
      /^\/b\/[^/]+\/staff(?:\/|$)/i.test(p) ||
      /^\/b\/[^/]+\/staff-login(?:\/|$)/i.test(p) ||
      p.startsWith("/api/staff/")
    ) return "staff";
    if (p.startsWith("/api/auth/")) return "legacy";
    return "public";
  }

  app.use((req, res, next) => {
    const scope = detectSessionScope(req);
    req.qsysSessionScope = scope;
    if (scope === "staff") return staffSessionMiddleware(req, res, next);
    if (scope === "admin") return adminSessionMiddleware(req, res, next);
    if (scope === "super-admin") return superAdminSessionMiddleware(req, res, next);
    if (scope === "legacy") return legacySessionMiddleware(req, res, next);
    return next();
  });

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: true, limit: "256kb" }));

  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 20,
      fileSize: 1024 * 1024 * 300,
    },
  });

  app.use((req, res, next) => {
    if (!isActivationEnforced()) return next();
    try {
      const st = refreshActivationState();
      const status = String(st.status || "").toUpperCase();
      if (status === ACTIVATION_STATUS_ACTIVATED) return next();
      if (isActivationBypassRequest(req)) return next();
      if (String(req.path || "").startsWith("/api/")) {
        const expired = status === ACTIVATION_STATUS_EXPIRED;
        return res.status(423).json({
          ok: false,
          error: expired
            ? "Installation license has expired. Provider renewal is required."
            : "Installation is not activated. Provider activation is required.",
          code: expired ? "INSTALLATION_LICENSE_EXPIRED" : "INSTALLATION_NOT_ACTIVATED",
        });
      }
      return res.redirect(302, pathWithBase("/provider-setup"));
    } catch (e) {
      console.error("[activation/middleware]", e);
      return res.status(500).json({ ok: false, error: "Activation state error." });
    }
  });

  // ✅ Prevent direct static access entirely (SECURITY ADDON)
  // Allow ONLY:
  // - /static/media/*  (display videos)
  // - /static/ticket.html (guest ticket page) + any assets it needs ONLY if you reference them via /static/...
  // Everything else should be accessed via routes: /staff, /display, /guest, /admin
  // ✅ Prevent direct static access entirely (compatible with older path-to-regexp)
// Allow ONLY:
// - /static/media/*
// - /static/ticket.html
// - /static/assets/* (optional)
app.use("/static", (req, res, next) => {
  const p = String(req.path || ""); // path under /static

  // ✅ Allow media + bundled assets
  if (p.startsWith("/media/")) {
    setDisplayMediaHeaders(res);
    return next();
  }
  if (p.startsWith("/assets/")) return next(); // optional
  if (p.startsWith("/css/")) return next();
  if (p.startsWith("/img/")) return next();

  // ✅ Allow display sound
  if (p === "/chime.mp3") return next();

  // ✅ Allow ALL JS under /static/js/*
  if (p.startsWith("/js/")) return next();

// ✅ Allow guest ticket page (if used)
if (p === "/ticket.html") return next();

// ✅ Allow Electron launcher page
if (p === "/launcher.html") return next();
if (p === "/provider-setup.html") return next();
if (p === "/super-admin-login.html") return next();
if (p === "/super-admin-recover.html") return next();

return res.status(404).send("Not found");

});

// Keep the real static handler AFTER the gate
app.use("/static", express.static(path.join(__dirname, "static")));

// ✅ Hard fallback for display JS (prevents mysterious 404s if static mapping changes)
app.get("/static/js/:file", (req, res) => {
  const file = String(req.params.file || "");
  const full = path.join(__dirname, "static", "js", file);
  return res.sendFile(full, (err) => {
    if (err) return res.status(404).send("Not found");
  });
});


  // --- Branch config helpers (use DB as source of truth) ---
  function getBranchConfigSafe() {
    try {
      return (
        db
          .prepare(`SELECT branchCode, branchName, timezone FROM branch_config WHERE id=1`)
          .get() || { branchCode: branchCode, branchName: "", timezone: "Asia/Manila" }
      );
    } catch {
      return { branchCode: branchCode, branchName: "", timezone: "Asia/Manila" };
    }
  }
  function getBranchCode() {
    return String(getBranchConfigSafe().branchCode || branchCode).trim() || branchCode;
  }
  function getBranchName() {
    return String(getBranchConfigSafe().branchName || "").trim();
  }
  function getDefaultBranchRecord() {
    try {
      const defaultBranchId = String(getDbSetting("multibranch.defaultBranchId") || "").trim();
      if (defaultBranchId) {
        const row = db.prepare(
          `SELECT branchId, orgId, branchCode, branchName, timezone, status, isDefault
           FROM branches
           WHERE branchId=?
           LIMIT 1`
        ).get(defaultBranchId);
        if (row) return row;
      }
      const row = db.prepare(
        `SELECT branchId, orgId, branchCode, branchName, timezone, status, isDefault
         FROM branches
         WHERE isDefault=1
         ORDER BY updatedAt DESC, createdAt DESC
         LIMIT 1`
      ).get();
      if (row) return row;
    } catch {}
    const cfg = getBranchConfigSafe();
    return {
      branchId: getOrBootstrapDefaultBranchId(db),
      orgId: String(getDbSetting("multibranch.defaultOrgId") || "").trim(),
      branchCode: String(cfg.branchCode || branchCode).trim() || branchCode,
      branchName: String(cfg.branchName || "").trim(),
      timezone: String(cfg.timezone || "Asia/Manila"),
      status: "ACTIVE",
      isDefault: 1,
    };
  }
  function getBranchById(branchId) {
    const id = String(branchId || "").trim();
    if (!id) return null;
    try {
      return db.prepare(
        `SELECT branchId, orgId, branchCode, branchName, timezone, status, isDefault
         FROM branches
         WHERE branchId=?
         LIMIT 1`
      ).get(id) || null;
    } catch {
      return null;
    }
  }
  function getBranchByCode(branchCodeInput) {
    const code = String(branchCodeInput || "").trim().toUpperCase();
    if (!code) return null;
    try {
      return db.prepare(
        `SELECT branchId, orgId, branchCode, branchName, timezone, status, isDefault
         FROM branches
         WHERE upper(branchCode)=?
         ORDER BY isDefault DESC, updatedAt DESC, createdAt DESC
         LIMIT 1`
      ).get(code) || null;
    } catch {
      return null;
    }
  }
  function listUserBranchAccess(userId) {
    const id = String(userId || "").trim();
    if (!id) return [];
    try {
      return db.prepare(
        `SELECT b.branchId, b.orgId, b.branchCode, b.branchName, b.timezone, b.status, b.isDefault, uba.roleScope
         FROM user_branch_access uba
         JOIN branches b ON b.branchId = uba.branchId
         WHERE uba.userId=?
         ORDER BY b.isDefault DESC, b.branchName ASC, b.branchCode ASC`
      ).all(id);
    } catch {
      return [];
    }
  }
  function listActiveBranches() {
    try {
      return db.prepare(
        `SELECT branchId, orgId, branchCode, branchName, timezone, status, isDefault
         FROM branches
         WHERE upper(coalesce(status,'ACTIVE'))='ACTIVE'
         ORDER BY isDefault DESC, branchName ASC, branchCode ASC`
      ).all().map(enrichBranchLicense);
    } catch {
      const fallback = getDefaultBranchRecord();
      return fallback ? [enrichBranchLicense(fallback)] : [];
    }
  }
  function listOperationalBranches() {
    return listActiveBranches().filter(isBranchOperational);
  }
  function listAllBranches() {
    try {
      return db.prepare(
        `SELECT branchId, orgId, branchCode, branchName, timezone, status, isDefault
         FROM branches
         ORDER BY isDefault DESC, branchName ASC, branchCode ASC`
      ).all().map(enrichBranchLicense);
    } catch {
      const fallback = getDefaultBranchRecord();
      return fallback ? [enrichBranchLicense(fallback)] : [];
    }
  }
  function roleHasGlobalBranchAccess(roleId) {
    const normalized = String(roleId || "").trim().toUpperCase();
    return normalized === "ADMIN" || normalized === "SUPER_ADMIN";
  }
  function listAssignedBranchesForUser(userId, roleId = "") {
    if (roleHasGlobalBranchAccess(roleId)) return listAllBranches();
    return listUserBranchAccess(userId).map(enrichBranchLicense);
  }
  function listAccessibleBranchesForUser(userId, roleId = "") {
    if (roleHasGlobalBranchAccess(roleId)) return listOperationalBranches();
    return listAssignedBranchesForUser(userId, roleId).filter(isBranchOperational);
  }
  function describeBlockedBranch(branch, surface = "branch access") {
    const decision = getBranchAccessDecision(branch, surface);
    return {
      branchId: String(branch?.branchId || ""),
      branchCode: String(branch?.branchCode || ""),
      branchName: String(branch?.branchName || ""),
      status: String(branch?.status || ""),
      licenseStatus: String(branch?.licenseStatus || ""),
      licenseActivated: !!branch?.licenseActivated,
      accessCode: String(decision.code || ""),
      accessMessage: String(decision.message || ""),
    };
  }
  function getUserBranchAccessSummary(userId, roleId = "", surface = "branch access") {
    const assignedBranches = listAssignedBranchesForUser(userId, roleId);
    const allowedBranches = listAccessibleBranchesForUser(userId, roleId);
    const allowedIds = new Set(allowedBranches.map((row) => String(row.branchId || "").trim()).filter(Boolean));
    const blockedBranches = assignedBranches
      .filter((branch) => !allowedIds.has(String(branch.branchId || "").trim()))
      .map((branch) => describeBlockedBranch(branch, surface));
    return { assignedBranches, allowedBranches, blockedBranches };
  }
  function ensureSessionBranchContext(user) {
    if (!user || !user.userId) return user || null;
    const roleId = String(user.roleId || "").trim().toUpperCase();
    const branches = listAccessibleBranchesForUser(user.userId, roleId);
    const assignedBranches = listAssignedBranchesForUser(user.userId, roleId);
    const allowedBranchIds = branches.map((row) => String(row.branchId || "").trim()).filter(Boolean);
    const assignedBranchIds = assignedBranches.map((row) => String(row.branchId || "").trim()).filter(Boolean);
    let selectedBranchId = String(user.selectedBranchId || "").trim();
    if (!selectedBranchId || !allowedBranchIds.includes(selectedBranchId)) {
      if (allowedBranchIds.length === 1) selectedBranchId = allowedBranchIds[0];
      else if (allowedBranchIds.length > 1) {
        const defaultRow = branches.find((row) => Number(row.isDefault || 0) === 1) || branches[0];
        selectedBranchId = String(defaultRow?.branchId || "").trim();
      } else if (selectedBranchId && assignedBranchIds.includes(selectedBranchId)) {
        selectedBranchId = selectedBranchId;
      } else if (assignedBranchIds.length === 1) {
        selectedBranchId = assignedBranchIds[0];
      } else {
        selectedBranchId = "";
      }
    }
    return {
      ...user,
      allowedBranchIds,
      assignedBranchIds,
      selectedBranchId,
      branchCount: allowedBranchIds.length,
    };
  }
  function getSelectedBranchIdForUser(req, user) {
    const sessSelected = String(user?.selectedBranchId || "").trim();
    if (sessSelected) return sessSelected;
    const branches = listAccessibleBranchesForUser(user?.userId, user?.roleId);
    if (branches.length === 1) return String(branches[0].branchId || "").trim();
    const defaultRow = branches.find((row) => Number(row.isDefault || 0) === 1) || branches[0];
    return String(defaultRow?.branchId || "").trim();
  }
  function resolveRequestBranch(req) {
    const routeCode = String(req?.params?.branchCode || "").trim().toUpperCase();
    if (routeCode) {
      const byCode = getBranchByCode(routeCode);
      if (byCode) return byCode;
    }
    const queryCode = String(req?.query?.branchCode || "").trim().toUpperCase();
    if (queryCode) {
      const byCode = getBranchByCode(queryCode);
      if (byCode) return byCode;
    }
    const user = getSessionUser(req);
    if (user?.userId) {
      const branchId = getSelectedBranchIdForUser(req, user);
      if (!branchId) return null;
      const byId = getBranchById(branchId);
      if (byId) return byId;
      return null;
    }
    return getDefaultBranchRecord();
  }
  function getRequestBranch(req) {
    if (req?.qsysBranch?.branchId) return req.qsysBranch;
    return resolveRequestBranch(req);
  }
  function getRequestBranchCode(req) {
    return String(getRequestBranch(req)?.branchCode || getBranchCode()).trim() || getBranchCode();
  }
  function getRequestBranchName(req) {
    return String(getRequestBranch(req)?.branchName || getBranchName()).trim() || getBranchName();
  }
  function getRequestBranchTimezone(req) {
    return String(getRequestBranch(req)?.timezone || getBranchConfigSafe().timezone || "Asia/Manila").trim() || "Asia/Manila";
  }
  function getDbSetting(key) {
    try {
      const row = db.prepare(`SELECT value FROM app_settings WHERE key=? LIMIT 1`).get(String(key || ""));
      return row ? String(row.value || "") : "";
    } catch {
      return "";
    }
  }
  function setDbSetting(key, value) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO app_settings(key, value, updatedAt)
       VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
    ).run(String(key || ""), String(value || ""), now);
  }
  function isFeatureProvisioned(featureKey) {
    return getDbSetting(`feature.${String(featureKey || "").trim()}`) === "1";
  }
  function setFeatureProvisioned(featureKey, enabled) {
    setDbSetting(`feature.${String(featureKey || "").trim()}`, enabled ? "1" : "0");
  }
  function getProvisionedFeatureMap(keys) {
    const map = {};
    for (const key of keys || []) map[String(key)] = isFeatureProvisioned(key);
    return map;
  }
  function maskLicenseKey(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.length <= 4) return "*".repeat(raw.length);
    return `${"*".repeat(Math.max(0, raw.length - 4))}${raw.slice(-4)}`;
  }
  function normalizeLicenseValidationStatus(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if ([
      LICENSE_STATUS_ACTIVE,
      LICENSE_STATUS_GRACE,
      LICENSE_STATUS_EXPIRED,
      LICENSE_STATUS_SUSPENDED,
      LICENSE_STATUS_REVOKED,
      LICENSE_STATUS_UNLICENSED,
    ].includes(normalized)) return normalized;
    return LICENSE_STATUS_UNLICENSED;
  }
  function mapValidationStatusToActivationStatus(status) {
    const normalized = normalizeLicenseValidationStatus(status);
    if ([LICENSE_STATUS_ACTIVE, LICENSE_STATUS_GRACE].includes(normalized)) return ACTIVATION_STATUS_ACTIVATED;
    if (normalized === LICENSE_STATUS_EXPIRED) return ACTIVATION_STATUS_EXPIRED;
    return ACTIVATION_STATUS_UNACTIVATED;
  }
  function parseEpochOrNull(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function getStoredLicenseValidateUrl() {
    return String(getDbSetting("licensing.providerValidateUrl") || process.env.QSYS_LICENSE_VALIDATE_URL || "").trim();
  }
  function setStoredLicenseValidateUrl(value) {
    const next = String(value || "").trim();
    setDbSetting("licensing.providerValidateUrl", next);
  }
  function getLicenseValidationState() {
    ensureActivationState(db);
    ensureOnlineLicenseSchema(db);
    const row = db.prepare(
      `SELECT licenseKey, validationStatus, validationSource, lastValidatedAt, lastValidationAttemptAt, validationError,
              graceUntil, providerAccountId, providerOrgId, providerLicenseId, licensePlanCode, licenseFeaturesJson,
              licenseSnapshotJson
       FROM installation_state WHERE id=1`
    ).get() || {};
    let features = {};
    try {
      features = row.licenseFeaturesJson ? JSON.parse(row.licenseFeaturesJson) : {};
    } catch {
      features = {};
    }
    let snapshot = null;
    try {
      snapshot = row.licenseSnapshotJson ? JSON.parse(row.licenseSnapshotJson) : null;
    } catch {
      snapshot = null;
    }
    return {
      licenseKey: String(row.licenseKey || "").trim(),
      validationStatus: normalizeLicenseValidationStatus(row.validationStatus),
      validationSource: String(row.validationSource || "").trim(),
      lastValidatedAt: parseEpochOrNull(row.lastValidatedAt),
      lastValidationAttemptAt: parseEpochOrNull(row.lastValidationAttemptAt),
      validationError: String(row.validationError || "").trim(),
      graceUntil: parseEpochOrNull(row.graceUntil),
      providerAccountId: String(row.providerAccountId || "").trim(),
      providerOrgId: String(row.providerOrgId || "").trim(),
      providerLicenseId: String(row.providerLicenseId || "").trim(),
      licensePlanCode: String(row.licensePlanCode || "").trim(),
      licenseFeatures: features && typeof features === "object" ? features : {},
      licenseSnapshot: snapshot,
    };
  }
  function recordLicenseValidationEvent(payload = {}) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO license_validation_events(
        id, installId, licenseKeyMasked, requestType, resultStatus, httpStatus, errorCode, errorMessage,
        validatedAt, expiresAt, graceUntil, snapshotJson
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(),
      String(payload.installId || "").trim(),
      String(payload.licenseKeyMasked || "").trim(),
      String(payload.requestType || "VALIDATE").trim().toUpperCase(),
      String(payload.resultStatus || LICENSE_STATUS_UNLICENSED).trim().toUpperCase(),
      Number(payload.httpStatus || 0) || null,
      String(payload.errorCode || "").trim() || null,
      String(payload.errorMessage || "").trim() || null,
      Number(payload.validatedAt || now) || now,
      Number(payload.expiresAt || 0) || null,
      Number(payload.graceUntil || 0) || null,
      payload.snapshotJson ? JSON.stringify(payload.snapshotJson) : null,
    );
  }
  function syncProvisionedFeatures(features) {
    if (!features || typeof features !== "object") return;
    for (const entry of SUPER_ADMIN_FEATURE_CATALOG) {
      const key = String(entry.key || "").trim();
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(features, key)) {
        setFeatureProvisioned(key, !!features[key]);
      }
    }
  }
  function upsertBranchLicenseCache(branch, payload = {}) {
    const branchId = String(branch?.branchId || "").trim();
    const branchCode = String(branch?.branchCode || payload.branchCode || "").trim().toUpperCase();
    if (!branchId || !branchCode) return;
    const now = Date.now();
    const status = String(payload.status || ACTIVATION_STATUS_UNACTIVATED).trim().toUpperCase();
    const licenseId = String(payload.licenseId || "").trim();
    const entitled = payload.entitled == null ? [ACTIVATION_STATUS_ACTIVATED].includes(status) : !!payload.entitled;
    const issuedAt = parseEpochOrNull(payload.issuedAt);
    const expiresAt = parseEpochOrNull(payload.expiresAt);
    const lastValidatedAt = parseEpochOrNull(payload.lastValidatedAt) || now;
    const graceUntil = parseEpochOrNull(payload.graceUntil);
    const source = String(payload.source || "").trim();
    const snapshotJson = payload.snapshotJson ? JSON.stringify(payload.snapshotJson) : null;
    db.prepare(
      `INSERT INTO branch_license_state(
        branchId, branchCode, status, licenseId, entitled, issuedAt, expiresAt,
        lastValidatedAt, graceUntil, source, snapshotJson, updatedAt
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(branchId) DO UPDATE SET
        branchCode=excluded.branchCode,
        status=excluded.status,
        licenseId=excluded.licenseId,
        entitled=excluded.entitled,
        issuedAt=excluded.issuedAt,
        expiresAt=excluded.expiresAt,
        lastValidatedAt=excluded.lastValidatedAt,
        graceUntil=excluded.graceUntil,
        source=excluded.source,
        snapshotJson=excluded.snapshotJson,
        updatedAt=excluded.updatedAt`
    ).run(
      branchId,
      branchCode,
      status,
      licenseId || null,
      entitled ? 1 : 0,
      issuedAt,
      expiresAt,
      lastValidatedAt,
      graceUntil,
      source || null,
      snapshotJson,
      now
    );
  }
  function getBranchLicenseCache(branchId) {
    const id = String(branchId || "").trim();
    if (!id) return null;
    try {
      return db.prepare(
        `SELECT branchId, branchCode, status, licenseId, entitled, issuedAt, expiresAt, lastValidatedAt, graceUntil, source, snapshotJson, updatedAt
         FROM branch_license_state WHERE branchId=? LIMIT 1`
      ).get(id) || null;
    } catch {
      return null;
    }
  }
  function syncValidatedBranchLicenses(branches, meta = {}) {
    const rows = Array.isArray(branches) ? branches : [];
    const validatedAt = parseEpochOrNull(meta.validatedAt) || Date.now();
    for (const item of rows) {
      const branchCode = String(item?.branchCode || "").trim().toUpperCase();
      const branch = branchCode ? getBranchByCode(branchCode) : null;
      if (!branch?.branchId) continue;
      upsertBranchLicenseCache(branch, {
        status: String(item.status || (item.entitled ? ACTIVATION_STATUS_ACTIVATED : ACTIVATION_STATUS_UNACTIVATED)).trim().toUpperCase(),
        licenseId: String(item.licenseId || meta.licenseId || "").trim(),
        entitled: item.entitled,
        issuedAt: item.issuedAt,
        expiresAt: item.expiresAt,
        graceUntil: item.graceUntil || meta.graceUntil,
        lastValidatedAt: validatedAt,
        source: meta.source || "provider-api",
        snapshotJson: item,
      });
      setBranchLicenseState(branch.branchId, {
        status: String(item.status || (item.entitled ? ACTIVATION_STATUS_ACTIVATED : ACTIVATION_STATUS_UNACTIVATED)).trim().toUpperCase(),
        licenseId: String(item.licenseId || meta.licenseId || "").trim(),
        issuedAt: Number(item.issuedAt || 0),
        expiresAt: Number(item.expiresAt || 0),
        activatedAt: validatedAt,
        activatedBy: String(meta.source || "provider-api").trim() || "provider-api",
      });
    }
  }
  function normalizeRegistryLicenseStatus(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (["ISSUED", "ACTIVE", "DISABLED", "EXPIRED", "REVOKED"].includes(normalized)) return normalized;
    return "ISSUED";
  }
  function mapRegistryStatusToBranchLicenseStatus(status) {
    const normalized = normalizeRegistryLicenseStatus(status);
    if (normalized === "ACTIVE") return ACTIVATION_STATUS_ACTIVATED;
    if (normalized === "EXPIRED") return ACTIVATION_STATUS_EXPIRED;
    return ACTIVATION_STATUS_UNACTIVATED;
  }
  function generateLicenseNumber(branchCode, issuedAt = Date.now()) {
    const code = String(branchCode || "GEN").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
    const year = new Date(Number(issuedAt || Date.now())).getFullYear();
    const prefix = `QSYS-${code || "GEN"}-${year}`;
    const row = db.prepare(
      `SELECT licenseNumber FROM super_admin_licenses
       WHERE licenseNumber LIKE ?
       ORDER BY licenseNumber DESC
       LIMIT 1`
    ).get(`${prefix}-%`);
    const suffix = Number(String(row?.licenseNumber || "").split("-").pop() || 0) || 0;
    return `${prefix}-${String(suffix + 1).padStart(4, "0")}`;
  }
  function generateLicenseKey() {
    const raw = randomBytes(16).toString("hex").toUpperCase();
    return `QSYS-${raw.match(/.{1,4}/g).join("-")}`;
  }
  function listSuperAdminLicenses() {
    return db.prepare(
      `SELECT id, licenseNumber, licenseKey, branchId, branchCode, branchName, status, issuedAt, activatedAt,
              expiresAt, deactivatedAt, createdAt, updatedAt, createdBy, updatedBy, notes
       FROM super_admin_licenses
       ORDER BY createdAt DESC, licenseNumber DESC`
    ).all().map((row) => ({
      ...row,
      keyMasked: maskLicenseKey(row.licenseKey),
    }));
  }
  function listSuperAdminLicenseEvents(limit = 120) {
    return db.prepare(
      `SELECT id, licenseId, licenseNumber, action, fromStatus, toStatus, actorUserId, actorName, note, payloadJson, createdAt
       FROM super_admin_license_events
       ORDER BY createdAt DESC
       LIMIT ?`
    ).all(Math.max(1, Number(limit || 120))).map((row) => {
      let payload = null;
      try {
        payload = row.payloadJson ? JSON.parse(row.payloadJson) : null;
      } catch {
        payload = null;
      }
      return { ...row, payload };
    });
  }
  function getSuperAdminLicenseById(id) {
    const normalized = String(id || "").trim();
    if (!normalized) return null;
    const row = db.prepare(
      `SELECT id, licenseNumber, licenseKey, branchId, branchCode, branchName, status, issuedAt, activatedAt,
              expiresAt, deactivatedAt, createdAt, updatedAt, createdBy, updatedBy, notes
       FROM super_admin_licenses
       WHERE id=?
       LIMIT 1`
    ).get(normalized);
    return row ? { ...row, keyMasked: maskLicenseKey(row.licenseKey) } : null;
  }
  function findActiveLicenseForBranch(branchId, excludeLicenseId = "") {
    return db.prepare(
      `SELECT id, licenseNumber, status
       FROM super_admin_licenses
       WHERE branchId=? AND upper(status) IN ('ISSUED','ACTIVE') AND id<>?
       ORDER BY createdAt DESC
       LIMIT 1`
    ).get(String(branchId || "").trim(), String(excludeLicenseId || "").trim()) || null;
  }
  function appendSuperAdminLicenseEvent({ licenseId, licenseNumber, action, fromStatus, toStatus, actor, note, payload }) {
    db.prepare(
      `INSERT INTO super_admin_license_events(
        id, licenseId, licenseNumber, action, fromStatus, toStatus, actorUserId, actorName, note, payloadJson, createdAt
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(),
      String(licenseId || "").trim(),
      String(licenseNumber || "").trim(),
      String(action || "").trim().toUpperCase(),
      String(fromStatus || "").trim().toUpperCase() || null,
      String(toStatus || "").trim().toUpperCase() || null,
      String(actor?.userId || "").trim() || null,
      String(actor?.fullName || "").trim() || null,
      String(note || "").trim() || null,
      payload ? JSON.stringify(payload) : null,
      Date.now()
    );
  }
  function syncBranchLicenseFromRegistryRecord(record, actorName = "") {
    const branch = getBranchById(record?.branchId);
    if (!branch?.branchId) return;
    const status = mapRegistryStatusToBranchLicenseStatus(record?.status);
    const timestamp = status === ACTIVATION_STATUS_ACTIVATED
      ? Number(record?.activatedAt || record?.updatedAt || Date.now()) || Date.now()
      : Number(record?.deactivatedAt || record?.updatedAt || Date.now()) || Date.now();
    setBranchLicenseState(branch.branchId, {
      status,
      licenseId: String(record?.licenseNumber || ""),
      issuedAt: Number(record?.issuedAt || 0) || "",
      expiresAt: Number(record?.expiresAt || 0) || "",
      activatedAt: status === ACTIVATION_STATUS_ACTIVATED ? timestamp : "",
      activatedBy: String(actorName || record?.updatedBy || record?.createdBy || "super-admin"),
      snapshotJson: {
        source: "super-admin-registry",
        licenseId: record?.id,
        licenseNumber: record?.licenseNumber,
        status: record?.status,
      },
    });
  }
  function buildSuperAdminConsolePayload() {
    return {
      features: SUPER_ADMIN_FEATURE_CATALOG.map((item) => ({
        ...item,
        enabled: isFeatureProvisioned(item.key),
      })),
      branches: listAllBranches(),
      licenses: listSuperAdminLicenses(),
      licenseEvents: listSuperAdminLicenseEvents(150),
      backup: getBackupManagementPayload({ limit: 20 }),
    };
  }
  function getActivationState() {
    ensureActivationState(db);
    const row = db.prepare(
      `SELECT status, installId, activatedAt, activatedBy, activationLicenseId, licenseIssuedAt, licenseExpiresAt,
              lastRenewedAt, activationBranchCode, activationTokenHash, activationPayload, updatedAt,
              licenseKey, validationStatus, validationSource, lastValidatedAt, lastValidationAttemptAt, validationError,
              graceUntil, providerAccountId, providerOrgId, providerLicenseId, licensePlanCode, licenseFeaturesJson,
              licenseSnapshotJson
       FROM installation_state WHERE id=1`
    ).get();
    return row || {
      status: ACTIVATION_STATUS_UNACTIVATED,
      installId: "",
      activatedAt: null,
      activatedBy: null,
      activationLicenseId: null,
      licenseIssuedAt: null,
      licenseExpiresAt: null,
      lastRenewedAt: null,
      activationBranchCode: null,
      activationTokenHash: null,
      activationPayload: null,
      licenseKey: "",
      validationStatus: LICENSE_STATUS_UNLICENSED,
      validationSource: "",
      lastValidatedAt: null,
      lastValidationAttemptAt: null,
      validationError: "",
      graceUntil: null,
      providerAccountId: "",
      providerOrgId: "",
      providerLicenseId: "",
      licensePlanCode: "",
      licenseFeaturesJson: "",
      licenseSnapshotJson: "",
      updatedAt: Date.now(),
    };
  }
  function refreshActivationState() {
    const st = getActivationState();
    const status = String(st.status || "").toUpperCase();
    if (status !== ACTIVATION_STATUS_ACTIVATED) return st;
    const exp = Number(st.licenseExpiresAt || 0);
    const now = Date.now();
    const validationStatus = normalizeLicenseValidationStatus(st.validationStatus);
    const graceUntil = Number(st.graceUntil || 0) || 0;
    if (!Number.isFinite(exp) || exp <= 0 || now <= exp) return st;
    if (graceUntil && now <= graceUntil) {
      if (validationStatus !== LICENSE_STATUS_GRACE) {
        db.prepare(`UPDATE installation_state SET validationStatus=?, updatedAt=? WHERE id=1`).run(LICENSE_STATUS_GRACE, now);
      }
      return { ...st, validationStatus: LICENSE_STATUS_GRACE, updatedAt: now };
    }
    db.prepare(`UPDATE installation_state SET status=?, validationStatus=?, updatedAt=? WHERE id=1`).run(
      ACTIVATION_STATUS_EXPIRED,
      LICENSE_STATUS_EXPIRED,
      now
    );
    return { ...st, status: ACTIVATION_STATUS_EXPIRED, validationStatus: LICENSE_STATUS_EXPIRED, updatedAt: now };
  }
  function getBranchLicenseState(branch) {
    const branchId = String(branch?.branchId || "").trim();
    if (!branchId) return { status: ACTIVATION_STATUS_UNACTIVATED, activated: false, licenseExpiresAt: null };
    const cached = getBranchLicenseCache(branchId);
    if (cached) {
      const rawStatus = String(cached.status || "").trim().toUpperCase();
      const exp = Number(cached.expiresAt || 0) || null;
      const graceUntil = Number(cached.graceUntil || 0) || null;
      const now = Date.now();
      const expired = rawStatus === ACTIVATION_STATUS_ACTIVATED && exp && now > exp && (!graceUntil || now > graceUntil);
      const inGrace = rawStatus === ACTIVATION_STATUS_ACTIVATED && exp && graceUntil && now > exp && now <= graceUntil;
      return {
        status: expired ? ACTIVATION_STATUS_EXPIRED : rawStatus || ACTIVATION_STATUS_UNACTIVATED,
        activated: (rawStatus === ACTIVATION_STATUS_ACTIVATED && !expired) || inGrace,
        licenseId: String(cached.licenseId || ""),
        licenseIssuedAt: Number(cached.issuedAt || 0) || null,
        licenseExpiresAt: exp,
        activatedAt: Number(cached.lastValidatedAt || 0) || null,
        activatedBy: String(cached.source || ""),
      };
    }
    const rawStatus = String(getBranchSetting(branchId, "license.status") || "").trim().toUpperCase();
    const status = rawStatus || (Number(branch?.isDefault || 0) === 1 ? ACTIVATION_STATUS_ACTIVATED : ACTIVATION_STATUS_UNACTIVATED);
    const exp = Number(getBranchSetting(branchId, "license.expiresAt") || 0) || null;
    const expired = status === ACTIVATION_STATUS_ACTIVATED && exp && Date.now() > exp;
    return {
      status: expired ? ACTIVATION_STATUS_EXPIRED : status,
      activated: status === ACTIVATION_STATUS_ACTIVATED && !expired,
      licenseId: String(getBranchSetting(branchId, "license.licenseId") || ""),
      licenseIssuedAt: Number(getBranchSetting(branchId, "license.issuedAt") || 0) || null,
      licenseExpiresAt: exp,
      activatedAt: Number(getBranchSetting(branchId, "license.activatedAt") || 0) || null,
      activatedBy: String(getBranchSetting(branchId, "license.activatedBy") || ""),
    };
  }
  function setBranchLicenseState(branchId, payload = {}) {
    const id = String(branchId || "").trim();
    if (!id) return;
    const status = String(payload.status || ACTIVATION_STATUS_UNACTIVATED).trim().toUpperCase();
    setBranchSetting(id, "license.status", status);
    setBranchSetting(id, "license.licenseId", String(payload.licenseId || ""));
    setBranchSetting(id, "license.issuedAt", String(Number(payload.issuedAt || 0) || ""));
    setBranchSetting(id, "license.expiresAt", String(Number(payload.expiresAt || 0) || ""));
    setBranchSetting(id, "license.activatedAt", String(Number(payload.activatedAt || 0) || ""));
    setBranchSetting(id, "license.activatedBy", String(payload.activatedBy || ""));
    const branch = getBranchById(id);
    if (branch?.branchId) {
      upsertBranchLicenseCache(branch, {
        status,
        licenseId: payload.licenseId,
        entitled: status === ACTIVATION_STATUS_ACTIVATED,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        lastValidatedAt: payload.activatedAt || Date.now(),
        source: payload.activatedBy,
        snapshotJson: payload.snapshotJson || null,
      });
    }
  }
  function ensureBranchLicenseInitialized(branch, status = ACTIVATION_STATUS_UNACTIVATED) {
    const branchId = String(branch?.branchId || "").trim();
    if (!branchId) return;
    const cur = String(getBranchSetting(branchId, "license.status") || "").trim();
    if (cur) return;
    setBranchLicenseState(branchId, { status });
  }
  function ensureExistingDefaultBranchLicense() {
    try {
      const rows = db.prepare(
        `SELECT branchId, orgId, branchCode, branchName, timezone, status, isDefault
         FROM branches
         WHERE upper(coalesce(status,'ACTIVE'))='ACTIVE'`
      ).all();
      for (const row of rows) {
        ensureBranchLicenseInitialized(row, ACTIVATION_STATUS_ACTIVATED);
        const legacy = {
          status: String(getBranchSetting(row.branchId, "license.status") || "").trim().toUpperCase() || (Number(row.isDefault || 0) === 1 ? ACTIVATION_STATUS_ACTIVATED : ACTIVATION_STATUS_UNACTIVATED),
          licenseId: String(getBranchSetting(row.branchId, "license.licenseId") || ""),
          issuedAt: Number(getBranchSetting(row.branchId, "license.issuedAt") || 0) || null,
          expiresAt: Number(getBranchSetting(row.branchId, "license.expiresAt") || 0) || null,
          activatedAt: Number(getBranchSetting(row.branchId, "license.activatedAt") || 0) || null,
          activatedBy: String(getBranchSetting(row.branchId, "license.activatedBy") || ""),
        };
        upsertBranchLicenseCache(row, {
          ...legacy,
          entitled: legacy.status === ACTIVATION_STATUS_ACTIVATED,
          lastValidatedAt: legacy.activatedAt || Date.now(),
          source: legacy.activatedBy || "migration",
          snapshotJson: { migrated: true, ...legacy },
        });
      }
    } catch {
      const branch = getDefaultBranchRecord();
      if (branch?.branchId) {
        ensureBranchLicenseInitialized(branch, ACTIVATION_STATUS_ACTIVATED);
        upsertBranchLicenseCache(branch, {
          status: ACTIVATION_STATUS_ACTIVATED,
          entitled: true,
          lastValidatedAt: Date.now(),
          source: "migration",
          snapshotJson: { migrated: true, branchCode: branch.branchCode },
        });
      }
    }
  }
  function enrichBranchLicense(row) {
    if (!row) return row;
    const license = getBranchLicenseState(row);
    return {
      ...row,
      licenseStatus: license.status,
      licenseActivated: !!license.activated,
      licenseId: license.licenseId,
      licenseIssuedAt: license.licenseIssuedAt,
      licenseExpiresAt: license.licenseExpiresAt,
    };
  }
  function getBranchAccessDecision(branch, surface = "branch") {
    if (!branch?.branchId) {
      return {
        ok: false,
        code: "BRANCH_NOT_FOUND",
        message: "Branch not found.",
        http: 404,
      };
    }
    const branchStatus = String(branch.status || "ACTIVE").trim().toUpperCase();
    const license = getBranchLicenseState(branch);
    const licenseStatus = String(license.status || ACTIVATION_STATUS_UNACTIVATED).trim().toUpperCase();

    if (branchStatus !== "ACTIVE") {
      return {
        ok: false,
        code: "BRANCH_INACTIVE",
        message: "This branch is inactive.",
        http: 403,
        branchStatus,
        licenseStatus,
      };
    }
    if (licenseStatus === ACTIVATION_STATUS_EXPIRED) {
      return {
        ok: false,
        code: "BRANCH_LICENSE_EXPIRED",
        message: "Branch license expired. Renewal is required.",
        http: 403,
        branchStatus,
        licenseStatus,
      };
    }
    if (!license.activated) {
      return {
        ok: false,
        code: "BRANCH_NOT_ACTIVATED",
        message: `This branch is not activated for ${surface}.`,
        http: 403,
        branchStatus,
        licenseStatus,
      };
    }
    return {
      ok: true,
      code: "OK",
      message: "",
      http: 200,
      branchStatus,
      licenseStatus,
    };
  }
  function isBranchOperational(branch) {
    return getBranchAccessDecision(branch).ok;
  }
  function findBranchForLicensePayload(payload) {
    const branchCode = String(payload?.branchCode || "").trim().toUpperCase();
    if (!branchCode) return null;
    return getBranchByCode(branchCode);
  }
  function applyBranchLicenseToken({ token, action }) {
    const rawToken = String(token || "").trim();
    if (!rawToken) {
      const err = new Error("token is required.");
      err.http = 400;
      throw err;
    }
    const st = refreshActivationState();
    const installId = String(st.installId || getDbSetting("install.id") || "").trim();
    const verified = verifyActivationToken(rawToken, { baseDir, expectedInstallId: installId });
    const payload = verified.payload;
    const branch = findBranchForLicensePayload(payload);
    if (!branch?.branchId) {
      const branchCode = String(payload?.branchCode || "").trim().toUpperCase();
      const err = new Error(branchCode ? `Branch '${branchCode}' was not found.` : "Token is missing branchCode.");
      err.http = branchCode ? 404 : 400;
      throw err;
    }

    const now = Date.now();
    const license = {
      status: ACTIVATION_STATUS_ACTIVATED,
      licenseId: String(payload.licenseId || "").trim(),
      issuedAt: Number(payload.issuedAt || 0),
      expiresAt: Number(payload.expiresAt || 0),
      activatedAt: now,
      activatedBy: String(payload.issuer || "provider").trim() || "provider",
    };
    const normalizedAction = String(action || "BRANCH_ACTIVATE").trim().toUpperCase();
    const tokenAction = normalizedAction === "BRANCH_RENEW" ? "BRANCH_RENEW" : "BRANCH_ACTIVATE";

    db.transaction(() => {
      setBranchLicenseState(branch.branchId, license);
      db.prepare(
        `INSERT INTO activation_token_usage(tokenHash, installId, branchCode, licenseId, issuer, action, consumedAt)
         VALUES(?,?,?,?,?,?,?)`
      ).run(
        verified.tokenHash,
        installId,
        String(branch.branchCode || payload.branchCode || "").trim().toUpperCase(),
        license.licenseId,
        license.activatedBy,
        tokenAction,
        now
      );
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        tokenAction,
        JSON.stringify({
          branchId: branch.branchId,
          branchCode: branch.branchCode,
          branchName: branch.branchName,
          licenseId: license.licenseId,
          expiresAt: license.expiresAt,
          issuer: license.activatedBy,
        }),
        now
      );
    })();

    return {
      ok: true,
      status: ACTIVATION_STATUS_ACTIVATED,
      installId,
      branch: enrichBranchLicense(getBranchById(branch.branchId)),
      branchCode: String(branch.branchCode || "").trim().toUpperCase(),
      branchName: String(branch.branchName || "").trim(),
      licenseIssuedAt: license.issuedAt || null,
      licenseExpiresAt: license.expiresAt || null,
      appliedAt: now,
    };
  }
  function isActivationEnforced() {
    return String(process.env.QSYS_REQUIRE_ACTIVATION || "").trim() === "1";
  }
  function getVisibleBranchCode() {
    const code = String(getBranchCode() || "").trim().toUpperCase();
    const status = String(refreshActivationState()?.status || "").toUpperCase();
    if (![ACTIVATION_STATUS_ACTIVATED, ACTIVATION_STATUS_EXPIRED].includes(status)) return "";
    if (isReservedBranchCode(code)) return "";
    return code;
  }
  function isActivationBypassRequest(req) {
    const p = stripBasePathFromUrl(String(req.path || req.originalUrl || ""));
    if (p === "/provider-setup") return true;
    if (p === "/app-boot.js") return true;
    if (p === "/api/provider/install-info") return true;
    if (p === "/api/provider/license/config") return true;
    if (p === "/api/provider/license/validate") return true;
    if (p === "/api/provider/activate") return true;
    if (p === "/api/provider/renew") return true;
    if (p === "/api/health") return true;
    if (p === "/api/public/business-date") return true;
    if (p === "/favicon.ico") return true;
    if (p === "/static/provider-setup.html") return true;
    if (p === "/static/js/provider-setup.js") return true;
    return false;
  }

  function getLicenseValidationRequestUrl(overrideUrl) {
    const raw = String(overrideUrl || getStoredLicenseValidateUrl()).trim();
    if (!raw) return "";
    return raw;
  }

  function postJson(url, payload, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (error) {
        reject(new Error("License validation URL is invalid."));
        return;
      }
      const body = JSON.stringify(payload || {});
      const isHttps = parsed.protocol === "https:";
      const transport = isHttps ? https : http;
      const timeoutMs = Math.max(1000, Number(process.env.QSYS_LICENSE_HTTP_TIMEOUT_MS || 15000) || 15000);
      const req = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname || "/"}${parsed.search || ""}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...extraHeaders,
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: Number(res.statusCode || 0), json, text });
        });
      });
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error("License validation request timed out.")));
      req.write(body);
      req.end();
    });
  }

  async function validateLicenseWithProvider({ licenseKey, validateUrl, requestType = "VALIDATE" }) {
    const install = getActivationState();
    const effectiveKey = String(licenseKey || install.licenseKey || "").trim();
    if (!effectiveKey) throw activationError("licenseKey is required.", 400);
    const requestUrl = getLicenseValidationRequestUrl(validateUrl);
    if (!requestUrl) throw activationError("License validation URL is not configured.", 400);

    const branches = listAllBranches().map((row) => ({
      branchId: String(row.branchId || ""),
      branchCode: String(row.branchCode || "").trim().toUpperCase(),
      branchName: String(row.branchName || "").trim(),
      status: String(row.status || "ACTIVE").trim().toUpperCase(),
      isDefault: Number(row.isDefault || 0) === 1,
    }));
    const payload = {
      licenseKey: effectiveKey,
      installId: String(install.installId || getDbSetting("install.id") || "").trim(),
      product: "qsys-standalone",
      appVersion: String(require("../package.json").version || "").trim(),
      hostname: os.hostname(),
      timestamp: Date.now(),
      branches,
    };
    const authToken = String(process.env.QSYS_LICENSE_API_TOKEN || "").trim();
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const attemptAt = Date.now();

    db.prepare(
      `UPDATE installation_state SET licenseKey=?, lastValidationAttemptAt=?, validationError=?, updatedAt=? WHERE id=1`
    ).run(effectiveKey, attemptAt, "", attemptAt);
    if (validateUrl != null) setStoredLicenseValidateUrl(validateUrl);

    const response = await postJson(requestUrl, payload, headers);
    const body = response.json && typeof response.json === "object" ? response.json : null;
    if (!response.ok || !body) {
      const message = body?.error || response.text || "License validation failed.";
      db.prepare(
        `UPDATE installation_state SET validationError=?, lastValidationAttemptAt=?, updatedAt=? WHERE id=1`
      ).run(String(message || "License validation failed."), attemptAt, attemptAt);
      recordLicenseValidationEvent({
        installId: payload.installId,
        licenseKeyMasked: maskLicenseKey(effectiveKey),
        requestType,
        resultStatus: LICENSE_STATUS_UNLICENSED,
        httpStatus: response.status,
        errorMessage: message,
        validatedAt: attemptAt,
        snapshotJson: body || { raw: response.text || "" },
      });
      throw activationError(message, response.status || 502);
    }

    const validationStatus = normalizeLicenseValidationStatus(body.status);
    const validatedAt = parseEpochOrNull(body.checkedAt) || Date.now();
    const graceUntil = parseEpochOrNull(body.graceUntil);
    const expiresAt = parseEpochOrNull(body.expiresAt);
    const issuedAt = parseEpochOrNull(body.issuedAt) || validatedAt;
    const activationStatus = mapValidationStatusToActivationStatus(validationStatus);
    const providerLicenseId = String(body.licenseId || "").trim();
    const features = body.features && typeof body.features === "object" ? body.features : {};
    db.prepare(
      `UPDATE installation_state
       SET status=?, activatedAt=coalesce(activatedAt, ?), activatedBy=?, activationLicenseId=?, licenseIssuedAt=?, licenseExpiresAt=?, lastRenewedAt=?, updatedAt=?,
           licenseKey=?, validationStatus=?, validationSource=?, lastValidatedAt=?, lastValidationAttemptAt=?,
           validationError=?, graceUntil=?, providerAccountId=?, providerOrgId=?, providerLicenseId=?,
           licensePlanCode=?, licenseFeaturesJson=?, licenseSnapshotJson=?
       WHERE id=1`
    ).run(
      activationStatus,
      validatedAt,
      "provider-api",
      providerLicenseId,
      issuedAt,
      expiresAt,
      validatedAt,
      validatedAt,
      effectiveKey,
      validationStatus,
      "provider-api",
      validatedAt,
      attemptAt,
      "",
      graceUntil,
      String(body.accountId || "").trim(),
      String(body.orgId || "").trim(),
      providerLicenseId,
      String(body.planCode || "").trim(),
      JSON.stringify(features),
      JSON.stringify(body)
    );
    syncProvisionedFeatures(features);
    syncValidatedBranchLicenses(body.branches, {
      validatedAt,
      graceUntil,
      source: "provider-api",
      licenseId: providerLicenseId,
    });
    recordLicenseValidationEvent({
      installId: payload.installId,
      licenseKeyMasked: maskLicenseKey(effectiveKey),
      requestType,
      resultStatus: validationStatus,
      httpStatus: response.status,
      validatedAt,
      expiresAt,
      graceUntil,
      snapshotJson: body,
    });
    return {
      ok: true,
      status: validationStatus,
      installId: payload.installId,
      providerLicenseId,
      expiresAt,
      graceUntil,
      checkedAt: validatedAt,
      branches: Array.isArray(body.branches) ? body.branches : [],
      features,
      providerUrl: requestUrl,
    };
  }

  /* ===================== SECURITY ADDON: auth + perms ===================== */

  function isScopedSessionPath(url, scope) {
    const normalized = String(url || "").trim();
    if (!normalized) return false;
    if (scope === "super-admin") {
      return normalized.startsWith("/api/super-admin/") || normalized.startsWith("/super-admin");
    }
    if (scope === "admin") {
      return normalized.startsWith("/api/admin/")
        || normalized === "/admin"
        || normalized.startsWith("/admin/")
        || /^\/b\/[^/]+\/admin(?:\/|$)/i.test(normalized)
        || /^\/b\/[^/]+\/admin-login(?:\/|$)/i.test(normalized);
    }
    if (scope === "staff") {
      return normalized.startsWith("/api/staff/")
        || normalized === "/staff"
        || normalized.startsWith("/staff/")
        || /^\/b\/[^/]+\/staff(?:\/|$)/i.test(normalized)
        || /^\/b\/[^/]+\/staff-login(?:\/|$)/i.test(normalized);
    }
    return false;
  }

  function getSessionUser(req) {
    const url = stripBasePathFromUrl(String(req.path || req.originalUrl || ""));
    // Session separation: Admin and Staff must never overwrite each other
    if (isScopedSessionPath(url, "super-admin")) {
      return (req.session && req.session.superAdminUser) ? req.session.superAdminUser : null;
    }
    if (isScopedSessionPath(url, "admin")) {
      return (req.session && req.session.adminUser) ? req.session.adminUser : null;
    }
    if (isScopedSessionPath(url, "staff")) {
      return (req.session && req.session.staffUser) ? req.session.staffUser : null;
    }
    // Fallback for legacy endpoints
    if (req.session && req.session.staffUser) return req.session.staffUser;
    if (req.session && req.session.adminUser) return req.session.adminUser;
    if (req.session && req.session.superAdminUser) return req.session.superAdminUser;
    return (req.session && req.session.user) ? req.session.user : null;
  }

  function setSessionUser(req, scope, user) {
    if (!req || !req.session) return;
    if (scope === "admin") req.session.adminUser = user;
    else if (scope === "staff") req.session.staffUser = user;
    else if (scope === "super-admin") req.session.superAdminUser = user;
    else req.session.user = user; // legacy only
  }

  function clearSessionUser(req, scope){
    if (!req || !req.session) return;
    if (scope === "admin") delete req.session.adminUser;
    else if (scope === "staff") delete req.session.staffUser;
    else if (scope === "super-admin") delete req.session.superAdminUser;
    else delete req.session.user;
  }
  function getScopedSessionUser(req, scope) {
    if (!req?.session) return null;
    if (scope === "admin") return req.session.adminUser || null;
    if (scope === "staff") return req.session.staffUser || null;
    if (scope === "super-admin") return req.session.superAdminUser || null;
    return req.session.user || null;
  }
  function sessionCookieNameForScope(scope) {
    if (scope === "staff") return "qsys_staff.sid";
    if (scope === "admin") return "qsys_admin.sid";
    if (scope === "super-admin") return "qsys_super.sid";
    return "qsys_legacy.sid";
  }
  function clearSessionCookie(res, scope = "") {
    try {
      if (!res || typeof res.clearCookie !== "function") return;
      res.clearCookie(sessionCookieNameForScope(scope), {
        httpOnly: true,
        sameSite: "lax",
        secure: String(process.env.NODE_ENV || "").toLowerCase() === "production",
        path: "/",
      });
    } catch {}
  }
  function hasAnyScopedSessionUser(session) {
    return !!(session?.adminUser || session?.staffUser || session?.superAdminUser || session?.user);
  }
  function destroySessionAndRespond(req, res, { preserveRemainingUsers = false } = {}) {
    const scope = String(req?.qsysSessionScope || "").trim();
    if (!req?.session || typeof req.session.destroy !== "function") {
      if (!preserveRemainingUsers || !hasAnyScopedSessionUser(req?.session)) {
        clearSessionCookie(res, scope);
      }
      return res.json({ ok: true });
    }
    if (preserveRemainingUsers && hasAnyScopedSessionUser(req.session)) {
      return req.session.save(() => res.json({ ok: true }));
    }
    return req.session.destroy(() => {
      clearSessionCookie(res, scope);
      res.json({ ok: true });
    });
  }
  function updateSessionSelectedBranch(req, scope, branchId) {
    if (!req?.session) return null;
    const nextBranchId = String(branchId || "").trim();
    if (!nextBranchId) return null;
    const current = scope === "admin"
      ? req.session.adminUser
      : scope === "staff"
        ? req.session.staffUser
        : scope === "super-admin"
          ? req.session.superAdminUser
        : req.session.user;
    if (!current) return null;
    const nextUser = ensureSessionBranchContext({ ...current, selectedBranchId: nextBranchId });
    setSessionUser(req, scope, nextUser);
    return nextUser;
  }

  function getRequestIp(req) {
    return String(
      req.headers["x-forwarded-for"] ||
        req.socket?.remoteAddress ||
        req.ip ||
        "unknown",
    )
      .split(",")[0]
      .trim();
  }

  function getRateLimitBranchCode(req) {
    try {
      const requestedBranchCode = String(req.query.branchCode || "").trim().toUpperCase();
      if (requestedBranchCode) return requestedBranchCode;
      const branch = getRequestBranch(req);
      return String(branch?.branchCode || getBranchCode() || "default").trim().toUpperCase() || "default";
    } catch {
      return "default";
    }
  }

  // In-memory request throttling to reduce brute force/spam pressure.
  function createRateLimiter({ windowMs, max, name, keyFn, errorMessage }) {
    const buckets = new Map();
    const win = Math.max(1000, Number(windowMs) || 60000);
    const lim = Math.max(1, Number(max) || 60);
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of buckets.entries()) {
        if (!v || Number(v.resetAt || 0) <= now) buckets.delete(k);
      }
    }, Math.min(win, 60000)).unref?.();

    return (req, res, next) => {
      const rawKey = typeof keyFn === "function" ? keyFn(req) : getRequestIp(req);
      const key = `${name || "rl"}:${String(rawKey || "unknown")}`;
      const now = Date.now();
      const cur = buckets.get(key);
      if (!cur || Number(cur.resetAt || 0) <= now) {
        buckets.set(key, { count: 1, resetAt: now + win });
        return next();
      }
      cur.count = Number(cur.count || 0) + 1;
      buckets.set(key, cur);
      if (cur.count > lim) {
        const retryAfter = Math.max(1, Math.ceil((Number(cur.resetAt || now) - now) / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({
          ok: false,
          error: errorMessage || "Too many requests. Please try again shortly.",
          retryAfterSeconds: retryAfter,
        });
      }
      return next();
    };
  }

  const rateLimitAuthLogin = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 20, name: "auth_login" });
  const rateLimitQueueCreateSessionBurst = createRateLimiter({
    windowMs: 30 * 1000,
    max: 1,
    name: "queue_create_session_burst",
    keyFn: (req) => `${getRateLimitBranchCode(req)}:${String(req.sessionID || "anon")}`,
    errorMessage: "Please wait a few seconds before requesting another ticket.",
  });
  const rateLimitQueueCreateIpBranch = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 8,
    name: "queue_create_ip_branch",
    keyFn: (req) => `${getRateLimitBranchCode(req)}:${getRequestIp(req)}`,
    errorMessage: "Too many ticket requests from this connection. Please try again shortly or ask staff for help.",
  });
  const rateLimitDisplayPair = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 25, name: "display_pair" });

  function getRoleId(u) {
    return String(u?.roleId || "").toUpperCase();
  }

  function getUserPerms(roleId) {
    try {
      const rows = db
        .prepare(
          `
        SELECT permKey
        FROM role_permissions
        WHERE roleId=? AND allowed=1
      `
        )
        .all(String(roleId));
      return rows.map((r) => r.permKey);
    } catch {
      return [];
    }
  }

  function hasPerm(u, permKey) {
    if (!u) return false;
    const roleId = getRoleId(u);
    if (roleId === "SUPER_ADMIN") return true;
    const row = db
      .prepare(
        `
      SELECT allowed
      FROM role_permissions
      WHERE roleId=? AND permKey=?
      LIMIT 1
    `
      )
      .get(roleId, String(permKey));
    return !!(row && row.allowed);
  }

  function verifyPinAgainstStoredHash(pin, pinHash) {
    const rawPin = String(pin || "");
    const storedHash = String(pinHash || "").trim();
    if (!rawPin || !storedHash) return false;
    try {
      return bcrypt.compareSync(rawPin, storedHash);
    } catch {
      return false;
    }
  }

  function requireAuth(req, res, next) {
    const u = getSessionUser(req);
    if (!u) return res.status(401).json({ ok: false, error: "Not authenticated" });
    next();
  }

  // Back-compat alias: some routes still reference requireStaffApi
function requireStaffApi(req, res, next) {
  return requireAuth(req, res, next);
}


  function requirePerm(permKey) {
    return (req, res, next) => {
      const u = getSessionUser(req);
      if (!u) return res.status(401).json({ ok: false, error: "Not authenticated" });
      if (!hasPerm(u, permKey)) return res.status(403).json({ ok: false, error: "Not allowed" });
      next();
    };
  }

  function isSuperAdmin(user) {
    return String(user?.roleId || "").toUpperCase() === "SUPER_ADMIN";
  }

  function requireSuperAdminApi(req, res, next) {
    const u = getScopedSessionUser(req, "super-admin");
    if (!u) return res.status(401).json({ ok: false, error: "Not authenticated" });
    if (!isSuperAdmin(u)) return res.status(403).json({ ok: false, error: "Super admin only" });
    next();
  }

  function requireProvisionedFeatureApi(...featureKeys) {
    const keys = (featureKeys || []).map((k) => String(k || "").trim()).filter(Boolean);
    return (_req, res, next) => {
      if (keys.some((key) => isFeatureProvisioned(key))) return next();
      return res.status(404).json({ ok: false, error: "Not found" });
    };
  }

  // For PAGE routes (redirect instead of JSON)
function requirePermPage(permKey) {
  return (req, res, next) => {
    const u = getSessionUser(req);
    if (!u) return res.redirect(pathWithBase("/admin-login"));
    if (!hasPerm(u, permKey)) return res.status(403).send("Forbidden");
    next();
  };
}

function requireStaffPage(req, res, next) {
  const u = getScopedSessionUser(req, "staff");
  if (!u) return res.redirect(buildStaffLoginPath(req?.params?.branchCode));
  next();
}

  function requireAdminPage(req, res, next) {
  const u = getScopedSessionUser(req, "admin");
  if (!u) return res.redirect(buildAdminLoginPath(req?.params?.branchCode));

  const roleId = String(u.roleId || "").toUpperCase();
  if (roleId !== "ADMIN") return res.redirect(buildAdminLoginPath(req?.params?.branchCode));
  next();
}

function requireOperationalBranch(req, res, next) {
  const branch = getRequestBranch(req);
  const decision = getBranchAccessDecision(branch, "this branch");
  if (decision.ok) return next();
  return res.status(403).json({
    ok: false,
    error: decision.message,
    code: decision.code,
    branchCode: String(branch?.branchCode || ""),
    branchStatus: String(branch?.status || ""),
    licenseStatus: decision.licenseStatus || getBranchLicenseState(branch).status,
  });
}

function requireSuperAdminPage(req, res, next) {
  const u = getScopedSessionUser(req, "super-admin");
  if (!u) return res.redirect(pathWithBase("/super-admin-login"));
  if (!isSuperAdmin(u)) return res.status(403).send("Forbidden");
  next();
}

function getCanonicalBranchCodeForScope(req, scope) {
  const u = ensureSessionBranchContext(getScopedSessionUser(req, scope));
  if (!u?.userId) return "";
  if (!Array.isArray(u.allowedBranchIds) || !u.allowedBranchIds.length) return "";
  if (scope === "admin") setSessionUser(req, "admin", u);
  if (scope === "staff") setSessionUser(req, "staff", u);
  if (scope === "super-admin") setSessionUser(req, "super-admin", u);
  const selected = getBranchById(String(u.selectedBranchId || "").trim());
  return String(selected?.branchCode || "").trim().toUpperCase();
}

function maybeRedirectToCanonicalBranchPage(req, res, scope, pageType) {
  const routeCode = String(req?.params?.branchCode || "").trim().toUpperCase();
  const selectedCode = getCanonicalBranchCodeForScope(req, scope);
  if (!selectedCode || selectedCode === routeCode) return false;
  if (pageType === "login") {
    const nextPath = scope === "admin"
      ? buildAdminLoginPath(selectedCode)
      : buildStaffLoginPath(selectedCode);
    res.redirect(nextPath);
    return true;
  }
  const nextPath = scope === "admin"
    ? buildAdminEntryPath(selectedCode)
    : buildStaffEntryPath(selectedCode);
  const query = new URLSearchParams();
  const page = String(req?.query?.page || "").trim().toLowerCase();
  const internal = String(req?.query?.internal || "").trim();
  if (page) query.set("page", page);
  if (internal) query.set("internal", internal);
  const suffix = query.toString();
  res.redirect(suffix ? `${nextPath}?${suffix}` : nextPath);
  return true;
}

  function finalizeLoginSession(req, scope, sessUser) {
    return new Promise((resolve, reject) => {
      const nextUser = ensureSessionBranchContext(sessUser);
      if (!req || !req.session || typeof req.session.save !== "function") {
        try {
          if (req?.session) {
            if (scope === "admin") delete req.session.adminUser;
            if (scope === "staff") delete req.session.staffUser;
            if (scope === "super-admin") delete req.session.superAdminUser;
          }
          setSessionUser(req, scope, nextUser);
          return resolve();
        } catch (e) {
          return reject(e);
        }
      }
      try {
        clearSessionUser(req, scope);
        setSessionUser(req, scope, nextUser);
        req.session.save((saveErr) => {
          if (saveErr) return reject(saveErr);
          return resolve();
        });
      } catch (e) {
        return reject(e);
      }
    });
  }

  function resolveRequestedLoginBranchId(req, userId, roleId = "") {
    const normalizedRoleId = String(roleId || "").trim().toUpperCase();
    const requestedCode = String(
      req?.body?.branchCode ||
      req?.query?.branchCode ||
      req?.params?.branchCode ||
      ""
    ).trim().toUpperCase();
    if (!requestedCode || !userId) return "";
    const branch = getBranchByCode(requestedCode);
    if (!branch?.branchId) return "";
    const allowed = listAccessibleBranchesForUser(userId, normalizedRoleId).some((row) => String(row.branchId || "") === String(branch.branchId || ""));
    return allowed ? String(branch.branchId || "").trim() : "";
  }
  function getRequestedLoginBranchCode(req) {
    return String(
      req?.body?.branchCode ||
      req?.query?.branchCode ||
      req?.params?.branchCode ||
      ""
    ).trim().toUpperCase();
  }
  function listLoginCandidates(fullName) {
    return db.prepare(`
      SELECT userId, fullName, pinHash, roleId, isActive, createdAt, updatedAt
      FROM users
      WHERE lower(fullName) = lower(?)
      ORDER BY updatedAt DESC, createdAt DESC, userId DESC
    `).all(String(fullName || "").trim());
  }
  function resolveLoginUserRecord(req, fullName, pin, allowedRoles = []) {
    const requestedBranchCode = getRequestedLoginBranchCode(req);
    const requestedBranch = requestedBranchCode ? getBranchByCode(requestedBranchCode) : null;
    const allowed = new Set((allowedRoles || []).map((role) => String(role || "").trim().toUpperCase()).filter(Boolean));
    const candidates = listLoginCandidates(fullName)
      .filter((row) => !!row && !!row.isActive)
      .filter((row) => !allowed.size || allowed.has(String(row.roleId || "").trim().toUpperCase()));

    if (!candidates.length) return { error: "Invalid credentials", http: 401 };
    const pinMatches = candidates.filter((row) => verifyPinAgainstStoredHash(pin, row.pinHash));
    if (!pinMatches.length) return { error: "Invalid credentials", http: 401 };

    if (requestedBranch?.branchId) {
      const narrowed = pinMatches.filter((row) => {
        const roleId = String(row.roleId || "").trim().toUpperCase();
        if (roleHasGlobalBranchAccess(roleId)) return true;
        return listUserBranchAccess(row.userId).some((branch) => String(branch.branchId || "").trim() === String(requestedBranch.branchId || "").trim());
      });
      if (narrowed.length === 1) return { user: narrowed[0] };
      if (narrowed.length > 1) {
        return { error: "Multiple active users match this name for the selected branch. Use a unique full name.", http: 409 };
      }
      return { error: "Invalid credentials", http: 401 };
    }

    if (pinMatches.length === 1) return { user: pinMatches[0] };
    return {
      error: requestedBranchCode
        ? "No unique active user matched this name for the selected branch."
        : "Multiple active users share this name. Use a unique full name or the branch-specific login link.",
      http: 409,
    };
  }

  function actorFromReq(req) {
    const u = getSessionUser(req);
    if (!u) return null;
    return { userId: u.userId, fullName: u.fullName, roleId: getRoleId(u) };
  }

  function setStaffUndo(req, payload) {
    if (!req || !req.session) return;
    req.session.staffUndo = payload || null;
  }

  function getStaffUndo(req) {
    return req?.session?.staffUndo || null;
  }

  function clearStaffUndo(req) {
    if (!req || !req.session) return;
    delete req.session.staffUndo;
  }

  app.use((req, _res, next) => {
    try {
      req.qsysBranch = resolveRequestBranch(req);
    } catch {
      req.qsysBranch = getDefaultBranchRecord();
    }
    next();
  });

  /* ---------- AUTH: login/me/logout (SESSION SEPARATED: staff vs admin) ---------- */
  // Staff login (STAFF / SUPERVISOR)
  app.post("/api/staff/auth/login", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      try { clearSessionUser(req, "staff"); } catch {}
      try { clearStaffUndo(req); } catch {}
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName || !pin) return res.status(400).json({ ok: false, error: "fullName/pin required" });

      const resolved = resolveLoginUserRecord(req, fullName, pin, ["STAFF", "SUPERVISOR"]);
      if (!resolved.user) return res.status(Number(resolved.http || 401)).json({ ok: false, error: resolved.error || "Invalid credentials" });
      const u = resolved.user;

      const role = String(u.roleId || "").toUpperCase();
      if (!["STAFF","SUPERVISOR"].includes(role)) {
        return res.status(403).json({ ok: false, error: "Not allowed for Staff app" });
      }

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      const access = getUserBranchAccessSummary(u.userId, role, "staff login");
      if (access.assignedBranches.length !== 1) {
        return res.status(409).json({
          ok: false,
          error: "Staff users must have exactly one branch assignment.",
          assignedBranches: access.assignedBranches.map((branch) => ({
            branchId: String(branch.branchId || ""),
            branchCode: String(branch.branchCode || ""),
            branchName: String(branch.branchName || ""),
            status: String(branch.status || ""),
            licenseStatus: String(branch.licenseStatus || ""),
            licenseActivated: !!branch.licenseActivated,
          })),
        });
      }

      const requestedBranchCode = getRequestedLoginBranchCode(req);
      const assignedBranch = access.assignedBranches[0] || null;
      if (requestedBranchCode) {
        if (String(assignedBranch?.branchCode || "").trim().toUpperCase() !== requestedBranchCode) {
          return res.status(403).json({
            ok: false,
            error: "This branch is not assigned to this user.",
            assignedBranches: [describeBlockedBranch(assignedBranch, "staff login")],
          });
        }
        const requestedBlocked = access.blockedBranches.find((branch) => String(branch.branchCode || "").trim().toUpperCase() === requestedBranchCode);
        if (requestedBlocked) {
          return res.status(403).json({ ok: false, error: requestedBlocked.accessMessage || "This branch is not available for staff login.", assignedBranches: [requestedBlocked] });
        }
      }

      if (!access.allowedBranches.length) {
        if (!access.assignedBranches.length) {
          return res.status(403).json({ ok: false, error: "No branch access assigned to this user." });
        }
        return res.status(403).json({
          ok: false,
          error: access.blockedBranches[0]?.accessMessage || "Your assigned branch is not available for staff login.",
          assignedBranches: access.blockedBranches,
        });
      }

      const selectedBranchId = String(
        requestedBranchCode
          ? assignedBranch?.branchId || ""
          : access.allowedBranches[0]?.branchId || assignedBranch?.branchId || ""
      ).trim();
      const sessUser = ensureSessionBranchContext({
        userId: u.userId,
        fullName: u.fullName,
        roleId: role,
        ...(selectedBranchId ? { selectedBranchId } : {}),
      });
      await finalizeLoginSession(req, "staff", sessUser);

      return res.json({ ok: true, scope: "staff", user: sessUser, branch: getBranchById(sessUser.selectedBranchId), allowedBranches: access.allowedBranches });
    } catch (e) {
      console.error("[staff/auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // Admin login (ADMIN only)
  app.post("/api/admin/auth/login", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      try { clearSessionUser(req, "admin"); } catch {}
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName || !pin) return res.status(400).json({ ok: false, error: "fullName/pin required" });

      const resolved = resolveLoginUserRecord(req, fullName, pin, ["ADMIN"]);
      if (!resolved.user) return res.status(Number(resolved.http || 401)).json({ ok: false, error: resolved.error || "Invalid credentials" });
      const u = resolved.user;

      const role = String(u.roleId || "").toUpperCase();
      if (role !== "ADMIN") {
        return res.status(403).json({ ok: false, error: "Not allowed for Admin app" });
      }

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      const requestedBranchId = resolveRequestedLoginBranchId(req, u.userId, role);
      const sessUser = ensureSessionBranchContext({
        userId: u.userId,
        fullName: u.fullName,
        roleId: role,
        ...(requestedBranchId ? { selectedBranchId: requestedBranchId } : {}),
      });
      const allowedBranches = listAccessibleBranchesForUser(u.userId, role);
      if (!allowedBranches.length) {
        return res.status(403).json({ ok: false, error: "No active branches are available." });
      }
      await finalizeLoginSession(req, "admin", sessUser);

      return res.json({ ok: true, scope: "admin", user: sessUser, branch: getBranchById(sessUser.selectedBranchId), allowedBranches });
    } catch (e) {
      console.error("[admin/auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.post("/api/super-admin/auth/login", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();
      if (!fullName || !pin) return res.status(400).json({ ok: false, error: "fullName/pin required" });

      const resolved = resolveLoginUserRecord(req, fullName, pin, ["SUPER_ADMIN"]);
      if (!resolved.user) return res.status(Number(resolved.http || 401)).json({ ok: false, error: resolved.error || "Invalid credentials" });
      const u = resolved.user;
      const role = String(u.roleId || "").toUpperCase();
      if (role !== "SUPER_ADMIN") return res.status(403).json({ ok: false, error: "Super admin only" });

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      const sessUser = { userId: u.userId, fullName: u.fullName, roleId: role };
      await finalizeLoginSession(req, "super-admin", sessUser);
      return res.json({ ok: true, scope: "super-admin", user: sessUser });
    } catch (e) {
      console.error("[super-admin/auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // Legacy login (kept for backward compatibility)
  // - ADMIN -> admin session
  // - STAFF/SUPERVISOR -> staff session
  app.post("/api/auth/login", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      try { clearSessionUser(req, "staff"); } catch {}
      try { clearSessionUser(req, "admin"); } catch {}
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName || !pin) return res.status(400).json({ ok: false, error: "fullName/pin required" });

      const resolved = resolveLoginUserRecord(req, fullName, pin, ["STAFF", "SUPERVISOR", "ADMIN"]);
      if (!resolved.user) return res.status(Number(resolved.http || 401)).json({ ok: false, error: resolved.error || "Invalid credentials" });
      const u = resolved.user;

      const role = String(u.roleId || "").toUpperCase();
      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      const access = role === "ADMIN"
        ? { allowedBranches: listAccessibleBranchesForUser(u.userId, role) }
        : getUserBranchAccessSummary(u.userId, role, "staff login");
      if (role !== "ADMIN" && !access.allowedBranches.length) {
        if (!access.assignedBranches.length) {
          return res.status(403).json({ ok: false, error: "No branch access assigned to this user." });
        }
        return res.status(403).json({
          ok: false,
          error: access.blockedBranches[0]?.accessMessage || "Your assigned branch is not available for staff login.",
          assignedBranches: access.blockedBranches,
        });
      }

      const sessUser = ensureSessionBranchContext({ userId: u.userId, fullName: u.fullName, roleId: role });
      if (role === "ADMIN") await finalizeLoginSession(req, "admin", sessUser);
      else await finalizeLoginSession(req, "staff", sessUser);

      return res.json({
        ok: true,
        scope: (role === "ADMIN" ? "admin" : "staff"),
        user: sessUser,
        branch: getBranchById(sessUser.selectedBranchId),
        allowedBranches: access.allowedBranches,
      });
    } catch (e) {
      console.error("[auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // "me" endpoints are separated to prevent cross-app session bleed.
  app.get("/api/staff/auth/me", requireAuth, (req, res) => {
    const rawUser = getScopedSessionUser(req, "staff");
    if (!rawUser) return res.status(401).json({ ok: false, error: "Not authenticated" });
    const u = ensureSessionBranchContext(rawUser);
    if (u) setSessionUser(req, "staff", u);
    const access = getUserBranchAccessSummary(u?.userId, u?.roleId, "staff access");
    if (access.assignedBranches.length !== 1) {
      try { clearSessionUser(req, "staff"); } catch {}
      try { clearStaffUndo(req); } catch {}
      return res.status(409).json({
        ok: false,
        error: "Staff users must have exactly one branch assignment.",
        assignedBranches: access.assignedBranches.map((branch) => ({
          branchId: String(branch.branchId || ""),
          branchCode: String(branch.branchCode || ""),
          branchName: String(branch.branchName || ""),
          status: String(branch.status || ""),
          licenseStatus: String(branch.licenseStatus || ""),
          licenseActivated: !!branch.licenseActivated,
        })),
      });
    }
    if (!access.allowedBranches.length) {
      try { clearSessionUser(req, "staff"); } catch {}
      try { clearStaffUndo(req); } catch {}
      if (!access.assignedBranches.length) {
        return res.status(403).json({ ok: false, error: "No branch access assigned to this user." });
      }
      return res.status(403).json({
        ok: false,
        error: access.blockedBranches[0]?.accessMessage || "Your assigned branch is not available for staff access.",
        assignedBranches: access.blockedBranches,
      });
    }
    const perms = getUserPerms(getRoleId(u));
    const branch = getRequestBranch(req);
    res.json({ ok: true, user: u, permissions: perms, branch, allowedBranches: access.allowedBranches });
  });

  app.get("/api/admin/auth/me", requireAuth, (req, res) => {
    const rawUser = getScopedSessionUser(req, "admin");
    if (!rawUser) return res.status(401).json({ ok: false, error: "Not authenticated" });
    const u = ensureSessionBranchContext(rawUser);
    if (u) setSessionUser(req, "admin", u);
    const allowedBranches = listAccessibleBranchesForUser(u?.userId, u?.roleId);
    if (!allowedBranches.length) {
      return res.status(403).json({ ok: false, error: "No active branches are available." });
    }
    const perms = getUserPerms(getRoleId(u));
    const branch = getRequestBranch(req);
    res.json({ ok: true, user: u, permissions: perms, branch, allowedBranches });
  });

  app.get("/api/admin/feature-flags", requireAuth, (_req, res) => {
    const keys = SUPER_ADMIN_FEATURE_CATALOG.map((item) => item.key);
    return res.json({ ok: true, features: getProvisionedFeatureMap(keys) });
  });

  app.get("/api/admin/diagnostics/login-trace", requirePerm("USERS_MANAGE"), (req, res) => {
    try {
      const fullName = String(req.query?.fullName || "").trim();
      const requestedBranchCode = String(req.query?.branchCode || "").trim().toUpperCase();
      const runtimeDbPath = path.join(baseDir, "data", "qsys.db");
      const requestedBranch = requestedBranchCode ? enrichBranchLicense(getBranchByCode(requestedBranchCode)) : null;

      const users = fullName
        ? listLoginCandidates(fullName).map((row) => {
            const roleId = String(row.roleId || "").trim().toUpperCase();
            const assignedBranches = listAssignedBranchesForUser(row.userId, roleId);
            const access = getUserBranchAccessSummary(row.userId, roleId, "staff login");
            return {
              userId: String(row.userId || ""),
              fullName: String(row.fullName || ""),
              roleId,
              isActive: !!row.isActive,
              createdAt: Number(row.createdAt || 0) || 0,
              updatedAt: Number(row.updatedAt || 0) || 0,
              lastLoginAt: Number(row.lastLoginAt || 0) || 0,
              assignedBranchCount: assignedBranches.length,
              assignedBranches: assignedBranches.map((branch) => ({
                branchId: String(branch.branchId || ""),
                branchCode: String(branch.branchCode || ""),
                branchName: String(branch.branchName || ""),
                status: String(branch.status || ""),
                licenseStatus: String(branch.licenseStatus || ""),
                licenseActivated: !!branch.licenseActivated,
              })),
              allowedBranches: access.allowedBranches.map((branch) => ({
                branchId: String(branch.branchId || ""),
                branchCode: String(branch.branchCode || ""),
                branchName: String(branch.branchName || ""),
                status: String(branch.status || ""),
                licenseStatus: String(branch.licenseStatus || ""),
                licenseActivated: !!branch.licenseActivated,
              })),
              blockedBranches: access.blockedBranches,
            };
          })
        : [];

      return res.json({
        ok: true,
        fullName,
        requestedBranchCode,
        runtime: {
          baseDir,
          dbPath: runtimeDbPath,
          dbExists: fs.existsSync(runtimeDbPath),
        },
        requestedBranch: requestedBranch
          ? {
              branchId: String(requestedBranch.branchId || ""),
              branchCode: String(requestedBranch.branchCode || ""),
              branchName: String(requestedBranch.branchName || ""),
              status: String(requestedBranch.status || ""),
              licenseStatus: String(requestedBranch.licenseStatus || ""),
              licenseActivated: !!requestedBranch.licenseActivated,
              access: describeBlockedBranch(requestedBranch, "staff login"),
            }
          : null,
        userCount: users.length,
        users,
      });
    } catch (e) {
      console.error("[admin/diagnostics/login-trace]", e);
      return res.status(500).json({ ok: false, error: "Failed to load login diagnostics." });
    }
  });
  app.get("/api/admin/session-diagnostics", (req, res) => {
    try {
      const sid = String(req.sessionID || "");
      const dbPath = path.join(baseDir, "data", "qsys.db");
      const sessionRow = sid
        ? db.prepare(`SELECT sid, expiresAt, updatedAt FROM http_sessions WHERE sid=? LIMIT 1`).get(sid)
        : null;
      const rawAdminUser = getScopedSessionUser(req, "admin");
      let adminAuthProbe = null;
      try {
        if (!rawAdminUser) {
          adminAuthProbe = { ok: false, error: "Not authenticated" };
        } else {
          const normalizedUser = ensureSessionBranchContext(rawAdminUser);
          const allowedBranches = listAccessibleBranchesForUser(normalizedUser?.userId, normalizedUser?.roleId);
          const branch = getRequestBranch(req);
          adminAuthProbe = {
            ok: allowedBranches.length > 0,
            error: allowedBranches.length ? "" : "No active branches are available.",
            user: normalizedUser ? {
              userId: String(normalizedUser.userId || ""),
              fullName: String(normalizedUser.fullName || ""),
              roleId: String(normalizedUser.roleId || ""),
              selectedBranchId: String(normalizedUser.selectedBranchId || ""),
              allowedBranchIds: Array.isArray(normalizedUser.allowedBranchIds) ? normalizedUser.allowedBranchIds.map((v) => String(v || "")) : [],
            } : null,
            branch: branch ? {
              branchId: String(branch.branchId || ""),
              branchCode: String(branch.branchCode || ""),
              branchName: String(branch.branchName || ""),
              status: String(branch.status || ""),
            } : null,
            allowedBranches: allowedBranches.map((item) => ({
              branchId: String(item.branchId || ""),
              branchCode: String(item.branchCode || ""),
              branchName: String(item.branchName || ""),
              status: String(item.status || ""),
              licenseStatus: String(item.licenseStatus || ""),
              licenseActivated: !!item.licenseActivated,
            })),
          };
        }
      } catch (probeError) {
        adminAuthProbe = { ok: false, error: String(probeError?.message || probeError || "Probe failed.") };
      }
      return res.json({
        ok: true,
        scope: String(req.qsysSessionScope || ""),
        sessionID: sid,
        runtime: {
          baseDir,
          dbPath,
          dbExists: fs.existsSync(dbPath),
        },
        cookies: {
          headerPresent: !!String(req.headers?.cookie || ""),
          cookieNames: String(req.headers?.cookie || "")
            .split(";")
            .map((part) => String(part || "").split("=")[0].trim())
            .filter(Boolean),
        },
        session: {
          hasSessionObject: !!req.session,
          hasAdminUser: !!req.session?.adminUser,
          hasStaffUser: !!req.session?.staffUser,
          hasSuperAdminUser: !!req.session?.superAdminUser,
          adminUser: req.session?.adminUser
            ? {
                userId: String(req.session.adminUser.userId || ""),
                fullName: String(req.session.adminUser.fullName || ""),
                roleId: String(req.session.adminUser.roleId || ""),
                selectedBranchId: String(req.session.adminUser.selectedBranchId || ""),
              }
            : null,
        },
        storeRow: sessionRow
          ? {
              sid: String(sessionRow.sid || ""),
              expiresAt: Number(sessionRow.expiresAt || 0) || 0,
              updatedAt: Number(sessionRow.updatedAt || 0) || 0,
            }
          : null,
        adminAuthProbe,
      });
    } catch (e) {
      console.error("[admin/session-diagnostics]", e);
      return res.status(500).json({ ok: false, error: "Failed to load session diagnostics." });
    }
  });
  app.post("/api/admin/diagnostics/repair-single-branch", requirePerm("USERS_MANAGE"), express.json(), (req, res) => {
    try {
      const userId = String(req.body?.userId || "").trim();
      const branchId = String(req.body?.branchId || "").trim();
      if (!userId || !branchId) {
        return res.status(400).json({ ok: false, error: "userId and branchId are required." });
      }
      const user = db.prepare(`SELECT userId, fullName, roleId, isActive FROM users WHERE userId=? LIMIT 1`).get(userId);
      if (!user?.userId) return res.status(404).json({ ok: false, error: "User not found." });
      const roleId = String(user.roleId || "").trim().toUpperCase();
      if (!["STAFF", "SUPERVISOR"].includes(roleId)) {
        return res.status(400).json({ ok: false, error: "Repair is only supported for staff or supervisor users." });
      }
      const branch = getBranchById(branchId);
      if (!branch?.branchId) return res.status(404).json({ ok: false, error: "Branch not found." });

      const nextBranchIds = replaceUserBranchAccess(db, { userId, branchIds: [branchId], roleScope: roleId });
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_DIAGNOSTICS_REPAIR_SINGLE_BRANCH",
        JSON.stringify({
          actor: actorFromReq(req),
          userId,
          fullName: String(user.fullName || ""),
          roleId,
          branchId,
          branchCode: String(branch.branchCode || ""),
        }),
        Date.now()
      );
      return res.json({
        ok: true,
        userId,
        fullName: String(user.fullName || ""),
        roleId,
        branchId: String(branch.branchId || ""),
        branchCode: String(branch.branchCode || ""),
        branchName: String(branch.branchName || ""),
        branchIds: nextBranchIds,
      });
    } catch (e) {
      console.error("[admin/diagnostics/repair-single-branch]", e);
      const msg = String(e?.message || "");
      if (msg.includes("STAFF_SINGLE_BRANCH_REQUIRED")) {
        return res.status(409).json({ ok: false, error: "Staff users must have exactly one branch assignment." });
      }
      return res.status(500).json({ ok: false, error: "Failed to repair staff branch assignment." });
    }
  });

  app.get("/api/staff/feature-flags", requireAuth, (_req, res) => {
    const keys = ["queue.recovery_tools", "queue.reopen_completed", "queue.wait_forecast"];
    return res.json({ ok: true, features: getProvisionedFeatureMap(keys) });
  });

  app.get("/api/super-admin/auth/me", requireSuperAdminApi, (req, res) => {
    const u = getScopedSessionUser(req, "super-admin");
    res.json({ ok: true, user: u, branch: getRequestBranch(req) });
  });

  // Legacy /api/auth/me kept (uses getSessionUser routing by URL)
  app.get("/api/auth/me", requireAuth, (req, res) => {
    const u = ensureSessionBranchContext(getSessionUser(req));
    const perms = getUserPerms(getRoleId(u));
    res.json({ ok: true, user: u, permissions: perms, branch: getRequestBranch(req), allowedBranches: listAccessibleBranchesForUser(u?.userId, u?.roleId) });
  });

  // Logout (separated)
  app.post("/api/staff/auth/logout", (req, res) => {
    try { clearSessionUser(req, "staff"); } catch {}
    return destroySessionAndRespond(req, res, { preserveRemainingUsers: true });
  });

  app.post("/api/admin/auth/logout", (req, res) => {
    try { clearSessionUser(req, "admin"); } catch {}
    return destroySessionAndRespond(req, res, { preserveRemainingUsers: true });
  });

  app.post("/api/super-admin/auth/logout", (req, res) => {
    try { clearSessionUser(req, "super-admin"); } catch {}
    return destroySessionAndRespond(req, res, { preserveRemainingUsers: true });
  });

  // Legacy logout: destroys everything (kept for older pages)
  app.post("/api/auth/logout", (req, res) => {
    try {
      return destroySessionAndRespond(req, res);
    } catch (e) {
      res.status(500).json({ ok: false, error: "Server error" });
    }
  });


  app.get("/api/auth/supervisors", requireAuth, (req, res) => {
    try {
      const rows = db
        .prepare(
          `
        SELECT userId, fullName, roleId
        FROM users
        WHERE isActive=1 AND roleId IN ('SUPERVISOR','ADMIN')
        ORDER BY roleId DESC, fullName ASC
      `
        )
        .all();
      res.json({ ok: true, supervisors: rows });
    } catch (e) {
      console.error("[auth/supervisors]", e);
      res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.get("/api/staff/branches", requireAuth, (req, res) => {
    const rawUser = getScopedSessionUser(req, "staff");
    if (!rawUser) return res.status(401).json({ ok: false, error: "Not authenticated" });
    const u = ensureSessionBranchContext(rawUser);
    if (u) setSessionUser(req, "staff", u);
    const access = getUserBranchAccessSummary(u?.userId, u?.roleId, "staff access");
    if (access.assignedBranches.length !== 1) {
      try { clearSessionUser(req, "staff"); } catch {}
      try { clearStaffUndo(req); } catch {}
      return res.status(409).json({
        ok: false,
        error: "Staff users must have exactly one branch assignment.",
        assignedBranches: access.assignedBranches.map((branch) => ({
          branchId: String(branch.branchId || ""),
          branchCode: String(branch.branchCode || ""),
          branchName: String(branch.branchName || ""),
          status: String(branch.status || ""),
          licenseStatus: String(branch.licenseStatus || ""),
          licenseActivated: !!branch.licenseActivated,
        })),
      });
    }
    if (!access.allowedBranches.length) {
      try { clearSessionUser(req, "staff"); } catch {}
      try { clearStaffUndo(req); } catch {}
      if (!access.assignedBranches.length) {
        return res.status(403).json({ ok: false, error: "No branch access assigned to this user." });
      }
      return res.status(403).json({
        ok: false,
        error: access.blockedBranches[0]?.accessMessage || "Your assigned branch is not available for staff access.",
        assignedBranches: access.blockedBranches,
      });
    }
    return res.json({
      ok: true,
      selectedBranchId: String(u?.selectedBranchId || ""),
      branches: access.allowedBranches,
    });
  });

  app.post("/api/staff/select-branch", requireAuth, express.json(), (req, res) => {
    const rawUser = getScopedSessionUser(req, "staff");
    if (!rawUser) return res.status(401).json({ ok: false, error: "Not authenticated" });
    const u = ensureSessionBranchContext(rawUser);
    const branchId = String(req.body?.branchId || "").trim();
    const allowed = new Set((u?.allowedBranchIds || []).map((id) => String(id || "").trim()));
    if (!branchId || !allowed.has(branchId)) {
      return res.status(400).json({ ok: false, error: "Branch not assigned to this user." });
    }
    const nextUser = updateSessionSelectedBranch(req, "staff", branchId);
    if (!req?.session || typeof req.session.save !== "function") {
      return res.json({ ok: true, user: nextUser, branch: getBranchById(branchId) });
    }
    return req.session.save((err) => {
      if (err) {
        console.error("[staff/select-branch]", err);
        return res.status(500).json({ ok: false, error: "Failed to persist branch selection." });
      }
      return res.json({ ok: true, user: nextUser, branch: getBranchById(branchId) });
    });
  });

  app.use("/api/staff", (req, res, next) => {
    const pathName = String(req.path || "");
    if (pathName.startsWith("/auth/") || pathName === "/branches" || pathName === "/select-branch" || pathName === "/feature-flags") {
      return next();
    }
    return requireAuth(req, res, () => requireOperationalBranch(req, res, next));
  });

  app.get("/api/admin/branches", requireAuth, (req, res) => {
    const rawUser = getScopedSessionUser(req, "admin");
    if (!rawUser) return res.status(401).json({ ok: false, error: "Not authenticated" });
    const u = ensureSessionBranchContext(rawUser);
    if (u) setSessionUser(req, "admin", u);
    return res.json({
      ok: true,
      selectedBranchId: String(u?.selectedBranchId || ""),
      branches: listAccessibleBranchesForUser(u?.userId, u?.roleId),
    });
  });

  app.get("/api/admin/branches/manage", requirePerm("SETTINGS_MANAGE"), (_req, res) => {
    try {
      return res.json({ ok: true, branches: listAllBranches() });
    } catch (e) {
      console.error("[admin/branches/manage:get]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  function parseCsvCells(line) {
    const cells = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === "," && !inQuotes) {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }

    cells.push(current.trim());
    return cells.map((cell) => String(cell || "").replace(/^\uFEFF/, "").trim());
  }

  app.post("/api/admin/branches/manage", requirePerm("SETTINGS_MANAGE"), express.json(), (req, res) => {
    try {
      const branchId = String(req.body?.branchId || "").trim();
      const branchCode = String(req.body?.branchCode || "").trim().toUpperCase();
      const branchName = String(req.body?.branchName || "").trim();
      const timezone = String(req.body?.timezone || "Asia/Manila").trim() || "Asia/Manila";
      const status = String(req.body?.status || "ACTIVE").trim().toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE";
      const isDefault = req.body?.isDefault === true || String(req.body?.isDefault || "").toLowerCase() === "true";

      if (!branchCode) return res.status(400).json({ ok: false, error: "branchCode is required." });
      if (!branchName) return res.status(400).json({ ok: false, error: "branchName is required." });

      const now = Date.now();
      const existing = branchId ? getBranchById(branchId) : null;
      const defaultBranch = getDefaultBranchRecord();
      const orgId = String(existing?.orgId || defaultBranch?.orgId || getDbSetting("multibranch.defaultOrgId") || "").trim();
      if (!orgId) return res.status(500).json({ ok: false, error: "No organization available for branch assignment." });

      const duplicate = db.prepare(
        `SELECT branchId FROM branches WHERE orgId=? AND upper(branchCode)=? AND branchId<>? LIMIT 1`
      ).get(orgId, branchCode, branchId || "");
      if (duplicate?.branchId) {
        return res.status(409).json({ ok: false, error: "Branch code is already in use." });
      }

      let savedBranchId = branchId;
      if (existing?.branchId) {
        db.prepare(
          `UPDATE branches
           SET branchCode=?, branchName=?, timezone=?, status=?, updatedAt=?
           WHERE branchId=?`
        ).run(branchCode, branchName, timezone, status, now, existing.branchId);
      } else {
        savedBranchId = randomUUID();
        db.prepare(
          `INSERT INTO branches(branchId, orgId, branchCode, branchName, timezone, status, isDefault, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(savedBranchId, orgId, branchCode, branchName, timezone, status, 0, now, now);
        setBranchLicenseState(savedBranchId, { status: ACTIVATION_STATUS_UNACTIVATED });
      }

      if (isDefault) {
        db.prepare(`UPDATE branches SET isDefault=CASE WHEN branchId=? THEN 1 ELSE 0 END, updatedAt=? WHERE orgId=?`).run(savedBranchId, now, orgId);
        db.prepare(
          `INSERT INTO branch_config(id, branchCode, branchName, timezone, createdAt, updatedAt)
           VALUES(1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET branchCode=excluded.branchCode, branchName=excluded.branchName, timezone=excluded.timezone, updatedAt=excluded.updatedAt`
        ).run(branchCode, branchName, timezone, now, now);
      }

      const saved = getBranchById(savedBranchId);
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        existing?.branchId ? "ADMIN_BRANCH_RECORD_UPDATE" : "ADMIN_BRANCH_RECORD_CREATE",
        JSON.stringify({
          actor: actorFromReq(req),
          branchId: savedBranchId,
          branchCode,
          branchName,
          timezone,
          status,
          isDefault,
        }),
        now
      );

      return res.json({ ok: true, branch: saved, branches: listAllBranches() });
    } catch (e) {
      console.error("[admin/branches/manage:post]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/branches/manage/delete", requirePerm("SETTINGS_MANAGE"), express.json(), (req, res) => {
    try {
      const branchId = String(req.body?.branchId || "").trim();
      if (!branchId) return res.status(400).json({ ok: false, error: "branchId is required." });
      const branch = getBranchById(branchId);
      if (!branch?.branchId) return res.status(404).json({ ok: false, error: "Branch not found." });
      if (Number(branch.isDefault || 0) === 1) {
        return res.status(409).json({ ok: false, error: "Default branch cannot be deleted." });
      }

      const userAccessCount = Number(db.prepare(`SELECT count(1) AS n FROM user_branch_access WHERE branchId=?`).get(branchId)?.n || 0);
      if (userAccessCount > 0) {
        return res.status(409).json({ ok: false, error: "Remove user branch assignments before deleting this branch." });
      }

      const mediaCount = Number(db.prepare(`SELECT count(1) AS n FROM media_assets WHERE branchId=?`).get(branchId)?.n || 0);
      if (mediaCount > 0) {
        return res.status(409).json({ ok: false, error: "Remove branch media before deleting this branch." });
      }

      const licenseCount = Number(db.prepare(`SELECT count(1) AS n FROM super_admin_licenses WHERE branchId=?`).get(branchId)?.n || 0);
      if (licenseCount > 0) {
        return res.status(409).json({ ok: false, error: "This branch has license records. Revoke or archive them first." });
      }

      const tokenUsageCount = Number(db.prepare(`SELECT count(1) AS n FROM activation_token_usage WHERE upper(branchCode)=?`).get(String(branch.branchCode || "").trim().toUpperCase())?.n || 0);
      if (tokenUsageCount > 0) {
        return res.status(409).json({ ok: false, error: "This branch has activation history and cannot be deleted." });
      }

      const now = Date.now();
      db.transaction(() => {
        db.prepare(`DELETE FROM branch_settings WHERE branchId=?`).run(branchId);
        db.prepare(`DELETE FROM branch_business_dates WHERE branchId=?`).run(branchId);
        db.prepare(`DELETE FROM branch_license_state WHERE branchId=?`).run(branchId);
        db.prepare(`DELETE FROM branches WHERE branchId=?`).run(branchId);
        db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
          "ADMIN_BRANCH_RECORD_DELETE",
          JSON.stringify({
            actor: actorFromReq(req),
            branchId,
            branchCode: String(branch.branchCode || "").trim().toUpperCase(),
            branchName: String(branch.branchName || "").trim(),
          }),
          now
        );
      })();

      return res.json({ ok: true, branches: listAllBranches() });
    } catch (e) {
      console.error("[admin/branches/manage/delete]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/branches/manage/import", requirePerm("SETTINGS_MANAGE"), express.json({ limit: "512kb" }), (req, res) => {
    try {
      const csvText = String(req.body?.csvText || "").replace(/^\uFEFF/, "").trim();
      if (!csvText) {
        return res.status(400).json({ ok: false, error: "csvText is required." });
      }

      const lines = csvText
        .split(/\r?\n/)
        .map((line) => String(line || "").trim())
        .filter(Boolean);

      if (!lines.length) {
        return res.status(400).json({ ok: false, error: "No CSV rows were found." });
      }

      const parsedRows = lines.map(parseCsvCells);
      const firstRow = parsedRows[0] || [];
      const firstCode = String(firstRow[0] || "").trim().toUpperCase();
      const firstName = String(firstRow[1] || "").trim().toUpperCase();
      const hasHeader = firstCode === "BRANCHCODE" && firstName === "BRANCHNAME";
      const rows = hasHeader ? parsedRows.slice(1) : parsedRows;

      if (!rows.length) {
        return res.status(400).json({ ok: false, error: "The CSV only contains a header row." });
      }

      const defaultBranch = getDefaultBranchRecord();
      const orgId = String(defaultBranch?.orgId || getDbSetting("multibranch.defaultOrgId") || "").trim();
      if (!orgId) {
        return res.status(500).json({ ok: false, error: "No organization available for branch assignment." });
      }

      const now = Date.now();
      let created = 0;
      let updated = 0;
      const importedCodes = [];
      const touched = [];

      const insertBranch = db.prepare(
        `INSERT INTO branches(branchId, orgId, branchCode, branchName, timezone, status, isDefault, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,?,?,?)`
      );
      const updateBranch = db.prepare(
        `UPDATE branches
         SET branchName=?, timezone=?, status=?, updatedAt=?
         WHERE branchId=?`
      );

      const runImport = db.transaction(() => {
        rows.forEach((cols, index) => {
          const rowNumber = index + 1 + (hasHeader ? 1 : 0);
          const branchCode = String(cols[0] || "").trim().toUpperCase();
          const branchName = String(cols[1] || "").trim();

          if (!branchCode || !branchName) {
            throw new Error(`Row ${rowNumber} must contain branch code and branch name.`);
          }

          const existing = getBranchByCode(branchCode);
          if (existing?.branchId) {
            updateBranch.run(branchName, String(existing.timezone || "Asia/Manila").trim() || "Asia/Manila", "ACTIVE", now, existing.branchId);
            updated += 1;
            touched.push({
              branchId: existing.branchId,
              branchCode,
              branchName,
              action: "updated",
            });
          } else {
            const branchId = randomUUID();
            insertBranch.run(branchId, orgId, branchCode, branchName, "Asia/Manila", "ACTIVE", 0, now, now);
            setBranchLicenseState(branchId, { status: ACTIVATION_STATUS_UNACTIVATED });
            created += 1;
            touched.push({
              branchId,
              branchCode,
              branchName,
              action: "created",
            });
          }

          importedCodes.push(branchCode);
        });
      });

      runImport();

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_BRANCH_IMPORT",
        JSON.stringify({
          actor: actorFromReq(req),
          created,
          updated,
          importedCodes,
          rows: touched,
        }),
        now
      );

      return res.json({ ok: true, created, updated, importedCodes, branches: listAllBranches() });
    } catch (e) {
      console.error("[admin/branches/manage/import]", e);
      return res.status(400).json({ ok: false, error: String(e?.message || "Failed to import branches.") });
    }
  });

  app.post("/api/admin/select-branch", requireAuth, express.json(), (req, res) => {
    const u = ensureSessionBranchContext(getSessionUser(req));
    const branchId = String(req.body?.branchId || "").trim();
    const allowed = new Set((u?.allowedBranchIds || []).map((id) => String(id || "").trim()));
    if (!branchId || !allowed.has(branchId)) {
      return res.status(400).json({ ok: false, error: "Branch not assigned to this user." });
    }
    const nextUser = updateSessionSelectedBranch(req, "admin", branchId);
    if (!req?.session || typeof req.session.save !== "function") {
      return res.json({ ok: true, user: nextUser, branch: getBranchById(branchId) });
    }
    return req.session.save((err) => {
      if (err) {
        console.error("[admin/select-branch]", err);
        return res.status(500).json({ ok: false, error: "Failed to persist branch selection." });
      }
      return res.json({ ok: true, user: nextUser, branch: getBranchById(branchId) });
    });
  });

  app.post("/api/internal/super-admin/recover", express.json(), (req, res) => {
    try {
      const remote = String(req.ip || req.socket?.remoteAddress || "");
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        return res.status(403).json({ ok: false, error: "Loopback only" });
      }
      const fullName = String(process.env.QSYS_SUPER_ADMIN_USER || "").trim() || DEFAULT_SUPER_ADMIN_USER;
      const pin = String(process.env.QSYS_SUPER_ADMIN_PIN || "").trim() || DEFAULT_SUPER_ADMIN_PIN;
      if (!fullName || !/^\d{6}$/.test(pin)) {
        return res.status(500).json({ ok: false, error: "Recovery credentials are not configured." });
      }

      const now = Date.now();
      const pinHash = bcrypt.hashSync(pin, 10);
      const existing = db.prepare(
        `SELECT userId FROM users WHERE upper(roleId)='SUPER_ADMIN' ORDER BY createdAt ASC LIMIT 1`
      ).get();

      let userId = "";
      if (existing?.userId) {
        userId = String(existing.userId || "");
        db.prepare(
          `UPDATE users
           SET fullName=?, pinHash=?, roleId='SUPER_ADMIN', isActive=1, updatedAt=?
           WHERE userId=?`
        ).run(fullName, pinHash, now, userId);
      } else {
        userId = randomUUID();
        db.prepare(
          `INSERT INTO users(userId, fullName, pinHash, roleId, isActive, createdAt, updatedAt)
           VALUES(?,?,?,?,1,?,?)`
        ).run(userId, fullName, pinHash, "SUPER_ADMIN", now, now);
      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "SUPER_ADMIN_RECOVERY_RESET",
        JSON.stringify({ actor: "LOCAL_RECOVERY", userId, fullName, roleId: "SUPER_ADMIN" }),
        now
      );

      return res.json({ ok: true, user: { userId, fullName, roleId: "SUPER_ADMIN" } });
    } catch (e) {
      console.error("[internal/super-admin/recover]", e);
      return res.status(500).json({ ok: false, error: "Recovery reset failed." });
    }
  });

  /* ===================== END SECURITY ADDON ===================== */

  // --- Realtime (SSE) clients ---
  const sseClients = new Map();

  function sseSend(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  app.get("/api/admin/stream", requireAuth, (req, res) => {
    // If you already have admin auth middleware, KEEP IT here:
    // adminAuth(req,res,next)

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // optional: send hello
    sseSend(res, "hello", { ok: true, ts: Date.now() });

    // send initial dashboard snapshot immediately
    try {
      const bd = ensureBusinessDate(db);
      sseSend(res, "overview", computeAdminTodayStats(db, getRequestBranchCode(req), bd));
    } catch {}

    sseClients.set(res, { branchCode: getRequestBranchCode(req) });

    // keep-alive ping to prevent idle disconnects
    const ping = setInterval(() => {
      try {
        sseSend(res, "ping", { ts: Date.now() });
      } catch {}
    }, 25000);

    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  function broadcast(event, payload) {
    for (const [res, client] of sseClients.entries()) {
      try {
        const body = typeof payload === "function" ? payload(client) : payload;
        if (body === null || body === undefined) continue;
        sseSend(res, event, body);
      } catch {}
    }
  }

  // expose broadcaster + overview calculator to helpers
  app.set("broadcast", broadcast);
  app.set("computeOverview", (branchCode) => {
    const bd = ensureBusinessDate(db);
    return computeAdminTodayStats(db, branchCode || getBranchCode(), bd);
  });

  /* ---------- pages ---------- */

  /* ---------- QR: Dynamic Guest Registration ---------- */
app.set("trust proxy", true); // needed for deployed environments

function buildGuestEntryPath(branchCodeInput = "") {
  const code = String(branchCodeInput || "").trim().toUpperCase();
  if (!code) return pathWithBase("/guest");
  return pathWithBase(`/b/${encodeURIComponent(code)}/guest`);
}

function buildStaffLoginPath(branchCodeInput = "") {
  const code = String(branchCodeInput || "").trim().toUpperCase();
  return code
    ? pathWithBase(`/staff-login?branchCode=${encodeURIComponent(code)}`)
    : pathWithBase("/staff-login");
}

function buildStaffEntryPath(branchCodeInput = "") {
  const code = String(branchCodeInput || "").trim().toUpperCase();
  if (!code) return pathWithBase("/staff");
  return pathWithBase(`/b/${encodeURIComponent(code)}/staff`);
}

function buildAdminLoginPath(branchCodeInput = "") {
  const code = String(branchCodeInput || "").trim().toUpperCase();
  return code
    ? pathWithBase(`/admin-login?branchCode=${encodeURIComponent(code)}`)
    : pathWithBase("/admin-login");
}

function buildAdminEntryPath(branchCodeInput = "") {
  const code = String(branchCodeInput || "").trim().toUpperCase();
  if (!code) return pathWithBase("/admin");
  return pathWithBase(`/b/${encodeURIComponent(code)}/admin`);
}

function buildDisplayEntryPath(branchCodeInput = "", mode = "") {
  const code = String(branchCodeInput || "").trim().toUpperCase();
  const m = String(mode || "").trim().toLowerCase();
  const page =
    m === "portrait"
      ? "display-portrait.html"
      : m === "landscape"
        ? "display-landscape.html"
        : "display";
  if (!code) return pathWithBase(`/${page}`);
  return pathWithBase(`/b/${encodeURIComponent(code)}/${page}`);
}

function buildGuestEntryUrl(req, branchCodeInput = "") {
  const proto =
    (req.headers["x-forwarded-proto"] || req.protocol || "http")
      .split(",")[0]
      .trim();
  const host = String(req.get("host") || "");
  return `${proto}://${host}${buildGuestEntryPath(branchCodeInput)}`;
}

app.get("/qr/guest", async (req, res) => {
  try {
    const requestedBranchCode = String(req.query.branchCode || "").trim().toUpperCase();
    const branchCode = requestedBranchCode || getRequestBranchCode(req);
    const guestUrl = buildGuestEntryUrl(req, branchCode);


    const png = await QRCode.toBuffer(guestUrl, {
      margin: 1,
      scale: 8,
    });

    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (err) {
    console.error("[QR]", err);
    res.status(500).send("QR generation failed");
  }
});

app.get("/app-boot.js", (_req, res) => {
  const basePathJson = JSON.stringify(APP_BASE_PATH);
  res.type("application/javascript").send(`(() => {
  const basePath = ${basePathJson};

  function withBase(input) {
    const raw = String(input || "");
    if (!basePath) return raw || "/";
    if (!raw) return basePath;
    if (/^(?:[a-z]+:)?\\/\\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("#")) return raw;
    if (!raw.startsWith("/")) return raw;
    if (raw === basePath || raw.startsWith(basePath + "/") || raw.startsWith(basePath + "?")) return raw;
    return basePath + raw;
  }

  window.__APP_BASE_PATH__ = basePath;
  window.appUrl = withBase;
  window.appAbsoluteUrl = function(input) {
    return window.location.origin + withBase(input);
  };

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function(input, init) {
      if (typeof input === "string") return nativeFetch(withBase(input), init);
      return nativeFetch(input, init);
    };
  }

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    window.EventSource = function(url, config) {
      return new NativeEventSource(withBase(url), config);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }
})();`);
});
app.get("/b/:branchCode/app-boot.js", (_req, res) => {
  const basePathJson = JSON.stringify(APP_BASE_PATH);
  res.type("application/javascript").send(`(() => {
  const basePath = ${basePathJson};

  function withBase(input) {
    const raw = String(input || "");
    if (!basePath) return raw || "/";
    if (!raw) return basePath;
    if (/^(?:[a-z]+:)?\\/\\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("#")) return raw;
    if (!raw.startsWith("/")) return raw;
    if (raw === basePath || raw.startsWith(basePath + "/") || raw.startsWith(basePath + "?")) return raw;
    return basePath + raw;
  }

  window.__APP_BASE_PATH__ = basePath;
  window.appUrl = withBase;
  window.appAbsoluteUrl = function(input) {
    return window.location.origin + withBase(input);
  };

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function(input, init) {
      if (typeof input === "string") return nativeFetch(withBase(input), init);
      return nativeFetch(input, init);
    };
  }

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    window.EventSource = function(url, config) {
      return new NativeEventSource(withBase(url), config);
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }
})();`);
});

app.get("/qr/wifi", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
  try {
    // Wi‑Fi QR payload uses app_settings (saved from Admin → QR Setup)
    const secRaw = String(getAppSetting("wifi_security") || "WPA").trim();
    const sec = ["WPA", "WEP", "nopass"].includes(secRaw) ? secRaw : "WPA";

    const ssidRaw = String(getAppSetting("wifi_ssid") || "").trim();
    const passRaw = String(getAppSetting("wifi_password") || "");
    const hiddenRaw = String(getAppSetting("wifi_hidden") || "false").trim().toLowerCase();
    const hidden = hiddenRaw === "true" ? "true" : "false";

    // Basic fallback so preview still works even if SSID not set
    const ssid = ssidRaw || "YOUR_WIFI_SSID";
    const pass = passRaw || "";

    const esc = (v) =>
      String(v || "")
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/:/g, "\\:")
        .replace(/"/g, '\\"');

    const S = esc(ssid);
    const P = esc(pass);

    const payload =
      sec === "nopass"
        ? `WIFI:T:nopass;S:${S};H:${hidden};;`
        : `WIFI:T:${sec};S:${S};P:${P};H:${hidden};;`;

    const png = await QRCode.toBuffer(payload, { margin: 1, scale: 8 });

    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (err) {
    console.error("[QR WIFI]", err);
    res.status(500).send("QR generation failed");
  }
});

  app.get("/display", (req, res) => {
  setPrivateSurfaceNoIndex(res);
  try {
    const orientation = String(getResolvedDisplaySettings(getRequestBranch(req))["display.orientation"] || "landscape");
    if (orientation === "portrait") {
      return res.redirect(302, pathWithBase("/display-portrait.html"));
    }
    return res.redirect(302, pathWithBase("/display-landscape.html"));
  } catch {
    return res.redirect(302, pathWithBase("/display-landscape.html"));
  }
});


  // Serve the landscape display entry HTML
  app.get("/display-landscape.html", (_req, res) =>
    (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "display-landscape.html")))
  );
  
  // Serve the portrait display entry HTML
  app.get("/display-portrait.html", (_req, res) =>
    (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "display-portrait.html")))
  );
  app.get("/b/:branchCode/display", (req, res) => {
    setPrivateSurfaceNoIndex(res);
    const branchCode = String(req.params.branchCode || "").trim().toUpperCase();
    if (!branchCode || !getBranchByCode(branchCode)) return res.status(404).send("Branch not found");
    try {
      const orientation = String(getResolvedDisplaySettings(getRequestBranch(req))["display.orientation"] || "landscape");
      return res.redirect(302, buildDisplayEntryPath(branchCode, orientation));
    } catch {
      return res.redirect(302, buildDisplayEntryPath(branchCode, "landscape"));
    }
  });
  app.get("/b/:branchCode/display-landscape.html", (req, res) => {
    const branchCode = String(req.params.branchCode || "").trim().toUpperCase();
    if (!branchCode || !getBranchByCode(branchCode)) return res.status(404).send("Branch not found");
    return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "display-landscape.html")));
  });
  app.get("/b/:branchCode/display-portrait.html", (req, res) => {
    const branchCode = String(req.params.branchCode || "").trim().toUpperCase();
    if (!branchCode || !getBranchByCode(branchCode)) return res.status(404).send("Branch not found");
    return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "display-portrait.html")));
  });
app.get("/staff", requireStaffPage, (req, res) => {
  if (maybeRedirectToCanonicalBranchPage(req, res, "staff", "entry")) return;
  const decision = getBranchAccessDecision(getRequestBranch(req), "staff access");
  if (!decision.ok) return res.status(decision.http || 403).send(decision.message);
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "staff.html")));
});
app.get("/b/:branchCode/staff", requireStaffPage, (req, res) => {
  if (maybeRedirectToCanonicalBranchPage(req, res, "staff", "entry")) return;
  const decision = getBranchAccessDecision(getRequestBranch(req), "staff access");
  if (!decision.ok) return res.status(decision.http || 403).send(decision.message);
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "staff.html")));
});

/* ---------- Admin: QR (PNG for preview / print / download) ---------- */
app.get("/api/admin/qrcode.png", requireAuth, (req, res) => {
  try {
    // Reuse the same QR logic used by /qr/guest
    // Internally redirect so we keep ONE source of truth
    const branchCode = String(req.query.branchCode || getRequestBranchCode(req) || "").trim().toUpperCase();
    req.url = branchCode ? `/qr/guest?branchCode=${encodeURIComponent(branchCode)}` : "/qr/guest";
    app.handle(req, res);
  } catch (e) {
    console.error("[admin/qrcode]", e);
    res.status(500).send("QR generation failed");
  }
});

/* ---------- Admin: Wi‑Fi QR (PNG) ---------- */
app.get("/api/admin/wifi-qrcode.png", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    // Internally redirect so we keep ONE source of truth
    req.url = "/qr/wifi";
    app.handle(req, res);
  } catch (e) {
    console.error("[admin/wifi-qrcode]", e);
    res.status(500).send("QR generation failed");
  }
});

  app.get("/guest", (_req, res) => res.sendFile(path.join(__dirname, "static", "guest.html")));
  app.get("/b/:branchCode/guest", (req, res) => {
    const branchCode = String(req.params.branchCode || "").trim().toUpperCase();
    const branch = getBranchByCode(branchCode);
    if (!branchCode || !branch) {
      return res.status(404).send("Branch not found");
    }
    const decision = getBranchAccessDecision(branch, "guest registration");
    if (!decision.ok) return res.status(decision.http || 403).send(decision.message);
    return res.sendFile(path.join(__dirname, "static", "guest.html"));
  });
  app.get("/test", (_req, res) =>
    res.sendFile(path.join(__dirname, "static", "test.html"))
  );
 
  // ✅ Admin page requires login (so permission-gated actions like Media Folder work)
 app.get("/admin", requireAdminPage, (req, res) => {
  if (maybeRedirectToCanonicalBranchPage(req, res, "admin", "entry")) return;
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "admin.html")));
});
app.get("/b/:branchCode/admin", requireAdminPage, (req, res) => {
  if (maybeRedirectToCanonicalBranchPage(req, res, "admin", "entry")) return;
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "admin.html")));
});
app.get("/admin-diagnostics", requireAdminPage, requirePermPage("USERS_MANAGE"), (_req, res) => {
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "admin-login-diagnostics.html")));
});
app.get("/b/:branchCode/admin-diagnostics", requireAdminPage, requirePermPage("USERS_MANAGE"), (req, res) => {
  if (maybeRedirectToCanonicalBranchPage(req, res, "admin", "entry")) return;
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "admin-login-diagnostics.html")));
});
app.get("/admin-session-diagnostics", (_req, res) => {
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "admin-session-diagnostics.html")));
});
app.get("/b/:branchCode/admin-session-diagnostics", (req, res) => {
  if (maybeRedirectToCanonicalBranchPage(req, res, "admin", "entry")) return;
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "admin-session-diagnostics.html")));
});

app.get("/admin-login", (req, res) => {
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "admin-login.html")));
});
app.get("/b/:branchCode/admin-login", (req, res) => {
  return res.redirect(buildAdminLoginPath(req?.params?.branchCode));
});

app.get("/super-admin-login", (req, res) => {
  if (req?.session?.superAdminUser) return res.redirect(pathWithBase("/super-admin"));
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "super-admin-login.html")));
});

app.get("/super-admin-recover", (_req, res) =>
  (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "super-admin-recover.html")))
);

app.get("/provider-setup", (_req, res) =>
  (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "provider-setup.html")))
);

app.get("/super-admin", requireSuperAdminPage, (_req, res) =>
  (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "super-admin.html")))
);

app.get("/internal-tools", requireSuperAdminPage, (_req, res) =>
  (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "internal-tools.html")))
);


app.get("/staff-login", (req, res) => {
  return (setPrivateSurfaceNoIndex(res), res.sendFile(path.join(__dirname, "static", "staff-login.html")));
});
app.get("/b/:branchCode/staff-login", (req, res) => {
  return res.redirect(buildStaffLoginPath(req?.params?.branchCode));
});


  /* ---------- GUEST: Ticket details (for ticket.html) ---------- */
  // Used by /static/ticket.html to display queue info (offline-safe, no realtime stats)
  app.get("/api/guest/ticket", (req, res) => {
    try {
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "id required" });

      const row = db
        .prepare(
          `
        SELECT id, branchCode, businessDate, groupCode, queueNum, priorityType, name, pax, status
        FROM queue_items
        WHERE id = ?
        LIMIT 1
      `
        )
        .get(id);

      if (!row) return res.status(404).json({ ok: false, error: "not found" });

      const isPriority = String(row.priorityType || "NONE").toUpperCase() !== "NONE";
      const code = `${isPriority ? "P" : ""}${row.groupCode}-${String(row.queueNum).padStart(2, "0")}`;
      const status = String(row.status || "").toUpperCase();
      let waitingPosition = null;
      let waitingAhead = null;
      if (status === "WAITING") {
        const ahead = db
          .prepare(
            `
          SELECT COUNT(*) AS n
          FROM queue_items
          WHERE branchCode=?
            AND businessDate=?
            AND groupCode=?
            AND status='WAITING'
            AND (
              CASE
                WHEN ?=1 THEN
                  (priorityType IS NOT NULL AND priorityType!='NONE' AND queueNum < ?)
                ELSE
                  (
                    (priorityType IS NOT NULL AND priorityType!='NONE')
                    OR ((priorityType IS NULL OR priorityType='NONE') AND queueNum < ?)
                  )
              END
            )
        `
          )
          .get(
            row.branchCode,
            row.businessDate,
            row.groupCode,
            isPriority ? 1 : 0,
            row.queueNum,
            row.queueNum
          )?.n || 0;
        waitingAhead = Number(ahead) || 0;
        waitingPosition = waitingAhead + 1;
      }

      let branchName = row.branchCode;
      try {
        const branch = getBranchByCode(row.branchCode);
        if (branch?.branchName) branchName = String(branch.branchName).trim() || branchName;
        else {
          const cfg = getBranchConfigSafe();
          if (cfg && cfg.branchName) branchName = String(cfg.branchName).trim() || branchName;
        }
      } catch {}

      return res.json({
        ok: true,
        ticket: {
          id: row.id,
          code,
          name: row.name || "Guest",
          pax: row.pax || 1,
          group: row.groupCode,
          priorityType: String(row.priorityType || "NONE"),
          branchCode: row.branchCode,
          branchName,
          businessDate: row.businessDate,
          status: row.status,
          waitingPosition,
          waitingAhead,
        },
      });
    } catch (e) {
      console.error("[api/guest/ticket]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- admin/business date ---------- */

  app.get("/api/public/business-date", (req, res) => {
    try {
      const cur = ensureBusinessDate(db);
      const st = refreshActivationState();
      const branch = getRequestBranch(req);
      res.json({
        ok: true,
        activationStatus: String(st.status || ACTIVATION_STATUS_UNACTIVATED).toUpperCase(),
        branchCode: getRequestBranchCode(req),
        branchName: getRequestBranchName(req),
        timezone: getRequestBranchTimezone(req),
        branchId: String(branch?.branchId || ""),
        currentBusinessDate: cur,
        todayManila: getTodayManila(),
      });
    } catch (e) {
      console.error("[public/business-date]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.get("/api/public/branches", (_req, res) => {
    try {
      const rows = listOperationalBranches().map((row) => ({
        branchId: String(row.branchId || ""),
        branchCode: String(row.branchCode || "").trim().toUpperCase(),
        branchName: String(row.branchName || "").trim(),
        timezone: String(row.timezone || "Asia/Manila").trim() || "Asia/Manila",
        isDefault: Number(row.isDefault || 0) === 1,
      }));
      return res.json({ ok: true, branches: rows });
    } catch (e) {
      console.error("[public/branches]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.get("/api/provider/install-info", (req, res) => {
    try {
      const st = refreshActivationState();
      const license = getLicenseValidationState();
      const installId = String(st.installId || getDbSetting("install.id") || "").trim();
      const expiresAt = Number(st.licenseExpiresAt || 0) || null;
      const daysRemaining = expiresAt ? Math.floor((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)) : null;
      const branch = getRequestBranch(req);
      return res.json({
        ok: true,
        status: String(st.status || ACTIVATION_STATUS_UNACTIVATED).toUpperCase(),
        installId,
        branchCode: getRequestBranchCode(req),
        branchName: getRequestBranchName(req),
        branchId: String(branch?.branchId || ""),
        activatedAt: st.activatedAt || null,
        activatedBy: st.activatedBy || null,
        activationLicenseId: st.activationLicenseId || null,
        licenseIssuedAt: Number(st.licenseIssuedAt || 0) || null,
        licenseExpiresAt: expiresAt,
        daysRemaining,
        validationStatus: license.validationStatus,
        validationSource: license.validationSource || null,
        lastValidatedAt: license.lastValidatedAt,
        lastValidationAttemptAt: license.lastValidationAttemptAt,
        validationError: license.validationError || null,
        graceUntil: license.graceUntil,
        providerAccountId: license.providerAccountId || null,
        providerOrgId: license.providerOrgId || null,
        providerLicenseId: license.providerLicenseId || null,
        licensePlanCode: license.licensePlanCode || null,
        licenseKeyConfigured: !!license.licenseKey,
        licenseKeyMasked: maskLicenseKey(license.licenseKey),
        providerValidateUrl: getStoredLicenseValidateUrl() || null,
        licenseFeatures: license.licenseFeatures,
        branches: listAllBranches(),
        activationPublicKeyLoaded: !!getActivationVerifier(baseDir),
        activationEnforced: isActivationEnforced(),
      });
    } catch (e) {
      console.error("[provider/install-info]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/provider/license/config", rateLimitAuthLogin, express.json(), (req, res) => {
    try {
      const licenseKey = String(req.body?.licenseKey || "").trim();
      const providerValidateUrl = String(req.body?.providerValidateUrl || "").trim();
      const now = Date.now();
      db.prepare(
        `UPDATE installation_state
         SET licenseKey=?, updatedAt=?
         WHERE id=1`
      ).run(licenseKey, now);
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, "providerValidateUrl")) {
        setStoredLicenseValidateUrl(providerValidateUrl);
      }
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "PROVIDER_LICENSE_CONFIG_SAVED",
        JSON.stringify({
          actor: actorFromReq(req),
          licenseKeyMasked: maskLicenseKey(licenseKey),
          providerValidateUrl,
        }),
        now
      );
      return res.json({
        ok: true,
        licenseKeyConfigured: !!licenseKey,
        licenseKeyMasked: maskLicenseKey(licenseKey),
        providerValidateUrl: getStoredLicenseValidateUrl() || null,
      });
    } catch (e) {
      console.error("[provider/license/config]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/provider/license/validate", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      const result = await validateLicenseWithProvider({
        licenseKey: req.body?.licenseKey,
        validateUrl: req.body?.providerValidateUrl,
        requestType: "VALIDATE",
      });
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "PROVIDER_LICENSE_VALIDATED",
        JSON.stringify({
          actor: actorFromReq(req),
          licenseKeyMasked: maskLicenseKey(String(req.body?.licenseKey || getActivationState().licenseKey || "")),
          providerUrl: result.providerUrl,
          status: result.status,
          branchCount: Array.isArray(result.branches) ? result.branches.length : 0,
        }),
        Date.now()
      );
      return res.json(result);
    } catch (e) {
      if (e && typeof e.http === "number") {
        return res.status(e.http).json({ ok: false, error: e.message || "License validation failed." });
      }
      console.error("[provider/license/validate]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/provider/activate", rateLimitAuthLogin, express.json(), (req, res) => {
    try {
      const st = refreshActivationState();
      const currentStatus = String(st.status || "").toUpperCase();
      if (currentStatus === ACTIVATION_STATUS_ACTIVATED) {
        return res.status(409).json({ ok: false, error: "Installation is already activated. Use renewal instead." });
      }
      if (currentStatus === ACTIVATION_STATUS_EXPIRED) {
        return res.status(409).json({ ok: false, error: "Installation is expired. Use renewal instead." });
      }

      const token = String(req.body?.token || "").trim();
      if (!token) return res.status(400).json({ ok: false, error: "token is required." });

      const installId = String(st.installId || getDbSetting("install.id") || "").trim();
      const verified = verifyActivationToken(token, { baseDir, expectedInstallId: installId });
      const payload = verified.payload;
      const now = Date.now();
      const nextBranchCode = String(payload.branchCode || "").trim().toUpperCase();
      const nextBranchName = String(payload.branchName || "").trim() || `${nextBranchCode} Branch`;

      db.transaction(() => {
        db.prepare(
          `UPDATE branch_config SET branchCode=?, branchName=?, updatedAt=? WHERE id=1`
        ).run(nextBranchCode, nextBranchName, now);

        db.prepare(
          `UPDATE installation_state
           SET status=?, installId=?, activatedAt=?, activatedBy=?, activationLicenseId=?, licenseIssuedAt=?,
               licenseExpiresAt=?, lastRenewedAt=?, activationBranchCode=?, activationTokenHash=?, activationPayload=?, updatedAt=?
           WHERE id=1`
        ).run(
          ACTIVATION_STATUS_ACTIVATED,
          installId,
          now,
          String(payload.issuer || "provider").trim() || "provider",
          String(payload.licenseId || "").trim(),
          Number(payload.issuedAt || 0),
          Number(payload.expiresAt || 0),
          now,
          nextBranchCode,
          verified.tokenHash,
          JSON.stringify(payload),
          now
        );
        db.prepare(
          `INSERT INTO activation_token_usage(tokenHash, installId, branchCode, licenseId, issuer, action, consumedAt)
           VALUES(?,?,?,?,?,?,?)`
        ).run(
          verified.tokenHash,
          installId,
          nextBranchCode,
          String(payload.licenseId || "").trim(),
          String(payload.issuer || "provider").trim() || "provider",
          "ACTIVATE",
          now
        );
        bootstrapDefaultOrganizationAndBranch(db);
        const activatedBranch = getBranchByCode(nextBranchCode);
        if (activatedBranch?.branchId) {
          setBranchLicenseState(activatedBranch.branchId, {
            status: ACTIVATION_STATUS_ACTIVATED,
            licenseId: String(payload.licenseId || "").trim(),
            issuedAt: Number(payload.issuedAt || 0),
            expiresAt: Number(payload.expiresAt || 0),
            activatedAt: now,
            activatedBy: String(payload.issuer || "provider").trim() || "provider",
          });
        }
      })();

      return res.json({
        ok: true,
        status: ACTIVATION_STATUS_ACTIVATED,
        installId,
        branchCode: nextBranchCode,
        branchName: nextBranchName,
        activatedAt: now,
        licenseIssuedAt: Number(payload.issuedAt || 0),
        licenseExpiresAt: Number(payload.expiresAt || 0),
      });
    } catch (e) {
      if (e && typeof e.http === "number") {
        return res.status(e.http).json({ ok: false, error: e.message || "Activation failed." });
      }
      console.error("[provider/activate]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/provider/renew", rateLimitAuthLogin, express.json(), (req, res) => {
    try {
      const st = refreshActivationState();
      const currentStatus = String(st.status || "").toUpperCase();
      if (![ACTIVATION_STATUS_ACTIVATED, ACTIVATION_STATUS_EXPIRED].includes(currentStatus)) {
        return res.status(409).json({ ok: false, error: "Installation is not yet activated. Use initial activation first." });
      }

      const token = String(req.body?.token || "").trim();
      if (!token) return res.status(400).json({ ok: false, error: "token is required." });

      const installId = String(st.installId || getDbSetting("install.id") || "").trim();
      const verified = verifyActivationToken(token, { baseDir, expectedInstallId: installId });
      const payload = verified.payload;
      const renewalCode = String(payload.branchCode || "").trim().toUpperCase();
      const currentCode = String(getBranchCode() || "").trim().toUpperCase();
      if (!currentCode || isReservedBranchCode(currentCode)) {
        return res.status(409).json({ ok: false, error: "Current branch is not valid for renewal. Use initial activation." });
      }
      if (renewalCode !== currentCode) {
        return res.status(400).json({ ok: false, error: `Renewal token branchCode mismatch. Expected '${currentCode}', got '${renewalCode}'.` });
      }

      const now = Date.now();
      db.prepare(
        `UPDATE installation_state
         SET status=?, installId=?, activatedBy=?, activationLicenseId=?, licenseIssuedAt=?, licenseExpiresAt=?,
             lastRenewedAt=?, activationBranchCode=?, activationTokenHash=?, activationPayload=?, updatedAt=?
         WHERE id=1`
      ).run(
        ACTIVATION_STATUS_ACTIVATED,
        installId,
        String(payload.issuer || "provider").trim() || "provider",
        String(payload.licenseId || "").trim(),
        Number(payload.issuedAt || 0),
        Number(payload.expiresAt || 0),
        now,
        currentCode,
        verified.tokenHash,
        JSON.stringify(payload),
        now
      );
      db.prepare(
        `INSERT INTO activation_token_usage(tokenHash, installId, branchCode, licenseId, issuer, action, consumedAt)
         VALUES(?,?,?,?,?,?,?)`
      ).run(
        verified.tokenHash,
        installId,
        currentCode,
        String(payload.licenseId || "").trim(),
        String(payload.issuer || "provider").trim() || "provider",
        "RENEW",
        now
      );
      const renewedBranch = getBranchByCode(currentCode);
      if (renewedBranch?.branchId) {
        setBranchLicenseState(renewedBranch.branchId, {
          status: ACTIVATION_STATUS_ACTIVATED,
          licenseId: String(payload.licenseId || "").trim(),
          issuedAt: Number(payload.issuedAt || 0),
          expiresAt: Number(payload.expiresAt || 0),
          activatedAt: now,
          activatedBy: String(payload.issuer || "provider").trim() || "provider",
        });
      }

      return res.json({
        ok: true,
        status: ACTIVATION_STATUS_ACTIVATED,
        installId,
        branchCode: currentCode,
        branchName: getBranchName(),
        renewedAt: now,
        licenseIssuedAt: Number(payload.issuedAt || 0),
        licenseExpiresAt: Number(payload.expiresAt || 0),
      });
    } catch (e) {
      if (e && typeof e.http === "number") {
        return res.status(e.http).json({ ok: false, error: e.message || "Renewal failed." });
      }
      console.error("[provider/renew]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/provider/branches/activate", rateLimitAuthLogin, express.json(), (req, res) => {
    try {
      return res.json(applyBranchLicenseToken({ token: req.body?.token, action: "BRANCH_ACTIVATE" }));
    } catch (e) {
      if (e && typeof e.http === "number") {
        return res.status(e.http).json({ ok: false, error: e.message || "Branch activation failed." });
      }
      console.error("[provider/branches/activate]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/provider/branches/renew", rateLimitAuthLogin, express.json(), (req, res) => {
    try {
      return res.json(applyBranchLicenseToken({ token: req.body?.token, action: "BRANCH_RENEW" }));
    } catch (e) {
      if (e && typeof e.http === "number") {
        return res.status(e.http).json({ ok: false, error: e.message || "Branch renewal failed." });
      }
      console.error("[provider/branches/renew]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.get("/api/admin/business-date", requireAuth, (req, res) => {
    try {
      const cur = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      res.json({
        ok: true,
        branchId: String(branch?.branchId || ""),
        branchCode: getRequestBranchCode(req),
        branchName: getRequestBranchName(req),
        timezone: getRequestBranchTimezone(req),
        currentBusinessDate: cur,
        todayManila: getTodayManila(),
      });
    } catch (e) {
      console.error("[admin/business-date]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  // Manual Close Day (SECURITY ADDON: permission gate)
  app.post("/api/admin/close-day", requirePerm("DAY_CLOSE"), (req, res) => {
    try {
      const now = Date.now();
      const today = getTodayManila();
      const cur = ensureBusinessDate(db);
      const changed = cur !== today;

      if (changed) {
        setState(db, "currentBusinessDate", today);
        syncDefaultBranchBusinessDate(db, today);
        setState(db, "lastManualCloseDayAt", now);
      } else {
        syncDefaultBranchBusinessDate(db, today);
        setState(db, "lastManualCloseDayAt", now);
      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_CLOSE_DAY",
        JSON.stringify({
          actor: actorFromReq(req),
          previousBusinessDate: cur,
          currentBusinessDate: today,
          changed,
        }),
        now
      );

      emitChanged(app, db, "MANUAL_CLOSE_DAY");

      if (changed) {
        return res.json({
          ok: true,
          message: `Business date set to today: ${today}`,
          currentBusinessDate: today,
        });
      }

      return res.json({
        ok: true,
        message: `Close Day marked for ${today}. New day will start automatically at midnight.`,
        currentBusinessDate: today,
      });
    } catch (e) {
      console.error("[admin/close-day]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- Admin: Branch config ---------- */

  app.get("/api/public/branch", (_, res) => {
    try {
      const row = getBranchConfigSafe();
      res.json({ ok: true, branch: row || null });
    } catch (e) {
      console.error("[public/branch:get]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.get("/api/admin/branch", requireAuth, (req, res) => {
    try {
      const branch = getRequestBranch(req);
      res.json({ ok: true, branch: branch || null });
    } catch (e) {
      console.error("[admin/branch:get]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/branch", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    try {
      const branchName = String(req.body.branchName || "").trim();
      if (!branchName) return res.status(400).json({ ok: false, error: "branchName is required." });

      const branch = getRequestBranch(req);
      if (!branch?.branchId) {
        return res.status(400).json({ ok: false, error: "No active branch context resolved." });
      }
      const currentCode = String(branch.branchCode || "").trim().toUpperCase();

      const requestedCode = String(req.body.branchCode || "").trim().toUpperCase();
      const wantsCodeChange = requestedCode && requestedCode !== currentCode;

      // NOTE: you had isAdminRequest(req) referenced before but not defined in your paste.
      // Keeping behavior: if you need branchCode change gate, implement isAdminRequest elsewhere.
      // For now: preserve existing behavior but avoid crashing.
      function isAdminRequestSafe() {
        const u = getSessionUser(req);
        return u && getRoleId(u) === "ADMIN";
      }

      if (wantsCodeChange) {
        const confirmLoss = req.body.confirmLoss === true || String(req.body.confirmLoss || "").toLowerCase() === "true";
        if (!isAdminRequestSafe()) {
          return res.status(403).json({
            ok: false,
            error:
              "Branch Code change is ADMIN-only. (This can orphan existing tickets because ticket records are keyed by branchCode.)",
          });
        }
        if (!confirmLoss) {
          return res.status(400).json({
            ok: false,
            error:
              "Branch Code change requires confirmLoss=true. WARNING: existing tickets may not appear after changing branchCode.",
          });
        }
      }

      const nextCode = wantsCodeChange ? requestedCode : currentCode;
      const timezone = String(req.body.timezone || branch.timezone || "Asia/Manila").trim() || "Asia/Manila";

      const now = Date.now();
      const duplicate = db.prepare(
        `SELECT branchId FROM branches WHERE upper(branchCode)=? AND branchId<>? LIMIT 1`
      ).get(nextCode, branch.branchId);
      if (duplicate?.branchId) {
        return res.status(409).json({ ok: false, error: "Branch code is already in use." });
      }

      const updated = db.prepare(
        `UPDATE branches
         SET branchCode=?, branchName=?, timezone=?, updatedAt=?
         WHERE branchId=?`
      ).run(nextCode, branchName, timezone, now, branch.branchId);
      if (!updated || updated.changes === 0) {
        return res.status(500).json({ ok: false, error: "Branch update failed." });
      }

      if (Number(branch.isDefault || 0) === 1 || currentCode === String(getBranchCode() || "").trim().toUpperCase()) {
        const existing = db.prepare(`SELECT id FROM branch_config WHERE id=1`).get();
        if (!existing) {
          db.prepare(
            `INSERT INTO branch_config(id, branchCode, branchName, timezone, createdAt, updatedAt)
             VALUES(1, ?, ?, ?, ?, ?)`
          ).run(nextCode, branchName, timezone, now, now);
        } else {
          db.prepare(
            `UPDATE branch_config SET branchCode=?, branchName=?, timezone=?, updatedAt=? WHERE id=1`
          ).run(nextCode, branchName, timezone, now);
        }
      }

      bootstrapDefaultOrganizationAndBranch(db);
      req.qsysBranch = getBranchById(branch.branchId) || getBranchByCode(nextCode) || req.qsysBranch;

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_BRANCH_UPDATE",
        JSON.stringify({
          actor: actorFromReq(req),
          branchId: branch.branchId,
          prevBranchCode: currentCode,
          branchCode: nextCode,
          branchName,
          timezone,
          codeChanged: wantsCodeChange,
        }),
        now
      );

      emitChanged(app, db, "ADMIN_BRANCH_UPDATE", { branchCode: nextCode });

      res.json({ ok: true, branch: getRequestBranch(req) || getBranchByCode(nextCode) || null, branchCode: nextCode, branchName, timezone });
    } catch (e) {
      console.error("[admin/branch:post]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

    // ---- app_settings helpers (used by media source folder) ----
function getAppSetting(key) {
  try {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key=? LIMIT 1`).get(String(key));
    return row ? String(row.value || "") : "";
  } catch {
    return "";
  }
}

function getBranchSetting(branchId, key) {
  const bid = String(branchId || "").trim();
  const normalizedKey = String(key || "").trim();
  if (!bid || !normalizedKey) return "";
  try {
    const row = db.prepare(`SELECT value FROM branch_settings WHERE branchId=? AND key=? LIMIT 1`).get(bid, normalizedKey);
    return row ? String(row.value || "") : "";
  } catch {
    return "";
  }
}

function setBranchSetting(branchId, key, value) {
  const bid = String(branchId || "").trim();
  const normalizedKey = String(key || "").trim();
  if (!bid || !normalizedKey) return;
  const now = Date.now();
  db.prepare(
    `INSERT INTO branch_settings(branchId, key, value, updatedAt)
     VALUES(?,?,?,?)
     ON CONFLICT(branchId, key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
  ).run(bid, normalizedKey, String(value || ""), now);
}

function getResolvedDisplaySettings(branch) {
  const branchId = String(branch?.branchId || "").trim();
  const showVideoRaw = branchId
    ? getBranchSetting(branchId, "display.showVideo") || getAppSetting("display.showVideo")
    : getAppSetting("display.showVideo");
  const orientationRaw = branchId
    ? getBranchSetting(branchId, "display.orientation") || getAppSetting("display.orientation")
    : getAppSetting("display.orientation");
  const mediaSourceDirRaw = branchId
    ? getBranchSetting(branchId, "media.sourceDir") || getAppSetting("media.sourceDir")
    : getAppSetting("media.sourceDir");
  const mediaSourceFileRaw = branchId
    ? getBranchSetting(branchId, "media.sourceFile") || getAppSetting("media.sourceFile")
    : getAppSetting("media.sourceFile");

  return {
    "display.showVideo": String(showVideoRaw || "false").trim().toLowerCase() === "true" ? "true" : "false",
    "display.orientation": String(orientationRaw || "landscape").trim().toLowerCase() === "portrait" ? "portrait" : "landscape",
    "media.sourceDir": String(mediaSourceDirRaw || "").trim(),
    "media.sourceFile": String(mediaSourceFileRaw || "").trim(),
  };
}

function saveBranchDisplaySettings(branch, updates = {}) {
  const branchId = String(branch?.branchId || "").trim();
  if (!branchId) return false;
  if (Object.prototype.hasOwnProperty.call(updates, "display.showVideo")) {
    setBranchSetting(
      branchId,
      "display.showVideo",
      String(updates["display.showVideo"]).trim().toLowerCase() === "true" ? "true" : "false"
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, "display.orientation")) {
    setBranchSetting(
      branchId,
      "display.orientation",
      String(updates["display.orientation"]).trim().toLowerCase() === "portrait" ? "portrait" : "landscape"
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, "media.sourceDir")) {
    setBranchSetting(branchId, "media.sourceDir", String(updates["media.sourceDir"] || "").trim());
  }
  if (Object.prototype.hasOwnProperty.call(updates, "media.sourceFile")) {
    setBranchSetting(branchId, "media.sourceFile", String(updates["media.sourceFile"] || "").trim());
  }
  return true;
}

const DISPLAY_PAIR_CODES_KEY = "display.pairCodes";
const DISPLAY_PAIRED_DEVICES_KEY = "display.pairedDevices";
const DISPLAY_LAST_PAIR_CODE_KEY = "display.lastPairCode";

function hashDisplayToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function safeJsonArray(raw) {
  try {
    const v = JSON.parse(String(raw || "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function getDisplayPairCodes() {
  return safeJsonArray(getAppSetting(DISPLAY_PAIR_CODES_KEY))
    .filter((x) => x && typeof x === "object")
    .filter((x) => !x.usedAt);
}

function saveDisplayPairCodes(list) {
  const clean = (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === "object")
    .filter((x) => !x.usedAt)
    .slice(-100);
  setAppSetting(DISPLAY_PAIR_CODES_KEY, JSON.stringify(clean));
}

function getPairedDisplayDevices() {
  return safeJsonArray(getAppSetting(DISPLAY_PAIRED_DEVICES_KEY))
    .filter((x) => x && typeof x === "object")
    .slice(-300);
}

function savePairedDisplayDevices(list) {
  const clean = (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === "object")
    .slice(-300);
  setAppSetting(DISPLAY_PAIRED_DEVICES_KEY, JSON.stringify(clean));
}

function getReqIp(req) {
  return String(
    req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      req.ip ||
      "",
  )
    .split(",")[0]
    .trim();
}

function getCookieValue(req, name) {
  const raw = String(req.headers.cookie || "");
  if (!raw) return "";
  const key = String(name || "").trim();
  if (!key) return "";
  const parts = raw.split(";");
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i <= 0) continue;
    const k = String(p.slice(0, i)).trim();
    if (k !== key) continue;
    const v = String(p.slice(i + 1)).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

function setDisplayAuthCookie(res, token) {
  const v = encodeURIComponent(String(token || "").trim());
  if (!v) return;
  res.append(
    "Set-Cookie",
    `qsys_display_token=${v}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function extractDisplayToken(req) {
  return (
    String(req.headers["x-display-token"] || "").trim() ||
    String(getCookieValue(req, "qsys_display_token") || "").trim()
  );
}

function touchDisplayDevice(deviceId, patch) {
  try {
    if (!deviceId) return;
    const now = Date.now();
    const list = getPairedDisplayDevices();
    const idx = list.findIndex((d) => String(d.id || "") === String(deviceId));
    if (idx < 0) return;
    const prev = list[idx] || {};
    const prevSeen = Number(prev.lastSeenAt || 0);
    if (now - prevSeen < 60 * 1000) return;
    list[idx] = { ...prev, ...patch, lastSeenAt: now };
    savePairedDisplayDevices(list);
  } catch {}
}

function requireDisplayAuth(req, res, next) {
  const requestedBranchCode = String(
    req?.params?.branchCode || req?.query?.branchCode || ""
  ).trim().toUpperCase();
  const canUseBranchSelectedFallback = req.method === "GET" && !!requestedBranchCode;

  const token = extractDisplayToken(req);
  if (token) {
    const tokenHash = hashDisplayToken(token);
    const list = getPairedDisplayDevices();
    const device = list.find((d) => !d.revokedAt && String(d.tokenHash || "") === tokenHash);
    if (device) {
      const pairedBranchCode = String(device.branchCode || "").trim();
      if (pairedBranchCode && requestedBranchCode && pairedBranchCode !== requestedBranchCode) {
        if (!canUseBranchSelectedFallback) {
          return res.status(401).json({
            ok: false,
            error: "Display token belongs to a different branch. Re-pair this screen.",
          });
        }
      } else {
        if (pairedBranchCode) {
          const pairedBranch = getBranchByCode(pairedBranchCode);
          if (!pairedBranch) {
            return res.status(401).json({
              ok: false,
              error: "Display token is linked to an unknown branch. Re-pair this screen.",
            });
          }
          req.qsysBranch = pairedBranch;
        }
        req.displayToken = token;
        req.displayDevice = device;
        setDisplayAuthCookie(res, token);
        touchDisplayDevice(device.id, { lastIp: getReqIp(req) });
        return requireOperationalBranch(req, res, next);
      }
    }
  }

  // Legacy fallback if DISPLAY_KEY still exists in environment.
  const expected = String(process.env.DISPLAY_KEY || "").trim();
  if (expected) {
    const got = String(req.headers["x-display-key"] || "").trim();
    if (got && got === expected) return requireOperationalBranch(req, res, next);
  }

  // Branch-selected display mode:
  // for the Electron display agent we now trust the selected branch code
  // and allow read-only display access without pairing.
  if (canUseBranchSelectedFallback) {
    const branch = getBranchByCode(requestedBranchCode);
    if (branch) {
      req.qsysBranch = branch;
      return requireOperationalBranch(req, res, next);
    }
  }

  return res.status(401).json({ ok: false, error: "Display not authorized" });
}

app.get("/api/display/settings", requireDisplayAuth, (req, res) => {
  try {
    const settings = getResolvedDisplaySettings(getRequestBranch(req));

    res.json({
      ok: true,
      settings,
    });
  } catch (e) {
    console.error("[display/settings]", e);
    res.status(500).json({ ok: false });
  }
});

function setAppSetting(key, value) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_settings(key, value, updatedAt)
     VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
  ).run(String(key), String(value || ""), now);
}

app.post("/api/admin/display/pair-code", requirePerm("SETTINGS_MANAGE"), express.json(), (req, res) => {
  try {
    const now = Date.now();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const branch = getRequestBranch(req);
    const list = [{
      code,
      createdAt: now,
      createdBy: actorFromReq(req),
      branchCode: String(branch?.branchCode || "").trim().toUpperCase(),
      branchName: String(branch?.branchName || "").trim(),
    }];
    saveDisplayPairCodes(list);
    setAppSetting(
      DISPLAY_LAST_PAIR_CODE_KEY,
      JSON.stringify({
        code,
        createdAt: now,
        branchCode: String(branch?.branchCode || "").trim().toUpperCase(),
        branchName: String(branch?.branchName || "").trim(),
      }),
    );

    return res.json({
      ok: true,
      code,
      createdAt: now,
      branchCode: String(branch?.branchCode || "").trim().toUpperCase(),
      branchName: String(branch?.branchName || "").trim(),
    });
  } catch (e) {
    console.error("[admin/display/pair-code]", e);
    return res.status(500).json({ ok: false, error: "Failed to create pair code" });
  }
});

app.post("/api/display/pair/complete", rateLimitDisplayPair, express.json(), (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const label = String(req.body?.label || "").trim().slice(0, 80);
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok: false, error: "Invalid pairing code" });
    }

    const now = Date.now();
    const codes = getDisplayPairCodes();
    const idx = codes.findIndex((c) => String(c.code || "") === code);
    if (idx < 0) {
      return res.status(400).json({ ok: false, error: "Pairing code invalid" });
    }
    const pairEntry = codes[idx] || {};
    const requestedBranchCode = String(req.query?.branchCode || req.body?.branchCode || "").trim().toUpperCase();
    const pairedBranchCodeFromCode = String(pairEntry.branchCode || "").trim().toUpperCase();
    if (requestedBranchCode && pairedBranchCodeFromCode && requestedBranchCode !== pairedBranchCodeFromCode) {
      return res.status(400).json({
        ok: false,
        error: `Pairing code belongs to branch ${pairedBranchCodeFromCode}.`,
      });
    }
    codes.splice(idx, 1);
    saveDisplayPairCodes(codes);
    const nextCode = codes.length ? codes[codes.length - 1] : null;
    setAppSetting(
      DISPLAY_LAST_PAIR_CODE_KEY,
      nextCode ? JSON.stringify({
        code: String(nextCode.code || ""),
        createdAt: Number(nextCode.createdAt || Date.now()),
        branchCode: String(nextCode.branchCode || "").trim().toUpperCase(),
        branchName: String(nextCode.branchName || "").trim(),
      }) : "",
    );

    const token = randomBytes(32).toString("hex");
    const tokenHash = hashDisplayToken(token);
    const deviceId = randomUUID();
    const branchCode = pairedBranchCodeFromCode || String(getRequestBranchCode(req) || "").trim().toUpperCase();
    const branchRow = getBranchByCode(branchCode);
    const branchName = String(pairEntry.branchName || branchRow?.branchName || "").trim();

    const devices = getPairedDisplayDevices();
    devices.push({
      id: deviceId,
      label:
        label ||
        `Display ${new Date(now).toISOString().slice(0, 19).replace("T", " ")}`,
      tokenHash,
      createdAt: now,
      lastSeenAt: now,
      lastIp: getReqIp(req),
      branchCode,
      branchName,
    });
    savePairedDisplayDevices(devices);
    setDisplayAuthCookie(res, token);

    return res.json({
      ok: true,
      token,
      deviceId,
      branchCode,
      branchName,
    });
  } catch (e) {
    console.error("[display/pair/complete]", e);
    return res.status(500).json({ ok: false, error: "Display pairing failed" });
  }
});

app.get("/api/admin/display/devices", requirePerm("SETTINGS_MANAGE"), (_req, res) => {
  try {
    const devices = getPairedDisplayDevices().map((d) => ({
      id: String(d.id || ""),
      label: String(d.label || ""),
      createdAt: Number(d.createdAt || 0),
      lastSeenAt: Number(d.lastSeenAt || 0),
      lastIp: String(d.lastIp || ""),
      branchCode: String(d.branchCode || ""),
      branchName: String(d.branchName || ""),
      revokedAt: Number(d.revokedAt || 0) || 0,
    }));

    const lastPairRaw = String(getAppSetting(DISPLAY_LAST_PAIR_CODE_KEY) || "").trim();
    let lastPairCode = null;
    try {
      const tmp = JSON.parse(lastPairRaw || "{}");
      if (tmp && String(tmp.code || "").trim()) {
        lastPairCode = {
          code: String(tmp.code || ""),
          createdAt: Number(tmp.createdAt || 0),
          branchCode: String(tmp.branchCode || "").trim().toUpperCase(),
          branchName: String(tmp.branchName || "").trim(),
        };
      }
    } catch {}

    return res.json({ ok: true, devices, lastPairCode });
  } catch (e) {
    console.error("[admin/display/devices]", e);
    return res.status(500).json({ ok: false, error: "Failed to load display devices" });
  }
});

app.post(
  "/api/admin/display/devices/revoke",
  requirePerm("SETTINGS_MANAGE"),
  express.json(),
  (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || "").trim();
      if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId is required" });

      const now = Date.now();
      const devices = getPairedDisplayDevices();
      const idx = devices.findIndex((d) => String(d.id || "") === deviceId);
      if (idx < 0) return res.status(404).json({ ok: false, error: "Device not found" });

      devices[idx] = { ...devices[idx], revokedAt: now };
      savePairedDisplayDevices(devices);
      return res.json({ ok: true });
    } catch (e) {
      console.error("[admin/display/devices/revoke]", e);
      return res.status(500).json({ ok: false, error: "Failed to revoke display device" });
    }
  },
);

app.post("/api/admin/display/devices/revoke-all", requirePerm("SETTINGS_MANAGE"), (_req, res) => {
  try {
    const now = Date.now();
    const devices = getPairedDisplayDevices().map((d) => ({ ...d, revokedAt: now }));
    savePairedDisplayDevices(devices);
    saveDisplayPairCodes([]);
    setAppSetting(DISPLAY_LAST_PAIR_CODE_KEY, "");
    return res.json({ ok: true, revoked: devices.length });
  } catch (e) {
    console.error("[admin/display/devices/revoke-all]", e);
    return res.status(500).json({ ok: false, error: "Failed to revoke display devices" });
  }
});

app.get("/api/super-admin/console", requireSuperAdminApi, (_req, res) => {
  try {
    return res.json({ ok: true, ...buildSuperAdminConsolePayload() });
  } catch (e) {
    console.error("[super-admin/console:get]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.get("/api/super-admin/backups", requireSuperAdminApi, (_req, res) => {
  try {
    return res.json({ ok: true, ...getBackupManagementPayload({ limit: 50 }) });
  } catch (e) {
    console.error("[super-admin/backups:get]", e);
    return res.status(500).json({ ok: false, error: "Failed to load backup status." });
  }
});

app.get("/api/super-admin/backups/download", requireSuperAdminApi, (req, res) => {
  try {
    const file = getBackupFileByName(req.query?.name);
    if (!file?.full) return res.status(404).json({ ok: false, error: "Backup file not found." });
    return res.download(file.full, file.name);
  } catch (e) {
    console.error("[super-admin/backups/download]", e);
    return res.status(500).json({ ok: false, error: "Failed to download backup." });
  }
});

app.post("/api/super-admin/backups/config", requireSuperAdminApi, express.json(), (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const intervalHours = Math.max(1, Math.min(24 * 30, Number(req.body?.intervalHours) || 24));
    const retentionCount = Math.max(1, Math.min(100, Number(req.body?.retentionCount) || 14));
    setAppSetting("ops.autoBackup.enabled", enabled ? "1" : "0");
    setAppSetting("ops.autoBackup.intervalHours", String(intervalHours));
    setAppSetting("ops.autoBackup.retentionCount", String(retentionCount));
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "SUPER_ADMIN_BACKUP_CONFIG",
      JSON.stringify({ actor: actorFromReq(req), enabled, intervalHours, retentionCount }),
      Date.now()
    );
    return res.json({ ok: true, ...getBackupManagementPayload({ limit: 50 }) });
  } catch (e) {
    console.error("[super-admin/backups/config]", e);
    return res.status(500).json({ ok: false, error: "Failed to save backup settings." });
  }
});

app.post("/api/super-admin/backups/run", requireSuperAdminApi, (_req, res) => {
  try {
    const result = maybeRunAutoBackup("manual");
    return res.json({ ok: true, result, ...getBackupManagementPayload({ limit: 50 }) });
  } catch (e) {
    console.error("[super-admin/backups/run]", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e || "Backup failed.") });
  }
});

app.post("/api/super-admin/backups/restore-latest", requireSuperAdminApi, express.json(), (req, res) => {
  try {
    const confirmText = String(req.body?.confirmText || "").trim().toUpperCase();
    if (confirmText !== "RESTORE") {
      return res.status(400).json({ ok: false, error: "Type RESTORE to confirm." });
    }
    const result = restoreLatestBackup({ actor: actorFromReq(req), auditAction: "SUPER_ADMIN_DB_RESTORE" });
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[super-admin/backups/restore-latest]", e);
    return res.status(Number(e?.http || 500)).json({ ok: false, error: String(e?.message || "Restore failed.") });
  }
});

app.post("/api/super-admin/licenses/generate", requireSuperAdminApi, express.json(), (req, res) => {
  try {
    const branchId = String(req.body?.branchId || "").trim();
    const branch = branchId ? getBranchById(branchId) : null;
    if (!branch?.branchId) return res.status(400).json({ ok: false, error: "Valid branchId is required." });
    const issuedAt = Date.now();
    return res.json({
      ok: true,
      draft: {
        branchId: branch.branchId,
        branchCode: branch.branchCode,
        branchName: branch.branchName,
        licenseNumber: generateLicenseNumber(branch.branchCode, issuedAt),
        licenseKey: generateLicenseKey(),
        status: "ISSUED",
        issuedAt,
      },
    });
  } catch (e) {
    console.error("[super-admin/licenses/generate]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/super-admin/licenses", requireSuperAdminApi, express.json(), (req, res) => {
  try {
    const branchId = String(req.body?.branchId || "").trim();
    const branch = branchId ? getBranchById(branchId) : null;
    if (!branch?.branchId) return res.status(400).json({ ok: false, error: "Valid branchId is required." });

    const actor = actorFromReq(req);
    const status = normalizeRegistryLicenseStatus(req.body?.status || "ISSUED");
    const notes = String(req.body?.notes || "").trim();
    const issuedAt = Number(req.body?.issuedAt || Date.now()) || Date.now();
    const expiresAt = Number(req.body?.expiresAt || 0) || null;
    const activatedAt = status === "ACTIVE" ? Date.now() : null;
    const deactivatedAt = ["DISABLED", "REVOKED", "EXPIRED"].includes(status) ? Date.now() : null;
    const existing = findActiveLicenseForBranch(branch.branchId);
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: `Branch '${branch.branchCode}' already has an active or issued license (${existing.licenseNumber}).`,
      });
    }

    const id = randomUUID();
    const licenseNumber = String(req.body?.licenseNumber || generateLicenseNumber(branch.branchCode, issuedAt)).trim();
    const licenseKey = String(req.body?.licenseKey || generateLicenseKey()).trim();
    const now = Date.now();
    db.prepare(
      `INSERT INTO super_admin_licenses(
        id, licenseNumber, licenseKey, branchId, branchCode, branchName, status, issuedAt, activatedAt,
        expiresAt, deactivatedAt, createdAt, updatedAt, createdBy, updatedBy, notes
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      licenseNumber,
      licenseKey,
      branch.branchId,
      branch.branchCode,
      branch.branchName,
      status,
      issuedAt,
      activatedAt,
      expiresAt,
      deactivatedAt,
      now,
      now,
      String(actor?.fullName || "super-admin"),
      String(actor?.fullName || "super-admin"),
      notes || null,
    );
    const record = getSuperAdminLicenseById(id);
    syncBranchLicenseFromRegistryRecord(record, String(actor?.fullName || "super-admin"));
    appendSuperAdminLicenseEvent({
      licenseId: id,
      licenseNumber,
      action: "CREATE",
      fromStatus: "",
      toStatus: status,
      actor,
      note: notes,
      payload: { branchId: branch.branchId, branchCode: branch.branchCode, expiresAt },
    });
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "SUPER_ADMIN_LICENSE_CREATE",
      JSON.stringify({
        actor,
        licenseId: id,
        licenseNumber,
        branchId: branch.branchId,
        branchCode: branch.branchCode,
        status,
        expiresAt,
      }),
      now
    );
    return res.json({ ok: true, license: record, ...buildSuperAdminConsolePayload() });
  } catch (e) {
    console.error("[super-admin/licenses:create]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/super-admin/licenses/status", requireSuperAdminApi, express.json(), (req, res) => {
  try {
    const licenseId = String(req.body?.licenseId || "").trim();
    const nextStatus = normalizeRegistryLicenseStatus(req.body?.status || "");
    const note = String(req.body?.note || "").trim();
    if (!licenseId) return res.status(400).json({ ok: false, error: "licenseId is required." });
    const current = getSuperAdminLicenseById(licenseId);
    if (!current?.id) return res.status(404).json({ ok: false, error: "License not found." });
    if (current.status === nextStatus && !note) {
      return res.status(400).json({ ok: false, error: "No license change to apply." });
    }
    if (["ISSUED", "ACTIVE"].includes(nextStatus)) {
      const conflict = findActiveLicenseForBranch(current.branchId, current.id);
      if (conflict) {
        return res.status(409).json({
          ok: false,
          error: `Branch '${current.branchCode}' already has another active or issued license (${conflict.licenseNumber}).`,
        });
      }
    }
    const actor = actorFromReq(req);
    const now = Date.now();
    const activatedAt = nextStatus === "ACTIVE"
      ? (Number(current.activatedAt || 0) || now)
      : null;
    const deactivatedAt = ["DISABLED", "REVOKED", "EXPIRED"].includes(nextStatus)
      ? now
      : null;
    db.prepare(
      `UPDATE super_admin_licenses
       SET status=?, activatedAt=?, deactivatedAt=?, updatedAt=?, updatedBy=?, notes=?
       WHERE id=?`
    ).run(
      nextStatus,
      activatedAt,
      deactivatedAt,
      now,
      String(actor?.fullName || "super-admin"),
      note || current.notes || null,
      current.id
    );
    const updated = getSuperAdminLicenseById(current.id);
    syncBranchLicenseFromRegistryRecord(updated, String(actor?.fullName || "super-admin"));
    appendSuperAdminLicenseEvent({
      licenseId: updated.id,
      licenseNumber: updated.licenseNumber,
      action: "STATUS_CHANGE",
      fromStatus: current.status,
      toStatus: nextStatus,
      actor,
      note,
      payload: { previous: current.status, next: nextStatus },
    });
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "SUPER_ADMIN_LICENSE_STATUS_UPDATE",
      JSON.stringify({
        actor,
        licenseId: updated.id,
        licenseNumber: updated.licenseNumber,
        branchCode: updated.branchCode,
        fromStatus: current.status,
        toStatus: nextStatus,
        note,
      }),
      now
    );
    return res.json({ ok: true, license: updated, ...buildSuperAdminConsolePayload() });
  } catch (e) {
    console.error("[super-admin/licenses/status]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.get("/api/super-admin/features", requireSuperAdminApi, (_req, res) => {
  try {
    const features = SUPER_ADMIN_FEATURE_CATALOG.map((item) => ({
      ...item,
      enabled: isFeatureProvisioned(item.key),
    }));
    res.json({ ok: true, features });
  } catch (e) {
    console.error("[super-admin/features:get]", e);
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/super-admin/features", requireSuperAdminApi, express.json(), (req, res) => {
  try {
    const featureMap = req.body?.features;
    if (!featureMap || typeof featureMap !== "object") {
      return res.status(400).json({ ok: false, error: "features object is required." });
    }

    const allowed = new Set(SUPER_ADMIN_FEATURE_CATALOG.map((item) => item.key));
    const now = Date.now();
    const changes = [];
    for (const [key, raw] of Object.entries(featureMap)) {
      if (!allowed.has(key)) continue;
      const enabled = !!raw;
      setFeatureProvisioned(key, enabled);
      changes.push({ key, enabled });
    }
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "SUPER_ADMIN_FEATURES_UPDATE",
      JSON.stringify({ actor: actorFromReq(req), changes }),
      now
    );

    const features = SUPER_ADMIN_FEATURE_CATALOG.map((item) => ({
      ...item,
      enabled: isFeatureProvisioned(item.key),
    }));
    res.json({ ok: true, features });
  } catch (e) {
    console.error("[super-admin/features:post]", e);
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

  /* ---------- Admin: Settings (key/value) ---------- */

  app.get("/api/admin/settings", requirePerm("SETTINGS_MANAGE"), (_, res) => {
    try {
      const rows = db.prepare(`SELECT key, value, updatedAt FROM app_settings`).all();
      const map = {};
      rows.forEach((r) => (map[r.key] = r.value));
      res.json({ ok: true, settings: map });
    } catch (e) {
      console.error("[admin/settings:get]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.get("/api/admin/display-config", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    try {
      const branch = getRequestBranch(req);
      if (!branch?.branchId) return res.status(400).json({ ok: false, error: "No active branch context resolved." });
      return res.json({ ok: true, branch, settings: getResolvedDisplaySettings(branch), mediaSource: getDisplayMediaSourceSummary(branch) });
    } catch (e) {
      console.error("[admin/display-config:get]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/display-config", requirePerm("SETTINGS_MANAGE"), express.json(), (req, res) => {
    try {
      const branch = getRequestBranch(req);
      if (!branch?.branchId) return res.status(400).json({ ok: false, error: "No active branch context resolved." });
      const payload = req.body && typeof req.body === "object" ? req.body : {};
      saveBranchDisplaySettings(branch, payload);
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_DISPLAY_CONFIG_UPDATE",
        JSON.stringify({ actor: actorFromReq(req), branchCode: String(branch.branchCode || ""), keys: Object.keys(payload || {}) }),
        Date.now()
      );
      emitChanged(app, db, "ADMIN_DISPLAY_CONFIG_UPDATE", { branchCode: String(branch.branchCode || "") });
      return res.json({ ok: true, branch, settings: getResolvedDisplaySettings(branch), mediaSource: getDisplayMediaSourceSummary(branch) });
    } catch (e) {
      console.error("[admin/display-config:post]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.get("/api/public/display-config", (req, res) => {
    try {
      const branchCode = String(req.query?.branchCode || "").trim().toUpperCase();
      const branch = branchCode ? getBranchByCode(branchCode) : getRequestBranch(req);
      if (!branch?.branchId) return res.status(404).json({ ok: false, error: "Branch not found." });
      return res.json({ ok: true, branch, settings: getResolvedDisplaySettings(branch), mediaSource: getDisplayMediaSourceSummary(branch) });
    } catch (e) {
      console.error("[public/display-config:get]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/public/display-config", express.json(), (req, res) => {
    try {
      const branchCode = String(req.body?.branchCode || req.query?.branchCode || "").trim().toUpperCase();
      const branch = branchCode ? getBranchByCode(branchCode) : null;
      if (!branch?.branchId) return res.status(404).json({ ok: false, error: "Branch not found." });
      const payload = req.body && typeof req.body === "object" ? req.body : {};
      saveBranchDisplaySettings(branch, payload);
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "PUBLIC_DISPLAY_CONFIG_UPDATE",
        JSON.stringify({ actor: actorFromReq(req), branchCode, keys: Object.keys(payload || {}) }),
        Date.now()
      );
      emitChanged(app, db, "PUBLIC_DISPLAY_CONFIG_UPDATE", { branchCode });
      return res.json({ ok: true, branch, settings: getResolvedDisplaySettings(branch), mediaSource: getDisplayMediaSourceSummary(branch) });
    } catch (e) {
      console.error("[public/display-config:post]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

/* ---------- Admin: Media Source Folder ---------- */
// Uses Electron native folder picker (preferred).
// If Electron isn't available (running as plain node), it will return an error.

app.post("/api/admin/media/source/select", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
  try {
    let dialog, BrowserWindow;

    try {
      const electron = require("electron");
      dialog = electron.dialog;
      BrowserWindow = electron.BrowserWindow;
    } catch {
      return res.status(400).json({
        ok: false,
        error: "Folder picker requires Electron (this server is not running in Electron context).",
      });
    }

    if (!dialog) {
      return res.status(400).json({ ok: false, error: "Electron dialog is not available." });
    }

    // Replace your current `const win = ...` block with this:
const win = (() => {
  try {
    const wins = (BrowserWindow && BrowserWindow.getAllWindows) ? BrowserWindow.getAllWindows() : [];
    // Prefer the Admin window as parent (so dialog doesn't fight the Display window)
    const adminWin = wins.find(w => {
      try {
        const url = w.webContents && w.webContents.getURL ? w.webContents.getURL() : "";
        return String(url).includes("/admin") || String(url).includes("admin.html");
      } catch { return false; }
    });
    if (adminWin) return adminWin;

    // Fallbacks
    return (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow()) || wins[0] || null;
  } catch {
    return null;
  }
})();


    // IMPORTANT: don't parent the dialog to the kiosk window,
    // otherwise Windows will focus/minimize/overlay the display.
    const result = await dialog.showOpenDialog({
      title: "Select Media Folder (Videos)",
      properties: ["openDirectory"],
    });


    if (result.canceled) return res.json({ ok: true, canceled: true });

    const folder = String(result.filePaths?.[0] || "").trim();
    if (!folder) return res.status(400).json({ ok: false, error: "No folder selected." });

    // Basic sanity check
    try {
      const st = fs.statSync(folder);
      if (!st.isDirectory()) return res.status(400).json({ ok: false, error: "Selected path is not a folder." });
    } catch {
      return res.status(400).json({ ok: false, error: "Selected folder is not accessible." });
    }

    const branch = getRequestBranch(req);
    if (!saveBranchDisplaySettings(branch, { "media.sourceDir": folder, "media.sourceFile": "" })) {
      return res.status(400).json({ ok: false, error: "No active branch context resolved." });
    }
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_SOURCE_UPDATE",
      JSON.stringify({ actor: actorFromReq(req), branchCode: getRequestBranchCode(req), folder }),
      Date.now()
    );
    emitChanged(app, db, "ADMIN_MEDIA_SOURCE_UPDATE", { branchCode: getRequestBranchCode(req), folder });

    return res.json({ ok: true, folder });
  } catch (e) {
    console.error("[admin/media/source/select]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/media/source/clear", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    const now = Date.now();
    const branch = getRequestBranch(req);
    if (!saveBranchDisplaySettings(branch, { "media.sourceDir": "", "media.sourceFile": "" })) {
      return res.status(400).json({ ok: false, error: "No active branch context resolved." });
    }
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_SOURCE_UPDATE",
      JSON.stringify({ actor: actorFromReq(req), branchCode: getRequestBranchCode(req), folder: "" }),
      now
    );
    emitChanged(app, db, "ADMIN_MEDIA_SOURCE_UPDATE", { branchCode: getRequestBranchCode(req), folder: "" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[admin/media/source/clear]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});


/* ---------- Admin: Google Drive Service Account File ---------- */
app.post("/api/admin/gdrive/service-account/select", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
  try {
    let dialog;
    try {
      const electron = require("electron");
      dialog = electron.dialog;
    } catch {
      return res.status(400).json({
        ok: false,
        error: "File picker requires Electron (this server is not running in Electron context).",
      });
    }

    if (!dialog) return res.status(400).json({ ok: false, error: "Electron dialog is not available." });

    const result = await dialog.showOpenDialog({
      title: "Select Google Service Account JSON",
      properties: ["openFile"],
      filters: [{ name: "JSON Files", extensions: ["json"] }],
    });

    if (result.canceled) return res.json({ ok: true, canceled: true });

    const filePath = String(result.filePaths?.[0] || "").trim();
    if (!filePath) return res.status(400).json({ ok: false, error: "No file selected." });
    if (!fs.existsSync(filePath)) return res.status(400).json({ ok: false, error: "Selected file does not exist." });

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON file." });
    }
    const clientEmail = String(parsed?.client_email || "").trim();
    const privateKey = String(parsed?.private_key || "").trim();
    if (!clientEmail || !privateKey) {
      return res.status(400).json({ ok: false, error: "JSON file is missing client_email/private_key." });
    }

    setAppSetting("gdrive.serviceAccountFile", filePath);
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_GDRIVE_SERVICE_ACCOUNT_FILE_SET",
      JSON.stringify({ actor: actorFromReq(req), filePath }),
      Date.now()
    );
    emitChanged(app, db, "ADMIN_GDRIVE_SERVICE_ACCOUNT_FILE_SET", { filePath });

    return res.json({ ok: true, filePath, clientEmail });
  } catch (e) {
    console.error("[admin/gdrive/service-account/select]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/gdrive/service-account/clear", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    setAppSetting("gdrive.serviceAccountFile", "");
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_GDRIVE_SERVICE_ACCOUNT_FILE_SET",
      JSON.stringify({ actor: actorFromReq(req), filePath: "" }),
      Date.now()
    );
    emitChanged(app, db, "ADMIN_GDRIVE_SERVICE_ACCOUNT_FILE_SET", { filePath: "" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[admin/gdrive/service-account/clear]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/gdrive/oauth/start", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const cfg = resolveDriveConfig(body);
    if (!cfg.oauthClientId || !cfg.oauthClientSecret) {
      return res.status(400).json({ ok: false, error: "OAuth client ID/secret are required." });
    }

    // Persist OAuth config so callback can complete without relying on request-scoped data.
    // Normalize to our callback route to avoid root (/) redirects.
    const redirectUri = /\/api\/admin\/gdrive\/oauth\/callback$/i.test(String(cfg.oauthRedirectUri || ""))
      ? cfg.oauthRedirectUri
      : getDefaultOAuthRedirectUri();
    setAppSetting("gdrive.authMode", "oauth");
    setAppSetting("gdrive.oauthClientId", cfg.oauthClientId);
    setAppSetting("gdrive.oauthClientSecret", cfg.oauthClientSecret);
    setAppSetting("gdrive.oauthRedirectUri", redirectUri);

    const state = `${Date.now()}_${randomUUID()}`;
    setAppSetting("gdrive.oauthState", state);

    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: cfg.oauthClientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/drive",
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();

    return res.json({
      ok: true,
      authUrl,
      redirectUri,
    });
  } catch (e) {
    console.error("[admin/gdrive/oauth/start]", e);
    return res.status(500).json({ ok: false, error: "Failed to start OAuth flow." });
  }
});

app.post("/api/admin/gdrive/oauth-client/select", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
  try {
    let dialog;
    try {
      const electron = require("electron");
      dialog = electron.dialog;
    } catch {
      return res.status(400).json({
        ok: false,
        error: "File picker requires Electron (this server is not running in Electron context).",
      });
    }
    if (!dialog) return res.status(400).json({ ok: false, error: "Electron dialog is not available." });

    const result = await dialog.showOpenDialog({
      title: "Select Google OAuth Client JSON",
      properties: ["openFile"],
      filters: [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (result.canceled) return res.json({ ok: true, canceled: true });

    const filePath = String(result.filePaths?.[0] || "").trim();
    if (!filePath) return res.status(400).json({ ok: false, error: "No file selected." });
    if (!fs.existsSync(filePath)) return res.status(400).json({ ok: false, error: "Selected file does not exist." });

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON file." });
    }

    const oauthObj = (parsed && (parsed.installed || parsed.web)) || null;
    const clientId = String(oauthObj?.client_id || "").trim();
    const clientSecret = String(oauthObj?.client_secret || "").trim();
    const redirects = Array.isArray(oauthObj?.redirect_uris)
      ? oauthObj.redirect_uris.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const preferredRedirect =
      redirects.find((u) => /\/api\/admin\/gdrive\/oauth\/callback$/i.test(u)) ||
      getDefaultOAuthRedirectUri();

    if (!clientId || !clientSecret) {
      return res.status(400).json({ ok: false, error: "JSON does not contain OAuth client_id/client_secret." });
    }

    setAppSetting("gdrive.oauthClientId", clientId);
    setAppSetting("gdrive.oauthClientSecret", clientSecret);
    setAppSetting("gdrive.oauthRedirectUri", preferredRedirect);
    setAppSetting("gdrive.oauthClientFile", filePath);

    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_GDRIVE_OAUTH_CLIENT_SET",
      JSON.stringify({ actor: actorFromReq(req), filePath }),
      Date.now()
    );

    return res.json({
      ok: true,
      filePath,
      clientId,
      clientSecret,
      redirectUri: preferredRedirect || "",
    });
  } catch (e) {
    console.error("[admin/gdrive/oauth-client/select]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/gdrive/oauth-client/clear", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    setAppSetting("gdrive.oauthClientFile", "");
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_GDRIVE_OAUTH_CLIENT_SET",
      JSON.stringify({ actor: actorFromReq(req), filePath: "" }),
      Date.now()
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("[admin/gdrive/oauth-client/clear]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/gdrive/oauth/clear", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    setAppSetting("gdrive.oauthRefreshToken", "");
    setAppSetting("gdrive.oauthState", "");
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_GDRIVE_OAUTH_TOKEN_CLEAR",
      JSON.stringify({ actor: actorFromReq(req) }),
      Date.now()
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("[admin/gdrive/oauth/clear]", e);
    return res.status(500).json({ ok: false, error: "Failed to clear OAuth token." });
  }
});

app.get("/api/admin/gdrive/oauth/callback", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
  try {
    const htmlEsc = (v) =>
      String(v || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();
    const error = String(req.query.error || "").trim();
    if (error) {
      return res.status(400).send(`<html><body><h3>Google OAuth failed</h3><p>${htmlEsc(error)}</p><p>You can close this window.</p></body></html>`);
    }
    if (!code) {
      return res.status(400).send("<html><body><h3>Google OAuth failed</h3><p>Missing authorization code.</p><p>You can close this window.</p></body></html>");
    }

    const savedState = String(getAppSetting("gdrive.oauthState") || "").trim();
    if (!state || !savedState || state !== savedState) {
      return res.status(400).send("<html><body><h3>Google OAuth failed</h3><p>Invalid OAuth state.</p><p>Restart OAuth from Setup and try again.</p></body></html>");
    }

    const cfg = resolveDriveConfig();
    if (!cfg.oauthClientId || !cfg.oauthClientSecret || !cfg.oauthRedirectUri) {
      return res.status(400).send("<html><body><h3>Google OAuth failed</h3><p>OAuth client configuration is missing.</p><p>Save Setup first, then retry.</p></body></html>");
    }

    const form = new URLSearchParams({
      code,
      client_id: cfg.oauthClientId,
      client_secret: cfg.oauthClientSecret,
      redirect_uri: cfg.oauthRedirectUri,
      grant_type: "authorization_code",
    }).toString();

    const tokenResp = await httpsRequestBuffer({
      method: "POST",
      host: "oauth2.googleapis.com",
      path: "/token",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(form),
      },
      body: Buffer.from(form, "utf8"),
    });

    const raw = tokenResp.body.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (tokenResp.status < 200 || tokenResp.status >= 300) {
      const err = parsed.error_description || parsed.error || raw || `HTTP ${tokenResp.status}`;
      return res.status(400).send(`<html><body><h3>Google OAuth failed</h3><p>${htmlEsc(String(err))}</p><p>You can close this window.</p></body></html>`);
    }

    const newRefreshToken = String(parsed.refresh_token || "").trim();
    const existingRefreshToken = String(getAppSetting("gdrive.oauthRefreshToken") || "").trim();
    const refreshTokenToStore = newRefreshToken || existingRefreshToken;
    if (!refreshTokenToStore) {
      return res.status(400).send("<html><body><h3>Google OAuth failed</h3><p>No refresh token returned. Try again with prompt=consent.</p><p>You can close this window.</p></body></html>");
    }

    setAppSetting("gdrive.authMode", "oauth");
    setAppSetting("gdrive.oauthRefreshToken", refreshTokenToStore);
    setAppSetting("gdrive.oauthState", "");

    return res.status(200).send("<html><body><h3>Google OAuth connected</h3><p>Refresh token saved. You can close this window and return to QSys Setup.</p></body></html>");
  } catch (e) {
    console.error("[admin/gdrive/oauth/callback]", e);
    return res.status(500).send("<html><body><h3>Google OAuth failed</h3><p>Server error while processing callback.</p><p>You can close this window.</p></body></html>");
  }
});


  app.post("/api/admin/settings", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    try {
      const updates = req.body && typeof req.body === "object" ? req.body : {};
      const now = Date.now();
      const stmt = db.prepare(
        `INSERT INTO app_settings(key, value, updatedAt)
         VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
      );

      const keys = Object.keys(updates);
      for (const k of keys) {
        stmt.run(String(k), String(updates[k]), now);
      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_SETTINGS_UPDATE",
        JSON.stringify({ actor: actorFromReq(req), keys }),
        now
      );

      emitChanged(app, db, "ADMIN_SETTINGS_UPDATE");
      res.json({ ok: true });
    } catch (e) {
      console.error("[admin/settings:post]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- Admin: Users (PIN) ---------- */

  function normalizeRequestedUserBranchIds(input, fallbackBranchId, roleScope = "") {
    const values = Array.isArray(input) ? input : [];
    const valid = new Set(listAllBranches().map((row) => String(row.branchId || "").trim()).filter(Boolean));
    const unique = [];
    for (const raw of values) {
      const branchId = String(raw || "").trim();
      if (!branchId || !valid.has(branchId) || unique.includes(branchId)) continue;
      unique.push(branchId);
    }
    const normalizedRole = String(roleScope || "").trim().toUpperCase();
    if (roleHasGlobalBranchAccess(normalizedRole)) return [];
    const singleBranchOnly = normalizedRole === "STAFF" || normalizedRole === "SUPERVISOR";
    if (singleBranchOnly && unique.length) return [unique[0]];
    if (singleBranchOnly) return [];
    if (unique.length) return unique;
    const fallback = String(fallbackBranchId || "").trim();
    return fallback ? [fallback] : [String(getOrBootstrapDefaultBranchId(db) || "").trim()].filter(Boolean);
  }

  function replaceUserBranchAccess(dbRef, { userId, branchIds, roleScope }) {
    const id = String(userId || "").trim();
    if (!id) return [];
    const scope = String(roleScope || "STAFF").trim().toUpperCase() || "STAFF";
    const nextBranchIds = normalizeRequestedUserBranchIds(branchIds, null, scope);
    dbRef.prepare(`DELETE FROM user_branch_access WHERE userId=?`).run(id);
    for (const branchId of nextBranchIds) {
      upsertUserBranchAccess(dbRef, { userId: id, branchId, roleScope: scope });
    }
    return nextBranchIds;
  }

  app.get("/api/admin/users", requirePerm("USERS_MANAGE"), (_, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT userId, fullName, roleId, isActive, createdAt, updatedAt, lastLoginAt
         FROM users
         ORDER BY createdAt DESC`
        )
        .all()
        .map((row) => {
          const branchAccess = listUserBranchAccess(row.userId);
          return {
            ...row,
            branchIds: branchAccess.map((item) => String(item.branchId || "").trim()).filter(Boolean),
            branchAccess,
          };
        });
      res.json({ ok: true, users: rows, branches: listAllBranches() });
    } catch (e) {
      console.error("[admin/users:get]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/users/create", requirePerm("USERS_MANAGE"), (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const roleId = String(req.body.roleId || "STAFF").toUpperCase().trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName) return res.status(400).json({ ok: false, error: "Name is required." });
      if (!["STAFF", "SUPERVISOR", "ADMIN"].includes(roleId))
        return res.status(400).json({ ok: false, error: "Invalid roleId." });
      if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok: false, error: "PIN must be 6 digits." });
      if (db.prepare(`SELECT userId FROM users WHERE lower(fullName)=lower(?) LIMIT 1`).get(fullName)) {
        return res.status(409).json({ ok: false, error: "A user with this full name already exists. Use a unique full name." });
      }

      const userId = randomUUID();
      const pinHash = bcrypt.hashSync(pin, 10);
      const now = Date.now();
      const fallbackBranchId = String(getRequestBranch(req)?.branchId || getOrBootstrapDefaultBranchId(db) || "").trim();
      const branchIds = normalizeRequestedUserBranchIds(req.body.branchIds, fallbackBranchId, roleId);
      if (["STAFF", "SUPERVISOR"].includes(roleId) && branchIds.length !== 1) {
        return res.status(400).json({ ok: false, error: "Staff and supervisor users must be assigned exactly one branch." });
      }

      db.prepare(
        `INSERT INTO users(userId, fullName, pinHash, roleId, isActive, createdAt, updatedAt)
         VALUES(?,?,?,?,1,?,?)`
      ).run(userId, fullName, pinHash, roleId, now, now);
      replaceUserBranchAccess(db, { userId, branchIds, roleScope: roleId });

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_USER_CREATE",
        JSON.stringify({ actor: actorFromReq(req), userId, fullName, roleId, branchIds }),
        now
      );

      res.json({ ok: true, userId, branchIds });
    } catch (e) {
      console.error("[admin/users:create]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/users/update", requirePerm("USERS_MANAGE"), (req, res) => {
    try {
      const userId = String(req.body.userId || "").trim();
      const fullName = String(req.body.fullName || "").trim();
      const roleId = String(req.body.roleId || "").toUpperCase().trim();
      const isActive = req.body.isActive;
      const hasBranchIds = Array.isArray(req.body.branchIds);

      if (!userId) return res.status(400).json({ ok: false, error: "Missing userId." });

      const now = Date.now();
      const existing = db.prepare(`SELECT userId FROM users WHERE userId=?`).get(userId);
      if (!existing) return res.status(404).json({ ok: false, error: "User not found." });

      if (fullName) {
        const duplicate = db.prepare(`SELECT userId FROM users WHERE lower(fullName)=lower(?) AND userId<>? LIMIT 1`).get(fullName, userId);
        if (duplicate?.userId) {
          return res.status(409).json({ ok: false, error: "A user with this full name already exists. Use a unique full name." });
        }
        db.prepare(`UPDATE users SET fullName=?, updatedAt=? WHERE userId=?`).run(fullName, now, userId);
      }
      if (roleId && ["STAFF", "SUPERVISOR", "ADMIN"].includes(roleId)) {
        db.prepare(`UPDATE users SET roleId=?, updatedAt=? WHERE userId=?`).run(roleId, now, userId);
        db.prepare(`UPDATE user_branch_access SET roleScope=? WHERE userId=?`).run(roleId, userId);
        if (roleHasGlobalBranchAccess(roleId) && !hasBranchIds) {
          replaceUserBranchAccess(db, { userId, branchIds: [], roleScope: roleId });
        }
      }
      if (hasBranchIds) {
        const effectiveRoleId = roleId && ["STAFF", "SUPERVISOR", "ADMIN"].includes(roleId)
          ? roleId
          : String(db.prepare(`SELECT roleId FROM users WHERE userId=? LIMIT 1`).get(userId)?.roleId || "STAFF").trim().toUpperCase();
        const normalizedBranchIds = normalizeRequestedUserBranchIds(req.body.branchIds, null, effectiveRoleId);
        if (["STAFF", "SUPERVISOR"].includes(effectiveRoleId) && normalizedBranchIds.length !== 1) {
          return res.status(400).json({ ok: false, error: "Staff and supervisor users must be assigned exactly one branch." });
        }
        replaceUserBranchAccess(db, {
          userId,
          branchIds: req.body.branchIds,
          roleScope: effectiveRoleId,
        });
      }
      if (typeof isActive === "boolean" || isActive === 0 || isActive === 1) {
        db.prepare(`UPDATE users SET isActive=?, updatedAt=? WHERE userId=?`).run(isActive ? 1 : 0, now, userId);
      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_USER_UPDATE",
        JSON.stringify({ actor: actorFromReq(req), userId, fullName, roleId, isActive, branchIds: hasBranchIds ? normalizeRequestedUserBranchIds(req.body.branchIds, null, roleId || String(db.prepare(`SELECT roleId FROM users WHERE userId=? LIMIT 1`).get(userId)?.roleId || "STAFF").trim().toUpperCase()) : undefined }),
        now
      );

      res.json({ ok: true });
    } catch (e) {
      console.error("[admin/users:update]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/users/delete", requirePerm("USERS_MANAGE"), (req, res) => {
    try {
      const userId = String(req.body.userId || "").trim();
      if (!userId) return res.status(400).json({ ok: false, error: "Missing userId." });

      const now = Date.now();
      const existing = db.prepare(`SELECT userId, fullName, roleId FROM users WHERE userId=? LIMIT 1`).get(userId);
      if (!existing) return res.status(404).json({ ok: false, error: "User not found." });

      db.transaction(() => {
        db.prepare(`DELETE FROM user_branch_access WHERE userId=?`).run(userId);
        db.prepare(`DELETE FROM users WHERE userId=?`).run(userId);
      })();

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_USER_DELETE",
        JSON.stringify({ actor: actorFromReq(req), userId, fullName: existing.fullName || "", roleId: existing.roleId || "" }),
        now
      );

      res.json({ ok: true });
    } catch (e) {
      console.error("[admin/users:delete]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/users/reset-pin", requirePerm("USERS_MANAGE"), (req, res) =>  {
    try {
      const userId = String(req.body.userId || "").trim();
      const pin = String(req.body.pin || "").trim();
      if (!userId) return res.status(400).json({ ok: false, error: "Missing userId." });
      if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok: false, error: "PIN must be 6 digits." });

      const now = Date.now();
      const pinHash = bcrypt.hashSync(pin, 10);
      const updated = db.prepare(`UPDATE users SET pinHash=?, updatedAt=? WHERE userId=?`).run(pinHash, now, userId);
      if (!updated.changes) return res.status(404).json({ ok: false, error: "User not found." });

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_USER_RESET_PIN",
        JSON.stringify({ actor: actorFromReq(req), userId }),
        now
      );

      res.json({ ok: true });
    } catch (e) {
      console.error("[admin/users/reset-pin]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- Admin: Permissions matrix (editable) ---------- */

  app.get("/api/admin/permissions", requirePerm("PERMISSIONS_MANAGE"), (_, res) => {
    try {
      const roles = db.prepare(`SELECT roleId, roleName FROM roles ORDER BY roleId`).all();
      const perms = db.prepare(`SELECT permKey, permName, description FROM permissions ORDER BY permKey`).all();
      const rows = db.prepare(`SELECT roleId, permKey, allowed FROM role_permissions`).all();

      const matrix = {};
      for (const r of roles) matrix[r.roleId] = {};
      for (const rp of rows) {
        if (!matrix[rp.roleId]) matrix[rp.roleId] = {};
        matrix[rp.roleId][rp.permKey] = rp.allowed ? 1 : 0;
      }

      res.json({ ok: true, roles, permissions: perms, matrix });
    } catch (e) {
      console.error("[admin/permissions:get]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/permissions", requirePerm("PERMISSIONS_MANAGE"), (req, res) =>  {
    try {
      const matrix = req.body && req.body.matrix ? req.body.matrix : null;
      if (!matrix || typeof matrix !== "object") {
        return res.status(400).json({ ok: false, error: "Missing matrix." });
      }

      const now = Date.now();
      const upsert = db.prepare(
        `INSERT INTO role_permissions(roleId, permKey, allowed, updatedAt)
         VALUES(?,?,?,?)
         ON CONFLICT(roleId, permKey) DO UPDATE SET allowed=excluded.allowed, updatedAt=excluded.updatedAt`
      );

      const roleIds = Object.keys(matrix);
      for (const roleId of roleIds) {
        const permMap = matrix[roleId] || {};
        for (const permKey of Object.keys(permMap)) {
          const allowed = permMap[permKey] ? 1 : 0;
          upsert.run(String(roleId), String(permKey), allowed, now);
        }
      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_PERMISSIONS_UPDATE",
        JSON.stringify({ actor: actorFromReq(req), roles: roleIds }),
        now
      );

      res.json({ ok: true });
    } catch (e) {
      console.error("[admin/permissions:post]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- Admin: Audit list ---------- */

  app.get("/api/admin/audit", requirePerm("AUDIT_VIEW"), (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 100), 500);
      const offset = Math.max(Number(req.query.offset || 0), 0);
      const rows = db
        .prepare(
          `SELECT id, action, payload, createdAt FROM audit_logs
         ORDER BY createdAt DESC
         LIMIT ? OFFSET ?`
        )
        .all(limit, offset);
      res.json({ ok: true, rows, limit, offset });
    } catch (e) {
      console.error("[admin/audit:get]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  function hashLicenseToken(token) {
    return createHash("sha256").update(String(token || "").trim()).digest("hex");
  }

  function decodeActivationPayloadUnsafe(token) {
    try {
      const raw = String(token || "").trim();
      const parts = raw.split(".");
      if (parts.length < 2) return {};
      return JSON.parse(base64UrlDecodeToBuffer(parts[1]).toString("utf8"));
    } catch {
      return {};
    }
  }

  function findActivationTokenRevocation(tokenHash) {
    try {
      return db.prepare(`SELECT * FROM activation_token_revocations WHERE tokenHash=? LIMIT 1`).get(String(tokenHash || ""));
    } catch {
      return null;
    }
  }

  function revokeActivationTokenHash({ tokenHash, installId, branchCode, licenseId, reason, revokedBy, revokedAt }) {
    db.prepare(
      `INSERT INTO activation_token_revocations(tokenHash, installId, branchCode, licenseId, reason, revokedBy, revokedAt)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(tokenHash) DO UPDATE SET
         installId=excluded.installId,
         branchCode=excluded.branchCode,
         licenseId=excluded.licenseId,
         reason=excluded.reason,
         revokedBy=excluded.revokedBy,
         revokedAt=excluded.revokedAt`
    ).run(
      String(tokenHash || "").trim(),
      String(installId || "").trim(),
      String(branchCode || "").trim().toUpperCase(),
      String(licenseId || "").trim(),
      String(reason || "").trim(),
      String(revokedBy || "").trim(),
      Number(revokedAt || Date.now()) || Date.now()
    );
  }

  function listActivationTokenEvents(limit = 12) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
    const usageRows = db.prepare(
      `SELECT 'usage' AS eventType, tokenHash, installId, branchCode, licenseId, issuer, action, consumedAt AS eventAt
       FROM activation_token_usage
       ORDER BY consumedAt DESC
       LIMIT ?`
    ).all(safeLimit);
    const revokedRows = db.prepare(
      `SELECT 'revocation' AS eventType, tokenHash, installId, branchCode, licenseId, revokedBy AS issuer, reason AS action, revokedAt AS eventAt
       FROM activation_token_revocations
       ORDER BY revokedAt DESC
       LIMIT ?`
    ).all(safeLimit);
    return [...usageRows, ...revokedRows]
      .sort((a, b) => Number(b.eventAt || 0) - Number(a.eventAt || 0))
      .slice(0, safeLimit);
  }

  function getLicenseAuditHistory(limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const actions = [
      "INSTALL_ACTIVATED",
      "INSTALL_RENEWED",
      "INSTALL_TRANSFER_RELEASED",
      "INSTALL_TOKEN_REVOKED",
      "SUPER_ADMIN_RECOVERY_RESET",
    ];
    const placeholders = actions.map(() => "?").join(",");
    return db.prepare(
      `SELECT id, action, payload, createdAt
       FROM audit_logs
       WHERE action IN (${placeholders})
       ORDER BY createdAt DESC
       LIMIT ?`
    ).all(...actions, safeLimit);
  }

  function buildLicenseReminder(st) {
    const expiresAt = Number(st?.licenseExpiresAt || 0) || 0;
    if (!expiresAt) return { level: "unknown", daysRemaining: null, message: "No license expiration is recorded." };
    const msRemaining = expiresAt - Date.now();
    const daysRemaining = Math.floor(msRemaining / (24 * 60 * 60 * 1000));
    if (msRemaining < 0) {
      return { level: "expired", daysRemaining, message: `License expired ${Math.abs(daysRemaining)} day(s) ago.` };
    }
    if (daysRemaining <= 7) {
      return { level: "urgent", daysRemaining, message: `License expires in ${daysRemaining} day(s). Renewal is recommended now.` };
    }
    if (daysRemaining <= 30) {
      return { level: "warning", daysRemaining, message: `License expires in ${daysRemaining} day(s).` };
    }
    return { level: "ok", daysRemaining, message: `License valid for ${daysRemaining} more day(s).` };
  }

  function getBackupsDir() {
    return path.join(baseDir, "backups");
  }

  function listBackupFiles() {
    const backupsDir = getBackupsDir();
    if (!fs.existsSync(backupsDir)) return [];
    return fs
      .readdirSync(backupsDir)
      .filter((f) => /^qsys-backup-.*\.db$/i.test(f))
      .map((f) => {
        const full = path.join(backupsDir, f);
        const stat = fs.statSync(full);
        return { name: f, full, mtime: Number(stat.mtimeMs || 0), sizeBytes: Number(stat.size || 0) };
      })
      .sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0));
  }

  function getSupportBundlesDir() {
    return path.join(baseDir, "support-bundles");
  }

  function getAutoBackupConfig() {
    const enabledRaw = String(getAppSetting("ops.autoBackup.enabled") || "").trim();
    return {
      enabled: enabledRaw ? enabledRaw === "1" : true,
      intervalHours: Math.max(1, Math.min(24 * 30, Number(getAppSetting("ops.autoBackup.intervalHours") || 24) || 24)),
      retentionCount: Math.max(1, Math.min(100, Number(getAppSetting("ops.autoBackup.retentionCount") || 14) || 14)),
    };
  }

  function getAutoBackupState() {
    return safeParseJson(getAppSetting("ops.autoBackup.lastResult"), null);
  }

  function saveAutoBackupState(payload) {
    setAppSetting("ops.autoBackup.lastResult", JSON.stringify(payload || {}));
  }

  function getRestoreStateFilePath() {
    return path.join(baseDir, "restore-state.json");
  }

  function getLastRestoreState() {
    try {
      const filePath = getRestoreStateFilePath();
      if (fs.existsSync(filePath)) {
        return safeParseJson(fs.readFileSync(filePath, "utf8"), null);
      }
    } catch {}
    return safeParseJson(getAppSetting("ops.lastRestore"), null);
  }

  function saveLastRestoreState(payload) {
    setAppSetting("ops.lastRestore", JSON.stringify(payload || {}));
    try {
      fs.writeFileSync(getRestoreStateFilePath(), JSON.stringify(payload || {}, null, 2), "utf8");
    } catch {}
  }

  function getIntegrityCheckState() {
    return safeParseJson(getAppSetting("ops.integrityCheck.lastResult"), null);
  }

  function saveIntegrityCheckState(payload) {
    setAppSetting("ops.integrityCheck.lastResult", JSON.stringify(payload || {}));
  }

  function getSelfTestState() {
    return safeParseJson(getAppSetting("ops.selfTest.lastResult"), null);
  }

  function getBackupManagementPayload({ limit = 20 } = {}) {
    const config = getAutoBackupConfig();
    const backups = listBackupFiles();
    const lastResult = getAutoBackupState();
    const lastRestore = getLastRestoreState();
    const latestBackup = backups[0] || null;
    let nextDueAt = null;
    if (config.enabled) {
      const baseTs = Number(lastResult?.lastRunAt || latestBackup?.mtime || 0);
      if (Number.isFinite(baseTs) && baseTs > 0) {
        nextDueAt = baseTs + config.intervalHours * 60 * 60 * 1000;
      }
    }
    return {
      config,
      backupDir: getBackupsDir(),
      backupCount: backups.length,
      latestBackup: latestBackup
        ? {
            name: latestBackup.name,
            mtime: latestBackup.mtime,
            sizeBytes: latestBackup.sizeBytes,
          }
        : null,
      lastResult,
      lastRestore,
      nextDueAt,
      backups: backups.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))).map((file) => ({
        name: file.name,
        mtime: file.mtime,
        sizeBytes: file.sizeBytes,
      })),
    };
  }

  function saveSelfTestState(payload) {
    setAppSetting("ops.selfTest.lastResult", JSON.stringify(payload || {}));
  }

  function pruneBackupFiles({ keepCount, actor = "SYSTEM", trigger = "system" } = {}) {
    const files = listBackupFiles();
    const retentionCount = Math.max(1, Math.min(100, Number(keepCount) || 10));
    const stale = files.slice(retentionCount);
    for (const file of stale) {
      try { fs.unlinkSync(file.full); } catch {}
    }
    if (stale.length) {
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "OPS_AUTO_BACKUP_PRUNE",
        JSON.stringify({ actor, trigger, retentionCount, deleted: stale.map((f) => ({ name: f.name, mtime: f.mtime })) }),
        Date.now()
      );
    }
    return { retentionCount, deletedCount: stale.length };
  }

  let autoBackupInProgress = false;
  function maybeRunAutoBackup(trigger = "timer") {
    if (autoBackupInProgress) return { ok: false, skipped: true, reason: "in_progress" };
    const cfg = getAutoBackupConfig();
    if (!cfg.enabled && trigger !== "manual") return { ok: false, skipped: true, reason: "config_disabled" };

    const last = getAutoBackupState();
    const now = Date.now();
    if (
      trigger !== "manual" &&
      last?.lastRunAt &&
      Number(last.lastRunAt) + cfg.intervalHours * 60 * 60 * 1000 > now
    ) {
      return { ok: false, skipped: true, reason: "not_due", nextDueAt: Number(last.lastRunAt) + cfg.intervalHours * 60 * 60 * 1000 };
    }

    autoBackupInProgress = true;
    try {
      const snap = createInternalDbBackup();
      const cleanup = pruneBackupFiles({ keepCount: cfg.retentionCount, actor: "SYSTEM", trigger });
      const payload = {
        ok: true,
        trigger,
        lastRunAt: now,
        fileName: snap.fileName,
        filePath: snap.filePath,
        sizeBytes: snap.sizeBytes,
        retentionCount: cleanup.retentionCount,
        prunedCount: cleanup.deletedCount,
      };
      saveAutoBackupState(payload);
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "OPS_AUTO_BACKUP_RUN",
        JSON.stringify({ actor: "SYSTEM", ...payload }),
        now
      );
      return payload;
    } catch (e) {
      const payload = { ok: false, trigger, lastRunAt: now, error: String(e?.message || e || "Auto backup failed") };
      saveAutoBackupState(payload);
      throw e;
    } finally {
      autoBackupInProgress = false;
    }
  }

  function runIntegrityCheck(trigger = "manual", actor = "SYSTEM") {
    const checkedAt = Date.now();
    const details = db.prepare("PRAGMA quick_check").all().map((row) => String(row.quick_check || row.integrity_check || Object.values(row || {})[0] || ""));
    const payload = {
      ok: details.length ? details.every((v) => String(v).toLowerCase() === "ok") : true,
      trigger,
      actor,
      checkedAt,
      details,
    };
    saveIntegrityCheckState(payload);
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "OPS_INTEGRITY_CHECK_RUN",
      JSON.stringify(payload),
      checkedAt
    );
    return payload;
  }

  function runStartupSelfTest(trigger = "startup", actor = "SYSTEM") {
    const checkedAt = Date.now();
    const checks = [];
    const addCheck = (key, fn) => {
      try {
        checks.push({ key, status: "PASS", message: String(fn() || "") });
      } catch (e) {
        checks.push({ key, status: "FAIL", message: String(e?.message || e || "Check failed") });
      }
    };
    addCheck("database_access", () => {
      db.prepare("SELECT 1 AS ok").get();
      return "SQLite connection is available.";
    });
    addCheck("business_date", () => `Business date is ${ensureBusinessDate(db)}.`);
    addCheck("activation_verifier", () => getActivationVerifier(baseDir) ? "Activation public key is available." : "Activation public key is not configured.");
    addCheck("backup_dir", () => {
      const dir = getBackupsDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return `Backup directory ready at ${dir}.`;
    });
    const payload = {
      ok: checks.every((check) => check.status === "PASS"),
      trigger,
      actor,
      checkedAt,
      checks,
    };
    saveSelfTestState(payload);
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "OPS_SELF_TEST_RUN",
      JSON.stringify(payload),
      checkedAt
    );
    return payload;
  }

  function getQueueRecoveryRows({ branchCode, businessDate, groupCode, limit = 10 }) {
    const params = [branchCode, businessDate];
    let sql = `
      SELECT id, groupCode, queueNum, name, pax, status, priorityType,
             createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
      FROM queue_items
      WHERE branchCode = ?
        AND businessDate = ?
        AND status IN ('SEATED', 'SKIPPED')
    `;
    if (groupCode) {
      sql += ` AND groupCode = ?`;
      params.push(groupCode);
    }
    sql += `
      ORDER BY COALESCE(seatedAt, skippedAt, calledAt, createdAtLocal) DESC, queueNum DESC
      LIMIT ?
    `;
    params.push(Math.max(1, Math.min(25, Number(limit) || 10)));
    return db.prepare(sql).all(...params);
  }

  function getQueueWaitForecast({ branchCode, businessDate, groupCode }) {
    const avgCalledRow = db.prepare(
      `SELECT AVG(calledAt - createdAtLocal) AS avgMs, COUNT(*) AS sampleCount
       FROM queue_items
       WHERE branchCode = ?
         AND businessDate = ?
         AND groupCode = ?
         AND calledAt IS NOT NULL
         AND createdAtLocal IS NOT NULL
         AND calledAt >= createdAtLocal`
    ).get(branchCode, businessDate, groupCode) || {};
    const avgSeatedRow = db.prepare(
      `SELECT AVG(seatedAt - createdAtLocal) AS avgMs, COUNT(*) AS sampleCount
       FROM queue_items
       WHERE branchCode = ?
         AND businessDate = ?
         AND groupCode = ?
         AND seatedAt IS NOT NULL
         AND createdAtLocal IS NOT NULL
         AND seatedAt >= createdAtLocal`
    ).get(branchCode, businessDate, groupCode) || {};
    const counts = db.prepare(
      `SELECT
         SUM(CASE WHEN status='WAITING' THEN 1 ELSE 0 END) AS waitingCount,
         SUM(CASE WHEN status='CALLED' THEN 1 ELSE 0 END) AS calledCount
       FROM queue_items
       WHERE branchCode = ?
         AND businessDate = ?
         AND groupCode = ?`
    ).get(branchCode, businessDate, groupCode) || {};
    const avgWaitToCalledMinutes = Math.round((Number(avgCalledRow.avgMs || 0) / 60000) || 0);
    const waitingCount = Number(counts.waitingCount || 0);
    return {
      groupCode,
      waitingCount,
      calledCount: Number(counts.calledCount || 0),
      avgWaitToCalledMinutes: avgWaitToCalledMinutes || null,
      avgWaitToSeatedMinutes: Math.round((Number(avgSeatedRow.avgMs || 0) / 60000) || 0) || null,
      calledSampleCount: Number(avgCalledRow.sampleCount || 0),
      seatedSampleCount: Number(avgSeatedRow.sampleCount || 0),
      projectedMinutesForBacklog: avgWaitToCalledMinutes > 0 ? avgWaitToCalledMinutes * waitingCount : null,
    };
  }

  /* ---------- health ---------- */

  app.get("/api/health", (req, res) => {
    const branch = getRequestBranch(req);
    const st = refreshActivationState();
    res.json({
      ok: true,
      branchId: String(branch?.branchId || ""),
      branchCode: getRequestBranchCode(req),
      branchName: getRequestBranchName(req),
      timezone: getRequestBranchTimezone(req),
      port,
      activationStatus: String(st.status || ACTIVATION_STATUS_UNACTIVATED).toUpperCase(),
      activationEnforced: isActivationEnforced(),
      currentBusinessDate: ensureBusinessDate(db),
      todayManila: getTodayManila(),
    });
  });

  app.get("/api/admin/ops/health", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("operations.system_health"), (req, res) => {
    try {
      const st = refreshActivationState();
      const dbPath = path.join(baseDir, "data", "qsys.db");
      const backups = listBackupFiles();
      const supportDir = getSupportBundlesDir();
      const lastAudit = db.prepare(`SELECT action, createdAt FROM audit_logs ORDER BY createdAt DESC LIMIT 1`).get() || null;
      const lastRestore = getLastRestoreState();
      const branch = getRequestBranch(req);
      const branchCode = getRequestBranchCode(req);
      return res.json({
        ok: true,
        branchId: String(branch?.branchId || ""),
        branchCode,
        branchName: getRequestBranchName(req),
        activationStatus: String(st.status || ACTIVATION_STATUS_UNACTIVATED).toUpperCase(),
        licenseExpiresAt: Number(st.licenseExpiresAt || 0) || null,
        currentBusinessDate: ensureBusinessDate(db),
        port,
        dbPath,
        dbSizeBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
        backupCount: backups.length,
        lastBackupAt: backups[0] ? Number(backups[0].mtime || 0) : 0,
        lastRestoreAt: Number(lastRestore?.restoredAt || 0) || 0,
        supportBundleCount: fs.existsSync(supportDir)
          ? fs.readdirSync(supportDir).filter((f) => /^qsys-support-bundle-.*\.json$/i.test(f)).length
          : 0,
        lastAuditAction: lastAudit ? String(lastAudit.action || "") : "",
        lastAuditAt: lastAudit ? Number(lastAudit.createdAt || 0) : 0,
      });
    } catch (e) {
      console.error("[admin/ops/health]", e);
      return res.status(500).json({ ok: false, error: "Failed to load operations health." });
    }
  });

  app.get("/api/admin/licensing/status", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("licensing.advanced_dashboard", "licensing.renewal_reminders", "licensing.audit_history", "licensing.branch_transfer", "licensing.token_revocation", "licensing.one_time_tokens"), (req, res) => {
    try {
      const st = refreshActivationState();
      const reminder = buildLicenseReminder(st);
      const features = getProvisionedFeatureMap([
        "licensing.advanced_dashboard",
        "licensing.renewal_reminders",
        "licensing.audit_history",
        "licensing.branch_transfer",
        "licensing.token_revocation",
        "licensing.one_time_tokens",
      ]);
      const currentTokenHash = String(st.activationTokenHash || "").trim();
      return res.json({
        ok: true,
        features,
        status: String(st.status || ACTIVATION_STATUS_UNACTIVATED).toUpperCase(),
        installId: String(st.installId || getDbSetting("install.id") || "").trim(),
        branchCode: getRequestBranchCode(req),
        branchName: getRequestBranchName(req),
        activatedAt: Number(st.activatedAt || 0) || null,
        activatedBy: String(st.activatedBy || ""),
        activationLicenseId: String(st.activationLicenseId || ""),
        licenseIssuedAt: Number(st.licenseIssuedAt || 0) || null,
        licenseExpiresAt: Number(st.licenseExpiresAt || 0) || null,
        lastRenewedAt: Number(st.lastRenewedAt || 0) || null,
        updatedAt: Number(st.updatedAt || 0) || null,
        daysRemaining: reminder.daysRemaining,
        reminder,
        history: getLicenseAuditHistory(20),
        tokenEvents: listActivationTokenEvents(12),
        currentTokenRevoked: currentTokenHash ? !!findActivationTokenRevocation(currentTokenHash) : false,
      });
    } catch (e) {
      console.error("[admin/licensing/status]", e);
      return res.status(500).json({ ok: false, error: "Failed to load licensing status." });
    }
  });

  app.post("/api/admin/licensing/revoke-token", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("licensing.token_revocation"), express.json(), (req, res) => {
    try {
      const token = String(req.body?.token || "").trim();
      const reason = String(req.body?.reason || "").trim();
      if (!token) return res.status(400).json({ ok: false, error: "token is required." });
      const actor = String(getSessionUser(req)?.fullName || "admin").trim() || "admin";
      const payload = decodeActivationPayloadUnsafe(token);
      const tokenHash = hashLicenseToken(token);
      const now = Date.now();
      const branchCode = getRequestBranchCode(req);
      revokeActivationTokenHash({
        tokenHash,
        installId: String(payload.installId || getDbSetting("install.id") || "").trim(),
        branchCode: String(payload.branchCode || branchCode || "").trim().toUpperCase(),
        licenseId: String(payload.licenseId || "").trim(),
        reason,
        revokedBy: actor,
        revokedAt: now,
      });
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "INSTALL_TOKEN_REVOKED",
        JSON.stringify({
          tokenHash,
          installId: String(payload.installId || getDbSetting("install.id") || "").trim(),
          branchCode: String(payload.branchCode || branchCode || "").trim().toUpperCase(),
          licenseId: String(payload.licenseId || "").trim(),
          reason,
          revokedBy: actor,
        }),
        now
      );
      return res.json({ ok: true, tokenHash, revokedAt: now });
    } catch (e) {
      console.error("[admin/licensing/revoke-token]", e);
      return res.status(500).json({ ok: false, error: "Failed to revoke licensing token." });
    }
  });

  app.post("/api/admin/licensing/transfer-release", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("licensing.branch_transfer"), express.json(), (req, res) => {
    try {
      const confirmText = String(req.body?.confirmText || "").trim().toUpperCase();
      if (confirmText !== "TRANSFER") return res.status(400).json({ ok: false, error: "Type TRANSFER to confirm release." });

      const st = getActivationState();
      const currentStatus = String(st.status || "").toUpperCase();
      if (![ACTIVATION_STATUS_ACTIVATED, ACTIVATION_STATUS_EXPIRED].includes(currentStatus)) {
        return res.status(409).json({ ok: false, error: "Only activated or expired installations can be released." });
      }

      const previousInstallId = String(st.installId || getDbSetting("install.id") || "").trim();
      const previousBranchCode = String(getRequestBranchCode(req) || st.activationBranchCode || "").trim().toUpperCase();
      const previousLicenseId = String(st.activationLicenseId || "").trim();
      const nextInstallId = randomUUID();
      const now = Date.now();
      const actor = String(getSessionUser(req)?.fullName || "admin").trim() || "admin";

      db.transaction(() => {
        setDbSetting("install.id", nextInstallId);
        db.prepare(
          `UPDATE installation_state
           SET status=?, installId=?, activatedAt=NULL, activatedBy=NULL, activationLicenseId=NULL,
               licenseIssuedAt=NULL, licenseExpiresAt=NULL, lastRenewedAt=NULL, activationBranchCode=NULL,
               activationTokenHash=NULL, activationPayload=NULL, updatedAt=?
           WHERE id=1`
        ).run(ACTIVATION_STATUS_UNACTIVATED, nextInstallId, now);
        db.prepare(`UPDATE branch_config SET branchCode=?, branchName=?, updatedAt=? WHERE id=1`).run(
          BRANCH_CODE_PLACEHOLDER,
          "Unassigned Branch",
          now
        );
        bootstrapDefaultOrganizationAndBranch(db);
        db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
          "INSTALL_TRANSFER_RELEASED",
          JSON.stringify({
            previousInstallId,
            nextInstallId,
            branchCode: previousBranchCode,
            licenseId: previousLicenseId,
            releasedBy: actor,
            previousStatus: currentStatus,
          }),
          now
        );
      })();

      return res.json({ ok: true, previousInstallId, nextInstallId, branchCode: previousBranchCode, releasedAt: now });
    } catch (e) {
      console.error("[admin/licensing/transfer-release]", e);
      return res.status(500).json({ ok: false, error: "Failed to release installation for transfer." });
    }
  });

  app.get("/api/admin/ops/automation/status", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("operations.auto_backup", "operations.integrity_check", "operations.startup_self_test"), (_req, res) => {
    try {
      res.json({
        ok: true,
        features: getProvisionedFeatureMap(["operations.auto_backup", "operations.integrity_check", "operations.startup_self_test"]),
        autoBackup: { ...getAutoBackupConfig(), lastResult: getAutoBackupState() },
        integrityCheck: getIntegrityCheckState(),
        selfTest: getSelfTestState(),
      });
    } catch (e) {
      console.error("[admin/ops/automation/status]", e);
      res.status(500).json({ ok: false, error: "Failed to load automation status." });
    }
  });

  app.get("/api/admin/system/backup-status", requirePerm("SETTINGS_MANAGE"), (_req, res) => {
    try {
      return res.json({ ok: true, ...getBackupManagementPayload({ limit: 5 }) });
    } catch (e) {
      console.error("[admin/system/backup-status]", e);
      return res.status(500).json({ ok: false, error: "Failed to load backup status." });
    }
  });

  app.post("/api/admin/ops/auto-backup/config", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("operations.auto_backup"), express.json(), (req, res) => {
    try {
      const enabled = !!req.body?.enabled;
      const intervalHours = Math.max(1, Math.min(24 * 30, Number(req.body?.intervalHours) || 24));
      const retentionCount = Math.max(1, Math.min(100, Number(req.body?.retentionCount) || 10));
      setAppSetting("ops.autoBackup.enabled", enabled ? "1" : "0");
      setAppSetting("ops.autoBackup.intervalHours", String(intervalHours));
      setAppSetting("ops.autoBackup.retentionCount", String(retentionCount));
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "OPS_AUTO_BACKUP_CONFIG",
        JSON.stringify({ actor: actorFromReq(req), enabled, intervalHours, retentionCount }),
        Date.now()
      );
      res.json({ ok: true, config: getAutoBackupConfig() });
    } catch (e) {
      console.error("[admin/ops/auto-backup/config]", e);
      res.status(500).json({ ok: false, error: "Failed to save auto-backup config." });
    }
  });

  app.post("/api/admin/ops/auto-backup/run", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("operations.auto_backup"), (_req, res) => {
    try {
      return res.json({ ok: true, result: maybeRunAutoBackup("manual") });
    } catch (e) {
      console.error("[admin/ops/auto-backup/run]", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e || "Auto backup failed.") });
    }
  });

  app.post("/api/admin/ops/integrity-check/run", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("operations.integrity_check"), (req, res) => {
    try {
      return res.json({ ok: true, result: runIntegrityCheck("manual", actorFromReq(req)?.fullName || "SYSTEM") });
    } catch (e) {
      console.error("[admin/ops/integrity-check/run]", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e || "Integrity check failed.") });
    }
  });

  app.post("/api/admin/ops/startup-self-test/run", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("operations.startup_self_test"), (req, res) => {
    try {
      return res.json({ ok: true, result: runStartupSelfTest("manual", actorFromReq(req)?.fullName || "SYSTEM") });
    } catch (e) {
      console.error("[admin/ops/startup-self-test/run]", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e || "Self-test failed.") });
    }
  });

  app.get("/api/admin/ops/support-bundle", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("operations.support_bundle"), (req, res) => {
    try {
      const now = Date.now();
      const supportDir = getSupportBundlesDir();
      if (!fs.existsSync(supportDir)) fs.mkdirSync(supportDir, { recursive: true });
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      const fileName = `qsys-support-bundle-${stamp}.json`;
      const filePath = path.join(supportDir, fileName);
      const st = refreshActivationState();
      const payload = {
        generatedAt: now,
        branchCode: getRequestBranchCode(req),
        branchName: getRequestBranchName(req),
        currentBusinessDate: ensureBusinessDate(db),
        activation: {
          status: String(st.status || ACTIVATION_STATUS_UNACTIVATED).toUpperCase(),
          installId: String(st.installId || ""),
          activationLicenseId: String(st.activationLicenseId || ""),
          licenseIssuedAt: Number(st.licenseIssuedAt || 0) || null,
          licenseExpiresAt: Number(st.licenseExpiresAt || 0) || null,
          lastRenewedAt: Number(st.lastRenewedAt || 0) || null,
        },
        operations: {
          autoBackup: { ...getAutoBackupConfig(), lastResult: getAutoBackupState() },
          integrityCheck: getIntegrityCheckState(),
          selfTest: getSelfTestState(),
          lastRestore: getLastRestoreState(),
        },
        recentAudit: db.prepare(`SELECT id, action, payload, createdAt FROM audit_logs ORDER BY createdAt DESC LIMIT 100`).all(),
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "OPS_SUPPORT_BUNDLE_EXPORT",
        JSON.stringify({ actor: actorFromReq(req), fileName, filePath }),
        now
      );
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
      return res.sendFile(filePath);
    } catch (e) {
      console.error("[admin/ops/support-bundle]", e);
      return res.status(500).json({ ok: false, error: "Failed to build support bundle." });
    }
  });

  /* ---------- admin/system backup + restore ---------- */
  // Creates a deterministic internal DB snapshot under <baseDir>/backups.
  // Other backup flows (export) reuse this so behavior stays consistent.
  function createInternalDbBackup() {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const backupsDir = path.join(baseDir, "backups");
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

    let fileName = `qsys-backup-${ts}.db`;
    let outPath = path.join(backupsDir, fileName);
    let suffix = 1;
    while (fs.existsSync(outPath)) {
      fileName = `qsys-backup-${ts}-${suffix}.db`;
      outPath = path.join(backupsDir, fileName);
      suffix += 1;
    }
    const escapedOutPath = outPath.replace(/'/g, "''");

    // Flush WAL pages before creating a compact snapshot.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec(`VACUUM INTO '${escapedOutPath}'`);

    return { fileName, filePath: outPath, sizeBytes: fs.statSync(outPath).size };
  }

  function getBackupFileByName(name) {
    const target = String(name || "").trim();
    if (!target || !/^qsys-backup-.*\.db$/i.test(target)) return null;
    return listBackupFiles().find((file) => file.name === target) || null;
  }

  function restoreLatestBackup({ actor, auditAction = "SYSTEM_DB_RESTORE" } = {}) {
    const candidates = listBackupFiles();
    if (!candidates.length) {
      const err = new Error("No backup files found.");
      err.http = 400;
      throw err;
    }

    const latest = candidates[0];
    const dbPath = path.join(baseDir, "data", "qsys.db");
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    const now = Date.now();

    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      auditAction,
      JSON.stringify({
        actor: actor || "SYSTEM",
        sourceFile: latest.name,
        sourcePath: latest.full,
      }),
      now
    );
    saveLastRestoreState({
      restoredAt: now,
      sourceFile: latest.name,
      sourcePath: latest.full,
      actor: actor || "SYSTEM",
    });

    db.close();
    fs.copyFileSync(latest.full, dbPath);
    try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch {}
    try { if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath); } catch {}

    let restartPlanned = false;
    try {
      const electron = require("electron");
      if (electron && electron.app) {
        restartPlanned = true;
        setTimeout(() => {
          try {
            electron.app.relaunch();
            electron.app.exit(0);
          } catch {}
        }, 1200);
      }
    } catch {}

    if (!restartPlanned) {
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {}
      }, 1200).unref?.();
    }

    return {
      restoredFrom: latest.name,
      restoredAt: now,
      restartPlanned: true,
      message: "Database restored. QSys will restart now.",
    };
  }

  let seedTodayInProgress = false;

  // Seed realistic test queue data across a selectable month span.
  app.post("/api/admin/system/seed-today", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    if (seedTodayInProgress) {
      return res.status(409).json({ ok: false, error: "Seed job is already running." });
    }
    seedTodayInProgress = true;

    const seedScript = path.join(__dirname, "seed-demo-today.js");
    const requestedMonths = Math.max(1, Math.min(3, Number.parseInt(req.body?.months || "1", 10) || 1));
    const args = [seedScript, baseDir, String(requestedMonths)];
    const startedAt = Date.now();

    execFile(
      process.execPath,
      args,
      { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        seedTodayInProgress = false;
        const out = String(stdout || "").trim();
        const errOut = String(stderr || "").trim();
        const durationMs = Date.now() - startedAt;

        if (err) {
          const msg = String(err.message || "Seed failed");
          try {
            db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
              "ADMIN_SEED_TODAY",
              JSON.stringify({
                actor: actorFromReq(req),
                ok: false,
                months: requestedMonths,
                durationMs,
                error: msg,
                stderr: errOut,
              }),
              Date.now()
            );
          } catch {}
          return res.status(500).json({
            ok: false,
            error: `Seed failed: ${msg}`,
            stderr: errOut,
          });
        }

        try {
          db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
            "ADMIN_SEED_TODAY",
            JSON.stringify({
              actor: actorFromReq(req),
              ok: true,
              months: requestedMonths,
              durationMs,
              output: out,
            }),
            Date.now()
          );
        } catch {}

        return res.json({
          ok: true,
          months: requestedMonths,
          message: `Seed completed for ${requestedMonths} month(s).`,
          durationMs,
          output: out,
        });
      }
    );
  });

  // Backup now: creates an internal snapshot and returns file metadata.
  app.post("/api/admin/system/backup", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    try {
      const snap = createInternalDbBackup();

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_DB_BACKUP",
        JSON.stringify({
          actor: actorFromReq(req),
          fileName: snap.fileName,
          filePath: snap.filePath,
          sizeBytes: snap.sizeBytes,
        }),
        Date.now()
      );

      return res.json({ ok: true, fileName: snap.fileName, filePath: snap.filePath, sizeBytes: snap.sizeBytes });
    } catch (e) {
      console.error("[admin/system/backup]", e);
      return res.status(500).json({ ok: false, error: "Backup failed." });
    }
  });

  // Backup + export: create internal backup first, then copy to a user-selected folder.
  app.post("/api/admin/system/backup/export", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
    try {
      const snap = createInternalDbBackup();

      let dialog, BrowserWindow;
      try {
        const electron = require("electron");
        dialog = electron.dialog;
        BrowserWindow = electron.BrowserWindow;
      } catch {
        return res.status(400).json({ ok: false, error: "Folder picker requires Electron." });
      }

      if (!dialog) {
        return res.status(400).json({ ok: false, error: "Electron dialog is not available." });
      }

      const win = (() => {
        try {
          const wins = (BrowserWindow && BrowserWindow.getAllWindows) ? BrowserWindow.getAllWindows() : [];
          const adminWin = wins.find((w) => {
            try {
              const url = w.webContents && w.webContents.getURL ? w.webContents.getURL() : "";
              return String(url).includes("/admin") || String(url).includes("admin.html");
            } catch {
              return false;
            }
          });
          if (adminWin) return adminWin;
          return (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow()) || wins[0] || null;
        } catch {
          return null;
        }
      })();

      const result = await dialog.showOpenDialog(win || undefined, {
        title: "Choose Folder for Backup Export",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled) {
        return res.json({ ok: true, canceled: true, fileName: snap.fileName, filePath: snap.filePath });
      }

      const folder = String(result.filePaths?.[0] || "").trim();
      if (!folder) return res.status(400).json({ ok: false, error: "No folder selected." });

      const exportPath = path.join(folder, snap.fileName);
      fs.copyFileSync(snap.filePath, exportPath);

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_DB_BACKUP_EXPORT",
        JSON.stringify({
          actor: actorFromReq(req),
          internalPath: snap.filePath,
          exportPath,
          fileName: snap.fileName,
          sizeBytes: fs.statSync(exportPath).size,
        }),
        Date.now()
      );

      return res.json({
        ok: true,
        fileName: snap.fileName,
        filePath: snap.filePath,
        exportPath,
      });
    } catch (e) {
      console.error("[admin/system/backup/export]", e);
      return res.status(500).json({ ok: false, error: "Backup export failed." });
    }
  });

  // Opens the local backups directory in the OS file explorer.
  app.post("/api/admin/system/backup/open-folder", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
    try {
      const backupsDir = path.join(baseDir, "backups");
      if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

      let shell;
      try {
        const electron = require("electron");
        shell = electron.shell;
      } catch {
        return res.status(400).json({ ok: false, error: "Open folder requires Electron." });
      }
      if (!shell || typeof shell.openPath !== "function") {
        return res.status(400).json({ ok: false, error: "Electron shell is not available." });
      }

      const openErr = await shell.openPath(backupsDir);
      if (openErr) {
        return res.status(500).json({ ok: false, error: `Failed to open folder: ${openErr}` });
      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_DB_BACKUP_OPEN_FOLDER",
        JSON.stringify({
          actor: actorFromReq(req),
          folder: backupsDir,
        }),
        Date.now()
      );

      return res.json({ ok: true, folder: backupsDir });
    } catch (e) {
      console.error("[admin/system/backup/open-folder]", e);
      return res.status(500).json({ ok: false, error: "Failed to open backup folder." });
    }
  });

  // Restore latest backup and relaunch app so all processes reopen the restored DB.
  app.post("/api/admin/system/restore", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    try {
      const result = restoreLatestBackup({ actor: actorFromReq(req), auditAction: "ADMIN_DB_RESTORE" });
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error("[admin/system/restore]", e);
      return res.status(Number(e?.http || 500)).json({ ok: false, error: String(e?.message || "Restore failed.") });
    }
  });
  
  /* ---------- system: display window (Electron host) ---------- */
app.get("/api/system/display/state", requireStaffApi, requireOperationalBranch, (req, res) => {
  try {
    const ctrl = global.QSYS_DISPLAY;
    if (!ctrl) return res.json({ ok: true, on: false, note: "Display controller not available" });
    return res.json(ctrl.state());
  } catch (e) {
    console.error("[display/state]", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/system/display/open", requireStaffApi, requireOperationalBranch, (req, res) => {
  try {
    const ctrl = global.QSYS_DISPLAY;
    if (!ctrl) return res.status(400).json({ ok: false, error: "Display controller not available" });
    return res.json(ctrl.open({ displayId: req.body?.displayId }));
  } catch (e) {
    console.error("[display/open]", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/system/display/close", requireStaffApi, requireOperationalBranch, (req, res) => {
  try {
    const ctrl = global.QSYS_DISPLAY;
    if (!ctrl) return res.status(400).json({ ok: false, error: "Display controller not available" });
    return res.json(ctrl.close());
  } catch (e) {
    console.error("[display/close]", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

function formatDisplayTicketCode(row) {
  if (!row) return "";
  const groupCode = String(row.groupCode || "").trim().toUpperCase();
  if (!groupCode) return "";
  const queueNum = String(Number(row.queueNum || 0)).padStart(2, "0");
  const isPriority = String(row.priorityType || "NONE").trim().toUpperCase() !== "NONE";
  return `${isPriority ? "P" : ""}${groupCode}-${queueNum}`;
}

function announceDisplayTicket(row) {
  try {
    const ctrl = global.QSYS_DISPLAY;
    if (!ctrl || typeof ctrl.announce !== "function") return;
    const code = formatDisplayTicketCode(row);
    if (!code) return;
    if (typeof ctrl.attention === "function") {
      try { ctrl.attention(); } catch {}
    }
    try { ctrl.announce({ code }); } catch {}
  } catch {}
}

app.get("/api/staff/queue-tools", requireAuth, (req, res) => {
  try {
    const branchCode = getRequestBranchCode(req);
    const businessDate = ensureBusinessDate(db);
    const groupCode = normalizeGroup(req.query.groupCode || "B");
    const features = getProvisionedFeatureMap([
      "queue.recovery_tools",
      "queue.reopen_completed",
      "queue.wait_forecast",
    ]);

    const payload = { ok: true, groupCode, businessDate, features };
    if (features["queue.recovery_tools"] || features["queue.reopen_completed"]) {
      payload.recentRecoverable = getQueueRecoveryRows({ branchCode, businessDate, groupCode, limit: 12 });
    }
    if (features["queue.wait_forecast"]) {
      payload.waitForecast = getQueueWaitForecast({ branchCode, businessDate, groupCode });
    }
    return res.json(payload);
  } catch (e) {
    console.error("[staff/queue-tools]", e);
    return res.status(500).json({ ok: false, error: "Failed to load queue tools." });
  }
});

app.get("/api/staff/state", requireAuth, (req, res) => {
  const businessDate = ensureBusinessDate(db);
  const bc = getRequestBranchCode(req);

  const rows = db
    .prepare(
      `
    SELECT id, groupCode, queueNum, name, pax, status,
           priorityType, createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate = ?
      AND status IN ('WAITING','CALLED')
    ORDER BY
      CASE groupCode
          WHEN 'A' THEN 1
          WHEN 'B' THEN 2
          WHEN 'C' THEN 3
          WHEN 'D' THEN 4
          ELSE 9
      END,
      CASE WHEN (priorityType IS NOT NULL AND priorityType!='NONE') THEN 0 ELSE 1 END,
      queueNum ASC
  `
    )
    .all(bc, businessDate);

  res.json({ ok: true, branchCode: bc, branchName: getRequestBranchName(req), businessDate, rows });
});

  /* ---------- state snapshot (DISPLAY + STAFF) ---------- */
  // SECURITY ADDON: must be authenticated
app.get("/api/state", requireAuth, (req, res) => {
    const businessDate = ensureBusinessDate(db);
    const bc = getRequestBranchCode(req);

    const rows = db
      .prepare(
        `
    SELECT id, groupCode, queueNum, name, pax, status,
           priorityType, createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate = ?
      AND status IN ('WAITING','CALLED')
    ORDER BY
      CASE groupCode
          WHEN 'A' THEN 1
          WHEN 'B' THEN 2
          WHEN 'C' THEN 3
          WHEN 'D' THEN 4
          ELSE 9
      END,
      CASE WHEN (priorityType IS NOT NULL AND priorityType!='NONE') THEN 0 ELSE 1 END,
      queueNum ASC
  `
      )
      .all(bc, businessDate);

    res.json({ ok: true, branchCode: bc, branchName: getRequestBranchName(req), businessDate, rows });
  });


/* ---------- state snapshot (DISPLAY AUTHORIZED DEVICE) ---------- */
app.get("/api/display/state", requireDisplayAuth, (req, res) => {

  // Prevent caching on kiosk devices
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");

  const businessDate = ensureBusinessDate(db);
  const bc = getRequestBranchCode(req);

  const rowsRaw = db
    .prepare(
      `
  SELECT id, groupCode, queueNum, name, pax, status,
         priorityType, createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
  FROM queue_items
  WHERE branchCode = ?
    AND businessDate = ?
    AND status IN ('WAITING','CALLED')
  ORDER BY
    CASE groupCode
        WHEN 'A' THEN 1
        WHEN 'B' THEN 2
        WHEN 'C' THEN 3
        WHEN 'D' THEN 4
        ELSE 9
    END,
    CASE WHEN (priorityType IS NOT NULL AND priorityType!='NONE') THEN 0 ELSE 1 END,
    queueNum ASC
`
    )
    .all(bc, businessDate);

  // ---- Display mapping ----
  // Display must see priority as PA/PB/PC/PD (not just A/B/C/D)
  // and must receive a normalized 'priority' field.
  const pad2 = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    return String(x).padStart(2, "0");
  };

  const rows = (rowsRaw || []).map((r) => {
    const pt = String(r.priorityType || "NONE").toUpperCase();
    const isPriority = pt && pt !== "NONE";
    const baseGroup = String(r.groupCode || "").toUpperCase();
    const displayGroupCode = isPriority ? ("P" + baseGroup) : baseGroup;

    return {
      ...r,
      originalGroupCode: baseGroup,
      groupCode: displayGroupCode,
      isPriority: isPriority ? 1 : 0,
      priority: pt, // for frontend detectors
      code: `${displayGroupCode}-${pad2(r.queueNum)}`,
    };
  });

  // Version marker to confirm the running server code
  const version = "DISPLAY_STATE_PATCH_2026-01-24_DEV_A";

  res.json({ ok: true, version, branchCode: bc, branchName: getRequestBranchName(req), businessDate, rows });
});



  /* ---------- Admin: Today stats (all statuses) ---------- */
  app.get("/api/admin/stats/today", requireAuth, (req, res) => {
    try {
      const businessDate = ensureBusinessDate(db);
      const payload = computeAdminTodayStats(db, getRequestBranchCode(req), businessDate);
      res.json(payload);
    } catch (e) {
      console.error("[admin/stats/today]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- Admin: EMA(14) from daily_group_stats ---------- */
  app.get("/api/admin/stats/ema14", requireAuth, (req, res) => {
    try {
      const bc = getRequestBranchCode(req);
      const alpha = 2 / (14 + 1); // 2/15
      const groups = ["P", "A", "B", "C", "D"];

      const result = {};
      for (const g of groups) {
        const rows = db
          .prepare(
            `SELECT businessDate, waitSumMinutes, waitCount
           FROM daily_group_stats
           WHERE branchCode=? AND groupCode=?
           ORDER BY businessDate DESC
           LIMIT 14`
          )
          .all(bc, g);

        // compute EMA from oldest -> newest
        const ordered = rows.slice().reverse().filter((r) => Number(r.waitCount) > 0);
        let ema = null;
        for (const r of ordered) {
          const avg = Number(r.waitSumMinutes) / Number(r.waitCount);
          if (!Number.isFinite(avg)) continue;
          ema = ema === null ? avg : alpha * avg + (1 - alpha) * ema;
        }
        result[g] = ema === null ? null : Math.round(ema * 10) / 10;
      }

      res.json({ ok: true, ema14: result, alpha });
    } catch (e) {
      console.error("[admin/stats/ema14]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- Admin: CSV exports ---------- */
  // Date helpers for Manila-based range filtering and rolling-window cutoffs.
  function manilaDayStartMs(ymd) {
    const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!y || !mo || !d) return null;
    // Manila midnight in UTC
    return Date.UTC(y, mo - 1, d, -8, 0, 0, 0);
  }

  function manilaDayEndMs(ymd) {
    const start = manilaDayStartMs(ymd);
    if (start == null) return null;
    return start + (24 * 60 * 60 * 1000) - 1;
  }

  function manilaYmdFromMs(ms) {
    try {
      return new Date(Number(ms)).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    } catch {
      return "";
    }
  }

  function safeFilePart(v) {
    return String(v || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, "_");
  }

  function fileStampNow() {
    const ts = new Date();
    return (
      `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}_` +
      `${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(ts.getSeconds()).padStart(2, "0")}`
    );
  }

  function reportFileName(reportKey, branchCode, from, to, opts) {
    const o = opts || {};
    const bc = safeFilePart(branchCode || "BRANCH");
    const rk = safeFilePart(reportKey || "report");
    const f = safeFilePart(from || "");
    const t = safeFilePart(to || "");
    const ext = safeFilePart(o.ext || "csv") || "csv";
    const dateRange = f && t ? (f === t ? f : `${f}_to_${t}`) : (f || t || safeFilePart(o.scopeLabel || "") || "daterange");
    return `${bc}_${rk}_${dateRange}.${ext}`;
  }

  function formatReCallTimes(value) {
    const parts = String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return "";
    return parts
      .map((part) => {
        const n = Number(part);
        if (Number.isFinite(n) && n > 0) {
          try {
            return new Date(n).toLocaleTimeString("en-PH", {
              timeZone: "Asia/Manila",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: true,
            });
          } catch {
            return "";
          }
        }
        const parsed = Date.parse(part);
        if (Number.isFinite(parsed) && parsed > 0) {
          try {
            return new Date(parsed).toLocaleTimeString("en-PH", {
              timeZone: "Asia/Manila",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: true,
            });
          } catch {
            return "";
          }
        }
        return part;
      })
      .filter(Boolean)
      .join(" | ");
  }

  function getDailySummaryRowsWithFallback(branchCode, from, to, sinceMs) {
    let effectiveFrom = from;
    if (sinceMs) {
      const sinceYmd = manilaYmdFromMs(sinceMs);
      if (sinceYmd && sinceYmd > effectiveFrom) effectiveFrom = sinceYmd;
    }

    const hasTimestamp = tableHasColumn(db, "queue_items", "timestamp");
    const createdExpr = hasTimestamp ? "COALESCE(timestamp, createdAtLocal)" : "createdAtLocal";
    const sinceSql = sinceMs ? ` AND ${createdExpr} >= ?` : "";
    const baseParams = sinceMs
      ? [branchCode, effectiveFrom, to, sinceMs]
      : [branchCode, effectiveFrom, to];

    let rows = db
      .prepare(
        `SELECT businessDate, groupCode, registeredCount, calledCount, seatedCount, skippedCount,
                overrideCalledCount, waitSumMinutes, waitCount
         FROM daily_group_stats
         WHERE branchCode=? AND businessDate BETWEEN ? AND ?
         ORDER BY businessDate ASC,
           CASE groupCode WHEN 'P' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 9 END`
      )
      .all(branchCode, effectiveFrom, to);

    if (rows.length) {
      // Normalize Avg Wait to created -> seated (to match Daily Summary definition).
      const waitRows = db
        .prepare(
          `SELECT
             businessDate,
             groupCode,
             SUM(
               CASE
                 WHEN seatedAt IS NOT NULL AND createdAtLocal IS NOT NULL AND seatedAt >= createdAtLocal
                 THEN (seatedAt - createdAtLocal) / 60000.0
                 ELSE 0
               END
             ) AS waitSumMinutes,
             SUM(
               CASE
                 WHEN seatedAt IS NOT NULL AND createdAtLocal IS NOT NULL AND seatedAt >= createdAtLocal
                 THEN 1
                 ELSE 0
               END
             ) AS waitCount
           FROM queue_items
           WHERE branchCode=? AND businessDate BETWEEN ? AND ?
             ${sinceSql}
           GROUP BY businessDate, groupCode`
        )
        .all(...baseParams);
      const waitMap = new Map();
      for (const w of waitRows) {
        waitMap.set(`${w.businessDate}__${w.groupCode}`, {
          waitSumMinutes: Number(w.waitSumMinutes || 0),
          waitCount: Number(w.waitCount || 0),
        });
      }
      rows = rows.map((r) => {
        const w = waitMap.get(`${r.businessDate}__${r.groupCode}`);
        if (!w) return { ...r, waitSumMinutes: 0, waitCount: 0 };
        return { ...r, waitSumMinutes: w.waitSumMinutes, waitCount: w.waitCount };
      });
      return { effectiveFrom, rows };
    }

    rows = db
      .prepare(
        `SELECT
           businessDate,
           groupCode,
           COUNT(*) AS registeredCount,
           SUM(CASE WHEN calledAt IS NOT NULL THEN 1 ELSE 0 END) AS calledCount,
           SUM(CASE WHEN UPPER(COALESCE(status,''))='SEATED' THEN 1 ELSE 0 END) AS seatedCount,
           SUM(CASE WHEN UPPER(COALESCE(status,''))='SKIPPED' THEN 1 ELSE 0 END) AS skippedCount,
            0 AS overrideCalledCount,
            SUM(
              CASE
                WHEN seatedAt IS NOT NULL AND createdAtLocal IS NOT NULL AND seatedAt >= createdAtLocal
                THEN (seatedAt - createdAtLocal) / 60000.0
                ELSE 0
              END
            ) AS waitSumMinutes,
            SUM(
              CASE
                WHEN seatedAt IS NOT NULL AND createdAtLocal IS NOT NULL AND seatedAt >= createdAtLocal
                THEN 1
                ELSE 0
              END
           ) AS waitCount
         FROM queue_items
         WHERE branchCode=? AND businessDate BETWEEN ? AND ?
         ${sinceSql}
         GROUP BY businessDate, groupCode
         ORDER BY businessDate ASC,
           CASE groupCode WHEN 'P' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 9 END`
      )
      .all(...baseParams);

    return { effectiveFrom, rows };
  }

  function buildDailyEmaLookup(historyRows) {
    const alpha = 2 / (14 + 1);
    const grouped = new Map();
    const lookup = new Map();

    for (const r of historyRows || []) {
      const g = String(r.groupCode || "").trim();
      const d = String(r.businessDate || "").trim();
      if (!g || !d) continue;
      if (!grouped.has(g)) grouped.set(g, []);
      grouped.get(g).push(r);
    }

    for (const [g, rows] of grouped.entries()) {
      rows.sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)));
      let ema = null;
      for (const r of rows) {
        const avg = r.waitCount && Number(r.waitCount) > 0
          ? Number(r.waitSumMinutes) / Number(r.waitCount)
          : null;
        ema = avg === null ? ema : (ema === null ? avg : alpha * avg + (1 - alpha) * ema);
        lookup.set(`${r.businessDate}__${g}`, ema);
      }
    }

    return lookup;
  }

  // Raw ticket export with optional rolling-window filter (sinceMs/sinceHours).
  app.get("/api/admin/reports/tickets", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
    try {
      const bc = getRequestBranchCode(req);
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      if (!from || !to) return res.status(400).json({ ok: false, error: "from/to required" });
      const sinceMs = parseSinceMs(req);
      const hasTimestamp = tableHasColumn(db, "queue_items", "timestamp");
      const createdExpr = hasTimestamp ? "COALESCE(timestamp, createdAtLocal)" : "createdAtLocal";
      const sinceSql = sinceMs ? ` AND ${createdExpr} >= ?` : "";
      const params = sinceMs ? [bc, from, to, sinceMs] : [bc, from, to];

      const rows = db
        .prepare(
          `SELECT id, branchCode, businessDate, groupCode, queueNum, priorityType, name, pax, status,
              createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
       FROM queue_items
       WHERE branchCode=? AND businessDate BETWEEN ? AND ?
       ${sinceSql}
       ORDER BY businessDate ASC,
         CASE groupCode WHEN 'P' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 9 END,
         queueNum ASC`
        )
        .all(...params);

      function fmtTs(ms) {
        if (ms === null || ms === undefined || ms === "") return "";
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return "";
        return new Date(n).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        });
      }

      function minsDiff(startMs, endMs) {
        const s = Number(startMs);
        const e = Number(endMs);
        if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) return "";
        const mins = (e - s) / 60000;
        if (!Number.isFinite(mins) || mins < 0) return "";
        return Math.round(mins * 10) / 10;
      }

      function timesCalled(row) {
        if (!row || !row.calledAt) return 0;
        const next = String(row.next_calls || "").trim();
        if (!next) return 1;
        const extra = next.split(",").map((s) => s.trim()).filter(Boolean).length;
        return 1 + extra;
      }

      return res.json({
        ok: true,
        branchCode: bc,
        from,
        to,
        rows: rows.map((r) => ({
          schemaVersion: 1,
          branchCode: r.branchCode,
          businessDate: r.businessDate,
          ticketId: r.id,
          groupCode: r.groupCode,
          queueNum: r.queueNum,
          priorityType: r.priorityType,
          name: r.name,
          pax: r.pax,
          status: r.status,
          createdAtLocalHuman: fmtTs(r.createdAtLocal),
          calledAtHuman: fmtTs(r.calledAt),
          timesCalled: timesCalled(r),
          nextCalls: r.calledAt ? formatReCallTimes(r.next_calls) : "",
          seatedAtHuman: fmtTs(r.seatedAt),
          skippedAtHuman: fmtTs(r.skippedAt),
          calledNote: r.calledNote ?? "",
          waitMinsToCalled: minsDiff(r.createdAtLocal, r.calledAt),
          waitMinsToSeated: minsDiff(r.createdAtLocal, r.seatedAt),
        })),
      });
    } catch (e) {
      console.error("[reports/tickets.json]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.get("/api/admin/reports/tickets.csv", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
    try {
      const bc = getRequestBranchCode(req);
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      const scopeLabel = String(req.query.scopeLabel || "").trim();
      if (!from || !to) return res.status(400).send("from/to required");
      const sinceMs = parseSinceMs(req);
      const hasTimestamp = tableHasColumn(db, "queue_items", "timestamp");
      const createdExpr = hasTimestamp ? "COALESCE(timestamp, createdAtLocal)" : "createdAtLocal";
      const sinceSql = sinceMs ? ` AND ${createdExpr} >= ?` : "";
      const params = sinceMs ? [bc, from, to, sinceMs] : [bc, from, to];

      const rows = db
        .prepare(
          `SELECT id, branchCode, businessDate, groupCode, queueNum, priorityType, name, pax, status,
              createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
       FROM queue_items
       WHERE branchCode=? AND businessDate BETWEEN ? AND ?
       ${sinceSql}
       ORDER BY businessDate ASC,
         CASE groupCode WHEN 'P' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 9 END,
         queueNum ASC`
        )
        .all(...params);

      function fmtTs(ms) {
        if (ms === null || ms === undefined || ms === "") return "";
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return "";
        return new Date(n).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        });
      }

      function minsDiff(startMs, endMs) {
        const s = Number(startMs);
        const e = Number(endMs);
        if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) return "";
        const mins = (e - s) / 60000;
        if (!Number.isFinite(mins) || mins < 0) return "";
        return Math.round(mins * 10) / 10; // 1 decimal
      }

      function timesCalled(row) {
        if (!row || !row.calledAt) return 0;
        const next = String(row.next_calls || "").trim();
        if (!next) return 1;
        const extra = next.split(",").map((s) => s.trim()).filter(Boolean).length;
        return 1 + extra;
      }

      const header = [
        "schemaVersion",
        "branchCode",
        "businessDate",
        "ticketId",
        "groupCode",
        "queueNum",
        "priorityType",
        "name",
        "pax",
        "status",
        "createdAtLocalHuman",
        "calledAtHuman",
        "timesCalled",
        "nextCalls",
        "seatedAtHuman",
        "skippedAtHuman",
        "calledNote",
        "waitMinsToCalled",
        "waitMinsToSeated",
      ];

      const outRows = rows.map((r) => [
        1,
        r.branchCode,
        r.businessDate,
        r.id,
        r.groupCode,
        r.queueNum,
        r.priorityType,
        r.name,
        r.pax,
        r.status,
        fmtTs(r.createdAtLocal),
        fmtTs(r.calledAt),
        timesCalled(r),
        r.calledAt ? formatReCallTimes(r.next_calls) : "",
        fmtTs(r.seatedAt),
        fmtTs(r.skippedAt),
        r.calledNote ?? "",
        minsDiff(r.createdAtLocal, r.calledAt),
        minsDiff(r.createdAtLocal, r.seatedAt),
      ]);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${reportFileName("tickets", bc, from, to, { scopeLabel })}"`);
      res.send(rowsToCsv(header, outRows));
    } catch (e) {
      console.error("[reports/tickets]", e);
      res.status(500).send("Server error");
    }
  });

  // Audit export includes actor columns and filters by actual audit timestamp.
  app.get("/api/admin/reports/audit_logs.csv", requirePerm("AUDIT_VIEW"), (req, res) => {
    try {
      const bc = getRequestBranchCode(req);
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      const scopeLabel = String(req.query.scopeLabel || "").trim();
      if (!from || !to) return res.status(400).send("from/to required");
      const sinceMs = parseSinceMs(req);
      let fromMs = manilaDayStartMs(from);
      const toMs = manilaDayEndMs(to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return res.status(400).send("invalid from/to");
      if (sinceMs) fromMs = Math.max(fromMs, sinceMs);

      const rows = db
        .prepare(
          `SELECT action, payload, createdAt
          FROM audit_logs
         WHERE createdAt BETWEEN ? AND ?
         ORDER BY createdAt ASC`
        )
        .all(fromMs, toMs);

      const header = ["schemaVersion", "branchCode", "createdAt", "action", "userId", "fullName", "roleId", "businessDate", "payloadJson"];
      const outRows = [];
      for (const r of rows) {
        let actor = null;
        let biz = "";
        try {
          const p = JSON.parse(r.payload || "{}");
          actor = p && p.actor ? p.actor : null;
          if (p.businessDate) biz = String(p.businessDate);
        } catch {}
        outRows.push([
          1,
          bc,
          r.createdAt,
          r.action,
          actor?.userId || "",
          actor?.fullName || "",
          actor?.roleId || "",
          biz,
          r.payload,
        ]);
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${reportFileName("audit_logs", bc, from, to, { scopeLabel })}"`);
      res.send(rowsToCsv(header, outRows));
    } catch (e) {
      console.error("[reports/audit]", e);
      res.status(500).send("Server error");
    }
  });

  app.get(
    "/api/admin/reports/audit_export.csv",
    requirePerm("AUDIT_VIEW"),
    requireProvisionedFeatureApi("reporting.audit_export"),
    (req, res) => {
      try {
        const bc = getRequestBranchCode(req);
        const from = String(req.query.from || "").trim();
        const to = String(req.query.to || "").trim();
        const scopeLabel = String(req.query.scopeLabel || "").trim();
        if (!from || !to) return res.status(400).send("from/to required");
        const sinceMs = parseSinceMs(req);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${reportFileName("audit_export", bc, from, to, { scopeLabel })}"`);
        res.send(buildStructuredAuditExportCsvForRange(from, to, sinceMs, bc));
      } catch (e) {
        console.error("[reports/audit_export]", e);
        res.status(500).send("Server error");
      }
    }
  );

  // Daily rollup export from pre-aggregated stats table.
  app.get("/api/admin/reports/daily_summary", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
    try {
      const bc = getRequestBranchCode(req);
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      if (!from || !to) return res.status(400).json({ ok: false, error: "from/to required" });
      const sinceMs = parseSinceMs(req);
      const { effectiveFrom, rows } = getDailySummaryRowsWithFallback(bc, from, to, sinceMs);

      const emaFrom = addDaysYmd(effectiveFrom, -13);
      const emaHistory = getDailySummaryRowsWithFallback(bc, emaFrom, to, null).rows;
      const emaLookup = buildDailyEmaLookup(emaHistory);
      const outRows = [];
      for (const r of rows) {
        const avg = r.waitCount && r.waitCount > 0 ? Number(r.waitSumMinutes) / Number(r.waitCount) : null;
        const ema = emaLookup.get(`${r.businessDate}__${r.groupCode}`);
        outRows.push({
          schemaVersion: 1,
          branchCode: bc,
          businessDate: r.businessDate,
          groupCode: r.groupCode,
          registeredCount: Number(r.registeredCount || 0),
          calledCount: Number(r.calledCount || 0),
          seatedCount: Number(r.seatedCount || 0),
          skippedCount: Number(r.skippedCount || 0),
          overrideCalledCount: Number(r.overrideCalledCount || 0),
          avgWaitMinutes: avg === null ? "" : Math.round(avg),
          ema14WaitMinutes: ema === null ? "" : Math.round(ema),
        });
      }
      return res.json({ ok: true, branchCode: bc, from: effectiveFrom, to, rows: outRows });
    } catch (e) {
      console.error("[reports/daily_summary.json]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  app.get("/api/admin/reports/daily_summary.csv", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
    try {
      const bc = getRequestBranchCode(req);
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      const scopeLabel = String(req.query.scopeLabel || "").trim();
      if (!from || !to) return res.status(400).send("from/to required");
      const sinceMs = parseSinceMs(req);
      const { effectiveFrom, rows } = getDailySummaryRowsWithFallback(bc, from, to, sinceMs);

      const emaFrom = addDaysYmd(effectiveFrom, -13);
      const emaHistory = getDailySummaryRowsWithFallback(bc, emaFrom, to, null).rows;
      const emaLookup = buildDailyEmaLookup(emaHistory);
      const header = [
        "schemaVersion",
        "branchCode",
        "businessDate",
        "groupCode",
        "registeredCount",
        "calledCount",
        "seatedCount",
        "skippedCount",
        "overrideCalledCount",
        "avgWaitMinutes",
        "ema14WaitMinutes",
      ];

      const outRows = [];
      for (const r of rows) {
        const avg = r.waitCount && r.waitCount > 0 ? Number(r.waitSumMinutes) / Number(r.waitCount) : null;
        const ema = emaLookup.get(`${r.businessDate}__${r.groupCode}`);

        outRows.push([
          1,
          bc,
          r.businessDate,
          r.groupCode,
          r.registeredCount,
          r.calledCount,
          r.seatedCount,
          r.skippedCount,
          r.overrideCalledCount,
          avg === null ? "" : Math.round(avg),
          ema === null ? "" : Math.round(ema),
        ]);
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${reportFileName("daily_summary", bc, from, to, { scopeLabel })}"`);
      res.send(rowsToCsv(header, outRows));
    } catch (e) {
      console.error("[reports/daily_summary]", e);
      res.status(500).send("Server error");
    }
  });

  /* ---------- Admin: Custom Summary (JSON + CSV) ---------- */

  function pad2(n){ return String(Number(n||0)).padStart(2,"0"); }

  function baseGroupFromRow(r){
    // For priority tickets, we still bucket by pax so they fall under A/B/C/D
    return computeGroupCode({ priorityType: "NONE", pax: r.pax });
  }

  function safeNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function avgMins(sumMs, n){
    if (!n) return 0;
    return Math.round((sumMs / n) / 60000);
  }

  // Shared rolling-window parser used by all report endpoints.
  function parseSinceMs(req){
    const q = req.query || {};
    const sinceMs = q.sinceMs != null ? Number(q.sinceMs) : null;
    if (Number.isFinite(sinceMs) && sinceMs > 0) return sinceMs;
    const sinceHours = q.sinceHours != null ? Number(q.sinceHours) : null;
    if (Number.isFinite(sinceHours) && sinceHours > 0) {
      return Date.now() - (sinceHours * 3600 * 1000);
    }
    return null;
  }

  // Computes A/B/C/D custom summary rows used by JSON preview and CSV export.
  function buildCustomSummary(from, to, sinceMs, branchCodeArg){
    const bc = String(branchCodeArg || getBranchCode()).trim();

    // Some deployments store server-side `timestamp`, others only `createdAtLocal`.
    const hasTimestamp = tableHasColumn(db, "queue_items", "timestamp");
    const createdExpr = hasTimestamp ? "COALESCE(timestamp, createdAtLocal)" : "createdAtLocal";

    const params = [bc, from, to];
    let sinceSql = "";
    if (sinceMs) {
      sinceSql = ` AND ${createdExpr} >= ? `;
      params.push(sinceMs);
    }

    const rows = db.prepare(`
      SELECT id, groupCode, pax, priorityType, status,
             createdAtLocal, ${hasTimestamp ? "timestamp" : "NULL AS timestamp"},
             calledAt, seatedAt
      FROM queue_items
      WHERE branchCode=? AND businessDate BETWEEN ? AND ?
      ${sinceSql}
    `).all(...params);

    const groups = { A:null, B:null, C:null, D:null };
    for (const g of Object.keys(groups)){
      groups[g] = {
        groupCode: g,
        waitlistCount: 0,          // total reservations (groups)
        totalPax: 0,               // total pax reserved
        priorityCount: 0,          // total priority reservations
        seatedCount: 0,            // seated count - group
        seatedPax: 0,              // seated count - total pax count
        _sumToCalledMs: 0,
        _nToCalled: 0,
        _sumToSeatedMs: 0,
        _nToSeated: 0,
      };
    }

    for (const r of rows){
      const g = baseGroupFromRow(r); // A/B/C/D
      const bucket = groups[g];
      if (!bucket) continue;

      bucket.waitlistCount += 1;
      bucket.totalPax += safeNum(r.pax);

      const pri = normalizePriority(r.priorityType);
      if (pri !== "NONE") bucket.priorityCount += 1;

      const createdMs = safeNum(r.timestamp) || safeNum(r.createdAtLocal);
      const calledMs = safeNum(r.calledAt);
      const seatedMs = safeNum(r.seatedAt);

      if (calledMs && createdMs && calledMs >= createdMs){
        bucket._sumToCalledMs += (calledMs - createdMs);
        bucket._nToCalled += 1;
      }
      if (seatedMs && createdMs && seatedMs >= createdMs){
        bucket.seatedCount += 1;
        bucket.seatedPax += safeNum(r.pax);
        bucket._sumToSeatedMs += (seatedMs - createdMs);
        bucket._nToSeated += 1;
      }
    }

    // finalize averages + totals
    const outRows = [];
    let paxOverall = 0;
    let priorityTotal = 0;

    for (const g of ["A","B","C","D"]){
      const b = groups[g];
      b.avgToCalledMins = avgMins(b._sumToCalledMs, b._nToCalled);
      b.avgToSeatedMins = avgMins(b._sumToSeatedMs, b._nToSeated);

      paxOverall += b.totalPax;
      priorityTotal += b.priorityCount;

      // remove internals
      delete b._sumToCalledMs; delete b._nToCalled;
      delete b._sumToSeatedMs; delete b._nToSeated;

      outRows.push(b);
    }

    return { rows: outRows, paxOverall, priorityTotal, branchCode: bc, from, to, sinceMs: sinceMs || null };
  }

  app.get("/api/admin/reports/custom_summary", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
    try {
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      if (!from || !to) return res.status(400).json({ ok:false, error:"from/to required" });

      const sinceMs = parseSinceMs(req);
      const result = buildCustomSummary(from, to, sinceMs, getRequestBranchCode(req));

      res.json({ ok:true, ...result });
    } catch (e) {
      console.error("[reports/custom_summary]", e);
      res.status(500).json({ ok:false, error:"Server error." });
    }
  });

  app.get("/api/admin/reports/custom_summary.csv", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
    try {
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      const scopeLabel = String(req.query.scopeLabel || "").trim();
      if (!from || !to) return res.status(400).send("from/to required");

      const sinceMs = parseSinceMs(req);
      const bc = getRequestBranchCode(req);
      const result = buildCustomSummary(from, to, sinceMs, bc);

      const header = [
        "GROUP CODE",
        "Total Reservations (all created tickets)",
        "Total Pax count reserved",
        "Total Priority Reservations",
        "Seated Count - group",
        "Seated Count - total pax count",
        "Waiting Time to be called - Average (mins)",
        "Waiting Time to be seated - Average (mins)"
      ];

      const lines = [];
      lines.push(header.join(","));

      for (const r of result.rows){
        lines.push([
          r.groupCode,
          r.waitlistCount,
          r.totalPax,
          r.priorityCount,
          r.seatedCount,
          r.seatedPax,
          r.avgToCalledMins,
          r.avgToSeatedMins
        ].join(","));
      }

      const fn = reportFileName("custom_summary", bc, from, to, { scopeLabel });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fn}"`);
      res.send(lines.join("\n"));
    } catch (e) {
      console.error("[reports/custom_summary.csv]", e);
      res.status(500).send("Server error");
    }
  });


  
/* ---------- Admin: Report Summary (JSON + CSV) ---------- */
function parseWaitRef(str){
  const s = String(str || "").trim();
  if (!s) return { type: "hours", value: 2 };
  const m = s.match(/^(hours|days)\s*:\s*(\d+)$/i);
  if (!m) return { type: "hours", value: 2 };
  const type = m[1].toLowerCase();
  const valueRaw = parseInt(m[2], 10) || 2;
  const value = type === "hours" ? Math.max(1, Math.min(48, valueRaw)) : Math.max(1, Math.min(60, valueRaw));
  return { type, value };
}

function ymdToDate(ymd){
  const parts = String(ymd||"").split("-");
  if (parts.length !== 3) return null;
  const Y = parseInt(parts[0],10), M = parseInt(parts[1],10), D = parseInt(parts[2],10);
  if (!Y || !M || !D) return null;
  // Manila midnight -> UTC = -8
  return new Date(Date.UTC(Y, M-1, D, -8, 0, 0, 0));
}
function dateToYmd(dt){
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth()+1).padStart(2,"0");
  const d = String(dt.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}
function addDaysYmd(ymd, deltaDays){
  const dt = ymdToDate(ymd);
  if (!dt) return ymd;
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dateToYmd(dt);
}

// Computes multi-section report summary (waitlist, seated, avg wait, pax, priority).
function computeReportSummary(db, branchCode, fromYmd, toYmd, waitRef, sinceMs){
  const from = String(fromYmd || "").trim();
  const to = String(toYmd || "").trim();
  if (!from || !to) throw new Error("from/to required");
  const hasTimestamp = tableHasColumn(db, "queue_items", "timestamp");
  const createdExpr = hasTimestamp ? "COALESCE(timestamp, createdAtLocal)" : "createdAtLocal";
  const hasSince = Number.isFinite(Number(sinceMs)) && Number(sinceMs) > 0;
  const sinceSql = hasSince ? ` AND ${createdExpr} >= ?` : "";
  const withSince = (params) => (hasSince ? [...params, Number(sinceMs)] : params);

  const bucketCase = `
    CASE
      WHEN pax <= 1 THEN '1'
      WHEN pax BETWEEN 2 AND 3 THEN '2-3'
      WHEN pax BETWEEN 4 AND 5 THEN '4-5'
      ELSE '6+'
    END
  `;

  const waitlist = db.prepare(`
    SELECT groupCode, ${bucketCase} AS paxBucket, COUNT(*) AS count
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate BETWEEN ? AND ?
      AND UPPER(status) = 'WAITING'
      ${sinceSql}
    GROUP BY groupCode, paxBucket
    ORDER BY groupCode, paxBucket
  `).all(...withSince([branchCode, from, to]));

  const seatedCounts = db.prepare(`
    SELECT groupCode, ${bucketCase} AS paxBucket, COUNT(*) AS count
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate BETWEEN ? AND ?
      AND UPPER(status) = 'SEATED'
      ${sinceSql}
    GROUP BY groupCode, paxBucket
    ORDER BY groupCode, paxBucket
  `).all(...withSince([branchCode, from, to]));

  const paxByGroup = db.prepare(`
    SELECT groupCode, SUM(COALESCE(pax,0)) AS paxTotal
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate BETWEEN ? AND ?
      AND UPPER(status) <> 'SKIPPED'
      ${sinceSql}
    GROUP BY groupCode
    ORDER BY groupCode
  `).all(...withSince([branchCode, from, to]));

  const paxOverallRow = db.prepare(`
    SELECT SUM(COALESCE(pax,0)) AS paxOverall
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate BETWEEN ? AND ?
      AND UPPER(status) <> 'SKIPPED'
      ${sinceSql}
  `).get(...withSince([branchCode, from, to])) || {};
  const paxOverall = Number(paxOverallRow.paxOverall || 0);

  const prByGroup = db.prepare(`
    SELECT groupCode, COUNT(*) AS priorityCount
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate BETWEEN ? AND ?
      AND UPPER(status) <> 'SKIPPED'
      AND UPPER(COALESCE(priorityType,'NONE')) <> 'NONE'
      ${sinceSql}
    GROUP BY groupCode
    ORDER BY groupCode
  `).all(...withSince([branchCode, from, to]));

  const prTotalRow = db.prepare(`
    SELECT COUNT(*) AS priorityTotal
    FROM queue_items
    WHERE branchCode = ?
      AND businessDate BETWEEN ? AND ?
      AND UPPER(status) <> 'SKIPPED'
      AND UPPER(COALESCE(priorityType,'NONE')) <> 'NONE'
      ${sinceSql}
  `).get(...withSince([branchCode, from, to])) || {};
  const priorityTotal = Number(prTotalRow.priorityTotal || 0);

  const nowMs = Date.now();
  let avgWaitRows = [];
  if (waitRef.type === "hours") {
    const since = nowMs - (waitRef.value * 60 * 60 * 1000);
    avgWaitRows = db.prepare(`
      SELECT groupCode,
             AVG((seatedAt - createdAtLocal)/60000.0) AS avgWaitMins,
             COUNT(*) AS sampleSize
      FROM queue_items
      WHERE branchCode = ?
        AND UPPER(status) = 'SEATED'
        AND createdAtLocal IS NOT NULL
        AND seatedAt IS NOT NULL
        AND seatedAt >= ?
        ${sinceSql}
      GROUP BY groupCode
      ORDER BY groupCode
    `).all(...withSince([branchCode, since]));
  } else {
    const refFrom = addDaysYmd(to, -(waitRef.value - 1));
    avgWaitRows = db.prepare(`
      SELECT groupCode,
             AVG((seatedAt - createdAtLocal)/60000.0) AS avgWaitMins,
             COUNT(*) AS sampleSize
      FROM queue_items
      WHERE branchCode = ?
        AND UPPER(status) = 'SEATED'
        AND createdAtLocal IS NOT NULL
        AND seatedAt IS NOT NULL
        AND businessDate BETWEEN ? AND ?
        ${sinceSql}
      GROUP BY groupCode
      ORDER BY groupCode
    `).all(...withSince([branchCode, refFrom, to]));
  }

  return {
    ok: true,
    branchCode,
    from,
    to,
    waitRef,
    waitlist,
    seatedCounts,
    avgWait: avgWaitRows.map(r => ({
      groupCode: r.groupCode,
      avgWaitMins: r.avgWaitMins == null ? null : Number(r.avgWaitMins),
      sampleSize: Number(r.sampleSize || 0)
    })),
    pax: {
      byGroup: paxByGroup.map(r => ({ groupCode: r.groupCode, paxTotal: Number(r.paxTotal || 0) })),
      overall: paxOverall
    },
    priority: {
      total: priorityTotal,
      byGroup: prByGroup.map(r => ({ groupCode: r.groupCode, priorityCount: Number(r.priorityCount || 0) }))
    }
  };
}

function csvSafePaxBucket(bucket){
  const b = String(bucket || "");
  if (b === "2-3" || b === "4-5") return `="${b}"`;
  return b;
}

// JSON summary endpoint used by on-screen reports preview.
app.get("/api/admin/reports/summary", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
  try {
    const bc = getRequestBranchCode(req);
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const waitRef = parseWaitRef(req.query.waitRef);
    const sinceMs = parseSinceMs(req);
    const out = computeReportSummary(db, bc, from, to, waitRef, sinceMs);
    res.json(Object.assign({ ok: true }, out));
  } catch (e) {
    console.error("[reports/summary]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// CSV summary endpoint with sectioned layout for spreadsheet consumption.
app.get("/api/admin/reports/summary.csv", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
  try {
    const bc = getRequestBranchCode(req);
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const scopeLabel = String(req.query.scopeLabel || "").trim();
    const waitRef = parseWaitRef(req.query.waitRef);
    const sinceMs = parseSinceMs(req);
    const out = computeReportSummary(db, bc, from, to, waitRef, sinceMs);

    const rows = [];
    rows.push(["SECTION", "WAITLIST_COUNT", "", ""]);
    rows.push(["groupCode", "paxBucket", "count", ""]);
    for (const r of out.waitlist) rows.push([r.groupCode, csvSafePaxBucket(r.paxBucket), r.count, ""]);

    rows.push(["SECTION", "SEATED_COUNT", "", ""]);
    rows.push(["groupCode", "paxBucket", "count", ""]);
    for (const r of out.seatedCounts) rows.push([r.groupCode, csvSafePaxBucket(r.paxBucket), r.count, ""]);

    rows.push(["SECTION", "AVG_WAIT", "", ""]);
    rows.push(["groupCode", "avgWaitMins", "sampleSize", "reference"]);
    const refLabel = `${out.waitRef.type}:${out.waitRef.value}`;
    for (const r of out.avgWait) rows.push([r.groupCode, r.avgWaitMins == null ? "" : r.avgWaitMins, r.sampleSize, refLabel]);

    rows.push(["SECTION", "PAX_TOTAL", "", ""]);
    rows.push(["groupCode", "paxTotal", "", ""]);
    for (const r of out.pax.byGroup) rows.push([r.groupCode, r.paxTotal, "", ""]);
    rows.push(["OVERALL", out.pax.overall, "", ""]);

    rows.push(["SECTION", "PRIORITY_COUNT", "", ""]);
    rows.push(["groupCode", "priorityCount", "", ""]);
    for (const r of out.priority.byGroup) rows.push([r.groupCode, r.priorityCount, "", ""]);
    rows.push(["TOTAL", out.priority.total, "", ""]);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName("report_summary", bc, from, to, { scopeLabel })}"`);
    res.send(rowsToCsv([], rows));
  } catch (e) {
    console.error("[reports/summary.csv]", e);
    res.status(500).send("Server error");
  }
});

/* ---------- Admin: Upload / Sync (Google Drive via Service Account or OAuth) ---------- */
  function base64UrlEncode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
    return buf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function getDefaultOAuthRedirectUri() {
    return `http://127.0.0.1:${port}/api/admin/gdrive/oauth/callback`;
  }

  function normalizeDriveFolderId(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const m1 = s.match(/\/folders\/([A-Za-z0-9_-]+)/i);
    if (m1 && m1[1]) return m1[1];
    const m2 = s.match(/[?&]id=([A-Za-z0-9_-]+)/i);
    if (m2 && m2[1]) return m2[1];
    const m3 = s.match(/^([A-Za-z0-9_-]{10,})$/);
    if (m3 && m3[1]) return m3[1];
    return s.replace(/[?#].*$/, "");
  }

  function resolveDriveConfig(overrides = null) {
    const ov = overrides && typeof overrides === "object" ? overrides : {};
    const authModeRaw =
      String(ov.authMode || "").trim() ||
      String(process.env.GDRIVE_AUTH_MODE || "").trim() ||
      String(getAppSetting("gdrive.authMode") || "").trim() ||
      "service_account";
    const authMode = authModeRaw === "oauth" ? "oauth" : "service_account";

    const folderFromEnv =
      String(process.env.GDRIVE_FOLDER_ID || "").trim() ||
      String(process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
    const folderFromSettings = String(getAppSetting("gdrive.folderId") || "").trim();
    const folderFromReq = normalizeDriveFolderId(ov.folderId || "");
    const folderId = folderFromReq || normalizeDriveFolderId(folderFromEnv) || normalizeDriveFolderId(folderFromSettings);

    const jsonInline =
      String(ov.serviceAccountJson || "").trim() ||
      String(process.env.GDRIVE_SERVICE_ACCOUNT_JSON || "").trim() ||
      String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
    const jsonPathFromEnv =
      String(process.env.GDRIVE_SERVICE_ACCOUNT_FILE || "").trim() ||
      String(process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
    const jsonPathFromSettings = String(getAppSetting("gdrive.serviceAccountFile") || "").trim();
    const jsonPathFromReq = String(ov.serviceAccountFile || "").trim();
    const jsonPath = jsonPathFromReq || jsonPathFromEnv || jsonPathFromSettings;

    const oauthClientId =
      String(ov.oauthClientId || "").trim() ||
      String(process.env.GDRIVE_OAUTH_CLIENT_ID || "").trim() ||
      String(getAppSetting("gdrive.oauthClientId") || "").trim();
    const oauthClientSecret =
      String(ov.oauthClientSecret || "").trim() ||
      String(process.env.GDRIVE_OAUTH_CLIENT_SECRET || "").trim() ||
      String(getAppSetting("gdrive.oauthClientSecret") || "").trim();
    const oauthRefreshToken =
      String(ov.oauthRefreshToken || "").trim() ||
      String(process.env.GDRIVE_OAUTH_REFRESH_TOKEN || "").trim() ||
      String(getAppSetting("gdrive.oauthRefreshToken") || "").trim();
    const oauthRedirectUri =
      String(ov.oauthRedirectUri || "").trim() ||
      String(process.env.GDRIVE_OAUTH_REDIRECT_URI || "").trim() ||
      String(getAppSetting("gdrive.oauthRedirectUri") || "").trim() ||
      getDefaultOAuthRedirectUri();

    const folderSource = folderFromReq ? "request" : folderFromEnv ? "env" : folderFromSettings ? "settings" : "missing";
    const serviceAccountSource = jsonInline
      ? (ov.serviceAccountJson ? "request_json" : "env_json")
      : jsonPathFromReq
      ? "request_file"
      : jsonPathFromEnv
      ? "env_file"
      : jsonPathFromSettings
      ? "settings_file"
      : "missing";

    return {
      folderId,
      authMode,
      folderSource,
      jsonInline,
      jsonPath,
      jsonPathFromReq,
      jsonPathFromEnv,
      jsonPathFromSettings,
      serviceAccountSource,
      oauthClientId,
      oauthClientSecret,
      oauthRefreshToken,
      oauthRedirectUri,
    };
  }

  function loadDriveServiceAccountFromConfig(overrides = null) {
    const cfg = resolveDriveConfig(overrides);
    const jsonInline = cfg.jsonInline;
    const jsonPath = cfg.jsonPath;

    let raw = "";
    if (jsonInline) raw = jsonInline;
    else if (jsonPath) {
      if (!fs.existsSync(jsonPath)) {
        throw new Error(`Service account file not found: ${jsonPath}`);
      }
      raw = fs.readFileSync(jsonPath, "utf8");
    } else {
      throw new Error("Missing service account credentials. Set GDRIVE_SERVICE_ACCOUNT_FILE or GDRIVE_SERVICE_ACCOUNT_JSON.");
    }

    let sa;
    try {
      sa = JSON.parse(raw);
    } catch {
      throw new Error("Invalid service account JSON.");
    }

    const clientEmail = String(sa.client_email || "").trim();
    const privateKey = String(sa.private_key || "").replace(/\\n/g, "\n").trim();
    if (!clientEmail || !privateKey) {
      throw new Error("Service account JSON is missing client_email/private_key.");
    }
    return {
      client_email: clientEmail,
      private_key: privateKey,
      private_key_id: sa.private_key_id ? String(sa.private_key_id) : "",
    };
  }

  function httpsRequestBuffer({ method, host, path: reqPath, headers, body, timeoutMs = 30000 }) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method,
          host,
          path: reqPath,
          headers: headers || {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on("data", (d) => chunks.push(d));
          res.on("end", () => {
            resolve({
              status: Number(res.statusCode || 0),
              headers: res.headers || {},
              body: Buffer.concat(chunks),
            });
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("Request timed out.")));
      req.on("error", reject);
      if (body && body.length) req.write(body);
      req.end();
    });
  }

  async function googleServiceAccountAccessToken(scope, overrides = null) {
    const sa = loadDriveServiceAccountFromConfig(overrides);
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: "RS256",
      typ: "JWT",
    };
    if (sa.private_key_id) header.kid = sa.private_key_id;

    const payload = {
      iss: sa.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now - 5,
      exp: now + 3600,
    };

    const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(sa.private_key);
    const assertion = `${unsigned}.${base64UrlEncode(signature)}`;

    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString();

    const tokenResp = await httpsRequestBuffer({
      method: "POST",
      host: "oauth2.googleapis.com",
      path: "/token",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(form),
      },
      body: Buffer.from(form, "utf8"),
    });

    const raw = tokenResp.body.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (tokenResp.status < 200 || tokenResp.status >= 300 || !parsed.access_token) {
      const err = parsed.error_description || parsed.error || raw || `HTTP ${tokenResp.status}`;
      throw new Error(`Google token request failed: ${String(err).slice(0, 300)}`);
    }
    return String(parsed.access_token);
  }

  async function googleOAuthAccessToken(scope, overrides = null) {
    const cfg = resolveDriveConfig(overrides);
    if (!cfg.oauthClientId || !cfg.oauthClientSecret || !cfg.oauthRefreshToken) {
      throw new Error("Missing OAuth credentials. Configure client ID/secret and refresh token.");
    }

    const form = new URLSearchParams({
      client_id: cfg.oauthClientId,
      client_secret: cfg.oauthClientSecret,
      refresh_token: cfg.oauthRefreshToken,
      grant_type: "refresh_token",
    }).toString();

    const tokenResp = await httpsRequestBuffer({
      method: "POST",
      host: "oauth2.googleapis.com",
      path: "/token",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(form),
      },
      body: Buffer.from(form, "utf8"),
    });

    const raw = tokenResp.body.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (tokenResp.status < 200 || tokenResp.status >= 300 || !parsed.access_token) {
      const err = parsed.error_description || parsed.error || raw || `HTTP ${tokenResp.status}`;
      throw new Error(`Google OAuth token refresh failed: ${String(err).slice(0, 300)}`);
    }
    return String(parsed.access_token);
  }

  async function getDriveAccessToken(scope, overrides = null) {
    const cfg = resolveDriveConfig(overrides);
    if (cfg.authMode === "oauth") {
      return googleOAuthAccessToken(scope, overrides);
    }
    return googleServiceAccountAccessToken(scope, overrides);
  }

  async function uploadBufferToDrive({ accessToken, folderId, fileName, mimeType, fileBuffer }) {
    const boundary = `qsys_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = folderId
      ? { name: fileName, parents: [folderId] }
      : { name: fileName };

    const pre =
      `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const post = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(pre, "utf8"),
      fileBuffer,
      Buffer.from(post, "utf8"),
    ]);

    const resp = await httpsRequestBuffer({
      method: "POST",
      host: "www.googleapis.com",
      path: "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      body,
    });

    const raw = resp.body.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (resp.status < 200 || resp.status >= 300 || !parsed.id) {
      const err = parsed.error?.message || raw || `HTTP ${resp.status}`;
      throw new Error(`Drive upload failed for ${fileName}: ${String(err).slice(0, 300)}`);
    }
    return {
      id: String(parsed.id),
      name: String(parsed.name || fileName),
      webViewLink: String(parsed.webViewLink || ""),
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function uploadBufferToDriveWithRetry({ accessToken, folderId, fileName, mimeType, fileBuffer, maxAttempts = 3 }) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await uploadBufferToDrive({ accessToken, folderId, fileName, mimeType, fileBuffer });
      } catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || e || "").toLowerCase();
        const nonRetryable =
          msg.includes("file not found") ||
          msg.includes("not in a shared drive") ||
          msg.includes("insufficient permissions") ||
          msg.includes("invalid") ||
          msg.includes("unauthorized");
        if (nonRetryable || attempt >= maxAttempts) break;
        const waitMs = 600 * Math.pow(2, attempt - 1); // 600ms, 1200ms
        await sleep(waitMs);
      }
    }
    throw lastErr || new Error(`Drive upload failed for ${fileName}`);
  }

  async function getDriveFileMeta({ accessToken, fileId }) {
    const safeId = encodeURIComponent(String(fileId || "").trim());
    const resp = await httpsRequestBuffer({
      method: "GET",
      host: "www.googleapis.com",
      path: `/drive/v3/files/${safeId}?supportsAllDrives=true&fields=id,name,mimeType,driveId,parents`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const raw = resp.body.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (resp.status < 200 || resp.status >= 300 || !parsed.id) {
      const err = parsed.error?.message || raw || `HTTP ${resp.status}`;
      throw new Error(`Failed to read Drive folder metadata: ${String(err).slice(0, 300)}`);
    }
    return parsed;
  }

  function escapeDriveQueryValue(v) {
    return String(v || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  async function findDriveChildFolder({ accessToken, parentId, folderName }) {
    const q = [
      `mimeType='application/vnd.google-apps.folder'`,
      `name='${escapeDriveQueryValue(folderName)}'`,
      `'${escapeDriveQueryValue(parentId)}' in parents`,
      "trashed=false",
    ].join(" and ");
    const reqPath =
      `/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true` +
      `&pageSize=10&fields=files(id,name,mimeType,driveId,parents)` +
      `&q=${encodeURIComponent(q)}`;
    const resp = await httpsRequestBuffer({
      method: "GET",
      host: "www.googleapis.com",
      path: reqPath,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const raw = resp.body.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}
    if (resp.status < 200 || resp.status >= 300) {
      const err = parsed.error?.message || raw || `HTTP ${resp.status}`;
      throw new Error(`Failed to find Drive child folder: ${String(err).slice(0, 300)}`);
    }
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    return files.length ? files[0] : null;
  }

  async function createDriveFolder({ accessToken, parentId, folderName }) {
    const payload = {
      name: String(folderName || "").trim() || "folder",
      mimeType: "application/vnd.google-apps.folder",
      parents: [String(parentId || "").trim()],
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const resp = await httpsRequestBuffer({
      method: "POST",
      host: "www.googleapis.com",
      path: "/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,driveId,parents",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "Content-Length": body.length,
      },
      body,
    });
    const raw = resp.body.toString("utf8");
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}
    if (resp.status < 200 || resp.status >= 300 || !parsed.id) {
      const err = parsed.error?.message || raw || `HTTP ${resp.status}`;
      throw new Error(`Failed to create Drive folder '${folderName}': ${String(err).slice(0, 300)}`);
    }
    return parsed;
  }

  async function ensureDriveChildFolder({ accessToken, parentId, folderName }) {
    const found = await findDriveChildFolder({ accessToken, parentId, folderName });
    if (found && found.id) return { folder: found, created: false };
    const created = await createDriveFolder({ accessToken, parentId, folderName });
    return { folder: created, created: true };
  }

  async function getDriveAbout({ accessToken }) {
    const resp = await httpsRequestBuffer({
      method: "GET",
      host: "www.googleapis.com",
      path: "/drive/v3/about?fields=user(displayName,emailAddress)&supportsAllDrives=true",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const raw = resp.body.toString("utf8");
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}
    if (resp.status < 200 || resp.status >= 300) {
      const err = parsed.error?.message || raw || `HTTP ${resp.status}`;
      throw new Error(`Failed to read Drive account info: ${String(err).slice(0, 240)}`);
    }
    return parsed;
  }

  function buildTicketsCsvForRange(from, to, sinceMs, branchCodeArg) {
    const bc = String(branchCodeArg || getBranchCode()).trim();
    const hasTimestamp = tableHasColumn(db, "queue_items", "timestamp");
    const createdExpr = hasTimestamp ? "COALESCE(timestamp, createdAtLocal)" : "createdAtLocal";
    const sinceSql = sinceMs ? ` AND ${createdExpr} >= ?` : "";
    const params = sinceMs ? [bc, from, to, sinceMs] : [bc, from, to];
    const rows = db
      .prepare(
        `SELECT id, branchCode, businessDate, groupCode, queueNum, priorityType, name, pax, status,
                createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
         FROM queue_items
         WHERE branchCode=? AND businessDate BETWEEN ? AND ?
         ${sinceSql}
         ORDER BY businessDate ASC,
           CASE groupCode WHEN 'P' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 9 END,
           queueNum ASC`
      )
      .all(...params);

    function fmtTs(ms) {
      if (ms === null || ms === undefined || ms === "") return "";
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return "";
      return new Date(n).toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
    }
    function minsDiff(startMs, endMs) {
      const s = Number(startMs);
      const e = Number(endMs);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s <= 0 || e <= 0) return "";
      const mins = (e - s) / 60000;
      if (!Number.isFinite(mins) || mins < 0) return "";
      return Math.round(mins * 10) / 10;
    }

    function timesCalled(row) {
      if (!row || !row.calledAt) return 0;
      const next = String(row.next_calls || "").trim();
      if (!next) return 1;
      const extra = next.split(",").map((s) => s.trim()).filter(Boolean).length;
      return 1 + extra;
    }

    const header = [
      "schemaVersion",
      "branchCode",
      "businessDate",
      "ticketId",
      "groupCode",
      "queueNum",
      "priorityType",
      "name",
      "pax",
      "status",
      "createdAtLocalHuman",
      "calledAtHuman",
      "timesCalled",
      "nextCalls",
      "seatedAtHuman",
      "skippedAtHuman",
      "calledNote",
      "waitMinsToCalled",
      "waitMinsToSeated",
    ];
    const outRows = rows.map((r) => [
      1,
      r.branchCode,
      r.businessDate,
      r.id,
      r.groupCode,
      r.queueNum,
      r.priorityType,
      r.name,
      r.pax,
      r.status,
      fmtTs(r.createdAtLocal),
      fmtTs(r.calledAt),
      timesCalled(r),
      r.calledAt ? formatReCallTimes(r.next_calls) : "",
      fmtTs(r.seatedAt),
      fmtTs(r.skippedAt),
      r.calledNote || "",
      minsDiff(r.createdAtLocal, r.calledAt),
      minsDiff(r.createdAtLocal, r.seatedAt),
    ]);
    return rowsToCsv(header, outRows);
  }

  function buildDailySummaryCsvForRange(from, to, sinceMs, branchCodeArg) {
    const bc = String(branchCodeArg || getBranchCode()).trim();
    const { effectiveFrom, rows } = getDailySummaryRowsWithFallback(bc, from, to, sinceMs);
    const emaFrom = addDaysYmd(effectiveFrom, -13);
    const emaHistory = getDailySummaryRowsWithFallback(bc, emaFrom, to, null).rows;
    const emaLookup = buildDailyEmaLookup(emaHistory);
    const header = [
      "schemaVersion",
      "branchCode",
      "businessDate",
      "groupCode",
      "registeredCount",
      "calledCount",
      "seatedCount",
      "skippedCount",
      "overrideCalledCount",
      "avgWaitMinutes",
      "ema14WaitMinutes",
    ];
    const outRows = [];
    for (const r of rows) {
      const avg = r.waitCount && r.waitCount > 0 ? Number(r.waitSumMinutes) / Number(r.waitCount) : null;
      const ema = emaLookup.get(`${r.businessDate}__${r.groupCode}`);
      outRows.push([
        1,
        bc,
        r.businessDate,
        r.groupCode,
        r.registeredCount,
        r.calledCount,
        r.seatedCount,
        r.skippedCount,
        r.overrideCalledCount,
        avg === null ? "" : Math.round(avg),
        ema === null ? "" : Math.round(ema),
      ]);
    }
    return rowsToCsv(header, outRows);
  }

  function buildDailySummaryRowsForRange(from, to, sinceMs, branchCodeArg) {
    const bc = String(branchCodeArg || getBranchCode()).trim();
    const { effectiveFrom, rows } = getDailySummaryRowsWithFallback(bc, from, to, sinceMs);
    const emaFrom = addDaysYmd(effectiveFrom, -13);
    const emaHistory = getDailySummaryRowsWithFallback(bc, emaFrom, to, null).rows;
    const emaLookup = buildDailyEmaLookup(emaHistory);

    return rows.map((r) => {
      const avg = r.waitCount && r.waitCount > 0 ? Number(r.waitSumMinutes) / Number(r.waitCount) : null;
      const ema = emaLookup.get(`${r.businessDate}__${r.groupCode}`);
      return {
        businessDate: r.businessDate,
        groupCode: r.groupCode,
        registeredCount: Number(r.registeredCount || 0),
        calledCount: Number(r.calledCount || 0),
        seatedCount: Number(r.seatedCount || 0),
        skippedCount: Number(r.skippedCount || 0),
        overrideCalledCount: Number(r.overrideCalledCount || 0),
        avgWaitMinutes: avg === null ? "" : Math.round(avg),
        ema14WaitMinutes: ema === null ? "" : Math.round(ema),
      };
    });
  }

  function htmlEscape(v) {
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildDailySummaryHtmlForRange(from, to, sinceMs, branchCodeArg) {
    const bc = String(branchCodeArg || getBranchCode()).trim();
    const rows = buildDailySummaryRowsForRange(from, to, sinceMs, bc);
    const generatedAt = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", hour12: true });

    const body = [];
    let prevDate = "";
    for (const r of rows) {
      if (r.businessDate !== prevDate) {
        body.push(
          `<tr class="date-break"><td colspan="9">Date: ${htmlEscape(r.businessDate)}</td></tr>`
        );
        prevDate = r.businessDate;
      }
      body.push(
        `<tr>` +
          `<td class="muted">-</td>` +
          `<td>${htmlEscape(r.groupCode)}</td>` +
          `<td class="num">${htmlEscape(r.registeredCount)}</td>` +
          `<td class="num">${htmlEscape(r.calledCount)}</td>` +
          `<td class="num">${htmlEscape(r.seatedCount)}</td>` +
          `<td class="num">${htmlEscape(r.skippedCount)}</td>` +
          `<td class="num">${htmlEscape(r.overrideCalledCount)}</td>` +
          `<td class="num">${htmlEscape(r.avgWaitMinutes)}</td>` +
          `<td class="num">${htmlEscape(r.ema14WaitMinutes)}</td>` +
        `</tr>`
      );
    }

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily Summary - ${htmlEscape(bc)} - ${htmlEscape(from)} to ${htmlEscape(to)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #1f2937; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    .meta { color: #4b5563; margin-bottom: 14px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; font-size: 13px; }
    th { background: #f9fafb; position: sticky; top: 0; }
    .date-break td { background: #f3f4f6; font-weight: 700; border-top: 2px solid #d1d5db; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .muted { color: #9ca3af; }
  </style>
</head>
<body>
  <h1>Daily Summary</h1>
  <div class="meta">Branch: ${htmlEscape(bc)} | Scope: ${htmlEscape(from)} to ${htmlEscape(to)} | Generated: ${htmlEscape(generatedAt)}</div>
  <table>
    <thead>
      <tr>
        <th>Business Date</th>
        <th>Group</th>
        <th>Registered</th>
        <th>Called</th>
        <th>Seated</th>
        <th>Skipped</th>
        <th>Override Called</th>
        <th>Avg Wait (mins)</th>
        <th>EMA14 Wait (mins)</th>
      </tr>
    </thead>
    <tbody>
      ${body.join("") || `<tr><td colspan="9">No data in selected scope.</td></tr>`}
    </tbody>
  </table>
</body>
</html>`;
  }

  function buildCustomSummaryCsvForRange(from, to, sinceMs, branchCodeArg) {
    const result = buildCustomSummary(from, to, sinceMs, branchCodeArg);
    const header = [
      "GROUP CODE",
      "Total Reservations (all created tickets)",
      "Total Pax count reserved",
      "Total Priority Reservations",
      "Seated Count - group",
      "Seated Count - total pax count",
      "Waiting Time to be called - Average (mins)",
      "Waiting Time to be seated - Average (mins)",
    ];
    const outRows = result.rows.map((r) => [
      r.groupCode,
      r.waitlistCount,
      r.totalPax,
      r.priorityCount,
      r.seatedCount,
      r.seatedPax,
      r.avgToCalledMins,
      r.avgToSeatedMins,
    ]);
    return rowsToCsv(header, outRows);
  }

  function buildReportSummaryCsvForRange(from, to, waitRef, sinceMs, branchCodeArg) {
    const bc = String(branchCodeArg || getBranchCode()).trim();
    const out = computeReportSummary(db, bc, from, to, waitRef, sinceMs);
    const rows = [];
    rows.push(["SECTION", "WAITLIST_COUNT", "", ""]);
    rows.push(["groupCode", "paxBucket", "count", ""]);
    for (const r of out.waitlist) rows.push([r.groupCode, csvSafePaxBucket(r.paxBucket), r.count, ""]);
    rows.push(["SECTION", "SEATED_COUNT", "", ""]);
    rows.push(["groupCode", "paxBucket", "count", ""]);
    for (const r of out.seatedCounts) rows.push([r.groupCode, csvSafePaxBucket(r.paxBucket), r.count, ""]);
    rows.push(["SECTION", "AVG_WAIT", "", ""]);
    rows.push(["groupCode", "avgWaitMins", "sampleSize", "reference"]);
    const refLabel = `${out.waitRef.type}:${out.waitRef.value}`;
    for (const r of out.avgWait) rows.push([r.groupCode, r.avgWaitMins == null ? "" : r.avgWaitMins, r.sampleSize, refLabel]);
    rows.push(["SECTION", "PAX_TOTAL", "", ""]);
    rows.push(["groupCode", "paxTotal", "", ""]);
    for (const r of out.pax.byGroup) rows.push([r.groupCode, r.paxTotal, "", ""]);
    rows.push(["OVERALL", out.pax.overall, "", ""]);
    rows.push(["SECTION", "PRIORITY_COUNT", "", ""]);
    rows.push(["groupCode", "priorityCount", "", ""]);
    for (const r of out.priority.byGroup) rows.push([r.groupCode, r.priorityCount, "", ""]);
    rows.push(["TOTAL", out.priority.total, "", ""]);
    return rowsToCsv([], rows);
  }

  const REPORT_SCHEDULE_CONFIG_KEY = "reports.schedule.configJson";
  const REPORT_SCHEDULE_LAST_RESULT_KEY = "reports.schedule.lastResultJson";

  function queryAuditRowsForRange(from, to, sinceMs) {
    let fromMs = manilaDayStartMs(from);
    const toMs = manilaDayEndMs(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error("invalid from/to");
    if (sinceMs) fromMs = Math.max(fromMs, sinceMs);
    return db.prepare(
      `SELECT action, payload, createdAt
       FROM audit_logs
       WHERE createdAt BETWEEN ? AND ?
       ORDER BY createdAt ASC`
    ).all(fromMs, toMs);
  }

  function buildAuditLogsCsvForRange(from, to, sinceMs, branchCodeArg) {
    const bc = String(branchCodeArg || getBranchCode()).trim();
    const rows = queryAuditRowsForRange(from, to, sinceMs);
    const header = ["schemaVersion", "branchCode", "createdAt", "action", "userId", "fullName", "roleId", "businessDate", "payloadJson"];
    const outRows = [];
    for (const r of rows) {
      let actor = null;
      let biz = "";
      try {
        const p = JSON.parse(r.payload || "{}");
        actor = p && p.actor ? p.actor : null;
        if (p.businessDate) biz = String(p.businessDate);
      } catch {}
      outRows.push([
        1,
        bc,
        r.createdAt,
        r.action,
        actor?.userId || "",
        actor?.fullName || "",
        actor?.roleId || "",
        biz,
        r.payload,
      ]);
    }
    return rowsToCsv(header, outRows);
  }

  function buildStructuredAuditExportCsvForRange(from, to, sinceMs, branchCodeArg) {
    const bc = String(branchCodeArg || getBranchCode()).trim();
    const rows = queryAuditRowsForRange(from, to, sinceMs);
    const header = [
      "schemaVersion",
      "branchCode",
      "createdAt",
      "action",
      "actorName",
      "actorRole",
      "businessDate",
      "installId",
      "licenseId",
      "reportKey",
      "targetFile",
      "error",
      "reason",
      "payloadJson",
    ];
    const outRows = rows.map((r) => {
      let payload = {};
      try { payload = JSON.parse(r.payload || "{}"); } catch {}
      const actor = payload && payload.actor ? payload.actor : null;
      return [
        1,
        bc,
        r.createdAt,
        r.action,
        actor?.fullName || actor?.userId || "",
        actor?.roleId || "",
        String(payload.businessDate || ""),
        String(payload.installId || payload.previousInstallId || ""),
        String(payload.licenseId || ""),
        String(payload.reportKey || ""),
        String(payload.fileName || payload.filePath || payload.exportPath || ""),
        String(payload.error || ""),
        String(payload.reason || payload.previousStatus || ""),
        r.payload,
      ];
    });
    return rowsToCsv(header, outRows);
  }

  function collectExportableReportFiles({ from, to, sinceMs = null, scopeLabel = "", waitRef = parseWaitRef("hours:2"), reportKeys = [], includeDailyHtml = false, branchCode = "" } = {}) {
    const bc = String(branchCode || getBranchCode()).trim();
    const wanted = new Set((Array.isArray(reportKeys) ? reportKeys : []).map((v) => String(v || "").trim()).filter(Boolean));
    const include = (k) => wanted.size === 0 || wanted.has(k);
    const stamp = fileStampNow();
    const files = [];
    if (include("tickets")) {
      files.push({
        key: "tickets",
        name: reportFileName("tickets", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
        mimeType: "text/csv",
        data: Buffer.from(buildTicketsCsvForRange(from, to, sinceMs, bc), "utf8"),
      });
    }
    if (include("daily_summary_csv")) {
      files.push({
        key: "daily_summary_csv",
        name: reportFileName("daily_summary", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
        mimeType: "text/csv",
        data: Buffer.from(buildDailySummaryCsvForRange(from, to, sinceMs, bc), "utf8"),
      });
    }
    if (include("daily_summary_html") && includeDailyHtml) {
      files.push({
        key: "daily_summary_html",
        name: reportFileName("daily_summary_formatted", bc, from, to, { scopeLabel, stamp, ext: "html" }),
        mimeType: "text/html",
        data: Buffer.from(buildDailySummaryHtmlForRange(from, to, sinceMs, bc), "utf8"),
      });
    }
    if (include("custom_summary")) {
      files.push({
        key: "custom_summary",
        name: reportFileName("custom_summary", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
        mimeType: "text/csv",
        data: Buffer.from(buildCustomSummaryCsvForRange(from, to, sinceMs, bc), "utf8"),
      });
    }
    if (include("summary")) {
      files.push({
        key: "summary",
        name: reportFileName("report_summary", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
        mimeType: "text/csv",
        data: Buffer.from(buildReportSummaryCsvForRange(from, to, waitRef, sinceMs, bc), "utf8"),
      });
    }
    if (include("audit_logs")) {
      files.push({
        key: "audit_logs",
        name: reportFileName("audit_logs", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
        mimeType: "text/csv",
        data: Buffer.from(buildAuditLogsCsvForRange(from, to, sinceMs, bc), "utf8"),
      });
    }
    if (include("audit_export")) {
      files.push({
        key: "audit_export",
        name: reportFileName("audit_export", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
        mimeType: "text/csv",
        data: Buffer.from(buildStructuredAuditExportCsvForRange(from, to, sinceMs, bc), "utf8"),
      });
    }
    return files;
  }

  function computeHistoricalInsights(days = 30, branchCodeArg) {
    const branchCode = String(branchCodeArg || getBranchCode()).trim();
    const safeDays = Math.max(7, Math.min(Number(days) || 30, 180));
    const to = ensureBusinessDate(db);
    const currentFrom = addDaysYmd(to, -(safeDays - 1));
    const compareFrom = addDaysYmd(to, -((safeDays * 2) - 1));
    const rows = buildDailySummaryRowsForRange(compareFrom, to, null, branchCode);
    const perDay = new Map();
    const perGroup = new Map();
    for (const row of rows) {
      const dateKey = String(row.businessDate || "");
      const groupKey = String(row.groupCode || "");
      if (!perDay.has(dateKey)) {
        perDay.set(dateKey, {
          businessDate: dateKey,
          registeredCount: 0,
          calledCount: 0,
          seatedCount: 0,
          skippedCount: 0,
          overrideCalledCount: 0,
          waitWeightedSum: 0,
          waitWeight: 0,
        });
      }
      const daily = perDay.get(dateKey);
      daily.registeredCount += Number(row.registeredCount || 0);
      daily.calledCount += Number(row.calledCount || 0);
      daily.seatedCount += Number(row.seatedCount || 0);
      daily.skippedCount += Number(row.skippedCount || 0);
      daily.overrideCalledCount += Number(row.overrideCalledCount || 0);
      const avgWait = Number(row.avgWaitMinutes);
      const weight = Number(row.seatedCount || 0);
      if (Number.isFinite(avgWait) && weight > 0) {
        daily.waitWeightedSum += avgWait * weight;
        daily.waitWeight += weight;
      }

      if (!perGroup.has(groupKey)) {
        perGroup.set(groupKey, {
          groupCode: groupKey,
          registeredCount: 0,
          seatedCount: 0,
          skippedCount: 0,
        });
      }
      const grp = perGroup.get(groupKey);
      grp.registeredCount += Number(row.registeredCount || 0);
      grp.seatedCount += Number(row.seatedCount || 0);
      grp.skippedCount += Number(row.skippedCount || 0);
    }

    const dailyRows = Array.from(perDay.values())
      .sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)))
      .map((row) => ({
        businessDate: row.businessDate,
        registeredCount: row.registeredCount,
        calledCount: row.calledCount,
        seatedCount: row.seatedCount,
        skippedCount: row.skippedCount,
        overrideCalledCount: row.overrideCalledCount,
        avgWaitMinutes: row.waitWeight > 0 ? Math.round((row.waitWeightedSum / row.waitWeight) * 10) / 10 : null,
      }));

    const currentWindow = dailyRows.slice(-safeDays);
    const previousWindow = dailyRows.slice(-(safeDays * 2), -safeDays);
    const hasFullComparisonWindow = previousWindow.length >= safeDays;

    const totalRegistered = currentWindow.reduce((sum, row) => sum + Number(row.registeredCount || 0), 0);
    const totalSeated = currentWindow.reduce((sum, row) => sum + Number(row.seatedCount || 0), 0);
    const totalSkipped = currentWindow.reduce((sum, row) => sum + Number(row.skippedCount || 0), 0);
    const totalCalled = currentWindow.reduce((sum, row) => sum + Number(row.calledCount || 0), 0);
    const weightedWait = currentWindow.reduce((sum, row) => {
      const avg = Number(row.avgWaitMinutes);
      const weight = Number(row.seatedCount || 0);
      return sum + (Number.isFinite(avg) && weight > 0 ? avg * weight : 0);
    }, 0);
    const waitWeight = currentWindow.reduce((sum, row) => sum + Number(row.seatedCount || 0), 0);
    const overallAvgWait = waitWeight > 0 ? Math.round((weightedWait / waitWeight) * 10) / 10 : null;
    const sumWindow = (rowsForWindow) => ({
      registeredCount: rowsForWindow.reduce((sum, row) => sum + Number(row.registeredCount || 0), 0),
      calledCount: rowsForWindow.reduce((sum, row) => sum + Number(row.calledCount || 0), 0),
      seatedCount: rowsForWindow.reduce((sum, row) => sum + Number(row.seatedCount || 0), 0),
      skippedCount: rowsForWindow.reduce((sum, row) => sum + Number(row.skippedCount || 0), 0),
      avgWaitMinutes: (() => {
        const sumWeighted = rowsForWindow.reduce((sum, row) => {
          const avg = Number(row.avgWaitMinutes);
          const weight = Number(row.seatedCount || 0);
          return sum + (Number.isFinite(avg) && weight > 0 ? avg * weight : 0);
        }, 0);
        const sumWeight = rowsForWindow.reduce((sum, row) => sum + Number(row.seatedCount || 0), 0);
        return sumWeight > 0 ? Math.round((sumWeighted / sumWeight) * 10) / 10 : null;
      })(),
    });
    const currentPeriod = sumWindow(currentWindow);
    const previousPeriod = sumWindow(previousWindow);
    const pctDelta = (current, previous) => {
      const c = Number(current || 0);
      const p = Number(previous || 0);
      if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
      if (p === 0) return c === 0 ? 0 : null;
      return Math.round(((c - p) / p) * 1000) / 10;
    };

    return {
      branchCode,
      from: currentFrom,
      to,
      days: safeDays,
      availableHistoryDays: dailyRows.length,
      previousWindowDays: previousWindow.length,
      hasFullComparisonWindow,
      comparisonLabel: hasFullComparisonWindow
        ? `Compared with the previous ${safeDays}-day window`
        : `Only ${dailyRows.length} day(s) of history are available, so a full previous ${safeDays}-day comparison is not yet possible`,
      overview: {
        totalRegistered,
        totalCalled,
        totalSeated,
        totalSkipped,
        overallAvgWait,
        seatedRatePct: totalRegistered > 0 ? Math.round((totalSeated / totalRegistered) * 1000) / 10 : 0,
        skipRatePct: totalRegistered > 0 ? Math.round((totalSkipped / totalRegistered) * 1000) / 10 : 0,
      },
      trend: {
        currentPeriod,
        previousPeriod,
        registeredDeltaPct: pctDelta(currentPeriod.registeredCount, previousPeriod.registeredCount),
        calledDeltaPct: pctDelta(currentPeriod.calledCount, previousPeriod.calledCount),
        seatedDeltaPct: pctDelta(currentPeriod.seatedCount, previousPeriod.seatedCount),
        skipDeltaPct: pctDelta(currentPeriod.skippedCount, previousPeriod.skippedCount),
        avgWaitDeltaMins: (Number(currentPeriod.avgWaitMinutes || 0) - Number(previousPeriod.avgWaitMinutes || 0)) || 0,
      },
      topGroups: Array.from(perGroup.values())
        .sort((a, b) => Number(b.registeredCount || 0) - Number(a.registeredCount || 0))
        .slice(0, 5),
      dailyRows,
    };
  }

  function safeParseJson(text, fallback = null) {
    try {
      return JSON.parse(String(text || ""));
    } catch {
      return fallback;
    }
  }

  function normalizeScheduledReportKeys(keys) {
    const allowed = new Set(["tickets", "daily_summary_csv", "custom_summary", "summary", "audit_logs", "audit_export"]);
    const out = [];
    for (const key of Array.isArray(keys) ? keys : []) {
      const normalized = String(key || "").trim();
      if (allowed.has(normalized) && !out.includes(normalized)) out.push(normalized);
    }
    return out.length ? out : ["daily_summary_csv"];
  }

  function normalizeScheduledReportConfig(raw) {
    const cfg = raw && typeof raw === "object" ? raw : {};
    const frequency = String(cfg.frequency || "daily").trim().toLowerCase() === "hourly" ? "hourly" : "daily";
    const scopePresetRaw = String(cfg.scopePreset || "yesterday").trim().toLowerCase();
    const scopePreset = ["today", "yesterday", "last7", "month_to_date"].includes(scopePresetRaw) ? scopePresetRaw : "yesterday";
    return {
      enabled: !!cfg.enabled,
      frequency,
      hourLocal: Math.max(0, Math.min(Number(cfg.hourLocal) || 6, 23)),
      minuteLocal: Math.max(0, Math.min(Number(cfg.minuteLocal) || 0, 59)),
      scopePreset,
      reportKeys: normalizeScheduledReportKeys(cfg.reportKeys),
      exportFolder: String(cfg.exportFolder || "").trim(),
    };
  }

  function getScheduledReportConfig() {
    return normalizeScheduledReportConfig(safeParseJson(getAppSetting(REPORT_SCHEDULE_CONFIG_KEY), {}));
  }

  function getScheduledReportLastResult() {
    return safeParseJson(getAppSetting(REPORT_SCHEDULE_LAST_RESULT_KEY), null);
  }

  function resolveScheduledReportFolder(config) {
    const explicit = String(config.exportFolder || "").trim();
    return explicit || path.join(baseDir, "reports", "scheduled");
  }

  function computeScheduledReportScope(scopePreset) {
    const today = ensureBusinessDate(db);
    if (scopePreset === "today") {
      return { from: today, to: today, scopeLabel: "Scheduled Today" };
    }
    if (scopePreset === "last7") {
      return { from: addDaysYmd(today, -6), to: today, scopeLabel: "Scheduled Last 7 Days" };
    }
    if (scopePreset === "month_to_date") {
      return { from: `${String(today).slice(0, 8)}01`, to: today, scopeLabel: "Scheduled Month-to-date" };
    }
    const y = addDaysYmd(today, -1);
    return { from: y, to: y, scopeLabel: "Scheduled Yesterday" };
  }

  function getScheduleDueMarker(config, now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hour = now.getHours();
    const minute = now.getMinutes();
    const ymd = `${y}-${m}-${d}`;
    if (config.frequency === "hourly") {
      if (minute < Number(config.minuteLocal || 0)) return null;
      return `${ymd}T${String(hour).padStart(2, "0")}:${String(config.minuteLocal).padStart(2, "0")}`;
    }
    const targetHour = Number(config.hourLocal || 0);
    const targetMinute = Number(config.minuteLocal || 0);
    if (hour < targetHour) return null;
    if (hour === targetHour && minute < targetMinute) return null;
    return `${ymd}T${String(targetHour).padStart(2, "0")}:${String(targetMinute).padStart(2, "0")}`;
  }

  function getScheduledReportState() {
    const config = getScheduledReportConfig();
    const lastResult = getScheduledReportLastResult();
    return {
      config,
      lastResult,
      exportFolder: resolveScheduledReportFolder(config),
      availableReportKeys: [
        { key: "tickets", label: "Tickets CSV" },
        { key: "daily_summary_csv", label: "Daily Summary CSV" },
        { key: "custom_summary", label: "Custom Summary CSV" },
        { key: "summary", label: "Report Summary CSV" },
        { key: "audit_logs", label: "Audit Logs CSV" },
        { key: "audit_export", label: "Audit Export CSV" },
      ],
    };
  }

  let scheduledReportsInProgress = false;
  async function runScheduledReportExport(trigger = "manual", actor = "SYSTEM") {
    if (scheduledReportsInProgress) {
      return { ok: false, skipped: true, reason: "in_progress" };
    }
    const config = getScheduledReportConfig();
    if (!config.enabled && trigger === "timer") {
      return { ok: false, skipped: true, reason: "disabled" };
    }
    if (trigger === "timer" && !isFeatureProvisioned("reporting.scheduled_csv")) {
      return { ok: false, skipped: true, reason: "feature_disabled" };
    }
    const marker = trigger === "timer" ? getScheduleDueMarker(config) : `manual_${Date.now()}`;
    const lastResult = getScheduledReportLastResult();
    if (trigger === "timer" && !marker) {
      return { ok: false, skipped: true, reason: "not_due" };
    }
    if (trigger === "timer" && String(lastResult?.runMarker || "") === String(marker || "")) {
      return { ok: false, skipped: true, reason: "already_ran" };
    }

    scheduledReportsInProgress = true;
    try {
      const scope = computeScheduledReportScope(config.scopePreset);
      const exportFolder = resolveScheduledReportFolder(config);
      const folderStamp = fileStampNow();
      const targetFolder = path.join(exportFolder, folderStamp);
      fs.mkdirSync(targetFolder, { recursive: true });
      const waitRef = parseWaitRef("hours:2");
      const files = collectExportableReportFiles({
        from: scope.from,
        to: scope.to,
        sinceMs: null,
        scopeLabel: scope.scopeLabel,
        waitRef,
        reportKeys: config.reportKeys,
      });
      const written = [];
      for (const file of files) {
        const outPath = path.join(targetFolder, file.name);
        fs.writeFileSync(outPath, file.data);
        written.push({
          key: file.key,
          fileName: file.name,
          filePath: outPath,
          sizeBytes: Buffer.byteLength(file.data),
        });
      }
      const result = {
        ok: true,
        trigger,
        runMarker: marker,
        startedAt: Date.now(),
        from: scope.from,
        to: scope.to,
        scopeLabel: scope.scopeLabel,
        exportFolder: targetFolder,
        files: written,
      };
      setAppSetting(REPORT_SCHEDULE_LAST_RESULT_KEY, JSON.stringify(result));
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "REPORT_SCHEDULED_EXPORT_RUN",
        JSON.stringify({
          actor,
          trigger,
          runMarker: marker,
          from: scope.from,
          to: scope.to,
          scopeLabel: scope.scopeLabel,
          exportFolder: targetFolder,
          files: written,
        }),
        Date.now(),
      );
      return result;
    } finally {
      scheduledReportsInProgress = false;
    }
  }

  function getUploadConfigStatus() {
    const cfg = resolveDriveConfig();
    const folderId = cfg.folderId;
    const jsonInline = cfg.jsonInline;
    const jsonPath = cfg.jsonPath;
    const fileExists = jsonPath ? fs.existsSync(jsonPath) : false;
    const oauthReady = !!cfg.oauthClientId && !!cfg.oauthClientSecret && !!cfg.oauthRefreshToken;
    const lastSync = safeParseJson(getAppSetting("upload.lastResultJson"), null);
    const ready =
      !!folderId &&
      (cfg.authMode === "oauth" ? oauthReady : (!!jsonInline || fileExists));

    return {
      authMode: cfg.authMode,
      folderIdSet: !!folderId,
      folderId,
      folderSource: cfg.folderSource,
      serviceAccountSource: cfg.serviceAccountSource,
      serviceAccountFile: jsonPath || "",
      serviceAccountFileExists: fileExists,
      oauth: {
        clientIdSet: !!cfg.oauthClientId,
        clientSecretSet: !!cfg.oauthClientSecret,
        refreshTokenSet: !!cfg.oauthRefreshToken,
        redirectUri: cfg.oauthRedirectUri,
      },
      ready,
      lastSync,
    };
  }

  app.get("/api/admin/upload/status", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    try {
      const cfg = getUploadConfigStatus();
      return res.json({ ok: true, config: cfg });
    } catch (e) {
      console.error("[admin/upload/status]", e);
      return res.status(500).json({ ok: false, error: "Failed to load upload status." });
    }
  });

  app.post("/api/admin/upload/test", requirePerm("SETTINGS_MANAGE"), async (req, res) => {
    try {
      const cfg = resolveDriveConfig(req.body || {});
      const folderId = normalizeDriveFolderId(cfg.folderId || "");
      if (!folderId) {
        return res.status(400).json({ ok: false, error: "Missing Google Drive folder ID." });
      }

      const accessToken = await getDriveAccessToken("https://www.googleapis.com/auth/drive.file", req.body || {});
      let folderMeta;
      try {
        folderMeta = await getDriveFileMeta({ accessToken, fileId: folderId });
      } catch (e) {
        let about = null;
        try { about = await getDriveAbout({ accessToken }); } catch {}
        return res.status(400).json({
          ok: false,
          error: String((e && e.message) || e || "Failed to read Drive folder metadata."),
          diagnostics: {
            authMode: cfg.authMode,
            folderIdInput: String((req.body && req.body.folderId) || cfg.folderId || ""),
            folderIdNormalized: folderId,
            oauthUserEmail: String(about?.user?.emailAddress || ""),
            oauthUserName: String(about?.user?.displayName || ""),
            hints: [
              "Ensure this exact folder is accessible by the connected Google account.",
              "If you pasted a full URL, re-save folder using only ID or /folders/<id> URL.",
              "If this is a Shared Drive folder, verify the connected account is a member.",
            ],
          },
        });
      }
      if (cfg.authMode === "service_account" && !folderMeta.driveId) {
        return res.status(400).json({
          ok: false,
          error: "Target folder is not in a Shared Drive. Service-account uploads require Shared Drive for this setup.",
          folderMeta: {
            id: String(folderMeta.id || folderId),
            name: String(folderMeta.name || ""),
            mimeType: String(folderMeta.mimeType || ""),
            driveId: "",
          },
        });
      }
      const ts = Date.now();
      const fileName = `qsys_sync_test_${ts}.txt`;
      const content = Buffer.from(`QSys Google Drive sync test\nTimestamp: ${ts}\n`, "utf8");
      const uploaded = await uploadBufferToDrive({
        accessToken,
        folderId,
        fileName,
        mimeType: "text/plain",
        fileBuffer: content,
      });

      return res.json({
        ok: true,
        message: "Connection test succeeded.",
        authMode: cfg.authMode,
        folderMeta: {
          id: String(folderMeta.id || folderId),
          name: String(folderMeta.name || ""),
          driveId: String(folderMeta.driveId || ""),
        },
        uploaded,
      });
    } catch (e) {
      console.error("[admin/upload/test]", e);
      return res.status(500).json({
        ok: false,
        error: String((e && e.message) || e || "Connection test failed."),
      });
    }
  });

  app.get("/api/admin/reports/analytics", requirePerm("REPORT_EXPORT_CSV"), requireProvisionedFeatureApi("reporting.advanced_center", "reporting.historical_analytics", "reporting.branch_trends"), (req, res) => {
    try {
      const days = Number(req.query.days || 30) || 30;
      const insights = computeHistoricalInsights(days, getRequestBranchCode(req));
      return res.json({ ok: true, insights });
    } catch (e) {
      console.error("[reports/analytics]", e);
      return res.status(500).json({ ok: false, error: "Failed to load report analytics." });
    }
  });

  app.get("/api/admin/reports/schedule", requirePerm("REPORT_EXPORT_CSV"), requireProvisionedFeatureApi("reporting.scheduled_csv"), (_req, res) => {
    try {
      return res.json({ ok: true, schedule: getScheduledReportState() });
    } catch (e) {
      console.error("[reports/schedule/get]", e);
      return res.status(500).json({ ok: false, error: "Failed to load scheduled report settings." });
    }
  });

  const handleScheduledReportFolderSelect = async (req, res) => {
    try {
      let dialog, BrowserWindow;
      try {
        const electron = require("electron");
        dialog = electron.dialog;
        BrowserWindow = electron.BrowserWindow;
      } catch {
        return res.status(400).json({ ok: false, error: "Folder picker requires Electron." });
      }
      if (!dialog) {
        return res.status(400).json({ ok: false, error: "Electron dialog is not available." });
      }
      const win = (() => {
        try {
          const wins = (BrowserWindow && BrowserWindow.getAllWindows) ? BrowserWindow.getAllWindows() : [];
          const adminWin = wins.find((w) => {
            try {
              const url = w.webContents && w.webContents.getURL ? w.webContents.getURL() : "";
              return String(url).includes("/admin") || String(url).includes("admin.html");
            } catch {
              return false;
            }
          });
          if (adminWin) return adminWin;
          return (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow()) || wins[0] || null;
        } catch {
          return null;
        }
      })();
      const result = await dialog.showOpenDialog(win || undefined, {
        title: "Choose Scheduled Reports Folder",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled) return res.json({ ok: true, canceled: true });
      const folder = String(result.filePaths?.[0] || "").trim();
      if (!folder) return res.status(400).json({ ok: false, error: "No folder selected." });
      return res.json({ ok: true, folder });
    } catch (e) {
      console.error("[reports/schedule/folder/select]", e);
      return res.status(500).json({ ok: false, error: "Failed to open folder picker." });
    }
  };

  app.post("/api/admin/reports/schedule/folder/select", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("reporting.scheduled_csv"), handleScheduledReportFolderSelect);
  app.get("/api/admin/reports/schedule/folder/select", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("reporting.scheduled_csv"), handleScheduledReportFolderSelect);

  app.post("/api/admin/reports/schedule", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("reporting.scheduled_csv"), express.json(), (req, res) => {
    try {
      const config = normalizeScheduledReportConfig(req.body || {});
      setAppSetting(REPORT_SCHEDULE_CONFIG_KEY, JSON.stringify(config));
      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "REPORT_SCHEDULED_EXPORT_CONFIG_SAVED",
        JSON.stringify({ actor: actorFromReq(req), config }),
        Date.now(),
      );
      return res.json({ ok: true, schedule: getScheduledReportState() });
    } catch (e) {
      console.error("[reports/schedule/save]", e);
      return res.status(500).json({ ok: false, error: "Failed to save scheduled report settings." });
    }
  });

  app.post("/api/admin/reports/schedule/run", requirePerm("SETTINGS_MANAGE"), requireProvisionedFeatureApi("reporting.scheduled_csv"), async (req, res) => {
    try {
      const result = await runScheduledReportExport("manual", actorFromReq(req));
      return res.json({ ok: true, result, schedule: getScheduledReportState() });
    } catch (e) {
      console.error("[reports/schedule/run]", e);
      return res.status(500).json({ ok: false, error: "Failed to run scheduled report export." });
    }
  });

  app.post("/api/admin/upload", requirePerm("REPORT_EXPORT_CSV"), async (req, res) => {
    try {
      const cfg = resolveDriveConfig();
      const folderId = normalizeDriveFolderId(cfg.folderId || "");
      if (!folderId) {
        return res.status(400).json({
          ok: false,
          error: "Missing Google Drive folder ID. Set GDRIVE_FOLDER_ID or save gdrive.folderId in Setup.",
        });
      }

      const bc = getRequestBranchCode(req);
      const businessDate = ensureBusinessDate(db);
      const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim());
      const bodyFrom = String(req.body?.from || "").trim();
      const bodyTo = String(req.body?.to || "").trim();
      const from = isYmd(bodyFrom) ? bodyFrom : businessDate;
      const to = isYmd(bodyTo) ? bodyTo : from;
      if (from > to) {
        return res.status(400).json({ ok: false, error: "Invalid scope: from cannot be after to." });
      }
      let sinceMs = null;
      const bodySinceMs = Number(req.body?.sinceMs);
      const bodySinceHours = Number(req.body?.sinceHours);
      if (Number.isFinite(bodySinceMs) && bodySinceMs > 0) {
        sinceMs = Math.floor(bodySinceMs);
      } else if (Number.isFinite(bodySinceHours) && bodySinceHours > 0) {
        sinceMs = Date.now() - (bodySinceHours * 3600 * 1000);
      }
      const waitRef = parseWaitRef(String(req.body?.waitRef || "hours:2"));
      const scopeLabel = String(req.body?.scopeLabel || "").trim();
      const wantedReportKeys = new Set(
        (Array.isArray(req.body?.reportKeys) ? req.body.reportKeys : [])
          .map((v) => String(v || "").trim())
          .filter(Boolean)
      );
      const ts = new Date();
      const stamp =
        `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}_` +
        `${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}${String(ts.getSeconds()).padStart(2, "0")}`;
      const include = (k) => wantedReportKeys.size === 0 || wantedReportKeys.has(k);
      const files = [];
      if (include("tickets")) {
        files.push({
          name: reportFileName("tickets", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
          mimeType: "text/csv",
        data: Buffer.from(buildTicketsCsvForRange(from, to, sinceMs, bc), "utf8"),
        });
      }
      if (include("daily_summary_csv")) {
        files.push({
          name: reportFileName("daily_summary", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
          mimeType: "text/csv",
          data: Buffer.from(buildDailySummaryCsvForRange(from, to, sinceMs, bc), "utf8"),
        });
      }
      if (include("daily_summary_html")) {
        files.push({
          name: reportFileName("daily_summary_formatted", bc, from, to, { scopeLabel, stamp, ext: "html" }),
          mimeType: "text/html",
          data: Buffer.from(buildDailySummaryHtmlForRange(from, to, sinceMs, bc), "utf8"),
        });
      }
      if (include("custom_summary")) {
        files.push({
          name: reportFileName("custom_summary", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
          mimeType: "text/csv",
          data: Buffer.from(buildCustomSummaryCsvForRange(from, to, sinceMs, bc), "utf8"),
        });
      }
      if (!files.length) {
        return res.status(400).json({ ok: false, error: "No reports selected for upload." });
      }

      const scope = "https://www.googleapis.com/auth/drive.file";
      const accessToken = await getDriveAccessToken(scope);
      const folderMeta = await getDriveFileMeta({ accessToken, fileId: folderId });
      if (cfg.authMode === "service_account" && !folderMeta.driveId) {
        return res.status(400).json({
          ok: false,
          error: "Target folder is not in a Shared Drive. Service-account uploads require Shared Drive for this setup.",
        });
      }
      const branchFolderName = safeFilePart(bc || "BRANCH");
      const dateFolderName = safeFilePart(businessDate || from || "date");
      const branchFolder = await ensureDriveChildFolder({
        accessToken,
        parentId: folderId,
        folderName: branchFolderName,
      });
      const dateFolder = await ensureDriveChildFolder({
        accessToken,
        parentId: String(branchFolder.folder.id || ""),
        folderName: dateFolderName,
      });
      const targetFolderId = String(dateFolder.folder.id || folderId);
      const uploaded = [];
      for (const f of files) {
        const u = await uploadBufferToDriveWithRetry({
          accessToken,
          folderId: targetFolderId,
          fileName: f.name,
          mimeType: f.mimeType,
          fileBuffer: f.data,
          maxAttempts: 3,
        });
        uploaded.push(u);
      }

      const successPayload = {
        ok: true,
        at: Date.now(),
        branchCode: bc,
        businessDate,
        from,
        to,
        scopeLabel: scopeLabel || (from === to ? from : `${from}_to_${to}`),
        sinceMs,
        waitRef: `${waitRef.type}:${waitRef.value}`,
        folderId,
        targetFolderId,
        targetFolderPath: `${branchFolderName}/${dateFolderName}`,
        createdFolders: {
          branch: branchFolder.created,
          date: dateFolder.created,
        },
        uploaded,
      };
      try {
        setAppSetting("upload.lastResultJson", JSON.stringify(successPayload));
      } catch {}

      return res.json({
        ok: true,
        message: `Uploaded ${uploaded.length} report file(s) to Google Drive.`,
        authMode: cfg.authMode,
        branchCode: bc,
        businessDate,
        from,
        to,
        sinceMs,
        waitRef: `${waitRef.type}:${waitRef.value}`,
        folderId,
        targetFolderId,
        targetFolderPath: `${branchFolderName}/${dateFolderName}`,
        uploaded,
      });
    } catch (e) {
      console.error("[admin/upload]", e);
      try {
        setAppSetting(
          "upload.lastResultJson",
          JSON.stringify({
            ok: false,
            at: Date.now(),
            error: String((e && e.message) || e || "Upload failed."),
          })
        );
      } catch {}
      return res.status(500).json({
        ok: false,
        error: String((e && e.message) || e || "Upload failed."),
      });
    }
  });

  /* ---------- GUEST: CREATE QUEUE ---------- */
  app.post("/api/queue/create", rateLimitQueueCreateSessionBurst, rateLimitQueueCreateIpBranch, (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      const pax = Number(req.body.pax || 1);
      const priorityType = normalizePriority(req.body.priorityType);
      const website = String(req.body.website || "").trim();
      const requestedBranchCode = String(req.query.branchCode || "").trim().toUpperCase();

      if (website) {
        return res.status(400).json({ ok: false, error: "Invalid request." });
      }
      if (!name) return res.status(400).json({ ok: false, error: "Name is required." });
      if (!Number.isFinite(pax) || pax < 1 || pax > 50)
        return res.status(400).json({ ok: false, error: "Pax must be 1–50." });
      if (requestedBranchCode && !getBranchByCode(requestedBranchCode)) {
        return res.status(404).json({ ok: false, error: "Branch not found." });
      }

      const businessDate = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      const decision = getBranchAccessDecision(branch, "guest registration");
      if (!decision.ok) {
        return res.status(403).json({
          ok: false,
          error: decision.message,
          code: decision.code,
          branchCode: String(branch?.branchCode || ""),
          branchStatus: String(branch?.status || ""),
          licenseStatus: decision.licenseStatus || getBranchLicenseState(branch).status,
        });
      }
      const bc = String(branch?.branchCode || getBranchCode()).trim();
      const groupCode = computeGroupCode({ priorityType, pax });

      const isPriority = priorityType !== "NONE";

      // Regular queue numbers: A/B/C/D sequence (shared for non-priority)
      const regRow = db
        .prepare(
          `
        SELECT COALESCE(MAX(queueNum), 0) AS mx
        FROM queue_items
        WHERE branchCode=? AND businessDate=? AND groupCode=?
          AND (priorityType IS NULL OR priorityType='NONE')
      `
        )
        .get(bc, businessDate, groupCode);

      const nextReg = (regRow?.mx || 0) + 1;

      // Priority queue numbers: separate per bucket (PA/PB/PC/PD)
      const prRow = db
        .prepare(
          `
        SELECT COALESCE(MAX(queueNum), 0) AS mx
        FROM queue_items
        WHERE branchCode=? AND businessDate=? AND groupCode=?
          AND (priorityType IS NOT NULL AND priorityType!='NONE')
      `
        )
        .get(bc, businessDate, groupCode);

      const nextPr = (prRow?.mx || 0) + 1;

      // Use independent counters per bucket:
      // - Regular queueNum increments only among regular tickets
      // - Priority queueNum increments only among priority tickets (displayed as P{bucket}-NN)
      const queueNum = isPriority ? nextPr : nextReg;
      const id = randomUUID();
      const createdAtLocal = Date.now();

      db.prepare(
        `
        INSERT INTO queue_items
          (id, branchCode, businessDate, groupCode, queueNum,
           name, pax, status, priorityType, createdAtLocal)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?)
      `
      ).run(
        id,
        bc,
        businessDate,
        groupCode,
        queueNum,
        name,
        pax,
        priorityType,
        createdAtLocal
      );

      db.prepare(
        `
        INSERT INTO audit_logs (action, payload, createdAt)
        VALUES (?, ?, ?)
      `
      ).run(
        "QUEUE_CREATE",
        JSON.stringify({ id, branchId: branch?.branchId || null, branchCode: bc, groupCode, queueNum, name, pax, priorityType, businessDate }),
        Date.now()
      );

      emitChanged(app, db, "QUEUE_CREATE", { branchCode: bc, groupCode });
      res.json({
        ok: true,
        id,
        branchId: String(branch?.branchId || ""),
        branchCode: bc,
        businessDate,
        groupCode,
        queueNum,
      });
    } catch (e) {
      console.error("[queue/create]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- STAFF: CLEAR CALLED ---------- */
  app.post("/api/staff/clear-called", requirePerm("QUEUE_CLEAR_CALLED"), (req, res) => {
    try {
      const groupCode = normalizeGroup(req.body.groupCode);
      if (!groupCode) return res.status(400).json({ ok: false, error: "Invalid group." });

      const businessDate = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      const bc = getRequestBranchCode(req);

      const called = db
        .prepare(
          `
      SELECT id, groupCode, queueNum, name, status, calledAt, next_calls, calledNote, seatedAt, skippedAt
      FROM queue_items
      WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED'
      LIMIT 1
    `
        )
        .get(bc, businessDate, groupCode);

      if (!called) return res.json({ ok: false, error: "No CALLED ticket to clear." });

      const now = Date.now();

      db.prepare(
        `
      UPDATE queue_items
      SET status='WAITING', calledNote=NULL
      WHERE id=?
    `
      ).run(called.id);

      const undoExpiresAt = now + 30 * 1000;
      setStaffUndo(req, {
        action: "QUEUE_CLEAR_CALLED",
        resultingStatus: "WAITING",
        actorUserId: actorFromReq(req)?.userId || null,
        branchCode: bc,
        businessDate,
        groupCode,
        ticketId: called.id,
        expiresAt: undoExpiresAt,
        previous: {
          status: called.status,
          calledAt: called.calledAt ?? null,
          next_calls: called.next_calls ?? null,
          calledNote: called.calledNote ?? null,
          seatedAt: called.seatedAt ?? null,
          skippedAt: called.skippedAt ?? null,
        },
      });

      db.prepare(
        `
      INSERT INTO audit_logs (action, payload, createdAt)
      VALUES (?, ?, ?)
    `
      ).run("QUEUE_CLEAR_CALLED", JSON.stringify({ actor: actorFromReq(req), branchId: branch?.branchId || null, branchCode: bc, ...called, businessDate }), now);

      emitChanged(app, db, "QUEUE_CLEAR_CALLED", { branchCode: bc, groupCode });
      res.json({ ok: true, cleared: called, undo: { available: true, action: "QUEUE_CLEAR_CALLED", expiresAt: undoExpiresAt } });
    } catch (e) {
      console.error("[staff/clear-called]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- STAFF: CALL NEXT ---------- */
  // Moves the next eligible WAITING ticket to CALLED for one group/bucket.
  app.post("/api/staff/call-next", requirePerm("QUEUE_CALL_NEXT"), (req, res) => {
    const now = Date.now();

    try {
      const groupCode = normalizeGroup(req.body.groupCode);
      if (!groupCode) return res.status(400).json({ ok: false, error: "Invalid group." });
      clearStaffUndo(req);

      // Calling behavior within the same bucket:
      // - AUTO (default): Priority first, then regular (previous behavior)
      // - PRIORITY: Priority-only
      // - REGULAR: Regular-only
      const pick = String(req.body.pick || "AUTO").toUpperCase();
      const wantPriorityOnly = pick === "PRIORITY";
      const wantRegularOnly = pick === "REGULAR";

      const businessDate = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      const bc = getRequestBranchCode(req);
      const actor = actorFromReq(req);

      const tx = db.transaction(() => {
        const existing = db
          .prepare(
            `
        SELECT id, groupCode, queueNum, name
        FROM queue_items
        WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED'
        LIMIT 1
      `
          )
          .get(bc, businessDate, groupCode);

        if (existing) {
          const err = new Error("A ticket is already CALLED.");
          err.http = 200;
          throw err;
        }

        const next = db
          .prepare(
            `
        SELECT id, groupCode, queueNum, priorityType, name, pax, status
        FROM queue_items
        WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='WAITING'
          AND (
            CASE
              WHEN ?=1 THEN (priorityType IS NOT NULL AND priorityType!='NONE')
              WHEN ?=1 THEN (priorityType IS NULL OR priorityType='NONE')
              ELSE 1
            END
          )
        ORDER BY
          CASE
            WHEN ?=1 THEN queueNum
            WHEN ?=1 THEN queueNum
            ELSE CASE WHEN (priorityType IS NOT NULL AND priorityType!='NONE') THEN 0 ELSE 1 END
          END ASC,
          queueNum ASC
        LIMIT 1
      `
          )
          .get(
            bc,
            businessDate,
            groupCode,
            wantPriorityOnly ? 1 : 0,
            wantRegularOnly ? 1 : 0,
            wantPriorityOnly ? 1 : 0,
            wantRegularOnly ? 1 : 0
          );

        if (!next) {
          const msg = wantPriorityOnly
            ? "No PRIORITY waiting tickets."
            : wantRegularOnly
              ? "No REGULAR waiting tickets."
              : "No waiting tickets.";
          const err = new Error(msg);
          err.http = 200;
          throw err;
        }

        db.prepare(
          `
        UPDATE queue_items
        SET status='CALLED', calledAt=?, calledNote=NULL
        WHERE id=?
      `
        ).run(now, next.id);

        db.prepare(
          `
        INSERT INTO daily_group_stats (
          businessDate, branchCode, groupCode,
          registeredCount, calledCount, seatedCount, skippedCount, overrideCalledCount,
          waitSumMinutes, waitCount,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)
        ON CONFLICT(businessDate, branchCode, groupCode) DO NOTHING
      `
        ).run(businessDate, bc, groupCode, now, now);

        db.prepare(
          `
        UPDATE daily_group_stats
        SET calledCount = calledCount + 1,
            updatedAt = ?
        WHERE businessDate=? AND branchCode=? AND groupCode=?
      `
        ).run(now, businessDate, bc, groupCode);

        db.prepare(
          `
        INSERT INTO audit_logs (action, payload, createdAt)
        VALUES (?, ?, ?)
      `
        ).run(
          "QUEUE_CALL",
          JSON.stringify({ actor, branchId: branch?.branchId || null, ...next, status: "CALLED", branchCode: bc, businessDate }),
          now
        );

        return { ...next, status: "CALLED" };
      });

      const called = tx();
      announceDisplayTicket(called);
      emitChanged(app, db, "QUEUE_CALL", { branchCode: bc, groupCode });
      return res.json({ ok: true, called });
    } catch (e) {
      if (e && typeof e.http === "number") {
        return res.status(e.http).json({ ok: false, error: e.message });
      }
      console.error("[staff/call-next]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  
  /* ---------- STAFF: CALL AGAIN (RE-ANNOUNCE CURRENT CALLED) ---------- */
  // Appends additional "called again" timestamps (Manila local time) to queue_items.next_calls.
  // Initial call remains stored in calledAt (epoch ms) and is NOT modified here.
  app.post("/api/staff/call-again", requirePerm("QUEUE_CALL_NEXT"), (req, res) => {
    const now = Date.now();

    try {
      const groupCode = normalizeGroup(req.body.groupCode);
      if (!groupCode) return res.status(400).json({ ok: false, error: "Invalid group." });

      const businessDate = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      const bc = getRequestBranchCode(req);
      const actor = actorFromReq(req);

      const called = db
        .prepare(
          `
        SELECT id, groupCode, queueNum, priorityType, name, pax, status, calledAt, next_calls
        FROM queue_items
        WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED'
        LIMIT 1
      `
        )
        .get(bc, businessDate, groupCode);

      if (!called) return res.json({ ok: false, error: "No CALLED ticket in this group." });

      const t = formatTimeManila(now);
      const prev = String(called.next_calls || "").trim();
      const nextCalls = prev ? `${prev}, ${t}` : t;

      db.prepare(
        `
        UPDATE queue_items
        SET next_calls=?
        WHERE id=?
      `
      ).run(nextCalls, called.id);

      db.prepare(
        `
        INSERT INTO audit_logs (action, payload, createdAt)
        VALUES (?, ?, ?)
      `
      ).run(
        "QUEUE_CALL_AGAIN",
        JSON.stringify({
          actor,
          branchId: branch?.branchId || null,
          id: called.id,
          groupCode: called.groupCode,
          queueNum: called.queueNum,
          name: called.name,
          businessDate,
          branchCode: bc,
          time: t,
        }),
        now
      );      // Imperative recall: tell display to replay attention (chime + pulse) without state diffing
      const code = formatDisplayTicketCode(called);
      announceDisplayTicket(called);
      try {
        const io = req.app.get("io");
        if (io) {
          const recallPayload = { id: called.id, branchCode: bc, groupCode: called.groupCode, code, at: now };
          io.emit("display:recall", recallPayload);
          // Back-compat for older display clients that still listen for the legacy recall event.
          io.emit("QUEUE_RECALL", recallPayload);
        }
      } catch {}

      // Also notify other clients that something changed (overview/SSE etc.)
      emitChanged(req.app, db, "QUEUE_CALL_AGAIN", { branchCode: bc, groupCode, id: called.id });

      return res.json({ ok: true, called: { ...called, next_calls: nextCalls }, time: t });
    } catch (e) {
      console.error("[staff/call-again]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

/* ---------- STAFF: CALL SPECIFIC (OVERRIDE) ---------- */
  // SECURITY ADDON:
  // - If current user has QUEUE_CALL_OVERRIDE -> allow
  // - Else require supervisorUserId + supervisorPin (step-up)
  app.post("/api/staff/call-specific", requirePerm("QUEUE_CALL_NEXT"), (req, res) => {
    const now = Date.now();

    try {
      const groupCode = normalizeGroup(req.body.groupCode);
      if (!groupCode) return res.status(400).json({ ok: false, error: "Invalid group." });
      clearStaffUndo(req);

      const id = String(req.body.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Missing id." });

      const noteRaw = String(req.body.note || "").trim();
      const note = noteRaw ? noteRaw.slice(0, 200) : null;

      const businessDate = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      const bc = getRequestBranchCode(req);

      const actor = actorFromReq(req);
      const user = getSessionUser(req);

      let approvedBy = null;

      if (!hasPerm(user, "QUEUE_CALL_OVERRIDE")) {
        const supId = String(req.body.supervisorUserId || "").trim();
        const supPin = String(req.body.supervisorPin || "").trim();
        if (!supId || !supPin) {
          return res.status(403).json({ ok: false, error: "Supervisor approval required" });
        }

        const sup = db
          .prepare(
            `
          SELECT userId, fullName, pinHash, roleId, isActive
          FROM users
          WHERE userId=? LIMIT 1
        `
          )
          .get(supId);

        if (!sup || !sup.isActive) return res.status(403).json({ ok: false, error: "Invalid supervisor" });

        const okPin = verifyPinAgainstStoredHash(supPin, sup.pinHash);
        if (!okPin) return res.status(403).json({ ok: false, error: "Invalid supervisor PIN" });

        if (!hasPerm({ roleId: sup.roleId }, "QUEUE_CALL_OVERRIDE")) {
          return res.status(403).json({ ok: false, error: "Supervisor not allowed" });
        }

        approvedBy = { userId: sup.userId, fullName: sup.fullName, roleId: String(sup.roleId || "").toUpperCase() };
      }

      const tx = db.transaction(() => {
        const existing = db
          .prepare(
            `
          SELECT id, groupCode, queueNum, name
          FROM queue_items
          WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED'
          LIMIT 1
        `
          )
          .get(bc, businessDate, groupCode);

        if (existing) {
          const err = new Error(`Already CALLED: ${existing.groupCode}-${existing.queueNum}. Seat/Clear first.`);
          err.http = 200;
          err.code = "ALREADY_CALLED";
          throw err;
        }

        const target = db
          .prepare(
            `
          SELECT id, groupCode, queueNum, name, pax, status
          FROM queue_items
          WHERE id=?
            AND branchCode=?
            AND businessDate=?
            AND groupCode=?
          LIMIT 1
        `
          )
          .get(id, bc, businessDate, groupCode);

        if (!target) {
          const err = new Error("Ticket not found for this group/day.");
          err.http = 404;
          err.code = "NOT_FOUND";
          throw err;
        }

        if (target.status !== "WAITING") {
          const err = new Error("Ticket is not WAITING.");
          err.http = 400;
          err.code = "NOT_WAITING";
          throw err;
        }

        db.prepare(
          `
        UPDATE queue_items
        SET status='CALLED', calledAt=?, calledNote=?
        WHERE id=?
      `
        ).run(now, note, id);

        db.prepare(
          `
        INSERT INTO daily_group_stats (
          businessDate, branchCode, groupCode,
          registeredCount, calledCount, seatedCount, skippedCount, overrideCalledCount,
          waitSumMinutes, waitCount,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)
        ON CONFLICT(businessDate, branchCode, groupCode) DO NOTHING
      `
        ).run(businessDate, bc, groupCode, now, now);

        db.prepare(
          `
        UPDATE daily_group_stats
        SET overrideCalledCount = overrideCalledCount + 1,
            calledCount = calledCount + 1,
            updatedAt = ?
        WHERE businessDate = ?
          AND branchCode = ?
          AND groupCode = ?
      `
        ).run(now, businessDate, bc, groupCode);

        db.prepare(
          `
        INSERT INTO audit_logs (action, payload, createdAt)
        VALUES (?, ?, ?)
      `
        ).run(
          "QUEUE_CALL_OVERRIDE",
          JSON.stringify({
            actor,
            approvedBy,
            id,
            branchId: branch?.branchId || null,
            branchCode: bc,
            groupCode,
            queueNum: target.queueNum,
            name: target.name,
            pax: target.pax,
            note,
            businessDate,
          }),
          now
        );

        return { ...target, status: "CALLED", calledAt: now, calledNote: note };
      });

      const called = tx();
      announceDisplayTicket(called);
      emitChanged(app, db, "QUEUE_CALL", { branchCode: bc, groupCode });
      return res.json({ ok: true, called });
    } catch (e) {
      if (e && typeof e.http === "number") {
        return res.status(e.http).json({ ok: false, error: e.message || "Error." });
      }
      console.error("[staff/call-specific]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- STAFF: SEAT CALLED ---------- */
  // Marks current CALLED ticket as SEATED and updates daily counters/audit.
  app.post("/api/staff/seat-called", requirePerm("QUEUE_SEAT"), (req, res) => {
    const now = Date.now();

    try {
      const groupCode = normalizeGroup(req.body.groupCode);
      if (!groupCode) return res.status(400).json({ ok: false, error: "Invalid group." });

      const businessDate = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      const bc = getRequestBranchCode(req);
      const actor = actorFromReq(req);

      const tx = db.transaction(() => {
        const called = db
          .prepare(
            `
        SELECT id, groupCode, queueNum, name, pax, status, calledAt, next_calls, calledNote, seatedAt, skippedAt
        FROM queue_items
        WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED'
        LIMIT 1
      `
          )
          .get(bc, businessDate, groupCode);

        if (!called) {
          const err = new Error("No CALLED ticket.");
          err.http = 200;
          throw err;
        }

        db.prepare(
          `
        UPDATE queue_items
        SET status='SEATED', seatedAt=?
        WHERE id=?
      `
        ).run(now, called.id);

        db.prepare(
          `
        INSERT INTO daily_group_stats (
          businessDate, branchCode, groupCode,
          registeredCount, calledCount, seatedCount, skippedCount, overrideCalledCount,
          waitSumMinutes, waitCount,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)
        ON CONFLICT(businessDate, branchCode, groupCode) DO NOTHING
      `
        ).run(businessDate, bc, groupCode, now, now);

        db.prepare(
          `
        UPDATE daily_group_stats
        SET seatedCount = seatedCount + 1,
            updatedAt = ?
        WHERE businessDate=? AND branchCode=? AND groupCode=?
      `
        ).run(now, businessDate, bc, groupCode);

        db.prepare(
          `
        INSERT INTO audit_logs (action, payload, createdAt)
        VALUES (?, ?, ?)
      `
        ).run(
          "QUEUE_SEAT",
          JSON.stringify({ actor, branchId: branch?.branchId || null, ...called, status: "SEATED", branchCode: bc, businessDate }),
          now
        );

        return { ...called, status: "SEATED" };
      });

      const seated = tx();
      const undoExpiresAt = now + 30 * 1000;
      setStaffUndo(req, {
        action: "QUEUE_SEAT",
        resultingStatus: "SEATED",
        actorUserId: actor?.userId || null,
        branchCode: bc,
        businessDate,
        groupCode,
        ticketId: seated.id,
        expiresAt: undoExpiresAt,
        previous: {
          status: "CALLED",
          calledAt: seated.calledAt ?? null,
          next_calls: seated.next_calls ?? null,
          calledNote: seated.calledNote ?? null,
          seatedAt: seated.seatedAt ?? null,
          skippedAt: seated.skippedAt ?? null,
        },
      });
      emitChanged(app, db, "QUEUE_SEAT", { branchCode: bc, groupCode });
      return res.json({ ok: true, seated, undo: { available: true, action: "QUEUE_SEAT", expiresAt: undoExpiresAt } });
    } catch (e) {
      if (e && typeof e.http === "number") return res.status(e.http).json({ ok: false, error: e.message });
      console.error("[staff/seat-called]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- STAFF: SKIP ---------- */
  // Skips current CALLED ticket, or the next WAITING ticket if none is called.
  app.post("/api/staff/skip", requirePerm("QUEUE_SKIP"), (req, res) => {
    const now = Date.now();

    try {
      const groupCode = normalizeGroup(req.body.groupCode);
      if (!groupCode) return res.status(400).json({ ok: false, error: "Invalid group." });

      const businessDate = ensureBusinessDate(db);
      const branch = getRequestBranch(req);
      const bc = getRequestBranchCode(req);
      const actor = actorFromReq(req);

      const tx = db.transaction(() => {
        let target = db
          .prepare(
            `
        SELECT id, groupCode, queueNum, status, name, pax, calledAt, next_calls, calledNote, seatedAt, skippedAt
        FROM queue_items
        WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED'
        LIMIT 1
      `
          )
          .get(bc, businessDate, groupCode);

        if (!target) {
          target = db
            .prepare(
              `
          SELECT id, groupCode, queueNum, status, name, pax, calledAt, next_calls, calledNote, seatedAt, skippedAt
          FROM queue_items
          WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='WAITING'
          ORDER BY queueNum ASC
          LIMIT 1
        `
            )
            .get(bc, businessDate, groupCode);
        }

        if (!target) {
          const err = new Error("Nothing to skip.");
          err.http = 200;
          throw err;
        }

        db.prepare(
          `
        UPDATE queue_items
        SET status='SKIPPED', skippedAt=?
        WHERE id=?
      `
        ).run(now, target.id);

        db.prepare(
          `
        INSERT INTO daily_group_stats (
          businessDate, branchCode, groupCode,
          registeredCount, calledCount, seatedCount, skippedCount, overrideCalledCount,
          waitSumMinutes, waitCount,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)
        ON CONFLICT(businessDate, branchCode, groupCode) DO NOTHING
      `
        ).run(businessDate, bc, groupCode, now, now);

        db.prepare(
          `
        UPDATE daily_group_stats
        SET skippedCount = skippedCount + 1,
            updatedAt = ?
        WHERE businessDate=? AND branchCode=? AND groupCode=?
      `
        ).run(now, businessDate, bc, groupCode);

        db.prepare(
          `
        INSERT INTO audit_logs (action, payload, createdAt)
        VALUES (?, ?, ?)
      `
        ).run(
          "QUEUE_SKIP",
          JSON.stringify({ actor, branchId: branch?.branchId || null, ...target, status: "SKIPPED", branchCode: bc, businessDate }),
          now
        );

        return { ...target, status: "SKIPPED" };
      });

      const skipped = tx();
      const undoExpiresAt = now + 30 * 1000;
      setStaffUndo(req, {
        action: "QUEUE_SKIP",
        resultingStatus: "SKIPPED",
        actorUserId: actor?.userId || null,
        branchCode: bc,
        businessDate,
        groupCode,
        ticketId: skipped.id,
        expiresAt: undoExpiresAt,
        previous: {
          status: skipped.status,
          calledAt: skipped.calledAt ?? null,
          next_calls: skipped.next_calls ?? null,
          calledNote: skipped.calledNote ?? null,
          seatedAt: skipped.seatedAt ?? null,
          skippedAt: skipped.skippedAt ?? null,
        },
      });
      emitChanged(app, db, "QUEUE_SKIP", { branchCode: bc, groupCode });
      return res.json({ ok: true, skipped, undo: { available: true, action: "QUEUE_SKIP", expiresAt: undoExpiresAt } });
    } catch (e) {
      if (e && typeof e.http === "number") return res.status(e.http).json({ ok: false, error: e.message });
      console.error("[staff/skip]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/staff/undo-last", requireAuth, (req, res) => {
    const now = Date.now();
    try {
      const actor = actorFromReq(req);
      const undo = getStaffUndo(req);
      if (!undo) return res.status(400).json({ ok: false, error: "Nothing to undo." });
      if (Number(undo.expiresAt || 0) <= now) {
        clearStaffUndo(req);
        return res.status(400).json({ ok: false, error: "Undo window expired." });
      }
      if (undo.actorUserId && actor?.userId && undo.actorUserId !== actor.userId) {
        return res.status(403).json({ ok: false, error: "Undo is locked to the original staff user." });
      }
      if (!["QUEUE_SEAT", "QUEUE_SKIP", "QUEUE_CLEAR_CALLED"].includes(String(undo.action || ""))) {
        clearStaffUndo(req);
        return res.status(400).json({ ok: false, error: "Unsupported undo action." });
      }

      const bc = String(undo.branchCode || getBranchCode());
      const businessDate = String(undo.businessDate || ensureBusinessDate(db));
      const groupCode = normalizeGroup(undo.groupCode);
      const ticketId = String(undo.ticketId || "");
      const previous = undo.previous || {};
      if (!groupCode || !ticketId) {
        clearStaffUndo(req);
        return res.status(400).json({ ok: false, error: "Undo payload is invalid." });
      }

      db.transaction(() => {
        const cur = db.prepare(
          `SELECT id, groupCode, status
           FROM queue_items
           WHERE id=? AND branchCode=? AND businessDate=?
           LIMIT 1`
        ).get(ticketId, bc, businessDate);
        if (!cur) {
          const err = new Error("Ticket not found.");
          err.http = 404;
          throw err;
        }
        if (cur.status !== undo.resultingStatus) {
          const err = new Error("Ticket state changed already. Cannot undo.");
          err.http = 409;
          throw err;
        }
        if (String(previous.status || "") === "CALLED") {
          const existingCalled = db.prepare(
            `SELECT id
             FROM queue_items
             WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED' AND id<>?
             LIMIT 1`
          ).get(bc, businessDate, groupCode, ticketId);
          if (existingCalled) {
            const err = new Error("Another ticket is already CALLED in this group.");
            err.http = 409;
            throw err;
          }
        }

        db.prepare(
          `UPDATE queue_items
           SET status=?,
               calledAt=?,
               next_calls=?,
               calledNote=?,
               seatedAt=?,
               skippedAt=?
           WHERE id=?`
        ).run(
          previous.status || "WAITING",
          previous.calledAt ?? null,
          previous.next_calls ?? null,
          previous.calledNote ?? null,
          previous.seatedAt ?? null,
          previous.skippedAt ?? null,
          ticketId
        );

        if (undo.action === "QUEUE_SEAT") {
          db.prepare(
            `UPDATE daily_group_stats
             SET seatedCount = CASE WHEN seatedCount > 0 THEN seatedCount - 1 ELSE 0 END,
                 updatedAt = ?
             WHERE businessDate=? AND branchCode=? AND groupCode=?`
          ).run(now, businessDate, bc, groupCode);
        }
        if (undo.action === "QUEUE_SKIP") {
          db.prepare(
            `UPDATE daily_group_stats
             SET skippedCount = CASE WHEN skippedCount > 0 THEN skippedCount - 1 ELSE 0 END,
                 updatedAt = ?
             WHERE businessDate=? AND branchCode=? AND groupCode=?`
          ).run(now, businessDate, bc, groupCode);
        }

        db.prepare(`INSERT INTO audit_logs (action, payload, createdAt) VALUES (?, ?, ?)`).run(
          "QUEUE_UNDO",
          JSON.stringify({
            actor,
            undoneAction: undo.action,
            ticketId,
            groupCode,
            branchCode: bc,
            businessDate,
            restoredStatus: previous.status || "WAITING",
          }),
          now
        );
      })();

      clearStaffUndo(req);
      emitChanged(app, db, "QUEUE_UNDO", { branchCode: bc, groupCode });
      return res.json({
        ok: true,
        undoneAction: undo.action,
        restored: { id: ticketId, status: previous.status || "WAITING", groupCode },
      });
    } catch (e) {
      if (e && typeof e.http === "number") return res.status(e.http).json({ ok: false, error: e.message || "Error." });
      console.error("[staff/undo-last]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/staff/reopen-ticket", requirePerm("QUEUE_CLEAR_CALLED"), (req, res) => {
    try {
      if (!isFeatureProvisioned("queue.reopen_completed")) {
        return res.status(404).json({ ok: false, error: "Feature not enabled." });
      }

      const ticketId = String(req.body?.id || "").trim();
      if (!ticketId) return res.status(400).json({ ok: false, error: "Ticket id is required." });

      const branch = getRequestBranch(req);
      const branchCode = getRequestBranchCode(req);
      const businessDate = ensureBusinessDate(db);
      const actor = actorFromReq(req);
      const now = Date.now();

      const reopened = db.transaction(() => {
        const row = db.prepare(
          `SELECT id, branchCode, businessDate, groupCode, queueNum, name, pax, status, priorityType,
                  createdAtLocal, calledAt, next_calls, calledNote, seatedAt, skippedAt
           FROM queue_items
           WHERE id = ?
             AND branchCode = ?
             AND businessDate = ?
           LIMIT 1`
        ).get(ticketId, branchCode, businessDate);
        if (!row) {
          const err = new Error("Ticket not found for the current branch/day.");
          err.http = 404;
          throw err;
        }

        const currentStatus = String(row.status || "").toUpperCase();
        if (!["SEATED", "SKIPPED"].includes(currentStatus)) {
          const err = new Error("Only seated or skipped tickets can be reopened.");
          err.http = 400;
          throw err;
        }

        db.prepare(
          `UPDATE queue_items
           SET status='WAITING',
               calledAt=NULL,
               calledNote=NULL,
               seatedAt=NULL,
               skippedAt=NULL
           WHERE id=?`
        ).run(ticketId);

        if (currentStatus === "SEATED") {
          db.prepare(
            `UPDATE daily_group_stats
             SET seatedCount = CASE WHEN seatedCount > 0 THEN seatedCount - 1 ELSE 0 END
             WHERE branchCode=? AND businessDate=? AND groupCode=?`
          ).run(branchCode, businessDate, row.groupCode);
        }
        if (currentStatus === "SKIPPED") {
          db.prepare(
            `UPDATE daily_group_stats
             SET skippedCount = CASE WHEN skippedCount > 0 THEN skippedCount - 1 ELSE 0 END
             WHERE branchCode=? AND businessDate=? AND groupCode=?`
          ).run(branchCode, businessDate, row.groupCode);
        }

        db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
          "QUEUE_REOPEN_COMPLETED",
          JSON.stringify({
            actor,
            branchId: branch?.branchId || null,
            branchCode,
            businessDate,
            ticketId: row.id,
            groupCode: row.groupCode,
            queueNum: row.queueNum,
            priorityType: row.priorityType,
            previousStatus: currentStatus,
          }),
          now
        );

        return {
          ...row,
          previousStatus: currentStatus,
          status: "WAITING",
          calledAt: null,
          calledNote: null,
          seatedAt: null,
          skippedAt: null,
        };
      })();

      emitChanged(app, db, "QUEUE_REOPEN_COMPLETED", {
        branchCode,
        id: reopened.id,
        groupCode: reopened.groupCode,
        previousStatus: reopened.previousStatus,
      });
      return res.json({ ok: true, reopened });
    } catch (e) {
      if (e && typeof e.http === "number") return res.status(e.http).json({ ok: false, error: e.message || "Error." });
      console.error("[staff/reopen-ticket]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

function getBundledMediaDir() {
  // 1) Dev: server/static/media
  const p1 = path.join(__dirname, "static", "media");
  if (fs.existsSync(p1)) return p1;

  // 2) Packaged fallback attempts (won’t hurt in dev)
  if (process.resourcesPath) {
    const p2 = path.join(process.resourcesPath, "static", "media");
    if (fs.existsSync(p2)) return p2;

    const p3 = path.join(process.resourcesPath, "app.asar.unpacked", "server", "static", "media");
    if (fs.existsSync(p3)) return p3;

    const p4 = path.join(process.resourcesPath, "server", "static", "media");
    if (fs.existsSync(p4)) return p4;
  }

  return p1; // last resort
}

function listVideoFilesIn(dirAbs) {
  if (!dirAbs) return [];
  try {
    if (!fs.existsSync(dirAbs)) return [];
    return fs
      .readdirSync(dirAbs)
      .filter((f) => isDisplayVideoFileName(f))
      // ignore hidden/system junk
      .filter((f) => !String(f).startsWith("."));
  } catch {
    return [];
  }
}

function isDisplayVideoFileName(fileName) {
  // Chromium/Electron commonly reports MEDIA_ERR_SRC_NOT_SUPPORTED for MOV/M4V containers.
  // Keep uploaded/display-managed media to the broadest-safe target: MP4 (H.264 video + AAC audio).
  return /\.mp4$/i.test(String(fileName || ""));
}

function isUploadVideoFileName(fileName) {
  return /\.(mp4|m4v|mov|webm|ogg|ogv|avi|mkv)$/i.test(String(fileName || ""));
}

function toWebSafeMp4Name(fileName) {
  const safe = sanitizeMediaFileName(fileName || "video.mp4");
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  return `${stem || "video"}-websafe.mp4`;
}

async function transcodeVideoToWebSafeMp4(file, originalName) {
  const ffmpegBin = String(process.env.FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qsys-media-"));
  const inputExt = path.extname(originalName || "") || ".video";
  const inputPath = path.join(tempDir, `input${inputExt}`);
  const outputPath = path.join(tempDir, "output.mp4");
  try {
    fs.writeFileSync(inputPath, file.buffer);
    await execFileAsync(
      ffmpegBin,
      [
        "-y",
        "-i", inputPath,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", "22",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        outputPath,
      ],
      { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 }
    );
    return fs.readFileSync(outputPath);
  } catch (e) {
    const err = new Error(
      e && e.code === "ENOENT"
        ? "FFmpeg is not installed on this server. Rebuild/deploy the latest Docker image with FFmpeg support."
        : `Video conversion failed for ${originalName || "uploaded file"}. Use a valid video file.`
    );
    err.http = e && e.code === "ENOENT" ? 500 : 400;
    err.cause = e;
    throw err;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

function getManagedMediaRoot(baseDir) {
  return path.join(baseDir, "media-library");
}

function ensureManagedMediaDir(dirAbs) {
  try {
    fs.mkdirSync(dirAbs, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function getGeneralMediaDir(baseDir) {
  return path.join(getManagedMediaRoot(baseDir), "general");
}

function getBranchMediaDir(baseDir, branchCode) {
  return path.join(getManagedMediaRoot(baseDir), "branches", String(branchCode || "").trim().toUpperCase());
}

function sanitizeMediaFileName(name) {
  const raw = String(name || "").trim();
  const base = path.basename(raw).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim();
  return base || `media-${Date.now()}.bin`;
}

function listManagedMediaAssets(scopeType, branch) {
  const normalizedScope = String(scopeType || "").trim().toUpperCase();
  if (normalizedScope === "BRANCH") {
    const branchId = String(branch?.branchId || "").trim();
    if (!branchId) return [];
    return db.prepare(
      `SELECT id, scopeType, branchId, branchCode, fileName, storedName, relativePath, mimeType, sizeBytes, isActive, createdAt, updatedAt
       FROM media_assets
       WHERE scopeType='BRANCH' AND branchId=? AND isActive=1
       ORDER BY createdAt ASC, fileName ASC`
    ).all(branchId);
  }
  return db.prepare(
    `SELECT id, scopeType, branchId, branchCode, fileName, storedName, relativePath, mimeType, sizeBytes, isActive, createdAt, updatedAt
     FROM media_assets
     WHERE scopeType='GENERAL' AND isActive=1
     ORDER BY createdAt ASC, fileName ASC`
  ).all();
}

function listDisplayManagedMediaAssets(scopeType, branch) {
  return listManagedMediaAssets(scopeType, branch).filter((row) =>
    isDisplayVideoFileName(row?.fileName || row?.storedName || row?.relativePath || "")
  );
}

function getDisplayMediaSourceSummary(branch) {
  const generalCount = listDisplayManagedMediaAssets("GENERAL", null).length;
  const branchCount = branch?.branchId ? listDisplayManagedMediaAssets("BRANCH", branch).length : 0;
  const customDir = String(getResolvedDisplaySettings(branch)["media.sourceDir"] || "").trim();
  const localFile = String(getResolvedDisplaySettings(branch)["media.sourceFile"] || "").trim();

  if (localFile) {
    return {
      effectiveSource: "local-file",
      label: localFile,
      generalCount,
      branchCount,
      customDir,
      localFile,
    };
  }

  if (branchCount > 0) {
    return {
      effectiveSource: "managed-branch",
      label: `Branch videos + general videos (${branchCount} branch, ${generalCount} general)`,
      generalCount,
      branchCount,
      customDir,
      localFile,
    };
  }
  if (generalCount > 0) {
    return {
      effectiveSource: "managed-general",
      label: `General videos (${generalCount}) for all branches`,
      generalCount,
      branchCount,
      customDir,
      localFile,
    };
  }
  if (customDir) {
    return {
      effectiveSource: "custom-folder",
      label: customDir,
      generalCount,
      branchCount,
      customDir,
      localFile,
    };
  }
  return {
    effectiveSource: "bundled",
    label: "Bundled videos (default)",
    generalCount,
    branchCount,
    customDir,
    localFile,
  };
}

function getManagedMediaAssetById(id) {
  return db.prepare(
    `SELECT id, scopeType, branchId, branchCode, fileName, storedName, relativePath, mimeType, sizeBytes, isActive, createdAt, updatedAt
     FROM media_assets
     WHERE id=? LIMIT 1`
  ).get(String(id || "").trim());
}

function cleanupOldManagedMediaAssets(scopeType, branch) {
  const rows = listManagedMediaAssets(scopeType, branch);
  const removed = [];
  const root = getManagedMediaRoot(baseDir);
  for (const row of rows) {
    const isWebSafe = /-websafe\.mp4$/i.test(String(row.fileName || ""));
    const absPath = path.join(root, String(row.relativePath || ""));
    const missing = !fs.existsSync(absPath);
    if (isWebSafe && !missing) continue;
    try {
      if (!missing) fs.unlinkSync(absPath);
    } catch {}
    db.prepare(`DELETE FROM media_assets WHERE id=?`).run(String(row.id || ""));
    removed.push({
      id: row.id,
      fileName: row.fileName,
      storedName: row.storedName,
      reason: missing ? "missing-file" : "not-websafe-upload",
    });
  }
  return removed;
}

function normalizeMediaScope(raw) {
  return String(raw || "").trim().toUpperCase() === "BRANCH" ? "BRANCH" : "GENERAL";
}

function getMediaScopeContext(req) {
  const scopeType = normalizeMediaScope(req.query?.scope || req.body?.scopeType || req.body?.scope);
  const branch = scopeType === "BRANCH" ? getRequestBranch(req) : null;
  return { scopeType, branch };
}

app.get("/api/admin/media/assets", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    const { scopeType, branch } = getMediaScopeContext(req);
    if (scopeType === "BRANCH" && !branch?.branchId) {
      return res.status(400).json({ ok: false, error: "No active branch context resolved." });
    }
    const dir = scopeType === "BRANCH"
      ? getBranchMediaDir(baseDir, branch?.branchCode)
      : getGeneralMediaDir(baseDir);
    return res.json({
      ok: true,
      scopeType,
      branch: branch || null,
      folderPath: dir,
      exists: fs.existsSync(dir),
      files: listManagedMediaAssets(scopeType, branch),
    });
  } catch (e) {
    console.error("[admin/media/assets:get]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/media/folder", requirePerm("SETTINGS_MANAGE"), express.json(), (req, res) => {
  try {
    const { scopeType, branch } = getMediaScopeContext(req);
    if (scopeType === "BRANCH" && !branch?.branchId) {
      return res.status(400).json({ ok: false, error: "No active branch context resolved." });
    }
    const dir = scopeType === "BRANCH"
      ? getBranchMediaDir(baseDir, branch?.branchCode)
      : getGeneralMediaDir(baseDir);
    if (!ensureManagedMediaDir(dir)) {
      return res.status(500).json({ ok: false, error: "Failed to create media folder." });
    }
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_FOLDER_CREATE",
      JSON.stringify({ actor: actorFromReq(req), scopeType, branchCode: String(branch?.branchCode || "") }),
      Date.now()
    );
    return res.json({ ok: true, scopeType, branch: branch || null, folderPath: dir });
  } catch (e) {
    console.error("[admin/media/folder:post]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/media/upload", requirePerm("SETTINGS_MANAGE"), mediaUpload.array("files", 20), async (req, res) => {
  try {
    const { scopeType, branch } = getMediaScopeContext(req);
    if (scopeType === "BRANCH" && !branch?.branchId) {
      return res.status(400).json({ ok: false, error: "No active branch context resolved." });
    }
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ ok: false, error: "No files uploaded." });

    const dir = scopeType === "BRANCH"
      ? getBranchMediaDir(baseDir, branch?.branchCode)
      : getGeneralMediaDir(baseDir);
    if (!ensureManagedMediaDir(dir)) {
      return res.status(500).json({ ok: false, error: "Failed to prepare media folder." });
    }

    const now = Date.now();
    const inserted = [];
    const insertStmt = db.prepare(
      `INSERT INTO media_assets(id, scopeType, branchId, branchCode, fileName, storedName, relativePath, mimeType, sizeBytes, isActive, createdAt, updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    for (const file of files) {
      const originalName = sanitizeMediaFileName(file.originalname || file.fieldname || "video.bin");
      if (!isUploadVideoFileName(originalName)) continue;
      const webSafeName = toWebSafeMp4Name(originalName);
      const webSafeBuffer = await transcodeVideoToWebSafeMp4(file, originalName);
      const storedName = `${Date.now()}-${randomUUID()}-${webSafeName}`;
      const absPath = path.join(dir, storedName);
      fs.writeFileSync(absPath, webSafeBuffer);
      const relativePath = path.relative(getManagedMediaRoot(baseDir), absPath).replace(/\\/g, "/");
      const id = randomUUID();
      insertStmt.run(
        id,
        scopeType,
        scopeType === "BRANCH" ? String(branch?.branchId || "") : null,
        scopeType === "BRANCH" ? String(branch?.branchCode || "") : null,
        webSafeName,
        storedName,
        relativePath,
        "video/mp4",
        Number(webSafeBuffer.length || 0),
        1,
        now,
        now
      );
      inserted.push(getManagedMediaAssetById(id));
    }

    if (!inserted.length) {
      return res.status(400).json({ ok: false, error: "No supported video files were uploaded. Use a video file such as MP4, MOV, WebM, OGG, AVI, or MKV." });
    }

    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_UPLOAD",
      JSON.stringify({
        actor: actorFromReq(req),
        scopeType,
        branchCode: String(branch?.branchCode || ""),
        fileCount: inserted.length,
      }),
      now
    );
    emitChanged(app, db, "ADMIN_MEDIA_UPLOAD", { branchCode: String(branch?.branchCode || "") });
    return res.json({ ok: true, scopeType, branch: branch || null, files: inserted });
  } catch (e) {
    console.error("[admin/media/upload]", e);
    return res.status(Number(e?.http || 500) || 500).json({ ok: false, error: e?.message || "Server error." });
  }
});

app.use((err, req, res, next) => {
  const pathName = String(req?.path || req?.originalUrl || "");
  if (!pathName.includes("/api/admin/media/upload")) return next(err);
  const status = Number(err?.status || err?.statusCode || 500) || 500;
  const message = String(err?.message || "Upload failed.").trim() || "Upload failed.";
  console.error("[admin/media/upload:middleware]", err);
  return res.status(status).json({ ok: false, error: message });
});

app.post("/api/admin/media/delete", requirePerm("SETTINGS_MANAGE"), express.json(), (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Media id is required." });
    const row = getManagedMediaAssetById(id);
    if (!row?.id) return res.status(404).json({ ok: false, error: "Media file not found." });
    const absPath = path.join(getManagedMediaRoot(baseDir), String(row.relativePath || ""));
    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } catch {}
    db.prepare(`DELETE FROM media_assets WHERE id=?`).run(id);
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_DELETE",
      JSON.stringify({ actor: actorFromReq(req), id, scopeType: row.scopeType, branchCode: row.branchCode || "" }),
      Date.now()
    );
    emitChanged(app, db, "ADMIN_MEDIA_DELETE", { branchCode: String(row.branchCode || "") });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[admin/media/delete]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/media/cleanup", requirePerm("SETTINGS_MANAGE"), express.json(), (req, res) => {
  try {
    const { scopeType, branch } = getMediaScopeContext(req);
    if (scopeType === "BRANCH" && !branch?.branchId) {
      return res.status(400).json({ ok: false, error: "No active branch context resolved." });
    }
    const removed = cleanupOldManagedMediaAssets(scopeType, branch);
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_CLEANUP",
      JSON.stringify({
        actor: actorFromReq(req),
        scopeType,
        branchCode: String(branch?.branchCode || ""),
        removedCount: removed.length,
        removed,
      }),
      Date.now()
    );
    emitChanged(app, db, "ADMIN_MEDIA_CLEANUP", { branchCode: String(branch?.branchCode || "") });
    return res.json({ ok: true, scopeType, branch: branch || null, removed });
  } catch (e) {
    console.error("[admin/media/cleanup]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.get("/api/admin/media/file/:id", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    const row = getManagedMediaAssetById(req.params.id);
    if (!row?.id) return res.status(404).end();
    const absPath = path.join(getManagedMediaRoot(baseDir), String(row.relativePath || ""));
    if (!fs.existsSync(absPath)) return res.status(404).end();
    return res.sendFile(absPath);
  } catch (e) {
    console.error("[admin/media/file]", e);
    return res.status(500).end();
  }
});

app.get("/media/library/:id/:name", requireDisplayAuth, (req, res) => {
  try {
    const row = getManagedMediaAssetById(req.params.id);
    if (!row?.id || Number(row.isActive || 0) !== 1) return res.status(404).end();
    const branch = getRequestBranch(req);
    const branchId = String(branch?.branchId || "").trim();
    if (String(row.scopeType || "") === "BRANCH" && String(row.branchId || "").trim() !== branchId) {
      return res.status(403).end();
    }
    const absPath = path.join(getManagedMediaRoot(baseDir), String(row.relativePath || ""));
    if (!fs.existsSync(absPath)) return res.status(404).end();
    setDisplayMediaHeaders(res);
    return res.sendFile(absPath);
  } catch (e) {
    console.error("[media/library]", e);
    return res.status(500).end();
  }
});

app.get("/media/custom/:name", requireDisplayAuth, (req, res) => {
  try {
    const base = String(getResolvedDisplaySettings(getRequestBranch(req))["media.sourceDir"] || "").trim();
    if (!base) return res.status(404).end();

    const name = String(req.params.name || "");
    if (!isDisplayVideoFileName(name)) return res.status(400).end();

    // Path traversal defense
    const abs = path.resolve(base, name);
    const baseResolved = path.resolve(base);
    if (!abs.startsWith(baseResolved + path.sep)) return res.status(403).end();

    if (!fs.existsSync(abs)) return res.status(404).end();
    setDisplayMediaHeaders(res);
    return res.sendFile(abs);
  } catch (e) {
    console.error("[media:custom]", e);
    return res.status(500).end();
  }
});

app.get("/media/local-file/current", requireDisplayAuth, (req, res) => {
  try {
    const filePath = String(req.query?.path || getResolvedDisplaySettings(getRequestBranch(req))["media.sourceFile"] || "").trim();
    if (!filePath) return res.status(404).end();
    if (!isDisplayVideoFileName(filePath)) return res.status(400).end();
    if (!fs.existsSync(filePath)) return res.status(404).end();
    setDisplayMediaHeaders(res);
    return res.sendFile(path.resolve(filePath));
  } catch (e) {
    console.error("[media:local-file]", e);
    return res.status(500).end();
  }
});

app.get("/wifi-qr-test", (req, res) => {
  res.sendFile(path.join(__dirname, "static", "wifi-qr-test.html"));
});

  /* ---------- MEDIA LIST ---------- */
app.get("/api/media/list", requireDisplayAuth, (req, res) => {

  try {
    const branch = getRequestBranch(req);
    const branchCode = String(branch?.branchCode || "").trim().toUpperCase();
    const localFile = String(getResolvedDisplaySettings(branch)["media.sourceFile"] || "").trim();
    const withBranchCode = (url) => {
      const raw = String(url || "").trim();
      if (!raw || !branchCode) return raw;
      const sep = raw.includes("?") ? "&" : "?";
      return `${raw}${sep}branchCode=${encodeURIComponent(branchCode)}`;
    };

    if (localFile) {
      if (fs.existsSync(localFile) && isDisplayVideoFileName(localFile)) {
        return res.json({
          ok: true,
          files: [withBranchCode("/media/local-file/current")],
          source: "local-file",
          file: localFile,
        });
      }
      console.warn("[media:list] local file missing or unsupported, falling back:", localFile);
    }

    const generalAssets = listDisplayManagedMediaAssets("GENERAL", null).map((row) => ({
      url: withBranchCode(`/media/library/${encodeURIComponent(row.id)}/${encodeURIComponent(row.fileName)}`),
      scopeType: "GENERAL",
    }));
    const branchAssets = listDisplayManagedMediaAssets("BRANCH", branch).map((row) => ({
      url: withBranchCode(`/media/library/${encodeURIComponent(row.id)}/${encodeURIComponent(row.fileName)}`),
      scopeType: "BRANCH",
    }));
    const mergedManaged = [...generalAssets, ...branchAssets].map((row) => row.url);
    if (mergedManaged.length) {
      return res.json({
        ok: true,
        files: mergedManaged,
        source: "managed",
        generalCount: generalAssets.length,
        branchCount: branchAssets.length,
      });
    }

    // 1) Try custom folder
    const sourceDir = String(getResolvedDisplaySettings(getRequestBranch(req))["media.sourceDir"] || "").trim();
    if (sourceDir) {
      try {
        if (fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory()) {
          const customFiles = fs
            .readdirSync(sourceDir)
            .filter((f) => isDisplayVideoFileName(f))
            .map(
              (f) =>
                withBranchCode(`/media/custom/${encodeURIComponent(f)}`),
            );

          if (customFiles.length) {
            return res.json({ ok: true, files: customFiles, source: "custom", folder: sourceDir });
          }
          // If folder exists but no videos => fallback to bundled (do NOT return empty)
        }
      } catch (e) {
        // If anything about custom folder fails => fallback to bundled
        console.warn("[media:list] custom folder failed, falling back to bundled:", e.message || e);
      }
    }

    // 2) Bundled fallback
    const mediaDir = path.join(__dirname, "static", "media");
    if (!fs.existsSync(mediaDir)) return res.json({ ok: true, files: [], source: "bundled" });

    const files = fs
      .readdirSync(mediaDir)
      .filter((f) => isDisplayVideoFileName(f))
      .map((f) => `/static/media/${encodeURIComponent(f)}`);

    return res.json({ ok: true, files, source: "bundled" });
  } catch (e) {
    console.error("[media:list]", e);
    res.status(500).json({ ok: false, files: [] });
  }
});



  /* ---------- socket ---------- */
  const server = http.createServer(app);
  const allowedSocketHosts = new Set(["127.0.0.1", "localhost"]);
  for (const raw of [
    process.env.QSYS_PUBLIC_HOST,
    process.env.PUBLIC_HOST,
    process.env.APP_HOST,
    "onegourmetph.com",
    "www.onegourmetph.com",
  ]) {
    const host = String(raw || "").trim().toLowerCase();
    if (host) allowedSocketHosts.add(host);
  }
  const io = new Server(server, {
    path: pathWithBase("/socket.io"),
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        try {
          const u = new URL(String(origin));
          const host = String(u.hostname || "").toLowerCase();
          if (allowedSocketHosts.has(host)) return cb(null, true);
        } catch {}
        return cb(new Error("Not allowed by CORS"));
      },
    },
  });
  app.set("io", io);

  io.on("connection", (socket) => {
    socket.emit("hello", {
      ok: true,
      branchCode: getRequestBranchCode(socket.request),
      branchName: getRequestBranchName(socket.request),
    });
    socket.emit("heartbeat", { ts: Date.now() });

    socket.on("ping", () => socket.emit("pong", { ts: Date.now() }));

    // SECURITY: do not trust arbitrary client-triggered broadcast events.
    // Server-side emitChanged()/broadcast() remains the source of truth.
  });

  // Heartbeat: kiosks can use this to detect stale socket and auto-reload.
  setInterval(() => {
    try { io.emit("heartbeat", { ts: Date.now() }); } catch {}
  }, 10 * 1000);

  server.listen(port, "0.0.0.0", () => {
    console.log(`[QSysLocal] running on http://127.0.0.1:${port}`);
  });

  // Auto rollover watcher (midnight Manila)
  setInterval(() => {
    try {
      maybeAutoRolloverBusinessDate(db, app);
    } catch (e) {
      console.error("[auto-rollover]", e);
    }
  }, 30 * 1000);

  if (isFeatureProvisioned("operations.startup_self_test")) {
    try {
      runStartupSelfTest("startup", "SYSTEM");
    } catch (e) {
      console.error("[ops/startup-self-test]", e);
    }
  }

  setInterval(() => {
    try {
      maybeRunAutoBackup("timer");
    } catch (e) {
      console.error("[ops/auto-backup]", e);
    }
  }, 5 * 60 * 1000).unref?.();

  setInterval(() => {
    try {
      runScheduledReportExport("timer", "SYSTEM");
    } catch (e) {
      console.error("[reports/scheduled-csv]", e);
    }
  }, 60 * 1000).unref?.();

  return { server, io, db };
}

module.exports = { startServer };
