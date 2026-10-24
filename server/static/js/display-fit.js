// Fit text to its own card, including after queue changes and window resizing.
(() => {
  const selector = '#branchName, #branchTitle, .globalTicket, .nowTicket, .globalServingTitle, .heroLetter, .heroNum, .nowHdr, .landWaitingItem, .waitingItem, .qrHeading';
  let pending = false;
  const observed = new WeakSet();
  let renderWaiting = null;
  let waitingSize = '';
  const textMeasure = document.createElement('canvas').getContext('2d');
  function waitingLayout(list) {
    const landscape = list.matches('.landWaitingList');
    const vmin = Math.min(innerWidth, innerHeight);
    const baseSize = Math.min(54, Math.max(30, vmin * .038));
    const baseRows = Math.min(landscape ? 5 : 10, Math.max(1, Math.floor(list.clientHeight / (baseSize * 1.6))));
    const rowHeight = list.clientHeight / baseRows;
    const lineHeight = (landscape ? Math.min(56, Math.max(30, vmin * .041)) : baseSize) * 1.1;
    // Keep the compact spacing and use every complete row that fits.
    const height = Math.min(rowHeight, lineHeight + Math.max(0, rowHeight - lineHeight) * 0.3);
    return { height, rows: Math.max(1, Math.floor(list.clientHeight / Math.max(1, height))) };
  }
  function waitingCapacity(list, fallback) {
    if (!list || !list.clientHeight) return fallback;
    const columns = list.parentElement.classList.contains('regular') ? 2 : 1;
    return waitingLayout(list).rows * columns;
  }
  window.DisplayFit = {
    waitingCapacity,
    watchWaiting(callback) { renderWaiting = callback; schedule(); },
  };
  function fit(el) {
    el.style.removeProperty('font-size');
    if (el.closest('.globalTicket') && !el.matches('.globalTicket')) return;
    const ticket = el.closest('.nowTicket');
    if (ticket) {
      const inline = getComputedStyle(ticket).flexDirection === 'row';
      if (inline ? el !== ticket : el === ticket) return;
    }
    const style = getComputedStyle(el);
    const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (width <= 0 || height <= 0 || !el.textContent.trim()) return;
    let size = parseFloat(style.fontSize);
    const range = document.createRange();
    range.selectNodeContents(el);
    for (let i = 0; i < 8; i++) {
      const bounds = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const centerX = box.left + el.clientLeft + parseFloat(style.paddingLeft) + width / 2;
      const centerY = box.top + el.clientTop + parseFloat(style.paddingTop) + height / 2;
      const textWidth = 2 * Math.max(centerX - bounds.left, bounds.right - centerX);
      const textHeight = 2 * Math.max(centerY - bounds.top, bounds.bottom - centerY);
      const ratio = Math.min(1, width / Math.max(1, textWidth), height / Math.max(1, textHeight));
      if (ratio >= 0.995) break;
      size *= ratio * 0.97;
      el.style.fontSize = `${size}px`;
    }
  }
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const lists = [...document.querySelectorAll('.landWaitingList, .waitingList')];
      const size = lists.map(list => waitingCapacity(list, 20)).join(',');
      if (size !== waitingSize) {
        waitingSize = size;
        if (renderWaiting) renderWaiting();
      }
      document.querySelectorAll('.landWaitingList, .waitingList').forEach(list => {
        if (!observed.has(list)) { observer.observe(list); observed.add(list); }
        // Keep row positions stable even when only one ticket is waiting.
        const { rows, height } = waitingLayout(list);
        list.style.gridTemplateRows = `repeat(${rows}, minmax(0, ${height}px))`;
        list.style.alignContent = 'start';
      });
      document.querySelectorAll('.nowTicket .heroLetter, .nowTicket .heroNum').forEach(part => {
        part.style.removeProperty('transform');
      });
      document.querySelectorAll(selector).forEach(el => {
        if (!observed.has(el)) { observer.observe(el); observed.add(el); }
        fit(el);
      });
      document.querySelectorAll('.nowTicket').forEach(ticket => {
        const parts = [...ticket.querySelectorAll('.heroLetter, .heroNum')];
        if (getComputedStyle(ticket).flexDirection !== 'column') return;
        const size = Math.min(...parts.map(part => parseFloat(getComputedStyle(part).fontSize)));
        parts.forEach(part => { part.style.fontSize = `${size}px`; });
        if (parts.length !== 2 || !textMeasure) return;
        // Measure visible glyphs: font line boxes include substantial blank space.
        const ink = parts.map(part => {
          const style = getComputedStyle(part);
          textMeasure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const metrics = textMeasure.measureText(part.textContent.trim());
          const range = document.createRange();
          range.selectNodeContents(part);
          const baseline = range.getBoundingClientRect().top + metrics.fontBoundingBoxAscent;
          return {
            top: baseline - metrics.actualBoundingBoxAscent,
            bottom: baseline + metrics.actualBoundingBoxDescent,
          };
        });
        const shift = Math.max(0, ink[1].top - ink[0].bottom) * 0.55 / 2;
        parts[0].style.transform = `translateY(${shift}px)`;
        parts[1].style.transform = `translateY(${-shift}px)`;
      });
      document.querySelectorAll('.qrCard').forEach(card => {
        if (!observed.has(card)) { observer.observe(card); observed.add(card); }
        const heading = card.querySelector('.qrHeading'), img = card.querySelector('img');
        if (!heading || !img) return;
        const style = getComputedStyle(card);
        const width = card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height = card.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
          - heading.getBoundingClientRect().height - parseFloat(style.rowGap);
        const side = Math.max(0, Math.floor(Math.min(width, height)));
        img.style.width = img.style.height = `${side}px`;
      });
    });
  }
  const observer = new ResizeObserver(schedule);
  new MutationObserver(schedule).observe(document.body, { childList: true, characterData: true, subtree: true });
  window.addEventListener('resize', schedule);
  document.fonts.ready.then(schedule);
  schedule();
})();
