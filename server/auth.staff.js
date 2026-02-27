// server/auth.staff.js
// Staff-scoped auth (isolated from admin session)
const express = require("express");

module.exports = function createStaffAuth({ db, bcrypt, getUserPerms }) {
  const router = express.Router();

  function requireStaffApi(req, res, next) {
    const u = req.session?.staffUser;
    if (!u) return res.status(401).json({ ok: false, error: "Not authenticated" });
    next();
  }

  function requireStaffPage(req, res, next) {
    const u = req.session?.staffUser;
    if (!u) return res.redirect("/staff-login");
    next();
  }

  // Login (STAFF scope): allows STAFF / SUPERVISOR / ADMIN (some shops let admins operate staff screen)
  router.post("/api/staff/auth/login", express.json(), (req, res) => {
    try {
      const fullName = String(req.body.fullName || "").trim();
      const pin = String(req.body.pin || "").trim();

      if (!fullName || !pin) {
        return res.status(400).json({ ok: false, error: "fullName/pin required" });
      }

      const u = db
        .prepare(
          `
          SELECT userId, fullName, pinHash, roleId, isActive
          FROM users
          WHERE lower(fullName) = lower(?)
          LIMIT 1
        `
        )
        .get(fullName);

      if (!u || !u.isActive) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const ok = bcrypt.compareSync(pin, u.pinHash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      req.session.staffUser = {
        userId: u.userId,
        fullName: u.fullName,
        roleId: String(u.roleId || "").toUpperCase(),
      };

      return res.json({ ok: true, user: req.session.staffUser });
    } catch (e) {
      console.error("[staff/auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  router.get("/api/staff/auth/me", (req, res) => {
    const u = req.session?.staffUser;
    if (!u) return res.status(401).json({ ok: false, error: "Not authenticated" });
    const perms = getUserPerms(String(u.roleId || "").toUpperCase());
    return res.json({ ok: true, user: u, permissions: perms });
  });

  router.post("/api/staff/auth/logout", (req, res) => {
    try {
      // only clear staff scope
      if (req.session) req.session.staffUser = null;
      return res.json({ ok: true });
    } catch (e) {
      console.error("[staff/auth/logout]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  function mount(app) {
    app.use(router);
  }

  return { mount, requireStaffApi, requireStaffPage };
};
