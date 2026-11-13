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
// A group as students read it: a letter or number alone as "Group A", "Group 2"; a name as it is
// ("Lab 1"), never "Group Lab 1". (The editor's groupLabel, js/course-exams.js.)
const groupLabel = g => { const name = String(g ?? '').trim(); return /^[\p{L}\p{N}]{1,3}$/u.test(name) ? `Group ${name}` : name; };


// === Initialisation ===
// Page chrome first, so the theme toggle and footer are right before sign-in resolves.
applyThemeDefaults();
applyOwnerBranding();
setupThemeToggle();

// As soon as the page is read (the scripts are at its end), not after every image and font: on a
// slow connection the exam page comes up sooner.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

async function boot() {
    setupEventListeners();
    setupSessionManagement();
    setupBackupImportFeature();
    setupTopBar();
    updateOnlineStatus();
    window.addEventListener('online', () => { updateOnlineStatus(); heartbeatSoon(); });
    window.addEventListener('offline', updateOnlineStatus);
    examStore.onReachable(updateOnlineStatus);
    if (PREVIEW_EXAM) return bootPreview();

    // Answers waiting for the connection go now, and whenever it is back.
    startOutbox();
    let saved = readExamState();
    // A saved exam past its end is not opened again: its answers go as they were.
    if (saved && saved.examEndTime <= examStore.now()) {
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
// not opened again. Taken on another computer: says so (only the lecturer can let it move
// back). No connection: it carries on here.
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
    // The lecturer handed it back as a new paper meanwhile: the saved one (the old questions and
    // answers) goes, and the new one starts afresh.
    if (status === 'ok' && (info?.paper || 0) !== (d.Paper || 0)) {
        clearSavedExam();
        showImprovedNotification('info', 'A New Paper', `Your lecturer gave you a new paper for ${d.Name}: new questions, in a new order. Start it ${d.Kind === 'anonymous' ? 'with your exam ID and the exam password' : 'from your exams'}.`, 0);
        if (d.Kind === 'anonymous') { showScreen('login'); return; }
        return backToDashboard();
    }
    if (status === 'elsewhere') {
        showImprovedNotification('error', 'On Another Computer',
            `${d.Name} is being taken on another computer. To carry on here, ask your lecturer to let you continue on this computer, then reload this page.`, 0);
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
    // The dashboard has each course's colours on its own card; an exam or a result, the page.
    if (name === 'dashboard') courseColour.apply(document.documentElement, null);
    // During an exam the top bar has the exam's name, the timer and Sign out only.
    const taking = name === 'exam';
    document.body.classList.toggle('is-taking', taking);
    examCat.toggle(taking);
    document.getElementById('top-exam').hidden = !taking;
    const back = name === 'result' && (!!currentUser || !!dash);
    document.getElementById('top-back').hidden = !back;
    document.querySelector('.top-bar-title').hidden = back || taking;
    if (!taking) hideTimer();
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
        const session = await examStore.signInWithStudentId(document.getElementById('signin-student-no').value,
            document.getElementById('signin-student-password').value);
        form.reset();
        currentUser = await examStore.currentUser();
        noteActive(true);
        enterApp();
        if (!(await loadDashboard())) return;
        const saved = readExamState();
        if (saved && ownsSavedExam(saved)) return continueSavedExam(saved);
        // Signed in with an exam's password: that exam's Start, at once when it is open.
        const { exam } = findExam(dash.signed_in_exam || session?.exam_id);
        if (exam?.is_open && !exam.submitted_at) openStartDialog(exam);
    } catch (error) {
        const [title, message] = signInRefusal(error);
        showImprovedNotification('error', title, message);
    } finally {
        btn.disabled = false;
    }
}

// Why a Student ID sign-in was refused, as [title, message]. Not open yet: when it opens, and
// from when the password signs in (an hour before).
function signInRefusal(error) {
    const hint = String(error.hint || '');
    const opens = /^opens_at:(.+)$/.exec(hint);
    if (opens && Number.isFinite(Date.parse(opens[1]))) {
        const at = new Date(Date.parse(opens[1]));
        const day = at.toDateString() === new Date(examStore.now()).toDateString() ? '' : ` on ${formatDate(at.toISOString())}`;
        return ['Not Open Yet', `This exam starts at ${formatTime(at.toISOString())}${day}. You can sign in from ${formatTime(new Date(at.getTime() - 3600000).toISOString())}.`];
    }
    if (hint === 'exam_over') return ['Exam Over', 'This exam has ended, so its password no longer signs in. If you should still be able to take it, ask your lecturer.'];
    const groupOver = /^group_over:(.*)$/.exec(hint);
    if (groupOver) return ['Your Group\'s Time Is Over', `${groupLabel(groupOver[1])} took this exam at its own time, which is over. If you could not take it then, ask your lecturer to let you take it with another group.`];
    if (hint === 'submitted') return ['Already Submitted', 'You have submitted this exam, so its password no longer signs you in. Sign in with Google to see your grade once it is released.'];
    return ['Sign-in Failed', error.message];
}

// The app screen, with the top bar showing who is signed in (or that this is anonymous).
function enterApp() {
    clearNotifications(); // sign-in errors and the "sign in to continue" warning
    renderTopBar();
    showScreen('app');
}

function renderTopBar() {
    document.getElementById('manage-btn').hidden = !teaching || !!examDetails;
    const exam = document.getElementById('top-exam');
    exam.innerHTML = examDetails ? `${examDetails.Code ? `<span class="top-bar-exam-code">${escapeHtml(examDetails.Code)}</span>` : ''}<span class="top-bar-exam-name">${escapeHtml(examDetails.Name || '')}</span>` : '';
    if (PREVIEW_EXAM) {
        document.querySelector('#signout-btn .signout-text').textContent = 'Close';
        document.getElementById('top-user').innerHTML = '<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-eye"></i></span><span class="top-user-name">Preview</span>';
        return;
    }
    // Not signed in: an anonymous exam.
    const anonymous = !currentUser;
    document.querySelector('#signout-btn .signout-text').textContent = anonymous ? 'Leave' : 'Sign out';
    if (anonymous) {
        const topUser = document.getElementById('top-user');
        const code = examDetails?.ExamCode || '';
        topUser.innerHTML = `<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-user"></i></span><span class="top-user-name">${code ? `Exam ID ${escapeHtml(code)}` : 'Exam ID'}</span>`;
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
        hideTimer();
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
// another computer can carry on if this one breaks down (when the lecturer allows it). The
// answer also says when the sign-in is over, or the exam was taken over by another device or
// submitted, and the exam's end and questions as they are now (the lecturer may have changed
// them).
const HEARTBEAT_MS = 30 * 1000;
let heartbeatTimer = null, heartbeatSoonTimer = null;
// The draft is sent only when it changed since the last one that got through: on a slow
// connection, most check-ins are then a few bytes.
let draftSent = { exam: null, json: '' };
const forgetDraftSent = () => { draftSent = { exam: null, json: '' }; };

function startHeartbeat() {
    if (PREVIEW_EXAM || heartbeatTimer) return;
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}

// Soon after an answer is given or taken away, or a file uploaded, so the draft is up to date.
function heartbeatSoon() {
    clearTimeout(heartbeatSoonTimer);
    heartbeatSoonTimer = setTimeout(heartbeat, 2000);
}

async function heartbeat() {
    const d = examDetails && examDetails.Kind !== 'preview' && !examQuestionsModule.classList.contains('hidden') ? examDetails : null;
    const studentId = currentUser?.via === 'student_id';
    if (d) markExamAlive(); // even offline: the page is still here
    if (!d && !studentId) return;
    const draft = d ? examDraft() : null;
    const json = draft ? JSON.stringify(draft) : '';
    const send = draft && !(draftSent.exam === d.ExamId && draftSent.json === json) ? draft : null;
    let result;
    try {
        result = await examStore.heartbeat(d?.ExamId, d?.Kind === 'anonymous' ? d.Token : null, send);
    } catch {
        return; // no connection: the next one
    }
    if (send && result?.exam === 'ok') draftSent = { exam: d.ExamId, json };
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

// Another computer has the exam now (the lecturer let it move there): it stops here.
function examTakenElsewhere(details) {
    examIntegrity.stop();
    finishExamSession();
    showImprovedNotification('error', 'On Another Computer', `${details.Name} has moved to another computer, and carries on there.`, 0);
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
        hideTimer();
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

// First what needs doing (exams open now, then the next ones); then the courses running now, in
// one list, without the exams already above (each exam is on the page once: students asked
// which of two Starts to press); then the archived courses, folded.
function renderDashboard() {
    const student = dash.courses.find(c => c.student)?.student;
    const name = student?.name || currentUser?.name || '';
    document.getElementById('dash-sub').innerHTML = [name, student?.student_no].filter(Boolean)
        .map(part => `<span>${escapeHtml(part)}</span>`).join('');
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
    const now = examStore.now();
    const items = dash.courses.flatMap(course => shownExams(course).map(exam => ({ exam, course })));
    const waiting = items.filter(({ exam, course }) => !course.archived && !exam.submitted_at);
    const open = waiting.filter(({ exam }) => exam.is_open);
    const upcoming = waiting.filter(({ exam }) => !exam.is_open && exam.starts_at && Date.parse(exam.starts_at) > now)
        .sort((a, b) => Date.parse(a.exam.starts_at) - Date.parse(b.exam.starts_at));
    let html = '';
    if (open.length) html += focusPanelHtml('Open now', 'fa-solid fa-circle-play', open, 'is-open');
    if (upcoming.length) html += focusPanelHtml('Coming up', 'fa-regular fa-calendar', upcoming);

    const above = { open: new Set(open.map(({ exam }) => exam.id)), upcoming: new Set(upcoming.map(({ exam }) => exam.id)) };
    const yearOf = course => (isYear(course.year || '') ? parseInt(String(course.year).match(/\d{4}/)[0], 10) : -1);
    const current = dash.courses.filter(c => !c.archived).sort((a, b) => yearOf(b) - yearOf(a)
        || semesterRank(a) - semesterRank(b) || String(a.code || '').localeCompare(String(b.code || '')));
    if (current.length) {
        html += `<section class="dash-section" aria-labelledby="dash-current-title">
            <h2 class="dash-heading" id="dash-current-title"><span class="dash-group-title">Courses</span>
                <span class="dash-group-count">${escapeHtml(groupCount(current))}</span><span class="dash-group-rule" aria-hidden="true"></span></h2>
            <div class="dash-group-body">${current.map(course => courseCardHtml(course, above)).join('')}</div>
        </section>`;
    }
    const past = dash.courses.filter(c => c.archived)
        .sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')) || semesterRank(b) - semesterRank(a));
    if (past.length) html += groupHtml('archived', 'Archived courses', past, true);
    // A Student ID sign-in covers only the course of the exam whose password was used.
    if (dash.signed_in_by === 'student_id') {
        html += '<p class="form-hint dash-hint"><i class="fa-brands fa-google" aria-hidden="true"></i><span>Sign in with Google to see your other courses.</span></p>';
    }
    box.innerHTML = html;
    scheduleDashboardRefresh(upcoming.map(({ exam }) => exam));
}

// An exam starting within the next two hours: the dashboard asks again as it opens, so Start
// appears without a reload.
let dashboardRefresh = null;
function scheduleDashboardRefresh(upcoming) {
    clearTimeout(dashboardRefresh);
    const next = upcoming.map(exam => Date.parse(exam.starts_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const wait = next - examStore.now();
    if (!(wait > 0 && wait < 2 * 3600000)) return;
    dashboardRefresh = setTimeout(() => {
        if (currentUser && !examDetails && !document.getElementById('view-dashboard').hidden) loadDashboard();
    }, wait + 1500);
}

// "Open now" and "Coming up": across courses, so each row names its course (in its colour).
function focusPanelHtml(title, icon, items, className = '') {
    return `<section class="settings-group dash-focus ${className}">
        <div class="settings-head"><span><i class="${icon}" aria-hidden="true"></i>${escapeHtml(title)}</span><span class="dash-count">${items.length}</span></div>
        <div class="exam-list">${items.map(({ exam, course }) => examRowHtml(exam, course, true)).join('')}</div>
    </section>`;
}

// "3 courses, 2 grades".
function groupCount(courses) {
    const graded = courses.reduce((n, c) => n + shownExams(c).filter(e => e.results_published && e.score != null).length, 0);
    return `${courses.length} course${courses.length === 1 ? '' : 's'}${graded ? `, ${graded} grade${graded === 1 ? '' : 's'}` : ''}`;
}

function groupHtml(id, label, courses, archived = false) {
    return `<details class="dash-group${archived ? ' is-archived' : ''}" data-group="${escapeHtml(id)}"${isGroupOpen(id, archived) ? ' open' : ''}>
        <summary class="dash-group-head">
            <span class="dash-group-title">${escapeHtml(label)}</span>
            <span class="dash-group-count">${escapeHtml(groupCount(courses))}</span>
            <span class="dash-group-rule" aria-hidden="true"></span>
            <i class="fa-solid fa-chevron-down dash-group-chevron" aria-hidden="true"></i>
        </summary>
        <div class="dash-group-body">${courses.map(course => courseCardHtml(course)).join('')}</div>
    </details>`;
}

// The course's own colours, from the course or one of its exams (common.js courseColour).
const courseColours = course => course?.colours || course?.exams?.find(e => e.course_colours)?.course_colours || '';
const tintAttrs = colours => {
    const style = courseColour.style(colours);
    return style ? { cls: ' course-tinted', attr: ` style="${escapeHtml(style)}"` } : { cls: '', attr: '' };
};

// above: the exams already under Open now and Coming up, which the card leaves out.
function courseCardHtml(course, above = null) {
    const all = shownExams(course);
    const inOpen = all.some(e => above?.open.has(e.id)), inUpcoming = all.some(e => above?.upcoming.has(e.id));
    const exams = all.filter(e => !above?.open.has(e.id) && !above?.upcoming.has(e.id));
    const empty = inOpen || inUpcoming ? `See ${[inOpen && 'Open now', inUpcoming && 'Coming up'].filter(Boolean).join(' and ')} above.`
        : course.exams.length ? 'Its exams are held in class.' : 'No exams scheduled yet.';
    const tint = tintAttrs(courseColours(course));
    return `<section class="settings-group course-card${course.archived ? ' is-past' : ''}${tint.cls}" data-sheet="${escapeHtml(course.sheet_name)}"${tint.attr}>
        <div class="course-card-head">
            <span class="course-card-code">${escapeHtml(course.code || course.sheet_name)}</span>
            <span class="course-card-title">${escapeHtml(course.title || '')}</span>
            ${course.student?.group && all.some(e => e.group || e.for_group) ? `<span class="course-card-group" title="Your group in this course: you take its exams at your group's time"><i class="fa-solid fa-users" aria-hidden="true"></i>${escapeHtml(groupLabel(course.student.group))}</span>` : ''}
            ${course.semester ? `<span class="course-card-term">${escapeHtml(course.semester.replace(/\s+semester$/i, ''))}</span>` : ''}
        </div>
        <div class="exam-list">
            ${exams.length ? exams.map(exam => examRowHtml(exam, course)).join('') : `<p class="exam-empty">${escapeHtml(empty)}</p>`}
        </div>
    </section>`;
}

function examRowHtml(exam, course = {}, withCourse = false) {
    const meta = [];
    // A date without a time (an exam on paper whose time is not set yet): the date alone. Taken
    // in turns: the student's own group's time.
    if (exam.starts_at) meta.push(escapeHtml(exam.settings?.date_only ? formatDate(exam.starts_at) : formatWhen(exam.starts_at)));
    if (exam.group || exam.for_group) meta.push(escapeHtml(groupLabel(exam.group || exam.for_group)));
    if (exam.duration_minutes) meta.push(`${exam.duration_minutes} min`);
    if (exam.hall) meta.push(escapeHtml(exam.hall));
    if (exam.weight != null) meta.push(`${formatNumber(exam.weight)}% of the grade`);
    if (exam.question_count && !exam.submitted_at && !course.archived) {
        meta.push(exam.sign_in === 'google' ? 'Google sign-in' : exam.sign_in === 'anonymous' ? 'Exam ID' : 'Student ID sign-in');
    }
    const title = withCourse ? `<span class="exam-row-code">${escapeHtml(course.code || course.sheet_name)}</span>${escapeHtml(examTitle(exam))}` : escapeHtml(examTitle(exam));
    // The type, unless the label says it already ("Quiz 2").
    const type = exam.label && !exam.label.toLowerCase().includes(typeLabel(exam.type).toLowerCase()) ? typeLabel(exam.type) : '';
    const tint = withCourse ? tintAttrs(courseColours(course)) : { cls: '', attr: '' };
    return `<div class="exam-row${tint.cls}" data-exam-id="${escapeHtml(exam.id)}"${tint.attr}>
        <div class="exam-row-main">
            <div class="exam-row-title">${title}${type ? `<span class="exam-row-type">${escapeHtml(type)}</span>` : ''}</div>
            ${meta.length ? `<div class="exam-row-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}
        </div>
        <div class="exam-row-action">${examActionHtml(exam, course.archived)}</div>
    </div>`;
}

// What a student can do with an exam now, or where it stands. A past (archived) course's
// exams can't be started; their grades stay.
function examActionHtml(exam, archived = false) {
    const now = examStore.now();
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
    // A Student ID sign-in opens the one exam whose password it was made with.
    if (exam.is_open && dash?.signed_in_by === 'student_id' && dash.signed_in_exam && exam.id !== dash.signed_in_exam) {
        return '<span class="exam-chip exam-chip-missed" title="Sign out, then sign in with your student ID and this exam\'s password"><i class="fa-solid fa-key" aria-hidden="true"></i>Needs its own password</span>';
    }
    if (exam.is_open && exam.new_paper) return `<button type="button" class="btn-sm btn-green" data-action="start" title="Your lecturer gave you a new paper"><i class="fa-solid fa-play"></i> Start</button>`;
    if (exam.is_open && exam.returned) return `<button type="button" class="btn-sm btn-green" data-action="start" title="Your lecturer handed your exam back"><i class="fa-solid fa-rotate-left"></i> Continue</button>`;
    if (exam.is_open && exam.started) return `<button type="button" class="btn-sm btn-green" data-action="start" title="Carry on where you left off"><i class="fa-solid fa-play"></i> Continue</button>`;
    if (exam.is_open) return `<button type="button" class="btn-sm btn-green" data-action="start"><i class="fa-solid fa-play"></i> Start</button>`;
    if (exam.new_paper) return '<span class="exam-chip" title="Your lecturer gave you a new paper: you can take it while the exam is open">New paper</span>';
    if (exam.returned) return '<span class="exam-chip" title="Your lecturer handed your exam back: you can continue while it is open">Handed back</span>';
    // Today: when it opens (the dashboard asks again then, and Start appears).
    if (starts && starts > now) {
        const today = new Date(starts).toDateString() === new Date(now).toDateString();
        return `<span class="exam-chip">${today ? `Opens at ${escapeHtml(formatTime(exam.starts_at))}` : 'Upcoming'}</span>`;
    }
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
// Named exams: "Are you ready to start?", a short card as the countdown's: the minutes left in a
// ring, when it ends, what leaving does, and the exam password when it has one (not again when
// the student signed in with it). Handed back, or begun on another computer: "Are you ready to
// continue?", where they left off.
function openStartDialog(exam) {
    const { course } = findExam(exam.id);
    const continuing = !exam.new_paper && !!(exam.returned || exam.started);
    const ends = `<strong>${escapeHtml(formatTime(exam.ends_at))}</strong>`;
    const text = exam.new_paper ? `Your lecturer gave you a new paper: new questions, without your earlier answers. It ends at ${ends}.`
        : exam.returned ? `Your lecturer handed your exam back. You will continue where you left off, with your answers. It ends at ${ends}.`
        : continuing ? `You will continue where you left off, with your answers so far. It ends at ${ends}.`
        : `It ends at ${ends}. The time runs on once you start.`;
    openModal({
        variant: 'ready',
        colours: courseColours(course) || exam.course_colours,
        title: continuing ? 'Are you ready to continue?' : 'Are you ready to start?',
        body: readyCardHtml({
            exam, course, title: continuing ? 'Are you ready to continue?' : 'Are you ready to start?', text,
            fields: exam.has_password && !exam.password_entered ? `<div class="form-group"><label class="form-label" for="modal-password">Exam password</label>
                <input type="text" id="modal-password" class="secret-field" ${NOT_A_LOGIN} required></div>` : '',
        }),
        cancelLabel: 'Not yet',
        okLabel: continuing ? 'Continue' : 'Start', okIcon: exam.returned && !exam.new_paper ? 'fa-rotate-left' : 'fa-play', okClass: 'btn-green',
        onSubmit: async () => {
            const password = document.getElementById('modal-password')?.value || null;
            setSyncing(true);
            try {
                beginExam(await examStore.startExam(exam.id, password), 'named');
            } catch (error) {
                // Another group's turn now: when theirs is.
                const turn = /^group_time:(.*)\|(.+)$/.exec(String(error.hint || ''));
                if (turn && Number.isFinite(Date.parse(turn[2]))) {
                    const at = new Date(Date.parse(turn[2]));
                    const day = at.toDateString() === new Date(examStore.now()).toDateString() ? '' : ` on ${formatDate(at.toISOString())}`;
                    throw new Error(`Another group is taking this exam now. Yours, ${groupLabel(turn[1])}, takes it at ${formatTime(at.toISOString())}${day}.`);
                }
                throw error;
            } finally {
                setSyncing(false);
            }
        },
    });
}

// The exam password and the IDs are not an account's: no password field (password managers
// would offer to save and fill them, also for the next student at a shared computer), each
// manager's "ignore" mark, no autofill or spelling help. CSS masks the password (.secret-field).
const NOT_A_LOGIN = 'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"';

// What leaving the exam page does, in a line, as the exam's settings say (examIntegrity's
// defaults). The page of file questions, where leaving is allowed, says so itself (taking.js);
// what counts as leaving, the notice over the exam says when it happens (integrity.js).
function leaveRuleShort(settings = {}) {
    if (settings.leave === 'record') return 'Each time you leave this page is recorded for your lecturer.';
    return `Stay on this page: leaving it locks the exam for ${settings.cooldown_seconds || 15} seconds.`;
}

// The card before an exam (#modal-overlay.is-ready): the minutes left in a ring (to continue as
// much as to start: the exam ends at its time), the question, the exam, a line or two, the
// fields, and what is recorded.
const READY_RING = 2 * Math.PI * 54;
function readyCardHtml({ exam, course = null, title, text, fields = '' }) {
    const end = Date.parse(exam.ends_at), start = Date.parse(exam.starts_at);
    const span = (Number(exam.duration_minutes) || 0) * 60000 || (end - start) || 0;
    const left = Number.isFinite(end) ? Math.max(0, Math.min(end - examStore.now(), span || Infinity)) : NaN;
    const minutes = Number.isFinite(left) ? Math.max(1, Math.ceil(left / 60000)) : null;
    const share = minutes && span > 0 ? Math.min(1, left / span) : 1;
    const ring = minutes == null ? '<div class="ready-ring" aria-hidden="true"><i class="fa-solid fa-play"></i></div>'
        : `<div class="ready-ring" aria-hidden="true">
            <svg viewBox="0 0 120 120"><circle class="ready-track" cx="60" cy="60" r="54"></circle><circle class="ready-left" cx="60" cy="60" r="54" style="stroke-dashoffset: ${READY_RING}" data-offset="${(READY_RING * (1 - share)).toFixed(2)}"></circle></svg>
            <span class="ready-count${minutes >= 100 ? ' is-long' : ''}">${minutes}</span><span class="ready-unit">min left</span>
        </div>`;
    const of = [course?.code || exam.course_code, examTitle(exam)].filter(Boolean).map(escapeHtml).join(' · ');
    return `${ring}
        <h2 id="ready-title">${escapeHtml(title)}</h2>
        <p class="ready-exam">${of}</p>
        <p class="ready-text">${text}</p>
        <p>${escapeHtml(leaveRuleShort(exam.settings))}</p>
        ${fields}
        <p class="ready-note">Your IP address and device are recorded with your answers.</p>`;
}

// From the dashboard: an open anonymous exam still starts with the exam ID and its password.
function openAnonymousDialog(exam) {
    const { course } = findExam(exam.id);
    openModal({
        variant: 'ready',
        colours: courseColours(course) || exam.course_colours,
        title: 'Are you ready to start?',
        body: readyCardHtml({
            exam, course, title: 'Are you ready to start?',
            text: `It is anonymous: sign in to it with the exam ID from your attendance sheet, never linked to your account. It ends at <strong>${escapeHtml(formatTime(exam.ends_at))}</strong>.`,
            fields: `<div class="form-group"><label class="form-label" for="modal-code">Exam ID</label>
                <input type="text" id="modal-code" ${NOT_A_LOGIN} required></div>
            <div class="form-group"><label class="form-label" for="modal-password">Exam password</label>
                <input type="text" id="modal-password" class="secret-field" ${NOT_A_LOGIN} required></div>`,
        }),
        cancelLabel: 'Not yet',
        okLabel: 'Start', okIcon: 'fa-play', okClass: 'btn-green',
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
        if (saved?.examDetails.Kind === 'anonymous' && saved.examDetails.ExamId === payload.id && saved.examDetails.ExamCode === payload.exam_code
            && (saved.examDetails.Paper || 0) === (payload.paper || 0)) {
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
        StartsAt: Date.parse(payload.starts_at) || null, // the timer never shows more than the exam's length
        Kind: kind,
        Code: payload.course_code || '',
        CourseTitle: payload.course_title || '',
        Colours: payload.course_colours || '', // the course's theme colours: the page takes them
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
        // Which paper (0 the first; a new one when the lecturer hands it back as a new paper).
        Paper: payload.paper || 0,
        // A preview brings its own: each one is another student; so does a new paper.
        Seed: payload.seed || (kind === 'anonymous' ? payload.exam_code : (payload.student?.student_no || payload.student?.email || payload.student?.name)),
        Settings: payload.settings || {},
        // The page of an exam with file questions the student was on, on the computer that broke down.
        Page: payload.draft?.page === 'uploads' && !payload.returned ? 'uploads' : undefined,
        SignIn: payload.sign_in,
        Student: kind !== 'anonymous' ? payload.student : undefined,
        Token: kind === 'anonymous' ? payload.token : undefined,
        ExamCode: kind === 'anonymous' ? payload.exam_code : undefined,
    };
    examEndTime = Date.parse(payload.ends_at);
    forgetDraftSent();
    ensureResultSound();
    if (/"type":"code"/.test(examDetails.Questions)) ensureCodeMirror(); // the code editor, while the page draws
    fillExamHeader();
    showView('exam');
    renderTopBar();
    displayQuestions(examDetails.Questions);
    // Started before on a computer that broke down, or handed back by the lecturer: carry on
    // from what was saved (moved to where its questions are now).
    const draft = payload.draft && typeof payload.draft === 'object' ? payload.draft : null;
    if (draft) {
        const progress = remapProgress(draft, payload.questions || []);
        applyProgress(progress.answers);
    }
    startIntegrity(draft?.integrity || null, draft && !payload.returned ? payload.draft_at : null);
    saveExamState(); // after displayQuestions, which fixes the question order
    autoSaveAnswers();
    startTimer();
    checkAllAnswered();
    loadExamImages(kind === 'preview' ? payload.images : null);
    if (payload.returned && payload.paper > 0 && !draft) showImprovedNotification('info', 'A New Paper', 'Your lecturer gave you a new paper: new questions, in a new order.', 0);
    else if (payload.returned) showImprovedNotification('info', 'Handed Back', 'Your lecturer handed your exam back: your answers are where you left them. Check them, then submit again.', 0);
    else if (draft) showImprovedNotification('info', 'Carrying On', 'Your answers so far, from the other computer, are back.', 8000);
}

// After a reload: back as it was saved here, then the exam as it is now (its time, its questions).
function resumeExam(saved) {
    forgetDraftSent();
    ensureResultSound();
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
    // On the file uploads page (and in an exam of file questions only), leaving is allowed.
    examIntegrity.start({ settings: d.Settings, watermark, saved, movedSince, save: saveExamState, mode: leaveMode(), fullscreen: !examPages });
}

// A saved named exam belongs to whoever is signed in now (by email or student ID).
function ownsSavedExam(saved) {
    const student = saved.examDetails.Student || {};
    return (student.email && student.email === dash?.email) ||
        (dash?.courses || []).some(c => c.student?.student_no && c.student.student_no === student.student_no);
}

// The course (code and name) above the exam's name; nothing else. The page in the course's
// colours meanwhile.
function fillExamHeader(details = examDetails) {
    document.getElementById('exam-code-display').innerHTML = [details.Code, details.CourseTitle].filter(Boolean)
        .map(part => `<span>${escapeHtml(part)}</span>`).join('') || 'Syllatest';
    document.getElementById('exam-name-header').textContent = details.Name;
    courseColour.apply(document.documentElement, details.Colours);
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

// === After Submit: the result, plain to see ===
// Submitted: a big green check, and when. Not yet (no connection): it waits on this computer
// and goes as soon as it can, turning into the check then. Not submitted (refused): a red mark.
// While it is not in, an alarm sounds once and the student is told to stay where they are,
// not to close the page, and to call the lecturer (who can press Try again).
const doneView = () => document.getElementById('view-done');

function setResult(state, { title, text, note = '', actions = '' }) {
    const view = doneView();
    view.classList.toggle('is-waiting', state === 'waiting');
    view.classList.toggle('is-failed', state === 'failed');
    view.classList.toggle('is-ok', state === 'ok');
    // Again from the start: the mark pops in each time.
    const icon = view.querySelector('.done-icon');
    icon?.classList.remove('is-shown');
    void icon?.offsetWidth;
    icon?.classList.add('is-shown');
    document.getElementById('done-title').textContent = title;
    document.getElementById('done-text').innerHTML = text;
    document.getElementById('done-advice').innerHTML = note;
    document.getElementById('done-advice').hidden = !note;
    document.getElementById('done-actions').innerHTML = actions;
}

const STAY_NOTE = '<i class="fa-solid fa-hand" aria-hidden="true"></i><span><strong>Stay at this computer and call your lecturer.</strong> Do not close this page, reload it or turn the computer off.</span>';

function showDone() {
    renderTopBar();
    if (!currentUser) document.getElementById('top-user').innerHTML = '<span class="user-avatar" aria-hidden="true"><i class="fa-solid fa-user"></i></span><span>Signed out</span>';
    showView('done');
}

// The submitted screen's Done: back to the dashboard (or the sign-in card).
const DONE_BUTTON = '<button type="button" class="btn-sm" data-back><i class="fa-solid fa-check"></i> Done</button>';
document.getElementById('done-actions')?.addEventListener('click', e => {
    if (e.target.closest('[data-back]')) backToDashboard();
    else if (e.target.closest('[data-retry]')) retryFailedSubmission(e.target.closest('[data-retry]'));
});

// Called by taking.js once the submission is in.
async function onExamSubmitted(exam) {
    failedSubmission = null;
    const signedOut = await signOutAfterExam();
    setResult('ok', { title: exam.TimeUp ? 'Time is up: your exam was submitted' : 'Exam submitted', text: doneText(exam, signedOut), actions: DONE_BUTTON });
    showDone();
}

function doneText(exam, signedOut) {
    const at = `<span class="done-time">Received at ${escapeHtml(formatTime(new Date(examStore.now()).toISOString()))}.</span>`;
    const after = signedOut ? ' You have been signed out, so the next student can use this computer.' : '';
    return exam.Kind === 'anonymous'
        ? `${at} Your answers are with your lecturer, and a backup file was saved to your downloads. Your exam ID, <strong>${escapeHtml(exam.ExamCode)}</strong>, was never linked to you:
           your grade reaches you through EIS once your lecturer enters it, and to see your answers, visit your lecturer.`
        : `${at} Your answers are with your lecturer, and a backup file was saved to your downloads. Sign in once your lecturer releases the grades to see yours.${after}`;
}

// Called by taking.js when the answers could not reach the server: they wait in the outbox,
// which sends them once the connection is back (this page, or Syllatest opened again here).
let queuedExam = null;
async function onSubmissionQueued(exam) {
    queuedExam = exam.ExamId;
    const signedOut = await signOutAfterExam();
    setResult('waiting', {
        title: 'Not submitted yet: no connection',
        text: `Your answers to <strong>${escapeHtml(exam.Name)}</strong> have not reached your lecturer yet. They are saved on this computer, and in a backup file in your downloads, and are sent by themselves as soon as the connection is back.${signedOut ? ' You have been signed out.' : ''}`,
        note: STAY_NOTE,
    });
    showDone();
    playResultSound();
}

// Called by taking.js when the server refused the submission (not the connection): the answers
// stay on this computer, and Try again sends them as they are.
let failedSubmission = null;
async function onSubmissionFailed(exam, submission, message, endsAt) {
    failedSubmission = { exam, submission, endsAt };
    showFailed(exam, message);
    showDone();
    playResultSound();
}

// "This exam…" after a colon: "this exam…" (not "I…" or "EPOKA").
const lowerFirst = text => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

function showFailed(exam, message) {
    setResult('failed', {
        title: 'Not submitted',
        text: `Your answers to <strong>${escapeHtml(exam.Name)}</strong> could not be sent: ${escapeHtml(lowerFirst(String(message || 'the server refused them').replace(/\.$/, '')))}. They are safe: saved on this computer, and in a backup file in your downloads.`,
        note: STAY_NOTE,
        actions: '<button type="button" class="btn-sm btn-secondary" data-retry><i class="fa-solid fa-rotate-right"></i> Try again</button>',
    });
}

async function retryFailedSubmission(btn) {
    const failed = failedSubmission;
    if (!failed) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
    setSyncing(true);
    try {
        if (failed.exam.Kind === 'anonymous') await examStore.anonymousSubmit(failed.exam.Token, failed.submission);
        else await examStore.submitExam(failed.exam.ExamId, failed.submission);
    } catch (error) {
        setSyncing(false);
        if (/already submitted/i.test(error.message)) { clearSavedExam(); return onExamSubmitted(failed.exam); }
        if (error.offline) {
            queueSubmission(failed.exam, failed.submission, failed.endsAt);
            clearSavedExam();
            failedSubmission = null;
            return onSubmissionQueued(failed.exam);
        }
        showFailed(failed.exam, error.message);
        playResultSound();
        return;
    }
    setSyncing(false);
    clearSavedExam();
    onExamSubmitted(failed.exam);
}

// The alarm the lock uses (js/integrity.js), ready from the student's first press.
function ensureResultSound() { examIntegrity.readySound?.(); }
function playResultSound() { examIntegrity.alarm?.(); }

// Called by taking.js when the outbox has sent (or given up on) an exam's answers. On the
// waiting screen, the screen itself changes; anywhere else, a notification says so.
function outboxSettled(entry, how, message = '') {
    const waiting = queuedExam === entry.examId && !doneView().hidden;
    if (how === 'sent') {
        if (waiting) setResult('ok', { title: 'Exam submitted', text: doneText({ Kind: entry.kind, ExamCode: entry.examCode }, false), actions: DONE_BUTTON });
        else showImprovedNotification('success', 'Answers Sent', `Your answers to ${entry.name} have been sent.`, 0);
    } else if (waiting) {
        setResult('failed', {
            title: 'Not submitted',
            text: `Your answers to <strong>${escapeHtml(entry.name)}</strong> could not be sent: ${escapeHtml(String(message).replace(/\.$/, ''))}. A backup file of them is in your downloads.`,
            note: STAY_NOTE,
        });
        playResultSound();
    } else {
        showImprovedNotification('error', 'Answers Not Sent', `Your answers to ${entry.name} could not be sent (${String(message).replace(/\.$/, '')}). Give your lecturer the backup file from your downloads.`, 0);
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
    const start = examStore.now();
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
    courseColour.apply(document.documentElement, result.course_colours || courseColours(findExam(result.id).course));
    document.getElementById('result-course').innerHTML = [result.course_code, result.course_title].filter(Boolean)
        .map(part => `<span>${escapeHtml(part)}</span>`).join('');
    document.getElementById('result-title').textContent = examTitle(result);
    const facts = [escapeHtml(typeLabel(result.type))];
    if (result.starts_at) facts.push(escapeHtml(formatDay(result.starts_at)));
    document.getElementById('result-info').innerHTML = facts.map(f => `<span>${f}</span>`).join('');

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
    if (answer === '[NOT CONFIRMED]') return '<em>Not sent</em>';
    if (answer == null || answer === '') return '<em>No answer</em>';
    if (Array.isArray(answer)) return answer.some(v => String(v).trim()) ? answer.map(v => escapeHtml(String(v).trim() || '…')).join(', ') : '<em>No answer</em>';
    if (type === 'attachment' && typeof answer === 'object') return `<em>File:</em> ${escapeHtml(answer.name || '')} (${formatBytes(answer.size)})`;
    const text = String(answer);
    if (type === 'code') return `<pre class="result-code">${escapeHtml(text)}</pre>`;
    return escapeHtml(text).replace(/\n/g, '<br>');
}


// === Small form dialog ===
// The ×, Escape, Back and a click outside close it through js/dialogs.js, with closeModal.
let _modalSubmit = null;

// variant 'ready': the short card before an exam, its title inside the body (readyCardHtml),
// with cancelLabel's button beside the main one. colours: the course's, for the dialog.
function openModal({ title, body, okLabel = 'OK', okIcon = 'fa-check', okClass = '', onSubmit, variant = '', cancelLabel = '', colours = '' }) {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.toggle('is-ready', variant === 'ready');
    courseColour.apply(overlay, colours);
    overlay.querySelector('.modal').setAttribute('aria-labelledby', variant === 'ready' ? 'ready-title' : 'modal-title');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = body + '<p class="exam-error modal-error" id="modal-error" hidden></p>';
    document.getElementById('modal-foot').innerHTML = `${cancelLabel
        ? `<button class="btn-sm btn-secondary" type="button" data-close><i class="fa-solid fa-xmark" style="margin-right:5px"></i>${escapeHtml(cancelLabel)}</button>` : ''}
        <button class="btn-sm ${okClass}" type="submit" id="modal-ok"><i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${escapeHtml(okLabel)}</button>`;
    _modalSubmit = onSubmit;
    overlay.classList.add('open');
    // The ring fills to the time left as the card opens.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        overlay.querySelectorAll('.ready-left[data-offset]').forEach(ring => { ring.style.strokeDashoffset = ring.dataset.offset; });
    }));
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
// As this computer's settings write numbers (1,000.5 or 1 000,5), to a tenth.
const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function formatNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? NUMBER_FORMAT.format(Math.round(n * 10) / 10) : '';
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
