/* ==========================================================================
   Syllatest — the student exam page (/exam/).

   Sign in with Google; with a student ID and the exam's password, to take that
   exam; or, for anonymous exams, with an exam ID and the exam's password.
   Signed-in students see their courses (from the class lists) with each course's
   exams, start the open ones, and read published results question by question.
   An anonymous exam's grade is looked up by its exam ID alone, signed in or not.

   Load after ../js/config.js, js/common.js, js/store.js and js/taking.js.
   ========================================================================== */

// === App State ===
let currentUser = null;    // examStore.currentUser(): signed-in student, or null
let dash = null;           // The last exam_dashboard result
// "Try as student" in the course editor opens /exam/?preview=<exam id>: that exam, sent by the
// editor's tab, taken as a student would, with nothing saved or sent.
const PREVIEW_EXAM = new URLSearchParams(location.search).get('preview');

const EXAM_TYPES = {
    quiz: { label: 'Quiz', icon: 'fa-solid fa-question' },
    assignment: { label: 'Assignment', icon: 'fa-solid fa-book' },
    project: { label: 'Project', icon: 'fa-solid fa-diagram-project' },
    midterm_project: { label: 'Midterm Project', icon: 'fa-solid fa-diagram-project' },
    final_project: { label: 'Final Project', icon: 'fa-solid fa-diagram-project' },
    other: { label: 'Other', icon: 'fa-solid fa-ellipsis' },
    final_exam: { label: 'Final Exam', icon: 'fa-solid fa-graduation-cap' },
    midterm_exam: { label: 'Midterm Exam', icon: 'fa-solid fa-pen-to-square' },
    resit_exam: { label: 'Resit Exam', icon: 'fa-solid fa-rotate' },
    additional_exam: { label: 'Additional Exam', icon: 'fa-solid fa-plus' },
};
const typeLabel = type => EXAM_TYPES[type]?.label || 'Exam';
const examTitle = exam => exam.label || typeLabel(exam.type);


// === Initialisation ===
// Page chrome first, so the theme toggle and footer are right before sign-in resolves.
applyThemeDefaults();
applyOwnerBranding();
setupThemeToggle();

window.addEventListener('load', boot);

async function boot() {
    setupEventListeners();
    setupSessionManagement();
    setupBackupImportFeature();
    updateOnlineStatus();
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    if (PREVIEW_EXAM) return bootPreview();

    const saved = readExamState();
    try { currentUser = await examStore.currentUser(); } catch (e) { console.warn('Could not read the sign-in.', e); }
    // Drop the OAuth fragment so a reload doesn't try to consume it again.
    const justSignedIn = !!currentUser && location.hash.includes('access_token');
    if (location.hash.includes('access_token') || location.hash.includes('error')) {
        if (justSignedIn) noteActive(true); // just signed in with Google
        history.replaceState(history.state, '', location.pathname + location.search);
    }
    setupIdleSignOut();
    startHeartbeat();

    // An exam whose page has been gone for more than 2 minutes (the computer off, the browser
    // closed): whoever is at this computer now signs in again before it carries on. It may be
    // the next student. A reload is quicker, and carries on at once.
    if (saved && examLeftAlone(saved) && !justSignedIn) {
        if (currentUser) await examStore.signOut();
        currentUser = null;
        showScreen('login');
        showImprovedNotification('warning', 'Sign In to Continue', saved.examDetails.Kind === 'anonymous'
            ? 'An exam was left open on this computer. To carry on with it, enter your exam ID and the exam password.'
            : 'An exam was left open on this computer. To carry on with it, sign in again.', 0);
        return;
    }

    // An anonymous exam needs no sign-in: it carries on straight away.
    if (saved?.examDetails.Kind === 'anonymous') {
        enterApp();
        continueSavedExam(saved);
        return;
    }
    // Signed in on a shared computer, then gone for 30 minutes: signed out first.
    if (currentUser && !saved && idleTooLong()) await signOutIdle();
    if (!currentUser) {
        showScreen('login');
        if (saved) showImprovedNotification('warning', 'Sign In to Continue', 'Sign in again to continue your exam.', 0);
        return;
    }
    enterApp();
    if (!(await loadDashboard())) return;
    if (saved && ownsSavedExam(saved)) continueSavedExam(saved);
}

// A saved exam (a reload, a reboot, a lost connection): the server says where it stands first.
// Still taking answers: back where the student was, or, once its time is up, its answers are
// sent without opening it. Submitted or closed: not opened again. Open on another device: says
// so. No connection: it carries on here, and the answers go once it is back.
async function continueSavedExam(saved) {
    const d = saved.examDetails;
    let status = 'offline';
    try {
        status = (await examStore.heartbeat(d.ExamId, d.Kind === 'anonymous' ? d.Token : null, null)).exam;
    } catch (error) {
        if (!error.offline) status = 'unknown';
    }
    if (status === 'submitted') {
        clearSavedExam();
        showImprovedNotification('info', 'Already Submitted', `${d.Name} has been submitted.`, 8000);
        return backToDashboard();
    }
    if (status === 'closed') {
        clearSavedExam();
        showImprovedNotification('error', 'Exam Closed', `${d.Name} no longer takes answers. If yours were not sent, tell your lecturer.`, 0);
        return backToDashboard();
    }
    if (status === 'elsewhere') {
        showImprovedNotification('error', 'Open on Another Device',
            `${d.Name} is open on another device. Close it there first; if that computer stopped working, reload this page in 2 minutes.`, 0);
        return backToDashboard();
    }
    if (status === 'signed_out') {
        if (d.Kind === 'anonymous') {
            showScreen('login');
            showImprovedNotification('warning', 'Sign In to Continue', 'Sign in again with your exam ID and the exam password to continue your exam.', 0);
        } else {
            await signedOutByServer('Sign in again to continue your exam.');
        }
        return;
    }
    if (saved.pending || saved.examEndTime <= Date.now()) {
        showMessage({ icon: 'fa-solid fa-paper-plane', title: 'Sending your answers',
            text: `${d.Name} has ended. The answers saved on this computer are being sent.` });
        return sendSavedExam(saved);
    }
    resumeExam(saved);
}

