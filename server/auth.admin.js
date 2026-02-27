// server/auth.admin.js
// Admin-scoped auth (isolated from staff session)
const express = require("express");

module.exports = function createAdminAuth({ db, bcrypt, getUserPerms }) {
  const router = express.Router();

  function requireAdminApi(req, res, next) {
    const u = req.session?.adminUser;
    if (!u) return res.status(401).json({ ok: false, error: "Not authenticated" });
    next();
  }

  function requireAdminPage(req, res, next) {
    const u = req.session?.adminUser;
    if (!u) return res.redirect("/admin-login");
    // hard lock: only ADMIN role can load admin pages
    const roleId = String(u.roleId || "").toUpperCase();
    if (roleId !== "ADMIN") return res.redirect("/admin-login");
    next();
  }

  // Login (ADMIN scope): strictly ADMIN role
  router.post("/api/admin/auth/login", express.json(), (req, res) => {
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

      const roleId = String(u.roleId || "").toUpperCase();
      if (roleId !== "ADMIN") return res.status(403).json({ ok: false, error: "Admin access only" });

      const ok = bcrypt.compareSync(pin, u.pinHash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

      const now = Date.now();
      db.prepare(`UPDATE users SET lastLoginAt=?, updatedAt=? WHERE userId=?`).run(now, now, u.userId);

      req.session.adminUser = {
        userId: u.userId,
        fullName: u.fullName,
        roleId,
      };

      return res.json({ ok: true, user: req.session.adminUser });
    } catch (e) {
      console.error("[admin/auth/login]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  router.get("/api/admin/auth/me", (req, res) => {
    const u = req.session?.adminUser;
    if (!u) return res.status(401).json({ ok: false, error: "Not authenticated" });
    const perms = getUserPerms(String(u.roleId || "").toUpperCase());
    return res.json({ ok: true, user: u, permissions: perms });
  });

  router.post("/api/admin/auth/logout", (req, res) => {
    try {
      // only clear admin scope
      if (req.session) req.session.adminUser = null;
      return res.json({ ok: true });
    } catch (e) {
      console.error("[admin/auth/logout]", e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  function mount(app) {
    app.use(router);
  }

  return { mount, requireAdminApi, requireAdminPage };
};
