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
    window.addEventListener('pagehide', autoSaveAnswers);
    // Where the student is on the page, so a reload comes back there
    window.addEventListener('scroll', () => { if (examDetails) saveAnswersSoon(); }, { passive: true });
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

function initializeCodeEditor(textareaId, language = 'python') {
    const textarea = document.getElementById(textareaId);
    if (!textarea) {
        console.warn(`Cannot initialize code editor: textarea #${textareaId} not found`);
        return null;
    }

    if (typeof CodeMirror === 'undefined') {
        console.warn('CodeMirror library not loaded. Using regular textarea.');
        return null;
    }


    try {
        // Initialize CodeMirror directly on the textarea (replacing it)
        const editor = CodeMirror.fromTextArea(textarea, {
            mode: language || "python",
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
        editor.on('change', saveAnswersSoon);

        // Store the editor instance
        codeEditors[textareaId] = editor;

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

// The answers so far, and which questions are confirmed, by their original position.
function collectProgress() {
    const answers = {}, confirmations = {};
    for (const index of Object.keys(examDetails.OriginalOrderMap).map(Number).sort((a, b) => a - b)) {
        const n = index + 1;
        const div = document.getElementById(`q-${n}`);
        if (div) confirmations[`q-${n}`] = div.classList.contains('confirmed');
        const q = examDetails.OriginalOrderMap[index];
        if (!q || q.type === 'text_only') continue;
        const value = getAnswerValue(`ans-${n}`);
        if (value !== undefined) answers[`ans-${n}`] = value;
    }
    return { answers, confirmations };
}

// Puts saved answers and confirmations back into the questions on screen.
function applyProgress(answers = {}, confirmations = {}) {
    for (const answerName in answers) {
        if (answers[answerName] !== 'FILE_SELECTED') setAnswerValue(answerName, answers[answerName]);
    }
    for (const questionId in confirmations) {
        if (confirmations[questionId]) confirmAnswer(questionId);
    }
}

// What another computer carries on from, if this one breaks down (the heartbeat's draft).
function examDraft() {
    if (!examDetails || examDetails.Kind === 'preview' || !examDetails.OriginalOrderMap) return null;
    return { ...collectProgress(), integrity: examIntegrity.snapshot(), question_ids: questionIds() };
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
            const m = key.match(new RegExp(`^${prefix}-(\\d+)$`));
            const id = m && from ? from[Number(m[1]) - 1] : '';
            const at = id ? questions.findIndex(q => q?.id === id) : -1;
            if (!m || !id) out[key] = value;
            else if (at >= 0) out[`${prefix}-${at + 1}`] = value;
        }
        return out;
    };
    return { answers: move(progress?.answers, 'ans'), confirmations: move(progress?.confirmations, 'q') };
}

// Automatically save current answers to localStorage, with where the student was on the page
function autoSaveAnswers() {
    // Only auto-save if exam is in progress
    if (!examQuestionsModule || examQuestionsModule.classList.contains('hidden') || !examDetails || examDetails.Kind === 'preview') {
        return;
    }

    try {
        const { answers, confirmations } = collectProgress();
        const currentState = JSON.parse(localStorage.getItem(appStateKey) || '{}');
        currentState.currentAnswers = answers;
        currentState.confirmationStatus = confirmations;
        currentState.scrollY = Math.round(window.scrollY);
        currentState.aliveAt = Date.now();
        localStorage.setItem(appStateKey, JSON.stringify(currentState));
    } catch (e) {
        console.error("Error auto-saving answers:", e);
    }
}


function createStickyTimer() {
    // Remove any existing sticky timer first
    const existingTimer = document.querySelector('.sticky-timer');
    if (existingTimer) existingTimer.remove();

    // Create new sticky timer
    const stickyTimer = document.createElement('div');
    stickyTimer.setAttribute('class', 'sticky-timer');
    stickyTimer.innerHTML = `<i class="fa-solid fa-stopwatch"></i> <span id="sticky-timer-display">--:--</span>
        <button type="button" class="sticky-progress" id="sticky-progress" onclick="goToNextUnconfirmed()"></button>`;
    document.body.appendChild(stickyTimer);
    checkAllConfirmed(); // its count of confirmed answers

    return stickyTimer;
}

// The count of confirmed answers in the timer is a way through them: the next question still
// to confirm below the one at the top of the screen (round to the first), then Submit.
function goToNextUnconfirmed() {
    const open = [...examQuestionsArea.querySelectorAll('.question:not(.text-only-question):not(.confirmed)')];
    if (!open.length) {
        document.querySelector('.exam-finish')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    const next = open.find(q => q.getBoundingClientRect().top > 140) || open[0];
    next.scrollIntoView({ behavior: 'smooth', block: 'start' });
    next.querySelector('input.form-control:not([type="file"]):not(:disabled), textarea.form-control:not(.code-editor):not(:disabled), .form-control-checkbox:checked')
        ?.focus({ preventScroll: true });
}

// Enter in a one-line answer confirms it. The form itself is never submitted: with a single
// text field, Enter would otherwise send it and reload the page.
examForm?.addEventListener('submit', e => e.preventDefault());
examForm?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.matches('input.form-control:not([type="file"])')) return;
    e.preventDefault();
    const question = e.target.closest('.question');
    if (question && !question.classList.contains('confirmed')) confirmAnswer(question.id);
});

