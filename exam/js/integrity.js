/* ==========================================================================
   integrity.js — while an exam is taken on /exam/: the name watermark, and
   leaving the page.

   Each exam's settings (Exam settings in the course editor) choose:
   - watermark: the student's name and student ID (an anonymous exam's exam ID)
     large and faint along the left side of the screen, over everything but
     clicks go through: an invigilator reads it from the back of the room, and it
     is on any photo of the screen.
   - leave: 'record' records each time the student leaves the page (clicks
     outside the window, another tab or program, a reload); 'cooldown' (Lock on
     leaving) also turns the screen red and locks the exam for cooldown_seconds
     when they come back, the same each time, and the exam is taken in full
     screen (no tabs, address bar or extension pop-ups; Windows holds its
     notifications back for a full-screen app), unless taking.js says not (an
     exam with a page of file questions: going back and forth would switch it
     on and off). Out of full screen the exam is covered until the student goes
     back, and that counts as leaving. Where the browser has no full screen
     (iPhone), or refuses it, the exam goes on without, and the record says so.
   The page is 'locked' (the questions) or 'free' (taking.js: the page of file
   questions, where students may go to other programs for their files). On a
   free page leaving is listed as allowed and never counted: no full screen, no
   notice, no countdown.
   Two kinds of leaving. The page out of sight (another tab, the browser
   minimised or covered, the screen locked) counts from half a second. The page
   still in sight but its window not the active one (a pop-up of the browser or
   an extension, a notification closed, a click outside the window), or out of
   full screen: the exam is covered at once by a notice saying so (without it, a
   window that lost the focus unseen would only lock at the student's next
   click, as if that click had done it). Back within VISIBLE_GRACE_MS, that is a
   short interruption, without a countdown, FREE_BRIEF times in an exam: never
   a way to look something up again and again. The screenshot keys (Print
   Screen, Windows+Shift+S), where the browser lets the page see them, count as
   leaving at once.
   Picking a file for a file question takes the page's focus too: that is not
   counted, unless the file chooser stays open for more than 3 minutes. A reload
   or a closed page is always recorded, with a countdown only when it lasted
   more than 5 seconds; a countdown already running carries on after it, where
   it was. Moving to another computer (the first one crashed) is recorded too,
   without a countdown. Coming back to a countdown plays an alarm (failure.mp3),
   as loud as the page can make it.

   taking.js starts it with the exam and saves its state with the exam's (so a
   reload is counted and a countdown carries on), and sends activity() with the
   submission. Plain (non-module) script: examIntegrity is a window global.
   ========================================================================== */