function setupEventListeners() {
    // No right-click menu anywhere on the page, and no dragging images out of it.
    document.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('dragstart', e => { if (e.target.closest?.('img, a')) e.preventDefault(); });
    document.getElementById('signin-btn').addEventListener('click', signInWithGoogle);
    document.querySelectorAll('[data-signin]').forEach(btn => btn.addEventListener('click', () => toggleSignInForm(btn.dataset.signin)));
    document.getElementById('student-signin-form').addEventListener('submit', signInWithStudentId);
    document.getElementById('exam-signin-form').addEventListener('submit', e => {
        e.preventDefault();
        const code = document.getElementById('signin-exam-code'), password = document.getElementById('signin-exam-password');
        if (!code.value.trim()) return code.focus();
        if (!password.value) return password.focus();
        startAnonymousExam(code.value, password.value);
    });
    document.getElementById('grade-signin-form').addEventListener('submit', e => {
        e.preventDefault();
        const select = document.getElementById('signin-grade-course');
        const course = resultCourses?.[Number(select.value)];
        if (!select.value || !course) return select.focus();
        lookUpGrade(course, document.getElementById('signin-grade-code'), document.getElementById('signin-grade-results'));
    });
    document.getElementById('signin-grade-results').addEventListener('click', openLookupResult);
    // Each course card's own exam-ID lookup.
    document.getElementById('dash-courses').addEventListener('submit', e => {
        const form = e.target.closest('.course-lookup');
        if (!form) return;
        e.preventDefault();
        const course = dash?.courses.find(c => c.sheet_name === form.dataset.sheet && String(!!c.archived) === form.dataset.archived);
        if (course) lookUpGrade(course, form.querySelector('input'), form.parentElement.querySelector('.grade-results'));
    });
    document.getElementById('signout-btn').addEventListener('click', handleSignoutClick);
    submitExamBtn.addEventListener('click', () => handleSubmitExam(false));
    document.querySelectorAll('[data-back]').forEach(btn => btn.addEventListener('click', () => backToDashboard()));
    document.getElementById('dash-courses').addEventListener('click', handleDashboardClick);
    document.getElementById('modal-form').addEventListener('submit', submitModal);

    // Save answers shortly after every change, not only on the periodic auto-save
    examForm.addEventListener('input', saveAnswersSoon);
    examForm.addEventListener('change', saveAnswersSoon);

    // Warn before leaving mid-exam. Answers survive a reload, but leaving by accident is still disruptive.
    window.addEventListener('beforeunload', (e) => {
        if (!examDetails || examDetails.Kind === 'preview' || examQuestionsModule.classList.contains('hidden')) return;
        autoSaveAnswers();
        e.preventDefault();
        e.returnValue = '';
    });
}

// The views inside the app: dashboard, exam, result and done.
function showView(name) {
    document.querySelectorAll('.exam-view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
    examQuestionsModule.classList.toggle('hidden', name !== 'exam');
    window.scrollTo({ top: 0 });
}


// === Signing in and out ===
function toggleSignInForm(which) {
    document.querySelectorAll('[data-signin]').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.signin === which && btn.getAttribute('aria-pressed') !== 'true'));
    });
    document.querySelectorAll('[data-signin-form]').forEach(form => {
        const open = document.querySelector(`[data-signin="${form.dataset.signinForm}"]`).getAttribute('aria-pressed') === 'true';
        form.hidden = !open;
        if (open) form.querySelector('input, select')?.focus();
    });
    if (which === 'grade') loadResultCourses();
}

// The Grade form's courses (those with anonymous exams), loaded the first time it opens.
let resultCourses = null;
async function loadResultCourses() {
    if (resultCourses) return;
    const select = document.getElementById('signin-grade-course');
    try {
        resultCourses = await examStore.resultCourses();
    } catch (error) {
        select.innerHTML = '<option value="">Could not load the courses</option>';
        return;
    }
    const option = (c, i) => {
        const term = [c.semester, c.year].filter(Boolean).join(' ');
        return `<option value="${i}">${escapeHtml([c.code || c.sheet_name, c.title].filter(Boolean).join(' '))}${term ? ` (${escapeHtml(term)})` : ''}</option>`;
    };
    const current = resultCourses.map((c, i) => [c, i]).filter(([c]) => !c.archived);
    const past = resultCourses.map((c, i) => [c, i]).filter(([c]) => c.archived);
    select.innerHTML = resultCourses.length
        ? '<option value="">Choose your course</option>' +
          (current.length ? `<optgroup label="Current courses">${current.map(([c, i]) => option(c, i)).join('')}</optgroup>` : '') +
          (past.length ? `<optgroup label="Past courses">${past.map(([c, i]) => option(c, i)).join('')}</optgroup>` : '')
        : '<option value="">No course has exam grades yet</option>';
}

async function signInWithGoogle() {
    const btn = document.getElementById('signin-btn');
    btn.disabled = true;
    try {
        await examStore.signInWithGoogle(); // Redirects to Google and back
    } catch (error) {
        showImprovedNotification('error', 'Sign-in Failed', error.message);
        btn.disabled = false;
    }
}

async function signInWithStudentId(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
        await examStore.signInWithStudentId(document.getElementById('signin-student-no').value,
            document.getElementById('signin-student-password').value);
        form.reset();
        currentUser = await examStore.currentUser();
        noteActive(true);
        enterApp();
        if (!(await loadDashboard())) return;
        const saved = readExamState();
        if (saved && ownsSavedExam(saved)) continueSavedExam(saved);
    } catch (error) {
        showImprovedNotification('error', 'Sign-in Failed', error.message);
    } finally {
        btn.disabled = false;
    }
}

// The app screen, with the top bar showing who is signed in (or that this is anonymous).
function enterApp() {
    clearNotifications(); // sign-in errors and the "sign in to continue" warning
    renderTopBar();
    showScreen('app');
}

function renderTopBar() {
    if (PREVIEW_EXAM) {
        document.querySelector('#signout-btn .signout-text').textContent = 'Close';
        document.getElementById('top-user').innerHTML = '<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-play"></i></span><span>Preview</span>';
        return;
    }
    // Not signed in: an anonymous exam, or a grade looked up by exam ID.
    const anonymous = !currentUser;
    document.querySelector('#signout-btn .signout-text').textContent = anonymous ? 'Leave' : 'Sign out';
    if (anonymous) {
        const topUser = document.getElementById('top-user');
        topUser.innerHTML = `<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-user-secret"></i></span><span>${examDetails ? 'Anonymous exam' : 'Exam ID'}</span>`;
        topUser.title = '';
    } else {
        renderTopUser(currentUser || {});
    }
}