function getConfirmationCounts() {
    const required = examQuestionsArea.querySelectorAll('.question:not(.text-only-question)').length;
    const confirmed = examQuestionsArea.querySelectorAll('.question.confirmed:not(.text-only-question)').length;
    return { required, confirmed, allConfirmed: confirmed === required };
}

// Checks if all questions are confirmed and updates the main submit button
function checkAllConfirmed() {
    // Only proceed if the questions area is visible and we know the total count
    const status = document.getElementById('exam-finish-status');
    if (!examQuestionsArea || examQuestionsModule.classList.contains('hidden') || totalQuestions <= 0) {
        if (submitExamBtn) {
            submitExamBtn.disabled = true;
            submitExamBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit exam';
        }
        return;
    }

    const { required, confirmed, allConfirmed } = getConfirmationCounts();
    const progress = document.getElementById('sticky-progress');
    if (progress) {
        // On phones the word goes, so the timer fits the top bar.
        progress.innerHTML = `${confirmed}/${required}<span class="sticky-progress-word"> confirmed</span>`;
        progress.title = allConfirmed ? 'Go to Submit' : 'Go to the next question to confirm';
    }
    document.querySelector('.exam-finish')?.classList.toggle('is-ready', allConfirmed && isOnline);

    if (submitExamBtn) {
        // Enable button only if all questions are confirmed AND user is online
        submitExamBtn.disabled = !allConfirmed || !isOnline;
        submitExamBtn.innerHTML = isOnline ? '<i class="fa-solid fa-paper-plane"></i> Submit exam' : '<i class="fa-solid fa-wifi"></i> Offline';
    }
    if (status) {
        status.textContent = !isOnline ? 'You are offline: your answers are saved on this computer. Submit once the connection is back.'
            : allConfirmed ? 'Every answer is confirmed. Submit when you are ready: it cannot be undone.'
            : `${confirmed} of ${required} answers confirmed. Confirm each one (you can still edit it), then submit.`;
    }
}


// What each kind of question asks for, under its title.
const QUESTION_KINDS = { multiple_select: 'Choose one', true_false: 'True or false', short_answer: 'Short answer', numeric: 'A number',
    long_answer: 'Written answer', code: 'Code', attachment: 'File upload' };

