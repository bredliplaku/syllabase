// Sign-ins that end after an hour without use, and never while there is unsaved work. Used by
// the course editor (index.html, also on lecturer websites) and the timetable panel.
// The time of last use is kept per sign-in in localStorage and shared by its tabs, so it holds
// across a closed tab, a closed browser or a sleeping computer, which a timer in the page can't.
// js/skeleton.js reads the same time to choose its loading screen.
(function () {
  'use strict';
  const LIMIT_MS = 60 * 60 * 1000;
  const CHECK_MS = 60 * 1000;
  const SEEN_MS = 15 * 1000; // activity is written down at most this often

  const usedKey = storageKey => `${storageKey}-last-used`;
  const read = key => { try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; } };
  const write = (key, value) => { try { localStorage.setItem(key, String(value)); } catch { } };
  const remove = key => { try { localStorage.removeItem(key); } catch { } };
  // Back from Google with a new session in the address: #access_token, or ?code (PKCE).
  const returning = () => /(^#|&)access_token=/.test(location.hash) || new URLSearchParams(location.search).has('code');

  // Before the Supabase client starts: a stored sign-in unused for longer than the limit (or
  // from before this rule) is dropped from this browser, so the page opens signed out. Returns
  // true when it was.
  function dropExpired(storageKey) {
    if (returning()) { write(usedKey(storageKey), Date.now()); return false; }
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(storageKey)); } catch { }
    if (!stored?.refresh_token) return false;
    const last = read(usedKey(storageKey));
    if (last && Date.now() - last <= LIMIT_MS) return false;
    remove(storageKey);
    remove(usedKey(storageKey));
    return true;
  }

  // While the panel is on screen. Activity in any tab of the sign-in counts as use; after the
  // limit without any, onExpire signs out. Unsaved work keeps the sign-in instead, in this tab
  // or another: a tab with unsaved work holds a Web Lock, which the browser releases when that
  // tab closes. Activity after the limit never revives the sign-in.
  function watch({ storageKey, hasUnsavedWork, onExpire }) {
    const key = usedKey(storageKey), lockName = `${storageKey}-unsaved`;
    let running = false, timer = null, seen = 0, hold = null, holdTimer = null;

    const touch = () => write(key, Date.now());
    const expired = () => { const last = read(key); return !!last && Date.now() - last > LIMIT_MS; };

    function syncHold() {
      const dirty = running && !!hasUnsavedWork();
      if (dirty && !hold && navigator.locks) {
        const mine = hold = {};
        navigator.locks.request(lockName, { mode: 'shared' }, () => new Promise(resolve => {
          mine.release = resolve;
          if (hold !== mine) resolve(); // let go before it was granted
        })).catch(() => { });
      } else if (!dirty && hold) {
        hold.release?.();
        hold = null;
      }
    }

    async function otherTabHasWork() {
      try { return !!(await navigator.locks?.query())?.held.some(lock => lock.name === lockName); } catch { return false; }
    }

    async function check() {
      if (!running) return;
      syncHold();
      if (hasUnsavedWork()) { touch(); return; }
      if (!read(key)) { touch(); return; }
      if (!expired() || await otherTabHasWork() || !running) return;
      stop();
      onExpire();
    }

    function onActivity() {
      if (!running || Date.now() - seen < SEEN_MS) return;
      seen = Date.now();
      if (expired()) { check(); return; }
      touch();
      syncHold();
    }

    function start() {
      if (running) return;
      running = true;
      seen = Date.now();
      touch();
      timer = setInterval(check, CHECK_MS);
    }

    function stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      syncHold();
    }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach(type =>
      document.addEventListener(type, onActivity, { passive: true, capture: true }));
    // Edits become unsaved work a moment after the event that makes them.
    ['input', 'change', 'click', 'keyup'].forEach(type => document.addEventListener(type, () => {
      clearTimeout(holdTimer);
      holdTimer = setTimeout(syncHold, 1000);
    }, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    return { start, stop };
  }

  window.SessionGuard = { LIMIT_MS, usedKey, dropExpired, watch };
})();
