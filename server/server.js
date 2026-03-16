// server/server.js
// QSys Local (Offline) — Server
// NOTE: This is a full-file paste based on your provided server.js,
// with ONLY security-related additions + minimal wiring changes.
// Working queue logic is kept intact.

const express = require("express");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { randomUUID, createSign, randomBytes, createHash } = require("crypto");
const bcrypt = require("bcryptjs");
const { openDb } = require("./db");
const session = require("express-session");
const os = require("os");
const QRCode = require("qrcode");
const helmet = require("helmet");

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
      broadcast("changed", Object.assign({ reason }, extra));
      broadcast("overview", computeOverview());
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

function ensureBusinessDate(db) {
  const today = getTodayManila();
  let cur = getState(db, "currentBusinessDate");
  if (!cur) {
    setState(db, "currentBusinessDate", today);
    cur = today;
  }
  return cur;
}

function maybeAutoRolloverBusinessDate(db, app) {
  const today = getTodayManila();
  const cur = ensureBusinessDate(db);
  if (cur !== today) {
    setState(db, "currentBusinessDate", today);
    setState(db, "lastAutoRolloverAt", Date.now());
    emitChanged(app, db, "AUTO_ROLLOVER");
    console.log(`[QSysLocal] Auto rollover business date: ${cur} -> ${today}`);
  }
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

/* -------------------- Admin seeds -------------------- */
function ensureAdminSeeds(db, opts = {}) {
  const now = Date.now();
  const disableDefaultAdminSeed = !!opts.disableDefaultAdminSeed;

  // roles (must exist BEFORE users because schema.sql enforces FK)
  const roleCount = db.prepare(`SELECT COUNT(*) AS n FROM roles`).get()?.n || 0;
  if (roleCount === 0) {
    const insRole = db.prepare(
      `INSERT INTO roles(roleId, roleName, isSystem, createdAt, updatedAt) VALUES(?,?,?,?,?)`
    );
    insRole.run("STAFF", "Staff", 1, now, now);
    insRole.run("SUPERVISOR", "Supervisor", 1, now, now);
    insRole.run("ADMIN", "Admin", 1, now, now);
  }

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

  // Ensure branch_config row exists (id=1), safe defaults
  const bc = db.prepare(`SELECT id FROM branch_config WHERE id=1`).get();
  if (!bc) {
    db.prepare(
      `INSERT INTO branch_config(id, branchCode, branchName, timezone, createdAt, updatedAt)
       VALUES(1, ?, ?, 'Asia/Manila', ?, ?)`
    ).run("DEV", "DEV Branch", now, now);
  }
}


/* -------------------- server -------------------- */

function startServer({ baseDir, port = 3000, branchCode = "DEV" }) {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const db = openDb(baseDir);
  loadSchema(db);

  // Ensure required tables exist even if schema.sql is older
  ensureAdminSchema(db);

  // ✅ Ensure optional note column exists for override calls
  ensureColumn(db, "queue_items", "calledNote", "TEXT");
  // ✅ Track re-calls after the initial call
  ensureColumn(db, "queue_items", "next_calls", "TEXT");

  // Priority numbering is handled via queueNum with independent counters per bucket
  // for Regular vs Priority (Priority = priorityType != 'NONE').

  // Ensure system has a business date persisted
  ensureBusinessDate(db);

  // Ensure admin tables have baseline data
  try {
    ensureAdminSeeds(db, { disableDefaultAdminSeed: isProduction });
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
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        upgradeInsecureRequests: null,
      },
    },
  }));

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
  app.use(
    session({
      name: "qsys.sid",
      secret: sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: String(process.env.NODE_ENV || "").toLowerCase() === "production",
        maxAge: 1000 * 60 * 60 * 12, // 12h
      },
    })
  );

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: true, limit: "256kb" }));

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
  if (p.startsWith("/media/")) return next();
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

  /* ===================== SECURITY ADDON: auth + perms ===================== */

  function getSessionUser(req) {
    const url = stripBasePathFromUrl(String(req.path || req.originalUrl || ""));
    // Session separation: Admin and Staff must never overwrite each other
    if (url.startsWith("/api/admin/") || url.startsWith("/admin")) {
      return (req.session && req.session.adminUser) ? req.session.adminUser : null;
    }
    if (url.startsWith("/api/staff/") || url.startsWith("/staff")) {
      return (req.session && req.session.staffUser) ? req.session.staffUser : null;
    }
    // Fallback for legacy endpoints
    if (req.session && req.session.staffUser) return req.session.staffUser;
    if (req.session && req.session.adminUser) return req.session.adminUser;
    return (req.session && req.session.user) ? req.session.user : null;
  }

  function setSessionUser(req, scope, user) {
    if (!req || !req.session) return;
    if (scope === "admin") req.session.adminUser = user;
    else if (scope === "staff") req.session.staffUser = user;
    else req.session.user = user; // legacy only
  }

  function clearSessionUser(req, scope){
    if (!req || !req.session) return;
    if (scope === "admin") delete req.session.adminUser;
    else if (scope === "staff") delete req.session.staffUser;
    else delete req.session.user;
  }

  // In-memory IP throttling to reduce brute force/spam pressure.
  function createIpRateLimiter({ windowMs, max, name }) {
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
      const ip = String(
        req.headers["x-forwarded-for"] ||
          req.socket?.remoteAddress ||
          req.ip ||
          "unknown",
      )
        .split(",")[0]
        .trim();
      const key = `${name || "rl"}:${ip}`;
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
        return res.status(429).json({ ok: false, error: "Too many requests. Please try again shortly." });
      }
      return next();
    };
  }

  const rateLimitAuthLogin = createIpRateLimiter({ windowMs: 5 * 60 * 1000, max: 20, name: "auth_login" });
  const rateLimitQueueCreate = createIpRateLimiter({ windowMs: 60 * 1000, max: 3, name: "queue_create" });
  const rateLimitDisplayPair = createIpRateLimiter({ windowMs: 5 * 60 * 1000, max: 25, name: "display_pair" });

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
  const u = getSessionUser(req);
  if (!u) return res.redirect(pathWithBase("/staff-login"));
  next();
}