function displayQuestions(questionsJsonString) {
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
        const byId = questionsArray.every(q => q && typeof q === 'object' && q.id);

        // Create a shuffled order of question indices
        const originalIndices = Array.from(questionsArray.keys());
        const displayIndices = skipShuffle
            ? originalIndices
            : byId ? originalIndices.slice().sort((a, b) => hashString(`${seed}:${questionsArray[a].id}`) - hashString(`${seed}:${questionsArray[b].id}`))
            : seededShuffle(originalIndices.slice(), seed);

        // Create mapping of questions for later
        examDetails.OriginalOrderMap = {};
        questionsArray.forEach((q, index) => {
            examDetails.OriginalOrderMap[index] = q;
        });

        // Display questions in the shuffled order. Text-only items aren't numbered.
        let questionNumber = 0;
        displayIndices.forEach((originalIndex, displayIndex) => {
            const q = questionsArray[originalIndex];
            const originalQNum = originalIndex + 1;
            const questionId = `q-${originalQNum}`;
            const answerId = `ans-${originalQNum}`;
            const answerName = `ans-${originalQNum}`;

            const questionDiv = document.createElement('div');
            questionDiv.setAttribute('class', 'question');

            // For text_only type, set a special class
            if (q.type === 'text_only') {
                questionDiv.classList.add('text-only-question');
            }

            questionDiv.id = questionId;
            questionDiv.dataset.originalIndex = originalIndex;
            questionDiv.dataset.displayIndex = displayIndex;

            // --- Process Prompt Text: bold, italic, lists… (js/format-text.js) ---
            const promptText = formatQuestionText(q.prompt || '');

            // Create the question title/label
            const isTextOnly = q.type === 'text_only';
            const questionTitle = isTextOnly ? 'Information' : `Question ${++questionNumber}`;
            const titleIcon = isTextOnly ? 'fa-circle-info' : 'fa-circle-question';
            let pointsDisplay = '';

            if (q.points && q.type !== 'text_only') {
                pointsDisplay = `<span class="question-points">${escapeHtml(String(q.points))} ${q.points == 1 ? 'point' : 'points'}</span>`;
            }

            // The text, then its images (filled in by loadExamImages)
            const promptBlock = `${q.prompt ? `<div class="question-prompt">${promptText}</div>` : ''}${questionImagesHtml(q)}`;
            // --- End Process Prompt Text ---

            let questionContentHtml = '';

            // Generate input HTML based on question type
            switch (q.type) {
                case 'text_only':
                    // Information only, no input
                    questionContentHtml += promptBlock;
                    break;

                case 'short_answer':
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<input type="text" id="${answerId}" name="${answerName}" class="form-control" placeholder="Enter your answer">`;
                    break;

                case 'numeric': // One number, with the unit beside it when there is one
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<div class="numeric-answer"><input type="text" inputmode="decimal" id="${answerId}" name="${answerName}" class="form-control" placeholder="Enter a number" autocomplete="off">${q.unit ? `<span class="numeric-unit">${escapeHtml(q.unit)}</span>` : ''}</div>`;
                    break;

                case 'long_answer':
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<textarea id="${answerId}" name="${answerName}" class="form-control" rows="5" placeholder="Enter your detailed answer">${escapeHtml(q.content || '')}</textarea>`;
                    break;

                case 'code':
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<textarea id="${answerId}" name="${answerName}" class="form-control code-editor" rows="8" placeholder="Enter your code">${escapeHtml(q.content || '')}</textarea>`;
                    break;

                case 'attachment': { // Uploaded as soon as it is chosen (chooseFileAnswer)
                    const types = (Array.isArray(q.allowed_types) ? q.allowed_types : []).filter(Boolean);
                    const rules = `${types.length ? types.join(', ') : 'Any file'}, up to ${maxFileMb(q)} MB`;
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<div class="file-answer" data-answer="${answerName}" data-question="${originalQNum}">
                        <input type="file" id="${answerId}" class="form-control file-answer-input" hidden${types.length ? ` accept="${escapeHtml(types.join(','))}"` : ''}>
                        <button type="button" class="btn-sm btn-secondary file-answer-choose" data-file-input="${answerId}"><i class="fa-solid fa-upload" aria-hidden="true"></i><span>Choose file</span></button>
                        <span class="file-answer-rules">${escapeHtml(rules)}</span>
                        <div class="file-answer-status" aria-live="polite"></div>
                    </div>`;
                    break;
                }

                case 'multiple_select':
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<div class="checkbox-group" id="${answerId}">`;

                    if (Array.isArray(q.options) && q.options.length > 0) {
                        // Store original options
                        q.originalOptions = [...q.options];

                        // Shuffle options for students (with unique seed for this question)
                        const optionIndices = [...Array(q.options.length).keys()];
                        const shuffledOptionIndices = skipShuffle ?
                            [...optionIndices] :
                            seededShuffle(optionIndices, seed + (q.id ? hashString(String(q.id)) : originalIndex));

                        // Store shuffle mapping
                        q.shuffledOptionIndices = shuffledOptionIndices;

                        // Render options in shuffled order
                        shuffledOptionIndices.forEach((originalOptIndex, displayOptIndex) => {
                            const option = q.options[originalOptIndex];
                            const optionId = `${answerId}-opt${originalOptIndex}`;
                            const escapedOption = escapeHtml(option);

                            // The whole card is the label, so a click anywhere on it picks the option
                            questionContentHtml += `<label class="checkbox-item" for="${optionId}">
                        <input type="radio" id="${optionId}" name="${answerName}"
                            value="${escapedOption}" class="form-control-checkbox"
                            data-original-index="${originalOptIndex}">
                        <span class="choice-text">${formatQuestionText.inline(option)}</span>
                    </label>`;
                        });
                    } else {
                        questionContentHtml += `<p class="exam-error">Error: Options missing or empty.</p>`;
                    }
                    questionContentHtml += `</div>`;
                    break;

                case 'true_false': // Two choices, always in this order
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<div class="checkbox-group tf-group" id="${answerId}">${['True', 'False'].map(value => `
                        <label class="checkbox-item" for="${answerId}-${value.toLowerCase()}">
                            <input type="radio" id="${answerId}-${value.toLowerCase()}" name="${answerName}" value="${value}" class="form-control-checkbox">
                            <span class="choice-text">${value}</span>
                        </label>`).join('')}</div>`;
                    break;

                default:
                    questionContentHtml += promptBlock;
                    questionContentHtml += `<p>${escapeHtml(q.content || '')}</p>`;
                    break;
            }

            // Add confirm/edit actions - not for text_only type
            let actionsHtml = '';
            if (q.type !== 'text_only') {
                actionsHtml = `
            <div class="question-actions">
                <span class="question-recap"></span>
                <button type="button" class="btn-confirm btn-green btn-sm" onclick="confirmAnswer('${questionId}')">
                    <i class="fa-solid fa-check"></i> Confirm
                </button>
                <button type="button" class="btn-edit btn-secondary btn-sm" onclick="editAnswer('${questionId}')">
                    <i class="fa-solid fa-pen"></i> Edit
                </button>
            </div>
        `;
            }

            // A card: number, title and kind, points; then a body that folds to a one-line
            // recap of the answer once it is confirmed
            questionDiv.innerHTML = `
        <div class="question-header">
            <span class="question-number" aria-hidden="true">${isTextOnly ? `<i class="fa-solid ${titleIcon}"></i>` : questionNumber}</span>
            <div class="question-title">
                <span class="question-label">${questionTitle}</span>
                ${isTextOnly ? '' : `<span class="question-kind">${QUESTION_KINDS[q.type] || ''}</span>`}
            </div>
            ${pointsDisplay}
            <span class="question-state"><i class="fa-solid fa-check" aria-hidden="true"></i>Confirmed</span>
        </div>
        <div class="question-body">
            ${questionContentHtml}
            ${actionsHtml}
        </div>
    `;

            examQuestionsArea.appendChild(questionDiv);

            if (q.type === 'code') {
                initializeCodeEditor(answerId, q.language || 'python');
            }
        });

        // Above them: how many, and the points
        const counted = questionsArray.filter(q => q.type !== 'text_only');
        const points = counted.reduce((sum, q) => sum + (Number(q.points) || 0), 0);
        const count = document.getElementById('exam-questions-count');
        if (count) count.textContent = `${counted.length} question${counted.length === 1 ? '' : 's'}${points ? `, ${points} point${points === 1 ? '' : 's'}` : ''}`;
    } catch (e) {
        console.error("Error displaying questions:", e);
        examQuestionsArea.innerHTML = '<p>Error loading questions.</p>';
    }

    checkAllConfirmed();
}

// Reads a question's current answer. Code answers live in their CodeMirror editor, not the
// textarea; a file question's answer is the file already uploaded.
function getAnswerValue(answerName) {
    if (codeEditors[answerName]) return codeEditors[answerName].getValue();
    if (fileAnswerBox(answerName)) return fileAnswers[answerName] || '';
    const formElement = examForm.elements[answerName];
    if (!formElement) return undefined;
    if (formElement.type === 'file') {
        return (formElement.files && formElement.files.length > 0) ? 'FILE_SELECTED' : '';
    }
    return formElement.value || ''; // Radio groups (RadioNodeList) return the checked value
}

// Writes a saved answer back into its question (a file question's: the file it uploaded)
function setAnswerValue(answerName, value) {
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
    const formElement = examForm.elements[answerName];
    if (!formElement || formElement.type === 'file') return;
    formElement.value = value || '';
}

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


function confirmAnswer(questionId) {
    try {
        // First check if the question element exists
        const questionDiv = document.getElementById(questionId);
        if (!questionDiv) {
            console.warn(`Question element not found: ${questionId}`);
            return false;
        }

        // Already confirmed, or a text-only item (those never need confirming)
        if (questionDiv.classList.contains('confirmed') || questionDiv.classList.contains('text-only-question')) {
            return true;
        }
        if (uploadsInProgress.has(questionId.replace('q-', 'ans-'))) {
            showImprovedNotification('warning', 'Still Uploading', 'Confirm once the file has uploaded.', 4000);
            return false;
        }

        // Add confirmed class - this will automatically collapse via CSS, to the answer's recap
        const recap = questionDiv.querySelector('.question-recap');
        if (recap) recap.textContent = answerRecap(questionId);
        questionDiv.classList.add('confirmed');

        // Disable all inputs
        const inputs = questionDiv.querySelectorAll('.form-control, .form-control-checkbox, .file-answer-choose');
        inputs.forEach(input => {
            if (input) input.disabled = true;
        });

        // Handle CodeMirror editor if present
        const cmTextarea = questionDiv.querySelector('.code-editor');
        if (cmTextarea && cmTextarea.id && typeof codeEditors === 'object' && codeEditors[cmTextarea.id]) {
            codeEditors[cmTextarea.id].setOption('readOnly', true);

            const cmElement = codeEditors[cmTextarea.id].getWrapperElement();
            if (cmElement) {
                cmElement.classList.add('cm-confirmed');
            }
        }

        checkAllConfirmed();
        autoSaveAnswers();
        if (typeof heartbeatSoon === 'function') heartbeatSoon(); // the draft, for another computer

        return true;
    } catch (error) {
        console.error(`Error in confirmAnswer for ${questionId}:`, error);
        return false;
    }
}

// A confirmed answer in one line, shown on its folded card.
function answerRecap(questionId) {
    const n = Number(questionId.slice(2));
    const q = examDetails?.OriginalOrderMap?.[n - 1];
    if (!q) return '';
    const value = getAnswerValue(`ans-${n}`);
    if (q.type === 'attachment') return value?.name ? `File: ${value.name}` : 'No file';
    if (value == null || String(value).trim() === '') return 'No answer';
    if (q.type === 'code') {
        const count = String(value).trimEnd().split('\n').length;
        return `${count} line${count === 1 ? '' : 's'} of code`;
    }
    if (q.type === 'numeric') return `${value}${q.unit ? ` ${q.unit}` : ''}`;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
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
        <p><strong>Confirmed:</strong> ${backupData.confirmedCountOnSubmit || 'N/A'}</p>
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
    const wasFullyConfirmed = backupData.confirmedCountOnSubmit === backupData.totalQuestionsOnSubmit;

    for (const answerName in answers) {
        // Skip metadata entries (ans-N_metadata) and placeholder values
        if (!/^ans-\d+$/.test(answerName)) continue;
        const answerValue = answers[answerName];
        if (answerValue === '[NOT CONFIRMED]' || answerValue === '[TEXT_ONLY_NO_ANSWER_REQUIRED]') continue;

        const questionId = answerName.replace('ans-', 'q-');
        const questionDiv = document.getElementById(questionId);
        if (!questionDiv) continue;

        // A confirmed question is read-only, so unlock it before writing the value
        if (questionDiv.classList.contains('confirmed')) editAnswer(questionId);
        setAnswerValue(answerName, answerValue);
        if (wasFullyConfirmed) confirmAnswer(questionId);
    }

    checkAllConfirmed();
    autoSaveAnswers();
    return true;
}

function editAnswer(questionId) {
    try {
        // First check if the question element exists
        const questionDiv = document.getElementById(questionId);
        if (!questionDiv) {
            console.warn(`Question element not found: ${questionId}`);
            return false;
        }

        // Then check if it's confirmed
        if (!questionDiv.classList.contains('confirmed')) {
            return false;
        }

        // Remove confirmed class - this will automatically expand via CSS
        questionDiv.classList.remove('confirmed');

        // Re-enable all inputs
        const inputs = questionDiv.querySelectorAll('.form-control, .form-control-checkbox, .file-answer-choose');
        inputs.forEach(input => {
            if (input) input.disabled = false;
        });

        // Handle CodeMirror editor if present
        const cmTextarea = questionDiv.querySelector('.code-editor');
        if (cmTextarea && cmTextarea.id && typeof codeEditors === 'object' && codeEditors[cmTextarea.id]) {
            codeEditors[cmTextarea.id].setOption('readOnly', false);

            const cmElement = codeEditors[cmTextarea.id].getWrapperElement();
            if (cmElement) {
                cmElement.classList.remove('cm-confirmed');
            }
            // The editor was hidden while collapsed; re-measure it now that it's visible again
            codeEditors[cmTextarea.id].refresh();
        }

        checkAllConfirmed();
        autoSaveAnswers();

        return true;
    } catch (error) {
        console.error(`Error in editAnswer for ${questionId}:`, error);
        return false;
    }
}


// Starts the countdown timer
function startTimer() {
    if (examTimerInterval) {
        console.warn("Timer is already running.");
        return;
    }

    if (!examEndTime || isNaN(examEndTime) || examEndTime <= Date.now()) {
        console.error("Cannot start timer: Invalid or past exam end time.", examEndTime);
        if (examEndTime && examEndTime <= Date.now()) {
            showImprovedNotification('error', 'Deadline Passed', 'The time for this exam has already expired.', 0);
            handleSubmitExam(true);
        }
        return;
    }

    // Create sticky timer
    createStickyTimer();

    remindedAt = null;
    updateTimerDisplay(); // Initial display update
    examTimerInterval = setInterval(updateTimerDisplay, 1000);
}

// Updates the timer display every second
function updateTimerDisplay() {
    if (!examEndTime) {
        console.warn("Timer update called without a valid end time.");
        stopTimer();
        const stickyDisplay = document.getElementById('sticky-timer-display');
        if (stickyDisplay) stickyDisplay.textContent = "--:--";
        return;
    }

    const now = Date.now();
    const timeLeft = Math.max(0, examEndTime - now);
    const minutesLeft = Math.floor(timeLeft / (1000 * 60));
    const seconds = Math.floor((timeLeft / 1000) % 60);
    const timeString = `${String(minutesLeft).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    // Update the floating timer
    const stickyDisplay = document.getElementById('sticky-timer-display');
    if (stickyDisplay) stickyDisplay.textContent = timeString;

    // Update visual cues based on time remaining
    updateTimeVisualCues(minutesLeft, seconds, timeLeft);
    if (timeLeft > 0) remindUnconfirmed(timeLeft);

    // Check if time is up
    if (timeLeft <= 0) {
        stopTimer();
        showImprovedNotification('warning', "Time's Up!", 'The exam time has expired. Submitting automatically.', 0);
        handleSubmitExam(true);
    }
}

function updateTimeVisualCues(minutesLeft, seconds, timeLeft) {
    const stickyTimer = document.querySelector('.sticky-timer');

    if (timeLeft <= 0) {
        // Time's up
        document.body.classList.remove('time-warning', 'time-danger');
        document.body.classList.add('time-expired');
        if (stickyTimer) {
            stickyTimer.classList.remove('warning', 'danger');
            stickyTimer.classList.add('expired');
        }
    } else if (minutesLeft <= 5) {
        // Danger - 5 minutes or less
        document.body.classList.remove('time-warning');
        document.body.classList.add('time-danger');
        if (stickyTimer) {
            stickyTimer.classList.remove('warning');
            stickyTimer.classList.add('danger');
        }
    } else if (minutesLeft <= 10) {
        // Warning - 10 minutes or less
        document.body.classList.add('time-warning');
        document.body.classList.remove('time-danger');
        if (stickyTimer) {
            stickyTimer.classList.add('warning');
            stickyTimer.classList.remove('danger');
        }
    } else {
        // Normal time
        document.body.classList.remove('time-warning', 'time-danger');
        if (stickyTimer) {
            stickyTimer.classList.remove('warning', 'danger');
        }
    }
}

// At 5 minutes and at 1 minute left, once each: questions not confirmed yet are sent as "not
// confirmed" when time runs out, so say how many there are.
let remindedAt = null; // the last reminder's mark (5 or 1), for the exam on screen
function remindUnconfirmed(timeLeft) {
    const mark = [1, 5].find(m => timeLeft <= m * 60000);
    if (!mark || mark === remindedAt) return;
    remindedAt = mark;
    const { required, confirmed } = getConfirmationCounts();
    const open = required - confirmed;
    if (open <= 0) return;
    const minutes = Math.ceil(timeLeft / 60000);
    showImprovedNotification('warning', `${minutes} minute${minutes === 1 ? '' : 's'} left`,
        `${open} question${open === 1 ? ' is' : 's are'} not confirmed yet. Confirm ${open === 1 ? 'it' : 'them'}: only confirmed answers are sent when time runs out.`, 30000);
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
        URL.revokeObjectURL(url); // Release the object URL
        showImprovedNotification('info', 'Backup Saved', 'A JSON backup file of your submission has been downloaded.');
    } catch (e) {
        console.error("Error creating or triggering JSON backup download:", e);
        showImprovedNotification('error', 'Backup Error', 'Could not create the backup file. Please manually copy your answers if needed.');
    }
}




// Handles the final exam submission: a local backup file, then sendSubmission (scripts.js)
async function handleSubmitExam(isAutoSubmit = false) {
    const timeIsUp = examEndTime && Date.now() >= examEndTime;
    if (timeIsUp && !isAutoSubmit) {
        console.warn("Manual submit clicked after deadline. Treating as auto-submit.");
        showImprovedNotification('warning', 'Deadline Passed', 'Time expired. Submitting automatically.');
        isAutoSubmit = true;
    }
    // The deadline submits for the student: close a Submit confirmation they left open.
    if (isAutoSubmit) _resolveConfirm(false);

    // --- Mandatory Confirmation Check for MANUAL submit ---
    // The timer keeps running until the submission actually goes ahead, so the
    // automatic submit at the deadline still happens if this is refused or cancelled.
    if (!isAutoSubmit) {
        const { required, confirmed, allConfirmed } = getConfirmationCounts();
        if (uploadsInProgress.size) {
            showImprovedNotification('warning', 'Still Uploading', 'A file is still uploading. Submit once it is done.', 5000);
            return;
        }
        if (!allConfirmed) {
            showImprovedNotification('error', 'Not All Confirmed', `Please confirm all ${required} questions before submitting. You have confirmed ${confirmed}.`, 5000);
            checkAllConfirmed();
            return;
        }
        const submitConfirmed = await confirmDialog(
            'You have confirmed all answers. Submit your exam now?\nThis cannot be undone.',
            { title: 'Submit Exam', okLabel: 'Submit', okIcon: 'fa-paper-plane' });
        // examDetails is cleared once a submission (including the deadline's) has gone ahead.
        if (!submitConfirmed || !examDetails) {
            return;
        }
    }
    await submitNow(isAutoSubmit);
}

// Collects the submission, saves a backup file, and sends it. savedIntegrity: the leave record
// of an exam that isn't running here (sent after a reboot).
async function submitNow(isAutoSubmit, savedIntegrity = null) {
    const timeIsUp = examEndTime && Date.now() >= examEndTime;
    stopTimer();

    // Disable submit button and show submitting state (always)
    submitExamBtn.disabled = true;
    submitExamBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';

    if (!examDetails || !examDetails.OriginalOrderMap || totalQuestions <= 0) {
        showImprovedNotification('error', 'Submission Error', 'Cannot collect answers. Exam data or question count is invalid.', 0);
        checkAllConfirmed(); // Reset button state
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
    const confirmationCounts = getConfirmationCounts();
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
        confirmedCountOnSubmit: confirmationCounts.confirmed,
        totalQuestionsOnSubmit: confirmationCounts.required // Questions that needed confirming
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

// Sends a submission. Already in (an earlier try got through): done. No connection: the exam
// ends here and its answers wait in the outbox, which sends them once the connection is back.
async function deliverSubmission(submission, isAutoSubmit) {
    const details = examDetails;
    if (!details) return;
    try {
        await sendSubmission(submission);
    } catch (error) {
        if (examDetails !== details) return;
        if (/already submitted/i.test(error.message)) return submissionDone(details);
        if (error.offline) {
            queueSubmission(details, submission);
            const queued = { ...details };
            finishExamSession();
            return onSubmissionQueued(queued); // scripts.js
        }
        console.error('Error sending the submission:', error);
        showImprovedNotification('error', 'Submission Error', `Could not send submission: ${error.message}. A backup file was downloaded.`, 0);
        if (!isAutoSubmit) {
            checkAllConfirmed(); // Allow a retry
            if (examEndTime > Date.now()) startTimer();
        }
        return;
    }
    if (examDetails === details) submissionDone(details);
}

function submissionDone(details) {
    const submitted = { ...details };
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
        endsAt: endsAt || Date.now(), queuedAt: Date.now(), submission }]);
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
            if (Date.now() > entry.endsAt + OUTBOX_KEEP_MS) {
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
// answers are sent as they were, as the deadline sends them (only confirmed ones), without
// opening it again; this needs no sign-in.
function queueSavedExam(saved) {
    const d = saved.examDetails;
    const questions = Object.keys(d.OriginalOrderMap || {}).map(Number).sort((a, b) => a - b).map(i => d.OriginalOrderMap[i]);
    const answers = {};
    questions.forEach((q, i) => {
        const key = `ans-${i + 1}`;
        if (q?.type === 'text_only') { answers[key] = '[TEXT_ONLY_NO_ANSWER_REQUIRED]'; return; }
        if (!saved.confirmationStatus?.[`q-${i + 1}`]) { answers[key] = '[NOT CONFIRMED]'; return; }
        const value = saved.currentAnswers?.[key];
        answers[key] = value === undefined ? '' : value;
        if (q?.type === 'multiple_select' && Array.isArray(q.options) && q.options.includes(value)) {
            answers[`${key}_metadata`] = { originalIndex: String(q.options.indexOf(value)) };
        }
    });
    const activity = examIntegrity.activity(saved.integrity || {});
    queueSubmission(d, submissionPayload(answers, getFingerprintData(), activity, true, d), saved.examEndTime);
    clearSavedExam();
}

// Each question's answer by its original position. An automatic submit at the deadline
// sends only confirmed answers; a manual one has already checked they all are.
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
        if (isAutoSubmit && !questionDiv?.classList.contains('confirmed')) {
            answers[answerName] = "[NOT CONFIRMED]";
            return;
        }
        // The uploaded file: { upload, name, size }, which the lecturer downloads.
        if (questionData.type === 'attachment') {
            answers[answerName] = fileAnswers[answerName] || '';
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
    stopTimer();
    examIntegrity.stop();
    if (examDetails?.Kind !== 'preview') clearSavedExam();
    clearExamFiles();
    examDetails = null;
    examEndTime = null;
    totalQuestions = 0;
    codeEditors = {};
    document.querySelector('.sticky-timer')?.remove();
    document.body.classList.remove('time-warning', 'time-danger', 'time-expired');
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
function updateOnlineStatus() {
    isOnline = navigator.onLine;

    syncStatus?.setAttribute('class', `sync-status ${isOnline ? 'online' : 'offline'}`);
    if (syncText) syncText.textContent = isOnline ? 'Online' : 'Offline';
    if (!isOnline && !isInitializing) {
        showImprovedNotification('warning', 'Offline', 'You are currently offline. Features requiring connection may be limited.', 5000);
    }

    if (!isSyncing) { // Reset icon if not syncing
        setSyncIcon('fa-solid fa-circle', isOnline ? 'var(--success-color)' : 'var(--warning-color)');
    }

    // Let checkAllConfirmed handle the submit button state considering online status
    checkAllConfirmed();

    // Only the first check (at page load) stays quiet about being offline
    isInitializing = false;
}

// Updates the sync status indicator UI
function setSyncing(syncing) {
    isSyncing = syncing;
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
// the answers and confirmations to the same entry.
function saveExamState() {
    if (!examDetails || examDetails.Kind === 'preview') return;
    try {
        const state = JSON.parse(localStorage.getItem(appStateKey) || '{}') || {};
        Object.assign(state, { examDetails, examEndTime, integrity: examIntegrity.snapshot(), aliveAt: Date.now() });
        localStorage.setItem(appStateKey, JSON.stringify(state));
    } catch (e) {
        console.error("Error saving the exam state:", e);
    }
}

// The page is still on this exam (every check-in): a saved exam whose page has been gone
// longer than EXAM_LEFT_MS needs its student to sign in again (scripts.js), so the next
// person at a shared computer never gets it.
const EXAM_LEFT_MS = 2 * 60 * 1000;
function markExamAlive() {
    if (!examDetails || examDetails.Kind === 'preview') return;
    try {
        const state = JSON.parse(localStorage.getItem(appStateKey) || 'null');
        if (state?.examDetails?.ExamId !== examDetails.ExamId) return;
        state.aliveAt = Date.now();
        localStorage.setItem(appStateKey, JSON.stringify(state));
    } catch { }
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
        if (state?.examDetails?.OriginalOrderMap && state.examEndTime + LATE_GRACE_MS > Date.now()) return state;
    } catch (e) {
        console.warn('Ignoring unreadable saved exam state.', e);
    }
    clearSavedExam();
    return null;
}

function clearSavedExam() {
    try { localStorage.removeItem(appStateKey); } catch { }
}

// Rebuilds the questions from a saved state, refills the answers and confirmations, restarts
// the timer, and goes back to where the student was on the page.
function restoreExam(state) {
    examDetails = state.examDetails;
    examEndTime = state.examEndTime;
    displayQuestions(examDetails.Questions);
    applyProgress(state.currentAnswers, state.confirmationStatus);
    startTimer();
    checkAllConfirmed();
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
    const { type, prompt, options, images, unit, language, content } = q;
    return hashString(JSON.stringify([type, prompt || '', options || [], images || [], unit || '', language || '', content || '']));
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
    remindedAt = null;
    saveExamState();
    if (examTimerInterval) updateTimerDisplay();
    const at = new Date(end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    showImprovedNotification('info', later ? 'More Time' : 'New End Time', `Your lecturer ${later ? 'extended the exam' : 'changed the exam\'s time'}: it now ends at ${at}.`, 0);
}

function applyNewQuestions(questions, version) {
    const d = examDetails;
    let old = [];
    try { old = JSON.parse(d.Questions || '[]'); } catch { }
    const { answers, confirmations } = collectProgress();
    // Where each new question was: by its id, or (questions saved before ids) by its content.
    const oldIndexOf = q => {
        if (q?.id) { const i = old.findIndex(o => o?.id === q.id); if (i >= 0) return i; }
        const h = questionHash(q);
        return old.findIndex(o => !o?.id && questionHash(o) === h);
    };
    const nextAnswers = {}, nextConfirmations = {}, marks = {};
    const kept = new Set();
    let changed = 0, added = 0;
    questions.forEach((q, j) => {
        const i = oldIndexOf(q);
        if (i < 0) { added++; marks[j] = 'added'; return; }
        kept.add(i);
        if (questionHash(old[i]) !== questionHash(q)) { changed++; marks[j] = 'changed'; return; }
        if (answers[`ans-${i + 1}`] !== undefined) nextAnswers[`ans-${j + 1}`] = answers[`ans-${i + 1}`];
        if (confirmations[`q-${i + 1}`]) nextConfirmations[`q-${j + 1}`] = true;
    });
    const removed = old.filter((o, i) => !kept.has(i)).length;
    const scrollY = window.scrollY;
    d.Questions = JSON.stringify(questions);
    d.Version = version;
    displayQuestions(d.Questions);
    applyProgress(nextAnswers, nextConfirmations);
    for (const [j, kind] of Object.entries(marks)) {
        const card = document.getElementById(`q-${Number(j) + 1}`);
        if (!card || card.classList.contains('text-only-question')) continue;
        card.classList.add(`is-${kind}`);
        card.querySelector('.question-title')?.insertAdjacentHTML('beforeend',
            `<span class="question-flag">${kind === 'added' ? 'New question' : 'Changed: answer it again'}</span>`);
    }
    checkAllConfirmed();
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
const IMAGE_SIZES = ['small', 'medium', 'large', 'full'];
const imageSizeOf = q => (IMAGE_SIZES.includes(q?.image_size) ? q.image_size : 'medium');

function questionImagesHtml(q) {
    const ids = (Array.isArray(q.images) ? q.images : []).filter(id => typeof id === 'string');
    if (!ids.length) return '';
    return `<div class="question-images size-${imageSizeOf(q)}">${ids.map((id, i) => `<button type="button" class="question-image is-loading" data-image-id="${escapeHtml(id)}" aria-label="Image ${i + 1}: open it larger">
        <span class="question-image-note"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Loading the image</span></button>`).join('')}</div>`;
}

// preloaded: a preview's images, from the course editor.
async function loadExamImages(preloaded = null) {
    const details = examDetails;
    if (!details || !examQuestionsArea.querySelector('.question-image')) return;
    let images = preloaded;
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
    if (btn.classList.contains('is-failed')) {
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
        html = `<span class="file-answer-line is-done"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>${preview ? 'Checked' : 'Uploaded'}: <strong>${escapeHtml(answer.name)}</strong> (${formatBytes(answer.size)})${preview ? '. In a preview, files are not uploaded.' : ''}</span>`;
    }
    if (problem) {
        html += `<span class="file-answer-line is-problem"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${escapeHtml(problem)}${answer && progress == null ? ` Your answer is still ${escapeHtml(answer.name)}.` : ''}</span>`;
    }
    status.innerHTML = html;
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
        autoSaveAnswers();
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

// Once the exam is over: its files' state and its images.
function clearExamFiles() {
    fileAnswers = {};
    uploadsInProgress.clear();
    Object.values(examImageUrls).forEach(url => URL.revokeObjectURL(url));
    examImageUrls = {};
    closeImageViewer();
}
