CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  branchCode TEXT NOT NULL,
  businessDate TEXT NOT NULL,
  groupCode TEXT NOT NULL,
  queueNum INTEGER NOT NULL,
  name TEXT NOT NULL,
  pax INTEGER NOT NULL,
  status TEXT NOT NULL,          -- WAITING / CALLED / SEATED / SKIPPED
  priorityType TEXT DEFAULT 'NONE', -- NONE / SENIOR / PWD / PREGNANT
  createdAtLocal INTEGER NOT NULL,
  calledAt INTEGER,
  seatedAt INTEGER,
  skippedAt INTEGER,
  calledNote TEXT,
  next_calls TEXT
);


CREATE INDEX IF NOT EXISTS idx_queue_lookup
ON queue_items(branchCode, businessDate, status, groupCode, queueNum);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  payload TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  branchCode TEXT NOT NULL,
  branchName TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Manila',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);


CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  roleId TEXT PRIMARY KEY,          -- 'STAFF' | 'SUPERVISOR' | 'ADMIN'
  roleName TEXT NOT NULL,
  isSystem INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  permKey TEXT PRIMARY KEY,         -- e.g. 'QUEUE_CALL_NEXT'
  permName TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  roleId TEXT NOT NULL,
  permKey TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (roleId, permKey),
  FOREIGN KEY (roleId) REFERENCES roles(roleId),
  FOREIGN KEY (permKey) REFERENCES permissions(permKey)
);

CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,          -- uuid
  fullName TEXT NOT NULL,
  pinHash TEXT NOT NULL,            -- bcrypt hash
  roleId TEXT NOT NULL,
  isActive INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  lastLoginAt INTEGER,
  FOREIGN KEY (roleId) REFERENCES roles(roleId)
);

CREATE TABLE IF NOT EXISTS user_overrides (
  userId TEXT NOT NULL,
  permKey TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (userId, permKey),
  FOREIGN KEY (userId) REFERENCES users(userId),
  FOREIGN KEY (permKey) REFERENCES permissions(permKey)
);

CREATE TABLE IF NOT EXISTS daily_group_stats (
  businessDate TEXT NOT NULL,     -- 'YYYY-MM-DD'
  branchCode TEXT NOT NULL,
  groupCode TEXT NOT NULL,        -- P/A/B/C/D
  registeredCount INTEGER NOT NULL DEFAULT 0,
  calledCount INTEGER NOT NULL DEFAULT 0,
  seatedCount INTEGER NOT NULL DEFAULT 0,
  skippedCount INTEGER NOT NULL DEFAULT 0,
  overrideCalledCount INTEGER NOT NULL DEFAULT 0,

  -- wait-time raw inputs (minutes)
  waitSumMinutes REAL NOT NULL DEFAULT 0,
  waitCount INTEGER NOT NULL DEFAULT 0,

  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (businessDate, branchCode, groupCode)
);

ALTER TABLE queue_items ADD COLUMN next_calls TEXT;
