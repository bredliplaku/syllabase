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
  const EX = { course: null, isArchive: false, access: null, data: null, grading: [], view: 'list', examId: null, submissions: [] };
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
    for (const cat of GRADING_CATEGORIES) {
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
    if (EX.course !== course || EX.isArchive !== isArchive) Object.assign(EX, { view: 'list', examId: null, submissions: [] });
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
      const why = `Grades of ${exam} are visible to students. To change this, set that exam's Assessment to Custom.`;
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
          Exams carry <strong>${fmt(totalWeight)}%</strong> of the grade${gradingTotal ? ` · the Grading tab lists ${fmt(gradingTotal)}%` : ''}</span>
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
    body.oninput = body.onkeydown = body.onpaste = null;
  }

  function examCardHtml(exam) {
    const chips = [];
    if (exam.starts_at) chips.push(chip('fa-regular fa-calendar', formatWhen(exam.starts_at)));
    if (exam.duration_minutes) chips.push(chip('fa-regular fa-clock', `${exam.duration_minutes} min`));
    if (exam.hall) chips.push(chip('fa-solid fa-location-dot', exam.hall));
    if (exam.weight != null) chips.push(chip('fa-solid fa-percent', `${fmt(exam.weight)}%${gradingLabel(exam.grading_key) ? ` · ${gradingLabel(exam.grading_key)}` : ''}`));
    chips.push(chip('fa-solid fa-star', `Base ${fmt(exam.base)}`));
    const count = (exam.questions || []).filter(q => q.type !== 'text_only').length;
    if (!canManage()) chips.push(chip('fa-solid fa-list-ol', count ? `${count} question${count === 1 ? '' : 's'}` : 'No questions (in class)'));
    chips.push(chip(SIGN_INS[signInOf(exam)].icon, SIGN_INS[signInOf(exam)].label));
    if (exam.has_password) chips.push(chip('fa-solid fa-key', 'Password'));
    const status = examStatus(exam);
    const noPassword = canManage() && needsPassword(signInOf(exam)) && count && status.key !== 'ended' && !exam.has_password;
    return `<article class="exam-card${exam.visible ? '' : ' is-hidden'}" data-exam-id="${x(exam.id)}">
      <div class="exam-card-head">
        <span class="exam-card-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div class="exam-card-title"><span class="exam-card-name">${x(examTitle(exam))}</span>
          ${exam.label ? `<span class="badge exam-type-badge">${x(typeLabel(exam.type))}</span>` : ''}
          <span class="exam-status exam-status-${status.key}">${x(status.label)}</span></div>
        ${canManage() ? `<div class="exam-card-actions">
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
        <label class="exam-switch"><input type="checkbox" data-flag="visible" ${exam.visible ? 'checked' : ''} ${canManage() ? '' : 'disabled'}><span title="On their dashboard and the course page; they can start it when it opens">Visible to students</span></label>
        <label class="exam-switch"><input type="checkbox" data-flag="results_published" ${exam.results_published ? 'checked' : ''} ${canManage() ? '' : 'disabled'}><span title="Students see their grade, answers and your comments">Grades visible</span></label>
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
    return { key: 'listed', label: 'Visible' };
  }

  const examById = id => EX.data?.exams.find(e => e.id === id);
  // Named submissions carry the student ID, or the email for a student without one.
  const studentKey = s => s.student_no || s.email;
  const shownNo = no => (no && !no.includes('@') ? no : '');

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
      toast(flag === 'visible' ? (value ? 'Visible to students' : 'Hidden from students')
        : value ? `Grades visible to students${done ? ` · ${gradingLabel(exam.grading_key)} marked Done` : ''}` : 'Grades hidden from students', 'ok');
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
    if (!(await confirmDialog(`Delete "${examTitle(exam)}"?${subs}`, { title: 'Delete Exam', okLabel: 'Delete', danger: true, okIcon: 'fa-trash-can' }))) return;
    try {
      await rpc('exam_delete_exam', { p_id: exam.id });
      toast('Exam deleted', 'ok');
      reloadExams();
    } catch (error) {
      toast(error.message, 'err');
    }
  }


  // ── Overlays (the editor's own modal is too small for exams) ──
  function overlay(id, { wide = true, onClose } = {}) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'modal-overlay exam-overlay';
      el.id = id;
      el.innerHTML = `<div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
        <div class="modal-head"><h3 id="${id}-title"></h3>
          <button class="btn-ghost btn-icon" type="button" data-close aria-label="Close" style="margin-left:auto;padding:5px 9px;"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="modal-body" id="${id}-body"></div>
        <div class="modal-foot" id="${id}-foot"></div>
      </div>`;
      document.body.appendChild(el);
      let downOnBackdrop = false;
      el.addEventListener('mousedown', e => { downOnBackdrop = e.target === el; });
      el.addEventListener('click', e => {
        if (e.target.closest('[data-close]') || (downOnBackdrop && e.target === el)) el._requestClose();
      });
    }
    el._requestClose = async () => { if (!onClose || await onClose()) el.classList.remove('open'); };
    return {
      el,
      title: t => { document.getElementById(`${id}-title`).textContent = t; },
      body: document.getElementById(`${id}-body`),
      foot: document.getElementById(`${id}-foot`),
      open: () => el.classList.add('open'),
      close: () => el.classList.remove('open'),
    };
  }

  // Escape closes the top exam dialog; Ctrl/Cmd+S saves that dialog (exam or grades), not the tab.
  document.addEventListener('keydown', e => {
    if (document.getElementById('confirm-overlay')?.classList.contains('open')) return;
    const top = [...document.querySelectorAll('.exam-overlay.open')].pop();
    if (!top) return;
    if (e.key === 'Escape') { e.stopImmediatePropagation(); top._requestClose(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
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
    ov.foot.innerHTML = `<button class="btn-secondary btn-sm" type="button" data-close><i class="fa-solid fa-xmark" style="margin-right:5px"></i>Cancel</button>
      <button class="btn-sm btn-green" type="button" id="exam-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>${isNew ? 'Add exam' : 'Save exam'}</button>`;
    document.getElementById('exam-f-type').onchange = onTypeChange;
    document.getElementById('exam-f-grading').onchange = onGradingChange;
    document.getElementById('exam-f-signin').onchange = e => { e.target.dataset.touched = '1'; onSignInChange(); };
    document.getElementById('exam-edit-save').onclick = () => saveExam(isNew ? null : exam, source, returnToQuestions);
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

  function examFormHtml(src, { isNew, duplicate }) {
    const typeOptions = Object.entries(EXAM_TYPES).map(([id, t]) => `<option value="${id}" ${src.type === id ? 'selected' : ''}>${x(t.label)}</option>`).join('');
    const gradingOptions = ['<option value="">Custom</option>', ...EX.grading.map(g =>
      `<option value="${x(g.key)}" data-weight="${g.weight}" data-cat="${x(g.cat)}" data-label="${x(g.label)}" ${src.grading_key === g.key ? 'selected' : ''}>${x(g.label)}</option>`)].join('');
    const signIn = signInOf(src);
    return `
      <div class="sg-grid exam-edit-grid">
        <div class="form-group"><label class="form-label" for="exam-f-grading">Assessment</label>
          <select id="exam-f-grading">${gradingOptions}</select>
          <p class="form-hint">${EX.grading.length ? 'An entry from the Grading tab fills in the label, type and weight; Custom leaves them to you.' : 'Add weights on the Grading tab to choose one here.'}</p></div>
        <div class="form-group"><label class="form-label" for="exam-f-label">Label</label>
          <input type="text" id="exam-f-label" value="${x(duplicate ? `${src.label || typeLabel(src.type)} (copy)` : src.label || '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-type">Type</label>
          <select id="exam-f-type">${typeOptions}</select></div>
        <div class="form-group"><label class="form-label" for="exam-f-weight">Weight (% of grade)</label>
          <input type="number" id="exam-f-weight" min="0" max="100" step="0.1" value="${x(src.weight ?? '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-starts">Date and time</label>
          <input type="datetime-local" id="exam-f-starts" value="${x(toLocalInput(src.starts_at))}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-duration">Duration (minutes)</label>
          <input type="number" id="exam-f-duration" min="1" step="1" value="${x(src.duration_minutes ?? '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-hall">Hall</label>
          <input type="text" id="exam-f-hall" value="${x(src.hall || '')}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-base">Base</label>
          <input type="number" id="exam-f-base" min="1" step="1" value="${x(src.base ?? 100)}"></div>
        <div class="form-group"><label class="form-label" for="exam-f-signin">Sign-in</label>
          <select id="exam-f-signin">${Object.entries(SIGN_INS).map(([id, s]) => `<option value="${id}" ${signIn === id ? 'selected' : ''}>${x(s.label)}</option>`).join('')}</select>
          <p class="form-hint" id="exam-f-signin-hint">${x(signInHint(signIn))}</p></div>
        <div class="form-group"><label class="form-label" for="exam-f-password">Exam password</label>
          <input type="text" id="exam-f-password" autocomplete="off" spellcheck="false"
            placeholder="${!duplicate && src.has_password ? 'New password' : 'None'}">
          <p class="form-hint" id="exam-f-password-hint">${x(passwordHint(signIn))}</p>
          ${!duplicate && src.has_password ? `${PASSWORD_SAVED}<label class="exam-inline-check"><input type="checkbox" id="exam-f-password-clear"> Remove the password</label>` : ''}</div>
        <div class="form-group"><label class="form-label" for="exam-f-shuffle">Question order</label>
          <select id="exam-f-shuffle">
            <option value="yes" ${src.shuffle_questions !== false ? 'selected' : ''}>Shuffled for each student</option>
            <option value="no" ${src.shuffle_questions === false ? 'selected' : ''}>Fixed</option>
          </select></div>
      </div>
      <div class="exam-edit-flags">
        <label class="exam-switch"><input type="checkbox" id="exam-f-visible" ${!duplicate && src.visible ? 'checked' : ''}>
          <span><span class="exam-switch-title">Visible to students</span><span class="exam-switch-hint">On their dashboard and the course page, and they can start it when it opens. Off: a draft only you see.</span></span></label>
        <label class="exam-switch"><input type="checkbox" id="exam-f-published" ${!duplicate && src.results_published ? 'checked' : ''}>
          <span><span class="exam-switch-title">Grades visible to students</span><span class="exam-switch-hint">Turn on once grading is done: students then see their grade, answers and your comments. With an assessment chosen, it is marked Done on the Grading tab.</span></span></label>
      </div>
      ${isNew && !duplicate ? '<p class="form-hint qe-next"><i class="fa-solid fa-list-check" aria-hidden="true"></i>You add the questions next, once the exam is added.</p>' : ''}`;
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
    body.innerHTML = questionsViewHtml(exam);
    const list = document.getElementById('qe-list');
    const questions = exam.questions || [];
    questions.forEach(q => list.appendChild(questionCard(q, { collapsed: questions.length > 4 })));
    refreshQuestions();
    if (window.Sortable) {
      Sortable.create(list, { handle: '.qcard-grip', animation: 150, ghostClass: 'qcard-ghost', onEnd: refreshQuestions });
    }
    finishSectionLoad(body);
  }

  function questionsViewHtml(exam) {
    const todo = [];
    if (!exam.starts_at || !exam.duration_minutes) todo.push(['warn', 'Set the date, time and duration in <strong>Exam settings</strong>: students can start it only then.']);
    if (signInOf(exam) === 'anonymous' && !exam.has_password) todo.push(['warn', 'Set an exam password in <strong>Exam settings</strong>: exams with exam IDs need one.']);
    if (signInOf(exam) === 'anonymous' && !EX.data.codes.length) todo.push(['warn', 'Paste the exam IDs on the <strong>Students</strong> tab.']);
    if (signInOf(exam) === 'student_id' && !exam.has_password) todo.push(['warn', 'Set an exam password in <strong>Exam settings</strong>: students sign in with their student ID and it.']);
    if (!exam.visible) todo.push(['info', 'Turn on <strong>Visible to students</strong> on the exam when it is ready.']);
    return `
      <div class="section-topbar qe-topbar">
        <button type="button" class="btn-sm btn-secondary" data-qe="back"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>All exams</button>
        <div class="add-bar">
          <button type="button" class="btn-sm btn-secondary" data-qe="preview"><i class="fa-solid fa-eye"></i> Preview</button>
          <button type="button" class="btn-sm btn-secondary" data-qe="import"><i class="fa-solid fa-file-import"></i> Import</button>
          <button type="button" class="btn-sm btn-secondary" data-qe="export"><i class="fa-solid fa-file-export"></i> Export</button>
        </div>
        <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
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
        <div class="qcard-row">
          <div class="form-group"><label class="form-label">Type</label>
            <select class="q-type">${Object.entries(QUESTION_TYPES).map(([id, t]) => `<option value="${id}" ${id === type ? 'selected' : ''}>${x(t.label)}</option>`).join('')}</select></div>
          <div class="form-group q-points-wrap"><label class="form-label">Points</label>
            <input type="number" class="q-points" min="0" step="0.5" value="${x(q.points ?? 1)}"></div>
        </div>
        <div class="form-group"><label class="form-label q-prompt-label">${type === 'text_only' ? 'Text' : 'Question'}</label>
          <textarea class="q-prompt" rows="3">${x(q.prompt || '')}</textarea>
          <p class="form-hint">Write **like this** for bold. Line breaks are kept.</p></div>
        <div class="q-part" data-part="multiple_select">
          <label class="form-label">Options <span class="label-note">tick the correct one (or each correct one)</span></label>
          <div class="q-options">${options.map(o => optionRowHtml(o, correct.has(o))).join('')}</div>
          <button type="button" class="btn-sm btn-secondary q-add-option" data-qc="add-option"><i class="fa-solid fa-plus"></i> Add option</button>
          <p class="form-hint">Enter adds the next option; pasting several lines adds one option per line. Students pick one; autograding marks it right when it is ticked here.</p>
        </div>
        <div class="q-part" data-part="short_answer">
          <label class="form-label">Accepted answers <span class="label-note">optional, one per line</span></label>
          <textarea class="q-accepted" rows="2">${x((q.accepted_answers || []).join('\n'))}</textarea>
          <p class="form-hint">Autograding accepts these, ignoring capitals and extra spaces. Leave empty to grade by hand.</p>
        </div>
        <div class="q-part" data-part="numeric">
          <div class="qcard-row qcard-row-3">
            <div class="form-group"><label class="form-label">Correct answer</label>
              <input type="text" inputmode="decimal" class="q-answer" value="${x(q.answer ?? '')}"></div>
            <div class="form-group"><label class="form-label">Tolerance (±)</label>
              <input type="text" inputmode="decimal" class="q-tolerance" value="${x(q.tolerance ?? '')}"></div>
            <div class="form-group"><label class="form-label">Unit <span class="label-note">shown to students</span></label>
              <input type="text" class="q-unit" value="${x(q.unit || '')}"></div>
          </div>
          <p class="form-hint">Autograding accepts answers within the tolerance, e.g. 12.5 ± 0.1. Empty tolerance means exact.</p>
        </div>
        <div class="q-part" data-part="long_answer">
          <label class="form-label">Starting text <span class="label-note">optional, already in the answer box</span></label>
          <textarea class="q-content" rows="3">${x(type === 'long_answer' ? q.content || '' : '')}</textarea>
        </div>
        <div class="q-part" data-part="code">
          <div class="qcard-row"><div class="form-group"><label class="form-label">Language</label>
            <select class="q-language">${Object.entries(CODE_LANGUAGES).map(([id, label]) => `<option value="${id}" ${(q.language || 'python') === id ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
          <label class="form-label">Starter code <span class="label-note">optional</span></label>
          <textarea class="q-code" rows="6" spellcheck="false">${x(type === 'code' ? q.content || '' : '')}</textarea>
        </div>
        <div class="q-part" data-part="attachment">
          <div class="qcard-row">
            <div class="form-group"><label class="form-label">Allowed file types <span class="label-note">optional</span></label>
              <input type="text" class="q-file-types" value="${x((q.allowed_types || []).join(', '))}"></div>
            <div class="form-group"><label class="form-label">Largest file (MB) <span class="label-note">optional</span></label>
              <input type="number" class="q-file-size" min="1" step="1" value="${x(q.max_size_mb ?? '')}"></div>
          </div>
          <p class="form-hint">For example .pdf, .zip. Only the file's name is recorded with the submission.</p>
        </div>
        <details class="q-explain"${q.explanation ? ' open' : ''}>
          <summary>Explanation <span class="label-note">optional, shown to students with their grade</span></summary>
          <textarea class="q-explanation" rows="2">${x(q.explanation || '')}</textarea>
        </details>
      </div>`;
    applyCardType(card, type);
    return card;
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

  // Numbers, summaries, totals and the empty state, after any change.
  function refreshQuestions() {
    const cards = questionCards();
    let n = 0, points = 0;
    cards.forEach((card, i) => {
      const type = card.dataset.type;
      const info = type === 'text_only';
      card.querySelector('.qcard-num').innerHTML = info ? '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>' : String(++n);
      const firstLine = card.querySelector('.q-prompt').value.split('\n').find(l => l.trim()) || '';
      const summary = card.querySelector('.qcard-summary');
      summary.textContent = firstLine.replace(/\*\*/g, '') || 'No text yet';
      summary.classList.toggle('is-empty', !firstLine);
      const p = num(card.querySelector('.q-points').value) ?? 0;
      if (!info) points += p;
      card.querySelector('.qcard-points').textContent = info ? '' : `${fmt(p)} pt`;
      card.querySelector('[data-qc="up"]').disabled = i === 0;
      card.querySelector('[data-qc="down"]').disabled = i === cards.length - 1;
    });
    document.getElementById('qe-empty').hidden = cards.length > 0;
    document.getElementById('qe-summary').textContent = cards.length
      ? `${n} question${n === 1 ? '' : 's'} · ${fmt(points)} point${points === 1 ? '' : 's'}${cards.length > n ? ` · ${cards.length - n} information` : ''}`
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
    }
    refreshQuestions();
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
    if (e.target.matches('.q-opt-correct')) e.target.closest('.q-option').classList.toggle('is-correct', e.target.checked);
  }

  function onQuestionsInput(e) {
    if (S.section !== 'exams' || EX.view !== 'questions') return;
    if (e.target.matches('.q-prompt, .q-points')) refreshQuestions();
    e.target.classList.remove('field-error');
  }

  // In an option: Enter adds the next one, Backspace on an empty one removes it.
  function onQuestionsKeydown(e) {
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

  // Pasting several lines into an option makes one option per line ("a) ", "1. ", "- " dropped).
  function onQuestionsPaste(e) {
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
    if (action === 'preview') return previewQuestions(exam, collectQuestionCards({ strict: false }));
    if (action === 'export') return exportQuestionsJson(exam, collectQuestionCards({ strict: false }));
    if (action === 'import') return openImport(exam);
  }

  // A card's question as stored (only its type's fields).
  function readCard(card) {
    const get = sel => card.querySelector(sel);
    const type = card.dataset.type;
    const q = { type, prompt: get('.q-prompt').value.trim() };
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
      const problem = (selector, message) => {
        const el = card.querySelector(selector);
        el?.classList.add('field-error');
        if (!first) first = { card, el, message: `${label}: ${message}` };
      };
      if (!q.prompt) problem('.q-prompt', 'it needs text.');
      if (q.type !== 'text_only' && (num(card.querySelector('.q-points').value) ?? -1) < 0) problem('.q-points', 'points must be 0 or more.');
      if (q.type === 'multiple_select') {
        if (q.options.length < 2) problem('.q-options', 'it needs at least two options.');
        else if (new Set(q.options).size !== q.options.length) problem('.q-options', 'two options have the same text.');
        else if (!q.correct_answers.length) problem('.q-options', 'tick the correct option.');
      }
      if (q.type === 'numeric' && q.answer == null) problem('.q-answer', 'enter the correct answer as a number.');
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


  // ── Preview: the questions as students see them ──
  function previewQuestions(exam, questions) {
    const ov = overlay('q-preview');
    ov.title(`Preview: ${examTitle(exam)}`);
    let n = 0;
    const items = questions.map(q => {
      const info = q.type === 'text_only';
      const head = info ? '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>Information'
        : `<i class="fa-solid fa-circle-question" aria-hidden="true"></i>Question ${++n}<span class="qp-points">${fmt(q.points ?? 1)} ${q.points === 1 ? 'point' : 'points'}</span>`;
      let answer = '', key = '';
      if (q.type === 'multiple_select') {
        answer = `<div class="qp-options">${(q.options || []).map(o => `<label class="qp-option${(q.correct_answers || []).includes(o) ? ' is-correct' : ''}"><input type="radio" disabled><span>${x(o)}</span></label>`).join('')}</div>`;
      } else if (q.type === 'short_answer') {
        answer = '<input type="text" class="qp-input" disabled placeholder="Enter your answer">';
        if (q.accepted_answers?.length) key = `Accepted: ${q.accepted_answers.map(x).join(' · ')}`;
      } else if (q.type === 'numeric') {
        answer = `<div class="qp-numeric"><input type="text" class="qp-input" disabled placeholder="Enter a number">${q.unit ? `<span>${x(q.unit)}</span>` : ''}</div>`;
        if (q.answer != null) key = `Answer: ${exact(q.answer)}${q.tolerance ? ` ± ${exact(q.tolerance)}` : ''}${q.unit ? ` ${x(q.unit)}` : ''}`;
      } else if (q.type === 'long_answer') {
        answer = `<textarea class="qp-input" rows="4" disabled placeholder="Enter your detailed answer">${x(q.content || '')}</textarea>`;
      } else if (q.type === 'code') {
        answer = `<pre class="qp-code">${x(q.content || '# Your code')}</pre>`;
      } else if (q.type === 'attachment') {
        answer = `<div class="qp-file"><i class="fa-solid fa-paperclip" aria-hidden="true"></i>Choose a file${q.allowed_types?.length ? ` (${x(q.allowed_types.join(', '))})` : ''}${q.max_size_mb ? `, up to ${q.max_size_mb} MB` : ''}</div>`;
      }
      return `<div class="qp-q${info ? ' qp-info' : ''}"><div class="qp-head">${head}</div>
        <div class="qp-body"><div class="qp-prompt">${promptHtml(q.prompt) || '<em>No text yet</em>'}</div>${answer}
          ${key ? `<p class="qp-key">${key}</p>` : ''}${q.explanation ? `<p class="qp-key qp-explanation"><strong>Explanation:</strong> ${x(q.explanation)}</p>` : ''}</div></div>`;
    }).join('');
    ov.body.innerHTML = `<label class="exam-switch qp-toggle"><input type="checkbox" id="qp-answers"><span>Show answers</span></label>
      <div class="qp-list">${items || '<p class="builder-empty">No questions yet.</p>'}</div>`;
    ov.foot.innerHTML = '<button class="btn-secondary btn-sm" type="button" data-close>Close</button>';
    ov.body.querySelector('#qp-answers').onchange = e => ov.body.classList.toggle('qp-show-answers', e.target.checked);
    ov.body.classList.remove('qp-show-answers');
    ov.open();
  }

  // **bold** and line breaks, as students see them.
  function promptHtml(text) {
    return x(String(text || '')).replace(/\*\*\*(.*?)\*\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*\*(?!\*)(.*?)\*\*(?!\*)/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  }


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
    if (!prompt) return { error: 'no question text' };
    const q = { type, prompt };
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
- Write **like this** for bold. For a question that needs a figure, describe the figure or write [see figure].`;

  function exportQuestionsJson(exam, questions) {
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    const data = { format: 'syllabase-questions', version: 1, source: [header.code || EX.course, examTitle(exam)].filter(Boolean).join(' · '),
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
    ov.foot.innerHTML = `<button class="btn-secondary btn-sm" type="button" data-close>Cancel</button>
      <button class="btn-sm btn-green" type="button" id="qi-go" disabled><i class="fa-solid fa-file-import" style="margin-right:5px"></i>Import</button>`;
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
        <ol class="qi-list">${result.questions.map(q => `<li><i class="${QUESTION_TYPES[q.type].icon}" aria-hidden="true"></i><span>${x(q.prompt.split('\n')[0])}</span>${q.type !== 'text_only' ? `<em>${fmt(q.points)} pt</em>` : ''}</li>`).join('')}</ol>
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
    });
    document.getElementById('qi-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(CLAUDE_INSTRUCTIONS); toast('Instructions copied: paste them to Claude with the exam', 'ok'); }
      catch { toast('Could not copy', 'err'); }
    };
    document.getElementById('qi-go').onclick = async () => {
      if (!parsed?.questions?.length) return;
      const replace = document.querySelector('input[name="qi-mode"]:checked')?.value === 'replace' && questionCards().length;
      if (replace && !(await confirmDialog(`Replace the ${questionCards().length} current questions with the ${parsed.questions.length} imported ones?`, { title: 'Replace Questions', okLabel: 'Replace', danger: true }))) return;
      const list = document.getElementById('qe-list');
      if (replace) list.innerHTML = '';
      const many = parsed.questions.length + questionCards().length > 4;
      const added = parsed.questions.map(q => { const card = questionCard(q, { collapsed: many }); card.classList.add('is-new'); list.appendChild(card); return card; });
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
    body.onchange = body.oninput = body.onkeydown = body.onpaste = null;
    try {
      EX.submissions = await rpc('exam_submissions', { p_exam_id: examId });
    } catch (error) {
      toast(error.message, 'err');
      EX.submissions = [];
    }
    if (S.section !== 'exams' || EX.examId !== examId) return;
    renderSubmissions(body, exam);
  }

  function renderSubmissions(body, exam) {
    const anonymous = exam.sign_in === 'anonymous';
    const subs = sortedSubmissions(exam);
    const graded = subs.filter(s => s.status === 'graded').length;
    const expected = anonymous ? EX.data.codes.length : EX.data.students.length;
    const rows = subs.map(s => `<tr data-sub-id="${x(s.id)}">
        <td>${x(formatWhen(s.submitted_at))}${s.late ? ' <span class="badge exam-badge-late">Late</span>' : ''}${s.auto_submitted ? ' <span class="badge exam-badge-auto" title="Submitted automatically at the deadline">Auto</span>' : ''}</td>
        ${anonymous ? `<td class="exam-code-cell">${x(s.exam_code)}</td>`
        : `<td>${x(s.student_name)}</td><td>${x(shownNo(s.student_no))}</td><td>${x(s.student_email)}</td>`}
        <td>${s.status === 'graded' ? '<span class="badge exam-badge-graded">Graded</span>' : '<span class="badge exam-badge-submitted">Submitted</span>'}</td>
        <td>${s.grades ? `<strong>${x(gradeOnBase(s.grades, exam.base))}</strong> <span class="exam-muted">(${x(String(s.grades.totalScore ?? '?'))}/${x(String(s.grades.maxScore ?? '?'))})</span>` : '<span class="exam-muted">Not graded</span>'}</td>
        <td><button type="button" class="btn-secondary btn-sm" data-sub-action="answers"><i class="fa-solid fa-rectangle-list"></i> View</button></td>
        <td><button type="button" class="btn-secondary btn-sm" data-sub-action="fingerprint"><i class="fa-solid fa-fingerprint"></i> View</button></td>
        <td class="actions-cell">
          ${exam.questions?.length ? `<button type="button" class="btn-action-test" data-sub-action="grade" title="Grade" aria-label="Grade"><i class="fa-solid ${s.status === 'graded' ? 'fa-pen-to-square' : 'fa-square-check'}"></i></button>` : ''}
          ${canManage() ? '<button type="button" class="btn-action-del" data-sub-action="delete" title="Delete submission" aria-label="Delete submission"><i class="fa-solid fa-trash"></i></button>' : ''}
        </td></tr>`).join('');
    const columns = anonymous ? 7 : 9;
    body.innerHTML = `
      <div class="section-topbar" data-no-dirty>
        <button type="button" class="btn-sm btn-secondary" data-exam-action="back"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>All exams</button>
        <div class="add-bar">
          <button type="button" class="btn-sm btn-secondary" data-sub-action="refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
          <button type="button" class="btn-sm btn-secondary" data-sub-action="pdf-questions" ${exam.questions?.length ? '' : 'disabled'}><i class="fa-solid fa-file-pdf"></i> Questions</button>
          <button type="button" class="btn-sm btn-secondary" data-sub-action="zip" ${subs.length ? '' : 'disabled'}><i class="fa-solid fa-file-zipper"></i> Submissions</button>
          <button type="button" class="btn-sm btn-secondary" data-sub-action="pdf-grades" ${graded ? '' : 'disabled'}><i class="fa-solid fa-file-pdf"></i> Grades</button>
          <button type="button" class="btn-sm" data-sub-action="eis" ${graded ? '' : 'disabled'}><i class="fa-solid fa-copy"></i> Grades for EIS</button>
        </div>
      </div>
      <div class="exam-sub-head">
        <span class="exam-card-icon"><i class="${EXAM_TYPES[exam.type]?.icon || 'fa-solid fa-file-pen'}" aria-hidden="true"></i></span>
        <div><div class="exam-card-name">${x(examTitle(exam))}</div>
          <div class="exam-muted">${subs.length} submitted${expected ? ` of ${expected} ${anonymous ? 'exam IDs' : 'on the class list'}` : ''} · ${graded} graded${exam.results_published ? ' · grades visible' : ''}</div></div>
      </div>
      <div class="data-table-container" data-no-dirty>
        <table class="data-table">
          <thead><tr><th>Submitted</th>${anonymous ? '<th>Exam ID</th>' : '<th>Name</th><th>Student ID</th><th>Email</th>'}
            <th>Status</th><th>Grade</th><th>Answers</th><th>Fingerprint</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="${columns}" class="table-message">No submissions yet.</td></tr>`}</tbody>
        </table>
      </div>`;
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
      case 'fingerprint': return showInfo('Fingerprint', jsonListHtml(sub.fingerprint));
      case 'grade': return openGrading(exam, sub);
      case 'delete': return deleteSubmission(exam, sub);
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

  // Reloads counts and the submissions list after a change.
  async function refreshAfterChange(examId) {
    try { await loadCourse(EX.course, EX.isArchive); } catch { }
    if (S.section === 'exams' && EX.view === 'submissions') await showSubmissions(examId);
  }

  function showInfo(title, html) {
    const ov = overlay('exam-info');
    ov.title(title);
    ov.body.innerHTML = `<div class="formatted-content">${html}</div>`;
    ov.foot.innerHTML = '<button class="btn-secondary btn-sm" type="button" data-close>Close</button>';
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

  let _grading = null; // { exam, sub }

  function openGrading(exam, sub) {
    _grading = { exam, sub };
    const questions = exam.questions || [];
    const ov = overlay('exam-grade', { onClose: async () => { _grading = null; return true; } });
    ov.title(`Grade: ${sub.student_name || sub.exam_code || 'Submission'}`);
    let number = 0;
    const cards = questions.map((q, i) => {
      const n = i + 1;
      if (q.type === 'text_only') return `<div class="question-grading-card text-only-question" id="grading-q-${n}"><div class="text-content">${x(q.prompt || '')}</div></div>`;
      number++;
      const max = questionMaxPoints(q);
      const key = answerKey(q);
      return `<div class="question-grading-card ungraded" id="grading-q-${n}" data-q="${n}" data-max="${max}">
        <div class="question-prompt">Question ${number}: ${x(q.prompt || '')}</div>
        <span class="answer-label">Student answer</span>
        <div class="student-answer">${studentAnswerHtml(sub.answers?.[`ans-${n}`], q.type)}${q.type === 'numeric' && q.unit ? ` <span class="exam-muted">${x(q.unit)}</span>` : ''}</div>
        ${key ? `<span class="answer-label">${key.label}</span><div class="correct-answer">${key.html}</div>` : ''}
        <div class="form-group"><label for="comment-q-${n}">Comment</label>
          <textarea id="comment-q-${n}" rows="2" placeholder="Feedback for this question (optional)"></textarea></div>
        <div class="question-grading-controls">
          <div class="question-points"><label for="points-q-${n}">Points</label>
            <input type="number" id="points-q-${n}" min="0" max="${max}" step="0.1" data-grade-points><span>/ ${fmt(max)}</span></div>
          ${canAutograde(q) ? `<div class="grading-button-group">
            <button type="button" class="btn-sm btn-green" data-grade="correct"><i class="fa-solid fa-check"></i> Correct</button>
            <button type="button" class="btn-sm btn-red" data-grade="incorrect"><i class="fa-solid fa-xmark"></i> Incorrect</button>
            <button type="button" class="btn-sm btn-blue" data-grade="auto"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto</button></div>` : ''}
        </div></div>`;
    }).join('');
    ov.body.innerHTML = `
      <div class="grading-summary">
        <div class="grading-info">
          ${sub.exam_code ? `<p><strong>Exam ID:</strong> ${x(sub.exam_code)}</p>` : `<p><strong>Student:</strong> ${x(sub.student_name)} (${x([shownNo(sub.student_no), sub.student_email].filter(Boolean).join(', '))})</p>`}
          <p><strong>Exam:</strong> ${x(examTitle(exam))}</p>
          <p><strong>Submitted:</strong> ${x(formatWhen(sub.submitted_at))}${sub.late ? ' (late)' : ''}${sub.auto_submitted ? ' (automatically, at the deadline)' : ''}</p>
        </div>
        <div class="grading-score"><span class="form-label">Total</span>
          <div class="grading-score-row"><strong id="grading-total">0</strong> / ${fmt(totalPoints(questions))} points
            · grade <strong id="grading-base">0</strong> / ${fmt(exam.base)}</div></div>
      </div>
      <div class="grading-questions">${cards || '<p class="builder-empty">This exam has no questions.</p>'}</div>
      <div class="form-group"><label class="form-label" for="grading-feedback">Feedback to the student</label>
        <textarea id="grading-feedback" rows="3" placeholder="Overall feedback (optional)"></textarea></div>`;
    ov.foot.innerHTML = `<button class="btn-secondary btn-sm" type="button" data-close>Cancel</button>
      <button class="btn-sm btn-blue" type="button" id="grading-auto" ${questions.some(canAutograde) ? '' : 'disabled'}><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:5px"></i>Autograde</button>
      <button class="btn-sm btn-green" type="button" id="grading-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save grades</button>`;
    // Saved grades
    const g = sub.grades || {};
    document.getElementById('grading-feedback').value = g.feedback || '';
    for (const [qId, qGrade] of Object.entries(g.questionGrades || {})) {
      const n = parseInt(qId.slice(2), 10);
      const points = document.getElementById(`points-q-${n}`);
      if (points && qGrade.points !== '' && qGrade.points != null) points.value = qGrade.points;
      const comment = document.getElementById(`comment-q-${n}`);
      if (comment) comment.value = qGrade.comment || '';
      if (qGrade.status) setCardStatus(n, qGrade.status);
    }
    ov.body.onclick = onGradingClick;
    ov.body.oninput = e => { if (e.target.matches('[data-grade-points]')) updateGradingTotal(); };
    document.getElementById('grading-auto').onclick = () => {
      const n = autogradeAll();
      toast(n ? `Autograded ${n} question${n === 1 ? '' : 's'}; check the rest by hand` : 'No questions here can be autograded', n ? 'ok' : '');
    };
    document.getElementById('grading-save').onclick = saveGrades;
    updateGradingTotal();
    ov.open();
  }

  function studentAnswerHtml(answer, type) {
    if (answer === '[NOT CONFIRMED]') return '<em>Not confirmed before the deadline</em>';
    if (answer == null || answer === '') return '<em>No answer</em>';
    const text = String(answer);
    if (type === 'code') return `<div class="code-container"><button type="button" class="copy-btn" data-copy>Copy</button><pre class="code-snippet">${xh(text)}</pre></div>`;
    if (type === 'long_answer') return `<div class="text-container"><button type="button" class="copy-btn" data-copy>Copy</button><div class="long-answer-content">${xh(text)}</div></div>`;
    if (type === 'attachment' && text.startsWith('FILE_UPLOADED:')) return `<em>File:</em> ${x(text.slice(14))}`;
    return xh(text);
  }

  function setCardStatus(n, status) {
    const card = document.getElementById(`grading-q-${n}`);
    if (card) card.className = `question-grading-card ${status}`;
  }

  async function onGradingClick(e) {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const text = copy.parentElement.querySelector('.code-snippet, .long-answer-content').textContent;
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); } catch { }
      return;
    }
    const btn = e.target.closest('[data-grade]');
    const card = btn?.closest('[data-q]');
    if (!card) return;
    const n = parseInt(card.dataset.q, 10), max = parseFloat(card.dataset.max);
    if (btn.dataset.grade === 'correct') markQuestion(n, max, true);
    else if (btn.dataset.grade === 'incorrect') markQuestion(n, max, false);
    else if (!autogradeQuestion(n)) toast('This question cannot be autograded', 'err');
  }

  function markQuestion(n, max, correct) {
    document.getElementById(`points-q-${n}`).value = correct ? max : 0;
    setCardStatus(n, correct ? 'correct' : 'incorrect');
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

  const normalAnswer = text => String(text ?? '').trim().replace(/s+/g, ' ').toLowerCase();

  // Multiple choice: right when the chosen option is a correct one (its original position, when
  // recorded, survives the per-student shuffle). Short answer: one of the accepted answers,
  // ignoring capitals and spaces. Numeric: within the tolerance (a unit or comma is fine).
  function autogradeQuestion(n) {
    const q = _grading.exam.questions[n - 1];
    if (!canAutograde(q)) return false;
    const answers = _grading.sub.answers || {};
    const given = answers[`ans-${n}`];
    let right = false;
    if (q.type === 'multiple_select') {
      const index = answers[`ans-${n}_metadata`]?.originalIndex;
      const chosen = index != null && q.options?.[index] != null ? q.options[index] : given;
      right = q.correct_answers.includes(String(chosen ?? ''));
    } else if (q.type === 'short_answer') {
      right = q.accepted_answers.some(a => normalAnswer(a) === normalAnswer(given));
    } else {
      const value = num(String(given ?? '').match(/-?d+(?:[.,]d+)?(?:e-?d+)?/i)?.[0]);
      right = value != null && Math.abs(value - q.answer) <= (q.tolerance || 0) + 1e-9 * Math.max(1, Math.abs(q.answer));
    }
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
    document.querySelectorAll('#exam-grade-body [data-grade-points]').forEach(input => { total += parseFloat(input.value) || 0; });
    const max = totalPoints(_grading.exam.questions);
    document.getElementById('grading-total').textContent = fmt(total);
    document.getElementById('grading-base').textContent = fmt(max > 0 ? total / max * (parseFloat(_grading.exam.base) || 100) : 0);
    return { total, max };
  }

  // Graded once every question has points; partial grading and comments are kept either way.
  async function saveGrades() {
    const { exam, sub } = _grading;
    const questions = exam.questions || [];
    const { total, max } = updateGradingTotal();
    const questionGrades = {};
    let allFilled = true;
    questions.forEach((q, i) => {
      const n = i + 1;
      if (q.type === 'text_only') { questionGrades[`q-${n}`] = { points: '', status: 'confirmed', comment: '' }; return; }
      const input = document.getElementById(`points-q-${n}`);
      const card = document.getElementById(`grading-q-${n}`);
      const raw = input.value.trim();
      if (raw === '') allFilled = false;
      const points = raw === '' ? '' : parseFloat(raw);
      let status = ['correct', 'incorrect', 'partial'].find(c => card.classList.contains(c)) || 'ungraded';
      if (status === 'ungraded' && points !== '') {
        const qMax = questionMaxPoints(q);
        status = points === 0 ? 'incorrect' : points >= qMax ? 'correct' : 'partial';
      }
      questionGrades[`q-${n}`] = { points, status, comment: document.getElementById(`comment-q-${n}`).value.trim() };
    });
    const grades = {
      totalScore: total.toFixed(1), maxScore: max,
      percentage: `${(max > 0 ? total / max * 100 : 0).toFixed(1)}%`,
      feedback: document.getElementById('grading-feedback').value.trim(),
      gradedAt: new Date().toISOString(), gradedBy: S.access?.email || '',
      questionGrades,
    };
    const btn = document.getElementById('grading-save');
    btn.disabled = true;
    try {
      await rpc('exam_save_grades', { p_submission_id: sub.id, p_grades: grades, p_status: allFilled ? 'graded' : 'submitted' });
      toast(allFilled ? 'Graded' : 'Saved; some questions still have no points', 'ok');
      overlay('exam-grade').close();
      _grading = null;
      await refreshAfterChange(exam.id);
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
    } finally {
      btn.disabled = false;
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
    ov.foot.innerHTML = `<button class="btn-secondary btn-sm" type="button" data-close>Close</button>
      <button class="btn-sm btn-secondary" type="button" data-eis-copy="both"><i class="fa-solid fa-copy" style="margin-right:5px"></i>Copy ${anonymous ? 'IDs' : 'students'} and grades</button>
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
        w.write(q.prompt || '', { x: 18 });
        if (q.content) w.write(`Starting text: ${q.content}`, { x: 18, size: 9, style: 'italic', color: [90, 90, 90] });
        if (q.type === 'multiple_select') (q.options || []).forEach(option => {
          const right = (q.correct_answers || []).includes(option);
          w.write(`${right ? '[correct]' : '-'} ${option}`, { x: 21, size: 9, style: right ? 'bold' : 'normal', color: right ? [6, 95, 70] : [33, 33, 33], gap: 0.5 });
        });
        const key = q.type === 'multiple_select' ? null : answerKey(q);
        if (key) w.write(`${key.label}: ${key.html.replace(/<br>/g, ' · ').replace(/&[^;]+;/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m] || m))}`,
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
    if (sub.grades) w.write(`Grade: ${gradeOnBase(grades, exam.base)}  (${grades.totalScore}/${grades.maxScore} points)`, { size: 11, style: 'bold', color: [6, 95, 70], gap: 4 });
    let number = 0;
    questions.forEach((q, i) => {
      if (q.type === 'text_only') return;
      number++;
      const n = i + 1;
      const qGrade = grades.questionGrades?.[`q-${n}`] || {};
      w.write(`Question ${number}: ${q.prompt || ''}`, { style: 'bold', color: [55, 65, 81], gap: 1 });
      const answer = sub.answers?.[`ans-${n}`];
      w.write(answer == null || answer === '' ? 'No answer' : String(answer), { x: 18, style: answer ? 'normal' : 'italic' });
      if (qGrade.points !== '' && qGrade.points != null) w.write(`Score: ${qGrade.points}/${fmt(questionMaxPoints(q))} (${qGrade.status || 'graded'})`, { x: 18, size: 9, style: 'bold', color: [57, 73, 171], gap: 0.5 });
      if (qGrade.comment) w.write(`Comment: ${qGrade.comment}`, { x: 18, size: 9, style: 'italic', color: [100, 100, 100] });
      w.y += 3;
    });
    if (grades.feedback) { w.write('Feedback', { size: 11, style: 'bold' }); w.write(grades.feedback); }
    return doc.output('blob');
  }

  async function exportSubmissionsZip(exam) {
    const subs = sortedSubmissions(exam);
    if (!subs.length) return;
    try {
      toast(`Preparing ${subs.length} PDF${subs.length === 1 ? '' : 's'}…`);
      await loadScript(LIBS.jszip);
      const zip = new window.JSZip();
      for (const sub of subs) {
        zip.file(`${slug(examTitle(exam))}_${slug(sub.exam_code || `${sub.student_no}_${sub.student_name}`, true)}.pdf`, await submissionPdfBlob(exam, sub));
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${slug(EX.course)}_${slug(examTitle(exam))}_submissions.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      toast('Submissions exported', 'ok');
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
      w.write(`${typeLabel(exam.type)}${exam.starts_at ? `, ${formatWhen(exam.starts_at)}` : ''} · base ${fmt(exam.base)}${exam.weight != null ? ` · ${fmt(exam.weight)}% of grade` : ''} · generated ${new Date().toLocaleDateString('en-GB')}`, { size: 9, color: [100, 100, 100], gap: 4 });
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
    const ids = new Set(EX.data.students.map(s => s.id));
    [..._selected].forEach(id => { if (!ids.has(id)) _selected.delete(id); });
    renderStudents(body);
    finishSectionLoad(body);
    updateSelection();
  }

  function renderStudents(body) {
    const { students, codes } = EX.data;
    const manage = canManage();
    body.innerHTML = `
      <div class="section-topbar">
        <span class="exam-topbar-note"><i class="fa-solid fa-users" aria-hidden="true"></i><strong>${students.length}</strong> student${students.length === 1 ? '' : 's'} · <strong>${codes.length}</strong> exam ID${codes.length === 1 ? '' : 's'}</span>
        <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      </div>
      ${archivedNote()}
      <div class="settings-panel">

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
              <tbody id="student-rows">${students.map((s, i) => studentRowHtml(s, i)).join('')}</tbody></table></div>
            <p class="form-hint student-tip">Click a row to select it; Ctrl or Shift selects several, Ctrl+A all of them.</p>`
        : '<p class="form-hint">No students yet. Paste the class list from EIS below.</p>'}
          </div>
        </div>

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
    }
  }

  function studentRowHtml(s, i) {
    return `<tr data-student-id="${x(s.id)}" data-search="${x([s.student_no, s.full_name, s.email, s.programme, s.exam_code, s.note].join(' ').toLowerCase())}">
      <td class="select-cell"><input type="checkbox" class="row-check" aria-label="Select ${x(s.full_name || s.student_no)}"></td>
      <td>${i + 1}.</td><td>${x(s.student_no)}</td><td>${x(s.full_name)}</td><td>${x(s.email)}</td>
      <td>${x(s.programme)}</td><td class="exam-code-cell">${x(s.exam_code)}</td>
      <td>${s.note ? `<span class="badge exam-badge-note">${x(s.note)}</span>` : ''}</td>
      ${canManage() ? `<td class="actions-cell"><button type="button" class="btn-action-test" data-edit-student title="Edit" aria-label="Edit ${x(s.full_name)}"><i class="fa-solid fa-pen-to-square"></i></button></td>` : ''}</tr>`;
  }

  // ── Selecting students ──
  const visibleRows = () => [...document.querySelectorAll('#student-rows tr')].filter(tr => !tr.hidden);
  const selectedStudents = () => EX.data.students.filter(s => _selected.has(s.id));

  function updateSelection() {
    const rows = [...document.querySelectorAll('#student-rows tr')];
    if (!rows.length) return;
    rows.forEach(tr => {
      const on = _selected.has(tr.dataset.studentId);
      tr.classList.toggle('is-selected', on);
      tr.setAttribute('aria-selected', String(on));
      tr.querySelector('.row-check').checked = on;
    });
    const visible = visibleRows();
    const all = visible.length > 0 && visible.every(tr => _selected.has(tr.dataset.studentId));
    const checkAll = document.getElementById('students-check-all');
    checkAll.checked = all;
    checkAll.indeterminate = !all && visible.some(tr => _selected.has(tr.dataset.studentId));
    const n = _selected.size;
    document.getElementById('student-selection').textContent = n ? `${n} selected` : '';
    const allBtn = document.querySelector('[data-sel="all"] span');
    if (allBtn) allBtn.textContent = all ? 'Select none' : 'Select all';
    document.querySelectorAll('[data-sel="edit"], [data-sel="delete"]').forEach(b => { b.disabled = !n; });
  }

  function selectAll(on = true) {
    if (on) visibleRows().forEach(tr => _selected.add(tr.dataset.studentId));
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
      const rows = visibleRows().map(r => r.dataset.studentId);
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
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#student-rows tr').forEach(tr => {
      tr.hidden = !!q && !tr.dataset.search.includes(q);
      if (tr.hidden) _selected.delete(tr.dataset.studentId); // act only on what is on screen
    });
    updateSelection();
  }

  function onStudentToolbar(e) {
    const action = e.target.closest('[data-sel]')?.dataset.sel;
    if (action === 'all') selectAll(!visibleRows().every(tr => _selected.has(tr.dataset.studentId)));
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
    ov.foot.innerHTML = `<button class="btn-secondary btn-sm" type="button" data-close><i class="fa-solid fa-xmark" style="margin-right:5px"></i>Cancel</button>
      <button class="btn-sm btn-green" type="button" id="student-edit-save"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>`;
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
      <button class="btn-secondary btn-sm" type="button" data-close><i class="fa-solid fa-xmark" style="margin-right:5px"></i>Cancel</button>
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
    lockHeight(document.getElementById('section-body'));
    await loadStudentsSection();
    if (S.section !== 'students') return;
    for (const [id, value] of keep) { const el = document.getElementById(id); if (el && value) el.value = value; }
    if (keep[0][1]) previewStudents();
    if (keep[1][1]) previewCodes();
    for (const [id, on] of checks) { const el = document.getElementById(id); if (el && on != null) el.checked = on; }
    const search = document.getElementById('students-search');
    if (search?.value) filterStudents({ target: search });
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
    if (flags) { note = [flags[0].trim(), note].filter(Boolean).join(' · '); name = name.slice(0, flags.index).trim(); }
    // Names have letters, and no digits, '@' or ':'. Without tabs, a row number or an ID to show
    // this is a student row, it takes two words, so a stray "Contact: …" line is not a student.
    if (!/\p{L}/u.test(name) || /[\d@:]/.test(name) || name.length > 80) return null;
    if (!(tabbed || numbered || no) && name.split(' ').length < 2) return null;
    const programme = after.join(' ').replace(ATTENDANCE_RE, '').replace(/\s+/g, ' ').trim();
    return { student_no: no, full_name: name, email, programme, note };
  }

  // A pasted student is someone already on the list with the same student ID or email.
  const sameStudent = (s, p) => (p.student_no && s.student_no === p.student_no) || s.email === p.email;

  function previewStudents() {
    const text = document.getElementById('classlist-paste').value;
    const preview = document.getElementById('classlist-preview');
    if (!text.trim()) { _pastedStudents = []; preview.innerHTML = ''; return; }
    const { students, skipped } = parseClassList(text);
    const unique = [...new Map(students.map(s => [s.email, s])).values()];
    _pastedStudents = unique;
    const isExisting = p => EX.data.students.some(s => sameStudent(s, p));
    const added = unique.filter(p => !isExisting(p)).length;
    const missing = unique.length ? EX.data.students.filter(s => !unique.some(p => sameStudent(s, p))) : [];
    preview.innerHTML = `
      <p class="paste-summary ${unique.length ? '' : 'exam-error'}"><strong>${unique.length}</strong> student${unique.length === 1 ? '' : 's'} found${unique.length ? ` · ${added} new · ${unique.length - added} updated` : ' (each needs a name and an email)'}
        ${skipped.length ? ` · <span class="exam-error">${skipped.length} line${skipped.length === 1 ? '' : 's'} not understood</span>` : ''}</p>
      <p class="paste-conflicts exam-error"></p>
      ${missing.length ? `<label class="exam-inline-check"><input type="checkbox" id="classlist-remove-missing">
        Remove the ${missing.length} student${missing.length === 1 ? '' : 's'} not in this paste (${missing.slice(0, 4).map(s => x(s.full_name || s.student_no)).join(', ')}${missing.length > 4 ? ', …' : ''})</label>` : ''}
      ${unique.length ? `<div class="data-table-container"><table class="data-table classlist-table"><thead><tr><th>Student ID</th><th>Name</th><th>Email</th><th>Programme</th><th>Note</th><th></th></tr></thead><tbody>
        ${unique.map(s => `<tr data-email="${x(s.email)}"><td>${x(s.student_no)}</td><td>${x(s.full_name)}</td><td>${x(s.email)}</td>
          <td>${x(s.programme)}</td><td>${s.note ? `<span class="badge exam-badge-note">${x(s.note)}</span>` : ''}</td>
          <td>${isExisting(s) ? '<span class="badge exam-badge-submitted">Update</span>' : '<span class="badge exam-badge-graded">New</span>'}<div class="paste-issue"></div></td></tr>`).join('')}
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
      tr.querySelector('.paste-issue').innerHTML = notes.map(([cls, text]) => `<span class="${cls}">${x(text)}</span>`).join('<br>');
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
    examGradingLinks, applyGradingLocks, followGradingKeys });
})();
