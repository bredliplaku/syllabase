// Course editor: the Exams and Students tabs.
// Exams: label, type, time, hall, weight (from the Grading tab), base, sign-in, questions;
// then submissions, grading, exports and grades for EIS. Students: the class list pasted from
// EIS and the anonymous exam IDs. Everything goes through the
// exam_* database functions, which check permissions themselves. Load after
// js/course-editor.js, whose helpers (sb, S, x, toast, confirmDialog, finishSectionLoad,
// GRADING_CATEGORIES, gradingEntriesFor…) this uses.
(function () {
  'use strict';

  const EXAM_TYPES = {
    quiz: { label: 'Quiz', icon: 'fa-solid fa-question' },
    assignment: { label: 'Assignment', icon: 'fa-solid fa-book' },
    project: { label: 'Project', icon: 'fa-solid fa-diagram-project' },
    midterm_project: { label: 'Midterm Project', icon: 'fa-solid fa-diagram-project' },
    final_project: { label: 'Final Project', icon: 'fa-solid fa-diagram-project' },
    other: { label: 'Other', icon: 'fa-solid fa-ellipsis' },
    final_exam: { label: 'Final Exam', icon: 'fa-solid fa-graduation-cap', anonymous: true },
    midterm_exam: { label: 'Midterm Exam', icon: 'fa-solid fa-pen-to-square', anonymous: true },
    resit_exam: { label: 'Resit Exam', icon: 'fa-solid fa-rotate', anonymous: true },
    additional_exam: { label: 'Additional Exam', icon: 'fa-solid fa-plus', anonymous: true },
  };
  // The exam type an assessment from the Grading tab suggests, by its category.
  const TYPE_FOR_GRADING = { hw: 'assignment', project: 'project', casestudy: 'other', lab: 'other',
    quiz: 'quiz', midterm: 'midterm_exam', final: 'final_exam', other: 'other' };
  // How students sign in to an exam.
  const SIGN_INS = {
    student_id: { label: 'Student ID', icon: 'fa-solid fa-id-card' },
    google: { label: 'Google account', icon: 'fa-brands fa-google' },
    anonymous: { label: 'Exam ID', icon: 'fa-solid fa-user-secret' },
  };
  const signInOf = exam => (SIGN_INS[exam.sign_in] ? exam.sign_in : 'student_id');
  function signInHint(signIn) {
    if (signIn === 'google') return 'With the Google account on the class list.';
    if (signIn === 'anonymous') {
      const n = EX.data?.codes.length || 0;
      return `Anonymous, with an exam ID from the Students tab (${n || 'none yet'}).`;
    }
    return 'From an hour before the exam until it closes.';
  }
  // Student ID and exam ID sign-ins use the exam password; with Google it is optional.
  const needsPassword = signIn => signIn === 'student_id' || signIn === 'anonymous';
  function passwordHint(signIn) {
    if (signIn === 'student_id') return 'Typed with the student ID.';
    if (signIn === 'anonymous') return 'Typed with the exam ID.';
    return 'Asked when the exam starts.';
  }
  // What the exam page does while an exam is taken (exam_private.clean_settings has the same
  // defaults): what leaving the page (another tab or program) does, and whether only a date is
  // set. The name watermark is always on.
  const DEFAULT_SETTINGS = { watermark: true, date_only: false, leave: 'cooldown', cooldown_seconds: 15 };
  const settingsOf = exam => ({ ...DEFAULT_SETTINGS, ...(exam?.settings || {}) });
  // Students' file answers (Supabase Storage; supabase/exams/2-functions.sql).
  const UPLOAD_BUCKET = 'exam-uploads';
  // Question images are scaled down to this before they are saved.
  const IMAGE_MAX_SIDE = 2000;
  const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const imageIdsOf = questions => [...new Set((questions || []).flatMap(q => (Array.isArray(q.images) ? q.images : [])).filter(id => UUID.test(id)))];
  // Also the options' images: what loading and exporting the questions takes.
  const allImageIdsOf = questions => [...new Set([...imageIdsOf(questions),
    ...(questions || []).flatMap(q => (Array.isArray(q.option_images) ? q.option_images : [])).filter(id => typeof id === 'string' && UUID.test(id))])];
  // Question types as stored (and as the student page renders them), in the editor's order.
  const QUESTION_TYPES = {
    multiple_select: { label: 'Multiple choice', icon: 'fa-solid fa-list-ul', hint: 'Students pick one of the options' },
    true_false: { label: 'True or false', icon: 'fa-solid fa-circle-half-stroke', hint: 'Students choose True or False' },
    short_answer: { label: 'Short answer', icon: 'fa-solid fa-font', hint: 'A word or a phrase, checked against accepted answers' },
    numeric: { label: 'Numeric', icon: 'fa-solid fa-calculator', hint: 'One number, with a tolerance and a unit' },
    long_answer: { label: 'Long answer', icon: 'fa-solid fa-paragraph', hint: 'A written answer, graded by hand' },
    code: { label: 'Code', icon: 'fa-solid fa-code', hint: 'Code in an editor, graded by hand' },
    attachment: { label: 'File upload', icon: 'fa-solid fa-paperclip', hint: 'A file students upload, such as a drawing' },
    text_only: { label: 'Information', icon: 'fa-solid fa-circle-info', hint: 'Instructions or a heading, not graded' },
  };
  // Each question keeps a short id: answers, grades and files follow it when questions are
  // added, removed or moved, also while students take the exam (exam_save_questions).
  const newQuestionId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`)
    .replace(/-/g, '').slice(0, 12);
  const IMAGE_SIZES = { small: 'S', medium: 'M', large: 'L', full: 'Full width' };
  const typeLabel = type => EXAM_TYPES[type]?.label || 'Exam';
  const examTitle = exam => exam.label || typeLabel(exam.type);

  // The course offering on screen and what exam_course returned for it.
  // images: question images by id (data URLs), loaded per exam as needed.
  const EX = { course: null, isArchive: false, access: null, data: null, grading: [], view: 'list', examId: null, submissions: [], images: {} };
  const canManage = () => EX.access === 'manage';

  // ── Data ──
  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
        throw new Error('The exam database functions are not installed yet.');
      }
      throw new Error(error.message || 'Something went wrong. Please try again.');
    }
    return data;
  }
  const isStale = (course, isArchive, section) => S.course !== course || S.isArchive !== isArchive || S.section !== section;

  // The course's Grading tab entries with a weight, e.g. "Midterm 1 — 40%". Attendance is no exam.
  function gradingEntries(metaRows) {
    const metaMap = {};
    for (const r of metaRows || []) metaMap[r.b] = r;
    const entries = [];
    for (const cat of orderedGradingCategories(metaMap[GRADING_ORDER_KEY]?.c)) {
      if (cat.id === 'attendance') continue;
      const items = cat.multi ? gradingEntriesFor(cat, metaMap).map(e => ({ key: e.key, label: `${cat.label} ${e.n}` }))
        : [{ key: cat.key, label: cat.label }];
      for (const item of items) {
        const weight = parseFloat(metaMap[item.key]?.c);
        if (Number.isFinite(weight) && weight > 0) entries.push({ ...item, cat: cat.id, weight });
      }
    }
    return entries;
  }

  async function loadCourse(course, isArchive) {
    await retryPendingFollowUps();
    const [data, meta] = await Promise.all([
      rpc('exam_course', { p_sheet: course, p_archive: isArchive }),
      sb.from('course_rows').select('b,c,d').eq('sheet_name', course).eq('is_archive', isArchive).eq('type', 'metadata')
        .then(r => { if (r.error) throw r.error; return r.data; }),
    ]);
    if (EX.course !== course || EX.isArchive !== isArchive) Object.assign(EX, { view: 'list', examId: null, submissions: [], images: {} });
    Object.assign(EX, { course, isArchive, access: data.access, data, grading: gradingEntries(meta) });
    ensureGradingDone(meta);
    return data;
  }

  // ── Grading tab: an assessment whose exam grades are visible is Done, and locked ──
  // Marks the Grading tab entries Done (as its own Save does), or back to not done when grades
  // are hidden again and no other exam of the entry shows them. Returns how many changed.
  async function markGradingDone(course, isArchive, keys, done = true) {
    if (!done) keys = keys.filter(k => !EX.data.exams.some(e => e.grading_key === k && e.results_published));
    if (!keys.length) return 0;
    const { data, error } = await sb.from('course_rows').select('*').eq('sheet_name', course).eq('is_archive', isArchive)
      .eq('type', 'metadata').in('b', keys);
    if (error) throw error;
    const rows = (data || []).filter(r => (String(r.d || '').trim().toLowerCase() === 'done') !== done).map(r => ({ ...r, d: done ? 'Done' : '' }));
    if (!rows.length) return 0;
    const result = await saveCourseRows(rows, []);
    if (result?.error) throw result.error;
    return rows.length;
  }

  // On loading the Exams tab: entries of exams with visible grades that are not Done yet (say,
  // marking failed earlier) are marked now. Lecturers and admins only; quietly.
  function ensureGradingDone(meta) {
    if (!canManage() || typeof canEditSection !== 'function' || !canEditSection('grading')) return;
    const done = new Set((meta || []).filter(r => String(r.d || '').trim().toLowerCase() === 'done').map(r => r.b));
    const known = new Set((meta || []).map(r => r.b));
    const keys = [...new Set(EX.data.exams.filter(e => e.results_published && e.grading_key && known.has(e.grading_key) && !done.has(e.grading_key)).map(e => e.grading_key))];
    if (keys.length) markGradingDone(EX.course, EX.isArchive, keys).catch(error => console.warn('Could not mark the Grading tab entries Done.', error));
  }

  // For the Grading tab (course-editor.js): which entries exams count as. [] without the
  // exam functions or access.
  async function examGradingLinks(course, isArchive) {
    try {
      const { data, error } = await sb.rpc('exam_grading_links', { p_sheet: course, p_archive: isArchive });
      return error || !Array.isArray(data) ? [] : data;
    } catch { return []; }
  }

  // Locks the Grading tab's Done (and Remove) for entries whose exam grades are visible.
  function applyGradingLocks(links) {
    for (const link of links.filter(l => l.results_published)) {
      const select = document.querySelector(`#grade-table select[data-donekey="${CSS.escape(link.grading_key)}"]`);
      if (!select) continue;
      const exam = link.label || typeLabel(link.type);
      const why = `Grades of ${exam} are released to students. To change this, set that exam's Assessment to Custom.`;
      select.value = 'Done';
      select.disabled = true;
      select.title = why;
      const row = select.closest('tr');
      row.classList.add('grade-locked');
      const remove = row.querySelector('.gt-del button');
      if (remove) { remove.disabled = true; remove.title = why; }
      row.querySelector('.gt-label')?.insertAdjacentHTML('beforeend', ` <i class="fa-solid fa-lock grade-lock" title="${x(why)}" aria-label="${x(why)}"></i>`);
    }
  }

  // After the Grading tab saves: exams follow entries that were renumbered or removed.
  async function followGradingKeys(course, isArchive, map) {
    if (!Object.keys(map).length) return;
    const { error } = await sb.rpc('exam_rename_grading_keys', { p_sheet: course, p_archive: isArchive, p_map: map });
    if (error && error.code !== 'PGRST202') toast(`The exams did not follow the renumbered grading entries: ${error.message}`, 'err');
  }

  // Archived courses stay on students' dashboards for their grades; their exams are closed.
  function archivedNote() {
    return EX.isArchive ? `<p class="form-hint exam-edit-warning exam-archived-note"><i class="fa-solid fa-box-archive" aria-hidden="true"></i>
      <span>This course is archived: students still see their grades from it on the exam page, but can't start its exams or sign in to it with their student ID.</span></p>` : '';
  }

  function sectionError(body, error) {
    body.innerHTML = `<div class="empty-content"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${x(error.message)}</div>`;
    finishSectionLoad(body);
  }


  // ════════════════════════════════════════════════════════════════════════
  // Exams tab
  // ════════════════════════════════════════════════════════════════════════

  async function loadExamsSection() {
    const course = S.course, isArchive = S.isArchive;
    const body = document.getElementById('section-body');
    try {
      await loadCourse(course, isArchive);
    } catch (error) {
      if (!isStale(course, isArchive, 'exams')) sectionError(body, error);
      return;
    }
    if (isStale(course, isArchive, 'exams')) return;
    // Left the grading page another way (Settings, then back): its grades list.
    if (EX.view === 'grading') { _grading = null; EX.view = 'submissions'; }
    if (EX.view === 'questions' && examById(EX.examId) && canManage()) return showQuestions(EX.examId, body);
    if (EX.view === 'submissions' && examById(EX.examId)) await showSubmissions(EX.examId, body);
    else renderExamList(body);
    finishSectionLoad(body);
  }

  function renderExamList(body = document.getElementById('section-body')) {
    EX.view = 'list';
    const exams = EX.data.exams;
    const totalWeight = exams.reduce((sum, e) => sum + (parseFloat(e.weight) || 0), 0);
    const gradingTotal = EX.grading.reduce((sum, g) => sum + g.weight, 0);
    body.innerHTML = `
      <div class="section-topbar" data-no-dirty>
        <span class="exam-topbar-note"><i class="fa-solid fa-percent" aria-hidden="true"></i>
          Exams carry <strong>${fmt(totalWeight)}%</strong> of the grade${gradingTotal ? `; the Grading tab lists ${fmt(gradingTotal)}%` : ''}</span>
        <div class="add-bar">
          ${canManage() ? '<button class="btn-sm btn-green" type="button" data-exam-action="new"><i class="fa-solid fa-plus" style="margin-right:6px"></i>New exam</button>' : ''}
        </div>
      </div>
      ${archivedNote()}
      <div class="exam-cards" data-no-dirty>
        ${exams.length ? exams.map(examCardHtml).join('') : `<div class="empty-content">No exams yet.${canManage() ? ' Add one with <strong>New exam</strong>.' : ''}</div>`}
      </div>`;
    body.onclick = onExamsClick;
    body.onchange = onExamsChange;
    body.oninput = body.onkeydown = body.onpaste = body.ondragover = body.ondragleave = body.ondrop = null;
  }

  // One card an exam: its name and status, one line of facts, then Questions and Grading (the
  // two places work happens), and the switches that reach students. Settings and the rest are
  // in the head's gear and ⋯.
  function examCardHtml(exam) {
    const count = (exam.questions || []).filter(q => q.type !== 'text_only').length;
    const settings = settingsOf(exam);
    const facts = [typeLabel(exam.type)];
    if (exam.starts_at) facts.push(settings.date_only ? formatDate(exam.starts_at) : formatWhen(exam.starts_at));
    if (exam.duration_minutes) facts.push(`${exam.duration_minutes} min`);
    if (exam.hall) facts.push(exam.hall);
    if (exam.weight != null) facts.push(`${fmt(exam.weight)}% of the grade${gradingLabel(exam.grading_key) ? ` (${gradingLabel(exam.grading_key)})` : ''}`);
    if (fmt(exam.base) !== '100') facts.push(`out of ${fmt(exam.base)}`);
    facts.push(count ? `${SIGN_INS[signInOf(exam)].label.replace(/ \(.*\)$/, '')} sign-in` : 'On paper (no questions)');
    if (count && settings.leave === 'cooldown') facts.push(`${settings.cooldown_seconds} s lock on leaving`);
    const status = examStatus(exam);
    const noPassword = canManage() && needsPassword(signInOf(exam)) && count && status.key !== 'ended' && !exam.has_password;
    const expected = signInOf(exam) === 'anonymous' ? EX.data.codes.length : EX.data.students.length;
    const toGrade = exam.submission_count - exam.graded_count;
    const menu = [
      { label: 'Preview as a student', icon: 'fa-solid fa-eye', attrs: 'data-exam-action="try"', disabled: !count },
      { label: 'Duplicate', icon: 'fa-solid fa-copy', attrs: 'data-exam-action="duplicate"' },
      { label: 'Delete', icon: 'fa-solid fa-trash', danger: true, attrs: 'data-exam-action="delete"' },
    ];
    return `<article class="exam-card${exam.visible ? '' : ' is-hidden'}" data-exam-id="${x(exam.id)}">
      <div class="exam-card-head">
        <span class="exam-card-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="exam-card-title">
          <div class="exam-card-name-row"><span class="exam-card-name">${x(examTitle(exam))}</span>
            <span class="exam-status exam-status-${status.key}">${x(status.label)}</span></div>
          <div class="exam-card-facts">${facts.map(x).join('<span class="exam-dot">·</span>')}</div>
        </div>
        ${canManage() ? `<div class="exam-card-actions">
          <button type="button" class="btn-sm btn-secondary exam-settings-btn" data-exam-action="edit" title="Exam settings: date, sign-in, password, leaving the page"><i class="fa-solid fa-gear"></i><span>Settings</span></button>
          ${rowMenuHtml(menu, { label: 'More actions' })}
        </div>` : ''}
      </div>
      ${noPassword ? `<p class="exam-card-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span>Students can't sign in to start it without an exam password.
          <button type="button" class="exam-link-btn" data-exam-action="set-password">Set the password</button></span></p>` : ''}
      <div class="exam-card-foot">
        <div class="exam-card-work">
          ${canManage() ? `<button type="button" class="btn-sm btn-secondary" data-exam-action="questions"><i class="fa-solid fa-list-check"></i>Questions
            <span class="exam-count">${count}</span></button>` : ''}
          <button type="button" class="btn-sm btn-secondary" data-exam-action="submissions"><i class="fa-solid fa-marker"></i>Grades
            <span class="exam-count" title="Submitted, of ${expected} ${signInOf(exam) === 'anonymous' ? 'exam IDs' : 'students'}">${exam.submission_count}${expected ? `/${expected}` : ''}</span>
            ${toGrade > 0 ? `<span class="exam-count-sub">${toGrade} to grade</span>` : ''}</button>
        </div>
        <div class="exam-card-switches">
          <label class="exam-switch"><input type="checkbox" data-flag="visible" ${exam.visible ? 'checked' : ''} ${canManage() ? '' : 'disabled'}><span title="On students' dashboards and the course page; they can start it when it opens. Off: a draft only you see.">Published</span></label>
          <label class="exam-switch"><input type="checkbox" data-flag="results_published" ${exam.results_published ? 'checked' : ''} ${canManage() ? '' : 'disabled'}><span title="Students see their grade, answers and your comments">Grades released</span></label>
        </div>
      </div>
    </article>`;
  }

  function chip(icon, text) { return `<span class="exam-chip"><i class="${icon}" aria-hidden="true"></i>${x(text)}</span>`; }
  function gradingLabel(key) { return EX.grading.find(g => g.key === key)?.label || ''; }

  // Worked out here rather than from is_open, so a switch flipped on the card shows at once.
  function examStatus(exam) {
    if (!exam.visible) return { key: 'draft', label: 'Draft' };
    const now = Date.now(), start = Date.parse(exam.starts_at), end = Date.parse(exam.ends_at);
    if (exam.questions?.length && start <= now && now < end) return { key: 'open', label: 'Open now' };
    if (start > now) return { key: 'upcoming', label: 'Upcoming' };
    if (end <= now || (!exam.duration_minutes && start <= now)) return { key: 'ended', label: exam.results_published ? 'Grades out' : 'Ended' };
    return { key: 'listed', label: 'Published' };
  }

  const examById = id => EX.data?.exams.find(e => e.id === id);
  // Named submissions carry the student ID, or the email for a student without one.
  const studentKey = s => s.student_no || s.email;
  const shownNo = no => (no && !no.includes('@') ? no : '');
  const subName = s => s.student_name || s.exam_code || 'Submission';

  // #section-body is shared by every tab, so these handlers check the tab is still Exams.
  async function onExamsClick(e) {
    if (S.section === 'exams' && EX.view === 'submissions' && e.target.matches('.row-check, #roster-check-all')) return onRosterCheck(examById(EX.examId), e.target, e);
    const btn = S.section === 'exams' && e.target.closest('[data-exam-action], [data-sub-action], [data-roster-filter], [data-bulk], [data-roster-sort]');
    if (!btn) return;
    if (btn.dataset.subAction || btn.dataset.rosterFilter || btn.dataset.bulk || 'rosterSort' in btn.dataset) return onSubmissionsAction(btn);
    const exam = examById(btn.closest('[data-exam-id]')?.dataset.examId);
    switch (btn.dataset.examAction) {
      case 'new': return openExamEditor(null);
      case 'edit': return openExamEditor(exam);
      case 'duplicate': return openExamEditor(exam, true);
      case 'delete': return deleteExam(exam);
      case 'submissions': return showSubmissions(exam.id);
      case 'questions': return showQuestions(exam.id);
      case 'try': return tryAsStudent(exam, exam.questions || []);
      case 'back': return reloadExams();
      case 'set-password':
        openExamEditor(exam);
        return setTimeout(() => {
          const toggle = document.getElementById('exam-f-password-on');
          if (toggle && !toggle.checked) { toggle.checked = true; toggle.dispatchEvent(new Event('change')); }
          document.getElementById('exam-f-password')?.focus();
        }, 120);
    }
  }

  async function onExamsChange(e) {
    const input = S.section === 'exams' && e.target.closest('[data-flag]');
    if (!input) return;
    const exam = examById(input.closest('[data-exam-id]')?.dataset.examId);
    if (!exam) return;
    const flag = input.dataset.flag, value = input.checked;
    input.disabled = true;
    // Publishing and releasing grades reach students at once, so a stray click asks first.
    const ask = flagConfirmation(exam, flag, value);
    if (ask && !(await confirmDialog(ask.message, ask))) {
      input.checked = !value;
      input.disabled = false;
      return;
    }
    try {
      await rpc('exam_set_exam_flags', { p_id: exam.id, p_visible: flag === 'visible' ? value : null,
        p_results_published: flag === 'results_published' ? value : null });
      exam[flag] = value;
      if (flag === 'results_published' && value && exam.grading_key) {
        try { await markGradingDone(EX.course, EX.isArchive, [exam.grading_key]); }
        catch (error) { toast(`Grades are visible, but ${gradingLabel(exam.grading_key) || 'the assessment'} was not marked Done: ${error.message}`, 'err'); }
      }
      if (flag === 'results_published' && !value && exam.grading_key) {
        markGradingDone(EX.course, EX.isArchive, [exam.grading_key], false)
          .catch(error => toast(`${gradingLabel(exam.grading_key) || 'The assessment'} is still marked Done: ${error.message}`, 'err'));
      }
      // No toast: the switch and the card's status show the change (and the dialog said it).
      const card = input.closest('.exam-card');
      card.outerHTML = examCardHtml(exam);
    } catch (error) {
      input.checked = !value;
      toast(error.message, 'err');
    } finally {
      input.disabled = false;
    }
  }

  // What turning a card's switch on (or Published off while the exam is open) does, for the
  // confirmation; null when it needs none (taking grades back is undone as easily). Worded as
  // the editor's other confirmations: a short title, the action in one word.
  function flagConfirmation(exam, flag, value) {
    const name = `"${examTitle(exam)}"`;
    if (flag === 'visible' && value) {
      return {
        title: 'Publish Exam', okLabel: 'Publish', okIcon: 'fa-eye',
        message: `${name} will be listed on students' dashboards and the course page${exam.starts_at ? `. They can start it from ${formatWhen(exam.starts_at)}` : ''}.`
          + (exam.questions?.length ? '' : '\n\nIt has no questions yet.'),
      };
    }
    if (flag === 'visible' && examStatus(exam).key === 'open') {
      return {
        title: 'Unpublish Exam', okLabel: 'Unpublish', okIcon: 'fa-eye-slash', danger: true,
        message: `${name} is open now. Once unpublished, students no longer see it.`,
      };
    }
    if (flag === 'results_published' && value) {
      const ungraded = exam.submission_count && exam.graded_count < exam.submission_count;
      const label = exam.grading_key && gradingLabel(exam.grading_key);
      return {
        title: 'Release Grades', okLabel: 'Release', okIcon: 'fa-eye',
        message: `Students will see their grades for ${name}, with their answers and your comments.`
          + (ungraded ? `\n\n${exam.graded_count} of ${exam.submission_count} submissions are graded so far.` : '')
          + (label ? `\n\n${label} will be marked Done on the Grading tab.` : ''),
      };
    }
    return null;
  }

  async function reloadExams() {
    EX.view = 'list';
    const body = document.getElementById('section-body');
    lockHeight(body);
    await loadExamsSection();
  }

  async function deleteExam(exam) {
    if (!exam) return;
    const subs = exam.submission_count ? `\n\nIts ${exam.submission_count} submission${exam.submission_count === 1 ? '' : 's'} and grades are deleted too.` : '';
    const files = exam.file_count ? `\n\nSo are the ${exam.file_count} file${exam.file_count === 1 ? '' : 's'} students uploaded (${formatBytes(exam.file_bytes)}): download them first from its Grades page (Download).` : '';
    if (!(await confirmDialog(`Delete "${examTitle(exam)}"?${subs}${files}`, { title: 'Delete Exam', okLabel: 'Delete', danger: true, okIcon: 'fa-trash-can' }))) return;
    try {
      // The files first: they are in Storage, which the database can't empty.
      if (exam.file_count) await removeExamFiles(exam);
      await rpc('exam_delete_exam', { p_id: exam.id });
      toast('Exam deleted', 'ok');
      reloadExams();
    } catch (error) {
      toast(error.message, 'err');
    }
  }


  // ── Overlays (the editor's own modal is too small for exams) ──
  // The ×, Escape, Back and a click outside go through js/dialogs.js, which asks before
  // losing typed changes, or leaves the asking to onClose.
  function overlay(id, { wide = true, onClose } = {}) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'modal-overlay exam-overlay';
      el.id = id;
      el.innerHTML = `<div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
        <div class="modal-head"><h3 id="${id}-title"></h3>
          <button class="btn-ghost btn-icon modal-close" type="button" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="modal-body" id="${id}-body"></div>
        <div class="modal-foot" id="${id}-foot"></div>
      </div>`;
      document.body.appendChild(el);
    }
    el._requestClose = onClose ? async () => { if (await onClose()) el.classList.remove('open'); } : null;
    return {
      el,
      title: t => { document.getElementById(`${id}-title`).textContent = t; },
      body: document.getElementById(`${id}-body`),
      foot: document.getElementById(`${id}-foot`),
      open: () => el.classList.add('open'),
      close: () => el.classList.remove('open'),
    };
  }

  // Ctrl/Cmd+S saves the top exam dialog (exam or grades), not the tab.
  document.addEventListener('keydown', e => {
    if (document.getElementById('confirm-overlay')?.classList.contains('open')) return;
    const top = [...document.querySelectorAll('.exam-overlay.open')].pop();
    if (!top) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const save = { 'exam-edit': 'exam-edit-save' }[top.id];
      if (save) document.getElementById(save)?.click();
    }
  }, true);


  // ── Exam editor ──
  let _editorSnapshot = null;

  // returnToQuestions: opened from the questions editor, which reopens after a save.
  function openExamEditor(exam, duplicate = false, returnToQuestions = false) {
    if (!canManage()) return;
    const isNew = !exam || duplicate;
    const source = exam || { type: 'quiz', base: 100, sign_in: 'student_id', shuffle_questions: true, visible: false, questions: [] };
    const ov = overlay('exam-edit', { onClose: confirmDiscardEditor });
    ov.title(duplicate ? `Duplicate ${examTitle(exam)}` : exam ? `Edit ${examTitle(exam)}` : 'New exam');
    ov.body.innerHTML = examFormHtml(source, { isNew, duplicate });
    ov.foot.innerHTML = `<button class="btn-sm btn-green" type="button" id="exam-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>`;
    document.getElementById('exam-f-type').onchange = onTypeChange;
    document.getElementById('exam-f-grading').onchange = onGradingChange;
    document.getElementById('exam-f-signin').onchange = e => { e.target.dataset.touched = '1'; onSignInChange(); };
    document.getElementById('exam-f-lock').onchange = onLeaveChange;
    document.getElementById('exam-f-password-on').onchange = onPasswordToggle;
    ['exam-f-date', 'exam-f-time', 'exam-f-duration'].forEach(id => { document.getElementById(id).oninput = showExamEnd; });
    wirePasswordField();
    document.getElementById('exam-edit-save').onclick = () => saveExam(isNew ? null : exam, source, returnToQuestions);
    onLeaveChange();
    showExamEnd();
    ov.el.dataset.examId = isNew ? '' : exam.id;
    _editorSnapshot = editorSnapshot();
    ov.open();
    setTimeout(() => document.getElementById(isNew && !duplicate ? 'exam-f-grading' : 'exam-f-label')?.focus(), 60);
  }

  function editorSnapshot() {
    return JSON.stringify([...document.querySelectorAll('#exam-edit-body input, #exam-edit-body select, #exam-edit-body textarea')]
      .map(el => el.type === 'checkbox' ? el.checked : el.value));
  }

  async function confirmDiscardEditor() {
    if (_editorSnapshot === null || editorSnapshot() === _editorSnapshot) return true;
    return saveOrDiscard('This exam has changes that are not saved yet.', () => document.getElementById('exam-edit-save').click());
  }

  // Leaving a dialog with changes (a click outside, Escape, the ×, Back, or another
  // submission): Save runs save, which closes or moves on once it has saved; Discard goes on
  // without; Cancel stays. True when it can go on now.
  async function saveOrDiscard(message, save) {
    const choice = await confirmDialog(message, { title: 'Unsaved Changes', okLabel: 'Save', okIcon: 'fa-floppy-disk', altLabel: 'Discard' });
    if (choice === true) save();
    return choice === 'alt';
  }

  // An exam or grading dialog with changes not saved yet: course-editor.js asks before the page
  // closes, and keeps the sign-in while it is open.
  function examDraftOpen() {
    const open = id => !!document.getElementById(id)?.classList.contains('open');
    return (open('exam-edit') && _editorSnapshot !== null && editorSnapshot() !== _editorSnapshot) ||
      (onGradingPage() && gradingChanged());
  }

  // The exam's settings, in rows: what it is; when and where; how students sign in; what happens
  // while it runs; whether students see it and its grades.
  function examFormHtml(src, { isNew, duplicate }) {
    const typeOptions = Object.entries(EXAM_TYPES).map(([id, t]) => `<option value="${id}" ${src.type === id ? 'selected' : ''}>${x(t.label)}</option>`).join('');
    const gradingOptions = ['<option value="">Custom</option>', ...EX.grading.map(g =>
      `<option value="${x(g.key)}" data-weight="${g.weight}" data-cat="${x(g.cat)}" data-label="${x(g.label)}" ${src.grading_key === g.key ? 'selected' : ''}>${x(g.label)}</option>`)].join('');
    const signIn = signInOf(src);
    const settings = settingsOf(src);
    const local = toLocalInput(src.starts_at);
    const date = local.slice(0, 10), time = settings.date_only ? '' : local.slice(11, 16);
    // Once taken, the sign-in stays: the submissions belong to students, or to exam IDs.
    const taken = !duplicate && (src.submission_count || 0) > 0;
    const password = duplicate ? '' : src.password || '';
    const passwordOn = isNew ? needsPassword(signIn) : !!src.has_password;
    const lock = settings.leave === 'cooldown';
    const toggle = (id, on, title, hint = '') => `<label class="exam-switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}>
      <span><span class="exam-switch-title">${title}</span>${hint ? `<span class="exam-switch-hint">${hint}</span>` : ''}</span></label>`;
    return `
      <div class="sg-grid exam-edit-grid">
        <div class="form-group exam-edit-wide"><label class="form-label" for="exam-f-grading">Assessment</label>
          <select id="exam-f-grading">${gradingOptions}</select>
          ${EX.grading.length ? '' : '<p class="form-hint">Add weights on the Grading tab to choose one here.</p>'}</div>
        <div class="form-group"><label class="form-label" for="exam-f-label">Label</label>
          <input type="text" id="exam-f-label" value="${x(duplicate ? `${src.label || typeLabel(src.type)} (copy)` : src.label || '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-type">Type</label>
          <select id="exam-f-type">${typeOptions}</select></div>
        <div class="form-group"><label class="form-label" for="exam-f-weight">Weight (%)</label>
          <input type="number" id="exam-f-weight" min="0" max="100" step="0.1" value="${x(src.weight ?? '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-base">Base</label>
          <input type="number" id="exam-f-base" min="1" step="1" value="${x(src.base ?? 100)}"></div>
      </div>
      <div class="sg-grid exam-edit-grid exam-edit-row">
        <div class="form-group"><label class="form-label" for="exam-f-date">Date</label>
          <input type="date" id="exam-f-date" value="${x(date)}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-time">Time</label>
          <input type="time" id="exam-f-time" value="${x(time)}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-duration">Duration (min)</label>
          <input type="number" id="exam-f-duration" min="1" step="1" value="${x(src.duration_minutes ?? '')}">
          <p class="form-hint" id="exam-f-ends" aria-live="polite"></p></div>
        <div class="form-group"><label class="form-label" for="exam-f-hall">Hall</label>
          <input type="text" id="exam-f-hall" value="${x(src.hall || '')}" list="exam-f-halls" autocomplete="off">
          <datalist id="exam-f-halls">${[...new Set(EX.data.exams.map(e => (e.hall || '').trim()).filter(Boolean))].sort().map(h => `<option value="${x(h)}">`).join('')}</datalist></div>
      </div>
      <div class="sg-grid exam-edit-grid exam-edit-row exam-edit-access">
        <div class="form-group"><label class="form-label" for="exam-f-signin">Sign-in</label>
          <select id="exam-f-signin" ${taken ? 'disabled' : ''}>${Object.entries(SIGN_INS).map(([id, s]) => `<option value="${id}" ${signIn === id ? 'selected' : ''}>${x(s.label)}</option>`).join('')}</select>
          <p class="form-hint" id="exam-f-signin-hint">${taken ? '<i class="fa-solid fa-lock" aria-hidden="true"></i> Fixed: students have taken this exam.' : x(signInHint(signIn))}</p></div>
        <div class="form-group exam-password">
          <label class="exam-switch exam-switch-label"><input type="checkbox" id="exam-f-password-on" ${passwordOn ? 'checked' : ''}><span class="exam-switch-title">Password</span></label>
          <div class="exam-password-row" ${passwordOn ? '' : 'hidden'}>
            <span class="exam-password-field">
              <input type="password" id="exam-f-password" value="${x(password)}" autocomplete="new-password" spellcheck="false" aria-label="Exam password"
                placeholder="${!duplicate && src.has_password && !password ? 'Set earlier: type it to see it here' : ''}">
              <button type="button" class="exam-password-peek" id="exam-f-password-peek" title="Show" aria-label="Show the password" aria-pressed="false"><i class="fa-regular fa-eye"></i></button>
            </span>
            <button type="button" class="btn-sm btn-secondary" id="exam-f-password-new" title="A new password, easy to read out"><i class="fa-solid fa-dice"></i>Generate</button>
            <button type="button" class="btn-sm btn-secondary" id="exam-f-password-copy" title="Copy" aria-label="Copy the password" ${password ? '' : 'disabled'}><i class="fa-regular fa-copy"></i></button>
          </div>
          <p class="form-hint" id="exam-f-password-hint" ${passwordOn ? '' : 'hidden'}>${x(passwordHint(signIn))}</p></div>
      </div>
      <div class="exam-edit-flags exam-edit-row">
        ${toggle('exam-f-shuffle', src.shuffle_questions !== false, 'Shuffle questions', 'Each student gets their own order.')}
        <label class="exam-switch"><input type="checkbox" id="exam-f-lock" ${lock ? 'checked' : ''}>
          <span><span class="exam-switch-title">Lock on leaving</span><span class="exam-switch-hint" data-cooldown>For
            <input type="number" id="exam-f-cooldown" class="exam-inline-number" min="5" max="300" step="1" value="${x(settings.cooldown_seconds)}" aria-label="Seconds"> seconds each time. Leaving is always recorded.</span>
            <span class="exam-switch-hint" data-no-cooldown>Leaving is only recorded.</span></span></label>
      </div>
      <div class="exam-edit-flags exam-edit-row">
        ${toggle('exam-f-visible', !duplicate && src.visible, 'Publish')}
        ${toggle('exam-f-published', !duplicate && src.results_published, 'Release grades')}
      </div>`;
  }

  // The password, hidden until the eye shows it; Generate makes one easy to read out, and Copy
  // takes it for the board or an email.
  const PASSWORD_LETTERS = 'abcdefghjkmnpqrstuvwxyz', PASSWORD_DIGITS = '23456789';
  function newExamPassword() {
    const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), v => set[v % set.length]).join('');
    return pick(PASSWORD_LETTERS, 4) + pick(PASSWORD_DIGITS, 3);
  }
  function wirePasswordField() {
    const input = document.getElementById('exam-f-password');
    const copy = document.getElementById('exam-f-password-copy');
    const peek = document.getElementById('exam-f-password-peek');
    const show = shown => {
      input.type = shown ? 'text' : 'password';
      peek.setAttribute('aria-pressed', String(shown));
      peek.title = shown ? 'Hide' : 'Show';
      peek.innerHTML = `<i class="fa-regular ${shown ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    };
    peek.onclick = () => show(input.type === 'password');
    const sync = () => { copy.disabled = !input.value.trim(); };
    input.addEventListener('input', sync);
    document.getElementById('exam-f-password-new').onclick = () => {
      input.value = newExamPassword();
      show(true);
      sync();
      input.focus();
      input.select();
    };
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(input.value.trim());
        toast('Password copied', 'ok');
      } catch {
        input.select();
        toast('Press Ctrl+C to copy it');
      }
    };
  }

  // Under the duration: when the exam ends (the day too when it is another), so a typo shows.
  function showExamEnd() {
    const date = document.getElementById('exam-f-date').value, time = document.getElementById('exam-f-time').value;
    const minutes = parseInt(document.getElementById('exam-f-duration').value, 10);
    const starts = date && time ? new Date(`${date}T${time}`) : null;
    const ends = starts && !isNaN(starts) && minutes > 0 ? new Date(starts.getTime() + minutes * 60000) : null;
    document.getElementById('exam-f-ends').textContent = !ends ? '' : `Ends ${ends.toDateString() === starts.toDateString()
      ? ends.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : formatShortWhen(ends.toISOString())}`;
  }

  // The countdown's seconds only with the lock.
  function onLeaveChange() {
    const lock = document.getElementById('exam-f-lock').checked;
    document.querySelectorAll('#exam-edit-body [data-cooldown]').forEach(el => { el.hidden = !lock; });
    document.querySelectorAll('#exam-edit-body [data-no-cooldown]').forEach(el => { el.hidden = lock; });
  }

  // The password field, Generate and Copy only with the password on.
  function onPasswordToggle() {
    const on = document.getElementById('exam-f-password-on').checked;
    document.querySelector('#exam-edit-body .exam-password-row').hidden = !on;
    document.getElementById('exam-f-password-hint').hidden = !on;
    if (on && !document.getElementById('exam-f-password').value) document.getElementById('exam-f-password').focus();
  }

  // Until chosen by hand, the type suggests the sign-in: exam IDs for midterm, final, resit and
  // additional exams, the student ID otherwise.
  function onTypeChange() {
    const type = document.getElementById('exam-f-type').value;
    const signin = document.getElementById('exam-f-signin');
    if (!signin.dataset.touched) { signin.value = EXAM_TYPES[type]?.anonymous ? 'anonymous' : 'student_id'; onSignInChange(); }
  }

  function onSignInChange() {
    const signIn = document.getElementById('exam-f-signin').value;
    document.getElementById('exam-f-signin-hint').textContent = signInHint(signIn);
    document.getElementById('exam-f-password-hint').textContent = passwordHint(signIn);
    const toggle = document.getElementById('exam-f-password-on');
    if (needsPassword(signIn) && !toggle.checked) { toggle.checked = true; onPasswordToggle(); }
  }

  // An assessment from the Grading tab fills in the weight and type, and the label unless one
  // was typed.
  function onGradingChange() {
    const opt = document.getElementById('exam-f-grading').selectedOptions[0];
    if (!opt?.value) return;
    document.getElementById('exam-f-weight').value = opt.dataset.weight;
    const type = TYPE_FOR_GRADING[opt.dataset.cat];
    if (type) { document.getElementById('exam-f-type').value = type; onTypeChange(); }
    const label = document.getElementById('exam-f-label');
    if (!label.value.trim() || label.value === label.dataset.filled) { label.value = opt.dataset.label; label.dataset.filled = label.value; }
  }

  async function saveExam(original, source, returnToQuestions = false) {
    const val = id => document.getElementById(id).value.trim();
    const questions = source.questions || [];
    const date = val('exam-f-date'), time = val('exam-f-time');
    const starts = date ? new Date(`${date}T${time || '00:00'}`) : null;
    const dateOnly = !!date && !time;
    const duration = val('exam-f-duration');
    const signIn = val('exam-f-signin');
    const passwordOn = document.getElementById('exam-f-password-on').checked;
    const password = passwordOn ? val('exam-f-password') : '';
    const clearPassword = !passwordOn && !!original?.has_password;
    const hasPassword = passwordOn && (!!password || !!original?.has_password);
    const problems = [];
    if (time && !date) problems.push('Choose the date as well.');
    if (date && isNaN(starts)) problems.push('Enter a valid date and time.');
    if (questions.length && (!starts || dateOnly || !duration)) problems.push('An exam with questions needs a date, time and duration: students can start it only then.');
    if (needsPassword(signIn) && questions.length && !hasPassword) {
      problems.push(signIn === 'anonymous' ? 'Anonymous exams need an exam password.' : 'Student ID exams need an exam password: students sign in with it.');
    }
    const weight = val('exam-f-weight');
    if (weight && (parseFloat(weight) < 0 || parseFloat(weight) > 100)) problems.push('The weight is a percentage from 0 to 100.');
    const leave = document.getElementById('exam-f-lock').checked ? 'cooldown' : 'record';
    const cooldown = Number(val('exam-f-cooldown'));
    if (leave === 'cooldown' && !(Number.isInteger(cooldown) && cooldown >= 5 && cooldown <= 300)) problems.push('The countdown is 5 to 300 seconds.');
    if (problems.length) { toast(problems[0], 'err'); return; }
    if (signIn === 'anonymous' && questions.length && !EX.data.codes.length && original?.sign_in !== 'anonymous') {
      if (!(await confirmDialog('There are no exam IDs on the Students tab yet, so nobody can sign in to this exam. Save it anyway?',
        { title: 'No Exam IDs', okLabel: 'Save anyway' }))) return;
    }

    const exam = {
      id: original?.id || null,
      label: val('exam-f-label'),
      type: val('exam-f-type'),
      starts_at: starts ? starts.toISOString() : null,
      duration_minutes: duration ? parseInt(duration, 10) : null,
      hall: val('exam-f-hall'),
      grading_key: val('exam-f-grading'),
      weight: weight === '' ? null : parseFloat(weight),
      base: parseFloat(val('exam-f-base')) || 100,
      sign_in: signIn,
      shuffle_questions: document.getElementById('exam-f-shuffle').checked,
      settings: {
        watermark: true,
        date_only: dateOnly,
        leave,
        cooldown_seconds: leave === 'cooldown' ? cooldown : settingsOf(original || source).cooldown_seconds,
      },
      visible: document.getElementById('exam-f-visible').checked,
      results_published: document.getElementById('exam-f-published').checked,
      ...(original ? {} : { questions }), // a duplicate copies them; settings never change them
    };
    const btn = document.getElementById('exam-edit-save');
    btn.disabled = true;
    try {
      const id = await rpc('exam_save_exam', { p_sheet: EX.course, p_archive: EX.isArchive, p_exam: exam,
        p_password: clearPassword ? '' : (password || null) });
      if (original) original.password = password || (clearPassword ? null : original.password);
      _editorSnapshot = null;
      overlay('exam-edit').close();
      if (original?.results_published && !exam.results_published && original.grading_key) {
        original.results_published = false; // no longer counts as showing the entry's grades
        markGradingDone(EX.course, EX.isArchive, [original.grading_key], false)
          .catch(error => toast(`${gradingLabel(original.grading_key) || 'The assessment'} is still marked Done: ${error.message}`, 'err'));
      }
      toast(original ? 'Saved' : 'Exam added', 'ok');
      // A new exam goes on to its questions; settings opened from the questions return there.
      const next = !original && !questions.length ? id : returnToQuestions ? original.id : null;
      await reloadExams();
      if (next && examById(next)) showQuestions(next);
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }


  // ════════════════════════════════════════════════════════════════════════
  // Questions editor (inside the Exams tab, once the exam exists)
  // ════════════════════════════════════════════════════════════════════════

  const CODE_LANGUAGES = { python: 'Python', javascript: 'JavaScript', java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', matlab: 'MATLAB', r: 'R', sql: 'SQL', other: 'Other' };
  const num = text => { const n = parseFloat(String(text ?? '').trim().replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const lines = text => String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  // Answers and tolerances as entered: fmt() rounds to one decimal, which suits weights only.
  const exact = value => (Number.isFinite(Number(value)) ? String(Number(value)) : '');

  async function showQuestions(examId, body = document.getElementById('section-body')) {
    const exam = examById(examId);
    if (!exam || !canManage()) return;
    EX.view = 'questions';
    EX.examId = examId;
    body.onclick = onQuestionsClick;
    body.onchange = onQuestionsChange;
    body.oninput = onQuestionsInput;
    body.onkeydown = onQuestionsKeydown;
    body.onpaste = onQuestionsPaste;
    body.ondragover = onQuestionsDragOver;
    body.ondragleave = onQuestionsDragLeave;
    body.ondrop = onQuestionsDrop;
    body.innerHTML = questionsViewHtml(exam);
    const imagesLoaded = loadImages(exam); // started first, so the cards say their images are loading
    const list = document.getElementById('qe-list');
    const questions = exam.questions || [];
    questions.forEach(q => list.appendChild(questionCard(q, { collapsed: questions.length > 4 })));
    refreshQuestions();
    if (window.Sortable) {
      Sortable.create(list, { handle: '.qcard-grip', animation: 150, ghostClass: 'qcard-ghost', onEnd: refreshQuestions });
    }
    finishSectionLoad(body);
    imagesLoaded.then(() => { if (EX.view === 'questions' && EX.examId === examId) questionCards().forEach(card => { renderCardImages(card); renderOptions(card); }); });
  }

  // The questions editor: a floating bar (All exams; Add question, Select, Fold all; Preview,
  // Settings, the ⋯ menu with import and export; Save), then one card per question. A card folds
  // to a line; open, it is the question ready to edit: the text with its formatting tools, its
  // images, the answer (the correct one marked). Its head moves, duplicates and deletes it. With
  // Select, several questions get their points set, or are duplicated or deleted together.
  function questionsViewHtml(exam) {
    const more = [
      { label: 'Import questions', icon: 'fa-solid fa-file-import', attrs: 'data-qe="import"', hint: 'From a file, Claude, or another exam' },
      { label: 'Export questions', icon: 'fa-solid fa-file-export', attrs: 'data-qe="export"', hint: 'As a file, with their images' },
    ];
    return `
      <div class="section-topbar qe-topbar">
        <button type="button" class="btn-sm btn-secondary" data-qe="back"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>All exams</button>
        <div class="add-bar qe-tools">
          ${addQuestionHtml('qe-add-top')}
          <button type="button" class="btn-sm btn-secondary" data-qe="select" title="Select questions: set their points, duplicate or delete them together"><i class="fa-regular fa-square-check"></i> Select</button>
          <button type="button" class="btn-sm btn-secondary qe-collapse" data-qe="collapse"><i class="fa-solid fa-down-left-and-up-right-to-center"></i> <span>Fold all</span></button>
        </div>
        <div class="add-bar qe-select-bar" hidden>
          <span class="qe-select-count" id="qe-select-count">0 selected</span>
          <button type="button" class="btn-sm btn-secondary" data-qe="select-all">All</button>
          <label class="qe-select-points"><span class="sr-only">Points</span><input type="number" id="qe-select-points" min="0" step="0.5" placeholder="Points" data-no-dirty></label>
          <button type="button" class="btn-sm btn-secondary" data-qe="select-points" title="Give the selected questions these points">Set points</button>
          <button type="button" class="btn-sm btn-secondary" data-qe="select-duplicate"><i class="fa-solid fa-copy"></i> Duplicate</button>
          <button type="button" class="btn-sm btn-red" data-qe="select-delete"><i class="fa-solid fa-trash"></i> Delete</button>
          <button type="button" class="btn-sm btn-secondary" data-qe="select-done">Done</button>
        </div>
        <div class="add-bar">
          <button type="button" class="btn-sm btn-secondary" data-qe="preview" title="Take the exam as a student would, in a new tab, with the questions as they are here. Nothing is saved or sent."><i class="fa-solid fa-eye"></i> Preview</button>
          <button type="button" class="btn-sm btn-secondary" data-qe="settings" title="Date, sign-in, password, leaving the page"><i class="fa-solid fa-gear"></i> Settings</button>
        </div>
        ${rowMenuHtml(more, { label: 'More: import and export' })}
        <button class="btn-sm btn-save-section is-clean" id="section-save-btn" disabled title="Nothing to save" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      </div>
      <div class="qe-head">
        <div class="qe-head-text"><h3 class="qe-title">${x(examTitle(exam))}</h3>
          <div class="exam-muted" id="qe-summary"></div></div>
      </div>
      ${exam.submission_count ? `<p class="form-hint exam-edit-warning"><i class="fa-solid fa-circle-info"></i>
        <span>${exam.submission_count} student${exam.submission_count === 1 ? ' has' : 's have'} submitted. Their answers and grades follow each question when you move, add or remove questions; changing a question's text or options does not change what they answered.</span></p>` : ''}
      ${examStatus(exam).key === 'open' ? `<p class="form-hint exam-edit-warning qe-live"><i class="fa-solid fa-tower-broadcast"></i>
        <span>The exam is open now. Students get your changes within half a minute: a question you change loses their answer to it, new ones are added, removed ones go.</span></p>` : ''}
      <div class="qe-list" id="qe-list"></div>
      <div class="qe-empty" id="qe-empty">
        <i class="fa-solid fa-list-check" aria-hidden="true"></i>
        <p><strong>No questions yet.</strong> Add the first one, or import them.</p>
        <p class="form-hint">An exam without questions is held on paper: students see its date and hall, and you enter the grades on its Grades page.</p>
      </div>
      <div class="qe-add-foot">${addQuestionHtml('qe-add-bottom')}</div>`;
  }

  // Add question: a short menu of the types, each with a line on what it asks for.
  function addQuestionHtml(className) {
    return `<div class="qe-add ${className}">
        <button type="button" class="btn-sm btn-green qe-add-btn" data-qe="add-menu" aria-haspopup="menu" aria-expanded="false"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add question</button>
        <div class="qe-add-menu" role="menu" hidden>${Object.entries(QUESTION_TYPES).map(([id, t]) =>
          `<button type="button" role="menuitem" data-qe-add="${id}"><i class="${t.icon}" aria-hidden="true"></i><span><strong>${x(t.label)}</strong><small>${x(t.hint)}</small></span></button>`).join('')}</div>
      </div>`;
  }

  // An option: whether it is the correct one, its letter (students see a, b, c… in their own
  // order), an image if it has one, its text.
  function optionRowHtml(text = '', correct = false, image = '') {
    return `<div class="q-option${correct ? ' is-correct' : ''}">
      <input type="hidden" class="q-opt-image" value="${x(image)}">
      <label class="q-opt-check" title="The correct answer"><input type="checkbox" class="q-opt-correct" ${correct ? 'checked' : ''} aria-label="The correct answer"><i class="fa-solid fa-check" aria-hidden="true"></i></label>
      <span class="q-opt-letter" aria-hidden="true"></span>
      <span class="q-opt-thumb"></span>
      <input type="text" class="q-opt-text" value="${x(text)}" aria-label="Option" placeholder="Option">
      <button type="button" class="qcard-btn" data-qc="option-image" title="An image for this option" aria-label="Add an image to this option"><i class="fa-regular fa-image"></i></button>
      <button type="button" class="qcard-btn" data-qc="remove-option" title="Remove option" aria-label="Remove option"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }

  // The options' letters and images, as they are now.
  function renderOptions(card) {
    card.querySelectorAll('.q-option').forEach((row, i) => {
      row.querySelector('.q-opt-letter').textContent = `${String.fromCharCode(97 + i)})`;
      const id = row.querySelector('.q-opt-image').value, src = id && EX.images[id];
      row.classList.toggle('has-image', !!id);
      row.querySelector('.q-opt-thumb').innerHTML = !id ? '' : `${src ? `<img src="${x(src)}" alt="" draggable="false">` : '<i class="fa-regular fa-image" aria-hidden="true"></i>'}
        <button type="button" class="q-image-remove" data-qc="remove-option-image" title="Remove the image" aria-label="Remove the image"><i class="fa-solid fa-xmark"></i></button>`;
    });
  }

  // One question as an editable card. Every type's fields are kept, so switching type and
  // back loses nothing; only the current type's are saved.
  function questionCard(q = {}, { collapsed = false } = {}) {
    const type = QUESTION_TYPES[q.type] ? q.type : 'short_answer';
    const options = Array.isArray(q.options) && q.options.length ? q.options : ['', '', ''];
    const optionImages = Array.isArray(q.option_images) ? q.option_images : [];
    const correct = new Set(q.correct_answers || []);
    // A question keeps the id it came with (the server checks ids), so its answers follow it.
    const qid = typeof q.id === 'string' && q.id && q.id.length <= 40 ? q.id : newQuestionId();
    const size = IMAGE_SIZES[q.image_size] ? q.image_size : 'medium';
    const card = document.createElement('article');
    card.className = `qcard${collapsed ? ' is-collapsed' : ''}`;
    card.dataset.type = type;
    card.dataset.qid = qid;
    card.innerHTML = `
      <header class="qcard-head">
        <span class="qcard-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></span>
        <label class="qcard-select" hidden><input type="checkbox" class="qcard-select-box" data-no-dirty aria-label="Select this question"></label>
        <span class="qcard-num"></span>
        <span class="qcard-type"><i class="${QUESTION_TYPES[type].icon}" aria-hidden="true"></i><span>${x(QUESTION_TYPES[type].label)}</span></span>
        <label class="qcard-type-pick"><span class="sr-only">Type</span>
          <select class="q-type">${Object.entries(QUESTION_TYPES).map(([id, t]) => `<option value="${id}" ${id === type ? 'selected' : ''}>${x(t.label)}</option>`).join('')}</select></label>
        <span class="qcard-summary"></span>
        <span class="qcard-badges"></span>
        <span class="qcard-actions">
          <button type="button" class="qcard-btn" data-qc="up" title="Move up" aria-label="Move up"><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="qcard-btn" data-qc="down" title="Move down" aria-label="Move down"><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" class="qcard-btn" data-qc="duplicate" title="Duplicate" aria-label="Duplicate"><i class="fa-regular fa-copy"></i></button>
          <button type="button" class="qcard-btn qcard-delete" data-qc="delete" title="Delete" aria-label="Delete"><i class="fa-regular fa-trash-can"></i></button>
        </span>
        <span class="qcard-points"></span>
        <label class="qcard-points-edit q-points-wrap"><input type="number" class="q-points" min="0" step="0.5" value="${x(q.points ?? 1)}" aria-label="Points"><span>points</span></label>
        <button type="button" class="qcard-btn qcard-toggle" data-qc="toggle" title="Open or fold" aria-label="Open or fold" aria-expanded="${!collapsed}"><i class="fa-solid fa-chevron-down"></i></button>
      </header>
      <div class="qcard-body">
        <div class="form-group q-text">
          <div class="q-editor">
            <div class="q-text-head">${toolbarHtml()}</div>
            <textarea class="q-prompt" rows="3" aria-label="${type === 'text_only' ? 'Text' : 'Question'}" placeholder="${type === 'text_only' ? 'Instructions or a heading' : 'Type the question. Paste or drop an image to add it.'}">${x(q.prompt || '')}</textarea>
          </div>
          <div class="q-shows-as" hidden><span class="q-shows-as-label">Shows as</span><div class="q-shows-as-text"></div></div>
          <input type="file" class="q-image-input" hidden data-no-dirty accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple>
          <input type="hidden" class="q-image-ids" value="${x(imageIdsOf([q]).join(','))}">
          <input type="hidden" class="q-image-size" value="${size}">
          <div class="q-images"></div>
          <div class="q-image-size-row" hidden><span class="q-image-size-label">Image size</span>
            <span class="q-seg" role="group" aria-label="Image size">${Object.entries(IMAGE_SIZES).map(([id, label]) =>
              `<button type="button" data-qc="image-size" data-size="${id}" aria-pressed="${id === size}">${label}</button>`).join('')}</span>
            <span class="form-hint">Students can click an image to see it larger.</span></div>
        </div>
        <div class="q-part" data-part="multiple_select">
          <p class="q-part-title">Answer options <span class="label-note">tick the correct one</span></p>
          <div class="q-options">${options.map((o, i) => optionRowHtml(o, correct.has(o), typeof optionImages[i] === 'string' ? optionImages[i] : '')).join('')}</div>
          <input type="file" class="q-opt-image-input" hidden data-no-dirty accept="image/png,image/jpeg,image/webp,image/gif,image/bmp">
          <button type="button" class="exam-link-btn q-add-option" data-qc="add-option"><i class="fa-solid fa-plus"></i> Add option</button>
          <p class="form-hint">Enter adds the next option; pasting several lines adds one per line. An option can have an image. Students see them lettered, in a shuffled order.</p>
        </div>
        <div class="q-part" data-part="true_false">
          <p class="q-part-title">Correct answer</p>
          <div class="q-seg q-tf" role="radiogroup" aria-label="Correct answer">${[['true', 'True'], ['false', 'False']].map(([value, label]) =>
            `<label><input type="radio" class="q-tf-value" name="tf-${qid}" value="${value}" ${q.type === 'true_false' && String(q.answer) === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
        </div>
        <div class="q-part" data-part="short_answer">
          <p class="q-part-title">Accepted answers <span class="label-note">one per line</span></p>
          <textarea class="q-accepted" rows="2" placeholder="e.g. 1:100">${x((q.accepted_answers || []).join('\n'))}</textarea>
          <p class="form-hint">Autograding accepts these, ignoring capitals and extra spaces. Leave empty to grade by hand.</p>
        </div>
        <div class="q-part" data-part="numeric">
          <p class="q-part-title">Correct answer</p>
          <div class="qcard-row qcard-row-3">
            <div class="form-group"><label class="form-label">Answer</label>
              <input type="text" inputmode="decimal" class="q-answer" value="${x(q.type === 'numeric' ? q.answer ?? '' : '')}"></div>
            <div class="form-group"><label class="form-label">Tolerance (±)</label>
              <input type="text" inputmode="decimal" class="q-tolerance" value="${x(q.tolerance ?? '')}" placeholder="Exact"></div>
            <div class="form-group"><label class="form-label">Unit <span class="label-note">shown to students</span></label>
              <input type="text" class="q-unit" value="${x(q.unit || '')}"></div>
          </div>
        </div>
        <div class="q-part" data-part="long_answer">
          <p class="q-part-title">Model answer</p>
          <textarea class="q-model" rows="3">${x(type === 'long_answer' && typeof q.answer === 'string' ? q.answer : '')}</textarea>
          <p class="form-hint">Autograde gives points by how much of it an answer covers, and makes it your comment.</p>
          <p class="q-part-title">Starting text <span class="label-note">already in the answer box</span></p>
          <textarea class="q-content" rows="2">${x(type === 'long_answer' ? q.content || '' : '')}</textarea>
        </div>
        <div class="q-part" data-part="code">
          <div class="qcard-row"><div class="form-group"><label class="form-label">Language</label>
            <select class="q-language">${Object.entries(CODE_LANGUAGES).map(([id, label]) => `<option value="${id}" ${(q.language || 'python') === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
          <label class="form-label">Starter code</label>
          <textarea class="q-code" rows="6" spellcheck="false">${x(type === 'code' ? q.content || '' : '')}</textarea>
        </div>
        <div class="q-part" data-part="attachment">
          <div class="qcard-row">
            <div class="form-group"><label class="form-label">Allowed file types</label>
              <input type="text" class="q-file-types" placeholder=".dwg, .pdf" value="${x((q.allowed_types || []).join(', '))}"></div>
            <div class="form-group"><label class="form-label">Largest file (MB)</label>
              <input type="number" class="q-file-size" min="1" step="1" value="${x(q.max_size_mb ?? '')}" placeholder="50"></div>
          </div>
          <p class="form-hint">Students upload it during the exam; you download it on the Grades page. Empty: any type, up to 50 MB.</p>
        </div>
        <details class="q-explain"${q.explanation ? ' open' : ''}>
          <summary>Notes for grading <span class="label-note">shown to you when grading</span></summary>
          <textarea class="q-explanation" rows="2">${x(q.explanation || '')}</textarea>
        </details>
      </div>`;
    applyCardType(card, type);
    renderCardImages(card);
    renderOptions(card);
    renderShowsAs(card);
    return card;
  }

  // ── Question images ──
  const cardImageIds = card => card.querySelector('.q-image-ids').value.split(',').filter(Boolean);
  function setCardImageIds(card, ids) {
    card.querySelector('.q-image-ids').value = ids.join(',');
    renderCardImages(card);
    markDirty();
  }

  // The card's images (still loading, or gone if they never arrive), then any being added.
  function renderCardImages(card) {
    const holder = card.querySelector('.q-images');
    const adding = [...holder.querySelectorAll('.q-image.is-adding')];
    holder.innerHTML = cardImageIds(card).map((id, i) => {
      const src = EX.images[id];
      const note = _imagesLoading ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Loading' : '<i class="fa-regular fa-image" aria-hidden="true"></i>Not found';
      return `<figure class="q-image${src ? '' : ' is-missing'}" data-image-id="${x(id)}">
        ${src ? `<img src="${x(src)}" alt="Image ${i + 1}" draggable="false">` : `<span class="q-image-note">${note}</span>`}
        <button type="button" class="q-image-remove" data-qc="remove-image" title="Remove image" aria-label="Remove image ${i + 1}"><i class="fa-solid fa-xmark"></i></button>
      </figure>`;
    }).join('');
    adding.forEach(tile => holder.appendChild(tile));
    card.querySelector('.q-image-size-row').hidden = !cardImageIds(card).length;
  }

  // Scales an image down, on white (transparent drawings stay readable on dark screens), and
  // keeps the smaller of WebP and PNG: PNG is smaller for drawings and screenshots.
  async function shrinkImage(file) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('the browser cannot read this image'); }
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const encode = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
    const tries = await Promise.all([encode('image/webp', 0.9), encode('image/png')]);
    let blob = tries.filter(b => b && ['image/webp', 'image/png'].includes(b.type)).sort((a, b) => a.size - b.size)[0];
    if (!blob || blob.size > IMAGE_MAX_BYTES) blob = await encode('image/jpeg', 0.85);
    if (!blob || blob.size > IMAGE_MAX_BYTES) throw new Error('it is too large, even scaled down');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('it could not be read'));
      reader.readAsDataURL(blob);
    });
    return { mime: blob.type, dataUrl };
  }

  // Saves an image for the course's questions; returns its id.
  async function saveImage(file) {
    const { mime, dataUrl } = await shrinkImage(file);
    const id = await rpc('exam_add_image', { p_sheet: EX.course, p_archive: EX.isArchive, p_mime: mime, p_data: dataUrl });
    EX.images[id] = dataUrl;
    return id;
  }

  // Chosen, pasted or dropped images, added to the card one by one.
  async function addCardImages(card, files) {
    const images = files.filter(f => /^image\//.test(f.type));
    if (!images.length) { toast('Choose an image: PNG, JPEG or WebP', 'err'); return; }
    setCollapsed(card, false);
    for (const file of images) {
      const tile = document.createElement('figure');
      tile.className = 'q-image is-adding';
      tile.innerHTML = '<span class="q-image-note"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Adding</span>';
      card.querySelector('.q-images').appendChild(tile);
      try {
        const id = await saveImage(file);
        tile.remove();
        setCardImageIds(card, [...cardImageIds(card), id]);
      } catch (error) {
        tile.remove();
        toast(`Could not add ${file.name || 'the image'}: ${error.message}`, 'err');
      }
    }
    if (card.isConnected) refreshQuestions();
  }

  // Images by id for the exam's saved questions, fetched once per exam.
  let _imagesLoading = 0;
  async function loadImages(exam) {
    if (!allImageIdsOf(exam.questions).some(id => !(id in EX.images))) return;
    _imagesLoading++;
    try {
      Object.assign(EX.images, await rpc('exam_get_images', { p_exam_id: exam.id }));
    } catch (error) {
      toast(`The question images did not load: ${error.message}`, 'err');
    } finally {
      _imagesLoading--;
    }
  }

  const imageFilesOf = dataTransfer => [...(dataTransfer?.files || [])].filter(f => /^image\//.test(f.type));
  const draggingFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

  function onQuestionsDragOver(e) {
    if (S.section !== 'exams' || EX.view !== 'questions' || !draggingFiles(e)) return;
    const card = e.target.closest('.qcard');
    document.querySelectorAll('.qcard.is-drop-target').forEach(c => { if (c !== card) c.classList.remove('is-drop-target'); });
    if (!card) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    card.classList.add('is-drop-target');
  }

  function onQuestionsDragLeave(e) {
    const card = e.target.closest?.('.qcard');
    if (card && !card.contains(e.relatedTarget)) card.classList.remove('is-drop-target');
  }

  function onQuestionsDrop(e) {
    if (S.section !== 'exams' || EX.view !== 'questions' || !draggingFiles(e)) return;
    const card = e.target.closest('.qcard');
    document.querySelectorAll('.qcard.is-drop-target').forEach(c => c.classList.remove('is-drop-target'));
    if (!card) return;
    e.preventDefault();
    addCardImages(card, [...e.dataTransfer.files]);
  }

  function applyCardType(card, type) {
    card.dataset.type = type;
    card.querySelectorAll('.q-part').forEach(p => { p.hidden = p.dataset.part !== type; });
    card.querySelector('.q-points-wrap').hidden = type === 'text_only';
    card.querySelector('.q-explain').hidden = type === 'text_only';
    const prompt = card.querySelector('.q-prompt');
    prompt.setAttribute('aria-label', type === 'text_only' ? 'Text' : 'Question');
    prompt.placeholder = type === 'text_only' ? 'Instructions or a heading' : 'Type the question. Paste or drop an image to add it.';
    card.querySelector('.qcard-type').innerHTML = `<i class="${QUESTION_TYPES[type].icon}" aria-hidden="true"></i><span>${x(QUESTION_TYPES[type].label)}</span>`;
  }

  const questionCards = () => [...document.querySelectorAll('#qe-list .qcard')];

  // Numbers, summaries, totals and the empty state, after any change. A question with text
  // shows in its head what it still needs (cardProblems), so it shows while folded too.
  function refreshQuestions() {
    const cards = questionCards();
    let n = 0, points = 0, attention = 0;
    cards.forEach((card, i) => {
      const type = card.dataset.type;
      const info = type === 'text_only';
      card.querySelector('.qcard-num').innerHTML = info ? '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>' : String(++n);
      const firstLine = card.querySelector('.q-prompt').value.split('\n').find(l => l.trim()) || '';
      const summary = card.querySelector('.qcard-summary');
      summary.innerHTML = formatQuestionText.inline(firstLine.replace(/^\s*([-•]|\d+[.)])\s+/, '')) || 'No text yet';
      summary.classList.toggle('is-empty', !firstLine);
      const p = num(card.querySelector('.q-points').value) ?? 0;
      if (!info) points += p;
      card.querySelector('.qcard-points').textContent = info ? '' : `${fmt(p)} pt`;
      const images = cardImageIds(card).length;
      const issue = firstLine || images ? cardProblems(card).find(p => p[2])?.[2] : '';
      if (issue) attention++;
      card.querySelector('.qcard-badges').innerHTML = (issue ? `<span class="qcard-badge is-warn" title="To fix before saving">${x(issue)}</span>` : '') + (images
        ? `<span class="qcard-badge" title="${images} image${images === 1 ? '' : 's'}"><i class="fa-regular fa-image" aria-hidden="true"></i>${images}</span>` : '');
      card.querySelector('[data-qc="up"]').disabled = i === 0;
      card.querySelector('[data-qc="down"]').disabled = i === cards.length - 1;
      if (type === 'multiple_select') renderOptions(card);
    });
    document.getElementById('qe-empty').hidden = cards.length > 0;
    document.getElementById('qe-summary').textContent = cards.length
      ? `${n} question${n === 1 ? '' : 's'}, ${fmt(points)} point${points === 1 ? '' : 's'}${cards.length > n ? `, ${cards.length - n} information` : ''}${attention ? `, ${attention} to fix` : ''}`
      : 'No questions yet';
    const collapse = document.querySelector('[data-qe="collapse"]');
    if (collapse) {
      collapse.disabled = cards.length < 2;
      const open = cards.length && cards.some(c => c.classList.contains('is-collapsed'));
      const label = open ? 'Open all' : 'Fold all';
      if (collapse.dataset.label !== label) {
        collapse.dataset.label = label;
        collapse.innerHTML = `<i class="fa-solid ${open ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center'}"></i> <span>${label}</span>`;
      }
    }
    updateQuestionSelection();
  }

  // Opening a card folds the others (one question at a time), unless all are opened together.
  function setCollapsed(card, collapsed, alone = false) {
    if (!collapsed && alone) questionCards().forEach(c => { if (c !== card) setCollapsed(c, true); });
    card.classList.toggle('is-collapsed', collapsed);
    card.querySelector('.qcard-toggle').setAttribute('aria-expanded', String(!collapsed));
  }

  // A new question goes after the open one (or at the end), opened, with its text focused.
  function addQuestion(type, after = questionCards().find(c => !c.classList.contains('is-collapsed')) || null) {
    const card = questionCard({ type, points: type === 'text_only' ? undefined : 1 });
    const list = document.getElementById('qe-list');
    if (after) after.after(card); else list.appendChild(card);
    setCollapsed(card, false, true);
    refreshQuestions();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.querySelector('.q-prompt').focus({ preventScroll: true }), 250);
    return card;
  }

  // Add question (at the top or the foot): its menu of types opens; any other closes.
  function toggleAddMenu(open, holder = null) {
    document.querySelectorAll('.qe-add').forEach(add => {
      const menu = add.querySelector('.qe-add-menu');
      const show = add === holder && (open === undefined ? menu.hidden : open);
      menu.hidden = !show;
      add.querySelector('[data-qe="add-menu"]').setAttribute('aria-expanded', String(show));
      if (show) menu.querySelector('button')?.focus({ preventScroll: true });
    });
  }
  document.addEventListener('click', e => { if (!e.target.closest?.('.qe-add')) toggleAddMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('.qe-add-menu:not([hidden])')) toggleAddMenu(false); });

  async function onQuestionsClick(e) {
    if (S.section !== 'exams' || EX.view !== 'questions') return;
    const add = e.target.closest('[data-qe-add]');
    if (add) {
      const atTop = !!add.closest('.qe-add-top');
      toggleAddMenu(false);
      // From the top bar: after the open question, else first; from the foot: last.
      const open = questionCards().find(c => !c.classList.contains('is-collapsed'));
      if (atTop && !open) {
        const card = addQuestion(add.dataset.qeAdd, null);
        document.getElementById('qe-list').prepend(card);
        refreshQuestions();
        return card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return addQuestion(add.dataset.qeAdd, atTop ? open : null);
    }
    const menuButton = e.target.closest('[data-qe="add-menu"]');
    if (menuButton) return toggleAddMenu(undefined, menuButton.closest('.qe-add'));
    const action = e.target.closest('[data-qe]')?.dataset.qe;
    if (action) return onQuestionsAction(action);
    const card = e.target.closest('.qcard');
    if (!card) return;
    if (e.target.closest('.qcard-select')) return updateQuestionSelection();
    const btn = e.target.closest('[data-qc]');
    if (!btn) {
      // A click on the header (not its fields or buttons) opens or folds the card.
      if (e.target.closest('.qcard-head') && !e.target.closest('.qcard-grip, select, input, label')) {
        setCollapsed(card, !card.classList.contains('is-collapsed'), true);
        refreshQuestions();
      }
      return;
    }
    switch (btn.dataset.qc) {
      case 'toggle': setCollapsed(card, !card.classList.contains('is-collapsed'), true); break;
      case 'up': card.previousElementSibling?.before(card); break;
      case 'down': card.nextElementSibling?.after(card); break;
      case 'duplicate': {
        const copy = questionCard({ ...readCard(card), id: newQuestionId() });
        card.after(copy);
        setCollapsed(copy, false, true);
        copy.scrollIntoView({ behavior: 'smooth', block: 'center' });
        markDirty();
        break;
      }
      case 'delete': {
        const text = card.querySelector('.q-prompt').value.trim();
        if (text && !(await confirmDialog('Delete this question?', { title: 'Delete Question', okLabel: 'Delete', danger: true, okIcon: 'fa-trash-can' }))) return;
        card.remove();
        break;
      }
      case 'add-option': {
        const row = addOption(card.querySelector('.q-options'));
        row.querySelector('.q-opt-text').focus();
        break;
      }
      case 'remove-option': {
        const options = card.querySelector('.q-options');
        if (options.children.length <= 2) { toast('A multiple-choice question needs at least two options', 'err'); return; }
        btn.closest('.q-option').remove();
        break;
      }
      case 'remove-image': {
        const id = btn.closest('.q-image')?.dataset.imageId;
        setCardImageIds(card, cardImageIds(card).filter(i => i !== id));
        break;
      }
      case 'option-image': {
        card._imageOption = btn.closest('.q-option');
        card.querySelector('.q-opt-image-input').click();
        return;
      }
      case 'remove-option-image': {
        btn.closest('.q-option').querySelector('.q-opt-image').value = '';
        renderOptions(card);
        markDirty();
        break;
      }
      case 'format': applyFormat(card.querySelector('.q-prompt'), btn.dataset.format); break;
      case 'symbols': toggleSymbols(card, btn); return;
      case 'symbol': insertText(card.querySelector('.q-prompt'), btn.dataset.symbol); toggleSymbols(card, null, false); break;
      case 'image': card.querySelector('.q-image-input').click(); return;
      case 'image-size':
        card.querySelector('.q-image-size').value = btn.dataset.size;
        card.querySelectorAll('[data-qc="image-size"]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        markDirty();
        break;
    }
    refreshQuestions();
  }

  // ── Formatting the question's text (js/format-text.js reads the marks) ──
  const FORMATS = {
    bold: { mark: '**', icon: 'fa-bold', title: 'Bold (Ctrl+B)', key: 'b' },
    italic: { mark: '*', icon: 'fa-italic', title: 'Italic (Ctrl+I)', key: 'i' },
    underline: { mark: '__', icon: 'fa-underline', title: 'Underline (Ctrl+U)', key: 'u' },
    sup: { mark: '^', icon: 'fa-superscript', title: 'Superscript, as in m² (no spaces inside)' },
    sub: { mark: '~', icon: 'fa-subscript', title: 'Subscript, as in H₂O (no spaces inside)' },
    code: { mark: '`', icon: 'fa-code', title: 'Code, in a fixed-width font' },
    bullets: { list: /^\s*[-•]\s+/, icon: 'fa-list-ul', title: 'Bulleted list' },
    numbers: { list: /^\s*\d+[.)]\s+/, icon: 'fa-list-ol', title: 'Numbered list' },
  };
  const SYMBOLS = ['°', '±', '×', '÷', '≈', '≠', '≤', '≥', '√', '∞', '²', '³', '½', 'π', 'Δ', 'Σ', 'Ω', 'α', 'β', 'γ', 'δ', 'ε',
    'θ', 'λ', 'μ', 'ρ', 'σ', 'τ', 'φ', 'ω', '∠', '⊥', '∥', '∫', '∂', '→', '⇒', '↔'];

  // The toolbar above a question's text: formats, symbols, an image.
  function toolbarHtml() {
    const tool = (id, f) => `<button type="button" class="btn-secondary q-tool" data-qc="format" data-format="${id}" title="${x(f.title)}" aria-label="${x(f.title)}"><i class="fa-solid ${f.icon}" aria-hidden="true"></i></button>`;
    const group = ids => `<span class="q-tool-group">${ids.map(id => tool(id, FORMATS[id])).join('')}</span>`;
    return `<span class="q-tools" role="toolbar" aria-label="Formatting">
      ${group(['bold', 'italic', 'underline'])}${group(['sup', 'sub', 'code'])}${group(['bullets', 'numbers'])}
      <span class="q-tool-group q-symbols-wrap">
        <button type="button" class="btn-secondary q-tool" data-qc="symbols" title="Insert a symbol" aria-label="Insert a symbol" aria-expanded="false">Ω</button>
        <span class="q-symbols" role="group" aria-label="Symbols" hidden>${SYMBOLS.map(s => `<button type="button" class="q-symbol" data-qc="symbol" data-symbol="${s}" aria-label="${s}">${s}</button>`).join('')}</span>
      </span>
      <button type="button" class="btn-secondary q-tool q-tool-wide" data-qc="image" title="Add an image: a drawing, a figure (or paste or drop one)"><i class="fa-regular fa-image" aria-hidden="true"></i><span>Image</span></button>
    </span>`;
  }

  // A mark around the selection, or off again; with nothing selected, a word to type over.
  // A list: the selected lines become one, or plain again.
  function applyFormat(area, id) {
    const f = FORMATS[id];
    if (!f) return;
    const value = area.value;
    let start = area.selectionStart, end = area.selectionEnd;
    area.focus();
    if (f.list) {
      start = value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
      end = lineEnd < 0 ? value.length : lineEnd;
      const lines = value.slice(start, end).split('\n');
      const on = lines.some(l => l.trim()) && lines.every(l => f.list.test(l) || !l.trim());
      let n = 0;
      const next = lines.map(l => {
        if (!l.trim()) return l;
        const text = l.replace(/^\s*([-•]|\d+[.)])\s+/, '');
        return on ? text : `${id === 'bullets' ? '-' : `${++n}.`} ${text}`;
      });
      area.setRangeText(next.join('\n'), start, end, 'select');
    } else {
      const m = f.mark, chosen = value.slice(start, end);
      const wrapped = chosen.length > 2 * m.length && chosen.startsWith(m) && chosen.endsWith(m);
      const around = chosen && value.slice(start - m.length, start) === m && value.slice(end, end + m.length) === m
        && (m !== '*' || (value[start - 2] !== '*' && value[end + 1] !== '*'));
      if (wrapped) area.setRangeText(chosen.slice(m.length, -m.length), start, end, 'select');
      else if (around) area.setRangeText(chosen, start - m.length, end + m.length, 'select');
      else {
        const inner = chosen || 'text';
        area.setRangeText(`${m}${inner}${m}`, start, end, 'end');
        area.setSelectionRange(start + m.length, start + m.length + inner.length);
      }
    }
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertText(area, text) {
    area.focus();
    area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // The symbols under Ω: opened and closed by it, closed by a symbol, a click elsewhere or Escape.
  function toggleSymbols(card, btn, open) {
    document.querySelectorAll('.q-symbols:not([hidden])').forEach(list => {
      if (list.closest('.qcard') !== card) { list.hidden = true; list.previousElementSibling?.setAttribute('aria-expanded', 'false'); }
    });
    const list = card?.querySelector('.q-symbols');
    if (!list) return;
    list.hidden = open === undefined ? !list.hidden : !open;
    card.querySelector('[data-qc="symbols"]').setAttribute('aria-expanded', String(!list.hidden));
  }
  document.addEventListener('click', e => { if (!e.target.closest?.('.q-symbols-wrap')) toggleSymbols(null); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.querySelector('.q-symbols:not([hidden])')) { e.stopPropagation(); toggleSymbols(null); }
  }, true);
  // A press on the toolbar keeps the text's focus and selection.
  document.addEventListener('mousedown', e => { if (e.target.closest?.('.q-tool[data-qc="format"], .q-symbol')) e.preventDefault(); });

  // "Shows as": how formatted text will look, under it while it has marks.
  function renderShowsAs(card) {
    const text = card.querySelector('.q-prompt').value;
    const box = card.querySelector('.q-shows-as');
    box.hidden = !formatQuestionText.hasMarks(text);
    if (!box.hidden) box.querySelector('.q-shows-as-text').innerHTML = formatQuestionText(text);
  }

  function addOption(options, after = null, text = '') {
    const holder = document.createElement('div');
    holder.innerHTML = optionRowHtml(text);
    const row = holder.firstElementChild;
    if (after) after.after(row); else options.appendChild(row);
    const card = options.closest('.qcard');
    if (card) renderOptions(card);
    return row;
  }

  function onQuestionsChange(e) {
    if (S.section !== 'exams' || EX.view !== 'questions') return;
    const card = e.target.closest('.qcard');
    if (!card) return;
    if (e.target.matches('.q-type')) { applyCardType(card, e.target.value); refreshQuestions(); }
    if (e.target.matches('.q-opt-correct')) { e.target.closest('.q-option').classList.toggle('is-correct', e.target.checked); refreshQuestions(); }
    if (e.target.matches('.q-tf-value')) refreshQuestions();
    if (e.target.matches('.q-image-input')) {
      const files = [...e.target.files];
      e.target.value = ''; // the same file can be chosen again, and the tab's draft check ignores it
      if (files.length) addCardImages(card, files);
    }
    if (e.target.matches('.q-opt-image-input')) {
      const file = e.target.files[0];
      e.target.value = '';
      if (file && card._imageOption) addOptionImage(card, card._imageOption, file);
    }
  }

  // An image for an option; an option with no text yet is named after its place ("Figure 2").
  async function addOptionImage(card, row, file) {
    if (!/^image\//.test(file.type)) { toast('Choose an image: PNG, JPEG or WebP', 'err'); return; }
    row.classList.add('is-adding');
    try {
      row.querySelector('.q-opt-image').value = await saveImage(file);
      const text = row.querySelector('.q-opt-text');
      if (!text.value.trim()) text.value = `Figure ${[...card.querySelectorAll('.q-option')].indexOf(row) + 1}`;
      renderOptions(card);
      markDirty();
      refreshQuestions();
    } catch (error) {
      toast(`Could not add ${file.name || 'the image'}: ${error.message}`, 'err');
    } finally {
      row.classList.remove('is-adding');
    }
  }

  function onQuestionsInput(e) {
    if (S.section !== 'exams' || EX.view !== 'questions') return;
    if (e.target.matches('.q-prompt, .q-points, .q-opt-text, .q-answer')) refreshQuestions();
    if (e.target.matches('.q-prompt')) renderShowsAs(e.target.closest('.qcard'));
    e.target.classList.remove('field-error');
  }

  // Ctrl/Cmd+B, I or U in a question's text or explanation: bold, italic, underline. In an
  // option: Enter adds the next one, Backspace on an empty one removes it.
  function onQuestionsKeydown(e) {
    const format = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
      && Object.keys(FORMATS).find(id => FORMATS[id].key === e.key.toLowerCase());
    if (format && e.target.matches?.('.q-prompt, .q-explanation')) {
      e.preventDefault();
      applyFormat(e.target, format);
      return;
    }
    if (!e.target.matches?.('.q-opt-text')) return;
    const row = e.target.closest('.q-option');
    if (e.key === 'Enter') {
      e.preventDefault();
      addOption(row.parentElement, row).querySelector('.q-opt-text').focus();
    } else if (e.key === 'Backspace' && !e.target.value && row.parentElement.children.length > 2) {
      e.preventDefault();
      const prev = row.previousElementSibling || row.nextElementSibling;
      row.remove();
      prev?.querySelector('.q-opt-text').focus();
    }
  }

  // A pasted image (a screenshot) goes to the question it is pasted in; text copied from Word
  // or Excel, which brings a picture of itself along, stays text. Pasting several lines into
  // an option makes one option per line ("a) ", "1. ", "- " dropped).
  function onQuestionsPaste(e) {
    const card = e.target.closest?.('.qcard');
    const images = imageFilesOf(e.clipboardData);
    if (card && images.length && !(e.clipboardData.getData('text/plain') || '').trim()) {
      e.preventDefault();
      addCardImages(card, images);
      return;
    }
    if (!e.target.matches?.('.q-opt-text')) return;
    const text = e.clipboardData?.getData('text') || '';
    const parts = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.replace(/^(?:\(?[a-zA-Z]\)|[a-zA-Z][.)]|\d+[.)]|[-•*])\s+/, ''));
    if (parts.length < 2) return;
    e.preventDefault();
    const row = e.target.closest('.q-option');
    e.target.value = parts[0];
    let last = row;
    for (const part of parts.slice(1)) {
      const next = last.nextElementSibling;
      if (next && !next.querySelector('.q-opt-text').value) { next.querySelector('.q-opt-text').value = part; last = next; }
      else last = addOption(row.parentElement, last, part);
    }
    refreshQuestions();
  }

  async function onQuestionsAction(action) {
    const exam = examById(EX.examId);
    if (action === 'back') {
      if (!(await confirmLeaveIfDirty())) return;
      return reloadExams();
    }
    if (action === 'collapse') {
      const cards = questionCards();
      const open = cards.some(c => c.classList.contains('is-collapsed'));
      cards.forEach(c => setCollapsed(c, !open));
      return refreshQuestions();
    }
    if (action.startsWith('select')) return onSelectAction(action);
    if (action === 'settings') {
      if (!(await confirmLeaveIfDirty())) return;
      return openExamEditor(exam, false, true);
    }
    if (action === 'preview') return tryAsStudent(exam, collectQuestionCards({ strict: false }));
    if (action === 'export') return exportQuestionsJson(exam, collectQuestionCards({ strict: false }));
    if (action === 'import') return openImport(exam);
  }

  // ── Select: several questions at once ──
  // Select shows a box on each card; the bar's buttons then act on the ticked ones.
  const selectedCards = () => questionCards().filter(c => c.querySelector('.qcard-select-box')?.checked);
  function setSelecting(on) {
    document.querySelector('.qe-tools').hidden = on;
    document.querySelector('.qe-select-bar').hidden = !on;
    questionCards().forEach(card => {
      card.querySelector('.qcard-select').hidden = !on;
      if (!on) card.querySelector('.qcard-select-box').checked = false;
    });
    document.getElementById('qe-list').classList.toggle('is-selecting', on);
    updateQuestionSelection();
  }
  function updateQuestionSelection() {
    const count = document.getElementById('qe-select-count');
    if (!count) return;
    const chosen = selectedCards();
    questionCards().forEach(card => card.classList.toggle('is-selected', !!card.querySelector('.qcard-select-box')?.checked));
    count.textContent = `${chosen.length} selected`;
    document.querySelectorAll('[data-qe="select-points"], [data-qe="select-duplicate"], [data-qe="select-delete"]').forEach(b => { b.disabled = !chosen.length; });
  }

  async function onSelectAction(action) {
    const chosen = selectedCards();
    if (action === 'select') return setSelecting(true);
    if (action === 'select-done') return setSelecting(false);
    if (action === 'select-all') {
      const all = chosen.length < questionCards().length;
      questionCards().forEach(c => { c.querySelector('.qcard-select-box').checked = all; });
      return updateQuestionSelection();
    }
    if (!chosen.length) return;
    if (action === 'select-points') {
      const input = document.getElementById('qe-select-points');
      const points = num(input.value);
      if (points == null || points < 0) { input.classList.add('field-error'); input.focus(); return toast('Type the points: 0 or more', 'err'); }
      input.classList.remove('field-error');
      const questions = chosen.filter(c => c.dataset.type !== 'text_only');
      questions.forEach(c => { c.querySelector('.q-points').value = points; });
      markDirty();
      refreshQuestions();
      return toast(`${questions.length} question${questions.length === 1 ? '' : 's'}: ${fmt(points)} point${points === 1 ? '' : 's'} each`, 'ok');
    }
    if (action === 'select-duplicate') {
      let last = chosen[chosen.length - 1];
      for (const card of chosen) {
        const copy = questionCard({ ...readCard(card), id: newQuestionId() }, { collapsed: true });
        last.after(copy);
        last = copy;
        copy.querySelector('.qcard-select').hidden = false;
      }
      markDirty();
      refreshQuestions();
      return toast(`Duplicated ${chosen.length}: the copies are after the last one selected`, 'ok');
    }
    if (action === 'select-delete') {
      if (!(await confirmDialog(`Delete ${chosen.length === 1 ? 'this question' : `these ${chosen.length} questions`}?`,
        { title: chosen.length === 1 ? 'Delete Question' : 'Delete Questions', okLabel: 'Delete', danger: true, okIcon: 'fa-trash-can' }))) return;
      chosen.forEach(card => card.remove());
      markDirty();
      refreshQuestions();
    }
  }

  // A card's question as stored (only its type's fields).
  function readCard(card) {
    const get = sel => card.querySelector(sel);
    const type = card.dataset.type;
    const q = { id: card.dataset.qid, type, prompt: get('.q-prompt').value.trim() };
    const images = cardImageIds(card);
    if (images.length) {
      q.images = images;
      const size = get('.q-image-size').value;
      if (size && size !== 'medium') q.image_size = size;
    }
    if (type !== 'text_only') {
      q.points = num(get('.q-points').value) ?? 0;
      const explanation = get('.q-explanation').value.trim();
      if (explanation) q.explanation = explanation;
    }
    if (type === 'multiple_select') {
      const rows = [...card.querySelectorAll('.q-option')].map(r => ({ text: r.querySelector('.q-opt-text').value.trim(),
        correct: r.querySelector('.q-opt-correct').checked, image: r.querySelector('.q-opt-image').value || null })).filter(r => r.text);
      q.options = rows.map(r => r.text);
      q.correct_answers = rows.filter(r => r.correct).map(r => r.text);
      if (rows.some(r => r.image)) q.option_images = rows.map(r => r.image);
    } else if (type === 'true_false') {
      const chosen = card.querySelector('.q-tf-value:checked')?.value;
      if (chosen) q.answer = chosen === 'true';
    } else if (type === 'short_answer') {
      const accepted = lines(get('.q-accepted').value);
      if (accepted.length) q.accepted_answers = accepted;
    } else if (type === 'numeric') {
      q.answer = num(get('.q-answer').value);
      const tolerance = num(get('.q-tolerance').value);
      if (tolerance) q.tolerance = Math.abs(tolerance);
      const unit = get('.q-unit').value.trim();
      if (unit) q.unit = unit;
    } else if (type === 'long_answer') {
      const model = get('.q-model').value.trim();
      if (model) q.answer = model;
      const content = get('.q-content').value;
      if (content.trim()) q.content = content;
    } else if (type === 'code') {
      q.language = get('.q-language').value;
      const code = get('.q-code').value;
      if (code.trim()) q.content = code;
    } else if (type === 'attachment') {
      const types = get('.q-file-types').value.split(/[,\s]+/).map(t => t.trim()).filter(Boolean).map(t => t.startsWith('.') ? t : `.${t}`);
      if (types.length) q.allowed_types = types;
      const size = num(get('.q-file-size').value);
      if (size) q.max_size_mb = Math.round(size);
    }
    return q;
  }

  // The editor's questions. Strict (for saving): null after marking and showing what to fix.
  // What a question still needs before it can be saved: the field, the message on Save, and
  // the short form its head shows meanwhile (none for missing text: the head says so).
  function cardProblems(card, q = readCard(card)) {
    const out = [];
    if (!q.prompt && !q.images) out.push(['.q-prompt', 'it needs text or an image.', '']);
    if (q.type !== 'text_only' && (num(card.querySelector('.q-points').value) ?? -1) < 0) out.push(['.q-points', 'points must be 0 or more.', 'Points below 0']);
    if (q.type === 'multiple_select') {
      if (q.options.length < 2) out.push(['.q-options', 'it needs at least two options.', 'Needs two options']);
      else if (new Set(q.options).size !== q.options.length) out.push(['.q-options', 'two options have the same text.', 'Two options are the same']);
      else if (!q.correct_answers.length) out.push(['.q-options', 'tick the correct option.', 'No correct option ticked']);
    }
    if (q.type === 'numeric' && q.answer == null) out.push(['.q-answer', 'enter the correct answer as a number.', 'No correct answer']);
    if (q.type === 'true_false' && typeof q.answer !== 'boolean') out.push(['.q-tf', 'choose whether it is true or false.', 'True or false not chosen']);
    return out;
  }

  function collectQuestionCards({ strict = true } = {}) {
    const questions = [];
    let first = null;
    let n = 0;
    for (const card of questionCards()) {
      const q = readCard(card);
      const label = q.type === 'text_only' ? 'An information item' : `Question ${++n}`;
      questions.push(q);
      if (!strict) continue;
      card.querySelectorAll('.field-error').forEach(el => el.classList.remove('field-error'));
      for (const [selector, message] of cardProblems(card, q)) {
        const el = card.querySelector(selector);
        el?.classList.add('field-error');
        if (!first) first = { card, el, message: `${label}: ${message}` };
      }
    }
    if (first) {
      setCollapsed(first.card, false);
      if (first.card.querySelector('.q-explain') && first.el?.closest('.q-explain')) first.card.querySelector('.q-explain').open = true;
      refreshQuestions();
      toast(first.message, 'err');
      (first.el || first.card).scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => (first.el?.matches?.('input, textarea, select') ? first.el : first.card.querySelector('.q-opt-text, .q-prompt'))?.focus({ preventScroll: true }), 300);
      return null;
    }
    return questions;
  }

  // The tab's Save (and Ctrl/Cmd+S) while the questions editor is open.
  async function saveQuestions() {
    const exam = examById(EX.examId);
    if (document.querySelector('#qe-list .q-image.is-adding')) { toast('Images are still being added: save once they are in', 'err'); return false; }
    const questions = collectQuestionCards();
    if (!exam || !questions) return false;
    try {
      await rpc('exam_save_questions', { p_id: exam.id, p_questions: questions });
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
      return false;
    }
    exam.questions = questions;
    rememberSavedSection();
    toast(`Questions saved (${questions.filter(q => q.type !== 'text_only').length})`, 'ok');
    return true;
  }
  // Ctrl+S: the questions editor, or the grading page's points (staying on the page).
  const saveExamsSection = () => (EX.view === 'questions' ? saveQuestions()
    : EX.view === 'grading' && onGradingPage() ? saveGrades(null, { leave: false }) : true);


  // ── Preview: the exam page in a new tab, taken as a student would, where nothing is saved or sent ──
  // The tab (/exam/?preview=<exam id>) asks this one for its exam once it has loaded, and again
  // after a reload, and gets the questions as they are in the editor, without the answers. It
  // needn't be visible or open, and the timer starts when the tab does.
  const EXAM_PAGE = new URL('exam/', window.TEACHING_CONFIG.appBaseUrl);
  const _previews = new Map(); // exam id → { payload, waiting: tabs that asked before it was ready }

  // As students receive questions (exam_private.student_questions).
  const studentQuestion = ({ correct_answers, accepted_answers, answer, tolerance, explanation, ...rest }) => rest;

  async function tryAsStudent(exam, questions) {
    if (!exam) return;
    if (!questions.length) { toast('Add a question first', 'err'); return; }
    // Opened before anything is awaited, so the browser takes it as the click's own tab.
    const url = new URL(EXAM_PAGE);
    url.searchParams.set('preview', exam.id);
    const entry = { payload: null, waiting: [] };
    _previews.set(exam.id, entry);
    const tab = window.open(url.href, `exam-preview-${exam.id}`);
    if (!tab) { toast('The browser blocked the new tab. Allow pop-ups for this site, then try again.', 'err'); return; }
    await loadImages(exam);
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    const me = S.access || {};
    const ids = imageIdsOf(questions);
    entry.payload = {
      id: exam.id, label: exam.label, type: exam.type, duration_minutes: exam.duration_minutes, hall: exam.hall,
      base: exam.base, weight: exam.weight, sign_in: signInOf(exam), shuffle_questions: exam.shuffle_questions !== false,
      settings: settingsOf(exam), course_code: header.code || EX.course, course_title: header.title || '',
      questions: questions.map(studentQuestion),
      images: Object.fromEntries(ids.filter(id => EX.images[id]).map(id => [id, EX.images[id]])),
      student: { name: me.display_name || me.name || me.email || 'Student', email: me.email || '', student_no: '' },
    };
    entry.waiting.forEach(source => sendPreview(source, entry.payload));
    entry.waiting = [];
  }

  function sendPreview(source, payload) {
    try { source.postMessage({ type: 'syllabase-exam-preview', payload }, EXAM_PAGE.origin); } catch { }
  }

  window.addEventListener('message', e => {
    if (e.origin !== EXAM_PAGE.origin || e.data?.type !== 'syllabase-exam-preview-ready' || !e.source) return;
    const entry = _previews.get(e.data.examId);
    if (!entry) return;
    if (entry.payload) sendPreview(e.source, entry.payload);
    else entry.waiting.push(e.source);
  });

  // An image at full size, in a new tab (a data URL can't be opened directly).
  async function openImage(src) {
    const tab = window.open('', '_blank');
    if (!tab) { toast('The browser blocked the new tab. Allow pop-ups for this site, then try again.', 'err'); return; }
    tab.location.href = URL.createObjectURL(await (await fetch(src)).blob());
  }

  // A question's images, as loaded (previews and grading).
  function questionImagesHtml(q, className = 'qp-images') {
    const sources = imageIdsOf([q]).map(id => EX.images[id]).filter(Boolean);
    return sources.length ? `<div class="${className}">${sources.map((src, i) => `<img src="${x(src)}" alt="Image ${i + 1}">`).join('')}</div>` : '';
  }

  // Bold, italic, lists… as students see them (js/format-text.js).
  const promptHtml = text => formatQuestionText(text);


  // ── Import and export ──
  // The exchange format: plain names that another program, or Claude, can write.
  const FRIENDLY_TYPES = { multiple_select: 'multiple_choice', true_false: 'true_false', short_answer: 'short_answer', numeric: 'numeric', long_answer: 'long_answer', code: 'code', attachment: 'file', text_only: 'text' };
  const TYPE_ALIASES = {
    multiple_choice: 'multiple_select', multiple_select: 'multiple_select', mc: 'multiple_select', mcq: 'multiple_select', choice: 'multiple_select',
    single_choice: 'multiple_select', radio: 'multiple_select', true_false: 'true_false', truefalse: 'true_false', true_or_false: 'true_false', boolean: 'true_false', tf: 'true_false',
    short_answer: 'short_answer', short: 'short_answer', text_answer: 'short_answer', fill_in: 'short_answer', fill_in_the_blank: 'short_answer', blank: 'short_answer',
    numeric: 'numeric', number: 'numeric', numerical: 'numeric', calculation: 'numeric',
    long_answer: 'long_answer', long: 'long_answer', essay: 'long_answer', open: 'long_answer', open_ended: 'long_answer', paragraph: 'long_answer',
    code: 'code', programming: 'code', coding: 'code',
    file: 'attachment', attachment: 'attachment', upload: 'attachment', file_upload: 'attachment',
    text: 'text_only', text_only: 'text_only', info: 'text_only', information: 'text_only', instructions: 'text_only', section: 'text_only', heading: 'text_only',
  };

  function toFriendly(q) {
    const out = { type: FRIENDLY_TYPES[q.type] || q.type };
    if (q.type !== 'text_only') out.points = q.points ?? 1;
    out.question = q.prompt || '';
    if (q.type === 'multiple_select') { out.options = q.options || []; out.correct = q.correct_answers || []; }
    if (q.type === 'true_false' && typeof q.answer === 'boolean') out.answer = q.answer;
    if (q.type === 'short_answer' && q.accepted_answers?.length) out.accepted = q.accepted_answers;
    if (q.type === 'numeric') { out.answer = q.answer; if (q.tolerance) out.tolerance = q.tolerance; if (q.unit) out.unit = q.unit; }
    if (q.type === 'long_answer' && q.content) out.starting_text = q.content;
    if (q.type === 'code') { out.language = q.language || 'python'; if (q.content) out.starter_code = q.content; }
    if (q.type === 'attachment') { if (q.allowed_types?.length) out.allowed_types = q.allowed_types; if (q.max_size_mb) out.max_size_mb = q.max_size_mb; }
    if (q.explanation) out.explanation = q.explanation;
    // Images travel inside the file, so another course can import them too.
    const images = imageIdsOf([q]).map(id => EX.images[id]).filter(Boolean);
    if (images.length) out.images = images;
    if (images.length && q.image_size) out.image_size = q.image_size;
    return out;
  }

  // One imported question, read leniently (other names for the same fields are understood).
  // Returns { q } or { error }, with an optional warning.
  function fromFriendly(raw) {
    if (typeof raw === 'string') raw = { question: raw };
    if (!raw || typeof raw !== 'object') return { error: 'not a question' };
    const pick = (...keys) => { for (const k of keys) if (raw[k] != null && raw[k] !== '') return raw[k]; return undefined; };
    const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
    const prompt = String(pick('question', 'prompt', 'text', 'title', 'stem', 'body') ?? '').trim();
    let rawOptions = pick('options', 'choices', 'alternatives');
    if (!rawOptions && Array.isArray(raw.answers) && raw.answers.some(a => a && typeof a === 'object')) rawOptions = raw.answers;
    const typeName = String(pick('type', 'kind', 'question_type') ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    let type = TYPE_ALIASES[typeName];
    if (!type) {
      if (rawOptions) type = 'multiple_select';
      else if (num(pick('answer', 'correct_answer', 'value')) != null && !Array.isArray(pick('answer'))) type = 'numeric';
      else if (pick('accepted', 'accepted_answers', 'answers')) type = 'short_answer';
      else if (pick('language', 'starter_code')) type = 'code';
      else type = 'long_answer';
    }
    // Images: data URLs (from an export), or ids of this course's images (another exam's).
    const images = list(pick('images', 'figures', 'image')).filter(v => typeof v === 'string' && (UUID.test(v) || IMPORT_IMAGE.test(v)));
    if (!prompt && !images.length) return { error: 'no question text' };
    const q = { type, prompt };
    if (images.length) q.images = images;
    const size = String(pick('image_size', 'size') ?? '').toLowerCase();
    if (images.length && IMAGE_SIZES[size] && size !== 'medium') q.image_size = size;
    let warning = '';
    if (type !== 'text_only') {
      const points = num(pick('points', 'marks', 'score', 'max_points'));
      q.points = points != null && points >= 0 ? points : 1;
      const explanation = pick('explanation', 'feedback', 'solution', 'rationale');
      if (explanation) q.explanation = String(explanation).trim();
    }
    if (type === 'multiple_select') {
      let options = list(rawOptions);
      if (!options.length && /^(true_?false|boolean)$/.test(typeName)) options = ['True', 'False'];
      const flagged = [];
      options = options.map((o, i) => {
        if (o && typeof o === 'object') {
          if (o.correct || o.is_correct || o.isCorrect) flagged.push(i);
          return String(o.text ?? o.label ?? o.value ?? o.option ?? '').trim();
        }
        return String(o ?? '').trim();
      });
      // "A) Concrete", "B) Steel": drop the letters when every option has them in order.
      const lettered = options.length > 1 && options.every((o, i) => new RegExp(`^\\(?${String.fromCharCode(65 + i)}[.)]\\s+`, 'i').test(o));
      if (lettered) options = options.map(o => o.replace(/^\(?[a-z][.)]\s+/i, ''));
      const correct = new Set(flagged.map(i => options[i]));
      const index0 = pick('correct_index', 'correctIndex');
      list(index0).forEach(i => { if (options[Number(i)] != null) correct.add(options[Number(i)]); });
      list(pick('correct', 'correct_answers', 'correct_answer', 'answer', 'key')).forEach(c => {
        if (typeof c === 'number') { if (options[c - 1] != null) correct.add(options[c - 1]); return; } // 1 is the first option
        const text = String(c).trim();
        const exact = options.find(o => o === text) || options.find(o => o.toLowerCase() === text.toLowerCase());
        if (exact) return correct.add(exact);
        const letter = text.match(/^\(?([a-z])[.)]?(?:\s+(.*))?$/i);
        if (letter && options[letter[1].toUpperCase().charCodeAt(0) - 65] != null && (!letter[2] || lettered)) return correct.add(options[letter[1].toUpperCase().charCodeAt(0) - 65]);
        const stripped = text.replace(/^\(?[a-z][.)]\s+/i, '');
        const match = options.find(o => o.toLowerCase() === stripped.toLowerCase());
        if (match) correct.add(match);
      });
      q.options = options.filter(Boolean);
      q.correct_answers = q.options.filter(o => correct.has(o));
      if (q.options.length < 2) return { error: 'fewer than two options' };
      if (!q.correct_answers.length) warning = 'no correct option: tick it before saving';
    } else if (type === 'true_false') {
      const given = pick('answer', 'correct', 'correct_answer', 'key', 'value');
      const text = String(Array.isArray(given) ? given[0] : given ?? '').trim().toLowerCase();
      if (given === true || /^(true|t|yes|correct|1)$/.test(text)) q.answer = true;
      else if (given === false || /^(false|f|no|incorrect|0)$/.test(text)) q.answer = false;
      else warning = 'not said whether it is true or false: choose it before saving';
    } else if (type === 'short_answer') {
      const accepted = list(pick('accepted', 'accepted_answers', 'answers', 'answer', 'correct')).map(a => String(a).trim()).filter(Boolean);
      if (accepted.length) q.accepted_answers = accepted;
    } else if (type === 'numeric') {
      q.answer = num(pick('answer', 'correct', 'correct_answer', 'value'));
      const tolerance = num(pick('tolerance', 'tol', 'margin'));
      if (tolerance) q.tolerance = Math.abs(tolerance);
      const unit = pick('unit', 'units');
      if (unit) q.unit = String(unit).trim();
      if (q.answer == null) warning = 'no numeric answer: enter it before saving';
    } else if (type === 'long_answer') {
      const content = pick('starting_text', 'content', 'template');
      if (content) q.content = String(content);
    } else if (type === 'code') {
      const language = String(pick('language', 'lang') ?? 'python').toLowerCase().replace('c++', 'cpp').replace('c#', 'csharp');
      q.language = CODE_LANGUAGES[language] ? language : 'other';
      const code = pick('starter_code', 'code', 'template', 'content');
      if (code) q.content = String(code);
    } else if (type === 'attachment') {
      const types = pick('allowed_types', 'file_types', 'accept', 'extensions');
      const parsed = (Array.isArray(types) ? types : String(types ?? '').split(/[,\s]+/)).map(t => String(t).trim()).filter(Boolean).map(t => t.startsWith('.') ? t : `.${t}`);
      if (parsed.length) q.allowed_types = parsed;
      const size = num(pick('max_size_mb', 'max_size', 'max_mb'));
      if (size) q.max_size_mb = Math.round(size);
    }
    return { q, warning };
  }

  const IMPORT_IMAGE = /^data:image\/(png|jpeg|webp|gif|bmp);base64,/i;

  // An imported question's images as ids: data URLs are scaled down and saved for this course.
  async function importImages(q) {
    if (!q.images) return q;
    const ids = [];
    for (const image of q.images) {
      if (UUID.test(image)) { ids.push(image); continue; }
      try { ids.push(await saveImage(await (await fetch(image)).blob())); }
      catch (error) { toast(`An imported image was skipped: ${error.message}`, 'err'); }
    }
    if (ids.length) q.images = ids; else delete q.images;
    return q;
  }

  // Pasted text or a file: JSON, also inside ``` fences or after a sentence, as an object with
  // "questions" or as a bare list.
  function parseImport(text) {
    const source = String(text || '').trim();
    if (!source) return null;
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [source, fenced?.[1]];
    const start = source.search(/[[{]/);
    if (start >= 0) candidates.push(source.slice(start, Math.max(source.lastIndexOf('}'), source.lastIndexOf(']')) + 1));
    let data;
    for (const c of candidates.filter(Boolean)) { try { data = JSON.parse(c); break; } catch { } }
    if (data === undefined) return { fatal: 'This is not JSON. Paste the JSON that Claude or an export produced.' };
    const raw = Array.isArray(data) ? data : Array.isArray(data?.questions) ? data.questions : Array.isArray(data?.exam?.questions) ? data.exam.questions : null;
    if (!raw) return { fatal: 'No list of questions found in this JSON.' };
    const questions = [], problems = [];
    raw.forEach((item, i) => {
      const { q, error, warning } = fromFriendly(item);
      if (error) problems.push({ level: 'error', text: `Item ${i + 1} skipped: ${error}.` });
      else {
        questions.push(q);
        if (warning) problems.push({ level: 'warn', text: `Item ${i + 1}: ${warning}.` });
      }
    });
    return { questions, problems };
  }

  const CLAUDE_INSTRUCTIONS = `Convert the exam I give you into questions for Syllabase. Reply with JSON only, no other text, in exactly this shape:

{
  "format": "syllabase-questions",
  "version": 1,
  "questions": [
    { "type": "multiple_choice", "points": 2, "question": "Which material is strongest in tension?", "options": ["Concrete", "Steel", "Timber"], "correct": ["Steel"], "explanation": "Optional, shown to students with their grade." },
    { "type": "true_false", "points": 1, "question": "Concrete is strong in compression.", "answer": true },
    { "type": "short_answer", "points": 1, "question": "What is the SI unit of stress?", "accepted": ["Pa", "Pascal", "N/m²"] },
    { "type": "numeric", "points": 3, "question": "A 10 kN force acts on 800 mm². Find the stress.", "answer": 12.5, "tolerance": 0.1, "unit": "MPa" },
    { "type": "long_answer", "points": 5, "question": "Explain the difference between ductile and brittle failure." },
    { "type": "code", "points": 4, "question": "Write a function area(r) that returns a circle's area.", "language": "python", "starter_code": "def area(r):\\n    pass" },
    { "type": "file", "points": 5, "question": "Upload your hand calculations.", "allowed_types": [".pdf"], "max_size_mb": 10 },
    { "type": "text", "question": "Part B: answer the questions below. (Instructions and headings; not graded.)" }
  ]
}

Rules:
- Keep the original wording, numbers and order. Write formulas in plain text, e.g. σ = F/A.
- "correct" lists the right option(s), copied exactly from "options". Leave labels like "a)" out of the options.
- Use "true_false" for true-or-false statements, with "answer": true or false.
- Use "numeric" when the answer is one number. "tolerance" is how far off an answer may be (leave it out for exact answers).
- "accepted" lists acceptable short answers; leave it out when any wording may be right.
- Use "text" for instructions, reading passages and section headings.
- "points" are the question's points (1 when the exam doesn't say). "explanation" is optional.
- Formatting in question text: **bold**, *italic*, __underline__, m^2^ (superscript), H~2~O (subscript), \`code\`; lines starting with "- " make a bulleted list, "1. " a numbered one. Keep the original's formatting this way; don't add any of your own.
- For a question that needs a figure, describe the figure or write [see figure]: images are added in the editor.`;

  function exportQuestionsJson(exam, questions) {
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    const data = { format: 'syllabase-questions', version: 1, source: [header.code || EX.course, examTitle(exam)].filter(Boolean).join(' '),
      exported: new Date().toISOString().slice(0, 10), questions: questions.map(toFriendly) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${slug(EX.course)}_${slug(examTitle(exam))}_questions.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`Exported ${questions.length} question${questions.length === 1 ? '' : 's'}`, 'ok');
  }

  function openImport(exam) {
    const others = EX.data.exams.filter(e => e.id !== exam.id && e.questions?.length);
    const ov = overlay('q-import');
    ov.title('Import questions');
    ov.body.innerHTML = `
      <div class="form-group"><label class="form-label" for="qi-text">Paste questions <span class="label-note">JSON from Claude or an export</span></label>
        <textarea id="qi-text" class="qi-text" rows="8" spellcheck="false"></textarea>
        <div class="qi-file-row"><label class="btn-sm btn-secondary qi-file"><input type="file" id="qi-file" accept=".json,application/json,.txt,text/plain"><i class="fa-solid fa-folder-open"></i> Choose a file</label>
          <span class="form-hint">An exported .json file works too.</span></div></div>
      ${others.length ? `<div class="form-group"><label class="form-label" for="qi-exam">Or copy them from another exam of this course</label>
        <select id="qi-exam"><option value="">Choose an exam</option>${others.map(e => `<option value="${x(e.id)}">${x(examTitle(e))} (${e.questions.length})</option>`).join('')}</select></div>` : ''}
      <div class="qi-claude">
        <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
        <div><p><strong>Questions from another professor's exam?</strong> Copy these instructions and give them to Claude together with the exam (PDF, Word or text). Paste Claude's reply above.</p>
          <button type="button" class="btn-sm btn-secondary" id="qi-copy"><i class="fa-solid fa-copy"></i> Copy instructions for Claude</button></div>
      </div>
      <div id="qi-preview" class="qi-preview" aria-live="polite"></div>
      <div class="qi-mode" id="qi-mode" hidden>
        <label class="exam-inline-check"><input type="radio" name="qi-mode" value="append" checked> Add after the current questions</label>
        <label class="exam-inline-check"><input type="radio" name="qi-mode" value="replace"> Replace the current questions</label>
      </div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-green" type="button" id="qi-go" disabled><i class="fa-solid fa-file-import" style="margin-right:5px"></i>Import</button>`;
    let parsed = null;
    const show = result => {
      parsed = result;
      const preview = document.getElementById('qi-preview');
      document.getElementById('qi-go').disabled = !result?.questions?.length;
      document.getElementById('qi-mode').hidden = !result?.questions?.length || !questionCards().length;
      if (!result) { preview.innerHTML = ''; return; }
      if (result.fatal) { preview.innerHTML = `<p class="exam-error">${x(result.fatal)}</p>`; return; }
      const counts = {};
      result.questions.forEach(q => { counts[q.type] = (counts[q.type] || 0) + 1; });
      preview.innerHTML = `<p class="qi-summary"><strong>${result.questions.length}</strong> question${result.questions.length === 1 ? '' : 's'} ready: ${Object.entries(counts).map(([t, c]) => `${c} ${x(QUESTION_TYPES[t].label.toLowerCase())}`).join(', ')}</p>
        <ol class="qi-list">${result.questions.map(q => `<li><i class="${QUESTION_TYPES[q.type].icon}" aria-hidden="true"></i><span>${formatQuestionText.inline(q.prompt.split('\n')[0].replace(/^\s*([-•]|\d+[.)])\s+/, ''))}</span>${q.type !== 'text_only' ? `<em>${fmt(q.points)} pt</em>` : ''}</li>`).join('')}</ol>
        ${result.problems.length ? `<ul class="qi-problems">${result.problems.map(p => `<li class="qi-${p.level}">${x(p.text)}</li>`).join('')}</ul>` : ''}`;
    };
    const text = document.getElementById('qi-text');
    text.oninput = () => { const examSelect = document.getElementById('qi-exam'); if (examSelect) examSelect.value = ''; show(parseImport(text.value)); };
    document.getElementById('qi-file').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      text.value = await file.text();
      text.oninput();
    };
    document.getElementById('qi-exam')?.addEventListener('change', e => {
      const from = examById(e.target.value);
      text.value = '';
      show(from ? { questions: JSON.parse(JSON.stringify(from.questions)), problems: [] } : null);
      if (from) loadImages(from); // the same course's images, shown once imported
    });
    document.getElementById('qi-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(CLAUDE_INSTRUCTIONS); toast('Instructions copied: paste them to Claude with the exam', 'ok'); }
      catch { toast('Could not copy', 'err'); }
    };
    document.getElementById('qi-go').onclick = async () => {
      if (!parsed?.questions?.length) return;
      const replace = document.querySelector('input[name="qi-mode"]:checked')?.value === 'replace' && questionCards().length;
      if (replace && !(await confirmDialog(`Replace the ${questionCards().length} current questions with the ${parsed.questions.length} imported ones?`, { title: 'Replace Questions', okLabel: 'Replace', danger: true }))) return;
      const go = document.getElementById('qi-go');
      const withImages = parsed.questions.filter(q => q.images?.some(v => !UUID.test(v))).length;
      if (withImages) {
        go.disabled = true;
        go.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Adding images…';
      }
      const questions = [];
      for (const q of parsed.questions) questions.push(await importImages(q));
      const list = document.getElementById('qe-list');
      if (replace) list.innerHTML = '';
      const many = questions.length + questionCards().length > 4;
      const added = questions.map(q => { const card = questionCard(q, { collapsed: many }); card.classList.add('is-new'); list.appendChild(card); return card; });
      markDirty();
      refreshQuestions();
      ov.close();
      added[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => added.forEach(c => c.classList.remove('is-new')), 2500);
      toast(`Imported ${added.length} question${added.length === 1 ? '' : 's'}. Save to keep them.`, 'ok');
    };
    ov.open();
    setTimeout(() => text.focus(), 60);
  }


  // ════════════════════════════════════════════════════════════════════════
  // Submissions and grading (inside the Exams tab)
  // ════════════════════════════════════════════════════════════════════════

  async function showSubmissions(examId, body = document.getElementById('section-body')) {
    const exam = examById(examId);
    if (!exam) return;
    if (EX.examId !== examId || EX.view !== 'submissions') {
      Object.assign(EX, { subFilter: 'all', subQuery: '', subSort: null });
      _rosterSel.clear();
    }
    EX.view = 'submissions';
    EX.examId = examId;
    body.onclick = onExamsClick;
    body.onchange = onRosterChange;
    body.oninput = onRosterInput;
    body.onkeydown = onRosterKeydown;
    body.onpaste = body.ondragover = body.ondragleave = body.ondrop = null;
    try {
      const [subs, attempts] = await Promise.all([rpc('exam_submissions', { p_exam_id: examId }),
        rpc('exam_attempts', { p_exam_id: examId }).catch(() => []), loadImages(exam)]);
      EX.submissions = subs;
      EX.attempts = attempts || [];
    } catch (error) {
      toast(error.message, 'err');
      EX.submissions = [];
      EX.attempts = [];
    }
    if (S.section !== 'exams' || EX.examId !== examId) return;
    renderSubmissions(body, exam);
  }

  // ── The grading page: everyone who should take the exam ──
  // Each student on the class list (or each exam ID, for anonymous exams) is a row, whether
  // they submitted or not, with how far they got; then submissions of anyone since removed from
  // the list. An exam held on paper (no questions) has a grade field in each row instead.
  const paperExam = exam => !(exam.questions || []).length;
  const _rosterSel = new Set(); // Selected rows' keys
  let _rosterAnchor = null;     // Where a Shift-click range starts
  const ROSTER_STATES = {
    submitted: { label: 'To grade', filter: 'to-grade' }, partial: { label: 'Partly graded', filter: 'to-grade' },
    graded: { label: 'Graded', filter: 'graded' }, manual: { label: 'No submission', filter: 'none' },
    taking: { label: 'Taking it now', filter: 'none' }, started: { label: 'Started', filter: 'none' }, none: { label: 'No submission', filter: 'none' },
  };

  function rosterOf(exam) {
    const anonymous = signInOf(exam) === 'anonymous';
    const keyOf = s => (anonymous ? s.exam_code : s.student_no);
    const subs = new Map(EX.submissions.map(s => [keyOf(s), s]));
    const attempts = new Map((EX.attempts || []).map(a => [a.who, a]));
    const rows = anonymous
      ? EX.data.codes.map(code => ({ key: code, code, sub: subs.get(code) || null, attempt: attempts.get(`code:${code}`) || null }))
      : EX.data.students.map(st => ({ key: studentKey(st), student: st, sub: subs.get(studentKey(st)) || null, attempt: attempts.get(studentKey(st)) || null }));
    const listed = new Set(rows.map(r => r.key));
    for (const s of EX.submissions) {
      const key = keyOf(s);
      if (listed.has(key)) continue;
      rows.push(anonymous ? { key, code: key, sub: s, attempt: attempts.get(`code:${key}`) || null, offList: true }
        : { key, student: { full_name: s.student_name, student_no: s.student_no, email: s.student_email }, sub: s, attempt: attempts.get(key) || null, offList: true });
    }
    rows.forEach((r, i) => { r.n = i + 1; r.state = rowStateOf(r); });
    return rows;
  }

  function rowStateOf(r) {
    const s = r.sub;
    if (s) {
      if (s.status === 'graded') return 'graded';
      if (s.source === 'manual') return 'manual';
      return Number.isFinite(parseFloat(s.grades?.totalScore)) ? 'partial' : 'submitted';
    }
    if (r.attempt?.live) return 'taking';
    return r.attempt ? 'started' : 'none';
  }

  // The filters: everyone, those left to grade, the graded, those without a submission, and
  // two things to look at: late submissions and leaving the page.
  const ROSTER_FILTERS = [
    ['all', 'All', () => true],
    ['to-grade', 'To grade', r => ROSTER_STATES[r.state].filter === 'to-grade'],
    ['graded', 'Graded', r => r.state === 'graded'],
    ['none', 'No submission', r => !r.sub || r.sub.source === 'manual'],
    ['late', 'Late', r => !!r.sub?.late],
    ['left', 'Left the page', r => (r.sub?.activity?.count || 0) > 0],
  ];
  const PAPER_FILTERS = [
    ['all', 'All', () => true],
    ['graded', 'Graded', r => r.state === 'graded'],
    ['to-grade', 'Not graded yet', r => r.state !== 'graded'],
  ];
  const rosterFilters = exam => (paperExam(exam) ? PAPER_FILTERS : ROSTER_FILTERS);
  const rosterText = r => [r.code, r.student?.full_name, r.student?.student_no, r.student?.email].filter(Boolean).join(' ').toLowerCase();

  function visibleRows(exam, rows = rosterOf(exam)) {
    const test = (rosterFilters(exam).find(f => f[0] === EX.subFilter) || rosterFilters(exam)[0])[2];
    const query = EX.subQuery;
    return sortRows(rows.filter(r => test(r) && (!query || rosterText(r).includes(query))), EX.subSort, ROSTER_SORTS);
  }

  // Sorting by a column's header (again: the other way; # goes back to the list's order). Empty
  // values stay last either way; ties keep the list's order. Previous and Next follow it.
  const gradeShare = g => (g && Number.isFinite(parseFloat(g.totalScore)) && parseFloat(g.maxScore) > 0 ? parseFloat(g.totalScore) / parseFloat(g.maxScore) : null);
  const ROSTER_SORTS = {
    name: r => (r.code || r.student?.full_name || r.student?.email || '').toLowerCase(),
    submitted: r => (r.sub && r.sub.source !== 'manual' && r.sub.submitted_at ? Date.parse(r.sub.submitted_at) : null),
    grade: r => gradeShare(r.sub?.grades),
  };
  function sortRows(list, sort, keys) {
    const value = sort && keys[sort.key];
    if (!value) return list;
    return list.map((item, i) => [item, value(item), i]).sort(([, a, i], [, b, j]) => {
      if (a == null || b == null) return a == null && b == null ? i - j : a == null ? 1 : -1;
      return (typeof a === 'string' ? a.localeCompare(b) : a - b) * sort.dir || i - j;
    }).map(([item]) => item);
  }
  const nextSort = (sort, key) => (!key ? null : sort?.key === key ? { key, dir: -sort.dir } : { key, dir: key === 'name' ? 1 : -1 });
  function sortHeadHtml(attr, key, label, sort) {
    const on = sort?.key === key;
    return `<button type="button" class="th-sort${on ? ' is-on' : ''}" ${attr}="${x(key)}" title="Sort">${label}<i class="fa-solid ${on ? (sort.dir > 0 ? 'fa-arrow-up-short-wide' : 'fa-arrow-down-wide-short') : 'fa-sort'}" aria-hidden="true"></i></button>`;
  }
  const ariaSort = (sort, key) => (sort?.key === key ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : '');

  function renderSubmissions(body, exam) {
    const anonymous = signInOf(exam) === 'anonymous';
    const paper = paperExam(exam);
    const rows = rosterOf(exam);
    const classIp = classNetwork(EX.submissions);
    const online = EX.submissions.filter(s => s.source !== 'manual');
    const graded = rows.filter(r => r.state === 'graded').length;
    const counts = paper
      ? [`${rows.length} ${anonymous ? 'exam IDs' : 'students'}`, `${graded} graded`]
      : [`${rows.length} ${anonymous ? 'exam IDs' : 'students'}`, `${online.length} submitted`,
        `${rows.filter(r => ROSTER_STATES[r.state].filter === 'to-grade').length} to grade`, `${graded} graded`,
        `${rows.filter(r => !r.sub || r.sub.source === 'manual').length} without a submission`];
    const filters = rosterFilters(exam);
    if (!filters.some(f => f[0] === EX.subFilter)) EX.subFilter = 'all';
    const downloads = [
      { label: 'Questions (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-sub-action="pdf-questions"', disabled: paper },
      { label: `Submissions${exam.file_count ? ' and files' : ''} (ZIP)`, icon: 'fa-regular fa-file-zipper', attrs: 'data-sub-action="zip"', disabled: !online.length },
      { label: 'Grades (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-sub-action="pdf-grades"', disabled: !graded },
      { label: 'Graded exams (PDF)', icon: 'fa-regular fa-file-lines', attrs: 'data-sub-action="pdf-reports"', disabled: !graded || paper,
        hint: 'Each student\'s answers, points and comments' },
    ];
    body.innerHTML = `
      <div class="section-topbar" data-no-dirty>
        <button type="button" class="btn-sm btn-secondary" data-exam-action="back"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>All exams</button>
        <div class="add-bar">
          <button type="button" class="btn-sm btn-secondary" data-sub-action="refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
          <button type="button" class="btn-sm" data-sub-action="eis" ${graded ? '' : 'disabled'} title="${graded ? 'The grades in the order EIS lists them, to copy' : 'No grades yet'}"><i class="fa-solid fa-table-list"></i> Grades for EIS</button>
        </div>
        ${rowMenuHtml(downloads, { text: 'Download', icon: 'fa-solid fa-download', label: 'Download' })}
      </div>
      <div class="exam-sub-head">
        <span class="exam-card-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="exam-sub-title"><h3 class="qe-title">${x(examTitle(exam))}: grades</h3>
          <div class="exam-card-facts">${counts.map(x).join('<span class="exam-dot">·</span>')}<span class="exam-dot">·</span>${exam.results_published ? 'Grades released' : 'Grades not released'}
            ${exam.file_count ? `<span class="exam-dot">·</span>${exam.file_count} uploaded file${exam.file_count === 1 ? '' : 's'}, ${x(formatBytes(exam.file_bytes))}${canManage()
              ? ` <button type="button" class="exam-link-btn" data-sub-action="delete-files" title="Frees the storage they take, once you have downloaded them">Delete them</button>` : ''}` : ''}</div></div>
      </div>
      ${paper ? `<p class="form-hint exam-edit-warning"><i class="fa-solid fa-pen" aria-hidden="true"></i><span>This exam is held on paper: type each grade (out of ${x(fmt(exam.base))}) and press Enter or Tab. It is saved at once.</span></p>` : ''}
      <div class="roster-tools" data-no-dirty>
        <div class="roster-filters" role="group" aria-label="Show">${filters.map(([id, label, test]) => {
          const n = rows.filter(test).length;
          return `<button type="button" data-roster-filter="${id}" aria-pressed="${EX.subFilter === id}"${n || id === 'all' ? '' : ' disabled'}>${x(label)}<span>${n}</span></button>`;
        }).join('')}</div>
        <div class="roster-bulk" id="roster-bulk" role="group" aria-label="The selected" hidden>
          <button type="button" class="roster-bulk-clear" data-bulk="clear" title="Clear the selection (Esc)" aria-label="Clear the selection"><i class="fa-solid fa-xmark"></i></button>
          <span class="roster-bulk-count" id="roster-bulk-count" aria-live="polite"></span>
          <button type="button" class="btn-sm btn-secondary" data-bulk="grade"><i class="fa-solid fa-pen"></i>Give a grade</button>
          ${paper ? '' : '<button type="button" class="btn-sm btn-secondary" data-bulk="autograde" title="Questions with an answer key, where no points were given yet"><i class="fa-solid fa-wand-magic-sparkles"></i>Autograde</button>'}
          ${paper ? '' : '<button type="button" class="btn-sm btn-secondary" data-bulk="download" title="Their graded exams as one PDF"><i class="fa-solid fa-file-arrow-down"></i>Download</button>'}
          ${canManage() && !paper ? '<button type="button" class="btn-sm btn-secondary" data-bulk="return"><i class="fa-solid fa-rotate-left"></i>Hand back</button>' : ''}
          <button type="button" class="btn-sm btn-secondary" data-bulk="clear-grades" title="Removes their points, comments and feedback"><i class="fa-solid fa-eraser"></i>Clear grading</button>
          ${canManage() ? '<button type="button" class="btn-sm btn-red" data-bulk="delete"><i class="fa-solid fa-trash"></i>Delete</button>' : ''}
        </div>
        <input type="search" class="classlist-search" id="roster-search" placeholder="Search" aria-label="Search" value="${x(EX.subQuery)}">
      </div>
      <div class="data-table-container roster-wrap" data-no-dirty>
        <table class="data-table roster-table${paper ? ' is-paper' : ''}">
          <thead id="roster-head">${rosterHeadHtml(exam)}</thead>
          <tbody id="roster-rows"></tbody>
        </table>
      </div>`;
    renderRosterRows(exam, rows, classIp);
  }

  function rosterHeadHtml(exam) {
    const sort = EX.subSort, paper = paperExam(exam);
    return `<tr><th class="select-cell"><input type="checkbox" id="roster-check-all" aria-label="Select everyone shown"></th>
            <th class="roster-n">${sortHeadHtml('data-roster-sort', '', '#', null)}</th>
            <th${ariaSort(sort, 'name')}>${sortHeadHtml('data-roster-sort', 'name', signInOf(exam) === 'anonymous' ? 'Exam ID' : 'Student', sort)}</th>
            ${paper ? `<th${ariaSort(sort, 'grade')}>${sortHeadHtml('data-roster-sort', 'grade', `Grade <span class="exam-muted">/ ${x(fmt(exam.base))}</span>`, sort)}</th>`
              : `<th${ariaSort(sort, 'submitted')}>${sortHeadHtml('data-roster-sort', 'submitted', 'Submitted', sort)}</th>
                 <th${ariaSort(sort, 'grade')}>${sortHeadHtml('data-roster-sort', 'grade', 'Grade', sort)}</th><th>Integrity</th>`}
            <th><span class="sr-only">Actions</span></th></tr>`;
  }

  function renderRosterRows(exam, rows = rosterOf(exam), classIp = classNetwork(EX.submissions)) {
    const tbody = document.getElementById('roster-rows');
    if (!tbody) return;
    const shown = visibleRows(exam, rows);
    const columns = paperExam(exam) ? 5 : 7;
    tbody.innerHTML = shown.length ? shown.map(r => rosterRowHtml(exam, r, classIp)).join('')
      : `<tr><td colspan="${columns}" class="table-message">${rows.length ? 'Nobody here.' : signInOf(exam) === 'anonymous'
        ? 'No exam IDs yet: add them on the Students tab.' : 'No students yet: add the class list on the Students tab.'}</td></tr>`;
    updateRosterSelection(exam, rows);
    if (EX.focusRow) {
      const tr = tbody.querySelector(`tr[data-sub-id="${CSS.escape(EX.focusRow)}"]`);
      EX.focusRow = null;
      if (tr) flashRow(tr);
    }
  }

  // A row brought into view and lit up for a moment: where the eye should land.
  function flashRow(tr) {
    requestAnimationFrame(() => {
      tr.scrollIntoView({ block: 'center' });
      tr.classList.remove('is-flash');
      void tr.offsetWidth;
      tr.classList.add('is-flash');
      setTimeout(() => tr.classList.remove('is-flash'), 1800);
    });
  }

  function rosterWhoHtml(exam, r) {
    const off = r.offList ? `<span class="badge exam-badge-note" title="Submitted, then removed from the ${r.code ? 'exam IDs' : 'class list'}">Not on the list</span>` : '';
    if (r.code) return `<span class="sub-who-line"><span class="sub-name exam-code-cell">${x(r.code)}</span>${off}</span>`;
    const s = r.student, no = shownNo(s.student_no);
    return `<span class="sub-who-line" title="${x([s.full_name, no, s.email].filter(Boolean).join(' · '))}"><span class="sub-name">${x(s.full_name || s.email)}</span>${no ? `<span class="sub-id">${x(no)}</span>` : ''}${off}</span>`;
  }

  // The pills beside the time. Auto: the exam page submitted by itself when time ran out (the
  // student had not pressed Submit), with only the answers they had confirmed. Late: it reached
  // the server more than a minute after the end, kept on the device while it was offline. Each
  // can come without the other; both together, time ran out while the device was offline.
  const AUTO_TITLE = 'Submitted by the exam page when time ran out; only confirmed answers were sent';
  function lateTitle(exam, s) {
    const after = exam.ends_at && s.submitted_at ? (Date.parse(s.submitted_at) - Date.parse(exam.ends_at)) / 1000 : NaN;
    return `Reached the server ${after > 0 ? `${formatSeconds(after)} after the end` : 'after the end'}: the device was offline and sent it once it was back`;
  }

  // Where the student stands: when it was submitted (with Late, Auto or From file), or not
  // submitted (taking it now, started, handed back), or a grade entered without a submission.
  function rosterStatusHtml(exam, r) {
    const s = r.sub;
    if (s && s.source === 'manual') return '<span class="roster-state is-none" title="The grade was entered by hand">No submission</span>';
    if (s) {
      const tags = [s.late && `<span class="badge exam-badge-late" title="${x(lateTitle(exam, s))}">Late</span>`,
        s.auto_submitted && `<span class="badge exam-badge-auto" title="${x(AUTO_TITLE)}">Auto</span>`,
        s.source === 'imported' && '<span class="badge exam-badge-note" title="Added from the student\'s backup file">From file</span>'].filter(Boolean).join('');
      return `<span class="roster-state is-${r.state}" title="Submitted ${x(formatWhen(s.submitted_at))}">${x(formatShortWhen(s.submitted_at))}</span>${tags}`;
    }
    if (r.state === 'taking') return `<span class="roster-state is-taking">${r.attempt.returned ? 'Handed back, taking it' : 'Taking it now'}</span>`;
    if (r.state === 'started') {
      return `<span class="roster-state is-started" title="Last seen ${x(formatWhen(r.attempt.last_seen))}">${r.attempt.returned ? 'Handed back' : 'Started, not submitted'}</span>`;
    }
    return '<span class="roster-state is-none">Not submitted</span>';
  }

  function rosterRowHtml(exam, r, classIp) {
    const s = r.sub;
    const paper = paperExam(exam);
    const ended = !examTakingAnswers(exam);
    const menu = s ? [
      ...(s.source !== 'manual' ? [
        { label: 'Recorded answers', icon: 'fa-regular fa-rectangle-list', attrs: 'data-sub-action="answers"', hint: 'Exactly as they were received' },
        ...(canManage() ? [{ label: 'Hand back to the student', icon: 'fa-solid fa-rotate-left', attrs: 'data-sub-action="return"',
          hint: 'They can continue while the exam is open' }] : []),
      ] : []),
      ...(canManage() ? [{ label: s.source === 'manual' ? 'Remove the grade' : 'Delete submission', icon: 'fa-solid fa-trash', danger: true, attrs: 'data-sub-action="delete"' }] : []),
    ] : (canManage() && !paper ? [{ label: 'Add from a backup file', icon: 'fa-solid fa-file-import', attrs: 'data-sub-action="import"',
      hint: 'The JSON file the exam page saved to their downloads' }] : []);
    const actions = paper
      ? `<button type="button" class="btn-sm btn-secondary" data-sub-action="grade" ${s ? '' : 'disabled title="Type a grade first"'}><i class="fa-regular fa-comment"></i> Feedback</button>`
      : s ? `<button type="button" class="btn-sm ${s.status === 'graded' ? 'btn-secondary' : ''}" data-sub-action="grade">${s.status === 'graded' ? 'Review' : 'Grade'}</button>`
      : `<button type="button" class="btn-sm btn-secondary" data-sub-action="enter-grade" ${ended ? '' : 'disabled title="Once the exam has closed"'}>Enter grade</button>`;
    const grade = parseFloat(s?.grades?.totalScore);
    const name = r.code || r.student?.full_name || r.student?.email || '';
    return `<tr data-row-key="${x(r.key)}"${s ? ` data-sub-id="${x(s.id)}"` : ''} class="roster-row is-${r.state}">
      <td class="select-cell"><input type="checkbox" class="row-check" aria-label="Select ${x(name)}"></td>
      <td class="roster-n">${r.n}</td>
      <td class="sub-who">${rosterWhoHtml(exam, r)}</td>
      ${paper ? `<td class="roster-grade"><label class="inline-grade"><span class="sr-only">Grade</span><input type="number" min="0" max="${x(fmt(exam.base))}" step="any"
          value="${Number.isFinite(grade) ? x(String(Math.round(grade / (parseFloat(s.grades.maxScore) || exam.base) * exam.base * 100) / 100)) : ''}" data-inline-grade
          ${canManage() || EX.access === 'grade' ? '' : 'disabled'}></label></td>`
        : `<td class="sub-status">${rosterStatusHtml(exam, r)}</td>
      <td class="sub-grade">${s ? gradeCellHtml(s, exam) : '<span class="exam-muted">—</span>'}</td>
      <td class="sub-checks">${s && s.source !== 'manual' ? `<span class="sub-flags">${leftPageHtml(s)}${networkCellHtml(s, classIp)}${deliveryFlagHtml(s)}</span>` : ''}</td>`}
      <td class="sub-actions">${actions}${menu.length ? rowMenuHtml(menu, { label: 'More actions' }) : ''}</td></tr>`;
  }

  // A submission sent after the end from the device it was taken on (offline meanwhile).
  function deliveryFlagHtml(s) {
    const d = s.delivery;
    const screen = s.fingerprint?.extendedScreen ? subFlagHtml('Second screen', 'warn', '', 'A second screen was connected') : '';
    if (!d?.last_online) return screen;
    const changed = d.changed?.length || 0;
    return screen + subFlagHtml(changed ? `${changed} changed offline` : 'Kept offline', changed ? 'warn' : 'plain', 'delivery',
      'Kept on the device while it was offline: when it went offline, and which answers changed');
  }

  function deliveryHtml(exam, s) {
    const d = s.delivery || {};
    const numbers = new Map();
    let n = 0;
    (exam.questions || []).forEach((q, i) => { if (q.type !== 'text_only') numbers.set(i + 1, ++n); });
    const changed = (d.changed || []).map(p => numbers.get(p) ? `Question ${numbers.get(p)}` : null).filter(Boolean);
    return `<p>These answers were kept on the student's device while it had no connection, and sent after the exam ended.</p>
      <dl>
        <dt>Last online</dt><dd>${d.last_online ? x(formatWhen(d.last_online)) : 'Not known'}</dd>
        <dt>Last saved here</dt><dd>${d.draft_at ? x(formatWhen(d.draft_at)) : 'Never: the answers were not saved here before'}</dd>
        <dt>Collected on the device</dt><dd>${d.collected_at ? `${x(formatWhen(d.collected_at))} <span class="exam-muted">(the device's own clock)</span>` : 'Not known'}</dd>
        <dt>Sent</dt><dd>${x(formatWhen(s.submitted_at))}</dd>
        <dt>Different from the last save</dt><dd>${changed.length ? x(changed.join(', ')) : 'Nothing'}</dd>
      </dl>
      <p class="form-hint">Answers that changed after the device was last online were given without a connection: compare them with the time the exam ended. Unconfirmed answers are never sent.</p>`;
  }

  // The grade on the exam's base, and the points; or how far grading got.
  function gradeCellHtml(s, exam) {
    const g = s.grades;
    if (!g || !Number.isFinite(parseFloat(g.totalScore))) return '<span class="exam-muted">Not graded</span>';
    const [grade, base] = gradeOnBase(g, exam.base).split(' / ');
    if (paperExam(exam) || s.source === 'manual' && !Object.keys(g.questionGrades || {}).length) {
      return `<span class="sub-score"><strong>${x(grade)}</strong> / ${x(base)}</span>`;
    }
    const points = `${fmt(g.totalScore)} of ${fmt(g.maxScore)} points`;
    if (s.status !== 'graded') return `<span class="sub-partial" title="${x(points)} so far">Partly graded <span class="exam-muted">${x(fmt(g.totalScore))}/${x(fmt(g.maxScore))}</span></span>`;
    return `<span class="sub-score" title="${x(points)}"><strong>${x(grade)}</strong> / ${x(base)}</span>`;
  }

  // In the grading page's order (the class list's, or EIS's for exam IDs), within its filter
  // and search: Previous and Next in grading follow it. all: every submission, for exports.
  function sortedSubmissions(exam, all = false) {
    return (all ? rosterOf(exam) : visibleRows(exam)).map(r => r.sub).filter(Boolean);
  }

  function onRosterInput(e) {
    if (S.section !== 'exams' || EX.view !== 'submissions' || !e.target.matches('#roster-search')) return;
    EX.subQuery = e.target.value.trim().toLowerCase();
    renderRosterRows(examById(EX.examId));
  }

  function onRosterChange(e) {
    if (S.section !== 'exams' || EX.view !== 'submissions' || !e.target.matches('[data-inline-grade]')) return;
    saveInlineGrade(examById(EX.examId), e.target);
  }

  // Enter in a grade field saves it and goes to the next row's.
  function onRosterKeydown(e) {
    if (e.key !== 'Enter' || !e.target.matches?.('[data-inline-grade]')) return;
    e.preventDefault();
    const fields = [...document.querySelectorAll('#roster-rows [data-inline-grade]:not(:disabled)')];
    const next = fields[fields.indexOf(e.target) + 1];
    e.target.blur();
    next?.focus();
    next?.select();
  }

  // A paper exam's grade, typed in its row: a grade-only entry is made the first time, and the
  // grade saved on it (cleared: not graded).
  async function saveInlineGrade(exam, input) {
    const tr = input.closest('tr');
    const row = rosterOf(exam).find(r => r.key === tr.dataset.rowKey);
    if (!row) return;
    const base = parseFloat(exam.base) || 100;
    const raw = input.value.trim();
    const value = raw === '' ? null : parseFloat(raw.replace(',', '.'));
    if (raw !== '' && (!Number.isFinite(value) || value < 0 || value > base)) {
      input.classList.add('field-error');
      toast(`A grade is a number from 0 to ${fmt(base)}`, 'err');
      return;
    }
    input.classList.remove('field-error');
    if (value == null && !row.sub) return;
    tr.classList.add('is-saving');
    try {
      let id = row.sub?.id;
      if (!id) id = await rpc('exam_add_submission', { p_exam_id: exam.id, p_student: row.student?.id || null, p_code: row.code || null, p_submission: null });
      const grades = manualGrades(row, value, base);
      const status = value == null ? 'submitted' : 'graded';
      await rpc('exam_save_grades', { p_submission_id: id, p_grades: grades, p_status: status });
      const sub = row.sub || { id, source: 'manual', exam_code: row.code || null, student_no: row.code ? '' : row.key,
        student_name: row.student?.full_name || '', student_email: row.student?.email || '', answers: {}, activity: {}, network: [], files: [] };
      Object.assign(sub, { grades, status });
      if (!row.sub) EX.submissions.push(sub);
      tr.classList.remove('is-saving');
      tr.classList.add('is-saved');
      tr.dataset.subId = id;
      tr.querySelector('[data-sub-action="grade"]')?.removeAttribute('disabled');
      setTimeout(() => tr.classList.remove('is-saved'), 1200);
      updateRosterCounts(exam);
    } catch (error) {
      tr.classList.remove('is-saving');
      input.classList.add('field-error');
      toast(`Not saved: ${error.message}`, 'err');
    }
  }

  // The filter counts, after a grade typed in a row (the rows stay as they are, for typing on).
  function updateRosterCounts(exam) {
    const rows = rosterOf(exam);
    document.querySelectorAll('[data-roster-filter]').forEach(btn => {
      const filter = rosterFilters(exam).find(f => f[0] === btn.dataset.rosterFilter);
      const n = rows.filter(filter[2]).length;
      btn.querySelector('span').textContent = n;
      btn.disabled = !n && filter[0] !== 'all';
    });
  }

  // ── Selecting rows on the grades list ──
  // The checkbox selects a row (Shift: the range from the last one); the header's selects
  // everyone shown. The filters give way to what can be done with them: a grade for those
  // without a submission, hand back, delete. A filter or search keeps only what it shows.
  const rosterRowsShown = exam => visibleRows(exam);

  function updateRosterSelection(exam, rows = rosterOf(exam)) {
    const tbody = document.getElementById('roster-rows');
    if (!tbody) return;
    const shown = new Set(visibleRows(exam, rows).map(r => r.key));
    [..._rosterSel].forEach(k => { if (!shown.has(k)) _rosterSel.delete(k); });
    tbody.querySelectorAll('tr[data-row-key]').forEach(tr => {
      const on = _rosterSel.has(tr.dataset.rowKey);
      tr.classList.toggle('is-selected', on);
      const box = tr.querySelector('.row-check');
      if (box) box.checked = on;
    });
    const all = document.getElementById('roster-check-all');
    if (all) {
      all.checked = shown.size > 0 && [...shown].every(k => _rosterSel.has(k));
      all.indeterminate = !all.checked && _rosterSel.size > 0;
      all.disabled = !shown.size;
    }
    const chosen = rows.filter(r => _rosterSel.has(r.key));
    const bulk = document.getElementById('roster-bulk');
    const filters = document.querySelector('.roster-filters');
    if (!bulk) return;
    bulk.hidden = !chosen.length;
    if (filters) filters.hidden = !!chosen.length;
    if (!chosen.length) return;
    document.getElementById('roster-bulk-count').textContent = `${chosen.length} selected`;
    const { grade, auto, download, back, clear, remove } = bulkTargets(exam, chosen);
    const set = (name, list, why) => {
      const b = bulk.querySelector(`[data-bulk="${name}"]`);
      if (!b) return;
      b.disabled = !list.length;
      b.title = list.length ? (list.length < chosen.length ? `${list.length} of the ${chosen.length} selected` : '') : why;
    };
    set('grade', grade, paperExam(exam) ? '' : examTakingAnswers(exam) ? 'Once the exam has closed' : 'Everyone selected has a submission: grade those on their own page');
    set('autograde', auto, (exam.questions || []).some(canAutograde) ? 'Nobody selected has answers' : 'No question has an answer key');
    set('download', download, 'Nobody selected has answers');
    set('return', back, 'Nobody selected has answers to hand back');
    set('clear-grades', clear, 'Nobody selected is graded');
    set('delete', remove, 'Nobody selected has a submission or a grade');
  }

  // While the exam takes answers (until 10 minutes after its end), nobody gets a grade without a submission.
  const examTakingAnswers = exam => !!(exam.questions?.length && exam.starts_at && Date.now() >= Date.parse(exam.starts_at)
    && (!exam.ends_at || Date.now() <= Date.parse(exam.ends_at) + 10 * 60000));

  // Who each action applies to, of the chosen rows. A grade given here goes to those without
  // answers (absent, or a grade entered by hand before); answers are graded on their own page.
  function bulkTargets(exam, chosen) {
    const paper = paperExam(exam);
    const answered = chosen.filter(r => r.sub && r.sub.source !== 'manual');
    return {
      grade: paper ? chosen : examTakingAnswers(exam) ? [] : chosen.filter(r => (!r.sub || r.sub.source === 'manual') && r.state !== 'taking'),
      auto: (exam.questions || []).some(canAutograde) ? answered : [],
      download: answered,
      back: canManage() ? answered : [],
      clear: chosen.filter(r => r.sub?.grades),
      remove: canManage() ? chosen.filter(r => r.sub) : [],
    };
  }

  function onRosterCheck(exam, box, e) {
    const tr = box.closest('tr[data-row-key]');
    if (box.id === 'roster-check-all') {
      if (box.checked) rosterRowsShown(exam).forEach(r => _rosterSel.add(r.key));
      else _rosterSel.clear();
      return updateRosterSelection(exam);
    }
    if (!tr) return;
    const key = tr.dataset.rowKey;
    if (e.shiftKey && _rosterAnchor && _rosterAnchor !== key) {
      const keys = rosterRowsShown(exam).map(r => r.key);
      const [a, b] = [keys.indexOf(_rosterAnchor), keys.indexOf(key)].sort((p, q) => p - q);
      if (a >= 0) keys.slice(a, b + 1).forEach(k => (box.checked ? _rosterSel.add(k) : _rosterSel.delete(k)));
    } else if (box.checked) _rosterSel.add(key);
    else _rosterSel.delete(key);
    _rosterAnchor = key;
    updateRosterSelection(exam);
  }

  // Escape clears the selection; Ctrl/Cmd+A, once something is selected, takes everyone shown.
  document.addEventListener('keydown', e => {
    if (S.section !== 'exams' || EX.view !== 'submissions' || !_rosterSel.size || !document.getElementById('roster-rows')) return;
    if (e.target.closest?.('input:not([type=checkbox]), textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('.modal-overlay.open')) return;
    const exam = examById(EX.examId);
    if (!exam) return;
    if (e.key === 'Escape') { _rosterSel.clear(); updateRosterSelection(exam); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      rosterRowsShown(exam).forEach(r => _rosterSel.add(r.key));
      updateRosterSelection(exam);
    }
  });

  async function onBulkAction(exam, action) {
    const chosen = rosterOf(exam).filter(r => _rosterSel.has(r.key));
    if (action === 'clear') { _rosterSel.clear(); return updateRosterSelection(exam); }
    const targets = bulkTargets(exam, chosen);
    if (action === 'grade') return bulkGrade(exam, targets.grade, chosen.length);
    if (action === 'return') return bulkReturn(exam, targets.back, chosen.length);
    if (action === 'autograde') return bulkAutograde(exam, targets.auto);
    if (action === 'download') return exportReportsPdf(exam, targets.download.map(r => r.sub));
    if (action === 'clear-grades') return bulkClear(exam, targets.clear, chosen.length);
    if (action === 'delete') return bulkDelete(exam, targets.remove, chosen.length);
  }

  const rowName = r => r.code ? `exam ID ${r.code}` : (r.student?.full_name || r.student?.email || r.key);
  const countOf = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const skippedNote = (n, total, one, many) => (n < total ? `\n\n${total - n} of the selected ${total - n === 1 ? one : many}.` : '');

  // The grade-only entry a grade without a submission is kept on: the grade on the exam's base.
  function manualGrades(row, value, base) {
    return { ...(row.sub?.grades || {}), totalScore: value == null ? '' : String(value), maxScore: base,
      percentage: value == null ? '' : `${(value / base * 100).toFixed(1)}%`, gradedAt: new Date().toISOString(), gradedBy: S.access?.email || '', questionGrades: {} };
  }

  // Runs one call per row, in turn; how many went through, and the first error.
  async function eachRow(rows, call) {
    let done = 0, failed = null;
    for (const r of rows) {
      try { await call(r); done++; } catch (error) { failed ||= `${rowName(r)}: ${error.message}`; }
    }
    return { done, failed };
  }

  function bulkReport({ done, failed }, what) {
    if (failed) toast(`${done ? `${what(done)}; ` : ''}not all went through. ${failed}`, 'err');
    else toast(what(done), 'ok');
  }

  // The same grade for everyone chosen without a submission (0 for those absent, by default).
  async function bulkGrade(exam, rows, chosen) {
    if (!rows.length) return;
    const base = parseFloat(exam.base) || 100;
    const ov = overlay('exam-bulk-grade', { wide: false });
    ov.title('Give a Grade');
    const regrade = rows.filter(r => r.sub).length;
    ov.body.innerHTML = `
      <p>The grade for ${rows.length === 1 ? x(rowName(rows[0])) : `the <strong>${rows.length}</strong> selected`}${paperExam(exam) ? '' : ` without a submission`}, out of ${x(fmt(base))}.
        ${regrade ? (regrade === rows.length ? (regrade === 1 ? 'The grade it has is replaced.' : 'The grades they have are replaced.')
          : `${regrade} of them already ${regrade === 1 ? 'has a grade, which is' : 'have grades, which are'} replaced.`) : ''}</p>
      ${!paperExam(exam) && rows.length < chosen ? `<p class="form-hint">${chosen - rows.length} of the selected ${chosen - rows.length === 1 ? 'has' : 'have'} a submission: grade ${chosen - rows.length === 1 ? 'it' : 'those'} on ${chosen - rows.length === 1 ? 'its' : 'their'} own page.</p>` : ''}
      <label class="bulk-grade-field">Grade <input type="number" id="bulk-grade-value" min="0" max="${base}" step="any" value="0"> <span>/ ${x(fmt(base))}</span></label>`;
    ov.foot.innerHTML = `<button type="button" class="btn-sm btn-secondary" data-close>Cancel</button>
      <button type="button" class="btn-sm btn-green" id="bulk-grade-save"><i class="fa-solid fa-check"></i> Give ${rows.length === 1 ? 'grade' : `${rows.length} grades`}</button>`;
    ov.open();
    const input = document.getElementById('bulk-grade-value');
    setTimeout(() => { input.focus(); input.select(); }, 60);
    input.onkeydown = e => { if (e.key === 'Enter') document.getElementById('bulk-grade-save').click(); };
    document.getElementById('bulk-grade-save').onclick = async () => {
      const value = parseFloat(String(input.value).replace(',', '.'));
      if (!Number.isFinite(value) || value < 0 || value > base) {
        input.classList.add('field-error');
        return toast(`A grade is a number from 0 to ${fmt(base)}`, 'err');
      }
      const button = document.getElementById('bulk-grade-save');
      button.disabled = true;
      const result = await eachRow(rows, async r => {
        const id = r.sub?.id || await rpc('exam_add_submission', { p_exam_id: exam.id, p_student: r.student?.id || null, p_code: r.code || null, p_submission: null });
        await rpc('exam_save_grades', { p_submission_id: id, p_grades: manualGrades(r, value, base), p_status: 'graded' });
      });
      ov.close();
      _rosterSel.clear();
      bulkReport(result, n => `Gave ${fmt(value)} to ${countOf(n, 'student')}`);
      await refreshAfterChange(exam.id);
    };
  }

  // Autograde for the chosen: questions with an answer key and no points yet; points given stay.
  async function bulkAutograde(exam, rows) {
    if (!rows.length) return;
    let questions = 0;
    const result = await eachRow(rows, async r => {
      const graded = autogradeSubmission(exam, r.sub);
      if (!graded) return;
      questions += graded.changed;
      await rpc('exam_save_grades', { p_submission_id: r.sub.id, p_grades: graded.grades, p_status: graded.status });
    });
    _rosterSel.clear();
    bulkReport(result, () => (questions ? `Autograded ${questions} question${questions === 1 ? '' : 's'} in ${countOf(rows.length, 'submission')}` : 'Nothing left to autograde'));
    await refreshAfterChange(exam.id);
  }

  async function bulkClear(exam, rows, chosen) {
    if (!rows.length) return;
    if (!(await confirmDialog(`Clear the grading of ${rows.length === 1 ? rowName(rows[0]) : `${rows.length} students`}? Every point, comment and the feedback is removed.`
      + skippedNote(rows.length, chosen, 'is not graded', 'are not graded'), { title: 'Clear Grading', okLabel: 'Clear', danger: true, okIcon: 'fa-eraser' }))) return;
    const result = await eachRow(rows, r => rpc('exam_save_grades', { p_submission_id: r.sub.id, p_grades: null, p_status: 'submitted' }));
    _rosterSel.clear();
    bulkReport(result, n => `Cleared ${countOf(n, 'grading', 'gradings')}`);
    await refreshAfterChange(exam.id);
  }

  async function bulkReturn(exam, rows, chosen) {
    if (!rows.length || !requirePermission(canManage())) return;
    const open = examStatus(exam).key === 'open';
    const graded = rows.filter(r => r.sub.grades).length;
    const message = `Hand back ${rows.length === 1 ? `${rowName(rows[0])}'s exam` : `the exams of ${rows.length} students`}? Their answers return to their exam page, and they can change them and submit again while the exam is open.`
      + (graded ? `\n\n${graded === rows.length ? 'Their grades are' : `${graded} grade${graded === 1 ? ' is' : 's are'}`} removed.` : '')
      + (open ? '' : '\n\nThe exam has ended: extend its duration in Settings so they can continue. Everyone who has not submitted can then take it too.')
      + skippedNote(rows.length, chosen, 'has no answers to hand back', 'have no answers to hand back');
    if (!(await confirmDialog(message, { title: 'Hand Back', okLabel: 'Hand back', okIcon: 'fa-rotate-left' }))) return;
    const result = await eachRow(rows, r => rpc('exam_return_submission', { p_id: r.sub.id }));
    _rosterSel.clear();
    bulkReport(result, n => `Handed back to ${countOf(n, 'student')}`);
    await refreshAfterChange(exam.id);
  }

  async function bulkDelete(exam, rows, chosen) {
    if (!rows.length || !requirePermission(canManage())) return;
    const manual = rows.filter(r => r.sub.source === 'manual').length, real = rows.length - manual;
    const parts = [real && `${countOf(real, 'submission')} (answers and grades)`, manual && `${countOf(manual, 'grade')} entered by hand`].filter(Boolean);
    const message = `Delete ${parts.join(' and ')}? This cannot be undone.` + skippedNote(rows.length, chosen, 'has nothing to delete', 'have nothing to delete');
    if (!(await confirmDialog(message, { title: 'Delete', okLabel: 'Delete', danger: true, okIcon: 'fa-trash-can' }))) return;
    const result = await eachRow(rows, r => rpc('exam_delete_submission', { p_id: r.sub.id }));
    _rosterSel.clear();
    bulkReport(result, n => `Deleted ${countOf(n, 'entry', 'entries')}`);
    await refreshAfterChange(exam.id);
  }

  async function onSubmissionsAction(btn) {
    const exam = examById(EX.examId);
    if (!exam) return;
    if (btn.dataset.bulk) return onBulkAction(exam, btn.dataset.bulk);
    if ('rosterSort' in btn.dataset) {
      EX.subSort = nextSort(EX.subSort, btn.dataset.rosterSort);
      document.getElementById('roster-head').innerHTML = rosterHeadHtml(exam);
      return renderRosterRows(exam);
    }
    if (btn.dataset.rosterFilter) {
      EX.subFilter = btn.dataset.rosterFilter;
      document.querySelectorAll('[data-roster-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      return renderRosterRows(exam);
    }
    const tr = btn.closest('[data-row-key]');
    const row = tr ? rosterOf(exam).find(r => r.key === tr.dataset.rowKey) : null;
    const sub = row?.sub || EX.submissions.find(s => s.id === tr?.dataset.subId);
    switch (btn.dataset.subAction) {
      case 'refresh': return refreshAfterChange(exam.id);
      case 'answers': return showInfo('Answers', jsonListHtml(sub.answers));
      case 'network': return showNetwork(exam, sub);
      case 'activity': return showInfo(`Left the page: ${sub.student_name || sub.exam_code}`, activityHtml(sub.activity));
      case 'delivery': return showInfo(`Sent late: ${sub.student_name || sub.exam_code}`, deliveryHtml(exam, sub));
      case 'grade': return openGrading(exam, sub);
      case 'enter-grade': return enterGrade(exam, row);
      case 'import': return importBackupFile(exam, row);
      case 'return': return returnSubmission(exam, sub);
      case 'delete': return deleteSubmission(exam, sub);
      case 'delete-files': return deleteFiles(exam);
      case 'pdf-questions': return exportQuestionsPdf(exam);
      case 'zip': return exportSubmissionsZip(exam);
      case 'pdf-grades': return exportGradesPdf(exam);
      case 'pdf-reports': return exportReportsPdf(exam, sortedSubmissions(exam, true).filter(s => s.status === 'graded' && s.grades));
      case 'eis': return showEisGrades(exam);
    }
  }

  // A grade for someone without a submission (absent, or answered on paper): an entry with no
  // answers, graded question by question like the others.
  async function enterGrade(exam, row) {
    if (!row) return;
    try {
      const id = await rpc('exam_add_submission', { p_exam_id: exam.id, p_student: row.student?.id || null, p_code: row.code || null, p_submission: null });
      await refreshAfterChange(exam.id);
      const sub = EX.submissions.find(s => s.id === id);
      if (sub) openGrading(examById(exam.id) || exam, sub);
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  // The worst case: the answers never reached the server, but the student has the backup file
  // the exam page saved to their downloads. It becomes their submission (marked From file).
  function importBackupFile(exam, row) {
    if (!row || !requirePermission(canManage())) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch { toast('This is not a backup file from the exam page', 'err'); return; }
      if (!data?.answers || typeof data.answers !== 'object' || !data.examDetails) { toast('This is not a backup file from the exam page', 'err'); return; }
      const problems = [];
      if (data.examDetails.ExamId && data.examDetails.ExamId !== exam.id) problems.push(`it is from another exam (${data.examDetails.Name || 'unknown'})`);
      const info = data.studentInfo || {};
      if (row.code && info.examCode && info.examCode !== row.code) problems.push(`it is for exam ID ${info.examCode}`);
      if (row.student && (info.student_no || info.email) && info.student_no !== row.student.student_no && String(info.email || '').toLowerCase() !== row.student.email) {
        problems.push(`it is for ${info.name || info.email || info.student_no}`);
      }
      const who = row.code ? `exam ID ${row.code}` : row.student.full_name;
      const answered = Object.keys(data.answers).filter(k => /^ans-\d+$/.test(k)).length;
      const message = `Add this file as the submission of ${who}? It has ${answered} answer${answered === 1 ? '' : 's'}${data.submissionTimestamp ? `, saved ${formatWhen(data.submissionTimestamp)}` : ''}.`
        + (problems.length ? `\n\nCareful: ${problems.join(', and ')}.` : '')
        + '\n\nThe student had this file, so they could have changed it: it is marked "From file".';
      if (!(await confirmDialog(message, { title: 'Add from a Backup File', okLabel: 'Add', okIcon: 'fa-file-import', danger: problems.length > 0 }))) return;
      try {
        await rpc('exam_add_submission', { p_exam_id: exam.id, p_student: row.student?.id || null, p_code: row.code || null, p_submission: {
          answers: data.answers, question_ids: Array.isArray(data.questionIds) ? data.questionIds : null, activity: data.activity || {},
          fingerprint: data.fingerprint || {}, file_time: data.submissionTimestamp || null } });
        toast(`Added for ${who}`, 'ok');
        await refreshAfterChange(exam.id);
      } catch (error) {
        toast(error.message, 'err');
      }
    };
    input.click();
  }

  // Hands a submission back: the student can carry on from their answers while the exam is open.
  async function returnSubmission(exam, sub) {
    if (!sub || !requirePermission(canManage())) return;
    const who = sub.student_name || `exam ID ${sub.exam_code}`;
    const open = examStatus(exam).key === 'open';
    const until = exam.ends_at ? new Date(exam.ends_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const message = `Hand ${who}'s exam back? Their answers return to their exam page, and they can change them and submit again while the exam is open${open && until ? ` (until ${until})` : ''}.`
      + (sub.grades ? '\n\nIts grade is removed.' : '')
      + (open ? '' : '\n\nThe exam has ended: extend its duration in Settings so they can continue. Everyone who has not submitted can then take it too.');
    if (!(await confirmDialog(message, { title: 'Hand Back', okLabel: 'Hand back', okIcon: 'fa-rotate-left' }))) return;
    try {
      await rpc('exam_return_submission', { p_id: sub.id });
      toast(`Handed back to ${who}`, 'ok');
      await refreshAfterChange(exam.id);
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  async function deleteSubmission(exam, sub) {
    const who = sub.student_name || sub.exam_code || 'this student';
    const manual = sub.source === 'manual';
    if (!(await confirmDialog(manual ? `Remove the grade entered for ${who}?` : `Delete the submission from ${who}? Its answers and grades are lost.`,
      { title: manual ? 'Remove Grade' : 'Delete Submission', okLabel: manual ? 'Remove' : 'Delete', danger: true, okIcon: 'fa-trash-can' }))) return;
    try {
      await rpc('exam_delete_submission', { p_id: sub.id });
      toast(manual ? 'Grade removed' : 'Submission deleted', 'ok');
      await refreshAfterChange(exam.id);
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  // ── Uploaded files (Storage) ──
  // The file a student gave as a question's answer: the one the answer names, else (an answer
  // lost at the deadline, say) their last upload for that question.
  function answerFile(sub, n) {
    const files = (sub.files || []).filter(f => f.question === n);
    const named = sub.answers?.[`ans-${n}`]?.upload;
    return files.find(f => f.id === named) || (named ? null : files[files.length - 1]) || null;
  }

  async function downloadBlob(path) {
    const { data, error } = await sb.storage.from(UPLOAD_BUCKET).download(path);
    if (error) throw new Error(error.message || 'The file could not be downloaded');
    return data;
  }

  function saveBlob(blob, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function downloadUpload(btn) {
    btn.disabled = true;
    try { saveBlob(await downloadBlob(btn.dataset.fileDownload), btn.dataset.fileName); }
    catch (error) { toast(`Could not download ${btn.dataset.fileName}: ${error.message}`, 'err'); }
    finally { btn.disabled = false; }
  }

  // Removes every stored file of the exam through Storage, 100 at a time.
  async function removeExamFiles(exam) {
    const paths = await rpc('exam_upload_paths', { p_exam_id: exam.id });
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await sb.storage.from(UPLOAD_BUCKET).remove(paths.slice(i, i + 100));
      if (error) throw new Error(`The uploaded files could not be deleted: ${error.message}`);
    }
    return paths.length;
  }

  async function deleteFiles(exam) {
    if (!(await confirmDialog(`Delete the ${exam.file_count} file${exam.file_count === 1 ? '' : 's'} students uploaded for "${examTitle(exam)}" (${formatBytes(exam.file_bytes)})?\n\nDownload them first (Download, on the Grades page): the grades and the other answers stay.`,
      { title: 'Delete Uploaded Files', okLabel: 'Delete files', danger: true, okIcon: 'fa-trash-can' }))) return;
    try {
      const n = await removeExamFiles(exam);
      toast(`${n} file${n === 1 ? '' : 's'} deleted`, 'ok');
      await refreshAfterChange(exam.id);
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  // ── Leaving the exam page (recorded by the exam page) ──
  const LEAVE_HOW = { tab: 'Another tab, or the browser minimised', window: 'Clicked outside the window, or another program',
    reload: 'Page reloaded or closed, or signed out', device: 'Moved to another computer' };

  // A line of the Integrity column: a dot in the colour of what it says, and the details on a
  // click when there are any.
  function subFlagHtml(text, kind, action, title = '') {
    return action ? `<button type="button" class="sub-flag is-${kind}" data-sub-action="${action}" title="${x(title)}">${x(text)}</button>`
      : `<span class="sub-flag is-${kind}"${title ? ` title="${x(title)}"` : ''}>${x(text)}</span>`;
  }

  function leftPageHtml(sub) {
    const a = sub.activity;
    if (!a || a.count == null) return subFlagHtml('Leaving not recorded', 'muted');
    if (!a.count) return '';
    return subFlagHtml(`Left ${a.count}×, ${formatSeconds(a.total_seconds)}`, 'warn', 'activity', `Left the page ${a.count === 1 ? 'once' : `${a.count} times`}: when and for how long`);
  }

  function activityHtml(a) {
    if (!a?.count) return '<p class="exam-muted">The student never left the exam page.</p>';
    const rows = (a.leaves || []).map(l => `<tr><td>${x(l.from ? formatTime(l.from) : '')}</td><td>${x(formatSeconds(l.seconds))}</td><td>${x(LEAVE_HOW[l.how] || l.how || '')}</td></tr>`).join('');
    return `<p>Left the page <strong>${a.count} time${a.count === 1 ? '' : 's'}</strong>, <strong>${x(formatSeconds(a.total_seconds))}</strong> in total${a.cooldown ? `, with a countdown each time (${x(formatSeconds(a.cooldown_seconds_total || 0))} locked in all)` : ''}.</p>
      <div class="data-table-container"><table class="data-table"><thead><tr><th>Left at</th><th>Away for</th><th>How</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${(a.leaves || []).length < a.count ? `<p class="form-hint">Only the first ${a.leaves.length} are listed.</p>` : ''}`;
  }

  // ── Networks and devices (recorded with each start, check-in, upload and submission) ──
  const ipsOf = sub => [...new Set((sub.network || []).map(n => n.ip).filter(Boolean))];
  const devicesOf = sub => [...new Set((sub.network || []).map(n => n.device).concat(sub.fingerprint?.deviceId || []).filter(Boolean))];

  // The class's network: the address most submissions came from (two at least).
  function classNetwork(subs) {
    const counts = new Map();
    subs.forEach(s => ipsOf(s).forEach(ip => counts.set(ip, (counts.get(ip) || 0) + 1)));
    const [ip, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
    return n >= 2 ? ip : null;
  }

  function networkCellHtml(sub, classIp) {
    const ips = ipsOf(sub);
    let label, kind = 'plain';
    if (!ips.length) { label = 'No network'; kind = 'muted'; }
    else if (classIp && ips.every(ip => ip === classIp)) { label = 'Class network'; kind = 'ok'; }
    else if (classIp) { label = ips.includes(classIp) ? `Class and ${ips.length - 1} other network${ips.length === 2 ? '' : 's'}` : 'Other network'; kind = 'warn'; }
    else label = ips.length === 1 ? `Network ${ips[0]}` : `${ips.length} networks`;
    const devices = devicesOf(sub).length;
    if (devices > 1) kind = 'warn';
    return subFlagHtml(`${label}${devices > 1 ? `, ${devices} devices` : ''}`, kind, ips.length ? 'network' : '', ips.length ? 'Networks, provider, place and device' : 'The network was not recorded');
  }

  // "Edge 156, Windows" from a user agent.
  function describeAgent(ua) {
    if (!ua) return '';
    const browser = [[/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/Firefox\/(\d+)/, 'Firefox'], [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+).*Safari/, 'Safari']]
      .map(([re, name]) => (re.test(ua) ? `${name} ${ua.match(re)[1]}` : null)).find(Boolean) || 'A browser';
    const system = [[/Windows NT/, 'Windows'], [/iPhone|iPad/, 'iOS'], [/Mac OS X/, 'macOS'], [/Android/, 'Android'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux']]
      .find(([re]) => re.test(ua))?.[1] || '';
    return [browser, system].filter(Boolean).join(', ') + (/Mobi|iPhone|Android/.test(ua) ? ' (phone)' : '');
  }

  // Provider and place of an address, from ipwho.is (once per address).
  const IP_LOOKUPS = new Map();
  function lookUpIp(ip) {
    if (!IP_LOOKUPS.has(ip)) {
      IP_LOOKUPS.set(ip, fetch(`https://ipwho.is/${encodeURIComponent(ip)}`).then(r => r.json()).then(d => (d?.success ? d : null)).catch(() => null));
    }
    return IP_LOOKUPS.get(ip);
  }

  // Where a submission was made from: each network and device, with the provider and place
  // looked up as this opens, and what the browser said about itself.
  function showNetwork(exam, sub) {
    const classIp = classNetwork(EX.submissions);
    const net = sub.network || [];
    const f = sub.fingerprint || {};
    const ips = ipsOf(sub), devices = devicesOf(sub);
    const others = ips.filter(ip => ip !== classIp);
    const summary = !net.length ? 'No network was recorded with this submission.'
      : `Taken from ${ips.length || 'an unknown'} network${ips.length === 1 ? '' : 's'} on ${devices.length} device${devices.length === 1 ? '' : 's'}${!classIp ? '.'
        : others.length ? `; ${others.length === ips.length ? 'none of them is' : `${others.length} of them ${others.length === 1 ? 'is' : 'are'} not`} the class network (the one most submissions came from).`
        : ', all on the class network (the one most submissions came from).'}`;
    // The same browser in another submission of this exam: the same computer.
    const sharing = EX.submissions.filter(o => o.id !== sub.id && devicesOf(o).some(d => devices.includes(d))).map(o => o.student_name || o.exam_code);
    const rows = net.map(n => `<tr>
        <td><strong>${x(n.ip || 'Unknown')}</strong>${n.ip && classIp ? (n.ip === classIp ? ' <span class="badge exam-badge-graded">Class network</span>' : ' <span class="badge exam-badge-late">Other network</span>') : ''}</td>
        <td class="exam-net-place exam-muted" data-ip="${x(n.ip || '')}">${n.ip ? 'Looking up…' : ''}</td>
        <td>${x(describeAgent(n.agent))}</td>
        <td>${n.first ? `${x(formatTime(n.first))} to ${x(formatTime(n.last))}` : ''}</td>
        <td>${x(String(n.calls || 1))}</td></tr>`).join('');
    const tz = f.timezone || (f.timezoneOffset != null ? `UTC${f.timezoneOffset > 0 ? '−' : '+'}${Math.abs(f.timezoneOffset) / 60}` : '');
    const facts = [
      ['Browser and system', [describeAgent(f.ua), f.uaPlatform && `reports ${f.uaPlatform}`].filter(Boolean).join(', ')],
      ['Screen', f.screenRes && f.screenRes.split('x').slice(0, 2).join(' × ')], ['Window', f.windowInnerSize && f.windowInnerSize.replace('x', ' × ')],
      ['Time zone', tz], ['Language', f.lang], ['Graphics', f.webglRenderer], ['Connection', f.connection],
      ['Processor cores', f.cores], ['Device id', (devices[0] || '').slice(0, 8)],
    ].filter(([, v]) => v != null && v !== '' && v !== 'N/A');
    showInfo(`Network and device: ${sub.student_name || sub.exam_code}`, `
      <p>${x(summary)}</p>
      <div class="data-table-container exam-net-table"><table class="data-table">
        <thead><tr><th>Network (IP address)</th><th>Provider and place</th><th>Browser</th><th>Used</th><th>Check-ins</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="table-message">Not recorded: submitted before networks were recorded.</td></tr>'}</tbody></table></div>
      ${sharing.length ? `<p class="exam-edit-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>The same browser also took this exam for: ${x(sharing.join(', '))}. That is one computer, unless it was shared in turns.</span></p>` : ''}
      ${facts.length ? `<h4 class="exam-net-head">Device</h4><dl>${facts.map(([k, v]) => `<dt>${x(k)}</dt><dd>${x(String(v))}</dd>`).join('')}</dl>` : ''}
      <p class="form-hint exam-net-note">Provider and place come from the IP address, looked up at ipwho.is as this opens: they are approximate, and a university network shows as its internet provider. Web pages can't see Wi-Fi names (SSID) or an exact location.</p>
      ${Object.keys(f).length ? `<details class="exam-net-raw"><summary>Everything the browser reported</summary>${jsonListHtml(f)}</details>` : ''}`);
    document.querySelectorAll('#exam-info-body .exam-net-place[data-ip]').forEach(async cell => {
      if (!cell.dataset.ip) return;
      const d = await lookUpIp(cell.dataset.ip);
      cell.classList.remove('exam-muted');
      cell.textContent = d ? [d.connection?.org || d.connection?.isp, [d.city, d.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : 'Could not look up';
    });
  }

  // For grading and the PDFs: the networks in a line.
  function networkLine(sub) {
    const ips = ipsOf(sub);
    if (!ips.length) return '';
    const classIp = classNetwork(EX.submissions);
    return ips.map(ip => (classIp ? `${ip} (${ip === classIp ? 'class network' : 'other network'})` : ip)).join(', ');
  }

  // Reloads counts and the submissions list after a change.
  async function refreshAfterChange(examId) {
    try { await loadCourse(EX.course, EX.isArchive); } catch { }
    if (onGradingPage()) {
      try {
        const [subs, attempts] = await Promise.all([rpc('exam_submissions', { p_exam_id: examId }), rpc('exam_attempts', { p_exam_id: examId }).catch(() => EX.attempts)]);
        EX.submissions = subs;
        EX.attempts = attempts || [];
      } catch { }
      return;
    }
    if (S.section === 'exams' && EX.view === 'submissions') await showSubmissions(examId);
  }

  function showInfo(title, html) {
    const ov = overlay('exam-info');
    ov.title(title);
    ov.body.innerHTML = `<div class="formatted-content">${html}</div>`;
    ov.foot.innerHTML = '';
    ov.open();
  }

  function jsonListHtml(data) {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return '<p class="exam-muted">Nothing recorded.</p>';
    return '<dl>' + Object.entries(data).map(([key, value]) => `<dt>${x(key)}</dt><dd>${value == null ? '<em>empty</em>'
      : typeof value === 'object' ? `<pre>${x(JSON.stringify(value, null, 2))}</pre>` : xh(String(value)).replace(/\n/g, '<br>')}</dd>`).join('') + '</dl>';
  }


  // ── Grading dialog ──
  // A question's maximum points: text-only items are worth nothing, unpointed ones 1.
  function questionMaxPoints(q) {
    if (q.type === 'text_only') return 0;
    const points = parseFloat(q.points);
    return Number.isNaN(points) || points < 0 ? 1 : points;
  }
  const totalPoints = questions => questions.reduce((sum, q) => sum + questionMaxPoints(q), 0);

  function gradeOnBase(grades, base) {
    const total = parseFloat(grades?.totalScore), max = parseFloat(grades?.maxScore), scale = parseFloat(base) || 100;
    if (!Number.isFinite(total)) return 'Not graded';
    return Number.isFinite(max) && max > 0 ? `${fmt(total / max * scale)} / ${fmt(scale)}` : `${fmt(total)} / ${fmt(scale)}`;
  }

  let _grading = null; // { exam, sub, snapshot }

  // The page's points and comments, to tell whether anything was entered since it opened.
  const gradingSnapshot = () => JSON.stringify([...document.querySelectorAll('#exam-grade-body input, #exam-grade-body textarea')].map(el => el.value));
  const gradingChanged = () => _grading?.snapshot != null && gradingSnapshot() !== _grading.snapshot;
  const onGradingPage = () => !!document.getElementById('grading-page');

  // ── The grading page ──
  // Grading takes the page, as Settings does: the course's header and tabs give way to the
  // student's answers, with the arrow at the top left going back to the grades list. Its bar
  // keeps the total and Save in view. The questions come one under another, as the student had
  // them: each with its points in its head (Right and Wrong fill them in), then the answer, the
  // correct one when there is one (and whether they match), and a comment.
  let _gradingFrom = 'exams'; // where Back goes: the exam's grades list, or the Students tab
  function openGrading(exam, sub) {
    _grading = { exam, sub };
    EX.view = 'grading';
    S.section = 'exams'; // Ctrl+S saves the grades
    const questions = exam.questions || [];
    const answers = sub.answers || {};
    const list = sortedSubmissions(exam);
    const at = list.findIndex(s => s.id === sub.id);
    const prev = list[at - 1], next = list[at + 1];
    let number = 0;
    const chips = [];
    const base = parseFloat(exam.base) || 100;
    const paper = !questions.length;
    const items = paper ? `<section class="gq" id="grading-q-total" data-q="total" data-max="${base}" data-status="ungraded">
        <div class="gq-head"><h4 class="gq-title">Grade</h4><span class="badge gq-status">${STATUS_LABELS.ungraded}</span>
          <div class="gq-score"><label class="gq-points"><span class="sr-only">Grade</span>
            <input type="number" id="points-q-total" min="0" max="${base}" step="0.1" data-grade-points><span>/ ${fmt(base)}</span></label></div></div>
        <p class="form-hint">This exam is held on paper: the grade on its base of ${fmt(base)}.</p></section>`
    : questions.map((q, i) => {
      const n = i + 1;
      if (q.type === 'text_only') return `<section class="gq gq-text" id="grading-q-${n}"><div class="text-content">${promptHtml(q.prompt)}</div></section>`;
      number++;
      chips.push(`<button type="button" class="gq-jump" data-jump="${n}" data-status="ungraded" title="Question ${number}">${number}</button>`);
      const max = questionMaxPoints(q);
      const key = answerKey(q);
      const given = answers[`ans-${n}`];
      const match = given == null || given === '' ? null : autoCheck(q, answers, n);
      return `<section class="gq" id="grading-q-${n}" data-q="${n}" data-max="${max}" data-status="ungraded">
        <div class="gq-head">
          <h4 class="gq-title">Question ${number}</h4>
          <span class="badge gq-status">${STATUS_LABELS.ungraded}</span>
          <div class="gq-score">
            <span class="gq-marks" role="group" aria-label="Mark question ${number}">
              <button type="button" class="btn-sm btn-secondary" data-grade="correct" title="Full points">Right</button>
              <button type="button" class="btn-sm btn-secondary" data-grade="incorrect" title="No points">Wrong</button>
            </span>
            <label class="gq-points"><span class="sr-only">Points for question ${number}</span>
              <input type="number" id="points-q-${n}" min="0" max="${max}" step="0.1" data-grade-points><span>/ ${fmt(max)}</span></label>
          </div>
        </div>
        <div class="question-prompt gq-prompt">${promptHtml(q.prompt)}</div>
        ${questionImagesHtml(q, 'qp-images grading-images')}
        <dl class="gq-rows">
          <dt>Answer</dt>
          <dd><div class="student-answer">${studentAnswerHtml(given, q.type, sub, n)}${q.type === 'numeric' && q.unit ? ` <span class="exam-muted">${x(q.unit)}</span>` : ''}</div>
            ${match == null ? '' : `<span class="gq-match is-${match ? 'yes' : 'no'}">${match ? 'Matches the correct answer' : 'Does not match the correct answer'}</span>`}</dd>
          ${key ? `<dt>${key.label}</dt><dd class="correct-answer">${key.html}</dd>` : ''}
          ${q.explanation ? `<dt>Notes</dt><dd class="exam-muted">${xh(q.explanation)}</dd>` : ''}
          <dt><label for="comment-q-${n}">Comment</label></dt>
          <dd><textarea id="comment-q-${n}" rows="1"></textarea></dd>
        </dl>
      </section>`;
    }).join('');
    const meta = [
      ...(sub.exam_code ? [] : [['Student ID', x(shownNo(sub.student_no))], ['Email', x(sub.student_email)]]),
      sub.source === 'manual' ? ['Submitted', 'No submission: a grade entered by hand']
        : ['Submitted', `${x(formatWhen(sub.submitted_at))}${sub.late ? ' <span class="badge exam-badge-late">Late</span>' : ''}${sub.auto_submitted ? ' <span class="badge exam-badge-auto" title="Submitted automatically at the deadline">Auto</span>' : ''}${sub.source === 'imported' ? ' <span class="badge exam-badge-note">From file</span>' : ''}`],
      ['Left the page', sub.activity?.count ? `${sub.activity.count === 1 ? 'Once' : `${sub.activity.count} times`}, ${x(formatSeconds(sub.activity.total_seconds))} in total` : ''],
      ['Network', x(networkLine(sub))],
    ].filter(([, value]) => value);
    // Kept in view at the top: a chip for each question in its status's colour, to go to it,
    // and the other submissions, without saving (it asks first).
    const step = (s, icon, label, keys) => `<button type="button" class="btn-ghost btn-sm grading-step" ${s ? `data-nav="${x(s.id)}" title="${x(`${subName(s)} (${keys})`)}"` : 'disabled'} aria-label="${label}">${icon}</button>`;
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    const main = document.getElementById('main-area');
    lockHeight(main);
    main.innerHTML = `
      <section id="grading-page" class="grading-page" aria-labelledby="grading-title">
        <div class="course-header access-header grading-header">
          <button type="button" class="btn-ghost access-back" id="grading-back" title="${_gradingFrom === 'students' ? 'Back to the students' : 'Back to the grades'}" aria-label="Back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
          <div class="ch-title-wrap"><h2 id="grading-title">${x(subName(sub))}</h2>
            <div class="ch-meta">${x([examTitle(exam), header.code || EX.course].filter(Boolean).join(' · '))}${list.length > 1 && at >= 0 ? ` · ${at + 1} of ${list.length}` : ''}</div></div>
          ${list.length > 1 ? `<div class="grading-steps">${step(prev, '<i class="fa-solid fa-chevron-left"></i>', 'Previous', 'Alt+←')}${step(next, '<i class="fa-solid fa-chevron-right"></i>', 'Next', 'Alt+→')}</div>` : ''}
        </div>
        <div class="section-topbar grading-topbar" data-no-dirty>
          ${paper ? `<span class="exam-topbar-note grading-total" aria-live="polite"><span id="grading-total" hidden></span>Grade <strong id="grading-base">0</strong> / ${fmt(exam.base)}</span>`
            : `<span class="exam-topbar-note grading-total" aria-live="polite"><span><strong id="grading-total">0</strong> of ${fmt(totalPoints(questions))} points</span><span class="exam-dot">·</span>
              <span>grade <strong id="grading-base">0</strong> / ${fmt(exam.base)}</span></span>`}
          <span class="grading-actions">
          <button class="btn-sm btn-secondary" type="button" id="grading-download" title="This graded exam as a PDF, for your records"><i class="fa-solid fa-file-arrow-down"></i> Download</button>
          <button class="btn-sm btn-secondary" type="button" id="grading-clear" title="Removes every point, comment and the feedback" ${sub.grades ? '' : 'disabled'}><i class="fa-solid fa-eraser"></i> Clear</button>
          <button class="btn-sm btn-secondary" type="button" id="grading-auto" ${questions.some(canAutograde) ? '' : 'hidden'}
            title="Marks every question with a correct answer to compare with, Right or Wrong"><i class="fa-solid fa-wand-magic-sparkles"></i> Autograde</button>
          <button class="btn-sm btn-green" type="button" id="grading-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
          ${next ? `<button class="btn-sm" type="button" id="grading-save-next" title="Save, then grade ${x(subName(next))} (Ctrl+Enter)">Save and next <i class="fa-solid fa-chevron-right"></i></button>` : ''}
          </span>
        </div>
        <div class="grading-body" id="exam-grade-body">
          <dl class="grading-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
          ${chips.length > 1 ? `<nav class="gq-index" aria-label="Questions">${chips.join('')}</nav>` : ''}
          <div class="grading-questions">${items || '<p class="builder-empty">This exam has no questions.</p>'}</div>
          <section class="gq gq-feedback"><label class="gq-title" for="grading-feedback">Feedback to the student</label>
            <textarea id="grading-feedback" rows="3"></textarea></section>
        </div>
      </section>`;
    const page = document.getElementById('grading-page');
    // Saved grades
    const g = sub.grades || {};
    document.getElementById('grading-feedback').value = g.feedback || '';
    if (paper && Number.isFinite(parseFloat(g.totalScore))) {
      const total = parseFloat(g.totalScore), available = parseFloat(g.maxScore) || base;
      document.getElementById('points-q-total').value = Math.round(total / available * base * 100) / 100;
      setGradeStatus('total', statusOfPoints(document.getElementById('points-q-total').value, base));
    }
    for (const [qId, qGrade] of Object.entries(g.questionGrades || {})) {
      const n = parseInt(qId.slice(2), 10);
      const points = document.getElementById(`points-q-${n}`);
      if (!points) continue;
      if (qGrade.points !== '' && qGrade.points != null) points.value = qGrade.points;
      document.getElementById(`comment-q-${n}`).value = qGrade.comment || '';
      setGradeStatus(n, points.value === '' ? 'ungraded' : qGrade.status || statusOfPoints(points.value, questionMaxPoints(questions[n - 1])));
    }
    page.onclick = onGradingClick;
    page.oninput = e => {
      if (!e.target.matches('[data-grade-points]')) return;
      const item = e.target.closest('[data-q]');
      const max = parseFloat(item.dataset.max);
      const problem = pointsProblem(e.target.value, max);
      e.target.classList.toggle('field-error', !!problem);
      setGradeStatus(item.dataset.q, problem ? 'ungraded' : statusOfPoints(e.target.value, max));
      updateGradingTotal();
    };
    document.getElementById('grading-auto').onclick = () => {
      const n = autogradeAll();
      const skipped = questions.filter((q, i) => canAutograde(q) && answers[`ans-${i + 1}`] === UNCONFIRMED).length;
      const left = skipped ? `${skipped} not confirmed in time ${skipped === 1 ? 'is' : 'are'} left for you` : '';
      toast(n ? `Autograded ${n} question${n === 1 ? '' : 's'}${left ? `; ${left}` : '; check the rest by hand'}`
        : left ? `Nothing autograded: ${left}` : 'Nothing left to autograde: the others are graded by hand or already have points', n ? 'ok' : '');
    };
    document.getElementById('grading-clear').onclick = () => clearGrading(exam, sub);
    document.getElementById('grading-download').onclick = () => downloadReport(exam, sub);
    document.getElementById('grading-save').onclick = () => saveGrades();
    if (next) document.getElementById('grading-save-next').onclick = () => saveGrades(next.id);
    document.getElementById('grading-back').onclick = () => leaveGradingPage();
    updateGradingTotal();
    _grading.snapshot = gradingSnapshot();
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => { main.style.minHeight = ''; });
  }

  // Clear: no points, comments or feedback (asked first), saved at once.
  async function clearGrading(exam, sub) {
    if (!(await confirmDialog(`Clear the grading of ${subName(sub)}? Every point, comment and the feedback is removed.`,
      { title: 'Clear Grading', okLabel: 'Clear', danger: true, okIcon: 'fa-eraser' }))) return;
    try {
      await rpc('exam_save_grades', { p_submission_id: sub.id, p_grades: null, p_status: 'submitted' });
      toast('Grading cleared', 'ok');
      await refreshAfterChange(exam.id);
      openGrading(examById(exam.id) || exam, EX.submissions.find(s => s.id === sub.id) || { ...sub, grades: null, status: 'submitted' });
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  // This submission as a graded exam (PDF), from its saved grades: saved first when changed.
  async function downloadReport(exam, sub) {
    if (gradingChanged()) {
      if (!(await confirmDialog('Save the points and comments first? The report shows the saved grading.',
        { title: 'Unsaved Changes', okLabel: 'Save', okIcon: 'fa-floppy-disk' }))) return;
      if (!(await saveGrades(null, { leave: false }))) return;
      sub = EX.submissions.find(s => s.id === sub.id) || sub;
    }
    try {
      const doc = await newPdf();
      writeReport(doc, examById(exam.id) || exam, sub);
      savePdf(doc, `${slug(examTitle(exam))}_${slug(sub.exam_code || `${shownNo(sub.student_no)}_${sub.student_name}`, true)}.pdf`);
    } catch (error) {
      toast('Download failed: ' + error.message, 'err');
    }
  }

  // Leaving the page (Back, another course, another tab of the editor, Settings) with points or
  // comments not saved: Save (then go), Discard, or stay. True when it can go.
  async function confirmLeaveGrading() {
    if (!_grading || !gradingChanged()) return true;
    const choice = await confirmDialog('The points and comments you entered are not saved yet.',
      { title: 'Unsaved Changes', okLabel: 'Save', okIcon: 'fa-floppy-disk', altLabel: 'Discard' });
    if (choice === true) return saveGrades(null, { leave: false });
    return choice === 'alt';
  }

  // Back to the grades list (or the Students tab it was opened from), as Settings goes back to
  // its course; the list shows the student just graded, highlighted.
  async function leaveGradingPage(confirmed = false) {
    if (!confirmed && !(await confirmLeaveGrading())) return;
    const sub = _grading?.sub;
    _grading = null;
    if (_gradingFrom === 'students') {
      _gradingFrom = 'exams';
      EX.view = 'list';
      S.section = 'students';
      _studentFocus = EX.data.students.find(s => studentKey(s) === sub?.student_no)?.id || null;
    } else {
      EX.view = 'submissions';
      S.section = 'exams';
      EX.focusRow = sub?.id || null;
    }
    lockHeight(document.getElementById('main-area'));
    renderCourseShell(EX.course, EX.isArchive);
  }

  // Alt+← and Alt+→: the previous and next submission; Ctrl+Enter: Save and next (or Save).
  document.addEventListener('keydown', e => {
    if (!onGradingPage() || document.querySelector('.modal-overlay.open')) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const btn = document.querySelectorAll('.grading-steps .grading-step')[e.key === 'ArrowLeft' ? 0 : 1];
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      (document.getElementById('grading-save-next') || document.getElementById('grading-save'))?.click();
    }
  });

  // The Students tab's grade: that student's submission, on the grading page; Back returns there.
  async function openGradingFromBook(examId, studentId) {
    const exam = examById(examId), student = EX.data.students.find(s => s.id === studentId);
    if (!exam || !student) return;
    try {
      const [subs, attempts] = await Promise.all([rpc('exam_submissions', { p_exam_id: examId }),
        rpc('exam_attempts', { p_exam_id: examId }).catch(() => []), loadImages(exam)]);
      Object.assign(EX, { submissions: subs, attempts: attempts || [], examId, subFilter: 'all', subQuery: '', subSort: null });
      _rosterSel.clear();
    } catch (error) {
      return toast(error.message, 'err');
    }
    const sub = EX.submissions.find(s => !s.exam_code && s.student_no === studentKey(student));
    if (!sub) return toast(`${student.full_name || 'This student'} has no submission for ${examTitle(exam)} yet`);
    _gradingFrom = 'students';
    openGrading(exam, sub);
  }

  // At the deadline, the exam page sends this instead of an answer the student had not
  // confirmed: what they had typed or chosen is not sent. A file is uploaded as soon as it is
  // chosen, though, so an unconfirmed file is still there to see.
  const UNCONFIRMED = '[NOT CONFIRMED]';
  const UNCONFIRMED_TEXT = 'Not sent: not confirmed before time ran out';

  function studentAnswerHtml(answer, type, sub, n) {
    if (type === 'attachment') return fileAnswerHtml(answer, sub, n);
    if (answer === UNCONFIRMED) return `<em>${UNCONFIRMED_TEXT}</em>`;
    if (answer == null || answer === '') return '<em>No answer</em>';
    const text = String(answer);
    if (type === 'code') return `<div class="code-container"><button type="button" class="copy-btn" data-copy>Copy</button><pre class="code-snippet">${xh(text)}</pre></div>`;
    if (type === 'long_answer') return `<div class="text-container"><button type="button" class="copy-btn" data-copy>Copy</button><div class="long-answer-content">${xh(text)}</div></div>`;
    return xh(text);
  }

  // An uploaded file, to download: the one the student confirmed, or the last one they
  // uploaded when time ran out first (said under it, for you to decide whether it counts).
  function fileAnswerHtml(answer, sub, n) {
    const file = sub ? answerFile(sub, n) : null;
    if (file) {
      return `<div class="answer-file"><i class="fa-solid fa-file-arrow-down" aria-hidden="true"></i>
        <span class="answer-file-name">${x(file.name)} <span class="exam-muted">${x(formatBytes(file.size))}</span></span>
        <button type="button" class="btn-sm btn-secondary" data-file-download="${x(file.path)}" data-file-name="${x(file.name)}">Download</button></div>
        ${answer === UNCONFIRMED ? '<p class="answer-file-note">Uploaded, but not confirmed before time ran out.</p>' : ''}`;
    }
    if (answer?.name) return `<em>${x(answer.name)}: the file has been deleted</em>`;
    if (typeof answer === 'string' && answer.startsWith('FILE_UPLOADED:')) return `<em>File (name only):</em> ${x(answer.slice(14))}`;
    return answer === UNCONFIRMED ? `<em>${UNCONFIRMED_TEXT}, and no file uploaded</em>` : '<em>No file uploaded</em>';
  }

  // A question's status shows in its head; Right or Wrong shows as pressed when it applies.
  const STATUS_LABELS = { correct: 'Right', incorrect: 'Wrong', partial: 'Partly right', ungraded: 'Not graded' };
  function setGradeStatus(n, status) {
    const item = document.getElementById(`grading-q-${n}`);
    if (!item) return;
    item.dataset.status = STATUS_LABELS[status] ? status : 'ungraded';
    item.querySelector('.gq-status').textContent = STATUS_LABELS[item.dataset.status];
    item.querySelectorAll('[data-grade]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.grade === item.dataset.status)));
    const chip = document.querySelector(`#exam-grade-body [data-jump="${n}"]`);
    if (chip) {
      chip.dataset.status = item.dataset.status;
      chip.title = `${item.querySelector('.gq-title').textContent}: ${STATUS_LABELS[item.dataset.status]}`;
    }
  }

  // What is wrong with points typed for a question, if anything.
  function pointsProblem(raw, max) {
    if (String(raw ?? '').trim() === '') return '';
    const points = parseFloat(raw);
    if (!Number.isFinite(points)) return 'the points are not a number';
    if (points < 0) return 'the points are 0 or more';
    return points > max ? `the points are ${fmt(max)} at most` : '';
  }

  // Previous and Next: another submission on the same page, once unsaved points are saved or
  // let go.
  async function gradeAnother(id) {
    const sub = EX.submissions.find(s => s.id === id);
    if (!sub || !_grading) return;
    if (!(await confirmLeaveGrading())) return;
    openGrading(examById(_grading.exam.id) || _grading.exam, EX.submissions.find(s => s.id === id) || sub);
  }

  // From the points alone: none yet, none, all, or some.
  function statusOfPoints(raw, max) {
    if (String(raw ?? '').trim() === '') return 'ungraded';
    const points = parseFloat(raw);
    return points <= 0 && max > 0 ? 'incorrect' : points >= max ? 'correct' : 'partial';
  }

  async function onGradingClick(e) {
    const download = e.target.closest('[data-file-download]');
    if (download) return downloadUpload(download);
    const image = e.target.closest('.grading-images img');
    if (image) return openImage(image.src);
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const text = copy.parentElement.querySelector('.code-snippet, .long-answer-content').textContent;
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); } catch { }
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (jump) return document.getElementById(`grading-q-${jump.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const nav = e.target.closest('[data-nav]');
    if (nav) return gradeAnother(nav.dataset.nav);
    const btn = e.target.closest('[data-grade]');
    const item = btn?.closest('[data-q]');
    if (!item) return;
    markQuestion(parseInt(item.dataset.q, 10), parseFloat(item.dataset.max), btn.dataset.grade === 'correct');
  }

  function markQuestion(n, max, correct) {
    const input = document.getElementById(`points-q-${n}`);
    input.value = correct ? max : 0;
    input.classList.remove('field-error');
    setGradeStatus(n, correct ? 'correct' : 'incorrect');
    updateGradingTotal();
  }

  // Questions that have a right answer (or a model answer) to compare with. Files and code are
  // graded by hand.
  function canAutograde(q) {
    return (q?.type === 'multiple_select' && q.correct_answers?.length > 0) || (q?.type === 'true_false' && typeof q.answer === 'boolean') ||
      (q?.type === 'short_answer' && q.accepted_answers?.length > 0) || (q?.type === 'numeric' && q.answer != null) ||
      (q?.type === 'long_answer' && typeof q.answer === 'string' && !!q.answer.trim());
  }

  // The right answer, for the grader.
  function answerKey(q) {
    if (q.type === 'multiple_select' && q.correct_answers?.length) return { label: 'Correct answer', html: q.correct_answers.map(x).join('<br>') };
    if (q.type === 'true_false' && typeof q.answer === 'boolean') return { label: 'Correct answer', html: q.answer ? 'True' : 'False' };
    if (q.type === 'short_answer' && q.accepted_answers?.length) return { label: 'Accepted answers', html: q.accepted_answers.map(x).join('<br>') };
    if (q.type === 'numeric' && q.answer != null) return { label: 'Correct answer', html: x(`${exact(q.answer)}${q.tolerance ? ` ± ${exact(q.tolerance)}` : ''}${q.unit ? ` ${q.unit}` : ''}`) };
    if (q.type === 'long_answer' && typeof q.answer === 'string' && q.answer.trim()) return { label: 'Model answer', html: xh(q.answer) };
    return null;
  }

  const normalAnswer = text => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

  // Multiple choice: right when the chosen option is a correct one (its original position, when
  // recorded, survives the per-student shuffle). Short answer: one of the accepted answers,
  // ignoring capitals and spaces. Numeric: within the tolerance (a unit or comma is fine).
  // Whether question n's answer is right, or null when there is nothing to compare with. An
  // answer not confirmed in time is left for the grader: it was never sent.
  function autoCheck(q, answers, n) {
    const given = answers[`ans-${n}`];
    if (!canAutograde(q) || given === UNCONFIRMED) return null;
    if (q.type === 'multiple_select') {
      const index = answers[`ans-${n}_metadata`]?.originalIndex;
      const chosen = index != null && q.options?.[index] != null ? q.options[index] : given;
      return q.correct_answers.includes(String(chosen ?? ''));
    }
    if (q.type === 'true_false') return String(given ?? '').toLowerCase() === String(q.answer);
    if (q.type === 'short_answer') return shortAnswerCheck(q, given).right;
    if (q.type === 'long_answer') return null; // not right or wrong: points by how much it covers
    const value = num(String(given ?? '').match(/-?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:e[-+]?\d+)?/i)?.[0]);
    return value != null && Math.abs(value - q.answer) <= (q.tolerance || 0) + 1e-9 * Math.max(1, Math.abs(q.answer));
  }

  // Short answers: an accepted answer, ignoring capitals, spaces, accents and punctuation; a
  // number compared as a number; a slip of one letter (two in long answers) still counts, with a
  // comment saying so.
  const plainWords = text => normalAnswer(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s.,:/-]/gu, ' ').replace(/[.,:;]+$/, '').replace(/\s+/g, ' ').trim();
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  }
  function shortAnswerCheck(q, given) {
    const answer = plainWords(given);
    if (!answer) return { right: false };
    for (const accepted of q.accepted_answers || []) {
      const key = plainWords(accepted);
      if (key === answer) return { right: true };
      if (/^-?[\d.,]+$/.test(key) && /^-?[\d.,]+$/.test(answer)) {
        if (num(key) != null && num(key) === num(answer)) return { right: true };
        continue;
      }
      const slip = key.length >= 12 ? 2 : key.length >= 5 ? 1 : 0;
      if (slip && editDistance(key, answer) <= slip) return { right: true, comment: `Accepted: close to "${accepted}".` };
    }
    return { right: false };
  }

  // Paragraphs with a model answer: points by how many of its key words the answer has (most:
  // full points, few: none, in half points between), and the model answer as the comment. An
  // estimate: the page marks it for you to check.
  const STOP_WORDS = new Set(('a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those '
    + 'there their they them he she his her we our you your not no so than then which who whom what when where why how can could would should '
    + 'may might must do does did have has had will shall also into onto over under about between because while each such more most less very').split(' '));
  const stemOf = word => (word.length > 4 ? word.replace(/(ingly|edly|ing|ed|es|ly|s|e)$/, '') : word);
  const keyWordsOf = text => [...new Set(plainWords(text).split(/[\s,.:/-]+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)).map(stemOf))];
  function modelAnswerPoints(q, given) {
    const keys = keyWordsOf(q.answer);
    if (!keys.length) return null;
    const words = new Set(keyWordsOf(given));
    const covered = keys.filter(k => words.has(k)).length / keys.length;
    const share = Math.min(1, Math.max(0, (covered - 0.15) / 0.6));
    return Math.round(share * questionMaxPoints(q) * 2) / 2;
  }

  // Question n's autograde: its points, status and comment, or null when it is graded by hand
  // (no answer key) or its answer was not confirmed in time (never sent).
  function autoGrade(q, answers, n) {
    const given = answers[`ans-${n}`];
    if (!canAutograde(q) || given === UNCONFIRMED) return null;
    const max = questionMaxPoints(q);
    if (q.type === 'long_answer') {
      const points = given == null || !String(given).trim() ? 0 : modelAnswerPoints(q, given);
      if (points == null) return null;
      return { points, status: statusOfPoints(points, max), comment: `Model answer: ${q.answer}`, estimate: true };
    }
    const check = q.type === 'short_answer' ? shortAnswerCheck(q, given) : { right: autoCheck(q, answers, n) };
    return { points: check.right ? max : 0, status: check.right ? 'correct' : 'incorrect', comment: check.comment || '' };
  }

  // The grading page's Autograde: only questions with no points yet; points you gave stay.
  function autogradeAll() {
    let count = 0;
    _grading.exam.questions.forEach((q, i) => {
      const n = i + 1;
      const input = document.getElementById(`points-q-${n}`);
      if (!input || input.value.trim() !== '') return;
      const result = autoGrade(q, _grading.sub.answers || {}, n);
      if (!result) return;
      input.value = result.points;
      input.classList.remove('field-error');
      setGradeStatus(n, result.status);
      const comment = document.getElementById(`comment-q-${n}`);
      if (comment && !comment.value.trim() && result.comment) comment.value = result.comment;
      document.getElementById(`grading-q-${n}`)?.classList.toggle('is-estimate', !!result.estimate);
      count++;
    });
    updateGradingTotal();
    return count;
  }

  // The same for a whole submission (the grades list's Autograde): its new grades, or null when
  // nothing more could be graded.
  function autogradeSubmission(exam, sub) {
    const questions = exam.questions || [];
    const old = sub.grades?.questionGrades || {};
    const questionGrades = {};
    let changed = 0, total = 0, complete = questions.length > 0;
    questions.forEach((q, i) => {
      const n = i + 1, key = `q-${n}`;
      if (q.type === 'text_only') { questionGrades[key] = { points: '', status: 'confirmed', comment: '' }; return; }
      let grade = old[key] ? { ...old[key] } : { points: '', status: 'ungraded', comment: '' };
      if (grade.points === '' || grade.points == null) {
        const result = autoGrade(q, sub.answers || {}, n);
        if (result) {
          grade = { points: result.points, status: result.status, comment: grade.comment || result.comment || '' };
          changed++;
        }
      }
      if (grade.points === '' || grade.points == null) complete = false;
      else total += parseFloat(grade.points) || 0;
      questionGrades[key] = grade;
    });
    if (!changed) return null;
    const max = totalPoints(questions);
    return {
      changed, status: complete ? 'graded' : 'submitted',
      grades: { ...(sub.grades || {}), totalScore: total.toFixed(1), maxScore: max, percentage: `${(max > 0 ? total / max * 100 : 0).toFixed(1)}%`,
        gradedAt: new Date().toISOString(), gradedBy: S.access?.email || '', questionGrades },
    };
  }

  function updateGradingTotal() {
    let total = 0;
    // Points out of range count once corrected (Save asks for that).
    document.querySelectorAll('#exam-grade-body [data-grade-points]:not(.field-error)').forEach(input => { total += parseFloat(input.value) || 0; });
    const questions = _grading.exam.questions || [];
    const max = questions.length ? totalPoints(questions) : parseFloat(_grading.exam.base) || 100;
    document.getElementById('grading-total').textContent = fmt(total);
    document.getElementById('grading-base').textContent = fmt(max > 0 ? total / max * (parseFloat(_grading.exam.base) || 100) : 0);
    return { total, max };
  }

  // Graded once every question has points; partial grading and comments are kept either way.
  // nextId: the submission to grade next, on the same page; else back to the grades list
  // (unless leave is false: the caller goes on). True once saved.
  async function saveGrades(nextId = null, { leave = true } = {}) {
    if (!_grading) return true;
    const { exam, sub } = _grading;
    const questions = exam.questions || [];
    for (const input of document.querySelectorAll('#exam-grade-body [data-grade-points]')) {
      const item = input.closest('[data-q]');
      const problem = pointsProblem(input.value, parseFloat(item.dataset.max));
      if (!problem) continue;
      input.classList.add('field-error');
      toast(`${item.querySelector('.gq-title').textContent}: ${problem}.`, 'err');
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus({ preventScroll: true });
      return false;
    }
    const { total, max } = updateGradingTotal();
    const questionGrades = {};
    let allFilled = questions.length > 0 || document.getElementById('points-q-total')?.value.trim() !== '';
    questions.forEach((q, i) => {
      const n = i + 1;
      if (q.type === 'text_only') { questionGrades[`q-${n}`] = { points: '', status: 'confirmed', comment: '' }; return; }
      const raw = document.getElementById(`points-q-${n}`).value.trim();
      if (raw === '') allFilled = false;
      const marked = document.getElementById(`grading-q-${n}`).dataset.status;
      questionGrades[`q-${n}`] = {
        points: raw === '' ? '' : parseFloat(raw),
        status: raw === '' ? 'ungraded' : marked !== 'ungraded' ? marked : statusOfPoints(raw, questionMaxPoints(q)),
        comment: document.getElementById(`comment-q-${n}`).value.trim(),
      };
    });
    const grades = {
      totalScore: total.toFixed(1), maxScore: max,
      percentage: `${(max > 0 ? total / max * 100 : 0).toFixed(1)}%`,
      feedback: document.getElementById('grading-feedback').value.trim(),
      gradedAt: new Date().toISOString(), gradedBy: S.access?.email || '',
      questionGrades,
    };
    const buttons = document.querySelectorAll('#grading-save, #grading-save-next');
    buttons.forEach(b => { b.disabled = true; });
    try {
      await rpc('exam_save_grades', { p_submission_id: sub.id, p_grades: grades, p_status: allFilled ? 'graded' : 'submitted' });
      toast(allFilled ? 'Graded' : 'Saved; some questions still have no points', 'ok');
      _grading.snapshot = gradingSnapshot();
      await refreshAfterChange(exam.id);
      if (!leave || !onGradingPage()) return true;
      // On to the next one on the same page, or back to the list.
      const next = nextId && EX.submissions.find(s => s.id === nextId);
      if (next) openGrading(examById(exam.id) || exam, next);
      else await leaveGradingPage(true);
      return true;
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
      return false;
    } finally {
      buttons.forEach(b => { b.disabled = false; });
    }
  }


  // ── Grades for EIS: in the order EIS lists them ──
  function showEisGrades(exam) {
    const anonymous = exam.sign_in === 'anonymous';
    const byKey = new Map(EX.submissions.map(s => [anonymous ? s.exam_code : s.student_no, s]));
    const keys = anonymous ? EX.data.codes : EX.data.students.map(studentKey);
    const names = new Map(EX.data.students.map(s => [studentKey(s), s.full_name]));
    const rows = keys.map(key => {
      const s = byKey.get(key);
      const grade = s?.status === 'graded' && s.grades ? eisGrade(s.grades, exam.base) : '';
      return { key, name: names.get(key) || '', grade };
    });
    const missing = keys.length ? '' : `<p class="exam-error">Paste the ${anonymous ? 'exam IDs' : 'class list'} on the Students tab first: EIS's order comes from there.</p>`;
    const ov = overlay('exam-eis', { wide: false });
    ov.title(`Grades for EIS: ${examTitle(exam)}`);
    ov.body.innerHTML = `${missing}
      <p class="form-hint">Grades on the exam's base of ${fmt(exam.base)}, rounded to whole numbers, in the same order as the ${anonymous ? 'exam IDs' : 'class list'} you pasted. Ungraded or missing submissions are left blank.</p>
      <div class="data-table-container eis-table"><table class="data-table"><thead><tr><th>#</th><th>${anonymous ? 'Exam ID' : 'Student'}</th><th>Grade</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td>${i + 1}.</td><td>${x(anonymous ? r.key : `${r.name} (${r.key})`)}</td><td><strong>${x(r.grade)}</strong></td></tr>`).join('')}</tbody></table></div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-secondary" type="button" data-eis-copy="both"><i class="fa-solid fa-copy" style="margin-right:5px"></i>Copy ${anonymous ? 'IDs' : 'students'} and grades</button>
      <button class="btn-sm" type="button" data-eis-copy="grades"><i class="fa-solid fa-copy" style="margin-right:5px"></i>Copy grade column</button>`;
    ov.foot.onclick = async e => {
      const which = e.target.closest('[data-eis-copy]')?.dataset.eisCopy;
      if (!which) return;
      const text = rows.map(r => which === 'grades' ? r.grade : `${r.key}\t${r.grade}`).join('\n');
      try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch { toast('Could not copy', 'err'); }
    };
    ov.open();
  }

  function eisGrade(grades, base) {
    const total = parseFloat(grades.totalScore), max = parseFloat(grades.maxScore), scale = parseFloat(base) || 100;
    if (!Number.isFinite(total)) return '';
    return String(Math.round(Number.isFinite(max) && max > 0 ? total / max * scale : total));
  }


  // ── PDF and ZIP exports (libraries load on first use) ──
  const LIBS = {
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js',
    jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  };
  const _scripts = {};
  function loadScript(src) {
    return _scripts[src] || (_scripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => { delete _scripts[src]; reject(new Error('Could not load the export library.')); };
      document.head.appendChild(s);
    }));
  }
  async function newPdf() {
    await loadScript(LIBS.jspdf);
    await loadScript(LIBS.autotable);
    return new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  }
  function courseHeading() {
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    return [header.code || EX.course, header.title].filter(Boolean).join(': ');
  }
  // Exam IDs keep their case: EIS codes such as "aAauC" and "AAauc" are different students.
  const slug = (text, keepCase = false) => {
    const s = String(text || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
    return keepCase ? s : s.toLowerCase();
  };
  function savePdf(doc, name) {
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(120, 120, 120);
      doc.text(`Page ${i} of ${pages}`, 105, 290, { align: 'center' });
    }
    doc.save(name);
  }

  // Writes wrapped text, starting a new page when it runs past the bottom margin.
  function writer(doc) {
    const state = { y: 15 };
    state.write = (text, { x: left = 15, size = 10, style = 'normal', color = [33, 33, 33], gap = 1.5 } = {}) => {
      doc.setFontSize(size); doc.setFont(undefined, style); doc.setTextColor(...color);
      const lineHeight = size * 0.45;
      for (const line of doc.splitTextToSize(String(text), 180 - (left - 15))) {
        if (state.y + lineHeight > 280) { doc.addPage(); state.y = 15; }
        doc.text(line, left, state.y);
        state.y += lineHeight;
      }
      state.y += gap;
    };
    return state;
  }

  async function exportQuestionsPdf(exam) {
    try {
      const doc = await newPdf();
      const w = writer(doc);
      w.write(courseHeading(), { size: 10, color: [90, 90, 90] });
      w.write(examTitle(exam), { size: 15, style: 'bold' });
      w.write([typeLabel(exam.type), exam.starts_at && formatWhen(exam.starts_at), exam.duration_minutes && `${exam.duration_minutes} min`,
        exam.hall, exam.weight != null && `${fmt(exam.weight)}% of grade`, `base ${fmt(exam.base)}`,
        exam.shuffle_questions === false ? 'fixed order' : 'shuffled order'].filter(Boolean).join('   |   '), { size: 9, color: [100, 100, 100], gap: 4 });
      let number = 0;
      (exam.questions || []).forEach(q => {
        const isText = q.type === 'text_only';
        if (!isText) number++;
        const meta = [QUESTION_TYPES[q.type]?.label || q.type];
        if (!isText) meta.push(`${fmt(questionMaxPoints(q))} pt`);
        if (q.language) meta.push(`language: ${q.language}`);
        if (q.allowed_types?.length) meta.push(`allowed: ${q.allowed_types.join(', ')}`);
        if (q.max_size_mb) meta.push(`max ${q.max_size_mb} MB`);
        w.write(`${isText ? 'Information' : `Question ${number}`}  (${meta.join(', ')})`, { style: 'bold', color: [57, 73, 171], gap: 1 });
        w.write(formatQuestionText.plain(q.prompt), { x: 18 });
        if (q.content) w.write(`Starting text: ${q.content}`, { x: 18, size: 9, style: 'italic', color: [90, 90, 90] });
        if (q.type === 'multiple_select') (q.options || []).forEach(option => {
          const right = (q.correct_answers || []).includes(option);
          w.write(`${right ? '[correct]' : '-'} ${option}`, { x: 21, size: 9, style: right ? 'bold' : 'normal', color: right ? [6, 95, 70] : [33, 33, 33], gap: 0.5 });
        });
        const key = q.type === 'multiple_select' ? null : answerKey(q);
        if (key) w.write(`${key.label}: ${key.html.replace(/<br>/g, ' or ').replace(/&[^;]+;/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m] || m))}`,
          { x: 18, size: 9, style: 'bold', color: [6, 95, 70] });
        if (q.explanation) w.write(`Explanation: ${q.explanation}`, { x: 18, size: 9, style: 'italic', color: [90, 90, 90] });
        w.y += 3;
      });
      savePdf(doc, `${slug(EX.course)}_${slug(examTitle(exam))}_questions.pdf`);
    } catch (error) {
      toast('Export failed: ' + error.message, 'err');
    }
  }

  async function submissionPdfBlob(exam, sub) {
    const doc = await newPdf();
    writeReport(doc, exam, sub);
    return doc.output('blob');
  }

  // A graded exam as a report (A4, from the current page on): the course and exam; the student,
  // when it came in and the grade; a table of each question's points; then each question with
  // the answer, the right answer, the points and your comment; your feedback; who graded it.
  function writeReport(doc, exam, sub) {
    const w = writer(doc);
    const questions = exam.questions || [];
    const grades = sub.grades || {};
    const graded = Number.isFinite(parseFloat(grades.totalScore));
    const plainHtml = html => String(html).replace(/<br>/g, ' or ').replace(/<[^>]+>/g, '')
      .replace(/&[^;]+;/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m] || m));
    w.write(courseHeading(), { size: 9, color: [110, 110, 110], gap: 0.5 });
    w.write(examTitle(exam), { size: 16, style: 'bold', gap: 0.5 });
    w.write([typeLabel(exam.type), exam.starts_at && (settingsOf(exam).date_only ? formatDate(exam.starts_at) : formatWhen(exam.starts_at)),
      exam.hall, exam.weight != null && `${fmt(exam.weight)}% of the course grade`].filter(Boolean).join('   ·   '), { size: 9, color: [110, 110, 110], gap: 4 });
    // The student and the grade, side by side in a box.
    const top = w.y;
    doc.setDrawColor(220, 222, 230); doc.setFillColor(247, 248, 252);
    doc.roundedRect(15, top, 180, 24, 2, 2, 'FD');
    doc.setFontSize(12); doc.setFont(undefined, 'bold'); doc.setTextColor(33, 33, 33);
    doc.text(sub.exam_code ? `Exam ID ${sub.exam_code}` : (sub.student_name || ''), 20, top + 8);
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(100, 100, 100);
    doc.text([sub.exam_code ? '' : [shownNo(sub.student_no), sub.student_email].filter(Boolean).join('   ·   '),
      sub.source === 'manual' ? 'No submission: grade entered by hand'
        : `Submitted ${formatWhen(sub.submitted_at)}${sub.late ? ', late' : ''}${sub.auto_submitted ? ', when time ran out' : ''}${sub.source === 'imported' ? ', from the backup file' : ''}`]
      .filter(Boolean), 20, top + 14);
    doc.setFontSize(9); doc.setTextColor(110, 110, 110);
    doc.text('GRADE', 190, top + 7, { align: 'right' });
    doc.setFontSize(18); doc.setFont(undefined, 'bold'); doc.setTextColor(graded ? 6 : 150, graded ? 95 : 150, graded ? 70 : 150);
    doc.text(graded ? gradeOnBase(grades, exam.base) : 'Not graded', 190, top + 15, { align: 'right' });
    if (graded && questions.length) {
      doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(110, 110, 110);
      doc.text(`${fmt(grades.totalScore)} of ${fmt(grades.maxScore)} points`, 190, top + 20.5, { align: 'right' });
    }
    w.y = top + 30;
    // Each question's points.
    const rows = [];
    let number = 0;
    questions.forEach((q, i) => {
      if (q.type === 'text_only') return;
      const g = grades.questionGrades?.[`q-${i + 1}`] || {};
      const has = g.points !== '' && g.points != null;
      rows.push([`Question ${++number}`, QUESTION_TYPES[q.type]?.label || q.type, has ? fmt(g.points) : '', fmt(questionMaxPoints(q)), has ? (STATUS_LABELS[g.status] || '') : 'Not graded']);
    });
    if (rows.length) {
      doc.autoTable({
        startY: w.y, head: [['', 'Type', 'Points', 'Of', '']], body: rows, theme: 'plain',
        styles: { fontSize: 9, cellPadding: 1.8, textColor: [40, 40, 40] },
        headStyles: { fontStyle: 'bold', textColor: [110, 110, 110], lineWidth: { bottom: 0.3 }, lineColor: [210, 210, 215] },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 }, 2: { halign: 'right', cellWidth: 18 }, 3: { halign: 'right', cellWidth: 14 }, 4: { cellWidth: 28 } },
        margin: { left: 15, right: 15 },
      });
      w.y = doc.lastAutoTable.finalY + 6;
    }
    // Each question in full.
    number = 0;
    questions.forEach((q, i) => {
      const n = i + 1;
      if (q.type === 'text_only') {
        if (q.prompt) w.write(formatQuestionText.plain(q.prompt), { size: 9, style: 'italic', color: [110, 110, 110], gap: 2 });
        return;
      }
      number++;
      const g = grades.questionGrades?.[`q-${n}`] || {};
      const has = g.points !== '' && g.points != null;
      if (w.y > 255) { doc.addPage(); w.y = 15; }
      w.write(`Question ${number}${has ? `   ${fmt(g.points)} / ${fmt(questionMaxPoints(q))}` : `   (${fmt(questionMaxPoints(q))} points)`}`, { style: 'bold', color: [57, 73, 171], gap: 1 });
      w.write(formatQuestionText.plain(q.prompt), { x: 18, size: 9.5, gap: 1.5 });
      if (q.type === 'multiple_select') (q.options || []).forEach((option, k) => w.write(`${String.fromCharCode(97 + k)})  ${option}`, { x: 21, size: 9, color: [80, 80, 80], gap: 0.3 }));
      const given = sub.answers?.[`ans-${n}`];
      const answer = q.type === 'attachment' ? fileAnswerText(sub, n) : given === UNCONFIRMED ? UNCONFIRMED_TEXT : given;
      w.write(`Answer: ${answer == null || answer === '' ? 'No answer' : String(answer)}`, { x: 18, size: 9.5, gap: 1 });
      const key = answerKey(q);
      if (key) w.write(`${key.label}: ${plainHtml(key.html)}`, { x: 18, size: 9, color: [6, 95, 70], gap: 1 });
      if (g.comment) w.write(`Comment: ${g.comment}`, { x: 18, size: 9, style: 'italic', color: [90, 90, 90], gap: 1 });
      w.y += 3;
    });
    if (grades.feedback) {
      w.write('Feedback', { size: 11, style: 'bold', gap: 1 });
      w.write(grades.feedback, { size: 9.5 });
    }
    if (grades.gradedAt) w.write(`Graded${grades.gradedBy ? ` by ${grades.gradedBy}` : ''} on ${formatWhen(grades.gradedAt)}`, { size: 8, color: [140, 140, 140] });
  }

  // Graded exams as one PDF, a student from each page.
  async function exportReportsPdf(exam, subs) {
    if (!subs.length) return toast('No graded exams to download');
    try {
      const doc = await newPdf();
      subs.forEach((sub, i) => {
        if (i) doc.addPage();
        writeReport(doc, exam, sub);
      });
      savePdf(doc, `${slug(EX.course)}_${slug(examTitle(exam))}_graded.pdf`);
    } catch (error) {
      toast('Export failed: ' + error.message, 'err');
    }
  }

  // A file answer in the submission's PDF.
  function fileAnswerText(sub, n) {
    const file = answerFile(sub, n);
    const given = sub.answers?.[`ans-${n}`];
    if (file) return `File: ${file.name} (${formatBytes(file.size)}), in the ZIP${given === UNCONFIRMED ? '; uploaded, but not confirmed before time ran out' : ''}`;
    return given?.name ? 'File deleted' : given === UNCONFIRMED ? UNCONFIRMED_TEXT : '';
  }

  // A PDF per submission, and beside it the files the student uploaded, named by question.
  async function exportSubmissionsZip(exam) {
    const subs = sortedSubmissions(exam, true).filter(s => s.source !== 'manual');
    if (!subs.length) return;
    const questions = exam.questions || [];
    const fileQuestions = questions.map((q, i) => (q.type === 'attachment' ? i + 1 : 0)).filter(Boolean);
    const numberOf = n => questions.slice(0, n).filter(q => q.type !== 'text_only').length;
    try {
      toast(`Preparing ${subs.length} submission${subs.length === 1 ? '' : 's'}${exam.file_count ? ' and their files' : ''}…`);
      await loadScript(LIBS.jszip);
      const zip = new window.JSZip();
      const failed = [];
      for (const sub of subs) {
        const base = `${slug(examTitle(exam))}_${slug(sub.exam_code || `${sub.student_no}_${sub.student_name}`, true)}`;
        zip.file(`${base}.pdf`, await submissionPdfBlob(exam, sub));
        for (const n of fileQuestions) {
          const file = answerFile(sub, n);
          if (!file) continue;
          try { zip.file(`${base}_Q${numberOf(n)}_${file.name.replace(/[\\/:*?"<>|]+/g, '_')}`, await downloadBlob(file.path)); }
          catch { failed.push(file.name); }
        }
      }
      saveBlob(await zip.generateAsync({ type: 'blob' }), `${slug(EX.course)}_${slug(examTitle(exam))}_submissions.zip`);
      if (failed.length) toast(`Exported, but ${failed.length} file${failed.length === 1 ? '' : 's'} could not be downloaded: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''}`, 'err');
      else toast('Submissions exported', 'ok');
    } catch (error) {
      toast('Export failed: ' + error.message, 'err');
    }
  }

  async function exportGradesPdf(exam) {
    const anonymous = exam.sign_in === 'anonymous';
    const graded = sortedSubmissions(exam, true).filter(s => s.status === 'graded' && s.grades);
    try {
      const doc = await newPdf();
      const w = writer(doc);
      w.write(courseHeading(), { size: 11, color: [90, 90, 90] });
      w.write(`${examTitle(exam)}: grades`, { size: 15, style: 'bold' });
      w.write(`${typeLabel(exam.type)}${exam.starts_at ? `, ${formatWhen(exam.starts_at)}` : ''}, base ${fmt(exam.base)}${exam.weight != null ? `, ${fmt(exam.weight)}% of grade` : ''}, generated ${new Date().toLocaleDateString('en-GB')}`, { size: 9, color: [100, 100, 100], gap: 4 });
      doc.autoTable({
        startY: w.y,
        head: [anonymous ? ['Exam ID', 'Points', 'Max', 'Grade'] : ['Student', 'Student ID', 'Points', 'Max', 'Grade']],
        body: graded.map(s => anonymous
          ? [s.exam_code, s.grades.totalScore, s.grades.maxScore, gradeOnBase(s.grades, exam.base)]
          : [s.student_name, shownNo(s.student_no), s.grades.totalScore, s.grades.maxScore, gradeOnBase(s.grades, exam.base)]),
        theme: 'grid', styles: { fontSize: 10, cellPadding: 3 },
        headStyles: { fillColor: [57, 73, 171], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 246, 250] },
      });
      savePdf(doc, `${slug(EX.course)}_${slug(examTitle(exam))}_grades.pdf`);
    } catch (error) {
      toast('Export failed: ' + error.message, 'err');
    }
  }


  // ════════════════════════════════════════════════════════════════════════
  // Students tab
  // ════════════════════════════════════════════════════════════════════════

  // The class list as a grade book: a row per student with their grade in each of the course's
  // named exams and the weighted total, in a table that scrolls sideways. A student's name opens
  // their record: details to edit, and their grades in this and other courses. Exam IDs are a
  // list of their own: they are never matched to students (anonymous exams). Add takes a paste
  // from EIS and recognises a class list or an exam's grade list (exam IDs).
  let _pastedStudents = [];   // Parsed in the Add dialog, not saved yet
  let _pastedCodes = [];
  const _selected = new Set(); // Selected student ids
  let _anchor = null;          // Where a Shift-click range starts
  const STUDENTS_PER_PAGE = 50;
  let _studentPage = 0;        // The page of the list on screen, from 0
  let _studentQuery = '';      // The search, lowercased
  let _bookSort = null;        // { key: 'name' | 'programme' | 'total' | an exam's id, dir }
  let _studentFocus = null;    // The student to show (back from their grading page)

  async function loadStudentsSection() {
    const course = S.course, isArchive = S.isArchive;
    const body = document.getElementById('section-body');
    try {
      const [, book] = await Promise.all([loadCourse(course, isArchive),
        rpc('exam_gradebook', { p_sheet: course, p_archive: isArchive }).catch(() => [])]);
      EX.gradebook = book || [];
    } catch (error) {
      if (!isStale(course, isArchive, 'students')) sectionError(body, error);
      return;
    }
    if (isStale(course, isArchive, 'students')) return;
    _studentQuery = '';
    // Back from a student's grading page: the page of the list they are on; else the first.
    const focus = _studentFocus;
    _studentFocus = null;
    const at = focus ? matchingStudents().findIndex(s => s.id === focus) : -1;
    _studentPage = at >= 0 ? Math.floor(at / STUDENTS_PER_PAGE) : 0;
    const ids = new Set(EX.data.students.map(s => s.id));
    [..._selected].forEach(id => { if (!ids.has(id)) _selected.delete(id); });
    renderStudents(body);
    finishSectionLoad(body);
    // After the view-only lock: anyone who sees the list can search it, page through it, open a
    // record and switch to the exam IDs.
    renderStudentPage();
    body.querySelectorAll('#students-search, [data-st-view-btn], [data-st="csv"], [data-book-sort], [data-book-exam]').forEach(el => { el.disabled = false; });
    const back = focus && document.querySelector(`#student-rows tr[data-student-id="${CSS.escape(focus)}"]`);
    if (back) flashRow(back);
  }

  // The course's named exams, as the grade book's columns (anonymous ones are never matched).
  const bookExams = () => EX.data.exams.filter(e => signInOf(e) !== 'anonymous')
    .sort((a, b) => (Date.parse(a.starts_at) || Infinity) - (Date.parse(b.starts_at) || Infinity));
  const bookIndex = () => new Map((EX.gradebook || []).filter(r => !r.exam_code).map(r => [`${r.exam_id}|${r.student_no}`, r]));

  // A student's grade in an exam on its base, or how far it got.
  function bookEntry(index, exam, s) {
    const r = index.get(`${exam.id}|${studentKey(s)}`);
    if (!r) return { kind: 'none' };
    const total = parseFloat(r.total), max = parseFloat(r.max), base = parseFloat(exam.base) || 100;
    if (r.status !== 'graded' || !Number.isFinite(total)) return { kind: r.source === 'manual' ? 'none' : 'pending' };
    return { kind: 'graded', grade: max > 0 ? total / max * base : total, base, manual: r.source === 'manual' };
  }

  // What the graded exams add up to: each grade's share of its weight.
  function bookTotal(index, exams, s) {
    let sum = 0, weight = 0;
    for (const exam of exams) {
      const w = parseFloat(exam.weight);
      if (!Number.isFinite(w) || w <= 0) continue;
      weight += w;
      const entry = bookEntry(index, exam, s);
      if (entry.kind === 'graded') sum += entry.grade / entry.base * w;
    }
    return { sum, weight };
  }

  function renderStudents(body) {
    const { students, codes } = EX.data;
    const manage = canManage();
    const exams = bookExams();
    const anonymousExams = EX.data.exams.filter(e => signInOf(e) === 'anonymous');
    const view = EX.studentsView === 'codes' ? 'codes' : 'students';
    const weight = exams.reduce((n, e) => n + (parseFloat(e.weight) > 0 ? parseFloat(e.weight) : 0), 0);
    body.innerHTML = `
      <div class="section-topbar" data-no-dirty>
        <span class="exam-topbar-note"><i class="fa-solid fa-users" aria-hidden="true"></i><strong>${students.length}</strong> student${students.length === 1 ? '' : 's'}, <strong>${codes.length}</strong> exam ID${codes.length === 1 ? '' : 's'}</span>
        <div class="add-bar">
          <button type="button" class="btn-sm btn-secondary" data-st="csv" ${students.length ? '' : 'disabled'} title="The list with every grade, for Excel"><i class="fa-solid fa-file-csv"></i> Download</button>
          ${manage ? '<button type="button" class="btn-sm btn-green" data-st="add"><i class="fa-solid fa-plus"></i> Add</button>' : ''}
        </div>
      </div>
      ${archivedNote()}
      <div class="st-views" role="tablist" aria-label="Show" data-view="${view}" data-no-dirty>
        <button type="button" role="tab" data-st-view-btn="students" aria-selected="${view === 'students'}"><i class="fa-solid fa-users"></i>Students<span>${students.length}</span></button>
        <button type="button" role="tab" data-st-view-btn="codes" aria-selected="${view === 'codes'}"><i class="fa-solid fa-user-secret"></i>Exam IDs<span>${codes.length}</span></button>
      </div>

      <section class="st-view" data-st-view="students" ${view === 'students' ? '' : 'hidden'} data-no-dirty>
        ${students.length ? `
        <div class="student-toolbar">
          <input type="search" class="classlist-search" id="students-search" placeholder="Search name, ID, email, programme or note" aria-label="Search students">
          <span class="student-selection" id="student-selection" aria-live="polite"></span>
          ${manage ? `<span class="student-toolbar-actions">
            <button type="button" class="btn-sm btn-secondary" data-sel="edit" disabled><i class="fa-solid fa-pen-to-square"></i>Programme</button>
            <button type="button" class="btn-sm btn-red" data-sel="delete" disabled><i class="fa-solid fa-trash"></i>Remove</button>
          </span>` : ''}
        </div>
        ${anonymousExams.length ? `<p class="form-hint st-anon-note"><i class="fa-solid fa-user-secret" aria-hidden="true"></i>
          <span>${anonymousExams.map(e => x(examTitle(e))).join(', ')} ${anonymousExams.length === 1 ? 'uses' : 'use'} exam IDs: those grades are never matched to students (see ${anonymousExams.length === 1 ? 'its' : 'their'} Grades page${anonymousExams.length === 1 ? '' : 's'}).</span></p>` : ''}
        <div class="data-table-container gradebook-wrap">
          <table class="data-table gradebook">
            <thead><tr>
              <th class="select-cell gb-sticky gb-sticky-1"><input type="checkbox" id="students-check-all" aria-label="Select all students"></th>
            ${bookHeadCellsHtml(exams, weight)}
            </tr></thead>
            <tbody id="student-rows"></tbody>
          </table>
        </div>
        <nav class="student-pager" id="student-pager" aria-label="Students pages" hidden></nav>
        <p class="form-hint student-tip">A name opens the student's record, and a grade its submission. A column's head sorts the list. Click a row to select it; Ctrl or Shift selects several, Ctrl+A all of them.</p>`
        : `<div class="empty-content">No students yet.${manage ? ' Add the class list from EIS with <strong>Add</strong>.' : ''}</div>`}
      </section>

      <section class="st-view" data-st-view="codes" ${view === 'codes' ? '' : 'hidden'} data-no-dirty>
        <p class="form-hint">Exam IDs sign students in to anonymous exams (midterm and final), in the order EIS lists them. They change every semester and are never linked to a student.${manage ? ' To replace them, paste the exam\'s grade list from EIS with <strong>Add</strong>.' : ''}</p>
        ${codes.length ? `<div class="code-grid" id="code-list">${codes.map((c, i) => `<span class="code-chip"><span>${i + 1}.</span>${x(c)}${manage
          ? `<button type="button" class="code-edit" data-code-index="${i}" title="Edit ${x(c)}" aria-label="Edit exam ID ${x(c)}"><i class="fa-solid fa-pen"></i></button>` : ''}</span>`).join('')}</div>`
          : '<div class="empty-content">No exam IDs yet.</div>'}
      </section>`;
    body.onclick = onStudentsClick;
    body.onchange = body.oninput = body.onkeydown = body.onpaste = body.ondragover = body.ondragleave = body.ondrop = null;
    document.getElementById('students-search')?.addEventListener('input', filterStudents);
    const rows = document.getElementById('student-rows');
    if (rows) {
      rows.addEventListener('mousedown', e => { if (e.shiftKey && !e.target.closest('input')) e.preventDefault(); }); // no text selection
      rows.addEventListener('click', onStudentRowClick);
      document.getElementById('students-check-all').addEventListener('change', e => selectAll(e.target.checked));
      body.querySelector('.student-toolbar').addEventListener('click', onStudentToolbar);
      document.getElementById('student-pager').addEventListener('click', onStudentPager);
    }
  }

  // The grade book's heads: each sorts the list (# goes back to the class list's order).
  function bookHeadCellsHtml(exams, weight) {
    const sort = _bookSort, head = (key, label) => sortHeadHtml('data-book-sort', key, label, sort);
    return `<th class="gb-n">${head('', '#')}</th>
              <th class="gb-sticky gb-sticky-2 gb-name"${ariaSort(sort, 'name')}>${head('name', 'Student')}</th>
              <th class="gb-prog"${ariaSort(sort, 'programme')}>${head('programme', 'Programme')}</th>
              ${exams.map(e => `<th class="gb-exam"${ariaSort(sort, e.id)} title="${x(examTitle(e))}${e.starts_at ? `, ${x(formatWhen(e.starts_at))}` : ''}">${head(e.id,
                `<span class="gb-exam-name">${x(examTitle(e))}</span><span class="gb-exam-weight">${e.weight != null ? `${fmt(e.weight)}%` : 'no weight'}</span>`)}</th>`).join('')}
              ${weight ? `<th class="gb-total"${ariaSort(sort, 'total')} title="The graded exams' share of their weights">${head('total', `Total<span class="gb-exam-weight">of ${fmt(weight)}%</span>`)}</th>` : ''}`;
  }

  const BOOK_SORTS = {
    name: s => (s.full_name || s.email || '').toLowerCase(),
    programme: s => (s.programme || '').toLowerCase() || null,
    total: s => bookTotal(bookIndex(), bookExams(), s).sum,
  };
  function sortStudents(list) {
    if (!_bookSort) return list;
    if (BOOK_SORTS[_bookSort.key]) return sortRows(list, _bookSort, BOOK_SORTS);
    const exam = examById(_bookSort.key), index = bookIndex();
    if (!exam) return list;
    return sortRows(list, _bookSort, { [_bookSort.key]: s => {
      const entry = bookEntry(index, exam, s);
      return entry.kind === 'graded' ? entry.grade / entry.base : entry.kind === 'pending' ? -1 : null;
    } });
  }

  function onStudentsClick(e) {
    if (S.section !== 'students') return;
    const sortBtn = e.target.closest('[data-book-sort]');
    if (sortBtn) {
      _bookSort = nextSort(_bookSort, sortBtn.dataset.bookSort);
      const row = sortBtn.closest('tr');
      const exams = bookExams();
      row.innerHTML = `<th class="select-cell gb-sticky gb-sticky-1"><input type="checkbox" id="students-check-all" aria-label="Select all students"></th>${bookHeadCellsHtml(exams, exams.reduce((n, ex) => n + (parseFloat(ex.weight) > 0 ? parseFloat(ex.weight) : 0), 0))}`;
      document.getElementById('students-check-all').addEventListener('change', ev => selectAll(ev.target.checked));
      _studentPage = 0;
      return renderStudentPage();
    }
    const cell = e.target.closest('[data-book-exam]');
    if (cell) return openGradingFromBook(cell.dataset.bookExam, cell.closest('tr[data-student-id]').dataset.studentId);
    const viewBtn = e.target.closest('[data-st-view-btn]');
    if (viewBtn) {
      EX.studentsView = viewBtn.dataset.stViewBtn;
      document.querySelectorAll('[data-st-view-btn]').forEach(b => b.setAttribute('aria-selected', String(b === viewBtn)));
      viewBtn.closest('.st-views').dataset.view = EX.studentsView;
      document.querySelectorAll('[data-st-view]').forEach(v => { v.hidden = v.dataset.stView !== EX.studentsView; });
      return;
    }
    const code = e.target.closest('[data-code-index]');
    if (code) return editCode(Number(code.dataset.codeIndex));
    const action = e.target.closest('[data-st]')?.dataset.st;
    if (action === 'add') return openAddDialog();
    if (action === 'csv') return downloadGradebook();
  }

  // ── The list, a page at a time ──
  const studentSearchText = s => [s.student_no, s.full_name, s.email, s.programme, s.note].join(' ').toLowerCase();
  const matchingStudents = () => sortStudents(_studentQuery ? EX.data.students.filter(s => studentSearchText(s).includes(_studentQuery)) : EX.data.students);

  function renderStudentPage() {
    const rows = document.getElementById('student-rows');
    if (!rows) return;
    const list = matchingStudents();
    const pages = Math.max(1, Math.ceil(list.length / STUDENTS_PER_PAGE));
    _studentPage = Math.min(Math.max(_studentPage, 0), pages - 1);
    const start = _studentPage * STUDENTS_PER_PAGE;
    const shown = list.slice(start, start + STUDENTS_PER_PAGE);
    const exams = bookExams(), index = bookIndex();
    const weight = exams.some(e => parseFloat(e.weight) > 0);
    // Each student keeps their number in the whole list, also when searching.
    rows.innerHTML = shown.length ? shown.map(s => studentRowHtml(s, EX.data.students.indexOf(s), exams, index, weight)).join('')
      : `<tr class="student-none"><td class="table-message" colspan="${4 + exams.length + (weight ? 1 : 0)}">No students match “${x(_studentQuery)}”.</td></tr>`;
    const pager = document.getElementById('student-pager');
    pager.hidden = pages < 2;
    pager.innerHTML = pages < 2 ? '' : `
      <span class="student-pager-range">${start + 1}–${start + shown.length} of ${list.length}</span>
      <span class="student-pager-pages">
        <button type="button" class="btn-sm btn-secondary pager-step" data-step="-1" aria-label="Previous page" ${_studentPage ? '' : 'disabled'}><i class="fa-solid fa-chevron-left"></i></button>
        ${pageNumbers(_studentPage, pages).map(p => p == null ? '<span class="pager-gap" aria-hidden="true">…</span>'
          : `<button type="button" class="pager-num" data-page="${p}" aria-label="Page ${p + 1}"${p === _studentPage ? ' aria-current="page"' : ''}>${p + 1}</button>`).join('')}
        <button type="button" class="btn-sm btn-secondary pager-step" data-step="1" aria-label="Next page" ${_studentPage < pages - 1 ? '' : 'disabled'}><i class="fa-solid fa-chevron-right"></i></button>
      </span>`;
    updateSelection();
  }

  // Seven places at most, so the buttons stay put: every page when they fit, else the first,
  // the last and those around the current one.
  function pageNumbers(current, count) {
    if (count <= 7) return [...Array(count).keys()];
    if (current < 4) return [0, 1, 2, 3, 4, null, count - 1];
    if (current > count - 5) return [0, null, count - 5, count - 4, count - 3, count - 2, count - 1];
    return [0, null, current - 1, current, current + 1, null, count - 1];
  }

  // The pager stays where it was on screen, though the last page may be shorter, and keeps
  // the keyboard focus.
  function onStudentPager(e) {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const pager = e.currentTarget;
    const top = pager.getBoundingClientRect().top;
    _studentPage = btn.dataset.step ? _studentPage + Number(btn.dataset.step) : Number(btn.dataset.page);
    renderStudentPage();
    window.scrollBy(0, pager.getBoundingClientRect().top - top);
    const again = btn.dataset.step && pager.querySelector(`[data-step="${btn.dataset.step}"]:not(:disabled)`);
    (again || pager.querySelector('[aria-current="page"]'))?.focus({ preventScroll: true });
  }

  // A grade (or To grade) opens that submission on the grading page.
  function bookCellHtml(entry, exam) {
    if (entry.kind === 'none') return '<span class="gb-none" title="No submission">—</span>';
    const open = `type="button" class="gb-cell" data-book-exam="${x(exam.id)}"`;
    if (entry.kind === 'pending') return `<button ${open} title="Submitted, not graded yet: grade it"><span class="gb-pending">To grade</span></button>`;
    return `<button ${open} title="${entry.manual ? 'Entered without a submission. ' : ''}Open on the grading page"><span class="gb-grade${entry.manual ? ' is-manual' : ''}">${fmt(entry.grade)}</span></button>`;
  }

  function studentRowHtml(s, i, exams, index, withTotal) {
    const total = withTotal ? bookTotal(index, exams, s) : null;
    return `<tr data-student-id="${x(s.id)}">
      <td class="select-cell gb-sticky gb-sticky-1"><input type="checkbox" class="row-check" aria-label="Select ${x(s.full_name || s.student_no)}"></td>
      <td class="gb-n">${i + 1}</td>
      <td class="gb-sticky gb-sticky-2 gb-name"><span class="gb-who" title="${x([s.full_name, s.student_no, s.email].filter(Boolean).join(' · '))}">
        <button type="button" class="gb-open" data-open-student>${x(s.full_name || s.email)}</button>${s.student_no ? `<span class="gb-id">${x(s.student_no)}</span>` : ''}${s.note ? `<span class="badge exam-badge-note" title="Note">${x(s.note)}</span>` : ''}</span></td>
      <td class="gb-prog">${x(s.programme)}</td>
      ${exams.map(e => `<td class="gb-exam">${bookCellHtml(bookEntry(index, e, s), e)}</td>`).join('')}
      ${total ? `<td class="gb-total"><strong>${fmt(total.sum)}</strong></td>` : ''}
    </tr>`;
  }

  // The list with every grade, for Excel (UTF-8, so names keep their letters).
  function downloadGradebook() {
    const exams = bookExams(), index = bookIndex();
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Student ID', 'Name', 'Email', 'Programme', 'Note', ...exams.map(e => `${examTitle(e)}${e.weight != null ? ` (${fmt(e.weight)}%)` : ''}`), 'Total'];
    const rows = EX.data.students.map(s => {
      const grades = exams.map(e => { const entry = bookEntry(index, e, s); return entry.kind === 'graded' ? fmt(entry.grade) : ''; });
      return [s.student_no, s.full_name, s.email, s.programme, s.note, ...grades, fmt(bookTotal(index, exams, s).sum)];
    });
    const csv = '﻿' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${slug(EX.course)}_students.csv`);
  }

  // ── Selecting students ──
  // Select all, Ctrl+A and Shift ranges take every student the search finds, on every page.
  const matchingIds = () => matchingStudents().map(s => s.id);
  const selectedStudents = () => EX.data.students.filter(s => _selected.has(s.id));

  function updateSelection() {
    if (!document.getElementById('student-rows')) return;
    document.querySelectorAll('#student-rows tr[data-student-id]').forEach(tr => {
      const on = _selected.has(tr.dataset.studentId);
      tr.classList.toggle('is-selected', on);
      tr.setAttribute('aria-selected', String(on));
      tr.querySelector('.row-check').checked = on;
    });
    const ids = matchingIds();
    const all = ids.length > 0 && ids.every(id => _selected.has(id));
    const checkAll = document.getElementById('students-check-all');
    checkAll.checked = all;
    checkAll.indeterminate = !all && ids.some(id => _selected.has(id));
    const n = _selected.size;
    document.getElementById('student-selection').textContent = n ? `${n} selected` : '';
    document.querySelectorAll('[data-sel="edit"], [data-sel="delete"]').forEach(b => { b.disabled = !n; });
  }

  function selectAll(on = true) {
    if (on) matchingIds().forEach(id => _selected.add(id));
    else _selected.clear();
    updateSelection();
  }

  // A name opens the record. Elsewhere a click selects that row only; Ctrl/Cmd or the checkbox
  // toggles it; Shift selects the range from the last clicked row.
  function onStudentRowClick(e) {
    const tr = e.target.closest('tr[data-student-id]');
    if (!tr || e.target.closest('a')) return;
    const id = tr.dataset.studentId;
    if (e.target.closest('[data-open-student]')) return openStudentRecord(EX.data.students.find(s => s.id === id));
    const viaCheck = !!e.target.closest('.row-check');
    if (e.shiftKey && _anchor) {
      const rows = matchingIds();
      const [a, b] = [rows.indexOf(_anchor), rows.indexOf(id)].sort((p, q) => p - q);
      if (a >= 0) {
        if (!(e.ctrlKey || e.metaKey || viaCheck)) _selected.clear();
        rows.slice(a, b + 1).forEach(r => _selected.add(r));
        updateSelection();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || viaCheck) {
      if (_selected.has(id)) _selected.delete(id); else _selected.add(id);
    } else if (_selected.size === 1 && _selected.has(id)) {
      _selected.clear();
    } else {
      _selected.clear();
      _selected.add(id);
    }
    _anchor = id;
    updateSelection();
  }

  function filterStudents(e) {
    _studentQuery = e.target.value.trim().toLowerCase();
    _studentPage = 0;
    const found = new Set(matchingIds());
    [..._selected].forEach(id => { if (!found.has(id)) _selected.delete(id); }); // act only on what the search finds
    renderStudentPage();
  }

  function onStudentToolbar(e) {
    const action = e.target.closest('[data-sel]')?.dataset.sel;
    if (action === 'edit') editSelected();
    else if (action === 'delete') deleteSelected();
  }

  // Ctrl/Cmd+A selects every student once one is selected; Escape clears; Delete removes.
  document.addEventListener('keydown', e => {
    if (S.section !== 'students' || !_selected.size || !document.getElementById('student-rows')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('.modal-overlay.open')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(true); }
    else if (e.key === 'Escape') { _selected.clear(); updateSelection(); }
    else if (e.key === 'Delete' && canManage()) { e.preventDefault(); deleteSelected(); }
  });

  async function deleteSelected(chosen = selectedStudents()) {
    if (!chosen.length || !requirePermission(canManage())) return false;
    const who = chosen.length === 1 ? (chosen[0].full_name || chosen[0].student_no) : `${chosen.length} students`;
    if (!(await confirmDialog(`Remove ${who} from the list? Their submissions and grades are kept.`,
      { title: chosen.length === 1 ? 'Remove Student' : 'Remove Students', okLabel: 'Remove', danger: true, okIcon: 'fa-trash-can' }))) return false;
    try {
      await rpc('exam_save_students', { p_sheet: EX.course, p_archive: EX.isArchive, p_students: [], p_remove: chosen.map(s => s.id) });
      chosen.forEach(s => _selected.delete(s.id));
      toast(chosen.length === 1 ? 'Student removed' : `${chosen.length} students removed`, 'ok');
      await reloadStudentsKeepingPlace();
      return true;
    } catch (error) {
      toast(error.message, 'err');
      return false;
    }
  }

  const editSelected = () => editStudents(selectedStudents());

  // Saves the whole list, so everyone keeps their place in it; ids make these edits, not a paste.
  async function saveStudentChanges(ids, changes, extra = []) {
    const list = EX.data.students.map(({ id, student_no, full_name, email, programme, exam_code, note }) =>
      ({ id, student_no, full_name, email, programme, exam_code, note, ...(ids.has(id) ? changes : {}) }));
    await rpc('exam_save_students', { p_sheet: EX.course, p_archive: EX.isArchive, p_students: [...list, ...extra], p_remove: [] });
  }

  // The fields of one student, checked as the server will: a name, a valid email, and an email
  // and student ID nobody else on the list has.
  function studentFieldsHtml(s = {}) {
    const field = (id, label, value, extra = '') => `<div class="form-group"><label class="form-label" for="${id}">${label}</label>
      <input type="text" id="${id}" value="${x(value || '')}" autocomplete="off" ${extra}></div>`;
    return `<div class="sg-grid">${field('student-f-name', 'Name', s.full_name)}
      ${field('student-f-email', 'Email', s.email, 'inputmode="email" spellcheck="false"')}
      ${field('student-f-no', 'Student ID', s.student_no, 'inputmode="numeric"')}
      ${field('student-f-programme', 'Programme', s.programme)}</div>
      <div class="form-group"><label class="form-label" for="student-f-note">Note <span class="label-note">only you see it</span></label>
        <input type="text" id="student-f-note" value="${x(s.note || '')}" autocomplete="off"></div>`;
  }

  function readStudentFields(current = null) {
    const val = id => document.getElementById(id)?.value.trim() ?? '';
    const changes = { full_name: val('student-f-name'), email: val('student-f-email').toLowerCase(), student_no: val('student-f-no'),
      programme: val('student-f-programme'), note: val('student-f-note') };
    const others = EX.data.students.filter(s => s.id !== current?.id);
    if (!changes.full_name) return { problem: 'Enter the name' };
    if (!EMAIL_RE.test(changes.email)) return { problem: 'Enter a valid email' };
    if (others.some(s => s.email === changes.email)) return { problem: 'Another student has this email' };
    if (changes.student_no && others.some(s => s.student_no === changes.student_no)) return { problem: 'Another student has this student ID' };
    return { changes };
  }

  // Several students: their programme. (One student is edited in their record.)
  function editStudents(chosen) {
    chosen = chosen.filter(Boolean);
    if (!chosen.length || !requirePermission(canManage())) return;
    if (chosen.length === 1) return openStudentRecord(chosen[0]);
    const programmes = [...new Set(chosen.map(s => s.programme || ''))];
    const ov = overlay('student-edit', { wide: false });
    ov.title(`Programme of ${chosen.length} students`);
    ov.body.innerHTML = `<p>${chosen.slice(0, 6).map(s => x(s.full_name || s.student_no)).join(', ')}${chosen.length > 6 ? `, and ${chosen.length - 6} more` : ''}.</p>
      <div class="form-group"><label class="form-label" for="student-f-programme">Programme</label>
        <input type="text" id="student-f-programme" value="${programmes.length === 1 ? x(programmes[0]) : ''}"
          placeholder="${programmes.length > 1 ? 'Different for each: type one for all of them' : ''}"></div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-green" type="button" id="student-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>`;
    const save = async () => {
      const programme = document.getElementById('student-f-programme').value.trim();
      if (!programme && programmes.length > 1) { toast('Type the programme to give them all', 'err'); return; }
      const btn = document.getElementById('student-edit-save');
      btn.disabled = true;
      try {
        await saveStudentChanges(new Set(chosen.map(s => s.id)), { programme });
        ov.close();
        toast(`${chosen.length} students saved`, 'ok');
        await reloadStudentsKeepingPlace();
      } catch (error) {
        toast('Save failed: ' + error.message, 'err');
      } finally {
        btn.disabled = false;
      }
    };
    document.getElementById('student-edit-save').onclick = save;
    ov.body.onkeydown = e => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); save(); } };
    ov.open();
    setTimeout(() => ov.body.querySelector('input')?.focus(), 60);
  }

  // A student's record: their details (to edit), their grades in this course's named exams,
  // and in the other courses they took that you can see (exam_student_record). Anonymous
  // exams are never matched to a student, so they are not here. student null: a new student.
  function openStudentRecord(student = null) {
    const manage = canManage();
    const ov = overlay('student-record', { wide: true });
    ov.title(student ? student.full_name || student.email : 'New student');
    ov.body.innerHTML = `
      <section class="record-section"><h4 class="exam-edit-head"><i class="fa-solid fa-id-card" aria-hidden="true"></i>Details</h4>${studentFieldsHtml(student || {})}</section>
      ${student ? `<section class="record-section"><h4 class="exam-edit-head"><i class="fa-solid fa-chart-simple" aria-hidden="true"></i>Grades</h4>
        <div id="record-grades"><div class="skeleton skeleton-card"></div></div>
        <p class="form-hint">Grades of every course you can see, matched by this student's email and student ID. Exams taken with an exam ID are anonymous, so they are never listed here.</p></section>` : ''}`;
    ov.foot.innerHTML = `${student && manage ? '<button class="btn-sm btn-red foot-start" type="button" id="record-remove"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Remove from the list</button>' : ''}
      ${manage ? `<button class="btn-sm btn-green" type="button" id="record-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>${student ? 'Save' : 'Add student'}</button>` : ''}`;
    if (!manage) ov.body.querySelectorAll('input').forEach(i => { i.disabled = true; });
    const save = async () => {
      const { changes, problem } = readStudentFields(student);
      if (problem) { toast(problem, 'err'); return; }
      const btn = document.getElementById('record-save');
      btn.disabled = true;
      try {
        if (student) await saveStudentChanges(new Set([student.id]), changes);
        else await saveStudentChanges(new Set(), {}, [changes]);
        ov.close();
        toast(student ? 'Student saved' : 'Student added', 'ok');
        await reloadStudentsKeepingPlace();
      } catch (error) {
        toast('Save failed: ' + error.message, 'err');
      } finally {
        btn.disabled = false;
      }
    };
    document.getElementById('record-save')?.addEventListener('click', save);
    document.getElementById('record-remove')?.addEventListener('click', async () => { if (await deleteSelected([student])) ov.close(); });
    ov.body.onkeydown = e => { if (e.key === 'Enter' && e.target.matches('input') && manage) { e.preventDefault(); save(); } };
    ov.open();
    if (!student) setTimeout(() => document.getElementById('student-f-name')?.focus(), 60);
    if (student) loadStudentRecord(student);
  }

  async function loadStudentRecord(student) {
    const box = document.getElementById('record-grades');
    let record;
    try {
      record = await rpc('exam_student_record', { p_student: student.id });
    } catch (error) {
      if (box) box.innerHTML = `<p class="exam-error">The grades could not be loaded: ${x(error.message)}</p>`;
      return;
    }
    if (!box?.isConnected) return;
    const courses = (record || []).filter(c => c.exams.length || c.current);
    box.innerHTML = courses.length ? courses.map(c => {
      const term = [c.semester, c.year].filter(Boolean).join(' ');
      const rows = c.exams.map(e => {
        const sub = e.submission;
        const total = parseFloat(sub?.total), max = parseFloat(sub?.max), base = parseFloat(e.base) || 100;
        const grade = sub?.status === 'graded' && Number.isFinite(total) ? `<strong>${fmt(max > 0 ? total / max * base : total)}</strong> / ${fmt(base)}`
          : sub && sub.source !== 'manual' ? '<span class="exam-muted">Submitted, not graded</span>' : '<span class="exam-muted">No submission</span>';
        return `<tr><td>${x(e.label || typeLabel(e.type))}</td><td>${e.starts_at ? x(formatShortWhen(e.starts_at)) : ''}</td>
          <td>${e.weight != null ? `${fmt(e.weight)}%` : ''}</td><td>${grade}${sub?.late ? ' <span class="badge exam-badge-late">Late</span>' : ''}</td></tr>`;
      }).join('');
      return `<div class="record-course${c.current ? ' is-current' : ''}">
        <div class="record-course-head"><strong>${x(c.code || c.sheet_name)}</strong> ${x(c.title || '')}
          <span class="exam-muted">${x(term)}${c.archived ? ', archived' : ''}${c.current ? ', this course' : ''}</span></div>
        ${rows ? `<div class="data-table-container"><table class="data-table"><thead><tr><th>Exam</th><th>Date</th><th>Weight</th><th>Grade</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<p class="exam-muted">No named exams.</p>'}
      </div>`;
    }).join('') : '<p class="exam-muted">No grades yet.</p>';
  }

  // One exam ID in the list: change or remove it. The list is saved at once, in its order.
  function editCode(index) {
    const codes = EX.data.codes;
    const code = codes[index];
    if (code == null || !requirePermission(canManage())) return;
    const ov = overlay('code-edit', { wide: false });
    ov.title(`Exam ID ${index + 1}`);
    ov.body.innerHTML = `<div class="form-group"><label class="form-label" for="code-f-value">Exam ID</label>
      <input type="text" id="code-f-value" value="${x(code)}" autocomplete="off" spellcheck="false"></div>
      <p class="form-hint">Submissions already made with the old ID keep it.</p>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-red foot-start" type="button" id="code-edit-remove"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Remove</button>
      <button class="btn-sm btn-green" type="button" id="code-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>`;
    const saveList = async (list, message) => {
      ov.foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        await rpc('exam_save_codes', { p_sheet: EX.course, p_archive: EX.isArchive, p_codes: list });
        ov.close();
        toast(message, 'ok');
        await reloadStudentsKeepingPlace();
      } catch (error) {
        toast('Save failed: ' + error.message, 'err');
      } finally {
        ov.foot.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    };
    const save = () => {
      const value = document.getElementById('code-f-value').value.trim();
      if (!/^\S{1,32}$/.test(value)) { toast('An exam ID is one word of at most 32 characters', 'err'); return; }
      if (value === code) { ov.close(); return; }
      if (codes.some((c, i) => i !== index && c === value)) { toast('That exam ID is already in the list', 'err'); return; }
      saveList(codes.map((c, i) => i === index ? value : c), 'Exam ID saved');
    };
    document.getElementById('code-edit-save').onclick = save;
    document.getElementById('code-edit-remove').onclick = () => saveList(codes.filter((_, i) => i !== index), `Exam ID ${code} removed`);
    ov.body.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    ov.open();
    setTimeout(() => { const input = document.getElementById('code-f-value'); input.focus(); input.select(); }, 60);
  }

  // After a change, which saves at once: reload, on the same search and page.
  async function reloadStudentsKeepingPlace() {
    const search = document.getElementById('students-search')?.value || '';
    const page = _studentPage;
    lockHeight(document.getElementById('section-body'));
    await loadStudentsSection();
    if (S.section !== 'students') return;
    const box = document.getElementById('students-search');
    if (box && search) box.value = search;
    _studentQuery = search.trim().toLowerCase();
    _studentPage = page;
    renderStudentPage();
  }

  // ── Pasting from EIS ──
  // A student needs a name and an email; the student ID, programme and EIS status are read
  // when there. EIS rows look like "1.  02032407  Albi Kera  akera24@epoka.edu.al  Th: 96.15%
  // P: 80.77%  BA CE"; plain "Albi Kera  akera24@epoka.edu.al" lines work too. From a whole
  // copied page, lines that are not student rows are ignored, and only rows that look like a
  // student but cannot be read are reported. Attendance is dropped.
  function parseClassList(text) {
    const students = [], skipped = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const student = parseStudentLine(raw);
      if (student) students.push(student);
      else if (/^\d+\.\s*\d{5,}\b/.test(line) || (EMAIL_IN_TEXT.test(line) && /\b\d{5,}\b/.test(line))) skipped.push(line);
    }
    return { students, skipped };
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const EMAIL_IN_TEXT = /[^\s@<>(),;:"']+@[^\s@<>(),;:"']+\.[A-Za-z]{2,}/;
  const ATTENDANCE_RE = /\b(?:Th|P):\s*[\d.]+\s*%/gi;
  // EIS appends status to the name ("Armend Paci R EX", "Wiam Ettalhi Termination: 13 Jun
  // 2026"); that goes to the note.
  function parseStudentLine(raw) {
    const line = raw.trim();
    const found = line.match(EMAIL_IN_TEXT);
    if (!found) return null;
    const email = found[0].toLowerCase();
    const tabbed = raw.includes('\t');
    let before, after;
    if (tabbed) {
      const cells = raw.split('\t').map(c => c.trim()).filter(Boolean);
      const at = cells.findIndex(c => c.includes(found[0]));
      const rest = cells[at].replace(found[0], '').replace(/[<>()]/g, '').trim(); // "Name <email>"
      before = cells.slice(0, at).concat(rest ? [rest] : []);
      after = cells.slice(at + 1);
    } else {
      before = [line.slice(0, found.index).replace(/[<(]\s*$/, '').trim()].filter(Boolean);
      after = [line.slice(found.index + found[0].length).replace(/^\s*[>)]/, '').trim()].filter(Boolean);
    }
    // A leading row number ("1.") and student ID, then the name.
    let numbered = false, no = '';
    const words = before.join(' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (/^\d+\.$/.test(words[0] || '')) { words.shift(); numbered = true; }
    if (/^\d{5,}$/.test(words[0] || '')) no = words.shift();
    let name = words.join(' ');
    // Email first, then the name (two columns only): "akera24@epoka.edu.al  Albi Kera".
    if (!name && tabbed && after.length) name = after.shift();
    let note = '';
    const termination = name.match(/\s*(Termination:.*)$/i);
    if (termination) { note = termination[1].trim(); name = name.slice(0, termination.index).trim(); }
    const flags = name.match(/(?:\s+(?:R|EX))+$/);
    if (flags) { note = [flags[0].trim(), note].filter(Boolean).join(', '); name = name.slice(0, flags.index).trim(); }
    // Names have letters, and no digits, '@' or ':'. Without tabs, a row number or an ID to show
    // this is a student row, it takes two words, so a stray "Contact: …" line is not a student.
    if (!/\p{L}/u.test(name) || /[\d@:]/.test(name) || name.length > 80) return null;
    if (!(tabbed || numbered || no) && name.split(' ').length < 2) return null;
    const programme = after.join(' ').replace(ATTENDANCE_RE, '').replace(/\s+/g, ' ').trim();
    return { student_no: no, full_name: name, email, programme, note };
  }

  // A pasted student is someone already on the list: by email first (it keeps their data), else
  // by student ID (an email that changed).
  const matchOf = p => EX.data.students.find(s => s.email === p.email) || EX.data.students.find(s => p.student_no && s.student_no === p.student_no);
  const sameStudent = (s, p) => matchOf(p) === s;
  // What saving the pasted row would change for that student (empty fields keep the stored ones).
  function changesOf(p) {
    const s = matchOf(p);
    if (!s) return [];
    const changes = [];
    const diff = (label, from, to) => { if ((from || '') !== (to || '')) changes.push(`${label}: ${from || 'none'} to ${to || 'none'}`); };
    diff('Name', s.full_name, p.full_name);
    diff('Email', s.email, p.email);
    if (p.student_no) diff('Student ID', s.student_no, p.student_no);
    if (p.programme) diff('Programme', s.programme, p.programme);
    if (p.note) diff('Note', s.note, p.note);
    return changes;
  }

  // ── Add: one paste box for both ──
  // A class list (rows with emails) adds or updates students; an exam's grade list (numbered exam
  // IDs) replaces the exam IDs. What was pasted is recognised as it is typed, and previewed.
  function openAddDialog() {
    if (!requirePermission(canManage())) return;
    _pastedStudents = [];
    _pastedCodes = [];
    const ov = overlay('students-add', { onClose: async () => {
      if (!document.getElementById('add-paste')?.value.trim()) return true;
      return saveOrDiscard('What you pasted is not saved yet.', () => document.getElementById('add-save')?.click());
    } });
    ov.title('Add students or exam IDs');
    ov.body.innerHTML = `
      <div class="form-group"><label class="form-label" for="add-paste">Paste from EIS</label>
        <textarea id="add-paste" class="add-paste" rows="7" spellcheck="false" placeholder="1.&#9;02032407&#9;Albi Kera&#9;akera24@epoka.edu.al&#9;BA CE&#10;or&#10;1.&#9;dCepM&#10;2.&#9;iYBxw"></textarea>
        <p class="form-hint">Copy the class list, or an exam's grade list with its exam IDs, from EIS. The whole page works too (Ctrl+A, Ctrl+C): only the rows are read, and which list it is is recognised. A class list adds students and updates those already here; a grade list replaces the exam IDs.</p></div>
      <div id="add-kind" class="add-kind" aria-live="polite"></div>
      <div id="add-preview" class="paste-preview"></div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-secondary foot-start" type="button" id="add-one"><i class="fa-solid fa-user-plus" style="margin-right:5px"></i>Type one student</button>
      <button class="btn-sm btn-green" type="button" id="add-save" disabled><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>`;
    document.getElementById('add-paste').oninput = previewPaste;
    document.getElementById('add-save').onclick = () => saveAdd(ov);
    document.getElementById('add-one').onclick = () => { ov.close(); openStudentRecord(null); };
    ov.open();
    setTimeout(() => document.getElementById('add-paste').focus(), 60);
  }

  function previewPaste() {
    const text = document.getElementById('add-paste').value;
    const kind = document.getElementById('add-kind');
    const save = document.getElementById('add-save');
    _pastedStudents = [];
    _pastedCodes = [];
    if (!text.trim()) { kind.innerHTML = ''; document.getElementById('add-preview').innerHTML = ''; save.disabled = true; return; }
    const { students } = parseClassList(text);
    if (students.length) {
      kind.innerHTML = '<span class="add-kind-tag"><i class="fa-solid fa-users" aria-hidden="true"></i>A class list</span>';
      previewStudents(text);
    } else {
      const codes = parseCodes(text);
      kind.innerHTML = codes.length ? '<span class="add-kind-tag"><i class="fa-solid fa-user-secret" aria-hidden="true"></i>Exam IDs</span>' : '';
      previewCodes(text);
    }
    save.disabled = !_pastedStudents.length && !_pastedCodes.length;
  }

  function previewStudents(text) {
    const preview = document.getElementById('add-preview');
    const { students, skipped } = parseClassList(text);
    const unique = [...new Map(students.map(s => [s.email, s])).values()];
    _pastedStudents = unique;
    const isExisting = p => !!matchOf(p);
    const added = unique.filter(p => !isExisting(p)).length;
    const missing = unique.length ? EX.data.students.filter(s => !unique.some(p => sameStudent(s, p))) : [];
    preview.innerHTML = `
      <p class="paste-summary"><strong>${unique.length}</strong> student${unique.length === 1 ? '' : 's'} found, ${added} new, ${unique.filter(p => changesOf(p).length).length} to update
        ${skipped.length ? `, <span class="exam-error">${skipped.length} line${skipped.length === 1 ? '' : 's'} not understood</span>` : ''}</p>
      <p class="paste-conflicts exam-error"></p>
      ${missing.length ? `<label class="exam-inline-check"><input type="checkbox" id="classlist-remove-missing">
        Remove the ${missing.length} student${missing.length === 1 ? '' : 's'} not in this paste (${missing.slice(0, 4).map(s => x(s.full_name || s.student_no)).join(', ')}${missing.length > 4 ? ', …' : ''})</label>` : ''}
      <div class="data-table-container"><table class="data-table classlist-table"><thead><tr><th>Student ID</th><th>Name</th><th>Email</th><th>Programme</th><th>Note</th><th></th></tr></thead><tbody>
        ${unique.map(s => `<tr data-email="${x(s.email)}"><td>${x(s.student_no)}</td><td>${x(s.full_name)}</td><td>${x(s.email)}</td>
          <td>${x(s.programme)}</td><td>${s.note ? `<span class="badge exam-badge-note">${x(s.note)}</span>` : ''}</td>
          <td>${!isExisting(s) ? '<span class="badge exam-badge-graded">New</span>' : changesOf(s).length ? '<span class="badge exam-badge-submitted">Update</span>' : '<span class="badge">No change</span>'}
            <div class="paste-issue">${changesOf(s).map(c => `<span class="exam-muted">${x(c)}</span>`).join('<br>')}</div></td></tr>`).join('')}
      </tbody></table></div>
      ${skipped.length ? `<details class="paste-skipped"><summary>Lines not understood</summary><pre>${x(skipped.join('\n'))}</pre></details>` : ''}`;
    checkPaste(unique);
  }

  // The server checks a paste against the other courses: a person keeps one student ID and one
  // email everywhere. Conflicts block the save; a student ID filled in from another course and
  // a name that differs there are shown.
  let _pasteConflicts = 0, _checkSeq = 0;
  async function checkPaste(students) {
    const seq = ++_checkSeq;
    _pasteConflicts = 0;
    if (!students.length) return;
    let issues;
    try {
      issues = await rpc('exam_check_students', { p_sheet: EX.course, p_archive: EX.isArchive,
        p_students: students.map(({ student_no, email, full_name }) => ({ student_no, email, full_name })) });
    } catch { return; } // the save checks again
    if (seq !== _checkSeq) return;
    const byEmail = new Map((issues || []).map(i => [i.email, i]));
    let conflicts = 0;
    document.querySelectorAll('#add-preview tbody tr[data-email]').forEach(tr => {
      const issue = byEmail.get(tr.dataset.email);
      if (!issue) return;
      const notes = [];
      if (issue.conflict) {
        conflicts++;
        tr.classList.add('paste-conflict');
        notes.push(['exam-error', issue.conflict === 'student_id' ? 'This student ID has a different email in another course' : 'This email has a different student ID in another course']);
      }
      if (issue.student_no_elsewhere) {
        const student = students.find(p => p.email === issue.email);
        if (student) student.student_no = issue.student_no_elsewhere;
        tr.children[0].innerHTML = `${x(issue.student_no_elsewhere)} <span class="exam-muted">(from another course)</span>`;
      }
      if (issue.name_elsewhere) notes.push(['exam-muted', `Named ${issue.name_elsewhere} in another course`]);
      const box = tr.querySelector('.paste-issue');
      box.innerHTML = [...notes.map(([cls, text]) => `<span class="${cls}">${x(text)}</span>`), box.innerHTML].filter(Boolean).join('<br>');
    });
    _pasteConflicts = conflicts;
    const summary = document.querySelector('#add-preview .paste-conflicts');
    if (summary) summary.innerHTML = conflicts ? `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${conflicts} student${conflicts === 1 ? ' has' : 's have'} a different student ID or email in another course. A student keeps the same ID and email in every course: correct the paste (or the other course) before saving.` : '';
  }

  // The exam's grade list: "1.  dCepM  67". From a whole copied page, only the numbered rows
  // after the "Exam Code" header are read; without that header, the longest run of rows
  // numbered 1, 2, 3… A plain column of exam IDs, one per line, works too.
  function parseCodes(text) {
    let lines = String(text || '').split(/\r?\n/);
    const header = lines.findIndex(l => /exam\s*code/i.test(l));
    if (header >= 0) lines = lines.slice(header + 1);
    const rows = lines.map(l => l.trim().match(/^(\d+)\.\s*([A-Za-z0-9]{3,16})(?=\s|$)/)).filter(Boolean)
      .map(m => ({ n: Number(m[1]), code: m[2] }));
    let best = [], run = [];
    for (const row of rows) {
      run = row.n === 1 ? [row] : run.length && row.n === run[run.length - 1].n + 1 ? [...run, row] : [];
      if (run.length > best.length) best = run;
    }
    if (best.length) return [...new Set(best.map(r => r.code))];
    const column = lines.map(l => l.trim()).filter(Boolean);
    return column.length && column.every(l => /^[A-Za-z0-9]{3,16}$/.test(l)) ? [...new Set(column)] : [];
  }

  function previewCodes(text) {
    const preview = document.getElementById('add-preview');
    _pastedCodes = text.trim() ? parseCodes(text) : [];
    preview.innerHTML = _pastedCodes.length ? `<p class="paste-summary"><strong>${_pastedCodes.length}</strong> exam ID${_pastedCodes.length === 1 ? '' : 's'} found${EX.data.codes.length ? `; saving replaces the current ${EX.data.codes.length}` : ''}</p>
      <div class="code-grid">${_pastedCodes.map((c, i) => `<span class="code-chip"><span>${i + 1}.</span>${x(c)}</span>`).join('')}</div>`
      : '<p class="paste-summary exam-error">Neither students (each needs a name and an email) nor exam IDs were found in this text.</p>';
  }

  async function saveAdd(ov) {
    if (!requirePermission(canManage())) return;
    const btn = document.getElementById('add-save');
    if (_pastedStudents.length && _pasteConflicts) {
      toast('Some students have a different student ID or email in another course: see the list', 'err');
      document.querySelector('#add-preview .paste-conflicts')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!_pastedStudents.length && !_pastedCodes.length) return;
    // Students already on the list whose details differ: replaced only when asked.
    const replaced = _pastedStudents.filter(p => changesOf(p).length);
    if (replaced.length && !(await confirmDialog(
      `${replaced.length} student${replaced.length === 1 ? ' is' : 's are'} already on the list with different details: ${replaced.slice(0, 5).map(p => matchOf(p).full_name).join(', ')}${replaced.length > 5 ? ', …' : ''}. Update them with the pasted details? Their exams, grades and notes are kept.`,
      { title: 'Update Students', okLabel: 'Update', okIcon: 'fa-arrows-rotate' }))) return;
    if (_pastedCodes.length && EX.data.codes.length &&
      !(await confirmDialog(`Replace the ${EX.data.codes.length} exam IDs with the ${_pastedCodes.length} pasted ones?`, { title: 'Replace Exam IDs', okLabel: 'Replace' }))) return;
    btn.disabled = true;
    try {
      if (_pastedStudents.length) {
        const remove = document.getElementById('classlist-remove-missing')?.checked
          ? EX.data.students.filter(s => !_pastedStudents.some(p => sameStudent(s, p))).map(s => s.id) : [];
        await rpc('exam_save_students', { p_sheet: EX.course, p_archive: EX.isArchive, p_students: _pastedStudents, p_remove: remove });
        EX.studentsView = 'students';
      } else {
        await rpc('exam_save_codes', { p_sheet: EX.course, p_archive: EX.isArchive, p_codes: _pastedCodes });
        EX.studentsView = 'codes';
      }
      toast(_pastedStudents.length ? 'Students saved' : 'Exam IDs saved', 'ok');
      document.getElementById('add-paste').value = '';
      ov.close();
      await reloadStudentsKeepingPlace();
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // The tab saves as it goes (Add, records and exam IDs save at once): Ctrl/Cmd+S has nothing
  // left to do here.
  const saveStudentsSection = async () => true;


  // ════════════════════════════════════════════════════════════════════════
  // After archiving, restoring or deleting a course: its exam data follows
  // ════════════════════════════════════════════════════════════════════════

  // The database functions accept only a real follow-up (the course has moved or is gone) and
  // are safe to repeat, so a failure is kept in this browser and retried the next time an Exams
  // or Students tab opens.
  const PENDING_KEY = 'examPendingFollowUps';
  const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch { return []; } };
  const writePending = list => { try { list.length ? localStorage.setItem(PENDING_KEY, JSON.stringify(list)) : localStorage.removeItem(PENDING_KEY); } catch { } };

  async function tryFollowUp(fn, args, attempts) {
    for (let attempt = 1; ; attempt++) {
      const { error } = await sb.rpc(fn, args);
      if (!error || error.code === 'PGRST202') return null; // done, or no exam functions installed
      if (attempt >= attempts) return error;
      await new Promise(r => setTimeout(r, 600 * attempt));
    }
  }

  async function followUp(fn, args) {
    const error = await tryFollowUp(fn, args, 3);
    if (!error) return true;
    console.error(`${fn} failed:`, error);
    writePending([...readPending(), { fn, args }]);
    toast(`The course's exams and students did not follow yet (${error.message}). This browser retries when you next open an Exams or Students tab.`, 'err');
    return false;
  }

  async function retryPendingFollowUps() {
    const pending = readPending();
    if (!pending.length) return;
    const left = [];
    for (const item of pending) if (await tryFollowUp(item.fn, item.args, 1)) left.push(item);
    writePending(left);
    if (left.length < pending.length) toast('Exam data from an earlier course move is now in place', 'ok');
  }

  const followExamMove = (oldName, fromArchive, newName) =>
    followUp('exam_move_course', { p_name: oldName, p_from_archive: fromArchive, p_new_name: newName });
  const followExamDelete = (name, isArchive) =>
    followUp('exam_delete_course', { p_name: name, p_archive: isArchive });


  // ── Formatting ──
  function fmt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '';
  }
  function formatWhen(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }
  // A date without a time (an exam whose time is not set).
  function formatDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }
  // "12 Jun, 14:05" in a list; the year too when it is not this one.
  function formatShortWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
  }
  const formatTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // 45 → "45 s", 100 → "1 min 40 s", 3900 → "1 h 5 min".
  function formatSeconds(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
    return `${Math.floor(s / 3600)} h${Math.floor(s % 3600 / 60) ? ` ${Math.floor(s % 3600 / 60)} min` : ''}`;
  }
  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  }
  // ISO instant → the datetime-local input's local "YYYY-MM-DDTHH:MM".
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // For course-editor.js's section loader, Save and course moves.
  // For course-editor.js: leaving the grading page (another course, tab or Settings) asks first.
  const examLeaveGrading = () => (onGradingPage() ? confirmLeaveGrading() : Promise.resolve(true));
  const examGradingBack = () => leaveGradingPage();

  Object.assign(window, { loadExamsSection, saveExamsSection, loadStudentsSection, saveStudentsSection, followExamMove, followExamDelete,
    examGradingLinks, applyGradingLocks, followGradingKeys, examDraftOpen, examLeaveGrading, examGradingBack });
})();