async function handleSignoutClick() {
    if (PREVIEW_EXAM) return closePreview();
    if (examDetails) {
        const anonymous = examDetails.Kind === 'anonymous';
        const leave = await confirmDialog(anonymous
            ? 'Leave the exam? Your answers stay on this device; sign in again with your exam ID and password before it ends to continue.'
            : 'Sign out during the exam? Your answers stay on this device; sign in again before it ends to continue.',
            { title: anonymous ? 'Leave Exam' : 'Sign Out', okLabel: anonymous ? 'Leave' : 'Sign out', danger: true, okIcon: 'fa-right-from-bracket' });
        if (!leave) return;
        autoSaveAnswers();
        examIntegrity.suspend(); // counted as leaving the page, until they are back
        clearExamFiles();
        stopTimer();
        document.querySelector('.sticky-timer')?.remove();
        document.body.classList.remove('time-warning', 'time-danger', 'time-expired');
        examDetails = null;
        examEndTime = null;
    }
    await examStore.signOut();
    currentUser = null;
    dash = null;
    document.querySelectorAll('.grade-results').forEach(el => { el.hidden = true; el.innerHTML = ''; el._results = null; });
    showView('dashboard');
    showScreen('login');
    showImprovedNotification('info', 'Signed Out', 'You have been signed out.');
}


// === Staying signed in: one device, check-ins, idle sign-out ===
// Every 30 seconds while signed in with a student ID or taking an exam, the page checks in
// (exam_heartbeat): the Student ID sign-in lasts 30 minutes past the last check-in, and the
// exam stays on this device with the answers so far, so another computer can carry on if this
// one breaks down. The answer also says when the sign-in is over, or the exam was taken over
// by another device or submitted.
const HEARTBEAT_MS = 30 * 1000;
let heartbeatTimer = null, heartbeatSoonTimer = null;

function startHeartbeat() {
    if (PREVIEW_EXAM || heartbeatTimer) return;
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}

// Soon after a confirmation or an upload, so the draft is up to date.
function heartbeatSoon() {
    clearTimeout(heartbeatSoonTimer);
    heartbeatSoonTimer = setTimeout(heartbeat, 2000);
}

async function heartbeat() {
    const d = examDetails && examDetails.Kind !== 'preview' && !examQuestionsModule.classList.contains('hidden') ? examDetails : null;
    const studentId = currentUser?.via === 'student_id';
    if (d) markExamAlive(); // even offline: the page is still here
    if (!d && !studentId) return;
    let result;
    try {
        result = await examStore.heartbeat(d?.ExamId, d?.Kind === 'anonymous' ? d.Token : null, d ? examDraft() : null);
    } catch {
        return; // no connection: the next one
    }
    if (d && examDetails === d) {
        if (result.exam === 'elsewhere') return examTakenElsewhere(d);
        if (result.exam === 'submitted') return submissionDone(d);
    }
    if (studentId && currentUser?.via === 'student_id' && result.signed_in === false) {
        await signedOutByServer(examDetails ? 'Sign in again to continue your exam.' : 'Your sign-in has ended. Sign in again if you need to.');
    }
}

// Another device has the exam now (this one was silent for 2 minutes): it stops here.
function examTakenElsewhere(details) {
    examIntegrity.stop();
    finishExamSession();
    showImprovedNotification('error', 'Open on Another Device', `${details.Name} is now open on another device, and carries on there.`, 0);
    backToDashboard();
}

// The Student ID sign-in is over (30 minutes without a check-in, the exam's end, or another
// device signed in): back to the sign-in card. An exam in progress stays saved on the device.
async function signedOutByServer(message) {
    if (examDetails) {
        autoSaveAnswers();
        examIntegrity.suspend();
        clearExamFiles();
        stopTimer();
        document.querySelector('.sticky-timer')?.remove();
        document.body.classList.remove('time-warning', 'time-danger', 'time-expired');
        examDetails = null;
        examEndTime = null;
    }
    examStore.forgetStudentSession();
    currentUser = null;
    dash = null;
    showView('dashboard');
    showScreen('login');
    showImprovedNotification('warning', 'Signed Out', message, 0);
}

// On a shared computer: after 30 minutes without a click or a key, the page signs out (not
// during an exam). The time is kept in the browser, so a page opened again later counts too.
const IDLE_SIGN_OUT_MS = 30 * 60 * 1000;
const ACTIVE_KEY = 'examLastActive';
let activeNoted = 0;

// force: a sign-in just now (an older time kept from before must not sign it out).
function noteActive(force = false) {
    if (force !== true && Date.now() - activeNoted < 15000) return;
    activeNoted = Date.now();
    try { localStorage.setItem(ACTIVE_KEY, String(activeNoted)); } catch { }
}

function idleTooLong() {
    let last = 0;
    try { last = Number(localStorage.getItem(ACTIVE_KEY)) || 0; } catch { }
    return last > 0 && Date.now() - last > IDLE_SIGN_OUT_MS;
}

function setupIdleSignOut() {
    if (PREVIEW_EXAM) return;
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(type => document.addEventListener(type, noteActive, { passive: true, capture: true }));
    setInterval(() => {
        if (examDetails) noteActive(); // an exam in progress never signs out for idling
        else if (currentUser && idleTooLong()) signOutIdle();
    }, 60 * 1000);
}

async function signOutIdle() {
    await examStore.signOut();
    currentUser = null;
    dash = null;
    activeNoted = 0;
    try { localStorage.removeItem(ACTIVE_KEY); } catch { }
    showView('dashboard');
    showScreen('login');
    showImprovedNotification('info', 'Signed Out', 'You were signed out after 30 minutes without activity.', 0);
}


// === Dashboard ===
// False when the Student ID sign-in turned out to be over (back at the sign-in card).
async function loadDashboard() {
    const courses = document.getElementById('dash-courses');
    courses.setAttribute('aria-busy', 'true');
    showView('dashboard');
    setSyncing(true);
    try {
        dash = await examStore.dashboard();
    } catch (error) {
        courses.removeAttribute('aria-busy');
        courses.innerHTML = `<p class="exam-empty exam-error">Could not load your courses: ${escapeHtml(error.message)}</p>`;
        return true; // a saved exam can still carry on offline
    } finally {
        setSyncing(false);
    }
    courses.removeAttribute('aria-busy');
    if (currentUser?.via === 'student_id' && dash.signed_in_by !== 'student_id') {
        await signedOutByServer('Your sign-in has ended: sign in again.');
        return false;
    }
    renderDashboard();
    return true;
}

