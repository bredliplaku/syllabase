// Dialogs (.modal-overlay) on every page that has them: the editor, the exam page and the
// timetable panel. Each page fills and opens its own (adding .open) and closes them its own
// way; this file does what they share:
// - Escape, a click outside, an × (any [data-close]) and Back close the top dialog. One with
//   changes asks first, unless its page asks itself (overlay._requestClose).
// - Each open dialog has a history entry at the same address, so Back (the browser's button,
//   a mouse's back button, Android's back gesture, iOS's swipe) closes it instead of leaving
//   the page. Where the browser animates Back itself (Android's predictive back), the dialog
//   goes without its own way out.
// - Dialogs stack in the order they opened. On a computer, one opened over another takes its
//   size, so the one beneath never shows round its edges. On a phone, a sheet reaches up to
//   just under the title bar of the one behind, so the bars of what is open read down like a
//   tree. Confirmations keep their own size.
window.Dialogs = (function () {
  'use strict';

  const OPEN = '.modal-overlay.open';
  const isConfirm = overlay => overlay.id === 'confirm-overlay';
  let order = [];

  // The open dialogs, bottom first.
  function openDialogs() {
    const open = [...document.querySelectorAll(OPEN)];
    order = order.filter(el => open.includes(el)).concat(open.filter(el => !order.includes(el)));
    return order;
  }
  const top = () => openDialogs().at(-1) || null;

  // ── Changes ──
  // What each field held when its dialog opened (or when the field was added to an open one).
  // Search boxes, passwords and file choices are not work to lose, nor are choices inside
  // [data-no-dirty] (Copy to…'s courses).
  const FIELDS = 'input, select, textarea';
  const recorded = new WeakMap();
  const valueOf = el => (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
  const counts = el => !el.matches('[type="search"], [type="password"], [type="file"], [type="hidden"], [type="button"], [type="submit"], [type="reset"]') &&
    !el.closest('[data-no-dirty]');
  const fieldsIn = root => (root.matches(FIELDS) ? [root] : [...root.querySelectorAll(FIELDS)]);

  function hasChanges(overlay) {
    return [...overlay.querySelectorAll(FIELDS)].some(el => counts(el) && recorded.has(el) && recorded.get(el) !== valueOf(el));
  }

  async function confirmDiscard() {
    const message = 'Discard your changes?';
    if (typeof window.confirmDialog !== 'function') return window.confirm(message);
    return (await window.confirmDialog(message, { title: 'Unsaved Changes', okLabel: 'Discard', danger: true, okIcon: 'fa-trash-can' })) === true;
  }

  // Closing as its × does: a confirmation answers no; a page's own question comes first
  // (overlay._requestClose); else changes are asked about, then the page's way of closing
  // (overlay._close) or just dropping .open.
  async function requestClose(overlay) {
    if (!overlay?.classList.contains('open')) return;
    if (isConfirm(overlay)) { window._resolveConfirm?.(false); return; }
    if (typeof overlay._requestClose === 'function') { await overlay._requestClose(); return; }
    if (hasChanges(overlay) && !(await confirmDiscard())) return;
    if (typeof overlay._close === 'function') overlay._close();
    else overlay.classList.remove('open');
  }

  // ── Back ──
  // Entries carry this page load's id, so ones left by an earlier load (a reload with a
  // dialog open) are not counted. A dialog opened with no click or key behind it gets no
  // entry: Chrome would skip the page's own entry on Back, and leave the page.
  const PAGE = Math.random().toString(36).slice(2);
  let stepping = false, stepTimer = 0;
  const depth = () => (history.state?.dialogPage === PAGE ? Number(history.state.dialogDepth) || 0 : 0);
  const baseState = () => {
    const { dialogPage, dialogDepth, ...rest } = history.state && typeof history.state === 'object' ? history.state : {};
    return rest;
  };

  function syncHistory() {
    if (stepping) return;
    const open = openDialogs().length;
    let at = depth();
    try {
      if (at < open && navigator.userActivation?.isActive !== false) {
        while (at < open) history.pushState({ ...baseState(), dialogPage: PAGE, dialogDepth: ++at }, '');
      } else if (at > open) {
        // Back over the closed dialogs' entries; nothing else moves until it lands.
        stepping = true;
        clearTimeout(stepTimer);
        stepTimer = setTimeout(() => { stepping = false; syncHistory(); }, 1000);
        history.go(open - at);
      }
    } catch { /* A browser limiting history changes: Back works as usual meanwhile. */ }
  }

  window.addEventListener('popstate', event => {
    if (stepping) {
      stepping = false;
      clearTimeout(stepTimer);
      syncHistory();
      return;
    }
    const overlay = depth() < openDialogs().length ? top() : null;
    if (!overlay) { syncHistory(); return; }
    if (event.hasUAVisualTransition) {
      overlay.classList.add('dialog-instant');
      requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.remove('dialog-instant')));
    }
    // One that stays (it asks about its changes) gets its entry back.
    Promise.resolve(requestClose(overlay)).finally(syncHistory);
  });

  // ── Stacking ──
  const desktop = matchMedia('(min-width: 769px)');
  function place() {
    let under = null, barBottom = 0;
    openDialogs().forEach((overlay, level) => {
      overlay.style.setProperty('--dialog-level', level);
      const modal = overlay.querySelector(':scope > .modal');
      if (!modal) return;
      overlay.classList.toggle('is-stacked', level > 0);
      if (level > 0) overlay.style.setProperty('--sheet-top', `${barBottom}px`);
      else overlay.style.removeProperty('--sheet-top');
      const sized = !!under && !isConfirm(overlay) && desktop.matches;
      if (sized) {
        overlay.style.setProperty('--stack-width', `${under.offsetWidth}px`);
        overlay.style.setProperty('--stack-height', `${under.offsetHeight}px`);
      }
      overlay.classList.toggle('is-sized', sized);
      // Layout boxes, so a sheet still sliding in counts where it will stop.
      const head = modal.querySelector(':scope > .modal-head');
      if (head) barBottom = modal.offsetTop + head.offsetTop + head.offsetHeight;
      if (!isConfirm(overlay)) under = modal;
    });
  }

  function update() {
    const before = order.slice();
    openDialogs().filter(el => !before.includes(el))
      .forEach(overlay => fieldsIn(overlay).forEach(el => recorded.set(el, valueOf(el))));
    place();
    syncHistory();
  }

  // Before the first paint of a dialog: its baseline, its place in the stack and its entry.
  new MutationObserver(records => {
    let changed = false;
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target.classList.contains('modal-overlay')) changed = true;
        continue;
      }
      r.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.classList.contains('modal-overlay')) changed = true;
        else if (node.closest(OPEN)) fieldsIn(node).forEach(el => { if (!recorded.has(el)) recorded.set(el, valueOf(el)); });
      });
      r.removedNodes.forEach(node => { if (node.nodeType === 1 && node.classList.contains('modal-overlay')) changed = true; });
    }
    if (changed) update();
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', place);

  // ── Closing ──
  // A click outside closes only when it also began outside, so a drag that starts in a field
  // and ends on the backdrop keeps the dialog.
  let downOn = null;
  document.addEventListener('pointerdown', event => { downOn = event.target; }, true);
  document.addEventListener('click', event => {
    const target = event.target;
    if (target.matches?.(OPEN)) {
      if (downOn === target) requestClose(target);
      return;
    }
    const close = target.closest?.('[data-close]');
    if (close) requestClose(close.closest('.modal-overlay'));
  });

  // Bubbling to the window, so a field's open list (pick.js, suggest.js, comboboxes) takes
  // Escape first.
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    const overlay = top();
    if (!overlay) return;
    event.preventDefault();
    requestClose(overlay);
  });

  return { top, requestClose, hasChanges };
})();
