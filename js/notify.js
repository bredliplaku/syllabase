// Notifications for every page (course pages, the course editor, the exam page, the
// timetable admin), as STANDO shows them: cards at the top of the screen, newest first, at
// most three. A tap dismisses one; it can be dragged sideways or up, and springs back with a
// bounce when let go too soon, or flies off, fading, when dragged far enough. Each leaves on
// its own after a while (errors stay longer; duration 0 stays until dismissed), but not while
// the pointer rests on it. Styles: css/main.css (Notifications).
//
//   Notify.show(type, title, message = '', duration = 5000)
//     type: 'success' | 'error' | 'warning' | 'info' (also 'ok' and 'err')
//   Notify.clear()
//
// Plain script: Notify is a window global. Load it before the page's own scripts.
(function () {
  'use strict';

  const ICONS = { success: 'check', error: 'xmark', warning: 'exclamation', info: 'info' };
  const TYPES = { ok: 'success', err: 'error', '': 'info', delete: 'error' };
  let lastKey = '', lastTime = 0;

  function area() {
    let el = document.getElementById('notify-area');
    if (!el) {
      el = document.createElement('div');
      el.id = 'notify-area';
      el.className = 'notify-area';
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  }

  function show(type, title, message = '', duration = 5000) {
    type = TYPES[type] ?? (ICONS[type] ? type : 'info');
    title = String(title ?? '');
    message = String(message ?? '');
    // The same notification twice in a row (a double click, a retry) shows once.
    const key = `${type}|${title}|${message}`;
    if (key === lastKey && Date.now() - lastTime < 3000) return null;
    lastKey = key;
    lastTime = Date.now();

    const holder = area();
    // A new notification replaces one of the same kind; the oldest makes room for a fourth.
    holder.querySelectorAll(`.notify[data-type="${type}"]`).forEach(el => leave(el));
    const shown = holder.querySelectorAll('.notify:not(.removing)');
    if (shown.length >= 3) leave(shown[shown.length - 1]);

    const note = document.createElement('div');
    note.className = `notify notify-${type}`;
    note.dataset.type = type;
    note.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');
    note.title = 'Tap to dismiss';
    // Title and message are plain text: they often carry names and server errors. Line
    // breaks ("\n") in the message are kept.
    note.innerHTML = `<span class="notify-icon" aria-hidden="true"><i class="fa-solid fa-${ICONS[type]}"></i></span>
      <div class="notify-text"><strong></strong><span class="notify-message"></span></div>`;
    note.querySelector('strong').textContent = title;
    note.querySelector('.notify-message').textContent = message;
    holder.prepend(note);

    const lasting = duration === 0 ? 0 : type === 'error' ? Math.max(duration || 0, 8000) : duration || 5000;
    const startTimer = ms => {
      clearTimeout(note._timer);
      if (lasting) note._timer = setTimeout(() => leave(note), ms);
    };
    startTimer(lasting);
    note.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') clearTimeout(note._timer); });
    note.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse' && !note.classList.contains('is-dragging')) startTimer(2500);
    });
    swipeable(note, () => startTimer(type === 'error' ? 6000 : 3000));
    return note;
  }

  // A toast-style call (the editors' toast(message, type)): "Save failed: reason" becomes a
  // title and its message.
  function toast(text, type) {
    const m = String(text ?? '').match(/^([^:\n]{2,48}):\s+([\s\S]+)$/);
    if (!m) return show(type, text);
    return show(type, m[1], m[2].charAt(0).toUpperCase() + m[2].slice(1));
  }

  // It leaves the way it is going, fading as it moves; then the space it held closes, so the
  // ones below glide up instead of jumping.
  function leave(el, { x = 0, y = -12, rotate = 0 } = {}) {
    if (!el || el.classList.contains('removing')) return;
    el.classList.add('removing');
    el.classList.remove('is-dragging', 'is-settling');
    clearTimeout(el._timer);
    el.style.animation = 'none';
    el.style.transition = 'transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.22s ease-out';
    el.style.transform = `translate(${x}px, ${y}px) rotate(${rotate}deg)`;
    el.style.opacity = '0';
    setTimeout(() => {
      el.style.height = `${el.offsetHeight}px`;
      void el.offsetHeight;
      el.style.transition = 'height 0.2s ease, padding 0.2s ease, margin 0.2s ease, border-width 0.2s ease';
      el.style.height = '0px';
      el.style.paddingTop = '0px';
      el.style.paddingBottom = '0px';
      el.style.borderWidth = '0px';
      el.style.marginBottom = '-8px'; // takes back the gap above the next one
    }, 200);
    setTimeout(() => el.remove(), 450);
  }

  // Dragged sideways (either way) or up with a finger or the mouse; a tap without moving
  // dismisses it too. Let go before it is far enough (or flicked fast enough) and it springs
  // back with an overshoot.
  function swipeable(el, onSettle) {
    let drag = null;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || el.classList.contains('removing')) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0, axis: null };
      el.setPointerCapture(e.pointerId);
      el.style.animation = 'none';
      el.classList.remove('is-settling');
      el.classList.add('is-dragging');
      clearTimeout(el._timer);
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dx = e.clientX - drag.x;
      drag.dy = e.clientY - drag.y;
      if (!drag.axis && Math.hypot(drag.dx, drag.dy) > 6) drag.axis = Math.abs(drag.dx) >= Math.abs(drag.dy) ? 'x' : 'y';
      if (drag.axis === 'x') {
        el.style.transform = `translateX(${drag.dx}px) rotate(${drag.dx / 30}deg)`;
        el.style.opacity = String(Math.max(0.15, 1 - Math.abs(drag.dx) / el.offsetWidth));
      } else if (drag.axis === 'y') {
        // Up follows the pointer; down resists, as there is nowhere to go.
        el.style.transform = `translateY(${drag.dy < 0 ? drag.dy : drag.dy / 5}px)`;
        el.style.opacity = String(Math.max(0.15, 1 + Math.min(0, drag.dy) / (el.offsetHeight * 1.5)));
      }
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const { dx, dy, axis } = drag;
      const ms = Math.max(1, performance.now() - drag.t);
      drag = null;
      el.classList.remove('is-dragging');
      if (el.classList.contains('removing')) return;
      if (!axis && e.type === 'pointerup') {
        leave(el);
      } else if (axis === 'x' && (Math.abs(dx) > el.offsetWidth * 0.35 || Math.abs(dx) / ms > 0.6)) {
        const side = Math.sign(dx);
        leave(el, { x: side * (el.offsetWidth + 60), y: 0, rotate: side * 12 });
      } else if (axis === 'y' && (dy < -el.offsetHeight * 0.5 || dy / ms < -0.6)) {
        leave(el, { x: 0, y: -(el.offsetHeight + 40) });
      } else {
        el.classList.add('is-settling');
        el.style.transform = '';
        el.style.opacity = '';
        setTimeout(() => el.classList.remove('is-settling'), 600);
        onSettle();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function clear() {
    document.querySelectorAll('#notify-area .notify').forEach(el => el.remove());
  }

  window.Notify = { show, toast, leave, clear };
})();
