/* ==========================================================================
   taking.js — taking an exam on /exam/: questions, answers, code editors,
   timer, autosave, backups and collecting the submission.

   scripts.js decides which exam is taken (filling examDetails), sends the
   submission (sendSubmission) and shows what follows (onExamSubmitted).
   Load after js/common.js and before js/scripts.js.
   ========================================================================== */

// === The exam being taken ===
// examDetails: { ExamId, Kind: 'named' | 'anonymous' | 'preview', Code (course), Name (label),
//   TypeLabel, Duration, StartDate, StartTime, Hall, Base, Weight, Questions (JSON string),
//   Version (of the questions, from the server), SubmitKey (sends the answers, signed in or
//   not), OriginalOrderMap, shuffleQuestions, Seed, Settings (watermark, leaving the page),
//   Student: { name, email, student_no } (named, preview), Token and ExamCode (anonymous) }
// A preview ("Try as student" in the course editor) is never saved or sent.
// Answers are stored by position (ans-1 is the first question), and sent with the questions'
// ids in that order, so they find their question if the lecturer changes the exam meanwhile.
let examDetails = null;
let fileAnswers = {};               // ans-N → { upload, name, size }: a file question's uploaded answer
const uploadsInProgress = new Set(); // ans-N of files being uploaded
let examImageUrls = {};             // image id → object URL; images are never saved on the device
let examTimerInterval = null;   // Interval ID for the countdown timer
let examEndTime = null;         // Absolute end time (timestamp in ms)
const appStateKey = 'examAppState'; // localStorage: the exam in progress, for resuming
let totalQuestions = 0;
// File questions with others: two pages, { questions, uploads } (each the original positions in
// the order shown), so students may leave the exam page for their files on the second
// (examPagesOf). examDetails.Page is the one shown. An exam of file questions only is one page
// where leaving is allowed.
let examPages = null;
let examUploadsOnly = false;
let inactivityTimer = null;
let lastActivityTime = Date.now();
let autoSaveTimer = null;
let codeEditors = {};           // CodeMirror instances by answerId
let isOnline = navigator.onLine;
let isSyncing = false;          // A store call is in progress
let isInitializing = true;

const syncStatus = document.getElementById('sync-status');
const syncText = document.getElementById('sync-text');
const examQuestionsModule = document.getElementById('exam-questions-module');
const examForm = document.getElementById('exam-form');
const examQuestionsArea = document.getElementById('exam-questions-area');
const submitExamBtn = document.getElementById('submit-exam-btn');
const INACTIVITY_WARNING_TIME = 15 * 60 * 1000; // 15 minutes in milliseconds
const AUTO_SAVE_INTERVAL = 3 * 60 * 1000; // 3 minutes in milliseconds

function setupSessionManagement() {
    // Setup activity tracking
    document.addEventListener('mousemove', recordUserActivity);
    document.addEventListener('keydown', recordUserActivity);
    document.addEventListener('click', recordUserActivity);

    // Initial activity timestamp
    lastActivityTime = Date.now();

    // Auto-save answers periodically, and when the page is closed or reloaded
    startAutoSave();
    window.addEventListener('pagehide', () => { autoSaveAnswers(); saveScroll(); });
    // Where the student is on the page, so a reload comes back there: a small entry of its own,
    // once scrolling stops (the answers are not written again for it).
    let scrollTimer = 0;
    window.addEventListener('scroll', () => {
        if (!examDetails) return;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(saveScroll, 600);
    }, { passive: true });
}

function recordUserActivity() {
    lastActivityTime = Date.now();

    // Reset inactivity timer if it exists
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }

    // Start inactivity detection
    startInactivityDetection();
}

// Each language the editor offers (js/course-exams.js CODE_LANGUAGES): CodeMirror's mode for it
// and the file that has it. Python's is on the page from the start; another loads when an exam
// has a question in it, and until then (or offline) the code shows as plain text.
const CODE_MODES = {
    python: ['python', 'python'], javascript: ['javascript', 'javascript'], java: ['text/x-java', 'clike'],
    c: ['text/x-csrc', 'clike'], cpp: ['text/x-c++src', 'clike'], csharp: ['text/x-csharp', 'clike'],
    matlab: ['text/x-octave', 'octave'], r: ['text/x-rsrc', 'r'], sql: ['text/x-sql', 'sql'],
};
const codeModeLoads = {};
function loadCodeMode(language) {
    const [mode, file] = CODE_MODES[language] || [null, null];
    if (!file || CodeMirror.modes[file]) return Promise.resolve(file ? mode : null);
    codeModeLoads[file] = codeModeLoads[file] || new Promise(resolve => {
        const script = document.createElement('script');
        script.src = `https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.19/mode/${file}/${file}.min.js`;
        script.onload = script.onerror = () => resolve();
        document.head.appendChild(script);
    });
    return codeModeLoads[file].then(() => (CodeMirror.modes[file] ? mode : null));
}

// The code editor (CodeMirror) loads only for an exam with code questions: the page loads faster
// on a slow connection without it. Until it is there (or offline), the code is a plain text box,
// which it then takes over, with what was typed.
const CODEMIRROR = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.19/';
let codeMirrorLoad = null;
function ensureCodeMirror() {
    if (window.CodeMirror) return Promise.resolve(true);
    if (codeMirrorLoad) return codeMirrorLoad;
    const script = src => new Promise(resolve => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => resolve(true);
        el.onerror = () => resolve(false);
        document.head.appendChild(el);
    });
    ['codemirror.min.css', 'theme/monokai.min.css'].forEach(file => {
        if (document.querySelector(`link[href="${CODEMIRROR}${file}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${CODEMIRROR}${file}`;
        document.head.appendChild(link);
    });
    codeMirrorLoad = script(`${CODEMIRROR}codemirror.min.js`)
        .then(ok => (ok ? Promise.all(['mode/python/python.min.js', 'addon/edit/matchbrackets.min.js', 'addon/edit/closebrackets.min.js']
            .map(file => script(`${CODEMIRROR}${file}`))) : null))
        .then(() => {
            if (!window.CodeMirror) codeMirrorLoad = null; // offline: the next code question tries again
            return !!window.CodeMirror;
        });
    return codeMirrorLoad;
}

function initializeCodeEditor(textareaId, language = 'python') {
    const textarea = document.getElementById(textareaId);
    if (!textarea) {
        console.warn(`Cannot initialize code editor: textarea #${textareaId} not found`);
        return null;
    }

    if (typeof CodeMirror === 'undefined') {
        // A plain text box meanwhile; the editor takes it over once loaded (if it is still there).
        ensureCodeMirror().then(ok => {
            const now = document.getElementById(textareaId);
            if (ok && now && !codeEditors[textareaId] && now.isConnected) initializeCodeEditor(textareaId, language);
        });
        return null;
    }


    try {
        // Initialize CodeMirror directly on the textarea (replacing it)
        const [mode, file] = CODE_MODES[language] || [null, null];
        const editor = CodeMirror.fromTextArea(textarea, {
            mode: file && CodeMirror.modes[file] ? mode : null,
            theme: "monokai",
            lineNumbers: true,
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            matchBrackets: true,
            autoCloseBrackets: true,
            lineWrapping: true,
            extraKeys: {
                "Tab": function (cm) {
                    if (cm.somethingSelected()) {
                        cm.indentSelection("add");
                    } else {
                        cm.replaceSelection("    ", "end");
                    }
                }
            }
        });

        // Make the editor a bit taller for better visibility
        editor.setSize(null, 150);
        editor.on('change', () => {
            saveAnswersSoon();
            const question = editor.getWrapperElement().closest('.question');
            if (question) refreshAnswered(question);
        });

        // Store the editor instance
        codeEditors[textareaId] = editor;
        if (file && !CodeMirror.modes[file]) loadCodeMode(language).then(loaded => { if (loaded) editor.setOption('mode', loaded); });

        return editor;
    } catch (e) {
        console.error(`Error initializing CodeMirror for ${textareaId}:`, e);
        // Show the original textarea as fallback
        textarea.style.display = 'block';
        return null;
    }
}


// Starts the inactivity detection timer
function startInactivityDetection() {
    // Clear any existing timer
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
    }

    // Set new timer to detect inactivity
    inactivityTimer = setTimeout(() => {
        const inactiveTime = Date.now() - lastActivityTime;
        if (inactiveTime >= INACTIVITY_WARNING_TIME) {
            showInactivityWarning();
        }
    }, INACTIVITY_WARNING_TIME);
}

// Reminds an idle student about the running exam (only while questions are shown)
function showInactivityWarning() {
    if (examQuestionsModule.classList.contains('hidden')) return;
    showImprovedNotification(
        'warning',
        'Are you still there?',
        'You have been inactive for a while. Your exam timer is still running.',
        60000
    );
}


// Auto-save answers periodically
function startAutoSave() {
    // Clear any existing timer
    stopAutoSave();

    autoSaveTimer = setInterval(() => {
        if (examQuestionsModule && !examQuestionsModule.classList.contains('hidden')) {
            autoSaveAnswers();
        }
    }, AUTO_SAVE_INTERVAL);
}

// Stop auto-save timer
function stopAutoSave() {
    if (autoSaveTimer) {
        clearInterval(autoSaveTimer);
        autoSaveTimer = null;
    }
}

// Debounced save, so a crash or closed tab loses at most a second of typing
let answerSaveTimer = null;
function saveAnswersSoon() {
    clearTimeout(answerSaveTimer);
    answerSaveTimer = setTimeout(autoSaveAnswers, 1000);
}

// The answers so far, and which questions have one (kept as "confirmations", the name the
// saved states and drafts have always used), by their original position.
function collectProgress() {
    const answers = {}, confirmations = {};
    for (const index of Object.keys(examDetails.OriginalOrderMap).map(Number).sort((a, b) => a - b)) {
        const n = index + 1;
        const div = document.getElementById(`q-${n}`);
        if (div) confirmations[`q-${n}`] = div.classList.contains('is-answered');
        const q = examDetails.OriginalOrderMap[index];
        if (!q || q.type === 'text_only') continue;
        const value = getAnswerValue(`ans-${n}`);
        if (value !== undefined) answers[`ans-${n}`] = value;
        if (otherChosen(`ans-${n}`)) answers[`ans-${n}_metadata`] = { other: true };
    }
    return { answers, confirmations };
}

// Puts saved answers back into the questions on screen; a question with an answer is answered.
function applyProgress(answers = {}) {
    for (const answerName in answers) {
        if (!/^ans-\d+$/.test(answerName) || answers[answerName] === 'FILE_SELECTED') continue;
        setAnswerValue(answerName, answers[answerName], answers[`${answerName}_metadata`]);
    }
    refreshAnswered();
}

// What another computer carries on from, if this one breaks down (the heartbeat's draft).
function examDraft() {
    if (!examDetails || examDetails.Kind === 'preview' || !examDetails.OriginalOrderMap) return null;
    return { ...collectProgress(), integrity: examIntegrity.snapshot(), question_ids: questionIds(), ...(currentPage() ? { page: currentPage() } : {}) };
}

// The questions' ids in their positions (answers go by position).
function questionIds(details = examDetails) {
    const map = details?.OriginalOrderMap || {};
    return Object.keys(map).map(Number).sort((a, b) => a - b).map(i => map[i]?.id || '');
}

// Answers and confirmations saved for one version of the questions (with its question_ids),
// moved to the positions the questions have now. Without ids they stay where they are.
function remapProgress(progress, questions) {
    const from = Array.isArray(progress?.question_ids) ? progress.question_ids : null;
    const move = (obj, prefix) => {
        const out = {};
        for (const [key, value] of Object.entries(obj || {})) {
            const m = key.match(new RegExp(`^${prefix}-(\\d+)(_metadata)?$`)); // an answer's mark (Other) goes with it
            const id = m && from ? from[Number(m[1]) - 1] : '';
            const at = id ? questions.findIndex(q => q?.id === id) : -1;
            if (!m || !id) out[key] = value;
            else if (at >= 0) out[`${prefix}-${at + 1}${m[2] || ''}`] = value;
        }
        return out;
    };
    return { answers: move(progress?.answers, 'ans'), confirmations: move(progress?.confirmations, 'q') };
}

// The exam in progress is kept in three entries, so that what changes often is small to write
// (slow computers): the exam itself (appStateKey: its details and questions, its end, the leave
// record), the answers (ANSWERS_KEY), and where the page is and when it was last there (POS_KEY).
// readExamState puts them together.
const ANSWERS_KEY = `${appStateKey}:answers`;
const POS_KEY = `${appStateKey}:pos`;
const readStored = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const writeStored = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.error('Could not keep the exam on this computer:', e); } };

// The answers so far, on this computer (a second after each change, every 3 minutes, and as the
// page closes). Nothing is written when they are as they were.
let lastAnswersSaved = '';
function autoSaveAnswers() {
    // Only auto-save if exam is in progress
    if (!examQuestionsModule || examQuestionsModule.classList.contains('hidden') || !examDetails || examDetails.Kind === 'preview') {
        return;
    }
    const { answers, confirmations } = collectProgress();
    const json = JSON.stringify({ examId: examDetails.ExamId, currentAnswers: answers, confirmationStatus: confirmations, struck: collectStruck() });
    if (json !== lastAnswersSaved) {
        try { localStorage.setItem(ANSWERS_KEY, json); lastAnswersSaved = json; } catch (e) { console.error('Error auto-saving answers:', e); }
    }
    saveScroll();
}

// Where the student is on the page, and that the page is still here.
function saveScroll() {
    if (!examDetails || examDetails.Kind === 'preview') return;
    writeStored(POS_KEY, { examId: examDetails.ExamId, scrollY: Math.round(window.scrollY), aliveAt: Date.now() });
}


