(function () {
  const $ = (id) => document.getElementById(id);

  const el = {
    healthDot: $("healthDot"),
    healthText: $("healthText"),
    baseUrl: $("baseUrl"),

    serverStatus: $("serverStatus"),
    branchCode: $("branchCode"),
    businessDate: $("businessDate"),
    localTime: $("localTime"),

    btnStaff: $("btnStaff"),
    btnAdmin: $("btnAdmin"),
    btnGuest: $("btnGuest"),
    btnDisplay: $("btnDisplay"),
    btnRefresh: $("btnRefresh"),
    btnShutdown: $("btnShutdown"),

    bootPct: $("bootPct"),
    bootBarFill: $("bootBarFill"),
    bootNow: $("bootNow"),
    bootList: $("bootList"),
    bootSummary: $("bootSummary"),
  };

  function setHealth(ok, text) {
    el.healthDot.classList.remove("ok", "bad");
    el.healthDot.classList.add(ok ? "ok" : "bad");
    el.healthText.textContent = text;
    el.serverStatus.textContent = ok ? "ONLINE" : "OFFLINE";
  }

  function safeJson(res) {
    return res.json().catch(() => ({}));
  }

  function setBootProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (el.bootPct) el.bootPct.textContent = `${pct}%`;
    if (el.bootBarFill) el.bootBarFill.style.width = `${pct}%`;
    if (el.bootSummary) el.bootSummary.textContent = `Loaded ${done} of ${total} checks`;
  }

  function addBootRow(label) {
    if (!el.bootList) return null;
    const li = document.createElement("li");
    const file = document.createElement("span");
    const state = document.createElement("span");
    file.className = "bootFile mono";
    state.className = "bootState";
    file.textContent = label;
    state.textContent = "PENDING";
    li.appendChild(file);
    li.appendChild(state);
    el.bootList.appendChild(li);
    return state;
  }

  async function probe(url, method) {
    const res = await fetch(url, { method: method || "GET", cache: "no-store" });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pingHealth() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error("health not ok");
      setHealth(true, "Server online");
      return true;
    } catch (e) {
      setHealth(false, "Server offline");
      return false;
    }
  }

  async function fetchBranchInfoBestEffort() {
    const candidates = [
      "/api/public/business-date",
      "/api/public/branch",
      "/api/branch",
      "/api/admin/branch-config",
    ];

    let gotBranchCode = false;
    let gotBusinessDate = false;

    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const j = await safeJson(res);

        const bc =
          j.branchCode ||
          j.branch?.branchCode ||
          j.cfg?.branchCode ||
          j.row?.branchCode;

        const bd =
          j.currentBusinessDate ||
          j.businessDate ||
          j.todayManila ||
          j.branch?.currentBusinessDate ||
          j.data?.currentBusinessDate;

        if (bc) {
          el.branchCode.textContent = String(bc);
          gotBranchCode = true;
        }
        if (bd) {
          el.businessDate.textContent = String(bd);
          gotBusinessDate = true;
        }
        if (gotBranchCode && gotBusinessDate) return;
      } catch {
        // ignore and try next
      }
    }
  }

  function updateClock() {
    const d = new Date();
    el.localTime.textContent = d.toLocaleString();
  }

  function bindActions() {
    const qsys = window.qsys;

    if (!qsys) {
      console.error("window.qsys is missing. Preload bridge not injected.");
      setHealth(false, "Bridge missing");
      return false;
    }

    el.btnStaff?.addEventListener("click", () => qsys.openStaff());
    el.btnAdmin?.addEventListener("click", () => qsys.openAdmin());
    el.btnGuest?.addEventListener("click", () => qsys.openGuest());
    el.btnDisplay?.addEventListener("click", () => qsys.openDisplay());
    el.btnShutdown?.addEventListener("click", () => qsys.shutdownApp());

    el.btnRefresh?.addEventListener("click", async () => {
      const ok = await pingHealth();
      if (ok) await fetchBranchInfoBestEffort();
    });
    return true;
  }

  async function runStartupLoading() {
    const MIN_BOOT_MS = 3200;
    const MIN_STEP_MS = 420;
    const startedAt = Date.now();

    const checks = [
      { label: "bridge://window.qsys", run: async () => { if (!window.qsys) throw new Error("bridge missing"); } },
      { label: "/api/health", run: async () => probe("/api/health", "GET") },
      { label: "/display", run: async () => probe("/display", "HEAD") },
      { label: "/guest", run: async () => probe("/guest", "HEAD") },
      { label: "/static/launcher.html", run: async () => probe("/static/launcher.html", "HEAD") },
      { label: "/static/js/launcher.js", run: async () => probe("/static/js/launcher.js", "HEAD") },
    ];

    let done = 0;
    const total = checks.length;
    setBootProgress(done, total);

    for (const item of checks) {
      const stepStartedAt = Date.now();
      if (el.bootNow) el.bootNow.textContent = `Loading ${item.label}`;
      const stateEl = addBootRow(item.label);
      try {
        await item.run();
        if (stateEl) {
          stateEl.textContent = "OK";
          stateEl.classList.add("ok");
        }
      } catch (e) {
        if (stateEl) {
          stateEl.textContent = "FAILED";
          stateEl.classList.add("bad");
        }
        console.warn("[launcher-startup]", item.label, e);
      }
      const stepElapsed = Date.now() - stepStartedAt;
      if (stepElapsed < MIN_STEP_MS) {
        await sleep(MIN_STEP_MS - stepElapsed);
      }
      done += 1;
      setBootProgress(done, total);
    }

    const totalElapsed = Date.now() - startedAt;
    if (totalElapsed < MIN_BOOT_MS) {
      if (el.bootNow) el.bootNow.textContent = "Finalizing startup...";
      await sleep(MIN_BOOT_MS - totalElapsed);
    }

    if (el.bootNow) el.bootNow.textContent = "Startup checks complete";
    document.body.classList.add("ready");
  }

  async function boot() {
    el.baseUrl.textContent = window.appAbsoluteUrl("/");

    await runStartupLoading();
    const actionsBound = bindActions();

    if (!actionsBound) {
      if (el.bootNow) el.bootNow.textContent = "Bridge unavailable. Launcher controls are disabled.";
      return;
    }

    updateClock();
    setInterval(updateClock, 1000);

    const ok = await pingHealth();
    if (ok) await fetchBranchInfoBestEffort();

    setInterval(pingHealth, 4000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
