/* ==========================================================================
   timetable.js — renderer for the EIS timetable fragment.

   Turns the raw HTML fragment returned by the `eis-timetable` Edge Function
   into the presented table: dead columns trimmed, day names shortened, time
   columns equalised, the whole thing scaled to fit, plus the click-through
   "more info" popover.

   Shared by course-page.js and the public and admin timetable pages.

   Plain (non-module) script on purpose: these stay window globals, so the
   pages call them unqualified. Load it before the page controller.

   Depends on: DOMPurify (for the popover body) and the .tt-* rules in
   /css/main.css. Nothing else — no page state, no config.

   Public entry points:
     fitTimetable(container)          prune + abbreviate + equalise + scale
     wireTimetableTooltips(container) click-through "more info" popover
     hideTtPopover()                  dismiss it (e.g. when closing a table)
   ========================================================================== */

// Trims dead weight from the EIS table before fitting:
//   • Time columns: empty ones are trimmed off BOTH ends, right up to
//     the first and last lecture — never in between. The Week and Day
//     columns (0 and 1) are always kept.
//   • Rows: left untouched EXCEPT an empty Saturday, which is removed.
//     Other empty days stay — a two-week exam timetable must keep its
//     shape, so we don't collapse arbitrary blank days.
// Idempotent, so re-running on resize is safe.
function pruneTimetable(table) {
    const rows = Array.from(table.rows);
    const isCourse = cell => !!(cell.querySelector && cell.querySelector('.timetable-day-course'));

    // Occupancy matrix resolving colspan/rowspan into real column indexes
    // (matrix[row][col] = the cell covering that slot).
    const matrix = [];
    rows.forEach((tr, r) => {
        matrix[r] = matrix[r] || [];
        let c = 0;
        for (const cell of tr.cells) {
            while (matrix[r][c] !== undefined) c++;
            const cs = cell.colSpan || 1, rs = cell.rowSpan || 1;
            for (let i = 0; i < rs; i++) {
                matrix[r + i] = matrix[r + i] || [];
                for (let j = 0; j < cs; j++) matrix[r + i][c + j] = cell;
            }
            c += cs;
        }
    });

    // --- Trim empty time columns off both ends (cols 0/1 = Week/Day) ---
    let firstUsed = Infinity, lastUsed = -Infinity;
    matrix.forEach(row => row.forEach((cell, c) => {
        if (c >= 2 && cell && isCourse(cell)) {
            firstUsed = Math.min(firstUsed, c);
            lastUsed = Math.max(lastUsed, c);
        }
    }));

    if (lastUsed >= 2) {
        // Trim empty time columns right up to the first and last lecture
        // (no padding column on either side).
        const leftKeep = firstUsed;
        const rightKeep = lastUsed;
        const kept = c => c < 2 || (c >= leftKeep && c <= rightKeep);

        const handled = new Set();
        matrix.forEach(row => {
            row.forEach((cell, c) => {
                if (!cell || handled.has(cell)) return;
                handled.add(cell);
                const start = row.indexOf(cell);
                const span = cell.colSpan || 1;
                let keptCols = 0;
                for (let k = start; k < start + span; k++) if (kept(k)) keptCols++;
                if (keptCols === 0) cell.remove();
                else if (keptCols < span) cell.colSpan = keptCols;
            });
        });
    }

    // --- Remove an empty Saturday row-group only ---
    // Group tbody rows by their day cell (matrix column 1); each week's
    // Saturday is its own cell, so multi-week tables are handled too.
    const groups = new Map();
    rows.forEach((tr, r) => {
        if (tr.parentElement.tagName !== 'TBODY') return;
        const dayCell = matrix[r][1];
        if (!dayCell) return;
        if (!groups.has(dayCell)) groups.set(dayCell, []);
        groups.get(dayCell).push(r);
    });
    groups.forEach((rIdxs, dayCell) => {
        if (!/saturday/i.test(dayCell.textContent || '')) return; // only Saturday
        const hasCourse = rIdxs.some(r => matrix[r].some((cell, c) => c >= 2 && cell && isCourse(cell)));
        if (hasCourse) return; // keep a Saturday that actually has lectures
        const weekCell = matrix[rIdxs[0]][0];
        // Never remove the rows that *define* the week-number cell.
        if (weekCell && rIdxs.some(r => Array.from(rows[r].cells).includes(weekCell))) return;
        rIdxs.forEach(r => rows[r].remove());
        if (weekCell) weekCell.rowSpan = Math.max(1, weekCell.rowSpan - rIdxs.length);
    });

    // --- Drop the Week column when the timetable spans a single week ---
    // The week-number cells are the numeric <th>s in the body; one means
    // one week, so the whole column (its header + that cell) is dead.
    const body = table.tBodies[0];
    if (body) {
        const weekCells = Array.from(body.querySelectorAll('th'))
            .filter(th => /^\s*\d+\s*$/.test(th.textContent || ''));
        if (weekCells.length === 1) {
            weekCells[0].remove();
            const headRow = table.tHead && table.tHead.rows[0];
            const weekHead = headRow && headRow.cells[0];
            if (weekHead && /week/i.test(weekHead.textContent || '')) weekHead.remove();
        }
    }
}

