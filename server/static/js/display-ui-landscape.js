/* QSys Display UI (Landscape)
   - DOM rendering ONLY
   - No sockets / polling / playlist logic here
*/
(function(){
  'use strict';

  const BUCKETS = ["A", "B", "C", "D"]; // 1 pax, 2-3, 4-5, 6++
  // Waiting tiles per bucket: 1 priority slot (always shown) + 3 regular slots
  const MAX_TILES = 4;


function bucketFromPax(pax){
  const n = Number(pax || 0);
  if (n <= 1) return "A";
  if (n <= 3) return "B";
  if (n <= 5) return "C";
  return "D";
}

function isPriorityRowSafe(row){
  const v = row || {};

  // Preferred explicit flag
  if (v.isPriority === 1 || v.isPriority === true) return true;
  if (typeof v.isPriority === "string" && v.isPriority.toLowerCase() === "true") return true;

  // Some builds set priorityType/priority to "NONE" for regular queues — treat that as NOT priority.
  const pt = (v.priorityType ?? "").toString().trim().toUpperCase();
  const p  = (v.priority ?? "").toString().trim().toUpperCase();

  const isRealPriority = (x) => !!x && x !== "NONE" && x !== "NULL" && x !== "0" && x !== "N/A" && x !== "-";

  if (isRealPriority(pt) || isRealPriority(p)) return true;

  return false;
}






  function pad2(n){
    const s = String(n ?? "").replace(/\D+/g, "");
    if (!s) return "";
    return s.length >= 2 ? s.slice(-2) : ("0" + s);
  }

  function splitTicket(row, bucketCode, helpers){
    if (!row) return { group: "", num: "" };

    // Prefer explicit queueNum if present; otherwise parse from ticketText.
    const group = isPriorityRowSafe(row) ? ("P" + bucketCode) : bucketCode; // PA/PB/PC/PD


    let num = "";
    if (row.queueNum !== undefined && row.queueNum !== null) num = pad2(row.queueNum);
    if (!num){
      const t = String(helpers.ticketText(row) || "");
      const m = t.match(/(\d{1,4})\s*$/);
      if (m) num = pad2(m[1]);
    }
    return { group, num };
  }

  function $(id){ return document.getElementById(id); }

  function setDash(el, text){
    if (!el) return;
    if (!text){ el.textContent = "—"; el.classList.add("dash"); }
    else { el.textContent = text; el.classList.remove("dash"); }
  }

  function flashBucket(bucketCode){
    const cell = $("cell-" + bucketCode);
    if (!cell) return;
    cell.classList.remove("flash");
    // force reflow
    void cell.offsetWidth;
    cell.classList.add("flash");
  }

  function renderWaitingList(bucketCode, waitingRows, helpers){
    const listEl = $("list-" + bucketCode);
    if (!listEl) return;

    // HARD RULE:
    // - Slot 0: Priority ONLY (first priority item if exists)
    // - Slots 1-3: Regular ONLY (first 3 non-priority items)
    const pri = (waitingRows || []).filter(r => isPriorityRowSafe(r)).sort(helpers.sortByQueueNum);
    const reg = (waitingRows || []).filter(r => !isPriorityRowSafe(r)).sort(helpers.sortByQueueNum);

    const tiles = [
      { row: pri[0] || null, cls: "priority" }, // slot 0
      { row: reg[0] || null, cls: "" },         // slot 1
      { row: reg[1] || null, cls: "" },         // slot 2
      { row: reg[2] || null, cls: "" },         // slot 3
    ];

    if (reg.length > 3) tiles[3] = { row: null, cls: "ellipsis", text: "..." };

    listEl.innerHTML = "";

    for (let i = 0; i < MAX_TILES; i++){
      const div = document.createElement("div");

      const isPriSlot = (i === 0);
      const tile = tiles[i] || {};
      const hasEllipsis = tile.cls === "ellipsis";
      const row = tile.row || null;

      if (hasEllipsis){
        div.className = "qItem ellipsis" + (isPriSlot ? " prioritySlot priority" : "");
        div.textContent = "...";
        listEl.appendChild(div);
        continue;
      }

      if (row){
        const parts = splitTicket(row, bucketCode, helpers);

        // If a priority row ever slips into a regular slot, render it as regular (bucket letter).
        if (!isPriSlot && parts.group === "P") parts.group = bucketCode;

        let cls = "qItem";
        if (tile.cls) cls += " " + tile.cls;

        if (isPriSlot) cls += " prioritySlot priority";

        div.className = cls;
        div.innerHTML = `
          <div class="qGroup">${parts.group || ""}</div>
          <div class="qNum">${parts.num || ""}</div>
        `;
      } else {
        div.className = "qEmpty" + (isPriSlot ? " prioritySlot priority" : "");
        div.textContent = "—";
      }
      listEl.appendChild(div);
    }
  }

  function render(rows, state, helpers){
    rows = rows || [];

    for (const b of BUCKETS){
      const calledEl = $("called-" + b);
      const serveBoxEl = calledEl ? calledEl.closest(".serveBox") : null;
      const nameEl = $("name-" + b);
      const waitEl = $("wait-" + b);

      const bucketRows = rows.filter(r => {
      // If a row is priority, DO NOT bucket it as "P" for display; bucket by pax size.
      const displayBucket = isPriorityRowSafe(r)
        ? bucketFromPax(r?.pax)
        : helpers.paxToBucket(r);
      return displayBucket === b;
    });
      const calledRow = helpers.pickCalledForBucket(bucketRows, b);

      const waiting = bucketRows
        .filter(r => String(r?.status || "").toUpperCase() === "WAITING")
        .sort(helpers.sortByQueueNum);

      // Now Serving formatting (ONLY here): e.g., B01 (no dash). Waiting tiles keep 2-line format.
      let calledText = "";
      if (calledRow){
        const parts = splitTicket(calledRow, b, helpers);
        calledText = `${parts.group || ""}${parts.num || ""}`.trim();
      }
      const isPriorityCalled = !!(calledRow && isPriorityRowSafe(calledRow));

      if (state.lastNowServing[b] !== undefined && state.lastNowServing[b] !== calledText){
        if (calledText) {
          flashBucket(b);
          try {
            if (typeof window.__qsysAnnounceNowServing === "function") {
              window.__qsysAnnounceNowServing(calledText);
            }
          } catch {}
        }
      }
      state.lastNowServing[b] = calledText;
      if (serveBoxEl) serveBoxEl.classList.toggle("isPriorityCalled", isPriorityCalled);

            setDash(calledEl, calledText);
      // Name is intentionally removed from Now Serving tile.
      setDash(nameEl, "");
      if (waitEl) waitEl.textContent = String(waiting.length);

      renderWaitingList(b, waiting, helpers);
    }
  }

  window.DisplayUI = {
    BUCKETS,
    MAX_TILES,
    getStatusEl: () => $("status"),
    getAdPlayerEl: () => $("adPlayerA"), // keep compatibility
    getAdPlayers: () => ({ a: $("adPlayerA"), b: $("adPlayerB") }),
    getChimeEl: () => $("chime"),
    render,
  };
})();
