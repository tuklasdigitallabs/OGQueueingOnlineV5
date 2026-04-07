(function () {
  const $ = (id) => document.getElementById(id);
  const HARD_CODED_SERVER_URL = "https://onegourmetph.com/qsys";

  const el = {
    healthDot: $("healthDot"),
    healthText: $("healthText"),
    baseUrl: $("baseUrl"),

    serverStatus: $("serverStatus"),
    branchCodeRow: $("branchCodeRow"),
    branchCode: $("branchCode"),
    businessDate: $("businessDate"),
    localTime: $("localTime"),
    serverUrlValue: $("serverUrlValue"),
    branchCodeInput: $("branchCodeInput"),
    displayShowVideoInput: $("displayShowVideoInput"),
    displayModeInput: $("displayModeInput"),
    mediaSourceValue: $("mediaSourceValue"),
    mediaSourceModeInput: $("mediaSourceModeInput"),
    localMediaFileValue: $("localMediaFileValue"),
    btnPickLocalMediaFile: $("btnPickLocalMediaFile"),
    btnClearLocalMediaFile: $("btnClearLocalMediaFile"),
    displayTargetInput: $("displayTargetInput"),
    resolvedDisplayUrl: $("resolvedDisplayUrl"),
    agentConfigStatus: $("agentConfigStatus"),
    btnSaveAgentConfig: $("btnSaveAgentConfig"),
    btnRefreshAgentConfig: $("btnRefreshAgentConfig"),

    btnDisplay: $("btnDisplay"),
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
    availableBranches: [],
    displaySettings: null,
    displayMediaSource: null,
    localMediaFile: "",
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

  function absoluteAppUrl(input) {
    if (typeof window.appAbsoluteUrl === "function") return window.appAbsoluteUrl(input);
    try {
      return new URL(String(input || "/"), window.location.origin).toString();
    } catch {
      return String(input || "/");
    }
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
      serverUrl: HARD_CODED_SERVER_URL,
      branchCode: normalizeBranchCode(el.branchCodeInput?.value),
      displayShowVideo: String(el.displayShowVideoInput?.value || "false") === "true" ? "true" : "false",
      displayMode: normalizeDisplayMode(el.displayModeInput?.value),
      mediaSourceMode: String(el.mediaSourceModeInput?.value || "cloud").trim().toLowerCase() === "local-file" ? "local-file" : "cloud",
      localMediaFile: String(state.localMediaFile || "").trim(),
      targetDisplayId: getSelectedDisplayTargetId(),
    };
  }

  function renderLocalMediaControls() {
    const mode = String(el.mediaSourceModeInput?.value || "cloud").trim().toLowerCase() === "local-file" ? "local-file" : "cloud";
    const localPath = String(state.localMediaFile || "").trim();
    if (el.localMediaFileValue) {
      el.localMediaFileValue.textContent = localPath || "No local file selected";
      el.localMediaFileValue.title = localPath || "";
      el.localMediaFileValue.style.opacity = mode === "local-file" ? "1" : "0.7";
    }
    if (el.btnPickLocalMediaFile) el.btnPickLocalMediaFile.disabled = mode !== "local-file";
    if (el.btnClearLocalMediaFile) el.btnClearLocalMediaFile.disabled = mode !== "local-file" || !localPath;
  }

  function renderBranchOptions(selectedCode) {
    if (!el.branchCodeInput) return;
    const current = normalizeBranchCode(selectedCode);
    el.branchCodeInput.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = state.availableBranches.length ? "Select branch..." : "No branches found";
    el.branchCodeInput.appendChild(placeholder);

    for (const branch of state.availableBranches) {
      const option = document.createElement("option");
      option.value = branch.branchCode;
      option.textContent = branch.branchName ? `${branch.branchName} (${branch.branchCode})` : branch.branchCode;
      el.branchCodeInput.appendChild(option);
    }

    el.branchCodeInput.value = current || "";
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

  function renderDisplaySettings(settings) {
    state.displaySettings = settings || null;
    if (el.displayShowVideoInput) {
      el.displayShowVideoInput.value = String(settings?.["display.showVideo"] ?? "false");
    }
    if (el.displayModeInput) {
      el.displayModeInput.value = normalizeDisplayMode(settings?.["display.orientation"] || state.launcherConfig?.displayMode);
    }
    const localMode = String(state.launcherConfig?.mediaSourceMode || "cloud").trim().toLowerCase() === "local-file";
    state.localMediaFile = String(state.launcherConfig?.localMediaFile || state.localMediaFile || "").trim();
    if (el.mediaSourceModeInput) el.mediaSourceModeInput.value = localMode ? "local-file" : "cloud";
    if (el.mediaSourceValue) {
      const mediaSourceLabel = String(state.displayMediaSource?.label || "").trim();
      const mediaSource = localMode
        ? String(state.localMediaFile || "").trim()
        : String(settings?.["media.sourceDir"] || "").trim();
      const text = mediaSourceLabel || mediaSource || "Bundled videos (default)";
      el.mediaSourceValue.textContent = text;
      el.mediaSourceValue.title = text;
    }
    renderLocalMediaControls();
    renderResolvedDisplayUrl();
  }

  function renderLauncherConfig(config) {
    state.launcherConfig = config || null;
    if (el.serverUrlValue) el.serverUrlValue.textContent = HARD_CODED_SERVER_URL;
    renderBranchOptions(config?.branchCode);
    if (el.displayModeInput) el.displayModeInput.value = normalizeDisplayMode(config?.displayMode);
    renderDisplayTargets(config?.targetDisplayId ?? null);
    renderResolvedDisplayUrl();
    renderDisplaySettings(state.displaySettings || {
      "display.showVideo": String(config?.displayShowVideo ?? "false"),
      "display.orientation": normalizeDisplayMode(config?.displayMode),
      "media.sourceDir": "",
    });
    if (el.baseUrl) {
      el.baseUrl.textContent = HARD_CODED_SERVER_URL;
    }
  }

  function renderBranchValidation(status) {
    const configuredCode = normalizeBranchCode(state.launcherConfig?.branchCode || el.branchCodeInput?.value);
    if (!configuredCode) {
      if (el.branchCodeRow) el.branchCodeRow.style.display = "none";
      setAgentStatus("Enter the branch code for the store display before opening the kiosk window.", true);
      return;
    }
    if (status?.branchValid) {
      if (el.branchCodeRow) el.branchCodeRow.style.display = "";
      if (el.branchCode) el.branchCode.textContent = configuredCode;
      const label = status.branchName ? `${status.branchName} (${configuredCode})` : configuredCode;
      setAgentStatus(`Display agent is pointed at ${label}.`, false);
      return;
    }
    if (el.branchCodeRow) el.branchCodeRow.style.display = "none";
    const suggested = normalizeBranchCode(status?.suggestedBranchCode);
    if (suggested) {
      setAgentStatus(`Branch code ${configuredCode} was not found on the server. Try ${suggested} instead.`, true);
      return;
    }
    const available = Array.isArray(status?.availableBranches) ? status.availableBranches.map((row) => row.branchCode).filter(Boolean) : [];
    if (available.length) {
      setAgentStatus(`Branch code ${configuredCode} was not found on the server. Available: ${available.join(", ")}.`, true);
      return;
    }
    setAgentStatus(`Branch code ${configuredCode} could not be validated on the server.`, true);
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
      if (Array.isArray(status.availableBranches)) {
        state.availableBranches = status.availableBranches;
        renderBranchOptions(state.launcherConfig?.branchCode || el.branchCodeInput?.value);
      }
      renderBranchValidation(status);
      return true;
    } catch (e) {
      setHealth(false, "Server offline");
      setAgentStatus("Server is offline or unreachable from this display PC.", true);
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

  async function loadRemoteDisplaySettings(branchCode, syncLocalConfig) {
    const normalizedBranchCode = normalizeBranchCode(branchCode);
    if (!normalizedBranchCode) {
      renderDisplaySettings(null);
      return null;
    }
    const j = window.qsys?.getRemoteDisplayConfig
      ? await window.qsys.getRemoteDisplayConfig(normalizedBranchCode)
      : await (async () => {
          const res = await fetch(`${HARD_CODED_SERVER_URL}/api/public/display-config?branchCode=${encodeURIComponent(normalizedBranchCode)}`, {
            cache: "no-store",
          });
          const json = await safeJson(res);
          return res.ok ? json : { ok: false, error: json?.error || "Unable to load branch display settings" };
        })();
    if (!j?.ok) throw new Error(j?.error || "Unable to load branch display settings");
    state.displayMediaSource = j.mediaSource || null;
    renderDisplaySettings(j.settings || null);

    if (syncLocalConfig && window.qsys?.saveLauncherConfig) {
      const localPayload = {
        ...(state.launcherConfig || currentConfigFromForm()),
        serverUrl: HARD_CODED_SERVER_URL,
        branchCode: normalizedBranchCode,
        displayMode: normalizeDisplayMode(j.settings?.["display.orientation"]),
        mediaSourceMode: String(state.launcherConfig?.mediaSourceMode || "cloud"),
        localMediaFile: String(state.launcherConfig?.localMediaFile || state.localMediaFile || ""),
        targetDisplayId: getSelectedDisplayTargetId(),
      };
      const saved = await window.qsys.saveLauncherConfig(localPayload);
      if (saved?.ok) {
        state.launcherConfig = saved.config || localPayload;
      }
    }
    return j.settings || null;
  }

  async function saveLauncherConfig() {
    if (!window.qsys?.saveLauncherConfig) return;
    const payload = currentConfigFromForm();
    if (!payload.branchCode) {
      setAgentStatus("Branch code is required before saving display setup.", true);
      return;
    }
    if (payload.mediaSourceMode === "local-file" && !payload.localMediaFile) {
      setAgentStatus("Choose a local video file before saving Local File playback.", true);
      return;
    }
    setAgentStatus("Saving display setup...", false);
    const remoteJson = window.qsys?.saveRemoteDisplayConfig
      ? await window.qsys.saveRemoteDisplayConfig(payload)
      : await (async () => {
          const remoteRes = await fetch(`${HARD_CODED_SERVER_URL}/api/public/display-config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              branchCode: payload.branchCode,
              "display.showVideo": payload.displayShowVideo,
              "display.orientation": payload.displayMode,
              "media.sourceFile": "",
            }),
          });
          const json = await safeJson(remoteRes);
          return remoteRes.ok ? json : { ok: false, error: json?.error || "Failed to save branch display settings." };
        })();
    if (!remoteJson?.ok) {
      setAgentStatus(remoteJson?.error || "Failed to save branch display settings.", true);
      return;
    }
    const res = await window.qsys.saveLauncherConfig(payload);
    if (!res?.ok) {
      setAgentStatus(res?.error || "Failed to save local display setup.", true);
      return;
    }
    renderLauncherConfig(res.config || payload);
    state.displayMediaSource = remoteJson.mediaSource || null;
    renderDisplaySettings(remoteJson.settings || null);
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
        await loadRemoteDisplaySettings(state.launcherConfig?.branchCode || el.branchCodeInput?.value, true);
        setAgentStatus("Display setup reloaded.", false);
      } catch (err) {
        setAgentStatus(err?.message || "Failed to reload display setup.", true);
      }
    });

    el.serverUrlInput?.addEventListener("input", renderResolvedDisplayUrl);
    el.branchCodeInput?.addEventListener("change", async () => {
      renderResolvedDisplayUrl();
      try {
        await loadRemoteDisplaySettings(el.branchCodeInput?.value, true);
      } catch (err) {
        setAgentStatus(err?.message || "Failed to load branch display settings.", true);
      }
    });
    el.branchCodeInput?.addEventListener("change", renderResolvedDisplayUrl);
    el.displayShowVideoInput?.addEventListener("change", renderResolvedDisplayUrl);
    el.displayModeInput?.addEventListener("change", renderResolvedDisplayUrl);
    el.mediaSourceModeInput?.addEventListener("change", () => {
      renderLocalMediaControls();
    });
    el.displayTargetInput?.addEventListener("change", renderResolvedDisplayUrl);
    el.btnPickLocalMediaFile?.addEventListener("click", async () => {
      try {
        const picked = await window.qsys?.pickLocalMediaFile?.();
        if (!picked?.ok) throw new Error(picked?.error || "Failed to choose local media file.");
        if (picked.canceled) return;
        state.localMediaFile = String(picked.path || "").trim();
        renderLocalMediaControls();
      } catch (err) {
        setAgentStatus(err?.message || "Failed to choose local media file.", true);
      }
    });
    el.btnClearLocalMediaFile?.addEventListener("click", () => {
      state.localMediaFile = "";
      renderLocalMediaControls();
    });
    return true;
  }

  async function runStartupLoading() {
    const MIN_BOOT_MS = 3200;
    const MIN_STEP_MS = 420;
    const startedAt = Date.now();

    const checks = [
      {
        label: "Display bridge",
        run: async () => {
          if (!window.qsys) throw new Error("bridge missing");
        },
      },
      {
        label: "Display setup",
        run: async () => {
          const res = await window.qsys?.getLauncherConfig?.();
          if (!res?.ok) throw new Error(res?.error || "config unavailable");
        },
      },
      {
        label: "Monitor detection",
        run: async () => {
          const res = await window.qsys?.getDisplayTargets?.();
          if (!res?.ok) throw new Error(res?.error || "display targets unavailable");
        },
      },
      {
        label: "Display endpoint",
        run: async () => probe("/display", "HEAD"),
      },
    ];

    let done = 0;
    const total = checks.length;
    setBootProgress(done, total);

    for (const item of checks) {
      const stepStartedAt = Date.now();
      if (el.bootNow) el.bootNow.textContent = `Checking ${item.label}...`;
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
      if (el.bootNow) el.bootNow.textContent = "Finalizing display agent...";
      await sleep(MIN_BOOT_MS - totalElapsed);
    }

    if (el.bootNow) el.bootNow.textContent = "Display agent ready";
    document.body.classList.add("ready");
  }

  async function boot() {
    if (el.baseUrl) el.baseUrl.textContent = absoluteAppUrl("/");

    await runStartupLoading();
    const actionsBound = bindActions();

    if (!actionsBound) {
      if (el.bootNow) el.bootNow.textContent = "Bridge unavailable. Launcher controls are disabled.";
      return;
    }

    try {
      await loadLauncherConfig();
      await loadDisplayTargets();
      await loadRemoteDisplaySettings(state.launcherConfig?.branchCode || el.branchCodeInput?.value, true);
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