// The timer, in the middle of the top bar (#exam-timer), with the count of answered questions
// and Next question.
const TIME_STAGES = ['notice', 'warning', 'danger', 'over'];
function showTimer() {
    const timer = document.getElementById('exam-timer');
    if (!timer) return;
    timer.hidden = false;
    setTimeStage('');
    checkAllAnswered(); // its count, and what Next goes to
}

function hideTimer() {
    const timer = document.getElementById('exam-timer');
    if (timer) timer.hidden = true;
    setTimeStage('');
}

// The timer's colour and the page's tint (CSS): '' or one of TIME_STAGES.
function setTimeStage(stage) {
    const timer = document.getElementById('exam-timer');
    TIME_STAGES.forEach(s => {
        timer?.classList.toggle(`is-${s}`, s === stage);
        document.body.classList.toggle(`time-${s === 'over' ? 'expired' : s}`, s === stage);
    });
}

// Next question: the next one without an answer below the one at the top of the screen (round
// to the first), then Submit.
document.getElementById('exam-next')?.addEventListener('click', () => goToNextUnanswered());
function goToNextUnanswered() {
    const open = [...examQuestionsArea.querySelectorAll('.question:not(.text-only-question):not(.is-answered)')];
    if (!open.length) {
        document.querySelector('.exam-finish')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    // On this page first; then the other page's.
    const here = open.filter(q => !q.closest('.exam-page[hidden]'));
    if (!here.length) return goToQuestion(open[0]);
    goToQuestion(here.find(q => q.getBoundingClientRect().top > 140) || here[0]);
}

// A question, on whichever page it is.
function goToQuestion(question) {
    if (!question) return;
    const page = question.closest('.exam-page')?.dataset.page;
    if (page && page !== currentPage()) showExamPage(page, { scroll: false });
    question.scrollIntoView({ behavior: 'smooth', block: 'start' });
    focusAnswer(question);
}

// A question's first field: what to type in, else its first option, else Choose file.
function focusAnswer(question) {
    question?.querySelector('input.form-control:not([type="file"]):not(.choice-other-text), textarea.form-control:not(.code-editor), .form-control-checkbox, .file-answer-choose')
        ?.focus({ preventScroll: true });
    const code = question?.querySelector('.code-editor');
    if (code && codeEditors[code.id]) codeEditors[code.id].focus();
}

// Above Submit: a question still without an answer, to go to.
document.getElementById('exam-finish-open')?.addEventListener('click', e => {
    goToQuestion(document.getElementById(e.target.closest('[data-go]')?.dataset.go || ''));
});

// The form itself is never submitted: with a single text field, Enter would send it and reload
// the page.
examForm?.addEventListener('submit', e => e.preventDefault());
examForm?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.matches('input.form-control:not([type="file"])')) return;
    e.preventDefault();
    // In a blank: on to the next one.
    if (e.target.matches('.blank-input')) {
        const boxes = [...e.target.closest('.blanks').querySelectorAll('.blank-input')];
        boxes[boxes.indexOf(e.target) + 1]?.focus();
    }
});

function getAnswerCounts() {
    const required = examQuestionsArea.querySelectorAll('.question:not(.text-only-question)').length;
    const answered = examQuestionsArea.querySelectorAll('.question.is-answered:not(.text-only-question)').length;
    return { required, answered, allAnswered: answered === required };
}

// The count of answered questions (in the timer and above Submit), Next question, and Submit.
function checkAllAnswered() {
    const count = document.getElementById('exam-finish-count');
    const status = document.getElementById('exam-finish-status');
    if (!examQuestionsArea || examQuestionsModule.classList.contains('hidden') || totalQuestions <= 0) {
        if (submitExamBtn) {
            submitExamBtn.disabled = true;
            submitExamBtn.textContent = 'Submit exam';
        }
        return;
    }

    const { required, answered, allAnswered } = getAnswerCounts();
    const progress = document.getElementById('exam-progress');
    if (progress) {
        // On phones the words go, so the timer fits the top bar.
        progress.innerHTML = `<strong>${answered}</strong><span class="exam-progress-of"> of </span><span class="exam-progress-slash">/</span>${required}<span class="exam-progress-word"> answered</span>`;
        progress.classList.toggle('is-done', allAnswered);
    }
    const next = document.getElementById('exam-next');
    if (next) {
        const label = allAnswered ? 'Submit' : 'Next question';
        if (next.dataset.label !== label) {
            next.dataset.label = label;
            next.innerHTML = `<span class="exam-next-text">${label}</span><i class="fa-solid ${allAnswered ? 'fa-flag-checkered' : 'fa-arrow-down'}" aria-hidden="true"></i>`;
            next.title = allAnswered ? 'Every question has an answer: go to Submit' : 'The next question without an answer';
            next.setAttribute('aria-label', allAnswered ? 'Go to Submit' : 'Go to the next question without an answer');
        }
        next.classList.toggle('is-done', allAnswered);
    }
    document.querySelector('.exam-finish')?.classList.toggle('is-ready', allAnswered && isOnline);

    if (submitExamBtn) {
        // Submit whenever online: questions without an answer are asked about first.
        submitExamBtn.disabled = !isOnline;
        submitExamBtn.textContent = isOnline ? 'Submit exam' : 'Offline';
    }
    // The questions still without an answer, each a button to go to it.
    const open = document.getElementById('exam-finish-open');
    if (open) {
        const left = allAnswered ? [] : [...examQuestionsArea.querySelectorAll('.question:not(.text-only-question):not(.is-answered)')];
        const key = left.map(q => q.id).join(',');
        if (open.dataset.key !== key) {
            open.dataset.key = key;
            const MAX = 40;
            open.innerHTML = left.slice(0, MAX).map(q => `<button type="button" class="exam-finish-q" data-go="${q.id}" title="Go to question ${q.dataset.number}">${q.dataset.number}</button>`).join('')
                + (left.length > MAX ? `<span class="exam-finish-more">+${left.length - MAX}</span>` : '');
            open.hidden = !left.length;
        }
    }
    // Each page's count, on its tab.
    document.querySelectorAll('#exam-pages [data-page-go]').forEach(tab => {
        const page = examQuestionsArea.querySelector(`.exam-page[data-page="${tab.dataset.pageGo}"]`);
        const all = page ? page.querySelectorAll('.question:not(.text-only-question)').length : 0;
        const done = page ? page.querySelectorAll('.question.is-answered:not(.text-only-question)').length : 0;
        const badge = tab.querySelector('.exam-page-tab-count');
        if (badge) badge.textContent = `${done}/${all}`;
        tab.classList.toggle('is-done', all > 0 && done === all);
    });
    if (count) count.textContent = allAnswered ? `All ${required} question${required === 1 ? '' : 's'} answered` : `${answered} of ${required} questions answered`;
    if (status) {
        status.textContent = !isOnline ? 'No connection. Your answers are kept on this computer.'
            : allAnswered ? 'Once submitted, the exam cannot be changed.'
            : `${required - answered} without an answer. You can still submit.`;
    }
}


// The headings of questions of one kind that sit together.
const GROUP_HEADINGS = {
    true_false: ['True or false', 'Choose True or False for each statement.'],
    multiple_select: ['Multiple choice', 'Choose one answer for each question. You can cross out the options you rule out.'],
};

// The order students see. Text-only items divide the exam into parts, which keep their order.
// Shuffled, each part's questions are grouped by kind (true or false, multiple choice…), and the
// groups and the questions in each come in an order of the student's own: seeded by question id,
// so it stays the same after a reload or when the lecturer changes a question. Grading keeps the
// lecturer's order.
// Questions that show the same figure (the same images) stay together, under it, shuffled or not.
const figureOf = q => (q?.type === 'text_only' || !Array.isArray(q?.images) ? '' : q.images.filter(id => typeof id === 'string').join(','));

function questionOrder(questions, shuffle, seed) {
    const order = [];
    const rank = key => hashString(`${seed}:${key}`);
    let part = [];
    const flush = () => {
        if (shuffle) {
            const kinds = new Map();
            const figures = new Map();
            part.forEach(i => { const f = figureOf(questions[i]); if (f) figures.set(f, (figures.get(f) || 0) + 1); });
            part.forEach(i => {
                const f = figureOf(questions[i]);
                const kind = f && figures.get(f) > 1 ? `figure:${f}` : questions[i]?.type || '';
                if (!kinds.has(kind)) kinds.set(kind, []);
                kinds.get(kind).push(i);
            });
            [...kinds.keys()].sort((a, b) => rank(`kind:${a}`) - rank(`kind:${b}`)).forEach(kind => order.push(
                ...kinds.get(kind).sort((a, b) => rank(questions[a]?.id ?? `#${a}`) - rank(questions[b]?.id ?? `#${b}`))));
        } else order.push(...part);
        part = [];
    };
    questions.forEach((q, i) => {
        if (q?.type === 'text_only') { flush(); order.push(i); } else part.push(i);
    });
    flush();
    return order;
}

function questionGroup(kind, area = examQuestionsArea) {
    const section = document.createElement('section');
    section.className = `question-group is-${kind}`;
    section.innerHTML = `<header class="question-group-head"><span class="question-group-title">${GROUP_HEADINGS[kind][0]}</span>
        <span class="question-group-hint">${GROUP_HEADINGS[kind][1]}</span></header><div class="question-group-items"></div>`;
    area.appendChild(section);
    return section;
}

// Questions with the same figure: one card, the figure at its top, the questions under it.
function figureGroup(q, area = examQuestionsArea) {
    const section = document.createElement('section');
    section.className = 'question-group is-figure';
    section.dataset.figure = figureOf(q);
    section.innerHTML = `<header class="question-group-head"><span class="question-group-title">Figure</span>
        <span class="question-group-hint">For the questions below.</span></header>
        <div class="question-group-figure">${questionImagesHtml(q)}</div><div class="question-group-items"></div>`;
    area.appendChild(section);
    return section;
}

// What students type is their own: no spell check or autocorrect (the browser's, nor Grammarly's)
// and no autofill (the browser's, nor a password manager's).
const NO_HELP = 'autocomplete="off" autocorrect="off" spellcheck="false" data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"';

