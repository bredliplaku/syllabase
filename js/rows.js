// Rows of tabs, chips and buttons, shared by the editor, the course page and the homepage.
// - RowLayout.fade(row): a row that scrolls sideways (a phone's tabs, chips, buttons) fades
//   out at an edge only while there is more past it, easing in and out as it scrolls
//   (css/main.css .row-fade).
// - RowLayout.group(row, items): a button group that wraps rounds the ends of each line, not
//   only of its first and last button. It marks the items (a selector within the row) with
//   first-in-row, last-in-row or only-in-row, which the group's CSS rounds.
// Both follow scrolling, resizing and new content by themselves: call them once per row.
(function () {
  'use strict';

  const state = new WeakMap();
  const queue = new Set();
  let frame = 0;

  function schedule(row) {
    queue.add(row);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  // Every row is measured before any is changed, so a frame lays the page out once.
  function flush() {
    frame = 0;
    const rows = [...queue].filter(row => row.isConnected);
    queue.clear();
    rows.map(measure).forEach(write => write());
  }

  function measure(row) {
    const { fade, items } = state.get(row);
    const writes = [];
    if (fade) {
      const max = row.scrollWidth - row.clientWidth;
      const on = max > 1;
      const start = on && row.scrollLeft > 1;
      const end = on && row.scrollLeft < max - 1;
      writes.push(() => {
        row.classList.toggle('row-fade-on', on);
        row.classList.toggle('row-fade-start', start);
        row.classList.toggle('row-fade-end', end);
      });
    }
    if (items) {
      const members = [...row.querySelectorAll(items)].filter(el => el.getClientRects().length);
      // Items share a line when their middles are closer than half the smaller height.
      const lines = [];
      for (const el of members) {
        const box = el.getBoundingClientRect();
        const middle = box.top + box.height / 2;
        const line = lines.find(l => Math.abs(l.middle - middle) < Math.min(l.height, box.height) / 2);
        if (line) line.items.push(el); else lines.push({ middle, height: box.height, items: [el] });
      }
      writes.push(() => {
        for (const line of lines) {
          line.items.forEach((el, i) => {
            const only = line.items.length === 1;
            el.classList.toggle('only-in-row', only);
            el.classList.toggle('first-in-row', !only && i === 0);
            el.classList.toggle('last-in-row', !only && i === line.items.length - 1);
          });
        }
      });
    }
    return () => writes.forEach(write => write());
  }

  function watch(row, options) {
    if (!row) return;
    let entry = state.get(row);
    if (!entry) {
      entry = {};
      state.set(row, entry);
      row.addEventListener('scroll', () => schedule(row), { passive: true });
      const resized = new ResizeObserver(() => schedule(row));
      const observe = () => { resized.observe(row); [...row.children].forEach(child => resized.observe(child)); };
      observe();
      new MutationObserver(() => { observe(); schedule(row); }).observe(row, { childList: true });
    }
    Object.assign(entry, options);
    if (entry.fade) row.classList.add('row-fade');
    schedule(row);
  }

  window.RowLayout = {
    fade: row => watch(row, { fade: true }),
    group: (row, items) => watch(row, { items }),
    refresh: row => row && state.has(row) && schedule(row),
  };
})();
