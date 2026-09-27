/* ==========================================================================
   common.js — chrome shared by /timetable/ and /timetable/admin/.

   These two pages can't load each other's scripts.js (each has page-specific
   code that would break in the other), so the parts they both need live here.

   Deliberately NOT hoisted to a site-wide file: the course pages keep their
   own copies so the timetable stays independently removable. The duplication
   is a few small, stable functions.

   Plain (non-module) script: everything below is a window global. Load it
   before the page's own scripts.js.

   Reads window.TEACHING_CONFIG (from js/config.js) for branding
   and palette, but degrades to no-ops if it isn't present.
   ========================================================================== */


/* === THEME TOGGLE ========================================================
   Three states cycling auto → (light|dark) → auto, where the manual step is
   whichever is the *opposite* of the current system theme — so one click
   always visibly changes something. The pre-paint inline script in each
   page's <head> has already set data-theme; this only handles the toggle
   and keeps the icon, label and browser-chrome colour in sync.
   ======================================================================== */
function setupThemeToggle() {
    const KEY = 'theme-preference';
    const BTN = document.getElementById('theme-toggle');
    const icons = {
        auto: 'fa-solid fa-adjust',
        light: 'fa-regular fa-sun',
        dark: 'fa-regular fa-moon',
    };

    const getSaved = () => localStorage.getItem(KEY) || 'auto';

    const currentIsDark = () => {
        const forced = document.documentElement.getAttribute('data-theme');
        if (forced) return forced === 'dark';
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    };

    // Keep the address-bar / status-bar colour in step with the page. Only
    // the unconditional <meta name="theme-color"> is touched; the
    // prefers-color-scheme-scoped ones stay as the auto-mode fallback.
    const updateThemeColorMeta = () => {
        const meta = document.querySelector('meta[name="theme-color"]:not([media])');
        if (meta) meta.setAttribute('content', currentIsDark() ? '#121212' : '#f4f4f4');
    };

    // The icon is replaced rather than reclassed: Font Awesome's SVG mode
    // swaps each <i> for an <svg>, so setting className on the original
    // element would have no effect once the kit has run.
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
        localStorage.setItem(KEY, pref);
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


/* === ROW-AWARE BUTTON ROUNDING ===========================================
   A wrapped button group should look like one pill per visual row, not one
   pill overall — so the corner radii depend on where each button actually
   landed after wrapping, which only the layout knows. Buttons are bucketed
   by offsetTop (5px tolerance for sub-pixel rounding) and the first/last of
   each row get the outer edges.
   ======================================================================== */
function updateButtonRows(container) {
    const buttons = Array.from(container.children)
        .filter(b => b.tagName === 'BUTTON' && b.style.display !== 'none');
    if (!buttons.length) return;

    buttons.forEach(b => b.classList.remove(
        'first-in-row', 'last-in-row', 'only-in-row', 'grow-row', 'middle-in-row'));

    const rows = {};
    buttons.forEach(btn => {
        const top = btn.offsetTop;
        const key = Object.keys(rows).find(k => Math.abs(parseInt(k, 10) - top) < 5);
        if (key) rows[key].push(btn);
        else rows[top] = [btn];
    });

    Object.values(rows)
        .sort((a, b) => a[0].offsetTop - b[0].offsetTop)
        .forEach((rowButtons, index) => {
            if (rowButtons.length === 1) {
                // A lone button on the first row is a standalone pill; a lone
                // button on a later row is the tail of a wrap, so it keeps the
                // squared-off look of a group member.
                rowButtons[0].classList.add(index === 0 ? 'only-in-row' : 'middle-in-row');
            } else {
                rowButtons[0].classList.add('first-in-row');
                rowButtons[rowButtons.length - 1].classList.add('last-in-row');
            }
        });
}

// Keeps a container's row classes correct across re-renders and resizes.
// The observer is stored on the element so repeated calls don't stack up.
function trackButtonRows(container) {
    if (!container) return;
    updateButtonRows(container);
    if (!container._rowObserver) {
        container._rowObserver = new ResizeObserver(() => updateButtonRows(container));
        container._rowObserver.observe(container);
    }
}


/* === HORIZONTAL SCROLL FADES =============================================
   Marks a horizontally overflowing strip so main.css can mask its edges,
   and drops the mask on whichever end you've reached (no fade pointing at
   content that isn't there).
   ======================================================================== */
function updateScrollFaders(el) {
    const scrollable = el.scrollWidth > el.clientWidth + 1;
    el.classList.toggle('is-scrollable', scrollable);
    if (scrollable) {
        el.classList.toggle('at-start', el.scrollLeft < 5);
        el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 5);
    } else {
        el.classList.remove('at-start', 'at-end');
    }
}

function initializeScrollFaders(selector) {
    const sel = selector ||
        '.course-buttons-container, .course-actions, .course-info, .skeleton-actions, .skeleton-info-grid';
    document.querySelectorAll(sel).forEach(el => {
        if (el._faderBound) { updateScrollFaders(el); return; }
        el._faderBound = true;
        updateScrollFaders(el);
        el.addEventListener('scroll', () => updateScrollFaders(el), { passive: true });
        new ResizeObserver(entries => entries.forEach(e => updateScrollFaders(e.target))).observe(el);
    });
}


/* === SEMESTER PROGRESS ===================================================
   Shared so the admin's live preview and the public page's week counter can
   never disagree: both call these, neither reimplements them.
   ======================================================================== */

// 1-based teaching week, or null when the dates aren't set yet.
function calculateSemesterWeek(start, end, holidayStart, holidayWeeks) {
    if (!start || !end) return null;

    const startDate = new Date(start);
    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    const rawWeek = Math.ceil((new Date() - startDate) / oneWeek);
    if (rawWeek < 1) return 1;   // semester hasn't started yet

    let adjusted = rawWeek;
    const weeks = parseInt(holidayWeeks, 10) || 0;

    if (holidayStart && weeks > 0) {
        const holidayStartWeek = Math.ceil((new Date(holidayStart) - startDate) / oneWeek);
        if (rawWeek >= holidayStartWeek) {
            // Inside the break: freeze on the last teaching week rather than
            // counting weeks nobody is at university for.
            if (rawWeek < holidayStartWeek + weeks) return Math.max(1, holidayStartWeek - 1);
            adjusted = rawWeek - weeks;
        }
    } else if (weeks > 0) {
        // A break length with no start date — fall back to a flat subtraction.
        adjusted = Math.max(1, rawWeek - weeks);
    }

    const totalWeeks = Math.ceil((new Date(end) - startDate) / oneWeek) - weeks;
    return Math.min(adjusted, Math.max(1, totalWeeks));
}

// Percentage of the semester elapsed, clamped to 0–100.
function semesterProgress(start, end) {
    if (!start || !end) return 0;
    const from = new Date(start), to = new Date(end);
    if (!(to > from)) return 0;
    return Math.min(Math.max((new Date() - from) / (to - from) * 100, 0), 100);
}


/* === FOOTER BRANDING ===================================================== */
function updateYear() {
    const el = document.getElementById('currentYear');
    if (el) el.textContent = new Date().getFullYear();
}

// Fills the Home link, owner name and copyright start year from
// config.js, so nothing personal is hard-coded into the markup.
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