// What a short answer, a number or a blank takes, as the lecturer chose (js/course-exams.js
// ALLOWED_CHARS): anything, or only these. Other characters never get in (typed, pasted or
// dropped), and the line under the field says what is allowed.
const unicodeClass = (source, fallback) => { try { return new RegExp(source, 'u'); } catch { return fallback; } };
const ALLOWED_RULES = {
    digits: { test: /^[0-9]$/, hint: 'Digits only', inputmode: 'numeric', width: 3 },
    number: { test: /^[0-9.,+\-−/eE]$/, hint: 'A number', inputmode: 'decimal', width: 4.5 },
    // A Numeric question's default: digits, minus, comma and dot, and ×10^ from its ×10ⁿ button.
    decimal: { test: /^[0-9.,\-−×^]$/, hint: 'A number', inputmode: 'decimal', width: 4.5 },
    letters: { test: unicodeClass("^[\\p{L}\\p{M} '’-]$", /^[A-Za-zÀ-ɏ '’-]$/), hint: 'Letters only', width: 6 },
    alnum: { test: unicodeClass("^[\\p{L}\\p{M}\\p{N} '’.,-]$", /^[A-Za-zÀ-ɏ0-9 '’.,-]$/), hint: 'Letters and digits only', width: 6 },
};
function allowedRule(allowed, chars = '') {
    if (allowed === 'custom') {
        const list = [...new Set(String(chars || ''))];
        if (!list.length) return null;
        return { test: { test: c => list.includes(c) }, hint: `Only ${charRanges(list)}`,
            inputmode: list.every(c => /[0-9]/.test(c)) ? 'numeric' : '', width: list.every(c => /[0-9]/.test(c)) ? 3 : 5 };
    }
    return ALLOWED_RULES[allowed] || null;
}
// A list of characters to read: runs as ranges (A–Z a–z 0–9), the rest one by one.
function charRanges(list) {
    const codes = [...new Set(list.map(c => c.codePointAt(0)))].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < codes.length;) {
        let j = i;
        while (j + 1 < codes.length && codes[j + 1] === codes[j] + 1) j++;
        const name = n => (n === 32 ? 'space' : String.fromCodePoint(n));
        parts.push(j - i >= 2 ? `${name(codes[i])}–${name(codes[j])}` : codes.slice(i, j + 1).map(name).join(' '));
        i = j + 1;
    }
    return parts.join(' ');
}

// The attributes a field gets for its rule.
const allowedAttrs = q => {
    const rule = allowedRule(q?.allowed, q?.allowed_chars);
    return rule ? ` data-allowed="${escapeHtml(q.allowed)}"${q.allowed === 'custom' ? ` data-allowed-chars="${escapeHtml(String(q.allowed_chars || ''))}"` : ''}${rule.inputmode ? ` inputmode="${rule.inputmode}"` : ''}` : '';
};
const allowedHint = q => {
    const rule = allowedRule(q?.allowed, q?.allowed_chars);
    return rule ? `<span class="answer-allowed">${escapeHtml(rule.hint)}</span>` : '';
};
const ruleOfField = el => allowedRule(el?.dataset?.allowed, el?.dataset?.allowedChars);

// A character refused: the field and the line under it say so, for a moment.
function refuseInput(el) {
    const hint = el.closest('.question-response')?.querySelector('.answer-allowed');
    [el, hint].forEach(node => {
        if (!node) return;
        node.classList.remove('is-refused');
        void node.offsetWidth;
        node.classList.add('is-refused');
        clearTimeout(node._refused);
        node._refused = setTimeout(() => node.classList.remove('is-refused'), 1200);
    });
}
examQuestionsArea?.addEventListener('beforeinput', e => {
    const el = e.target;
    if (!el?.dataset?.allowed || e.isComposing || typeof e.data !== 'string' || !e.inputType?.startsWith('insert')) return;
    const rule = ruleOfField(el);
    if (rule && [...e.data].some(c => !rule.test.test(c))) {
        e.preventDefault();
        refuseInput(el);
    }
});
// ×10ⁿ: adds "×10^" after the number, for the student to type the power (once per answer).
examQuestionsArea?.addEventListener('click', e => {
    const btn = e.target.closest?.('[data-pow]');
    const el = btn && document.getElementById(btn.dataset.pow);
    if (!el || el.disabled || el.readOnly) return;
    const end = el.value.length;
    el.focus();
    if (!/×10\^/.test(el.value)) {
        el.setRangeText('×10^', end, end, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
    } else el.setSelectionRange(end, end);
});
// Pasted, dropped or written with an input method: what isn't allowed is taken out (first, before
// the answer is counted).
examQuestionsArea?.addEventListener('input', e => {
    const el = e.target;
    if (el?.matches?.('.blank-input')) sizeBlank(el);
    if (!el?.dataset?.allowed || e.isComposing) return;
    const rule = ruleOfField(el);
    if (!rule) return;
    const chars = [...el.value], kept = chars.filter(c => rule.test.test(c));
    if (kept.length === chars.length) return;
    const caret = el.selectionStart ?? el.value.length;
    const removedBefore = [...el.value.slice(0, caret)].filter(c => !rule.test.test(c)).length;
    el.value = kept.join('');
    const at = Math.max(0, caret - removedBefore);
    try { el.setSelectionRange(at, at); } catch { }
    refuseInput(el);
}, true);

// Fill in the blanks: a box for each, as wide as what is in it (a little room to spare).
function sizeBlank(el) {
    const rule = ruleOfField(el);
    const min = rule?.width || 5;
    const width = `${Math.min(26, Math.max(min, [...el.value].length + 1.2))}ch`;
    if (el.style.width !== width) el.style.width = width;
}
const blanksBox = answerName => examQuestionsArea.querySelector(`.blanks[data-answer="${answerName}"]`);

// One question, as on the paper: a head with QUESTION and its number and the points (true or
// false: its choice too), then the text at the full width, its images and the answer. True or
// false statements together are one line each: the number, the statement, the choice. An answer
// counts as soon as it is given (refreshAnswered).
function questionElement(q, originalIndex, number, seed, shuffle, { figureAbove = false } = {}) {
    const n = originalIndex + 1;
    const answerId = `ans-${n}`;
    const isTextOnly = q.type === 'text_only';
    const div = document.createElement('div');
    div.className = `question is-${q.type || 'other'}${isTextOnly ? ' text-only-question' : ''}`;
    div.id = `q-${n}`;
    div.dataset.originalIndex = originalIndex;
    const prompt = q.prompt ? `<div class="question-prompt">${formatQuestionText(q.prompt)}</div>` : '';
    const images = figureAbove ? '' : questionImagesHtml(q);
    if (isTextOnly) {
        div.innerHTML = `<div class="question-header"><div class="question-title">${prompt}</div></div>${images ? `<div class="question-body">${images}</div>` : ''}`;
        return div;
    }
    div.dataset.number = number;
    const points = q.points ? `<span class="question-points">${escapeHtml(Number(q.points).toLocaleString())} ${q.points == 1 ? 'point' : 'points'}</span>` : '';
    let inline = '', answer = '';
    switch (q.type) {
        case 'short_answer':
            answer = `<input type="text" id="${answerId}" name="${answerId}" class="form-control" autocapitalize="off"${allowedAttrs(q)} ${NO_HELP}>${allowedHint(q)}`;
            break;
        case 'numeric': { // One number, with the unit beside it when there is one
            // Numbers only unless the lecturer chose otherwise; a power of ten with the ×10ⁿ button,
            // for those who don't know how to type one.
            const nq = q.allowed ? q : { ...q, allowed: 'decimal' };
            const rule = allowedRule(nq.allowed, nq.allowed_chars);
            const pow = !rule || nq.allowed === 'decimal';
            answer = `<div class="numeric-answer"><input type="text" ${rule ? '' : 'inputmode="decimal" '}id="${answerId}" name="${answerId}" class="form-control" autocapitalize="off"${allowedAttrs(nq)} ${NO_HELP}>${pow ? `<button type="button" class="numeric-pow" data-pow="${answerId}" title="Times a power of ten: then type the power" aria-label="Times ten to the power of">×10<sup>n</sup></button>` : ''}${q.unit ? `<span class="numeric-unit">${escapeHtml(q.unit)}</span>` : ''}</div>${allowedHint(nq)}`;
            break;
        }
        case 'fill_blanks': // The line, a box in each blank (Enter goes to the next)
            answer = `<div class="blanks qb-text" data-answer="${answerId}" role="group" aria-label="Fill in the blanks">${formatQuestionText.blanks(q.template || '', i =>
                `<input type="text" class="form-control blank-input" id="${answerId}-b${i}" data-blank="${i}" aria-label="Blank ${i + 1}" autocapitalize="off"${allowedAttrs(q)} ${NO_HELP}>`)}</div>${allowedHint(q)}`;
            break;
        case 'long_answer':
            answer = `<textarea id="${answerId}" name="${answerId}" class="form-control" rows="5" ${NO_HELP}>${escapeHtml(q.content || '')}</textarea><span class="answer-words"></span>`;
            break;
        case 'code':
            answer = `<textarea id="${answerId}" name="${answerId}" class="form-control code-editor" rows="8" ${NO_HELP}>${escapeHtml(q.content || '')}</textarea>`;
            break;
        case 'attachment': { // Uploaded as soon as it is chosen (chooseFileAnswer)
            const types = (Array.isArray(q.allowed_types) ? q.allowed_types : []).filter(Boolean);
            const rules = `${types.length ? types.join(', ') : 'Any file'}, up to ${maxFileMb(q)} MB`;
            answer = `<div class="file-answer" data-answer="${answerId}" data-question="${n}">
                <input type="file" id="${answerId}" class="form-control file-answer-input" hidden${types.length ? ` accept="${escapeHtml(types.join(','))}"` : ''}>
                <button type="button" class="btn-sm btn-secondary file-answer-choose" data-file-input="${answerId}"><i class="fa-solid fa-upload" aria-hidden="true"></i><span>Choose file</span></button>
                <span class="file-answer-rules">${escapeHtml(rules)}</span>
                <div class="file-answer-status" aria-live="polite"></div>
            </div>`;
            break;
        }
        case 'multiple_select':
            answer = choiceListHtml(q, answerId, seed + (q.id ? hashString(String(q.id)) : originalIndex), shuffle);
            break;
        case 'true_false': // Beside the statement, always in this order
            inline = `<div class="tf-choice" id="${answerId}" role="radiogroup" aria-label="True or false">${['True', 'False'].map(value => `
                <label class="tf-option" for="${answerId}-${value.toLowerCase()}"><input type="radio" id="${answerId}-${value.toLowerCase()}" name="${answerId}" value="${value}" class="form-control-checkbox"><span>${value}</span></label>`).join('')}</div>`;
            break;
        default:
            answer = q.content ? `<p>${escapeHtml(q.content)}</p>` : '';
    }
    // The answer in a box of its own: beside a figure that isn't wide, when it is one that fits
    // there (options, a line, a number, a text, a file); code keeps the full width.
    const beside = ['multiple_select', 'short_answer', 'numeric', 'fill_blanks', 'long_answer', 'attachment'].includes(q.type);
    const body = images + (answer ? `<div class="question-response">${answer}</div>` : '');
    div.innerHTML = `
        <div class="question-header">
            <span class="question-number" aria-hidden="true"><span class="question-word">Question</span><span class="question-n">${number}</span></span>
            <span class="question-meta">${inline}${points}</span>
            <div class="question-title"><span class="question-label">Question ${number}</span>${prompt}</div>
        </div>
        ${body ? `<div class="question-body"><div class="question-answer"${beside && images ? ' data-beside' : ''}>${body}</div></div>` : ''}`;
    return div;
}

// Multiple choice: lettered in the order shown (a, b, c… whatever the shuffle), in rows of as
// many as fit, each column as wide as the widest option (fitChoices), so they line up as a grid
// read across: a b c, then d e under a b. An option may have an image, with its text under it.
// With Other (allow_other), the last option is the student's own answer, written in.
function choiceListHtml(q, answerId, optionSeed, shuffle) {
    if (!Array.isArray(q.options) || !q.options.length) return '<p class="exam-error">This question has no options.</p>';
    q.originalOptions = [...q.options];
    const indices = [...Array(q.options.length).keys()];
    const order = shuffle ? seededShuffle(indices, optionSeed) : indices;
    q.shuffledOptionIndices = order; // for grading: each answer's original position
    const images = Array.isArray(q.option_images) ? q.option_images : [];
    const imageOf = i => (typeof images[i] === 'string' && images[i] ? images[i] : '');
    const withImages = order.some(i => imageOf(i));
    return `<div class="choice-list${withImages ? ' has-images' : ''}" id="${answerId}" role="radiogroup">${order.map((i, position) => {
        const optionId = `${answerId}-opt${i}`;
        const image = imageOf(i);
        return `<label class="choice" for="${optionId}">
            <input type="radio" id="${optionId}" name="${answerId}" value="${escapeHtml(q.options[i])}" class="form-control-checkbox" data-original-index="${i}">
            <span class="choice-letter">${String.fromCharCode(97 + position)})</span>
            <span class="choice-body">${image ? `<span class="question-image choice-image is-loading" data-image-id="${escapeHtml(image)}"><span class="question-image-note"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i></span></span>` : ''}<span class="choice-text">${formatQuestionText.inline(q.options[i])}</span></span>
            <span class="choice-strike" role="button" aria-pressed="false" aria-label="Cross out ${String.fromCharCode(97 + position)})" title="${STRIKE_TITLE}"><i class="fa-solid fa-strikethrough" aria-hidden="true"></i></span>
        </label>`;
    }).join('')}${q.allow_other ? `<label class="choice choice-other" for="${answerId}-other">
            <input type="radio" id="${answerId}-other" name="${answerId}" value="${OTHER_VALUE}" class="form-control-checkbox" data-other>
            <span class="choice-letter">${String.fromCharCode(97 + order.length)})</span>
            <span class="choice-body"><span class="choice-text">Other:</span><input type="text" class="form-control choice-other-text" id="${answerId}-other-text" autocapitalize="off" ${NO_HELP} aria-label="Your own answer"></span>
        </label>` : ''}</div>`;
}

// Other: the radio's value is only a mark; the answer is what is written beside it.
const OTHER_VALUE = '__other__';
const otherRadio = answerName => document.getElementById(`${answerName}-other`);
const otherChosen = answerName => !!otherRadio(answerName)?.checked;
const otherText = answerName => document.getElementById(`${answerName}-other-text`)?.value || '';

// Two equal columns when there are four options or fewer and the widest, on one line, fits in
// half the list; else one to a row (CSS .choice-list). Measured once the list is on screen, and
// again when its size changes (the page's font arriving, a larger text size), never while it is
// hidden. (In the next frame: changing a list's size inside the observer's own call is a loop.)
const choiceLists = new ResizeObserver(entries => requestAnimationFrame(() => entries.forEach(entry => fitChoices(entry.target))));
const CHOICE_GAP = 18; // the columns' gap (CSS)
function fitChoices(list) {
    if (!list.isConnected || !list.offsetWidth) return;
    const options = [...list.querySelectorAll('.choice:not(.choice-other)')];
    list.classList.add('is-measuring');
    const widest = Math.max(0, ...options.map(choice => choice.getBoundingClientRect().width));
    list.classList.remove('is-measuring');
    const two = options.length > 1 && options.length <= 4 && widest > 0 && widest <= (list.clientWidth - CHOICE_GAP) / 2;
    if (list.classList.contains('is-two') !== two) list.classList.toggle('is-two', two);
}

function displayQuestions(questionsJsonString) {
    choiceLists.disconnect();
    examQuestionsArea.innerHTML = ''; // Clear previous questions
    codeEditors = {};
    fileAnswers = {}; // restoreExam puts saved ones back
    totalQuestions = 0;

    try {
        let questionsArray = [];
        try {
            questionsArray = JSON.parse(questionsJsonString);
            if (!Array.isArray(questionsArray)) {
                throw new Error("Parsed data is not an array.");
            }
        } catch (parseError) {
            console.warn("Could not parse questions JSON. Displaying as a single block.", parseError);
            questionsArray = [{
                type: "long_answer",
                prompt: "Exam Instructions / Questions",
                content: questionsJsonString
            }];
        }

        totalQuestions = questionsArray.length;

        // Check if the exam has shuffle disabled
        const shuffleDisabled = examDetails.shuffleQuestions === false;

        const skipShuffle = shuffleDisabled;

        // Seeded per student (their email or student ID, or the exam ID when anonymous), and by
        // each question's id, so the order is the same after a reload, and stays so when the
        // lecturer adds or removes a question meanwhile.
        const seed = hashString(examDetails.Seed || Date.now().toString());

        // The order students see (questionOrder): shuffled, by kind within each part of the exam.
        const displayIndices = questionOrder(questionsArray, !skipShuffle, seed);

        // Create mapping of questions for later
        examDetails.OriginalOrderMap = {};
        questionsArray.forEach((q, index) => {
            examDetails.OriginalOrderMap[index] = q;
        });

        // File questions with others: a page of their own, after the questions (examPagesOf).
        examPages = examPagesOf(questionsArray, displayIndices);
        examUploadsOnly = !examPages && questionsArray.some(q => q?.type === 'attachment');

        // Numbered in that order (the questions page, then the file uploads); text-only items
        // are headings, not numbered. Two or more true or false (or multiple choice) questions in
        // a row sit together under one heading, as on a paper exam.
        let questionNumber = 0;
        const renderQuestions = (indices, area) => {
            let group = null;
            indices.forEach((originalIndex, k) => {
                const q = questionsArray[originalIndex];
                const previous = questionsArray[indices[k - 1]], next = questionsArray[indices[k + 1]];
                const figure = figureOf(q);
                const shared = !!figure && (figureOf(previous) === figure || figureOf(next) === figure);
                const questionDiv = questionElement(q, originalIndex, q.type === 'text_only' ? 0 : ++questionNumber, seed, !skipShuffle, { figureAbove: shared });
                // A part's heading on both pages: the second is a copy.
                if (document.getElementById(questionDiv.id)) {
                    questionDiv.id += '-again';
                    delete questionDiv.dataset.originalIndex;
                }
                const kind = GROUP_HEADINGS[q.type] ? q.type : '';
                if (shared) {
                    if (group?.dataset.figure !== figure) group = figureGroup(q, area);
                    group.querySelector('.question-group-items').appendChild(questionDiv);
                } else if (kind && (previous?.type === kind || next?.type === kind)) {
                    if (!group || group.dataset.figure || previous?.type !== kind) group = questionGroup(kind, area);
                    group.querySelector('.question-group-items').appendChild(questionDiv);
                } else {
                    group = null;
                    area.appendChild(questionDiv);
                }
                if (q.type === 'code') initializeCodeEditor(`ans-${originalIndex + 1}`, q.language || 'python');
            });
        };
        if (examPages) {
            for (const page of ['questions', 'uploads']) {
                const area = examPageElement(page);
                examQuestionsArea.appendChild(area);
                renderQuestions(examPages[page], area.querySelector('.exam-page-items'));
            }
        } else {
            if (examUploadsOnly) examQuestionsArea.insertAdjacentHTML('beforeend', examPageNote('uploads'));
            renderQuestions(displayIndices, examQuestionsArea);
        }
        renderPageTabs();
        examQuestionsArea.querySelectorAll('.choice-list:not(.has-images)').forEach(list => choiceLists.observe(list));
        refreshAnswered();

        // Above them: how many, and the points
        const counted = questionsArray.filter(q => q.type !== 'text_only');
        const points = counted.reduce((sum, q) => sum + (Number(q.points) || 0), 0);
        const count = document.getElementById('exam-questions-count');
        if (count) count.textContent = `${counted.length.toLocaleString()} question${counted.length === 1 ? '' : 's'}${points ? `, ${points.toLocaleString()} point${points === 1 ? '' : 's'}` : ''}`;
    } catch (e) {
        console.error("Error displaying questions:", e);
        examQuestionsArea.innerHTML = '<p>Error loading questions.</p>';
        examPages = null;
        examUploadsOnly = false;
        renderPageTabs();
    }

    applyExamPage();
}


// === Pages: the questions, and the file uploads ===
// An exam with file questions and others has two pages. On the first, leaving the exam page
// locks the exam as its settings say (without full screen); on the second, the file
// questions, students may go to other programs for their files (examIntegrity's 'free'),
// while the questions stay hidden. The page shown is kept with the exam on this computer
// (examDetails.Page) and in the draft another computer carries on from (examDraft).
// Students go back and forth as they like (the tabs, Previous and Next), and Submit, under
// both, sends the whole exam. A part's heading goes with its questions: on both pages when its
// part has both kinds, on the first when its part has none.
function examPagesOf(questions, order) {
    const isFile = i => questions[i]?.type === 'attachment';
    const isOther = i => !!questions[i] && questions[i].type !== 'attachment' && questions[i].type !== 'text_only';
    if (!order.some(isFile) || !order.some(isOther)) return null;
    const pages = { questions: [], uploads: [] };
    order.forEach((i, k) => {
        if (questions[i]?.type !== 'text_only') { pages[isFile(i) ? 'uploads' : 'questions'].push(i); return; }
        const part = [];
        for (let j = k + 1; j < order.length && questions[order[j]]?.type !== 'text_only'; j++) part.push(order[j]);
        const files = part.some(isFile);
        if (part.some(isOther) || !files) pages.questions.push(i);
        if (files) pages.uploads.push(i);
    });
    return pages;
}

const PAGE_NAMES = { questions: 'Questions', uploads: 'File uploads' };
const currentPage = () => (examPages ? (examDetails?.Page === 'uploads' ? 'uploads' : 'questions') : null);
// How leaving the exam page is treated (examIntegrity): allowed on the file uploads. With two
// pages there is no full screen: going back and forth would switch it on and off.
const leaveMode = () => (examUploadsOnly || currentPage() === 'uploads' ? 'free' : 'locked');

// What a page's tab says under its name: what leaving does there.
function pageRule(page) {
    if (page === 'uploads') return 'You may leave this page';
    return examDetails?.Settings?.leave === 'record' ? 'Leaving is recorded' : 'Stay on this page';
}

// On the file uploads: leaving is allowed here.
function examPageNote(page) {
    if (page !== 'uploads') return '';
    return `<p class="exam-page-note"><i class="fa-solid fa-door-open" aria-hidden="true"></i><span>You may leave the exam page here to make or find your files.${examPages ? ' The questions stay hidden while you are on this page.' : ''}</span></p>`;
}

function examPageElement(page) {
    const other = page === 'questions' ? 'uploads' : 'questions';
    const el = document.createElement('div');
    el.className = 'exam-page';
    el.id = `exam-page-${page}`;
    el.dataset.page = page;
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', `exam-tab-${page}`);
    el.innerHTML = `${examPageNote(page)}<div class="exam-page-items"></div>
        <div class="exam-page-nav is-${page === 'questions' ? 'next' : 'previous'}">
            <button type="button" class="btn-secondary" data-page-go="${other}">${page === 'questions'
                ? `<span>Next: ${PAGE_NAMES[other]}</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`
                : `<i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>Previous: ${PAGE_NAMES[other]}</span>`}</button>
        </div>`;
    return el;
}

// The two tabs above the questions: each page's name, what leaving does there, and its count.
function renderPageTabs() {
    let tabs = document.getElementById('exam-pages');
    if (!examPages) { tabs?.remove(); return; }
    if (!tabs) {
        tabs = document.createElement('div');
        tabs.id = 'exam-pages';
        tabs.className = 'exam-pages';
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', 'Pages of the exam');
        examQuestionsArea.before(tabs);
    }
    tabs.innerHTML = ['questions', 'uploads'].map((page, i) => `<button type="button" role="tab" class="exam-page-tab" id="exam-tab-${page}" data-page-go="${page}" aria-controls="exam-page-${page}">
        <span class="exam-page-step" aria-hidden="true">${i + 1}</span>
        <span class="exam-page-tab-text"><strong>${PAGE_NAMES[page]}</strong><small>${pageRule(page)}</small></span>
        <span class="exam-page-tab-count"></span></button>`).join('');
}

// Shows a page (a press on a tab, Previous or Next, or a question on the other page). The
// questions take the exam back to full screen, and the press lets the browser do it.
function showExamPage(page, { scroll = true } = {}) {
    if (!examPages || !examDetails) return;
    page = page === 'uploads' ? 'uploads' : 'questions';
    if (page === currentPage()) return;
    examDetails.Page = page;
    applyExamPage();
    if (scroll) window.scrollTo({ top: 0 });
    saveExamState();
}

// The page in examDetails.Page on screen, its tab chosen, and leaving treated as it says.
function applyExamPage() {
    const page = currentPage();
    examQuestionsArea.querySelectorAll('.exam-page').forEach(el => { el.hidden = el.dataset.page !== page; });
    document.querySelectorAll('#exam-pages [data-page-go]').forEach(tab => {
        const on = tab.dataset.pageGo === page;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
    });
    // Code editors made while their page was hidden draw themselves once it shows.
    if (page === 'questions') requestAnimationFrame(() => Object.values(codeEditors).forEach(editor => editor.refresh?.()));
    examIntegrity.setMode(leaveMode(), { allowFullscreen: !examPages });
    checkAllAnswered();
}

document.addEventListener('click', e => {
    const go = e.target.closest?.('[data-page-go]');
    if (go && examQuestionsModule.contains(go)) showExamPage(go.dataset.pageGo);
});
// The tabs: the arrow keys move between them.
document.addEventListener('keydown', e => {
    if (!e.target.closest?.('#exam-pages') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const page = e.key === 'ArrowLeft' || e.key === 'Home' ? 'questions' : 'uploads';
    showExamPage(page);
    document.getElementById(`exam-tab-${page}`)?.focus();
});

// Reads a question's current answer. Code answers live in their CodeMirror editor, not the
// textarea; a file question's answer is the file already uploaded.
function getAnswerValue(answerName) {
    if (codeEditors[answerName]) return codeEditors[answerName].getValue();
    if (fileAnswerBox(answerName)) return fileAnswers[answerName] || '';
    // Fill in the blanks: what is in each, in order.
    const blanks = blanksBox(answerName);
    if (blanks) return [...blanks.querySelectorAll('.blank-input')].map(input => input.value);
    if (otherChosen(answerName)) return otherText(answerName);
    const formElement = examForm.elements[answerName];
    if (!formElement) return undefined;
    if (formElement.type === 'file') {
        return (formElement.files && formElement.files.length > 0) ? 'FILE_SELECTED' : '';
    }
    return formElement.value || ''; // Radio groups (RadioNodeList) return the checked value
}

// Writes a saved answer back into its question (a file question's: the file it uploaded). A
// multiple-choice answer that is none of the options is the student's own, under Other.
function setAnswerValue(answerName, value, metadata = null) {
    if (codeEditors[answerName]) {
        codeEditors[answerName].setValue(value || '');
        return;
    }
    const box = fileAnswerBox(answerName);
    if (box) {
        if (value && typeof value === 'object' && value.upload) fileAnswers[answerName] = value;
        else delete fileAnswers[answerName];
        renderFileAnswer(box);
        return;
    }
    const blanks = blanksBox(answerName);
    if (blanks) {
        const values = Array.isArray(value) ? value : [];
        blanks.querySelectorAll('.blank-input').forEach((input, i) => { input.value = typeof values[i] === 'string' ? values[i] : ''; sizeBlank(input); });
        return;
    }
    const formElement = examForm.elements[answerName];
    if (!formElement || formElement.type === 'file') return;
    const other = otherRadio(answerName);
    if (other) {
        const text = typeof value === 'string' ? value : '';
        const isOption = [...examForm.querySelectorAll(`input[name="${answerName}"]:not([data-other])`)].some(r => r.value === text);
        if (metadata?.other || (text && !isOption)) {
            other.checked = true;
            document.getElementById(`${answerName}-other-text`).value = text;
            return;
        }
    }
    if (formElement instanceof RadioNodeList && !value) {
        examForm.querySelectorAll(`input[name="${answerName}"]`).forEach(r => { r.checked = false; });
        return;
    }
    formElement.value = value || '';
}

// ── Answered, at once: an option or True or False chosen, something typed (other than the
// starting text or code), a file uploaded. The answer then fades a little: still clear to the
// student, harder to read from the next seat; taking it away (a second click on the option,
// clearing the text, Remove) brings it back. Every answer is sent, by Submit and at the
// deadline alike. ──
function questionHasAnswer(div) {
    const n = Number(div?.id?.slice(2));
    const q = examDetails?.OriginalOrderMap?.[n - 1];
    if (!q || q.type === 'text_only') return false;
    const name = `ans-${n}`;
    if (q.type === 'attachment') return !!fileAnswers[name];
    if (q.type === 'multiple_select' || q.type === 'true_false') {
        if (!examForm.querySelector(`input[name="${name}"]:checked`)) return false;
        return !otherChosen(name) || !!otherText(name).trim();
    }
    // Every blank filled in (one left empty: Next question comes back to it).
    if (q.type === 'fill_blanks') {
        const values = getAnswerValue(name);
        return Array.isArray(values) && values.length > 0 && values.every(v => v.trim());
    }
    const value = getAnswerValue(name);
    if (typeof value !== 'string' || !value.trim()) return false;
    if (q.type === 'long_answer' || q.type === 'code') return value.trim() !== String(q.content || '').trim();
    return true;
}

// Some answer given: what is sent (a blank or two filled in counts, though not answered in full).
function questionHasAnyAnswer(div) {
    const n = Number(div?.id?.slice(2));
    const q = examDetails?.OriginalOrderMap?.[n - 1];
    if (q?.type === 'fill_blanks') return (getAnswerValue(`ans-${n}`) || []).some(v => v.trim());
    return questionHasAnswer(div);
}
const partlyAnswered = div => !questionHasAnswer(div) && questionHasAnyAnswer(div);

function refreshAnswered(div = null) {
    const list = div ? [div] : examQuestionsArea.querySelectorAll('.question:not(.text-only-question)');
    let changed = false;
    list.forEach(question => {
        if (question.classList.contains('is-long_answer')) updateWordCount(question);
        const on = questionHasAnswer(question);
        if (question.classList.contains('is-answered') === on) return;
        question.classList.toggle('is-answered', on);
        changed = true;
    });
    if (!changed) return;
    checkAllAnswered();
    if (examDetails && typeof heartbeatSoon === 'function') heartbeatSoon(); // the draft, for another computer
}

// A long answer's words so far, under its box.
function updateWordCount(question) {
    const box = question.querySelector('.answer-words');
    if (!box) return;
    const words = (question.querySelector('textarea')?.value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
    const label = words ? `${words.toLocaleString()} word${words === 1 ? '' : 's'}` : '';
    if (box.textContent !== label) box.textContent = label;
}

examQuestionsArea?.addEventListener('input', e => {
    // Writing an answer of one's own chooses Other.
    if (e.target.matches?.('.choice-other-text')) {
        const radio = e.target.closest('.choice-other')?.querySelector('input[type="radio"]');
        if (radio && !radio.checked && e.target.value.trim()) radio.checked = true;
    }
    const question = e.target.closest?.('.question');
    if (question) refreshAnswered(question);
});
examQuestionsArea?.addEventListener('change', e => {
    const question = e.target.closest?.('.question');
    if (question) refreshAnswered(question);
});

// ── Crossing out, as on paper: an option the student has ruled out, struck through and dimmed
// (the button at its end, a right-click on the option, or a long press on a phone). It is not
// an answer and is never sent: crossing out the chosen option clears it, and choosing a
// crossed-out one brings it back. Kept on this computer with the answers, across a reload. ──
const STRIKE_TITLE = 'Cross it out (or right-click the option)';
function setStruck(choice, on, { save = true } = {}) {
    if (!choice || choice.classList.contains('is-struck') === on) return;
    choice.classList.toggle('is-struck', on);
    const button = choice.querySelector('.choice-strike');
    button?.setAttribute('aria-pressed', String(on));
    button?.setAttribute('title', on ? 'Bring it back' : STRIKE_TITLE);
    const radio = choice.querySelector('input[type="radio"]');
    if (on && radio?.checked) {
        radio.checked = false;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (save) saveAnswersSoon();
}
const strikable = target => {
    const choice = target?.closest?.('.choice:not(.choice-other)');
    return choice && !choice.querySelector('input:disabled') ? choice : null;
};
examQuestionsArea?.addEventListener('click', e => {
    if (!e.target.closest?.('.choice-strike')) return;
    e.preventDefault(); // not a click on the option: it stays as it was
    const choice = strikable(e.target);
    if (choice) setStruck(choice, !choice.classList.contains('is-struck'));
});
examQuestionsArea?.addEventListener('contextmenu', e => {
    const choice = strikable(e.target);
    if (!choice) return;
    e.preventDefault();
    setStruck(choice, !choice.classList.contains('is-struck'));
});
examQuestionsArea?.addEventListener('change', e => {
    if (e.target.matches?.('.choice input[type="radio"]') && e.target.checked) setStruck(e.target.closest('.choice'), false);
});

// The crossed-out options, by question and original position, to keep and to put back.
function collectStruck() {
    const struck = {};
    examQuestionsArea?.querySelectorAll('.choice.is-struck input[data-original-index]').forEach(radio => {
        (struck[radio.name] ||= []).push(Number(radio.dataset.originalIndex));
    });
    return struck;
}
function applyStruck(struck) {
    for (const [name, list] of Object.entries(struck || {})) {
        if (!Array.isArray(list)) continue;
        list.forEach(i => {
            const choice = document.getElementById(`${name}-opt${i}`)?.closest('.choice');
            if (choice && !choice.querySelector('input:checked')) setStruck(choice, true, { save: false });
        });
    }
}

// A second click on the chosen option (or on True or False) clears it.
let pressedChoice = null;
examQuestionsArea?.addEventListener('pointerdown', e => {
    const radio = e.target.closest?.('.choice, .tf-option')?.querySelector('input[type="radio"]');
    pressedChoice = radio && radio.checked && !e.target.matches('.choice-other-text') ? radio : null;
});
examQuestionsArea?.addEventListener('click', e => {
    const radio = e.target.matches?.('input[type="radio"].form-control-checkbox') ? e.target : null;
    if (!radio) return;
    const clear = radio === pressedChoice;
    pressedChoice = null;
    if (!clear || radio.disabled) return;
    radio.checked = false;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
});

// Function to create a consistent hash from a string (for seeding)
function hashString(str) {
    let hash = 0;
    if (!str || str.length === 0) return Math.floor(Math.random() * 1000000);

    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }

    return Math.abs(hash);
}

/**
 * Deterministic (seeded) in‐place Fisher–Yates shuffle.
 *
 * @param {any[]} array
 * @param {number} seed  // e.g. hashString(userEmail)
 * @returns the same array, shuffled
 */
function seededShuffle(array, seed) {
    let m = array.length, t, i;
    // very simple PRNG: linear congruential
    while (m > 0) {
        seed = (seed * 1664525 + 1013904223) >>> 0;     // update seed
        i = seed % m;                                   // pick an index
        m--;
        // swap array[m] and array[i]
        t = array[m];
        array[m] = array[i];
        array[i] = t;
    }
    return array;
}


// Add triple click handler for the user's photo in the top bar (import backup).
// Delegated from #top-user, because renderTopUser() replaces the photo on every sign-in.
function setupBackupImportFeature() {
    const topUser = document.getElementById('top-user');
    if (!topUser) return;

    // Track clicks for triple-click detection
    let clickCount = 0;
    let clickTimer = null;

    topUser.addEventListener('click', function (e) {
        if (!e.target.closest('.user-avatar')) return;
        clickCount++;

        if (clickCount === 1) {
            clickTimer = setTimeout(() => {
                clickCount = 0;
                clickTimer = null;
            }, 500); // Reset after 500ms
        }

        if (clickCount === 3) {
            // Triple click detected!
            clearTimeout(clickTimer);
            clickCount = 0;
            clickTimer = null;

            // Show import backup dialog
            showBackupImportDialog();
        }
    });

    // Create backup import dialog if it doesn't exist
    if (!document.getElementById('backup-import-modal')) {
        createBackupImportDialog();
    }
}

// Create the backup import dialog (the site's modal)
function createBackupImportDialog() {
    const modalDiv = document.createElement('div');
    modalDiv.id = 'backup-import-modal';
    modalDiv.setAttribute('class', 'modal-overlay');

    modalDiv.innerHTML = `
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="backup-modal-title">
    <div class="modal-head">
        <h3 id="backup-modal-title">Import Backup</h3>
        <button type="button" class="btn-ghost btn-icon modal-close" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="modal-body">
        <p>You can restore a previously saved exam backup JSON file here.</p>
        <div class="form-group">
            <label class="form-label" for="backup-file-input">Backup file</label>
            <input type="file" id="backup-file-input" class="form-control" accept=".json">
        </div>
        <div class="backup-info" id="backup-info"></div>
        <div class="backup-preview" id="backup-preview"></div>
    </div>
    <div class="modal-foot">
        <button type="button" class="btn-green btn-sm" id="backup-import-btn" disabled><i class="fa-solid fa-file-import" style="margin-right:5px"></i>Import Backup</button>
    </div>
</div>
    `;

    document.body.appendChild(modalDiv);

    // The ×, Escape, Back and a click outside close it through js/dialogs.js.
    modalDiv._close = hideBackupImportDialog;
    document.getElementById('backup-file-input').addEventListener('change', handleBackupFileSelected);
    document.getElementById('backup-import-btn').addEventListener('click', importBackupData);
}

// Show the backup import dialog
function showBackupImportDialog() {
    const modal = document.getElementById('backup-import-modal');
    if (modal) {
        // Reset dialog state
        document.getElementById('backup-file-input').value = '';
        document.getElementById('backup-info').innerHTML = '';
        document.getElementById('backup-preview').innerHTML = '';
        document.getElementById('backup-import-btn').disabled = true;

        // Show modal
        modal.classList.add('open');
    }
}

// Hide the backup import dialog
function hideBackupImportDialog() {
    const modal = document.getElementById('backup-import-modal');
    if (modal) {
        modal.classList.remove('open');
    }
}

// Handle backup file selection
function handleBackupFileSelected(event) {
    const fileInput = event.target;
    const file = fileInput.files[0];
    const infoDiv = document.getElementById('backup-info');
    const previewDiv = document.getElementById('backup-preview');
    const importBtn = document.getElementById('backup-import-btn');

    // Reset display areas
    infoDiv.innerHTML = '';
    previewDiv.innerHTML = '';
    importBtn.disabled = true;

    if (!file) return;

    // Check file type
    if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
        infoDiv.innerHTML = '<p class="backup-error">Error: Selected file is not a JSON file.</p>';
        return;
    }

    // Read file content
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const backupData = JSON.parse(e.target.result);

            // Validate backup data structure
            if (!backupData.examDetails || !backupData.studentInfo || !backupData.answers) {
                throw new Error('Invalid backup file structure');
            }

            // Show backup details
            infoDiv.innerHTML = `
        <p><strong>Exam:</strong> ${escapeHtml(backupData.examDetails.Name || 'N/A')}</p>
        <p><strong>Course:</strong> ${escapeHtml(backupData.examDetails.Code || 'N/A')}</p>
        <p><strong>Student:</strong> ${escapeHtml(backupData.studentInfo.name || backupData.studentInfo.examCode || 'N/A')}</p>
        <p><strong>Timestamp:</strong> ${escapeHtml(backupData.submissionTimestamp || 'N/A')}</p>
        <p><strong>Questions:</strong> ${backupData.totalQuestionsOnSubmit || 'N/A'}</p>
        <p><strong>Answered:</strong> ${backupData.confirmedCountOnSubmit || 'N/A'}</p>
    `;

            // Show preview of answers
            const answerKeys = Object.keys(backupData.answers || {}).slice(0, 3);
            if (answerKeys.length > 0) {
                let previewHtml = '<p><strong>Answer Preview:</strong></p><ul>';
                answerKeys.forEach(key => {
                    const value = backupData.answers[key];
                    const truncatedValue = typeof value === 'string' && value.length > 50
                        ? value.substring(0, 50) + '...'
                        : value;
                    previewHtml += `<li>${escapeHtml(key)}: ${escapeHtml(String(truncatedValue))}</li>`;
                });
                if (Object.keys(backupData.answers).length > 3) {
                    previewHtml += `<li>... and ${Object.keys(backupData.answers).length - 3} more</li>`;
                }
                previewHtml += '</ul>';
                previewDiv.innerHTML = previewHtml;
            } else {
                previewDiv.innerHTML = '<p>No answers found in backup.</p>';
            }

            // Store backup data for import
            fileInput.dataset.validBackup = 'true';
            importBtn.disabled = false;

        } catch (error) {
            console.error('Error parsing backup file:', error);
            infoDiv.innerHTML = `<p class="backup-error">Error: ${error.message}. Please select a valid backup file.</p>`;
            fileInput.dataset.validBackup = 'false';
        }
    };

    reader.onerror = function () {
        infoDiv.innerHTML = '<p class="backup-error">Error: Failed to read the file.</p>';
    };

    reader.readAsText(file);
}

// Import backup data
function importBackupData() {
    const fileInput = document.getElementById('backup-file-input');
    if (!fileInput || fileInput.dataset.validBackup !== 'true' || !fileInput.files[0]) {
        showImprovedNotification('error', 'Import Failed', 'Invalid or missing backup file.', 3000);
        return;
    }

    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            const backupData = JSON.parse(e.target.result);

            // Confirm with user
            const confirmed = await confirmDialog(
                `Import the backup for ${backupData.examDetails.Name} (${backupData.examDetails.Code})?\n\nThis will replace any current exam data.`,
                { title: 'Import Backup', okLabel: 'Import', okIcon: 'fa-file-import' });
            if (confirmed) {
                if (applyBackupToForm(backupData)) {
                    hideBackupImportDialog();
                    showImprovedNotification('success', 'Backup Imported', 'Exam backup has been successfully imported.', 5000);
                }
            }
        } catch (error) {
            console.error('Error importing backup:', error);
            showImprovedNotification('error', 'Import Failed', `Error: ${error.message}`, 5000);
        }
    };

    reader.readAsText(fileInput.files[0]);
}

// Apply backup data to the form. The backup file has the answers but not the questions,
// so the same exam must already be loaded and started.
function applyBackupToForm(backupData) {
    const backupExamId = backupData.examDetails?.ExamId;
    if (!examDetails || examDetails.ExamId !== backupExamId || examQuestionsModule.classList.contains('hidden')) {
        showImprovedNotification('error', 'Import Failed', `Start "${backupData.examDetails?.Name || 'the same exam'}" first, then import the backup again.`, 0);
        return false;
    }

    const answers = backupData.answers || {};

    for (const answerName in answers) {
        // Skip metadata entries (ans-N_metadata) and placeholder values
        if (!/^ans-\d+$/.test(answerName)) continue;
        const answerValue = answers[answerName];
        if (answerValue === '[NOT CONFIRMED]' || answerValue === '[TEXT_ONLY_NO_ANSWER_REQUIRED]') continue;

        const questionId = answerName.replace('ans-', 'q-');
        const questionDiv = document.getElementById(questionId);
        if (!questionDiv) continue;

        setAnswerValue(answerName, answerValue, answers[`${answerName}_metadata`]);
        refreshAnswered(questionDiv);
    }

    checkAllAnswered();
    autoSaveAnswers();
    return true;
}

// Starts the countdown timer
function startTimer() {
    if (examTimerInterval) {
        console.warn("Timer is already running.");
        return;
    }

    if (!examEndTime || isNaN(examEndTime) || timeLeftMs() <= 0) {
        console.error("Cannot start timer: Invalid or past exam end time.", examEndTime);
        if (examEndTime && timeLeftMs() <= 0) handleSubmitExam(true); // the result screen says time was up
        return;
    }

    showTimer();
    updateTimerDisplay(); // Initial display update
    examTimerInterval = setInterval(updateTimerDisplay, 1000);
}

// The time left, by the server's clock (examStore.now: the computer's own may be wrong), and
// never more than the exam's whole length.
function timeLeftMs() {
    const left = Math.max(0, examEndTime - examStore.now());
    const span = examDetails?.StartsAt ? examEndTime - examDetails.StartsAt : 0;
    return span > 0 ? Math.min(left, span) : left;
}

// 59:07, or 1:59:07 from an hour.
function formatTimeLeft(ms) {
    const total = Math.ceil(ms / 1000);
    const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
    const two = n => String(n).padStart(2, '0');
    return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

// The exam's whole length, to colour the time by the share left (a 10-minute quiz is not
// orange the whole time).
function examSpanMs() {
    if (examDetails?.StartsAt && examEndTime > examDetails.StartsAt) return examEndTime - examDetails.StartsAt;
    return (Number(examDetails?.Duration) || 60) * 60000;
}
// Yellow at 30% of the exam left, orange at 15%, red at 7%.
function timeStage(left) {
    if (left <= 0) return 'over';
    const share = left / examSpanMs();
    return share <= 0.07 ? 'danger' : share <= 0.15 ? 'warning' : share <= 0.3 ? 'notice' : '';
}

// Updates the timer display every second
function updateTimerDisplay() {
    const display = document.getElementById('exam-timer-display');
    if (!examEndTime) {
        stopTimer();
        if (display) display.textContent = '--:--';
        return;
    }
    const timeLeft = timeLeftMs();
    const text = formatTimeLeft(timeLeft);
    if (display && display.textContent !== text) display.textContent = text;
    setTimeStage(timeStage(timeLeft));

    // Time is up: submitted at once (the result screen says so; no notification on top). The
    // timer itself, turning yellow, orange and red, is the only reminder before: a pop-up over
    // the questions only got in the way.
    if (timeLeft <= 0) {
        stopTimer();
        handleSubmitExam(true);
    }
}

// Stops the countdown timer interval
function stopTimer() {
    if (examTimerInterval) {
        clearInterval(examTimerInterval);
        examTimerInterval = null; // Clear the interval ID
    }
}

// Collects browser/device fingerprint data (basic)
function getFingerprintData() {
    const webglFp = getWebglFingerprint();
    const data = {
        // --- Category 1: Basic Browser & Config ---
        ua: navigator.userAgent || 'N/A',
        lang: navigator.language || 'N/A',
        vendor: navigator.vendor || 'N/A',
        cookieEnabled: navigator.cookieEnabled || false,
        doNotTrack: navigator.doNotTrack || 'unknown',
        plugins: Array.from(navigator.plugins || []).map(p => ({ name: p.name, filename: p.filename })).sort((a, b) => a.name.localeCompare(b.name)),
        mimeTypes: Array.from(navigator.mimeTypes || []).map(m => ({ type: m.type, description: m.description })).sort((a, b) => a.type.localeCompare(b.type)),

        // --- Category 2: Hardware / OS ---
        platform: navigator.platform || 'N/A',
        cores: navigator.hardwareConcurrency || undefined,
        memory: navigator.deviceMemory || undefined,
        maxTouchPoints: navigator.maxTouchPoints || 0,

        // --- Category 3: Screen & Display ---
        screenRes: `${screen.width || 0}x${screen.height || 0}x${screen.colorDepth || 0}`,
        // A second screen connected (Chrome and Edge tell; others leave it out): notes can sit
        // on it without the exam page ever losing focus.
        extendedScreen: typeof screen.isExtended === 'boolean' ? screen.isExtended : null,
        availScreenRes: `${screen.availWidth || 0}x${screen.availHeight || 0}`,
        windowInnerSize: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
        timezoneOffset: new Date().getTimezoneOffset(),
        timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })(),

        // --- Category 3b: This browser (the id one device at a time uses), as it reports itself,
        // and its connection where the browser tells (Wi-Fi names are never available) ---
        deviceId: examStore.deviceId(),
        uaPlatform: navigator.userAgentData?.platform || '',
        uaMobile: navigator.userAgentData?.mobile ?? null,
        uaBrands: (navigator.userAgentData?.brands || []).map(b => `${b.brand} ${b.version}`).join(', '),
        connection: navigator.connection ? [navigator.connection.type, navigator.connection.effectiveType].filter(Boolean).join(', ') : '',

        // --- Category 4: GPU Info (from WebGL) ---
        webglAvailable: webglFp.available, // Was WebGL context available?
        webglVendor: webglFp.vendor,       // GPU Vendor string
        webglRenderer: webglFp.renderer,   // GPU Renderer string (often the model)

        // --- Timestamp ---
        ts: Date.now()
    };
    // Return as OBJECT now, will be stringified before sending
    return data;
}

