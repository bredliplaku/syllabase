/* ==========================================================================
   integrity.js — while an exam is taken on /exam/: the name watermark, and
   leaving the page.

   Each exam's settings (Exam settings in the course editor) choose:
   - watermark: the student's name and student ID (an anonymous exam's exam ID)
     large and faint along the left side of the screen, over everything but
     clicks go through: an invigilator reads it from the back of the room, and it
     is on any photo of the screen.
   - leave: 'record' records each time the student leaves the page (clicks
     outside the window, another tab or program, a reload); 'cooldown' also turns
     the screen red and locks the exam for cooldown_seconds when they come back,
     the same each time.
   Picking a file for a file question takes the page's focus too: that is not
   counted, unless the file chooser stays open for more than 3 minutes. A reload
   or a closed page is always recorded, with a countdown only when it lasted
   more than 5 seconds; a countdown already running carries on after it, where
   it was. Moving to another computer (the first one crashed) is recorded too,
   without a countdown.

   taking.js starts it with the exam and saves its state with the exam's (so a
   reload is counted and a countdown carries on), and sends activity() with the
   submission. Plain (non-module) script: examIntegrity is a window global.
   ========================================================================== */

const examIntegrity = (() => {
    const DEFAULTS = { watermark: true, leave: 'cooldown', cooldown_seconds: 15 };
    const MIN_AWAY_MS = 1000;                 // shorter blips (a notification) don't count
    const RELOAD_GRACE_MS = 5000;             // a quick reload is recorded, without a countdown
    const FILE_CHOOSER_GRACE_MS = 3 * 60000;  // picking a file for an answer
    const MAX_LISTED = 300;                   // leaves listed one by one; all are counted

    let settings = null;
    let state = null;     // { count, total, leaves, away: { from, how } | null, cooldownLeft, cooldownTotal }
    let save = () => { };
    let picking = false;  // the file chooser is (probably) open
    let leaving = false;  // the page is being reloaded or closed: later focus events are not a return
    let ticker = null, lastTick = 0;

    const awayNow = () => document.visibilityState === 'hidden' || !document.hasFocus();

    // options: settings, watermark ([big line, small line]), saved (snapshot() from before a
    // reload), movedSince (another computer's last check-in, when the exam moved from it), save.
    function start(options = {}) {
        stop();
        settings = { ...DEFAULTS, ...(options.settings || {}) };
        save = options.save || (() => { });
        state = { count: 0, total: 0, leaves: [], away: null, cooldownLeft: 0, cooldownTotal: 0, ...(options.saved || {}) };
        if (options.movedSince) state.away = { from: Date.parse(options.movedSince) || Date.now(), how: 'device' };
        if (settings.watermark && options.watermark?.length) showWatermark(options.watermark);
        // Saved while away: the page was reloaded or closed (or the computer changed), from then
        // until now. A countdown running then carries on where it was.
        if (state.away) back(Date.now());
        if (state.cooldownLeft > 0) showCooldown();
        window.addEventListener('blur', check);
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', check);
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);
        document.addEventListener('click', onClick, true);
        document.addEventListener('change', onPicked, true);
        document.addEventListener('cancel', onPicked, true);
        leaving = false;
        lastTick = Date.now();
        ticker = setInterval(tick, 250);
        check();
    }

    function stop() {
        window.removeEventListener('blur', check);
        window.removeEventListener('focus', check);
        document.removeEventListener('visibilitychange', check);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('change', onPicked, true);
        document.removeEventListener('cancel', onPicked, true);
        clearInterval(ticker);
        ticker = null;
        hideCooldown();
        document.getElementById('exam-watermark')?.remove();
        state = null;
        save = () => { };
        picking = false;
    }

    // Signing out mid-exam: away from now, counted once the exam resumes.
    function suspend() {
        if (!state) return;
        onPageHide();
        stop();
    }

    // For saving with the exam in progress (and in the draft another computer would carry on from).
    const snapshot = () => (state ? JSON.parse(JSON.stringify(state)) : null);

    // What the submission records. A student still away (the deadline submitting for them) is
    // counted up to now. saved: a snapshot, when the exam isn't running here (sent after a reboot).
    function activity(saved = null) {
        if (!state && saved) state = { count: 0, total: 0, leaves: [], away: null, cooldownLeft: 0, cooldownTotal: 0, ...saved };
        if (!state) return null;
        if (state.away) back(Date.now(), false);
        const result = {
            count: state.count, total_seconds: Math.round(state.total), leaves: state.leaves,
            cooldown: (settings || DEFAULTS).leave === 'cooldown', cooldown_seconds_total: Math.round(state.cooldownTotal),
        };
        if (!ticker) state = null; // only borrowed for this
        return result;
    }

    // ── Leaving and coming back ──
    function check() {
        if (!state || leaving) return;
        if (awayNow()) {
            if (state.away) return;
            const hidden = document.visibilityState === 'hidden';
            state.away = { from: Date.now(), how: hidden ? 'tab' : picking ? 'file' : 'window' };
            save();
        } else {
            picking = false;
            if (state.away) back(Date.now());
        }
    }

    function back(now, countdown = true) {
        const away = state.away;
        state.away = null;
        let ms = now - away.from;
        let how = away.how;
        if (how === 'file') { ms -= FILE_CHOOSER_GRACE_MS; how = 'window'; }
        // A reload, a closed page or another computer always counts; a countdown only after a
        // real absence, and not for the computer that broke down.
        if (ms >= MIN_AWAY_MS || how === 'reload' || how === 'device') {
            const seconds = Math.round(Math.max(0, ms) / 100) / 10;
            state.count++;
            state.total += seconds;
            if (state.leaves.length < MAX_LISTED) {
                state.leaves.push({ from: new Date(now - ms).toISOString(), to: new Date(now).toISOString(), seconds, how });
            }
            if (countdown && settings?.leave === 'cooldown' && how !== 'device' && (how !== 'reload' || ms > RELOAD_GRACE_MS)) startCooldown();
        }
        save();
    }

    function onPageHide() {
        if (!state) return;
        leaving = true;
        if (!state.away) state.away = { from: Date.now(), how: 'reload' };
        else state.away.how = 'reload';
        save();
    }

    // Back from the browser's back/forward cache, scripts still running: back on the page.
    function onPageShow(e) {
        if (!e.persisted || !state) return;
        leaving = false;
        if (state.away) back(Date.now());
        check();
    }

    // A click on a file question's chooser: the focus it takes isn't leaving.
    function onClick(e) {
        if (e.target.closest?.('input[type="file"], .file-answer-choose')) picking = true;
    }
    function onPicked(e) {
        if (e.target.matches?.('input[type="file"]')) setTimeout(() => { picking = false; }, 0);
    }

    // ── The countdown: the same length each time ──
    function startCooldown() {
        const seconds = settings.cooldown_seconds;
        state.cooldownLeft = Math.max(state.cooldownLeft, seconds);
        state.cooldownTotal += seconds;
        showCooldown();
    }

    // Runs only while the student is on the page.
    function tick() {
        const now = Date.now();
        const elapsed = (now - lastTick) / 1000;
        lastTick = now;
        if (!state || state.cooldownLeft <= 0) return;
        if (!awayNow()) state.cooldownLeft = Math.max(0, state.cooldownLeft - elapsed);
        renderCooldown();
        if (state.cooldownLeft <= 0) {
            hideCooldown();
            save();
        }
    }

    function showCooldown() {
        let el = document.getElementById('exam-cooldown');
        if (!el) {
            el = document.createElement('div');
            el.id = 'exam-cooldown';
            el.className = 'exam-cooldown';
            el.setAttribute('role', 'alertdialog');
            el.setAttribute('aria-modal', 'true');
            el.setAttribute('aria-labelledby', 'cooldown-title');
            el.innerHTML = `<div class="cooldown-card">
                <h2 id="cooldown-title">You left the exam page</h2>
                <p class="cooldown-count" aria-live="off"><span id="cooldown-seconds"></span></p>
                <p>You can go on once the countdown ends. The exam timer keeps running.</p>
                <p class="cooldown-note">Each time you leave is recorded for your lecturer.</p>
            </div>`;
            document.body.appendChild(el);
        }
        // Nothing behind it can be clicked or typed in meanwhile.
        const app = document.getElementById('admin-app');
        if (app) app.inert = true;
        document.body.classList.add('exam-cooling-down');
        renderCooldown();
    }

    function renderCooldown() {
        const seconds = document.getElementById('cooldown-seconds');
        if (seconds && state) seconds.textContent = String(Math.ceil(state.cooldownLeft));
    }

    function hideCooldown() {
        document.getElementById('exam-cooldown')?.remove();
        const app = document.getElementById('admin-app');
        if (app) app.inert = false;
        document.body.classList.remove('exam-cooling-down');
    }

    // ── The watermark: the name, large and faint, along the left side ──
    function showWatermark(lines) {
        const [big, small = ''] = lines.map(l => String(l || '').trim()).filter(Boolean);
        if (!big) return;
        let el = document.getElementById('exam-watermark');
        if (!el) {
            el = document.createElement('div');
            el.id = 'exam-watermark';
            el.setAttribute('aria-hidden', 'true');
            el.innerHTML = '<span class="watermark-name"></span><span class="watermark-id"></span>';
            document.body.appendChild(el);
        }
        el.querySelector('.watermark-name').textContent = big;
        el.querySelector('.watermark-id').textContent = small;
    }

    return { start, stop, suspend, snapshot, activity };
})();
