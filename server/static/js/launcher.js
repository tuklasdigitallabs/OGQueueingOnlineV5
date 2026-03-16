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
    serverUrlInput: $("serverUrlInput"),
    branchCodeInput: $("branchCodeInput"),
    displayModeInput: $("displayModeInput"),
    displayTargetInput: $("displayTargetInput"),
    resolvedDisplayUrl: $("resolvedDisplayUrl"),
    agentConfigStatus: $("agentConfigStatus"),
    btnSaveAgentConfig: $("btnSaveAgentConfig"),
    btnRefreshAgentConfig: $("btnRefreshAgentConfig"),

    btnDisplay: $("btnDisplay"),
    btnRefresh: $("btnRefresh"),
    btnShutdown: $("btnShutdown"),

    bootPct: $("bootPct"),
    bootBarFill: $("bootBarFill"),
    bootNow: $("bootNow"),
    bootList: $("bootList"),
    bootSummary: $("bootSummary"),
  };

  const state = {
    launcherConfig: null,
    displayTargets: [],
  };

  function normalizeServerUrl(serverUrl) {
    return String(serverUrl || "").trim().replace(/\/+$/, "");
  }

  function normalizeBranchCode(branchCode) {
    return String(branchCode || "").trim().toUpperCase();
  }

  function normalizeDisplayMode(mode) {
    return String(mode || "").toLowerCase() === "portrait" ? "portrait" : "landscape";
  }

  function buildResolvedDisplayUrl(config) {
    const branchCode = normalizeBranchCode(config?.branchCode);
    const serverUrl = normalizeServerUrl(config?.serverUrl);
    const mode = normalizeDisplayMode(config?.displayMode);
    if (!branchCode) return "-";
    const suffix = mode === "portrait" ? "display-portrait.html" : "display-landscape.html";
    if (!serverUrl) return `/b/${encodeURIComponent(branchCode)}/${suffix}`;
    return `${serverUrl}/b/${encodeURIComponent(branchCode)}/${suffix}`;
  }

  function setAgentStatus(text, isError) {
    if (!el.agentConfigStatus) return;
    el.agentConfigStatus.textContent = text;
    el.agentConfigStatus.style.color = isError ? "#fca5a5" : "";
  }

  function getSelectedDisplayTargetId() {
    const raw = String(el.displayTargetInput?.value || "").trim();
    if (!raw) return null;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function currentConfigFromForm() {
    return {
      serverUrl: normalizeServerUrl(el.serverUrlInput?.value),
      branchCode: normalizeBranchCode(el.branchCodeInput?.value),
      displayMode: normalizeDisplayMode(el.displayModeInput?.value),
      targetDisplayId: getSelectedDisplayTargetId(),
    };
  }

  function renderDisplayTargets(selectedId) {
    if (!el.displayTargetInput) return;
    const current = selectedId;
    el.displayTargetInput.innerHTML = "";

    const autoOption = document.createElement("option");
    autoOption.value = "";
    autoOption.textContent = "Primary / Auto";
    el.displayTargetInput.appendChild(autoOption);

    for (const item of state.displayTargets) {
      const option = document.createElement("option");
      option.value = String(item.id);
      option.textContent = `${item.label}${item.primary ? " (Primary)" : ""}`;
      el.displayTargetInput.appendChild(option);
    }

    if (current !== null && current !== undefined && current !== "") {
      el.displayTargetInput.value = String(current);
    } else {
      el.displayTargetInput.value = "";
    }
  }

  function renderResolvedDisplayUrl() {
    if (!el.resolvedDisplayUrl) return;
    const config = currentConfigFromForm();
    el.resolvedDisplayUrl.textContent = buildResolvedDisplayUrl(config);
  }

  function renderLauncherConfig(config) {
    state.launcherConfig = config || null;
    if (el.serverUrlInput) el.serverUrlInput.value = String(config?.serverUrl || "");
    if (el.branchCodeInput) el.branchCodeInput.value = normalizeBranchCode(config?.branchCode);
    if (el.displayModeInput) el.displayModeInput.value = normalizeDisplayMode(config?.displayMode);
    renderDisplayTargets(config?.targetDisplayId ?? null);
    renderResolvedDisplayUrl();
    if (el.baseUrl) {
      el.baseUrl.textContent = normalizeServerUrl(config?.serverUrl) || String(config?.localLauncherUrl || window.appAbsoluteUrl("/"));
    }
    if (el.branchCode) {
      el.branchCode.textContent = normalizeBranchCode(config?.branchCode) || "-";
    }
  }

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

  function getHealthUrl() {
    const config = state.launcherConfig || currentConfigFromForm();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    if (serverUrl) return `${serverUrl}/api/health`;
    return "/api/health";
  }

  async function getLauncherStatus() {
    if (window.qsys?.getLauncherStatus) {
      return window.qsys.getLauncherStatus();
    }
    const res = await fetch(getHealthUrl(), { cache: "no-store" });
    const j = await safeJson(res);
    return {
      ok: !!res.ok,
      healthOk: !!res.ok,
      branchCode: String(j.branchCode || ""),
      businessDate: String(j.currentBusinessDate || ""),
      branchName: "",
      baseUrl: getHealthUrl().replace(/\/api\/health$/, ""),
    };
  }

  async function pingHealth() {
    try {
      const status = await getLauncherStatus();
      if (!status?.healthOk) throw new Error("health not ok");
      setHealth(true, "Server online");
      if (status.baseUrl && el.baseUrl) el.baseUrl.textContent = String(status.baseUrl);
      if (status.businessDate) el.businessDate.textContent = String(status.businessDate);
      if (status.branchCode && el.branchCode) el.branchCode.textContent = String(status.branchCode);
      return true;
    } catch (e) {
      setHealth(false, "Server offline");
      return false;
    }
  }

  async function fetchBranchInfoBestEffort() {
    const config = state.launcherConfig || currentConfigFromForm();
    const serverUrl = normalizeServerUrl(config.serverUrl);
    const branchCode = normalizeBranchCode(config.branchCode);
    const prefix = serverUrl || "";
    const candidates = [
      branchCode ? `${prefix}/api/public/business-date?branchCode=${encodeURIComponent(branchCode)}` : null,
      `${prefix}/api/public/business-date`,
      `${prefix}/api/public/branch`,
      `${prefix}/api/branch`,
      `${prefix}/api/admin/branch-config`,
      branchCode ? `${prefix}/api/public/branches` : null,
    ];

    let gotBranchCode = false;
    let gotBusinessDate = false;

    for (const url of candidates) {
      if (!url) continue;
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

  async function loadDisplayTargets() {
    if (!window.qsys?.getDisplayTargets) return;
    const res = await window.qsys.getDisplayTargets();
    if (!res?.ok) throw new Error(res?.error || "Unable to load display targets");
    state.displayTargets = Array.isArray(res.displays) ? res.displays : [];
    renderDisplayTargets(state.launcherConfig?.targetDisplayId ?? res.displayId ?? null);
  }

  async function loadLauncherConfig() {
    if (!window.qsys?.getLauncherConfig) return;
    const res = await window.qsys.getLauncherConfig();
    if (!res?.ok) throw new Error(res?.error || "Unable to load launcher config");
    renderLauncherConfig(res.config || {});
  }

  async function saveLauncherConfig() {
    if (!window.qsys?.saveLauncherConfig) return;
    const payload = currentConfigFromForm();
    if (!payload.branchCode) {
      setAgentStatus("Branch code is required before saving display setup.", true);
      return;
    }
    setAgentStatus("Saving display setup...", false);
    const res = await window.qsys.saveLauncherConfig(payload);
    if (!res?.ok) {
      setAgentStatus(res?.error || "Failed to save display setup.", true);
      return;
    }
    renderLauncherConfig(res.config || payload);
    setAgentStatus("Display setup saved for this PC.", false);
    const ok = await pingHealth();
    if (ok) await fetchBranchInfoBestEffort();
  }

  function bindActions() {
    const qsys = window.qsys;

    if (!qsys) {
      console.error("window.qsys is missing. Preload bridge not injected.");
      setHealth(false, "Bridge missing");
      return false;
    }

    el.btnDisplay?.addEventListener("click", () => qsys.openDisplay());
    el.btnShutdown?.addEventListener("click", () => qsys.shutdownApp());

    el.btnRefresh?.addEventListener("click", async () => {
      const ok = await pingHealth();
      if (ok) await fetchBranchInfoBestEffort();
    });

    el.btnSaveAgentConfig?.addEventListener("click", async () => {
      try {
        await saveLauncherConfig();
      } catch (err) {
        setAgentStatus(err?.message || "Failed to save display setup.", true);
      }
    });

    el.btnRefreshAgentConfig?.addEventListener("click", async () => {
      try {
        setAgentStatus("Reloading display setup...", false);
        await loadLauncherConfig();
        await loadDisplayTargets();
        setAgentStatus("Display setup reloaded.", false);
      } catch (err) {
        setAgentStatus(err?.message || "Failed to reload display setup.", true);
      }
    });

    el.serverUrlInput?.addEventListener("input", renderResolvedDisplayUrl);
    el.branchCodeInput?.addEventListener("input", renderResolvedDisplayUrl);
    el.displayModeInput?.addEventListener("change", renderResolvedDisplayUrl);
    el.displayTargetInput?.addEventListener("change", renderResolvedDisplayUrl);
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

    try {
      await loadLauncherConfig();
      await loadDisplayTargets();
      setAgentStatus("Configure the online branch display URL and the monitor to use on this PC.", false);
    } catch (err) {
      setAgentStatus(err?.message || "Failed to load display setup.", true);
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
