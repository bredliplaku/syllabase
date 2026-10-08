/* ==========================================================================
   Class Timetable — public page.

   Data comes from the `timetable_rows` table in the shared Supabase project
   (the same one behind the course pages), edited from /timetable/admin/. One
   anonymous REST read fetches the whole configuration; class timetables
   themselves are pulled on demand through the `eis-timetable` Edge Function,
   which proxies eis.epoka.edu.al (it sends no CORS headers of its own).

   Loaded before this file:
     ../js/config.js             window.TEACHING_CONFIG
     ../js/timetable.js          fitTimetable(), wireTimetableTooltips()
     js/common.js                theme toggle, button rows, scroll fades,
                                 branding, semester maths

   The first two are the course pages' own files on purpose — this page
   depends on them, never the reverse, so timetable/ can be removed on its own.
   ========================================================================== */

const SUPABASE_URL = window.TEACHING_CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = window.TEACHING_CONFIG.supabaseAnonKey;

const CACHE_KEY = 'timetable_rows_v2';
const ACTIVE_CATEGORY_KEY = 'timetable_active_category';
const ACTIVE_ENTRY_KEY = 'timetable_active_entry';

// Populated by groupRows(); shape mirrors the `type` column of timetable_rows.
let config = {
    settings: {},        // semester_start | semester_end | holiday_start | holiday_weeks
    infoItems: [],       // { icon, text }
    actionButtons: [],   // { label, icon, url, cssClass }
    categories: [],      // { name, icon, kind, id }
    entries: {},         // category name -> [{ label, timetableId, classId, lecturerId }]
};

// Which view is currently open. Also used to drop stale fetch responses when
// the user clicks away mid-request.
let activeKey = null;


/* === BOOT ================================================================ */

function init() {
    applyThemeDefaults();
    applyOwnerBranding();
    setupThemeToggle();
    setupSwipeGestures();

    // One listener for the lifetime of the page — wiring it per load would
    // stack duplicate handlers on the same container.
    wireTimetableTooltips(document.getElementById('native-timetable-container'));

    // A resize changes the available width, so the scale factor has to be
    // recomputed for whichever table is open.
    window.addEventListener('resize', () => {
        const c = document.getElementById('native-timetable-container');
        if (c && c.classList.contains('visible')) fitTimetable(c);
    });

    loadAllData();
}

window.addEventListener('load', init);


/* === DATA ================================================================
   Stale-while-revalidate: paint whatever was cached last visit immediately,
   then refresh from Supabase in the background. A first-time visitor sees
   the skeleton until the network answers.
   ======================================================================== */

function sbFetch(endpoint) {
    return fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    });
}

async function loadAllData() {
    let hasCache = false;

    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            hasCache = true;
            renderAll(groupRows(JSON.parse(cached)));
            document.body.classList.remove('is-loading');
        }
    } catch (err) {
        console.error('Cache read failed:', err);
        localStorage.removeItem(CACHE_KEY);
    }

    try {
        const res = await sbFetch(
            'timetable_rows?select=row_uid,section,row_index,type,b,c,d,e&order=row_index');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();

        localStorage.setItem(CACHE_KEY, JSON.stringify(rows));
        renderAll(groupRows(rows));
    } catch (err) {
        console.error('Could not load timetable configuration:', err);
    } finally {
        // Never leave the skeleton up: with no cache and a failed request the
        // page still shows its header rather than an endless skeleton.
        document.body.classList.remove('is-loading');
    }
}

