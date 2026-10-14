// Dropdown lists in the site's own style. A <select> keeps its look when closed; opening
// it (click, tap, Enter, Space or the arrows) shows this list instead of the browser's.
// The <select> still holds the value and fires 'input' and 'change', so pages read it as
// before, including selects added later. Skipped: multiple and sized lists, disabled
// ones, data-native, and the searchable combo's hidden select (enhanceSearchSelect).
(function () {
  'use strict';

  let list = null, owner = null, active = -1, typed = '', typedAt = 0, touch = null;
  const CHECK = '<svg class="pick-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const eligible = el => el instanceof HTMLSelectElement && !el.multiple && el.size <= 1 && !el.disabled &&
    !('native' in el.dataset) && !el.classList.contains('combo-native');
  const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const items = () => (list ? [...list.querySelectorAll('[role="option"]')] : []);
  const usable = item => item && item.getAttribute('aria-disabled') !== 'true';

  function optionHtml(option) {
    const text = option.textContent.trim();
    // A title that says more than the label (a programme's full name) shows beside it.
    const hint = option.title && option.title !== text ? `<span class="pick-hint">${esc(option.title)}</span>` : '';
    return `<li role="option" id="pick-option-${option.index}" data-index="${option.index}" class="pick-option${option.selected ? ' is-selected' : ''}"` +
      ` aria-selected="${option.selected}"${option.disabled ? ' aria-disabled="true"' : ''}>` +
      `<span class="pick-text">${esc(text) || '&nbsp;'}</span>${hint}${CHECK}</li>`;
  }

  function place() {
    const rect = owner.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return close();
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const up = below < 200 && above > below;
    const width = Math.max(rect.width, Math.min(list.scrollWidth + 2, 360));
    list.style.minWidth = `${rect.width}px`;
    list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    list.style.maxHeight = `${Math.max(140, Math.min(320, up ? above : below))}px`;
    list.style.top = up ? '' : `${rect.bottom + 6}px`;
    list.style.bottom = up ? `${window.innerHeight - rect.top + 6}px` : '';
    list.classList.toggle('is-up', up);
  }

  function setActive(index, scroll = true) {
    active = index;
    items().forEach((item, i) => item.classList.toggle('is-active', i === index));
    const item = items()[index];
    if (item) {
      owner.setAttribute('aria-activedescendant', item.id);
      if (scroll) item.scrollIntoView({ block: 'nearest' });
    }
  }

  // The next usable option from index, stepping by step (+1 down, -1 up).
  function step(from, by) {
    const all = items();
    for (let i = from + by; i >= 0 && i < all.length; i += by) if (usable(all[i])) return i;
    return from;
  }

  function open(select) {
    close();
    owner = select;
    list = document.createElement('ul');
    list.className = 'pick-list';
    list.id = 'pick-list';
    list.setAttribute('role', 'listbox');
    const label = select.getAttribute('aria-label') || select.labels?.[0]?.textContent.trim();
    if (label) list.setAttribute('aria-label', label);
    list.innerHTML = [...select.children].map(child => {
      if (child instanceof HTMLOptGroupElement) {
        return `<li class="pick-group" role="presentation">${esc(child.label)}</li>` +
          [...child.children].filter(option => !option.hidden).map(optionHtml).join('');
      }
      return child instanceof HTMLOptionElement && !child.hidden ? optionHtml(child) : '';
    }).join('');
    document.body.appendChild(list);
    select.classList.add('is-picking');
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', list.id);
    place();
    const chosen = items().findIndex(item => item.classList.contains('is-selected'));
    setActive(chosen >= 0 ? chosen : step(-1, 1), false);
    const item = items()[active];
    if (item) list.scrollTop = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;

    list.addEventListener('pointermove', event => {
      const item = event.target.closest('[role="option"]');
      if (item && usable(item)) setActive(items().indexOf(item), false);
    });
    list.addEventListener('mousedown', event => event.preventDefault()); // focus stays on the select
    list.addEventListener('click', event => {
      const item = event.target.closest('[role="option"]');
      if (usable(item)) choose(Number(item.dataset.index));
    });
  }

  function close(refocus = false) {
    if (!list) return;
    const select = owner;
    list.remove();
    list = null; owner = null; active = -1;
    select.classList.remove('is-picking');
    select.setAttribute('aria-expanded', 'false');
    select.removeAttribute('aria-activedescendant');
    if (refocus) select.focus({ preventScroll: true });
  }

  function choose(index) {
    const select = owner;
    close(true);
    if (!select || index < 0 || select.selectedIndex === index) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Typing a few letters jumps to the first option that starts with them.
  function typeAhead(key) {
    typed = Date.now() - typedAt > 700 ? key : typed + key;
    typedAt = Date.now();
    const all = items();
    const hit = all.findIndex(item => usable(item) && item.querySelector('.pick-text').textContent.trim().toLowerCase().startsWith(typed.toLowerCase()));
    if (hit >= 0) setActive(hit);
  }

  // Opened by pointer: no focus ring (as the browser's own list), until a key is used.
  function toggle(select) {
    select.classList.add('pick-pointer');
    if (owner === select) close();
    else open(select);
  }
  document.addEventListener('focusout', event => event.target.classList?.remove('pick-pointer'));

  // A click opens the list in place of the browser's; a tap too (on touchend, so a
  // swipe that starts on a select still scrolls the page).
  document.addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    const select = event.target.closest?.('select');
    if (!eligible(select)) {
      if (list && !list.contains(event.target)) close();
      return;
    }
    event.preventDefault();
    select.focus({ preventScroll: true });
    toggle(select);
  }, true);
  document.addEventListener('touchstart', event => {
    const point = event.touches[0];
    touch = { x: point.clientX, y: point.clientY };
    if (list && !list.contains(event.target) && !eligible(event.target.closest?.('select'))) close();
  }, { capture: true, passive: true });
  document.addEventListener('touchend', event => {
    const select = event.target.closest?.('select');
    const point = event.changedTouches[0];
    const moved = !touch || Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 10;
    if (!eligible(select) || moved) return;
    event.preventDefault(); // no mouse events and no browser list
    select.focus({ preventScroll: true });
    toggle(select);
  }, { capture: true, passive: false });

  document.addEventListener('keydown', event => {
    if (event.key === 'Tab' || !list) event.target.classList?.remove('pick-pointer');
    if (event.ctrlKey || event.metaKey) return;
    if (!list) {
      const select = event.target;
      const opens = ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(event.key);
      if (eligible(select) && opens && !(event.key === ' ' && Date.now() - typedAt < 700)) {
        event.preventDefault();
        open(select);
      }
      return;
    }
    const all = items();
    const keys = {
      ArrowDown: () => setActive(step(active, 1)),
      ArrowUp: () => event.altKey ? choose(Number(all[active]?.dataset.index ?? -1)) : setActive(step(active, -1)),
      Home: () => setActive(step(-1, 1)),
      End: () => setActive(step(all.length, -1)),
      PageDown: () => setActive(step(Math.min(active + 7, all.length - 1) - 1, 1)),
      PageUp: () => setActive(step(Math.max(active - 7, 0) + 1, -1)),
      Enter: () => choose(Number(all[active]?.dataset.index ?? -1)),
      Escape: () => close(true),
      Tab: () => { close(); return true; }
    };
    if (event.key === ' ' && Date.now() - typedAt >= 700) keys[' '] = keys.Enter;
    const action = keys[event.key];
    if (action) {
      if (action() !== true) { event.preventDefault(); event.stopPropagation(); }
    } else if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      typeAhead(event.key);
    }
  }, true);

  window.addEventListener('resize', () => close());
  document.addEventListener('scroll', event => {
    if (list && event.target !== list) place();
  }, true);
  // A select that leaves the page (a list re-rendered under it) takes its list along.
  new MutationObserver(() => { if (owner && !owner.isConnected) close(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
