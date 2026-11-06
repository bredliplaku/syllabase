/* ==========================================================================
   Syllatest — the student exam page (/exam/).

   Sign in with Google; with a student ID and the exam's password, to take that
   exam; or, for anonymous exams, with an exam ID and the exam's password.
   Signed-in students see their exams: what is open now and coming up, then
   their courses by academic year (and the archived ones), and read published
   results question by question. Anonymous exams' grades reach students through
   EIS and their answers through the lecturer: an exam ID is no secret, so it
   opens nothing here. Lecturers who sign in go on to exam/manage/.

   Load after ../js/config.js, js/common.js, js/store.js and js/taking.js.
   ========================================================================== */

// === App State ===
let currentUser = null;    // examStore.currentUser(): signed-in student, or null
let dash = null;           // The last exam_dashboard result
let teaching = null;       // teaching_access for a Google account that also teaches
// "Preview" in the course editor opens /exam/?preview=<exam id>: that exam, sent by the
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
    setupTopBar();
    updateOnlineStatus();
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    if (PREVIEW_EXAM) return bootPreview();

    // Answers waiting for the connection go now, and whenever it is back.
    startOutbox();
    let saved = readExamState();
    // A saved exam past its end is not opened again: its answers go as they were.
    if (saved && saved.examEndTime <= Date.now()) {
        const name = saved.examDetails.Name;
        queueSavedExam(saved);
        saved = null;
        flushOutbox();
        showImprovedNotification('info', 'Sending Your Answers', `${name} has ended. The answers saved on this computer are being sent.`, 8000);
    }
    try { currentUser = await examStore.currentUser(); } catch (e) { console.warn('Could not read the sign-in.', e); }
    // Drop the sign-in's fragment, or the bare "#" the Supabase library leaves of it, so the
    // address is clean and a reload doesn't try to consume it again.
    if (examStore.returnedFromSignIn) {
        if (currentUser) noteActive(true); // just signed in with Google
    }
    if (examStore.returnedFromSignIn || location.href.endsWith('#') || /access_token|error/.test(location.hash)) {
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
    if (currentUser.via === 'google' && !saved && (await routeLecturer())) return;
    enterApp();
    if (manageRefused) showImprovedNotification('error', manageRefused[0], manageRefused[1], 0);
    if (!(await loadDashboard())) return;
    if (saved && ownsSavedExam(saved)) continueSavedExam(saved);
}