// Turns the flat slot rows into the shape the renderers want.
function groupRows(rows) {
    const grouped = {
        settings: {}, infoItems: [], actionButtons: [], categories: [], entries: {},
    };

    // The single `order=row_index` above sorts globally, which is enough:
    // rows are bucketed by section here, and each bucket stays in order.
    (rows || []).forEach(r => {
        switch (r.type) {
            case 'setting':
                if (r.b) grouped.settings[r.b] = r.c;
                break;
            case 'info_item':
                if (r.c) grouped.infoItems.push({ icon: r.b || 'fa-solid fa-circle-info', text: r.c });
                break;
            case 'action_button':
                if (r.b && r.d) {
                    grouped.actionButtons.push({
                        label: r.b, icon: r.c || 'fa-solid fa-link', url: r.d, cssClass: r.e || '',
                    });
                }
                break;
            case 'category':
                if (r.b) {
                    grouped.categories.push({
                        name: r.b,
                        icon: r.c || 'fa-solid fa-layer-group',
                        kind: r.d === 'lecturer' ? 'lecturer' : 'timetable',
                        id: categoryDomId(r.b),
                    });
                }
                break;
            case 'entry':
                // e === '1': hidden by the admin, kept in the database but not shown.
                if (r.b && r.e !== '1') {
                    (grouped.entries[r.section] ||= []).push({
                        label: r.b, timetableId: r.c || '', classId: r.d || '',
                    });
                }
                break;
            case 'lecturer':
                if (r.b && r.e !== '1') {
                    (grouped.entries[r.section] ||= []).push({
                        label: r.b, lecturerId: r.c || '',
                    });
                }
                break;
        }
    });

    // Categories with no visible entries are left out.
    grouped.categories = grouped.categories.filter(c => (grouped.entries[c.name] || []).length > 0);

    return grouped;
}

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
    const a = parseCourseLabel(aLabel);
    const b = parseCourseLabel(bLabel);

    if (a.hasNum && b.hasNum) {
        if (a.num !== b.num) {
            return a.num - b.num;
        }
        const textCmp = a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: 'base' });
        if (textCmp !== 0) return textCmp;
        return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
    }

    if (a.hasNum && !b.hasNum) return -1;
    if (!a.hasNum && b.hasNum) return 1;

    // Non-numbered items (e.g. Lecturer names): sort by clean name (ignoring titles)
    const cleanCmp = a.clean.localeCompare(b.clean, undefined, { numeric: true, sensitivity: 'base' });
    if (cleanCmp !== 0) return cleanCmp;

    return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
}

// Category names are author-supplied, so the DOM id is derived rather than
// used raw — spaces and punctuation would break the querySelector below.
function categoryDomId(name) {
    return `cat-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-content`;
}


/* === RENDER ============================================================== */

function renderAll(next) {
    config = next;
    renderSemesterInfo();
    renderInfoItems();
    renderActionButtons();
    renderCategories();
    initializeScrollFaders();
}

function renderSemesterInfo() {
    updateWeekCounter();
    updateProgress();
}

function renderInfoItems() {
    const container = document.querySelector('.course-info');
    if (!container) return;

    container.querySelectorAll('.dynamic-info-item').forEach(el => el.remove());

    config.infoItems.forEach(item => {
        const span = document.createElement('span');
        span.className = 'info-item dynamic-info-item';
        span.innerHTML = `<i class="${escapeAttr(item.icon)}"></i>`;
        span.append(item.text);   // author text as a text node, never parsed as HTML
        container.appendChild(span);
    });
}

function renderActionButtons() {
    const container = document.getElementById('dynamic-course-actions');
    if (!container) return;

    container.innerHTML = '';
    config.actionButtons.forEach(item => {
        const button = document.createElement('button');
        if (item.cssClass) button.className = item.cssClass;
        button.innerHTML = `<i class="${escapeAttr(item.icon)}"></i>`;
        button.append(item.label);
        button.onclick = () => window.open(item.url, '_self', 'noopener,noreferrer');
        container.appendChild(button);
    });
    trackButtonRows(container);
}