function renderDashboard() {
    const first = dash.courses[0]?.student;
    const name = first?.name || currentUser?.name || '';
    document.getElementById('dash-title').textContent = name ? `Hello, ${name.split(/\s+/)[0]}` : 'My courses';
    const info = document.getElementById('dash-info');
    info.hidden = !first;
    info.innerHTML = first ? `<span class="info-item"><i class="fa-solid fa-id-card" aria-hidden="true"></i>${escapeHtml(first.student_no)}</span>
        <span class="info-item"><i class="fa-solid fa-book-open" aria-hidden="true"></i>${dash.courses.length} course${dash.courses.length === 1 ? '' : 's'}</span>` : '';

    const courses = document.getElementById('dash-courses');
    if (!dash.courses.length) {
        courses.innerHTML = `<div class="settings-group"><div class="settings-body exam-empty">
            <i class="fa-solid fa-user-slash" aria-hidden="true"></i>
            <p>${currentUser?.via === 'google'
                ? `${escapeHtml(dash.email || 'This account')} is not on any course's class list yet.`
                : 'No courses found for this sign-in.'}</p>
            <p class="form-hint">Your lecturer adds you when they paste the class list. Sign in with the email on it.</p>
        </div></div>`;
        return;
    }
    // Past (archived) courses keep their grades, folded away below the current ones. A Student ID
    // sign-in covers only the course of the exam whose password was used, so others need Google.
    const current = dash.courses.filter(c => !c.archived), past = dash.courses.filter(c => c.archived);
    const pastOpen = !current.length || !!courses.querySelector('details.past-courses')?.open; // stays open after viewing a result
    courses.innerHTML = current.map(courseCardHtml).join('') + (past.length ? `
        <details class="past-courses"${pastOpen ? ' open' : ''}>
            <summary><i class="fa-solid fa-box-archive" aria-hidden="true"></i>Past courses <span class="past-count">${past.length}</span></summary>
            <div class="dash-courses">${past.map(courseCardHtml).join('')}</div>
        </details>` : '') + (dash.signed_in_by === 'student_id'
        ? '<p class="form-hint dash-hint"><i class="fa-brands fa-google" aria-hidden="true"></i>Sign in with Google to see your other and past courses.</p>' : '');
}

function courseCardHtml(course) {
    const term = [course.semester, course.year].filter(Boolean).join(' ');
    const anonymous = course.exams.some(e => e.sign_in === 'anonymous');
    return `<section class="settings-group course-card${course.archived ? ' is-past' : ''}" data-sheet="${escapeHtml(course.sheet_name)}">
        <div class="course-card-head">
            <span class="course-card-code">${escapeHtml(course.code || course.sheet_name)}</span>
            <span class="course-card-title">${escapeHtml(course.title || '')}</span>
            ${term ? `<span class="course-card-term">${escapeHtml(term)}</span>` : ''}
        </div>
        <div class="settings-body exam-list">
            ${course.exams.length ? course.exams.map(exam => examRowHtml(exam, course)).join('')
            : '<p class="exam-empty">No exams scheduled yet.</p>'}
        </div>
        ${anonymous ? `<div class="course-lookup-wrap">
            <form class="course-lookup" data-sheet="${escapeHtml(course.sheet_name)}" data-archived="${!!course.archived}" novalidate>
                <label class="course-lookup-label" for="lookup-${escapeHtml(course.sheet_name)}-${!!course.archived}"><i class="fa-solid fa-user-secret" aria-hidden="true"></i>Midterm and final grades: enter your exam ID</label>
                <div class="course-lookup-row">
                    <input type="text" id="lookup-${escapeHtml(course.sheet_name)}-${!!course.archived}" placeholder="Exam ID" autocomplete="off" autocapitalize="off" spellcheck="false">
                    <button type="submit" class="btn-sm"><i class="fa-solid fa-star" aria-hidden="true"></i>See my grade</button>
                </div>
            </form>
            <div class="grade-results" hidden></div>
        </div>` : ''}
    </section>`;
}

function examRowHtml(exam, course = {}) {
    const meta = [];
    if (exam.starts_at) meta.push(`<span><i class="fa-regular fa-calendar" aria-hidden="true"></i>${escapeHtml(formatWhen(exam.starts_at))}</span>`);
    if (exam.duration_minutes) meta.push(`<span><i class="fa-regular fa-clock" aria-hidden="true"></i>${exam.duration_minutes} min</span>`);
    if (exam.hall) meta.push(`<span><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${escapeHtml(exam.hall)}</span>`);
    if (exam.weight != null) meta.push(`<span><i class="fa-solid fa-percent" aria-hidden="true"></i>${formatNumber(exam.weight)}% of grade</span>`);
    if (exam.question_count && exam.sign_in === 'google') meta.push('<span><i class="fa-brands fa-google" aria-hidden="true"></i>Google sign-in</span>');
    else if (exam.question_count && exam.sign_in === 'student_id') meta.push('<span><i class="fa-solid fa-id-card" aria-hidden="true"></i>Student ID sign-in</span>');
    return `<div class="exam-row" data-exam-id="${escapeHtml(exam.id)}">
        <span class="exam-row-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="exam-row-main">
            <div class="exam-row-title">${escapeHtml(examTitle(exam))}${exam.label ? `<span class="badge exam-type-badge">${escapeHtml(typeLabel(exam.type))}</span>` : ''}</div>
            ${meta.length ? `<div class="exam-row-meta">${meta.join('')}</div>` : ''}
        </div>
        <div class="exam-row-action">${examActionHtml(exam, course.archived)}</div>
    </div>`;
}

// What a student can do with an exam now, or where it stands. A past (archived) course's
// exams can't be started; their grades stay.
function examActionHtml(exam, archived = false) {
    const now = Date.now();
    const starts = exam.starts_at ? Date.parse(exam.starts_at) : null;
    const ends = exam.ends_at ? Date.parse(exam.ends_at) : null;
    if (exam.sign_in === 'anonymous') {
        if (exam.is_open && !archived) return `<button type="button" class="btn-sm btn-green" data-action="anonymous"><i class="fa-solid fa-user-secret"></i> Use exam ID</button>`;
        return `<span class="exam-chip" title="See its grade with your exam ID below"><i class="fa-solid fa-user-secret" aria-hidden="true"></i>Anonymous</span>`;
    }
    if (exam.submitted_at) {
        if (exam.results_published && exam.score != null) {
            return `<span class="exam-chip exam-chip-grade">${escapeHtml(formatGrade(exam.score, exam.max_score, exam.base))}</span>
                <button type="button" class="btn-sm btn-secondary" data-action="result"><i class="fa-solid fa-eye"></i> View</button>`;
        }
        return `<span class="exam-chip exam-chip-done"><i class="fa-solid fa-check" aria-hidden="true"></i>Submitted</span>`;
    }
    if (archived) return exam.question_count ? '<span class="exam-chip exam-chip-missed">Not taken</span>' : '';
    if (!exam.question_count) return starts && starts > now ? '<span class="exam-chip">Upcoming</span>' : '';
    // Each named exam takes one way of signing in: Google, or the student ID and exam password.
    if (exam.is_open && dash?.signed_in_by && exam.sign_in !== dash.signed_in_by) {
        return exam.sign_in === 'google'
            ? '<span class="exam-chip exam-chip-missed" title="Sign out, then sign in with Google to start it"><i class="fa-brands fa-google" aria-hidden="true"></i>Needs Google sign-in</span>'
            : '<span class="exam-chip exam-chip-missed" title="Sign out, then sign in with your student ID and the exam password to start it"><i class="fa-solid fa-id-card" aria-hidden="true"></i>Needs student ID sign-in</span>';
    }
    if (exam.is_open) return `<button type="button" class="btn-sm btn-green" data-action="start"><i class="fa-solid fa-play"></i> Start</button>`;
    if (starts && starts > now) return '<span class="exam-chip">Upcoming</span>';
    if (ends && ends <= now) return '<span class="exam-chip exam-chip-missed">Closed</span>';
    return '';
}

function findExam(examId) {
    for (const course of dash?.courses || []) {
        const exam = course.exams.find(e => e.id === examId);
        if (exam) return { exam, course };
    }
    return {};
}

function handleDashboardClick(e) {
    if (e.target.closest('[data-lookup-index]')) return openLookupResult(e);
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { exam } = findExam(btn.closest('[data-exam-id]').dataset.examId);
    if (!exam) return;
    if (btn.dataset.action === 'start') openStartDialog(exam);
    else if (btn.dataset.action === 'anonymous') openAnonymousDialog(exam);
    else if (btn.dataset.action === 'result') openNamedResult(exam);
}

async function backToDashboard() {
    if (currentUser) await loadDashboard();
    else showScreen('login');
}


// === Taking an exam ===
// Named exams: a last look at the timing, and the exam password when it has one (not again
// when the student signed in with it).
function openStartDialog(exam) {
    openModal({
        title: `Start ${examTitle(exam)}`,
        body: `<p>The exam ends at <strong>${escapeHtml(formatTime(exam.ends_at))}</strong>${exam.duration_minutes ? ` (${exam.duration_minutes} minutes from its start)` : ''}. The timer keeps running once you start.</p>
            <p>${escapeHtml(leaveRule(exam.settings))}</p>
            <p class="form-hint">${RECORDED_NOTE}</p>
            ${exam.has_password && !exam.password_entered ? `<div class="form-group"><label class="form-label" for="modal-password">Exam password</label>
                <input type="password" id="modal-password" autocomplete="off" required></div>` : ''}`,
        okLabel: 'Start', okIcon: 'fa-play', okClass: 'btn-green',
        onSubmit: async () => {
            const password = document.getElementById('modal-password')?.value || null;
            setSyncing(true);
            try {
                beginExam(await examStore.startExam(exam.id, password), 'named');
            } finally {
                setSyncing(false);
            }
        },
    });
}

// Students are told what their lecturer sees besides their answers (exam_private.claim_attempt).
const RECORDED_NOTE = 'Your network address (IP) and device (browser, screen) are recorded with your answers.';

// What leaving the exam page does, as the exam's settings say (examIntegrity's defaults).
function leaveRule(settings = {}) {
    if (settings.leave === 'record') return 'Each time you leave this page (clicking outside the window, another tab or program) is recorded for your lecturer.';
    const seconds = settings.cooldown_seconds || 15;
    return `Stay on this page: if you leave it (clicking outside the window, another tab or program), the exam locks for ${seconds} seconds each time you come back, and your lecturer sees each time.`;
}

// From the dashboard: an open anonymous exam still starts with the exam ID and its password.
function openAnonymousDialog(exam) {
    openModal({
        title: examTitle(exam),
        body: `<p>This exam is anonymous: sign in to it with the exam ID from your attendance sheet. It is never linked to your account.</p>
            <div class="form-group"><label class="form-label" for="modal-code">Exam ID</label>
                <input type="text" id="modal-code" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
            <div class="form-group"><label class="form-label" for="modal-password">Exam password</label>
                <input type="password" id="modal-password" autocomplete="off" required></div>`,
        okLabel: 'Start exam', okIcon: 'fa-play', okClass: 'btn-green',
        onSubmit: () => startAnonymousExam(document.getElementById('modal-code').value, document.getElementById('modal-password').value, true),
    });
}

async function startAnonymousExam(code, password, throwErrors = false) {
    setSyncing(true);
    try {
        const payload = await examStore.anonymousStart(code, password);
        document.getElementById('exam-signin-form').reset();
        // This computer has this exam ID's exam saved (it was left, or the page closed): carry
        // on from there, with the new sign-in.
        const saved = readExamState();
        if (saved?.examDetails.Kind === 'anonymous' && saved.examDetails.ExamId === payload.id && saved.examDetails.ExamCode === payload.exam_code) {
            saved.examDetails.Token = payload.token;
            enterApp();
            return continueSavedExam(saved);
        }
        beginExam(payload, 'anonymous');
        enterApp();
    } catch (error) {
        if (throwErrors) throw error;
        showImprovedNotification('error', 'Could Not Start', error.message);
    } finally {
        setSyncing(false);
    }
}

// Fills examDetails from exam_start / exam_anonymous_start (or a preview's exam from the
// course editor) and shows the questions.
function beginExam(payload, kind) {
    const start = new Date(payload.starts_at);
    examDetails = {
        ExamId: payload.id,
        Kind: kind,
        Code: payload.course_code || '',
        CourseTitle: payload.course_title || '',
        Name: examTitle(payload),
        TypeLabel: typeLabel(payload.type),
        Duration: payload.duration_minutes,
        StartDate: start.toLocaleDateString('en-GB'),
        StartTime: start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        Hall: payload.hall || '',
        Base: payload.base,
        Weight: payload.weight,
        Questions: JSON.stringify(payload.questions || []),
        OriginalOrderMap: null,
        shuffleQuestions: payload.shuffle_questions !== false,
        Seed: kind === 'anonymous' ? payload.exam_code : (payload.student?.student_no || payload.student?.email || payload.student?.name),
        Settings: payload.settings || {},
        SignIn: payload.sign_in,
        Student: kind !== 'anonymous' ? payload.student : undefined,
        Token: kind === 'anonymous' ? payload.token : undefined,
        ExamCode: kind === 'anonymous' ? payload.exam_code : undefined,
    };
    examEndTime = Date.parse(payload.ends_at);
    fillExamHeader();
    showView('exam');
    displayQuestions(examDetails.Questions);
    // Started before on a computer that broke down: carry on from what it last sent.
    const draft = payload.draft && typeof payload.draft === 'object' ? payload.draft : null;
    if (draft) applyProgress(draft.answers, draft.confirmations);
    startIntegrity(draft?.integrity || null, draft ? payload.draft_at : null);
    saveExamState(); // after displayQuestions, which fixes the question order
    autoSaveAnswers();
    startTimer();
    checkAllConfirmed();
    loadExamImages(kind === 'preview' ? payload.images : null);
    if (draft) showImprovedNotification('info', 'Carrying On', 'Your answers so far, from the other computer, are back.', 8000);
    // An exam ID's exam has no start dialog: the rule for leaving the page, now.
    else if (kind !== 'named') showImprovedNotification('info', 'Before You Start', leaveRule(payload.settings), 12000);
}

function resumeExam(saved) {
    fillExamHeader(saved.examDetails);
    showView('exam');
    restoreExam(saved);
    startIntegrity(saved.integrity);
    renderTopBar();
    loadExamImages();
    showImprovedNotification('info', 'Exam Session Restored', 'Resuming your exam where you left off.', 5000);
}

// The watermark shows how the student signed in (the exam ID only, when anonymous); leaving
// the page is watched as the exam's settings say. saved: the state before a reload, or from
// another computer's draft (movedSince: when it last checked in).
function startIntegrity(saved = null, movedSince = null) {
    const d = examDetails;
    const student = d.Student || {};
    const watermark = d.Kind === 'anonymous' ? [d.ExamCode, 'Exam ID']
        : d.Kind === 'preview' ? (d.SignIn === 'anonymous' ? ['Exam ID', 'Preview'] : [student.name, 'Preview'])
        : [student.name, student.student_no || student.email];
    examIntegrity.start({ settings: d.Settings, watermark, saved, movedSince, save: saveExamState });
}

// A saved named exam belongs to whoever is signed in now (by email or student ID).
function ownsSavedExam(saved) {
    const student = saved.examDetails.Student || {};
    return (student.email && student.email === dash?.email) ||
        (dash?.courses || []).some(c => c.student?.student_no && c.student.student_no === student.student_no);
}

// The course (code and name) above the exam's name; nothing else.
function fillExamHeader(details = examDetails) {
    document.getElementById('exam-code-display').textContent = [details.Code, details.CourseTitle].filter(Boolean).join(' · ') || 'Syllatest';
    document.getElementById('exam-name-header').textContent = details.Name;
}

// Called by taking.js with the collected answers.
async function sendSubmission(submission) {
    setSyncing(true);
    try {
        if (examDetails.Kind === 'anonymous') await examStore.anonymousSubmit(examDetails.Token, submission);
        else await examStore.submitExam(examDetails.ExamId, submission);
    } finally {
        setSyncing(false);
    }
}

// Called by taking.js when answers saved before a reboot could not be sent after the end.
function sendFailed(details, message) {
    finishExamSession();
    showMessage({
        icon: 'fa-solid fa-triangle-exclamation', title: 'Your answers could not be sent',
        text: `${message.replace(/\.$/, '')}. A backup file of your answers was saved to your downloads: give it to your lecturer.`,
        actions: `<button type="button" class="btn-sm" id="message-back"><i class="fa-solid fa-arrow-left"></i> ${currentUser ? 'My courses' : 'Done'}</button>`,
    });
    document.getElementById('message-back').addEventListener('click', backToDashboard);
}

// Called by taking.js once the submission is in.
// The exam's sign-in ends with it, so the next student at this computer starts afresh.
async function onExamSubmitted(exam) {
    showImprovedNotification('success', 'Exam Submitted Successfully!', 'Your submission has been sent.', 0);
    const anonymous = exam.Kind === 'anonymous';
    const signedOut = !!currentUser;
    if (signedOut) {
        await examStore.signOut();
        currentUser = null;
        dash = null;
    }
    const after = signedOut ? ' You have been signed out, so the next student can use this computer.' : '';
    document.getElementById('done-text').innerHTML = anonymous
        ? `Your answers have been sent, and a backup file was saved to your downloads. Your exam ID was never linked to you.
           Keep your exam ID, <strong>${escapeHtml(exam.ExamCode)}</strong>: once results are out, choose <em>Grade</em> on this page and enter it to see your grade.`
        : `Your answers have been sent. A backup file was also saved to your downloads. Sign in once your lecturer publishes the results to see yours.${after}`;
    document.getElementById('done-actions').innerHTML = '<button type="button" class="btn-sm" data-back><i class="fa-solid fa-right-from-bracket"></i> Done</button>';
    document.querySelector('#done-actions [data-back]').addEventListener('click', backToDashboard);
    renderTopBar();
    if (signedOut) document.getElementById('top-user').innerHTML = '<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-user"></i></span><span>Signed out</span>';
    showView('done');
}


// === Preview ("Try as student" in the course editor) ===
// The editor's tab opened this one, and answers its request with the exam: the questions as
// they are in the editor, without the answers. The timer starts now; files are checked but not
// uploaded; nothing is saved on this device or sent, and a reload starts again.
function bootPreview() {
    showScreen('app');
    renderTopBar();
    showMessage({ icon: 'fa-solid fa-play', title: 'Opening the preview', text: 'Getting the exam from the course editor…' });
    const editor = window.opener;
    if (!editor) return previewUnavailable();
    window.addEventListener('message', e => {
        if (e.source !== editor || e.data?.type !== 'syllabase-exam-preview' || e.data.payload?.id !== PREVIEW_EXAM || examDetails) return;
        startPreview(e.data.payload);
    });
    editor.postMessage({ type: 'syllabase-exam-preview-ready', examId: PREVIEW_EXAM }, '*');
    setTimeout(() => { if (!examDetails && !document.getElementById('view-message').hidden) previewUnavailable(); }, 8000);
}

function startPreview(payload) {
    const start = Date.now();
    beginExam({ ...payload, starts_at: new Date(start).toISOString(),
        ends_at: new Date(start + (payload.duration_minutes || 30) * 60000).toISOString() }, 'preview');
}

function previewUnavailable() {
    showMessage({ icon: 'fa-solid fa-play', title: 'The preview could not open',
        text: 'Open it again with Preview in the course editor\'s Exams tab, and keep that tab open.' });
}

// A message in place of the page (#view-message).
function showMessage({ icon = '', title, text = '', body = '', actions = '' }) {
    document.getElementById('message-icon').innerHTML = icon ? `<i class="${icon}"></i>` : '';
    document.getElementById('message-title').textContent = title;
    document.getElementById('message-text').textContent = text;
    document.getElementById('message-body').innerHTML = body;
    document.getElementById('message-actions').innerHTML = actions;
    showView('message');
}

// Called by taking.js instead of sending: what would have gone to the lecturer.
function onPreviewSubmitted(details, answers, activity, automatic) {
    const questions = Object.values(details.OriginalOrderMap || {});
    let number = 0;
    const rows = questions.map((q, i) => {
        if (q.type === 'text_only') return '';
        number++;
        const answer = answers[`ans-${i + 1}`];
        return `<li><span class="preview-q">Question ${number}</span><span class="preview-a">${answerHtml(answer, q.type)}</span></li>`;
    }).join('');
    showMessage({
        icon: 'fa-solid fa-flag-checkered',
        title: automatic ? 'Time is up: the preview is over' : 'The preview is over',
        text: 'Students would have sent this. As a preview, nothing was saved or sent.',
        body: `<ol class="preview-answers">${rows}</ol>
            <p class="preview-left"><i class="fa-solid fa-eye" aria-hidden="true"></i>${activity?.count
                ? `Left the page ${activity.count} time${activity.count === 1 ? '' : 's'}, ${formatSeconds(activity.total_seconds)} in total.`
                : 'Never left the page.'}</p>`,
        actions: `<button type="button" class="btn-sm btn-green" id="preview-again"><i class="fa-solid fa-rotate-right"></i> Try again</button>
            <button type="button" class="btn-sm btn-secondary" id="preview-close"><i class="fa-solid fa-xmark"></i> Close</button>`,
    });
    document.getElementById('preview-again').addEventListener('click', () => location.reload());
    document.getElementById('preview-close').addEventListener('click', closePreview);
}

function closePreview() {
    window.close();
    // A tab the page did not open stays: say so.
    setTimeout(() => showImprovedNotification('info', 'Preview', 'Close this tab to end the preview.', 5000), 300);
}

function formatSeconds(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}


// === Results ===
async function openNamedResult(exam) {
    setSyncing(true);
    try {
        renderResult(await examStore.myResult(exam.id));
    } catch (error) {
        showImprovedNotification('error', 'Could Not Load Result', error.message);
    } finally {
        setSyncing(false);
    }
}

// A question's maximum points: text-only items are worth nothing, unpointed ones 1.
function questionMaxPoints(q) {
    if (q.type === 'text_only') return 0;
    const points = parseFloat(q.points);
    return Number.isNaN(points) || points < 0 ? 1 : points;
}

function renderResult(result) {
    const grades = result.submission?.grades || null;
    const questions = Array.isArray(result.questions) ? result.questions : [];
    document.querySelector('#view-result [data-back]').innerHTML = `<i class="fa-solid fa-arrow-left" aria-hidden="true"></i>${currentUser ? 'My courses' : 'Back'}`;
    document.getElementById('result-course').textContent = result.course_code || '';
    document.getElementById('result-title').textContent = examTitle(result);
    const chips = [`<span class="info-item"><i class="${EXAM_TYPES[result.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i>${escapeHtml(typeLabel(result.type))}</span>`];
    if (result.starts_at) chips.push(`<span class="info-item"><i class="fa-regular fa-calendar" aria-hidden="true"></i>${escapeHtml(formatWhen(result.starts_at))}</span>`);
    if (grades) {
        chips.push(`<span class="info-item"><i class="fa-solid fa-star" aria-hidden="true"></i>Grade <strong>${escapeHtml(formatGrade(grades.totalScore, grades.maxScore, result.base))}</strong></span>`);
        const contribution = weightedContribution(grades.totalScore, grades.maxScore, result.base, result.weight);
        if (contribution != null) chips.push(`<span class="info-item"><i class="fa-solid fa-percent" aria-hidden="true"></i><strong>${formatNumber(contribution)}</strong>&nbsp;of ${formatNumber(result.weight)}%</span>`);
    }
    document.getElementById('result-info').innerHTML = chips.join('');

    const body = document.getElementById('result-body');
    if (!result.submission) {
        body.innerHTML = '<div class="settings-group"><div class="settings-body exam-empty"><p>No submission was recorded for this exam.</p></div></div>';
        showView('result');
        return;
    }
    let html = '';
    if (grades?.feedback) {
        html += `<div class="settings-group"><div class="settings-head"><span><i class="fa-solid fa-comment" aria-hidden="true"></i>Feedback</span></div>
            <div class="settings-body result-feedback">${escapeHtml(grades.feedback).replace(/\n/g, '<br>')}</div></div>`;
    }
    let number = 0;
    questions.forEach((q, index) => {
        if (q.type === 'text_only') return;
        number++;
        const qGrade = grades?.questionGrades?.[`q-${index + 1}`] || {};
        const max = questionMaxPoints(q);
        const points = qGrade.points === '' || qGrade.points == null ? null : parseFloat(qGrade.points);
        const status = qGrade.status && qGrade.status !== 'ungraded' ? qGrade.status : '';
        html += `<article class="question result-question${status ? ` is-${escapeHtml(status)}` : ''}">
            <div class="question-header"><span class="question-number" aria-hidden="true">${number}</span>
                <div class="question-title"><span class="question-label">Question ${number}</span></div>
                <span class="question-points">${points == null ? `${formatNumber(max)} point${max === 1 ? '' : 's'}` : `${formatNumber(points)} / ${formatNumber(max)}`}</span></div>
            <div class="question-body">
                <div class="question-prompt">${promptHtml(q.prompt)}</div>
                ${resultImagesHtml(q, result.images)}
                <p class="answer-label">Your answer</p>
                <div class="result-answer">${answerHtml(result.submission.answers?.[`ans-${index + 1}`], q.type)}</div>
                ${correctAnswerHtml(q)}
                ${q.explanation ? `<p class="answer-label">Explanation</p><div class="result-answer">${promptHtml(q.explanation)}</div>` : ''}
                ${qGrade.comment ? `<p class="answer-label">Comment</p><div class="result-comment">${escapeHtml(qGrade.comment).replace(/\n/g, '<br>')}</div>` : ''}
            </div>
        </article>`;
    });
    body.innerHTML = html || '<div class="settings-group"><div class="settings-body exam-empty"><p>This exam had no questions to grade.</p></div></div>';
    showView('result');
}

