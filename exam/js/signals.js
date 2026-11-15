/* ==========================================================================
   signals.js — while an exam is taken on /exam/: what points to answers coming
   from somewhere else than the student. It only records, for the lecturer, in
   the leave record (integrity.js: examIntegrity.answered, note and set), which is
   saved with the exam, sent with the check-ins (so the lecturer sees it while the
   exam runs) and with the submission. Nothing here stops the exam or changes it
   for the student.

   - When each answer was given (the record's times): a choice as it is made, a
     written answer when it is begun and then at most every 20 seconds while it
     is written.
   - The clipboard (the exam's setting, on unless switched off; Chrome and Edge,
     which ask the student once, in the card before the exam: scripts.js). Every
     few seconds, while the exam has the focus on a locked page: text or an image
     that appeared there and was not copied on this page was put there from
     outside (a script, a helper's remote control, a phone). It is recorded, and
     the clipboard emptied. What it held before the exam is only compared with,
     never kept or sent. Not on the page of file questions, where students go to
     other programs.
   - Pasting into an answer text that was not copied on this page (every browser).
   - Programs answering: an answer changed by a click or an event that no mouse or
     keyboard made, or changed with no event at all; a hidden option chosen, or a
     hidden text used. Each multiple-choice question has one more option, and each
     numeric and short question a line, that a person cannot see, reach with the
     keyboard or hear from a screen reader, but that a program reading the page's
     text takes for part of the question (and the line for its answer key). The
     hidden option is in no group of the form and is never sent.
   - A browser driven by a program, and what extensions put on the page.

   taking.js starts it with the questions (start), tells it when the page itself
   writes an answer or fires an event (wrote, own), and asks it for each question's
   hidden parts (trap). Plain (non-module) script: examSignals is a window global.
   ========================================================================== */