// Builds the category tab strip and one entry-button strip per category.
// Re-runs on the background refresh, so it has to be idempotent: the tab
// strip is rebuilt only when the category list actually changed, otherwise
// switching tabs mid-refresh would snap back.
function renderCategories() {
    const main = document.getElementById('main-container');
    if (!main) return;
    if (!config.categories.length) {
        document.getElementById('category-tabs')?.remove();
        document.getElementById('category-panes')?.remove();
        return;
    }

    const signature = config.categories.map(c => `${c.id}|${c.icon}|${c.kind}`).join(',');
    let tabs = document.getElementById('category-tabs');
    let panes = document.getElementById('category-panes');

    if (!tabs || tabs.dataset.signature !== signature) {
        const previous = tabs ? activeCategoryId() : localStorage.getItem(ACTIVE_CATEGORY_KEY);

        tabs?.remove();
        panes?.remove();

        tabs = document.createElement('div');
        tabs.id = 'category-tabs';
        tabs.className = 'course-buttons-container';
        tabs.dataset.signature = signature;

        panes = document.createElement('div');
        panes.id = 'category-panes';

        // Fall back to the first tab if the remembered one no longer exists
        // (renamed or deleted in the admin since the last visit).
        const known = config.categories.some(c => c.id === previous);
        const activeId = known ? previous : config.categories[0].id;

        config.categories.forEach(cat => {
            const button = document.createElement('button');
            button.className = 'course-button';
            button.dataset.category = cat.id;
            // Same structure as the teaching course tabs: the selected tab closes its
            // icon and shows its name in bold (main.css .course-button-icon / -label).
            button.innerHTML = `<i class="${escapeAttr(cat.icon)} fa-fw course-button-icon" aria-hidden="true"></i>` +
                '<span class="course-button-label"><span class="course-button-swap"><span></span></span></span>';
            button.querySelector('.course-button-swap > span').textContent = cat.name;
            if (cat.id === activeId) button.classList.add('active');
            tabs.appendChild(button);

            const pane = document.createElement('div');
            pane.id = cat.id;
            pane.className = 'category-content';
            if (cat.id === activeId) pane.classList.add('active');
            pane.innerHTML =
                `<div class="course-buttons-container" data-entries-for="${escapeAttr(cat.name)}">
                     <div class="category-loading">
                         <i class="fa-solid fa-circle-notch fa-spin fa-2x"></i>
                     </div>
                 </div>`;
            panes.appendChild(pane);
        });

        const anchor = document.getElementById('native-timetable-container');
        main.insertBefore(tabs, anchor);
        main.insertBefore(panes, anchor);

        setupCategoryButtons();
        trackButtonRows(tabs);
    }

    config.categories.forEach(cat => renderEntries(cat));
    restoreActiveEntry();
}

function renderEntries(cat) {
    const container = document.querySelector(`[data-entries-for="${cssEscape(cat.name)}"]`);
    if (!container) return;

    const items = config.entries[cat.name] || [];

    // Skip the rebuild when nothing changed, so the background refresh doesn't
    // flicker the strip or drop the .active class off the open entry.
    const hash = JSON.stringify(items);
    if (container.dataset.hash === hash) return;
    container.dataset.hash = hash;

    container.innerHTML = '';

    if (!items.length) {
        container.innerHTML = '<div class="category-empty">Nothing here yet.</div>';
        return;
    }

    items.forEach(item => {
        const button = document.createElement('button');
        button.className = 'course-button secondary-action';
        button.textContent = item.label;

        if (cat.kind === 'lecturer') {
            button.dataset.lecturerId = item.lecturerId;
            button.onclick = e => {
                e.stopPropagation();
                loadLecturer(item.lecturerId, button);
            };
        } else {
            button.dataset.tId = item.timetableId;
            button.dataset.cId = item.classId;
            button.onclick = e => {
                e.stopPropagation();
                loadTimetable(item.timetableId, item.classId, button);
            };
        }

        container.appendChild(button);
    });

    trackButtonRows(container);
    initializeScrollFaders();
}