// The right answer, where the question has one: options, accepted answers or a number.
function correctAnswerHtml(q) {
    let label = 'Correct answer', text = '';
    if (q.type === 'multiple_select' && q.correct_answers?.length) text = q.correct_answers.map(formatQuestionText.inline).join('<br>');
    else if (q.type === 'short_answer' && q.accepted_answers?.length) { label = q.accepted_answers.length > 1 ? 'Accepted answers' : 'Correct answer'; text = q.accepted_answers.map(escapeHtml).join('<br>'); }
    else if (q.type === 'numeric' && q.answer != null) text = escapeHtml(`${q.answer}${q.tolerance ? ` ± ${q.tolerance}` : ''}${q.unit ? ` ${q.unit}` : ''}`); // as entered, not rounded
    return text ? `<p class="answer-label">${label}</p><div class="result-answer result-correct">${text}</div>` : '';
}

// Bold, italic, lists… as on the exam itself (js/format-text.js)
const promptHtml = prompt => formatQuestionText(prompt);

function answerHtml(answer, type) {
    if (answer === '[NOT CONFIRMED]') return '<em>Not confirmed before the deadline, so not submitted</em>';
    if (answer == null || answer === '') return '<em>No answer</em>';
    if (type === 'attachment' && typeof answer === 'object') return `<em>File:</em> ${escapeHtml(answer.name || '')} (${formatBytes(answer.size)})`;
    const text = String(answer);
    if (type === 'code') return `<pre class="result-code">${escapeHtml(text)}</pre>`;
    if (type === 'attachment' && text.startsWith('FILE_UPLOADED:')) return `<em>File:</em> ${escapeHtml(text.slice('FILE_UPLOADED:'.length))}`;
    return escapeHtml(text).replace(/\n/g, '<br>');
}