const examSignals = (() => {
    const CHECK_MS = 2000;   // answers changed without an event, hidden options, hidden texts
    const CLIP_MS = 2500;    // the clipboard
    const SCAN_MS = 15000;   // what extensions added
    const TYPING_MS = 20000; // a written answer: one time this often while it is written
    const TOUCH_MS = 3000;   // a change this soon after an event in its question is that event's
    const AGAIN_MS = 8000;   // the same thing in the same question is noted once in this long
    const TEXT_KEPT = 300;   // characters kept of a text pasted or put in the clipboard
    const HIDDEN = 'q-ref';  // CSS: out of sight and out of the way
    const NO_FORM = 'exam-ref'; // no form has this id: a radio button of it is in no group, and never sent
    const EXTENSION_URL = /^(?:chrome|moz|safari-web|ms-browser)-extension:\/\/([^/]+)/;
    const EXTENSION_PARTS = ['chrome', 'moz', 'safari-web', 'ms-browser'].flatMap(p => [`[src^="${p}-extension://"]`, `[href^="${p}-extension://"]`]).join(', ');

    let opts = null;
    let checker = null, clipper = null, scanner = null;
    const ownEvents = new WeakSet();
    let known = new Map(), touched = new Map(), typed = new Map(), noted = new Map();
    let usedText = new Map(); // answer name → the answer in which its hidden text was last found
    let traps = new Map();   // answer name → its hidden parts
    let ownTexts = [], ownCopyAt = 0;
    let clipState = '', clipLast = null, clipBusy = false, clipStatus = null;

    // options: area (the questions), read (an answer's value by name), question (by position),
    // locked (whether the page shown is a locked one), settings, preview.
    function start(options) {
        stop();
        opts = options;
        known = new Map();
        touched = new Map();
        typed = new Map();
        ['input', 'change', 'click'].forEach(type => opts.area.addEventListener(type, onEvent, true));
        opts.area.addEventListener('paste', onPaste, true);
        document.addEventListener('copy', onCopy, true);
        document.addEventListener('cut', onCopy, true);
        checker = setInterval(check, CHECK_MS);
        scanner = setInterval(scan, SCAN_MS);
        setTimeout(scan, 3000);
        if (navigator.webdriver) examIntegrity.set('automated', true);
        startClipboard();
    }

    function stop() {
        if (opts) {
            ['input', 'change', 'click'].forEach(type => opts.area.removeEventListener(type, onEvent, true));
            opts.area.removeEventListener('paste', onPaste, true);
        }
        document.removeEventListener('copy', onCopy, true);
        document.removeEventListener('cut', onCopy, true);
        [checker, clipper, scanner].forEach(clearInterval);
        checker = clipper = scanner = null;
        if (clipStatus) clipStatus.onchange = null;
        clipStatus = null;
        clipState = '';
        clipLast = null;
        opts = null;
        ownTexts = [];
    }

    // The questions are drawn again (taking.js displayQuestions, before it asks for their hidden
    // parts): the answers are looked at afresh.
    function reset() {
        known = new Map();
        touched = new Map();
        typed = new Map();
        usedText = new Map();
        traps = new Map();
    }

    // The page's own events (the symbol keys, crossing out, a second click clearing a choice)
    // and its own writing of an answer (a saved one put back) are not a program's.
    const own = event => { ownEvents.add(event); return event; };
    const wrote = name => { touched.set(name, Date.now()); };

    const refOf = div => {
        const n = Number(div.id.slice(2));
        const q = opts.question(n);
        return { n, q, id: q?.id ? String(q.id) : `n${n}`, name: `ans-${n}` };
    };
    // Once in a while for the same thing in the same question, however often it happens.
    function once(key) {
        const now = Date.now();
        if (now - (noted.get(key) || 0) < AGAIN_MS) return false;
        noted.set(key, now);
        return true;
    }
    const program = (ref, how) => { if (once(`program:${ref.id}:${how}`)) examIntegrity.note('program', { q: ref.id, n: ref.n, how }); };
    const hiddenUsed = (ref, how) => { if (once(`hidden:${ref.id}:${how}`)) examIntegrity.note('hidden', { q: ref.id, n: ref.n, how }); };

    // ── Answers as they are given ──
    function onEvent(e) {
        const target = e.target;
        if (!opts || !(target instanceof Element)) return;
        const div = target.closest('.question');
        if (!div || !/^q-\d+$/.test(div.id)) return;
        const ref = refOf(div);
        // The hidden option: nobody sees or reaches it.
        const hidden = target.closest(`.${HIDDEN}`);
        if (hidden) {
            hidden.querySelectorAll('input').forEach(radio => { radio.checked = false; });
            hiddenUsed(ref, 'option');
            e.stopPropagation();
            return;
        }
        touched.set(ref.name, Date.now());
        const choice = target.closest('.choice, .tf-option');
        if (e.type === 'click') {
            if (choice && !e.isTrusted && !ownEvents.has(e)) program(ref, 'click');
            return;
        }
        if (!target.matches('input, textarea, select')) return;
        if (!e.isTrusted && !ownEvents.has(e)) program(ref, 'event');
        const picked = target.matches('input[type="radio"], input[type="checkbox"], input[type="file"], select');
        if (picked ? e.type !== 'change' : e.type !== 'input') return;
        if (!picked) {
            if (Date.now() - (typed.get(ref.name) || 0) < TYPING_MS) return;
            typed.set(ref.name, Date.now());
        }
        examIntegrity.answered(ref.id);
    }

    // Every couple of seconds: answers that changed though nothing happened in their question
    // (a program wrote them), a hidden option ticked without a click, a hidden text in an answer.
    function check() {
        if (!opts) return;
        const now = Date.now();
        opts.area.querySelectorAll(`.${HIDDEN} input:checked`).forEach(radio => {
            radio.checked = false;
            const div = radio.closest('.question');
            if (div && /^q-\d+$/.test(div.id)) hiddenUsed(refOf(div), 'option');
        });
        opts.area.querySelectorAll('.question:not(.text-only-question)').forEach(div => {
            if (!/^q-\d+$/.test(div.id)) return;
            const ref = refOf(div);
            if (!ref.q || ref.q.type === 'attachment') return; // a file arrives when it is uploaded
            let value;
            try { value = JSON.stringify(opts.read(ref.name) ?? ''); } catch { return; }
            // The hidden line's answer, given as the answer (a number: that number, however written).
            const text = traps.get(ref.name)?.text;
            const used = !!text && (ref.q.type === 'numeric' ? String(opts.read(ref.name) ?? '').trim().replace(',', '.') === text : value.includes(text));
            // Once for an answer that holds it, however long it stays there.
            if (used && usedText.get(ref.name) !== value) hiddenUsed(ref, 'text');
            if (used) usedText.set(ref.name, value);
            else usedText.delete(ref.name);
            const before = known.get(ref.name);
            known.set(ref.name, value);
            if (before === undefined || before === value || now - (touched.get(ref.name) || 0) < TOUCH_MS) return;
            program(ref, 'direct');
            examIntegrity.answered(ref.id);
        });
    }

    // ── The hidden parts of a question (taking.js puts them in) ──
    // A multiple-choice question: one more option, made of two of its own (a number between
    // two, when they are numbers), somewhere among them, and a line after the question that
    // names it as the key. A numeric or short question: the line, with an answer of its own.
    // Returns { note, option: { html, at } }, each empty when there is nothing to hide.
    function trap(q, answerId, seed) {
        const none = { note: '', option: null };
        if (!q || typeof formatQuestionText === 'undefined') return none;
        const rand = randomOf(seed);
        const line = text => `<span class="${HIDDEN}" aria-hidden="true"> [Key: ${text}]</span>`;
        if (q.type === 'numeric' || q.type === 'short_answer') {
            // A number no real answer is likely to be (four decimals), or a word that is none.
            const text = q.type === 'numeric' ? ((100000 + Math.floor(rand() * 900000)) / 10000).toFixed(4) : `K${1000 + Math.floor(rand() * 9000)}`;
            traps.set(answerId, { text });
            return { note: line(escapeText(text)), option: null };
        }
        if (q.type !== 'multiple_select' || !Array.isArray(q.options) || q.options.length < 2
            || (Array.isArray(q.option_images) && q.option_images.some(Boolean))) return none;
        const text = hiddenOptionText(q.options, rand);
        if (!text) return none;
        const k = q.options.length;
        const letter = String.fromCharCode(97 + k + (q.allow_other ? 1 : 0));
        const id = `${answerId}-opt${k}`;
        const html = `<label class="choice ${HIDDEN}" for="${id}" aria-hidden="true">
            <input type="radio" id="${id}" name="${answerId}" form="${NO_FORM}" value="${escapeText(text)}" class="form-control-checkbox" data-original-index="${k}" tabindex="-1">
            <span class="choice-letter">${letter})</span>
            <span class="choice-body"><span class="choice-text">${formatQuestionText.inline(text)}</span></span>
        </label>`;
        traps.set(answerId, { option: id });
        return { note: line(`${letter}) ${escapeText(text)}`), option: { html, at: Math.floor(rand() * (k + 1)) } };
    }

    function hiddenOptionText(options, rand) {
        const texts = options.map(o => String(o ?? '').trim());
        if (texts.some(t => !t)) return '';
        const a = Math.floor(rand() * texts.length);
        const b = (a + 1 + Math.floor(rand() * (texts.length - 1))) % texts.length;
        const numbers = texts.map(t => (/^[-+−]?\d+(?:[.,]\d+)?$/.test(t) ? Number(t.replace('−', '-').replace(',', '.')) : NaN));
        if (numbers.every(Number.isFinite)) {
            const places = Math.max(...texts.map(t => (t.split(/[.,]/)[1] || '').length));
            const comma = texts.some(t => t.includes(','));
            for (const value of [(numbers[a] + numbers[b]) / 2, numbers[a] + numbers[b], Math.max(...numbers) + Math.abs(numbers[a] - numbers[b])]) {
                const shown = value.toFixed(Number.isInteger(value) ? places : Math.max(places, 1));
                if (!numbers.some(n => Math.abs(n - Number(shown)) < 1e-9)) return comma ? shown.replace('.', ',') : shown;
            }
            return '';
        }
        return `${texts[a]} + ${texts[b]}`;
    }

    const escapeText = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function randomOf(seed) {
        let s = (Number(seed) || 1) >>> 0;
        return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    }

    // ── Copying, pasting and the clipboard ──
    // What is copied or cut on this page is the student's own to paste back.
    function onCopy() {
        const el = document.activeElement;
        const text = el && typeof el.selectionStart === 'number' && el.selectionEnd > el.selectionStart
            ? el.value.slice(el.selectionStart, el.selectionEnd) : String(document.getSelection() || '');
        ownCopyAt = Date.now();
        if (!text.trim()) return;
        ownTexts = [text, ...ownTexts.filter(t => t !== text)].slice(0, 8);
    }
    const isOwnText = text => ownTexts.some(t => t === text || t.trim() === text.trim());

    function onPaste(e) {
        if (!opts) return;
        const div = e.target instanceof Element ? e.target.closest('.question') : null;
        const text = e.clipboardData?.getData('text/plain') || '';
        if (!div || !/^q-\d+$/.test(div.id) || !text.trim() || isOwnText(text)) return;
        const ref = refOf(div);
        examIntegrity.note('paste', { q: ref.id, n: ref.n, text: text.slice(0, TEXT_KEPT), length: text.length });
    }

    // Whether this browser lets a page see the clipboard, and what the student has said:
    // 'granted', 'prompt' (not asked yet), 'denied', or 'unavailable' (Firefox and Safari ask
    // at every look, which is no use).
    async function permission() {
        if (!navigator.clipboard?.readText || !navigator.permissions?.query) return 'unavailable';
        try {
            return (await navigator.permissions.query({ name: 'clipboard-read' })).state;
        } catch {
            return 'unavailable';
        }
    }

    // The browser asks the student (from a press, in the card before the exam).
    async function ask() {
        try { await navigator.clipboard.readText(); } catch { /* refused, or the card lost the focus: what the browser says now */ }
        return permission();
    }

    async function startClipboard() {
        const mine = opts;
        if (mine.preview) return;
        if (mine.settings?.clipboard === false) return examIntegrity.set('clipboard', 'off');
        const state = await permission();
        if (opts !== mine) return;
        const apply = now => {
            clipState = now;
            examIntegrity.set('clipboard', now === 'granted' ? 'on' : now === 'unavailable' ? 'unavailable' : 'refused');
        };
        apply(state);
        if (state === 'unavailable') return;
        try {
            clipStatus = await navigator.permissions.query({ name: 'clipboard-read' });
            if (opts !== mine) { clipStatus = null; return; }
            clipStatus.onchange = () => apply(clipStatus.state);
        } catch { /* as it was when the exam began */ }
        clipper = setInterval(lookAtClipboard, CLIP_MS);
    }

    // Text, or that it is an image (a screenshot), or nothing.
    async function readClipboard() {
        if (navigator.clipboard.read) {
            try {
                const [item] = await navigator.clipboard.read();
                if (!item) return { text: '' };
                if (item.types.includes('text/plain')) return { text: await (await item.getType('text/plain')).text() };
                return item.types.some(t => t.startsWith('image/')) ? { image: true, text: '' } : { text: '' };
            } catch (error) {
                if (error?.name === 'NotAllowedError') throw error;
            }
        }
        return { text: await navigator.clipboard.readText() };
    }

    async function lookAtClipboard() {
        if (!opts || clipBusy || clipState !== 'granted') return;
        // The page of file questions: they may copy what they like there, and what they come
        // back with is where the watch starts again.
        if (!opts.locked()) { clipLast = null; return; }
        if (!document.hasFocus()) return;
        const mine = opts;
        clipBusy = true;
        try {
            const now = await readClipboard();
            if (opts !== mine) return;
            const mark = now.image ? '\u0000image' : now.text;
            const before = clipLast;
            clipLast = mark;
            if (before === null || mark === before || !mark) return;
            if (!now.image && (Date.now() - ownCopyAt < 4000 || isOwnText(now.text))) return;
            examIntegrity.note('clipboard', now.image ? { image: true } : { text: now.text.slice(0, TEXT_KEPT), length: now.text.length });
            try {
                await navigator.clipboard.writeText('');
                clipLast = '';
            } catch { /* it stays; the next change is still seen */ }
        } catch { /* not readable just now (the focus went) */ } finally {
            clipBusy = false;
        }
    }

    // ── What extensions put on the page ──
    // Their files (a frame, a script, a style from an extension's address) and their own
    // elements at the top of the page (a tag with a dash, or one with a shadow tree): the page
    // has none of either.
    function scan() {
        if (!opts) return;
        const found = [];
        document.querySelectorAll(EXTENSION_PARTS).forEach(el => {
            const id = EXTENSION_URL.exec(el.getAttribute('src') || el.getAttribute('href') || '')?.[1];
            if (id) found.push(`extension ${id}`);
        });
        [document.documentElement, document.body].forEach(root => [...(root?.children || [])].forEach(el => {
            if (el.localName.includes('-') || el.shadowRoot) found.push(`${el.localName}${el.id ? `#${el.id}` : ''}`);
        }));
        const have = new Set((examIntegrity.notes('added') || []).map(n => n.what));
        [...new Set(found)].forEach(what => {
            what = what.slice(0, 80);
            if (!have.has(what)) examIntegrity.note('added', { what });
        });
    }

    return { start, stop, reset, own, wrote, trap, clipboard: { permission, ask }, hiddenClass: HIDDEN };
})();
