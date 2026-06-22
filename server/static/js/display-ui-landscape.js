(function () {
  "use strict";

  const GROUPS = ["A", "B", "C"];
  const $ = (id) => document.getElementById(id);
  let recalledCode = "";
  let recalledAt = 0;

  function upper(value) {
    return String(value || "").toUpperCase();
  }

  function codeFor(row, helpers) {
    return helpers.ticketText(row).replace("-", "");
  }

  function pickGlobalCalled(rows) {
    return (rows || [])
      .filter((row) => upper(row.status) === "CALLED")
      .sort((a, b) => Number(b.calledAt || 0) - Number(a.calledAt || 0))[0] || null;
  }

  function renderCodes(target, rows, helpers) {
    if (!target) return;
    target.innerHTML = "";
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "queueCode";
      item.textContent = codeFor(row, helpers);
      target.appendChild(item);
    }
  }

  function setGuestQr() {
    const image = $("guestQr");
    if (!image || image.dataset.ready === "1") return;
    const query = new URLSearchParams(window.location.search);
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    const branchIndex = pathParts.findIndex((part) => part.toLowerCase() === "b");
    const branchCode = upper(query.get("branchCode") || (branchIndex >= 0 ? pathParts[branchIndex + 1] : ""));
    const base = typeof window.appUrl === "function" ? window.appUrl("/qr/guest") : "/qr/guest";
    image.src = branchCode ? `${base}?branchCode=${encodeURIComponent(branchCode)}` : base;
    image.dataset.ready = "1";
  }

  function forceHeroPulse() {
    const hero = $("globalServing");
    if (!hero) return;
    hero.classList.remove("pulse");
    void hero.offsetWidth;
    hero.classList.add("pulse");
  }

  function showRecalledCode(code, payload) {
    const hero = $("globalServing");
    if (!hero || !code) return;
    const normalized = String(code).replace("-", "").toUpperCase();
    recalledCode = normalized;
    recalledAt = Number(payload?.at || Date.now());
    hero.textContent = normalized;
    hero.classList.toggle("priority", normalized.startsWith("P"));
  }

  function render(rows, state, helpers) {
    setGuestQr();
    const calledRows = (rows || []).filter((row) => upper(row.status) === "CALLED");
    const recalledRow = calledRows.find((row) => codeFor(row, helpers) === recalledCode);
    const newerCallExists = calledRows.some((row) => Number(row.calledAt || 0) > recalledAt);
    if (!recalledRow || newerCallExists) {
      recalledCode = "";
      recalledAt = 0;
    }
    const called = recalledCode ? recalledRow : pickGlobalCalled(rows);
    const hero = $("globalServing");
    const code = recalledCode || (called ? codeFor(called, helpers) : "—");
    if (hero) {
      if (hero.textContent !== code && code !== "—") forceHeroPulse();
      hero.textContent = code;
      hero.classList.toggle("priority", !!called && helpers.isPriorityRow(called));
    }

    for (const group of GROUPS) {
      const waiting = (rows || []).filter((row) =>
        upper(row.status) === "WAITING" && helpers.paxToBucket(row) === group
      );
      const allocation = helpers.stableWaitingColumns(group, waiting, {
        layoutKey: "landscape",
        priorityCapacity: 5,
        regularCapacity: 10,
      });
      renderCodes($(`priority-${group}`), allocation.visiblePriority, helpers);
      renderCodes($(`regular-${group}`), allocation.visibleRegular, helpers);
      const hidden = $(`hidden-${group}`);
      if (hidden) hidden.textContent = `P: ${allocation.hiddenPriority} | R: ${allocation.hiddenRegular}`;
    }
  }

  window.DisplayUI = {
    render,
    forceHeroPulse,
    showRecalledCode,
    getStatusEl: () => $("status"),
    getAdPlayerEl: () => $("adPlayerA"),
    getAdPlayers: () => ({ a: $("adPlayerA"), b: $("adPlayerB") }),
    getChimeEl: () => $("chime"),
  };
})();