// A result's question images (sent with published results).
function resultImagesHtml(q, images) {
    const sources = (Array.isArray(q.images) ? q.images : []).map(id => images?.[id]).filter(src => /^data:image\//.test(src || ''));
    return sources.length ? `<div class="question-images">${sources.map(src => `<img class="result-image" src="${escapeHtml(src)}" alt="" draggable="false">`).join('')}</div>` : '';
}


// === Grades by exam ID ===
// Anonymous exams are never linked to a student, so their grades are looked up by exam ID, in
// one course offering (exam IDs are reshuffled every semester, so the same ID is someone else's
// in another one): on the sign-in card or in a course's card on the dashboard, without the
// student's session (examStore.codeResults). Each results box keeps its own results.
async function lookUpGrade(course, input, results) {
    const code = input.value.trim();
    if (!code) { input.focus(); return; }
    const button = input.closest('form').querySelector('button[type="submit"]');
    button.disabled = true;
    results.hidden = false;
    results.innerHTML = '<div class="skeleton skeleton-card"></div>';
    try {
        results._results = await examStore.codeResults(course.sheet_name, !!course.archived, code);
        results.innerHTML = results._results.length
            ? results._results.map((r, i) => gradeRowHtml(r, i)).join('')
            : `<p class="exam-empty exam-error">No exam of this course was taken with the exam ID <strong>${escapeHtml(code)}</strong>. Check it and try again.</p>`;
    } catch (error) {
        results.innerHTML = `<p class="exam-empty exam-error">Could not look up the grade: ${escapeHtml(error.message)}</p>`;
    } finally {
        button.disabled = false;
    }
}

function gradeRowHtml(r, index) {
    const graded = r.results_published && r.submission?.grades;
    const term = [r.course_semester, r.course_year].filter(Boolean).join(' ');
    return `<div class="exam-row">
        <span class="exam-row-icon"><i class="${EXAM_TYPES[r.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="exam-row-main">
            <div class="exam-row-title">${escapeHtml([r.course_code, examTitle(r)].filter(Boolean).join(' '))}</div>
            <div class="exam-row-meta">${term ? `<span>${escapeHtml(term)}</span>` : ''}${r.starts_at ? `<span><i class="fa-regular fa-calendar" aria-hidden="true"></i>${escapeHtml(formatWhen(r.starts_at))}</span>` : ''}</div>
        </div>
        <div class="exam-row-action">${graded
            ? `<span class="exam-chip exam-chip-grade">${escapeHtml(formatGrade(r.submission.grades.totalScore, r.submission.grades.maxScore, r.base))}</span>
               <button type="button" class="btn-sm btn-secondary" data-lookup-index="${index}"><i class="fa-solid fa-eye"></i> View</button>`
            : '<span class="exam-chip exam-chip-done" title="Your lecturer has not published the results yet"><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i>Not graded yet</span>'}</div>
    </div>`;
}

// The full result, question by question. From the sign-in card, the app screen opens for it.
function openLookupResult(e) {
    const btn = e.target.closest('[data-lookup-index]');
    const result = btn?.closest('.grade-results')?._results?.[Number(btn.dataset.lookupIndex)];
    if (!result) return;
    if (!currentUser) enterApp();
    renderResult(result);
}


// === Small form dialog ===
// The ×, Escape, Back and a click outside close it through js/dialogs.js, with closeModal.
let _modalSubmit = null;

function openModal({ title, body, okLabel = 'OK', okIcon = 'fa-check', okClass = '', onSubmit }) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = body + '<p class="exam-error modal-error" id="modal-error" hidden></p>';
    document.getElementById('modal-foot').innerHTML = `
        <button class="btn-sm ${okClass}" type="submit" id="modal-ok"><i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${escapeHtml(okLabel)}</button>`;
    _modalSubmit = onSubmit;
    document.getElementById('modal-overlay').classList.add('open');
    setTimeout(() => (document.querySelector('#modal-body input') || document.getElementById('modal-ok')).focus(), 50);
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
    _modalSubmit = null;
}
document.getElementById('modal-overlay')._close = closeModal;