// Shortens day names to Mon/Tue/… so the Day column can be as narrow as
// the time columns. Must run AFTER pruneTimetable (which matches the
// Saturday row by its full name) and BEFORE equalizeColumns (which
// measures column widths off the current text) — the column would
// otherwise stay sized for "Wednesday" even after the label shortens.
function abbreviateDays(table) {
    const body = table.tBodies[0];
    if (!body) return;
    const ABBR = {
        monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
        friday: 'Fri', saturday: 'Sat', sunday: 'Sun'
    };
    Array.from(body.rows).forEach(row => {
        Array.from(row.cells).forEach(cell => {
            if (cell.tagName !== 'TH') return;
            const key = (cell.textContent || '').trim().toLowerCase();
            if (ABBR[key]) cell.textContent = ABBR[key];
        });
    });
}

// Gives every time column the same width (distributed equally), keeping
// the total time-width the same so the fit scale — and thus the on-screen
// text size — is unchanged. Content that no longer fits a column is cut
// off with an ellipsis (see the .tt-fitted CSS). The Week/Day columns are
// left at their natural width; only the time slots are equalised.
function equalizeColumns(table) {
    const head = table.tHead && table.tHead.rows[0];
    if (!head) return;
    const cells = Array.from(head.cells);
    // Clear any widths from a previous run so the auto measurement below
    // reflects real content, not last time's equalised columns.
    cells.forEach(c => { c.style.width = ''; });
    table.style.tableLayout = 'auto';
    table.style.width = 'auto';
    const isTime = c => /\d{1,2}:\d{2}/.test(c.textContent || '');
    const timeCells = cells.filter(isTime);
    const fixedCells = cells.filter(c => !isTime(c));
    if (timeCells.length < 2) return;

    const fixedWidths = fixedCells.map(c => Math.ceil(c.getBoundingClientRect().width));
    const totalTimeW = timeCells.reduce((s, c) => s + c.getBoundingClientRect().width, 0);
    const n = timeCells.length;
    const colW = Math.max(44, Math.round(totalTimeW / n));
    const fixedTotal = fixedWidths.reduce((a, b) => a + b, 0);

    table.style.tableLayout = 'fixed';
    table.style.width = (fixedTotal + n * colW) + 'px';
    fixedCells.forEach((c, i) => { c.style.width = fixedWidths[i] + 'px'; });
    timeCells.forEach(c => { c.style.width = colW + 'px'; });
}