// Reopens whatever was open last visit. Only auto-clicks when nothing is
// currently open — a background refresh must never yank the user's view.
function restoreActiveEntry() {
    const saved = localStorage.getItem(ACTIVE_ENTRY_KEY);
    if (!saved) return;

    let parsed;
    try { parsed = JSON.parse(saved); } catch { localStorage.removeItem(ACTIVE_ENTRY_KEY); return; }

    const target = parsed.kind === 'lecturer'
        ? document.querySelector(`.course-button.secondary-action[data-lecturer-id="${cssEscape(parsed.id)}"]`)
        : document.querySelector(
            `.course-button.secondary-action[data-t-id="${cssEscape(parsed.tId)}"][data-c-id="${cssEscape(parsed.cId)}"]`);
    if (!target) return;

    if (activeKey) {
        highlightActiveButton(target);
    } else {
        target.click();
        // Let the click render first, then bring the button into view — on a
        // narrow screen it's often scrolled off the end of the strip.
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }), 50);
    }
}


/* === VIEWS =============================================================== */

function setupCategoryButtons() {
    document.querySelectorAll('.course-button[data-category]').forEach(button => {
        button.addEventListener('click', e => {
            e.stopPropagation();
            document.querySelectorAll('.course-button[data-category]')
                .forEach(b => b.classList.remove('active'));
            button.classList.add('active');
            document.querySelectorAll('.category-content')
                .forEach(c => c.classList.toggle('active', c.id === button.dataset.category));
            hideAllViews();

            localStorage.setItem(ACTIVE_CATEGORY_KEY, button.dataset.category);
            // Switching tabs closes the open view, so the remembered entry
            // would no longer match what's on screen.
            localStorage.removeItem(ACTIVE_ENTRY_KEY);
            initializeScrollFaders();
        });
    });
}

function activeCategoryId() {
    return document.querySelector('.course-button[data-category].active')?.dataset.category || null;
}

function highlightActiveButton(clicked) {
    document.querySelectorAll('.course-button.secondary-action')
        .forEach(b => b.classList.remove('active'));
    if (clicked) clicked.classList.add('active');
}

function hideAllViews() {
    hideTtPopover();

    const table = document.getElementById('native-timetable-container');
    table.classList.remove('visible', 'active');
    table.style.display = 'none';

    const lecturer = document.getElementById('lecturer-container');
    lecturer.classList.remove('visible', 'active', 'is-loaded');
    lecturer.style.display = 'none';

    highlightActiveButton(null);
    activeKey = null;
}