// A saved exam (a reload, a reboot, a lost connection): the server says where it stands first.
// Still taking answers: back where the student was, with what changed meanwhile (time,
// questions). No longer taking answers from the page: its answers go as they are. Submitted:
// not opened again. Open on another device: says so. No connection: it carries on here.
async function continueSavedExam(saved) {
    const d = saved.examDetails;
    let status = 'offline', info = null;
    try {
        info = await examStore.heartbeat(d.ExamId, d.Kind === 'anonymous' ? d.Token : null, null);
        status = info.exam;
    } catch (error) {
        if (!error.offline) status = 'unknown';
    }
    if (status === 'submitted') {
        clearSavedExam();
        showImprovedNotification('info', 'Already Submitted', `${d.Name} has been submitted.`, 8000);
        return backToDashboard();
    }
    if (status === 'closed') {
        queueSavedExam(saved);
        flushOutbox();
        showImprovedNotification('info', 'Sending Your Answers', `${d.Name} no longer takes answers on the page. The answers saved on this computer are being sent.`, 8000);
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
    document.getElementById('signout-btn').addEventListener('click', handleSignoutClick);
    submitExamBtn.addEventListener('click', () => handleSubmitExam(false));
    const courses = document.getElementById('dash-courses');
    courses.addEventListener('click', handleDashboardClick);
    // The groups remember being open or folded (toggle doesn't bubble).
    courses.addEventListener('toggle', e => {
        if (e.target.matches?.('details[data-group]')) rememberGroup(e.target.dataset.group, e.target.open);
    }, true);
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

// The top bar: the page's name, or Back to the dashboard from a result; Manage exams for a
// lecturer who is also a student. It blends with the page until the page scrolls under it.
function setupTopBar() {
    document.getElementById('top-back').addEventListener('click', () => backToDashboard());
    document.getElementById('manage-btn').addEventListener('click', goManage);
    const bar = document.querySelector('#admin-app .top-bar');
    const onScroll = () => bar.classList.toggle('is-scrolled', window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
}

// The views inside the app: dashboard, exam, result, message and done.
function showView(name) {
    document.querySelectorAll('.exam-view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
    examQuestionsModule.classList.toggle('hidden', name !== 'exam');
    examCat.toggle(name === 'exam');
    const back = name === 'result' && (!!currentUser || !!dash);
    document.getElementById('top-back').hidden = !back;
    document.querySelector('.top-bar-title').hidden = back;
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
    document.getElementById('manage-btn').hidden = !teaching || !!examDetails;
    if (PREVIEW_EXAM) {
        document.querySelector('#signout-btn .signout-text').textContent = 'Close';
        document.getElementById('top-user').innerHTML = '<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-eye"></i></span><span>Preview</span>';
        return;
    }
    // Not signed in: an anonymous exam.
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
            ? 'Leave the exam? Your answers stay on this device. To continue before it ends, sign in again with your exam ID and the exam password.'
            : 'Sign out during the exam? Your answers stay on this device. To continue before it ends, sign in again.',
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
    teaching = null;
    showView('dashboard');
    showScreen('login');
}


// === Lecturers ===
// A lecturer (anyone the course editor lets in) who signs in with Google here manages exams in
// exam/manage/: the course editor's Exams, Grading and Students tabs. Someone who also is on a
// class list (an assistant who studies) sees their dashboard, with Manage exams in the top bar.
// Sent here from exam/manage/ (?manage) without teaching access, a student is told so, on their
// own dashboard.
let manageRefused = null;
async function routeLecturer() {
    const access = await examStore.teachingAccess();
    teaching = access || null;
    const fromManage = new URLSearchParams(location.search).has('manage');
    if (fromManage) history.replaceState(history.state, '', location.pathname);
    if (!teaching) {
        if (fromManage) manageRefused = access === false
            ? ['Could Not Check Your Access', 'Managing exams needs a connection to check that you teach. Try again in a moment.']
            : ['No Access', `Managing exams is only for lecturers. ${currentUser?.email || 'This account'} is signed in as a student.`];
        return false;
    }
    if (!fromManage) {
        try { dash = await examStore.dashboard(); } catch { dash = null; }
        if (dash?.courses?.length) return false;
    }
    goManage();
    return true;
}

function goManage() {
    examStore.handOverSession();
    location.replace(new URL('manage/', location.href).href);
}


// === Staying signed in: one device, check-ins, idle sign-out ===
// Every 30 seconds while signed in with a student ID or taking an exam, the page checks in
// (exam_heartbeat): the Student ID sign-in lasts 30 minutes past the last check-in (and while
// an exam runs, until it ends), and the exam stays on this device with the answers so far, so
// another computer can carry on if this one breaks down. The answer also says when the sign-in
// is over, or the exam was taken over by another device or submitted, and the exam's end and
// questions as they are now (the lecturer may have changed them).
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
    if (result.session_until) examStore.extendStudentSession(result.session_until);
    if (d && examDetails === d) {
        if (result.exam === 'elsewhere') return examTakenElsewhere(d);
        if (result.exam === 'submitted') return submissionDone(d);
        if (result.exam === 'ok') catchUpWithServer(result);
    }
    if (studentId && currentUser?.via === 'student_id' && result.signed_in === false) {
        await signedOutByServer(examDetails ? 'Sign in again to continue your exam.' : null);
    }
}

// Another device has the exam now (this one was silent for 2 minutes): it stops here.
function examTakenElsewhere(details) {
    examIntegrity.stop();
    finishExamSession();
    showImprovedNotification('error', 'Open on Another Device', `${details.Name} is now open on another device, and carries on there.`, 0);
    backToDashboard();
}

// The Student ID sign-in is over (30 minutes without a check-in outside an exam, or another
// device signed in): back to the sign-in card. An exam in progress stays saved on the device,
// and only then is there something to say (message): how to carry on.
async function signedOutByServer(message = null) {
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
    if (message) showImprovedNotification('warning', 'Sign In to Continue', message, 0);
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
        await signedOutByServer();
        return false;
    }
    renderDashboard();
    return true;
}

// Each group opened or folded as the student left it, kept in this browser. Until then the
// academic years (the courses running now) are open and the archived courses folded.
const GROUPS_KEY = 'examDashboardGroups';
try { localStorage.removeItem('examDashboardOpen'); } catch { } // the earlier list of opened groups
function groupStates() {
    try {
        const states = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}');
        return states && typeof states === 'object' && !Array.isArray(states) ? states : {};
    } catch { return {}; }
}
function isGroupOpen(id, archived) {
    const state = groupStates()[id];
    return typeof state === 'boolean' ? state : !archived;
}
function rememberGroup(id, open) {
    const states = groupStates();
    states[id] = open;
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(states)); } catch { }
}

