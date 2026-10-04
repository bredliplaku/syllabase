/* ==========================================================================
   common.js — the exam page's chrome. (Lecturers work in the course editor.)

   Like /timetable/js/common.js, this is a per-app copy rather than a
   site-wide file, so the exam pages stay independently removable. The theme
   toggle and footer branding match the timetable's versions.

   Plain (non-module) script: everything below is a window global. Load it
   after ../js/config.js and before the page's own scripts.js.
   ========================================================================== */


/* === THEME TOGGLE ========================================================
   Cycles auto → (light|dark) → auto, where the manual step is the opposite of
   the system theme, so one click always visibly changes something. The
   pre-paint script in each page's <head> has already set data-theme.
   ======================================================================== */
function setupThemeToggle() {
    const KEY = 'theme-preference';
    const BTN = document.getElementById('theme-toggle');
    const icons = {
        auto: 'fa-solid fa-adjust',
        light: 'fa-regular fa-sun',
        dark: 'fa-regular fa-moon',
    };

    const getSaved = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };

    const currentIsDark = () => {
        const forced = document.documentElement.getAttribute('data-theme');
        if (forced) return forced === 'dark';
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    };

    const updateThemeColorMeta = () => {
        const meta = document.querySelector('meta[name="theme-color"]:not([media])');
        if (meta) meta.setAttribute('content', currentIsDark() ? '#000000' : '#f4f4f4');
    };

    // Replaced rather than reclassed: the Font Awesome kit swaps each <i> for an <svg>.
    const updateUI = (pref) => {
        const old = document.getElementById('theme-toggle-icon');
        if (old) {
            const i = document.createElement('i');
            i.id = 'theme-toggle-icon';
            i.className = icons[pref] || icons.auto;
            i.setAttribute('aria-hidden', 'true');
            old.replaceWith(i);
        }
        if (BTN) {
            const label = pref.charAt(0).toUpperCase() + pref.slice(1);
            BTN.setAttribute('aria-label', `Theme: ${label}`);
            BTN.title = `Theme: ${label}`;
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

    if (BTN) {
        BTN.addEventListener('click', (e) => {
            e.stopPropagation();
            const current = getSaved();
            const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            applyTheme(current === 'auto' ? (isSystemDark ? 'light' : 'dark') : 'auto');
        });
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getSaved() === 'auto') applyTheme('auto');
    });

    applyTheme(getSaved());
}


/* === FOOTER BRANDING ===================================================== */
function updateYear() {
    const el = document.getElementById('currentYear');
    if (el) el.textContent = new Date().getFullYear();
}

// Fills the Home link, owner name and copyright start year from config.js.
function applyOwnerBranding() {
    const owner = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.owner) || {};
    const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };

    if (owner.name) set('footer-owner', el => { el.textContent = owner.name; });
    if (owner.startYear) set('footer-start-year', el => { el.textContent = owner.startYear; });
    if (owner.homeUrl) set('footer-home', el => { el.href = owner.homeUrl; });

    updateYear();
}

// Applies the config.js palette as CSS custom properties on :root.
function applyThemeDefaults() {
    const t = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.theme) || {};
    const root = document.documentElement.style;
    const map = {
        '--primary-color': t.primary,
        '--primary-dark': t.primaryDark,
        '--secondary-color': t.secondary,
        '--tertiary-color': t.tertiary,
        '--accent-color': t.accent,
        '--success-color': t.success,
    };
    Object.entries(map).forEach(([prop, val]) => { if (val) root.setProperty(prop, val); });
}


/* === SCREENS =============================================================
   Each page marks its top-level screens with data-screen (login, app, error);
   exactly one is shown at a time, after the boot spinner.
   ======================================================================== */
function hideBootSpinner() {
    const el = document.getElementById('boot-spinner');
    if (!el || el.style.display === 'none') return;
    el.classList.add('hidden');
    setTimeout(() => { el.style.display = 'none'; }, 300);
}

function showScreen(name) {
    hideBootSpinner();
    document.querySelectorAll('[data-screen]').forEach(el => {
        el.style.display = el.dataset.screen === name ? 'flex' : 'none';
    });
    // The sign-in card carries its own back link, so the footer's would be a duplicate.
    const back = document.getElementById('footer-back');
    if (back) back.style.display = name === 'login' ? 'none' : '';
}

// The signed-in person's photo (initials underneath until it loads, or if it can't)
// and name, as in the site's other top bars.
function renderTopUser(user) {
    const el = document.getElementById('top-user');
    if (!el) return;
    const name = user?.name && user.name !== 'N/A' ? user.name : (user?.email || '');
    const photo = /^https:\/\//.test(user?.picture || '') ? user.picture : '';
    const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toLocaleUpperCase();
    el.innerHTML = `<span class="user-avatar" aria-hidden="true">${escapeHtml(initials)}${photo
        ? `<img src="${escapeHtml(photo)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ''}</span><span>${escapeHtml(name)}</span>`;
    el.title = user?.email || '';
}


/* === NOTIFICATIONS =======================================================
   Dismissible notifications at the bottom right (styled by main.css).
   duration 0 keeps a notification until it is closed.
   ======================================================================== */
function showImprovedNotification(type, title, message, duration = 5000) {
    const container = document.getElementById('in-page-notification-area');
    if (!container) return;

    const notification = document.createElement('div');
    notification.setAttribute('class', `in-page-notification in-page-notification-${type}`);
    notification.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');

    const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation' };
    notification.innerHTML = `<i class="fa-solid ${icons[type] || 'fa-circle-info'}" aria-hidden="true"></i>
        <div class="notification-content"><strong>${escapeHtml(title)}</strong><br>${escapeHtml(String(message)).replace(/\n/g, '<br>')}</div>
        <button type="button" class="notification-close" aria-label="Close">&times;</button>`;
    container.appendChild(notification);

    const removeNotification = () => {
        notification.classList.add('removing');
        setTimeout(() => notification.remove(), 300);
    };
    notification.querySelector('.notification-close').addEventListener('click', (e) => {
        e.stopPropagation();
        removeNotification();
    });
    if (duration > 0) setTimeout(removeNotification, duration);
}

// Drops every notification on screen, e.g. sign-in errors once signed in.
function clearNotifications() {
    document.querySelectorAll('#in-page-notification-area .in-page-notification').forEach(n => n.remove());
}


/* === CONFIRM DIALOG ======================================================
   The site's confirm modal (#confirm-overlay in each page's markup).
   Resolves true (OK) or false (Cancel, backdrop or Escape).
   ======================================================================== */
let _confirmResolve = null;

function confirmDialog(message, opts = {}) {
    const { title = 'Please Confirm', okLabel = 'Confirm', danger = false, okIcon = 'fa-check' } = opts;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = message;

    const okBtn = document.getElementById('confirm-ok-btn');
    okBtn.className = 'btn-sm' + (danger ? ' btn-red' : '');
    okBtn.innerHTML = `<i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${escapeHtml(okLabel)}`;

    if (_confirmResolve) _resolveConfirm(false);   // supersede an open dialog
    document.getElementById('confirm-overlay').classList.add('open');
    okBtn.focus();
    return new Promise(resolve => { _confirmResolve = resolve; });
}

function _resolveConfirm(val) {
    document.getElementById('confirm-overlay').classList.remove('open');
    const resolve = _confirmResolve;
    _confirmResolve = null;
    if (resolve) resolve(val);
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('confirm-overlay')?.classList.contains('open')) {
        _resolveConfirm(false);
    }
});


/* === UTILITIES =========================================================== */
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
