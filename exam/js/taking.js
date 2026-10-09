/* ==========================================================================
   taking.js — taking an exam on /exam/: questions, answers, code editors,
   timer, autosave, backups and collecting the submission.

   scripts.js decides which exam is taken (filling examDetails), sends the
   submission (sendSubmission) and shows what follows (onExamSubmitted).
   Load after js/common.js and before js/scripts.js.
   ========================================================================== */

// === The exam being taken ===
// examDetails: { ExamId, Kind: 'named' | 'anonymous', Code (course), Name (label), TypeLabel,
//   Duration, StartDate, StartTime, Hall, Base, Weight, Questions (JSON string),
//   OriginalOrderMap, shuffleQuestions, Seed, Student: { name, email, student_no } (named),
//   Token and ExamCode (anonymous) }
let examDetails = null;
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

// Automatically save current answers to localStorage
function autoSaveAnswers() {
    // Only auto-save if exam is in progress
    if (!examQuestionsModule || examQuestionsModule.classList.contains('hidden') || !examDetails) {
        return;
    }

    try {
        // Collect current answers
        const currentAnswers = {};
        const confirmationStatus = {};

        // Use the original indices to collect answers
        const originalIndices = Object.keys(examDetails.OriginalOrderMap).map(Number).sort((a, b) => a - b);
        originalIndices.forEach(originalIndex => {
            const originalQNum = originalIndex + 1;
            const answerName = `ans-${originalQNum}`;
            const questionDivId = `q-${originalQNum}`;
            const questionDiv = document.getElementById(questionDivId);

            // Get confirmation status
            if (questionDiv) {
                confirmationStatus[questionDivId] = questionDiv.classList.contains('confirmed');
            }

            const questionData = examDetails.OriginalOrderMap[originalIndex];
            if (!questionData || questionData.type === 'text_only') return;

            const value = getAnswerValue(answerName);
            if (value !== undefined) currentAnswers[answerName] = value;
        });

        // Update the saved state with current answers and confirmation status
        const currentState = JSON.parse(localStorage.getItem(appStateKey) || '{}');
        currentState.currentAnswers = currentAnswers;
        currentState.confirmationStatus = confirmationStatus;
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
    stickyTimer.innerHTML = `<i class="fa-solid fa-stopwatch"></i> <span id="sticky-timer-display">--:--</span>`;
    document.body.appendChild(stickyTimer);

    return stickyTimer;
}

function getConfirmationCounts() {
    const required = examQuestionsArea.querySelectorAll('.question:not(.text-only-question)').length;
    const confirmed = examQuestionsArea.querySelectorAll('.question.confirmed:not(.text-only-question)').length;
    return { required, confirmed, allConfirmed: confirmed === required };
}

// Checks if all questions are confirmed and updates the main submit button
function checkAllConfirmed() {
    // Only proceed if the questions area is visible and we know the total count
    if (!examQuestionsArea || examQuestionsModule.classList.contains('hidden') || totalQuestions <= 0) {
        if (submitExamBtn) {
            submitExamBtn.disabled = true;
            submitExamBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Submit Exam (Confirm All First)';
        }
        return;
    }

    const { required: questionsRequiringConfirmation, confirmed: confirmedNonTextOnly, allConfirmed } = getConfirmationCounts();

    if (submitExamBtn) {
        // Enable button only if all questions are confirmed AND user is online
        submitExamBtn.disabled = !allConfirmed || !isOnline;

        // Update button text for clarity
        if (allConfirmed && isOnline) {
            submitExamBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Submit Exam Now';
        } else if (!isOnline) {
            submitExamBtn.innerHTML = '<i class="fa-solid fa-wifi"></i> Submit Exam (Offline)';
        } else {
            submitExamBtn.innerHTML = `<i class="fa-solid fa-lock"></i> Submit Exam (${confirmedNonTextOnly}/${questionsRequiringConfirmation} Confirmed)`;
        }
    }
}


function displayQuestions(questionsJsonString) {
    examQuestionsArea.innerHTML = ''; // Clear previous questions
    codeEditors = {};
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

        // Seeded per student (their email or student ID, or the exam ID when anonymous),
        // so the order is the same after a reload
        const seed = hashString(examDetails.Seed || Date.now().toString());

        // Create a shuffled order of question indices
        const originalIndices = Array.from(questionsArray.keys());
        const displayIndices = skipShuffle
            ? originalIndices
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

            // --- Process Prompt Text ---
            let promptText = q.prompt || `Question`;
            promptText = escapeHtml(promptText);

            // Create the question title/label
            const isTextOnly = q.type === 'text_only';
            const questionTitle = isTextOnly ? 'Information' : `Question ${++questionNumber}`;
            const titleIcon = isTextOnly ? 'fa-circle-info' : 'fa-circle-question';
            let pointsDisplay = '';

            if (q.points && q.type !== 'text_only') {
                pointsDisplay = `<span class="question-points">${escapeHtml(String(q.points))} ${q.points == 1 ? 'point' : 'points'}</span>`;
            }

            // **bold** and ***bold*** markup
            promptText = promptText.replace(/\*\*\*(.*?)\*\*\*/g, '<strong>$1</strong>');
            promptText = promptText.replace(/(?<!\*)\*\*(?!\*)(.*?)\*\*(?!\*)/g, '<strong>$1</strong>');

            promptText = promptText.replace(/\n/g, '<br>');
            // --- End Process Prompt Text ---

            let questionContentHtml = '';

            // Generate input HTML based on question type
            switch (q.type) {
                case 'text_only':
                    // Information only, no input
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    break;

                case 'short_answer':
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    questionContentHtml += `<input type="text" id="${answerId}" name="${answerName}" class="form-control" placeholder="Enter your answer">`;
                    break;

                case 'numeric': // One number, with the unit beside it when there is one
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    questionContentHtml += `<div class="numeric-answer"><input type="text" inputmode="decimal" id="${answerId}" name="${answerName}" class="form-control" placeholder="Enter a number" autocomplete="off">${q.unit ? `<span class="numeric-unit">${escapeHtml(q.unit)}</span>` : ''}</div>`;
                    break;

                case 'long_answer':
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    questionContentHtml += `<textarea id="${answerId}" name="${answerName}" class="form-control" rows="5" placeholder="Enter your detailed answer">${escapeHtml(q.content || '')}</textarea>`;
                    break;

                case 'code':
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    questionContentHtml += `<textarea id="${answerId}" name="${answerName}" class="form-control code-editor" rows="8" placeholder="Enter your code">${escapeHtml(q.content || '')}</textarea>`;
                    break;

                case 'attachment':
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    questionContentHtml += `<input type="file" id="${answerId}" name="${answerName}" class="form-control">`;
                    break;

                case 'multiple_select':
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    questionContentHtml += `<div class="checkbox-group" id="${answerId}">`;

                    if (Array.isArray(q.options) && q.options.length > 0) {
                        // Store original options
                        q.originalOptions = [...q.options];

                        // Shuffle options for students (with unique seed for this question)
                        const optionIndices = [...Array(q.options.length).keys()];
                        const shuffledOptionIndices = skipShuffle ?
                            [...optionIndices] :
                            seededShuffle(optionIndices, seed + originalIndex);

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
                        <span class="choice-text">${escapedOption}</span>
                    </label>`;
                        });
                    } else {
                        questionContentHtml += `<p class="exam-error">Error: Options missing or empty.</p>`;
                    }
                    questionContentHtml += `</div>`;
                    break;

                default:
                    questionContentHtml += `<div class="question-prompt">${promptText}</div>`;
                    questionContentHtml += `<p>${escapeHtml(q.content || '')}</p>`;
                    break;
            }

            // Add confirm/edit actions - not for text_only type
            let actionsHtml = '';
            if (q.type !== 'text_only') {
                actionsHtml = `
            <div class="question-actions">
                <button type="button" class="btn-confirm btn-green btn-sm" onclick="confirmAnswer('${questionId}')">
                    <i class="fa-solid fa-check"></i> Confirm
                </button>
                <button type="button" class="btn-edit btn-secondary btn-sm" onclick="editAnswer('${questionId}')">
                    <i class="fa-solid fa-pen"></i> Edit
                </button>
            </div>
        `;
            }

            // Module-style layout: header, then a body that collapses once the answer is confirmed
            questionDiv.innerHTML = `
        <div class="question-header">
            <div class="question-title">
                <i class="fa-solid ${titleIcon}"></i>
                ${questionTitle}
                ${pointsDisplay}
            </div>
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

    } catch (e) {
        console.error("Error displaying questions:", e);
        examQuestionsArea.innerHTML = '<p>Error loading questions.</p>';
    }

    checkAllConfirmed();
}

// Reads a question's current answer. Code answers live in their CodeMirror editor, not the textarea.
function getAnswerValue(answerName) {
    if (codeEditors[answerName]) return codeEditors[answerName].getValue();
    const formElement = examForm.elements[answerName];
    if (!formElement) return undefined;
    if (formElement.type === 'file') {
        return (formElement.files && formElement.files.length > 0) ? 'FILE_SELECTED' : '';
    }
    return formElement.value || ''; // Radio groups (RadioNodeList) return the checked value
}

// Writes a saved answer back into its question (file inputs can't be restored)
function setAnswerValue(answerName, value) {
    if (codeEditors[answerName]) {
        codeEditors[answerName].setValue(value || '');
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

        // Add confirmed class - this will automatically collapse via CSS
        questionDiv.classList.add('confirmed');

        // Disable all inputs
        const inputs = questionDiv.querySelectorAll('.form-control, .form-control-checkbox');
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

        return true;
    } catch (error) {
        console.error(`Error in confirmAnswer for ${questionId}:`, error);
        return false;
    }
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
        <h3 id="backup-modal-title"><i class="fa-solid fa-file-import" style="margin-right:8px"></i>Import Backup</h3>
        <button type="button" class="btn-ghost btn-icon" id="backup-close-btn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
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
        <button type="button" class="btn-secondary btn-sm" id="backup-cancel-btn"><i class="fa-solid fa-xmark" style="margin-right:5px"></i>Cancel</button>
        <button type="button" class="btn-green btn-sm" id="backup-import-btn" disabled><i class="fa-solid fa-file-import" style="margin-right:5px"></i>Import Backup</button>
    </div>
</div>
    `;

    document.body.appendChild(modalDiv);

    // Setup event listeners
    document.getElementById('backup-close-btn').addEventListener('click', hideBackupImportDialog);
    document.getElementById('backup-cancel-btn').addEventListener('click', hideBackupImportDialog);
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
        const inputs = questionDiv.querySelectorAll('.form-control, .form-control-checkbox');
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
        availScreenRes: `${screen.availWidth || 0}x${screen.availHeight || 0}`,
        windowInnerSize: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
        timezoneOffset: new Date().getTimezoneOffset(),

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

    // --- A local backup file, whatever happens online ---
    const confirmationCounts = getConfirmationCounts();
    const isAnonymous = examDetails.Kind === 'anonymous';
    const backupData = {
        submissionTimestamp: new Date().toISOString(),
        examDetails: { ExamId: examDetails.ExamId, Name: examDetails.Name, Code: examDetails.Code, Kind: examDetails.Kind },
        studentInfo: isAnonymous ? { examCode: examDetails.ExamCode } : { ...examDetails.Student },
        answers: answers,
        fingerprint: fingerprintObject,
        submittedLate: timeIsUp,
        autoSubmitted: isAutoSubmit,
        confirmedCountOnSubmit: confirmationCounts.confirmed,
        totalQuestionsOnSubmit: confirmationCounts.required // Questions that needed confirming
    };
    const slug = text => String(text || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();
    const who = isAnonymous ? examDetails.ExamCode : (examDetails.Student?.student_no || examDetails.Student?.email);
    downloadJsonBackup(backupData, `exam_backup_${slug(examDetails.Code)}_${slug(examDetails.Name)}_${slug(who) || 'student'}_${Date.now()}.json`);

    let submissionSuccess = false;
    try {
        await sendSubmission({ answers: answers, fingerprint: fingerprintObject, auto_submitted: isAutoSubmit });
        submissionSuccess = true;
    } catch (error) {
        console.error('Error sending the submission:', error);
        showImprovedNotification('error', 'Submission Error', `Could not send submission: ${error.message}. A backup file was downloaded.`, 0);
    }

    // --- Final UI update ---
    if (submissionSuccess) {
        const submitted = { ...examDetails };
        finishExamSession();
        onExamSubmitted(submitted);
    } else if (!isAutoSubmit) {
        checkAllConfirmed(); // Allow a retry (the button stays disabled while offline)
    } else {
        showImprovedNotification('error', 'Auto-Submit Failed', 'Could not automatically send submission online. Backup downloaded.', 0);
    }
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
        const formElement = examForm.elements[answerName];
        if (!formElement) {
            console.warn(`Could not find form element for answer name: "${answerName}"`);
            answers[answerName] = 'ERROR_ELEMENT_NOT_FOUND';
            return;
        }
        switch (questionData.type) {
            case 'attachment':
                answers[answerName] = (formElement.files && formElement.files.length > 0)
                    ? `FILE_UPLOADED:${formElement.files[0].name}` : '';
                break;
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
    localStorage.removeItem(appStateKey);
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
    if (!examDetails) return;
    try {
        const state = JSON.parse(localStorage.getItem(appStateKey) || '{}') || {};
        Object.assign(state, { examDetails, examEndTime });
        localStorage.setItem(appStateKey, JSON.stringify(state));
    } catch (e) {
        console.error("Error saving the exam state:", e);
    }
}

// The saved exam in progress, if it hasn't ended yet.
function readExamState() {
    try {
        const state = JSON.parse(localStorage.getItem(appStateKey) || 'null');
        if (state?.examDetails?.OriginalOrderMap && state.examEndTime > Date.now()) return state;
    } catch (e) {
        console.warn('Ignoring unreadable saved exam state.', e);
    }
    localStorage.removeItem(appStateKey);
    return null;
}

// Rebuilds the questions from a saved state, refills the answers and confirmations, and
// restarts the timer.
function restoreExam(state) {
    examDetails = state.examDetails;
    examEndTime = state.examEndTime;
    displayQuestions(examDetails.Questions);
    for (const answerName in (state.currentAnswers || {})) {
        if (state.currentAnswers[answerName] !== 'FILE_SELECTED') {
            setAnswerValue(answerName, state.currentAnswers[answerName]);
        }
    }
    for (const questionId in (state.confirmationStatus || {})) {
        if (state.confirmationStatus[questionId]) confirmAnswer(questionId);
    }
    startTimer();
    checkAllConfirmed();
}