// Runs the dialog's action; an error keeps it open with the message shown.
async function submitModal(e) {
    e.preventDefault();
    if (!_modalSubmit) return;
    const run = _modalSubmit;
    const ok = document.getElementById('modal-ok');
    const errorEl = document.getElementById('modal-error');
    const missing = [...document.querySelectorAll('#modal-body input[required]')].find(input => !input.value.trim());
    if (missing) { missing.focus(); return; }
    ok.disabled = true;
    errorEl.hidden = true;
    try {
        await run();
        if (_modalSubmit === run) closeModal(); // unless the action opened another dialog
    } catch (error) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
    } finally {
        ok.disabled = false;
    }
}


// === Formatting ===
function formatWhen(iso) {
    return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
}
function formatNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '';
}
// The grade on the exam's base (default 100): points scored out of the points available.
function formatGrade(score, max, base) {
    const total = parseFloat(score), available = parseFloat(max), scale = parseFloat(base) || 100;
    if (!Number.isFinite(total)) return 'Graded';
    return Number.isFinite(available) && available > 0
        ? `${formatNumber(total / available * scale)} / ${formatNumber(scale)}`
        : `${formatNumber(total)} / ${formatNumber(scale)}`;
}
// What the exam adds to the course grade: the grade's share of its weight.
function weightedContribution(score, max, base, weight) {
    const total = parseFloat(score), available = parseFloat(max), w = parseFloat(weight);
    if (!Number.isFinite(total) || !Number.isFinite(w)) return null;
    const fraction = Number.isFinite(available) && available > 0 ? total / available : total / (parseFloat(base) || 100);
    return fraction * w;
}
