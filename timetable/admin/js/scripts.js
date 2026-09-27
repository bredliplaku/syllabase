/* ==========================================================================
   Timetable Panel — editor for the department Class Timetable (/timetable/).

   Reads and writes the `timetable_rows` table in the shared Supabase project,
   behind the same Google sign-in and the same `admins` allowlist as the
   teaching panel. The whole configuration is a few dozen rows, so this loads
   all of them once and each tab saves its own slice.

   Layout differs from the teaching panel on purpose: that one is
   course-per-sidebar-item, this one edits a single global configuration, so
   the four tabs sit directly under the top bar with no sidebar.
   ========================================================================== */
(function () {
  'use strict';

  const SUPABASE_URL = window.TEACHING_CONFIG.supabaseUrl;
  const SUPABASE_ANON_KEY = window.TEACHING_CONFIG.supabaseAnonKey;
  const { createClient } = supabase;

  // Synchronously drop only genuinely unusable session blobs BEFORE createClient
  // (corrupt JSON, or missing the refresh_token needed to revive the session). An
  // expired access_token alone is normal — that's what the refresh_token is for —
  // so it must NOT count as a reason to delete the session, or the admin gets
  // signed out on every visit once the short-lived access_token expires.
  (function () {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
          try {
            const d = JSON.parse(localStorage.getItem(k));
            if (!d?.access_token || !d?.refresh_token) localStorage.removeItem(k);
          } catch { localStorage.removeItem(k); }
        }
      }
    } catch { }
  })();

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true },
  });

  const FA_SEARCH_URL = 'https://fontawesome.com/search?ic=free-collection';

  const SECTIONS = [
    { id: 'categories', label: 'Categories', icon: 'fa-solid fa-layer-group' },
    { id: 'settings', label: 'Settings', icon: 'fa-solid fa-gear' },
  ];

  const SETTING_KEYS = ['semester_start', 'semester_end', 'holiday_start', 'holiday_weeks'];

  // All timetable_rows, keyed by row_uid. Loaded once at sign-in and kept in
  // step with every successful save, so a tab switch never needs a round trip.
  let ROWS = {};

  const TAB_KEY = 'tt-admin-tab';
  const VALID_SECTIONS = new Set(SECTIONS.map(s => s.id));

  function cachedSection() {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (saved && VALID_SECTIONS.has(saved)) return saved;
    } catch { }
    return 'categories';
  }

  const S = { admin: null, section: cachedSection() };

  let _sessionHandled = false;
  let _confirmResolve = null;
  let _tt = null;


  /* === UNSAVED-CHANGES TRACKING ==========================================
     True once something is staged in the open tab but not yet in the DB:
     typing, adding, deleting, or reordering. Cleared when a tab (re)renders
     or a save succeeds.
     ====================================================================== */

  let _dirty = false;
  function markDirty() { _dirty = true; }
  function clearDirty() { _dirty = false; }

  // Delegated on document so it survives every re-render of the section body.
  // Programmatic value/innerHTML changes don't fire these, so a fresh render
  // never trips the flag on its own.
  document.addEventListener('input', e => { if (e.target.closest?.('#section-body')) markDirty(); });
  document.addEventListener('change', e => { if (e.target.closest?.('#section-body')) markDirty(); });

  // Leaving the page entirely can only use the browser's native prompt.
  window.addEventListener('beforeunload', e => {
    if (_dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // Every save is a real network round trip and only clears _dirty once it
  // resolves. Without this, clicking Save and immediately clicking a
  // different tab races the network: the tab click lands while _dirty is
  // still true (the save just hasn't finished yet), so confirmLeaveIfDirty()
  // shows "unsaved changes" for a save that's already in flight and about to
  // succeed — reads as "I have to save twice." wireSection() wraps each save
  // button's click in trackSave() so confirmLeaveIfDirty() can await the
  // in-flight save first and judge the flag it actually leaves behind.
  let _savePromise = null;
  function trackSave(promise) {
    _savePromise = promise;
    promise.finally(() => { if (_savePromise === promise) _savePromise = null; });
    return promise;
  }

  async function confirmLeaveIfDirty() {
    if (_savePromise) await _savePromise.catch(() => { });
    if (!_dirty) return true;
    const answer = await confirmDialog(
      'You have unsaved changes in this tab. Leave without saving?',
      { title: 'Unsaved Changes', okLabel: 'Discard', danger: true, okIcon: 'fa-trash-can' });
    if (answer) clearDirty();
    return answer;
  }


  /* === AUTH ===============================================================
     Lifted from the teaching panel — same allowlist, same Google client, so
     signing into one signs you into the other.
     ====================================================================== */

  // Whether a session blob with both tokens is in localStorage right now. Tells
  // "definitely logged out" apart from "getSession() returned empty because its
  // internal token-refresh race hasn't resolved" — the latter must not flash the
  // login screen, since onAuthStateChange corrects it a moment later.
  function hasStoredSession() {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
          const d = JSON.parse(localStorage.getItem(k));
          if (d?.access_token && d?.refresh_token) return true;
        }
      }
    } catch { }
    return false;
  }

  // Sizes the ambiguous-session fallback from the browser's own reported
  // connection quality rather than a blind guess: a token refresh is one round
  // trip, so the wait only needs to be a small multiple of the real RTT.
  function estimateAuthTimeoutMs() {
    if (navigator.onLine === false) return 0;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      if (typeof conn.rtt === 'number' && conn.rtt > 0) {
        return Math.min(6000, Math.max(1200, conn.rtt * 6));
      }
      const byType = { 'slow-2g': 6000, '2g': 5000, '3g': 3000, '4g': 1500 };
      if (conn.effectiveType && byType[conn.effectiveType] != null) return byType[conn.effectiveType];
    }
    return 3000;
  }

  // Race getSession() against a timeout so a slow refresh never leaves a blank
  // screen. A timeout only *shows* the login screen — it never deletes the
  // stored session, so a slow-but-valid session still logs in when it resolves.
  (async () => {
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      if (!_sessionHandled) { hideBootSpinner(); showScreen('login'); }
    }, estimateAuthTimeoutMs());

    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session && !_sessionHandled) {
        clearTimeout(timeoutId);
        _sessionHandled = true;
        promoteToFullSkeleton();
        await handleSession(session);
      } else if (!session && !hasStoredSession() && !_sessionHandled && !didTimeout) {
        clearTimeout(timeoutId);
        hideBootSpinner();
        showScreen('login');
      }
      // else: empty result despite a stored session. Keep the neutral boot
      // spinner up and let onAuthStateChange decide, with the timeout as the
      // final fallback.
    } catch {
      if (!hasStoredSession() && !_sessionHandled) {
        clearTimeout(timeoutId);
        hideBootSpinner();
        showScreen('login');
      }
    }
  })();

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') { _sessionHandled = false; hideBootSpinner(); showScreen('login'); return; }
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session && !_sessionHandled) {
      _sessionHandled = true;
      promoteToFullSkeleton();
      await handleSession(session);
    }
  });

  async function signIn() {
    const btn = document.getElementById('signin-btn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px"></i>Signing in...';
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) { toast('Sign-in failed: ' + error.message, 'err'); btn.disabled = false; btn.innerHTML = orig; }
  }

  async function signOut() {
    _sessionHandled = false;
    // Stop One Tap silently re-selecting the same account the instant the login
    // screen reappears — without this, signing out becomes a re-login loop.
    try { google.accounts.id.disableAutoSelect(); } catch { }
    await sb.auth.signOut();
    window.history.replaceState(null, '', window.location.pathname);
  }

  /* --- Google One Tap ---------------------------------------------------
     Signs in with no redirect and no popup: GIS shows a browser-mediated
     (FedCM) prompt, and the resulting ID token is verified by Supabase.
     The button above stays as the fallback for when One Tap can't display.

     Nonce contract: Google gets the SHA-256 HASH of the nonce inside the ID
     token; Supabase gets the RAW nonce and checks the hash matches — proving
     the token was minted for this page load. */

  const GOOGLE_CLIENT_ID = window.TEACHING_CONFIG.googleClientId;
  let _oneTapNonce = null;
  let _oneTapInited = false;
  let _oneTapWanted = false;   // login screen showed before the GIS script loaded

  window._gsiOnLoad = () => { if (_oneTapWanted) showOneTap(); };

  async function initOneTap() {
    if (_oneTapInited) return true;
    if (!window.google?.accounts?.id || !window.crypto?.subtle) return false;

    const raw = crypto.getRandomValues(new Uint8Array(32));
    _oneTapNonce = btoa(String.fromCharCode(...raw)).replace(/[+/=]/g, '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(_oneTapNonce));
    const hashedNonce = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');

    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: onOneTapCredential,
      nonce: hashedNonce,
      context: 'signin',
      auto_select: true,
      itp_support: true,
      use_fedcm_for_prompt: true,
    });
    _oneTapInited = true;
    return true;
  }

  async function showOneTap() {
    _oneTapWanted = false;
    if (!(await initOneTap())) { _oneTapWanted = true; return; }  // retried from _gsiOnLoad
    google.accounts.id.prompt();
  }

  function cancelOneTap() {
    if (_oneTapInited) { try { google.accounts.id.cancel(); } catch { } }
  }

  async function onOneTapCredential(resp) {
    const btn = document.getElementById('signin-btn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px"></i>Signing in...';
    const { error } = await sb.auth.signInWithIdToken({
      provider: 'google', token: resp.credential, nonce: _oneTapNonce,
    });
    if (error) { toast('Sign-in failed: ' + error.message, 'err'); btn.disabled = false; btn.innerHTML = orig; }
    // On success onAuthStateChange fires SIGNED_IN → handleSession().
  }

  /* --- Idle sign-out ----------------------------------------------------
     Guards against staying signed in on a shared machine. Only runs while
     the panel is actually on screen (started/stopped by showScreen). */

  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  let _idleTimer = null;
  let _idleWatchStarted = false;

  function resetIdleTimer() {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(async () => {
      toast('Signed out due to inactivity', 'err');
      await signOut();
    }, IDLE_TIMEOUT_MS);
  }

  function startIdleWatch() {
    resetIdleTimer();
    if (_idleWatchStarted) return;
    _idleWatchStarted = true;
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt =>
      document.addEventListener(evt, resetIdleTimer, { passive: true }));
  }

  function stopIdleWatch() {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = null;
  }

  async function handleSession(session) {
    let admin;
    try {
      // Start the row fetch alongside the identity lookup: the two are
      // independent (both only need the token), so overlapping them saves a
      // full round trip on every sign-in.
      const rowsPromise = sb.from('timetable_rows').select('*').order('row_index');
      const result = await Promise.race([
        sb.from('admins').select('name,surname,email').single(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
      ]);
      admin = result.data;

      if (admin) {
        const { data, error } = await rowsPromise;
        if (error) throw error;
        ROWS = {};
        for (const r of (data || [])) ROWS[r.row_uid] = r;
      }
    } catch {
      // Supabase cold start or network blip. The auth session itself is fine,
      // so don't delete it — fall back to login and let a retry re-run this.
      _sessionHandled = false;
      hideLoading();
      showScreen('login');
      return;
    }

    hideLoading();

    if (!admin) {
      document.getElementById('error-msg').textContent =
        (session.user.email || 'Your account') + ' is not in the admin list.';
      showScreen('error');
      return;
    }

    S.admin = admin;
    // Photo (initials underneath) and name, as in the teaching admin's top bar.
    const name = [admin.name, admin.surname].filter(Boolean).join(' ') || session.user.email || '';
    const meta = session.user.user_metadata || {};
    const photo = [meta.avatar_url, meta.picture].find(url => /^https:\/\//.test(url || '')) || '';
    const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toLocaleUpperCase();
    document.getElementById('top-user').innerHTML = `<span class="user-avatar" aria-hidden="true">${x(initials)}${photo
      ? `<img src="${x(photo)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ''}</span><span>${x(name)}</span>`;
    // Strip the OAuth fragment so a refresh doesn't try to re-consume it.
    if (window.location.href.includes('#')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    showScreen('admin');
    renderTabs();
    selectSection(S.section);
  }


  /* === SCREENS ============================================================ */

  function hideBootSpinner() {
    const el = document.getElementById('boot-spinner');
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; }, 300);
  }

  function promoteToFullSkeleton() {
    hideBootSpinner();
    document.getElementById('app-loading').style.display = 'flex';
  }

  function hideLoading() {
    const el = document.getElementById('app-loading');
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; }, 400);
  }

  function showScreen(w) {
    hideBootSpinner();
    document.getElementById('login-screen').style.display = w === 'login' ? 'flex' : 'none';
    document.getElementById('error-screen').style.display = w === 'error' ? 'flex' : 'none';
    document.getElementById('admin-app').style.display = w === 'admin' ? 'flex' : 'none';
    // The sign-in card carries its own back link, so the footer's would be a duplicate.
    document.getElementById('footer-back').style.display = w === 'login' ? 'none' : '';
    if (w !== 'admin') hideLoading();
    if (w === 'admin') startIdleWatch(); else stopIdleWatch();
    if (w === 'login') showOneTap(); else cancelOneTap();
  }


  /* === ROW HELPERS ========================================================
     Every tab saves the same way: build the exact set of rows that tab owns,
     then replace what's in the database with it. Because a tab's rows are
     fully determined by its form, a diff-free replace is both simpler and
     immune to drifting out of sync — deletes are computed by comparing UIDs.
     ====================================================================== */

  // Strips academic and professional titles from names for accurate alphabetical sorting
  // Supported titles & combinations: Prof., Dr., Assoc., Acad., MSc., Mr., Ms., Mrs.
  function stripTitles(str) {
    let s = String(str || '').trim();
    const titleToken = /\b(?:Prof(?:essor)?|Dr|Assoc(?:\.?\s*Prof(?:essor)?)?|Acad(?:emician)?|M\.?Sc|Mr|Ms|Mrs)\.?/i;
    const titlePattern = new RegExp(`^(?:${titleToken.source}\\s*)+`, 'i');
    const stripped = s.replace(titlePattern, '').trim();
    return stripped || s;
  }

  function parseCourseLabel(label) {
    const str = String(label || '').trim();
    const cleanStr = stripTitles(str);

    // Extract number from string, e.g. "PIR 123", "CE 211", "CE 322", "CE213", "Group 1"
    const match = cleanStr.match(/^(.*?)(?:[\s\-_]*)(\d+)(.*)$/);
    if (match) {
      const prefix = match[1].trim();
      const num = parseInt(match[2], 10);
      const suffix = match[3].trim();
      const text = [prefix, suffix].filter(Boolean).join(' ').trim();
      return {
        hasNum: true,
        num,
        text: text || cleanStr,
        raw: str,
        clean: cleanStr,
      };
    }
    return {
      hasNum: false,
      num: Infinity,
      text: cleanStr,
      raw: str,
      clean: cleanStr,
    };
  }

  function compareCourseLabels(aLabel, bLabel) {
    // Cross-listed codes ("SWE / CE 101") come after single codes, A–Z (as in teaching).
    const crossA = String(aLabel || '').includes('/'), crossB = String(bLabel || '').includes('/');
    if (crossA !== crossB) return crossA ? 1 : -1;
    if (crossA) return String(aLabel).localeCompare(String(bLabel), undefined, { numeric: true, sensitivity: 'base' });
    const a = parseCourseLabel(aLabel);
    const b = parseCourseLabel(bLabel);

    // Both have numbers: sort first by number (e.g. 123 < 211 < 322), then by text
    if (a.hasNum && b.hasNum) {
      if (a.num !== b.num) {
        return a.num - b.num;
      }
      const textCmp = a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: 'base' });
      if (textCmp !== 0) return textCmp;
      return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
    }

    // Items with course numbers come before non-numbered items
    if (a.hasNum && !b.hasNum) return -1;
    if (!a.hasNum && b.hasNum) return 1;

    // Non-numbered items (e.g. Lecturer names): sort by clean name (ignoring titles)
    const cleanCmp = a.clean.localeCompare(b.clean, undefined, { numeric: true, sensitivity: 'base' });
    if (cleanCmp !== 0) return cleanCmp;

    return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
  }

  function rowsOfType(...types) {
    return Object.values(ROWS)
      .filter(r => types.includes(r.type))
      .sort((a, b) => a.row_index - b.row_index);
  }

  function rowsInSection(section, type) {
    return Object.values(ROWS)
      .filter(r => r.section === section && r.type === type)
      .sort((a, b) => a.row_index - b.row_index);
  }

  const BLANK = { b: '', c: '', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };

  // Replaces every row matching `owns` with `rows`, in one upsert + one delete.
  async function replaceRows(owns, rows) {
    const keep = new Set(rows.map(r => r.row_uid));
    const stale = Object.values(ROWS).filter(r => owns(r) && !keep.has(r.row_uid)).map(r => r.row_uid);

    if (rows.length) {
      const { error } = await sb.from('timetable_rows').upsert(rows, { onConflict: 'row_uid' });
      if (error) throw error;
    }
    if (stale.length) {
      const { error } = await sb.from('timetable_rows').delete().in('row_uid', stale);
      if (error) throw error;
    }

    // Mirror the write locally so a tab switch doesn't need to refetch.
    stale.forEach(uid => { delete ROWS[uid]; });
    rows.forEach(r => { ROWS[r.row_uid] = r; });
  }

  // Stable, readable primary keys. Author-supplied text is slugged because
  // row_uid is a text primary key that also ends up in the table editor.
  //
  // Slugging is lossy — "Year 1" and "Year-1" both become "year_1" — so it is
  // NEVER the sole discriminator for a repeatable row. Positional rows (chips,
  // buttons, entries) key off their index instead, and category names are
  // validated for slug-uniqueness in saveCategoriesTab() before being used here.
  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
  }
  function uid(...parts) { return parts.map(slug).join(':'); }

  // Primary key for an entry: category slug (unique by validation) + position.
  function entryUid(category, index) { return `e:${slug(category)}:${index}`; }

  async function withSaveButton(btn, fn) {
    if (!btn) return fn();
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…';
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }


  /* === TABS =============================================================== */

  function renderTabs() {
    document.getElementById('section-tabs').innerHTML = SECTIONS.map((s, i, arr) => {
      // Pill ends on the outermost tabs so the strip reads as one control.
      const r = i === 0 ? 'border-radius:20px 8px 8px 20px'
        : i === arr.length - 1 ? 'border-radius:8px 20px 20px 8px' : '';
      return `<button class="section-tab${s.id === S.section ? ' active' : ''}" style="${r}" data-sec="${s.id}"><i class="${s.icon} tab-icon" aria-hidden="true"></i><span class="tab-label" data-label="${x(s.label)}">${s.label}</span></button>`;
    }).join('');

    document.querySelectorAll('#section-tabs .section-tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.sec === S.section) return;
        if (!(await confirmLeaveIfDirty())) return;
        selectSection(btn.dataset.sec);
      });
    });
  }

  function selectSection(id) {
    S.section = id;
    try { localStorage.setItem(TAB_KEY, id); } catch { }
    document.querySelectorAll('#section-tabs .section-tab')
      .forEach(b => b.classList.toggle('active', b.dataset.sec === id));

    const body = document.getElementById('section-body');
    body.classList.remove('loaded');
    body.innerHTML = ({
      categories: renderCategories,
      settings: renderSettings,
    })[id]();

    // Next frame so the entry animation actually plays on a fresh render.
    requestAnimationFrame(() => body.classList.add('loaded'));

    clearDirty();
    wireSection(id);
  }


  /* === SETTINGS TAB (Semester + Header merged) ============================= */

  function settingValue(key) {
    return rowsOfType('setting').find(r => r.b === key)?.c || '';
  }

  function renderSettings() {
    const v = k => x(settingValue(k));
    const info = rowsOfType('info_item');
    const buttons = rowsOfType('action_button');

    return `
      <div class="section-topbar">
        <button class="btn-sm btn-save-section" id="section-save-btn"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      </div>
      <div class="settings-panel">

        <div class="settings-group">
          <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-calendar-days"></i>Semester Dates</span></div>
          <div class="settings-body">
            <div class="sg-grid">
              <div class="form-group">
                <label class="form-label">Start Date</label>
                <input type="date" id="set_semester_start" value="${v('semester_start')}">
              </div>
              <div class="form-group">
                <label class="form-label">End Date</label>
                <input type="date" id="set_semester_end" value="${v('semester_end')}">
              </div>
              <div class="form-group">
                <label class="form-label">Break Start Date</label>
                <input type="date" id="set_holiday_start" value="${v('holiday_start')}">
              </div>
              <div class="form-group">
                <label class="form-label">Break Length (weeks)</label>
                <input type="number" id="set_holiday_weeks" min="0" max="8" step="1" value="${v('holiday_weeks') || '0'}">
              </div>
            </div>
            <div class="form-hint" style="margin-top:10px">
              During the break the week counter freezes on the last teaching week, and
              weeks after it are shifted back so week numbers keep matching the syllabus.
            </div>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-eye"></i>Preview</span></div>
          <div class="settings-body">
            <!-- As on the public header: the chip and bar are made for its blue banner. -->
            <div class="header-preview">
              <div class="course-info">
                <span class="info-item"><i class="fa-regular fa-clock"></i> <span id="preview-week">—</span></span>
              </div>
              <div class="progress-bar"><div class="progress" id="preview-progress" style="width:0%"></div></div>
            </div>
            <div class="form-hint" id="preview-note" style="margin-top:8px"></div>
          </div>
        </div>

        <div class="settings-group" style="margin-top:6px">
          <div class="settings-head">
            <span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-circle-info"></i>Info Chips</span>
            <button class="btn-sm btn-secondary" type="button" id="add-info-btn"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Chip</button>
          </div>
          <div class="settings-body" id="info-list">
            ${info.map(r => infoCardHtml(r.b, r.c)).join('') ||
      '<div class="form-hint" id="no-info-msg" style="padding:4px 0">No info chips yet.</div>'}
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-head">
            <span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-link"></i>Action Buttons</span>
            <button class="btn-sm btn-secondary" type="button" id="add-action-btn"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Button</button>
          </div>
          <div class="settings-body" id="action-list">
            ${buttons.map(r => actionCardHtml(r.b, r.c, r.d, r.e)).join('') ||
      '<div class="form-hint" id="no-action-msg" style="padding:4px 0">No action buttons yet.</div>'}
          </div>
        </div>

      </div>`;
  }

  function updateSemesterPreview() {
    const start = document.getElementById('set_semester_start')?.value;
    const end = document.getElementById('set_semester_end')?.value;
    const hStart = document.getElementById('set_holiday_start')?.value;
    const hWeeks = document.getElementById('set_holiday_weeks')?.value;
    if (!start && !end) return;

    const week = window.calculateSemesterWeek(start, end, hStart, hWeeks);
    const pct = window.semesterProgress(start, end);

    document.getElementById('preview-week').textContent = week ? `Week ${week}` : 'Semester dates not set';
    document.getElementById('preview-progress').style.width = `${pct}%`;

    const note = document.getElementById('preview-note');
    if (!start || !end) note.textContent = 'Set both dates to see the week counter.';
    else if (new Date(end) <= new Date(start)) note.textContent = '⚠ End date is not after the start date.';
    else note.textContent = `${Math.round(pct)}% of the semester elapsed.`;
  }

  function infoCardHtml(icon = '', text = '') {
    return `<div class="dynamic-card" data-kind="info">
      <div class="dynamic-card-head">
        <span class="dynamic-card-label"><i class="fa-solid fa-grip-vertical drag-handle" style="margin-right:8px;opacity:0.5;cursor:grab"></i><span class="dcl-text">${x(text || 'New Chip')}</span></span>
        <button class="btn-action-del" type="button" data-remove="1" title="Delete chip"><i class="fa-solid fa-trash"></i></button>
      </div>
      <div class="dynamic-card-body sg-grid2">
        <div class="form-group">
          <label class="form-label">Icon</label>
          ${iconInputHtml('info_icon', icon)}
        </div>
        <div class="form-group">
          <label class="form-label">Text</label>
          <input type="text" name="info_text" value="${x(text)}" data-label-source="New Chip">
        </div>
      </div>
    </div>`;
  }

  function actionCardHtml(label = '', icon = '', url = '', cssClass = '') {
    return `<div class="dynamic-card" data-kind="action">
      <div class="dynamic-card-head">
        <span class="dynamic-card-label"><i class="fa-solid fa-grip-vertical drag-handle" style="margin-right:8px;opacity:0.5;cursor:grab"></i><span class="dcl-text">${x(label || 'New Button')}</span></span>
        <button class="btn-action-del" type="button" data-remove="1" title="Delete button"><i class="fa-solid fa-trash"></i></button>
      </div>
      <div class="dynamic-card-body sg-grid2">
        <div class="form-group">
          <label class="form-label">Label</label>
          <input type="text" name="action_label" value="${x(label)}" data-label-source="New Button">
        </div>
        <div class="form-group">
          <label class="form-label">Icon</label>
          ${iconInputHtml('action_icon', icon)}
        </div>
        <div class="form-group">
          <label class="form-label">URL</label>
          <input type="text" name="action_url" value="${x(url)}" placeholder="https://…">
        </div>
        <div class="form-group">
          <label class="form-label">Style</label>
          <select name="action_class">
            <option value=""${cssClass === '' ? ' selected' : ''}>Primary</option>
            <option value="secondary-action"${cssClass === 'secondary-action' ? ' selected' : ''}>Secondary</option>
          </select>
        </div>
      </div>
    </div>`;
  }

  async function saveSettings(btn) {
    // — Semester validation —
    const values = {
      semester_start: document.getElementById('set_semester_start').value,
      semester_end: document.getElementById('set_semester_end').value,
      holiday_start: document.getElementById('set_holiday_start').value,
      holiday_weeks: document.getElementById('set_holiday_weeks').value,
    };

    if (values.semester_start && values.semester_end &&
      new Date(values.semester_end) <= new Date(values.semester_start)) {
      toast('End date must be after the start date', 'err');
      return;
    }

    const settingRows = SETTING_KEYS.map((key, i) => ({
      ...BLANK,
      row_uid: uid('settings', key),
      section: 'settings',
      row_index: i,
      type: 'setting',
      b: key,
      c: values[key] || '',
    }));

    // — Header validation —
    const info = [...document.querySelectorAll('#info-list .dynamic-card')]
      .map(card => ({
        icon: fieldValue(card, 'info_icon'),
        text: fieldValue(card, 'info_text'),
      }))
      .filter(r => r.icon || r.text);

    const blankText = info.find(r => !r.text);
    if (blankText) { toast('Every info chip needs text', 'err'); return; }

    const actions = [...document.querySelectorAll('#action-list .dynamic-card')]
      .map(card => ({
        label: fieldValue(card, 'action_label'),
        icon: fieldValue(card, 'action_icon'),
        url: fieldValue(card, 'action_url'),
        cssClass: fieldValue(card, 'action_class'),
      }))
      .filter(r => r.label || r.icon || r.url);

    const incomplete = actions.find(r => !r.label || !r.url);
    if (incomplete) {
      toast(`"${incomplete.label || 'Untitled button'}" needs both a label and a URL`, 'err');
      return;
    }

    const headerRows = [
      ...info.map((r, i) => ({
        ...BLANK, row_uid: uid('settings', 'info', String(i)), section: 'settings',
        row_index: i, type: 'info_item', b: r.icon, c: r.text,
      })),
      ...actions.map((r, i) => ({
        ...BLANK, row_uid: uid('settings', 'action', String(i)), section: 'settings',
        row_index: i, type: 'action_button', b: r.label, c: r.icon, d: r.url, e: r.cssClass,
      })),
    ];

    await withSaveButton(btn, async () => {
      try {
        await replaceRows(r => r.type === 'setting', settingRows);
        await replaceRows(r => r.type === 'info_item' || r.type === 'action_button', headerRows);
        clearDirty();
        toast('Settings saved', 'ok');
      } catch (err) {
        toast('Save failed: ' + err.message, 'err');
      }
    });
  }


  /* === TAB 1: CATEGORIES (clean cards with streamlined entry rows) ========= */

  function renderCategories() {
    const cats = rowsOfType('category');
    return `
      <div class="section-topbar">
        <div class="add-bar">
          <button class="btn-sm btn-secondary" type="button" id="add-category-btn"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Category</button>
        </div>
        <button class="btn-sm btn-save-section" id="section-save-btn"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      </div>
      <div class="settings-panel">
        <div class="form-hint" style="margin-bottom:12px">Drag a category by its handle to reorder the public tabs; drag an entry to reorder its buttons.</div>
        <div id="category-list">
          ${cats.map(r => categoryBlockHtml(r.b, r.c, r.d)).join('') ||
      '<div class="form-hint" id="no-cat-msg" style="padding:4px 0">No categories yet.</div>'}
        </div>
      </div>`;
  }

  function categoryBlockHtml(name = '', icon = '', kind = 'timetable') {
    const isLecturer = kind === 'lecturer';
    const entries = name ? rowsInSection(name, isLecturer ? 'lecturer' : 'entry') : [];
    const allHidden = entries.length > 0 && entries.every(r => r.e === '1');
    return `<div class="category-card" data-original="${x(name)}">
      <div class="category-card-head" data-collapse-toggle="1">
        <div class="category-card-title-group">
          <i class="fa-solid fa-grip-vertical cat-drag-handle" title="Drag to reorder category"></i>
          <i class="category-head-icon ${x(icon || 'fa-solid fa-layer-group')}"></i>
          <span class="category-head-title">${x(name || 'New Category')}</span>
          <span class="badge category-count-badge">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
          <span class="badge category-kind-badge">${isLecturer ? 'Lecturers' : 'Class Timetables'}</span>
          ${allHidden ? '<span class="badge category-hidden-badge"><i class="fa-solid fa-eye-slash" style="margin-right:4px"></i>Hidden</span>' : ''}
        </div>
        <div class="category-card-actions">
          <button class="btn-action-vis" type="button" data-toggle-cat-vis="1" title="${allHidden ? 'Show all entries in this category' : 'Hide all entries in this category'}"><i class="fa-solid ${allHidden ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
          <button class="btn-action-del" type="button" data-remove="1" title="Delete category"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <div class="category-card-body-wrap">
        <div class="category-card-body">
          <div class="category-config-row">
            <div class="form-group">
              <label class="form-label">Category Name</label>
              <input type="text" name="cat_name" value="${x(name)}" placeholder="e.g. Civil Engineering Year 1" data-label-source="New Category">
            </div>
            <div class="form-group">
              <label class="form-label">Tab Icon</label>
              ${iconInputHtml('cat_icon', icon)}
            </div>
            <div class="form-group">
              <label class="form-label">Type</label>
              <select name="cat_kind">
                <option value="timetable"${isLecturer ? '' : ' selected'}>Class Timetables</option>
                <option value="lecturer"${isLecturer ? ' selected' : ''}>Lecturers</option>
              </select>
            </div>
          </div>
          <div class="category-entries-section">
            <div class="entries-section-header">
              <div class="entries-section-title">
                <i class="fa-solid fa-list-ul"></i>
                <span>Entries</span>
              </div>
              <div class="entries-header-actions" style="display:flex;align-items:center;gap:6px">
                <button class="btn-sm btn-secondary" type="button" data-sort-cat-entries="1" title="Sort entries by code, or lecturers by title then name">
                  <i class="fa-solid fa-arrow-down-a-z" style="margin-right:5px"></i><span>Sort</span>
                </button>
                <button class="btn-sm btn-secondary" type="button" data-toggle-cat-vis="1" title="${allHidden ? 'Show all entries' : 'Hide all entries'}">
                  <i class="fa-solid ${allHidden ? 'fa-eye' : 'fa-eye-slash'}" style="margin-right:5px"></i><span>${allHidden ? 'Show All' : 'Hide All'}</span>
                </button>
                <button class="btn-sm btn-secondary" type="button" data-add-entry="1"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Entry</button>
              </div>
            </div>
            <div class="entries-table-header ${isLecturer ? 'kind-lecturer' : 'kind-timetable'}">
              <span class="col-handle"></span>
              <span class="col-label">Label / Name</span>
              ${isLecturer
        ? '<span class="col-id">Lecturer ID</span>'
        : '<span class="col-id">Timetable ID</span><span class="col-id">Class ID</span>'}
              <span class="col-actions" style="text-align:right">Actions</span>
            </div>
            <div class="entry-list" data-kind="${isLecturer ? 'lecturer' : 'entry'}">
              ${entries.map(r => entryRowHtml(isLecturer, r.b, r.c, r.d, r.e === '1')).join('') ||
      '<div class="entry-list-empty"><i class="fa-regular fa-folder-open"></i><span>No entries yet. Click "Add Entry" to create one.</span></div>'}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function entryRowHtml(isLecturer, label = '', first = '', second = '', hidden = false) {
    const fields = isLecturer
      ? `<div class="entry-cell entry-cell-id">
           <input type="text" name="entry_first" value="${x(first)}" placeholder="e.g. b3M3VlBz…">
         </div>`
      : `<div class="entry-cell entry-cell-id">
           <input type="text" name="entry_first" value="${x(first)}" inputmode="numeric" placeholder="e.g. 42">
         </div>
         <div class="entry-cell entry-cell-id">
           <input type="text" name="entry_second" value="${x(second)}" inputmode="numeric" placeholder="e.g. 118">
         </div>`;

    return `<div class="entry-row${hidden ? ' is-hidden' : ''}" data-hidden="${hidden ? 'true' : 'false'}">
      <div class="entry-cell entry-cell-handle">
        <i class="fa-solid fa-grip-vertical drag-handle" title="Drag to reorder entry"></i>
      </div>
      <div class="entry-cell entry-cell-label">
        <input type="text" name="entry_label" value="${x(label)}" placeholder="e.g. ${isLecturer ? 'Prof. Name' : 'Section / Group'}" data-label-source="New Entry">
      </div>
      ${fields}
      <div class="entry-cell entry-cell-actions">
        ${isLecturer ? '' : '<button class="btn-action-test" type="button" data-test="1" title="Test timetable preview in modal"><i class="fa-solid fa-flask"></i></button>'}
        ${hideToggleHtml(hidden)}
        <button class="btn-action-del" type="button" data-remove="1" title="Delete entry"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
  }

  function hideToggleHtml(hidden) {
    return `<button class="btn-action-vis" type="button" data-toggle-hidden="1"
              title="${hidden ? 'Hidden from public page — click to show' : 'Visible on public page — click to hide'}">
              <i class="fa-solid ${hidden ? 'fa-eye-slash' : 'fa-eye'}"></i>
            </button>`;
  }

  function updateCategoryHeaderState(catCard) {
    if (!catCard) return;
    const rows = [...catCard.querySelectorAll('.entry-list > .entry-row')];
    const total = rows.length;
    const allHidden = total > 0 && rows.every(r => r.dataset.hidden === 'true');

    // Update count badge
    const countBadge = catCard.querySelector('.category-count-badge');
    if (countBadge) countBadge.textContent = `${total} ${total === 1 ? 'entry' : 'entries'}`;

    // Update hidden badge in title group
    let hiddenBadge = catCard.querySelector('.category-hidden-badge');
    if (allHidden) {
      if (!hiddenBadge) {
        const titleGroup = catCard.querySelector('.category-card-title-group');
        if (titleGroup) {
          titleGroup.insertAdjacentHTML('beforeend', '<span class="badge category-hidden-badge"><i class="fa-solid fa-eye-slash" style="margin-right:4px"></i>Hidden</span>');
        }
      }
    } else if (hiddenBadge) {
      hiddenBadge.remove();
    }

    // Update the icon button in category card actions
    const headVisBtn = catCard.querySelector('.category-card-actions [data-toggle-cat-vis]');
    if (headVisBtn) {
      headVisBtn.title = allHidden ? 'Show all entries in this category' : 'Hide all entries in this category';
      headVisBtn.innerHTML = `<i class="fa-solid ${allHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    }

    // Update the button in entries section header
    const entriesVisBtn = catCard.querySelector('.entries-header-actions [data-toggle-cat-vis]');
    if (entriesVisBtn) {
      entriesVisBtn.title = allHidden ? 'Show all entries' : 'Hide all entries';
      entriesVisBtn.innerHTML = `<i class="fa-solid ${allHidden ? 'fa-eye' : 'fa-eye-slash'}" style="margin-right:5px"></i><span>${allHidden ? 'Show All' : 'Hide All'}</span>`;
    }
  }

  async function saveCategoriesTab(btn) {
    const catCards = [...document.querySelectorAll('#category-list > .category-card')];
    const cats = catCards.map(card => ({
      name: fieldValue(card, 'cat_name'),
      icon: fieldValue(card, 'cat_icon'),
      kind: fieldValue(card, 'cat_kind') === 'lecturer' ? 'lecturer' : 'timetable',
      card,
    })).filter(c => c.name);

    const names = cats.map(c => c.name);
    if (new Set(names).size !== names.length) {
      toast('Category names must be unique', 'err');
      return;
    }
    if (new Set(names.map(slug)).size !== names.length) {
      toast('Category names must differ by more than punctuation', 'err');
      return;
    }

    const entryRows = [];
    for (const cat of cats) {
      const list = cat.card.querySelector('.entry-list');
      const isLecturer = cat.kind === 'lecturer';
      const items = [...list.querySelectorAll(':scope > .entry-row')].map(row => ({
        label: fieldValue(row, 'entry_label'),
        first: fieldValue(row, 'entry_first'),
        second: fieldValue(row, 'entry_second'),
        hidden: row.dataset.hidden === 'true',
      })).filter(e => e.label || e.first || e.second);

      const bad = isLecturer
        ? items.find(e => !e.first)
        : items.find(e => !/^\d+$/.test(e.first) || !/^\d+$/.test(e.second));
      if (bad) {
        toast(isLecturer
          ? `"${bad.label || 'Untitled'}" in ${cat.name} needs a Lecturer ID`
          : `"${bad.label || 'Untitled'}" in ${cat.name} needs numeric IDs`, 'err');
        return;
      }
      const labels = items.map(e => e.label);
      if (new Set(labels).size !== labels.length) {
        toast(`Entry labels must be unique within ${cat.name}`, 'err');
        return;
      }

      items.forEach((item, i) => entryRows.push({
        ...BLANK,
        row_uid: entryUid(cat.name, i),
        section: cat.name,
        row_index: i,
        type: isLecturer ? 'lecturer' : 'entry',
        b: item.label, c: item.first, d: isLecturer ? '' : item.second,
        e: item.hidden ? '1' : '',
      }));
    }

    const categoryRows = cats.map((c, i) => ({
      ...BLANK,
      row_uid: uid('settings', 'cat', c.name),
      section: 'settings',
      row_index: i,
      type: 'category',
      b: c.name, c: c.icon, d: c.kind,
    }));

    await withSaveButton(btn, async () => {
      try {
        await replaceRows(row => row.type === 'category', categoryRows);
        await replaceRows(row => row.type === 'entry' || row.type === 'lecturer', entryRows);
        clearDirty();
        toast('Categories saved', 'ok');
        selectSection('categories');   // re-render so data-original tracks the new names
      } catch (err) {
        toast('Save failed: ' + err.message, 'err');
      }
    });
  }

  // Fetches and renders a class timetable in the modal
  async function testEntry(card) {
    const label = fieldValue(card, 'entry_label') || 'Entry';
    const tId = fieldValue(card, 'entry_first');
    const cId = fieldValue(card, 'entry_second');

    if (!/^\d+$/.test(tId) || !/^\d+$/.test(cId)) {
      toast('Both IDs must be numbers before testing', 'err');
      return;
    }

    document.getElementById('modal-title').textContent = `Preview — ${label}`;
    document.getElementById('modal-body').innerHTML =
      `<div class="table-container visible" id="test-container" style="display:grid">
         <div class="tt-inner"><div class="iframe-loader"></div></div>
       </div>`;
    document.getElementById('modal-overlay').classList.add('open');

    const container = document.getElementById('test-container');
    const inner = container.querySelector('.tt-inner');

    try {
      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/eis-timetable?tId=${encodeURIComponent(tId)}&cId=${encodeURIComponent(cId)}`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      if (!document.body.contains(inner)) return;

      if (!html.includes('<table')) {
        inner.innerHTML = '<div class="tt-error">No timetable found for these IDs — double-check them in EIS.</div>';
        return;
      }
      inner.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
      fitTimetable(container);
    } catch (err) {
      if (!document.body.contains(inner)) return;
      inner.innerHTML = `<div class="tt-error">Could not reach the timetable service (${x(err.message)}).</div>`;
    }
  }


  /* === CATEGORY COLLAPSE STATE ============================================
     Collapsed categories are tracked in localStorage so the state survives
     page reloads. Keys are the category's data-original (name at last save).
     Default is all expanded (empty set).
     ====================================================================== */

  const COLLAPSE_KEY = 'tt-admin-collapsed';

  function getCollapsedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
    catch { return new Set(); }
  }

  function saveCollapsedSet(set) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { }
  }

  function toggleCategoryCollapse(catCard) {
    if (!catCard) return;
    const isCollapsed = catCard.classList.toggle('is-collapsed');
    const key = catCard.dataset.original || fieldValue(catCard, 'cat_name');
    if (key) {
      const set = getCollapsedSet();
      isCollapsed ? set.add(key) : set.delete(key);
      saveCollapsedSet(set);
    }
  }

  function restoreCollapseState() {
    const collapsed = getCollapsedSet();
    if (!collapsed.size) return;
    document.querySelectorAll('#category-list > .category-card').forEach(card => {
      const key = card.dataset.original;
      if (key && collapsed.has(key)) card.classList.add('is-collapsed');
    });
  }


  /* === SECTION WIRING ===================================================== */

  const sectionBody = document.getElementById('section-body');

  // Live card-title updates, icon previews, and the semester preview.
  sectionBody.addEventListener('input', e => {
    const t = e.target;
    if (t.name === 'cat_name') {
      const titleEl = t.closest('.category-card')?.querySelector('.category-head-title');
      if (titleEl) titleEl.textContent = t.value.trim() || t.dataset?.labelSource || 'New Category';
    }
    if (t.name === 'cat_icon' || (t.classList?.contains('icon-field') && t.name === 'cat_icon')) {
      const cardIcon = t.closest('.category-card')?.querySelector('.category-head-icon');
      if (cardIcon) cardIcon.className = 'category-head-icon ' + (t.value.trim() || 'fa-solid fa-layer-group');
    }
    if (t.dataset?.labelSource && t.closest('.dynamic-card')) {
      const lbl = t.closest('.dynamic-card')?.querySelector('.dcl-text');
      if (lbl) lbl.textContent = t.value.trim() || t.dataset.labelSource;
    }
    if (t.classList?.contains('icon-field')) {
      const preview = t.parentElement.querySelector('.icon-preview-el');
      if (preview) preview.className = 'icon-preview-el ' + (t.value.trim() || 'fa-solid fa-question');
    }
    if (S.section === 'settings') updateSemesterPreview();
  });

  // Kind switching
  sectionBody.addEventListener('change', e => {
    const t = e.target;
    if (t.name === 'cat_kind') {
      const catCard = t.closest('.category-card');
      if (!catCard) return;
      const isLecturer = t.value === 'lecturer';
      const kindBadge = catCard.querySelector('.category-kind-badge');
      if (kindBadge) kindBadge.textContent = isLecturer ? 'Lecturers' : 'Class Timetables';

      const header = catCard.querySelector('.entries-table-header');
      if (header) {
        header.className = `entries-table-header ${isLecturer ? 'kind-lecturer' : 'kind-timetable'}`;
        header.innerHTML = `
          <span class="col-handle"></span>
          <span class="col-label">Label / Name</span>
          ${isLecturer
            ? '<span class="col-id">Lecturer ID</span>'
            : '<span class="col-id">Timetable ID</span><span class="col-id">Class ID</span>'}
          <span class="col-actions" style="text-align:right">Actions</span>
        `;
      }

      const list = catCard.querySelector('.entry-list');
      if (list) {
        list.dataset.kind = isLecturer ? 'lecturer' : 'entry';
        const rows = [...list.querySelectorAll(':scope > .entry-row')];
        rows.forEach(row => {
          const label = fieldValue(row, 'entry_label');
          const first = fieldValue(row, 'entry_first');
          const second = fieldValue(row, 'entry_second');
          const hidden = row.dataset.hidden === 'true';
          row.outerHTML = entryRowHtml(isLecturer, label, first, second, hidden);
        });
        initSortable(list, '.drag-handle');
      }
      updateCategoryHeaderState(catCard);
      markDirty();
    }
  });

  // Delete / hide-toggle / Test / per-category Add Entry
  sectionBody.addEventListener('click', async e => {
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      const catCard = removeBtn.closest('.category-card');
      const entryRow = removeBtn.closest('.entry-row');
      const dynamicCard = removeBtn.closest('.dynamic-card');

      if (entryRow) {
        const name = entryRow.querySelector('[name="entry_label"]')?.value || 'this entry';
        if (await confirmDialog(`Remove "${name}"? It will be deleted from the site when you save.`, { title: 'Remove Entry', okLabel: 'Remove', danger: true, okIcon: 'fa-trash' })) {
          const list = entryRow.closest('.entry-list');
          entryRow.remove();
          if (list && !list.querySelector('.entry-row')) {
            list.innerHTML = '<div class="entry-list-empty"><i class="fa-regular fa-folder-open"></i><span>No entries yet. Click "Add Entry" to create one.</span></div>';
          }
          if (catCard) updateCategoryHeaderState(catCard);
          markDirty();
        }
        return;
      }

      if (catCard && !entryRow) {
        const name = catCard.querySelector('.category-head-title')?.textContent || 'this category';
        const entryCount = catCard.querySelectorAll('.entry-list > .entry-row').length;
        const message = entryCount
          ? `Remove ${name}? Its ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'} will be removed too when you save.`
          : `Remove ${name}? It will be deleted from the site when you save.`;
        if (await confirmDialog(message, { title: 'Remove Category', okLabel: 'Remove', danger: true, okIcon: 'fa-trash' })) {
          catCard.remove();
          markDirty();
        }
        return;
      }

      if (dynamicCard) {
        const name = dynamicCard.querySelector('.dcl-text')?.textContent || 'this item';
        if (await confirmDialog(`Remove ${name}? It will be deleted from the site when you save.`, { title: 'Remove', okLabel: 'Remove', danger: true, okIcon: 'fa-trash' })) {
          dynamicCard.remove();
          markDirty();
        }
        return;
      }
    }

    const sortCatBtn = e.target.closest('[data-sort-cat-entries]');
    if (sortCatBtn) {
      const catCard = sortCatBtn.closest('.category-card');
      const list = catCard?.querySelector('.entry-list');
      if (!list) return;
      const rows = [...list.querySelectorAll(':scope > .entry-row')];
      if (rows.length <= 1) return;

      // Lecturers by title (Prof., Assoc. Prof., Dr., …) then name, as everywhere else.
      const lecturers = catCard.querySelector('[name="cat_kind"]')?.value === 'lecturer';
      rows.sort((a, b) => {
        const aLabel = fieldValue(a, 'entry_label');
        const bLabel = fieldValue(b, 'entry_label');
        return lecturers ? TeachingSites.compareLecturers(aLabel, bLabel) : compareCourseLabels(aLabel, bLabel);
      });

      rows.forEach(row => list.appendChild(row));
      markDirty();
      toast('Entries sorted', 'ok');
      return;
    }

    const toggleCatVisBtn = e.target.closest('[data-toggle-cat-vis]');
    if (toggleCatVisBtn) {
      const catCard = toggleCatVisBtn.closest('.category-card');
      if (!catCard) return;
      const rows = [...catCard.querySelectorAll('.entry-list > .entry-row')];
      if (!rows.length) return;

      const currentlyAllHidden = rows.every(r => r.dataset.hidden === 'true');
      const setHidden = !currentlyAllHidden;

      rows.forEach(r => {
        r.dataset.hidden = String(setHidden);
        r.classList.toggle('is-hidden', setHidden);
        const visBtn = r.querySelector('[data-toggle-hidden]');
        if (visBtn) visBtn.outerHTML = hideToggleHtml(setHidden);
      });

      updateCategoryHeaderState(catCard);
      markDirty();
      return;
    }

    const toggleBtn = e.target.closest('[data-toggle-hidden]');
    if (toggleBtn) {
      const row = toggleBtn.closest('.entry-row, .dynamic-card');
      if (!row) return;
      const hidden = row.dataset.hidden !== 'true';
      row.dataset.hidden = String(hidden);
      row.classList.toggle('is-hidden', hidden);
      toggleBtn.outerHTML = hideToggleHtml(hidden);
      const catCard = row.closest('.category-card');
      if (catCard) updateCategoryHeaderState(catCard);
      markDirty();
      return;
    }

    const addEntryBtn = e.target.closest('[data-add-entry]');
    if (addEntryBtn) {
      const catCard = addEntryBtn.closest('.category-card');
      const list = catCard?.querySelector('.entry-list');
      if (!list) return;
      list.querySelector('.entry-list-empty')?.remove();
      list.insertAdjacentHTML('beforeend', entryRowHtml(list.dataset.kind === 'lecturer'));
      updateCategoryHeaderState(catCard);
      markDirty();
      initSortable(list, '.drag-handle');
      list.lastElementChild?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Clicking the card header (but not the drag handle, delete button, or visibility toggle)
    // toggles collapse.
    const collapseHead = e.target.closest('[data-collapse-toggle]');
    if (collapseHead && !e.target.closest('.cat-drag-handle') && !e.target.closest('[data-remove]') && !e.target.closest('[data-toggle-cat-vis]')) {
      toggleCategoryCollapse(collapseHead.closest('.category-card'));
      return;
    }

    const testBtn = e.target.closest('[data-test]');
    if (testBtn) {
      testEntry(testBtn.closest('.entry-row, .dynamic-card'));
    }
  });

  // Per-render wiring only
  function wireSection(id) {
    const saveBtn = document.getElementById('section-save-btn');
    if (saveBtn) {
      const savers = {
        settings: saveSettings, categories: saveCategoriesTab,
      };
      saveBtn.addEventListener('click', () => trackSave(savers[id](saveBtn)));
    }

    if (id === 'settings') {
      updateSemesterPreview();
      wireAdd('add-info-btn', 'info-list', 'no-info-msg', () => infoCardHtml());
      wireAdd('add-action-btn', 'action-list', 'no-action-msg', () => actionCardHtml());
      initDnD('info-list');
      initDnD('action-list');
    }

    if (id === 'categories') {
      wireAdd('add-category-btn', 'category-list', 'no-cat-msg', () => categoryBlockHtml(), '.cat-drag-handle');
      initDnD('category-list', '.cat-drag-handle');
      document.querySelectorAll('.entry-list').forEach(list => initSortable(list, '.drag-handle'));
      restoreCollapseState();
    }
  }

  function wireAdd(buttonId, listId, emptyMsgId, html, handle = '.drag-handle') {
    const btn = document.getElementById(buttonId);
    const list = document.getElementById(listId);
    if (!btn || !list) return;
    btn.addEventListener('click', () => {
      document.getElementById(emptyMsgId)?.remove();
      list.insertAdjacentHTML('beforeend', html());
      // Bookkeeping before the cosmetic scroll: if scrolling ever throws, the
      // card must still be registered as an unsaved change and be draggable.
      markDirty();
      initDnD(listId, handle);
      // A freshly added category starts with its own (empty) entry list,
      // which needs its own Sortable instance too.
      document.querySelectorAll('.entry-list').forEach(l => initSortable(l, '.drag-handle'));
      // The new card lands below the fold on a long list.
      list.lastElementChild?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    });
  }

  const DND_OPTS = {
    animation: 180,
    ghostClass: 'dnd-ghost',
    chosenClass: 'dnd-chosen',
    forceFallback: true,
    delay: 250,
    delayOnTouchOnly: true,
    touchStartThreshold: 5,
    onEnd: () => markDirty(),   // a reorder is an unsaved change
  };

  // Order is never persisted on drop — each tab's Save reads the final DOM
  // order. Idempotent (checked via Sortable.get), so it's safe to call again
  // after every add rather than tracking which lists already have one.
  function initSortable(el, handle) {
    if (!el || !window.Sortable || Sortable.get(el)) return;
    Sortable.create(el, { ...DND_OPTS, handle });
  }

  function initDnD(listId, handle = '.drag-handle') {
    initSortable(document.getElementById(listId), handle);
  }


  /* === SHARED WIDGETS ===================================================== */

  function iconInputHtml(name, value) {
    return `<div class="icon-input-wrap">
      <input type="text" class="icon-field" name="${name}" value="${x(value)}" placeholder="fa-solid fa-calendar">
      <i class="icon-preview-el ${x(value || 'fa-solid fa-question')}" style="font-size:1.5em;color:var(--primary-color);width:30px;text-align:center;flex-shrink:0"></i>
      <a class="icon-find-link" href="${FA_SEARCH_URL}" target="_blank" rel="noopener noreferrer" title="Find an icon on Font Awesome"><i class="fa-solid fa-magnifying-glass"></i></a>
    </div>`;
  }

  function fieldValue(card, name) {
    return card.querySelector(`[name="${name}"]`)?.value.trim() || '';
  }


  /* === MODAL / CONFIRM / TOAST ============================================ */

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
    document.getElementById('modal-body').innerHTML = '';
  }

  // Resolves true (OK) or false (Cancel / backdrop / Escape).
  function confirmDialog(message, opts = {}) {
    const { title = 'Please Confirm', okLabel = 'Confirm', danger = false, okIcon = 'fa-check' } = opts;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = message;

    const okBtn = document.getElementById('confirm-ok-btn');
    okBtn.className = 'btn-sm' + (danger ? ' btn-red' : '');
    okBtn.innerHTML = `<i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${x(okLabel)}`;

    if (_confirmResolve) _resolveConfirm(false);   // supersede an open dialog
    document.getElementById('confirm-overlay').classList.add('open');
    return new Promise(resolve => { _confirmResolve = resolve; });
  }

  function _resolveConfirm(val) {
    document.getElementById('confirm-overlay').classList.remove('open');
    const resolve = _confirmResolve;
    _confirmResolve = null;
    if (resolve) resolve(val);
  }

  function toast(msg, type) {
    const el = document.getElementById('toast');
    const icon = type === 'ok' ? 'fa-circle-check' : type === 'err' ? 'fa-circle-exclamation' : 'fa-circle-info';
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${x(msg)}</span>`;
    el.className = 'toast show' + (type ? ' ' + type : '');
    // Errors linger so the reason is actually readable before it fades.
    clearTimeout(_tt);
    _tt = setTimeout(() => el.classList.remove('show'), type === 'err' ? 6000 : 3000);
  }

  function x(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Escape dismisses the topmost layer; Ctrl/Cmd+S saves the open tab rather
  // than triggering the browser's Save Page.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('confirm-overlay').classList.contains('open')) { _resolveConfirm(false); return; }
      if (document.getElementById('modal-overlay').classList.contains('open')) { closeModal(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      const btn = document.getElementById('section-save-btn');
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    }
  });


  /* === PAGE CHROME ======================================================== */

  applyThemeDefaults();
  applyOwnerBranding();
  setupThemeToggle();

  // The markup calls these from inline handlers, so they need to be reachable
  // from outside this IIFE. (_overlayMD / _confirmOverlayMD are set and read
  // entirely within those inline handlers, so they stay plain window globals
  // and need nothing here.)
  window.signIn = signIn;
  window.signOut = signOut;
  window.closeModal = closeModal;
  window._resolveConfirm = _resolveConfirm;
})();