// Forces the EIS fragment's full desktop presentation (course names +
// room details, not the stripped mobile view) and scales the whole
// table down so it always fits the container width — no horizontal
// scrollbar, nothing hidden. On wide screens where it already fits, it
// just fills the container like a normal table (no scaling).
function fitTimetable(container) {
    const inner = container.querySelector('.tt-inner');
    const table = inner && inner.querySelector('table');
    if (!table) return;
    inner.classList.add('tt-fitted');
    pruneTimetable(table);
    abbreviateDays(table);
    equalizeColumns(table);

    // Wrap the table once so the wrapper can clip its unscaled layout box
    // (a CSS transform doesn't shrink the space the element reserves).
    let wrap = inner.querySelector('.tt-scale-wrap');
    if (!wrap || table.parentNode !== wrap) {
        wrap = document.createElement('div');
        wrap.className = 'tt-scale-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
    }

    // Measure at natural width, then fill (wide) or scale down (narrow).
    table.style.transform = 'none';
    // width/tableLayout were set by equalizeColumns; measure that.
    const naturalW = table.offsetWidth;
    const avail = wrap.clientWidth;
    if (naturalW <= avail) {
        table.style.width = '100%';
        wrap.style.height = '';
    } else {
        const scale = avail / naturalW;
        const naturalH = table.offsetHeight;
        table.style.transform = `scale(${scale})`;
        wrap.style.height = (naturalH * scale) + 'px';
    }
}

// --- Timetable cell "more info" popover ---
// EIS's own page shows this on click via tippy.js + jQuery, loaded from
// its own site — none of which we pull in (and we strip <script> tags
// from the proxied fragment on purpose). Each course cell still carries
// its data-tippy-html attribute though (plain data, not a script), so we
// read that directly and render our own lightweight popover instead.
let ttPopoverEl = null;
let ttOpenedAt = 0;

function ensureTtPopover() {
    if (ttPopoverEl) return ttPopoverEl;
    ttPopoverEl = document.createElement('div');
    ttPopoverEl.className = 'tt-popover';
    ttPopoverEl.innerHTML = '<button type="button" class="tt-popover-close" aria-label="Close">&times;</button><div class="tt-popover-body"></div>';
    document.body.appendChild(ttPopoverEl);
    ttPopoverEl.querySelector('.tt-popover-close').onclick = hideTtPopover;
    return ttPopoverEl;
}

function hideTtPopover() {
    if (ttPopoverEl) {
        ttPopoverEl.classList.remove('visible');
        ttPopoverEl._forCell = null;
    }
}

function showTtPopover(cell) {
    const raw = cell.dataset.tippyHtml;
    if (!raw) return;
    const popover = ensureTtPopover();
    // Sanitized separately here: the initial DOMPurify pass over the
    // fragment doesn't recurse into data-* attribute values, so this
    // string was never actually sanitized until now.
    popover.querySelector('.tt-popover-body').innerHTML =
        DOMPurify.sanitize(raw, { ADD_TAGS: ['style'], FORCE_BODY: true });
    popover.classList.add('visible');
    popover._forCell = cell;
    ttOpenedAt = Date.now();

    const margin = 10;
    const rect = cell.getBoundingClientRect();
    const popW = popover.offsetWidth;
    const popH = popover.offsetHeight;

    let left = rect.left + rect.width / 2 - popW / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));

    let top = rect.bottom + 8;
    if (top + popH > window.innerHeight - margin) top = rect.top - popH - 8;
    top = Math.max(margin, top);

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

function wireTimetableTooltips(container) {
    container.addEventListener('click', e => {
        const cell = e.target.closest('[data-tippy-html]');
        if (!cell) return;
        e.stopPropagation();
        if (ttPopoverEl && ttPopoverEl.classList.contains('visible') && ttPopoverEl._forCell === cell) {
            hideTtPopover();
            return;
        }
        showTtPopover(cell);
    });

    // Dismiss on outside click, Escape, or scroll (a fixed-position
    // popover would otherwise drift away from the cell it's anchored to).
    document.addEventListener('click', e => {
        if (ttPopoverEl && ttPopoverEl.classList.contains('visible') && !ttPopoverEl.contains(e.target)) {
            hideTtPopover();
        }
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') hideTtPopover();
    });
    // Ignore scrolls fired by the opening tap itself (mobile taps often
    // emit a tiny scroll) — only genuine later scrolls dismiss it.
    window.addEventListener('scroll', () => {
        if (Date.now() - ttOpenedAt > 400) hideTtPopover();
    }, { passive: true, capture: true });
}