async function loadTimetable(timetableId, classId, btn) {
    const key = `tt:${timetableId}:${classId}`;
    if (activeKey === key) { hideAllViews(); localStorage.removeItem(ACTIVE_ENTRY_KEY); return; }

    hideAllViews();
    activeKey = key;
    highlightActiveButton(btn);
    localStorage.setItem(ACTIVE_ENTRY_KEY,
        JSON.stringify({ kind: 'timetable', tId: timetableId, cId: classId }));

    const container = document.getElementById('native-timetable-container');
    const inner = container.querySelector('.tt-inner');

    // Empty string, not 'block': the stylesheet's display:grid has to apply or
    // the grid-template-rows expand/collapse animation can't run.
    container.style.display = '';
    inner.innerHTML = '<div class="iframe-loader"></div>';

    // Commit the collapsed (0fr) state before .visible opens it, or the browser skips the
    // animation (rAF alone is unreliable after display:none).
    void container.offsetHeight;
    container.classList.add('visible', 'active');

    try {
        // A public proxy (verify_jwt off); the keys only match the REST calls above.
        const res = await fetch(
            `${SUPABASE_URL}/functions/v1/eis-timetable?tId=${encodeURIComponent(timetableId)}&cId=${encodeURIComponent(classId)}`,
            { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();

        // The user may have switched or closed the view mid-request.
        if (activeKey !== key) return;

        if (!html.includes('<table')) {
            inner.innerHTML = html.includes('tt-error')
                ? DOMPurify.sanitize(html)
                : '<div class="tt-error">No timetable found for this class.</div>';
            return;
        }

        // FORCE_BODY keeps the allowed <style> (the timetable colours), which DOMPurify
        // otherwise drops from a fragment.
        inner.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
        fitTimetable(container);
    } catch (err) {
        console.error('Timetable load error:', err);
        if (activeKey !== key) return;
        inner.innerHTML = '<div class="tt-error">Could not load the timetable. Please try again later.</div>';
    }
}

// The lecturer view is EIS's own live page in an iframe. No proxy needed:
// framing isn't subject to CORS, and there's nothing to extract from it.
function loadLecturer(lecturerId, btn) {
    if (!lecturerId || lecturerId === '#') return;

    const key = `lec:${lecturerId}`;
    if (activeKey === key) { hideAllViews(); localStorage.removeItem(ACTIVE_ENTRY_KEY); return; }

    hideAllViews();
    activeKey = key;
    highlightActiveButton(btn);
    localStorage.setItem(ACTIVE_ENTRY_KEY, JSON.stringify({ kind: 'lecturer', id: lecturerId }));

    const container = document.getElementById('lecturer-container');
    container.style.display = 'block';
    container.classList.remove('is-loaded');   // show the spinner

    const iframe = document.getElementById('lecturer-iframe');
    iframe.onload = () => container.classList.add('is-loaded');
    iframe.src = `https://eis.epoka.edu.al/publictimetable/live/${encodeURIComponent(lecturerId)}`;

    // Same reflow-before-transition reason as loadTimetable().
    void container.offsetHeight;
    container.classList.add('visible', 'active');
}


/* === SEMESTER PROGRESS ===================================================
   calculateSemesterWeek() and semesterProgress() live in js/common.js so the
   admin's live preview runs the identical arithmetic.
   ======================================================================== */

function updateWeekCounter() {
    const el = document.getElementById('week-counter');
    if (!el) return;
    const week = calculateSemesterWeek(
        config.settings.semester_start, config.settings.semester_end,
        config.settings.holiday_start, config.settings.holiday_weeks);
    el.textContent = week ? `Week ${week}` : 'Semester dates not set';
}

function updateProgress() {
    const bar = document.querySelector('.progress');
    if (!bar) return;
    bar.style.width =
        `${semesterProgress(config.settings.semester_start, config.settings.semester_end)}%`;
}


/* === SWIPE NAVIGATION ====================================================
   Left/right swipes step through entries when a view is open, or through the
   category tabs when nothing is. Swipes that start inside a horizontally
   scrollable strip are ignored — those belong to the strip.
   ======================================================================== */

function setupSwipeGestures() {
    let startX = 0;
    let insideScroller = false;

    document.body.addEventListener('touchstart', e => {
        startX = e.changedTouches[0].screenX;
        insideScroller = false;
        for (let el = e.target; el && el !== document.body; el = el.parentElement) {
            if (el.scrollWidth > el.clientWidth) { insideScroller = true; break; }
        }
    }, { passive: true });

    document.body.addEventListener('touchend', e => {
        if (insideScroller) return;
        const delta = e.changedTouches[0].screenX - startX;
        if (Math.abs(delta) < 50) return;
        navigate(delta < 0 ? 1 : -1);
    }, { passive: true });

    function navigate(direction) {
        const selector = activeKey
            ? '.category-content.active .course-button.secondary-action'
            : '.course-button[data-category]';
        const buttons = Array.from(document.querySelectorAll(selector));
        if (!buttons.length) return;

        const current = buttons.findIndex(b => b.classList.contains('active'));
        buttons[(current + direction + buttons.length) % buttons.length]?.click();
    }
}


/* === HELPERS ============================================================= */

// For values interpolated into an HTML attribute (icon classes from the DB).
function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// For values interpolated into a CSS selector string. Category names and EIS
// ids are author-supplied, so they can't go into querySelector unescaped.
function cssEscape(s) {
    const str = String(s ?? '');
    return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/["\\\]]/g, '\\$&');
}