const examIntegrity = (() => {
    const DEFAULTS = { watermark: true, leave: 'cooldown', cooldown_seconds: 15 };
    const MIN_AWAY_MS = 500;                  // shorter blips aren't recorded at all
    const VISIBLE_GRACE_MS = 5000;            // the page in sight, its window not active: back within this, no countdown...
    const FREE_BRIEF = 3;                     // ...this many times in an exam
    const COVER_DELAY_MS = 300;               // the notice waits this long: focus often bounces straight back
    const SHOT_KEYS_MS = 1500;                // the window lost this soon after Windows+Shift: the screenshot tool took it
    const RELOAD_GRACE_MS = 5000;             // a quick reload is recorded, without a countdown
    const FILE_CHOOSER_GRACE_MS = 3 * 60000;  // picking a file for an answer
    const MAX_LISTED = 300;                   // leaves listed one by one; all are counted
    const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

    let settings = null;
    // { count, total, leaves, away: { from, how, free } | null, cooldownLeft, cooldownTotal,
    //   brief: short interruptions let go so far, fullscreen: 'unavailable' once the browser refused it }
    let state = null;
    let save = () => { };
    let mode = 'locked';  // 'free' on the page of file questions (setMode)
    let fullscreenAllowed = true; // false for an exam with a page of file questions (setMode)
    let picking = false;  // the file chooser is (probably) open
    let pickingAt = 0;
    let leaving = false;  // the page is being reloaded or closed: later focus events are not a return
    let ticker = null, lastTick = 0;
    let fsEntered = false; // full screen was reached on this page: leaving it counts from then
    let asking = false;    // full screen asked for, the browser not done yet
    let shotKeysAt = 0, shotAt = 0;

    // ── Full screen (the standard calls, and Safari's) ──
    const root = document.documentElement;
    const fullscreen = {
        possible: () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && !!(root.requestFullscreen || root.webkitRequestFullscreen),
        // Also the browser's own (F11), which pages can't start but can see.
        on: () => !!(document.fullscreenElement || document.webkitFullscreenElement) || !!window.matchMedia?.('(display-mode: fullscreen)').matches,
        enter: () => Promise.resolve((root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' })),
        exit: () => {
            if (!(document.fullscreenElement || document.webkitFullscreenElement)) return;
            try { Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen).call(document)).catch(() => { }); } catch { /* already out */ }
        },
    };
    const locked = () => mode === 'locked';
    const fullscreenNeeded = () => !!(state && locked() && fullscreenAllowed && settings?.leave === 'cooldown' && state.fullscreen !== 'unavailable' && fullscreen.possible());
    const hiddenNow = () => document.visibilityState === 'hidden';
    const awayNow = () => hiddenNow() || !document.hasFocus() || (fullscreenNeeded() && fsEntered && !fullscreen.on());

    // options: settings, watermark ([big line, small line]), saved (snapshot() from before a
    // reload), movedSince (another computer's last check-in, when the exam moved from it), save,
    // mode ('free' on the page of file questions), fullscreen (false: never asked for).
    function start(options = {}) {
        stop(true);
        settings = { ...DEFAULTS, ...(options.settings || {}) };
        save = options.save || (() => { });
        mode = options.mode === 'free' ? 'free' : 'locked';
        fullscreenAllowed = options.fullscreen !== false;
        state = { count: 0, total: 0, leaves: [], away: null, cooldownLeft: 0, cooldownTotal: 0, ...(options.saved || {}) };
        // Saved before short interruptions had a limit, or handed back: the ones listed.
        if (typeof state.brief !== 'number') state.brief = (state.leaves || []).filter(l => l.brief).length;
        // The server's time of the other device's last check-in, on this computer's clock.
        // On the page of file questions there, as allowed as any other leave.
        if (options.movedSince) state.away = { from: (Date.parse(options.movedSince) - (typeof examStore !== 'undefined' ? examStore.clockOffset() : 0)) || Date.now(), how: 'device', ...(locked() ? {} : { free: true }) };
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
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('keyup', onKey, true);
        FULLSCREEN_EVENTS.forEach(type => document.addEventListener(type, onFullscreenChange));
        leaving = false;
        fsEntered = fullscreenNeeded() && fullscreen.on();
        // Start was just pressed: full screen may still be asked for without another press.
        // Otherwise (a reload, a slow sign-in) the notice over the exam has the button.
        if (fullscreenNeeded() && !fullscreen.on() && navigator.userActivation?.isActive !== false) enterFullscreen(false);
        lastTick = Date.now();
        ticker = setInterval(tick, 250);
        check();
        renderCover();
    }

    // keepFullscreen: start() clearing up before it starts again.
    function stop(keepFullscreen = false) {
        FULLSCREEN_EVENTS.forEach(type => document.removeEventListener(type, onFullscreenChange));
        if (!keepFullscreen && settings?.leave === 'cooldown') {
            try { navigator.keyboard?.unlock?.(); } catch { /* not locked */ }
            fullscreen.exit();
        }
        fsEntered = false;
        hideCover();
        window.removeEventListener('blur', check);
        window.removeEventListener('focus', check);
        document.removeEventListener('visibilitychange', check);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('change', onPicked, true);
        document.removeEventListener('cancel', onPicked, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('keyup', onKey, true);
        clearInterval(ticker);
        ticker = null;
        hideCooldown();
        document.getElementById('exam-watermark')?.remove();
        state = null;
        save = () => { };
        picking = false;
    }

    // The page shown changed (taking.js): 'free' on the page of file questions, 'locked' on the
    // questions; allowFullscreen false when the exam has such a page (or gets one when the
    // lecturer changes the questions). Called from the student's press, so full screen can be
    // asked for at once.
    function setMode(next, { allowFullscreen = fullscreenAllowed } = {}) {
        next = next === 'free' ? 'free' : 'locked';
        if (next === mode && allowFullscreen === fullscreenAllowed) return;
        const before = fullscreenNeeded();
        mode = next;
        fullscreenAllowed = allowFullscreen;
        if (!state) return;
        if (before && !fullscreenNeeded()) {
            // Their files are in other programs: Alt+Tab and the rest work again.
            try { navigator.keyboard?.unlock?.(); } catch { /* not locked */ }
            fullscreen.exit();
        } else if (!before && fullscreenNeeded()) {
            fsEntered = fullscreen.on(); // not in full screen yet isn't leaving it
            if (!fullscreen.on()) enterFullscreen(false);
        }
        check();
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
    // Short interruptions and leaves from the page of file questions are listed with the others
    // (marked brief or allowed) but not counted.
    function activity(saved = null) {
        if (!state && saved) state = { count: 0, total: 0, leaves: [], away: null, cooldownLeft: 0, cooldownTotal: 0, ...saved };
        if (!state) return null;
        if (state.away) back(Date.now(), false);
        const result = {
            count: state.count, total_seconds: Math.round(state.total), leaves: state.leaves,
            brief: state.leaves.filter(l => l.brief).length, allowed: state.leaves.filter(l => l.allowed).length,
            cooldown: (settings || DEFAULTS).leave === 'cooldown', cooldown_seconds_total: Math.round(state.cooldownTotal),
        };
        if (state.fullscreen) result.fullscreen = state.fullscreen;
        if (!ticker) state = null; // only borrowed for this
        return result;
    }

    // ── Leaving and coming back ──
    // Also run by the ticker: browsers don't always say when the focus comes or goes (a frame
    // inside the page, a pop-up of the browser closing).
    function check() {
        if (!state || leaving) return;
        if (fullscreenNeeded() && fullscreen.on()) fsEntered = true;
        if (awayNow()) {
            const hidden = hiddenNow();
            // Browsers blur the window before they hide the page (another tab, the browser
            // minimised): the page being hidden says what happened, also during a file pick.
            if (state.away) {
                if (hidden && ['window', 'file', 'fullscreen'].includes(state.away.how)) { state.away.how = 'tab'; save(); }
            } else {
                const how = hidden ? 'tab' : picking ? 'file' : !document.hasFocus()
                    ? (locked() && Date.now() - shotKeysAt < SHOT_KEYS_MS ? 'screenshot' : 'window') : 'fullscreen';
                state.away = { from: Date.now(), how, ...(locked() ? {} : { free: true }) };
                save();
            }
        } else {
            picking = false;
            if (state.away) back(Date.now());
        }
        renderCover();
    }

    function back(now, countdown = true) {
        const away = state.away;
        state.away = null;
        let ms = now - away.from;
        let how = away.how;
        if (how === 'file') { ms -= FILE_CHOOSER_GRACE_MS; how = 'window'; }
        // A reload, a closed page, another computer or the screenshot keys always count; a
        // countdown only after a real absence, and not for the computer that broke down.
        if (ms >= MIN_AWAY_MS || how === 'reload' || how === 'device' || how === 'screenshot') {
            const seconds = Math.round(Math.max(0, ms) / 100) / 10;
            const entry = { from: new Date(now - Math.max(0, ms)).toISOString(), to: new Date(now).toISOString(), seconds, how };
            if (away.free) entry.allowed = true; // the page of file questions: they may go
            // The page stayed in sight, and the student was soon back: a pop-up, a notification
            // closed. A short interruption, the first FREE_BRIEF times: not counted, no countdown.
            else if ((how === 'window' || how === 'fullscreen') && ms < VISIBLE_GRACE_MS && state.brief < FREE_BRIEF) {
                entry.brief = true;
                state.brief++;
            }
            const counted = !entry.allowed && !entry.brief;
            if (counted) {
                state.count++;
                state.total += seconds;
            }
            if (state.leaves.length < MAX_LISTED) state.leaves.push(entry);
            if (counted && countdown && settings?.leave === 'cooldown' && how !== 'device' && (how !== 'reload' || ms > RELOAD_GRACE_MS)) startCooldown();
        }
        save();
    }

    // ── The screenshot keys, where the browser lets the page see them ──
    // Print Screen (its press, or only its release), Windows+Shift+S, and Cmd+Shift+3/4/5 on a
    // Mac. Windows usually keeps the last key for itself and opens its screenshot tool, which
    // takes the window: a window lost straight after Windows+Shift is that (check). In full
    // screen Chrome and Edge give the page those keys instead, and the tool doesn't open.
    function onKey(e) {
        if (!state || !locked() || leaving) return;
        if (!MAC && e.type === 'keydown' && e.shiftKey && (e.metaKey || e.key === 'Meta')) shotKeysAt = Date.now();
        const shot = e.key === 'PrintScreen' || e.code === 'PrintScreen'
            || (e.type === 'keydown' && e.metaKey && e.shiftKey && (MAC ? /^Digit[345]$/ : /^KeyS$/).test(e.code));
        if (!shot) return;
        e.preventDefault();
        if (Date.now() - shotAt < 2000) return; // its press and its release
        shotAt = Date.now();
        if (state.away) state.away.how = 'screenshot';
        else {
            state.away = { from: shotAt, how: 'screenshot' };
            back(shotAt);
        }
        save();
        renderCover();
    }

    // ── Full screen: asked for at the start, from the notice's button, and back on the questions ──
    const FULLSCREEN_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'];
    function onFullscreenChange() {
        if (fullscreen.on() && locked()) lockKeys();
        check();
    }

    // Chrome and Edge, in full screen: Alt+Tab, the Windows key and the browser's shortcuts
    // come to the page instead of switching away, and Esc leaves full screen only when held.
    function lockKeys() {
        try { navigator.keyboard?.lock?.().catch(() => { }); } catch { /* not this browser */ }
    }

    // pressed: from the notice's button. Refused even then, the browser has no full screen for
    // this page: the exam goes on without, and the record says so.
    async function enterFullscreen(pressed) {
        if (!fullscreenNeeded() || fullscreen.on()) return;
        let refused = false;
        asking = true;
        try { await fullscreen.enter(); } catch { refused = true; }
        // Safari's older call returns nothing: a moment for it to happen.
        if (!refused && !fullscreen.on()) await new Promise(resolve => setTimeout(resolve, 1200));
        asking = false;
        if (!state) return;
        if (fullscreen.on()) { if (locked()) lockKeys(); }
        else if (pressed) { state.fullscreen = 'unavailable'; save(); }
        check();
    }

    function onPageHide() {
        if (!state) return;
        leaving = true;
        if (!state.away) state.away = { from: Date.now(), how: 'reload', ...(locked() ? {} : { free: true }) };
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
        if (e.target.closest?.('input[type="file"], .file-answer-choose')) { picking = true; pickingAt = Date.now(); }
    }
    function onPicked(e) {
        if (e.target.matches?.('input[type="file"]')) setTimeout(() => { picking = false; }, 0);
    }

    // ── The countdown: the same length each time, with the alarm ──
    function startCooldown() {
        const seconds = settings.cooldown_seconds;
        state.cooldownLeft = Math.max(state.cooldownLeft, seconds);
        state.cooldownTotal += seconds;
        showCooldown();
        alarm.play();
    }

    // The alarm: failure.mp3, louder than the file (amplified, then limited so it doesn't break
    // up). Browsers let a page play sound only after a click or a key on it, and Firefox shows a
    // "blocked" mark when a page tries before: so the sound is made ready at the student's first
    // press (Start is one), and only played once it is. After a reload, until the next press, the
    // countdown comes without it.
    const alarm = (() => {
        const SRC = new URL('../miscellaneous/failure.mp3', document.baseURI).href;
        let ctx = null, buffer = null, loading = false;
        function ready() {
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context) return;
            try { ctx ||= new Context(); } catch { return; }
            if (ctx.state !== 'running') ctx.resume().catch(() => { });
            if (buffer || loading) return;
            loading = true;
            fetch(SRC).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('sound'))))
                .then(data => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)))
                .then(decoded => { buffer = decoded; })
                .catch(() => { loading = false; });
        }
        ['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, ready, { capture: true, passive: true }));
        function play() {
            if (!ctx || !buffer) return;
            const go = () => {
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                const gain = ctx.createGain();
                gain.gain.value = 3.5;
                const limit = ctx.createDynamicsCompressor();
                limit.threshold.value = -3;
                limit.knee.value = 0;
                limit.ratio.value = 20;
                limit.attack.value = 0.002;
                limit.release.value = 0.12;
                source.connect(gain).connect(limit).connect(ctx.destination);
                source.start();
            };
            if (ctx.state === 'running') go();
            else ctx.resume().then(go, () => { });
        }
        return { play, ready };
    })();

    // Runs only while the student is on the page.
    function tick() {
        const now = Date.now();
        const elapsed = (now - lastTick) / 1000;
        lastTick = now;
        if (!state) return;
        // The file chooser never opened (or closed without a word): the next leave isn't a pick.
        if (picking && !state.away && now - pickingAt > 3000) picking = false;
        // What the events may have missed. Not check() each time: it ends a file pick.
        if (!leaving && awayNow() !== !!state.away) check();
        else renderCover();
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
            // The seconds left, large and red, in a ring that empties as they run out.
            el.innerHTML = `<div class="cooldown-card">
                <div class="cooldown-ring" aria-hidden="true">
                    <svg viewBox="0 0 120 120"><circle class="cooldown-track" cx="60" cy="60" r="54"></circle><circle class="cooldown-left" cx="60" cy="60" r="54"></circle></svg>
                    <span class="cooldown-count" id="cooldown-seconds"></span>
                </div>
                <h2 id="cooldown-title">You left the exam page</h2>
                <p>The exam is locked until the countdown ends. The exam timer keeps running.</p>
                <p class="cooldown-note" id="cooldown-note"></p>
            </div>`;
            document.body.appendChild(el);
        }
        document.body.classList.add('exam-cooling-down');
        syncInert();
        renderCooldown();
    }

    // Nothing behind the red screen, or behind the full-screen notice, can be clicked or typed
    // in. Not for the "window not active" notice: there is no typing without the focus, and
    // the field being written in would lose its place.
    function syncInert() {
        const app = document.getElementById('admin-app');
        if (app) app.inert = !!document.getElementById('exam-cooldown') || document.getElementById('exam-away')?.dataset.mode === 'fullscreen';
    }

    const RING = 2 * Math.PI * 54;
    function renderCooldown() {
        const seconds = document.getElementById('cooldown-seconds');
        if (!seconds || !state) return;
        seconds.textContent = String(Math.ceil(state.cooldownLeft));
        const share = Math.min(1, state.cooldownLeft / Math.max(1, settings?.cooldown_seconds || state.cooldownLeft));
        const ring = document.querySelector('#exam-cooldown .cooldown-left');
        if (ring) ring.style.strokeDashoffset = String(RING * (1 - share));
        const note = document.getElementById('cooldown-note');
        const times = state.count === 1 ? 'Once' : `${state.count} times`;
        if (note) note.textContent = state.count > 0 ? `${times} so far. Your lecturer sees each time.` : 'Each time you leave is recorded for your lecturer.';
    }

    function hideCooldown() {
        document.getElementById('exam-cooldown')?.remove();
        document.body.classList.remove('exam-cooling-down');
        syncInert();
    }

    // ── The notice over the exam: the window isn't the active one, or full screen is off ──
    // Shown at once, so nobody is away without knowing; it covers the questions meanwhile.
    function renderCover() {
        if (!state || !locked()) return hideCover();
        const away = state.away;
        const outOfFullscreen = fullscreenNeeded() && !fullscreen.on() && !asking;
        const kind = outOfFullscreen ? 'fullscreen'
            : !hiddenNow() && !document.hasFocus() && !picking && away && Date.now() - away.from >= COVER_DELAY_MS ? 'inactive' : null;
        if (!kind) return hideCover();

        // What coming back will do: nothing yet (while short interruptions are left), then the
        // countdown (or only the record).
        const counted = away && ['window', 'fullscreen', 'tab', 'screenshot'].includes(away.how);
        const forgiven = FREE_BRIEF - state.brief;
        const left = counted && forgiven > 0 && (away.how === 'window' || away.how === 'fullscreen')
            ? Math.ceil((VISIBLE_GRACE_MS - (Date.now() - away.from)) / 1000) : 0;
        const lock = settings?.leave === 'cooldown';
        const seconds = settings?.cooldown_seconds || DEFAULTS.cooldown_seconds;
        const note = !counted ? ''
            : !lock ? 'The time away is recorded for your lecturer.'
            : left > 0 ? `Come back within ${left} s and the exam does not lock (${forgiven === 1 ? 'the last time' : `${forgiven} times left`}).`
            : `The exam will be locked for ${seconds} seconds when you are back.`;
        const text = kind === 'inactive'
            ? { title: 'The exam window is not active', body: 'A pop-up, a notification or a click outside took it. Click anywhere here to carry on.', button: '' }
            : fsEntered
                ? { title: 'You left full screen', body: 'This exam is taken in full screen.', button: 'Back to full screen' }
                : { title: 'This exam is taken in full screen', body: 'Other windows and notifications stay out of the way. Leaving full screen counts as leaving the exam page.', button: 'Go to full screen' };

        let el = document.getElementById('exam-away');
        if (!el) {
            el = document.createElement('div');
            el.id = 'exam-away';
            el.className = 'exam-away';
            el.setAttribute('role', 'alertdialog');
            el.setAttribute('aria-labelledby', 'away-title');
            el.innerHTML = `<div class="away-card">
                <h2 id="away-title"></h2>
                <p id="away-body"></p>
                <button type="button" class="btn-green" id="away-button"><i class="fa-solid fa-expand" aria-hidden="true"></i><span></span></button>
                <p class="away-note" id="away-note" aria-live="polite"></p>
            </div>`;
            // Anywhere on it: a click is what the browser needs before it goes full screen.
            el.addEventListener('click', () => { if (el.dataset.mode === 'fullscreen') enterFullscreen(true); });
            document.body.appendChild(el);
        }
        const set = (id, value) => { const node = el.querySelector(id); if (node.textContent !== value) node.textContent = value; };
        set('#away-title', text.title);
        set('#away-body', text.body);
        set('#away-button span', text.button);
        set('#away-note', note);
        el.querySelector('#away-button').hidden = !text.button;
        el.querySelector('#away-note').hidden = !note;
        if (el.dataset.mode !== kind) {
            el.dataset.mode = kind;
            syncInert();
            if (kind === 'fullscreen' && document.hasFocus()) el.querySelector('#away-button').focus({ preventScroll: true });
        }
    }

    function hideCover() {
        const el = document.getElementById('exam-away');
        if (!el) return;
        el.remove();
        syncInert();
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
        fitWatermark();
    }

    // The text runs the height of the window below the top bar, less some room at each end:
    // the font size is worked out from the text's length at 100px. Capped, so a short name
    // doesn't become a wide column over the questions (narrower on phones).
    const TOP_BAR = 52, WATERMARK_PAD = 28;
    function fitWatermark() {
        const el = document.getElementById('exam-watermark');
        if (!el) return;
        el.style.fontSize = '100px';
        const length = el.scrollHeight;
        if (!length) return;
        const fit = 100 * (window.innerHeight - TOP_BAR - 2 * WATERMARK_PAD) / length;
        const cap = window.innerWidth <= 768 ? 56 : 160;
        el.style.fontSize = `${Math.max(24, Math.min(fit, cap))}px`;
    }
    window.addEventListener('resize', fitWatermark, { passive: true });
    // The page's font arrives after the first fit and changes the text's length.
    document.fonts?.ready.then(fitWatermark);

    // The alarm, for the exam page's result too: a submission that did not get through.
    return { start, stop, suspend, snapshot, activity, setMode, alarm: () => alarm.play(), readySound: () => alarm.ready() };
})();