// An exam without questions is held on paper (it is only scheduled here): it shows once its
// grade is out.
const shownExams = course => course.exams.filter(e => e.question_count > 0 || (e.results_published && e.score != null));
const SEMESTER_ORDER = ['fall', 'spring', 'summer'];
const semesterRank = course => { const i = SEMESTER_ORDER.findIndex(s => String(course.semester || '').toLowerCase().startsWith(s)); return i < 0 ? 9 : i; };
const isYear = label => /\d{4}/.test(label);

// First what needs doing (exams open now, then the next ones); then the courses by academic
// year, newest first (open), and the archived ones (folded).
function renderDashboard() {
    const student = dash.courses.find(c => c.student)?.student;
    const name = student?.name || currentUser?.name || '';
    document.getElementById('dash-sub').textContent = [name, student?.student_no].filter(Boolean).join(' · ');
    const box = document.getElementById('dash-courses');
    if (!dash.courses.length) {
        box.innerHTML = `<div class="settings-group"><div class="settings-body exam-empty">
            <i class="fa-solid fa-user-slash" aria-hidden="true"></i>
            <p>${currentUser?.via === 'google'
                ? `${escapeHtml(dash.email || 'This account')} is not on any course's class list yet.`
                : 'No courses found for this sign-in.'}</p>
            <p class="form-hint">Your lecturer adds you with the class list. Sign in with the email on it.</p>
        </div></div>`;
        return;
    }
    const now = Date.now();
    const items = dash.courses.flatMap(course => shownExams(course).map(exam => ({ exam, course })));
    const waiting = items.filter(({ exam, course }) => !course.archived && !exam.submitted_at);
    const open = waiting.filter(({ exam }) => exam.is_open);
    const upcoming = waiting.filter(({ exam }) => !exam.is_open && exam.starts_at && Date.parse(exam.starts_at) > now)
        .sort((a, b) => Date.parse(a.exam.starts_at) - Date.parse(b.exam.starts_at));
    let html = '';
    if (open.length) html += focusPanelHtml('Open now', 'fa-solid fa-circle-play', open, 'is-open');
    if (upcoming.length) html += focusPanelHtml('Coming up', 'fa-regular fa-calendar', upcoming);

    const years = new Map();
    for (const course of dash.courses.filter(c => !c.archived)) {
        const year = course.year || 'Other courses';
        if (!years.has(year)) years.set(year, []);
        years.get(year).push(course);
    }
    const sortCourses = list => list.slice().sort((a, b) => semesterRank(a) - semesterRank(b) || String(a.code || '').localeCompare(String(b.code || '')));
    [...years.keys()].sort((a, b) => (isYear(b) - isYear(a)) || b.localeCompare(a))
        .forEach(year => { html += groupHtml(`year:${year}`, year, sortCourses(years.get(year))); });
    const past = dash.courses.filter(c => c.archived)
        .sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')) || semesterRank(b) - semesterRank(a));
    if (past.length) html += groupHtml('archived', 'Archived courses', past, true);
    // A Student ID sign-in covers only the course of the exam whose password was used.
    if (dash.signed_in_by === 'student_id') {
        html += '<p class="form-hint dash-hint"><i class="fa-brands fa-google" aria-hidden="true"></i><span>Sign in with Google to see your other courses.</span></p>';
    }
    box.innerHTML = html;
}

// "Open now" and "Coming up": across courses, so each row names its course.
function focusPanelHtml(title, icon, items, className = '') {
    return `<section class="settings-group dash-focus ${className}">
        <div class="settings-head"><span><i class="${icon}" aria-hidden="true"></i>${escapeHtml(title)}</span><span class="dash-count">${items.length}</span></div>
        <div class="exam-list">${items.map(({ exam, course }) => examRowHtml(exam, course, true)).join('')}</div>
    </section>`;
}

function groupHtml(id, label, courses, archived = false) {
    const graded = courses.reduce((n, c) => n + shownExams(c).filter(e => e.results_published && e.score != null).length, 0);
    const count = `${courses.length} course${courses.length === 1 ? '' : 's'}${graded ? `, ${graded} grade${graded === 1 ? '' : 's'}` : ''}`;
    return `<details class="dash-group${archived ? ' is-archived' : ''}" data-group="${escapeHtml(id)}"${isGroupOpen(id, archived) ? ' open' : ''}>
        <summary class="dash-group-head">
            <span class="dash-group-title">${escapeHtml(label)}</span>
            <span class="dash-group-count">${escapeHtml(count)}</span>
            <span class="dash-group-rule" aria-hidden="true"></span>
            <i class="fa-solid fa-chevron-down dash-group-chevron" aria-hidden="true"></i>
        </summary>
        <div class="dash-group-body">${courses.map(courseCardHtml).join('')}</div>
    </details>`;
}

function courseCardHtml(course) {
    const exams = shownExams(course);
    return `<section class="settings-group course-card${course.archived ? ' is-past' : ''}" data-sheet="${escapeHtml(course.sheet_name)}">
        <div class="course-card-head">
            <span class="course-card-code">${escapeHtml(course.code || course.sheet_name)}</span>
            <span class="course-card-title">${escapeHtml(course.title || '')}</span>
            ${course.semester ? `<span class="course-card-term">${escapeHtml(course.semester.replace(/\s+semester$/i, ''))}</span>` : ''}
        </div>
        <div class="exam-list">
            ${exams.length ? exams.map(exam => examRowHtml(exam, course)).join('')
            : `<p class="exam-empty">${course.exams.length ? 'Its exams are held in class.' : 'No exams scheduled yet.'}</p>`}
        </div>
    </section>`;
}

function examRowHtml(exam, course = {}, withCourse = false) {
    const meta = [];
    // A date without a time (an exam on paper whose time is not set yet): the date alone.
    if (exam.starts_at) meta.push(escapeHtml(exam.settings?.date_only ? formatDate(exam.starts_at) : formatWhen(exam.starts_at)));
    if (exam.duration_minutes) meta.push(`${exam.duration_minutes} min`);
    if (exam.hall) meta.push(escapeHtml(exam.hall));
    if (exam.weight != null) meta.push(`${formatNumber(exam.weight)}% of the grade`);
    if (exam.question_count && !exam.submitted_at && !course.archived) {
        meta.push(exam.sign_in === 'google' ? 'Google sign-in' : exam.sign_in === 'anonymous' ? 'Exam ID' : 'Student ID sign-in');
    }
    const title = withCourse ? `${escapeHtml(course.code || course.sheet_name)} <span class="exam-row-sep">·</span> ${escapeHtml(examTitle(exam))}` : escapeHtml(examTitle(exam));
    // The type, unless the label says it already ("Quiz 2").
    const type = exam.label && !exam.label.toLowerCase().includes(typeLabel(exam.type).toLowerCase()) ? typeLabel(exam.type) : '';
    return `<div class="exam-row" data-exam-id="${escapeHtml(exam.id)}">
        <div class="exam-row-main">
            <div class="exam-row-title">${title}${type ? `<span class="exam-row-type">${escapeHtml(type)}</span>` : ''}</div>
            ${meta.length ? `<div class="exam-row-meta">${meta.join('<span class="exam-row-sep">·</span>')}</div>` : ''}
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
        if (starts && starts > now) return '<span class="exam-chip">Upcoming</span>';
        return `<span class="exam-chip" title="Anonymous: your grade reaches you through EIS, and your answers through your lecturer"><i class="fa-solid fa-user-secret" aria-hidden="true"></i>Grade in EIS</span>`;
    }
    if (exam.results_published && exam.score != null) {
        const grade = `<span class="exam-chip exam-chip-grade">${escapeHtml(formatGrade(exam.score, exam.max_score, exam.base))}</span>`;
        return exam.question_count ? `${grade}<button type="button" class="btn-sm btn-secondary" data-action="result"><i class="fa-solid fa-eye"></i> View</button>` : grade;
    }
    if (exam.submitted_at) return `<span class="exam-chip exam-chip-done"><i class="fa-solid fa-check" aria-hidden="true"></i>Submitted</span>`;
    if (archived) return exam.question_count ? '<span class="exam-chip exam-chip-missed">Not taken</span>' : '';
    if (!exam.question_count) return starts && starts > now ? '<span class="exam-chip">Upcoming</span>' : '';
    // Each named exam takes one way of signing in: Google, or the student ID and exam password.
    if (exam.is_open && dash?.signed_in_by && exam.sign_in !== dash.signed_in_by) {
        return exam.sign_in === 'google'
            ? '<span class="exam-chip exam-chip-missed" title="Sign out, then sign in with Google to start it"><i class="fa-brands fa-google" aria-hidden="true"></i>Needs Google sign-in</span>'
            : '<span class="exam-chip exam-chip-missed" title="Sign out, then sign in with your student ID and the exam password to start it"><i class="fa-solid fa-id-card" aria-hidden="true"></i>Needs student ID sign-in</span>';
    }
    if (exam.is_open && exam.returned) return `<button type="button" class="btn-sm btn-green" data-action="start" title="Your lecturer handed your exam back"><i class="fa-solid fa-rotate-left"></i> Continue</button>`;
    if (exam.is_open) return `<button type="button" class="btn-sm btn-green" data-action="start"><i class="fa-solid fa-play"></i> Start</button>`;
    if (exam.returned) return '<span class="exam-chip" title="Your lecturer handed your exam back: you can continue while it is open">Handed back</span>';
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
        title: `${exam.returned ? 'Continue' : 'Start'} ${examTitle(exam)}`,
        body: `${exam.returned ? '<p>Your lecturer handed your exam back: your answers are where you left them. Check them, then submit again.</p>' : ''}
            <p>The exam ends at <strong>${escapeHtml(formatTime(exam.ends_at))}</strong>${exam.duration_minutes && !exam.returned ? ` (${exam.duration_minutes} minutes from its start)` : ''}. The timer keeps running once you start.</p>
            <p>${escapeHtml(leaveRule(exam.settings))}</p>
            <p class="form-hint">${RECORDED_NOTE}</p>
            ${exam.has_password && !exam.password_entered ? `<div class="form-group"><label class="form-label" for="modal-password">Exam password</label>
                <input type="password" id="modal-password" autocomplete="off" required></div>` : ''}`,
        okLabel: exam.returned ? 'Continue' : 'Start', okIcon: exam.returned ? 'fa-rotate-left' : 'fa-play', okClass: 'btn-green',
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
    if (settings.leave === 'record') return 'Each time you leave this page (clicking outside the window, another tab or program, minimising the browser) is recorded for your lecturer.';
    const seconds = settings.cooldown_seconds || 15;
    return `Stay on this page: if you leave it (clicking outside the window, another tab or program, minimising the browser), the exam locks for ${seconds} seconds each time you come back, and your lecturer sees each time.`;
}

