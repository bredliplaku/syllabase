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
    google: { label: 'Google account (full name)', icon: 'fa-brands fa-google' },
    anonymous: { label: 'Exam ID (anonymous)', icon: 'fa-solid fa-user-secret' },
  };
  const signInOf = exam => (SIGN_INS[exam.sign_in] ? exam.sign_in : 'student_id');
  function signInHint(signIn) {
    if (signIn === 'google') return 'Students sign in with the Google account on the class list; their full name is recorded.';
    if (signIn === 'anonymous') {
      const n = EX.data?.codes.length || 0;
      return `Students sign in with an exam ID from the Students tab (${n ? `${n} there` : 'none yet'}) and the exam password. No name is recorded.`;
    }
    return 'Students sign in with their student ID and the exam password, from an hour before the exam starts until it closes.';
  }
  // Student ID and exam ID sign-ins use the exam password; with Google it is optional.
  const needsPassword = signIn => signIn === 'student_id' || signIn === 'anonymous';
  function passwordHint(signIn) {
    if (signIn === 'student_id') return 'Students sign in with their student ID and this password. Required once the exam has questions.';
    if (signIn === 'anonymous') return 'Students sign in with their exam ID and this password. Required once the exam has questions.';
    return 'Optional: students type it when they start the exam.';
  }
  // Passwords are stored scrambled (hashed): a saved one can't be shown again, so say it is there.
  const PASSWORD_SAVED = `<p class="form-hint exam-password-saved"><i class="fa-solid fa-lock" aria-hidden="true"></i>
    <span>A password is saved. It is stored scrambled, so it can't be shown here: type a new one to change it.</span></p>`;
  // What the exam page does while an exam is taken (exam_private.clean_settings has the same
  // defaults): the name watermark, and what leaving the page (another tab or program) does.
  const DEFAULT_SETTINGS = { watermark: true, leave: 'cooldown', cooldown_seconds: 15 };
  const settingsOf = exam => ({ ...DEFAULT_SETTINGS, ...(exam?.settings || {}) });
  const LEAVE_MODES = {
    cooldown: { label: 'Red screen and a countdown', icon: 'fa-solid fa-hourglass-half' },
    record: { label: 'Recorded only', icon: 'fa-solid fa-eye' },
  };
  // Students' file answers (Supabase Storage; supabase/exams/2-functions.sql).
  const UPLOAD_BUCKET = 'exam-uploads';
  // Question images are scaled down to this before they are saved.
  const IMAGE_MAX_SIDE = 2000;
  const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const imageIdsOf = questions => [...new Set((questions || []).flatMap(q => (Array.isArray(q.images) ? q.images : [])).filter(id => UUID.test(id)))];
  // Question types as stored (and as the student page renders them), in the editor's order.
  const QUESTION_TYPES = {
    multiple_select: { label: 'Multiple choice', icon: 'fa-solid fa-list-ul' },
    short_answer: { label: 'Short answer', icon: 'fa-solid fa-font' },
    numeric: { label: 'Numeric', icon: 'fa-solid fa-calculator' },
    long_answer: { label: 'Long answer', icon: 'fa-solid fa-paragraph' },
    code: { label: 'Code', icon: 'fa-solid fa-code' },
    attachment: { label: 'File upload', icon: 'fa-solid fa-paperclip' },
    text_only: { label: 'Information', icon: 'fa-solid fa-circle-info' },
  };
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

  function examCardHtml(exam) {
    const chips = [];
    if (exam.starts_at) chips.push(chip('fa-regular fa-calendar', formatWhen(exam.starts_at)));
    if (exam.duration_minutes) chips.push(chip('fa-regular fa-clock', `${exam.duration_minutes} min`));
    if (exam.hall) chips.push(chip('fa-solid fa-location-dot', exam.hall));
    if (exam.weight != null) chips.push(chip('fa-solid fa-percent', `${fmt(exam.weight)}%${gradingLabel(exam.grading_key) ? ` (${gradingLabel(exam.grading_key)})` : ''}`));
    chips.push(chip('fa-solid fa-star', `Base ${fmt(exam.base)}`));
    const count = (exam.questions || []).filter(q => q.type !== 'text_only').length;
    if (!canManage()) chips.push(chip('fa-solid fa-list-ol', count ? `${count} question${count === 1 ? '' : 's'}` : 'No questions (in class)'));
    chips.push(chip(SIGN_INS[signInOf(exam)].icon, SIGN_INS[signInOf(exam)].label));
    if (exam.has_password) chips.push(chip('fa-solid fa-key', 'Password'));
    const settings = settingsOf(exam);
    if (count) chips.push(chip(LEAVE_MODES[settings.leave].icon, settings.leave === 'cooldown' ? `Leaving: ${settings.cooldown_seconds} s countdown` : 'Leaving: recorded'));
    const status = examStatus(exam);
    const noPassword = canManage() && needsPassword(signInOf(exam)) && count && status.key !== 'ended' && !exam.has_password;
    return `<article class="exam-card${exam.visible ? '' : ' is-hidden'}" data-exam-id="${x(exam.id)}">
      <div class="exam-card-head">
        <span class="exam-card-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="exam-card-title"><span class="exam-card-name">${x(examTitle(exam))}</span>
          ${exam.label ? `<span class="badge exam-type-badge">${x(typeLabel(exam.type))}</span>` : ''}
          <span class="exam-status exam-status-${status.key}">${x(status.label)}</span></div>
        ${canManage() ? `<div class="exam-card-actions">
          <button type="button" class="btn-action-vis" data-exam-action="try" title="Preview: take it as a student would, in a new tab (nothing is saved or sent)" aria-label="Preview"><i class="fa-solid fa-eye"></i></button>
          <button type="button" class="btn-action-test" data-exam-action="edit" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
          <button type="button" class="btn-action-vis" data-exam-action="duplicate" title="Duplicate" aria-label="Duplicate"><i class="fa-solid fa-copy"></i></button>
          <button type="button" class="btn-action-del" data-exam-action="delete" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>` : ''}
      </div>
      <div class="exam-card-meta">${chips.join('')}</div>
      ${noPassword ? `<p class="exam-card-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <span>Students can't sign in to start it without an exam password.
          <button type="button" class="exam-link-btn" data-exam-action="set-password">Set the password</button></span></p>` : ''}
      <div class="exam-card-foot">
        <label class="exam-switch"><input type="checkbox" data-flag="visible" ${exam.visible ? 'checked' : ''} ${canManage() ? '' : 'disabled'}><span title="On students' dashboards and the course page; they can start it when it opens. Off: a draft only you see.">Published</span></label>
        <label class="exam-switch"><input type="checkbox" data-flag="results_published" ${exam.results_published ? 'checked' : ''} ${canManage() ? '' : 'disabled'}><span title="Students see their grade, answers and your comments">Grades released</span></label>
        ${canManage() ? `<button type="button" class="btn-sm btn-secondary exam-q-btn" data-exam-action="questions"><i class="fa-solid fa-list-check" style="margin-right:6px"></i>Questions
          <span class="exam-count">${count}</span></button>` : ''}
        <button type="button" class="btn-sm btn-secondary exam-subs-btn" data-exam-action="submissions"><i class="fa-solid fa-inbox" style="margin-right:6px"></i>Submissions
          <span class="exam-count">${exam.submission_count}</span>${exam.submission_count ? `<span class="exam-count-sub">${exam.graded_count} graded</span>` : ''}</button>
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
    const btn = S.section === 'exams' && e.target.closest('[data-exam-action], [data-sub-action]');
    if (!btn) return;
    if (btn.dataset.subAction) return onSubmissionsAction(btn);
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
        return setTimeout(() => document.getElementById('exam-f-password')?.focus(), 120);
    }
  }

  async function onExamsChange(e) {
    const input = S.section === 'exams' && e.target.closest('[data-flag]');
    if (!input) return;
    const exam = examById(input.closest('[data-exam-id]')?.dataset.examId);
    if (!exam) return;
    const flag = input.dataset.flag, value = input.checked;
    input.disabled = true;
    try {
      await rpc('exam_set_exam_flags', { p_id: exam.id, p_visible: flag === 'visible' ? value : null,
        p_results_published: flag === 'results_published' ? value : null });
      exam[flag] = value;
      let done = 0;
      if (flag === 'results_published' && value && exam.grading_key) {
        try { done = await markGradingDone(EX.course, EX.isArchive, [exam.grading_key]); }
        catch (error) { toast(`Grades are visible, but ${gradingLabel(exam.grading_key) || 'the assessment'} was not marked Done: ${error.message}`, 'err'); }
      }
      if (flag === 'results_published' && !value && exam.grading_key) {
        markGradingDone(EX.course, EX.isArchive, [exam.grading_key], false)
          .catch(error => toast(`${gradingLabel(exam.grading_key) || 'The assessment'} is still marked Done: ${error.message}`, 'err'));
      }
      toast(flag === 'visible' ? (value ? 'Published: students see it' : 'Unpublished: a draft only you see')
        : value ? `Grades released to students${done ? `. ${gradingLabel(exam.grading_key)} marked Done.` : ''}` : 'Grades withdrawn from students', 'ok');
      const card = input.closest('.exam-card');
      card.outerHTML = examCardHtml(exam);
    } catch (error) {
      input.checked = !value;
      toast(error.message, 'err');
    } finally {
      input.disabled = false;
    }
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
    const files = exam.file_count ? `\n\nSo are the ${exam.file_count} file${exam.file_count === 1 ? '' : 's'} students uploaded (${formatBytes(exam.file_bytes)}): download them first from its Submissions.` : '';
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
      const save = { 'exam-edit': 'exam-edit-save', 'exam-grade': 'grading-save' }[top.id];
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
    ov.foot.innerHTML = `<button class="btn-sm btn-green" type="button" id="exam-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>${isNew ? 'Add exam' : 'Save exam'}</button>`;
    document.getElementById('exam-f-type').onchange = onTypeChange;
    document.getElementById('exam-f-grading').onchange = onGradingChange;
    document.getElementById('exam-f-signin').onchange = e => { e.target.dataset.touched = '1'; onSignInChange(); };
    document.getElementById('exam-f-leave').onchange = onLeaveChange;
    document.getElementById('exam-f-starts').oninput = document.getElementById('exam-f-duration').oninput = showExamEnd;
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
    return confirmDialog('Discard the changes to this exam?', { title: 'Unsaved Changes', okLabel: 'Discard', danger: true, okIcon: 'fa-trash-can' });
  }

  // An exam or grading dialog with changes not saved yet: course-editor.js asks before the page
  // closes, and keeps the sign-in while it is open.
  function examDraftOpen() {
    const open = id => !!document.getElementById(id)?.classList.contains('open');
    return (open('exam-edit') && _editorSnapshot !== null && editorSnapshot() !== _editorSnapshot) ||
      (open('exam-grade') && gradingChanged());
  }

  function examFormHtml(src, { isNew, duplicate }) {
    const typeOptions = Object.entries(EXAM_TYPES).map(([id, t]) => `<option value="${id}" ${src.type === id ? 'selected' : ''}>${x(t.label)}</option>`).join('');
    const gradingOptions = ['<option value="">Custom</option>', ...EX.grading.map(g =>
      `<option value="${x(g.key)}" data-weight="${g.weight}" data-cat="${x(g.cat)}" data-label="${x(g.label)}" ${src.grading_key === g.key ? 'selected' : ''}>${x(g.label)}</option>`)].join('');
    const signIn = signInOf(src);
    const settings = settingsOf(src);
    const section = (icon, title, body) => `<section class="exam-edit-section">
        <h4 class="exam-edit-head"><i class="${icon}" aria-hidden="true"></i>${title}</h4>${body}</section>`;
    return `
      ${section('fa-solid fa-clipboard-list', 'Exam', `<div class="sg-grid exam-edit-grid">
        <div class="form-group exam-edit-wide"><label class="form-label" for="exam-f-grading">Assessment</label>
          <select id="exam-f-grading">${gradingOptions}</select>
          <p class="form-hint">${EX.grading.length ? 'An entry from the Grading tab fills in the label, type and weight; Custom leaves them to you.' : 'Add weights on the Grading tab to choose one here.'}</p></div>
        <div class="form-group"><label class="form-label" for="exam-f-label">Label</label>
          <input type="text" id="exam-f-label" value="${x(duplicate ? `${src.label || typeLabel(src.type)} (copy)` : src.label || '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-type">Type</label>
          <select id="exam-f-type">${typeOptions}</select></div>
        <div class="form-group"><label class="form-label" for="exam-f-weight">Weight (% of grade)</label>
          <input type="number" id="exam-f-weight" min="0" max="100" step="0.1" value="${x(src.weight ?? '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-base">Base</label>
          <input type="number" id="exam-f-base" min="1" step="1" value="${x(src.base ?? 100)}"></div>
      </div>`)}
      ${section('fa-regular fa-calendar', 'Date and place', `<div class="sg-grid exam-edit-grid">
        <div class="form-group"><label class="form-label" for="exam-f-starts">Date and time</label>
          <input type="datetime-local" id="exam-f-starts" value="${x(toLocalInput(src.starts_at))}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-duration">Duration (minutes)</label>
          <input type="number" id="exam-f-duration" min="1" step="1" value="${x(src.duration_minutes ?? '')}">
          <p class="form-hint" id="exam-f-ends" aria-live="polite"></p></div>
        <div class="form-group"><label class="form-label" for="exam-f-hall">Hall</label>
          <input type="text" id="exam-f-hall" value="${x(src.hall || '')}"></div>
      </div>`)}
      ${section('fa-solid fa-right-to-bracket', 'Sign-in', `<div class="sg-grid exam-edit-grid">
        <div class="form-group"><label class="form-label" for="exam-f-signin">Sign-in</label>
          <select id="exam-f-signin">${Object.entries(SIGN_INS).map(([id, s]) => `<option value="${id}" ${signIn === id ? 'selected' : ''}>${x(s.label)}</option>`).join('')}</select>
          <p class="form-hint" id="exam-f-signin-hint">${x(signInHint(signIn))}</p></div>
        <div class="form-group"><label class="form-label" for="exam-f-password">Exam password</label>
          <input type="text" id="exam-f-password" autocomplete="off" spellcheck="false"
            placeholder="${!duplicate && src.has_password ? 'New password' : 'None'}">
          <p class="form-hint" id="exam-f-password-hint">${x(passwordHint(signIn))}</p>
          ${!duplicate && src.has_password ? `${PASSWORD_SAVED}<label class="exam-inline-check"><input type="checkbox" id="exam-f-password-clear"> Remove the password</label>` : ''}</div>
      </div>`)}
      ${section('fa-solid fa-shield-halved', 'During the exam', `<div class="sg-grid exam-edit-grid">
        <div class="form-group"><label class="form-label" for="exam-f-shuffle">Question order</label>
          <select id="exam-f-shuffle">
            <option value="yes" ${src.shuffle_questions !== false ? 'selected' : ''}>Shuffled for each student</option>
            <option value="no" ${src.shuffle_questions === false ? 'selected' : ''}>Fixed</option>
          </select></div>
        <div class="form-group"><label class="form-label" for="exam-f-leave">Leaving the page</label>
          <select id="exam-f-leave">${Object.entries(LEAVE_MODES).map(([id, m]) => `<option value="${id}" ${settings.leave === id ? 'selected' : ''}>${x(m.label)}</option>`).join('')}</select>
          <p class="form-hint">Leaving means switching to another tab or program; each time is recorded with the submission. Choose Recorded only when students need other programs, such as AutoCAD or an IDE.</p></div>
        <div class="form-group" data-cooldown><label class="form-label" for="exam-f-cooldown">Countdown (seconds)</label>
          <input type="number" id="exam-f-cooldown" min="5" max="300" step="1" value="${x(settings.cooldown_seconds)}">
          <p class="form-hint">Each time a student comes back, the screen stays red and the exam locked for this long (5 to 300 seconds). The exam timer keeps running.</p></div>
      </div>
      <div class="exam-edit-flags">
        <label class="exam-switch"><input type="checkbox" id="exam-f-watermark" ${settings.watermark ? 'checked' : ''}>
          <span><span class="exam-switch-title">Name watermark</span><span class="exam-switch-hint">The student's name and student ID (the exam ID on anonymous exams), large and faint across the screen: readable from the back of the room, and on any photo of the screen.</span></span></label>
      </div>`)}
      ${section('fa-solid fa-user-graduate', 'Students', `<div class="exam-edit-flags">
        <label class="exam-switch"><input type="checkbox" id="exam-f-visible" ${!duplicate && src.visible ? 'checked' : ''}>
          <span><span class="exam-switch-title">Published</span><span class="exam-switch-hint">On students' dashboards and the course page, and they can start it when it opens. Off: a draft only you see.</span></span></label>
        <label class="exam-switch"><input type="checkbox" id="exam-f-published" ${!duplicate && src.results_published ? 'checked' : ''}>
          <span><span class="exam-switch-title">Grades released</span><span class="exam-switch-hint">Turn on once grading is done: students then see their grade, answers and your comments. With an assessment chosen, it is marked Done on the Grading tab.</span></span></label>
      </div>`)}
      ${isNew && !duplicate ? '<p class="form-hint qe-next"><i class="fa-solid fa-list-check" aria-hidden="true"></i>You add the questions next, once the exam is added.</p>' : ''}`;
  }

  // Under the duration: when the exam closes, so a typo in either shows at once.
  function showExamEnd() {
    const starts = new Date(document.getElementById('exam-f-starts').value);
    const minutes = parseInt(document.getElementById('exam-f-duration').value, 10);
    document.getElementById('exam-f-ends').textContent = !isNaN(starts) && minutes > 0
      ? `Ends ${formatWhen(new Date(starts.getTime() + minutes * 60000).toISOString())}` : '';
  }

  // The countdown's length only with a countdown.
  function onLeaveChange() {
    const countdown = document.getElementById('exam-f-leave').value === 'cooldown';
    document.querySelectorAll('#exam-edit-body [data-cooldown]').forEach(el => { el.hidden = !countdown; });
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
    const startsLocal = val('exam-f-starts');
    const starts = startsLocal ? new Date(startsLocal) : null;
    const duration = val('exam-f-duration');
    const signIn = val('exam-f-signin');
    const password = val('exam-f-password');
    const clearPassword = document.getElementById('exam-f-password-clear')?.checked;
    const hasPassword = (original?.has_password && !clearPassword) || !!password;
    const problems = [];
    if (startsLocal && isNaN(starts)) problems.push('Enter a valid date and time.');
    if (questions.length && (!starts || !duration)) problems.push('An exam with questions needs a date, time and duration: students can start it only then.');
    if (needsPassword(signIn) && questions.length && !hasPassword) {
      problems.push(signIn === 'anonymous' ? 'Anonymous exams need an exam password.' : 'Student ID exams need an exam password: students sign in with it.');
    }
    const weight = val('exam-f-weight');
    if (weight && (parseFloat(weight) < 0 || parseFloat(weight) > 100)) problems.push('The weight is a percentage from 0 to 100.');
    const leave = val('exam-f-leave');
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
      shuffle_questions: val('exam-f-shuffle') !== 'no',
      settings: {
        watermark: document.getElementById('exam-f-watermark').checked,
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
      _editorSnapshot = null;
      overlay('exam-edit').close();
      if (original?.results_published && !exam.results_published && original.grading_key) {
        original.results_published = false; // no longer counts as showing the entry's grades
        markGradingDone(EX.course, EX.isArchive, [original.grading_key], false)
          .catch(error => toast(`${gradingLabel(original.grading_key) || 'The assessment'} is still marked Done: ${error.message}`, 'err'));
      }
      toast(original ? 'Exam saved' : 'Exam added', 'ok');
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
    imagesLoaded.then(() => { if (EX.view === 'questions' && EX.examId === examId) questionCards().forEach(renderCardImages); });
  }

  function questionsViewHtml(exam) {
    const todo = [];
    const settings = settingsOf(exam);
    if (!exam.starts_at || !exam.duration_minutes) todo.push(['warn', 'Set the date, time and duration in <strong>Exam settings</strong>: students can start it only then.']);
    if (signInOf(exam) === 'anonymous' && !exam.has_password) todo.push(['warn', 'Set an exam password in <strong>Exam settings</strong>: exams with exam IDs need one.']);
    if (signInOf(exam) === 'anonymous' && !EX.data.codes.length) todo.push(['warn', 'Paste the exam IDs on the <strong>Students</strong> tab.']);
    if (signInOf(exam) === 'student_id' && !exam.has_password) todo.push(['warn', 'Set an exam password in <strong>Exam settings</strong>: students sign in with their student ID and it.']);
    if (settings.leave === 'cooldown' && (exam.questions || []).some(q => q.type === 'attachment' || q.type === 'code')) {
      todo.push(['warn', 'Leaving the page starts a countdown, but this exam has file or code questions: students who switch to AutoCAD or an IDE are locked out each time. If they need other programs, choose <strong>Recorded only</strong> in <strong>Exam settings</strong>.']);
    }
    if (!exam.visible) todo.push(['info', 'Turn on <strong>Published</strong> on the exam when it is ready.']);
    return `
      <div class="section-topbar qe-topbar">
        <button type="button" class="btn-sm btn-secondary" data-qe="back"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>All exams</button>
        <div class="add-bar">
          <button type="button" class="btn-sm btn-secondary" data-qe="preview" title="Take the exam as a student would, in a new tab, with the questions as they are here. Nothing is saved or sent."><i class="fa-solid fa-eye"></i> Preview</button>
          <button type="button" class="btn-sm btn-secondary" data-qe="import"><i class="fa-solid fa-file-import"></i> Import</button>
          <button type="button" class="btn-sm btn-secondary" data-qe="export"><i class="fa-solid fa-file-export"></i> Export</button>
        </div>
        <button class="btn-sm btn-save-section is-clean" id="section-save-btn" disabled title="Nothing to save" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      </div>
      <div class="exam-sub-head qe-head">
        <span class="exam-card-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="qe-head-text"><div class="exam-card-name">${x(examTitle(exam))}: questions</div>
          <div class="exam-muted" id="qe-summary"></div></div>
        <div class="qe-head-actions">
          <button type="button" class="btn-sm btn-secondary" data-qe="collapse"><i class="fa-solid fa-down-left-and-up-right-to-center"></i> <span>Collapse all</span></button>
          <button type="button" class="btn-sm btn-secondary" data-qe="settings"><i class="fa-solid fa-gear"></i> Exam settings</button>
        </div>
      </div>
      ${exam.submission_count ? `<p class="form-hint exam-edit-warning"><i class="fa-solid fa-triangle-exclamation"></i>
        ${exam.submission_count} student${exam.submission_count === 1 ? ' has' : 's have'} already submitted. Answers are matched to questions by their position, so don't reorder or remove questions now.</p>` : ''}
      ${todo.length ? `<div class="qe-todo"><p class="qe-todo-title">Before students can start</p><ul>${todo.map(([kind, text]) =>
        `<li class="qe-todo-${kind}"><i class="fa-solid ${kind === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'}" aria-hidden="true"></i><span>${text}</span></li>`).join('')}</ul></div>` : ''}
      <div class="qe-list" id="qe-list"></div>
      <div class="qe-empty" id="qe-empty">
        <i class="fa-solid fa-list-check" aria-hidden="true"></i>
        <p><strong>No questions yet.</strong> Add them below, or import them from another exam.</p>
        <p class="form-hint">An exam without questions (held on paper) is only listed, with its date, hall and weight.</p>
        <p class="form-hint">Use <strong>Preview</strong> to take the exam yourself, timer and all, whenever you like: it needn't be published or open.</p>
      </div>
      <div class="qe-add">
        <span class="qe-add-label">Add a question</span>
        <div class="qe-add-buttons">${Object.entries(QUESTION_TYPES).map(([id, t]) =>
          `<button type="button" class="qe-add-btn" data-qe-add="${id}"><i class="${t.icon}" aria-hidden="true"></i>${x(t.label)}</button>`).join('')}</div>
      </div>`;
  }

  function optionRowHtml(text = '', correct = false) {
    return `<div class="q-option${correct ? ' is-correct' : ''}">
      <label class="q-opt-check" title="Correct answer"><input type="checkbox" class="q-opt-correct" ${correct ? 'checked' : ''} aria-label="Correct answer"><i class="fa-solid fa-check" aria-hidden="true"></i></label>
      <input type="text" class="q-opt-text" value="${x(text)}" aria-label="Option">
      <button type="button" class="qcard-btn" data-qc="remove-option" title="Remove option" aria-label="Remove option"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  }

  // One question as an editable card. Every type's fields are kept, so switching type and
  // back loses nothing; only the current type's are saved.
  function questionCard(q = {}, { collapsed = false } = {}) {
    const type = QUESTION_TYPES[q.type] ? q.type : 'short_answer';
    const options = Array.isArray(q.options) && q.options.length ? q.options : ['', '', ''];
    const correct = new Set(q.correct_answers || []);
    const card = document.createElement('article');
    card.className = `qcard${collapsed ? ' is-collapsed' : ''}`;
    card.dataset.type = type;
    card.innerHTML = `
      <header class="qcard-head">
        <span class="qcard-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></span>
        <span class="qcard-num"></span>
        <span class="qcard-type"><i class="${QUESTION_TYPES[type].icon}" aria-hidden="true"></i><span>${x(QUESTION_TYPES[type].label)}</span></span>
        <span class="qcard-summary"></span>
        <span class="qcard-badges"></span>
        <span class="qcard-points"></span>
        <span class="qcard-actions">
          <button type="button" class="qcard-btn" data-qc="up" title="Move up" aria-label="Move up"><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="qcard-btn" data-qc="down" title="Move down" aria-label="Move down"><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" class="qcard-btn" data-qc="duplicate" title="Duplicate" aria-label="Duplicate"><i class="fa-solid fa-copy"></i></button>
          <button type="button" class="qcard-btn is-danger" data-qc="delete" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
          <button type="button" class="qcard-btn qcard-toggle" data-qc="toggle" title="Show or hide" aria-label="Show or hide" aria-expanded="${!collapsed}"><i class="fa-solid fa-chevron-down"></i></button>
        </span>
      </header>
      <div class="qcard-body">
        <div class="qcard-row qcard-row-meta">
          <div class="form-group"><label class="form-label">Type</label>
            <select class="q-type">${Object.entries(QUESTION_TYPES).map(([id, t]) => `<option value="${id}" ${id === type ? 'selected' : ''}>${x(t.label)}</option>`).join('')}</select></div>
          <div class="form-group q-points-wrap"><label class="form-label">Points</label>
            <input type="number" class="q-points" min="0" step="0.5" value="${x(q.points ?? 1)}"></div>
        </div>
        <div class="form-group q-text">
          <div class="q-text-head">
            <label class="form-label q-prompt-label">${type === 'text_only' ? 'Text' : 'Question'}</label>
            ${toolbarHtml()}
          </div>
          <textarea class="q-prompt" rows="3" placeholder="${type === 'text_only' ? 'Instructions or a heading' : 'Type the question. Paste or drop an image to add it.'}">${x(q.prompt || '')}</textarea>
          <div class="q-shows-as" hidden><span class="q-shows-as-label">Shows as</span><div class="q-shows-as-text"></div></div>
          <input type="file" class="q-image-input" hidden data-no-dirty accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple>
          <input type="hidden" class="q-image-ids" value="${x(imageIdsOf([q]).join(','))}">
          <div class="q-images"></div>
        </div>
        <div class="q-part" data-part="multiple_select">
          <p class="q-part-title"><i class="fa-solid fa-list-check" aria-hidden="true"></i>Answer options <span class="label-note">tick the correct one</span></p>
          <div class="q-options">${options.map(o => optionRowHtml(o, correct.has(o))).join('')}</div>
          <button type="button" class="btn-sm btn-secondary q-add-option" data-qc="add-option"><i class="fa-solid fa-plus"></i> Add option</button>
          <p class="form-hint">Enter adds the next option; pasting several lines adds one option per line. Students pick one; autograding marks it right when it is ticked here.</p>
        </div>
        <div class="q-part" data-part="short_answer">
          <p class="q-part-title"><i class="fa-solid fa-spell-check" aria-hidden="true"></i>Accepted answers <span class="label-note">optional, one per line</span></p>
          <textarea class="q-accepted" rows="2">${x((q.accepted_answers || []).join('\n'))}</textarea>
          <p class="form-hint">Autograding accepts these, ignoring capitals and extra spaces. Leave empty to grade by hand.</p>
        </div>
        <div class="q-part" data-part="numeric">
          <p class="q-part-title"><i class="fa-solid fa-bullseye" aria-hidden="true"></i>Correct answer</p>
          <div class="qcard-row qcard-row-3">
            <div class="form-group"><label class="form-label">Answer</label>
              <input type="text" inputmode="decimal" class="q-answer" value="${x(q.answer ?? '')}"></div>
            <div class="form-group"><label class="form-label">Tolerance (±)</label>
              <input type="text" inputmode="decimal" class="q-tolerance" value="${x(q.tolerance ?? '')}"></div>
            <div class="form-group"><label class="form-label">Unit <span class="label-note">shown to students</span></label>
              <input type="text" class="q-unit" value="${x(q.unit || '')}"></div>
          </div>
          <p class="form-hint">Autograding accepts answers within the tolerance, e.g. 12.5 ± 0.1. Empty tolerance means exact.</p>
        </div>
        <div class="q-part" data-part="long_answer">
          <p class="q-part-title"><i class="fa-solid fa-paragraph" aria-hidden="true"></i>Starting text <span class="label-note">optional, already in the answer box</span></p>
          <textarea class="q-content" rows="3">${x(type === 'long_answer' ? q.content || '' : '')}</textarea>
        </div>
        <div class="q-part" data-part="code">
          <p class="q-part-title"><i class="fa-solid fa-code" aria-hidden="true"></i>Code answer</p>
          <div class="qcard-row"><div class="form-group"><label class="form-label">Language</label>
            <select class="q-language">${Object.entries(CODE_LANGUAGES).map(([id, label]) => `<option value="${id}" ${(q.language || 'python') === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
          <label class="form-label">Starter code <span class="label-note">optional</span></label>
          <textarea class="q-code" rows="6" spellcheck="false">${x(type === 'code' ? q.content || '' : '')}</textarea>
        </div>
        <div class="q-part" data-part="attachment">
          <p class="q-part-title"><i class="fa-solid fa-upload" aria-hidden="true"></i>The file students upload</p>
          <div class="qcard-row">
            <div class="form-group"><label class="form-label">Allowed file types <span class="label-note">optional</span></label>
              <input type="text" class="q-file-types" placeholder=".dwg, .pdf" value="${x((q.allowed_types || []).join(', '))}"></div>
            <div class="form-group"><label class="form-label">Largest file (MB) <span class="label-note">optional</span></label>
              <input type="number" class="q-file-size" min="1" step="1" value="${x(q.max_size_mb ?? '')}"></div>
          </div>
          <p class="form-hint">Students upload it during the exam; you download it from Submissions. Empty: any type, up to 50 MB.</p>
        </div>
        <details class="q-explain"${q.explanation ? ' open' : ''}>
          <summary>Explanation <span class="label-note">optional, shown to students with their grade</span></summary>
          <textarea class="q-explanation" rows="2">${x(q.explanation || '')}</textarea>
        </details>
      </div>`;
    applyCardType(card, type);
    renderCardImages(card);
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
    if (!imageIdsOf(exam.questions).some(id => !(id in EX.images))) return;
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
    card.querySelector('.q-prompt-label').textContent = type === 'text_only' ? 'Text' : 'Question';
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
    });
    document.getElementById('qe-empty').hidden = cards.length > 0;
    document.getElementById('qe-summary').textContent = cards.length
      ? `${n} question${n === 1 ? '' : 's'}, ${fmt(points)} point${points === 1 ? '' : 's'}${cards.length > n ? `, ${cards.length - n} information` : ''}${attention ? `, ${attention} to fix` : ''}`
      : 'No questions yet';
    const collapse = document.querySelector('[data-qe="collapse"] span');
    if (collapse) collapse.textContent = cards.length && cards.every(c => c.classList.contains('is-collapsed')) ? 'Expand all' : 'Collapse all';
  }

  function setCollapsed(card, collapsed) {
    card.classList.toggle('is-collapsed', collapsed);
    card.querySelector('.qcard-toggle').setAttribute('aria-expanded', String(!collapsed));
  }

  function addQuestion(type, after = null) {
    const card = questionCard({ type, points: type === 'text_only' ? undefined : 1 });
    const list = document.getElementById('qe-list');
    if (after) after.after(card); else list.appendChild(card);
    refreshQuestions();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.querySelector('.q-prompt').focus({ preventScroll: true }), 250);
    return card;
  }

  async function onQuestionsClick(e) {
    if (S.section !== 'exams' || EX.view !== 'questions') return;
    const add = e.target.closest('[data-qe-add]');
    if (add) return addQuestion(add.dataset.qeAdd);
    const action = e.target.closest('[data-qe]')?.dataset.qe;
    if (action) return onQuestionsAction(action);
    const card = e.target.closest('.qcard');
    if (!card) return;
    const btn = e.target.closest('[data-qc]');
    if (!btn) {
      // A click on the header (not its buttons) shows or hides the card.
      if (e.target.closest('.qcard-head') && !e.target.closest('.qcard-grip')) { setCollapsed(card, !card.classList.contains('is-collapsed')); refreshQuestions(); }
      return;
    }
    switch (btn.dataset.qc) {
      case 'toggle': setCollapsed(card, !card.classList.contains('is-collapsed')); break;
      case 'up': card.previousElementSibling?.before(card); break;
      case 'down': card.nextElementSibling?.after(card); break;
      case 'duplicate': {
        const copy = questionCard(readCard(card));
        card.after(copy);
        copy.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      case 'format': applyFormat(card.querySelector('.q-prompt'), btn.dataset.format); break;
      case 'symbols': toggleSymbols(card, btn); return;
      case 'symbol': insertText(card.querySelector('.q-prompt'), btn.dataset.symbol); toggleSymbols(card, null, false); break;
      case 'image': card.querySelector('.q-image-input').click(); return;
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
    return row;
  }

  function onQuestionsChange(e) {
    if (S.section !== 'exams' || EX.view !== 'questions') return;
    const card = e.target.closest('.qcard');
    if (!card) return;
    if (e.target.matches('.q-type')) { applyCardType(card, e.target.value); refreshQuestions(); }
    if (e.target.matches('.q-opt-correct')) { e.target.closest('.q-option').classList.toggle('is-correct', e.target.checked); refreshQuestions(); }
    if (e.target.matches('.q-image-input')) {
      const files = [...e.target.files];
      e.target.value = ''; // the same file can be chosen again, and the tab's draft check ignores it
      if (files.length) addCardImages(card, files);
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
      const collapse = !cards.every(c => c.classList.contains('is-collapsed'));
      cards.forEach(c => setCollapsed(c, collapse));
      return refreshQuestions();
    }
    if (action === 'settings') {
      if (!(await confirmLeaveIfDirty())) return;
      return openExamEditor(exam, false, true);
    }
    if (action === 'preview') return tryAsStudent(exam, collectQuestionCards({ strict: false }));
    if (action === 'export') return exportQuestionsJson(exam, collectQuestionCards({ strict: false }));
    if (action === 'import') return openImport(exam);
  }

  // A card's question as stored (only its type's fields).
  function readCard(card) {
    const get = sel => card.querySelector(sel);
    const type = card.dataset.type;
    const q = { type, prompt: get('.q-prompt').value.trim() };
    const images = cardImageIds(card);
    if (images.length) q.images = images;
    if (type !== 'text_only') {
      q.points = num(get('.q-points').value) ?? 0;
      const explanation = get('.q-explanation').value.trim();
      if (explanation) q.explanation = explanation;
    }
    if (type === 'multiple_select') {
      const rows = [...card.querySelectorAll('.q-option')].map(r => ({ text: r.querySelector('.q-opt-text').value.trim(), correct: r.querySelector('.q-opt-correct').checked }))
        .filter(r => r.text);
      q.options = rows.map(r => r.text);
      q.correct_answers = rows.filter(r => r.correct).map(r => r.text);
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
  const saveExamsSection = () => (EX.view === 'questions' ? saveQuestions() : true);


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
  const FRIENDLY_TYPES = { multiple_select: 'multiple_choice', short_answer: 'short_answer', numeric: 'numeric', long_answer: 'long_answer', code: 'code', attachment: 'file', text_only: 'text' };
  const TYPE_ALIASES = {
    multiple_choice: 'multiple_select', multiple_select: 'multiple_select', mc: 'multiple_select', mcq: 'multiple_select', choice: 'multiple_select',
    single_choice: 'multiple_select', radio: 'multiple_select', true_false: 'multiple_select', truefalse: 'multiple_select', boolean: 'multiple_select',
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
    if (q.type === 'short_answer' && q.accepted_answers?.length) out.accepted = q.accepted_answers;
    if (q.type === 'numeric') { out.answer = q.answer; if (q.tolerance) out.tolerance = q.tolerance; if (q.unit) out.unit = q.unit; }
    if (q.type === 'long_answer' && q.content) out.starting_text = q.content;
    if (q.type === 'code') { out.language = q.language || 'python'; if (q.content) out.starter_code = q.content; }
    if (q.type === 'attachment') { if (q.allowed_types?.length) out.allowed_types = q.allowed_types; if (q.max_size_mb) out.max_size_mb = q.max_size_mb; }
    if (q.explanation) out.explanation = q.explanation;
    // Images travel inside the file, so another course can import them too.
    const images = imageIdsOf([q]).map(id => EX.images[id]).filter(Boolean);
    if (images.length) out.images = images;
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
    EX.view = 'submissions';
    EX.examId = examId;
    body.onclick = onExamsClick;
    body.onchange = body.oninput = body.onkeydown = body.onpaste = body.ondragover = body.ondragleave = body.ondrop = null;
    try {
      [EX.submissions] = await Promise.all([rpc('exam_submissions', { p_exam_id: examId }), loadImages(exam)]);
    } catch (error) {
      toast(error.message, 'err');
      EX.submissions = [];
    }
    if (S.section !== 'exams' || EX.examId !== examId) return;
    renderSubmissions(body, exam);
  }

  // One row a submission: who, when, the grade, what the exam page noticed (leaving it, the
  // network) and Grade. The rest of a row's actions are in its ⋯ menu; the exports are under
  // Download. Narrow, the rows stack (css .subs-table).
  function renderSubmissions(body, exam) {
    const anonymous = exam.sign_in === 'anonymous';
    const subs = sortedSubmissions(exam);
    const graded = subs.filter(s => s.status === 'graded').length;
    const expected = anonymous ? EX.data.codes.length : EX.data.students.length;
    const classIp = classNetwork(subs);
    const gradable = !!exam.questions?.length;
    const rows = subs.map(s => {
      const menu = [
        { label: 'Recorded answers', icon: 'fa-regular fa-rectangle-list', attrs: 'data-sub-action="answers"' },
        { label: 'Network and device', icon: 'fa-solid fa-network-wired', attrs: 'data-sub-action="network"' },
        ...(s.activity?.count ? [{ label: 'Time away from the page', icon: 'fa-solid fa-person-walking-arrow-right', attrs: 'data-sub-action="activity"' }] : []),
        ...(canManage() ? [{ label: 'Delete submission', icon: 'fa-solid fa-trash', danger: true, attrs: 'data-sub-action="delete"' }] : []),
      ];
      return `<tr data-sub-id="${x(s.id)}">
        ${anonymous ? `<td class="sub-id exam-code-cell">${x(s.exam_code)}</td>`
        : `<td class="sub-id">${x(shownNo(s.student_no))}</td>
          <td class="sub-who"><span class="sub-name">${x(s.student_name)}</span><span class="sub-line" title="${x(s.student_email)}">${x(s.student_email)}</span></td>`}
        <td class="sub-when"><span title="${x(formatWhen(s.submitted_at))}">${x(formatShortWhen(s.submitted_at))}</span>
          ${s.late || s.auto_submitted ? `<span class="sub-tags">${s.late ? '<span class="badge exam-badge-late">Late</span>' : ''}${s.auto_submitted ? '<span class="badge exam-badge-auto" title="Submitted automatically at the deadline">Auto</span>' : ''}</span>` : ''}</td>
        <td class="sub-grade">${gradeCellHtml(s, exam)}</td>
        <td class="sub-checks">${leftPageHtml(s)}${networkCellHtml(s, classIp)}</td>
        <td class="sub-actions">
          ${gradable ? `<button type="button" class="btn-sm ${s.status === 'graded' ? 'btn-secondary' : ''}" data-sub-action="grade">${s.status === 'graded' ? 'Review' : 'Grade'}</button>` : ''}
          ${rowMenuHtml(menu, { label: 'More actions' })}
        </td></tr>`;
    }).join('');
    const columns = anonymous ? 5 : 6;
    const toGrade = subs.length - graded;
    const counts = [
      `${subs.length}${expected ? ` of ${expected}` : ''} submitted`,
      subs.length ? (toGrade ? `${toGrade} to grade` : 'All graded') : '',
      exam.results_published ? 'Grades released' : 'Grades not released',
    ].filter(Boolean);
    const downloads = [
      { label: 'Questions (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-sub-action="pdf-questions"', disabled: !gradable },
      { label: `Submissions${exam.file_count ? ' and files' : ''} (ZIP)`, icon: 'fa-regular fa-file-zipper', attrs: 'data-sub-action="zip"', disabled: !subs.length },
      { label: 'Grades (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-sub-action="pdf-grades"', disabled: !graded },
    ];
    body.innerHTML = `
      <div class="section-topbar" data-no-dirty>
        <button type="button" class="btn-sm btn-secondary" data-exam-action="back"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>All exams</button>
        <div class="add-bar">
          <button type="button" class="btn-sm btn-secondary" data-sub-action="refresh">Refresh</button>
          <button type="button" class="btn-sm" data-sub-action="eis" ${graded ? '' : 'disabled'} title="${graded ? 'The grades in the order EIS lists them, to copy' : 'No graded submissions yet'}">Grades for EIS</button>
        </div>
        ${rowMenuHtml(downloads, { text: 'Download', icon: 'fa-solid fa-download', label: 'Download' })}
      </div>
      <div class="exam-sub-head">
        <span class="exam-card-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="exam-sub-title"><div class="exam-card-name">${x(examTitle(exam))}</div>
          <div class="exam-sub-counts">${counts.map(c => `<span class="exam-chip">${x(c)}</span>`).join('')}
            ${exam.file_count ? `<span class="exam-chip">${exam.file_count} uploaded file${exam.file_count === 1 ? '' : 's'}, ${x(formatBytes(exam.file_bytes))}${canManage()
              ? ` <button type="button" class="exam-link-btn" data-sub-action="delete-files" title="Frees the storage they take, once you have downloaded them">Delete</button>` : ''}</span>` : ''}</div></div>
      </div>
      <div class="subs-wrap" data-no-dirty>
        <div class="data-table-container">
          <table class="data-table subs-table">
            <thead><tr>${anonymous ? '<th>Exam ID</th>' : '<th>Student ID</th><th>Name</th>'}<th>Submitted</th><th>Grade</th><th>Integrity</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${rows || `<tr><td colspan="${columns}" class="table-message">No submissions yet.</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }

  // The grade on the exam's base, and the points; or how far grading got.
  function gradeCellHtml(s, exam) {
    const g = s.grades;
    if (!g || !Number.isFinite(parseFloat(g.totalScore))) return '<span class="exam-muted">Not graded</span>';
    const points = `${x(fmt(g.totalScore))} of ${x(fmt(g.maxScore))} points`;
    if (s.status !== 'graded') return `<span class="sub-partial">Partly graded</span><span class="sub-line">${points} so far</span>`;
    const [grade, base] = gradeOnBase(g, exam.base).split(' / ');
    return `<span class="sub-score"><strong>${x(grade)}</strong> / ${x(base)}</span><span class="sub-line">${points}</span>`;
  }

  // Named: by name. Anonymous: in the pasted exam-ID order, as EIS lists them.
  function sortedSubmissions(exam) {
    const subs = [...EX.submissions];
    if (exam.sign_in === 'anonymous') {
      const order = new Map(EX.data.codes.map((c, i) => [c, i]));
      return subs.sort((a, b) => (order.get(a.exam_code) ?? 1e9) - (order.get(b.exam_code) ?? 1e9));
    }
    return subs.sort((a, b) => (a.student_name || '').localeCompare(b.student_name || ''));
  }

  async function onSubmissionsAction(btn) {
    const exam = examById(EX.examId);
    if (!exam) return;
    const sub = EX.submissions.find(s => s.id === btn.closest('[data-sub-id]')?.dataset.subId);
    switch (btn.dataset.subAction) {
      case 'refresh': return showSubmissions(exam.id);
      case 'answers': return showInfo('Answers', jsonListHtml(sub.answers));
      case 'network': return showNetwork(exam, sub);
      case 'activity': return showInfo(`Left the page: ${sub.student_name || sub.exam_code}`, activityHtml(sub.activity));
      case 'grade': return openGrading(exam, sub);
      case 'delete': return deleteSubmission(exam, sub);
      case 'delete-files': return deleteFiles(exam);
      case 'pdf-questions': return exportQuestionsPdf(exam);
      case 'zip': return exportSubmissionsZip(exam);
      case 'pdf-grades': return exportGradesPdf(exam);
      case 'eis': return showEisGrades(exam);
    }
  }

  async function deleteSubmission(exam, sub) {
    const who = sub.student_name || sub.exam_code || 'this student';
    if (!(await confirmDialog(`Delete the submission from ${who}? Its answers and grades are lost.`,
      { title: 'Delete Submission', okLabel: 'Delete', danger: true, okIcon: 'fa-trash-can' }))) return;
    try {
      await rpc('exam_delete_submission', { p_id: sub.id });
      toast('Submission deleted', 'ok');
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
    if (!(await confirmDialog(`Delete the ${exam.file_count} file${exam.file_count === 1 ? '' : 's'} students uploaded for "${examTitle(exam)}" (${formatBytes(exam.file_bytes)})?\n\nDownload them first with Submissions: the grades and the other answers stay.`,
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
  function subFlagHtml(text, kind, action, title) {
    return action ? `<button type="button" class="sub-flag is-${kind}" data-sub-action="${action}" title="${x(title)}">${x(text)}</button>`
      : `<span class="sub-flag is-${kind}">${x(text)}</span>`;
  }

  function leftPageHtml(sub) {
    const a = sub.activity;
    if (!a || a.count == null) return subFlagHtml('Leaving not recorded', 'muted');
    if (!a.count) return subFlagHtml('Stayed on the page', 'ok');
    return subFlagHtml(`Left ${a.count === 1 ? 'once' : `${a.count} times`}, ${formatSeconds(a.total_seconds)}`, 'warn', 'activity', 'When and for how long');
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
    if (!ips.length) { label = 'Network not recorded'; kind = 'muted'; }
    else if (classIp && ips.every(ip => ip === classIp)) { label = 'Class network'; kind = 'ok'; }
    else if (classIp) { label = ips.includes(classIp) ? `Class and ${ips.length - 1} other network${ips.length === 2 ? '' : 's'}` : 'Other network'; kind = 'warn'; }
    else label = ips.length === 1 ? `Network ${ips[0]}` : `${ips.length} networks`;
    const devices = devicesOf(sub).length;
    if (devices > 1) kind = 'warn';
    return subFlagHtml(`${label}${devices > 1 ? `, ${devices} devices` : ''}`, kind, 'network', 'Networks, provider, place and device');
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

  // The dialog's points and comments, to tell whether anything was entered since it opened.
  const gradingSnapshot = () => JSON.stringify([...document.querySelectorAll('#exam-grade-body input, #exam-grade-body textarea')].map(el => el.value));
  const gradingChanged = () => _grading?.snapshot != null && gradingSnapshot() !== _grading.snapshot;

  // The questions one under another, as the student had them: each with its points in its head
  // (Right and Wrong fill them in), then the answer, the correct one when there is one (and
  // whether they match), and a comment. The total stays in the footer, by Save; Save and next
  // keeps the dialog open for the next submission in the list.
  function openGrading(exam, sub) {
    _grading = { exam, sub };
    const questions = exam.questions || [];
    const answers = sub.answers || {};
    // Escape, the ×, Back or a stray click outside: ask before the entered grades are lost.
    const ov = overlay('exam-grade', { onClose: async () => {
      if (gradingChanged() && !(await confirmDialog('Discard the points and comments you entered?',
        { title: 'Unsaved Grades', okLabel: 'Discard', danger: true, okIcon: 'fa-trash-can' }))) return false;
      _grading = null;
      return true;
    } });
    ov.title(`Grade: ${subName(sub)}`);
    const list = sortedSubmissions(exam);
    const at = list.findIndex(s => s.id === sub.id);
    const prev = list[at - 1], next = list[at + 1];
    let number = 0;
    const chips = [];
    const items = questions.map((q, i) => {
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
          <dt><label for="comment-q-${n}">Comment</label></dt>
          <dd><textarea id="comment-q-${n}" rows="1" placeholder="For the student (optional)"></textarea></dd>
        </dl>
      </section>`;
    }).join('');
    const meta = [
      ...(sub.exam_code ? [] : [['Student ID', x(shownNo(sub.student_no))], ['Email', x(sub.student_email)]]),
      ['Submitted', `${x(formatWhen(sub.submitted_at))}${sub.late ? ' <span class="badge exam-badge-late">Late</span>' : ''}${sub.auto_submitted ? ' <span class="badge exam-badge-auto" title="Submitted automatically at the deadline">Auto</span>' : ''}`],
      ['Left the page', sub.activity?.count ? `${sub.activity.count === 1 ? 'Once' : `${sub.activity.count} times`}, ${x(formatSeconds(sub.activity.total_seconds))} in total` : ''],
      ['Network', x(networkLine(sub))],
    ].filter(([, value]) => value);
    // Kept in view at the top: a chip for each question in its status's colour, to go to it,
    // and the other submissions, without saving (it asks first).
    const step = (s, label) => `<button type="button" class="btn-sm btn-secondary" ${s ? `data-nav="${x(s.id)}" title="${x(subName(s))}"` : 'disabled'}>${label}</button>`;
    const bar = (chips.length > 1 ? `<nav class="gq-index" aria-label="Questions">${chips.join('')}</nav>` : '')
      + (list.length > 1 ? `<div class="grading-nav">${step(prev, 'Previous')}<span class="grading-pos">${at + 1} of ${list.length}</span>${step(next, 'Next')}</div>` : '');
    ov.body.innerHTML = `
      ${bar ? `<div class="grading-bar">${bar}</div>` : ''}
      <dl class="grading-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="grading-questions">${items || '<p class="builder-empty">This exam has no questions.</p>'}</div>
      <section class="gq gq-feedback"><label class="gq-title" for="grading-feedback">Feedback to the student</label>
        <textarea id="grading-feedback" rows="3" placeholder="About the exam as a whole (optional)"></textarea></section>`;
    ov.foot.innerHTML = `<p class="grading-total" aria-live="polite">Total <strong id="grading-total">0</strong> of ${fmt(totalPoints(questions))} points,
        grade <strong id="grading-base">0</strong> / ${fmt(exam.base)}</p>
      <button class="btn-sm btn-secondary" type="button" id="grading-auto" ${questions.some(canAutograde) ? '' : 'disabled'}
        title="Marks every question with a correct answer to compare with, Right or Wrong">Autograde</button>
      <button class="btn-sm btn-green" type="button" id="grading-save">Save</button>
      ${next ? `<button class="btn-sm" type="button" id="grading-save-next" title="Save, then grade ${x(subName(next))}">Save and next</button>` : ''}`;
    // Saved grades
    const g = sub.grades || {};
    document.getElementById('grading-feedback').value = g.feedback || '';
    for (const [qId, qGrade] of Object.entries(g.questionGrades || {})) {
      const n = parseInt(qId.slice(2), 10);
      const points = document.getElementById(`points-q-${n}`);
      if (!points) continue;
      if (qGrade.points !== '' && qGrade.points != null) points.value = qGrade.points;
      document.getElementById(`comment-q-${n}`).value = qGrade.comment || '';
      setGradeStatus(n, points.value === '' ? 'ungraded' : qGrade.status || statusOfPoints(points.value, questionMaxPoints(questions[n - 1])));
    }
    ov.body.onclick = onGradingClick;
    ov.body.oninput = e => {
      if (!e.target.matches('[data-grade-points]')) return;
      const item = e.target.closest('[data-q]');
      const max = parseFloat(item.dataset.max);
      const problem = pointsProblem(e.target.value, max);
      e.target.classList.toggle('field-error', !!problem);
      setGradeStatus(Number(item.dataset.q), problem ? 'ungraded' : statusOfPoints(e.target.value, max));
      updateGradingTotal();
    };
    document.getElementById('grading-auto').onclick = () => {
      const n = autogradeAll();
      const skipped = questions.filter((q, i) => canAutograde(q) && answers[`ans-${i + 1}`] === UNCONFIRMED).length;
      const left = skipped ? `${skipped} not confirmed in time ${skipped === 1 ? 'is' : 'are'} left for you` : '';
      toast(n ? `Autograded ${n} question${n === 1 ? '' : 's'}${left ? `; ${left}` : '; check the rest by hand'}`
        : left ? `Nothing autograded: ${left}` : 'No questions here can be autograded', n ? 'ok' : '');
    };
    document.getElementById('grading-save').onclick = () => saveGrades();
    if (next) document.getElementById('grading-save-next').onclick = () => saveGrades(next.id);
    updateGradingTotal();
    _grading.snapshot = gradingSnapshot();
    ov.body.scrollTop = 0;
    ov.open();
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

  // Previous and Next: another submission in the same dialog, once unsaved points are let go.
  async function gradeAnother(id) {
    const sub = EX.submissions.find(s => s.id === id);
    if (!sub || !_grading) return;
    if (gradingChanged() && !(await confirmDialog('Discard the points and comments you entered?',
      { title: 'Unsaved Grades', okLabel: 'Discard', danger: true, okIcon: 'fa-trash-can' }))) return;
    openGrading(_grading.exam, sub);
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

  // Questions that have a right answer to compare with.
  function canAutograde(q) {
    return (q?.type === 'multiple_select' && q.correct_answers?.length > 0) ||
      (q?.type === 'short_answer' && q.accepted_answers?.length > 0) || (q?.type === 'numeric' && q.answer != null);
  }

  // The right answer, for the grader.
  function answerKey(q) {
    if (q.type === 'multiple_select' && q.correct_answers?.length) return { label: 'Correct answer', html: q.correct_answers.map(x).join('<br>') };
    if (q.type === 'short_answer' && q.accepted_answers?.length) return { label: 'Accepted answers', html: q.accepted_answers.map(x).join('<br>') };
    if (q.type === 'numeric' && q.answer != null) return { label: 'Correct answer', html: x(`${exact(q.answer)}${q.tolerance ? ` ± ${exact(q.tolerance)}` : ''}${q.unit ? ` ${q.unit}` : ''}`) };
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
    if (q.type === 'short_answer') return q.accepted_answers.some(a => normalAnswer(a) === normalAnswer(given));
    const value = num(String(given ?? '').match(/-?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:e[-+]?\d+)?/i)?.[0]);
    return value != null && Math.abs(value - q.answer) <= (q.tolerance || 0) + 1e-9 * Math.max(1, Math.abs(q.answer));
  }

  function autogradeQuestion(n) {
    const q = _grading.exam.questions[n - 1];
    const right = autoCheck(q, _grading.sub.answers || {}, n);
    if (right == null) return false;
    markQuestion(n, questionMaxPoints(q), right);
    return true;
  }

  function autogradeAll() {
    let count = 0;
    _grading.exam.questions.forEach((q, i) => { if (autogradeQuestion(i + 1)) count++; });
    return count;
  }

  function updateGradingTotal() {
    let total = 0;
    // Points out of range count once corrected (Save asks for that).
    document.querySelectorAll('#exam-grade-body [data-grade-points]:not(.field-error)').forEach(input => { total += parseFloat(input.value) || 0; });
    const max = totalPoints(_grading.exam.questions);
    document.getElementById('grading-total').textContent = fmt(total);
    document.getElementById('grading-base').textContent = fmt(max > 0 ? total / max * (parseFloat(_grading.exam.base) || 100) : 0);
    return { total, max };
  }

  // Graded once every question has points; partial grading and comments are kept either way.
  // nextId: the submission to grade next, in the same dialog.
  async function saveGrades(nextId = null) {
    const { exam, sub } = _grading;
    const questions = exam.questions || [];
    for (const input of document.querySelectorAll('#exam-grade-body [data-grade-points]')) {
      const item = input.closest('[data-q]');
      const problem = pointsProblem(input.value, parseFloat(item.dataset.max));
      if (!problem) continue;
      input.classList.add('field-error');
      toast(`${item.querySelector('.gq-title').textContent}: ${problem}.`, 'err');
      item.scrollIntoView({ behavior: 'smooth', block: 'start' });
      input.focus({ preventScroll: true });
      return;
    }
    const { total, max } = updateGradingTotal();
    const questionGrades = {};
    let allFilled = true;
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
      _grading = null;
      // Going on to the next one keeps the dialog open: it is drawn again for them.
      if (!nextId) overlay('exam-grade').close();
      await refreshAfterChange(exam.id);
      // Unless it was closed meanwhile.
      const next = nextId && document.getElementById('exam-grade').classList.contains('open') && EX.submissions.find(s => s.id === nextId);
      if (next) openGrading(examById(exam.id) || exam, next);
      else if (nextId) overlay('exam-grade').close();
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
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
    const w = writer(doc);
    const questions = exam.questions || [];
    const grades = sub.grades || {};
    w.write(courseHeading(), { size: 10, color: [90, 90, 90] });
    w.write(`${examTitle(exam)}: ${sub.student_name || sub.exam_code}`, { size: 15, style: 'bold' });
    w.write([sub.exam_code ? `Exam ID ${sub.exam_code}` : [shownNo(sub.student_no), sub.student_email].filter(Boolean).join(', '),
      `submitted ${formatWhen(sub.submitted_at)}${sub.late ? ' (late)' : ''}`, sub.status].join('   |   '), { size: 9, color: [100, 100, 100], gap: 3 });
    if (networkLine(sub)) w.write(`Network: ${networkLine(sub)}`, { size: 9, color: [100, 100, 100], gap: 3 });
    if (sub.grades) w.write(`Grade: ${gradeOnBase(grades, exam.base)}  (${grades.totalScore}/${grades.maxScore} points)`, { size: 11, style: 'bold', color: [6, 95, 70], gap: 4 });
    let number = 0;
    questions.forEach((q, i) => {
      if (q.type === 'text_only') return;
      number++;
      const n = i + 1;
      const qGrade = grades.questionGrades?.[`q-${n}`] || {};
      w.write(`Question ${number}: ${formatQuestionText.plain(q.prompt)}`, { style: 'bold', color: [55, 65, 81], gap: 1 });
      const given = sub.answers?.[`ans-${n}`];
      const answer = q.type === 'attachment' ? fileAnswerText(sub, n) : given === UNCONFIRMED ? UNCONFIRMED_TEXT : given;
      w.write(answer == null || answer === '' ? 'No answer' : String(answer), { x: 18, style: answer ? 'normal' : 'italic' });
      if (qGrade.points !== '' && qGrade.points != null) w.write(`Score: ${qGrade.points}/${fmt(questionMaxPoints(q))} (${qGrade.status || 'graded'})`, { x: 18, size: 9, style: 'bold', color: [57, 73, 171], gap: 0.5 });
      if (qGrade.comment) w.write(`Comment: ${qGrade.comment}`, { x: 18, size: 9, style: 'italic', color: [100, 100, 100] });
      w.y += 3;
    });
    if (grades.feedback) { w.write('Feedback', { size: 11, style: 'bold' }); w.write(grades.feedback); }
    return doc.output('blob');
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
    const subs = sortedSubmissions(exam);
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
    const graded = sortedSubmissions(exam).filter(s => s.status === 'graded' && s.grades);
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

  let _pastedStudents = [];   // Parsed from the paste box, not saved yet
  let _pastedCodes = [];
  const _selected = new Set(); // Selected student ids
  let _anchor = null;          // Where a Shift-click range starts
  const STUDENTS_PER_PAGE = 10;
  let _studentPage = 0;        // The page of the list on screen, from 0
  let _studentQuery = '';      // The search, lowercased

  async function loadStudentsSection() {
    const course = S.course, isArchive = S.isArchive;
    const body = document.getElementById('section-body');
    try {
      await loadCourse(course, isArchive);
    } catch (error) {
      if (!isStale(course, isArchive, 'students')) sectionError(body, error);
      return;
    }
    if (isStale(course, isArchive, 'students')) return;
    _pastedStudents = [];
    _pastedCodes = [];
    _studentPage = 0;
    _studentQuery = '';
    const ids = new Set(EX.data.students.map(s => s.id));
    [..._selected].forEach(id => { if (!ids.has(id)) _selected.delete(id); });
    renderStudents(body);
    finishSectionLoad(body);
    // After the view-only lock: anyone who sees the list can search it and page through it.
    renderStudentPage();
    const search = document.getElementById('students-search');
    if (search) search.disabled = false;
  }

  function renderStudents(body) {
    const { students, codes } = EX.data;
    const manage = canManage();
    body.innerHTML = `
      <div class="section-topbar">
        <span class="exam-topbar-note"><i class="fa-solid fa-users" aria-hidden="true"></i><strong>${students.length}</strong> student${students.length === 1 ? '' : 's'}, <strong>${codes.length}</strong> exam ID${codes.length === 1 ? '' : 's'}</span>
        <button class="btn-sm btn-save-section is-clean" id="section-save-btn" disabled title="Nothing to save" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      </div>
      ${archivedNote()}
      <div class="settings-panel">

        <div class="settings-group">
          <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-paste"></i>Paste students from EIS</span></div>
          <div class="settings-body">
            <textarea id="classlist-paste" rows="5" spellcheck="false" placeholder="1.&#9;02032407&#9;Albi Kera&#9;akera24@epoka.edu.al&#9;BA CE&#10;2.&#9;02032421&#9;Albion Istrefi&#9;aistrefi24@epoka.edu.al&#9;BA CE"></textarea>
            <p class="form-hint">Copy the class list from EIS, or the whole page (Ctrl+A, Ctrl+C): only the student rows are read. Pasting again updates students by their ID and keeps everyone else unless you choose to remove them.</p>
            <div id="classlist-preview" class="paste-preview" data-no-dirty></div>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-user-secret"></i>Exam IDs for anonymous exams</span></div>
          <div class="settings-body">
            ${codes.length ? `<div class="code-grid" id="code-list" data-no-dirty>${codes.map((c, i) => `<span class="code-chip"><span>${i + 1}.</span>${x(c)}${manage
        ? `<button type="button" class="code-edit" data-code-index="${i}" title="Edit ${x(c)}" aria-label="Edit exam ID ${x(c)}"><i class="fa-solid fa-pen"></i></button>` : ''}</span>`).join('')}</div>`
        : '<p class="form-hint">No exam IDs yet.</p>'}
            <textarea id="codes-paste" rows="4" spellcheck="false" placeholder="1.&#9;dCepM&#10;2.&#9;iYBxw&#10;3.&#9;Lu5pt"></textarea>
            <p class="form-hint">Copy the exam's grade list from EIS, or the whole page: only the exam IDs are read, in EIS's order. Saving replaces the current list. The IDs are never linked to students.</p>
            <div id="codes-preview" class="paste-preview" data-no-dirty></div>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-users"></i>Students</span>
            ${students.length ? `<input type="search" class="classlist-search" id="students-search" placeholder="Search" aria-label="Search students" data-no-dirty>` : ''}</div>
          <div class="settings-body">
            ${students.length ? `
            <div class="student-toolbar" data-no-dirty>
              <button type="button" class="btn-sm btn-secondary" data-sel="all"><i class="fa-solid fa-check-double"></i><span>Select all</span></button>
              <span class="student-selection" id="student-selection" aria-live="polite"></span>
              ${manage ? `<span class="student-toolbar-actions">
                <button type="button" class="btn-sm btn-secondary" data-sel="edit" disabled><i class="fa-solid fa-pen-to-square"></i>Edit</button>
                <button type="button" class="btn-sm btn-red" data-sel="delete" disabled><i class="fa-solid fa-trash"></i>Delete</button>
              </span>` : ''}
            </div>
            <div class="data-table-container" data-no-dirty><table class="data-table classlist-table students-table"><thead><tr>
                <th class="select-cell"><input type="checkbox" id="students-check-all" aria-label="Select all students"></th>
                <th>#</th><th>Student ID</th><th>Name</th><th>Email</th><th>Programme</th><th>Exam ID</th><th>Note</th>
                ${manage ? '<th><span class="sr-only">Edit</span></th>' : ''}</tr></thead>
              <tbody id="student-rows"></tbody></table></div>
            <nav class="student-pager" id="student-pager" aria-label="Students pages" data-no-dirty hidden></nav>
            <p class="form-hint student-tip">Click a row to select it; Ctrl or Shift selects several, Ctrl+A all of them.</p>`
        : '<p class="form-hint">No students yet. Paste the class list from EIS above.</p>'}
          </div>
        </div>
      </div>`;
    document.getElementById('classlist-paste').oninput = previewStudents;
    document.getElementById('codes-paste').oninput = previewCodes;
    document.getElementById('students-search')?.addEventListener('input', filterStudents);
    document.getElementById('code-list')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-code-index]');
      if (btn) editCode(Number(btn.dataset.codeIndex));
    });
    const rows = document.getElementById('student-rows');
    if (rows) {
      rows.addEventListener('mousedown', e => { if (e.shiftKey && !e.target.closest('input')) e.preventDefault(); }); // no text selection
      rows.addEventListener('click', onStudentRowClick);
      document.getElementById('students-check-all').addEventListener('change', e => selectAll(e.target.checked));
      body.querySelector('.student-toolbar').addEventListener('click', onStudentToolbar);
      document.getElementById('student-pager').addEventListener('click', onStudentPager);
    }
  }

  // ── The list, a page at a time ──
  const studentSearchText = s => [s.student_no, s.full_name, s.email, s.programme, s.exam_code, s.note].join(' ').toLowerCase();
  const matchingStudents = () => _studentQuery ? EX.data.students.filter(s => studentSearchText(s).includes(_studentQuery)) : EX.data.students;

  function renderStudentPage() {
    const rows = document.getElementById('student-rows');
    if (!rows) return;
    const list = matchingStudents();
    const pages = Math.max(1, Math.ceil(list.length / STUDENTS_PER_PAGE));
    _studentPage = Math.min(Math.max(_studentPage, 0), pages - 1);
    const start = _studentPage * STUDENTS_PER_PAGE;
    const shown = list.slice(start, start + STUDENTS_PER_PAGE);
    // Each student keeps their number in the whole list, also when searching.
    rows.innerHTML = shown.length ? shown.map(s => studentRowHtml(s, EX.data.students.indexOf(s))).join('')
      : `<tr class="student-none"><td class="table-message" colspan="${canManage() ? 9 : 8}">No students match “${x(_studentQuery)}”.</td></tr>`;
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

  function studentRowHtml(s, i) {
    return `<tr data-student-id="${x(s.id)}">
      <td class="select-cell"><input type="checkbox" class="row-check" aria-label="Select ${x(s.full_name || s.student_no)}"></td>
      <td>${i + 1}.</td><td>${x(s.student_no)}</td><td>${x(s.full_name)}</td><td>${x(s.email)}</td>
      <td>${x(s.programme)}</td><td class="exam-code-cell">${x(s.exam_code)}</td>
      <td>${s.note ? `<span class="badge exam-badge-note">${x(s.note)}</span>` : ''}</td>
      ${canManage() ? `<td class="actions-cell"><button type="button" class="btn-action-test" data-edit-student title="Edit" aria-label="Edit ${x(s.full_name)}"><i class="fa-solid fa-pen-to-square"></i></button></td>` : ''}</tr>`;
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
    const allBtn = document.querySelector('[data-sel="all"] span');
    if (allBtn) allBtn.textContent = all ? 'Select none' : 'Select all';
    document.querySelectorAll('[data-sel="edit"], [data-sel="delete"]').forEach(b => { b.disabled = !n; });
  }

  function selectAll(on = true) {
    if (on) matchingIds().forEach(id => _selected.add(id));
    else _selected.clear();
    updateSelection();
  }

  // A click selects that row only; Ctrl/Cmd or the checkbox toggles it; Shift selects the range
  // from the last clicked row (adding to the selection with Ctrl, or from the checkbox).
  function onStudentRowClick(e) {
    const tr = e.target.closest('tr[data-student-id]');
    if (!tr || e.target.closest('a')) return;
    const id = tr.dataset.studentId;
    if (e.target.closest('[data-edit-student]')) return editStudents([EX.data.students.find(s => s.id === id)]);
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
    if (action === 'all') selectAll(!matchingIds().every(id => _selected.has(id)));
    else if (action === 'edit') editSelected();
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

  async function deleteSelected() {
    const chosen = selectedStudents();
    if (!chosen.length || !requirePermission(canManage())) return;
    const who = chosen.length === 1 ? (chosen[0].full_name || chosen[0].student_no) : `${chosen.length} students`;
    if (!(await confirmDialog(`Remove ${who} from the list? Their submissions are kept.`,
      { title: chosen.length === 1 ? 'Remove Student' : 'Remove Students', okLabel: 'Remove', danger: true, okIcon: 'fa-trash-can' }))) return;
    try {
      await rpc('exam_save_students', { p_sheet: EX.course, p_archive: EX.isArchive, p_students: [], p_remove: chosen.map(s => s.id) });
      chosen.forEach(s => _selected.delete(s.id));
      toast(chosen.length === 1 ? 'Student removed' : `${chosen.length} students removed`, 'ok');
      await reloadStudentsKeepingDrafts();
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  const editSelected = () => editStudents(selectedStudents());

  // One student: every field. Several: their programme. Saves at once.
  function editStudents(chosen) {
    chosen = chosen.filter(Boolean);
    if (!chosen.length || !requirePermission(canManage())) return;
    const single = chosen.length === 1 ? chosen[0] : null;
    const programmes = [...new Set(chosen.map(s => s.programme || ''))];
    const field = (id, label, value, extra = '') => `<div class="form-group"><label class="form-label" for="${id}">${label}</label>
      <input type="text" id="${id}" value="${x(value || '')}" autocomplete="off" ${extra}></div>`;
    const ov = overlay('student-edit', { wide: false });
    ov.title(single ? `Edit ${single.full_name || single.student_no}` : `Edit ${chosen.length} students`);
    ov.body.innerHTML = single
      ? `<div class="sg-grid">${field('student-f-name', 'Name', single.full_name)}
          ${field('student-f-email', 'Email', single.email, 'inputmode="email" spellcheck="false"')}
          ${field('student-f-no', 'Student ID <span class="label-note">optional</span>', single.student_no, 'inputmode="numeric"')}
          ${field('student-f-programme', 'Programme', single.programme)}
          ${field('student-f-code', 'Exam ID <span class="label-note">for your reference</span>', single.exam_code, 'list="student-code-options" spellcheck="false"')}
          ${field('student-f-note', 'Note', single.note)}</div>
        <datalist id="student-code-options">${EX.data.codes.map(c => `<option value="${x(c)}">`).join('')}</datalist>
        <p class="form-hint">The exam ID here only helps you find a student: it does not sign them in or link their results.</p>`
      : `<p class="form-hint">${chosen.slice(0, 6).map(s => x(s.full_name || s.student_no)).join(', ')}${chosen.length > 6 ? `, and ${chosen.length - 6} more` : ''}</p>
        <div class="form-group"><label class="form-label" for="student-f-programme">Programme</label>
          <input type="text" id="student-f-programme" value="${programmes.length === 1 ? x(programmes[0]) : ''}"
            placeholder="${programmes.length > 1 ? 'Different for each: type one for all of them' : ''}"></div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-green" type="button" id="student-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>`;
    const save = async () => {
      const val = id => document.getElementById(id)?.value.trim() ?? '';
      const changes = single
        ? { full_name: val('student-f-name'), email: val('student-f-email').toLowerCase(), student_no: val('student-f-no'),
          programme: val('student-f-programme'), exam_code: val('student-f-code'), note: val('student-f-note') }
        : { programme: val('student-f-programme') };
      if (single) {
        const others = EX.data.students.filter(s => s.id !== single.id);
        if (!changes.full_name) { toast('Enter the name', 'err'); return; }
        if (!EMAIL_RE.test(changes.email)) { toast('Enter a valid email', 'err'); return; }
        if (others.some(s => s.email === changes.email)) { toast('Another student has this email', 'err'); return; }
        if (changes.student_no && others.some(s => s.student_no === changes.student_no)) { toast('Another student has this student ID', 'err'); return; }
      } else if (!changes.programme && programmes.length > 1) { toast('Type the programme to give them all', 'err'); return; }
      const ids = new Set(chosen.map(s => s.id));
      // The whole list, so everyone keeps their place in it; ids make these edits, not a paste.
      const list = EX.data.students.map(({ id, student_no, full_name, email, programme, exam_code, note }) =>
        ({ id, student_no, full_name, email, programme, exam_code, note, ...(ids.has(id) ? changes : {}) }));
      const btn = document.getElementById('student-edit-save');
      btn.disabled = true;
      try {
        await rpc('exam_save_students', { p_sheet: EX.course, p_archive: EX.isArchive, p_students: list, p_remove: [] });
        ov.close();
        toast(single ? 'Student saved' : `${chosen.length} students saved`, 'ok');
        await reloadStudentsKeepingDrafts();
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

  // One exam ID in the list: change or remove it. The list is saved at once, in its order.
  function editCode(index) {
    const codes = EX.data.codes;
    const code = codes[index];
    if (code == null || !requirePermission(canManage())) return;
    const ov = overlay('code-edit', { wide: false });
    ov.title(`Edit exam ID ${index + 1}`);
    ov.body.innerHTML = `<div class="form-group"><label class="form-label" for="code-f-value">Exam ID</label>
      <input type="text" id="code-f-value" value="${x(code)}" autocomplete="off" spellcheck="false"></div>
      <p class="form-hint">Submissions already made with the old ID keep it.</p>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-red code-remove" type="button" id="code-edit-remove"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Remove</button>
      <button class="btn-sm btn-green" type="button" id="code-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>`;
    const saveList = async (list, message) => {
      ov.foot.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        await rpc('exam_save_codes', { p_sheet: EX.course, p_archive: EX.isArchive, p_codes: list });
        ov.close();
        toast(message, 'ok');
        await reloadStudentsKeepingDrafts();
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

  // After an edit or removal, which save at once: reload, keeping anything typed but not saved.
  async function reloadStudentsKeepingDrafts() {
    const keep = ['classlist-paste', 'codes-paste', 'students-search']
      .map(id => [id, document.getElementById(id)?.value || '']);
    const checks = ['classlist-remove-missing'].map(id => [id, document.getElementById(id)?.checked]);
    const page = _studentPage;
    lockHeight(document.getElementById('section-body'));
    await loadStudentsSection();
    if (S.section !== 'students') return;
    for (const [id, value] of keep) { const el = document.getElementById(id); if (el && value) el.value = value; }
    if (keep[0][1]) previewStudents();
    if (keep[1][1]) previewCodes();
    for (const [id, on] of checks) { const el = document.getElementById(id); if (el && on != null) el.checked = on; }
    // The same search and page, or the last one if the list got shorter.
    _studentQuery = (document.getElementById('students-search')?.value || '').trim().toLowerCase();
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
    diff('Note', s.note, p.note);
    return changes;
  }

  function previewStudents() {
    const text = document.getElementById('classlist-paste').value;
    const preview = document.getElementById('classlist-preview');
    if (!text.trim()) { _pastedStudents = []; preview.innerHTML = ''; return; }
    const { students, skipped } = parseClassList(text);
    const unique = [...new Map(students.map(s => [s.email, s])).values()];
    _pastedStudents = unique;
    const isExisting = p => !!matchOf(p);
    const added = unique.filter(p => !isExisting(p)).length;
    const missing = unique.length ? EX.data.students.filter(s => !unique.some(p => sameStudent(s, p))) : [];
    preview.innerHTML = `
      <p class="paste-summary ${unique.length ? '' : 'exam-error'}"><strong>${unique.length}</strong> student${unique.length === 1 ? '' : 's'} found${unique.length ? `, ${added} new, ${unique.filter(p => changesOf(p).length).length} to replace` : ' (each needs a name and an email)'}
        ${skipped.length ? `, <span class="exam-error">${skipped.length} line${skipped.length === 1 ? '' : 's'} not understood</span>` : ''}</p>
      <p class="paste-conflicts exam-error"></p>
      ${missing.length ? `<label class="exam-inline-check"><input type="checkbox" id="classlist-remove-missing">
        Remove the ${missing.length} student${missing.length === 1 ? '' : 's'} not in this paste (${missing.slice(0, 4).map(s => x(s.full_name || s.student_no)).join(', ')}${missing.length > 4 ? ', …' : ''})</label>` : ''}
      ${unique.length ? `<div class="data-table-container"><table class="data-table classlist-table"><thead><tr><th>Student ID</th><th>Name</th><th>Email</th><th>Programme</th><th>Note</th><th></th></tr></thead><tbody>
        ${unique.map(s => `<tr data-email="${x(s.email)}"><td>${x(s.student_no)}</td><td>${x(s.full_name)}</td><td>${x(s.email)}</td>
          <td>${x(s.programme)}</td><td>${s.note ? `<span class="badge exam-badge-note">${x(s.note)}</span>` : ''}</td>
          <td>${!isExisting(s) ? '<span class="badge exam-badge-graded">New</span>' : changesOf(s).length ? '<span class="badge exam-badge-submitted">Replace</span>' : '<span class="badge">No change</span>'}
            <div class="paste-issue">${changesOf(s).map(c => `<span class="exam-muted">${x(c)}</span>`).join('<br>')}</div></td></tr>`).join('')}
      </tbody></table></div>` : ''}
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
    document.querySelectorAll('#classlist-preview tbody tr[data-email]').forEach(tr => {
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
    const summary = document.querySelector('#classlist-preview .paste-conflicts');
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

  function previewCodes() {
    const text = document.getElementById('codes-paste').value;
    const preview = document.getElementById('codes-preview');
    _pastedCodes = text.trim() ? parseCodes(text) : [];
    preview.innerHTML = _pastedCodes.length ? `<p class="paste-summary"><strong>${_pastedCodes.length}</strong> exam ID${_pastedCodes.length === 1 ? '' : 's'} found${EX.data.codes.length ? `; saving replaces the current ${EX.data.codes.length}` : ''}</p>
      <div class="code-grid">${_pastedCodes.map((c, i) => `<span class="code-chip"><span>${i + 1}.</span>${x(c)}</span>`).join('')}</div>`
      : text.trim() ? '<p class="paste-summary exam-error">No exam IDs found.</p>' : '';
  }

  // The tab's Save (and Ctrl/Cmd+S): the pasted students and the pasted exam IDs, whichever
  // there are.
  async function saveStudentsSection() {
    if (!requirePermission(canManage())) return false;
    const btn = document.getElementById('section-save-btn');
    if (_pastedStudents.length && _pasteConflicts) {
      toast('Some students have a different student ID or email in another course: see the paste preview', 'err');
      document.querySelector('#classlist-preview .paste-conflicts')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    if (!_pastedStudents.length && !_pastedCodes.length) {
      if (document.getElementById('classlist-paste').value.trim()) toast('No students found in the pasted text', 'err');
      else if (document.getElementById('codes-paste').value.trim()) toast('No exam IDs found in the pasted text', 'err');
      else toast('Nothing to save', '');
      return true;
    }
    // Students already on the list (same email) whose details differ: replace only when asked.
    const replaced = _pastedStudents.filter(p => changesOf(p).length);
    if (replaced.length && !(await confirmDialog(
      `${replaced.length} student${replaced.length === 1 ? ' is' : 's are'} already on the list with different details: ${replaced.slice(0, 5).map(p => matchOf(p).full_name).join(', ')}${replaced.length > 5 ? ', …' : ''}. Replace their details with the pasted ones? Their exams and grades are kept.`,
      { title: 'Replace Students', okLabel: 'Replace', okIcon: 'fa-arrows-rotate' }))) return false;
    if (_pastedCodes.length && EX.data.codes.length &&
      !(await confirmDialog(`Replace the ${EX.data.codes.length} exam IDs with the ${_pastedCodes.length} pasted ones?`, { title: 'Replace Exam IDs', okLabel: 'Replace' }))) return false;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }
    try {
      if (_pastedStudents.length) {
        const remove = document.getElementById('classlist-remove-missing')?.checked
          ? EX.data.students.filter(s => !_pastedStudents.some(p => sameStudent(s, p))).map(s => s.id) : [];
        await rpc('exam_save_students', { p_sheet: EX.course, p_archive: EX.isArchive, p_students: _pastedStudents, p_remove: remove });
      }
      if (_pastedCodes.length) await rpc('exam_save_codes', { p_sheet: EX.course, p_archive: EX.isArchive, p_codes: _pastedCodes });
      toast('Students saved', 'ok');
      lockHeight(document.getElementById('section-body'));
      await loadStudentsSection();
      return true;
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save'; }
      return false;
    }
  }


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
  Object.assign(window, { loadExamsSection, saveExamsSection, loadStudentsSection, saveStudentsSection, followExamMove, followExamDelete,
    examGradingLinks, applyGradingLocks, followGradingKeys, examDraftOpen });
})();