function requireAdminPage(req, res, next) {
  const u = getSessionUser(req);
  if (!u) return res.redirect(pathWithBase("/admin-login"));

  const roleId = String(u.roleId || "").toUpperCase();
  if (roleId !== "ADMIN") return res.redirect(pathWithBase("/staff")); // or res.status(403).send("Forbidden");
  next();
}

  function finalizeLoginSession(req, scope, sessUser) {
    return new Promise((resolve, reject) => {
      if (!req || !req.session || typeof req.session.regenerate !== "function") {
        try {
          setSessionUser(req, scope, sessUser);
          return resolve();
        } catch (e) {
          return reject(e);
        }
      }
      req.session.regenerate((err) => {
        if (err) return reject(err);
        try {
          setSessionUser(req, scope, sessUser);
          req.session.save((saveErr) => {
            if (saveErr) return reject(saveErr);
            return resolve();
          });
        } catch (e) {
          return reject(e);
        }
      });
    });
  }

  function actorFromReq(req) {
    const u = getSessionUser(req);
    if (!u) return null;
    return { userId: u.userId, fullName: u.fullName, roleId: getRoleId(u) };
  }

  /* ---------- AUTH: login/me/logout (SESSION SEPARATED: staff vs admin) ---------- */
  // Staff login (STAFF / SUPERVISOR)
  app.post("/api/staff/auth/login", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName || !pin) return res.status(400).json({ ok: false, error: "fullName/pin required" });

      const u = db.prepare(`
        SELECT userId, fullName, pinHash, roleId, isActive
        FROM users
        WHERE lower(fullName) = lower(?)
        LIMIT 1
      `).get(fullName);

      if (!u || !u.isActive) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const role = String(u.roleId || "").toUpperCase();
      if (!["STAFF","SUPERVISOR"].includes(role)) {
        return res.status(403).json({ ok: false, error: "Not allowed for Staff app" });
      }

      const ok = bcrypt.compareSync(pin, u.pinHash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      const sessUser = { userId: u.userId, fullName: u.fullName, roleId: role };
      await finalizeLoginSession(req, "staff", sessUser);

      return res.json({ ok: true, scope: "staff", user: sessUser });
    } catch (e) {
      console.error("[staff/auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // Admin login (ADMIN only)
  app.post("/api/admin/auth/login", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName || !pin) return res.status(400).json({ ok: false, error: "fullName/pin required" });

      const u = db.prepare(`
        SELECT userId, fullName, pinHash, roleId, isActive
        FROM users
        WHERE lower(fullName) = lower(?)
        LIMIT 1
      `).get(fullName);

      if (!u || !u.isActive) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const role = String(u.roleId || "").toUpperCase();
      if (role !== "ADMIN") {
        return res.status(403).json({ ok: false, error: "Not allowed for Admin app" });
      }

      const ok = bcrypt.compareSync(pin, u.pinHash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      const sessUser = { userId: u.userId, fullName: u.fullName, roleId: role };
      await finalizeLoginSession(req, "admin", sessUser);

      return res.json({ ok: true, scope: "admin", user: sessUser });
    } catch (e) {
      console.error("[admin/auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // Legacy login (kept for backward compatibility)
  // - ADMIN -> admin session
  // - STAFF/SUPERVISOR -> staff session
  app.post("/api/auth/login", rateLimitAuthLogin, express.json(), async (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName || !pin) return res.status(400).json({ ok: false, error: "fullName/pin required" });

      const u = db.prepare(`
        SELECT userId, fullName, pinHash, roleId, isActive
        FROM users
        WHERE lower(fullName) = lower(?)
        LIMIT 1
      `).get(fullName);

      if (!u || !u.isActive) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const role = String(u.roleId || "").toUpperCase();
      const ok = bcrypt.compareSync(pin, u.pinHash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      const sessUser = { userId: u.userId, fullName: u.fullName, roleId: role };
      if (role === "ADMIN") await finalizeLoginSession(req, "admin", sessUser);
      else await finalizeLoginSession(req, "staff", sessUser);

      return res.json({ ok: true, scope: (role === "ADMIN" ? "admin" : "staff"), user: sessUser });
    } catch (e) {
      console.error("[auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // "me" endpoints are separated to prevent cross-app session bleed.
  app.get("/api/staff/auth/me", requireAuth, (req, res) => {
    const u = getSessionUser(req);
    const perms = getUserPerms(getRoleId(u));
    res.json({ ok: true, user: u, permissions: perms });
  });

  app.get("/api/admin/auth/me", requireAuth, (req, res) => {
    const u = getSessionUser(req);
    const perms = getUserPerms(getRoleId(u));
    res.json({ ok: true, user: u, permissions: perms });
  });

  // Legacy /api/auth/me kept (uses getSessionUser routing by URL)
  app.get("/api/auth/me", requireAuth, (req, res) => {
    const u = getSessionUser(req);
    const perms = getUserPerms(getRoleId(u));
    res.json({ ok: true, user: u, permissions: perms });
  });

  // Logout (separated)
  app.post("/api/staff/auth/logout", (req, res) => {
    try { clearSessionUser(req, "staff"); } catch {}
    res.json({ ok: true });
  });

  app.post("/api/admin/auth/logout", (req, res) => {
    try { clearSessionUser(req, "admin"); } catch {}
    res.json({ ok: true });
  });

  // Legacy logout: destroys everything (kept for older pages)
  app.post("/api/auth/logout", (req, res) => {
    try {
      req.session.destroy(() => res.json({ ok: true }));
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

  /* ===================== END SECURITY ADDON ===================== */

  // --- Realtime (SSE) clients ---
  const sseClients = new Set();

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
      sseSend(res, "overview", computeAdminTodayStats(db, getBranchCode(), bd));
    } catch {}

    sseClients.add(res);

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
    for (const res of sseClients) {
      try {
        sseSend(res, event, payload);
      } catch {}
    }
  }

  // expose broadcaster + overview calculator to helpers
  app.set("broadcast", broadcast);
  app.set("computeOverview", () => {
    const bd = ensureBusinessDate(db);
    return computeAdminTodayStats(db, getBranchCode(), bd);
  });

  /* ---------- pages ---------- */

  /* ---------- QR: Dynamic Guest Registration ---------- */
app.set("trust proxy", true); // needed for deployed environments

app.get("/qr/guest", async (req, res) => {
  try {
    const proto =
      (req.headers["x-forwarded-proto"] || req.protocol || "http")
        .split(",")[0]
        .trim();

        const host = String(req.get("host") || ""); // includes port if any
    const hostPort = host.includes(":") ? host.split(":")[1] : "";
    const portStr = hostPort || String(port || 3000);

    const lan = getLanIPv4();
    const baseHost = lan ? `${lan}:${portStr}` : host;

    const guestUrl = `${proto}://${baseHost}${pathWithBase("/guest")}`;


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
  try {
    const orientation = String(getAppSetting("display.orientation") || "landscape");
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
    res.sendFile(path.join(__dirname, "static", "display-landscape.html"))
  );
  
  // Serve the portrait display entry HTML
  app.get("/display-portrait.html", (_req, res) =>
    res.sendFile(path.join(__dirname, "static", "display-portrait.html"))
  );
app.get("/staff", requireStaffPage, (_, res) =>
  res.sendFile(path.join(__dirname, "static", "staff.html"))
);

/* ---------- Admin: QR (PNG for preview / print / download) ---------- */
app.get("/api/admin/qrcode.png", requireAuth, (req, res) => {
  try {
    // Reuse the same QR logic used by /qr/guest
    // Internally redirect so we keep ONE source of truth
    req.url = "/qr/guest";
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


  app.get("/guest", (_, res) => res.sendFile(path.join(__dirname, "static", "guest.html")));
  app.get("/test", (_req, res) =>
    res.sendFile(path.join(__dirname, "static", "test.html"))
  );
 
  // ✅ Admin page requires login (so permission-gated actions like Media Folder work)
   app.get("/admin", requireAdminPage, (_, res) =>
  res.sendFile(path.join(__dirname, "static", "admin.html"))
);

app.get("/admin-login", (_, res) =>
  res.sendFile(path.join(__dirname, "static", "admin-login.html"))
);


  app.get("/staff-login", (_, res) =>
  res.sendFile(path.join(__dirname, "static", "staff-login.html"))
);


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

      let branchName = row.branchCode;
      try {
        const cfg = getBranchConfigSafe();
        if (cfg && cfg.branchName) branchName = String(cfg.branchName).trim() || branchName;
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
        },
      });
    } catch (e) {
      console.error("[api/guest/ticket]", e);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- admin/business date ---------- */

  app.get("/api/public/business-date", (_, res) => {
    try {
      const cur = ensureBusinessDate(db);
      const cfg = getBranchConfigSafe();
      res.json({
        ok: true,
        branchCode: getBranchCode(),
        branchName: String(cfg.branchName || "").trim(),
        timezone: String(cfg.timezone || "Asia/Manila"),
        currentBusinessDate: cur,
        todayManila: getTodayManila(),
      });
    } catch (e) {
      console.error("[public/business-date]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.get("/api/admin/business-date", requireAuth, (_, res) => {
    try {
      const cur = ensureBusinessDate(db);
      const cfg = getBranchConfigSafe();
      res.json({
        ok: true,
        branchCode: getBranchCode(),
        branchName: String(cfg.branchName || "").trim(),
        timezone: String(cfg.timezone || "Asia/Manila"),
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
        setState(db, "lastManualCloseDayAt", now);
      } else {
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

  app.get("/api/admin/branch", requireAuth, (_, res) => {
    try {
      const row = getBranchConfigSafe();
      res.json({ ok: true, branch: row || null });
    } catch (e) {
      console.error("[admin/branch:get]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  app.post("/api/admin/branch", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    try {
      const branchName = String(req.body.branchName || "").trim();
      if (!branchName) return res.status(400).json({ ok: false, error: "branchName is required." });

      const cfg = getBranchConfigSafe();
      const currentCode = String(cfg.branchCode || branchCode).trim() || branchCode;

      const requestedCode = String(req.body.branchCode || "").trim();
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
      const timezone = String(req.body.timezone || cfg.timezone || "Asia/Manila").trim() || "Asia/Manila";

      const now = Date.now();
      const existing = db.prepare(`SELECT id FROM branch_config WHERE id=1`).get();
      if (!existing) {
        db.prepare(
          `INSERT INTO branch_config(id, branchCode, branchName, timezone, createdAt, updatedAt)
         VALUES(1, ?, ?, ?, ?, ?)`
        ).run(nextCode, branchName, timezone, now, now);
      } else {
        const r = db
          .prepare(`UPDATE branch_config SET branchCode=?, branchName=?, timezone=?, updatedAt=? WHERE id=1`)
          .run(nextCode, branchName, timezone, now);

        if (!r || r.changes === 0) {
          return res.status(500).json({
            ok: false,
            error: "Branch config update failed (0 rows changed). Database row id=1 may be missing/corrupted.",
          });
        }

      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_BRANCH_UPDATE",
        JSON.stringify({
          actor: actorFromReq(req),
          prevBranchCode: currentCode,
          branchCode: nextCode,
          branchName,
          timezone,
          codeChanged: wantsCodeChange,
        }),
        now
      );

      emitChanged(app, db, "ADMIN_BRANCH_UPDATE", { branchCode: nextCode });

      res.json({ ok: true, branchCode: nextCode, branchName, timezone });
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
  const token = extractDisplayToken(req);
  if (token) {
    const tokenHash = hashDisplayToken(token);
    const list = getPairedDisplayDevices();
    const device = list.find((d) => !d.revokedAt && String(d.tokenHash || "") === tokenHash);
    if (device) {
      const currentBranchCode = String(getBranchCode() || "").trim();
      const pairedBranchCode = String(device.branchCode || "").trim();
      if (pairedBranchCode && currentBranchCode && pairedBranchCode !== currentBranchCode) {
        return res.status(401).json({
          ok: false,
          error: "Display token belongs to a different branch. Re-pair this screen.",
        });
      }
      req.displayToken = token;
      req.displayDevice = device;
      setDisplayAuthCookie(res, token);
      touchDisplayDevice(device.id, { lastIp: getReqIp(req) });
      return next();
    }
  }

  // Legacy fallback if DISPLAY_KEY still exists in environment.
  const expected = String(process.env.DISPLAY_KEY || "").trim();
  if (expected) {
    const got = String(req.headers["x-display-key"] || "").trim();
    if (got && got === expected) return next();
  }

  return res.status(401).json({ ok: false, error: "Display not authorized" });
}

app.get("/api/display/settings", requireDisplayAuth, (req, res) => {
  try {
    const showVideo = String(getAppSetting("display.showVideo") || "false");
    const orientation = String(getAppSetting("display.orientation") || "landscape");

    res.json({
      ok: true,
      settings: {
        "display.showVideo": showVideo,
        "display.orientation": orientation,
      },
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
    const list = [{
      code,
      createdAt: now,
      createdBy: actorFromReq(req),
    }];
    saveDisplayPairCodes(list);
    setAppSetting(
      DISPLAY_LAST_PAIR_CODE_KEY,
      JSON.stringify({ code, createdAt: now }),
    );

    return res.json({ ok: true, code, createdAt: now });
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
    codes.splice(idx, 1);
    saveDisplayPairCodes(codes);
    const nextCode = codes.length ? codes[codes.length - 1] : null;
    setAppSetting(
      DISPLAY_LAST_PAIR_CODE_KEY,
      nextCode ? JSON.stringify({ code: String(nextCode.code || ""), createdAt: Number(nextCode.createdAt || Date.now()) }) : "",
    );

    const token = randomBytes(32).toString("hex");
    const tokenHash = hashDisplayToken(token);
    const deviceId = randomUUID();
    const branchCode = String(getBranchCode() || "").trim();
    const branchName = String(getBranchName() || "").trim();

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

    setAppSetting("media.sourceDir", folder);
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_SOURCE_UPDATE",
      JSON.stringify({ actor: actorFromReq(req), folder }),
      Date.now()
    );
    emitChanged(app, db, "ADMIN_MEDIA_SOURCE_UPDATE", { folder });

    return res.json({ ok: true, folder });
  } catch (e) {
    console.error("[admin/media/source/select]", e);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.post("/api/admin/media/source/clear", requirePerm("SETTINGS_MANAGE"), (req, res) => {
  try {
    const now = Date.now();
    setAppSetting("media.sourceDir", "");
    db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
      "ADMIN_MEDIA_SOURCE_UPDATE",
      JSON.stringify({ actor: actorFromReq(req), folder: "" }),
      now
    );
    emitChanged(app, db, "ADMIN_MEDIA_SOURCE_UPDATE", { folder: "" });
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

  app.get("/api/admin/users", requirePerm("USERS_MANAGE"), (_, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT userId, fullName, roleId, isActive, createdAt, updatedAt, lastLoginAt
         FROM users
         ORDER BY createdAt DESC`
        )
        .all();
      res.json({ ok: true, users: rows });
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

      const userId = randomUUID();
      const pinHash = bcrypt.hashSync(pin, 10);
      const now = Date.now();

      db.prepare(
        `INSERT INTO users(userId, fullName, pinHash, roleId, isActive, createdAt, updatedAt)
         VALUES(?,?,?,?,1,?,?)`
      ).run(userId, fullName, pinHash, roleId, now, now);

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_USER_CREATE",
        JSON.stringify({ actor: actorFromReq(req), userId, fullName, roleId }),
        now
      );

      res.json({ ok: true, userId });
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

      if (!userId) return res.status(400).json({ ok: false, error: "Missing userId." });

      const now = Date.now();
      const existing = db.prepare(`SELECT userId FROM users WHERE userId=?`).get(userId);
      if (!existing) return res.status(404).json({ ok: false, error: "User not found." });

      if (fullName) {
        db.prepare(`UPDATE users SET fullName=?, updatedAt=? WHERE userId=?`).run(fullName, now, userId);
      }
      if (roleId && ["STAFF", "SUPERVISOR", "ADMIN"].includes(roleId)) {
        db.prepare(`UPDATE users SET roleId=?, updatedAt=? WHERE userId=?`).run(roleId, now, userId);
      }
      if (typeof isActive === "boolean" || isActive === 0 || isActive === 1) {
        db.prepare(`UPDATE users SET isActive=?, updatedAt=? WHERE userId=?`).run(isActive ? 1 : 0, now, userId);
      }

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_USER_UPDATE",
        JSON.stringify({ actor: actorFromReq(req), userId, fullName, roleId, isActive }),
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
      const updated = db.prepare(`UPDATE users SET isActive=0, updatedAt=? WHERE userId=?`).run(now, userId);
      if (!updated.changes) return res.status(404).json({ ok: false, error: "User not found." });

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_USER_DELETE",
        JSON.stringify({ actor: actorFromReq(req), userId }),
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

  /* ---------- health ---------- */

  app.get("/api/health", (_, res) => {
    const bc = getBranchCode();
    res.json({
      ok: true,
      branchCode: bc,
      branchName: getBranchName(),
      port,
      currentBusinessDate: ensureBusinessDate(db),
      todayManila: getTodayManila(),
    });
  });

  /* ---------- admin/system backup + restore ---------- */
  // Creates a deterministic internal DB snapshot under <baseDir>/backups.
  // Other backup flows (export) reuse this so behavior stays consistent.
  function createInternalDbBackup() {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const backupsDir = path.join(baseDir, "backups");
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

    const fileName = `qsys-backup-${ts}.db`;
    const outPath = path.join(backupsDir, fileName);
    const escapedOutPath = outPath.replace(/'/g, "''");

    // Flush WAL pages before creating a compact snapshot.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec(`VACUUM INTO '${escapedOutPath}'`);

    return { fileName, filePath: outPath, sizeBytes: fs.statSync(outPath).size };
  }

  let seedTodayInProgress = false;

  // Seed realistic test queue data for today's business date.
  app.post("/api/admin/system/seed-today", requirePerm("SETTINGS_MANAGE"), (req, res) => {
    if (seedTodayInProgress) {
      return res.status(409).json({ ok: false, error: "Seed job is already running." });
    }
    seedTodayInProgress = true;

    const seedScript = path.join(__dirname, "seed-demo-today.js");
    const args = [seedScript, baseDir];
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
              durationMs,
              output: out,
            }),
            Date.now()
          );
        } catch {}

        return res.json({
          ok: true,
          message: "Seed completed.",
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
      const backupsDir = path.join(baseDir, "backups");
      if (!fs.existsSync(backupsDir)) {
        return res.status(400).json({ ok: false, error: "No backups directory found." });
      }

      const candidates = fs
        .readdirSync(backupsDir)
        .filter((f) => /^qsys-backup-.*\.db$/i.test(f))
        .map((f) => ({
          name: f,
          full: path.join(backupsDir, f),
          mtime: fs.statSync(path.join(backupsDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (!candidates.length) {
        return res.status(400).json({ ok: false, error: "No backup files found." });
      }

      const latest = candidates[0];
      const dbPath = path.join(baseDir, "data", "qsys.db");
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      const now = Date.now();

      db.prepare(`INSERT INTO audit_logs(action, payload, createdAt) VALUES(?,?,?)`).run(
        "ADMIN_DB_RESTORE",
        JSON.stringify({
          actor: actorFromReq(req),
          sourceFile: latest.name,
          sourcePath: latest.full,
        }),
        now
      );

      db.close();
      fs.copyFileSync(latest.full, dbPath);
      try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch {}
      try { if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath); } catch {}

      // Relaunch app so server/db reopen cleanly with the restored file.
      try {
        const electron = require("electron");
        if (electron && electron.app) {
          setTimeout(() => {
            try {
              electron.app.relaunch();
              electron.app.exit(0);
            } catch {}
          }, 1200);
        }
      } catch {}

      return res.json({
        ok: true,
        restoredFrom: latest.name,
        message: "Database restored. QSys will restart now.",
      });
    } catch (e) {
      console.error("[admin/system/restore]", e);
      return res.status(500).json({ ok: false, error: "Restore failed." });
    }
  });
  
  /* ---------- system: display window (Electron host) ---------- */
app.get("/api/system/display/state", requireStaffApi, (req, res) => {
  try {
    const ctrl = global.QSYS_DISPLAY;
    if (!ctrl) return res.json({ ok: true, on: false, note: "Display controller not available" });
    return res.json(ctrl.state());
  } catch (e) {
    console.error("[display/state]", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/system/display/open", requireStaffApi, (req, res) => {
  try {
    const ctrl = global.QSYS_DISPLAY;
    if (!ctrl) return res.status(400).json({ ok: false, error: "Display controller not available" });
    return res.json(ctrl.open());
  } catch (e) {
    console.error("[display/open]", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/system/display/close", requireStaffApi, (req, res) => {
  try {
    const ctrl = global.QSYS_DISPLAY;
    if (!ctrl) return res.status(400).json({ ok: false, error: "Display controller not available" });
    return res.json(ctrl.close());
  } catch (e) {
    console.error("[display/close]", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

  /* ---------- state snapshot (DISPLAY + STAFF) ---------- */
  // SECURITY ADDON: must be authenticated
  app.get("/api/state", requireAuth, (_, res) => {
    const businessDate = ensureBusinessDate(db);
    const bc = getBranchCode();

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

    res.json({ ok: true, branchCode: bc, branchName: getBranchName(), businessDate, rows });
  });


/* ---------- state snapshot (DISPLAY AUTHORIZED DEVICE) ---------- */
app.get("/api/display/state", requireDisplayAuth, (req, res) => {

  // Prevent caching on kiosk devices
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");

  const businessDate = ensureBusinessDate(db);
  const bc = getBranchCode();

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

  res.json({ ok: true, version, branchCode: bc, branchName: getBranchName(), businessDate, rows });
});



  /* ---------- Admin: Today stats (all statuses) ---------- */
  app.get("/api/admin/stats/today", requireAuth, (_, res) => {
    try {
      const businessDate = ensureBusinessDate(db);
      const payload = computeAdminTodayStats(db, getBranchCode(), businessDate);
      res.json(payload);
    } catch (e) {
      console.error("[admin/stats/today]", e);
      res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  /* ---------- Admin: EMA(14) from daily_group_stats ---------- */
  app.get("/api/admin/stats/ema14", requireAuth, (_, res) => {
    try {
      const bc = getBranchCode();
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
    const explicitScope = safeFilePart(o.scopeLabel || "");
    const scope = explicitScope || (f && t ? (f === t ? f : `${f}_to_${t}`) : (f || t || "scope"));
    const stamp = safeFilePart(o.stamp || "") || fileStampNow();
    const ext = safeFilePart(o.ext || "csv") || "csv";
    return `${bc}_${scope}_${rk}_${stamp}.${ext}`;
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
      const bc = getBranchCode();
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
          nextCalls: String(r.next_calls || "").trim(),
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
      const bc = getBranchCode();
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
        String(r.next_calls || "").trim(),
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
      const bc = getBranchCode();
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

  // Daily rollup export from pre-aggregated stats table.
  app.get("/api/admin/reports/daily_summary", requirePerm("REPORT_EXPORT_CSV"), (req, res) => {
    try {
      const bc = getBranchCode();
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
      const bc = getBranchCode();
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
  function buildCustomSummary(from, to, sinceMs){
    const bc = getBranchCode();

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
      const result = buildCustomSummary(from, to, sinceMs);

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
      const result = buildCustomSummary(from, to, sinceMs);

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

      const bc = getBranchCode();
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
    const bc = getBranchCode();
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
    const bc = getBranchCode();
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

  function buildTicketsCsvForRange(from, to, sinceMs) {
    const bc = getBranchCode();
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
      String(r.next_calls || "").trim(),
      fmtTs(r.seatedAt),
      fmtTs(r.skippedAt),
      r.calledNote || "",
      minsDiff(r.createdAtLocal, r.calledAt),
      minsDiff(r.createdAtLocal, r.seatedAt),
    ]);
    return rowsToCsv(header, outRows);
  }

  function buildDailySummaryCsvForRange(from, to, sinceMs) {
    const bc = getBranchCode();
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

  function buildDailySummaryRowsForRange(from, to, sinceMs) {
    const bc = getBranchCode();
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

  function buildDailySummaryHtmlForRange(from, to, sinceMs) {
    const bc = getBranchCode();
    const rows = buildDailySummaryRowsForRange(from, to, sinceMs);
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

  function buildCustomSummaryCsvForRange(from, to, sinceMs) {
    const result = buildCustomSummary(from, to, sinceMs);
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

  function buildReportSummaryCsvForRange(from, to, waitRef, sinceMs) {
    const bc = getBranchCode();
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

  function safeParseJson(text, fallback = null) {
    try {
      return JSON.parse(String(text || ""));
    } catch {
      return fallback;
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

      const bc = getBranchCode();
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
          data: Buffer.from(buildTicketsCsvForRange(from, to, sinceMs), "utf8"),
        });
      }
      if (include("daily_summary_csv")) {
        files.push({
          name: reportFileName("daily_summary", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
          mimeType: "text/csv",
          data: Buffer.from(buildDailySummaryCsvForRange(from, to, sinceMs), "utf8"),
        });
      }
      if (include("daily_summary_html")) {
        files.push({
          name: reportFileName("daily_summary_formatted", bc, from, to, { scopeLabel, stamp, ext: "html" }),
          mimeType: "text/html",
          data: Buffer.from(buildDailySummaryHtmlForRange(from, to, sinceMs), "utf8"),
        });
      }
      if (include("custom_summary")) {
        files.push({
          name: reportFileName("custom_summary", bc, from, to, { scopeLabel, stamp, ext: "csv" }),
          mimeType: "text/csv",
          data: Buffer.from(buildCustomSummaryCsvForRange(from, to, sinceMs), "utf8"),
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
  app.post("/api/queue/create", rateLimitQueueCreate, (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      const pax = Number(req.body.pax || 1);
      const priorityType = normalizePriority(req.body.priorityType);

      if (!name) return res.status(400).json({ ok: false, error: "Name is required." });
      if (!Number.isFinite(pax) || pax < 1 || pax > 50)
        return res.status(400).json({ ok: false, error: "Pax must be 1–50." });

      const businessDate = ensureBusinessDate(db);
      const bc = getBranchCode();
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
        JSON.stringify({ id, groupCode, queueNum, name, pax, priorityType, businessDate }),
        Date.now()
      );

      emitChanged(app, db, "QUEUE_CREATE");
      res.json({ ok: true, id, businessDate, groupCode, queueNum });
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
      const bc = getBranchCode();

      const called = db
        .prepare(
          `
      SELECT id, groupCode, queueNum, name, calledAt, next_calls
      FROM queue_items
      WHERE branchCode=? AND businessDate=? AND groupCode=? AND status='CALLED'
      LIMIT 1
    `
        )
        .get(bc, businessDate, groupCode);

      if (!called) return res.json({ ok: false, error: "No CALLED ticket to clear." });

      // Preserve call history: move current calledAt into next_calls before clearing.
      const currentCalledAt = Number(called.calledAt || 0);
      const prevNextCalls = String(called.next_calls || "").trim();
      const parts = prevNextCalls ? prevNextCalls.split(",").map((s) => s.trim()).filter(Boolean) : [];
      if (Number.isFinite(currentCalledAt) && currentCalledAt > 0) {
        parts.push(String(currentCalledAt));
      }
      const mergedNextCalls = parts.join(",");

      db.prepare(
        `
      UPDATE queue_items
      SET status='WAITING', calledAt=NULL, next_calls=?, calledNote=NULL
      WHERE id=?
    `
      ).run(mergedNextCalls, called.id);

      db.prepare(
        `
      INSERT INTO audit_logs (action, payload, createdAt)
      VALUES (?, ?, ?)
    `
      ).run("QUEUE_CLEAR_CALLED", JSON.stringify({ actor: actorFromReq(req), ...called, businessDate }), Date.now());

      emitChanged(app, db, "QUEUE_CLEAR_CALLED");
      res.json({ ok: true, cleared: called });
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

      // Calling behavior within the same bucket:
      // - AUTO (default): Priority first, then regular (previous behavior)
      // - PRIORITY: Priority-only
      // - REGULAR: Regular-only
      const pick = String(req.body.pick || "AUTO").toUpperCase();
      const wantPriorityOnly = pick === "PRIORITY";
      const wantRegularOnly = pick === "REGULAR";

      const businessDate = ensureBusinessDate(db);
      const bc = getBranchCode();
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
          JSON.stringify({ actor, ...next, status: "CALLED", branchCode: bc, businessDate }),
          now
        );

        return { ...next, status: "CALLED" };
      });

      const called = tx();
      emitChanged(app, db, "QUEUE_CALL", { groupCode });
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
      const bc = getBranchCode();
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
      try {
        const io = req.app.get("io");
        if (io) io.emit("display:recall", { id: called.id, groupCode: called.groupCode, at: now });
      } catch {}

      // Also notify other clients that something changed (overview/SSE etc.)
      emitChanged(req.app, db, "QUEUE_CALL_AGAIN", { groupCode, id: called.id });

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

      const id = String(req.body.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Missing id." });

      const noteRaw = String(req.body.note || "").trim();
      const note = noteRaw ? noteRaw.slice(0, 200) : null;

      const businessDate = ensureBusinessDate(db);
      const bc = getBranchCode();

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

        const okPin = bcrypt.compareSync(supPin, sup.pinHash);
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
      emitChanged(app, db, "QUEUE_CALL", { groupCode });
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
      const bc = getBranchCode();
      const actor = actorFromReq(req);

      const tx = db.transaction(() => {
        const called = db
          .prepare(
            `
        SELECT id, groupCode, queueNum, name, pax, status
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
          JSON.stringify({ actor, ...called, status: "SEATED", branchCode: bc, businessDate }),
          now
        );

        return { ...called, status: "SEATED" };
      });

      const seated = tx();
      emitChanged(app, db, "QUEUE_SEAT", { groupCode });
      return res.json({ ok: true, seated });
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
      const bc = getBranchCode();
      const actor = actorFromReq(req);

      const tx = db.transaction(() => {
        let target = db
          .prepare(
            `
        SELECT id, groupCode, queueNum, status, name, pax
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
          SELECT id, groupCode, queueNum, status, name, pax
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
          JSON.stringify({ actor, ...target, status: "SKIPPED", branchCode: bc, businessDate }),
          now
        );

        return { ...target, status: "SKIPPED" };
      });

      const skipped = tx();
      emitChanged(app, db, "QUEUE_SKIP", { groupCode });
      return res.json({ ok: true, skipped });
    } catch (e) {
      if (e && typeof e.http === "number") return res.status(e.http).json({ ok: false, error: e.message });
      console.error("[staff/skip]", e);
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
  const exts = /\.(mp4|webm|m4v|mov)$/i;
  if (!dirAbs) return [];
  try {
    if (!fs.existsSync(dirAbs)) return [];
    return fs
      .readdirSync(dirAbs)
      .filter((f) => exts.test(f))
      // ignore hidden/system junk
      .filter((f) => !String(f).startsWith("."));
  } catch {
    return [];
  }
}

app.get("/media/custom/:name", requireDisplayAuth, (req, res) => {
  try {
    const base = String(getAppSetting("media.sourceDir") || "").trim();
    if (!base) return res.status(404).end();

    const name = String(req.params.name || "");
    const exts = /\.(mp4|webm|m4v|mov)$/i;
    if (!exts.test(name)) return res.status(400).end();

    // Path traversal defense
    const abs = path.resolve(base, name);
    const baseResolved = path.resolve(base);
    if (!abs.startsWith(baseResolved + path.sep)) return res.status(403).end();

    if (!fs.existsSync(abs)) return res.status(404).end();
    return res.sendFile(abs);
  } catch (e) {
    console.error("[media:custom]", e);
    return res.status(500).end();
  }
});

app.get("/wifi-qr-test", (req, res) => {
  res.sendFile(path.join(__dirname, "static", "wifi-qr-test.html"));
});

  /* ---------- MEDIA LIST ---------- */
app.get("/api/media/list", requireDisplayAuth, (req, res) => {

  try {
    const exts = /\.(mp4|webm|ogg|m4v|mov)$/i;

    // 1) Try custom folder
    const sourceDir = String(getAppSetting("media.sourceDir") || "").trim();
    if (sourceDir) {
      try {
        if (fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory()) {
          const customFiles = fs
            .readdirSync(sourceDir)
            .filter((f) => exts.test(f))
            .map(
              (f) =>
                `/media/custom/${encodeURIComponent(f)}`,
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
      .filter((f) => exts.test(f))
      .map((f) => `/static/media/${encodeURIComponent(f)}`);

    return res.json({ ok: true, files, source: "bundled" });
  } catch (e) {
    console.error("[media:list]", e);
    res.status(500).json({ ok: false, files: [] });
  }
});



  /* ---------- socket ---------- */
  const server = http.createServer(app);
  const io = new Server(server, {
    path: pathWithBase("/socket.io"),
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        try {
          const u = new URL(String(origin));
          const host = String(u.hostname || "").toLowerCase();
          if (host === "127.0.0.1" || host === "localhost") return cb(null, true);
        } catch {}
        return cb(new Error("Not allowed by CORS"));
      },
    },
  });
  app.set("io", io);

  io.on("connection", (socket) => {
    socket.emit("hello", { ok: true, branchCode: getBranchCode(), branchName: getBranchName() });
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

  return { server, io, db };
}

module.exports = { startServer };
