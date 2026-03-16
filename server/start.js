const path = require("path");
const fs = require("fs");
const { startServer } = require("./server");

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const baseDir = path.resolve(process.env.QSYS_DATA_DIR || path.join(process.cwd(), "data"));
const port = toInt(process.env.PORT, 3000);
const branchCode = String(process.env.BRANCH_CODE || "OG").trim() || "OG";

ensureDir(baseDir);

console.log(`[QSysServer] starting with data dir: ${baseDir}`);
console.log(`[QSysServer] port: ${port}`);
console.log(`[QSysServer] branch code: ${branchCode}`);
console.log(`[QSysServer] base path: ${String(process.env.APP_BASE_PATH || "/")}`);

startServer({ baseDir, port, branchCode });
