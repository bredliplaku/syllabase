/* ==========================================================================
   Exam Portal — the student page (/exam/).

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

    const saved = readExamState();
    try { currentUser = await examStore.currentUser(); } catch (e) { console.warn('Could not read the sign-in.', e); }
    // Drop the OAuth fragment so a reload doesn't try to consume it again.
    if (location.hash.includes('access_token') || location.hash.includes('error')) {
        history.replaceState(null, '', location.pathname + location.search);
    }

    // An anonymous exam needs no sign-in: resume it straight away.
    if (saved?.examDetails.Kind === 'anonymous') {
        enterApp();
        resumeExam(saved);
        return;
    }
    if (!currentUser) {
        showScreen('login');
        if (saved) showImprovedNotification('warning', 'Sign In to Continue', 'Sign in again to continue your exam.', 0);
        return;
    }
    enterApp();
    await loadDashboard();
    if (saved && ownsSavedExam(saved)) resumeExam(saved);
}

function setupEventListeners() {
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
        if (!examDetails || examQuestionsModule.classList.contains('hidden')) return;
        autoSaveAnswers();
        e.preventDefault();
        e.returnValue = '';
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.getElementById('modal-overlay').classList.contains('open')) closeModal();
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
        enterApp();
        await loadDashboard();
        const saved = readExamState();
        if (saved && ownsSavedExam(saved)) resumeExam(saved);
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
    if (examDetails) {
        const anonymous = examDetails.Kind === 'anonymous';
        const leave = await confirmDialog(anonymous
            ? 'Leave the exam? Your answers stay on this device; sign in again with your exam ID and password before it ends to continue.'
            : 'Sign out during the exam? Your answers stay on this device; sign in again before it ends to continue.',
            { title: anonymous ? 'Leave Exam' : 'Sign Out', okLabel: anonymous ? 'Leave' : 'Sign out', danger: true, okIcon: 'fa-right-from-bracket' });
        if (!leave) return;
        autoSaveAnswers();
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


// === Dashboard ===
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
        return;
    } finally {
        setSyncing(false);
    }
    courses.removeAttribute('aria-busy');
    renderDashboard();
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
        beginExam(payload, 'anonymous');
        enterApp();
    } catch (error) {
        if (throwErrors) throw error;
        showImprovedNotification('error', 'Could Not Start', error.message);
    } finally {
        setSyncing(false);
    }
}

// Fills examDetails from exam_start / exam_anonymous_start and shows the questions.
function beginExam(payload, kind) {
    const start = new Date(payload.starts_at);
    examDetails = {
        ExamId: payload.id,
        Kind: kind,
        Code: payload.course_code || '',
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
        Seed: kind === 'anonymous' ? payload.exam_code : (payload.student?.student_no || payload.student?.email),
        Student: kind === 'named' ? payload.student : undefined,
        Token: kind === 'anonymous' ? payload.token : undefined,
        ExamCode: kind === 'anonymous' ? payload.exam_code : undefined,
    };
    examEndTime = Date.parse(payload.ends_at);
    fillExamHeader();
    showView('exam');
    displayQuestions(examDetails.Questions);
    saveExamState(); // after displayQuestions, which fixes the question order
    startTimer();
    checkAllConfirmed();
}

function resumeExam(saved) {
    fillExamHeader(saved.examDetails);
    showView('exam');
    restoreExam(saved);
    renderTopBar();
    showImprovedNotification('info', 'Exam Session Restored', 'Resuming your exam where you left off.', 5000);
}

// A saved named exam belongs to whoever is signed in now (by email or student ID).
function ownsSavedExam(saved) {
    const student = saved.examDetails.Student || {};
    return (student.email && student.email === dash?.email) ||
        (dash?.courses || []).some(c => c.student?.student_no && c.student.student_no === student.student_no);
}

function fillExamHeader(details = examDetails) {
    document.getElementById('exam-code-display').textContent = details.Code || 'Exam Portal';
    document.getElementById('exam-name-header').textContent = details.Name;
    const chips = [];
    if (details.Duration) chips.push(`<span class="info-item"><i class="fa-regular fa-clock" aria-hidden="true"></i>Duration <strong>${details.Duration} minutes</strong></span>`);
    chips.push(`<span class="info-item"><i class="fa-regular fa-calendar" aria-hidden="true"></i>Started <strong>${escapeHtml(`${details.StartDate} ${details.StartTime}`)}</strong></span>`);
    if (details.Hall) chips.push(`<span class="info-item"><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${escapeHtml(details.Hall)}</span>`);
    if (details.Kind === 'anonymous') chips.push(`<span class="info-item"><i class="fa-solid fa-user-secret" aria-hidden="true"></i>Exam ID <strong>${escapeHtml(details.ExamCode)}</strong></span>`);
    document.getElementById('exam-info-row').innerHTML = chips.join('');
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

// Called by taking.js once the submission is in.
function onExamSubmitted(exam) {
    showImprovedNotification('success', 'Exam Submitted Successfully!', 'Your submission has been sent.', 0);
    const anonymous = exam.Kind === 'anonymous';
    document.getElementById('done-text').innerHTML = anonymous
        ? `Your answers have been sent, and a backup file was saved to your downloads. Your exam ID was never linked to you.
           Keep your exam ID, <strong>${escapeHtml(exam.ExamCode)}</strong>: once results are out, choose <em>Grade</em> on this page (or open your course on your dashboard) and enter it to see your grade.`
        : 'Your answers have been sent. A backup file was also saved to your downloads. The result appears on your dashboard once your lecturer publishes it.';
    document.getElementById('done-actions').innerHTML = currentUser
        ? '<button type="button" class="btn-sm" data-back><i class="fa-solid fa-arrow-left"></i> My courses</button>'
        : '<button type="button" class="btn-sm" data-back><i class="fa-solid fa-right-from-bracket"></i> Done</button>';
    document.querySelector('#done-actions [data-back]').addEventListener('click', backToDashboard);
    renderTopBar();
    showView('done');
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
            <div class="question-header"><div class="question-title"><i class="fa-solid fa-circle-question" aria-hidden="true"></i>Question ${number}</div>
                <span class="question-points">${points == null ? `${formatNumber(max)} point${max === 1 ? '' : 's'}` : `${formatNumber(points)} / ${formatNumber(max)}`}</span></div>
            <div class="question-body">
                <div class="question-prompt">${promptHtml(q.prompt)}</div>
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
    if (q.type === 'multiple_select' && q.correct_answers?.length) text = q.correct_answers.map(escapeHtml).join('<br>');
    else if (q.type === 'short_answer' && q.accepted_answers?.length) { label = q.accepted_answers.length > 1 ? 'Accepted answers' : 'Correct answer'; text = q.accepted_answers.map(escapeHtml).join('<br>'); }
    else if (q.type === 'numeric' && q.answer != null) text = escapeHtml(`${q.answer}${q.tolerance ? ` ± ${q.tolerance}` : ''}${q.unit ? ` ${q.unit}` : ''}`); // as entered, not rounded
    return text ? `<p class="answer-label">${label}</p><div class="result-answer result-correct">${text}</div>` : '';
}

// **bold** and ***bold*** markup, as on the exam itself
function promptHtml(prompt) {
    return escapeHtml(String(prompt || ''))
        .replace(/\*\*\*(.*?)\*\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*\*(?!\*)(.*?)\*\*(?!\*)/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

function answerHtml(answer, type) {
    if (answer === '[NOT CONFIRMED]') return '<em>Not confirmed before the deadline, so not submitted</em>';
    if (answer == null || answer === '') return '<em>No answer</em>';
    const text = String(answer);
    if (type === 'code') return `<pre class="result-code">${escapeHtml(text)}</pre>`;
    if (type === 'attachment' && text.startsWith('FILE_UPLOADED:')) return `<em>File:</em> ${escapeHtml(text.slice('FILE_UPLOADED:'.length))}`;
    return escapeHtml(text).replace(/\n/g, '<br>');
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
let _modalOverlayMD = false;
let _modalSubmit = null;

function openModal({ title, body, okLabel = 'OK', okIcon = 'fa-check', okClass = '', onSubmit }) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = body + '<p class="exam-error modal-error" id="modal-error" hidden></p>';
    document.getElementById('modal-foot').innerHTML = `
        <button class="btn-secondary btn-sm" type="button" onclick="closeModal()"><i class="fa-solid fa-xmark" style="margin-right:5px"></i>Cancel</button>
        <button class="btn-sm ${okClass}" type="submit" id="modal-ok"><i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${escapeHtml(okLabel)}</button>`;
    _modalSubmit = onSubmit;
    document.getElementById('modal-overlay').classList.add('open');
    setTimeout(() => (document.querySelector('#modal-body input') || document.getElementById('modal-ok')).focus(), 50);
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
    _modalSubmit = null;
}

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
