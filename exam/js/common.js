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

// Fills the owner name and copyright start year from config.js.
function applyOwnerBranding() {
    const owner = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.owner) || {};
    const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };

    if (owner.name) set('footer-owner', el => { el.textContent = owner.name; });
    if (owner.startYear) set('footer-start-year', el => { el.textContent = owner.startYear; });

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


/* === COURSE COLOURS ======================================================
   A course's theme colours (its Info tab: "#3949ab, #ffa726, …"). Syllatest takes the first,
   the primary, as the course page does: buttons such as Next, question numbers, highlights,
   the course's code. Never for what must mean the same in every course: green to confirm,
   amber and red for warnings and errors, the timer running out.
   Worked out once for both themes: the colour as set for light (darker if white text on it
   would be hard to read), a lighter one for text on dark, so Auto, Light and Dark switch by
   CSS alone (exam/css/styles.css .course-tinted).
   ======================================================================== */
const courseColour = (() => {
    const hex = value => {
        const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
        if (!m) return null;
        const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    };
    const mix = (c, to, t) => c.map((v, i) => Math.round(v + (to[i] - v) * t));
    const css = c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
    const luminance = c => {
        const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const WHITE = [255, 255, 255], BLACK = [0, 0, 0], NIGHT = [18, 18, 18]; // the dark theme's cards
    // Towards white or black, a step at a time, until it reads well enough against `against`.
    const until = (c, to, against, ratio) => {
        for (let t = 0; t <= 1; t += 0.05) { const next = mix(c, to, t); if (contrast(next, against) >= ratio) return next; }
        return to;
    };

    // The CSS properties for a course's colours, or null when it has none of its own.
    function properties(colours) {
        const first = hex(String(colours || '').split(',')[0]);
        if (!first) return null;
        const day = until(first, BLACK, WHITE, 4.5);               // white text on it, and text on white
        // On dark: a little lighter, as the course page has it, while white text still reads.
        let button = mix(day, WHITE, 0.1);
        if (contrast(button, WHITE) < 4.5) button = day;
        const text = until(first, WHITE, NIGHT, 7);                 // text and icons on dark
        const tint = until(first, WHITE, NIGHT, 5);                 // soft backgrounds on dark
        const deep = mix(day, BLACK, 0.25);
        return {
            '--course-primary': css(day), '--course-primary-deep': css(deep), '--course-primary-night': css(button),
            '--course-rgb': day.join(', '), '--course-deep-rgb': deep.join(', '),
            '--course-night-text': css(text), '--course-night-rgb': tint.join(', '),
        };
    }

    // An inline style="…" for an element of one course (a course card on the dashboard).
    function style(colours) {
        const props = properties(colours);
        return props ? Object.entries(props).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
    }

    // Tints an element (the whole page during an exam) in a course's colours; none: as it was.
    function apply(el, colours) {
        const props = properties(colours);
        el.classList.toggle('course-tinted', !!props);
        ['--course-primary', '--course-primary-deep', '--course-primary-night', '--course-rgb', '--course-deep-rgb',
            '--course-night-text', '--course-night-rgb'].forEach(prop => {
            if (props) el.style.setProperty(prop, props[prop]);
            else el.style.removeProperty(prop);
        });
    }

    return { style, apply };
})();


/* === SCREENS =============================================================
   Each page marks its top-level screens with data-screen (login, app, error);
   exactly one is shown at a time, after the loading skeleton.
   ======================================================================== */
// ../js/skeleton.js shows one skeleton before the first paint (#app-loading when signed
// in, #boot-skeleton otherwise); it fades out as the first screen appears.
function hideBootSkeleton() {
    ['boot-skeleton', 'app-loading'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.classList.contains('skeleton-done')) return;
        el.classList.add('skeleton-done');
        setTimeout(() => { el.style.display = 'none'; }, 400);
    });
}

function showScreen(name) {
    hideBootSkeleton();
    // The sign-in card is Syllatest's own, not a course's.
    if (name === 'login') courseColour.apply(document.documentElement, null);
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
   The site's shared notifications (../js/notify.js): cards at the top, a tap or a
   swipe dismisses one. duration 0 keeps a notification until it is dismissed.
   ======================================================================== */
function showImprovedNotification(type, title, message, duration = 5000) {
    return Notify.show(type, title, message, duration);
}

// Drops every notification on screen, e.g. sign-in errors once signed in.
function clearNotifications() {
    Notify.clear();
}


/* === CONFIRM DIALOG ======================================================
   The site's confirm modal (#confirm-overlay in each page's markup).
   Resolves true (OK) or false (Cancel, backdrop or Escape).
   ======================================================================== */
let _confirmResolve = null;

function confirmDialog(message, opts = {}) {
    const { title = 'Please Confirm', okLabel = 'Confirm', danger = false, okIcon = 'fa-check',
        cancelLabel = 'Cancel', cancelIcon = 'fa-xmark' } = opts;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = message;
    const cancel = document.querySelector('#confirm-overlay .modal-foot button:first-child');
    if (cancel) cancel.innerHTML = `<i class="fa-solid ${cancelIcon}" style="margin-right:5px"></i>${escapeHtml(cancelLabel)}`;

    const okBtn = document.getElementById('confirm-ok-btn');
    okBtn.className = 'btn-sm' + (danger ? ' btn-red' : '');
    okBtn.innerHTML = `<i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${escapeHtml(okLabel)}`;

    if (_confirmResolve) _resolveConfirm(false);   // supersede an open dialog
    document.getElementById('confirm-overlay').classList.add('open');
    okBtn.focus();
    return new Promise(resolve => { _confirmResolve = resolve; });
}

// Escape, Back and a click outside answer no through js/dialogs.js.
function _resolveConfirm(val) {
    document.getElementById('confirm-overlay').classList.remove('open');
    const resolve = _confirmResolve;
    _confirmResolve = null;
    if (resolve) resolve(val);
}


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
