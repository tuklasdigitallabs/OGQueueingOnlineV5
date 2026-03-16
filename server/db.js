const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Opens SQLite DB under:
 * <baseDir>/data/qsys.db
 *
 * In DEV: baseDir = projectRoot/data
 * In PROD: baseDir = C:\ProgramData\QSysLocal
 */
function openDb(baseDir) {
  const dataDir = path.join(baseDir, "data");
  ensureDir(dataDir);

  const dbPath = path.join(dataDir, "qsys.db");
  const db = new Database(dbPath);

  // Safe defaults for kiosk + multiple clients
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  return db;
}

module.exports = { openDb };