// Helper function for WebGL fingerprinting
function getWebglFingerprint() {
    try {
        const canvas = document.createElement('canvas');
        // Try both standard and experimental contexts
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) {
            return { available: false, vendor: 'N/A', renderer: 'N/A' }; // WebGL not supported
        }
        // Get debug extension to potentially unmask renderer/vendor info
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = gl.getParameter(debugInfo ? debugInfo.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
        const renderer = gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
        return {
            available: true,
            vendor: vendor || 'unknown',
            renderer: renderer || 'unknown'
        };
    } catch (e) {
        console.warn("WebGL fingerprinting failed:", e);
        return { available: false, vendor: 'error', renderer: 'error', errorMsg: e.message };
    }
}

// Triggers a download of JSON data as a file
function downloadJsonBackup(data, filename) {
    try {
        const jsonString = JSON.stringify(data, null, 2); // Pretty-print JSON
        const blob = new Blob([jsonString], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename; // Set the download filename
        document.body.appendChild(link); // Append link to body
        link.click(); // Programmatically click the link to trigger download
        document.body.removeChild(link); // Remove link from body
        setTimeout(() => URL.revokeObjectURL(url), 1000); // the result screen says it was saved
    } catch (e) {
        console.error("Error creating or triggering JSON backup download:", e);
        showImprovedNotification('error', 'Backup Error', 'Could not create the backup file. Please manually copy your answers if needed.');
    }
}




// Handles the final exam submission: a local backup file, then sendSubmission (scripts.js)
async function handleSubmitExam(isAutoSubmit = false) {
    const timeIsUp = examEndTime && timeLeftMs() <= 0;
    if (timeIsUp && !isAutoSubmit) isAutoSubmit = true; // after the deadline: submitted as time ran out
    // The deadline submits for the student: close a Submit confirmation they left open.
    if (isAutoSubmit) _resolveConfirm(false);

    // Submit asks first. The timer keeps running until the submission actually goes ahead, so
    // the automatic submit at the deadline still happens if this is refused or cancelled.
    if (!isAutoSubmit) {
        const { required, answered, allAnswered } = getAnswerCounts();
        if (uploadsInProgress.size) {
            showImprovedNotification('warning', 'Still Uploading', 'A file is still uploading. Submit once it is done.', 5000);
            return;
        }
        // A question without an answer: a warning, with Submit anyway, or back to the first one.
        const submitConfirmed = await confirmDialog(submitQuestion(required, answered, allAnswered), allAnswered
            ? { title: 'Submit Exam', okLabel: 'Submit', okIcon: 'fa-paper-plane' }
            : { title: 'Not Everything Is Answered', okLabel: 'Submit anyway', okIcon: 'fa-paper-plane', danger: true,
                cancelLabel: 'Go to it', cancelIcon: 'fa-arrow-up' });
        // examDetails is cleared once a submission (including the deadline's) has gone ahead.
        if (!submitConfirmed || !examDetails) {
            if (!submitConfirmed && examDetails && !allAnswered) goToFirstUnanswered();
            return;
        }
    }
    await submitNow(isAutoSubmit);
}

// What Submit asks: whether every question has an answer, and if not, which (by their numbers
// on the page).
function submitQuestion(required, answered, allAnswered) {
    const end = 'Submit your exam? It cannot be changed afterwards.';
    if (allAnswered) return end;
    const anyway = 'Submit anyway? It cannot be changed afterwards.';
    const open = [...examQuestionsArea.querySelectorAll('.question:not(.text-only-question):not(.is-answered)')];
    const partly = open.some(partlyAnswered);
    if (!answered && !partly) return `No question has an answer yet.\n\n${anyway}`;
    const numbers = open.map(el => Number(el.dataset.number)).filter(Boolean).sort((a, b) => a - b);
    const list = numbers.length > 1 ? `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}` : String(numbers[0] ?? '');
    return `${numbers.length === 1 ? `Question ${list} has` : `Questions ${list} have`} no answer${partly ? ', or a blank left empty' : ''}.\n\n${anyway}`;
}

// The first question without an answer, from the top.
function goToFirstUnanswered() {
    goToQuestion(examQuestionsArea.querySelector('.question:not(.text-only-question):not(.is-answered)'));
}

// Collects the submission, saves a backup file, and sends it. savedIntegrity: the leave record
// of an exam that isn't running here (sent after a reboot).
async function submitNow(isAutoSubmit, savedIntegrity = null) {
    const timeIsUp = examEndTime && timeLeftMs() <= 0;
    stopTimer();

    // Disable submit button and show submitting state (always)
    submitExamBtn.disabled = true;
    submitExamBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';

    if (!examDetails || !examDetails.OriginalOrderMap || totalQuestions <= 0) {
        showImprovedNotification('error', 'Submission Error', 'Cannot collect answers. Exam data or question count is invalid.', 0);
        checkAllAnswered(); // Reset button state
        return;
    }

    const answers = collectAnswers(isAutoSubmit);
    const fingerprintObject = getFingerprintData();
    const activity = examIntegrity.activity(savedIntegrity); // leaving the page

    // A preview ends here: what would have been sent, and nothing saved.
    if (examDetails.Kind === 'preview') {
        const preview = { ...examDetails };
        finishExamSession();
        onPreviewSubmitted(preview, answers, activity, isAutoSubmit);
        return;
    }

    // --- A local backup file, whatever happens online ---
    const answerCounts = getAnswerCounts();
    const isAnonymous = examDetails.Kind === 'anonymous';
    const backupData = {
        submissionTimestamp: new Date().toISOString(),
        examDetails: { ExamId: examDetails.ExamId, Name: examDetails.Name, Code: examDetails.Code, Kind: examDetails.Kind },
        studentInfo: isAnonymous ? { examCode: examDetails.ExamCode } : { ...examDetails.Student },
        answers: answers,
        questionIds: questionIds(), // the lecturer can add this file as the submission
        fingerprint: fingerprintObject,
        activity: activity,
        submittedLate: timeIsUp,
        autoSubmitted: isAutoSubmit,
        confirmedCountOnSubmit: answerCounts.answered, // the name backup files have always used
        totalQuestionsOnSubmit: answerCounts.required
    };
    const slug = text => String(text || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();
    const who = isAnonymous ? examDetails.ExamCode : (examDetails.Student?.student_no || examDetails.Student?.email);
    downloadJsonBackup(backupData, `exam_backup_${slug(examDetails.Code)}_${slug(examDetails.Name)}_${slug(who) || 'student'}_${Date.now()}.json`);

    await deliverSubmission(submissionPayload(answers, fingerprintObject, activity, isAutoSubmit), isAutoSubmit);
}

// What is sent: the answers by position with the questions' ids, and the submit key, which
// sends them also once the sign-in has ended (exam_submit).
function submissionPayload(answers, fingerprint, activity, isAutoSubmit, details = examDetails) {
    return { answers, fingerprint, activity, auto_submitted: isAutoSubmit, device: examStore.deviceId(),
        question_ids: questionIds(details), submit_key: details.SubmitKey || null, exam_id: details.ExamId,
        collected_at: new Date().toISOString() };
}

// Sends a submission, and the result screen says how it went (scripts.js): in (a big green check;
// an earlier try that got through counts), or not. No connection (or no answer within the
// store's time limit): its answers wait in the outbox, which sends them once the connection is
// back. Refused by the server: the exam stops here, its answers kept on this computer and in the
// backup file, an alarm sounds and the student is told to call the lecturer, who can press Try
// again.
async function deliverSubmission(submission, isAutoSubmit) {
    const details = examDetails;
    if (!details) return;
    const endsAt = examEndTime;
    try {
        await sendSubmission(submission);
    } catch (error) {
        if (examDetails !== details) return;
        if (/already submitted/i.test(error.message)) return submissionDone(details, isAutoSubmit);
        if (error.offline) {
            queueSubmission(details, submission, endsAt);
            const queued = { ...details, TimeUp: isAutoSubmit };
            finishExamSession();
            return onSubmissionQueued(queued); // scripts.js
        }
        console.error('Error sending the submission:', error);
        const failed = { ...details, TimeUp: isAutoSubmit };
        pauseExamSession();
        return onSubmissionFailed(failed, submission, error.message, endsAt); // scripts.js
    }
    if (examDetails === details) submissionDone(details, isAutoSubmit);
}

function submissionDone(details, timeUp = false) {
    const submitted = { ...details, TimeUp: timeUp };
    finishExamSession();
    onExamSubmitted(submitted);
}


// === The outbox: answers waiting for the connection ===
// A submission that could not reach the server is kept on this computer with the attempt's
// submit key, and sent as soon as the connection is back: from this page, or from Syllatest
// opened again on this computer later, signed in or not, until a day after the exam's end
// (the server takes it until then, marked late, with when the device was last online).
const OUTBOX_KEY = 'examOutbox';
const OUTBOX_KEEP_MS = 24 * 3600 * 1000;

function readOutbox() {
    try { const list = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
}
function writeOutbox(list) {
    try { list.length ? localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)) : localStorage.removeItem(OUTBOX_KEY); } catch { }
}
function queueSubmission(details, submission, endsAt = examEndTime) {
    writeOutbox([...readOutbox().filter(e => e.examId !== details.ExamId), { examId: details.ExamId, kind: details.Kind,
        token: details.Token || null, name: details.Name, code: details.Code, examCode: details.ExamCode || null,
        endsAt: endsAt || examStore.now(), queuedAt: Date.now(), submission }]);
}
const dropFromOutbox = examId => writeOutbox(readOutbox().filter(e => e.examId !== examId));

let outboxBusy = false;
async function flushOutbox() {
    if (outboxBusy) return;
    const list = readOutbox();
    if (!list.length) return;
    outboxBusy = true;
    try {
        for (const entry of list) {
            if (examStore.now() > entry.endsAt + OUTBOX_KEEP_MS) {
                dropFromOutbox(entry.examId);
                outboxSettled(entry, 'failed', 'The exam closed a day after its end');
                continue;
            }
            try {
                if (entry.kind === 'anonymous') await examStore.anonymousSubmit(entry.token, entry.submission);
                else await examStore.submitExam(entry.examId, entry.submission);
                dropFromOutbox(entry.examId);
                outboxSettled(entry, 'sent');
            } catch (error) {
                if (error.offline) break; // still no connection: the next try
                dropFromOutbox(entry.examId);
                outboxSettled(entry, /already submitted/i.test(error.message) ? 'sent' : 'failed', error.message);
            }
        }
    } finally {
        outboxBusy = false;
    }
}

// Now, every 15 seconds while something waits, and as soon as the connection is back.
function startOutbox() {
    flushOutbox();
    setInterval(() => { if (readOutbox().length) flushOutbox(); }, 15000);
    window.addEventListener('online', flushOutbox);
}

// A saved exam found past its end (a reboot, a closed page, a long loss of connection): its
// answers are sent as they were, as the deadline sends them, without opening it again; this
// needs no sign-in.
function queueSavedExam(saved) {
    const d = saved.examDetails;
    const questions = Object.keys(d.OriginalOrderMap || {}).map(Number).sort((a, b) => a - b).map(i => d.OriginalOrderMap[i]);
    const answers = {};
    questions.forEach((q, i) => {
        const key = `ans-${i + 1}`;
        if (q?.type === 'text_only') { answers[key] = '[TEXT_ONLY_NO_ANSWER_REQUIRED]'; return; }
        const value = saved.currentAnswers?.[key];
        // Starting text or code left as it was is no answer.
        const untouched = typeof value === 'string' && (q?.type === 'long_answer' || q?.type === 'code') && value.trim() === String(q.content || '').trim();
        answers[key] = value === undefined || untouched ? '' : value;
        if (q?.type === 'multiple_select' && saved.currentAnswers?.[`${key}_metadata`]?.other) {
            answers[`${key}_metadata`] = { other: true };
        } else if (q?.type === 'multiple_select' && Array.isArray(q.options) && q.options.includes(value)) {
            answers[`${key}_metadata`] = { originalIndex: String(q.options.indexOf(value)) };
        }
    });
    const activity = examIntegrity.activity(saved.integrity || {});
    queueSubmission(d, submissionPayload(answers, getFingerprintData(), activity, true, d), saved.examEndTime);
    clearSavedExam();
}

// Each question's answer by its original position, by Submit and at the deadline alike; a
// question without one goes empty.
function collectAnswers(isAutoSubmit) {
    const answers = {};
    const originalIndices = Object.keys(examDetails.OriginalOrderMap).map(Number).sort((a, b) => a - b);
    originalIndices.forEach(originalIndex => {
        const answerName = `ans-${originalIndex + 1}`;
        const questionData = examDetails.OriginalOrderMap[originalIndex];
        const questionDiv = document.getElementById(`q-${originalIndex + 1}`);
        if (questionData.type === 'text_only') {
            answers[answerName] = "[TEXT_ONLY_NO_ANSWER_REQUIRED]"; // Information only
            return;
        }
        if (!questionDiv || !questionHasAnyAnswer(questionDiv)) {
            answers[answerName] = '';
            return;
        }
        // The uploaded file: { upload, name, size }, which the lecturer downloads.
        if (questionData.type === 'attachment') {
            answers[answerName] = fileAnswers[answerName] || '';
            return;
        }
        // Fill in the blanks: what is in each blank, in order (some may be empty).
        if (questionData.type === 'fill_blanks') {
            answers[answerName] = getAnswerValue(answerName) || [];
            return;
        }
        const formElement = examForm.elements[answerName];
        if (!formElement) {
            console.warn(`Could not find form element for answer name: "${answerName}"`);
            answers[answerName] = 'ERROR_ELEMENT_NOT_FOUND';
            return;
        }
        switch (questionData.type) {
            case 'multiple_select': { // Radio buttons
                if (otherChosen(answerName)) { // the student's own answer, graded by hand
                    answers[answerName] = otherText(answerName).trim();
                    answers[`${answerName}_metadata`] = { other: true };
                    break;
                }
                answers[answerName] = formElement.value !== '' ? formElement.value : null;
                // The option's original position, for grading when options were shuffled
                const selected = examForm.querySelector(`input[name="${answerName}"]:checked`);
                if (selected?.dataset.originalIndex && questionData.shuffledOptionIndices) {
                    answers[`${answerName}_metadata`] = { originalIndex: selected.dataset.originalIndex };
                }
                break;
            }
            default: // short_answer, long_answer, code
                answers[answerName] = getAnswerValue(answerName) ?? '';
        }
    });
    return answers;
}

// Clears the exam in progress once it has been submitted (or abandoned).
function finishExamSession() {
    if (examDetails?.Kind !== 'preview') clearSavedExam();
    pauseExamSession();
}

// The exam stops on this page, but stays saved on this computer (a submission the server refused:
// a reload carries on with it, or sends it once it is over).
function pauseExamSession() {
    stopTimer();
    examIntegrity.stop();
    clearExamFiles();
    examDetails = null;
    examEndTime = null;
    totalQuestions = 0;
    codeEditors = {};
    hideTimer();
}


// Swaps the connection status icon. Replaced rather than reclassed: the Font Awesome kit
// renders each <i> as an <svg>, which ignores a later class change.
function setSyncIcon(iconClass, color) {
    const old = syncStatus?.querySelector('i, svg');
    if (!old) return;
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    icon.style.color = color;
    old.replaceWith(icon);
}

// Updates online status and related UI elements
let wasOffline = false, reachTimer = 0;
// navigator.onLine stays true on a network without internet (a hall's Wi-Fi that lost its
// line): a request that does not get through counts too (examStore.reachable).
function updateOnlineStatus() {
    isOnline = navigator.onLine && examStore.reachable();

    // Shown only while offline or sending (CSS): online and idle, there is nothing to say.
    syncStatus?.setAttribute('class', `sync-status ${isOnline ? 'online' : 'offline'}${isSyncing ? ' is-syncing' : ''}`);
    if (syncText) syncText.textContent = isOnline ? 'Online' : 'No connection';
    syncStatus?.setAttribute('title', isOnline ? 'Connected' : 'No connection: your answers are kept on this computer and sent once it is back');
    if (!isOnline && !isInitializing && !wasOffline) {
        showImprovedNotification('warning', 'No Connection', 'Keep going: your answers are kept on this computer and sent once the connection is back.', 6000);
    }
    wasOffline = !isOnline;
    // Not getting through on a network that is there: try again every 10 seconds until it does.
    clearTimeout(reachTimer);
    if (navigator.onLine && !examStore.reachable()) {
        reachTimer = setTimeout(async () => { if (!(await examStore.ping())) updateOnlineStatus(); }, 10000);
    }

    if (!isSyncing) { // Reset icon if not syncing
        setSyncIcon('fa-solid fa-circle', isOnline ? 'var(--success-color)' : 'var(--warning-color)');
    }

    // Let checkAllConfirmed handle the submit button state considering online status
    checkAllAnswered();

    // Only the first check (at page load) stays quiet about being offline
    isInitializing = false;
}

// Updates the sync status indicator UI
function setSyncing(syncing) {
    isSyncing = syncing;
    syncStatus?.classList.toggle('is-syncing', syncing);
    if (syncing) {
        setSyncIcon('fa-solid fa-spinner fa-spin', 'var(--info-color)');
        if (syncText) syncText.textContent = 'Syncing...';
    } else {
        // Revert to online/offline status display
        updateOnlineStatus(); // This will set the correct icon/text/color
    }
}


// === State Persistence ===
// The exam in progress, so a reload or an expired sign-in resumes it. autoSaveAnswers adds
// the answers to the same entry.
function saveExamState() {
    if (!examDetails || examDetails.Kind === 'preview') return;
    writeStored(appStateKey, { examDetails, examEndTime, integrity: examIntegrity.snapshot(), aliveAt: Date.now() });
    saveScroll();
}

// The page is still on this exam (every check-in): a saved exam whose page has been gone
// longer than EXAM_LEFT_MS needs its student to sign in again (scripts.js), so the next
// person at a shared computer never gets it.
const EXAM_LEFT_MS = 2 * 60 * 1000;
function markExamAlive() {
    if (!examDetails || examDetails.Kind === 'preview') return;
    const pos = readStored(POS_KEY);
    writeStored(POS_KEY, { examId: examDetails.ExamId, scrollY: pos?.examId === examDetails.ExamId ? pos.scrollY : Math.round(window.scrollY), aliveAt: Date.now() });
}
const examLeftAlone = state => Date.now() - (state.aliveAt || 0) > EXAM_LEFT_MS;

// Answers kept on the device are taken until a day after the end (exam_submit), so a saved
// exam is kept that long: after a reboot or a lost connection, its answers can still be sent.
const LATE_GRACE_MS = OUTBOX_KEEP_MS;

// The saved exam in progress, until it stops taking answers. Past its end, scripts.js sends
// it instead of opening it again (examEndTime <= now).
function readExamState() {
    try {
        const state = JSON.parse(localStorage.getItem(appStateKey) || 'null');
        if (state?.examDetails?.OriginalOrderMap && state.examEndTime + LATE_GRACE_MS > examStore.now()) {
            // The answers, and where the page was, kept apart (an older page kept them in the state).
            const id = state.examDetails.ExamId;
            const answers = readStored(ANSWERS_KEY), pos = readStored(POS_KEY);
            if (answers?.examId === id) Object.assign(state, { currentAnswers: answers.currentAnswers, confirmationStatus: answers.confirmationStatus, struck: answers.struck });
            if (pos?.examId === id) Object.assign(state, { scrollY: pos.scrollY, aliveAt: Math.max(state.aliveAt || 0, pos.aliveAt || 0) });
            return state;
        }
    } catch (e) {
        console.warn('Ignoring unreadable saved exam state.', e);
    }
    clearSavedExam();
    return null;
}

function clearSavedExam() {
    lastAnswersSaved = '';
    try { [appStateKey, ANSWERS_KEY, POS_KEY].forEach(key => localStorage.removeItem(key)); } catch { }
}

// Rebuilds the questions from a saved state, refills the answers and confirmations, restarts
// the timer, and goes back to where the student was on the page.
function restoreExam(state) {
    examDetails = state.examDetails;
    examEndTime = state.examEndTime;
    displayQuestions(examDetails.Questions);
    applyProgress(state.currentAnswers);
    applyStruck(state.struck);
    startTimer();
    checkAllAnswered();
    // Where the student was: now, and again once the images are in (they make the page taller),
    // unless the student has scrolled meanwhile.
    restoreScrollY = state.scrollY || null;
    if (restoreScrollY) requestAnimationFrame(() => window.scrollTo({ top: restoreScrollY }));
}

let restoreScrollY = null;
['wheel', 'touchmove', 'keydown', 'mousedown'].forEach(type =>
    window.addEventListener(type, () => { restoreScrollY = null; }, { passive: true }));


// === Changes while the exam runs ===
// The lecturer may change the questions or the time while students take the exam. Each
// check-in says the exam's end and which version of its questions is current, and a reload
// asks too (exam_current). The timer follows the end. Questions follow by id: one that
// changed loses its answer and its confirmation, new ones are added, removed ones go, and
// every other answer stays as it was.
function questionHash(q) {
    if (!q || typeof q !== 'object') return 0;
    const { type, prompt, options, images, unit, language, content, template, allowed, allowed_chars: chars } = q;
    return hashString(JSON.stringify([type, prompt || '', options || [], images || [], unit || '', language || '', content || '', template || '', allowed || '', chars || '']));
}

let catchingUp = false;
// info: a check-in's answer ({ ends_at, version }); without it, the server is asked.
async function catchUpWithServer(info = null) {
    const d = examDetails;
    if (!d || d.Kind === 'preview' || catchingUp) return;
    if (info?.ends_at) applyEndTime(Date.parse(info.ends_at));
    if (info && (!info.version || info.version === d.Version)) return;
    if (uploadsInProgress.size) return; // the next check-in, once the file is up
    catchingUp = true;
    let payload;
    try {
        payload = await examStore.current(d.ExamId, d.Kind === 'anonymous' ? d.Token : null);
    } catch (error) {
        return; // offline, or the server says no: the exam carries on as it is
    } finally {
        catchingUp = false;
    }
    if (examDetails !== d) return;
    if (payload.submit_key) d.SubmitKey = payload.submit_key;
    applyEndTime(Date.parse(payload.ends_at));
    if (payload.version && payload.version !== d.Version) applyNewQuestions(payload.questions || [], payload.version);
    saveExamState();
}

function applyEndTime(end) {
    if (!Number.isFinite(end) || !examEndTime || !examDetails || end === examEndTime) return;
    const later = end > examEndTime;
    examEndTime = end;
    saveExamState();
    if (examTimerInterval) updateTimerDisplay();
    const at = new Date(end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    showImprovedNotification('info', later ? 'More Time' : 'New End Time', `Your lecturer ${later ? 'extended the exam' : 'changed the exam\'s time'}: it now ends at ${at}.`, 0);
}

function applyNewQuestions(questions, version) {
    const d = examDetails;
    let old = [];
    try { old = JSON.parse(d.Questions || '[]'); } catch { }
    const { answers } = collectProgress();
    const struck = collectStruck();
    // Where each new question was: by its id, or (questions saved before ids) by its content.
    const oldIndexOf = q => {
        if (q?.id) { const i = old.findIndex(o => o?.id === q.id); if (i >= 0) return i; }
        const h = questionHash(q);
        return old.findIndex(o => !o?.id && questionHash(o) === h);
    };
    const nextAnswers = {}, nextStruck = {}, marks = {};
    const kept = new Set();
    let changed = 0, added = 0;
    questions.forEach((q, j) => {
        const i = oldIndexOf(q);
        if (i < 0) { added++; marks[j] = 'added'; return; }
        kept.add(i);
        if (questionHash(old[i]) !== questionHash(q)) { changed++; marks[j] = 'changed'; return; }
        if (answers[`ans-${i + 1}`] !== undefined) nextAnswers[`ans-${j + 1}`] = answers[`ans-${i + 1}`];
        if (answers[`ans-${i + 1}_metadata`] !== undefined) nextAnswers[`ans-${j + 1}_metadata`] = answers[`ans-${i + 1}_metadata`];
        if (struck[`ans-${i + 1}`]) nextStruck[`ans-${j + 1}`] = struck[`ans-${i + 1}`];
    });
    const removed = old.filter((o, i) => !kept.has(i)).length;
    const scrollY = window.scrollY;
    d.Questions = JSON.stringify(questions);
    d.Version = version;
    displayQuestions(d.Questions);
    applyProgress(nextAnswers);
    applyStruck(nextStruck);
    for (const [j, kind] of Object.entries(marks)) {
        const card = document.getElementById(`q-${Number(j) + 1}`);
        if (!card || card.classList.contains('text-only-question')) continue;
        card.classList.add(`is-${kind}`);
        card.querySelector('.question-title')?.insertAdjacentHTML('beforeend',
            `<span class="question-flag">${kind === 'added' ? 'New question' : 'Changed: answer it again'}</span>`);
    }
    checkAllAnswered();
    saveExamState();
    autoSaveAnswers();
    loadExamImages();
    window.scrollTo({ top: scrollY });
    const parts = [changed && `${changed} question${changed === 1 ? '' : 's'} changed, so ${changed === 1 ? 'its answer was' : 'their answers were'} cleared`,
        added && `${added} added`, removed && `${removed} removed`].filter(Boolean);
    showImprovedNotification('warning', 'The Exam Was Updated',
        `Your lecturer updated the questions${parts.length ? `: ${parts.join(', ')}` : ''}. Your other answers are as they were.`, 0);
}

// Images that could not load without a connection, once it is back.
window.addEventListener('online', () => {
    if (examDetails && examQuestionsArea.querySelector('.question-image.is-failed, .question-image.is-loading')) loadExamImages();
});


// === Question images ===
// Fetched when the exam starts or resumes (exam_images), kept in memory as object URLs: never
// saved on the device, and no address that works anywhere else.
// The size the lecturer chose for the question's images: small, medium (the default), large or
// the full width; a click opens one at the size of the screen.
// Figures come at one size for their shape, the same on every question (CSS): a wide one (at
// least 1.6 times as wide as tall) across the question; any other in a column of the same width
// everywhere, with the answer beside it when it is one that fits there (so answers start at the
// same place on every such question); several side by side in frames of one height. A figure
// shared by several questions stays in sight beside them. Small ones grow, to twice their size
// at most. (Questions saved with a size, S M L or full width, before Nov 2026: the same.)
const WIDE_FIGURE = 1.6;
function shapeFigures(holder) {
    const images = [...(holder?.querySelectorAll('img') || [])];
    if (!images.length || images.some(img => !img.naturalWidth)) return;
    images.forEach(img => { img.style.maxWidth = `${img.naturalWidth * 2}px`; });
    const layout = images.length > 1 ? 'row' : images[0].naturalWidth / images[0].naturalHeight >= WIDE_FIGURE ? 'wide' : 'side';
    holder.dataset.layout = layout;
    const box = holder.closest('.question-answer, .question-group.is-figure, .question-body');
    if (box && box.dataset.figure !== layout) box.dataset.figure = layout;
}

function questionImagesHtml(q) {
    const ids = (Array.isArray(q.images) ? q.images : []).filter(id => typeof id === 'string');
    if (!ids.length) return '';
    return `<div class="question-images">${ids.map((id, i) => `<button type="button" class="question-image is-loading" data-image-id="${escapeHtml(id)}" aria-label="Image ${i + 1}: open it larger">
        <span class="question-image-note"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Loading the image</span></button>`).join('')}</div>`;
}

// preloaded: a preview's images, from the course editor.
async function loadExamImages(preloaded = null) {
    const details = examDetails;
    if (!details || !examQuestionsArea.querySelector('.question-image')) return;
    let images = preloaded;
    // Every image already here (the questions were updated, say): nothing to download again.
    const needed = [...new Set([...examQuestionsArea.querySelectorAll('.question-image[data-image-id]')].map(el => el.dataset.imageId))];
    if (!images && needed.every(id => examImageUrls[id])) images = {};
    if (!images) {
        try {
            images = await examStore.images(details.ExamId, details.Kind === 'anonymous' ? details.Token : null);
        } catch (error) {
            console.warn('Could not load the question images.', error);
            images = {};
        }
    }
    if (examDetails !== details) return;
    for (const [id, dataUrl] of Object.entries(images || {})) {
        if (!examImageUrls[id]) {
            try { examImageUrls[id] = URL.createObjectURL(await (await fetch(dataUrl)).blob()); } catch { }
        }
    }
    examQuestionsArea.querySelectorAll('.question-image').forEach(btn => {
        const url = examImageUrls[btn.dataset.imageId];
        btn.classList.remove('is-loading');
        btn.classList.toggle('is-failed', !url);
        btn.innerHTML = url ? `<img src="${url}" alt="" draggable="false">`
            : '<span class="question-image-note"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i>The image did not load: try again</span>';
        const img = btn.querySelector('img'), holder = btn.closest('.question-images');
        if (img && holder) {
            if (img.complete) shapeFigures(holder);
            else img.addEventListener('load', () => shapeFigures(holder), { once: true });
        }
    });
    if (restoreScrollY) {
        const top = restoreScrollY;
        const images = [...examQuestionsArea.querySelectorAll('.question-image img')];
        await Promise.all(images.map(img => (img.complete ? null : new Promise(done => { img.onload = img.onerror = done; }))));
        if (restoreScrollY === top) window.scrollTo({ top });
        restoreScrollY = null;
    }
}

examQuestionsArea.addEventListener('click', e => {
    // A file question's button opens its (hidden) file input.
    const choose = e.target.closest('.file-answer-choose');
    if (choose) { document.getElementById(choose.dataset.fileInput)?.click(); return; }
    const btn = e.target.closest('.question-image');
    if (!btn) return;
    if (btn.classList.contains('choice-image') && !btn.classList.contains('is-failed')) return;
    if (btn.classList.contains('is-failed')) {
        e.preventDefault();
        btn.classList.replace('is-failed', 'is-loading');
        btn.innerHTML = '<span class="question-image-note"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Loading the image</span>';
        loadExamImages();
        return;
    }
    const url = examImageUrls[btn.dataset.imageId];
    if (url) openImageViewer(url);
});

// An image at the size of the screen; a click, Escape or Back closes it.
function openImageViewer(url) {
    let viewer = document.getElementById('image-viewer');
    if (!viewer) {
        viewer = document.createElement('div');
        viewer.id = 'image-viewer';
        viewer.className = 'image-viewer';
        viewer.setAttribute('role', 'dialog');
        viewer.setAttribute('aria-modal', 'true');
        viewer.setAttribute('aria-label', 'Image');
        viewer.innerHTML = `<img alt="" draggable="false">
            <button type="button" class="image-viewer-close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
        viewer.addEventListener('click', closeImageViewer);
        document.body.appendChild(viewer);
    }
    viewer.querySelector('img').src = url;
    viewer.classList.add('open');
    viewer.querySelector('.image-viewer-close').focus({ preventScroll: true });
}

function closeImageViewer() {
    document.getElementById('image-viewer')?.classList.remove('open');
}
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('image-viewer')?.classList.contains('open')) closeImageViewer();
});


// === File answers ===
// Uploaded as soon as they are chosen (examStore.startUpload, then uploadFile), so a closed
// page or the deadline loses nothing; another file can replace it until the question is
// confirmed. A preview checks the file but uploads nothing.
const maxFileMb = q => Math.min(50, Number(q?.max_size_mb) > 0 ? Number(q.max_size_mb) : 50);
const fileAnswerBox = answerName => examQuestionsArea.querySelector(`.file-answer[data-answer="${answerName}"]`);

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

function fileProblem(file, q) {
    const types = (Array.isArray(q?.allowed_types) ? q.allowed_types : []).map(t => String(t).toLowerCase());
    const extension = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (types.length && !types.includes(extension)) return `This question takes only ${q.allowed_types.join(', ')} files.`;
    if (!file.size) return 'This file is empty.';
    if (file.size > maxFileMb(q) * 1048576) return `This file is too large: at most ${maxFileMb(q)} MB.`;
    return '';
}

// The box's state: uploading (progress 0 to 1), a problem, or the file now answering it.
function renderFileAnswer(box, { progress = null, problem = '' } = {}) {
    const answer = fileAnswers[box.dataset.answer];
    const status = box.querySelector('.file-answer-status');
    box.querySelector('.file-answer-choose span').textContent = answer ? 'Choose another file' : 'Choose file';
    box.classList.toggle('is-uploading', progress != null);
    let html = '';
    if (progress != null) {
        const percent = Math.round(progress * 100);
        html = `<span class="file-answer-line"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Uploading ${percent}%</span>
            <span class="file-answer-progress"><span style="width:${percent}%"></span></span>`;
    } else if (answer) {
        const preview = answer.upload === 'preview';
        html = `<span class="file-answer-line is-done"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><span>${preview ? 'Checked' : 'Uploaded'}: <strong>${escapeHtml(answer.name)}</strong> (${formatBytes(answer.size)})${preview ? '. In a preview, files are not uploaded.' : ''}</span>
            <button type="button" class="file-answer-remove" data-file-remove="${escapeHtml(box.dataset.answer)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Remove</span></button></span>`;
    }
    if (problem) {
        html += `<span class="file-answer-line is-problem"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${escapeHtml(problem)}${answer && progress == null ? ` Your answer is still ${escapeHtml(answer.name)}.` : ''}</span>`;
    }
    status.innerHTML = html;
    const question = box.closest('.question');
    if (question) refreshAnswered(question);
}

async function chooseFileAnswer(input) {
    const box = input.closest('.file-answer');
    const file = input.files[0];
    input.value = ''; // the same file can be chosen again after a failed upload
    if (!file || !examDetails || !box) return;
    const answerName = box.dataset.answer, question = Number(box.dataset.question);
    const details = examDetails;
    const problem = fileProblem(file, details.OriginalOrderMap?.[question - 1]);
    if (problem) return renderFileAnswer(box, { problem });
    if (details.Kind === 'preview') {
        fileAnswers[answerName] = { upload: 'preview', name: file.name, size: file.size };
        return renderFileAnswer(box);
    }
    uploadsInProgress.add(answerName);
    renderFileAnswer(box, { progress: 0 });
    try {
        const target = await examStore.startUpload(details.ExamId, details.Kind === 'anonymous' ? details.Token : null, question, file);
        await examStore.uploadFile(target, file, p => { if (examDetails === details) renderFileAnswer(box, { progress: p }); });
        if (examDetails !== details) return;
        fileAnswers[answerName] = { upload: target.id, name: file.name, size: file.size };
        renderFileAnswer(box);
        uploadsInProgress.delete(answerName);
        autoSaveAnswers(); // the file is the answer
        if (typeof heartbeatSoon === 'function') heartbeatSoon();
    } catch (error) {
        if (examDetails === details) renderFileAnswer(box, { problem: `Not uploaded: ${error.message}.` });
    } finally {
        uploadsInProgress.delete(answerName);
    }
}

examQuestionsArea.addEventListener('change', e => {
    if (e.target.matches?.('.file-answer-input')) chooseFileAnswer(e.target);
});

// Remove: the question has no file again (the file stays with the uploads, where the lecturer
// sees it as not given as the answer).
examQuestionsArea.addEventListener('click', e => {
    const button = e.target.closest?.('[data-file-remove]');
    if (!button || button.disabled) return;
    const box = button.closest('.file-answer');
    delete fileAnswers[button.dataset.fileRemove];
    renderFileAnswer(box);
    autoSaveAnswers();
    if (typeof heartbeatSoon === 'function') heartbeatSoon();
    box.querySelector('.file-answer-choose')?.focus();
});

// Once the exam is over: its files' state and its images.
function clearExamFiles() {
    fileAnswers = {};
    uploadsInProgress.clear();
    Object.values(examImageUrls).forEach(url => URL.revokeObjectURL(url));
    examImageUrls = {};
    closeImageViewer();
}
