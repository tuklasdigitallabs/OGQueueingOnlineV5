/* display-ui-portrait.js (CLEAN)
   Portrait renderer used by display-core.js
*/
(function(){
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PRIORITY_CAPACITY = 10;
  const REGULAR_CAPACITY = 20;

  // Hero timing (letter shows first, number follows after this delay)
const HERO_NUM_DELAY_MS = 100;
let __heroNumTimer = null;


  function upper(s){ return String(s || '').toUpperCase(); }

  function isPriorityGroupCode(gc){
    const g = upper(gc);
    return g.startsWith('P'); // PA/PB/PC
  }

  function bucketFromGroupCode(gc){
    const g = upper(gc);
    if (g.startsWith('P')) return g.slice(1,2) || 'A';
    if (['A','B','C'].includes(g)) return g;
    return 'A';
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

    // Show the most recently active called ticket.
    // latestCallAt is updated on both CALL and CALL AGAIN.
    const scored = called.map(r => {
      const latestCallAt = Number(r?.latestCallAt || 0);
      const calledAt = Number(r?.calledAt || 0);
      const latestTs = (Number.isFinite(latestCallAt) && latestCallAt > 0)
        ? latestCallAt
        : ((Number.isFinite(calledAt) && calledAt > 0) ? calledAt : -1);
      const calledTs = (Number.isFinite(calledAt) && calledAt > 0) ? calledAt : -1;
      const qn = Number(r?.queueNum || 0);
      return { r, latestTs, calledTs, qn };
    });

    scored.sort((a,b) => (b.latestTs - a.latestTs) || (b.calledTs - a.calledTs) || (a.qn - b.qn));
    return scored[0]?.r || null;
  }

  function sortByQueueNum(a,b){ return (Number(a?.queueNum || 0) - Number(b?.queueNum || 0)); }

  function makeListItem(row){
    const el = document.createElement('div');
    el.className = 'waitingItem';
    const p = splitCodeParts(row);
    el.textContent = `${p.letters}${p.num}`;
    return el;
  }

  function buildList(container, rows){
    if (!container) return;
    container.innerHTML = '';
    for (const row of rows || []) container.appendChild(makeListItem(row));
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




  function renderWaiting(rows, helpers){
    const waiting = (rows || []).filter(r => upper(r?.status) === 'WAITING');

    const byBucket = { A: [], B: [], C: [] };
    const priByBucket = { A: [], B: [], C: [] };

    for (const r of waiting){
      const b = bucketFromGroupCode(r?.groupCode);
      if (!byBucket[b]) continue;
      if (isPriorityGroupCode(r?.groupCode)) priByBucket[b].push(r);
      else byBucket[b].push(r);
    }

    for (const b of ['A','B','C']){
      priByBucket[b].sort(sortByQueueNum);
      byBucket[b].sort(sortByQueueNum);
      const allocation = helpers.stableWaitingColumns(
        b,
        [...priByBucket[b], ...byBucket[b]],
        {
          layoutKey: 'portrait-columns-v2',
          priorityCapacity: window.DisplayFit?.waitingCapacity($('priority-' + b), PRIORITY_CAPACITY) ?? PRIORITY_CAPACITY,
          regularCapacity: window.DisplayFit?.waitingCapacity($('regular-' + b), REGULAR_CAPACITY) ?? REGULAR_CAPACITY
        }
      );
      buildList(document.getElementById('priority-' + b), allocation.visiblePriority);
      buildList(document.getElementById('regular-' + b), allocation.visibleRegular);
      const c = document.getElementById('count-' + b);
      if (c) {
        c.innerHTML = `<span class="grpCountTitle">Waiting</span>`
          + `<span class="grpCountBreakdown">P: ${allocation.hiddenPriority} | R: ${allocation.hiddenRegular}</span>`;
      }
    }
  }

  // Public API expected by display-core.js
  window.DisplayUI = {
    render(rows, state, helpers){
      setBranchName(state);
      setGlobalCalled(rows);
      renderWaiting(rows, helpers);
      window.DisplayFit?.watchWaiting(() => renderWaiting(rows || [], helpers));
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
