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

// Pill switches whose chosen part's colour slides (Exams | Question pool, Questions | Grades |
// Statistics, Students | Exam codes, a dialog's choices and tabs, the grading filters,
// Current | Past | All, My | All courses): the colour can be dragged, as any slider's handle.
// Pressed on the chosen part and moved, it follows the pointer (its width easing between parts
// of different widths), the part under its middle showing as chosen; let go, that part is chosen
// as by a click (the switch's own click does the rest) and the colour glides into place. A press
// that doesn't move is an ordinary click; Esc puts it back. No drag cursor (css/main.css). The
// exam page's sign-in switch has its own (exam/js/scripts.js setupSignInDrag).
(function () {
  'use strict';

  const SWITCHES = '.exam-views, .st-views, .seg-pick, .gq-filters, .finder-tabs, .sb-scope';
  const ON = ['aria-pressed', 'aria-selected', 'aria-checked'];
  const DRAG_FROM = 5; // px before a press becomes a drag
  let drag = null, swallowClick = false, escaped = null;

  // The click a press ends with (when it comes) is not a choice of its own.
  function swallowNextClick() {
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
  }

  const onAttr = el => ON.find(a => el.getAttribute(a) === 'true');
  const partsOf = bar => [...bar.children].filter(el => el.matches('button') && !el.hidden && !el.disabled && el.offsetWidth > 0);

  // The colour's left edge at x (px in the switch), its width between the two parts it is over.
  function place(x) {
    const { stops } = drag;
    x = Math.min(stops[stops.length - 1].x, Math.max(stops[0].x, x));
    let i = 0;
    while (i < stops.length - 2 && x > stops[i + 1].x) i++;
    const a = stops[i], b = stops[i + 1];
    const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
    const w = a.w + (b.w - a.w) * t;
    drag.bar.style.setProperty('--drag-x', `${x}px`);
    drag.bar.style.setProperty('--drag-w', `${w}px`);
    const middle = x + w / 2;
    const near = stops.reduce((p, q) => (Math.abs(q.x + q.w / 2 - middle) < Math.abs(p.x + p.w / 2 - middle) ? q : p));
    if (near !== drag.near) {
      drag.near = near;
      stops.forEach(s => s.el.setAttribute(drag.attr, String(s === near)));
    }
  }

  // Let go (or put back): the parts as they were, then the one let go on is clicked; the colour
  // glides from where it was to its place.
  function finish(choose) {
    const { bar, near, from, stops, attr } = drag;
    drag = null;
    stops.forEach(s => s.el.setAttribute(attr, s.was));
    bar.classList.remove('is-thumb-drag');
    bar.classList.add('is-thumb-settle');
    bar.style.removeProperty('--drag-x');
    bar.style.removeProperty('--drag-w');
    setTimeout(() => bar.classList.remove('is-thumb-settle'), 320);
    if (choose && near && near.el !== from) near.el.click();
  }

  document.addEventListener('pointerdown', e => {
    if (drag?.moved || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = null; // a press whose end never came
    const part = e.target.closest?.('button');
    const bar = part?.parentElement;
    const attr = part && onAttr(part);
    if (!attr || !bar.matches(SWITCHES)) return;
    const parts = partsOf(bar);
    if (parts.length < 2 || !parts.includes(part)) return;
    drag = {
      id: e.pointerId, bar, from: part, attr, startX: e.clientX, moved: false, near: null,
      stops: parts.map(el => ({ el, x: el.offsetLeft, w: el.offsetWidth, was: el.getAttribute(attr) || 'false' })),
    };
    drag.fromX = part.offsetLeft;
  });

  document.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_FROM) return;
      drag.moved = true;
      try { drag.bar.setPointerCapture(e.pointerId); } catch { /* moves still reach the page */ }
      drag.bar.classList.remove('is-thumb-settle');
      drag.bar.classList.add('is-thumb-drag');
    }
    place(drag.fromX + dx);
    e.preventDefault();
  });

  const end = e => {
    // Put back with Esc: the release that follows clicks nothing either.
    if (escaped === e.pointerId) { escaped = null; swallowNextClick(); return; }
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) { drag = null; return; }
    finish(e.type === 'pointerup');
    swallowNextClick();
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('lostpointercapture', e => { if (drag && e.target === drag.bar) end(e); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !drag?.moved) return;
    e.preventDefault();
    e.stopPropagation();
    escaped = drag.id;
    finish(false);
  }, true);
  document.addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
})();
