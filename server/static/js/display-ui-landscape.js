/* QSys landscape renderer: global Now Serving + A/B/C queue columns. */
(function(){
  'use strict';

  const GROUPS = ['A','B','C'];
  const PRIORITY_CAPACITY = 5;
  const REGULAR_CAPACITY = 10;
  const $ = (id) => document.getElementById(id);
  let heroTimer = null;

  function upper(value){ return String(value || '').toUpperCase(); }
  function pad2(value){
    const n = Number(value);
    return Number.isFinite(n) ? String(n).padStart(2, '0') : '';
  }
  function isPriority(row){
    const group = upper(row?.groupCode);
    const priority = upper(row?.priorityType || row?.priority || 'NONE');
    return group.startsWith('P') || (priority && priority !== 'NONE');
  }
  function bucket(row){
    const pax = Number(row?.pax || 0);
    if (pax <= 2) return 'A';
    if (pax <= 5) return 'B';
    return 'C';
  }
  function codeParts(row){
    const group = isPriority(row) ? `P${bucket(row)}` : bucket(row);
    return { group, number: pad2(row?.queueNum) };
  }
  function pickGlobalCalled(rows){
    return (rows || [])
      .filter((row) => upper(row?.status) === 'CALLED')
      .slice()
      .sort((a,b) => {
        const aLatest = Number(a?.latestCallAt || a?.calledAt || 0);
        const bLatest = Number(b?.latestCallAt || b?.calledAt || 0);
        return (bLatest - aLatest) || (Number(a?.queueNum || 0) - Number(b?.queueNum || 0));
      })[0] || null;
  }
  function setBranchName(state){
    const el = $('branchTitle');
    if (el) el.textContent = String(state?.branchName || '').trim() || 'BRANCH NAME';
  }
  function setGlobalCalled(rows){
    const letter = $('heroLetter');
    const number = $('heroNum');
    const card = $('calledGlobal');
    if (!letter || !number || !card) return;
    if (heroTimer) clearTimeout(heroTimer);

    const row = pickGlobalCalled(rows);
    if (!row) {
      letter.textContent = '—';
      number.textContent = '—';
      card.classList.remove('isPriorityCalled');
      return;
    }
    const parts = codeParts(row);
    letter.textContent = parts.group;
    heroTimer = setTimeout(() => {
      number.textContent = parts.number;
      heroTimer = null;
    }, 100);
    card.classList.toggle('isPriorityCalled', isPriority(row));
  }
  function makeItem(row){
    const el = document.createElement('div');
    const parts = codeParts(row);
    el.className = 'landWaitingItem';
    el.textContent = `${parts.group}${parts.number}`;
    return el;
  }
  function buildList(id, rows){
    const list = $(id);
    if (!list) return;
    list.innerHTML = '';
    for (const row of rows || []) list.appendChild(makeItem(row));
  }
  function renderWaiting(rows, helpers){
    const waiting = (rows || []).filter((row) => upper(row?.status) === 'WAITING');
    for (const group of GROUPS) {
      const groupRows = waiting.filter((row) => bucket(row) === group);
      const allocation = helpers.stableWaitingColumns(group, groupRows, {
        layoutKey: 'landscape-columns-v2',
        priorityCapacity: window.DisplayFit?.waitingCapacity($('priority-' + group), PRIORITY_CAPACITY) ?? PRIORITY_CAPACITY,
        regularCapacity: window.DisplayFit?.waitingCapacity($('regular-' + group), REGULAR_CAPACITY) ?? REGULAR_CAPACITY,
      });
      buildList(`priority-${group}`, allocation.visiblePriority);
      buildList(`regular-${group}`, allocation.visibleRegular);
      const count = $(`wait-${group}`);
      if (count) count.textContent = `P: ${allocation.hiddenPriority} | R: ${allocation.hiddenRegular}`;
    }
  }

  function forceHeroPulse(){
    const el = $('calledGlobal');
    if (!el) return;
    el.classList.remove('qsysPulse');
    void el.offsetWidth;
    el.classList.add('qsysPulse');
  }

  window.DisplayUI = {
    render(rows, state, helpers){
      setBranchName(state);
      setGlobalCalled(rows || []);
      renderWaiting(rows || [], helpers);
      window.DisplayFit?.watchWaiting(() => renderWaiting(rows || [], helpers));
    },
    getStatusEl: () => $('status'),
    getAdPlayerEl: () => $('adPlayerA'),
    getAdPlayers: () => ({ a: $('adPlayerA'), b: $('adPlayerB') }),
    getChimeEl: () => $('chime'),
    forceHeroPulse,
  };
})();
