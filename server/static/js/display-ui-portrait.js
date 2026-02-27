/* display-ui-portrait.js (CLEAN)
   Portrait renderer used by display-core.js
*/
(function(){
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOTAL_SLOTS = 6;   // 3x2 tiles per bucket
  const PRI_MAX = 3;         // show up to first 3 priority tickets
  
  // Hero timing (letter shows first, number follows after this delay)
const HERO_NUM_DELAY_MS = 100;
let __heroNumTimer = null;


  function upper(s){ return String(s || '').toUpperCase(); }

  function isPriorityGroupCode(gc){
    const g = upper(gc);
    return g.startsWith('P'); // PA/PB/PC/PD
  }

  function bucketFromGroupCode(gc){
    const g = upper(gc);
    if (g.startsWith('P')) return g.slice(1,2) || 'B';
    if (['A','B','C','D'].includes(g)) return g;
    return 'B';
  }

  function pad2(n){
    const x = Number(n);
    if (!Number.isFinite(x)) return '';
    return String(x).padStart(2, '0');
  }

  function splitCodeParts(row){
    const raw = String(row?.code || '').trim();
    const qn = pad2(row?.queueNum);
    const gc = upper(row?.groupCode);
    const code = raw || (gc && qn ? `${gc}-${qn}` : '');

    const parts = code.split('-');
    if (parts.length >= 2) return { letters: upper(parts[0]), num: parts[1] };
    return { letters: gc || '—', num: qn || '—' };
  }

  function pickGlobalCalled(rows){
    const called = (rows || []).filter(r => upper(r?.status) === 'CALLED');
    if (!called.length) return null;

    // Priority first, then oldest calledAt, then lowest queueNum
    const scored = called.map(r => {
      const pri = isPriorityGroupCode(r?.groupCode) ? 0 : 1;
      const calledAt = Number(r?.calledAt || 0);
      const ts = (Number.isFinite(calledAt) && calledAt > 0) ? calledAt : 9e15;
      const qn = Number(r?.queueNum || 0);
      return { r, pri, ts, qn };
    });

    scored.sort((a,b) => (a.pri - b.pri) || (a.ts - b.ts) || (a.qn - b.qn));
    return scored[0]?.r || null;
  }

  function sortByQueueNum(a,b){ return (Number(a?.queueNum || 0) - Number(b?.queueNum || 0)); }

  function makeTile(row, isPrioritySlot){
    const el = document.createElement('div');
    el.className = 'qTile' + (isPrioritySlot ? ' priSlot' : '');

    if (row && row.__ellipsis){
      el.className += ' ellipsis';
      el.innerHTML = `<div class="qLetter">…</div><div class="qNum">…</div>`;
      return el;
    }

    if (!row){
      el.className += ' empty';
      el.innerHTML = `<div class="qLetter">&nbsp;</div><div class="qNum">&nbsp;</div>`;
      return el;
    }

    const p = splitCodeParts(row);
    el.innerHTML = `<div class="qLetter">${p.letters}</div><div class="qNum">${p.num}</div>`;
    return el;
  }

  function buildGroup(container, priRows, regularRows){
    if (!container) return;
    container.innerHTML = '';

    const pri = Array.isArray(priRows) ? priRows.slice(0) : [];
    const regs = Array.isArray(regularRows) ? regularRows.slice(0) : [];

    pri.sort(sortByQueueNum);
    regs.sort(sortByQueueNum);

    const hasPriority = pri.length > 0;
    const priVis = hasPriority ? pri.slice(0, PRI_MAX) : [];

    const tiles = [];

    // Priority tiles first (only if there is at least 1 priority in queue)
    for (const r of priVis){
      tiles.push({ row: r, isPri: true });
    }

    // Fill remaining tiles with regular queue
    const remaining = TOTAL_SLOTS - tiles.length;
    let regVis = regs.slice(0, Math.max(0, remaining));
    const overflow = regs.length > remaining;

    if (overflow && remaining > 0){
      regVis = regVis.slice(0, Math.max(0, remaining - 1));
      regVis.push({ __ellipsis: true });
    }

    for (const r of regVis){
      tiles.push({ row: r, isPri: false });
    }

    // If no priorities at all: regular fills all slots (no green)
    if (!hasPriority){
      tiles.length = 0;
      let vis = regs.slice(0, TOTAL_SLOTS);
      const ov = regs.length > TOTAL_SLOTS;

      if (ov && TOTAL_SLOTS > 0){
        vis = vis.slice(0, Math.max(0, TOTAL_SLOTS - 1));
        vis.push({ __ellipsis: true });
      }

      for (const r of vis){
        tiles.push({ row: r, isPri: false });
      }
    }

    // Pad empties
    while (tiles.length < TOTAL_SLOTS){
      tiles.push({ row: null, isPri: false });
    }

    for (const t of tiles.slice(0, TOTAL_SLOTS)){
      container.appendChild(makeTile(t.row, t.isPri));
    }
  }

  function setBranchName(state){
    const el = $('branchName');
    if (!el) return;
    const name = String(state?.branchName || '').trim();
    el.textContent = name || 'BRANCH NAME';
  }

  function setGlobalCalled(rows){
  const letterEl = document.getElementById('heroLetter');
  const numEl = document.getElementById('heroNum');
  const calledEl = document.getElementById('calledGlobal');

  if (!letterEl || !numEl || !calledEl) return;

  // cancel any pending delayed update (avoid wrong numbers on rapid calls)
  if (__heroNumTimer) {
    clearTimeout(__heroNumTimer);
    __heroNumTimer = null;
  }

  const r = pickGlobalCalled(rows);
  if (!r){
    letterEl.textContent = '—';
    numEl.textContent = '—';
    calledEl.classList.remove('isPriorityCalled');
    return;
  }

  const p = splitCodeParts(r);

  // Update LETTER immediately
  letterEl.textContent = p.letters || '—';

  // Update NUMBER after 0.4s
  __heroNumTimer = setTimeout(() => {
    numEl.textContent = p.num || '—';
    __heroNumTimer = null;
  }, HERO_NUM_DELAY_MS);

  // Priority detection still uses letters (safe to do immediately)
  const isPriorityCalled = String(p.letters || '').toUpperCase().startsWith('P');
  calledEl.classList.toggle('isPriorityCalled', isPriorityCalled);
}




  function renderWaiting(rows){
    const waiting = (rows || []).filter(r => upper(r?.status) === 'WAITING');

    const byBucket = { A: [], B: [], C: [], D: [] };
    const priByBucket = { A: [], B: [], C: [], D: [] };

    for (const r of waiting){
      const b = bucketFromGroupCode(r?.groupCode);
      if (!byBucket[b]) continue;
      if (isPriorityGroupCode(r?.groupCode)) priByBucket[b].push(r);
      else byBucket[b].push(r);
    }

    for (const b of ['A','B','C','D']){
      const total = priByBucket[b].length + byBucket[b].length;
      const c = document.getElementById('count-' + b);
      if (c) c.textContent = `WAITING: ${total}`;
    }

    for (const b of ['A','B','C','D']){
      priByBucket[b].sort(sortByQueueNum);
      byBucket[b].sort(sortByQueueNum);
      buildGroup(document.getElementById('list-' + b), priByBucket[b], byBucket[b]);
    }
  }

  // Public API expected by display-core.js
  window.DisplayUI = {
    render(rows, state){
      setBranchName(state);
      setGlobalCalled(rows);
      renderWaiting(rows);
    },
    getStatusEl(){ return $('status'); },
    getAdPlayerEl(){ return $('adPlayer'); },
    getChimeEl(){ return $('chime'); }
  };


// === Recall support: force hero pulse (imperative, no state change) ===
function forceHeroPulse(){
  const el = document.getElementById("calledGlobal") || document.querySelector(".nowServing");
  if (!el) return;

  // Restart CSS animation reliably
  el.classList.remove("qsysPulse");
  void el.offsetWidth; // force reflow
  el.classList.add("qsysPulse");
}

// expose to core
window.DisplayUI = window.DisplayUI || {};
window.DisplayUI.forceHeroPulse = forceHeroPulse;
})();
