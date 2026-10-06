// Course editor: sign-in, permissions, section forms and saves.
const SUPABASE_URL = window.TEACHING_CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = window.TEACHING_CONFIG.supabaseAnonKey;
const { createClient } = supabase;
const EMBEDDED_ADMIN_SITE = window.TEACHING_EMBEDDED_ADMIN ? window.TEACHING_SITE : null;
const ADMIN_RETURN_URL = EMBEDDED_ADMIN_SITE ? TeachingSites.adminUrl(EMBEDDED_ADMIN_SITE) :
  window.location.origin + window.location.pathname;
const AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}${EMBEDDED_ADMIN_SITE ? '-teaching-' + EMBEDDED_ADMIN_SITE.id : ''}-auth-token`;
// Before createClient, drop only unusable session blobs (corrupt JSON or no refresh_token).
// An expired access_token is normal: the refresh_token renews it.
(function () {
  try {
    const d = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY));
    if (!d?.access_token || !d?.refresh_token) localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { }
  }
})();
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: EMBEDDED_ADMIN_SITE ? 'pkce' : 'implicit', storageKey: AUTH_STORAGE_KEY,
    detectSessionInUrl: true, persistSession: true
  }
});

const S = { course: null, isArchive: false, section: 'info', admin: null, access: null };
const ROW_STORE = Object.create(null);
const COURSE_HEADERS = new Map();
let _sessionHandled = false;
let _overlayMD = false;

// ── Unsaved-changes tracking ──
// True once the current tab has an unsaved change; reset when a section loads or saves.
let _sectionDirty = false;
let _sectionBaseline = null;
function markDirty() { if (canEditSection(S.section)) _sectionDirty = true; }
// Typing in the section body counts as an edit (delegated, so it survives re-renders).
// Controls inside [data-no-dirty] (searches, switches that save at once) are not drafts.
const isDraftField = el => el.closest && el.closest('#section-body') && !el.closest('[data-no-dirty]');
document.addEventListener('input', e => { if (isDraftField(e.target)) markDirty(); });
document.addEventListener('change', e => { if (isDraftField(e.target)) markDirty(); });

// Compare values and staged row order, not event timing: a field can fire change on blur
// after Ctrl/Cmd+S has already saved its value. Inline drafts have their own snapshot.
function sectionSnapshot() {
  const body = document.getElementById('section-body');
  if (!body || !S.course) return null;
  const fields = [...body.querySelectorAll('input, select, textarea')]
    .filter(el => !el.closest('.inline-edit-panel, [data-no-dirty]'))
    .map(el => [el.id, el.name, el.dataset.metakey || el.dataset.key || el.dataset.donekey || '',
    el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value]);
  const rows = [...body.querySelectorAll('[data-uid]')]
    .map(el => [el.dataset.uid, ROW_STORE[el.dataset.uid]]);
  return JSON.stringify([S.course, S.isArchive, S.section, fields, rows]);
}

function rememberSavedSection() {
  _sectionBaseline = sectionSnapshot();
  _sectionDirty = false;
}

function hasSectionChanges() {
  if (!S.course || !canEditSection(S.section)) return false;
  return _sectionBaseline === null ? _sectionDirty : sectionSnapshot() !== _sectionBaseline;
}

// Start the save here so repeated clicks/shortcuts share one operation. Navigation waits
// for it, and the section cannot acquire another draft while its saved content reloads.
let _savePromise = null;
function trackSave(save) {
  if (_savePromise) return _savePromise;
  const body = document.getElementById('section-body');
  const wasInert = body?.inert;
  const busy = body?.getAttribute('aria-busy');
  const button = document.getElementById('section-save-btn');
  const buttonHtml = button?.innerHTML, buttonDisabled = button?.disabled;
  if (body) {
    if (body.contains(document.activeElement)) document.activeElement.blur();
    body.inert = true;
    body.setAttribute('aria-busy', 'true');
  }
  const promise = Promise.resolve().then(save).catch(error => {
    toast('Save failed: ' + (error.message || 'Try again.'), 'err');
    return false;
  }).finally(() => {
    if (body?.isConnected) {
      body.inert = wasInert;
      if (busy === null) body.removeAttribute('aria-busy'); else body.setAttribute('aria-busy', busy);
    }
    if (button?.isConnected) { button.innerHTML = buttonHtml; button.disabled = buttonDisabled; }
    if (_savePromise === promise) _savePromise = null;
  });
  _savePromise = promise;
  return promise;
}
// Leaving the page can only use the browser's own prompt; in-app switches use confirmLeaveIfDirty.
window.addEventListener('beforeunload', e => {
  if (hasSectionChanges() || (typeof accessSettingsDirty === 'function' && accessSettingsDirty()) || (typeof inlinePanelDirty === 'function' && inlinePanelDirty())) { e.preventDefault(); e.returnValue = ''; }
});

// These checks drive the UI only. Every write is checked again in Supabase; removing
// disabled attributes or changing S in developer tools cannot grant database access.
function isCourseAdmin() { return ['global_admin', 'admin'].includes(S.access?.role); }
// Assignments grant Lecturers and Students access. For Admins, who can edit every
// course, they are only a personal list: the sidebar's "Mine" and the public catalog.
function isAssignedCourse(name, archive) {
  return !!S.access?.assignments?.some(a => a.sheet_name === name && a.is_archive === archive);
}
function hasCourseAccess(name = S.course, archive = S.isArchive) {
  return isCourseAdmin() || isAssignedCourse(name, archive);
}
function canEditSection(id, name = S.course, archive = S.isArchive) {
  return hasCourseAccess(name, archive) && (isCourseAdmin() || S.access?.role === 'lecturer' ||
    (S.access?.role === 'student' && ['modules', 'projects', 'announce', 'exams'].includes(id)));
}
function canArchiveCourse(name = S.course, archive = S.isArchive) {
  return isCourseAdmin() || (!archive && S.access?.role === 'lecturer' && hasCourseAccess(name, archive));
}
function ownsProfessor(key) {
  return isCourseAdmin() || (S.access?.role === 'lecturer' && hasCourseAccess() &&
    !!S.access?.professor_keys?.some(p => p.sheet_name === S.course && p.is_archive === S.isArchive && p.key === key));
}
const PROTECTED_META_KEYS = new Set(['code', 'title', 'year', 'semester', 'level', 'type', 'credits',
  'startdate', 'enddate', 'holidayweeks', 'holiday_startdate', 'holiday_start_date', 'holidaystartdate', 'holiday_start']);
// A metadata key as Supabase compares them: "Header Decoration" is header_decoration.
function metaKeyOf(key) { return String(key || '').trim().toLowerCase().replace(/\s+/g, '_'); }
function canEditMetadata(key) {
  if (!canEditSection('info')) return false;
  if (isCourseAdmin()) return true;
  const k = metaKeyOf(key);
  if (PROTECTED_META_KEYS.has(k)) return false;
  if (k.startsWith('professor')) return /^professor[1-9]\d*(_link|_photo)?$/.test(k) && ownsProfessor(k.replace(/_(link|photo)$/, ''));
  return true;
}
function requirePermission(allowed) {
  if (!allowed) toast('You do not have permission to make this change.', 'err');
  return allowed;
}
async function refreshTeachingAccess() {
  const { data, error } = await sb.rpc('teaching_access');
  if (error) throw error;
  S.access = data;
  S.admin = data;
  renderAccessControls();
  return data;
}
async function saveCourseRows(rows = [], deleteUids = []) {
  try {
    return await sb.rpc('teaching_save_rows', { p_upserts: Array.isArray(rows) ? rows : [rows], p_delete_uids: deleteUids });
  } catch (error) { return { error }; }
}
function lockPermissionArea(el) {
  if (!el) return;
  el.classList.add('permission-locked');
  el.setAttribute('aria-disabled', 'true');
  el.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = true; });
  el.querySelectorAll('a, [draggable]').forEach(control => {
    control.setAttribute('tabindex', '-1');
    control.setAttribute('aria-disabled', 'true');
    control.removeAttribute('href');
    control.removeAttribute('onclick');
    control.setAttribute('draggable', 'false');
  });
}
function applySectionPermissions(body) {
  // The same section container is reused when switching tabs.
  body.classList.remove('permission-locked');
  body.removeAttribute('aria-disabled');
  if (!canEditSection(S.section)) {
    lockPermissionArea(body);
    body.insertAdjacentHTML('afterbegin', '<p class="permission-note"><i class="fa-solid fa-lock"></i> View only — your role cannot edit this tab.</p>');
    return;
  }
  if (S.section !== 'info' || isCourseAdmin()) return;
  body.querySelectorAll('.meta-field').forEach(inp => {
    if (!canEditMetadata(inp.dataset.metakey)) lockPermissionArea(inp.closest('.settings-group') || inp.closest('.form-group'));
  });
  body.querySelectorAll('[data-custom-key]').forEach(card => {
    if (!canEditMetadata(card.dataset.customKey)) lockPermissionArea(card);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

// Grading categories, in display order. `multi` ones have numbered entries (Homework 1, 2, …).
// `legacyKey` reads older un-numbered keys, renamed to `${id}${n}_percentage` on the next save.
const GRADING_CATEGORIES = [
  { id: 'hw', label: 'Homework', icon: 'fa-solid fa-book', multi: true },
  { id: 'project', label: 'Project', icon: 'fa-solid fa-diagram-project', multi: true, legacyKey: 'term_project_percentage' },
  { id: 'casestudy', label: 'Case Study', icon: 'fa-solid fa-magnifying-glass-chart', multi: true },
  { id: 'lab', label: 'Laboratory', icon: 'fa-solid fa-flask', multi: true },
  { id: 'quiz', label: 'Quiz', icon: 'fa-solid fa-question', multi: true },
  { id: 'midterm', label: 'Midterm', icon: 'fa-solid fa-pen-to-square', multi: true, legacyKey: 'midterm_percentage' },
  { id: 'final', label: 'Final', icon: 'fa-solid fa-graduation-cap', multi: false, key: 'final_percentage' },
  { id: 'attendance', label: 'Attendance', icon: 'fa-solid fa-calendar-check', multi: false, key: 'attendance_percentage' },
  { id: 'other', label: 'Other', icon: 'fa-solid fa-ellipsis', multi: true },
];
const GRADING_LEGACY_KEYS = GRADING_CATEGORIES.filter(c => c.legacyKey).map(c => c.legacyKey);
const GRADING_FIXED_KEYS = GRADING_CATEGORIES.filter(c => !c.multi).map(c => c.key);

// The five slots of the theme_colours metadata, in order, and the site-wide defaults used
// when a course sets none (must match js/course-page.js's fallback palette).
const THEME_COLOR_NAMES = ['Primary', 'Secondary', 'Tertiary', 'Accent', 'Success'];
// The colour picker's default palette, from config.js.
const _cfgTheme = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.theme) || {};
const THEME_COLOR_DEFAULTS = [
  _cfgTheme.primary || '#3949ab',
  _cfgTheme.secondary || '#ffa726',
  _cfgTheme.tertiary || '#2196f3',
  _cfgTheme.accent || '#9c27b0',
  _cfgTheme.success || '#43a047',
];

const FA_SEARCH_URL = 'https://fontawesome.com/search?ic=free-collection';

// Existing numbered + legacy entries for a multi category, e.g. quiz1_percentage, quiz2_percentage.
function gradingEntriesFor(cat, metaMap) {
  const re = new RegExp(`^${cat.id}(\\d+)_percentage$`);
  const nums = [];
  for (const k of Object.keys(metaMap)) {
    const m = k.match(re);
    if (m) nums.push(parseInt(m[1], 10));
  }
  nums.sort((a, b) => a - b);
  const entries = nums.map(n => ({ n, key: `${cat.id}${n}_percentage` }));
  if (cat.legacyKey && metaMap[cat.legacyKey]) {
    entries.push({ n: entries.length ? entries[entries.length - 1].n + 1 : 1, key: cat.legacyKey });
  }
  return entries;
}

const STATIC_META_KEYS = new Set([
  'code', 'title', 'year', 'semester', 'level', 'type', 'credits',
  'startdate', 'enddate', 'holidayweeks', 'holiday_startdate',
  'header_decoration', 'theme_colours',
  ...GRADING_FIXED_KEYS, ...GRADING_LEGACY_KEYS,
]);

function isDynamicMetaKey(k) {
  return /^professor\d+(_link|_photo)?$/.test(k) ||
    /^timetable\d+_(name|id|height|hidden)$/.test(k) ||
    /^class\d+_id$/.test(k) ||
    /^(hw|project|casestudy|lab|quiz|midterm|other)\d+_percentage$/.test(k);
}
function isKnownMetaKey(k) { return STATIC_META_KEYS.has(k) || isDynamicMetaKey(k); }

const TYPE_NAMES = {
  metadata: 'Metadata', button: 'Link Button', announcement: 'Announcement',
  module: 'Module', material: 'Material', project: 'Project',
  project_file: 'Project File', project_description: 'Project Description',
  project_group: 'Project Group', group_file: 'Group File',
  funfact: 'Fun Fact',
};

const FIELDS = {
  button: [
    { col: 'b', label: 'Button Label', fi: 'fa-solid fa-tag' },
    { col: 'c', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
    { col: 'd', label: 'Link URL', link: true, fi: 'fa-solid fa-link' },
    {
      col: 'e', label: 'Button Color', fi: 'fa-solid fa-palette', sel: [
        { val: '', lbl: '—' }, { val: 'btn-blue', lbl: 'Blue' }, { val: 'btn-red', lbl: 'Red' },
        { val: 'btn-green', lbl: 'Green' }, { val: 'btn-orange', lbl: 'Orange' }, { val: 'btn-purple', lbl: 'Purple' }
      ]
    },
  ],
  announcement: [
    { col: 'e', label: 'Title', fi: 'fa-solid fa-heading' },
    { col: 'f', label: 'Body', ta: true, hint: 'HTML allowed', fi: 'fa-solid fa-align-left' },
    { col: 'd', label: 'Date / Time', dt: true, fi: 'fa-solid fa-calendar' },
    { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
    {
      col: 'c', label: 'Accent Colour', fi: 'fa-solid fa-palette', sel: [
        { val: '', lbl: '—' },
        { val: 'var(--primary-color)', lbl: 'Primary (Blue)' },
        { val: 'var(--secondary-color)', lbl: 'Secondary (Orange)' },
        { val: 'var(--warning-color)', lbl: 'Warning (Amber)' },
        { val: 'var(--danger-color)', lbl: 'Danger (Red)' },
        { val: 'var(--success-color)', lbl: 'Success (Green)' }
      ]
    },
    { col: 'g', label: 'Action Links', hint: 'comma-separated URLs', fi: 'fa-solid fa-link' },
    { col: 'h', label: 'Action Icons', faList: true, hint: 'comma-separated Font Awesome classes or <i> tags, one per link', fi: 'fa-solid fa-icons' },
    { col: 'i', label: 'Visibility', fi: 'fa-regular fa-eye', sel: [{ val: '', lbl: '—' }, { val: 'SHOW', lbl: 'Show' }, { val: 'HIDE', lbl: 'Hide' }] },
  ],
  module: [
    { col: 'b', label: 'Order', fi: 'fa-solid fa-list-ol' },
    { col: 'c', label: 'Module Title', fi: 'fa-solid fa-heading' },
    { col: 'd', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
    { col: 'e', label: 'Subtitle', fi: 'fa-solid fa-align-left' },
    {
      col: 'f', label: 'Default State', fi: 'fa-solid fa-toggle-on', sel: [
        { val: 'SHOW', lbl: 'Expanded' }, { val: 'HIDE', lbl: 'Collapsed' }, { val: '', lbl: 'Hidden' }
      ]
    },
  ],
  material: [
    { col: 'c', label: 'Title', fi: 'fa-solid fa-heading' },
    { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons', default: 'fa-regular fa-file-powerpoint' },
    { col: 'd', label: 'Subtitle / Description', fi: 'fa-solid fa-align-left' },
    { col: 'e', label: 'View Link', link: true, fi: 'fa-regular fa-eye' },
    { col: 'f', label: 'Download Link', link: true, fi: 'fa-solid fa-download' },
    { col: 'g', label: 'Open Link', link: true, fi: 'fa-solid fa-arrow-up-right-from-square' },
    { col: 'h', label: 'Autofill Link', autofill: true, fi: 'fa-solid fa-wand-magic-sparkles' },
  ],
  funfact: [
    { col: 'b', label: 'Fun Fact Text', ta: true, fi: 'fa-solid fa-lightbulb' },
  ],
  project: [
    { col: 'b', label: 'Order', fi: 'fa-solid fa-list-ol' },
    { col: 'c', label: 'Project Title', fi: 'fa-solid fa-heading' },
    { col: 'd', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
    { col: 'e', label: 'Subtitle / Deadline', fi: 'fa-regular fa-clock' },
    {
      col: 'f', label: 'Default State', fi: 'fa-solid fa-toggle-on', sel: [
        { val: 'SHOW', lbl: 'Expanded' }, { val: 'HIDE', lbl: 'Collapsed' }, { val: '', lbl: 'Hidden' }
      ]
    },
  ],
  project_file: [
    { col: 'c', label: 'Title', fi: 'fa-solid fa-heading' },
    { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
    { col: 'd', label: 'Subtitle / Description', fi: 'fa-solid fa-align-left' },
    { col: 'e', label: 'View Link', link: true, fi: 'fa-regular fa-eye' },
    { col: 'f', label: 'Download Link', link: true, fi: 'fa-solid fa-download' },
    { col: 'g', label: 'Open Link', link: true, fi: 'fa-solid fa-arrow-up-right-from-square' },
    { col: 'h', label: 'Autofill Link', autofill: true, fi: 'fa-solid fa-wand-magic-sparkles' },
  ],
  project_description: [
    { col: 'b', label: 'Description (HTML)', ta: true, fi: 'fa-solid fa-code' },
  ],
  project_group: 'dynamic', // handled inline via buildInlineGroupFieldsHtml/commitInlineGroupFields
  group_file: [
    { col: 'c', label: 'Title', fi: 'fa-solid fa-heading' },
    { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
    { col: 'd', label: 'Subtitle', fi: 'fa-solid fa-align-left' },
    { col: 'e', label: 'View Link', link: true, fi: 'fa-regular fa-eye' },
    { col: 'f', label: 'Download Link', link: true, fi: 'fa-solid fa-download' },
    { col: 'g', label: 'Open Link', link: true, fi: 'fa-solid fa-arrow-up-right-from-square' },
  ],
};

const SECTIONS = [
  { id: 'modules', label: 'Modules', icon: 'fa-solid fa-layer-group', types: ['module', 'material', 'funfact'], hier: true },
  { id: 'projects', label: 'Projects', icon: 'fa-solid fa-diagram-project', types: ['project', 'project_file', 'project_description', 'project_group', 'group_file'], proj: true },
  { id: 'announce', label: 'Announcements', icon: 'fa-solid fa-bullhorn', types: ['announcement'] },
  // Exams and Students live in the private exam tables (js/course-exams.js), not course_rows.
  { id: 'exams', label: 'Exams', icon: 'fa-solid fa-file-pen', types: [] },
  { id: 'links', label: 'Links', icon: 'fa-solid fa-link', types: ['button'] },
  { id: 'grading', label: 'Grading', icon: 'fa-solid fa-chart-simple', types: ['metadata'] },
  { id: 'students', label: 'Students', icon: 'fa-solid fa-users', types: [] },
  { id: 'info', label: 'Info', icon: 'fa-solid fa-circle-info', types: ['metadata'] },
];

// A row_index band per section, so the public page's row_index order never mixes two
// sections' rows. Metadata is read by key, so it needs none.
const SECTION_ROW_BASE = { modules: 100000, projects: 200000, announce: 300000, links: 400000 };

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

// A stored session with both tokens. getSession() can still come back empty while its
// token refresh is in flight, which must not flash the login screen.
function hasStoredSession() {
  try {
    const d = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY));
    return !!(d?.access_token && d?.refresh_token);
  } catch { }
  return false;
}

// How long to wait for that refresh: a few round trips on this connection, or a flat
// default without the Network Information API (Safari, Firefox).
function estimateAuthTimeoutMs() {
  if (navigator.onLine === false) return 0; // no network at all — no point waiting
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    if (typeof conn.rtt === 'number' && conn.rtt > 0) {
      return Math.min(6000, Math.max(1200, conn.rtt * 6));
    }
    const byEffectiveType = { 'slow-2g': 6000, '2g': 5000, '3g': 3000, '4g': 1500 };
    if (conn.effectiveType && byEffectiveType[conn.effectiveType] != null) {
      return byEffectiveType[conn.effectiveType];
    }
  }
  return 3000;
}

// Race getSession() against a timeout so a slow refresh never leaves a blank screen. The
// timeout only shows the login screen; the session stays, and signs in if it resolves.
(async () => {
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    if (!_sessionHandled) { hideBootSpinner(); showScreen('login'); }
  }, estimateAuthTimeoutMs());

  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) throw error;
    if (session && !_sessionHandled) {
      clearTimeout(timeoutId);
      _sessionHandled = true;
      promoteToFullSkeleton();
      await handleSession(session);
    } else if (!session && !hasStoredSession() && !_sessionHandled && !didTimeout) {
      // Nothing to restore at all — genuinely logged out, safe to show login right away.
      clearTimeout(timeoutId);
      hideBootSpinner();
      showScreen('login');
    }
    // Empty despite a stored session: keep the neutral spinner and let onAuthStateChange
    // decide, with the timeout as the fallback.
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
  const origHTML = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="google-icon signin-spinner" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin"></i></span>Signing in...';
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: ADMIN_RETURN_URL }
    });
    if (error) throw error;
  } catch (error) {
    toast('Sign-in failed: ' + error.message, 'err'); btn.disabled = false; btn.innerHTML = origHTML;
  }
}

async function signOut(force = false) {
  if (!force && !(await confirmLeaveIfDirty())) return;
  _sessionHandled = false;
  // Stop One Tap from silently re-selecting the same Google account the moment the
  // login screen reappears — without this, signing out becomes an instant re-login loop.
  try { google.accounts.id.disableAutoSelect(); } catch { }
  await sb.auth.signOut();
  S.admin = null; S.access = null; S.course = null;
  _sectionDirty = false;
  closeInlineEdit(true);
  clearMain();
  renderAccessControls();
  window.history.replaceState(null, '', ADMIN_RETURN_URL);
}

// ─────────────────────────────────────────────────────────────────────────────
// Google One Tap: a browser prompt (FedCM) with no redirect; Supabase verifies the ID token.
// The Sign in button's redirect is the fallback when One Tap can't show.
// Nonce: Google puts its SHA-256 hash in the token; Supabase gets the raw nonce to check it.
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = window.TEACHING_CONFIG.googleClientId;
let _oneTapNonce = null;
let _oneTapInited = false;
let _oneTapWanted = false; // login screen showed before the GIS script finished loading

window._gsiOnLoad = () => { if (_oneTapWanted) showOneTap(); };

async function initOneTap() {
  if (EMBEDDED_ADMIN_SITE) return false;
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
    auto_select: true,          // returning admin with one Google account: zero-click sign-in
    itp_support: true,          // Safari/ITP-friendly UX
    use_fedcm_for_prompt: true  // browser-native FedCM prompt — the non-popup path Chrome mandates
  });
  _oneTapInited = true;
  return true;
}

async function showOneTap() {
  // Lecturer websites use Supabase OAuth and its redirect allowlist. The homepage is
  // for browsing courses, so the prompt appears only on ?admin.
  if (EMBEDDED_ADMIN_SITE || !new URLSearchParams(location.search).has('admin')) return;
  _oneTapWanted = false;
  if (!(await initOneTap())) { _oneTapWanted = true; return; } // GIS not ready yet; retried from _gsiOnLoad
  google.accounts.id.prompt();
}

function cancelOneTap() {
  // Close any prompt still on screen once we leave the login screen.
  if (_oneTapInited) { try { google.accounts.id.cancel(); } catch { } }
}

async function onOneTapCredential(resp) {
  if (EMBEDDED_ADMIN_SITE) return;
  const btn = document.getElementById('signin-btn');
  const origHTML = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="google-icon signin-spinner" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin"></i></span>Signing in...';
  const { error } = await sb.auth.signInWithIdToken({
    provider: 'google',
    token: resp.credential,
    nonce: _oneTapNonce
  });
  if (error) {
    toast('Sign-in failed: ' + error.message, 'err');
    btn.disabled = false; btn.innerHTML = origHTML;
  }
  // On success onAuthStateChange fires SIGNED_IN → handleSession() routes into the app.
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle sign-out, for shared computers: no interaction for IDLE_TIMEOUT_MS signs out. It only
// runs while the admin is on screen (see showScreen).
// ─────────────────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let _idleTimer = null;
let _idleWatchStarted = false;

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    toast('Signed out due to inactivity', 'err');
    await signOut(true);
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
    // Start the sidebar query now, alongside the identity lookup; they're independent.
    prefetchSidebar();
    const result = await Promise.race([
      sb.rpc('teaching_access'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
    ]);
    if (result.error) throw result.error;
    admin = result.data;
  } catch (error) {
    // A cold start or network issue: the session is still fine, so keep it and show the
    // login screen; signing in again retries.
    _sessionHandled = false;
    hideLoading();
    document.getElementById('error-msg').textContent = ['PGRST202', '42883'].includes(error.code)
      ? 'Could not load your course access. Please try again later.'
      : 'Could not load your course permissions. Please try signing in again.';
    showScreen('error');
    return;
  }
  hideLoading();
  if (!admin) {
    S.access = null;
    document.getElementById('error-msg').textContent = (session.user.email || 'Your account') + ' has not been granted teaching access.';
    showScreen('error'); return;
  }
  S.admin = admin;
  S.access = admin;
  // Use this sign-in's Google profile photo as a fallback.
  const meta = session.user.user_metadata || {};
  S.sessionPhoto = [meta.avatar_url, meta.picture].find(url => /^https:\/\//.test(url || '')) || '';
  renderTopUser();
  renderAccessControls();
  if (EMBEDDED_ADMIN_SITE || window.location.href.includes('#')) window.history.replaceState(null, '', ADMIN_RETURN_URL);
  showScreen('admin');
  await loadSidebar();
  reopenLastCourse();
}

// Opens the course that was open last time in this browser, if it still exists here.
function reopenLastCourse() {
  if (S.course || S.section === 'access') return;
  let last = null;
  try { last = JSON.parse(localStorage.getItem('admin_last_course') || 'null'); } catch { }
  if (!Array.isArray(last) || !COURSE_HEADERS.has(JSON.stringify([last[0], !!last[1]]))) return;
  const [name, isArchive] = [last[0], !!last[1]];
  const button = [...document.querySelectorAll('.course-btn')]
    .find(b => b.dataset.sheet === name && b.dataset.archive === String(isArchive));
  selectCourse(name, isArchive, button || null);
}

// The signed-in person's shown name (display name, else Google name) and photo.
function renderTopUser() {
  const me = S.access || {};
  const name = me.display_name || me.name || me.email || '';
  document.getElementById('top-user').innerHTML = userAvatar(name, me.photo || S.sessionPhoto) + `<span>${x(name)}</span>`;
}

// Google profile photo over the person's initials. The initials stay visible if the
// photo is missing or fails to load; no-referrer avoids Google's hotlink refusals.
function userAvatar(name, photo, className = 'user-avatar') {
  const initials = String(name || '').split(/[\s@._-]+/).filter(Boolean)
    .slice(0, 2).map(part => part[0]).join('').toLocaleUpperCase();
  return `<span class="${className}" aria-hidden="true">${x(initials)}${photo ?
    `<img src="${x(photo)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}

function hideBootSpinner() {
  const el = document.getElementById('boot-spinner');
  el.classList.add('hidden');
  setTimeout(() => el.style.display = 'none', 300);
}

// The admin-shaped skeleton, only once a session exists, so signed-out visitors never see it.
function promoteToFullSkeleton() {
  hideBootSpinner();
  document.getElementById('app-loading').style.display = 'flex';
}

function hideLoading() {
  const el = document.getElementById('app-loading');
  el.classList.add('hidden');
  setTimeout(() => el.style.display = 'none', 400);
}

function showScreen(w) {
  hideBootSpinner();
  document.getElementById('login-screen').style.display = w === 'login' ? 'flex' : 'none';
  document.getElementById('error-screen').style.display = w === 'error' ? 'flex' : 'none';
  document.getElementById('admin-app').style.display = w === 'admin' ? 'flex' : 'none';
  // The sign-in card carries its own back link, so the footer's would be a duplicate.
  document.getElementById('footer-back').style.display = w === 'login' ? 'none' : '';
  if (w !== 'admin') { hideLoading(); applyCourseTheme(''); } // reset brand colour off any course
  if (w === 'admin') { startIdleWatch(); applyArchiveGroupState(); } else stopIdleWatch();
  if (w === 'login') { showOneTap(); window.showCourseFinder?.(); } else cancelOneTap();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────────

// Only matters on mobile, where the sidebar is a drawer opened by the floating button.
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 768) {
    const open = sidebar.classList.toggle('mobile-open');
    document.getElementById('sidebar-backdrop').classList.toggle('active', open);
    document.getElementById('sidebar-fab').classList.toggle('active', open);
  } else {
    const hidden = sidebar.classList.toggle('desktop-hidden');
    document.getElementById('admin-app').classList.toggle('sidebar-desktop-hidden', hidden);
  }
}

// Archive-group expand/collapse persists across visits.
function toggleArchiveGroup() {
  const body = document.getElementById('sb-archive');
  const btn = document.getElementById('sb-archive-toggle');
  const expanded = body.classList.toggle('sb-archive-collapsed') === false;
  btn.classList.toggle('expanded', expanded);
  try { localStorage.setItem('admin_archive_expanded', expanded ? '1' : '0'); } catch { }
}

function applyArchiveGroupState() {
  let expanded = false;
  try { expanded = localStorage.getItem('admin_archive_expanded') === '1'; } catch { }
  document.getElementById('sb-archive').classList.toggle('sb-archive-collapsed', !expanded);
  document.getElementById('sb-archive-toggle').classList.toggle('expanded', expanded);
}

let _sidebarPrefetch = null;
function prefetchSidebar() {
  // Supabase queries only start when awaited; .then() starts this one now.
  _sidebarPrefetch = sb.from('course_rows')
    .select('sheet_name, is_archive, b, c')
    .eq('type', 'metadata').order('sheet_name')
    .then(r => r);
  return _sidebarPrefetch;
}

async function loadSidebar() {
  const lecturers = loadCourseLecturers().catch(() => { });
  const { data, error } = await (_sidebarPrefetch || prefetchSidebar());
  await lecturers;
  _sidebarPrefetch = null;
  if (error) { toast('Sidebar error: ' + error.message, 'err'); return; }
  const map = {};
  for (const r of (data || [])) {
    const isArch = r.is_archive === true || r.is_archive === 'true' || r.is_archive === 1 || r.is_archive === '1';
    if (!hasCourseAccess(r.sheet_name, isArch)) continue;
    const k = r.sheet_name + '|' + String(isArch);
    if (!map[k]) map[k] = { sheet_name: r.sheet_name, is_archive: isArch };
    const bKey = String(r.b || '').trim().toLowerCase();
    if (!bKey || bKey === 'sheet_name' || bKey === 'is_archive') continue;
    map[k][bKey] = String(r.c || '').trim();
    if (bKey === 'header_decoration') map[k].icon = map[k][bKey];
  }
  COURSE_HEADERS.clear();
  for (const course of Object.values(map)) {
    COURSE_HEADERS.set(JSON.stringify([course.sheet_name, course.is_archive]), course);
  }
  renderSidebar();
}

// Admins with their own courses choose between those and every course. Without
// any assigned, "Mine" would be empty, so the sidebar lists every course as before.
function sidebarScope() {
  if (!isCourseAdmin() || !S.access?.assignments?.length) return null;
  try { return localStorage.getItem('admin_sidebar_scope') === 'all' ? 'all' : 'mine'; } catch { return 'mine'; }
}

function setSidebarScope(scope) {
  try { localStorage.setItem('admin_sidebar_scope', scope); } catch { }
  renderSidebar();
}

// Lecturers assigned to each course, keyed like COURSE_HEADERS. Filled from the public
// teaching_lecturers list; empty when the service is unavailable.
const COURSE_LECTURERS = new Map();
async function loadCourseLecturers() {
  const { data, error } = await sb.rpc('teaching_lecturers', {});
  if (error || !Array.isArray(data)) return;
  COURSE_LECTURERS.clear();
  for (const row of data) {
    const key = JSON.stringify([row.sheet_name, !!row.is_archive]);
    if (!COURSE_LECTURERS.has(key)) COURSE_LECTURERS.set(key, []);
    COURSE_LECTURERS.get(key).push(row);
  }
  for (const list of COURSE_LECTURERS.values()) list.sort((a, b) => TeachingSites.compareLecturers(a.name, b.name));
}
const courseLecturerNames = c => (COURSE_LECTURERS.get(JSON.stringify([c.sheet_name, c.is_archive])) || []).map(l => l.name);

// Every word must appear in the code, name, semester, year or a lecturer's name, as in Settings.
function courseMatchesQuery(c, query) {
  const text = [c.code, c.title, c.sheet_name, c.semester, c.year, ...courseLecturerNames(c)]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}

function renderSidebar() {
  const scope = sidebarScope();
  const toggle = document.getElementById('sb-scope');
  toggle.hidden = !scope;
  toggle.dataset.active = scope || ''; // Positions the sliding thumb.
  toggle.querySelectorAll('[data-scope]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
  });
  const query = document.getElementById('sb-search')?.value || '';
  const courses = [...COURSE_HEADERS.values()]
    .filter(c => scope !== 'mine' || isAssignedCourse(c.sheet_name, c.is_archive))
    .filter(c => !query.trim() || courseMatchesQuery(c, query));
  const archived = courses.filter(c => c.is_archive).sort(courseOrder);
  renderSidebarGroup('sb-active', courses.filter(c => !c.is_archive).sort(courseOrder), false);
  renderSidebarGroup('sb-archive', archived, true);
  // While searching, open Archived when it has matches; clearing the search restores
  // the saved open/closed state.
  if (query.trim() && archived.length) {
    document.getElementById('sb-archive').classList.remove('sb-archive-collapsed');
    document.getElementById('sb-archive-toggle').classList.add('expanded');
  } else applyArchiveGroupState();
}

// Course order (sidebar, Settings and the public page): newest academic year first, then
// Summer → Spring → Fall within a year, then course number ascending with the code's
// letters as tie-break — CE 123, ARCH 203, CE 345.
const SEMESTER_ORDER = ['Summer', 'Spring', 'Fall'];

// Strips academic and professional titles (Prof., Dr., Assoc., Acad., MSc., Mr., Ms., Mrs. and combinations)
function stripTitles(str) {
  let s = String(str || '').trim();
  const titleToken = /\b(?:Prof(?:essor)?|Dr|Assoc(?:\.?\s*Prof(?:essor)?)?|Acad(?:emician)?|M\.?Sc|Mr|Ms|Mrs)\.?/i;
  const titlePattern = new RegExp(`^(?:${titleToken.source}\\s*)+`, 'i');
  const stripped = s.replace(titlePattern, '').trim();
  return stripped || s;
}

// Extracts the course number (e.g. 211 from "CE 211") and prefix text (e.g. "CE").
function parseCourseCode(str) {
  const s = String(str || '').trim();
  const cleanStr = stripTitles(s);
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
      raw: s,
      clean: cleanStr,
    };
  }
  return {
    hasNum: false,
    num: Infinity,
    text: cleanStr,
    raw: s,
    clean: cleanStr,
  };
}

function compareCourseCodes(aCode, bCode) {
  // Cross-listed codes ("SWE / CE 101") come after all single codes, A–Z among themselves.
  const crossA = String(aCode || '').includes('/'), crossB = String(bCode || '').includes('/');
  if (crossA !== crossB) return crossA ? 1 : -1;
  if (crossA) return String(aCode).localeCompare(String(bCode), undefined, { numeric: true, sensitivity: 'base' });
  const a = parseCourseCode(aCode);
  const b = parseCourseCode(bCode);

  if (a.hasNum && b.hasNum) {
    if (a.num !== b.num) return a.num - b.num;
    const textCmp = a.text.localeCompare(b.text, undefined, { sensitivity: 'base' });
    if (textCmp !== 0) return textCmp;
    return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
  }

  if (a.hasNum && !b.hasNum) return -1;
  if (!a.hasNum && b.hasNum) return 1;

  const cleanCmp = a.clean.localeCompare(b.clean, undefined, { numeric: true, sensitivity: 'base' });
  if (cleanCmp !== 0) return cleanCmp;

  return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
}

// Courses with no semester/year set sort after those that have one, so a half-filled course
// never wedges itself between two real offerings.
function semesterRank(s) {
  const m = String(s || '').match(/^\s*(Fall|Spring|Summer)/);
  const i = m ? SEMESTER_ORDER.indexOf(m[1]) : -1;
  return i === -1 ? SEMESTER_ORDER.length : i;
}

// Sentinel rather than -Infinity: two unset years must subtract to 0, not NaN.
function yearStart(y) {
  const m = String(y || '').match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : -1;
}

function courseOrder(a, b) {
  return (yearStart(b.year) - yearStart(a.year))
    || (semesterRank(a.semester) - semesterRank(b.semester))
    || compareCourseCodes(a.code || a.sheet_name, b.code || b.sheet_name);
}

function renderSidebarGroup(id, courses, isArchive) {
  const el = document.getElementById(id);
  if (!courses.length) {
    el.innerHTML = `<div class="sb-empty">${document.getElementById('sb-search')?.value.trim() ? 'No matches' : 'None'}</div>`;
    return;
  }
  el.innerHTML = courses.map(c => {
    const active = S.course === c.sheet_name && S.isArchive === isArchive;
    const code = c.code || c.sheet_name;
    const title = c.title && c.title !== code ? c.title : '';
    const term = [c.semester, c.year].filter(Boolean).join(' ');
    const icon = c.icon || 'fa-solid fa-graduation-cap';
    return `<button class="course-btn${active ? ' active' : ''}" data-sheet="${x(c.sheet_name)}" data-archive="${isArchive}"
                onclick="selectCourse('${xjs(c.sheet_name)}',${isArchive},this)">
      <i class="${x(icon)} cb-icon"></i>
      <div class="cb-text">
        <div class="cb-code">${x(code)}</div>
        ${title ? `<div class="cb-name">${x(title)}</div>` : ''}
        ${term ? `<div class="cb-sub">${x(term)}</div>` : ''}
      </div>
    </button>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Course / Section
// ─────────────────────────────────────────────────────────────────────────────

// The tab last open per course, so reopening a course returns to it.
function lastSectionKey(course, isArchive) { return `admin_last_section:${course}:${isArchive}`; }
// A tab that no longer exists falls back to Modules; Class list is now Students.
function getLastSection(course, isArchive) {
  let id = null;
  try { id = localStorage.getItem(lastSectionKey(course, isArchive)); } catch { }
  if (id === 'classlist') id = 'students';
  return SECTIONS.some(s => s.id === id) ? id : 'modules';
}
function saveLastSection(course, isArchive, id) {
  try { localStorage.setItem(lastSectionKey(course, isArchive), id); } catch { }
}

// Persists whatever tab is currently open, dispatching to the right save routine. Returns
// true only if the save actually succeeded (so navigation can be aborted on failure).
async function saveCurrentSection() {
  if (S.section === 'info') return await trackSave(saveSettings);
  if (S.section === 'grading') return await trackSave(saveGradingSettings);
  if (S.section === 'students') return await trackSave(saveStudentsSection);
  if (S.section === 'exams') return await trackSave(saveExamsSection); // the questions editor; dialogs save themselves
  return await trackSave(() => saveSectionChanges(S.section));
}

// Returns true if it's safe to leave the current tab/course.
async function confirmLeaveIfDirty() {
  if (document.getElementById('access-settings')) return confirmLeaveAccessSettings();
  // Check the saved snapshot only after any pending save and reload have finished.
  if (_savePromise) await _savePromise.catch(() => { });
  if (!hasSectionChanges() && !inlinePanelDirty()) return true;
  const choice = await confirmDialog('You have unsaved changes in this tab.',
    { title: 'Save changes?', okLabel: 'Save', okIcon: 'fa-floppy-disk', altLabel: 'Discard' });
  if (choice === true) {
    const ok = await saveCurrentSection();
    if (!ok) return false; // save failed — stay put so nothing is lost
    return !hasSectionChanges() && !inlinePanelDirty();
  }
  if (choice === 'alt') { rememberSavedSection(); return true; } // discard
  return false; // cancel — stay
}

async function selectCourse(name, isArchive, el) {
  if (!requirePermission(hasCourseAccess(name, isArchive))) return;
  if (name === S.course && isArchive === S.isArchive) return;
  if (!(await confirmLeaveIfDirty())) return;
  closeInlineEdit(true); // drop any open editor without re-prompting
  S.course = name; S.isArchive = isArchive; S.section = getLastSection(name, isArchive);
  try { localStorage.setItem('admin_last_course', JSON.stringify([name, isArchive])); } catch { }
  document.querySelectorAll('.course-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  if (window.innerWidth <= 768 && document.getElementById('sidebar').classList.contains('mobile-open')) {
    toggleSidebar();
  }
  lockHeight(document.getElementById('main-area'));
  renderCourseShell(name, isArchive);
}

function renderCourseShell(name, isArchive) {
  const key = JSON.stringify([name, isArchive]);
  const header = COURSE_HEADERS.get(key);
  applyCourseTheme(header?.theme_colours);
  const main = document.getElementById('main-area');
  // Moving between courses: no entry animation, and the previous tab content is carried
  // over (dimmed, inert) instead of blanking to a skeleton.
  const switching = !!main.querySelector('.course-header.ch-course');
  const carried = [...(main.querySelector('#section-body')?.children || [])];
  main.innerHTML = `
    <div class="course-header ch-course${isArchive ? ' is-archive' : ''}${switching ? ' no-enter' : ''}">
      <div class="ch-actions">
        <!-- Colour-coded actions: labels on wider screens, icons only on phones (the
             names stay as tooltips and accessible labels). Status shows only when
             archived, as a plain tag rather than a button. Preview, open to everyone,
             is a link whose address updateCoursePreview() fills in. -->
        ${isArchive ? '<span class="ch-status">Archived</span>' : ''}
        <div class="ch-action-group" role="group" aria-label="Course actions">
        <a class="btn-sm ch-action ch-action-preview" id="ch-preview" target="_blank" rel="noopener" title="Preview"
           aria-label="Preview" aria-disabled="true"><i class="fa-solid fa-eye" aria-hidden="true"></i><span class="ch-action-label">Preview</span></a>
        ${isArchive
      ? `<button class="btn-sm ch-action ch-action-restore" title="Restore" aria-label="Restore" ${isCourseAdmin() ? '' : 'disabled'} onclick="restoreCourse('${xjs(name)}')"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i><span class="ch-action-label">Restore</span></button>`
      : `<button class="btn-sm ch-action ch-action-archive" title="Archive" aria-label="Archive" ${canArchiveCourse(name, isArchive) ? '' : 'disabled'} onclick="archiveCourse('${xjs(name)}')"><i class="fa-solid fa-box-archive" aria-hidden="true"></i><span class="ch-action-label">Archive</span></button>`}
        <button class="btn-sm ch-action ch-action-delete" title="Delete" aria-label="Delete"
                ${isCourseAdmin() ? '' : 'disabled'} onclick="deleteCourse('${xjs(name)}',${isArchive})"><i class="fa-solid fa-trash" aria-hidden="true"></i><span class="ch-action-label">Delete</span></button>
        </div>
      </div>
      <!-- Same structure and styles (main.css) as the public course header, minus the
           week counter and term progress bar. -->
      <div id="header-decoration" aria-hidden="true"><i class="fa-solid ${x(courseIconClass(header?.icon))}"></i></div>
      <h2 id="ch-code">${header ? x(header.code || name) : '<span class="skeleton skeleton-on-dark" style="display:inline-block;width:90px;height:0.9em"></span>'}</h2>
      <h1 id="ch-title">${header ? x(header.title || header.code || name) : '<span class="skeleton skeleton-on-dark" style="display:inline-block;width:60%;height:1em"></span>'}</h1>
      <div class="course-info" id="ch-info">${header ? courseInfoChips(header, isArchive, COURSE_LECTURERS.get(key) || [])
      : [140, 120, 110, 100].map(w => `<span class="info-item skeleton skeleton-on-dark" style="width:${w}px"></span>`).join('')}</div>
    </div>
    <div class="section-tabs${switching ? ' no-enter' : ''}" id="section-tabs">
      ${SECTIONS.map((s, i, arr) => {
        const r = i === 0 ? 'border-radius:20px 8px 8px 20px'
          : i === arr.length - 1 ? 'border-radius:8px 20px 20px 8px' : '';
        return `<button class="section-tab${s.id === S.section ? ' active' : ''}" style="${r}" data-sec="${s.id}"
                  onclick="selectSection('${s.id}',this)">${s.icon ? `<i class="${s.icon} tab-icon" aria-hidden="true"></i>` : ''}<span class="tab-label" data-label="${x(s.label)}">${s.label}</span>${canEditSection(s.id) ? '' : '<i class="fa-solid fa-lock tab-lock" title="View only"></i>'}</button>`;
      }).join('')}
    </div>
    <div class="section-body" id="section-body"></div>
  `;
  tagInfoRows(document.getElementById('ch-info'));
  updateCoursePreview(name, isArchive);
  const body = document.getElementById('section-body');
  carried.forEach(child => { child.inert = true; body.appendChild(child); });
  setTimeout(() => {
    if (!body.isConnected || body.classList.contains('loaded')) return;
    if (body.children.length && !body.querySelector(':scope > [inert]:not(.section-topbar)')) return;
    const toolbar = body.querySelector(':scope > .section-topbar[inert]');
    body.innerHTML = sectionSkeletonHtml();
    if (toolbar) body.prepend(toolbar);
  }, 400);
  fillCourseHeader(name, isArchive);
  loadSection(S.section);
  renderAccessControls();
}

// Preview opens the course on a public course page, chosen by where you are signed in:
// this lecturer website when it lists the course, then your own page, then one of the
// course's other lecturers' pages, then the main course page (/courses/) if it lists
// the course. '' when no page shows it.
const _previewRefreshed = new Set();
const _centralSheets = {};
async function coursePreviewUrl(name, isArchive) {
  const find = directory => directory.courses.find(c => c.sheet_name === name && !!c.is_archive === isArchive);
  let directory = await TeachingSites.directory();
  // A course created or assigned since the page loaded: look again, once.
  if (!find(directory) && !_previewRefreshed.has(name)) {
    _previewRefreshed.add(name);
    directory = await TeachingSites.directory(true);
  }
  const lecturers = find(directory)?.lecturers || [];
  const link = page => TeachingSites.courseLink(page, name, isArchive);
  if (EMBEDDED_ADMIN_SITE && lecturers.includes(EMBEDDED_ADMIN_SITE.id)) return link(TeachingSites.sitePage(EMBEDDED_ADMIN_SITE));
  const handle = String(S.access?.email || '').split('@')[0];
  const pages = directory.lecturers.filter(person => person.url && lecturers.includes(person.id))
    .sort((a, b) => (b.slug === handle) - (a.slug === handle) || TeachingSites.compareLecturers(a.name, b.name));
  if (pages.length) return link(pages[0].url);
  _centralSheets[isArchive] ||= TeachingSites.centralRows(isArchive)
    .then(rows => new Set(rows.map(row => row.sheet_name)))
    .catch(() => { delete _centralSheets[isArchive]; return new Set(); });
  return (await _centralSheets[isArchive]).has(name) ? link(new URL('courses/', window.TEACHING_CONFIG.appBaseUrl).href) : '';
}

async function updateCoursePreview(name, isArchive) {
  let url = '';
  try { url = await coursePreviewUrl(name, isArchive); } catch (error) { console.error('Preview link:', error); }
  const preview = document.getElementById('ch-preview');
  if (!preview || S.course !== name || S.isArchive !== isArchive) return; // another course is open now
  if (url) { preview.href = url; preview.removeAttribute('aria-disabled'); }
  else preview.title = 'Not on any course page yet';
}

// Darkens a hex colour toward black (matches js/course-page.js's darkenHex) — used to
// derive --primary-dark from a course's primary colour.
function darkenHex(hex, amount = 0.25) {
  hex = String(hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = Math.max(0, Math.round(parseInt(hex.substring(0, 2), 16) * (1 - amount)));
  const g = Math.max(0, Math.round(parseInt(hex.substring(2, 4), 16) * (1 - amount)));
  const b = Math.max(0, Math.round(parseInt(hex.substring(4, 6), 16) * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function lightenHex(hex, amount = 0.4) {
  hex = String(hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const channel = i => { const v = parseInt(hex.substring(i, i + 2), 16); return Math.min(255, Math.round(v + (255 - v) * amount)); };
  return '#' + [0, 2, 4].map(i => channel(i).toString(16).padStart(2, '0')).join('');
}

// Recolours the admin to the course's primary colour, or the default blue when it sets none.
function applyCourseTheme(themeStr) {
  const root = document.documentElement;
  const first = String(themeStr || '').split(',')[0].trim();
  const hex = first ? (first.startsWith('#') ? first : '#' + first) : '';
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    root.style.setProperty('--primary-color', hex);
    root.style.setProperty('--primary-dark', darkenHex(hex, 0.25));
    // Dark mode header colours, computed as on the public course page.
    const theme = root.dataset.theme;
    const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    const base = dark ? lightenHex(hex, 0.1) : hex;
    root.style.setProperty('--course-header-bg1', dark ? darkenHex(base, 0.4) : base);
    root.style.setProperty('--course-header-bg2', dark ? darkenHex(base, 0.6) : darkenHex(base, 0.25));
  } else {
    ['--primary-color', '--primary-dark', '--course-header-bg1', '--course-header-bg2']
      .forEach(prop => root.style.removeProperty(prop));
  }
}

// The course's Font Awesome icon from its Info tab (read as the public page reads it).
function courseIconClass(icon) {
  const value = String(icon || '').trim().toLowerCase();
  return /^[a-z0-9 -]+$/.test(value) ? value : 'fa-square';
}

// The public header's info chips: lecturers, semester, level, type and credits. Lecturers are
// the accounts assigned in Settings; the lecturer entries stored with the course only fill
// in while nobody is assigned (as on the public page).
function courseInfoChips(m, isArchive, assigned = []) {
  const chips = [];
  let lecturers = assigned.map(l => ({ name: l.name, photo: l.photo }));
  if (!lecturers.length) {
    lecturers = Object.keys(m).filter(key => /^professor\d+$/.test(key) && String(m[key] || '').trim())
      .map(key => ({ name: m[key], photo: m[`${key}_photo`] }))
      .sort((a, b) => TeachingSites.compareLecturers(a.name, b.name));
  }
  for (const person of lecturers) {
    const photo = safeCourseUrl(person.photo);
    chips.push(`<span class="info-item professor-item">${photo
      ? `<img src="${x(photo)}" alt="" class="professor-photo" referrerpolicy="no-referrer"
        onerror="this.nextElementSibling.style.display='inline-block';this.remove()"><i class="fa-solid fa-user-circle" style="display:none"></i>`
      : '<i class="fa-solid fa-user-circle"></i>'} ${x(person.name)}</span>`);
  }
  if (!lecturers.length) chips.push('<span class="info-item"><i class="fa-solid fa-user-circle"></i> Instructor</span>');
  const semester = m.semester || 'Unknown Semester';
  chips.push(`<span class="info-item"><i class="fa-solid fa-calendar-check"></i> ${x(isArchive && m.year ? `${semester} ${m.year}` : semester)}</span>`);
  chips.push(`<span class="info-item"><i class="fa-solid fa-graduation-cap"></i> ${x(m.level || 'Undergraduate')}</span>`);
  chips.push(String(m.type || '').trim().toLowerCase() === 'elective'
    ? '<span class="info-item"><i class="fa-regular fa-circle"></i> Elective</span>'
    : '<span class="info-item"><i class="fa-solid fa-exclamation-circle"></i> Compulsory</span>');
  if (m.credits) chips.push(`<span class="info-item"><i class="fa-solid fa-trophy"></i> ${x(m.credits)} ECTS</span>`);
  return chips.join('');
}

// Rounds the outer ends of each visual row of chips, as the public header does.
function tagInfoRows(container) {
  const items = [...(container?.querySelectorAll('.info-item') || [])].filter(el => el.offsetParent);
  items.forEach(el => el.classList.remove('first-in-row', 'last-in-row', 'only-in-row', 'middle-in-row'));
  const rows = [];
  for (const el of items) {
    const row = rows.find(r => Math.abs(r.top - el.offsetTop) < 5);
    if (row) row.items.push(el); else rows.push({ top: el.offsetTop, items: [el] });
  }
  rows.sort((a, b) => a.top - b.top).forEach(({ items: row }) => {
    if (row.length === 1) row[0].classList.add('only-in-row');
    else { row[0].classList.add('first-in-row'); row[row.length - 1].classList.add('last-in-row'); }
  });
}
window.addEventListener('resize', () => tagInfoRows(document.getElementById('ch-info')), { passive: true });

async function fillCourseHeader(name, isArchive) {
  const { data, error } = await sb.from('course_rows').select('b,c')
    .eq('sheet_name', name).eq('is_archive', isArchive).eq('type', 'metadata');
  if (S.course !== name || S.isArchive !== isArchive) return;
  if (error) { toast('Could not load course details: ' + error.message, 'err'); return; }
  const m = {};
  for (const r of (data || [])) m[String(r.b || '').trim().toLowerCase()] = r.c;
  m.icon = m.header_decoration || '';
  // Merge: the sidebar re-renders from these entries when its scope changes.
  const key = JSON.stringify([name, isArchive]);
  COURSE_HEADERS.set(key, { ...COURSE_HEADERS.get(key), ...m, sheet_name: name, is_archive: isArchive });
  applyCourseTheme(m.theme_colours);
  const codeEl = document.getElementById('ch-code');
  if (!codeEl) return;
  codeEl.textContent = m.code || name;
  document.getElementById('ch-title').textContent = m.title || m.code || name;
  document.getElementById('header-decoration').innerHTML = `<i class="fa-solid ${x(courseIconClass(m.icon))}"></i>`;
  const info = document.getElementById('ch-info');
  info.innerHTML = courseInfoChips(m, isArchive, COURSE_LECTURERS.get(key) || []);
  tagInfoRows(info);
}

// Placeholder shown while a tab or course loads.
function sectionSkeletonHtml() {
  return `<div class="skeleton-section">
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>
  </div>`;
}

// Holding min-height across the skeleton swap stops the scrollbar flickering.
function lockHeight(el) {
  if (el) el.style.minHeight = el.offsetHeight + 'px';
}

// Show the glass surface only while the shared toolbar is pinned below the header.
(function () {
  const main = document.getElementById('main-area');
  let frame = 0;
  function update() {
    frame = 0;
    const toolbar = main.querySelector('.section-topbar');
    if (!toolbar) return;
    const inset = parseFloat(getComputedStyle(toolbar).top);
    toolbar.classList.toggle('is-stuck', window.scrollY > 0 && toolbar.getBoundingClientRect().top <= inset + 0.5);
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  main.addEventListener('animationend', schedule);
  new MutationObserver(schedule).observe(main, { childList: true, subtree: true });
  new ResizeObserver(schedule).observe(main);
  schedule();
})();

function finishSectionLoad(body) {
  applySectionPermissions(body);
  body.style.minHeight = '';
  const main = document.getElementById('main-area');
  if (main) main.style.minHeight = '';
  body.classList.add('loaded');
  rememberSavedSection();
}

async function selectSection(id, el) {
  if (id === S.section) return;
  if (!(await confirmLeaveIfDirty())) return; // unsaved changes, user cancelled
  closeInlineEdit(true); // drop any open editor without re-prompting
  S.section = id;
  saveLastSection(S.course, S.isArchive, id);
  document.querySelectorAll('.section-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  const body = document.getElementById('section-body');
  lockHeight(body);
  body.classList.remove('loaded');
  // Keep the current tab on screen, inert and dimmed (except its toolbar), until the
  // next one renders over it: blanking to a skeleton on every switch is tiring. Only a
  // slow load, still showing the old tab after 400ms, swaps in the skeleton.
  [...body.children].forEach(child => { child.inert = true; });
  setTimeout(() => {
    if (!body.isConnected || !body.querySelector(':scope > [inert]:not(.section-topbar)')) return;
    const toolbar = body.querySelector(':scope > .section-topbar[inert]');
    body.innerHTML = sectionSkeletonHtml();
    if (toolbar) body.prepend(toolbar);
  }, 400);
  loadSection(id);
}

async function loadSection(id) {
  const sec = SECTIONS.find(s => s.id === id);
  if (!sec) return;
  _sectionDirty = false; // fresh load — nothing staged yet
  _sectionBaseline = null;
  if (id === 'info') { await loadMetadataSettings(); return; }
  if (id === 'grading') { await loadGradingSettings(); return; }
  if (id === 'links') { await loadLinksSection(sec); return; }
  if (id === 'exams') { await loadExamsSection(); return; }
  if (id === 'students') { await loadStudentsSection(); return; }
  const course = S.course, isArchive = S.isArchive;
  // The Modules view is the single place where module & project ORDER is set, so it also
  // loads project header rows (type 'project') to show them as draggable refs alongside
  // modules. Their content stays in the Projects tab.
  const fetchTypes = sec.hier ? [...sec.types, 'project'] : sec.types;
  const { data, error } = await sb.from('course_rows').select('*')
    .eq('sheet_name', course).eq('is_archive', isArchive)
    .in('type', fetchTypes).order('row_index');
  const body = document.getElementById('section-body');
  if (!body || S.course !== course || S.isArchive !== isArchive || S.section !== id) return;
  if (error) { body.innerHTML = `<div class="empty-content">Error: ${x(error.message)}</div>`; return; }
  for (const r of (data || [])) ROW_STORE[r.row_uid] = r;
  if (sec.hier) body.innerHTML = renderHier(data || []);
  else if (sec.proj) body.innerHTML = renderProjects(data || []);
  else body.innerHTML = renderCards(data || [], sec);
  finishSectionLoad(body);
  initDnD(sec);
  // Arriving here from an Edit click on a project ref in the Modules view: open that
  // project's inline editor now that the Projects tab has rendered.
  if (sec.proj && _openProjectAfterLoad) {
    const uid = _openProjectAfterLoad; _openProjectAfterLoad = null;
    openInlineEdit(uid);
  }
}
let _openProjectAfterLoad = null;

// Links tab shows the Timetables editor above the Link Button cards; both save together
// via the one Save button (saveSectionChanges('links') also calls saveTimetablesWork()).
async function loadLinksSection(sec) {
  const course = S.course, isArchive = S.isArchive;
  const body = document.getElementById('section-body');
  const [metaRes, btnRes] = await Promise.all([
    sb.from('course_rows').select('*').eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata').order('row_index'),
    sb.from('course_rows').select('*').eq('sheet_name', S.course).eq('is_archive', S.isArchive).in('type', sec.types).order('row_index'),
  ]);
  if (!body?.isConnected || S.course !== course || S.isArchive !== isArchive || S.section !== sec.id) return;
  if (metaRes.error) { body.innerHTML = `<div class="empty-content">Error: ${x(metaRes.error.message)}</div>`; return; }
  if (btnRes.error) { body.innerHTML = `<div class="empty-content">Error: ${x(btnRes.error.message)}</div>`; return; }

  const metaMap = {};
  for (const r of (metaRes.data || [])) { ROW_STORE[r.row_uid] = r; if (isKnownMetaKey(r.b)) metaMap[r.b] = r; }

  const ttNums = new Set();
  for (const k of Object.keys(metaMap)) {
    const m = k.match(/^timetable(\d+)_name$/);
    if (m) ttNums.add(parseInt(m[1]));
  }
  const tts = Array.from(ttNums).sort((a, b) => a - b);

  let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
    ${tabMenuHtml('links')}
  </div>`;

  h += `<div class="settings-group" style="margin-bottom:14px">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-clock"></i>Timetables</span>
      <button class="btn-sm btn-secondary" type="button" onclick="addTimetableCard()"><i class="fa-solid fa-plus"></i></button>
    </div>
    <div class="settings-body" id="timetables-list">`;
  if (tts.length) {
    for (const n of tts) h += timetableCardHtml(n, metaMap);
  } else {
    h += `<div id="no-tt-msg" class="form-hint" style="padding:4px 0">No timetables yet.</div>`;
  }
  h += `</div></div>`;

  for (const r of (btnRes.data || [])) ROW_STORE[r.row_uid] = r;
  h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-link"></i>Link Buttons</span>
      <button class="btn-sm btn-secondary" type="button" onclick="addFlatRow('button')"><i class="fa-solid fa-plus"></i></button>
    </div>
    <div class="settings-body" id="links-cards-body">${renderCards(btnRes.data || [], sec, { bare: true })}</div>
  </div>`;

  body.innerHTML = h;
  finishSectionLoad(body);
  initDnD(sec);
}

// Stage timetables alongside link buttons so the whole Links tab saves atomically.
// Returns { upserts, deleteUids } or { error } without writing to the database.
async function saveTimetablesWork() {
  const { data: existing, error: fetchError } = await sb.from('course_rows').select('row_uid,b,row_index')
    .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata');
  if (fetchError) return { error: fetchError };
  const existMap = {};
  let maxIdx = 0;
  for (const r of (existing || [])) { existMap[r.b] = r; if (r.row_index > maxIdx) maxIdx = r.row_index; }
  const base = { sheet_name: S.course, is_archive: S.isArchive, type: 'metadata', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };

  const oldTtUids = Object.entries(existMap)
    .filter(([k]) => /^timetable\d+_(name|id|height|hidden)$/.test(k) || /^class\d+_id$/.test(k))
    .map(([, r]) => r.row_uid);

  const ttCards = document.getElementById('timetables-list') ? [...document.querySelectorAll('#timetables-list .dynamic-card')] : [];
  const newTtRows = [];
  ttCards.forEach((card, idx) => {
    const i = idx + 1;
    const name = card.querySelector('[name=tt_name]')?.value?.trim() || '';
    const tid = card.querySelector('[name=tt_id]')?.value?.trim() || '';
    const classId = card.querySelector('[name=tt_class]')?.value?.trim() || '';
    const hidden = card.querySelector('[name=tt_hidden]')?.value === '1';
    let ri = maxIdx + idx * 5;
    if (name) newTtRows.push({ ...base, row_uid: newCourseRowUid(), row_index: ri + 1, b: `timetable${i}_name`, c: name });
    if (tid) newTtRows.push({ ...base, row_uid: newCourseRowUid(), row_index: ri + 2, b: `timetable${i}_id`, c: tid });
    if (classId) newTtRows.push({ ...base, row_uid: newCourseRowUid(), row_index: ri + 3, b: `class${i}_id`, c: classId });
    if (hidden) newTtRows.push({ ...base, row_uid: newCourseRowUid(), row_index: ri + 4, b: `timetable${i}_hidden`, c: '1' });
  });
  return { upserts: newTtRows, deleteUids: oldTtUids };
}

// ─────────────────────────────────────────────────────────────────────────────
// Info / Metadata Settings
// ─────────────────────────────────────────────────────────────────────────────

async function loadGradingSettings() {
  const course = S.course, isArchive = S.isArchive;
  // Which entries exams count as: those whose exam grades are visible are Done and locked.
  const [{ data, error }, examLinks] = await Promise.all([
    sb.from('course_rows').select('*').eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata').order('row_index'),
    typeof examGradingLinks === 'function' ? examGradingLinks(course, isArchive) : [],
  ]);
  const body = document.getElementById('section-body');
  if (!body || S.course !== course || S.isArchive !== isArchive || S.section !== 'grading') return;
  if (error) { body.innerHTML = `<div class="empty-content">Error: ${x(error.message)}</div>`; return; }

  const metaMap = {};
  for (const r of (data || [])) { ROW_STORE[r.row_uid] = r; if (isKnownMetaKey(r.b)) metaMap[r.b] = r; }

  const { html: gradeRows, total: gradeTotal } = renderGradingRows(metaMap);
  const h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
    ${tabMenuHtml('grading')}
  </div>
  <div class="settings-panel">
    <div class="settings-group">
      <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-chart-simple"></i>Grading</span></div>
      <div class="settings-body">
        <table class="grade-table" id="grade-table">${gradeRows}</table>
        <div class="grade-total">Total: <strong id="grade-total" style="color:${Math.abs(gradeTotal - 100) < 0.01 ? 'var(--success-color)' : (gradeTotal > 100 ? 'var(--danger-color)' : 'var(--primary-color)')}">${gradeTotal}</strong> %</div>
      </div>
    </div>
  </div>`;
  body.innerHTML = h;
  if (typeof applyGradingLocks === 'function') applyGradingLocks(examLinks);
  finishSectionLoad(body);
}

async function saveGradingSettings() {
  if (!requirePermission(canEditSection('grading'))) return false;
  const btn = document.getElementById('section-save-btn');
  const origHtml = btn ? btn.innerHTML : '';
  const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = origHtml; } };
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }

  const { data: existing, error: fetchError } = await sb.from('course_rows').select('row_uid,b,row_index')
    .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata');
  if (fetchError) { toast('Save failed: ' + fetchError.message, 'err'); resetBtn(); return false; }
  const existMap = {};
  let maxIdx = 0;
  for (const r of (existing || [])) { existMap[r.b] = r; if (r.row_index > maxIdx) maxIdx = r.row_index; }

  const toUpsert = [];
  const base = { sheet_name: S.course, is_archive: S.isArchive, type: 'metadata', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };

  const doneMap = {};
  document.querySelectorAll('.grade-done').forEach(s => doneMap[s.dataset.donekey] = s.value);
  for (const inp of document.querySelectorAll('.grade-val')) {
    const key = inp.dataset.key;
    const val = inp.value.trim();
    const done = doneMap[key] || '';
    if (!val && !existMap[key]) continue;
    const uid = existMap[key]?.row_uid || newCourseRowUid();
    const idx = existMap[key]?.row_index || (maxIdx += 10, maxIdx);
    toUpsert.push({ ...base, row_uid: uid, row_index: idx, b: key, c: val, d: done });
  }

  const toDelete = [];

  // Multi-entry categories: delete all old + legacy keys for each category, then renumber
  // fresh from current DOM order — same pattern as professors/timetables.
  let gradeRowIdx = maxIdx + 20;
  const keyMap = {}; // old key → new key ('' when removed), for exams that count as these entries
  for (const cat of GRADING_CATEGORIES.filter(c => c.multi)) {
    const re = new RegExp(`^${cat.id}\\d+_percentage$`);
    const oldGradeUids = Object.entries(existMap)
      .filter(([k]) => re.test(k) || k === cat.legacyKey)
      .map(([, r]) => r.row_uid);
    toDelete.push(...oldGradeUids);

    const newGradeRows = [];
    const kept = new Set();
    let i = 0;
    document.querySelectorAll(`tr.grading-row[data-cat="${cat.id}"]`).forEach(tr => {
      const val = tr.querySelector('.grade-val-multi')?.value?.trim() || '';
      const done = tr.querySelector('.grade-done-multi')?.value || '';
      if (!val) return;
      const key = `${cat.id}${++i}_percentage`;
      newGradeRows.push({ ...base, row_uid: newCourseRowUid(), row_index: ++gradeRowIdx, b: key, c: val, d: done });
      const orig = tr.dataset.origKey;
      if (orig) { kept.add(orig); if (orig !== key) keyMap[orig] = key; }
    });
    // Entries removed (or emptied): exams that counted as them become Custom.
    for (const k of Object.keys(existMap)) if ((re.test(k) || k === cat.legacyKey) && !kept.has(k)) keyMap[k] = '';
    toUpsert.push(...newGradeRows);
  }

  const { error } = await saveCourseRows(toUpsert, toDelete);
  if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
  if (typeof followGradingKeys === 'function') await followGradingKeys(S.course, S.isArchive, keyMap);

  toast('Grading saved', 'ok');
  resetBtn();
  rememberSavedSection();
  return true;
}

async function loadMetadataSettings() {
  const course = S.course, isArchive = S.isArchive;
  const { data, error } = await sb.from('course_rows').select('*')
    .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata')
    .order('row_index');
  const body = document.getElementById('section-body');
  if (!body || S.course !== course || S.isArchive !== isArchive || S.section !== 'info') return;
  if (error) { body.innerHTML = `<div class="empty-content">Error: ${x(error.message)}</div>`; return; }

  const metaMap = {}, extras = [];
  for (const r of (data || [])) {
    ROW_STORE[r.row_uid] = r;
    if (isKnownMetaKey(r.b)) metaMap[r.b] = r;
    else extras.push(r);
  }

  if (!metaMap['year']?.c && metaMap['startdate']?.c) {
    const parts = String(metaMap['startdate'].c).split('-');
    const yr = parseInt(parts[0]), mo = parseInt(parts[1]);
    if (!isNaN(yr) && !isNaN(mo) && yr > 2000) {
      const derived = mo >= 9 ? `${yr}–${yr + 1}` : `${yr - 1}–${yr}`;
      metaMap['year'] = { c: derived };
    }
  }

  const themeStr = metaMap['theme_colours']?.c || '';
  const themeParts = themeStr.split(',').map(s => s.trim());

  const v = k => x(metaMap[k]?.c || '');
  const vDate = k => { const s = metaMap[k]?.c || ''; if (!s) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const d = new Date(s); if (!isNaN(d)) return d.toISOString().slice(0, 10); return ''; };

  let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
    ${tabMenuHtml('info')}
  </div><div class="settings-panel">`;

  // ── Course Identity ──
  h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-id-card"></i>Course Identity</span></div>
    <div class="settings-body"><div class="sg-grid">
      <div class="form-group">
        <label class="form-label">Course Code</label>
        <input type="text" class="meta-field" data-metakey="code" value="${v('code')}">
      </div>
      <div class="form-group">
        <label class="form-label">Title</label>
        <input type="text" class="meta-field" data-metakey="title" value="${v('title')}">
      </div>
      <div class="form-group">
        <label class="form-label">Academic Year</label>
        <input type="text" class="meta-field" data-metakey="year" value="${v('year')}" oninput="onYearInput(this)" onblur="normalizeYearField(this)">
      </div>
      <div class="form-group">
        <label class="form-label">Semester</label>
        <select class="meta-field" data-metakey="semester">
          ${['', 'Fall Semester', 'Spring Semester', 'Summer Semester'].map(o => `<option value="${x(o)}"${(metaMap['semester']?.c || '') === (o) ? ` selected` : ''}>${o || '—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Level</label>
        <select class="meta-field" data-metakey="level">
          ${['', 'Undergraduate', 'Graduate', 'Integrated Second Cycle', 'Postgraduate'].map(o => `<option value="${x(o)}"${(metaMap['level']?.c || '') === (o) ? ` selected` : ''}>${o || '—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select class="meta-field" data-metakey="type">
          ${['', 'Compulsory', 'Elective', 'Optional'].map(o => `<option value="${x(o)}"${(metaMap['type']?.c || '') === (o) ? ` selected` : ''}>${o || '—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Credits (ECTS)</label>
        <input type="number" class="meta-field" data-metakey="credits" min="1" max="10" step="1" value="${v('credits')}">
      </div>
    </div></div>
  </div>`;

  // ── Dates ──
  h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-calendar-days"></i>Dates</span></div>
    <div class="settings-body"><div class="sg-grid">
      <div class="form-group">
        <label class="form-label">Start Date</label>
        <input type="date" class="meta-field" data-metakey="startdate" value="${vDate('startdate')}">
      </div>
      <div class="form-group">
        <label class="form-label">End Date</label>
        <input type="date" class="meta-field" data-metakey="enddate" value="${vDate('enddate')}">
      </div>
      <div class="form-group">
        <label class="form-label">Holiday Weeks</label>
        <input type="number" class="meta-field" data-metakey="holidayweeks" min="0" max="2" step="1" value="${v('holidayweeks') || '0'}">
      </div>
      <div class="form-group">
        <label class="form-label">Holiday Start Date</label>
        <input type="date" class="meta-field" data-metakey="holiday_startdate" value="${vDate('holiday_startdate')}">
      </div>
    </div></div>
  </div>`;

  // ── Appearance ──
  const hdVal = metaMap['header_decoration']?.c || '';
  const tpTitle = metaMap['title']?.c || metaMap['code']?.c || S.course;
  const tpSub = [metaMap['code']?.c, metaMap['semester']?.c].filter(Boolean).join(' · ') || 'Course page preview';
  h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-palette"></i>Appearance</span></div>
    <div class="settings-body">
      <div class="form-group">
        <label class="form-label">Header Icon <span class="form-hint" style="display:inline;margin-left:6px">Font Awesome class or &lt;i&gt; tag · e.g. fa-solid fa-tent-arrows-down</span></label>
        <div class="icon-input-wrap">
          <input type="text" class="meta-field" data-metakey="header_decoration" value="${x(hdVal)}"
                 data-fa-icon data-fa-preview="tp-icon" spellcheck="false" autocomplete="off">
          <span class="fa-preview" style="font-size:1.8em;width:32px;color:var(--primary-color)">${faIconHtml(hdVal)}</span>
          <a class="icon-find-link" href="${FA_SEARCH_URL}" target="_blank" rel="noopener noreferrer" title="Find an icon on Font Awesome"><i class="fa-solid fa-magnifying-glass"></i></a>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Theme Colours <span class="form-hint" style="display:inline;margin-left:6px">pick a swatch or type a hex value</span></label>
        <div class="color-picker-row">
          ${THEME_COLOR_NAMES.map((name, i) => {
    const val = /^#[0-9a-f]{6}$/i.test(themeParts[i] || '') ? themeParts[i] : THEME_COLOR_DEFAULTS[i];
    return `<div class="color-picker-item">
              <input type="color" id="tc_${i}" value="${val}" oninput="onThemeSwatchInput(${i})">
              <input type="text" class="tc-hex" id="tcx_${i}" value="${val}" maxlength="7" spellcheck="false" autocomplete="off"
                     oninput="onThemeHexInput(${i})" onblur="normalizeThemeHexInput(${i})">
              <span class="color-label">${name}</span>
            </div>`;
  }).join('')}
        </div>
        <input type="hidden" class="meta-field" data-metakey="theme_colours" id="theme_colours_field" value="${x(themeStr)}">
        <div class="theme-preview" id="theme-preview">
          <div class="tp-header">
            <span id="tp-icon" class="fa-preview" data-fallback="fa-solid fa-graduation-cap" style="font-size:1.5em;width:26px">${faIconHtml(hdVal, 'fa-solid fa-graduation-cap')}</span>
            <div class="tp-head-text">
              <div class="tp-title">${x(tpTitle)}</div>
              <div class="tp-sub">${x(tpSub)}</div>
            </div>
            <span class="tp-chip"><i class="fa-regular fa-clock" style="margin-right:4px"></i>Timetable</span>
          </div>
          <div class="tp-body">
            <div class="tp-module"><i class="fa-solid fa-layer-group"></i>Module — Lecture Slides</div>
            <div class="tp-row">
              <span class="tp-pill" style="background:var(--tp-primary,#3949ab)">Primary</span>
              <span class="tp-pill" style="background:var(--tp-secondary,#ffa726)">Secondary</span>
              <span class="tp-pill" style="background:var(--tp-tertiary,#2196f3)">Tertiary</span>
              <span class="tp-pill" style="background:var(--tp-accent,#9c27b0)">Accent</span>
              <span class="tp-pill" style="background:var(--tp-success,#43a047)">Success</span>
            </div>
          </div>
        </div>
        <div class="form-hint" style="margin-top:6px">Live preview of the public course page with these colours · <button type="button" class="link-btn" onclick="resetThemeColours()">reset to default colours</button></div>
      </div>
    </div>
  </div>`;

  // ── Lecturers: the accounts assigned to this course in Settings (read-only here) ──
  const assigned = COURSE_LECTURERS.get(JSON.stringify([S.course, S.isArchive])) || [];
  h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-user-tie"></i>Lecturers</span>
      ${canManageLecturerAssignments() ? `<button type="button" class="btn-circle" onclick="openAccessSettings()" title="Manage in Settings" aria-label="Manage in Settings"><i class="fa-solid fa-gear" aria-hidden="true"></i></button>` : ''}
    </div>
    <div class="settings-body">
      ${assigned.length ? `<div class="info-lecturers">${assigned.map(l =>
    `<span class="info-lecturer">${userAvatar(l.name, safeCourseUrl(l.photo), 'info-lecturer-avatar')}${x(l.name)}</span>`).join('')}</div>`
      : '<div class="form-hint">No lecturers assigned yet.</div>'}
      <div class="form-hint">Lecturers are the accounts assigned to this course in Settings. Their names and photos come from their profiles.</div>
    </div>
  </div>`;

  h += `</div>`;

  if (extras.length) {
    h += `<div style="margin-top:18px;margin-bottom:8px;font-size:0.72em;font-weight:700;color:#9e9e9e;text-transform:uppercase;letter-spacing:0.07em">Custom / Other Keys</div>`;
    for (const r of extras) {
      h += `<div class="material-card" data-custom-key="${x(r.b)}">
        <div class="card-main">
          <div class="card-title">${x(r.b)}</div>
          ${r.c ? `<div class="card-detail">${x(r.c.substring(0, 100))}</div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn-secondary btn-sm" onclick="openEditCustomMeta('${xjs(r.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
          <button class="btn-red btn-sm" onclick="deleteRow('${xjs(r.row_uid)}')"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
        </div>
      </div>`;
    }
  }

  body.innerHTML = h;
  finishSectionLoad(body);
  updateThemePreview();
}

const canManageLecturerAssignments = () => isCourseAdmin();

function updateDynamicCardLabel(input, fallback) {
  const lbl = input.closest('.dynamic-card')?.querySelector('.dcl-text');
  if (lbl) lbl.textContent = input.value.trim() || fallback;
}

// Preview and Hide work as in the timetable admin: Preview shows the timetable from the
// IDs typed here, and a hidden timetable stays saved but off the course page.
function timetableCardHtml(n, metaMap) {
  const name = metaMap[`timetable${n}_name`]?.c || '';
  const tid = metaMap[`timetable${n}_id`]?.c || '';
  const classId = metaMap[`class${n}_id`]?.c || '';
  const hidden = metaMap[`timetable${n}_hidden`]?.c === '1';
  return `<div class="dynamic-card timetable-card${hidden ? ' is-hidden' : ''}">
    <div class="dynamic-card-head">
      <span class="dynamic-card-label"><i class="fa-solid fa-clock" style="margin-right:5px;opacity:0.7"></i><span class="dcl-text">${x(name || 'New Timetable')}</span><span class="badge tt-hidden-badge">Hidden</span></span>
      <span class="dynamic-card-actions">
        ${timetablePreviewButtonHtml(false)}
        ${timetableHideButtonHtml(hidden)}
        <button class="btn-action-del" type="button" onclick="removeTimetableCard(this)" title="Delete timetable" aria-label="Delete timetable"><i class="fa-solid fa-trash"></i></button>
      </span>
    </div>
    <div class="dynamic-card-body sg-grid3">
      <div class="form-group">
        <label class="form-label">Name</label>
        <input type="text" name="tt_name" value="${x(name)}" oninput="updateDynamicCardLabel(this,'New Timetable')">
      </div>
      <div class="form-group">
        <label class="form-label">Timetable ID</label>
        <input type="text" name="tt_id" value="${x(tid)}" inputmode="numeric" onchange="refreshTimetablePreview(this)">
      </div>
      <div class="form-group">
        <label class="form-label">Class ID</label>
        <input type="text" name="tt_class" value="${x(classId)}" inputmode="numeric" onchange="refreshTimetablePreview(this)">
      </div>
      <input type="hidden" name="tt_hidden" value="${hidden ? '1' : ''}">
    </div>
    <div class="table-container tt-preview"><div class="tt-inner"></div></div>
  </div>`;
}

function timetablePreviewButtonHtml(open) {
  const label = open ? 'Close preview' : 'Preview timetable';
  return `<button class="btn-action-test" type="button" data-tt-preview onclick="toggleTimetablePreview(this)" title="${label}" aria-label="${label}" aria-expanded="${open}"><i class="fa-solid ${open ? 'fa-calendar-xmark' : 'fa-calendar-week'}" aria-hidden="true"></i></button>`;
}

function timetableHideButtonHtml(hidden) {
  const label = hidden ? 'Hidden from the course page — click to show' : 'Shown on the course page — click to hide';
  return `<button class="btn-action-vis" type="button" data-tt-hide onclick="toggleTimetableHidden(this)" title="${label}" aria-label="${label}" aria-pressed="${hidden}"><i class="fa-solid ${hidden ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i></button>`;
}

function toggleTimetableHidden(button) {
  const card = button.closest('.timetable-card');
  const input = card.querySelector('[name=tt_hidden]');
  const hidden = input.value !== '1';
  input.value = hidden ? '1' : '';
  card.classList.toggle('is-hidden', hidden);
  button.outerHTML = timetableHideButtonHtml(hidden);
  markDirty(); // a programmatic value change fires no input event
}

async function toggleTimetablePreview(button, refresh = false) {
  const card = button.closest('.timetable-card');
  const container = card.querySelector('.tt-preview');
  const inner = container.querySelector('.tt-inner');
  if (container.classList.contains('visible') && !refresh) {
    hideTtPopover();
    container.classList.remove('visible');
    button.outerHTML = timetablePreviewButtonHtml(false);
    return;
  }
  if (!refresh) button.outerHTML = timetablePreviewButtonHtml(true);
  container.classList.add('visible');
  const tId = card.querySelector('[name=tt_id]').value.trim();
  const cId = card.querySelector('[name=tt_class]').value.trim();
  const key = `${tId}:${cId}`;
  card.dataset.previewKey = key;
  if (!/^\d+$/.test(tId) || !/^\d+$/.test(cId)) {
    inner.innerHTML = '<div class="tt-error">Enter the Timetable ID and Class ID (numbers) to preview.</div>';
    return;
  }
  inner.innerHTML = '<div class="iframe-loader"></div>';
  // The course page's request: on a lecturer website the proxy checks that lecturer's ID.
  const url = `${SUPABASE_URL}/functions/v1/eis-timetable?tId=${encodeURIComponent(tId)}&cId=${encodeURIComponent(cId)}` +
    (EMBEDDED_ADMIN_SITE ? '&lecturer=' + encodeURIComponent(EMBEDDED_ADMIN_SITE.id) : '');
  let html = '';
  try {
    const response = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch {
    html = '<div class="tt-error">Could not load the timetable. Try again later.</div>';
  }
  // Closed, or other IDs typed, while this one loaded.
  if (card.dataset.previewKey !== key || !container.classList.contains('visible')) return;
  if (!html.includes('<table')) {
    inner.innerHTML = html.includes('tt-error') ? DOMPurify.sanitize(html) : '<div class="tt-error">No timetable found for these IDs.</div>';
    return;
  }
  // FORCE_BODY keeps the fragment's <style> (its colours), which DOMPurify drops otherwise.
  inner.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
  fitTimetable(container);
}

// Changed IDs reload an open preview.
function refreshTimetablePreview(input) {
  const card = input.closest('.timetable-card');
  if (card.querySelector('.tt-preview').classList.contains('visible')) toggleTimetablePreview(card.querySelector('[data-tt-preview]'), true);
}

// The previews' cell popovers, and their fit when the window resizes.
wireTimetableTooltips(document.getElementById('main-area'));
window.addEventListener('resize', () => {
  document.querySelectorAll('.tt-preview.visible').forEach(container => {
    if (container.querySelector('table')) fitTimetable(container);
  });
}, { passive: true });

function addTimetableCard() {
  const list = document.getElementById('timetables-list');
  const noMsg = list.querySelector('#no-tt-msg');
  if (noMsg) noMsg.remove();
  list.insertAdjacentHTML('beforeend', timetableCardHtml(0, {}));
}

function removeTimetableCard(btn) {
  btn.closest('.dynamic-card').remove();
  const list = document.getElementById('timetables-list');
  if (!list.querySelector('.dynamic-card')) {
    list.insertAdjacentHTML('beforeend', `<div id="no-tt-msg" class="form-hint" style="padding:4px 0">No timetables yet.</div>`);
  }
}

// ── Date/time conversion: "DD-MM-YYYY, HH:mm" ↔ "YYYY-MM-DDTHH:mm" ──
function toIsoDatetime(str) {
  if (!str) return '';
  const m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})[,\s]+(\d{1,2}):(\d{2})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}`;
  return '';
}
function fromIsoDatetime(str) {
  if (!str) return '';
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}, ${m[4]}:${m[5]}`;
  return str;
}

// ── Link preview button ──
function updateLinkPreview(inp, btn) {
  if (typeof btn === 'string') btn = document.getElementById(btn);
  if (!btn) return;
  const url = inp.value.trim();
  btn.href = safeCourseUrl(url) || '#';
  btn.style.display = url ? 'flex' : 'none';
}
function updatePhotoPreview(inp, img) {
  if (!img) return;
  const url = inp.value.trim();
  img.src = safeCourseUrl(url) || '';
  img.style.display = url ? 'block' : 'none';
}

// ── Autofill Google Drive / OneDrive links ──
function autofillDriveLink(inp, force = false) {
  const url = inp.value.trim();
  if (!url) return;
  let viewUrl = '', dlUrl = '';

  // Google Drive file (PDF, PPTX, etc.)
  let m = url.match(/drive\.google\.com\/file\/d\/([^\/\?&#]+)/);
  if (m) {
    const id = m[1];
    viewUrl = `https://drive.google.com/file/d/${id}/preview`;
    dlUrl = `https://drive.google.com/uc?export=download&id=${id}`;
  }
  // Google Docs
  if (!viewUrl) {
    m = url.match(/docs\.google\.com\/document\/d\/([^\/\?&#]+)/);
    if (m) { const id = m[1]; viewUrl = `https://docs.google.com/document/d/${id}/preview`; dlUrl = `https://docs.google.com/document/d/${id}/export?format=pdf`; }
  }
  // Google Sheets
  if (!viewUrl) {
    m = url.match(/docs\.google\.com\/spreadsheets\/d\/([^\/\?&#]+)/);
    if (m) { const id = m[1]; viewUrl = `https://docs.google.com/spreadsheets/d/${id}/preview`; dlUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`; }
  }
  // Google Slides
  if (!viewUrl) {
    m = url.match(/docs\.google\.com\/presentation\/d\/([^\/\?&#]+)/);
    if (m) { const id = m[1]; viewUrl = `https://docs.google.com/presentation/d/${id}/preview`; dlUrl = `https://docs.google.com/presentation/d/${id}/export/pptx`; }
  }
  // Google Drive open?id=...
  if (!viewUrl) {
    m = url.match(/drive\.google\.com\/open\?id=([^&]+)/);
    if (m) { const id = m[1]; viewUrl = `https://drive.google.com/file/d/${id}/preview`; dlUrl = `https://drive.google.com/uc?export=download&id=${id}`; }
  }
  // OneDrive 1drv.ms / onedrive.live.com
  if (!viewUrl && (url.includes('1drv.ms') || url.includes('onedrive.live.com'))) {
    viewUrl = url; dlUrl = url.replace(/\?.*$/, '').replace(/embed$/, 'download');
  }
  // SharePoint / OneDrive for Business
  if (!viewUrl && url.includes('sharepoint.com')) {
    viewUrl = url.includes('?') ? url + '&web=1' : url + '?web=1'; dlUrl = url;
  }

  if (!viewUrl) {
    if (force) toast('Unrecognised link, use a Google Drive or OneDrive URL', 'err');
    return;
  }
  const viewEl = document.getElementById('mf_e');
  const dlEl = document.getElementById('mf_f');
  if (viewEl) { viewEl.value = viewUrl; updateLinkPreview(viewEl, 'lp_e'); }
  if (dlEl) { dlEl.value = dlUrl; updateLinkPreview(dlEl, 'lp_f'); }
  toast('View & Download links filled', 'ok');
}

// ── Google Drive Picker ──
// Browse Drive instead of pasting a link. Sign-in grants no Drive scope, so the GIS token
// client asks for one (consent the first time only). The picked file then goes through
// autofillDriveLink(), like a pasted link.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GOOGLE_API_KEY = window.TEACHING_CONFIG.googleApiKey || '';
const GOOGLE_APP_ID = String(GOOGLE_CLIENT_ID).split('-')[0]; // project number = numeric client-id prefix
let _driveToken = null;         // { value, expiresAt }
let _driveTokenClient = null;
let _pickerApiLoaded = false;
let _pickerScrollY = 0;
let _pickerScrollLocked = false;

// Freeze the page while the picker is up, so Google's window.scrollTo can't move it.
function lockPickerScroll() {
  if (_pickerScrollLocked) return;
  _pickerScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${_pickerScrollY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  _pickerScrollLocked = true;
}

function unlockPickerScroll() {
  if (!_pickerScrollLocked) return;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  window.scrollTo(0, _pickerScrollY);
  _pickerScrollLocked = false;
}

function loadPickerApi() {
  return new Promise((resolve, reject) => {
    if (_pickerApiLoaded) return resolve();
    if (!window.gapi) return reject(new Error('Google API not loaded yet — try again in a moment'));
    gapi.load('picker', {
      callback: () => { _pickerApiLoaded = true; resolve(); },
      onerror: () => reject(new Error('Drive picker failed to load')),
    });
  });
}

function getDriveToken() {
  return new Promise((resolve, reject) => {
    // Reuse a still-valid token (with a 60s safety margin) to avoid re-prompting.
    if (_driveToken && _driveToken.expiresAt > Date.now() + 60000) return resolve(_driveToken.value);
    if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in not loaded yet'));
    if (!_driveTokenClient) {
      _driveTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID, scope: DRIVE_SCOPE, callback: () => { },
      });
    }
    // Reassign per call so this Promise gets the result; empty prompt = silent when
    // already granted, consent only on first use.
    _driveTokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      _driveToken = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) * 1000) };
      resolve(resp.access_token);
    };
    // hint = the signed-in admin's email so Google skips the account chooser and
    // reuses the already-signed-in account instead of asking every time.
    _driveTokenClient.requestAccessToken({ prompt: '', hint: S.admin?.email || '' });
  });
}

async function openDrivePicker(inp) {
  if (!inp) return;
  try {
    const [token] = await Promise.all([getDriveToken(), loadPickerApi()]);
    // Tabs as in Google's picker: Recent, My Drive (a plain DocsView; setEnableDrives would
    // turn it into Shared drives) and Shared drives.
    const myDrive = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true).setSelectFolderEnabled(false);
    const sharedDrives = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(false);
    // Size the dialog to the viewport (CSS also clamps it), so it stays usable on
    // phones instead of overflowing at Google's fixed default size.
    const w = Math.min(1051, Math.max(320, Math.floor(window.innerWidth * 0.95)));
    const h = Math.min(650, Math.max(380, Math.floor(window.innerHeight * 0.9)));
    const builder = new google.picker.PickerBuilder()
      .setAppId(GOOGLE_APP_ID)
      .setOrigin(window.location.protocol + '//' + window.location.host)
      .setOAuthToken(token)
      .addView(google.picker.ViewId.RECENTLY_PICKED)
      .addView(myDrive)
      .addView(sharedDrives)
      .setSize(w, h)
      .setCallback((data) => onDrivePicked(data, inp));
    if (GOOGLE_API_KEY) builder.setDeveloperKey(GOOGLE_API_KEY);
    lockPickerScroll();          // freeze the page before the dialog appears
    builder.build().setVisible(true);
  } catch (e) {
    unlockPickerScroll();
    toast('Could not open Google Drive: ' + e.message, 'err');
  }
}

function onDrivePicked(data, inp) {
  // The picker occasionally leaves the busy cursor set after LOADED fires; clear it
  // defensively on every callback so it can't get stuck once the dialog is up.
  document.body.style.cursor = '';
  if (!data) return;
  // LOADED just means the dialog rendered — keep the scroll lock in place. Any other
  // terminal action (PICKED / CANCEL) closes the dialog, so release the page then.
  if (data.action === google.picker.Action.LOADED) return;
  unlockPickerScroll();
  if (data.action !== google.picker.Action.PICKED) return;
  const doc = data.docs && data.docs[0];
  if (!doc) return;
  inp.value = doc.url || `https://drive.google.com/file/d/${doc.id}/view`;
  autofillDriveLink(inp, true); // reuse the paste path to fill View/Download links
}

function syncThemeColourField() {
  const vals = [0, 1, 2, 3, 4].map(i => {
    const el = document.getElementById('tc_' + i);
    return el ? el.value : '';
  });
  const field = document.getElementById('theme_colours_field');
  if (field) field.value = vals.join(', ');
}

// Accepts "#abc", "abc", "#aabbcc" or "aabbcc"; returns canonical "#aabbcc" or null.
function normalizeHexColour(s) {
  s = String(s || '').trim().replace(/^#?/, '#');
  if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + [...s.slice(1)].map(c => c + c).join('');
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function onThemeSwatchInput(i) {
  const sw = document.getElementById('tc_' + i);
  const tx = document.getElementById('tcx_' + i);
  if (sw && tx) { tx.value = sw.value; tx.classList.remove('invalid'); }
  syncThemeColourField();
  updateThemePreview();
}

// Hex typed → only mirror into the swatch once it parses; flag it red while it doesn't.
function onThemeHexInput(i) {
  const tx = document.getElementById('tcx_' + i);
  if (!tx) return;
  const hex = normalizeHexColour(tx.value);
  tx.classList.toggle('invalid', !hex);
  if (!hex) return;
  const sw = document.getElementById('tc_' + i);
  if (sw) sw.value = hex;
  syncThemeColourField();
  updateThemePreview();
}

// On blur, snap the hex box back to the swatch's canonical value (fixes half-typed input).
function normalizeThemeHexInput(i) {
  const tx = document.getElementById('tcx_' + i);
  const sw = document.getElementById('tc_' + i);
  if (tx && sw) { tx.value = sw.value; tx.classList.remove('invalid'); }
}

function resetThemeColours() {
  THEME_COLOR_DEFAULTS.forEach((hex, i) => {
    const sw = document.getElementById('tc_' + i);
    if (sw) sw.value = hex;
    const tx = document.getElementById('tcx_' + i);
    if (tx) { tx.value = hex; tx.classList.remove('invalid'); }
  });
  syncThemeColourField();
  updateThemePreview();
  markDirty(); // programmatic value changes don't fire the delegated input listener
}

// Repaints the mini course-page mock from the current picker values via its --tp-* props.
function updateThemePreview() {
  const prev = document.getElementById('theme-preview');
  if (!prev) return;
  const vals = [0, 1, 2, 3, 4].map(i => document.getElementById('tc_' + i)?.value || THEME_COLOR_DEFAULTS[i]);
  prev.style.setProperty('--tp-primary', vals[0]);
  prev.style.setProperty('--tp-primary-dark', darkenHex(vals[0], 0.25));
  prev.style.setProperty('--tp-secondary', vals[1]);
  prev.style.setProperty('--tp-tertiary', vals[2]);
  prev.style.setProperty('--tp-accent', vals[3]);
  prev.style.setProperty('--tp-success', vals[4]);
}

function updateGradeTotal() {
  const inputs = document.querySelectorAll('.grade-val, .grade-val-multi');
  let t = 0;
  inputs.forEach(i => t += parseFloat(i.value) || 0);
  const el = document.getElementById('grade-total');
  if (el) {
    el.textContent = t;
    el.style.color = Math.abs(t - 100) < 0.01 ? 'var(--success-color)' : (t > 100 ? 'var(--danger-color)' : 'var(--primary-color)');
  }
}

function gradingCatHeadHtml(cat, withAdd) {
  return `<tr class="grading-cat-head" data-cat="${cat.id}">
      <td colspan="4"><i class="${cat.icon}" style="margin-right:6px;opacity:0.6;width:14px;text-align:center;display:inline-block"></i>${x(cat.label)}</td>
      <td class="gt-del">${withAdd ? `<button type="button" class="btn-secondary btn-icon" onclick="addGradingRow('${cat.id}')" title="Add ${x(cat.label)}"><i class="fa-solid fa-plus"></i></button>` : ''}</td>
    </tr>`;
}

function gradingRowHtml(catId, label, key, row) {
  const val = row?.c || '';
  const done = row?.d || '';
  // data-orig-key: the saved key, so exams can follow when the entries are renumbered.
  return `<tr class="grading-row" data-cat="${x(catId)}"${row ? ` data-orig-key="${x(key)}"` : ''}>
      <td class="gt-label">${x(label)}</td>
      <td class="gt-pct"><input type="number" min="0" max="100" class="grade-val-multi" data-key="${x(key)}" value="${x(val)}" oninput="updateGradeTotal()"></td>
      <td class="gt-unit">%</td>
      <td class="gt-done"><select class="grade-done-multi" data-donekey="${x(key)}">
        <option value=""${done === '' ? ' selected' : ''}>—</option>
        <option value="Done"${done === 'Done' ? ' selected' : ''}>Done</option>
      </select></td>
      <td class="gt-del"><button type="button" class="btn-red btn-icon" onclick="removeGradingRow(this)" title="Remove"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
}

// Fixed (non-multi) categories — e.g. Final, Attendance — get a header for visual parity
// with the multi-entry categories, but their single row has no add/remove controls.
function fixedGradingRowHtml(cat, row) {
  const val = row?.c || '';
  const done = row?.d || '';
  return `<tr>
      <td class="gt-label">${x(cat.label)}</td>
      <td class="gt-pct"><input type="number" min="0" max="100" class="grade-val" data-key="${x(cat.key)}" value="${x(val)}" oninput="updateGradeTotal()"></td>
      <td class="gt-unit">%</td>
      <td class="gt-done"><select class="grade-done" data-donekey="${x(cat.key)}">
        <option value=""${done === '' ? ' selected' : ''}>—</option>
        <option value="Done"${done === 'Done' ? ' selected' : ''}>Done</option>
      </select></td>
      <td class="gt-del"></td>
    </tr>`;
}

function renderGradingRows(metaMap) {
  let total = 0;
  let html = '';
  for (const cat of GRADING_CATEGORIES) {
    if (!cat.multi) {
      const row = metaMap[cat.key];
      total += parseFloat(row?.c || '') || 0;
      html += gradingCatHeadHtml(cat, false);
      html += fixedGradingRowHtml(cat, row);
      continue;
    }
    html += gradingCatHeadHtml(cat, true);
    const entries = gradingEntriesFor(cat, metaMap);
    entries.forEach((e, i) => {
      const row = metaMap[e.key];
      total += parseFloat(row?.c || '') || 0;
      // Only number entries once there are 2+ (e.g. "Quiz" alone, but "Quiz 1"/"Quiz 2" when there are several).
      const label = entries.length > 1 ? `${cat.label} ${i + 1}` : cat.label;
      html += gradingRowHtml(cat.id, label, e.key, row);
    });
  }
  return { html, total };
}

function relabelGradingCategory(catId) {
  const cat = GRADING_CATEGORIES.find(c => c.id === catId);
  if (!cat) return;
  const rows = document.querySelectorAll(`tr.grading-row[data-cat="${catId}"]`);
  rows.forEach((row, i) => {
    const labelCell = row.querySelector('.gt-label');
    if (labelCell) labelCell.textContent = rows.length > 1 ? `${cat.label} ${i + 1}` : cat.label;
  });
}

function addGradingRow(catId) {
  const cat = GRADING_CATEGORIES.find(c => c.id === catId);
  if (!cat) return;
  const head = document.querySelector(`tr.grading-cat-head[data-cat="${catId}"]`);
  if (!head) return;
  const rows = document.querySelectorAll(`tr.grading-row[data-cat="${catId}"]`);
  const n = rows.length + 1;
  const html = gradingRowHtml(catId, cat.label, `${catId}${n}_percentage`, null);
  const last = rows.length ? rows[rows.length - 1] : head;
  last.insertAdjacentHTML('afterend', html);
  relabelGradingCategory(catId);
  updateGradeTotal();
}

function removeGradingRow(btn) {
  const tr = btn.closest('tr');
  const catId = tr.dataset.cat;
  tr.remove();
  relabelGradingCategory(catId);
  updateGradeTotal();
}

async function saveSettings() {
  if (!requirePermission(canEditSection('info'))) return false;
  const btn = document.getElementById('section-save-btn');
  const origHtml = btn ? btn.innerHTML : '';
  const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = origHtml; } };
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }

  const { data: existing, error: fetchError } = await sb.from('course_rows').select('*')
    .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata');
  if (fetchError) { toast('Save failed: ' + fetchError.message, 'err'); resetBtn(); return false; }
  const existMap = {};
  let maxIdx = 0;
  for (const r of (existing || [])) { existMap[r.b] = r; if (r.row_index > maxIdx) maxIdx = r.row_index; }

  const toUpsert = [];
  const base = { sheet_name: S.course, is_archive: S.isArchive, type: 'metadata', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };

  const pushField = (key, val, extra = {}) => {
    if (!val && !existMap[key]) return;
    const uid = existMap[key]?.row_uid || newCourseRowUid();
    const idx = existMap[key]?.row_index || (maxIdx += 10, maxIdx);
    toUpsert.push({ ...base, row_uid: uid, row_index: idx, b: key, c: val, ...extra });
  };

  for (const inp of document.querySelectorAll('.meta-field')) {
    const key = inp.dataset.metakey;
    if (!key || !canEditMetadata(key)) continue;
    pushField(key, key === 'header_decoration' ? faIconClass(inp.value) : inp.value.trim());
  }

  const { error } = await saveCourseRows(toUpsert, []);
  if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }

  // Timetables and Grading save separately (saveTimetablesWork/saveGradingSettings), not here.

  toast('Settings saved', 'ok');
  resetBtn();
  rememberSavedSection();
  await loadSidebar();
  await fillCourseHeader(S.course, S.isArchive);
  return true;
}

function openEditCustomMeta(uid) {
  if (!requirePermission(canEditMetadata(ROW_STORE[uid]?.b))) return;
  const row = ROW_STORE[uid];
  if (!row) return;
  document.getElementById('modal-title').textContent = 'Edit: ' + row.b;
  document.getElementById('modal-body').innerHTML = `
    <input type="hidden" id="m_uid" value="${x(row.row_uid)}">
    <input type="hidden" id="m_sheet" value="${x(row.sheet_name)}">
    <input type="hidden" id="m_archive" value="${row.is_archive}">
    <input type="hidden" id="m_index" value="${row.row_index}">
    <input type="hidden" id="m_type" value="_custom">
    <div class="form-group"><label class="form-label">Key</label><input type="text" id="mf_b" value="${x(row.b)}" ${isCourseAdmin() ? '' : 'disabled'}></div>
    <div class="form-group"><label class="form-label">Value</label><input type="text" id="mf_c" value="${x(row.c || '')}"></div>
    <div class="form-group"><label class="form-label">Status (col D)</label><input type="text" id="mf_d" value="${x(row.d || '')}"></div>
  `;
  FIELDS['_custom'] = [{ col: 'b' }, { col: 'c' }, { col: 'd' }];
  document.getElementById('modal-foot').style.display = '';
  // The shared modal's button keeps the last dialog's label (New course, Copy) otherwise.
  document.getElementById('modal-save').innerHTML = '<i class="fa-solid fa-check" style="margin-right:5px"></i>Save';
  document.getElementById('modal-save').onclick = modalSave;
  document.getElementById('modal-overlay').classList.add('open');
}

// ─────────────────────────────────────────────────────────────────────────────
// Module hierarchy (modules + materials + funfacts)
// ─────────────────────────────────────────────────────────────────────────────

// ── Row actions ──────────────────────────────────────────────────────────
// Every row shows at most a quiet Edit, an "Add" menu when it holds items, and a ⋯ menu
// for everything else (Delete lives there, so it is never one stray tap away). Menus are
// part of the row, so their actions find the row with closest('[data-uid]'); they are
// positioned with fixed coordinates so rounded, clipped containers never cut them off.
function rowEditBtn(uid, label = 'Edit') {
  return `<button type="button" class="row-edit-btn" title="${label}" aria-label="${label}" onclick="openInlineEdit('${xjs(uid)}')"><i class="fa-solid fa-pen" aria-hidden="true"></i><span>Edit</span></button>`;
}

function rowMenuHtml(items, { text = '', label = 'More actions' } = {}) {
  return `<div class="row-menu">
    <button type="button" class="row-menu-btn${text ? ' has-text' : ''}" aria-haspopup="menu" aria-expanded="false" aria-label="${label}" title="${label}"
      onclick="toggleRowMenu(this)">${text ? `<span>${text}</span><i class="fa-solid fa-chevron-down row-menu-caret" aria-hidden="true"></i>` : '<i class="fa-solid fa-ellipsis" aria-hidden="true"></i>'}</button>
    <div class="row-menu-list" role="menu" hidden>${items.map(item =>
    `<button type="button" role="menuitem"${item.danger ? ' class="is-danger"' : ''} onclick="closeRowMenus();${item.action}"><i class="${item.icon}" aria-hidden="true"></i>${item.label}</button>`).join('')}</div>
  </div>`;
}

const DELETE_ITEM = { label: 'Delete', icon: 'fa-solid fa-trash', danger: true, action: 'stageDeleteRow(this)' };

function toggleRowMenu(button) {
  const list = button.nextElementSibling;
  const opening = list.hidden;
  closeRowMenus();
  if (!opening) return;
  list.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  const r = button.getBoundingClientRect();
  const width = list.offsetWidth, height = list.offsetHeight;
  list.style.left = `${Math.max(8, Math.min(r.right - width, innerWidth - width - 8))}px`;
  list.style.top = `${r.bottom + 6 + height > innerHeight - 8 ? r.top - 6 - height : r.bottom + 6}px`;
  list.querySelector('button:not(:disabled)')?.focus();
}

function closeRowMenus() {
  document.querySelectorAll('.row-menu-list:not([hidden])').forEach(list => {
    list.hidden = true;
    list.previousElementSibling?.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', event => { if (!event.target.closest('.row-menu')) closeRowMenus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeRowMenus(); });
window.addEventListener('scroll', closeRowMenus, { passive: true });
window.addEventListener('resize', closeRowMenus, { passive: true });

function moduleHeaderHtml(p) {
  const uid = xjs(p.row_uid);
  return `<div class="module-header">
        <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
        <div class="mod-icon">${p.d ? `<i class="${x(p.d)}"></i>` : ''}</div>
        <div class="mod-info">
          <div class="mod-title">${x(p.c || 'Untitled Module')}</div>
          ${p.e ? `<div class="mod-sub">${x(p.e)}</div>` : ''}
        </div>
        <div class="card-actions">
          ${rowEditBtn(p.row_uid, 'Edit module')}
          ${rowMenuHtml([
    { label: 'Material', icon: 'fa-regular fa-file-lines', action: `addMaterialOrFunfact('${uid}','material')` },
    { label: 'Fun fact', icon: 'fa-regular fa-lightbulb', action: `addMaterialOrFunfact('${uid}','funfact')` }
  ], { text: 'Add', label: 'Add to this module' })}
          ${rowMenuHtml([...copyMenuItems('modules'), DELETE_ITEM], { label: 'More module actions' })}
        </div>
      </div>`;
}

function funfactCardHtml(c) {
  return `<div class="funfact-card" data-uid="${x(c.row_uid)}">
    <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
    <i class="fa-solid fa-lightbulb" style="color:var(--secondary-color);font-size:1.1em;flex-shrink:0"></i>
    <div class="card-main">
      <div class="card-title">${x((c.b || '').substring(0, 100))}</div>
    </div>
    <div class="card-actions">${rowEditBtn(c.row_uid)}${rowMenuHtml([DELETE_ITEM])}</div>
  </div>`;
}

function moduleContentHtml(children) {
  const materials = children.filter(c => c.type !== 'funfact');
  const funfacts = children.filter(c => c.type === 'funfact');
  let h = `<div class="module-content">`;
  // The materials/funfacts wrapper divs always render, even when empty, so "Add Material"/
  // "Add Fun Fact" always has somewhere to insert into — only the placeholder text is conditional.
  if (!children.length) {
    h += `<div class="empty-content" style="padding:14px;margin:0">No items yet. Use Add above.</div>`;
  }
  h += `<div class="module-materials">${materials.map(c => materialCardHtml(c)).join('')}</div>`;
  h += `<div class="module-funfacts">${funfacts.map(c => funfactCardHtml(c)).join('')}</div>`;
  h += `</div>`;
  return h;
}

function renderHier(rows) {
  let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
    <div class="add-bar">
      <button onclick="addModule()" class="btn-sm"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Module</button>
    </div>
  </div>`;
  if (!rows.length) return h + `<div class="empty-content">No modules or projects yet.</div>`;

  // Walk the row_index-ordered rows into top-level items. A 'module' starts a module group
  // (materials/funfacts attach to it); a 'project' is a standalone ref (its content lives in
  // the Projects tab). Everything else attaches to the current module group only.
  const items = []; let cur = null;
  for (const row of rows) {
    if (row.type === 'module') { cur = { kind: 'module', parent: row, children: [] }; items.push(cur); }
    else if (row.type === 'project') { cur = null; items.push({ kind: 'project', parent: row }); }
    else if (cur) cur.children.push(row);
    else { if (!items.length || items[items.length - 1].kind !== 'orphan') items.push({ kind: 'orphan', parent: null, children: [] }); items[items.length - 1].children.push(row); }
  }

  // Modules and projects share one Order (`b`); highest on top. Orphaned items stay pinned first.
  const orphan = items.length && items[0].kind === 'orphan' ? items.shift() : null;
  items.sort((a, b) => (parseFloat(b.parent?.b) || 0) - (parseFloat(a.parent?.b) || 0));
  if (orphan) items.unshift(orphan);

  for (const g of items) {
    if (g.kind === 'project') {
      h += projectRefCardHtml(g.parent);
    } else if (g.kind === 'module') {
      h += `<div class="module" data-uid="${x(g.parent.row_uid)}">
        ${moduleHeaderHtml(g.parent)}
        ${moduleContentHtml(g.children)}
      </div>`;
    } else {
      h += `<div class="module">
        <div class="module-header">
          <div class="mod-icon"></div>
          <div class="mod-info"><div class="mod-title">Orphaned items</div></div>
        </div>
        ${moduleContentHtml(g.children)}
      </div>`;
    }
  }
  return h;
}

// Compact, drag-to-reorder stand-in for a project shown inside the Modules view. It carries
// the project's data-uid so it takes part in the unified top-level ordering, but its only
// action is Edit, which jumps to the Projects tab (where its content is edited).
function projectRefCardHtml(p) {
  return `<div class="module project-ref" data-uid="${x(p.row_uid)}">
    <div class="module-header">
      <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
      <div class="mod-icon">${p.d ? `<i class="${x(p.d)}"></i>` : '<i class="fa-solid fa-diagram-project"></i>'}</div>
      <div class="mod-info">
        <div class="mod-title"><span class="proj-ref-badge">Project</span>${x(p.c || 'Untitled Project')}</div>
        ${p.e ? `<div class="mod-sub">${x(p.e)}</div>` : ''}
      </div>
      <div class="card-actions">
        <button type="button" class="row-edit-btn" title="Edit in Projects" aria-label="Edit in Projects" onclick="editProjectFromModules('${xjs(p.row_uid)}')"><i class="fa-solid fa-pen" aria-hidden="true"></i><span>Edit</span></button>
      </div>
    </div>
  </div>`;
}

// Edit a project from the Modules view → switch to the Projects tab and open its editor.
// Goes through selectSection so unsaved module-order changes still prompt to save.
async function editProjectFromModules(uid) {
  _openProjectAfterLoad = uid;
  const tab = document.querySelector('.section-tab[data-sec="projects"]');
  await selectSection('projects', tab);
  if (S.section !== 'projects') _openProjectAfterLoad = null; // switch was cancelled
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects hierarchy
// ─────────────────────────────────────────────────────────────────────────────

function projectHeaderHtml(p) {
  // No drag handle here: project ORDER is set in the Modules view (where projects appear as
  // refs alongside modules). This tab is for editing project content only.
  const uid = xjs(p.row_uid);
  return `<div class="module-header">
        <div class="mod-icon">${p.d ? `<i class="${x(p.d)}"></i>` : ''}</div>
        <div class="mod-info">
          <div class="mod-title">${x(p.c || 'Untitled Project')}</div>
          ${p.e ? `<div class="mod-sub">${x(p.e)}</div>` : ''}
        </div>
        <div class="card-actions">
          ${rowEditBtn(p.row_uid, 'Edit project')}
          ${rowMenuHtml([
    { label: 'File', icon: 'fa-regular fa-file-lines', action: `addProjectFile('${uid}')` },
    { label: 'Description', icon: 'fa-solid fa-align-left', action: `addProjectDescription('${uid}')` },
    { label: 'Group', icon: 'fa-solid fa-users', action: `addProjectGroup('${uid}')` }
  ], { text: 'Add', label: 'Add to this project' })}
          ${rowMenuHtml([...copyMenuItems('projects'), DELETE_ITEM], { label: 'More project actions' })}
        </div>
      </div>`;
}

function projectDescCardHtml(d) {
  return `<div class="material-card project-desc-card" data-uid="${x(d.row_uid)}" style="margin-bottom:8px;background:#f7f8fc">
    <div class="card-icon"><i class="fa-solid fa-align-left"></i></div>
    <div class="card-main">
      <div class="card-title">Project Description</div>
      <div class="card-detail">${x((d.b || '').substring(0, 80))}</div>
    </div>
    <div class="card-actions">${rowEditBtn(d.row_uid)}${rowMenuHtml([DELETE_ITEM])}</div>
  </div>`;
}

function pgbHeadHtml(g) {
  // Name and actions share the first line; the topic and leader get a full-width line
  // below, so neither is squeezed into a narrow column beside the name.
  const members = [g.e, g.f, g.g, g.h, g.i].filter(Boolean);
  return `<div class="pgb-headwrap">
    <div class="pgb-head">
      <div class="pgb-name"><i class="fa-solid fa-users" style="opacity:0.5;margin-right:6px"></i>${x(g.b || 'Group')}</div>
      <div class="card-actions">
        ${rowEditBtn(g.row_uid, 'Edit group')}
        ${rowMenuHtml([
    { label: 'Add file', icon: 'fa-regular fa-file-lines', action: `addGroupFile('${xjs(g.row_uid)}')` },
    DELETE_ITEM
  ], { label: 'More group actions' })}
      </div>
      ${g.c || g.d ? `<div class="pgb-details">
        ${g.c ? `<div class="pgb-topic">${x(g.c)}</div>` : ''}
        ${g.d ? `<span class="pgb-chip"><i class="fa-solid fa-star" style="margin-right:4px;opacity:0.6"></i>${x(g.d)}</span>` : ''}
      </div>` : ''}
    </div>
    ${members.length ? `<div class="pgb-members">${members.map(m => `<span class="member-chip">${x(m)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function projectGroupBlockHtml(g, files) {
  return `<div class="project-group-block" data-uid="${x(g.row_uid)}">
    ${pgbHeadHtml(g)}
    ${files.length ? `<div class="pgb-files">${files.map(f => materialCardHtml(f)).join('')}</div>` : ''}
  </div>`;
}

function renderProjects(rows) {
  let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
    <div class="add-bar">
      <button onclick="addProject()" class="btn-sm"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Project</button>
    </div>
  </div>`;
  if (!rows.length) return h + `<div class="empty-content">No projects yet.</div>`;

  const projects = []; let curProj = null; let curGrp = null;
  for (const row of rows) {
    if (row.type === 'project') {
      curProj = { header: row, desc: null, files: [], groups: [] }; curGrp = null;
      projects.push(curProj);
    } else if (curProj) {
      if (row.type === 'project_description') curProj.desc = row;
      else if (row.type === 'project_file') curProj.files.push(row);
      else if (row.type === 'project_group') { curGrp = { header: row, files: [] }; curProj.groups.push(curGrp); }
      else if (row.type === 'group_file' && curGrp) curGrp.files.push(row);
    }
  }

  // Same Order as the Modules view / public page: highest on top.
  projects.sort((a, b) => (parseFloat(b.header.b) || 0) - (parseFloat(a.header.b) || 0));

  for (const proj of projects) {
    const p = proj.header;
    h += `<div class="module" data-uid="${x(p.row_uid)}">
      ${projectHeaderHtml(p)}
      <div class="module-content">`;

    if (proj.desc) h += projectDescCardHtml(proj.desc);
    for (const f of proj.files) h += materialCardHtml(f);
    for (const grp of proj.groups) h += projectGroupBlockHtml(grp.header, grp.files);

    if (!proj.desc && !proj.files.length && !proj.groups.length) {
      h += `<div class="empty-content" style="padding:14px;margin:0">No content yet. Use <strong>Add</strong> above for a file, description or group.</div>`;
    }

    h += `</div></div>`;
  }
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cards (links, announcements)
// ─────────────────────────────────────────────────────────────────────────────

function flatCardHtml(row) {
  let t1 = '', t2 = '';
  if (row.type === 'button') { t1 = row.b; t2 = row.d; }
  else if (row.type === 'announcement') { t1 = row.e; t2 = row.d; }
  else { t1 = row.b || row.c || ''; }
  const icon = (row.type === 'announcement' || row.type === 'button') ? row.b : '';
  return `<div class="material-card" data-uid="${x(row.row_uid)}">
      <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
      ${icon ? `<div class="card-icon"><i class="${x(icon)}"></i></div>` : ''}
      <div class="card-main">
        <div class="card-title">${x((t1 || '').substring(0, 70)) || '(empty)'}</div>
        ${t2 ? `<div class="card-detail">${x((t2 || '').substring(0, 80))}</div>` : ''}
      </div>
      <div class="card-actions">${rowEditBtn(row.row_uid)}${rowMenuHtml([DELETE_ITEM])}</div>
    </div>`;
}

function renderCards(rows, sec, opts = {}) {
  const ADD_ICONS = { button: 'fa-solid fa-link', announcement: 'fa-solid fa-plus' };
  let h = '';
  if (!opts.bare) {
    const btns = sec.types.map(t => `<button onclick="addFlatRow('${t}')" class="btn-sm"><i class="${ADD_ICONS[t] || 'fa-solid fa-plus'}" style="margin-right:5px"></i>Add ${TYPE_NAMES[t] || t}</button>`).join('');
    h += `<div class="section-topbar">
      <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      <div class="add-bar">${btns}</div>
      ${tabMenuHtml(sec.id)}
    </div>`;
  }
  if (!rows.length) return h + `<div class="empty-content">No ${sec.label.toLowerCase()} yet.</div>`;
  for (const row of rows) h += flatCardHtml(row);
  return h;
}

function materialCardHtml(c) {
  return `<div class="material-card" data-uid="${x(c.row_uid)}">
    <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
    ${c.b ? `<div class="card-icon"><i class="${x(c.b)}"></i></div>` : ''}
    <div class="card-main">
      <div class="card-title">${x(c.c || 'Untitled')}</div>
      ${c.d ? `<div class="card-detail">${x(c.d.substring(0, 80))}</div>` : ''}
    </div>
    <div class="card-actions">${rowEditBtn(c.row_uid)}${rowMenuHtml([DELETE_ITEM])}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row CRUD
// ─────────────────────────────────────────────────────────────────────────────

// ── Inline editing (replaces the old modal for Modules/Projects/Links/Announcements) ──
// Only one row is ever being edited inline at a time; opening a new one commits + collapses
// whatever was previously open first. Nothing here touches the database — edits, adds,
// deletes, and drag reordering are all purely local until the tab's Save button is clicked.

let _inlineEditUid = null;
let _newRowSeq = 0;

function attrSel(uid) { return `[data-uid="${String(uid).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`; }

function addNewRow(type, defaults = {}) {
  const uid = newCourseRowUid();
  const row = { row_uid: uid, sheet_name: S.course, is_archive: S.isArchive, row_index: 0, type, b: '', c: '', d: '', e: '', f: '', g: '', h: '', i: '', j: '', ...defaults };
  ROW_STORE[uid] = row;
  markDirty(); // a new (unsaved) row now exists
  return { uid, row };
}

function currentDatetimeStr() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy}, ${hh}:${min}`;
}

// The element whose outerHTML gets replaced when an inline edit closes, and right after
// which the edit panel gets inserted. For module/project/project_group this is just the
// header portion, so re-rendering it never disturbs already-rendered children.
function getEditAnchor(uid, row) {
  const el = document.querySelector('#section-body ' + attrSel(uid));
  if (!el) return null;
  if (row.type === 'module' || row.type === 'project') return el.querySelector(':scope > .module-header') || el;
  if (row.type === 'project_group') return el.querySelector(':scope > .pgb-headwrap') || el;
  return el;
}

// JSON of the field values shown in the open panel, taken when it opens — compared against
// the current DOM on close to know whether there are unsaved edits.
let _inlineEditSnapshot = null;

function openInlineEdit(uid) {
  const row = ROW_STORE[uid];
  if (!row) { toast('Row not in cache, reload the section', 'err'); return; }
  // Clicking the same Edit toggle again is a request to close (and may prompt to save).
  if (_inlineEditUid === uid) { requestCloseInlineEdit(); return; }
  closeInlineEdit();
  // Drop any panel still mid-collapse from a previous close so we never get two at once.
  document.getElementById('inline-edit-panel')?.remove();
  const anchor = getEditAnchor(uid, row);
  if (!anchor) return;
  let inner;
  if (row.type === 'project_group') {
    inner = buildInlineGroupFieldsHtml(row);
  } else {
    const schema = FIELDS[row.type];
    if (!schema || schema === 'dynamic') { toast('No schema for type: ' + row.type, 'err'); return; }
    inner = buildInlineFieldsHtml(row, schema);
  }
  _inlineEditUid = uid;
  const panel = document.createElement('div');
  panel.className = 'inline-edit-panel';
  panel.id = 'inline-edit-panel';
  // All chrome/fields live on .iep-inner so the outer grid row can collapse to zero height.
  // Every panel gets the same Save / Cancel footer (Save persists like the big section Save).
  panel.innerHTML = `<div class="iep-inner">${inner}<div class="inline-edit-foot">
        <button type="button" class="btn-secondary btn-sm" onclick="requestCloseInlineEdit()"><i class="fa-solid fa-xmark" style="margin-right:5px"></i>Cancel</button>
        <button type="button" class="btn-sm btn-save-section" onclick="inlineSave()"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>
      </div></div>`;
  anchor.classList.add('inline-editing-anchor');
  anchor.insertAdjacentElement('afterend', panel);
  _inlineEditSnapshot = readInlineFieldsJson(row);
  setDnDDisabled(true);
  // Force a reflow at 0fr, then flip to .open so the accordion actually animates the expand.
  void panel.offsetHeight;
  panel.classList.add('open');
  // Focus the first field once the panel has mostly opened.
  setTimeout(() => {
    if (_inlineEditUid !== uid) return; // panel already closed/switched meanwhile
    panel.querySelector('input:not([type=hidden]), textarea, select')?.focus();
  }, 180);
}

// Tears the panel down. Commits DOM → ROW_STORE first (unless discarding) — this MUST happen
// before the panel is removed, since the fields live inside it. When `animate` is set (the
// user-facing Cancel / toggle paths), the panel collapses shut first; programmatic callers
// (Save, switching rows) tear down instantly since the section re-renders anyway.
function closeInlineEdit(discard, animate) {
  if (!_inlineEditUid) return;
  const uid = _inlineEditUid;
  const row = ROW_STORE[uid];
  if (row && !discard && (inlinePanelDirty() || row.row_index === 0)) {
    if (row.type === 'project_group') commitInlineGroupFields(row);
    else {
      const schema = FIELDS[row.type];
      if (schema && schema !== 'dynamic') commitInlineFieldsFromDom(row, schema);
    }
  }
  // Clear state up front so a follow-up open can't double-commit or race this teardown.
  _inlineEditUid = null;
  _inlineEditSnapshot = null;
  setDnDDisabled(false);
  const panel = document.getElementById('inline-edit-panel');
  // Remove the panel and re-render the edited card together at the end, so the card stays
  // flush-attached while the panel collapses, then swaps instantly (no fade) once it's gone.
  const finish = () => { if (panel) panel.remove(); if (row) rerenderAnchor(uid); };
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (panel && animate && !reduce) {
    panel.classList.remove('open'); // collapse shut, then tear down after the transition
    setTimeout(finish, 300);
  } else {
    finish();
  }
}

// User-facing close (Cancel button, or toggling the Edit button off). Prompts to save when
// there are unsaved edits so a stray click can't quietly drop them.
async function requestCloseInlineEdit() {
  if (!_inlineEditUid) return;
  if (inlinePanelDirty()) {
    const choice = await confirmDialog('You have unsaved changes to this item.',
      { title: 'Save changes?', okLabel: 'Save', okIcon: 'fa-floppy-disk', altLabel: 'Discard' });
    if (choice === true) { await inlineSave(); return; }
    if (choice === 'alt') { closeInlineEdit(true, true); return; } // discard, animated
    return; // Cancel — keep editing
  }
  closeInlineEdit(false, true); // commit, animated collapse
}

// Save the open panel exactly like the big section Save (commit → persist → reload). Because
// saveSectionChanges() calls closeInlineEdit() first, the panel's edits are committed and
// written in the same pass.
async function inlineSave() {
  if (!S.section) { closeInlineEdit(); return; }
  return await saveCurrentSection();
}

function inlinePanelDirty() {
  if (!_inlineEditUid || _inlineEditSnapshot == null) return false;
  const row = ROW_STORE[_inlineEditUid];
  if (!row) return false;
  return readInlineFieldsJson(row) !== _inlineEditSnapshot;
}

// Reads the panel's live field values (without mutating ROW_STORE) as a stable JSON string.
function readInlineFieldsJson(row) {
  if (row.type === 'project_group') return JSON.stringify(readGroupFieldsFromDom());
  const schema = FIELDS[row.type];
  if (!schema || schema === 'dynamic') return '';
  return JSON.stringify(readInlineFieldsFromDom(schema));
}

// Dragging is suspended for the section while an inline editor is open.
function setDnDDisabled(disabled) {
  document.querySelectorAll('#section-body, #section-body .module-materials, #section-body .module-funfacts, #links-cards-body')
    .forEach(el => { const s = window.Sortable && Sortable.get(el); if (s) s.option('disabled', disabled); });
}

function buildInlineFieldsHtml(row, schema) {
  let h = '';
  for (const f of schema) {
    const raw = row[f.col] || '';
    const v = raw || f.default || '';
    h += `<div class="form-group"><label class="form-label">${x(f.label)}</label>`;
    if (f.ta) {
      h += `<textarea id="mf_${f.col}">${xh(v)}</textarea>`;
    } else if (f.sel) {
      const opts = f.sel.map(o => {
        const oval = (typeof o === 'object') ? o.val : o;
        const olbl = (typeof o === 'object') ? o.lbl : (o || '—');
        return `<option value="${x(oval)}"${v === oval ? ' selected' : ''}>${x(olbl)}</option>`;
      }).join('');
      h += `<select id="mf_${f.col}">${opts}</select>`;
    } else if (f.dt) {
      h += `<input type="datetime-local" id="mf_${f.col}" value="${x(toIsoDatetime(v))}">`;
    } else if (f.icon) {
      h += `<div class="icon-input-wrap">
        <input type="text" id="mf_${f.col}" value="${x(v)}" data-fa-icon spellcheck="false" autocomplete="off"
               placeholder="fa-solid fa-folder or its &lt;i&gt; tag">
        <span class="fa-preview" style="font-size:1.6em;width:28px;color:var(--primary-color)">${faIconHtml(v)}</span>
        <a class="icon-find-link" href="${FA_SEARCH_URL}" target="_blank" rel="noopener noreferrer" title="Find an icon on Font Awesome"><i class="fa-solid fa-magnifying-glass"></i></a>
      </div>`;
    } else if (f.link) {
      h += `<div class="icon-input-wrap">
        <input type="text" id="mf_${f.col}" value="${x(v)}"
               oninput="updateLinkPreview(this,'lp_${f.col}')">
        <a id="lp_${f.col}" href="${x(safeCourseUrl(v) || '#')}" target="_blank" rel="noopener noreferrer"
           class="btn btn-sm" style="flex-shrink:0;padding:6px 10px;background:var(--primary-color);color:white;border-radius:10px;text-decoration:none;display:${v ? 'flex' : 'none'};align-items:center;gap:4px;border:none">
          <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.85em"></i>
        </a>
      </div>`;
    } else if (f.autofill) {
      h += `<div class="icon-input-wrap">
        <input type="text" id="mf_${f.col}" value="${x(v)}" placeholder="Pick from Drive or paste a Drive / OneDrive link"
               onpaste="setTimeout(()=>autofillDriveLink(this),50)"
               onblur="autofillDriveLink(this)">
        <button type="button" class="btn btn-sm" title="Pick a file from Google Drive"
                style="flex-shrink:0;padding:6px 11px;font-size:0.95em"
                onclick="openDrivePicker(document.getElementById('mf_${f.col}'))"><i class="fa-brands fa-google-drive"></i></button>
        <button type="button" class="btn btn-sm" style="flex-shrink:0;padding:6px 12px;font-size:0.82em"
                onclick="autofillDriveLink(document.getElementById('mf_${f.col}'),true)">Fill</button>
      </div>`;
    } else {
      h += `<input type="text" id="mf_${f.col}" value="${x(v)}"${f.faList ? ' data-fa-list spellcheck="false"' : ''}>`;
    }
    if (f.hint && !f.sel && !f.icon && !f.dt && !f.link && !f.autofill) h += `<div class="form-hint">${x(f.hint)}</div>`;
    h += `</div>`;
  }
  return h;
}

function readInlineFieldsFromDom(schema) {
  const o = {};
  for (const f of schema) {
    const el = document.getElementById('mf_' + f.col);
    if (!el) continue;
    // Icon fields keep the class, also when a Font Awesome <i> tag was set without typing.
    o[f.col] = f.dt && el.value ? fromIsoDatetime(el.value) : f.icon ? faIconClass(el.value)
      : f.faList ? faIconList(el.value) : (el.value || '');
  }
  return o;
}

function commitInlineFieldsFromDom(row, schema) {
  Object.assign(row, readInlineFieldsFromDom(schema));
}

function buildInlineGroupFieldsHtml(row) {
  // cols e,f,g,h each store one member; col i stores member5,member6,... comma-separated
  const allMembers = ['e', 'f', 'g', 'h'].map(c => row[c] || '').filter(Boolean);
  if (row.i) allMembers.push(...row.i.split(',').map(s => s.trim()).filter(Boolean));
  allMembers.push(''); // one empty slot at end
  let membersHtml = '';
  allMembers.forEach((val, i) => { membersHtml += memberRowHtml(i + 1, val); });
  return `
    <div class="form-group"><label class="form-label">Group Name</label><input type="text" id="mf_b" value="${x(row.b || '')}"></div>
    <div class="form-group"><label class="form-label">Supervisor</label><input type="text" id="mf_c" value="${x(row.c || '')}"></div>
    <div class="form-group"><label class="form-label">Leader</label><input type="text" id="mf_d" value="${x(row.d || '')}"></div>
    <div style="margin-bottom:4px;font-size:0.77em;font-weight:700;color:#9e9e9e;text-transform:uppercase;letter-spacing:0.05em"><i class="fa-solid fa-person" style="margin-right:5px;opacity:0.6"></i>Members</div>
    <div id="members-list">${membersHtml}</div>
    <button type="button" class="btn-secondary btn-sm" onclick="addMemberSlot()" style="margin-top:4px"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Member</button>
  `;
}

function readGroupFieldsFromDom() {
  const members = [...document.querySelectorAll('#members-list .member-input')].map(inp => inp.value.trim()).filter(Boolean);
  return {
    b: (document.getElementById('mf_b')?.value || '').trim(),
    c: (document.getElementById('mf_c')?.value || '').trim(),
    d: (document.getElementById('mf_d')?.value || '').trim(),
    e: members[0] || '', f: members[1] || '', g: members[2] || '', h: members[3] || '',
    i: members.slice(4).join(',')
  };
}

function commitInlineGroupFields(row) {
  Object.assign(row, readGroupFieldsFromDom());
}

function rerenderAnchor(uid) {
  const row = ROW_STORE[uid];
  if (!row) return;
  const anchor = getEditAnchor(uid, row);
  if (!anchor) return;
  let html;
  if (row.type === 'module') html = moduleHeaderHtml(row);
  else if (row.type === 'project') html = projectHeaderHtml(row);
  else if (row.type === 'project_group') html = pgbHeadHtml(row);
  else if (row.type === 'funfact') html = funfactCardHtml(row);
  else if (row.type === 'material' || row.type === 'project_file' || row.type === 'group_file') html = materialCardHtml(row);
  else if (row.type === 'project_description') html = projectDescCardHtml(row);
  else if (row.type === 'button' || row.type === 'announcement') html = flatCardHtml(row);
  else return;
  anchor.outerHTML = html;
}

function memberRowHtml(n, val) {
  return `<div class="form-group member-row" style="display:flex;align-items:center;gap:6px">
    <label class="form-label" style="min-width:84px;margin:0">Member ${n}</label>
    <input type="text" class="member-input" value="${x(val)}" style="flex:1">
    <button type="button" class="btn-secondary btn-icon" style="flex-shrink:0"
            onclick="this.closest('.member-row').remove()"><i class="fa-solid fa-xmark"></i></button>
  </div>`;
}

function addMemberSlot() {
  const list = document.getElementById('members-list');
  const count = list.querySelectorAll('.member-row').length;
  list.insertAdjacentHTML('beforeend', memberRowHtml(count + 1, ''));
}

// ── Staged delete: just removes the DOM node (after confirming). Nothing is deleted from
// the database until the tab's Save button diffs the final DOM state against it. ──

async function stageDeleteRow(btn) {
  const el = btn.closest('[data-uid]');
  if (!el) return;
  const ok = await confirmDialog('This item will be permanently deleted.', { title: 'Delete item', okLabel: 'Remove', danger: true });
  if (!ok) return;
  if (_inlineEditUid === el.dataset.uid) {
    _inlineEditUid = null;
    const panel = document.getElementById('inline-edit-panel');
    if (panel) panel.remove();
  }
  const moduleContent = el.closest('.module-content');
  el.remove();
  if (moduleContent) refreshModuleContentPlaceholder(moduleContent);
  refreshTopLevelPlaceholder();
  markDirty(); // a row was removed but not yet persisted
}

function refreshModuleContentPlaceholder(contentEl) {
  const mats = contentEl.querySelector(':scope > .module-materials');
  const funs = contentEl.querySelector(':scope > .module-funfacts');
  let placeholder = contentEl.querySelector(':scope > .empty-content');
  if (mats || funs) {
    const isEmpty = (!mats || !mats.children.length) && (!funs || !funs.children.length);
    if (isEmpty && !placeholder) contentEl.insertAdjacentHTML('afterbegin', `<div class="empty-content" style="padding:14px;margin:0">No items yet. Use Add above.</div>`);
    else if (!isEmpty && placeholder) placeholder.remove();
  } else {
    const hasContent = !!contentEl.querySelector(':scope > [data-uid], :scope > .project-group-block');
    if (!hasContent && !placeholder) contentEl.insertAdjacentHTML('beforeend', `<div class="empty-content" style="padding:14px;margin:0">No content. Click <strong>Add File</strong>, <strong>Add Description</strong>, or <strong>Add Group</strong> above.</div>`);
    else if (hasContent && placeholder) placeholder.remove();
  }
}

function refreshTopLevelPlaceholder() {
  const sec = SECTIONS.find(s => s.id === S.section);
  if (!sec) return;
  const body = document.getElementById('section-body');
  if (!body) return;
  const listEl = sec.id === 'links' ? (document.getElementById('links-cards-body') || body) : body;
  const hasItems = !!listEl.querySelector(':scope > [data-uid], :scope > .module');
  let placeholder = listEl.querySelector(':scope > .empty-content');
  if (!hasItems && !placeholder) listEl.insertAdjacentHTML('beforeend', `<div class="empty-content">No ${sec.label.toLowerCase()} yet.</div>`);
  else if (hasItems && placeholder) placeholder.remove();
}

// ── Add flows: create the row locally, insert its (empty) card into the right spot,
// then immediately open it for inline editing — no dialogue, no DB write yet. ──

function addModule() {
  closeInlineEdit();
  const body = document.getElementById('section-body');
  const emptyMsg = body.querySelector(':scope > .empty-content');
  if (emptyMsg) emptyMsg.remove();
  const uids = [...body.querySelectorAll(':scope > .module[data-uid]')].map(el => el.dataset.uid);
  const maxOrder = Math.max(0, ...uids.map(u => parseInt(ROW_STORE[u]?.b) || 0));
  // f = Default State. Empty means Hidden on the public site, so a new module starts as SHOW.
  const { uid, row } = addNewRow('module', { b: String(maxOrder + 1), d: 'fa-solid fa-folder', f: 'SHOW' });
  const html = `<div class="module" data-uid="${x(uid)}">${moduleHeaderHtml(row)}${moduleContentHtml([])}</div>`;
  const topbar = body.querySelector(':scope > .section-topbar');
  if (topbar) topbar.insertAdjacentHTML('afterend', html); else body.insertAdjacentHTML('afterbegin', html);
  initDnD(SECTIONS.find(s => s.id === 'modules'));
  openInlineEdit(uid);
}

function addMaterialOrFunfact(moduleUid, type) {
  closeInlineEdit();
  const moduleEl = document.querySelector('#section-body > .module' + attrSel(moduleUid));
  if (!moduleEl) return;
  const listEl = moduleEl.querySelector(type === 'funfact' ? '.module-funfacts' : '.module-materials');
  if (!listEl) return;
  const emptyMsg = moduleEl.querySelector(':scope > .module-content > .empty-content');
  if (emptyMsg) emptyMsg.remove();
  const { uid, row } = addNewRow(type);
  listEl.insertAdjacentHTML('beforeend', type === 'funfact' ? funfactCardHtml(row) : materialCardHtml(row));
  initDnD(SECTIONS.find(s => s.id === 'modules'));
  openInlineEdit(uid);
}

function addProject() {
  closeInlineEdit();
  const body = document.getElementById('section-body');
  const emptyMsg = body.querySelector(':scope > .empty-content');
  if (emptyMsg) emptyMsg.remove();
  const uids = [...body.querySelectorAll(':scope > .module[data-uid]')].map(el => el.dataset.uid);
  const maxOrder = Math.max(0, ...uids.map(u => parseInt(ROW_STORE[u]?.b) || 0));
  // See addModule: empty f = Hidden on the public site, so default a new project to SHOW.
  const { uid, row } = addNewRow('project', { b: String(maxOrder + 1), f: 'SHOW' });
  const html = `<div class="module" data-uid="${x(uid)}">${projectHeaderHtml(row)}<div class="module-content"><div class="empty-content" style="padding:14px;margin:0">No content. Click <strong>Add File</strong>, <strong>Add Description</strong>, or <strong>Add Group</strong> above.</div></div></div>`;
  body.insertAdjacentHTML('beforeend', html);
  initDnD(SECTIONS.find(s => s.id === 'projects'));
  openInlineEdit(uid);
}

function addProjectFile(projectUid) {
  closeInlineEdit();
  const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
  if (!moduleEl) return;
  const contentEl = moduleEl.querySelector(':scope > .module-content');
  if (!contentEl) return;
  const emptyMsg = contentEl.querySelector(':scope > .empty-content');
  if (emptyMsg) emptyMsg.remove();
  const { uid, row } = addNewRow('project_file');
  contentEl.insertAdjacentHTML('beforeend', materialCardHtml(row));
  initDnD(SECTIONS.find(s => s.id === 'projects'));
  openInlineEdit(uid);
}

function hasProjectDescription(projectUid) {
  const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
  return !!(moduleEl && moduleEl.querySelector(':scope > .module-content > .project-desc-card'));
}

function addProjectDescription(projectUid) {
  if (hasProjectDescription(projectUid)) { toast('This project already has a description, edit it below', 'err'); return; }
  closeInlineEdit();
  const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
  if (!moduleEl) return;
  const contentEl = moduleEl.querySelector(':scope > .module-content');
  if (!contentEl) return;
  const emptyMsg = contentEl.querySelector(':scope > .empty-content');
  if (emptyMsg) emptyMsg.remove();
  const { uid, row } = addNewRow('project_description');
  contentEl.insertAdjacentHTML('afterbegin', projectDescCardHtml(row));
  initDnD(SECTIONS.find(s => s.id === 'projects'));
  openInlineEdit(uid);
}

function addProjectGroup(projectUid) {
  closeInlineEdit();
  const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
  if (!moduleEl) return;
  const contentEl = moduleEl.querySelector(':scope > .module-content');
  if (!contentEl) return;
  const emptyMsg = contentEl.querySelector(':scope > .empty-content');
  if (emptyMsg) emptyMsg.remove();
  const { uid, row } = addNewRow('project_group');
  contentEl.insertAdjacentHTML('beforeend', projectGroupBlockHtml(row, []));
  initDnD(SECTIONS.find(s => s.id === 'projects'));
  openInlineEdit(uid);
}

function addGroupFile(groupUid) {
  closeInlineEdit();
  const groupEl = document.querySelector('#section-body .project-group-block' + attrSel(groupUid));
  if (!groupEl) return;
  const { uid, row } = addNewRow('group_file');
  let filesEl = groupEl.querySelector(':scope > .pgb-files');
  if (!filesEl) {
    groupEl.insertAdjacentHTML('beforeend', '<div class="pgb-files"></div>');
    filesEl = groupEl.querySelector(':scope > .pgb-files');
  }
  filesEl.insertAdjacentHTML('beforeend', materialCardHtml(row));
  initDnD(SECTIONS.find(s => s.id === 'projects'));
  openInlineEdit(uid);
}

function addFlatRow(type) {
  closeInlineEdit();
  const defaults = {};
  if (type === 'announcement') defaults.d = currentDatetimeStr();
  const { uid, row } = addNewRow(type, defaults);
  const body = document.getElementById('section-body');
  const container = document.getElementById('links-cards-body') || body;
  const emptyMsg = container.querySelector(':scope > .empty-content');
  if (emptyMsg) emptyMsg.remove();
  container.insertAdjacentHTML('beforeend', flatCardHtml(row));
  const sec = SECTIONS.find(s => s.types.includes(type));
  initDnD(sec);
  openInlineEdit(uid);
}

// ── Save: diff the section's current DOM state against the database and reconcile ──

function collectSectionUids(sec) {
  const body = document.getElementById('section-body');
  if (sec.hier || sec.proj) {
    // allUids = rows this section actually owns (for the upsert/delete diff and row_index).
    // topUids = every top-level card in DOM order (used only to assign the shared Order).
    // In the Modules view, project refs are top-level too, but they are NOT owned here — their
    // rows stay untouched apart from the Order (`b`) written back in saveSectionChanges.
    const allUids = [];
    const topUids = [];
    body.querySelectorAll(':scope > .module').forEach(modEl => {
      const uid = modEl.dataset.uid;
      if (!uid) return;
      topUids.push(uid);
      if (modEl.classList.contains('project-ref')) return; // owned by the Projects tab
      allUids.push(uid);
      modEl.querySelectorAll('.module-content [data-uid]').forEach(el => allUids.push(el.dataset.uid));
    });
    return { allUids, topUids };
  }
  const container = document.getElementById('links-cards-body') || body;
  const allUids = [...container.querySelectorAll(':scope > [data-uid]')].map(el => el.dataset.uid);
  return { allUids, topUids: allUids };
}

async function saveSectionChanges(sectionId) {
  if (!requirePermission(canEditSection(sectionId))) return false;
  const sec = SECTIONS.find(s => s.id === sectionId);
  if (!sec) return;
  closeInlineEdit();

  const btn = document.getElementById('section-save-btn');
  const origHtml = btn ? btn.innerHTML : '';
  const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = origHtml; } };
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }

  const timetableChanges = sectionId === 'links' ? await saveTimetablesWork() : { upserts: [], deleteUids: [] };
  if (timetableChanges.error) { toast('Save failed: ' + timetableChanges.error.message, 'err'); resetBtn(); return false; }

  const { allUids, topUids } = collectSectionUids(sec);

  // The Modules view owns the shared Order (`b`): its top-level cards (modules and project
  // refs) are renumbered from their drag order, highest on top, so numbers never clash.
  if (sec.hier && topUids.length > 1) {
    // Surface a pre-existing clash (e.g. two items hand-typed to the same number) before we
    // silently renumber, so the fix is visible rather than mysterious.
    const seen = new Set(); let clash = false;
    for (const uid of topUids) { const b = (ROW_STORE[uid]?.b || '').trim(); if (b && seen.has(b)) clash = true; seen.add(b); }
    if (clash) toast('Some Order numbers clashed. Renumbered automatically...', 'err');
    const n = topUids.length;
    topUids.forEach((uid, i) => { if (ROW_STORE[uid]) ROW_STORE[uid].b = String(n - i); });
  }

  const { data: existing, error: fetchErr } = await sb.from('course_rows').select('row_uid')
    .eq('sheet_name', S.course).eq('is_archive', S.isArchive).in('type', sec.types);
  if (fetchErr) { toast('Save failed: ' + fetchErr.message, 'err'); resetBtn(); return false; }

  // The section's own row_index band (see SECTION_ROW_BASE).
  const base = SECTION_ROW_BASE[sectionId] || 0;
  const existingUids = new Set((existing || []).map(r => r.row_uid));
  const finalSet = new Set(allUids);
  const toDelete = [...existingUids].filter(u => !finalSet.has(u));
  const toUpsert = allUids.map((uid, i) => {
    const row = ROW_STORE[uid];
    return row ? { ...row, row_index: base + (i + 1) * 10 } : null;
  }).filter(Boolean);

  toUpsert.push(...timetableChanges.upserts);
  toDelete.push(...timetableChanges.deleteUids);

  // Modules view also owns project ordering: persist the reordered project refs' Order only,
  // leaving their content and row_index (their own band) untouched.
  if (sec.hier) {
    const projRows = topUids.map(uid => ROW_STORE[uid]).filter(r => r && r.type === 'project');
    toUpsert.push(...projRows.map(r => ({ ...r })));
  }

  const { error } = await saveCourseRows(toUpsert, toDelete);
  if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }

  toast('Saved', 'ok');
  await loadSection(sectionId);
  return true;
}

async function modalSave() {
  if (!requirePermission(canEditSection(S.section))) return;
  const btn = document.getElementById('modal-save');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Saving…';
  const type = document.getElementById('m_type').value;
  const row = {
    row_uid: document.getElementById('m_uid').value,
    sheet_name: document.getElementById('m_sheet').value,
    is_archive: document.getElementById('m_archive').value === 'true',
    row_index: parseInt(document.getElementById('m_index').value),
    type: type === '_custom' ? 'metadata' : type,
    b: '', c: '', d: '', e: '', f: '', g: '', h: '', i: '', j: ''
  };
  for (const f of (FIELDS[type] || [])) {
    const el = document.getElementById('mf_' + f.col);
    if (!el) continue;
    row[f.col] = f.dt && el.value ? fromIsoDatetime(el.value) : (el.value || '');
  }
  const { error } = await saveCourseRows(row);
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:5px"></i>Save';
  if (error) { toast('Save failed: ' + error.message, 'err'); return; }
  ROW_STORE[row.row_uid] = row;
  toast('Saved', 'ok'); closeModal();
  if (S.section === 'info') await loadMetadataSettings();
  else await loadSection(S.section);
}

async function deleteRow(uid) {
  if (!requirePermission(canEditSection(S.section) && (ROW_STORE[uid]?.type !== 'metadata' || canEditMetadata(ROW_STORE[uid]?.b)))) return;
  if (!await confirmDialog('This row will be permanently deleted.', { title: 'Delete this row?', okLabel: 'Delete', danger: true })) return;
  const { error } = await saveCourseRows([], [uid]);
  if (error) { toast('Delete failed: ' + error.message, 'err'); return; }
  delete ROW_STORE[uid]; toast('Deleted', 'ok');
  if (S.section === 'info') await loadMetadataSettings();
  else await loadSection(S.section);
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy to another course
// ─────────────────────────────────────────────────────────────────────────────

// Content can be copied into another active course, usually from an archived offering into
// the current one: a module (with its materials and fun facts) or a project (with its
// description and files) from its ⋯ menu, and from the ⋯ menu in a tab's toolbar the Info
// fields, the grading, links and timetables, or announcements. The copy is what the tab
// shows, unsaved edits included. Project groups stay behind: they list one offering's students.

const COPY_CHILD_TYPES = { module: ['material', 'funfact'], project: ['project_description', 'project_file'] };
const COPY_COLS = ['type', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
const COPY_BUTTON_HTML = '<i class="fa-regular fa-copy" style="margin-right:5px"></i>Copy';
const COPY_ITEM = { label: 'Copy to…', icon: 'fa-regular fa-copy' };
// Year and semester start unticked: they usually differ between offerings.
const INFO_COPY_FIELDS = [
  { key: 'code', label: 'Course Code' },
  { key: 'title', label: 'Title' },
  { key: 'year', label: 'Academic Year', offering: true },
  { key: 'semester', label: 'Semester', offering: true },
  { key: 'level', label: 'Level' },
  { key: 'type', label: 'Type' },
  { key: 'credits', label: 'Credits (ECTS)' },
  { key: 'header_decoration', label: 'Header Icon' },
  { key: 'theme_colours', label: 'Theme Colours' },
];
// An announcement's content, without its date: copies are dated when copied.
const ANNOUNCEMENT_COPY_COLS = ['b', 'c', 'e', 'f', 'g', 'h', 'i'];
const GRADING_MULTI_KEY = new RegExp(`^(${GRADING_CATEGORIES.filter(c => c.multi).map(c => c.id).join('|')})\\d+_percentage$`);
let _copy = null; // the open copy dialog
let _copyLastTarget = '';

// Active courses, other than the open one, that can take this tab's content.
function copyTargets(sectionId) {
  return [...COURSE_HEADERS.values()].filter(c => !c.is_archive && !(c.sheet_name === S.course && !S.isArchive) &&
    canEditSection(sectionId, c.sheet_name, false));
}
function hasCopyTarget(sectionId) { return copyTargets(sectionId).length > 0; }
function copyMenuItems(sectionId) {
  return hasCopyTarget(sectionId) ? [{ ...COPY_ITEM, action: 'openCopyDialog(this)' }] : [];
}
// The ⋯ menu at the end of a tab's toolbar.
function tabMenuHtml(sectionId) {
  return hasCopyTarget(sectionId)
    ? rowMenuHtml([{ ...COPY_ITEM, action: `openCopyTabDialog('${sectionId}')` }], { label: 'More actions' }) : '';
}

// The same module or project: its title, icon and subtitle match exactly.
function sameCopyHead(a, b) {
  return a.type === b.type && ['c', 'd', 'e'].every(col => String(a[col] || '').trim() === String(b[col] || '').trim());
}

function copyTerm(c) {
  const semester = String(c.semester || '').match(/\b(Fall|Spring|Summer)\b/i)?.[1] || c.semester;
  return [semester, c.year].filter(Boolean).join(' ');
}

function copySourceHtml(icon, title, sub) {
  return `<div class="copy-source">
    <span class="copy-source-icon" aria-hidden="true">${faIconHtml(icon)}</span>
    <span class="copy-source-text"><span class="copy-source-title">${x(title)}</span>
      ${sub ? `<span class="copy-source-sub">${x(sub)}</span>` : ''}</span>
  </div>`;
}

const copyCols = row => Object.fromEntries(COPY_COLS.map(col => [col, row[col] ?? '']));
const copyText = value => String(value || '').trim();
const copyIcon = cls => cls ? `${faIconHtml(cls)} ` : '';
// A short line of plain text for long values, such as links and announcement bodies.
function copyExcerpt(value, length = 60) {
  const text = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length - 1) + '…' : text;
}

// The end of a tab's row_index band, so appended rows keep its order (see SECTION_ROW_BASE).
function copyBandEnd(rows, sectionId) {
  const base = SECTION_ROW_BASE[sectionId];
  return Math.max(base, ...rows.map(row => row.row_index).filter(i => i > base && i < base + 100000));
}

// From a module or project's ⋯ menu.
function openCopyDialog(button) {
  const uid = button.closest('[data-uid]')?.dataset.uid;
  closeInlineEdit(); // an open editor's changes go into the copy
  const el = uid && document.querySelector('#section-body > .module' + attrSel(uid));
  const head = ROW_STORE[uid];
  if (!el || !COPY_CHILD_TYPES[head?.type]) return;
  const children = [...el.querySelectorAll('.module-content [data-uid]')].map(child => ROW_STORE[child.dataset.uid]).filter(Boolean);
  const rows = [head, ...children.filter(row => COPY_CHILD_TYPES[head.type].includes(row.type))];
  const isModule = head.type === 'module';
  const count = (type, one, many) => {
    const n = rows.filter(row => row.type === type).length;
    return n ? `${n} ${n === 1 ? one : many}` : '';
  };
  const contents = (isModule
    ? [count('material', 'material', 'materials'), count('funfact', 'fun fact', 'fun facts')]
    : [rows.some(row => row.type === 'project_description') ? 'Description' : '', count('project_file', 'file', 'files')]
  ).filter(Boolean).join(' · ');
  openCopyModal({
    kind: head.type, sectionId: isModule ? 'modules' : 'projects', rows,
    // The tab's order, to place the copy among the target's items (see placeCopy).
    order: [...document.querySelectorAll('#section-body > .module[data-uid]')].map(m => ROW_STORE[m.dataset.uid]).filter(Boolean),
    title: isModule ? 'Copy module' : 'Copy project',
    summary: copySourceHtml(head.d || (isModule ? 'fa-solid fa-folder' : 'fa-solid fa-diagram-project'),
      head.c || (isModule ? 'Untitled Module' : 'Untitled Project'),
      contents || (isModule ? 'No materials or fun facts' : 'No description or files')),
    note: children.some(row => row.type === 'project_group') ? 'Groups are not copied: they list this course\'s students.' : '',
  });
}

// From the ⋯ menu in the Info, Grading, Links or Announcements toolbar.
function openCopyTabDialog(sectionId) {
  closeInlineEdit(); // an open editor's changes go into the copy
  const tab = COPY_TABS[sectionId];
  const header = COURSE_HEADERS.get(JSON.stringify([S.course, S.isArchive])) || {};
  openCopyModal({
    kind: sectionId, sectionId, tab, title: tab.title, source: tab.source(), picked: new Map(), state: null, table: [],
    summary: copySourceHtml(`fa-solid ${courseIconClass(header.icon)}`, courseLabel(header, S.course),
      [copyTerm(header), S.isArchive ? 'Archived' : ''].filter(Boolean).join(' · ')),
  });
}

function openCopyModal(copy) {
  const targets = copyTargets(copy.sectionId).sort(courseOrder);
  // Preselect this course's active offering (usually the point of copying), else the
  // course copied to last, else the only choice.
  const codeKey = c => sheetNameFromCode(c.code || courseNameBase(c.sheet_name)).toLowerCase();
  const own = codeKey(COURSE_HEADERS.get(JSON.stringify([S.course, S.isArchive])) || { sheet_name: S.course });
  const preset = targets.find(c => own && codeKey(c) === own) || targets.find(c => c.sheet_name === _copyLastTarget) ||
    (targets.length === 1 ? targets[0] : null);
  _copy = { ...copy, targets, target: preset?.sheet_name || '' };
  const { tab } = copy;
  document.getElementById('modal-title').textContent = copy.title;
  document.getElementById('modal-body').innerHTML = `<div class="copy-dialog${tab ? ' is-tab' : ''}">
    ${copy.summary}
    <section class="nc-section" aria-labelledby="copy-to-title">
      <h4 class="nc-section-title" id="copy-to-title">Copy to</h4>
      ${targets.length > 6 ? `<div class="sb-search copy-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input type="search" id="copy-search" placeholder="Search courses" autocomplete="off" aria-label="Search courses by code, name, lecturer, semester or year"></div>` : ''}
      <div class="copy-courses" id="copy-courses" role="radiogroup" aria-labelledby="copy-to-title">${targets.map((c, i) => {
    const code = c.code || c.sheet_name;
    return `<label class="copy-course" data-index="${i}">
          <input type="radio" name="copy_target" value="${x(c.sheet_name)}"${c.sheet_name === _copy.target ? ' checked' : ''}>
          <strong class="copy-course-code">${x(code)}</strong>
          <span class="copy-course-title">${c.title && c.title !== code ? x(c.title) : ''}</span>
          <span class="copy-course-term">${x(copyTerm(c))}</span>
        </label>`;
  }).join('')}</div>
      <p class="form-hint" id="copy-empty" hidden>No matching courses.</p>
      ${copy.note ? `<p class="form-hint">${x(copy.note)}</p>` : ''}
    </section>
    ${tab ? `<section class="nc-section" aria-labelledby="copy-items-title">
      <h4 class="nc-section-title" id="copy-items-title">${x(tab.heading)}</h4>
      ${copy.source.length ? `<div class="copy-fields${tab.pick ? '' : ' no-pick'}" id="copy-fields"></div>` : `<p class="form-hint">${x(tab.empty)}</p>`}
      <p class="form-hint">${x(tab.hint())}</p>
    </section>` : ''}
    <p id="copy-status" class="access-form-status is-error" role="alert"></p>
  </div>`;
  document.getElementById('modal-foot').style.display = '';
  const save = document.getElementById('modal-save');
  save.disabled = false;
  save.innerHTML = COPY_BUTTON_HTML;
  save.onclick = runCopy;
  document.getElementById('modal-overlay').classList.add('open');

  const list = document.getElementById('copy-courses');
  list.addEventListener('change', event => {
    _copy.target = event.target.value;
    document.getElementById('copy-status').textContent = '';
    if (_copy.tab) loadCopyState();
  });
  const search = document.getElementById('copy-search');
  search?.addEventListener('input', () => {
    let shown = 0;
    list.querySelectorAll('.copy-course').forEach(label => {
      label.hidden = !!search.value.trim() && !courseMatchesQuery(targets[label.dataset.index], search.value);
      shown += !label.hidden;
    });
    document.getElementById('copy-empty').hidden = shown > 0;
  });
  // Enter picks the course when the search leaves exactly one.
  search?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const shown = [...list.querySelectorAll('.copy-course:not([hidden]) input')];
    if (shown.length !== 1) return;
    shown[0].checked = true;
    shown[0].dispatchEvent(new Event('change', { bubbles: true }));
    shown[0].focus();
  });
  // Ticks are remembered by item, so they survive loading another course's values.
  document.getElementById('copy-fields')?.addEventListener('change', event => {
    const input = event.target;
    document.getElementById('copy-status').textContent = '';
    if (input.id === 'copy-all') {
      document.querySelectorAll('#copy-fields input[data-copy-id]:not(:disabled)').forEach(box => {
        box.checked = input.checked;
        _copy.picked.set(box.dataset.copyId, input.checked);
      });
    } else if (input.dataset.copyId) _copy.picked.set(input.dataset.copyId, input.checked);
    updateCopyAll();
  });
  if (tab) { renderCopyRows(); if (_copy.target) loadCopyState(); }
  (list.querySelector('input:checked') || list.querySelector('input'))?.focus();
}

// A tab's items beside the target's: "Same", the value the copy replaces, or — for none.
function renderCopyRows() {
  const list = document.getElementById('copy-fields');
  if (!list) return;
  const { tab, state, picked } = _copy;
  const table = _copy.table = tab.rows(_copy.source, state);
  const tag = tab.pick ? 'label' : 'div';
  list.innerHTML = `<div class="copy-fields-head">${tab.pick ? '<span><input type="checkbox" id="copy-all" aria-label="Select all"></span>' : ''}${tab.head.map((name, i) => `<span${i ? '' : ' class="copy-head-label"'}>${name}</span>`).join('')}</div>` +
    table.map(row => {
      const off = !!row.lock || row.same;
      const on = picked.has(row.id) ? picked.get(row.id) : row.on;
      const now = !_copy.target ? '' : !state ? '…' : row.total ? row.now : row.same ? 'Same' : row.now || '—';
      return `<${tag} class="copy-field${off ? ' is-off' : ''}${row.total ? ' is-total' : ''}">
        ${tab.pick ? `<input type="checkbox" data-copy-id="${x(row.id)}"${on && !off ? ' checked' : ''}${off ? ' disabled' : ''}>` : ''}
        <span class="copy-field-label">${row.label}${row.lock ? ' <i class="fa-solid fa-lock" title="Admins only" aria-label="Admins only"></i>' : ''}</span>
        <span class="copy-field-value">${row.value}</span>
        <span class="copy-field-now">${now}</span>
      </${tag}>`;
    }).join('');
  updateCopyAll();
}

function updateCopyAll() {
  const all = document.getElementById('copy-all');
  if (!all) return;
  const boxes = [...document.querySelectorAll('#copy-fields input[data-copy-id]:not(:disabled)')];
  const ticked = boxes.filter(box => box.checked).length;
  all.disabled = !boxes.length;
  all.checked = !!boxes.length && ticked === boxes.length;
  all.indeterminate = ticked > 0 && ticked < boxes.length;
}

async function loadCopyState() {
  const copy = _copy, target = copy.target;
  copy.state = null;
  renderCopyRows();
  let state = null, error = null;
  try { state = await fetchCopyState(target); } catch (e) { error = e; }
  if (_copy !== copy || copy.target !== target) return; // another course was picked meanwhile
  if (error) { document.getElementById('copy-status').textContent = 'Could not load that course. ' + (error.message || ''); return; }
  copy.state = state;
  renderCopyRows();
}

// The target's rows that tab copies compare with and write to.
async function fetchCopyState(sheet) {
  const { data, error } = await sb.from('course_rows').select('*')
    .eq('sheet_name', sheet).eq('is_archive', false).in('type', ['metadata', 'button', 'announcement']).order('row_index');
  if (error) throw error;
  const rows = data || [];
  const meta = new Map();
  let metaEnd = 0;
  for (const row of rows.filter(r => r.type === 'metadata')) {
    if (!meta.has(metaKeyOf(row.b))) meta.set(metaKeyOf(row.b), row);
    metaEnd = Math.max(metaEnd, row.row_index || 0);
  }
  return { sheet, rows, meta, metaEnd, buttons: rows.filter(r => r.type === 'button'), announcements: rows.filter(r => r.type === 'announcement') };
}

// Sets a metadata key in the target, on its own row when it has one; empty removes it.
function setCopyMeta(state, out, key, value) {
  const row = state.meta.get(key);
  if (value) {
    out.upserts.push(row ? { ...row, c: value } : {
      sheet_name: state.sheet, is_archive: false, type: 'metadata', row_uid: newCourseRowUid(),
      row_index: state.metaEnd += 10, b: key, c: value, d: '', e: '', f: '', g: '', h: '', i: '', j: '',
    });
  } else if (row) out.deletes.push(row.row_uid);
}

function copyValueKey(key, value) {
  return key === 'theme_colours' ? String(value || '').replace(/\s+/g, '').toLowerCase() : String(value || '').trim();
}

function copyValueHtml(key, value) {
  if (key === 'theme_colours') {
    const colours = String(value).split(',').map(normalizeHexColour).filter(Boolean);
    if (colours.length) return `<span class="copy-swatches" title="${x(value)}">${colours.map(c => `<span class="copy-swatch" style="background:${c}"></span>`).join('')}</span>`;
  }
  if (key === 'header_decoration') {
    return `${faIconHtml(value)} ${x(value.replace(/\bfa-(solid|regular|brands|light|thin|duotone)\b\s*/g, '').replace(/\bfa-/g, ''))}`;
  }
  return x(value);
}

// A course's grading entries in display order, numbered as saving numbers them.
function gradingFromDom() {
  const entries = [];
  for (const cat of GRADING_CATEGORIES) {
    const inputs = cat.multi ? [...document.querySelectorAll(`tr.grading-row[data-cat="${cat.id}"] .grade-val-multi`)]
      : [document.querySelector(`.grade-val[data-key="${cat.key}"]`)];
    inputs.map(input => input?.value.trim()).filter(Boolean).forEach((value, i) =>
      entries.push({ cat, key: cat.multi ? `${cat.id}${i + 1}_percentage` : cat.key, value }));
  }
  return entries;
}

function gradingFromMeta(meta) {
  const metaMap = Object.fromEntries(meta);
  const entries = [];
  for (const cat of GRADING_CATEGORIES) {
    const keys = cat.multi ? gradingEntriesFor(cat, metaMap).map(e => e.key) : [cat.key];
    keys.map(key => meta.get(key)).filter(row => copyText(row?.c)).forEach(row =>
      entries.push({ cat, key: metaKeyOf(row.b), value: copyText(row.c) }));
  }
  return entries;
}

const isGradingKey = key => GRADING_FIXED_KEYS.includes(key) || GRADING_LEGACY_KEYS.includes(key) || GRADING_MULTI_KEY.test(key);

function timetablesFromMeta(meta) {
  const numbers = new Set();
  for (const key of meta.keys()) {
    const m = key.match(/^timetable(\d+)_(?:name|id|hidden)$|^class(\d+)_id$/);
    if (m) numbers.add(Number(m[1] || m[2]));
  }
  const value = key => copyText(meta.get(key)?.c);
  return [...numbers].sort((a, b) => a - b).map(n => ({
    n, name: value(`timetable${n}_name`), tid: value(`timetable${n}_id`),
    cls: value(`class${n}_id`), hidden: value(`timetable${n}_hidden`) === '1'
  }));
}
const timetableKey = t => copyText(t.name).toLowerCase() || copyText(t.tid);
const timetableSummary = t => x(`IDs ${t.tid || '—'} · ${t.cls || '—'}`) + (t.hidden ? ' · Hidden' : '');
const announcementKey = row => copyText(row.e).toLowerCase() || copyText(row.f);

// The tabs copied from their toolbar. Each reads its items from the tab (source), lays
// them beside the target's (rows: Same, the replaced value, or none) and adds the chosen
// ones' rows to out (write). Grading has no choice: it copies the whole scheme.
const COPY_TABS = {
  info: {
    title: 'Copy course info', heading: 'Fields', head: ['Field', 'Copy', 'Replaces'], pick: true,
    empty: 'This course has no info to copy yet.',
    hint: () => isCourseAdmin() ? 'Academic year and semester start unticked: they usually differ between offerings.'
      : 'Only Admins can copy Course Identity fields.',
    source() {
      const value = key => document.querySelector(`#section-body .meta-field[data-metakey="${key}"]`)?.value || '';
      return INFO_COPY_FIELDS.map(f => ({ ...f, value: f.key === 'header_decoration' ? faIconClass(value(f.key)) : value(f.key).trim() }))
        .filter(f => f.value);
    },
    rows: (source, state) => source.map(f => {
      const now = state?.meta.get(f.key)?.c || '';
      return {
        id: f.key, label: x(f.label), value: copyValueHtml(f.key, f.value), now: now && copyValueHtml(f.key, now),
        same: !!state && copyValueKey(f.key, now) === copyValueKey(f.key, f.value), on: !f.offering,
        lock: !isCourseAdmin() && PROTECTED_META_KEYS.has(f.key)
      };
    }),
    write(source, state, ids, out) { source.filter(f => ids.has(f.key)).forEach(f => setCopyMeta(state, out, f.key, f.value)); },
  },
  grading: {
    title: 'Copy grading', heading: 'Grading', head: ['Assessment', 'Copy', 'Replaces'], pick: false,
    empty: 'This course has no grading to copy yet.',
    hint: () => 'The copy replaces that course\'s whole grading. Done marks are not copied.',
    source: gradingFromDom,
    rows(source, state) {
      const target = state ? gradingFromMeta(state.meta) : [];
      const pct = entry => entry ? `${x(entry.value)}%` : '—';
      const total = entries => `${entries.reduce((sum, e) => sum + (parseFloat(e.value) || 0), 0)}%`;
      const rows = [];
      for (const cat of GRADING_CATEGORIES) {
        const mine = source.filter(e => e.cat === cat), theirs = target.filter(e => e.cat === cat);
        const count = Math.max(mine.length, theirs.length);
        for (let i = 0; i < count; i++) {
          rows.push({
            id: `${cat.id}${i}`, label: x(count > 1 ? `${cat.label} ${i + 1}` : cat.label), value: pct(mine[i]),
            now: theirs[i] ? pct(theirs[i]) : '', same: !!state && (mine[i]?.value || '') === (theirs[i]?.value || '')
          });
        }
      }
      rows.push({ id: 'total', total: true, label: 'Total', value: total(source), now: total(target) });
      return rows;
    },
    // The whole scheme, as saving the Grading tab writes it. An entry the target already
    // has keeps its Done mark.
    write(source, state, ids, out) {
      const keep = new Set(source.map(e => e.key));
      for (const [key, row] of state.meta) if (isGradingKey(key) && !keep.has(key)) out.deletes.push(row.row_uid);
      source.forEach(e => setCopyMeta(state, out, e.key, e.value));
    },
  },
  links: {
    title: 'Copy links', heading: 'Links', head: ['Link', 'Copy', 'Replaces'], pick: true,
    empty: 'This course has no links or timetables yet.',
    hint: () => 'Timetables start unticked: their IDs usually change each semester. A link replaces the one with the same label.',
    source() {
      const field = (card, name) => card.querySelector(`[name=${name}]`)?.value.trim() || '';
      const timetables = [...document.querySelectorAll('#timetables-list .timetable-card')].map(card => ({
        kind: 'timetable',
        name: field(card, 'tt_name'), tid: field(card, 'tt_id'), cls: field(card, 'tt_class'), hidden: field(card, 'tt_hidden') === '1'
      }))
        .filter(t => t.name || t.tid);
      const buttons = [...document.querySelectorAll('#links-cards-body > [data-uid]')].map(el => ROW_STORE[el.dataset.uid])
        .filter(Boolean).map(row => ({ kind: 'button', row }));
      return [...timetables, ...buttons].map((item, i) => ({ ...item, id: String(i) }));
    },
    rows(source, state) {
      const timetables = state ? timetablesFromMeta(state.meta) : [];
      return source.map(item => {
        if (item.kind === 'timetable') {
          const match = timetables.find(t => timetableKey(t) === timetableKey(item));
          return {
            id: item.id, label: copyIcon('fa-solid fa-clock') + x(item.name || 'Timetable'), value: timetableSummary(item),
            now: match && timetableSummary(match), same: !!match && timetableSummary(match) === timetableSummary(item), on: false
          };
        }
        const { row } = item;
        const match = state?.buttons.find(b => copyText(b.b) === copyText(row.b));
        return {
          id: item.id, label: copyIcon(row.c) + x(row.b || 'Link'), value: x(copyExcerpt(row.d)), now: match && x(copyExcerpt(match.d)),
          same: !!match && ['c', 'd', 'e'].every(col => copyText(match[col]) === copyText(row[col])), on: true
        };
      });
    },
    write(source, state, ids, out) {
      const timetables = timetablesFromMeta(state.meta);
      let next = Math.max(0, ...timetables.map(t => t.n));
      let index = copyBandEnd(state.rows, 'links');
      for (const item of source.filter(item => ids.has(item.id))) {
        if (item.kind === 'timetable') {
          const n = timetables.find(t => timetableKey(t) === timetableKey(item))?.n ?? ++next;
          setCopyMeta(state, out, `timetable${n}_name`, item.name);
          setCopyMeta(state, out, `timetable${n}_id`, item.tid);
          setCopyMeta(state, out, `class${n}_id`, item.cls);
          setCopyMeta(state, out, `timetable${n}_hidden`, item.hidden ? '1' : '');
          continue;
        }
        const match = state.buttons.find(b => copyText(b.b) === copyText(item.row.b));
        out.upserts.push(match ? { ...match, c: item.row.c, d: item.row.d, e: item.row.e }
          : { ...copyCols(item.row), row_uid: newCourseRowUid(), sheet_name: state.sheet, is_archive: false, row_index: index += 10 });
      }
    },
  },
  announce: {
    title: 'Copy announcements', heading: 'Announcements', head: ['Announcement', 'Copy', 'Replaces'], pick: true,
    empty: 'This course has no announcements yet.',
    hint: () => 'Announcements start unticked, as most are about one semester. Copies are dated now, and replace an announcement with the same title.',
    source: () => [...document.querySelectorAll('#section-body > .material-card[data-uid]')].map(el => ROW_STORE[el.dataset.uid])
      .filter(Boolean).map((row, i) => ({ id: String(i), row })),
    rows: (source, state) => source.map(({ id, row }) => {
      const match = state?.announcements.find(a => announcementKey(a) === announcementKey(row));
      return {
        id, label: copyIcon(row.b) + x(row.e || copyExcerpt(row.f, 40) || 'Announcement'), value: x(copyExcerpt(row.f)),
        now: match && x(copyExcerpt(match.f)), same: !!match && ANNOUNCEMENT_COPY_COLS.every(col => copyText(match[col]) === copyText(row[col])), on: false
      };
    }),
    write(source, state, ids, out) {
      let index = copyBandEnd(state.rows, 'announce');
      const d = currentDatetimeStr();
      for (const { id, row } of source.filter(item => ids.has(item.id))) {
        const match = state.announcements.find(a => announcementKey(a) === announcementKey(row));
        out.upserts.push({ ...(match || { row_uid: newCourseRowUid(), sheet_name: state.sheet, is_archive: false, row_index: index += 10 }), ...copyCols(row), d });
      }
    },
  },
};

async function runCopy() {
  const copy = _copy;
  const status = document.getElementById('copy-status');
  if (!copy || !status) return;
  const target = copy.targets.find(c => c.sheet_name === copy.target);
  if (!target) { status.textContent = 'Choose a course to copy to.'; return; }
  const label = courseLabel(target, target.sheet_name);
  const { tab } = copy;
  let ids = null;
  if (tab) {
    if (!copy.source.length) { status.textContent = tab.empty; return; }
    if (tab.pick) {
      ids = new Set([...document.querySelectorAll('#copy-fields input[data-copy-id]:checked:not(:disabled)')].map(input => input.dataset.copyId));
      const open = document.querySelectorAll('#copy-fields input[data-copy-id]:not(:disabled)').length;
      if (!ids.size) { status.textContent = copy.state && !open ? `Nothing to copy: ${label} already has all of these.` : 'Tick at least one item to copy.'; return; }
    } else if (copy.state && copy.table.every(row => row.total || row.same)) {
      status.textContent = `${label} already has the same grading.`; return;
    }
  }
  status.textContent = '';
  const btn = document.getElementById('modal-save');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Copying…';
  let result;
  try { result = tab ? await copyTabTo(copy, target, ids) : await copyRowsTo(copy, target); }
  catch (error) { result = { error }; }
  const open = status.isConnected; // still this dialog, not closed or replaced meanwhile
  if (open) { btn.disabled = false; btn.innerHTML = COPY_BUTTON_HTML; }
  if (result === 'cancelled') return;
  if (result.error) {
    const message = 'Could not copy. ' + (result.error.message || 'Try again.');
    if (open) status.textContent = message; else toast(message, 'err');
    return;
  }
  _copyLastTarget = target.sheet_name;
  if (open) closeModal();
  toast(result.replaced ? `Replaced in ${label}` : `Copied to ${label}`, 'ok');
  if (copy.kind === 'info') await loadSidebar(); // its code, title or icon may have changed
}

async function copyTabTo(copy, target, ids) {
  const state = await fetchCopyState(target.sheet_name);
  const out = { upserts: [], deletes: [] };
  copy.tab.write(copy.source, state, ids, out);
  // One upsert per row: two items can write the same row.
  const { error } = await saveCourseRows([...new Map(out.upserts.map(row => [row.row_uid, row])).values()], out.deletes);
  return error ? { error } : {};
}

async function copyRowsTo(copy, target) {
  const [head, ...children] = copy.rows;
  const own = group => group.children.filter(row => COPY_CHILD_TYPES[head.type].includes(row.type));
  const { data, error } = await sb.from('course_rows').select('*')
    .eq('sheet_name', target.sheet_name).eq('is_archive', false)
    .in('type', ['module', 'project', ...COPY_CHILD_TYPES.module, ...COPY_CHILD_TYPES.project, 'project_group', 'group_file'])
    .order('row_index');
  if (error) return { error };
  // Grouped as the course page reads them: a module or project row starts a group.
  const groups = [];
  for (const row of data || []) {
    if (row.type === 'module' || row.type === 'project') groups.push({ head: row, children: [] });
    else groups[groups.length - 1]?.children.push(row);
  }

  const match = groups.find(group => sameCopyHead(group.head, head));
  if (match) {
    const content = rows => JSON.stringify(rows.map(row => COPY_COLS.map(col => String(row[col] || '').trim())));
    const identical = content(own(match)) === content(children);
    const what = head.type === 'module' ? 'materials and fun facts' : 'description and files';
    const name = `“${head.c || (head.type === 'module' ? 'Untitled Module' : 'Untitled Project')}”`;
    const label = courseLabel(target, target.sheet_name);
    const message = (identical ? `${label} already has ${name}, with the same ${what}.` : `${label} already has a ${head.type} named ${name}.`) +
      '\n\nReplace it with this copy?' + (identical ? '' : ` Its ${what} are replaced too.`) +
      (head.type === 'project' ? ' Its groups stay.' : '');
    const replace = await confirmDialog(message, {
      title: head.type === 'module' ? 'Module already exists' : 'Project already exists',
      okLabel: 'Replace', okIcon: 'fa-arrows-rotate', danger: true,
    });
    if (!replace) return 'cancelled';
  }

  // Appended to the end of its tab's band, so its rows stay together.
  let index = copyBandEnd(data || [], head.type === 'module' ? 'modules' : 'projects');
  const upserts = copy.rows.map(row => ({
    ...copyCols(row), row_uid: newCourseRowUid(), sheet_name: target.sheet_name, is_archive: false, row_index: index += 10,
  }));
  const deletes = [];
  if (match) {
    deletes.push(match.head.row_uid, ...own(match).map(row => row.row_uid));
    // Groups list the target's own students: they stay, moved to follow the new project.
    upserts.push(...match.children.filter(row => row.type === 'project_group' || row.type === 'group_file')
      .map(row => ({ ...row, row_index: index += 10 })));
  }
  upserts.push(...placeCopy(copy, groups.map(group => group.head), match?.head, upserts[0]));

  const { error: saveError } = await saveCourseRows(upserts, deletes);
  return saveError ? { error: saveError } : { replaced: !!match };
}

// Sets the copy's Order (`b`, shared by modules and projects, highest on top). It goes
// right below the nearest item above it in this tab that the target also has, else right
// above the nearest one below it, else on top like a new module: copying a course's modules
// one at a time, in any order, keeps their order. A replacement takes the replaced item's
// place. The target's items are renumbered as saving its Modules tab does; returns those
// whose Order changed.
function placeCopy(copy, heads, replaced, row) {
  const list = heads.slice().sort((a, b) => (parseFloat(b.b) || 0) - (parseFloat(a.b) || 0));
  let at = replaced ? list.indexOf(replaced) : -1;
  if (replaced) list.splice(at, 1);
  else {
    const i = copy.order.indexOf(copy.rows[0]);
    const find = k => list.findIndex(head => sameCopyHead(head, copy.order[k]));
    for (let k = i - 1; k >= 0 && at < 0; k--) { const j = find(k); if (j >= 0) at = j + 1; }
    for (let k = i + 1; k < copy.order.length && at < 0; k++) at = find(k);
    if (at < 0) at = 0;
  }
  list.splice(at, 0, row);
  const changed = [];
  list.forEach((head, j) => {
    const b = String(list.length - j);
    if (head === row) row.b = b;
    else if (String(head.b) !== b) changed.push({ ...head, b });
  });
  return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Course management
// ─────────────────────────────────────────────────────────────────────────────

// A course's key (and public link) from its code: "CE 101" → CE_101, "SWE / CE 101" → SWE_CE_101.
function sheetNameFromCode(code) {
  return String(code || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

let _newCourseTaken = new Set();

async function openNewCourseModal() {
  if (!requirePermission(isCourseAdmin())) return;
  if (!(await confirmLeaveIfDirty())) return;
  const option = (value, selected = '') => `<option value="${x(value)}"${value === selected ? ' selected' : ''}>${x(value || '—')}</option>`;
  document.getElementById('modal-title').textContent = 'New course';
  document.getElementById('modal-save').innerHTML = '<i class="fa-solid fa-plus" style="margin-right:5px"></i>Create course';
  document.getElementById('modal-save').onclick = createCourse;
  document.getElementById('modal-foot').style.display = '';
  document.getElementById('modal-body').innerHTML = `
    <form id="nc-form" class="nc-form" novalidate onsubmit="event.preventDefault();createCourse()">
      <section class="nc-section" aria-labelledby="nc-identity">
        <h4 class="nc-section-title" id="nc-identity">Course identity</h4>
        <div class="sg-grid">
          <div class="form-group"><label class="form-label" for="nc_code">Course code <span class="nc-required" aria-hidden="true">*</span></label>
            <input type="text" id="nc_code" required maxlength="60" placeholder="e.g. CE 101" autocomplete="off" oninput="updateNewCourseKey()"></div>
          <div class="form-group"><label class="form-label" for="nc_title">Title <span class="nc-required" aria-hidden="true">*</span></label>
            <input type="text" id="nc_title" required maxlength="200" placeholder="e.g. Engineering Mechanics" autocomplete="off"></div>
          <div class="form-group"><label class="form-label" for="nc_year">Academic year <span class="nc-required" aria-hidden="true">*</span></label>
            <input type="text" id="nc_year" required placeholder="e.g. 2026–2027" autocomplete="off" oninput="onYearInput(this)" onblur="normalizeYearField(this)"></div>
          <div class="form-group"><label class="form-label" for="nc_sem">Semester <span class="nc-required" aria-hidden="true">*</span></label>
            <select id="nc_sem" required>${['', 'Fall Semester', 'Spring Semester', 'Summer Semester'].map(v => option(v)).join('')}</select></div>
          <div class="form-group"><label class="form-label" for="nc_level">Level</label>
            <select id="nc_level">${['', 'Undergraduate', 'Graduate', 'Integrated Second Cycle', 'Postgraduate'].map(v => option(v)).join('')}</select></div>
          <div class="form-group"><label class="form-label" for="nc_type">Type</label>
            <select id="nc_type">${['', 'Compulsory', 'Elective', 'Optional'].map(v => option(v)).join('')}</select></div>
          <div class="form-group"><label class="form-label" for="nc_credits">Credits (ECTS)</label>
            <input type="number" id="nc_credits" min="1" max="10" step="1"></div>
        </div>
        <p class="form-hint" id="nc-key-hint" aria-live="polite">The course link is made from the code.</p>
      </section>
      <section class="nc-section" aria-labelledby="nc-lecturers-title">
        <h4 class="nc-section-title" id="nc-lecturers-title">Lecturers</h4>
        <div id="nc-lecturers" class="nc-lecturers"><div class="form-hint">Loading lecturers…</div></div>
        <p class="form-hint">They see this course in their sidebar and on their teaching website, with their name on the course page. You can change this later in Settings.</p>
      </section>
      <p id="nc-status" class="access-form-status is-error" role="alert"></p>
    </form>`;
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('nc_code').focus();
  // Existing active keys, to warn before creating a duplicate; and the lecturer choices.
  const [taken, accounts] = await Promise.all([takenCourseNames(false), sb.rpc('teaching_list_accounts')]);
  _newCourseTaken = taken || new Set();
  updateNewCourseKey();
  const list = document.getElementById('nc-lecturers');
  if (!list) return;
  const people = (Array.isArray(accounts.data) ? accounts.data : [])
    .filter(a => ['admin', 'global_admin', 'lecturer'].includes(a.role))
    .sort((a, b) => TeachingSites.compareLecturers(a.display_name || a.name || a.email, b.display_name || b.name || b.email));
  // You are ticked when you keep a course list, so the new course joins "My courses".
  const mine = !!S.access?.assignments?.length;
  list.innerHTML = people.length ? people.map(p => {
    const name = p.display_name || p.name || p.email;
    const checked = p.email === S.access?.email ? mine : false;
    return `<label class="nc-lecturer">
      <input type="checkbox" name="nc_lecturer" value="${x(p.email)}"${checked ? ' checked' : ''}>
      ${userAvatar(name, p.photo, 'access-avatar')}
      <span class="nc-lecturer-text"><span class="nc-lecturer-name">${x(name)}${p.email === S.access?.email ? ' <span class="nc-you">(you)</span>' : ''}</span>
        <span class="nc-lecturer-sub">${x(p.role === 'lecturer' ? 'Lecturer' : 'Admin')}</span></span>
    </label>`;
  }).join('') : '<div class="form-hint">No Lecturer accounts yet. Add them in Settings.</div>';
}

function updateNewCourseKey() {
  const hint = document.getElementById('nc-key-hint');
  if (!hint) return;
  const key = sheetNameFromCode(document.getElementById('nc_code').value);
  hint.classList.toggle('is-error', !!key && _newCourseTaken.has(key));
  hint.textContent = !key ? 'The course link is made from the code.'
    : _newCourseTaken.has(key) ? `An active course already uses ${key}. Archive it first, or change the code.`
      : `Course link: …/#${key}`;
}

async function createCourse() {
  if (!requirePermission(isCourseAdmin())) return;
  const value = id => document.getElementById(id)?.value.trim() || '';
  const status = document.getElementById('nc-status');
  normalizeYearField(document.getElementById('nc_year'));
  const code = value('nc_code'), title = value('nc_title'), year = value('nc_year'), semester = value('nc_sem');
  const missing = [['nc_code', code, 'course code'], ['nc_title', title, 'title'], ['nc_year', year, 'academic year'], ['nc_sem', semester, 'semester']]
    .filter(([, v]) => !v);
  document.querySelectorAll('#nc-form [required]').forEach(el => el.setAttribute('aria-invalid', String(!el.value.trim())));
  if (missing.length) {
    status.textContent = `Add the ${missing.map(m => m[2]).join(', ')}.`;
    document.getElementById(missing[0][0]).focus();
    return;
  }
  const sheet = sheetNameFromCode(code);
  if (!sheet) { status.textContent = 'Use letters or numbers in the course code.'; return; }
  if (_newCourseTaken.has(sheet)) { status.textContent = `An active course already uses ${sheet}. Archive it first, or change the code.`; return; }
  status.textContent = '';
  const lecturers = [...document.querySelectorAll('input[name="nc_lecturer"]:checked')].map(input => input.value);
  const base = { sheet_name: sheet, is_archive: false, type: 'metadata', b: '', c: '', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };
  const fields = [['code', code], ['title', title], ['year', year], ['semester', semester],
  ['level', value('nc_level')], ['type', value('nc_type')], ['credits', value('nc_credits')]].filter(([, v]) => v);
  const rows = fields.map(([key, c], i) => ({ ...base, row_uid: newCourseRowUid(), row_index: (i + 1) * 10, b: key, c }));
  const btn = document.getElementById('modal-save');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Creating…';
  const { error } = await sb.rpc('teaching_create_course', { p_rows: rows, p_lecturers: lecturers });
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-plus" style="margin-right:5px"></i>Create course';
  if (error) { status.textContent = 'Could not create the course. ' + error.message; return; }
  document.getElementById('modal-save').onclick = modalSave;
  closeModal(); toast('Course created', 'ok');
  // Assignments changed: your course list, and the lecturers shown for the course.
  try { await refreshTeachingAccess(); } catch { }
  await loadSidebar();
  S.course = sheet; S.isArchive = false; S.section = getLastSection(sheet, false);
  try { localStorage.setItem('admin_last_course', JSON.stringify([sheet, false])); } catch { }
  renderCourseShell(sheet, false);
  renderSidebar();
}


// ── Archive naming ───────────────────────────────────────────────────────
// sheet_name doubles as the public course link (courses/index.html reads #<sheet_name>), so
// teaching the same code twice would leave two courses fighting over one URL. Archiving stamps
// the offering onto the key — CE_132 + "Fall Semester" + "2024–2025" → CE_132_Fall2425 — which
// frees the bare code for the next offering; restoring strips the stamp back off.
const COURSE_SUFFIX_RE = /_(Fall|Spring|Summer)(\d{4})?$/;

function courseNameBase(name) { return String(name || '').replace(COURSE_SUFFIX_RE, ''); }

// '' when there's no semester to stamp: a bare year ("_2425") is indistinguishable from the tail
// of a course code, so courseNameBase() could not strip it off again on restore.
function courseNameSuffix(semester, year) {
  const sem = (String(semester || '').match(/^\s*(Fall|Spring|Summer)/) || [])[1];
  if (!sem) return '';
  const ym = String(year || '').match(/(\d{4})\D*(\d{4})?/);
  if (!ym) return '_' + sem;
  const start = parseInt(ym[1], 10);
  const end = ym[2] ? parseInt(ym[2], 10) : start + 1;
  const yy = v => String(v % 100).padStart(2, '0');
  return `_${sem}${yy(start)}${yy(end)}`;
}

async function courseMetaValues(name, isArchive, keys) {
  const { data, error } = await sb.from('course_rows').select('b,c')
    .eq('sheet_name', name).eq('is_archive', isArchive).eq('type', 'metadata').in('b', keys);
  if (error) return null;
  const m = {};
  for (const r of (data || [])) m[r.b] = r.c;
  return m;
}

// "CE 132 Structural Analysis" — how the course is named to the user, since the sheet name is
// an internal key. Falls back to it for a course with no code or title of its own.
function courseLabel(meta, sheetName) {
  const parts = [...new Set([meta.code, meta.title].filter(Boolean))];
  return parts.join(' ').trim() || sheetName;
}

// Names already used in the group we're moving into. sheet_name only has to be unique per
// archive flag — the public page queries one flag at a time.
async function takenCourseNames(isArchive) {
  const { data, error } = await sb.from('course_rows').select('sheet_name')
    .eq('is_archive', isArchive).eq('type', 'metadata');
  if (error) return null;
  return new Set((data || []).map(r => r.sheet_name));
}

// Move content, assignments and professor ownership in one database transaction. The
// course's exams, class list and submissions follow right after (js/course-exams.js).
async function moveCourse(oldName, newName, fromArchive) {
  const { error } = await sb.rpc('teaching_move_course', {
    p_name: oldName, p_new_name: newName, p_from_archive: fromArchive
  });
  if (!error) {
    await refreshTeachingAccess();
    if (typeof followExamMove === 'function') await followExamMove(oldName, fromArchive, newName);
  }
  return error || null;
}

async function archiveCourse(n) {
  if (!requirePermission(canArchiveCourse(n, false)) || !(await confirmLeaveIfDirty())) return;
  const meta = await courseMetaValues(n, false, ['semester', 'year', 'code', 'title']);
  if (!meta) { toast('Could not read the course metadata', 'err'); return; }
  // Strip any existing stamp before re-adding one, so archiving a restored course (which kept
  // its stamp because the bare code was taken) can't append a second one.
  const suffix = courseNameSuffix(meta.semester, meta.year);
  const target = suffix ? courseNameBase(n) + suffix : n;

  if (target !== n) {
    const taken = await takenCourseNames(true);
    if (!taken) { toast('Could not check the archived course names', 'err'); return; }
    if (taken.has(target)) {
      toast(`"${target}" is already archived. Change this course's semester or year first`, 'err');
      return;
    }
  }

  // The only case worth a word: with no semester there's nothing to file the offering under.
  const tip = suffix ? '' : '\n\nTip: set a Semester on the Info tab to file it under its academic year.';
  if (!await confirmDialog(`This course will be moved to your archived courses list.${tip}`,
    { title: `Archive ${courseLabel(meta, n)}?`, okLabel: 'Archive' })) return;

  const error = await moveCourse(n, target, false);
  if (error) { toast('Failed: ' + error.message, 'err'); return; }
  toast(target === n ? 'Archived' : `Archived as ${target}`, 'ok');
  S.course = null; clearMain(); await loadSidebar();
}

async function restoreCourse(n) {
  if (!requirePermission(isCourseAdmin()) || !(await confirmLeaveIfDirty())) return;
  const meta = await courseMetaValues(n, true, ['code', 'title']);
  if (!meta) { toast('Could not read the course metadata', 'err'); return; }
  const base = courseNameBase(n);
  let target = n;
  if (base !== n) {
    const taken = await takenCourseNames(false);
    if (!taken) { toast('Could not check the active course names', 'err'); return; }
    // An active course already holds the bare code — keep the stamp so both keep a distinct link.
    target = taken.has(base) ? n : base;
  }
  if (!await confirmDialog('This course will be moved back to your active courses list.',
    { title: `Restore ${courseLabel(meta, n)}?`, okLabel: 'Restore' })) return;

  const error = await moveCourse(n, target, true);
  if (error) { toast('Failed: ' + error.message, 'err'); return; }
  toast(target === n ? 'Restored' : `Restored as ${target}`, 'ok');
  S.course = null; clearMain(); await loadSidebar();
}
async function deleteCourse(n, a) {
  if (!requirePermission(isCourseAdmin()) || !(await confirmLeaveIfDirty())) return;
  if (!await confirmDialog('This CANNOT be undone.', { title: `Permanently delete ALL data for "${n}"?`, okLabel: 'Delete Everything', danger: true })) return;
  const { error } = await sb.rpc('teaching_delete_course', { p_name: n, p_archive: a });
  if (error) { toast('Failed: ' + error.message, 'err'); return; }
  if (typeof followExamDelete === 'function') await followExamDelete(n, a);
  toast(`"${n}" deleted`, 'ok'); S.course = null; clearMain();
  try { await refreshTeachingAccess(); } catch { } // Its assignments were deleted too.
  await loadSidebar();
}

function clearMain() {
  document.getElementById('main-area').innerHTML =
    `<div class="no-course"><div><h3>No course selected</h3><p>Choose a course from the sidebar.${isCourseAdmin() ? ' You can also create a new course.' : ''}</p></div></div>`;
  renderAccessControls();
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────────

function setupThemeToggle() {
  const KEY = 'theme-preference';
  const icons = { auto: 'fa-solid fa-adjust', light: 'fa-regular fa-sun', dark: 'fa-regular fa-moon' };
  const getSaved = () => {
    let pref = document.documentElement.dataset.theme || 'auto';
    try { pref = localStorage.getItem(KEY) || 'auto'; } catch { }
    return ['light', 'dark'].includes(pref) ? pref : 'auto';
  };
  const currentIsDark = () => {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced) return forced === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const updateThemeColorMeta = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', currentIsDark() ? '#000000' : '#f4f4f4');
  };
  const updateUI = (pref) => {
    const oldIcon = document.getElementById('theme-toggle-icon');
    if (oldIcon) {
      const i = document.createElement('i');
      i.id = 'theme-toggle-icon';
      i.className = icons[pref] || icons.auto;
      i.setAttribute('aria-hidden', 'true');
      oldIcon.replaceWith(i);
    }
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      const label = pref.charAt(0).toUpperCase() + pref.slice(1);
      btn.setAttribute('aria-label', `Theme: ${label}`);
      btn.title = `Theme: ${label}`;
    }
  };
  const applyTheme = (pref) => {
    const html = document.documentElement;
    if (pref === 'auto') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', pref);
    try { localStorage.setItem(KEY, pref); } catch { }
    updateUI(pref);
    updateThemeColorMeta();
  };
  applyTheme(getSaved());
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const cur = getSaved();
      const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(cur === 'auto' ? (isSystemDark ? 'light' : 'dark') : 'auto');
    });
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getSaved() === 'auto') applyTheme('auto');
  });
}

const _yr = document.getElementById('currentYear');
if (_yr) _yr.textContent = new Date().getFullYear();

// Footer branding + default colour palette from config.js, so the markup
// and CSS stay identical across deployments (only config.js differs).
(function applyConfig() {
  const cfg = window.TEACHING_CONFIG || {};
  const owner = cfg.owner || {};
  const name = document.getElementById('footer-owner');
  if (name && owner.name) name.textContent = owner.name;
  const startYear = document.getElementById('footer-start-year');
  if (startYear && owner.startYear) startYear.textContent = owner.startYear;
  const home = document.getElementById('footer-home');
  if (home && owner.homeUrl) home.href = owner.homeUrl;

  const t = cfg.theme || {};
  const root = document.documentElement.style;
  const map = {
    '--primary-color': t.primary, '--primary-dark': t.primaryDark,
    '--secondary-color': t.secondary, '--tertiary-color': t.tertiary,
    '--accent-color': t.accent, '--success-color': t.success,
  };
  Object.keys(map).forEach(k => { if (map[k]) root.setProperty(k, map[k]); });
})();

setupThemeToggle();

// ─────────────────────────────────────────────────────────────────────────────
// Drag & Drop
// ─────────────────────────────────────────────────────────────────────────────

const DND_OPTS = {
  animation: 180,
  handle: '.drag-handle',
  ghostClass: 'dnd-ghost',
  chosenClass: 'dnd-chosen',
  forceFallback: true,
  delay: 250,
  delayOnTouchOnly: true,
  touchStartThreshold: 5,
  preventOnFilter: false,
  onEnd: () => markDirty(), // a reorder is an unsaved change
};

// Drag-and-drop only reorders the DOM; Save reads the final order. Called again after
// every add, so a container never gets a second Sortable.
function ensureSortable(el, opts) {
  if (!el || Sortable.get(el)) return;
  Sortable.create(el, opts);
}

function initDnD(sec) {
  if (!canEditSection(sec.id)) return;
  if (!sec || !window.Sortable) return;
  const body = document.getElementById('section-body');
  if (!body) return;

  if (sec.hier) {
    const modules = body.querySelectorAll(':scope > .module[data-uid]');
    if (modules.length > 1) {
      ensureSortable(body, { ...DND_OPTS, filter: '.section-topbar, .empty-content' });
    }
    // Materials and fun facts are separate lists, so neither can be dragged into the other.
    body.querySelectorAll('.module-materials, .module-funfacts').forEach(listEl => {
      ensureSortable(listEl, { ...DND_OPTS, filter: '.inline-edit-panel' });
    });
  } else if (sec.proj) {
    const modules = body.querySelectorAll(':scope > .module[data-uid]');
    if (modules.length > 1) {
      ensureSortable(body, { ...DND_OPTS, filter: '.section-topbar, .empty-content' });
    }
  } else {
    // On the Links tab the cards sit inside #links-cards-body.
    const container = document.getElementById('links-cards-body') || body;
    const cards = container.querySelectorAll(':scope > .material-card[data-uid]');
    if (cards.length > 1) {
      ensureSortable(container, { ...DND_OPTS, filter: '.section-topbar, .empty-content, .inline-edit-panel' });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-foot').style.display = '';
}

// Styled stand-in for window.confirm(). Resolves true/false; used with await.
let _confirmOverlayMD = false;
let _confirmResolve = null;
function _resolveConfirm(val) {
  document.getElementById('confirm-overlay').classList.remove('open');
  const resolve = _confirmResolve;
  _confirmResolve = null;
  if (resolve) resolve(val);
}
// Resolves true (OK), false (Cancel / backdrop), or 'alt' (the optional middle button,
// e.g. "Discard"). altLabel is only shown when provided.
function confirmDialog(message, opts = {}) {
  const { title = 'Please Confirm', okLabel = 'Confirm', danger = false, altLabel = '', okIcon = 'fa-check' } = opts;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent = message;
  const okBtn = document.getElementById('confirm-ok-btn');
  okBtn.className = 'btn-sm' + (danger ? ' btn-red' : '');
  okBtn.innerHTML = `<i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${x(okLabel)}`;
  const altBtn = document.getElementById('confirm-alt-btn');
  if (altLabel) {
    altBtn.style.display = '';
    altBtn.innerHTML = `<i class="fa-solid fa-trash-can" style="margin-right:5px"></i>${x(altLabel)}`;
  } else {
    altBtn.style.display = 'none';
  }
  if (_confirmResolve) _resolveConfirm(false);
  document.getElementById('confirm-overlay').classList.add('open');
  return new Promise(resolve => { _confirmResolve = resolve; });
}

// ── Keyboard shortcuts ──
// Escape dismisses whatever is topmost (confirm dialog → modal → inline editor → mobile
// drawer); Ctrl/Cmd+S saves the open tab instead of triggering the browser's Save Page.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('confirm-overlay').classList.contains('open')) { _resolveConfirm(false); return; }
    if (document.getElementById('modal-overlay').classList.contains('open')) { closeModal(); return; }
    if (_inlineEditUid) { requestCloseInlineEdit(); return; }
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('mobile-open')) toggleSidebar();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
    if (document.getElementById('admin-app').style.display !== 'flex') return;
    e.preventDefault(); // never fall through to the browser's Save Page dialog
    if (document.getElementById('confirm-overlay').classList.contains('open') ||
      document.getElementById('modal-overlay').classList.contains('open')) return;
    if (document.getElementById('access-settings')) { saveAccessAccount(); return; }
    if (!S.course) return;
    const saveBtn = document.getElementById('section-save-btn');
    if (saveBtn && saveBtn.disabled) return; // a save is already running
    saveCurrentSection();
  }
});

// Academic Year: a typed 4-digit start year fills in the next ("2024" → "2024–2025"); on
// blur, other shapes ("2024-2025", "2024/2025") are normalised to the same format.
function onYearInput(el) {
  const raw = el.value;
  if (/^\d{4}$/.test(raw)) {
    el.value = `${raw}–${parseInt(raw, 10) + 1}`;
    el.setSelectionRange(4, 4);
  }
}
function normalizeYearField(el) {
  const raw = el.value.trim();
  if (!raw) return;
  const m = raw.match(/(\d{4})\D*(\d{4})?/);
  if (!m) return;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start + 1;
  el.value = `${start}–${end}`;
}

function x(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
// HTML escaping alone is insufficient for strings inside inline JavaScript attributes.
function xjs(s) { return x(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')); }
function safeCourseUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  try {
    const resolved = new URL(url, EMBEDDED_ADMIN_SITE ? window.TEACHING_CONFIG.appBaseUrl : window.location.href);
    return ['https:', 'http:'].includes(resolved.protocol) ? EMBEDDED_ADMIN_SITE ? resolved.href : url : '';
  }
  catch { return ''; }
}
function newCourseRowUid() { return 'course:' + crypto.randomUUID(); }
function xh(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

let _tt;
function toast(msg, type) {
  const el = document.getElementById('toast');
  const icon = type === 'ok' ? 'fa-circle-check' : type === 'err' ? 'fa-circle-exclamation' : 'fa-circle-info';
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${x(msg)}</span>`;
  el.className = 'toast show' + (type ? ' ' + type : '');
  // Errors linger longer so the reason is actually readable before it fades.
  clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove('show'), type === 'err' ? 6000 : 3000);
}