// From the dashboard: an open anonymous exam still starts with the exam ID and its password.
function openAnonymousDialog(exam) {
    openModal({
        title: examTitle(exam),
        body: `<p>This exam is anonymous: sign in to it with the exam ID from your attendance sheet. It is never linked to your account.</p>
            <p>${escapeHtml(leaveRule(exam.settings))}</p>
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
            if (payload.submit_key) saved.examDetails.SubmitKey = payload.submit_key;
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
        Version: payload.version || null,
        SubmitKey: payload.submit_key || null,
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
    renderTopBar();
    displayQuestions(examDetails.Questions);
    // Started before on a computer that broke down, or handed back by the lecturer: carry on
    // from what was saved (moved to where its questions are now).
    const draft = payload.draft && typeof payload.draft === 'object' ? payload.draft : null;
    if (draft) {
        const progress = remapProgress(draft, payload.questions || []);
        applyProgress(progress.answers, progress.confirmations);
    }
    startIntegrity(draft?.integrity || null, draft && !payload.returned ? payload.draft_at : null);
    saveExamState(); // after displayQuestions, which fixes the question order
    autoSaveAnswers();
    startTimer();
    checkAllConfirmed();
    loadExamImages(kind === 'preview' ? payload.images : null);
    if (payload.returned) showImprovedNotification('info', 'Handed Back', 'Your lecturer handed your exam back: your answers are where you left them. Check them, then submit again.', 0);
    else if (draft) showImprovedNotification('info', 'Carrying On', 'Your answers so far, from the other computer, are back.', 8000);
}

// After a reload: back as it was saved here, then the exam as it is now (its time, its questions).
function resumeExam(saved) {
    fillExamHeader(saved.examDetails);
    showView('exam');
    restoreExam(saved);
    startIntegrity(saved.integrity);
    renderTopBar();
    loadExamImages();
    catchUpWithServer();
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

// Ends a sign-in once its exam is over, so the next student at this computer starts afresh.
async function signOutAfterExam() {
    if (!currentUser) return false;
    await examStore.signOut();
    currentUser = null;
    dash = null;
    teaching = null;
    return true;
}

// Called by taking.js once the submission is in.
async function onExamSubmitted(exam) {
    showImprovedNotification('success', 'Exam Submitted', 'Your submission has been sent.', 0);
    const signedOut = await signOutAfterExam();
    document.getElementById('done-title').textContent = 'Exam submitted';
    document.getElementById('done-text').innerHTML = doneText(exam, signedOut);
    showDone();
}

function doneText(exam, signedOut) {
    const after = signedOut ? ' You have been signed out, so the next student can use this computer.' : '';
    return exam.Kind === 'anonymous'
        ? `Your answers have been sent, and a backup file was saved to your downloads. Your exam ID, <strong>${escapeHtml(exam.ExamCode)}</strong>, was never linked to you:
           your grade reaches you through EIS once your lecturer enters it, and to see your answers, visit your lecturer.`
        : `Your answers have been sent. A backup file was also saved to your downloads. Sign in once your lecturer releases the grades to see yours.${after}`;
}

function showDone() {
    document.getElementById('done-actions').innerHTML = '<button type="button" class="btn-sm" data-back><i class="fa-solid fa-check"></i> Done</button>';
    document.querySelector('#done-actions [data-back]').addEventListener('click', backToDashboard);
    renderTopBar();
    if (!currentUser) document.getElementById('top-user').innerHTML = '<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-user"></i></span><span>Signed out</span>';
    showView('done');
}

// Called by taking.js when the answers could not reach the server: they wait in the outbox,
// which sends them once the connection is back (this page, or Syllatest opened again here).
let queuedExam = null;
async function onSubmissionQueued(exam) {
    queuedExam = exam.ExamId;
    const signedOut = await signOutAfterExam();
    document.getElementById('done-title').textContent = 'Saved: waiting for the connection';
    document.getElementById('done-text').innerHTML = `There is no connection, so your answers to <strong>${escapeHtml(exam.Name)}</strong> are saved on this computer
        and sent as soon as it is back. A backup file was also saved to your downloads.
        <span class="done-note">If you have to close this page, open Syllatest on this computer again once it is online: the answers are sent then, until a day after the exam's end.${signedOut ? ' You have been signed out.' : ''}</span>`;
    document.getElementById('view-done').classList.add('is-waiting');
    showDone();
}

// Called by taking.js when the outbox has sent (or given up on) an exam's answers.
function outboxSettled(entry, how, message = '') {
    const waiting = queuedExam === entry.examId && !document.getElementById('view-done').hidden;
    if (how === 'sent') {
        showImprovedNotification('success', 'Answers Sent', `Your answers to ${entry.name} have been sent.`, 0);
        if (waiting) {
            document.getElementById('view-done').classList.remove('is-waiting');
            document.getElementById('done-title').textContent = 'Exam submitted';
            document.getElementById('done-text').innerHTML = doneText({ Kind: entry.kind, ExamCode: entry.examCode }, false);
        }
    } else {
        showImprovedNotification('error', 'Answers Not Sent', `Your answers to ${entry.name} could not be sent (${String(message).replace(/\.$/, '')}). Give your lecturer the backup file from your downloads.`, 0);
        if (waiting) {
            document.getElementById('done-title').textContent = 'Your answers could not be sent';
            document.getElementById('done-text').textContent = `${message}. A backup file of your answers was saved to your downloads: give it to your lecturer.`;
        }
    }
    if (how === 'sent' && queuedExam === entry.examId) queuedExam = null;
}


// === Preview ("Preview" in the course editor) ===
// The editor's tab opened this one, and answers its request with the exam: the questions as
// they are in the editor, without the answers. The timer starts now; files are checked but not
// uploaded; nothing is saved on this device or sent, and a reload starts again.
function bootPreview() {
    showScreen('app');
    renderTopBar();
    showMessage({ icon: 'fa-solid fa-eye', title: 'Opening the preview', text: 'Getting the exam from the course editor…' });
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
    showMessage({ icon: 'fa-solid fa-eye', title: 'The preview could not open',
        text: 'Open it again with Preview in the Exams tab, and keep that tab open.' });
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

// Called by taking.js instead of sending: what would have been sent to the lecturer.
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
        actions: `<button type="button" class="btn-sm btn-secondary" id="preview-close"><i class="fa-solid fa-xmark"></i> Close</button>
            <button type="button" class="btn-sm btn-green" id="preview-again"><i class="fa-solid fa-rotate-right"></i> Try again</button>`,
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

// The header is one line of facts under the exam's name; the grade and feedback follow.
function renderResult(result) {
    const grades = result.submission?.grades || null;
    document.getElementById('result-course').textContent = [result.course_code, result.course_title].filter(Boolean).join(' · ');
    document.getElementById('result-title').textContent = examTitle(result);
    const facts = [escapeHtml(typeLabel(result.type))];
    if (result.starts_at) facts.push(escapeHtml(formatDay(result.starts_at)));
    document.getElementById('result-info').innerHTML = facts.join('<span class="exam-row-sep">·</span>');

    const body = document.getElementById('result-body');
    if (!result.submission) {
        body.innerHTML = '<div class="settings-group"><div class="settings-body exam-empty"><p>No submission was recorded for this exam.</p></div></div>';
        showView('result');
        return;
    }
    // The grade and the feedback. The questions, the answers and each question's points stay
    // with the lecturer: the student sees them in person.
    const graded = grades && Number.isFinite(parseFloat(grades.totalScore));
    const contribution = graded ? weightedContribution(grades.totalScore, grades.maxScore, result.base, result.weight) : null;
    let html = `<div class="settings-group result-grade">
        <div class="result-grade-main">
            <span class="result-grade-label">Grade</span>
            <span class="result-grade-value">${graded ? escapeHtml(formatGrade(grades.totalScore, grades.maxScore, result.base)) : 'Not graded'}</span>
            ${contribution != null ? `<span class="result-grade-share"><strong>${formatNumber(contribution)}</strong> of ${formatNumber(result.weight)}% of the course grade</span>` : ''}
        </div>
        ${grades?.feedback ? `<div class="result-feedback"><span class="result-grade-label">Feedback</span><p>${escapeHtml(grades.feedback).replace(/\n/g, '<br>')}</p></div>` : ''}
    </div>
    <p class="form-hint result-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>The questions and your answers are not shown here. To go through them, meet your lecturer.</span></p>`;
    body.innerHTML = html;
    showView('result');
}


// An answer as text (the preview's list of what was answered).
function answerHtml(answer, type) {
    if (answer === '[NOT CONFIRMED]') return '<em>Not confirmed, so not sent</em>';
    if (answer == null || answer === '') return '<em>No answer</em>';
    if (type === 'attachment' && typeof answer === 'object') return `<em>File:</em> ${escapeHtml(answer.name || '')} (${formatBytes(answer.size)})`;
    const text = String(answer);
    if (type === 'code') return `<pre class="result-code">${escapeHtml(text)}</pre>`;
    return escapeHtml(text).replace(/\n/g, '<br>');
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
function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function formatDay(iso) {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
