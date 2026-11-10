// Course editor: the Exams and Students tabs.
// Exams: label, type, time, hall, weight (from the Weights tab), base, sign-in, questions;
// then submissions, grading, exports and grades for EIS. Students: the class list pasted from
// EIS and the anonymous exam IDs. Everything goes through the
// exam_* database functions, which check permissions themselves. Load after
// js/course-editor.js, whose helpers (sb, S, x, toast, confirmDialog, finishSectionLoad,
// GRADING_CATEGORIES, gradingEntriesFor…) this uses.
(function () {
  'use strict';

  // In the order they come in a semester (the Type list's order), Other last.
  const EXAM_TYPES = {
    quiz: { label: 'Quiz', icon: 'fa-solid fa-question' },
    assignment: { label: 'Assignment', icon: 'fa-solid fa-book' },
    project: { label: 'Project', icon: 'fa-solid fa-diagram-project' },
    midterm_exam: { label: 'Midterm Exam', icon: 'fa-solid fa-pen-to-square', anonymous: true },
    midterm_project: { label: 'Midterm Project', icon: 'fa-solid fa-diagram-project' },
    final_exam: { label: 'Final Exam', icon: 'fa-solid fa-graduation-cap', anonymous: true },
    final_project: { label: 'Final Project', icon: 'fa-solid fa-diagram-project' },
    resit_exam: { label: 'Resit Exam', icon: 'fa-solid fa-rotate', anonymous: true },
    additional_exam: { label: 'Additional Exam', icon: 'fa-solid fa-plus', anonymous: true },
    other: { label: 'Other', icon: 'fa-solid fa-ellipsis' },
  };
  // The exam type an assessment from the Weights tab suggests, by its category.
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
    return 'With the exam password, from an hour before the start until the end; not once a student has submitted. It opens this exam only.';
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
  // Question types as stored (and as the student page renders them), in the editor's order:
  // information, then those graded automatically, then those graded by hand.
  const QUESTION_TYPES = {
    text_only: { label: 'Information', icon: 'fa-solid fa-circle-info', hint: 'Instructions or a heading, not graded' },
    multiple_select: { label: 'Multiple choice', icon: 'fa-solid fa-list-ul', hint: 'One of several options' },
    true_false: { label: 'True or false', icon: 'fa-solid fa-circle-half-stroke', hint: 'A statement to mark True or False' },
    short_answer: { label: 'Short answer', icon: 'fa-solid fa-font', hint: 'A word or phrase, checked automatically' },
    numeric: { label: 'Numeric', icon: 'fa-solid fa-calculator', hint: 'A number, with a tolerance and a unit' },
    long_answer: { label: 'Long answer', icon: 'fa-solid fa-paragraph', hint: 'Written text, graded by hand' },
    code: { label: 'Code', icon: 'fa-solid fa-code', hint: 'Code in an editor, graded by hand' },
    attachment: { label: 'File upload', icon: 'fa-solid fa-paperclip', hint: 'A file, such as a drawing' },
  };
  // Each question keeps a short id: answers, grades and files follow it when questions are
  // added, removed or moved, also while students take the exam (exam_save_questions).
  const newQuestionId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`)
    .replace(/-/g, '').slice(0, 12);
  const IMAGE_SIZES = { small: 'S', medium: 'M', large: 'L', full: 'Full width' };
  const typeLabel = type => EXAM_TYPES[type]?.label || 'Exam';
  const examTitle = exam => exam.label || typeLabel(exam.type);

  // Question pools: the course keeps one pool of questions for every semester, each assigned
  // to a module (by its title). An exam draws from it with a pool item among its questions,
  // { type: 'pool', id, count, points, modules, kinds, exclude }: count questions of those
  // modules and types (all when none are chosen), leaving out those in exclude, worth points
  // each. Every student draws their own (exam_private.draw_pool). Questions that share an
  // "apart" (linked: alike, or giving each other away) never come together for one student.
  const POOL_ICON = 'fa-solid fa-layer-group';
  const isPoolItem = q => q?.type === 'pool';
  const hasPool = questions => (questions || []).some(isPoolItem);
  const poolCount = item => Math.max(0, Math.min(100, Math.floor(Number(item?.count) || 0)));
  // How many questions a list stands for: a pool item counts as many as it draws.
  const questionCount = questions => (questions || []).reduce((n, q) => n + (isPoolItem(q) ? poolCount(q) : q.type === 'text_only' ? 0 : 1), 0);
  const NO_MODULE = 'No module';
  const NL = '\n';

  // The course offering on screen and what exam_course returned for it.
  // images: question images by id (data URLs), loaded per exam as needed. pool: the course's
  // question pool ({ course, questions }), modules: the Modules tab's titles, in its order.
  const EX = { course: null, isArchive: false, access: null, data: null, grading: [], view: 'list', examId: null, submissions: [], images: {},
    pool: null, modules: [], sample: 1 };
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

  // The course's Weights tab entries with a weight, e.g. "Midterm 1 — 40%". Attendance is no exam.
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
    if (EX.course !== course || EX.isArchive !== isArchive) Object.assign(EX, { view: 'list', examId: null, submissions: [], images: {}, pool: null, modules: [], sample: 1 });
    Object.assign(EX, { course, isArchive, access: data.access, data, grading: gradingEntries(meta) });
    ensureGradingDone(meta);
    return data;
  }

  // The course's question pool and the Modules tab's module titles (highest Order first, as on
  // the course page). Without the pool functions installed, there is no pool (null).
  async function fetchPool(course, isArchive) {
    const [pool, modules] = await Promise.all([
      rpc('exam_pool', { p_sheet: course, p_archive: isArchive }).catch(() => null),
      sb.from('course_rows').select('b,c,row_index').eq('sheet_name', course).eq('is_archive', isArchive).eq('type', 'module').order('row_index')
        .then(r => (r.error ? [] : r.data || []), () => []),
    ]);
    return { course, isArchive, pool, modules };
  }
  function applyPool({ course, isArchive, pool, modules }) {
    if (EX.course !== course || EX.isArchive !== isArchive) return;
    EX.pool = pool ? { course: pool.course, questions: Array.isArray(pool.questions) ? pool.questions : [], updated_at: pool.updated_at } : null;
    EX.modules = [...modules].sort((a, b) => (parseFloat(b.b) || 0) - (parseFloat(a.b) || 0))
      .map(r => String(r.c || '').replace(/<[^>]+>/g, '').trim()).filter((t, i, all) => t && all.indexOf(t) === i);
  }
  async function loadPool() {
    applyPool(await fetchPool(EX.course, EX.isArchive));
    return EX.pool;
  }

  // The pool's images, fetched once.
  async function loadPoolImages() {
    if (!EX.pool || !allImageIdsOf(EX.pool.questions).some(id => !(id in EX.images))) return;
    _imagesLoading++;
    try { Object.assign(EX.images, await rpc('exam_pool_images', { p_sheet: EX.course, p_archive: EX.isArchive })); }
    catch (error) { toast(`The pool's images did not load: ${error.message}`, 'err'); }
    finally { _imagesLoading--; }
  }

  // Modules to sort the pool by: the course's, then others its questions name (from another
  // semester), then questions without one.
  function poolModules(questions = EX.pool?.questions || []) {
    const named = questions.map(q => String(q.module || '').trim()).filter(Boolean);
    const list = [...EX.modules, ...named.filter((m, i) => named.indexOf(m) === i && !EX.modules.includes(m))];
    if (questions.some(q => !String(q.module || '').trim())) list.push('');
    return list;
  }
  const moduleLabel = m => m || NO_MODULE;

  // The pool's questions a pool item can draw (as exam_private.pool_candidates), and those its
  // modules and types allow before any are left out.
  function poolFits(item, pool = EX.pool?.questions || []) {
    const modules = item.modules || [], kinds = item.kinds || [];
    return pool.filter(q => q?.id && QUESTION_TYPES[q.type] && q.type !== 'text_only'
      && (!modules.length || modules.includes(String(q.module || '').trim())) && (!kinds.length || kinds.includes(q.type)));
  }
  const poolCandidates = item => poolFits(item).filter(q => !(item.exclude || []).includes(q.id));
  // The most a pool item can draw: one of each linked set.
  function poolMost(item) {
    const candidates = poolCandidates(item);
    return candidates.filter(q => !q.apart).length + new Set(candidates.filter(q => q.apart).map(q => q.apart)).size;
  }

  // A string's hash, for an order of draws of its own per sample student.
  function hashOf(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // What sample student n would draw for each pool item of these questions, as
  // exam_private.draw_pool does: a question once in the exam and one of a linked set at most
  // (each unlinked question, and each linked set, a "unit" for one item). The items with the
  // least room first; then, for an item still short, units move between items along an
  // augmenting path, so every item gets its count whenever the pool can give it.
  const poolRoom = item => poolMost(item) - poolCount(item);
  const unitOf = q => (q.apart ? `apart:${q.apart}` : `id:${q.id}`);
  function sampleDraws(questions, n = EX.sample) {
    const items = [];
    for (const item of questions.filter(isPoolItem)) if (item.id && !items.some(i => i.id === item.id)) items.push(item);
    const elig = new Map(items.map(item => [item.id, poolCandidates(item)
      .map(q => ({ u: unitOf(q), q, key: hashOf(`${n}:${item.id}:${q.id}`) })).sort((a, b) => a.key - b.key)]));
    const want = new Map(items.map(item => [item.id, poolCount(item)]));
    const have = new Map(items.map(item => [item.id, 0]));
    const owner = new Map(); // unit → { i: item id, q }
    const take = (id, e) => { owner.set(e.u, { i: id, q: e.q }); have.set(id, have.get(id) + 1); };
    const byRoom = items.map((item, k) => [item, poolRoom(item), k]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([item]) => item);
    for (const item of byRoom) {
      for (const e of elig.get(item.id)) {
        if (have.get(item.id) >= want.get(item.id)) break;
        if (!owner.has(e.u)) take(item.id, e);
      }
    }
    for (const item of items) {
      while (have.get(item.id) < want.get(item.id)) {
        const queue = [item.id], seen = new Set([item.id]), parent = new Map();
        let found = null;
        while (queue.length && !found) {
          const cur = queue.shift();
          for (const e of elig.get(cur)) {
            if (!owner.has(e.u)) { found = { i: cur, u: e.u, q: e.q }; break; }
            const next = owner.get(e.u).i;
            if (seen.has(next)) continue;
            seen.add(next);
            parent.set(next, { i: cur, u: e.u, q: e.q });
            queue.push(next);
          }
        }
        if (!found) break; // the pool has no more to give
        let cur = found.i;
        owner.set(found.u, { i: cur, q: found.q });
        while (cur !== item.id) {
          const step = parent.get(cur);
          owner.set(step.u, { i: step.i, q: step.q });
          cur = step.i;
        }
        have.set(item.id, have.get(item.id) + 1);
      }
    }
    const draws = {};
    for (const item of items) draws[item.id] = elig.get(item.id).filter(e => owner.get(e.u)?.i === item.id && owner.get(e.u).q.id === e.q.id).map(e => e.q);
    return draws;
  }
  // Whether the pool can't give an item its count once the other items (and links) have theirs:
  // how many it would get, or null when it gets them all. The draw gives every student the most
  // the pool can, so one draw tells; worked out once per refresh of the questions.
  let _shortfalls = null;
  function poolShortfall(item) {
    if (!_shortfalls) {
      _shortfalls = {};
      const items = editorPoolItems();
      if (items.length) {
        const draws = sampleDraws(items, 1);
        items.forEach(it => { const got = (draws[it.id] || []).length; if (got < poolCount(it)) _shortfalls[it.id] = got; });
      }
    }
    return _shortfalls[item.id] ?? null;
  }

  // The questions with each pool item replaced by what it drew (exam_private.drawn_questions).
  function drawnQuestions(questions, draws) {
    return (questions || []).flatMap(q => (!isPoolItem(q) ? [q] : (draws[q.id] || []).map(({ module, apart, points, ...c }) =>
      ({ ...c, id: `${q.id}-${c.id}`, points: questionMaxPoints(q), pool: { item: q.id, id: c.id, module: module || '' } }))));
  }
  // The questions a submission had: with pool items, its own (exam_submissions sends them); a
  // grade-only entry then has none (graded as a whole, as on paper).
  function subQuestions(exam, sub) {
    if (!hasPool(exam?.questions)) return exam?.questions || [];
    if (!sub || sub.source === 'manual') return [];
    return Array.isArray(sub.questions) ? sub.questions : drawnQuestions(exam.questions, {});
  }

  // ── Weights tab: an assessment whose exam grades are visible is Done, and locked ──
  // Marks the Weights tab entries Done (as its own Save does), or back to not done when grades
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
    if (keys.length) markGradingDone(EX.course, EX.isArchive, keys).catch(error => console.warn('Could not mark the Weights tab entries Done.', error));
  }

  // For the Weights tab (course-editor.js): which entries exams count as. [] without the
  // exam functions or access.
  async function examGradingLinks(course, isArchive) {
    try {
      const { data, error } = await sb.rpc('exam_grading_links', { p_sheet: course, p_archive: isArchive });
      return error || !Array.isArray(data) ? [] : data;
    } catch { return []; }
  }

  // Locks the Weights tab's Done (and Remove) for entries whose exam grades are visible.
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

  // After the Weights tab saves: exams follow entries that were renumbered or removed.
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
      const [, pool] = await Promise.all([loadCourse(course, isArchive), fetchPool(course, isArchive)]);
      applyPool(pool);
    } catch (error) {
      if (!isStale(course, isArchive, 'exams')) sectionError(body, error);
      return;
    }
    if (isStale(course, isArchive, 'exams')) return;
    // Left the grading page another way (Settings, then back): its grades list.
    if (EX.view === 'grading') { _grading = null; EX.view = 'submissions'; }
    if (EX.view === 'pool' && EX.pool && canManage()) return showPool(body);
    if (EX.view === 'questions' && examById(EX.examId) && canManage()) return showQuestions(EX.examId, body);
    if (EX.view === 'submissions' && examById(EX.examId)) await showSubmissions(EX.examId, body);
    else if (EX.view === 'stats' && examById(EX.examId) && canManage()) await showStats(EX.examId, body);
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
          Exams carry <strong>${fmt(totalWeight)}%</strong> of the grade${gradingTotal ? `; the Weights tab lists ${fmt(gradingTotal)}%` : ''}</span>
        <div class="add-bar">
          ${canManage() && EX.pool ? `<button class="btn-sm btn-secondary" type="button" data-exam-action="pool" title="The course's questions for every semester, by module. Exams draw from them."><i class="${POOL_ICON}" style="margin-right:6px"></i>Question pool <span class="exam-count">${EX.pool.questions.length}</span></button>` : ''}
          ${canManage() ? '<button class="btn-sm btn-green" type="button" data-exam-action="new"><i class="fa-solid fa-plus" style="margin-right:6px"></i>New exam</button>' : ''}
        </div>
      </div>
      ${archivedNote()}
      ${exams.length ? `<div class="exam-table" role="table" aria-label="Exams" data-no-dirty>
        <div class="exam-table-head" role="row">
          <span role="columnheader">Status</span><span role="columnheader">Exam</span><span role="columnheader">Date and place</span>
          <span role="columnheader">Submitted</span><span role="columnheader">Published</span><span role="columnheader">Grades released</span>
          <span role="columnheader"><span class="sr-only">Actions</span></span>
        </div>
        ${exams.map(examCardHtml).join('')}
      </div>` : `<div class="empty-content" data-no-dirty>No exams yet.${canManage() ? ' Add one with <strong>New exam</strong>.' : ''}</div>`}`;
    body.onclick = onExamsClick;
    body.onchange = onExamsChange;
    body.oninput = body.onkeydown = body.onpaste = body.ondragover = body.ondragleave = body.ondrop = null;
  }

  // One row an exam, its columns lined up with the others': where it stands (a pill), the name
  // with what it is under it, when and where, how many submitted and are left to grade, the two
  // switches that reach students, then one action for where the exam is: Questions before it
  // takes place, Grades from then on; ⋯ has the rest. A click anywhere else on the row does the
  // same as the action.
  function examCardHtml(exam) {
    const count = questionCount(exam.questions);
    const settings = settingsOf(exam);
    const about = [typeLabel(exam.type)];
    if (exam.weight != null) about.push(`${fmt(exam.weight)}%`);
    if (fmt(exam.base) !== '100') about.push(`out of ${fmt(exam.base)}`);
    about.push(count ? `${count} question${count === 1 ? '' : 's'}` : 'on paper');
    if (count && signInOf(exam) === 'anonymous') about.push('exam IDs');
    const when = exam.starts_at ? listWhen(exam.starts_at, settings.date_only) : 'No date yet';
    const status = examStatus(exam);
    const where = [relativeWhen(exam, status), exam.duration_minutes && `${exam.duration_minutes} min`, exam.hall].filter(Boolean);
    const noPassword = canManage() && needsPassword(signInOf(exam)) && count && !['ended', 'released'].includes(status.key) && !exam.has_password;
    const anonymous = signInOf(exam) === 'anonymous';
    const expected = anonymous ? EX.data.codes.length : EX.data.students.length;
    const toGrade = exam.submission_count - exam.graded_count;
    // Before it takes place (and nothing submitted), the questions are what there is to do.
    const before = canManage() && !exam.submission_count && (!exam.starts_at || Date.parse(exam.starts_at) > Date.now());
    const menu = canManage() ? [
      { label: 'Questions', icon: 'fa-solid fa-list-check', attrs: 'data-exam-action="questions"' },
      { label: 'Grades', icon: 'fa-solid fa-marker', attrs: 'data-exam-action="submissions"' },
      { label: 'Statistics', icon: 'fa-solid fa-chart-column', attrs: 'data-exam-action="stats"', disabled: !exam.submission_count, title: 'How the grades spread, and how each question went' },
      { label: 'Preview as a student', icon: 'fa-solid fa-eye', attrs: 'data-exam-action="try"', disabled: !count, title: 'Each time another student: their own order and draw' },
      { label: 'Settings', icon: 'fa-solid fa-gear', attrs: 'data-exam-action="edit"', title: 'Date, sign-in, password, leaving the page' },
      { separator: true },
      { label: 'Exam paper (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-exam-action="paper"', disabled: !count, title: 'To print, with or without the answers' },
      { label: 'Duplicate', icon: 'fa-solid fa-copy', attrs: 'data-exam-action="duplicate"' },
      { separator: true },
      { label: 'Delete', icon: 'fa-solid fa-trash', danger: true, attrs: 'data-exam-action="delete"' },
    ] : [];
    const action = before
      ? `<button type="button" class="row-act ${count ? 'is-edit' : 'is-add'}" data-exam-action="questions" title="${count ? 'Its questions' : 'Add its questions, or hold it on paper'}"><i class="fa-solid ${count ? 'fa-list-check' : 'fa-plus'}" aria-hidden="true"></i><span>${count ? 'Questions' : 'Add questions'}</span>${count ? `<span class="row-act-count">${count}</span>` : ''}</button>`
      : `<button type="button" class="row-act ${toGrade > 0 ? 'is-todo' : 'is-done'}" data-exam-action="submissions" title="${toGrade > 0 ? `${toGrade} to grade` : 'Submissions and grades'}"><i class="fa-solid fa-marker" aria-hidden="true"></i><span>Grades</span>${toGrade > 0 ? `<span class="row-act-count">${toGrade}</span>` : ''}</button>`;
    const flag = (name, on, label, title) => `<label class="exam-switch" title="${x(title)}"><input type="checkbox" data-flag="${name}" ${on ? 'checked' : ''} ${canManage() ? '' : 'disabled'}><span class="exam-item-flag-label">${label}</span></label>`;
    return `<article class="exam-item${exam.visible ? '' : ' is-draft'}" data-exam-id="${x(exam.id)}" data-row-action="${before ? 'questions' : 'submissions'}" role="row">
      <div class="exam-item-state" role="cell"><span class="exam-status exam-status-${status.key}">${x(status.label)}</span></div>
      <div class="exam-item-name" role="cell">
        <span class="exam-item-title">${x(examTitle(exam))}</span>
        <span class="exam-item-sub">${x(about.join(', '))}</span>
      </div>
      <div class="exam-item-when" role="cell"><span>${x(when)}</span>${where.length ? `<span class="exam-item-sub">${x(where.join(', '))}</span>` : ''}</div>
      <div class="exam-item-count" role="cell" title="Submitted, of ${expected} ${anonymous ? 'exam IDs' : 'students'}">
        ${before ? '<span class="exam-muted">None yet</span>' : `<span><strong>${exam.submission_count}</strong>${expected ? `<span class="exam-muted"> / ${expected}</span>` : ''}</span>`}
        ${toGrade > 0 ? `<span class="exam-item-sub is-todo">${toGrade} to grade</span>` : ''}</div>
      <div class="exam-item-flag" role="cell">${flag('visible', exam.visible, 'Published', "On students' dashboards and the course page; they can start it when it opens. Off: a draft only you see.")}</div>
      <div class="exam-item-flag" role="cell">${flag('results_published', exam.results_published, 'Grades released', 'Students see their grade and your feedback')}</div>
      <div class="exam-item-actions" role="cell">
        ${action}
        ${menu.length ? rowMenuHtml(menu, { label: 'More actions' }) : ''}
      </div>
      ${noPassword ? `<div class="exam-item-alert" role="cell"><span class="exam-item-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>No exam password yet, so students can't sign in.
        <button type="button" class="exam-link-btn" data-exam-action="set-password">Set it</button></span></span></div>` : ''}
    </article>`;
  }

  // When it is, in words, while it is close: Today, Tomorrow, In 3 days (up to two weeks ahead);
  // open, when it ends.
  function relativeWhen(exam, status) {
    const start = Date.parse(exam.starts_at);
    if (!Number.isFinite(start)) return '';
    if (status.key === 'open' && exam.ends_at) return `Ends at ${new Date(exam.ends_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    if (start <= Date.now()) return '';
    const day = t => { const d = new Date(t); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); };
    const days = day(start) - day(Date.now());
    return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days < 14 ? `In ${days} days` : '';
  }

  function chip(icon, text) { return `<span class="exam-chip"><i class="${icon}" aria-hidden="true"></i>${x(text)}</span>`; }
  function gradingLabel(key) { return EX.grading.find(g => g.key === key)?.label || ''; }

  // Worked out here rather than from is_open, so a switch flipped on the card shows at once.
  function examStatus(exam) {
    if (!exam.visible) return { key: 'draft', label: 'Draft' };
    const now = Date.now(), start = Date.parse(exam.starts_at), end = Date.parse(exam.ends_at);
    if (exam.questions?.length && start <= now && now < end) return { key: 'open', label: 'Open now' };
    if (start > now) return { key: 'upcoming', label: 'Upcoming' };
    if (end <= now || (!exam.duration_minutes && start <= now)) return exam.results_published ? { key: 'released', label: 'Grades out' } : { key: 'ended', label: 'Ended' };
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
    let btn = S.section === 'exams' && e.target.closest('[data-exam-action], [data-sub-action], [data-roster-filter], [data-bulk], [data-roster-sort], [data-stats-sort]');
    // An exam's row, anywhere but its switches and menu: its action (Questions or Grades).
    if (!btn && S.section === 'exams' && EX.view === 'list' && !e.target.closest('label, input, button, a, .row-menu')) {
      btn = e.target.closest('.exam-item[data-row-action]')?.querySelector(`.exam-item-actions [data-exam-action="${e.target.closest('.exam-item').dataset.rowAction}"]`);
    }
    if (!btn) return;
    if ('statsSort' in btn.dataset) return sortStats(btn.dataset.statsSort);
    if (btn.dataset.subAction || btn.dataset.rosterFilter || btn.dataset.bulk || 'rosterSort' in btn.dataset) return onSubmissionsAction(btn);
    const exam = examById(btn.closest('[data-exam-id]')?.dataset.examId);
    switch (btn.dataset.examAction) {
      case 'new': return openExamEditor(null);
      case 'edit': return openExamEditor(exam);
      case 'duplicate': return openExamEditor(exam, true);
      case 'delete': return deleteExam(exam);
      case 'submissions': return showSubmissions(exam.id);
      case 'questions': return showQuestions(exam.id);
      case 'pool': return showPool();
      case 'try': return tryAsStudent(exam, exam.questions || []);
      case 'paper': return openPaperDialog(exam);
      case 'back': return reloadExams();
      case 'to-questions': return switchExamView('questions', EX.examId);
      case 'to-grades': return switchExamView('submissions', EX.examId);
      case 'to-stats': return switchExamView('stats', EX.examId);
      case 'stats': return showStats(exam.id);
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
      input.closest('.exam-item').outerHTML = examCardHtml(exam);
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
          + (label ? `\n\n${label} will be marked Done on the Weights tab.` : ''),
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
  // The exam's two views, Questions and Grades, as one switch beside All exams (lecturers and
  // admins; assistants have Grades only). The pressed half slides across before the view changes.
  // An exam's three views: its Questions, its Grades and its Statistics. From the questions a
  // press goes through their unsaved-changes check (data-qe); from the others, straight there.
  const EXAM_VIEWS = ['questions', 'grades', 'stats'];
  function examViewsHtml(exam, view) {
    if (!canManage()) return '';
    const graded = exam.submission_count ? `<span class="exam-views-count">${exam.submission_count}</span>` : '';
    const go = target => (view === target ? 'tabindex="-1"' : view === 'questions' ? `data-qe="${target}"` : `data-exam-action="to-${target}"`);
    return `<div class="exam-views" role="tablist" aria-label="${x(examTitle(exam))}" data-view="${view}">
      <button type="button" role="tab" aria-selected="${view === 'questions'}" ${go('questions')}>Questions</button>
      <button type="button" role="tab" aria-selected="${view === 'grades'}" ${go('grades')}>Grades${graded}</button>
      <button type="button" role="tab" aria-selected="${view === 'stats'}" ${go('stats')} title="How the exam went: the grades' spread and each question">Statistics</button>
    </div>`;
  }
  // Slides the switch's pressed part to the other view, then goes there.
  function slideExamViews(view) {
    const views = document.querySelector('.exam-views');
    if (!views || views.dataset.view === view) return Promise.resolve();
    views.dataset.view = view;
    views.querySelectorAll('[role="tab"]').forEach((tab, i) => tab.setAttribute('aria-selected', String(EXAM_VIEWS[i] === view)));
    return new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200));
  }

  // From one of an exam's views to another: the switch beside All exams.
  async function switchExamView(view, examId) {
    await slideExamViews(view === 'submissions' ? 'grades' : view);
    const body = document.getElementById('section-body');
    if (!examById(examId)) return reloadExams();
    if (view === 'questions') return showQuestions(examId, body);
    await (view === 'stats' ? showStats(examId, body) : showSubmissions(examId, body));
    finishSectionLoad(body);
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

  // The exam's settings, on one grid of four columns: what it is (Assessment, Label; Type,
  // Weight, Base, Hall), when (Date, Time, Duration with its end) and how students sign in
  // (Sign-in, then the password with Generate and Copy, the rule in one line under them); then
  // the four switches in a row, what each does in its tooltip.
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
    const field = (id, label, control, extra = '', span = 1) => `<div class="form-group${span > 1 ? ` ef-span-${span}` : ''}">
      <label class="form-label" for="${id}">${label}</label>${control}${extra}</div>`;
    const toggle = (id, on, title, tip, extra = '') => `<label class="exam-switch" title="${x(tip)}"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}>
      <span class="exam-switch-title">${title}</span>${extra}</label>`;
    const halls = [...new Set(EX.data.exams.map(e => (e.hall || '').trim()).filter(Boolean))].sort();
    return `
      <div class="exam-form">
        ${field('exam-f-grading', 'Assessment', `<select id="exam-f-grading">${gradingOptions}</select>`,
          EX.grading.length ? '' : '<p class="form-hint">Add them on the Weights tab to choose one here.</p>', 2)}
        ${field('exam-f-label', 'Label', `<input type="text" id="exam-f-label" autocomplete="off" value="${x(duplicate ? `${src.label || typeLabel(src.type)} (copy)` : src.label || '')}">`, '', 2)}
        ${field('exam-f-type', 'Type', `<select id="exam-f-type">${typeOptions}</select>`)}
        ${field('exam-f-weight', 'Weight (%)', `<input type="number" id="exam-f-weight" autocomplete="off" min="0" max="100" step="0.1" value="${x(src.weight ?? '')}">`)}
        ${field('exam-f-base', 'Base', `<input type="number" id="exam-f-base" autocomplete="off" min="1" step="1" value="${x(src.base ?? 100)}">`)}
        ${field('exam-f-hall', 'Hall', `<input type="text" id="exam-f-hall" value="${x(src.hall || '')}" list="exam-f-halls" autocomplete="off">
          <datalist id="exam-f-halls">${halls.map(h => `<option value="${x(h)}">`).join('')}</datalist>`)}
        ${field('exam-f-date', 'Date', `<input type="date" id="exam-f-date" autocomplete="off" value="${x(date)}">`)}
        ${field('exam-f-time', 'Time', `<input type="time" id="exam-f-time" autocomplete="off" value="${x(time)}">`)}
        ${field('exam-f-duration', 'Duration (min)', `<input type="number" id="exam-f-duration" autocomplete="off" min="1" step="1" value="${x(src.duration_minutes ?? '')}">`,
          '<p class="form-hint" id="exam-f-ends" aria-live="polite"></p>')}
        ${field('exam-f-signin', 'Sign-in', `<select id="exam-f-signin" ${taken ? 'disabled' : ''}>${Object.entries(SIGN_INS).map(([id, s]) => `<option value="${id}" ${signIn === id ? 'selected' : ''}>${x(s.label)}</option>`).join('')}</select>`)}
        <div class="form-group exam-password ef-span-4">
          <label class="exam-switch exam-switch-label"><input type="checkbox" id="exam-f-password-on" ${passwordOn ? 'checked' : ''}><span class="exam-switch-title">Password</span></label>
          <div class="exam-password-row" ${passwordOn ? '' : 'hidden'}>
            <span class="exam-password-field">
              <input type="text" id="exam-f-password" class="secret-field" value="${x(password)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" aria-label="Exam password"
                placeholder="${!duplicate && src.has_password && !password ? 'Set earlier: type it to see it here' : ''}">
              <button type="button" class="exam-password-peek" id="exam-f-password-peek" title="Show" aria-label="Show the password" aria-pressed="false"><i class="fa-regular fa-eye"></i></button>
            </span>
            <button type="button" class="btn-sm btn-secondary" id="exam-f-password-new" title="A new password, easy to read out"><i class="fa-solid fa-dice"></i>Generate</button>
            <button type="button" class="btn-sm btn-secondary" id="exam-f-password-copy" title="Copy" aria-label="Copy the password" ${password ? '' : 'disabled'}><i class="fa-regular fa-copy"></i></button>
            <span class="form-hint" id="exam-f-password-hint" ${passwordOn ? '' : 'hidden'}>${x(passwordHint(signIn))}</span>
          </div>
        </div>
        <p class="form-hint ef-span-4 ef-signin-hint" id="exam-f-signin-hint">${taken ? '<i class="fa-solid fa-lock" aria-hidden="true"></i> Sign-in fixed: students have taken this exam.' : x(signInHint(signIn))}</p>
        <div class="ef-switches ef-span-4">
          ${toggle('exam-f-shuffle', src.shuffle_questions !== false, 'Shuffle questions', 'Each student gets their own order')}
          ${toggle('exam-f-lock', lock, 'Lock on leaving', 'Back after leaving the page, the exam stays locked for these seconds each time. Leaving is always recorded.',
            `<span class="ef-lock-seconds" data-cooldown><input type="number" id="exam-f-cooldown" class="exam-inline-number" autocomplete="off" min="5" max="300" step="1" value="${x(settings.cooldown_seconds)}" aria-label="Seconds"> s</span>
            <span class="ef-lock-seconds" data-no-cooldown>recorded only</span>`)}
          ${toggle('exam-f-visible', !duplicate && src.visible, 'Published','On students\' dashboards and the course page; they can start it when it opens')}
          ${toggle('exam-f-published', !duplicate && src.results_published, 'Grades released','Students see their grade and your feedback')}
        </div>
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
    // A text field masked by CSS, not a password field: password managers leave it alone.
    const show = shown => {
      input.classList.toggle('is-shown', shown);
      peek.setAttribute('aria-pressed', String(shown));
      peek.title = shown ? 'Hide' : 'Show';
      peek.innerHTML = `<i class="fa-regular ${shown ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    };
    peek.onclick = () => show(!input.classList.contains('is-shown'));
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

  // An assessment from the Weights tab fills in the weight and type, and the label unless one
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

  // A to Z, Other last.
  const CODE_LANGUAGES = { c: 'C', cpp: 'C++', csharp: 'C#', java: 'Java', javascript: 'JavaScript', matlab: 'MATLAB', python: 'Python', r: 'R', sql: 'SQL', other: 'Other' };
  const num = text => { const n = parseFloat(String(text ?? '').trim().replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const lines = text => String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  // Answers and tolerances as entered: fmt() rounds to one decimal, which suits weights only.
  const exact = value => (Number.isFinite(Number(value)) ? String(Number(value)) : '');
  // Points to the hundredth (100 shared between 3 is 33.33 each, and 33.34).
  const pts = value => (Number.isFinite(Number(value)) ? NUMBER_2.format(Math.round(Number(value) * 100) / 100) : '');

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
    EX.linking = null;
    body.innerHTML = questionsViewHtml(exam);
    // Started first, so the cards say their images are loading.
    const imagesLoaded = Promise.all([loadImages(exam), hasPool(exam.questions) ? loadPoolImages() : null]);
    const list = document.getElementById('qe-list');
    const questions = exam.questions || [];
    questions.forEach(q => list.appendChild(makeCard(q, { collapsed: questions.length > 4 })));
    refreshQuestions();
    if (window.Sortable) {
      EX.sortable = Sortable.create(list, { handle: '.qcard-grip', animation: 150, ghostClass: 'qcard-ghost', onEnd: refreshQuestions });
    }
    finishSectionLoad(body);
    imagesLoaded.then(() => {
      if (EX.view === 'questions' && EX.examId === examId) questionCards().forEach(card => { if (isPoolCard(card)) renderPoolCard(card); else { renderCardImages(card); renderOptions(card); } });
    });
  }

  // A card for a question, or for a pool item.
  const makeCard = (q, options) => (isPoolItem(q) ? poolItemCard(q, options) : questionCard(q, options));
  const isPoolCard = card => card?.dataset.type === 'pool';
  const inQuestionEditor = () => S.section === 'exams' && (EX.view === 'questions' || EX.view === 'pool');

  // The questions editor: a floating bar, with the way out and the exam's other views on the
  // left (All exams, Preview, Settings) and the work on the questions on the right (Add
  // question, Select, Fold all, the ⋯ menu, Save); then one card per question. A card folds to
  // a line; open, it is the question ready to edit: the text with its formatting tools, its
  // images, the answer (the correct one marked). Its head moves, duplicates and deletes it.
  // Select turns the bar into a selection bar (select all with the count; points, duplicate,
  // delete; Done) and the cards into a list to tick.
  function questionsViewHtml(exam) {
    const more = [
      { label: 'Preview as a student', icon: 'fa-solid fa-eye', attrs: 'data-qe="preview"', title: 'In a new tab, as the questions are here, each time another student; nothing is saved or sent' },
      { label: 'Exam settings', icon: 'fa-solid fa-gear', attrs: 'data-qe="settings"', title: 'Date, sign-in, password, leaving the page' },
      { separator: true },
      { label: 'Select questions', icon: 'fa-regular fa-square-check', attrs: 'data-qe="select"', title: 'Points, duplicate or delete several at once' },
      { label: 'Fold all', icon: 'fa-solid fa-down-left-and-up-right-to-center', attrs: 'data-qe="collapse"' },
      { label: 'Share 100 points evenly', icon: 'fa-solid fa-scale-balanced', attrs: 'data-qe="split-points"' },
      { separator: true },
      { label: 'Import questions', icon: 'fa-solid fa-file-import', attrs: 'data-qe="import"', title: 'From a file, pasted, or another exam' },
      { label: 'Export questions', icon: 'fa-solid fa-file-export', attrs: 'data-qe="export"', title: 'As a file, with their images and links' },
      { label: 'Exam paper (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-qe="paper"', title: 'The saved questions to print, with or without the answers' },
    ];
    const notes = [
      exam.submission_count && `<p class="exam-edit-warning"><i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        <span>${exam.submission_count} student${exam.submission_count === 1 ? ' has' : 's have'} submitted. Their answers and grades follow each question when you move, add or remove questions; changing a question's text or options does not change what they answered.</span></p>`,
      examStatus(exam).key === 'open' && `<p class="exam-edit-warning qe-live"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i>
        <span>The exam is open now. Students get your changes within half a minute: a question you change loses their answer to it, new ones are added, removed ones go.</span></p>`,
    ].filter(Boolean).join('');
    return `
      <div class="section-topbar qe-topbar">
        <div class="add-bar qe-nav">
          <button type="button" class="btn-sm btn-secondary" data-qe="back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All exams</button>
        </div>
        ${examViewsHtml(exam, 'questions')}
        <label class="qe-sel-all" title="Select every question, or none"><input type="checkbox" id="qe-select-all" data-no-dirty><span id="qe-select-count">0 selected</span></label>
        <div class="add-bar qe-tools">
          <button type="button" class="btn-sm btn-green qe-add-btn" data-qe="add-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="qe-add-menu"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add question</button>
        </div>
        ${rowMenuHtml(more, { label: 'More: preview, settings, select, import, export, print', className: 'qe-more' })}
        <div class="qe-sel-points"><input type="number" id="qe-select-points" min="0" step="0.5" placeholder="Points" aria-label="Points for each selected question" data-no-dirty><button type="button" class="btn-sm btn-secondary" data-qe="select-points" title="Give each selected question these points">Set</button></div>
        <div class="add-bar qe-sel-actions">
          <button type="button" class="btn-sm btn-secondary" data-qe="select-duplicate"><i class="fa-regular fa-copy" aria-hidden="true"></i> Duplicate</button>
          <button type="button" class="btn-sm btn-red" data-qe="select-delete"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Delete</button>
        </div>
        <button type="button" class="btn-sm qe-sel-done" data-qe="select-done" title="Stop selecting (Esc)"><i class="fa-solid fa-check" aria-hidden="true"></i> Done</button>
        <button class="btn-sm btn-save-section is-clean" id="section-save-btn" disabled title="Nothing to save" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
        ${addMenuHtml(Object.keys(QUESTION_TYPES), !!EX.pool)}
      </div>
      <div class="qe-head">
        <h3 class="qe-title">${x(examTitle(exam))}</h3>
        <span class="exam-muted" id="qe-summary"></span>
      </div>
      ${notes ? `<div class="qe-notes">${notes}</div>` : ''}
      <div class="qe-list" id="qe-list"></div>
      <div class="qe-empty" id="qe-empty">
        <i class="fa-solid fa-list-check" aria-hidden="true"></i>
        <p><strong>No questions yet.</strong> Add the first one, or import them.</p>
        <p class="form-hint">An exam without questions is held on paper: students see its date and hall, and you enter the grades on its Grades page.</p>
      </div>`;
  }

  // Add question's menu: the question types, then (in an exam) questions from the pool.
  function addMenuHtml(types, withPool) {
    const item = (id, icon, label, hint) => `<button type="button" role="menuitem" data-qe-add="${id}"><i class="${icon}" aria-hidden="true"></i><span><strong>${x(label)}</strong><small>${x(hint)}</small></span></button>`;
    return `<div class="qe-add-menu" id="qe-add-menu" role="menu" aria-label="Question types" hidden>${types.map(id => item(id, QUESTION_TYPES[id].icon, QUESTION_TYPES[id].label, QUESTION_TYPES[id].hint)).join('')}
      ${withPool ? item('pool', `${POOL_ICON} qe-add-pool`, 'From the pool', `${EX.pool.questions.length} in the course's pool; each student draws their own`) : ''}</div>`;
  }

  // ── A pool item in an exam's questions ──
  // Its head: how many questions it draws, from where, and their points. Open: how many and
  // their points, the modules and types to draw from (none chosen: all), one student's draw
  // (‹ › for another student's), and every question that fits, to leave some out. Questions
  // can be linked so that a student gets one of them at most (kept in the pool, for every exam).
  function poolItemCard(item = {}, { collapsed = false } = {}) {
    const card = document.createElement('article');
    card.className = `qcard qcard-pool${collapsed ? ' is-collapsed' : ''}`;
    card.dataset.type = 'pool';
    card.dataset.qid = typeof item.id === 'string' && item.id && item.id.length <= 40 ? item.id : newQuestionId();
    const list = v => x(JSON.stringify(Array.isArray(v) ? v.filter(s => typeof s === 'string') : []));
    card.innerHTML = `
      <header class="qcard-head">
        <span class="qcard-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></span>
        <label class="qcard-select"><input type="checkbox" class="qcard-select-box" data-no-dirty aria-label="Select this item"></label>
        <span class="qcard-num"></span>
        <span class="qcard-type"><i class="${POOL_ICON}" aria-hidden="true"></i><span>From the pool</span></span>
        <span class="qcard-summary"></span>
        <span class="qcard-badges"></span>
        <span class="qcard-actions">
          <button type="button" class="qcard-btn" data-qc="up" title="Move up" aria-label="Move up"><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="qcard-btn" data-qc="down" title="Move down" aria-label="Move down"><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" class="qcard-btn" data-qc="duplicate" title="Duplicate" aria-label="Duplicate"><i class="fa-regular fa-copy"></i></button>
          <button type="button" class="qcard-btn qcard-delete" data-qc="delete" title="Delete" aria-label="Delete"><i class="fa-regular fa-trash-can"></i></button>
        </span>
        <span class="qcard-points"></span>
        <button type="button" class="qcard-btn qcard-toggle" data-qc="toggle" title="Open or fold" aria-label="Open or fold" aria-expanded="${!collapsed}"><i class="fa-solid fa-chevron-down"></i></button>
      </header>
      <div class="qcard-body">
        <input type="hidden" class="q-pool-modules" value="${list(item.modules)}">
        <input type="hidden" class="q-pool-kinds" value="${list(item.kinds)}">
        <input type="hidden" class="q-pool-exclude" value="${list(item.exclude)}">
        <div class="qpool-row">
          <label class="qpool-num">Draw <input type="number" class="q-pool-count" min="1" max="100" step="1" value="${x(item.count ?? 5)}" aria-label="Questions to draw"> questions,</label>
          <label class="qpool-num"><input type="number" class="q-points q-pool-points" min="0" step="0.5" value="${x(item.points ?? 1)}" aria-label="Points for each"> points each</label>
          <span class="qpool-total"></span>
        </div>
        <div class="qpool-filters"></div>
        <p class="qpool-fit" aria-live="polite"></p>
        <details class="qpool-more qpool-sample">
          <summary>See one student's questions</summary>
          <div class="qpool-sample-head">
            <span class="qpool-steps">
              <button type="button" class="qcard-btn" data-qc="pool-prev" title="Another student's" aria-label="The previous student's questions"><i class="fa-solid fa-chevron-left"></i></button>
              <span class="qpool-who" aria-live="polite"></span>
              <button type="button" class="qcard-btn" data-qc="pool-next" title="Another student's" aria-label="The next student's questions"><i class="fa-solid fa-chevron-right"></i></button>
            </span>
            <span class="form-hint">Each student draws their own when they start.</span>
          </div>
          <ol class="qpool-drawn"></ol>
        </details>
        <details class="qpool-more qpool-all">
          <summary></summary>
          <p class="form-hint">Untick a question to leave it out of this exam. It stays in the pool.</p>
          <ul class="qpool-list"></ul>
        </details>
      </div>`;
    renderPoolCard(card);
    return card;
  }

  const readList = input => { try { const v = JSON.parse(input?.value || '[]'); return Array.isArray(v) ? v.filter(s => typeof s === 'string') : []; } catch { return []; } };
  const writeList = (input, values) => { input.value = JSON.stringify([...new Set(values)]); markDirty(); };
  const poolItemOf = card => ({
    id: card.dataset.qid, type: 'pool',
    count: Math.max(0, Math.floor(num(card.querySelector('.q-pool-count').value) ?? 0)),
    points: num(card.querySelector('.q-pool-points').value) ?? 0,
    modules: readList(card.querySelector('.q-pool-modules')), kinds: readList(card.querySelector('.q-pool-kinds')),
    exclude: readList(card.querySelector('.q-pool-exclude')),
  });
  // The pool items of the editor, as they are now (one student's draw spans them all).
  const editorPoolItems = () => questionCards().filter(isPoolCard).map(poolItemOf);

  // A question's first line as plain text, shortened: how a link names it.
  const poolQuestionName = q => {
    const text = formatQuestionText.plain(String(q.prompt || '').split('\n').find(l => l.trim()) || '').trim();
    return text ? (text.length > 90 ? `${text.slice(0, 88)}…` : text) : 'A question with an image';
  };

  // One pool question as a line: its type, its text, its module and whether it is linked (links
  // are made in the question pool); in the list of all that fit, its tick to leave it out.
  function poolLineHtml(q, { drawn = false, out = false } = {}) {
    const type = QUESTION_TYPES[q.type] || QUESTION_TYPES.short_answer;
    const firstLine = String(q.prompt || '').split('\n').find(l => l.trim()) || '';
    const text = formatQuestionText.inline(firstLine.replace(/^\s*([-•]|\d+[.)])\s+/, '')) || (q.images?.length ? '<em>An image</em>' : '<em>No text</em>');
    const linked = q.apart ? EX.pool.questions.filter(o => o.apart === q.apart && o.id !== q.id) : [];
    return `<li class="qpool-line${out ? ' is-out' : ''}" data-pool-id="${x(q.id)}">
      ${drawn ? '' : `<label class="qpool-include" title="${out ? 'Left out of this exam: tick to draw it again' : 'Can be drawn: untick to leave it out of this exam'}"><input type="checkbox" data-no-dirty data-pool-include ${out ? '' : 'checked'} aria-label="Can be drawn"></label>`}
      <span class="qpool-line-type" title="${x(type.label)}"><i class="${type.icon}" aria-hidden="true"></i></span>
      <span class="qpool-line-text">${text}</span>
      ${q.images?.length ? `<span class="qpool-line-meta" title="${q.images.length} image${q.images.length === 1 ? '' : 's'}"><i class="fa-regular fa-image" aria-hidden="true"></i></span>` : ''}
      <span class="qpool-line-module">${x(moduleLabel(String(q.module || '').trim()))}</span>
      ${linked.length ? `<span class="qpool-link-badge" style="--link-hue:${hashOf(q.apart) % 360}" title="${x(`Linked: a student gets one of these at most\n${linked.map(o => `• ${poolQuestionName(o)}`).join('\n')}`)}"><i class="fa-solid fa-link" aria-hidden="true"></i>${linked.length}</span>` : ''}
    </li>`;
  }

  // Draws, filters and the list of a pool item card, from its fields and the pool as they are.
  function renderPoolCard(card) {
    if (!EX.pool) return;
    const item = poolItemOf(card);
    const all = EX.pool.questions.filter(q => q?.id && QUESTION_TYPES[q.type] && q.type !== 'text_only');
    const fits = poolFits(item), excluded = new Set(item.exclude);
    const candidates = fits.filter(q => !excluded.has(q.id));
    const most = poolMost(item);
    // Modules and types: chips, with how many questions each has (of the chosen types, and of
    // the chosen modules). An item's choice that the pool no longer has stays, to undo.
    const modules = [...poolModules(all)];
    item.modules.forEach(m => { if (!modules.includes(m)) modules.push(m); });
    const kinds = Object.keys(QUESTION_TYPES).filter(t => all.some(q => q.type === t) || item.kinds.includes(t));
    const chip = (attr, value, label, count, on) => `<label class="qpool-chip${on ? ' is-on' : ''}"><input type="checkbox" data-no-dirty ${attr}="${x(value)}" ${on ? 'checked' : ''}><span>${label}</span><em>${count}</em></label>`;
    const ofKinds = q => !item.kinds.length || item.kinds.includes(q.type);
    const ofModules = q => !item.modules.length || item.modules.includes(String(q.module || '').trim());
    card.querySelector('.qpool-filters').innerHTML = all.length ? `
      <div class="qpool-filter" role="group" aria-label="Modules"><span class="qpool-filter-label">Modules</span>
        ${chip('data-pool-module-all', '', 'All', all.filter(ofKinds).length, !item.modules.length)}
        ${modules.map(m => chip('data-pool-module', m, x(moduleLabel(m)), all.filter(q => String(q.module || '').trim() === m && ofKinds(q)).length, item.modules.includes(m))).join('')}</div>
      <div class="qpool-filter" role="group" aria-label="Types"><span class="qpool-filter-label">Types</span>
        ${chip('data-pool-kind-all', '', 'All', all.filter(ofModules).length, !item.kinds.length)}
        ${kinds.map(t => chip('data-pool-kind', t, `<i class="${QUESTION_TYPES[t].icon}" aria-hidden="true"></i>${x(QUESTION_TYPES[t].label)}`, all.filter(q => q.type === t && ofModules(q)).length, item.kinds.includes(t))).join('')}</div>`
      : `<p class="qpool-empty">The course's pool has no questions yet. <button type="button" class="exam-link-btn" data-qe="pool">Add them to the pool</button>, then choose here which to draw from.</p>`;
    // Whether it works: how many fit and what each student gets, or what to change.
    const fit = card.querySelector('.qpool-fit');
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const warn = all.length > 0 && item.count > most;
    fit.hidden = !all.length;
    fit.classList.toggle('is-warn', warn);
    fit.innerHTML = !all.length ? '' : `<i class="fa-solid ${warn ? 'fa-triangle-exclamation' : 'fa-circle-check'}" aria-hidden="true"></i><span>${x(
      !candidates.length ? 'No question fits: choose other modules or types.'
        : warn ? `Only ${most} can be drawn for one student${most < candidates.length ? ' (linked questions count once)' : ''}: draw fewer, or choose more modules or types.`
        : `${plural(candidates.length, 'question')} fit. Each student gets ${item.count} of them, at random.`)}</span>`;
    card.querySelector('.qpool-total').textContent = item.count && item.points ? `${fmt(item.count * item.points)} points in all` : '';
    // One student's draw: the editor's items together, so a question comes once in the exam.
    const items = editorPoolItems();
    if (!items.some(i => i.id === item.id)) items.push(item);
    const drawn = sampleDraws(items, EX.sample)[item.id] || [];
    card.querySelector('.qpool-who').textContent = `Student ${EX.sample}`;
    card.querySelector('.qpool-sample').hidden = !all.length;
    card.querySelector('.qpool-drawn').innerHTML = drawn.length ? drawn.map(q => poolLineHtml(q, { drawn: true })).join('')
      : `<li class="qpool-none">${candidates.length ? 'Nothing left to draw: the other pool items took these questions.' : 'No question fits: choose other modules or types.'}</li>`;
    if (drawn.length < item.count && drawn.length) card.querySelector('.qpool-drawn').insertAdjacentHTML('beforeend', `<li class="qpool-none">Only ${drawn.length} of ${item.count} could be drawn.</li>`);
    // Every question that fits, the left-out ones too.
    const details = card.querySelector('.qpool-all');
    details.hidden = !fits.length;
    const left = fits.filter(q => excluded.has(q.id)).length;
    details.querySelector('summary').innerHTML = `Leave some questions out <span class="exam-muted">${left ? `${left} of ${fits.length} left out` : `${fits.length} can be drawn`}</span>`;
    details.querySelector('.qpool-list').innerHTML = fits.map(q => poolLineHtml(q, { out: excluded.has(q.id) })).join('');
  }

  // Links two pool questions (from an exam's pool item): saved in the pool at once, for every exam.
  async function linkPoolQuestions(a, b) {
    const qa = EX.pool.questions.find(q => q.id === a), qb = EX.pool.questions.find(q => q.id === b);
    if (!qa || !qb) return;
    const group = qa.apart || qb.apart || newQuestionId();
    // Joining two linked sets makes one.
    const ids = EX.pool.questions.filter(q => q.id === a || q.id === b || (q.apart && (q.apart === qa.apart || q.apart === qb.apart))).map(q => q.id);
    await savePoolLink(ids, group);
  }
  async function savePoolLink(ids, group) {
    try {
      EX.pool.questions = await rpc('exam_link_pool', { p_sheet: EX.course, p_archive: EX.isArchive, p_ids: ids, p_apart: group });
    } catch (error) {
      toast(`The link was not saved: ${error.message}`, 'err');
    }
    EX.linking = null;
    refreshQuestions();
  }

  // Clicks inside a pool item card; true when handled.
  async function onPoolCardClick(card, btn, e) {
    const line = e.target.closest('[data-pool-id]');
    const id = line?.dataset.poolId;
    switch (btn?.dataset.qc) {
      case 'pool-prev': EX.sample = Math.max(1, EX.sample - 1); break;
      case 'pool-next': EX.sample += 1; break;
      case 'pool-leave-out': {
        const input = card.querySelector('.q-pool-exclude');
        writeList(input, [...readList(input), id]);
        break;
      }
      case 'pool-link':
        if (!EX.linking || EX.linking.id === id) { EX.linking = EX.linking ? null : { id }; break; }
        await linkPoolQuestions(EX.linking.id, id);
        return true;
      case 'pool-link-cancel': EX.linking = null; break;
      case 'pool-unlink': {
        // Out of its set; a set of one is no link.
        const source = EX.pool.questions.find(q => q.id === EX.linking?.id);
        const rest = EX.pool.questions.filter(q => source?.apart && q.apart === source.apart && q.id !== source.id);
        await savePoolLink([source?.id, ...(rest.length === 1 ? [rest[0].id] : [])].filter(Boolean), null);
        return true;
      }
      default: return false;
    }
    refreshQuestions();
    return true;
  }

  // The chips and ticks of a pool item card: they change its hidden fields (which are saved).
  function onPoolCardChange(card, el) {
    const set = (sel, values) => writeList(card.querySelector(sel), values);
    if (el.matches('[data-pool-module-all]')) set('.q-pool-modules', []);
    else if (el.matches('[data-pool-module]')) {
      const now = readList(card.querySelector('.q-pool-modules')).filter(m => m !== el.dataset.poolModule);
      set('.q-pool-modules', el.checked ? [...now, el.dataset.poolModule] : now);
    } else if (el.matches('[data-pool-kind-all]')) set('.q-pool-kinds', []);
    else if (el.matches('[data-pool-kind]')) {
      const now = readList(card.querySelector('.q-pool-kinds')).filter(t => t !== el.dataset.poolKind);
      set('.q-pool-kinds', el.checked ? [...now, el.dataset.poolKind] : now);
    } else if (el.matches('[data-pool-include]')) {
      const id = el.closest('[data-pool-id]').dataset.poolId;
      const now = readList(card.querySelector('.q-pool-exclude')).filter(v => v !== id);
      set('.q-pool-exclude', el.checked ? now : [...now, id]);
    } else return false;
    refreshQuestions();
    return true;
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

  // Text and markup written only when they differ: refreshQuestions runs on every keystroke,
  // and rewriting every card each time made long lists lag.
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const setHtml = (el, html) => { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } };

  // The options' letters and images, as they are now.
  function renderOptions(card) {
    const other = card.querySelector('.q-allow-other')?.checked;
    const otherRow = card.querySelector('.q-other-row');
    if (otherRow) {
      otherRow.hidden = !other;
      card.querySelector('.q-add-other').hidden = !!other;
      setText(otherRow.querySelector('.q-opt-letter'), `${String.fromCharCode(97 + card.querySelectorAll('.q-option').length)})`);
    }
    card.querySelectorAll('.q-option').forEach((row, i) => {
      setText(row.querySelector('.q-opt-letter'), `${String.fromCharCode(97 + i)})`);
      const id = row.querySelector('.q-opt-image').value, src = id && imageSrc(id);
      row.classList.toggle('has-image', !!id);
      setHtml(row.querySelector('.q-opt-thumb'), !id ? '' : `${src ? `<img src="${x(src)}" alt="" draggable="false">` : '<i class="fa-regular fa-image" aria-hidden="true"></i>'}
        <button type="button" class="q-image-remove" data-qc="remove-option-image" title="Remove the image" aria-label="Remove the image"><i class="fa-solid fa-xmark"></i></button>`);
    });
  }

  // One question as an editable card. Every type's fields are kept, so switching type and
  // back loses nothing; only the current type's are saved.
  // pool: a question of the course's pool (its module and links; no points, the exam's pool
  // item gives them).
  function questionCard(q = {}, { collapsed = false, pool = EX.view === 'pool' } = {}) {
    const types = Object.keys(QUESTION_TYPES).filter(id => !pool || id !== 'text_only');
    const type = types.includes(q.type) ? q.type : pool && q.type === 'text_only' ? 'long_answer' : QUESTION_TYPES[q.type] ? q.type : 'short_answer';
    const options = Array.isArray(q.options) && q.options.length ? q.options : ['', '', '', ''];
    const optionImages = Array.isArray(q.option_images) ? q.option_images : [];
    const correct = new Set(q.correct_answers || []);
    // A question keeps the id it came with (the server checks ids), so its answers follow it.
    const qid = typeof q.id === 'string' && q.id && q.id.length <= 40 ? q.id : newQuestionId();
    const size = IMAGE_SIZES[q.image_size] ? q.image_size : 'medium';
    const card = document.createElement('article');
    card.className = `qcard${pool ? ' is-pool-question' : ''}${collapsed ? ' is-collapsed' : ''}`;
    card.dataset.type = type;
    card.dataset.qid = qid;
    card.innerHTML = `
      <header class="qcard-head">
        <span class="qcard-grip" title="Drag to reorder${pool ? ', also to another module' : ''}"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></span>
        <label class="qcard-select"><input type="checkbox" class="qcard-select-box" data-no-dirty aria-label="Select this question"></label>
        <span class="qcard-num"></span>
        <span class="qcard-type"><i class="${QUESTION_TYPES[type].icon}" aria-hidden="true"></i><span>${x(QUESTION_TYPES[type].label)}</span></span>
        <label class="qcard-type-pick"><span class="sr-only">Type</span>
          <select class="q-type">${types.map(id => `<option value="${id}" ${id === type ? 'selected' : ''}>${x(QUESTION_TYPES[id].label)}</option>`).join('')}</select></label>
        <span class="qcard-summary"></span>
        <span class="qcard-badges"></span>
        <span class="qcard-actions">
          ${pool ? '<button type="button" class="qcard-btn" data-qc="link" title="Link with another question: a student gets one of them at most" aria-label="Link with another question"><i class="fa-solid fa-link"></i></button>' : ''}
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
        ${pool ? `<input type="hidden" class="q-apart" value="${x(typeof q.apart === 'string' ? q.apart : '')}">
          <div class="qcard-row q-module-row"><div class="form-group"><label class="form-label">Module</label>
            <select class="q-module">${poolGroupModules().map(m => `<option value="${x(m)}" ${m === String(q.module || '').trim() ? 'selected' : ''}>${x(moduleLabel(m))}</option>`).join('')}</select></div></div>` : ''}
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
          <div class="q-image-size-row" hidden><span class="form-hint q-image-size-hint">${x(imageLayoutHint(''))}</span></div>
        </div>
        <div class="q-part" data-part="multiple_select">
          <p class="q-part-title">Answer options <span class="label-note">tick the correct one</span></p>
          <div class="q-options">${options.map((o, i) => optionRowHtml(o, correct.has(o), typeof optionImages[i] === 'string' ? optionImages[i] : '')).join('')}</div>
          <input type="checkbox" class="q-allow-other" hidden ${q.allow_other ? 'checked' : ''}>
          <div class="q-other-row" ${q.allow_other ? '' : 'hidden'}>
            <span class="q-opt-check is-other" aria-hidden="true"><i class="fa-solid fa-pen"></i></span>
            <span class="q-opt-letter" aria-hidden="true"></span>
            <span class="q-other-text">Other: <span class="label-note">the student writes their own answer, graded by hand</span></span>
            <button type="button" class="qcard-btn" data-qc="remove-other" title="Remove Other" aria-label="Remove Other"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <input type="file" class="q-opt-image-input" hidden data-no-dirty accept="image/png,image/jpeg,image/webp,image/gif,image/bmp">
          <div class="q-option-adds">
            <button type="button" class="exam-link-btn q-add-option" data-qc="add-option"><i class="fa-solid fa-plus"></i> Add option</button>
            <button type="button" class="exam-link-btn q-add-other" data-qc="add-other" ${q.allow_other ? 'hidden' : ''} title="An option where students write their own answer"><i class="fa-solid fa-plus"></i> Add “Other”</button>
          </div>
          <p class="form-hint">Enter adds the next option; pasting several lines adds one per line. An option can have an image. Students see them lettered, in a shuffled order, with Other last.</p>
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
      const src = imageSrc(id);
      const note = _imagesLoading ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Loading' : '<i class="fa-regular fa-image" aria-hidden="true"></i>Not found';
      return `<figure class="q-image${src ? '' : ' is-missing'}" data-image-id="${x(id)}">
        ${src ? `<img src="${x(src)}" alt="Image ${i + 1}" draggable="false" onload="window.examFigureShape?.(this)">` : `<span class="q-image-note">${note}</span>`}
        <button type="button" class="q-image-remove" data-qc="remove-image" title="Remove image" aria-label="Remove image ${i + 1}"><i class="fa-solid fa-xmark"></i></button>
      </figure>`;
    }).join('');
    adding.forEach(tile => holder.appendChild(tile));
    card.querySelector('.q-image-size-row').hidden = !cardImageIds(card).length;
  }

  // Figures have one size for their shape, as on the exam page (taking.js shapeFigures): here
  // they show at that size, and the line under them says where they go.
  const WIDE_FIGURE = 1.6;
  const IMAGE_LAYOUT_HINTS = {
    wide: 'Wide: across the question, up to 460 px tall, as shown here.',
    side: 'Beside the answer, in a column of the same width on every question (on phones above it), as shown here.',
    row: 'Side by side, in frames of one height.',
  };
  const imageLayoutHint = layout => `${IMAGE_LAYOUT_HINTS[layout] || 'Every figure has one size for its shape: wide ones go across the question, others beside the answer.'} Students can click a figure to see it larger. Best 1600 to 2000 px wide.`;
  window.examFigureShape = img => {
    const holder = img.closest('.q-images');
    const images = [...(holder?.querySelectorAll('img') || [])];
    if (!images.length || images.some(i => !i.naturalWidth)) return;
    const layout = images.length > 1 ? 'row' : images[0].naturalWidth / images[0].naturalHeight >= WIDE_FIGURE ? 'wide' : 'side';
    holder.dataset.layout = layout;
    const hint = holder.closest('.qcard')?.querySelector('.q-image-size-hint');
    if (hint) hint.textContent = imageLayoutHint(layout);
  };

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

  // An image's address for the page: a blob made once from its data. Images come as data
  // (megabytes each), which written into the page's HTML on every render made the questions
  // editor and the grading page slow to open and to move through.
  const _imageSrcs = new Map(); // id → { data, url }
  function imageSrc(id) {
    const data = id ? EX.images[id] : '';
    if (!data || !data.startsWith('data:')) return data || '';
    const known = _imageSrcs.get(id);
    if (known?.data === data) return known.url;
    try {
      const comma = data.indexOf(',');
      const mime = (data.slice(5, comma).split(';')[0]) || 'image/png';
      const binary = atob(data.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (known) URL.revokeObjectURL(known.url);
      _imageSrcs.set(id, { data, url });
      return url;
    } catch {
      return data;
    }
  }
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
    if (!inQuestionEditor() || !draggingFiles(e)) return;
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
    if (!inQuestionEditor() || !draggingFiles(e)) return;
    const card = e.target.closest('.qcard');
    document.querySelectorAll('.qcard.is-drop-target').forEach(c => c.classList.remove('is-drop-target'));
    if (!card) return;
    e.preventDefault();
    addCardImages(card, [...e.dataTransfer.files]);
  }

  function applyCardType(card, type) {
    card.dataset.type = type;
    card.querySelectorAll('.q-part').forEach(p => { p.hidden = p.dataset.part !== type; });
    card.querySelector('.q-points-wrap').hidden = type === 'text_only' || card.classList.contains('is-pool-question');
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
    const inPool = EX.view === 'pool';
    // Pool items: one student's draw spans them all, so a change to any (or to their order, the
    // student shown, a link, the pool) draws them again.
    const poolCards = cards.filter(isPoolCard);
    const poolSig = poolCards.length ? JSON.stringify([editorPoolItems(), EX.sample, EX.linking?.id, EX.pool?.questions]) : '';
    if (poolSig !== EX.poolSig) {
      EX.poolSig = poolSig;
      poolCards.forEach(renderPoolCard);
    }
    let n = 0, points = 0, attention = 0, infos = 0;
    // Information stays where it is: each starts a part of the exam, the questions under it (up to
    // the next information) stay under it, and Shuffle questions mixes them only among themselves.
    // Its head says which questions those are.
    const parts = new Map();
    if (!inPool) {
      let count = 0, open = null;
      cards.forEach(card => {
        if (card.dataset.type === 'text_only') {
          if (open) open.to = count;
          parts.set(card, open = { from: count + 1, to: count });
        } else count += isPoolCard(card) ? poolItemOf(card).count : 1;
      });
      if (open) open.to = count;
    }
    const shuffled = examById(EX.examId)?.shuffle_questions !== false;
    const partBadge = card => {
      const part = parts.get(card);
      if (!part) return '';
      const label = part.to < part.from ? 'After the last question' : part.to === part.from ? `Before question ${part.from}` : `Before questions ${part.from}–${part.to}`;
      const title = `Stays where it is. ${part.to < part.from ? 'No question comes after it.' : `Questions ${part.from}${part.to > part.from ? `–${part.to}` : ''} come under it${shuffled ? ', shuffled only among themselves' : ''}, up to the next information.`}`;
      return `<span class="qcard-badge is-part" title="${x(title)}"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i>${x(label)}</span>`;
    };
    // How many questions share each link, counted once (not per card).
    const links = inPool ? linkCounts(cards) : null;
    _shortfalls = null;
    cards.forEach((card, i) => {
      if (isPoolCard(card)) {
        // A pool item numbers the questions it draws, and counts their points.
        const item = poolItemOf(card), first = n + 1;
        n += item.count;
        points += item.count * item.points;
        setText(card.querySelector('.qcard-num'), item.count > 1 ? `${first}–${n}` : item.count ? String(first) : '0');
        setText(card.querySelector('.qcard-summary'), poolSummary(item));
        setText(card.querySelector('.qcard-points'), `${item.count} × ${pts(item.points)} pt`);
        // Fewer than asked: the pool has too few, or (with other pool items or linked questions
        // taking some) some students would draw fewer.
        const short = EX.pool ? poolShortfall(item) : null;
        const issue = cardProblems(card)[0]?.[2] || (EX.pool && item.count > poolMost(item) ? `Only ${poolMost(item)} can be drawn`
          : short != null ? `Only ${short} can be drawn beside the other pool items: they share questions or links` : '');
        if (issue) attention++;
        setHtml(card.querySelector('.qcard-badges'), issue ? `<span class="qcard-badge is-warn">${x(issue)}</span>` : '');
        card.querySelector('[data-qc="up"]').disabled = i === 0;
        card.querySelector('[data-qc="down"]').disabled = i === cards.length - 1;
        return;
      }
      const type = card.dataset.type;
      const info = type === 'text_only';
      if (info) infos++;
      // The pool's questions have no numbers: their order means nothing.
      setHtml(card.querySelector('.qcard-num'), inPool ? '' : info ? '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>' : String(++n));
      if (!info && inPool) n++;
      const firstLine = card.querySelector('.q-prompt').value.split('\n').find(l => l.trim()) || '';
      const summary = card.querySelector('.qcard-summary');
      setHtml(summary, formatQuestionText.inline(firstLine.replace(/^\s*([-•]|\d+[.)])\s+/, '')) || 'No text yet');
      summary.classList.toggle('is-empty', !firstLine);
      const p = num(card.querySelector('.q-points').value) ?? 0;
      if (!info) points += p;
      setText(card.querySelector('.qcard-points'), info || inPool ? '' : `${pts(p)} pt`);
      const images = cardImageIds(card).length;
      const issue = firstLine || images ? cardProblems(card).find(p => p[2])?.[2] : '';
      if (issue) attention++;
      const apart = inPool ? card.querySelector('.q-apart').value : '';
      const linked = apart ? (links.get(apart) || 1) - 1 : 0;
      setHtml(card.querySelector('.qcard-badges'), (issue ? `<span class="qcard-badge is-warn" title="To fix before saving">${x(issue)}</span>` : '') + partBadge(card) + (images
        ? `<span class="qcard-badge" title="${images} image${images === 1 ? '' : 's'}"><i class="fa-regular fa-image" aria-hidden="true"></i>${images}</span>` : '')
        + (linked ? `<span class="qcard-badge is-link" style="--link-hue:${hashOf(apart) % 360}" title="Linked with ${linked} other${linked === 1 ? '' : 's'}: a student gets one of them at most"><i class="fa-solid fa-link" aria-hidden="true"></i>${linked + 1}</span>` : ''));
      card.querySelector('[data-qc="up"]').disabled = i === 0;
      card.querySelector('[data-qc="down"]').disabled = i === cards.length - 1;
      if (type === 'multiple_select') renderOptions(card);
    });
    document.getElementById('qe-empty').hidden = inPool || cards.length > 0;
    if (inPool) refreshPoolGroups(attention);
    else document.getElementById('qe-summary').textContent = cards.length
      ? `${n} question${n === 1 ? '' : 's'}, ${pts(points)} point${points === 1 ? '' : 's'}${infos ? `, ${infos} information` : ''}${attention ? `, ${attention} to fix` : ''}`
      : 'No questions yet';
    const collapse = document.querySelector('[data-qe="collapse"]');
    if (collapse) {
      collapse.disabled = cards.length < 2;
      const open = cards.length && cards.some(c => c.classList.contains('is-collapsed'));
      const label = open ? 'Open all' : 'Fold all';
      if (collapse.dataset.label !== label) {
        collapse.dataset.label = label;
        collapse.title = label;
        collapse.innerHTML = `<i class="fa-solid ${open ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center'}" aria-hidden="true"></i>${label}`;
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
  // In the pool: at the end of the module given (its own Add question), else after the open
  // question, else at the end of the first module. A pool item draws 5 to begin with (or the
  // pool's whole size, when smaller).
  function addQuestion(type, after = questionCards().find(c => !c.classList.contains('is-collapsed')) || null, module = undefined) {
    const card = type === 'pool' ? poolItemCard({ count: Math.min(5, Math.max(1, poolMost({}))), points: 1 })
      : questionCard({ type, points: type === 'text_only' ? undefined : 1 });
    if (EX.view === 'pool') {
      const list = module != null ? groupList(module) : after?.closest('.pool-group-list') || document.querySelector('#qe-list .pool-group-list');
      if (after && module == null && after.parentElement === list) after.after(card); else list.appendChild(card);
      syncCardModule(card);
    } else if (after) after.after(card);
    else document.getElementById('qe-list').appendChild(card);
    setCollapsed(card, false, true);
    refreshQuestions();
    revealPoolCard(card);
    markDirty();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.querySelector(type === 'pool' ? '.q-pool-count' : '.q-prompt')?.focus({ preventScroll: true }), 250);
    return card;
  }

  // Add question: its menu of types opens under the button, inside the bar (so it floats with
  // it), kept within the bar's width. The arrow keys move through it as through its grid.
  // In the pool, a module's own Add question opens it at the module's foot (anchor), for that module.
  function toggleAddMenu(open, anchor = null) {
    const menu = document.getElementById('qe-add-menu');
    const top = document.querySelector('.qe-topbar [data-qe="add-menu"]');
    if (!menu || !top) return;
    const button = anchor || EX.addAnchor || top;
    const show = open === undefined ? menu.hidden || button !== EX.addAnchor : open;
    document.querySelectorAll('[data-qe="add-menu"]').forEach(b => b.setAttribute('aria-expanded', String(show && b === button)));
    menu.hidden = !show;
    if (!show) { EX.addAnchor = null; return; }
    EX.addAnchor = button;
    const holder = button === top ? top.closest('.qe-topbar') : button.parentElement;
    if (menu.parentElement !== holder) holder.appendChild(menu);
    const bar = menu.offsetParent || menu.parentElement;
    const barBox = bar.getBoundingClientRect(), box = button.getBoundingClientRect();
    menu.style.top = `${Math.round(box.bottom - barBox.top + 6)}px`;
    menu.style.left = `${Math.round(Math.max(0, Math.min(box.left - barBox.left, barBox.width - menu.offsetWidth)))}px`;
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  document.addEventListener('click', e => { if (!e.target.closest?.('#qe-add-menu, [data-qe="add-menu"]')) toggleAddMenu(false); });
  document.addEventListener('keydown', e => {
    const menu = document.getElementById('qe-add-menu');
    if (!menu || menu.hidden) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      toggleAddMenu(false);
      return document.querySelector('[data-qe="add-menu"]')?.focus();
    }
    const items = [...menu.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement);
    // The arrow keys move to the nearest item that way, as the items lie on screen.
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    if (!dir || at < 0) return;
    e.preventDefault();
    const from = items[at].getBoundingClientRect();
    const mid = r => [r.left + r.width / 2, r.top + r.height / 2];
    const [fx, fy] = mid(from);
    const next = items.map(item => [item, mid(item.getBoundingClientRect())])
      .filter(([item, [x2, y2]]) => item !== items[at] && (dir[0] ? (x2 - fx) * dir[0] > 4 : (y2 - fy) * dir[1] > 4))
      .sort((a, b) => (Math.abs(a[1][0] - fx) * (dir[0] ? 1 : 3) + Math.abs(a[1][1] - fy) * (dir[1] ? 1 : 3))
        - (Math.abs(b[1][0] - fx) * (dir[0] ? 1 : 3) + Math.abs(b[1][1] - fy) * (dir[1] ? 1 : 3)))[0];
    next?.[0].focus();
  }, true);

  async function onQuestionsClick(e) {
    if (!inQuestionEditor()) return;
    const add = e.target.closest('[data-qe-add]');
    if (add) {
      const module = EX.addAnchor?.dataset.module;
      toggleAddMenu(false);
      return addQuestion(add.dataset.qeAdd, undefined, module); // after the open question, else at the end
    }
    const addButton = e.target.closest('[data-qe="add-menu"]');
    if (addButton) return toggleAddMenu(undefined, addButton);
    const poolNav = e.target.closest('[data-pool-fold], [data-pool-page]');
    if (poolNav) return onPoolNav(poolNav);
    const action = e.target.closest('[data-qe]')?.dataset.qe;
    if (action) return onQuestionsAction(action);
    if (e.target.closest('#qe-select-all')) return selectAllQuestions(e.target.checked);
    const card = e.target.closest('.qcard');
    if (!card) return;
    // Selecting: a click anywhere on a card ticks it, and Shift ticks the cards in between.
    if (isSelecting()) return onSelectClick(card, e);
    const btn = e.target.closest('[data-qc]');
    if (isPoolCard(card) && btn && await onPoolCardClick(card, btn, e)) return;
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
      case 'link': onCardLink(card); return;
      case 'duplicate': {
        const copy = makeCard({ ...readCard(card), id: newQuestionId(), apart: undefined });
        card.after(copy);
        setCollapsed(copy, false, true);
        copy.scrollIntoView({ behavior: 'smooth', block: 'center' });
        markDirty();
        break;
      }
      case 'delete': {
        const text = card.querySelector('.q-prompt')?.value.trim();
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
        renderOptions(card);
        break;
      }
      case 'add-other':
      case 'remove-other':
        card.querySelector('.q-allow-other').checked = btn.dataset.qc === 'add-other';
        renderOptions(card);
        markDirty();
        break;
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
    if (!inQuestionEditor()) return;
    const card = e.target.closest('.qcard');
    if (!card) return;
    if (isPoolCard(card)) { onPoolCardChange(card, e.target); return; }
    // The pool: another module moves the question there.
    if (e.target.matches('.q-module')) {
      const list = groupList(e.target.value);
      if (list && card.parentElement !== list) {
        list.appendChild(card);
        refreshQuestions();
        revealPoolCard(card);
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      refreshQuestions();
    }
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

  let _refreshFrame = 0;
  function refreshSoon() {
    if (!_refreshFrame) _refreshFrame = requestAnimationFrame(() => { _refreshFrame = 0; if (inQuestionEditor()) refreshQuestions(); });
  }
  function onQuestionsInput(e) {
    if (!inQuestionEditor()) return;
    if (e.target.matches('.pool-search')) {
      EX.poolQuery = e.target.value.trim().toLowerCase();
      return pagePool();
    }
    if (e.target.matches('.q-prompt, .q-points, .q-opt-text, .q-answer')) refreshSoon();
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
    if (action === 'pool') {
      if (!(await confirmLeaveIfDirty())) return;
      lockHeight(document.getElementById('section-body'));
      EX.view = 'list';
      return showPool();
    }
    if (action === 'pool-link-cancel') { EX.linking = null; return refreshQuestions(); }
    if (action === 'pool-open-all' || action === 'pool-fold-all') {
      document.querySelectorAll('#qe-list .pool-group').forEach(group => setGroupFolded(group, action === 'pool-fold-all'));
      return;
    }
    if (action === 'pool-unlink') return unlinkCard(questionCards().find(c => c.dataset.qid === EX.linking?.id));
    if (EX.view === 'pool' && action === 'export') { await loadPoolImages(); return exportQuestionsJson({ label: 'Question pool' }, collectQuestionCards({ strict: false })); }
    if (EX.view === 'pool' && action === 'import') return openImport(null);
    if (action === 'grades' || action === 'stats') {
      if (!(await confirmLeaveIfDirty())) return;
      return switchExamView(action === 'stats' ? 'stats' : 'submissions', exam.id);
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
    if (action === 'export') { await loadImages(exam); return exportQuestionsJson(exam, collectQuestionCards({ strict: false })); }
    if (action === 'import') return openImport(exam);
    if (action === 'split-points') return splitPoints();
    if (action === 'paper') {
      if (!(await confirmLeaveIfDirty())) return;
      return openPaperDialog(examById(exam.id) || exam);
    }
  }

  // ── Select: several questions at once ──
  // Select turns the bar into a selection bar and folds the cards into a list: a click
  // anywhere on a card ticks it, Shift+click ticks the cards in between, Ctrl+A ticks them
  // all and Esc (or Done) ends it, opening again the cards that were open. Cards don't move
  // or open meanwhile. The bar's points, Duplicate and Delete act on the ticked ones.
  const selectedCards = () => questionCards().filter(c => c.querySelector('.qcard-select-box')?.checked);
  const isSelecting = () => !!document.querySelector('.qe-topbar.is-selecting');
  function setSelecting(on) {
    const bar = document.querySelector('.qe-topbar'), list = document.getElementById('qe-list');
    if (!bar || !list || isSelecting() === on) return;
    toggleAddMenu(false);
    if (typeof closeRowMenus === 'function') closeRowMenus();
    const cards = questionCards();
    if (on) {
      EX.openBeforeSelect = cards.filter(c => !c.classList.contains('is-collapsed'));
      cards.forEach(c => setCollapsed(c, true));
    } else {
      cards.forEach(c => { c.querySelector('.qcard-select-box').checked = false; });
      (EX.openBeforeSelect || []).filter(c => c.isConnected).forEach(c => setCollapsed(c, false));
      EX.openBeforeSelect = null;
    }
    EX.selectAnchor = null;
    bar.classList.toggle('is-selecting', on);
    list.classList.toggle('is-selecting', on);
    EX.sortable?.option('disabled', on);
    refreshQuestions();
    document.querySelector(on ? '#qe-select-all' : '[data-qe="select"]')?.focus({ preventScroll: true });
  }
  function updateQuestionSelection() {
    const count = document.getElementById('qe-select-count');
    if (!count) return;
    const cards = questionCards(), chosen = selectedCards();
    cards.forEach(card => card.classList.toggle('is-selected', !!card.querySelector('.qcard-select-box')?.checked));
    count.textContent = `${chosen.length} of ${cards.length} selected`;
    const all = document.getElementById('qe-select-all');
    all.checked = cards.length > 0 && chosen.length === cards.length;
    all.indeterminate = chosen.length > 0 && chosen.length < cards.length;
    document.querySelectorAll('[data-qe="select-points"], [data-qe="select-duplicate"], [data-qe="select-delete"], #qe-select-points').forEach(b => { b.disabled = !chosen.length; });
  }
  function selectAllQuestions(on) {
    questionCards().forEach(c => { c.querySelector('.qcard-select-box').checked = on; });
    EX.selectAnchor = null;
    updateQuestionSelection();
  }
  function onSelectClick(card, e) {
    const box = card.querySelector('.qcard-select-box');
    if (e.target.closest('.qcard-select') && e.target !== box) return; // its label passes the click on to the box
    if (e.target !== box) box.checked = !box.checked;
    const anchor = EX.selectAnchor;
    if (e.shiftKey && anchor?.isConnected && anchor !== card) {
      const cards = questionCards(), a = cards.indexOf(anchor), b = cards.indexOf(card);
      cards.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(c => { c.querySelector('.qcard-select-box').checked = box.checked; });
    }
    EX.selectAnchor = card;
    updateQuestionSelection();
  }
  document.addEventListener('keydown', e => {
    if (!inQuestionEditor() || !isSelecting() || Dialogs.top()) return;
    if (document.querySelector('.row-menu-list:not([hidden])')) return;
    const typing = e.target.matches?.('input:not([type=checkbox]), textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') { e.preventDefault(); setSelecting(false); }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); selectAllQuestions(true); }
    else if (e.key === 'Enter' && e.target.id === 'qe-select-points') { e.preventDefault(); onSelectAction('select-points'); }
  });

  async function onSelectAction(action) {
    const chosen = selectedCards();
    if (action === 'select') return setSelecting(true);
    if (action === 'select-done') return setSelecting(false);
    if (!chosen.length) return;
    if (action === 'select-points') {
      const input = document.getElementById('qe-select-points');
      const points = num(input.value);
      if (points == null || points < 0) { input.classList.add('field-error'); input.focus(); return toast('Type the points: 0 or more', 'err'); }
      input.classList.remove('field-error');
      const questions = chosen.filter(c => c.dataset.type !== 'text_only');
      if (!questions.length) return toast('Information has no points', 'err');
      questions.forEach(c => { c.querySelector('.q-points').value = points; });
      markDirty();
      refreshQuestions();
      return toast(`${questions.length} question${questions.length === 1 ? '' : 's'}: ${pts(points)} point${points === 1 ? '' : 's'} each`, 'ok');
    }
    if (action === 'select-duplicate') {
      let last = chosen[chosen.length - 1];
      for (const card of chosen) {
        const copy = makeCard({ ...readCard(card), id: newQuestionId(), apart: undefined }, { collapsed: true });
        last.after(copy);
        if (EX.view === 'pool') syncCardModule(copy);
        last = copy;
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
      if (!questionCards().length) setSelecting(false);
      refreshQuestions();
    }
  }

  // Share 100 points evenly (the ⋯ menu): every question gets the same, in hundredths; when
  // 100 doesn't divide evenly, the last few get a hundredth more, so the total is exactly 100.
  // A pool item counts as the questions it draws, each with the same points: the hundredths
  // left over go to questions of the exam's own, and are dropped when it has too few.
  async function splitPoints() {
    const cards = questionCards().filter(c => c.dataset.type !== 'text_only');
    const countOf = c => (isPoolCard(c) ? poolItemOf(c).count : 1);
    const n = cards.reduce((sum, c) => sum + countOf(c), 0);
    if (!n) return toast('Add a question first', 'err');
    const base = Math.floor(10000 / n);
    let extra = 10000 - base * n;
    const singles = cards.filter(c => !isPoolCard(c));
    const plus = new Set(singles.slice(Math.max(0, singles.length - extra)));
    extra = plus.size;
    const each = new Map(cards.map(c => [c, (base + (plus.has(c) ? 1 : 0)) / 100]));
    const total = (base * n + extra) / 100;
    const low = base / 100, high = (base + 1) / 100;
    const what = n === 1 ? 'The question gets 100 points.'
      : !extra ? `Each of the ${n} questions gets ${pts(low)} points, ${pts(total)} in all.`
        : `Each of the ${n} questions gets ${pts(low)} points, and the last ${extra === 1 ? 'one' : extra} ${pts(high)}, so they add up to ${pts(total)}.`;
    if (!(await confirmDialog(`${what} Their points now are replaced.`, { title: 'Share Points Evenly', okLabel: 'Share', okIcon: 'fa-scale-balanced' }))) return;
    cards.forEach(c => { c.querySelector('.q-points').value = each.get(c); });
    markDirty();
    refreshQuestions();
    toast(`${pts(total)} points shared between ${n} question${n === 1 ? '' : 's'}`, 'ok');
  }

  // A card's question as stored (only its type's fields).
  function readCard(card) {
    if (isPoolCard(card)) return poolItemOf(card);
    const get = sel => card.querySelector(sel);
    const type = card.dataset.type;
    const q = { id: card.dataset.qid, type, prompt: get('.q-prompt').value.trim() };
    // A pool question: its module (where it is) and its link, without points.
    const pool = card.classList.contains('is-pool-question');
    if (pool) {
      q.module = card.closest('.pool-group')?.dataset.module ?? get('.q-module')?.value ?? '';
      const apart = get('.q-apart').value;
      if (apart && ((_collectLinks ? _collectLinks.get(apart) : linkedCards(card).length + 1) || 0) > 1) q.apart = apart;
    }
    const images = cardImageIds(card);
    if (images.length) {
      q.images = images;
      const size = get('.q-image-size').value;
      if (size && size !== 'medium') q.image_size = size;
    }
    if (type !== 'text_only') {
      if (!pool) q.points = num(get('.q-points').value) ?? 0;
      const explanation = get('.q-explanation').value.trim();
      if (explanation) q.explanation = explanation;
    }
    if (type === 'multiple_select') {
      const rows = [...card.querySelectorAll('.q-option')].map(r => ({ text: r.querySelector('.q-opt-text').value.trim(),
        correct: r.querySelector('.q-opt-correct').checked, image: r.querySelector('.q-opt-image').value || null })).filter(r => r.text);
      q.options = rows.map(r => r.text);
      q.correct_answers = rows.filter(r => r.correct).map(r => r.text);
      if (rows.some(r => r.image)) q.option_images = rows.map(r => r.image);
      if (card.querySelector('.q-allow-other')?.checked) q.allow_other = true;
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
    if (isPoolItem(q)) {
      if (q.count < 1) out.push(['.q-pool-count', 'it draws at least one question.', 'Draws none']);
      if (q.points < 0) out.push(['.q-pool-points', 'points must be 0 or more.', 'Points below 0']);
      // Every student gets the same number of questions, so an item must get its count.
      if (EX.pool && q.count > poolMost(q)) {
        out.push(['.q-pool-count', `it asks for ${q.count}, but the pool has only ${poolMost(q)} it can draw (one of each linked set). Every student must get the same number of questions.`, `Only ${poolMost(q)} can be drawn`]);
      } else if (EX.pool && poolShortfall(q) != null) {
        out.push(['.q-pool-count', `beside the other pool items, only ${poolShortfall(q)} of its ${q.count} can be drawn: they share questions or links. Every student must get the same number of questions.`,
          `Only ${poolShortfall(q)} can be drawn beside the other items`]);
      }
      return out;
    }
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

  let _collectLinks = null; // how many questions share each link, while collecting
  function collectQuestionCards({ strict = true } = {}) {
    _shortfalls = null;
    const questions = [];
    let first = null;
    let n = 0;
    _collectLinks = linkCounts(questionCards());
    try {
      for (const card of questionCards()) collectOne(card);
    } finally {
      _collectLinks = null;
    }
    function collectOne(card) {
      const q = readCard(card);
      const label = q.type === 'text_only' ? 'An information item' : isPoolItem(q) ? 'A pool item' : EX.view === 'pool' ? 'A question' : `Question ${++n}`;
      questions.push(q);
      if (!strict) return;
      card.querySelectorAll('.field-error').forEach(el => el.classList.remove('field-error'));
      for (const [selector, message] of cardProblems(card, q)) {
        const el = card.querySelector(selector);
        el?.classList.add('field-error');
        if (!first) first = { card, el, message: `${label}: ${message}` };
      }
    }
    if (first) {
      revealPoolCard(first.card);
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
    toast(`Questions saved (${questionCount(questions)})`, 'ok');
    return true;
  }
  // Ctrl+S: the questions editor or the pool, or the grading page's points (staying on the page).
  const saveExamsSection = () => (EX.view === 'questions' ? saveQuestions() : EX.view === 'pool' ? savePool()
    : EX.view === 'grading' && onGradingPage() ? saveGrades(null, { leave: false }) : true);


  // ── The question pool ──
  // The course's questions for every semester, a section per module (the Modules tab's, in its
  // order; then others the pool names; then questions without a module), each with an Add
  // question at its foot. The cards are the questions editor's, without points (an exam's pool
  // item gives them), with the module and a link: questions linked together are kept apart, a
  // student gets one of them at most. Drag a card to another module to move it there.
  const POOL_TYPES = Object.keys(QUESTION_TYPES).filter(t => t !== 'text_only');
  // The modules the pool shows: those of poolModules, and a place for questions without one when
  // the course has no modules.
  function poolGroupModules() {
    const groups = document.querySelectorAll('#qe-list .pool-group');
    if (groups.length) return [...groups].map(g => g.dataset.module);
    const list = poolModules();
    return list.length ? list : [''];
  }

  async function showPool(body = document.getElementById('section-body')) {
    if (!canManage()) return;
    if (EX.view !== 'pool' || !EX.pool) {
      body.innerHTML = loadingHtml(null, '', 'Loading the question pool…');
      await loadPool();
    }
    EX.poolQuery = '';
    if (!EX.pool) return toast('The question pool is not installed yet: run supabase/exams/2-functions.sql', 'err');
    EX.view = 'pool';
    EX.examId = null;
    EX.linking = null;
    body.onclick = onQuestionsClick;
    body.onchange = onQuestionsChange;
    body.oninput = onQuestionsInput;
    body.onkeydown = onQuestionsKeydown;
    body.onpaste = onQuestionsPaste;
    body.ondragover = onQuestionsDragOver;
    body.ondragleave = onQuestionsDragLeave;
    body.ondrop = onQuestionsDrop;
    const modules = poolModules();
    if (!modules.length) modules.push('');
    body.innerHTML = poolViewHtml(modules);
    const imagesLoaded = loadPoolImages();
    const questions = EX.pool.questions;
    for (const q of questions) {
      const module = String(q.module || '').trim();
      groupList(modules.includes(module) ? module : modules[modules.length - 1]).appendChild(questionCard(q, { collapsed: true, pool: true }));
    }
    refreshQuestions();
    EX.sortables = [...document.querySelectorAll('#qe-list .pool-group-list')].map(poolSortable).filter(Boolean);
    applyPoolFolds();
    EX.sortable = { option: (key, value) => EX.sortables.forEach(s => s.option(key, value)) };
    finishSectionLoad(body);
    imagesLoaded.then(() => { if (EX.view === 'pool') questionCards().forEach(card => { renderCardImages(card); renderOptions(card); }); });
  }

  function poolViewHtml(modules) {
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    const more = [
      { label: 'Select questions', icon: 'fa-regular fa-square-check', attrs: 'data-qe="select"', title: 'Duplicate or delete several at once' },
      { label: 'Fold all', icon: 'fa-solid fa-down-left-and-up-right-to-center', attrs: 'data-qe="collapse"' },
      { label: 'Open all modules', icon: 'fa-solid fa-folder-open', attrs: 'data-qe="pool-open-all"' },
      { label: 'Fold all modules', icon: 'fa-solid fa-folder', attrs: 'data-qe="pool-fold-all"' },
      { separator: true },
      { label: 'Import questions', icon: 'fa-solid fa-file-import', attrs: 'data-qe="import"', title: 'From a file, pasted, or the course\'s exams' },
      { label: 'Export the pool', icon: 'fa-solid fa-file-export', attrs: 'data-qe="export"', title: 'As a file, with modules, links and images' },
    ];
    return `
      <div class="section-topbar qe-topbar qe-pool-topbar">
        <div class="add-bar qe-nav">
          <button type="button" class="btn-sm btn-secondary" data-qe="back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All exams</button>
        </div>
        <label class="qe-sel-all" title="Select every question, or none"><input type="checkbox" id="qe-select-all" data-no-dirty><span id="qe-select-count">0 selected</span></label>
        <div class="add-bar qe-tools">
          <button type="button" class="btn-sm btn-green qe-add-btn" data-qe="add-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="qe-add-menu"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add question</button>
        </div>
        ${rowMenuHtml(more, { label: 'More: select, fold, import and export', className: 'qe-more' })}
        <div class="add-bar qe-sel-actions">
          <button type="button" class="btn-sm btn-secondary" data-qe="select-duplicate"><i class="fa-regular fa-copy" aria-hidden="true"></i> Duplicate</button>
          <button type="button" class="btn-sm btn-red" data-qe="select-delete"><i class="fa-regular fa-trash-can" aria-hidden="true"></i> Delete</button>
        </div>
        <button type="button" class="btn-sm qe-sel-done" data-qe="select-done" title="Stop selecting (Esc)"><i class="fa-solid fa-check" aria-hidden="true"></i> Done</button>
        <button class="btn-sm btn-save-section is-clean" id="section-save-btn" disabled title="Nothing to save" onclick="saveCurrentSection()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
        ${addMenuHtml(POOL_TYPES, false)}
        <div class="qe-pool-linking" id="pool-linking" hidden></div>
      </div>
      <div class="qe-head pool-head">
        <h3 class="qe-title">Question pool</h3>
        <span class="exam-muted" id="qe-summary"></span>
        <input type="search" class="classlist-search pool-search" placeholder="Search the pool" aria-label="Search the pool's questions" autocomplete="off" data-no-dirty>
      </div>
      <p class="qe-pool-intro">${x(header.code || EX.course)}'s questions for every semester, by module. Exams draw from them with <strong>Add question</strong>, <strong>From the pool</strong>; of linked questions, a student gets one at most.</p>
      <div class="qe-list pool-groups" id="qe-list">${modules.map(poolGroupHtml).join('')}</div>
      <div class="qe-empty" id="qe-empty" hidden></div>`;
  }

  function poolGroupHtml(module) {
    return `<section class="pool-group" data-module="${x(module)}" data-page="0">
      <header class="pool-group-head"><button type="button" class="pool-group-toggle" data-pool-fold aria-expanded="true">
        <i class="fa-solid fa-chevron-down pool-group-chevron" aria-hidden="true"></i><h4 class="pool-group-title">${x(moduleLabel(module))}</h4>
        <span class="pool-group-count"></span></button></header>
      <div class="pool-group-list"></div>
      <nav class="pool-pages" aria-label="Pages of ${x(moduleLabel(module))}" hidden></nav>
      <div class="block-add-bar pool-group-foot"><button type="button" class="block-add-btn" data-qe="add-menu" data-module="${x(module)}" aria-haspopup="menu" aria-expanded="false"><i class="fa-solid fa-plus" aria-hidden="true"></i>Add question</button></div>
    </section>`;
  }
  const groupOf = module => [...document.querySelectorAll('#qe-list .pool-group')].find(g => g.dataset.module === module) || null;
  const groupList = module => groupOf(module)?.querySelector('.pool-group-list');
  // Cards move between modules by dragging, as within one.
  // While a card is dragged, folded modules open a strip to drop it in.
  const poolSortable = list => (window.Sortable ? Sortable.create(list, {
    group: 'pool-questions', handle: '.qcard-grip', draggable: '.qcard', animation: 150, ghostClass: 'qcard-ghost',
    onStart: () => document.getElementById('qe-list')?.classList.add('is-dragging'),
    onEnd: e => {
      document.getElementById('qe-list')?.classList.remove('is-dragging');
      syncCardModule(e.item);
      refreshQuestions();
      revealPoolCard(e.item);
      markDirty();
    },
  }) : null);
  // A module the pool doesn't show yet (an import names it): added before "No module".
  function ensureGroup(module) {
    if (groupOf(module)) return groupOf(module);
    const none = module !== '' && groupOf('');
    if (none) none.insertAdjacentHTML('beforebegin', poolGroupHtml(module));
    else document.getElementById('qe-list').insertAdjacentHTML('beforeend', poolGroupHtml(module));
    const sortable = poolSortable(groupList(module));
    if (sortable) EX.sortables.push(sortable);
    // Every card's module choice lists it.
    const modules = poolGroupModules();
    document.querySelectorAll('#qe-list .q-module').forEach(select => {
      const value = select.value;
      select.innerHTML = modules.map(m => `<option value="${x(m)}">${x(moduleLabel(m))}</option>`).join('');
      select.value = value;
    });
    return groupOf(module);
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !EX.linking || !inQuestionEditor() || Dialogs.top()) return;
    e.preventDefault();
    EX.linking = null;
    refreshQuestions();
  });

  // A card dragged to another module takes that module.
  function syncCardModule(card) {
    const module = card.closest('.pool-group')?.dataset.module;
    const select = card.querySelector('.q-module');
    if (select && module != null && select.value !== module) select.value = module;
  }

  // Each module's count (and what kinds), the empty ones, and the pool's summary.
  function refreshPoolGroups(attention) {
    let total = 0, filled = 0;
    document.querySelectorAll('#qe-list .pool-group').forEach(group => {
      const cards = [...group.querySelectorAll('.pool-group-list > .qcard')];
      total += cards.length;
      if (cards.length) filled++;
      const kinds = {};
      cards.forEach(c => { kinds[c.dataset.type] = (kinds[c.dataset.type] || 0) + 1; });
      group.querySelector('.pool-group-count').textContent = cards.length
        ? `${cards.length} question${cards.length === 1 ? '' : 's'}: ${Object.entries(kinds).map(([t, n]) => `${n} ${QUESTION_TYPES[t].label.toLowerCase()}`).join(', ')}` : '';
      group.classList.toggle('is-empty', !cards.length);
    });
    const sets = new Set([...linkCounts(questionCards())].filter(([, n]) => n > 1).map(([apart]) => apart));
    arrangePoolLinks();
    pagePool();
    document.getElementById('qe-summary').textContent = total
      ? `${total} question${total === 1 ? '' : 's'} in ${filled} module${filled === 1 ? '' : 's'}${sets.size ? `, ${sets.size} linked set${sets.size === 1 ? '' : 's'}` : ''}${attention ? `, ${attention} to fix` : ''}`
      : 'No questions yet';
    renderPoolLinking();
  }

  // ── Folding the pool's modules, its pages, its search, and linked sets together ──
  // A module folds from its heading, as this browser remembers per course (a long pool starts
  // folded). Each module shows 15 questions a page; a linked set is never split, and every card
  // stays on the page, hidden, so dragging to another module, linking across pages and saving
  // work as before. A search shows the questions that match, in every module.
  const POOL_PAGE = 15;
  const poolFoldKey = () => `pool_folded:${EX.pool?.course || EX.course}`;
  function poolFolds() {
    try { const saved = JSON.parse(localStorage.getItem(poolFoldKey()) || 'null'); if (saved && typeof saved === 'object') return saved; } catch { }
    return null;
  }
  function applyPoolFolds() {
    const saved = poolFolds();
    const long = (EX.pool?.questions.length || 0) > 20;
    document.querySelectorAll('#qe-list .pool-group').forEach(group => {
      const folded = saved && group.dataset.module in saved ? !!saved[group.dataset.module] : long;
      setGroupFolded(group, folded, false);
    });
  }
  // Opening bounces a little and folding is quick (css/course-exams.css .is-opening, .is-closing);
  // when remembered from before (remember false), it just is.
  function setGroupFolded(group, folded, remember = true) {
    const was = group.classList.contains('is-folded');
    clearTimeout(group._foldTimer);
    group.classList.remove('is-opening', 'is-closing');
    if (remember && was !== folded && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (folded) {
        group.classList.add('is-closing');
        group._foldTimer = setTimeout(() => { group.classList.remove('is-closing'); group.classList.add('is-folded'); }, 150);
      } else {
        group.classList.remove('is-folded');
        group.classList.add('is-opening');
        group._foldTimer = setTimeout(() => group.classList.remove('is-opening'), 450);
      }
    } else group.classList.toggle('is-folded', folded);
    group.querySelector('.pool-group-toggle')?.setAttribute('aria-expanded', String(!folded));
    if (!remember) return;
    const saved = poolFolds() || {};
    saved[group.dataset.module] = folded;
    try { localStorage.setItem(poolFoldKey(), JSON.stringify(saved)); } catch { }
  }
  function onPoolNav(btn) {
    const group = btn.closest('.pool-group');
    if (!group) return;
    if ('poolFold' in btn.dataset) return setGroupFolded(group, !group.classList.contains('is-folded'));
    group.dataset.page = btn.dataset.poolPage;
    pagePool();
    group.querySelector('.pool-group-head').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // How many questions share each link.
  function linkCounts(cards) {
    const counts = new Map();
    for (const card of cards) {
      const apart = card.querySelector('.q-apart')?.value;
      if (apart) counts.set(apart, (counts.get(apart) || 0) + 1);
    }
    return counts;
  }

  // Each module's linked questions one after another, under a line that says they are linked.
  // Cards move only when a set is not together yet (after linking, or a drag).
  function arrangePoolLinks() {
    document.querySelectorAll('#qe-list .pool-group-list').forEach(list => {
      const cards = [...list.querySelectorAll(':scope > .qcard')];
      const apartOf = c => c.querySelector('.q-apart')?.value || '';
      const order = [], placed = new Set();
      for (const card of cards) {
        if (placed.has(card)) continue;
        const apart = apartOf(card);
        for (const c of apart ? cards.filter(o => apartOf(o) === apart) : [card]) { order.push(c); placed.add(c); }
      }
      if (order.some((c, i) => c !== cards[i])) {
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        order.forEach(c => list.appendChild(c));
        focused?.focus({ preventScroll: true });
      }
      const heads = [];
      order.forEach((card, i) => {
        const apart = apartOf(card), before = i ? apartOf(order[i - 1]) : '', after = order[i + 1] ? apartOf(order[i + 1]) : '';
        const inSet = !!apart && (apart === before || apart === after);
        card.classList.toggle('in-link-set', inSet);
        card.classList.toggle('link-set-last', inSet && apart !== after);
        if (inSet) card.style.setProperty('--link-hue', hashOf(apart) % 360); else card.style.removeProperty('--link-hue');
        if (inSet && apart !== before) heads.push([card, apart, order.filter(c => apartOf(c) === apart).length]);
      });
      // The lines over the sets, rewritten only when the sets changed.
      const sig = heads.map(([card, apart, n]) => `${card.dataset.qid}:${apart}:${n}`).join('|');
      if (list.dataset.links === sig) return;
      list.dataset.links = sig;
      list.querySelectorAll(':scope > .pool-link-head').forEach(h => h.remove());
      for (const [card, apart, n] of heads) {
        card.insertAdjacentHTML('beforebegin', `<div class="pool-link-head" style="--link-hue:${hashOf(apart) % 360}" data-set="${x(apart)}">
          <i class="fa-solid fa-link" aria-hidden="true"></i><span>Linked, ${n} questions: a student gets one of them at most</span></div>`);
      }
    });
  }

  // The pages of a module's cards: about POOL_PAGE each, a linked set never split.
  function poolPages(cards) {
    const pages = [];
    let page = [];
    for (let i = 0; i < cards.length;) {
      const apart = cards[i].querySelector('.q-apart')?.value || '';
      let j = i + 1;
      while (apart && j < cards.length && (cards[j].querySelector('.q-apart')?.value || '') === apart) j++;
      const unit = cards.slice(i, j);
      if (page.length && page.length + unit.length > POOL_PAGE) { pages.push(page); page = []; }
      page.push(...unit);
      i = j;
    }
    if (page.length) pages.push(page);
    return pages;
  }
  const poolCardText = card => [card.querySelector('.q-prompt')?.value, ...[...card.querySelectorAll('.q-opt-text, .q-answer, .q-accepted')].map(el => el.value)]
    .join(' ').toLowerCase();

  function pagePool() {
    const query = EX.poolQuery || '';
    let found = 0;
    document.querySelectorAll('#qe-list .pool-group').forEach(group => {
      const cards = [...group.querySelectorAll('.pool-group-list > .qcard')];
      const nav = group.querySelector('.pool-pages');
      if (query) {
        let hits = 0;
        cards.forEach(card => { const hit = poolCardText(card).includes(query); card.classList.toggle('is-paged-out', !hit); if (hit) hits++; });
        found += hits;
        group.classList.add('is-searching');
        group.classList.toggle('is-filtered-out', !hits);
        nav.hidden = true;
      } else {
        group.classList.remove('is-searching', 'is-filtered-out');
        const pages = poolPages(cards);
        const at = Math.max(0, Math.min(Number(group.dataset.page) || 0, pages.length - 1));
        group.dataset.page = at;
        pages.forEach((page, i) => page.forEach(card => card.classList.toggle('is-paged-out', i !== at)));
        nav.hidden = pages.length < 2;
        if (pages.length > 1) {
          const from = pages.slice(0, at).reduce((n, p) => n + p.length, 0);
          const html = `<span class="pool-pages-range">${from + 1}–${from + pages[at].length} of ${cards.length}</span>
            <button type="button" class="pool-page" data-pool-page="${at - 1}" ${at ? '' : 'disabled'} aria-label="Previous page"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            ${pageNumbers(at, pages.length).map(i => i == null ? '<span class="pool-page-gap">…</span>'
              : `<button type="button" class="pool-page" data-pool-page="${i}" ${i === at ? 'aria-current="page"' : ''}>${i + 1}</button>`).join('')}
            <button type="button" class="pool-page" data-pool-page="${at + 1}" ${at < pages.length - 1 ? '' : 'disabled'} aria-label="Next page"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
          setHtml(nav, html);
        }
      }
      // A set's line shows with its first question.
      group.querySelectorAll('.pool-group-list > .pool-link-head').forEach(head => {
        head.hidden = !!head.nextElementSibling?.classList.contains('is-paged-out');
      });
    });
    const none = document.getElementById('pool-search-none');
    if (query && !found && !none) document.getElementById('qe-list')?.insertAdjacentHTML('beforebegin', `<p class="pool-search-none" id="pool-search-none">No question matches.</p>`);
    else if ((!query || found) && none) none.remove();
  }

  // A card brought into view: its module open, on the page that has it, outside a search that
  // hides it.
  function revealPoolCard(card) {
    const group = card?.closest('.pool-group');
    if (!group || EX.view !== 'pool') return;
    if (group.classList.contains('is-folded')) setGroupFolded(group, false);
    if (EX.poolQuery && card.classList.contains('is-paged-out')) {
      EX.poolQuery = '';
      const search = document.querySelector('.pool-search');
      if (search) search.value = '';
    }
    const pages = poolPages([...group.querySelectorAll('.pool-group-list > .qcard')]);
    const at = pages.findIndex(page => page.includes(card));
    if (at >= 0) group.dataset.page = at;
    pagePool();
  }

  // ── Linking pool questions (on the pool's cards) ──
  // The link of a card: the others with the same "apart".
  const linkedCards = card => {
    const apart = card.querySelector('.q-apart')?.value;
    return apart ? questionCards().filter(c => c !== card && c.querySelector('.q-apart')?.value === apart) : [];
  };
  const cardName = card => poolQuestionName({ prompt: card.querySelector('.q-prompt')?.value || '' });

  // Link on a card: chosen first, then the question to link it with (its Link again, or Cancel,
  // stops). Joining two linked sets makes one; Unlink takes the first one out of its set.
  function onCardLink(card) {
    const source = EX.linking && questionCards().find(c => c.dataset.qid === EX.linking.id);
    if (!source || source === card) EX.linking = source ? null : { id: card.dataset.qid };
    else {
      const a = source.querySelector('.q-apart'), b = card.querySelector('.q-apart');
      const group = a.value || b.value || newQuestionId();
      const joined = new Set([a.value, b.value].filter(Boolean));
      questionCards().forEach(c => { const input = c.querySelector('.q-apart'); if (input && (c === source || c === card || joined.has(input.value))) input.value = group; });
      EX.linking = null;
      markDirty();
      refreshQuestions();
      revealPoolCard(source);
      return;
    }
    refreshQuestions();
  }
  function unlinkCard(card) {
    const input = card?.querySelector('.q-apart');
    if (!input) return;
    const rest = linkedCards(card);
    input.value = '';
    if (rest.length === 1) rest[0].querySelector('.q-apart').value = '';
    EX.linking = null;
    markDirty();
    refreshQuestions();
  }
  function renderPoolLinking() {
    const banner = document.getElementById('pool-linking');
    if (!banner) return;
    const source = EX.linking && questionCards().find(c => c.dataset.qid === EX.linking.id);
    if (EX.linking && !source) EX.linking = null;
    questionCards().forEach(c => {
      c.classList.toggle('is-link-source', c === source);
      const btn = c.querySelector('[data-qc="link"]');
      if (!btn) return;
      btn.classList.toggle('is-link-target', !!source && c !== source);
      const title = c === source ? 'Cancel linking' : source ? 'Link with the chosen question' : 'Link with another question: a student gets one of them at most';
      btn.title = title;
      btn.setAttribute('aria-label', title);
    });
    banner.hidden = !source;
    if (source) {
      banner.innerHTML = `<i class="fa-solid fa-link" aria-hidden="true"></i><span>Choose the question to link with <strong>${x(cardName(source))}</strong>: its <i class="fa-solid fa-link" aria-hidden="true"></i> button. A student then gets one of them at most.</span>
        ${linkedCards(source).length ? '<button type="button" class="btn-sm btn-secondary" data-qe="pool-unlink">Unlink it</button>' : ''}
        <button type="button" class="btn-sm btn-secondary" data-qe="pool-link-cancel">Cancel</button>`;
    }
  }

  async function savePool() {
    if (document.querySelector('#qe-list .q-image.is-adding')) { toast('Images are still being added: save once they are in', 'err'); return false; }
    const questions = collectQuestionCards();
    if (!questions) return false;
    try {
      EX.pool.questions = await rpc('exam_save_pool', { p_sheet: EX.course, p_archive: EX.isArchive, p_questions: questions });
    } catch (error) {
      toast('Save failed: ' + error.message, 'err');
      return false;
    }
    rememberSavedSection();
    toast(`Pool saved (${questions.length})`, 'ok');
    return true;
  }

  // A pool item's head: what it draws from.
  function poolSummary(item) {
    const kinds = item.kinds.map(t => QUESTION_TYPES[t]?.label).filter(Boolean);
    const modules = item.modules.map(moduleLabel);
    return `${kinds.length ? kinds.join(', ') : 'Any type'} from ${modules.length ? modules.join(', ') : 'all modules'}`;
  }


  // ── Preview: the exam page in a new tab, taken as a student would, where nothing is saved or sent ──
  // The tab (/exam/?preview=<exam id>) asks this one for its exam once it has loaded, and again
  // after a reload, and gets the questions as they are in the editor, without the answers. It
  // needn't be visible or open, and the timer starts when the tab does.
  const EXAM_PAGE = new URL('exam/', window.TEACHING_CONFIG.appBaseUrl);
  const _previews = new Map(); // exam id → { payload, waiting: tabs that asked before it was ready }

  // As students receive questions (exam_private.student_questions).
  const studentQuestion = ({ correct_answers, accepted_answers, answer, tolerance, explanation, pool, module, apart, ...rest }) => rest;

  // Pool items: the draw of the student the questions editor shows (Student 1 elsewhere).
  // Each preview (and each Try again in it) is another student: their own order of the questions
  // and of the options, and their own draw from the pool, as two students would differ.
  const previewStudent = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 1000000);
  async function tryAsStudent(exam, questions) {
    if (!exam) return;
    const source = questions;
    const draw = () => (hasPool(source) ? drawnQuestions(source, sampleDraws(source, previewStudent())) : source);
    if (!draw().length) { toast('Add a question first', 'err'); return; }
    // Opened before anything is awaited, so the browser takes it as the click's own tab.
    const url = new URL(EXAM_PAGE);
    url.searchParams.set('preview', exam.id);
    const entry = { payload: null, waiting: [] };
    _previews.set(exam.id, entry);
    const tab = window.open(url.href, `exam-preview-${exam.id}`);
    if (!tab) { toast('The browser blocked the new tab. Allow pop-ups for this site, then try again.', 'err'); return; }
    await Promise.all([loadImages(exam), hasPool(source) ? loadPoolImages() : null]);
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    const me = S.access || {};
    entry.payload = () => {
      const drawn = draw();
      const ids = allImageIdsOf(drawn);
      return {
        id: exam.id, label: exam.label, type: exam.type, duration_minutes: exam.duration_minutes, hall: exam.hall,
        base: exam.base, weight: exam.weight, sign_in: signInOf(exam), shuffle_questions: exam.shuffle_questions !== false,
        settings: settingsOf(exam), course_code: header.code || EX.course, course_title: header.title || '',
        questions: drawn.map(studentQuestion),
        images: Object.fromEntries(ids.filter(id => EX.images[id]).map(id => [id, EX.images[id]])),
        student: { name: me.display_name || me.name || me.email || 'Student', email: me.email || '', student_no: '' },
        seed: `preview:${previewStudent()}`,
      };
    };
    entry.waiting.forEach(tab => sendPreview(tab, entry.payload()));
    entry.waiting = [];
  }

  function sendPreview(source, payload) {
    try { source.postMessage({ type: 'syllabase-exam-preview', payload }, EXAM_PAGE.origin); } catch { }
  }

  window.addEventListener('message', e => {
    if (e.origin !== EXAM_PAGE.origin || e.data?.type !== 'syllabase-exam-preview-ready' || !e.source) return;
    const entry = _previews.get(e.data.examId);
    if (!entry) return;
    if (entry.payload) sendPreview(e.source, entry.payload());
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
    const sources = imageIdsOf([q]).map(imageSrc).filter(Boolean);
    return sources.length ? `<div class="${className}">${sources.map((src, i) => `<img src="${x(src)}" alt="Image ${i + 1}">`).join('')}</div>` : '';
  }

  // Bold, italic, lists… as students see them (js/format-text.js).
  const promptHtml = text => formatQuestionText(text);


  // ── Import and export ──
  // The exchange format: plain names that another program, or a person, can write.
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

  function toFriendly(q, linkName = null) {
    if (isPoolItem(q)) return { type: 'pool', count: poolCount(q), points: q.points ?? 1, modules: q.modules || [], types: (q.kinds || []).map(t => FRIENDLY_TYPES[t] || t), exclude: q.exclude || [] };
    const out = { type: FRIENDLY_TYPES[q.type] || q.type };
    if (q.module) out.module = q.module;
    // Linked questions share a link name ("A", "B"…): a student gets one of them at most.
    if (q.apart && linkName) out.link = linkName(q.apart);
    if (q.type !== 'text_only') out.points = q.points ?? 1;
    out.question = q.prompt || '';
    if (q.type === 'multiple_select') {
      out.options = q.options || [];
      out.correct = q.correct_answers || [];
      if (q.allow_other) out.other = true;
      // An option's image, in the option's place (null for none).
      const optionImages = (q.options || []).map((o, i) => (q.option_images?.[i] && EX.images[q.option_images[i]]) || null);
      if (optionImages.some(Boolean)) out.option_images = optionImages;
    }
    if (q.type === 'true_false' && typeof q.answer === 'boolean') out.answer = q.answer;
    if (q.type === 'short_answer' && q.accepted_answers?.length) out.accepted = q.accepted_answers;
    if (q.type === 'numeric') { out.answer = q.answer; if (q.tolerance) out.tolerance = q.tolerance; if (q.unit) out.unit = q.unit; }
    if (q.type === 'long_answer') {
      if (q.content) out.starting_text = q.content;
      if (typeof q.answer === 'string' && q.answer.trim()) out.model_answer = q.answer;
    }
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
    // A pool item (from an exported exam): what it draws from the course's pool.
    if (typeName === 'pool') {
      const count = num(pick('count', 'questions', 'draw'));
      const points = num(pick('points', 'marks'));
      return { q: { type: 'pool', count: count != null && count >= 1 ? Math.min(100, Math.floor(count)) : 1, points: points != null && points >= 0 ? points : 1,
        modules: list(pick('modules', 'module')).map(m => String(m).trim()).filter(Boolean),
        kinds: list(pick('types', 'kinds')).map(t => TYPE_ALIASES[String(t).toLowerCase().replace(/[\s-]+/g, '_')]).filter(t => t && t !== 'text_only'),
        exclude: list(pick('exclude')).map(String) } };
    }
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
    const module = pick('module', 'chapter', 'topic');
    if (module != null && typeof module !== 'object') q.module = String(module).trim();
    const link = pick('link', 'linked', 'link_group', 'apart', 'group');
    if (link != null && typeof link !== 'object' && String(link).trim()) q.apart = String(link).trim();
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
      // Each option's image, in its place: data URLs (from an export) or this course's image ids.
      const rawImages = list(pick('option_images', 'option_figures'));
      const imageAt = i => (typeof rawImages[i] === 'string' && (UUID.test(rawImages[i]) || IMPORT_IMAGE.test(rawImages[i])) ? rawImages[i] : null);
      const kept = options.map((o, i) => [o, imageAt(i)]).filter(([o]) => o);
      q.options = kept.map(([o]) => o);
      if (kept.some(([, image]) => image)) q.option_images = kept.map(([, image]) => image);
      q.correct_answers = q.options.filter(o => correct.has(o));
      // "other": true adds Other, where students write their own answer.
      const other = pick('other', 'allow_other', 'write_in');
      if (other === true || /^(true|yes|1)$/i.test(String(other ?? '').trim())) q.allow_other = true;
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
      // The model answer: what Autograde compares with.
      const model = pick('model_answer', 'model', 'sample_answer', 'answer');
      if (typeof model === 'string' && model.trim()) q.answer = model.trim();
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

  // An imported question's images (its own and its options') as ids: data URLs are scaled down
  // and saved for this course.
  async function importImages(q) {
    const save = async image => {
      if (!image || UUID.test(image)) return image || null;
      try { return await saveImage(await (await fetch(image)).blob()); }
      catch (error) { toast(`An imported image was skipped: ${error.message}`, 'err'); return null; }
    };
    if (q.images) {
      const ids = [];
      for (const image of q.images) { const id = await save(image); if (id) ids.push(id); }
      if (ids.length) q.images = ids; else delete q.images;
    }
    if (q.option_images) {
      const ids = [];
      for (const image of q.option_images) ids.push(await save(image));
      if (ids.some(Boolean)) q.option_images = ids; else delete q.option_images;
    }
    return q;
  }
  const newImagesOf = q => [...(q.images || []), ...(q.option_images || [])].some(v => v && !UUID.test(v));

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
    if (data === undefined) return { fatal: 'This is not JSON. Paste questions converted with the instructions below, or an export.' };
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

  const CONVERT_INSTRUCTIONS = `Convert the exam I give you into questions for Syllabase. Reply with JSON only, no other text, in exactly this shape:

{
  "format": "syllabase-questions",
  "version": 1,
  "questions": [
    { "type": "multiple_choice", "points": 2, "question": "Which material is strongest in tension?", "options": ["Concrete", "Steel", "Timber"], "correct": ["Steel"], "explanation": "Optional, shown to students with their grade." },
    { "type": "true_false", "points": 1, "question": "Concrete is strong in compression.", "answer": true },
    { "type": "short_answer", "points": 1, "question": "What is the SI unit of stress?", "accepted": ["Pa", "Pascal", "N/m²"] },
    { "type": "numeric", "points": 3, "question": "A 10 kN force acts on 800 mm². Find the stress.", "answer": 12.5, "tolerance": 0.1, "unit": "MPa" },
    { "type": "long_answer", "points": 5, "question": "Explain the difference between ductile and brittle failure.", "model_answer": "Optional: what a full answer says." },
    { "type": "code", "points": 4, "question": "Write a function area(r) that returns a circle's area.", "language": "python", "starter_code": "def area(r):\\n    pass" },
    { "type": "file", "points": 5, "question": "Upload your hand calculations.", "allowed_types": [".pdf"], "max_size_mb": 10 },
    { "type": "text", "question": "Part B: answer the questions below. (Instructions and headings; not graded.)" }
  ]
}

Rules:
- Keep the original wording, numbers and order. Write formulas in plain text, e.g. σ = F/A.
- "correct" lists the right option(s), copied exactly from "options". Leave labels like "a)" out of the options.
- Add "other": true to a multiple-choice question whose last option asks students to write their own answer (e.g. "Other: ____"), and leave that option out of "options".
- Use "true_false" for true-or-false statements, with "answer": true or false.
- Use "numeric" when the answer is one number. "tolerance" is how far off an answer may be (leave it out for exact answers).
- "accepted" lists acceptable short answers; leave it out when any wording may be right.
- Use "text" for instructions, reading passages and section headings.
- "points" are the question's points (1 when the exam doesn't say). "explanation" is optional.
- "module" (optional) is the chapter or module a question belongs to, when the material says so.
- "link" (optional) gives questions that are alike, or that give each other away, the same name, e.g. "link": "A": a student then gets one of them at most. Only for a question pool.
- Formatting in question text: **bold**, *italic*, __underline__, m^2^ (superscript), H~2~O (subscript), \`code\`; lines starting with "- " make a bulleted list, "1. " a numbered one. Keep the original's formatting this way; don't add any of your own.
- For a question that needs a figure, describe the figure or write [see figure]: images are added in the editor.`;

  function exportQuestionsJson(exam, questions) {
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    // Links get short names, A, B… AA, in the order they first come.
    const linked = new Map(), counts = new Map();
    questions.forEach(q => { if (q.apart) counts.set(q.apart, (counts.get(q.apart) || 0) + 1); });
    const letters = n => (n >= 26 ? letters(Math.floor(n / 26) - 1) : '') + String.fromCharCode(65 + (n % 26));
    const linkName = apart => (counts.get(apart) > 1 ? (linked.get(apart) || linked.set(apart, letters(linked.size)).get(apart)) : undefined);
    const data = { format: 'syllabase-questions', version: 1, source: [header.code || EX.course, examTitle(exam)].filter(Boolean).join(' '),
      exported: new Date().toISOString().slice(0, 10), questions: questions.map(q => toFriendly(q, linkName)) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${slug(EX.course)}_${slug(examTitle(exam))}_questions.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`Exported ${questions.length} question${questions.length === 1 ? '' : 's'}`, 'ok');
  }

  // exam null: into the question pool, which takes questions only (no information or pool
  // items, no points), in the module chosen here or the one the file names.
  function openImport(exam) {
    const toPool = !exam;
    const others = EX.data.exams.filter(e => e.id !== exam?.id && (e.questions || []).some(q => !toPool || (!isPoolItem(q) && q.type !== 'text_only')));
    const shownType = q => (isPoolItem(q) ? { icon: POOL_ICON, label: 'From the pool' } : QUESTION_TYPES[q.type]);
    const ov = overlay('q-import');
    ov.title(toPool ? 'Import questions into the pool' : 'Import questions');
    ov.body.innerHTML = `
      <div class="form-group"><label class="form-label" for="qi-text">Paste questions <span class="label-note">JSON, converted or exported</span></label>
        <textarea id="qi-text" class="qi-text" rows="8" spellcheck="false"></textarea>
        <div class="qi-file-row"><input type="file" id="qi-file" accept=".json,application/json,.txt,text/plain" hidden>
          <button type="button" class="btn-sm btn-secondary qi-file" id="qi-file-choose"><i class="fa-solid fa-folder-open" aria-hidden="true"></i>Choose a file</button>
          <span class="form-hint">An exported .json file works too.</span></div></div>
      ${others.length ? `<div class="form-group"><label class="form-label" for="qi-exam">Or copy them from ${toPool ? 'an exam' : 'another exam'} of this course</label>
        <select id="qi-exam"><option value="">Choose an exam</option>${others.map(e => `<option value="${x(e.id)}">${x(examTitle(e))} (${questionCount(e.questions)})</option>`).join('')}</select></div>` : ''}
      ${toPool ? `<div class="form-group"><label class="form-label" for="qi-module">Module</label>
        <select id="qi-module"><option value="@file">As the file says (else ${x(NO_MODULE.toLowerCase())})</option>${poolGroupModules().map(m => `<option value="${x(m)}">${x(moduleLabel(m))}</option>`).join('')}</select></div>` : ''}
      <div class="qi-claude">
        <i class="fa-solid fa-file-lines" aria-hidden="true"></i>
        <div><p><strong>Questions from another exam?</strong> The instructions describe this format: use them to convert the exam (PDF, Word or text), then paste the result above.</p>
          <button type="button" class="btn-sm btn-secondary" id="qi-copy"><i class="fa-solid fa-copy"></i> Copy instructions</button></div>
      </div>
      <div id="qi-preview" class="qi-preview" aria-live="polite"></div>
      <div class="qi-mode" id="qi-mode" hidden>
        <label class="exam-inline-check"><input type="radio" name="qi-mode" value="append" checked> Add ${toPool ? 'to' : 'after'} the current questions</label>
        <label class="exam-inline-check"><input type="radio" name="qi-mode" value="replace"> Replace the current questions</label>
      </div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-green" type="button" id="qi-go" disabled><i class="fa-solid fa-file-import" style="margin-right:5px"></i>Import</button>`;
    let parsed = null;
    const show = result => {
      // The pool takes questions only: information and pool items are left out (and said so).
      if (toPool && result?.questions) {
        const skipped = result.questions.filter(q => isPoolItem(q) || q.type === 'text_only').length;
        result = { ...result, questions: result.questions.filter(q => !isPoolItem(q) && q.type !== 'text_only'),
          problems: [...(result.problems || []), ...(skipped ? [{ level: 'warn', text: `${skipped} information or pool item${skipped === 1 ? '' : 's'} left out: the pool takes questions only.` }] : [])] };
      }
      parsed = result;
      const preview = document.getElementById('qi-preview');
      document.getElementById('qi-go').disabled = !result?.questions?.length;
      document.getElementById('qi-mode').hidden = !result?.questions?.length || !questionCards().length;
      if (!result) { preview.innerHTML = ''; return; }
      if (result.fatal) { preview.innerHTML = `<p class="exam-error">${x(result.fatal)}</p>`; return; }
      const counts = {};
      result.questions.forEach(q => { counts[q.type] = (counts[q.type] || 0) + 1; });
      preview.innerHTML = `<p class="qi-summary"><strong>${result.questions.length}</strong> question${result.questions.length === 1 ? '' : 's'} ready: ${Object.keys(counts).map(t => `${counts[t]} ${x((t === 'pool' ? 'from the pool' : QUESTION_TYPES[t].label).toLowerCase())}`).join(', ')}</p>
        <ol class="qi-list">${result.questions.map(q => `<li><i class="${shownType(q).icon}" aria-hidden="true"></i><span>${isPoolItem(q) ? x(`${poolCount(q)} drawn: ${poolSummary({ kinds: q.kinds || [], modules: q.modules || [] })}`) : formatQuestionText.inline(q.prompt.split('\n')[0].replace(/^\s*([-•]|\d+[.)])\s+/, ''))}</span>${toPool && q.module ? `<em>${x(q.module)}</em>` : !toPool && q.type !== 'text_only' ? `<em>${fmt(isPoolItem(q) ? poolCount(q) * (num(q.points) ?? 0) : q.points)} pt</em>` : ''}</li>`).join('')}</ol>
        ${result.problems.length ? `<ul class="qi-problems">${result.problems.map(p => `<li class="qi-${p.level}">${x(p.text)}</li>`).join('')}</ul>` : ''}`;
    };
    const text = document.getElementById('qi-text');
    text.oninput = () => { const examSelect = document.getElementById('qi-exam'); if (examSelect) examSelect.value = ''; show(parseImport(text.value)); };
    document.getElementById('qi-file-choose').onclick = () => document.getElementById('qi-file').click();
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
      try { await navigator.clipboard.writeText(CONVERT_INSTRUCTIONS); toast('Instructions copied', 'ok'); }
      catch { toast('Could not copy', 'err'); }
    };
    document.getElementById('qi-go').onclick = async () => {
      if (!parsed?.questions?.length) return;
      const replace = document.querySelector('input[name="qi-mode"]:checked')?.value === 'replace' && questionCards().length;
      if (replace && !(await confirmDialog(`Replace the ${questionCards().length} current questions with the ${parsed.questions.length} imported ones?`, { title: 'Replace Questions', okLabel: 'Replace', danger: true }))) return;
      const go = document.getElementById('qi-go');
      const withImages = parsed.questions.filter(newImagesOf).length;
      if (withImages) {
        go.disabled = true;
        go.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Adding images…';
      }
      const questions = [];
      for (const q of parsed.questions) questions.push(await importImages(q));
      if (replace) questionCards().forEach(card => card.remove());
      const many = questions.length + questionCards().length > 4;
      // Into the pool: each into its module (the one chosen, else the file's, added when the pool
      // has no such module); copied from an exam, a question is new to the pool (a new id),
      // without points.
      const chosen = document.getElementById('qi-module')?.value;
      // The file's links (its own names) become new links of the pool, so they never join
      // links the pool has already; a name only one question has links nothing.
      const named = new Map();
      questions.forEach(q => { if (q.apart) named.set(q.apart, (named.get(q.apart) || 0) + 1); });
      const links = new Map();
      const linkOf = name => (name && named.get(name) > 1 ? (links.get(name) || links.set(name, newQuestionId()).get(name)) : undefined);
      const added = questions.map(q => {
        let card;
        if (toPool) {
          const module = chosen !== '@file' ? chosen : String(q.module || '').trim();
          ensureGroup(module);
          const { points, ...rest } = q;
          card = questionCard({ ...rest, id: newQuestionId(), module, apart: linkOf(q.apart) }, { collapsed: many, pool: true });
          groupList(module).appendChild(card);
          syncCardModule(card);
        } else {
          card = makeCard(q, { collapsed: many });
          document.getElementById('qe-list').appendChild(card);
        }
        card.classList.add('is-new');
        return card;
      });
      markDirty();
      refreshQuestions();
      if (added[0]) revealPoolCard(added[0]);
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

  // While a view loads: its bar, and a placeholder that says what is coming.
  function loadingHtml(exam, view, text) {
    return `<div class="section-topbar" data-no-dirty>
        <div class="add-bar bar-nav"><button type="button" class="btn-sm btn-secondary" data-exam-action="back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All exams</button></div>
        ${exam ? examViewsHtml(exam, view) : ''}
      </div>
      <div class="exam-loading" role="status" aria-live="polite">
        <p class="exam-loading-text"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>${x(text)}</p>
        ${'<div class="skeleton exam-loading-row"></div>'.repeat(6)}
      </div>`;
  }

  async function showSubmissions(examId, body = document.getElementById('section-body')) {
    const exam = examById(examId);
    if (!exam) return;
    const again = EX.examId === examId && EX.view === 'submissions' && !!body.querySelector('#roster-rows');
    if (!again) {
      Object.assign(EX, { subFilter: 'all', subQuery: '', subSort: null });
      _rosterSel.clear();
      body.innerHTML = loadingHtml(exam, 'grades', 'Loading the submissions…');
    } else {
      body.setAttribute('aria-busy', 'true');
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
    body.removeAttribute('aria-busy');
    if (S.section !== 'exams' || EX.examId !== examId || EX.view !== 'submissions') return;
    renderSubmissions(body, exam);
    watchRoster(exam);
  }

  // While the exam is open (and for 15 minutes after), the list refreshes itself every 30
  // seconds, as students start and submit. Not while a menu or dialog is open, a grade is typed,
  // or the page is hidden.
  let _rosterWatch = null;
  function watchRoster(exam) {
    clearInterval(_rosterWatch);
    const live = () => {
      const start = Date.parse(exam.starts_at), end = Date.parse(exam.ends_at), now = Date.now();
      return !paperExam(exam) && start <= now && now < end + 15 * 60000;
    };
    if (!live()) return;
    _rosterWatch = setInterval(async () => {
      if (S.section !== 'exams' || EX.view !== 'submissions' || EX.examId !== exam.id || !live()) { clearInterval(_rosterWatch); return; }
      if (document.hidden || document.querySelector('.row-menu-list:not([hidden]), .modal-overlay.open') || document.activeElement?.matches('#roster-rows input')) return;
      try {
        const [subs, attempts] = await Promise.all([rpc('exam_submissions', { p_exam_id: exam.id }), rpc('exam_attempts', { p_exam_id: exam.id }).catch(() => EX.attempts)]);
        if (EX.view !== 'submissions' || EX.examId !== exam.id) return;
        EX.submissions = subs;
        EX.attempts = attempts || [];
        renderRosterRows(exam);
        updateRosterCounts(exam);
      } catch { /* the next time */ }
    }, 30000);
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
    // Grades go out as they are: partly graded submissions count the points given so far.
    const withGrade = rows.filter(r => Number.isFinite(parseFloat(r.sub?.grades?.totalScore))).length;
    const exports = [
      { label: 'Grades (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-sub-action="pdf-grades"', disabled: !withGrade,
        title: 'The grade report to sign, everyone on the list' },
      { label: 'Graded exams (PDF)', icon: 'fa-regular fa-file-lines', attrs: 'data-sub-action="pdf-reports"', disabled: !online.length || paper,
        title: 'Each student\'s answers, with the points and comments so far' },
      { label: `Submissions${exam.file_count ? ' and files' : ''} (ZIP)`, icon: 'fa-regular fa-file-zipper', attrs: 'data-sub-action="zip"', disabled: !online.length },
      { separator: true },
      { label: 'Exam paper (PDF)', icon: 'fa-regular fa-file-pdf', attrs: 'data-sub-action="paper"', disabled: paper,
        title: 'The questions to print, with or without the answers' },
    ];
    const more = [
      { label: 'Refresh', icon: 'fa-solid fa-rotate', attrs: 'data-sub-action="refresh"', title: 'While the exam is open, the list refreshes by itself' },
      ...(exam.file_count && canManage() ? [{ separator: true }, { label: 'Delete uploaded files', icon: 'fa-solid fa-trash', danger: true, attrs: 'data-sub-action="delete-files"',
        title: `${exam.file_count} file${exam.file_count === 1 ? '' : 's'}, ${formatBytes(exam.file_bytes)}: download the ZIP first` }] : []),
    ];
    const facts = [counts.join(', '), exam.results_published ? 'Grades released' : 'Grades not released',
      exam.file_count && `${exam.file_count} uploaded file${exam.file_count === 1 ? '' : 's'}, ${formatBytes(exam.file_bytes)}`].filter(Boolean);
    body.innerHTML = `
      <div class="section-topbar" data-no-dirty>
        <div class="add-bar bar-nav">
          <button type="button" class="btn-sm btn-secondary" data-exam-action="back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All exams</button>
        </div>
        ${examViewsHtml(exam, 'grades')}
        <div class="add-bar">
          <button type="button" class="btn-sm" data-sub-action="eis" ${withGrade ? '' : 'disabled'} title="${withGrade ? 'Names and grades in the class list\'s order, to copy into EIS' : 'No grades yet'}"><i class="fa-solid fa-table-list" style="margin-right:6px"></i>Grades for EIS</button>
        </div>
        ${rowMenuHtml(exports, { text: 'Export', icon: 'fa-solid fa-download', label: 'Export' })}
        ${rowMenuHtml(more, { label: 'More actions' })}
      </div>
      <div class="exam-sub-head">
        <h3 class="qe-title">${x(examTitle(exam))}</h3>
        <div class="exam-sub-facts">${facts.map(f => `<span>${x(f)}</span>`).join('')}</div>
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
    return `<span class="sub-who-line" title="${x([s.full_name, no, s.email].filter(Boolean).join(', '))}"><span class="sub-name">${x(s.full_name || s.email)}</span>${no ? `<span class="sub-id">${x(no)}</span>` : ''}${off}</span>`;
  }

  // The pills beside the time. Auto: the exam page submitted by itself when time ran out (the
  // student had not pressed Submit), with the answers they had given. Late: it reached
  // the server more than a minute after the end, kept on the device while it was offline. Each
  // can come without the other; both together, time ran out while the device was offline.
  const AUTO_TITLE = 'Submitted by the exam page when time ran out, with the answers given by then';
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
        { label: 'Recorded answers', icon: 'fa-regular fa-rectangle-list', attrs: 'data-sub-action="answers"', title: 'Exactly as they were received' },
        ...(canManage() ? [{ label: 'Hand back to the student', icon: 'fa-solid fa-rotate-left', attrs: 'data-sub-action="return"',
          title: 'With their answers: they can continue while the exam is open' },
        { label: 'Hand back a new paper', icon: 'fa-solid fa-file-circle-plus', attrs: 'data-sub-action="new-paper"',
          title: 'Deletes this submission: they start again with new questions in a new order' }] : []),
      ] : []),
      ...(canManage() ? [{ label: s.source === 'manual' ? 'Remove the grade' : 'Delete submission', icon: 'fa-solid fa-trash', danger: true, attrs: 'data-sub-action="delete"' }] : []),
    ] : (canManage() && !paper ? [{ label: 'Add from a backup file', icon: 'fa-solid fa-file-import', attrs: 'data-sub-action="import"',
      title: 'The JSON file the exam page saved to their downloads' }] : []);
    // One action a row, the same size in every row: Grade (work to do, filled), Review (graded),
    // Enter grade (no submission), Feedback (an exam on paper).
    const act = (kind, action, icon, label, attrs = '') => `<button type="button" class="row-act is-${kind}" data-sub-action="${action}" ${attrs}><i class="${icon}" aria-hidden="true"></i><span>${label}</span></button>`;
    const actions = paper
      ? act('done', 'grade', 'fa-regular fa-comment', 'Feedback', s ? '' : 'disabled title="Type a grade first"')
      : s ? (s.status === 'graded' ? act('done', 'grade', 'fa-solid fa-check', 'Review', 'title="Graded: see or change the grading"')
        : act('todo', 'grade', 'fa-solid fa-pen', 'Grade'))
      : act('add', 'enter-grade', 'fa-solid fa-plus', 'Enter grade', ended ? 'title="A grade without a submission"' : 'disabled title="Once the exam has closed"');
    const grade = parseFloat(s?.grades?.totalScore);
    const name = r.code || r.student?.full_name || r.student?.email || '';
    return `<tr data-row-key="${x(r.key)}"${s ? ` data-sub-id="${x(s.id)}"` : ''} class="roster-row is-${r.state}">
      <td class="select-cell"><input type="checkbox" class="row-check" aria-label="Select ${x(name)}"></td>
      <td class="roster-n">${r.n}</td>
      <td class="sub-who">${rosterWhoHtml(exam, r)}</td>
      ${paper ? `<td class="roster-grade"><label class="inline-grade"><span class="sr-only">Grade</span><input type="number" min="0" max="${x(String(parseFloat(exam.base) || 100))}" step="any"
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
    if (d?.by === 'server') return screen + subFlagHtml('Not on the page', 'plain', 'delivery', 'Submitted at the end from the answers last saved: the exam page was not open then');
    if (!d?.last_online) return screen;
    const changed = d.changed?.length || 0;
    return screen + subFlagHtml(changed ? `${changed} changed offline` : 'Kept offline', changed ? 'warn' : 'plain', 'delivery',
      'Kept on the device while it was offline: when it went offline, and which answers changed');
  }

  function deliveryHtml(exam, s) {
    const d = s.delivery || {};
    if (d.by === 'server') {
      return `<p>The student started this exam but did not submit it, and the exam page was not open when it ended (closed, the computer off, or left). It was submitted for them, dated at the end, with the answers last saved: the page saves them as the student answers, and every 30 seconds.</p>
        <dl>
          <dt>Last saved</dt><dd>${d.draft_at ? x(formatWhen(d.draft_at)) : 'Never: no answers were saved'}</dd>
          <dt>Last on the page</dt><dd>${d.last_online ? x(formatWhen(d.last_online)) : 'Not known'}</dd>
        </dl>
        <p class="form-hint">If the device kept newer answers while offline, it sends them when it is back (until a day after the end), and they take this one's place unless it is graded.</p>`;
    }
    const numbers = new Map();
    let n = 0;
    subQuestions(exam, s).forEach((q, i) => { if (q.type !== 'text_only') numbers.set(i + 1, ++n); });
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
    set('autograde', auto, examCanAutograde(exam) ? 'Nobody selected has answers' : 'No question has an answer key');
    set('download', download, 'Nobody selected has answers');
    set('return', back, 'Nobody selected has answers to hand back');
    set('clear-grades', clear, 'Nobody selected is graded');
    set('delete', remove, 'Nobody selected has a submission or a grade');
  }

  // While the exam takes answers (until 10 minutes after its end), nobody gets a grade without a submission.
  const examTakingAnswers = exam => !!(exam.questions?.length && exam.starts_at && Date.now() >= Date.parse(exam.starts_at)
    && (!exam.ends_at || Date.now() <= Date.parse(exam.ends_at) + 10 * 60000));

  // Whether any question of the exam (or that its students drew from the pool) has an answer key.
  const examCanAutograde = exam => (exam.questions || []).some(canAutograde)
    || (hasPool(exam.questions) && EX.submissions.some(s => subQuestions(exam, s).some(canAutograde)));

  // Who each action applies to, of the chosen rows. A grade given here goes to those without
  // answers (absent, or a grade entered by hand before); answers are graded on their own page.
  function bulkTargets(exam, chosen) {
    const paper = paperExam(exam);
    const answered = chosen.filter(r => r.sub && r.sub.source !== 'manual');
    return {
      grade: paper ? chosen : examTakingAnswers(exam) ? [] : chosen.filter(r => (!r.sub || r.sub.source === 'manual') && r.state !== 'taking'),
      auto: examCanAutograde(exam) ? answered.filter(r => subQuestions(exam, r.sub).some(canAutograde)) : [],
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
      + (open ? '' : '\n\nThe exam has ended: extend its duration in Settings so they can continue. Students who never started it can then take it too.')
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
      case 'new-paper': return returnNewPaper(exam, sub);
      case 'delete': return deleteSubmission(exam, sub);
      case 'delete-files': return deleteFiles(exam);
      case 'pdf-questions':
      case 'paper': return openPaperDialog(exam);
      case 'zip': return exportSubmissionsZip(exam);
      case 'pdf-grades': return exportGradesPdf(exam);
      case 'pdf-reports': return exportReportsPdf(exam, sortedSubmissions(exam, true).filter(s => s.source !== 'manual' || s.grades));
      case 'eis': return showEisGrades(exam);
    }
  }

  // A grade for someone without a submission (absent, or answered on paper): an entry with no
  // answers, graded question by question like the others.
  async function enterGrade(exam, row) {
    if (!row) return;
    const button = document.querySelector(`tr[data-row-key="${CSS.escape(row.key)}"] [data-sub-action="enter-grade"]`);
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>Opening</span>'; }
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
      + (open ? '' : '\n\nThe exam has ended: extend its duration in Settings so they can continue. Students who never started it can then take it too.');
    if (!(await confirmDialog(message, { title: 'Hand Back', okLabel: 'Hand back', okIcon: 'fa-rotate-left' }))) return;
    try {
      await rpc('exam_return_submission', { p_id: sub.id });
      toast(`Handed back to ${who}`, 'ok');
      await refreshAfterChange(exam.id);
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  // A new paper: the submission, its answers and grade are deleted (kept in the attempt's
  // record), and the student starts again with new questions and a new order.
  async function returnNewPaper(exam, sub) {
    if (!sub || !requirePermission(canManage())) return;
    const who = sub.student_name || `exam ID ${sub.exam_code}`;
    const open = examStatus(exam).key === 'open';
    const message = `Give ${who} a new paper? Their submission is deleted: their answers${sub.grades ? ', points and grade' : ''} are gone, and they start the exam again with new questions${hasPool(exam.questions) ? ' drawn from the pool' : ''} in a new order.`
      + (open ? '' : '\n\nThe exam has ended: extend its duration in Settings so they can take it.')
      + '\n\nThis cannot be undone.';
    if (!(await confirmDialog(message, { title: 'New Paper', okLabel: 'Delete and give a new paper', danger: true, okIcon: 'fa-file-circle-plus' }))) return;
    try {
      await rpc('exam_return_new_paper', { p_id: sub.id });
      toast(`New paper for ${who}`, 'ok');
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
      cell.textContent = d ? [d.connection?.org || d.connection?.isp, [d.city, d.country].filter(Boolean).join(', ')].filter(Boolean).join(', ') : 'Could not look up';
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


  // ── Statistics: how the exam went ──
  // From the submissions, for the lecturer: the grades' spread on the exam's base (from the
  // graded ones), then each question in the exam's order with its average points, how many got
  // full points and how many left it without an answer, and what they answered: how many chose
  // each option (the correct ones in green), or the commonest short and numeric answers (marked
  // when the key accepts them). A wrong option chosen more than the right one, a common answer
  // the key does not accept, or a question nearly everyone lost points on is pointed out: often
  // a slip in the key or in the question. Answers count before grading; nothing here is saved.
  async function showStats(examId, body = document.getElementById('section-body')) {
    const exam = examById(examId);
    if (!exam || !canManage()) return;
    // Coming from its grades (or back to this view), the submissions in hand show at once, and
    // fresh ones replace them as they arrive.
    const held = EX.examId === examId && (EX.view === 'submissions' || EX.view === 'stats') && Array.isArray(EX.submissions);
    EX.view = 'stats';
    EX.examId = examId;
    body.onclick = onExamsClick;
    body.onchange = body.oninput = body.onkeydown = body.onpaste = body.ondragover = body.ondragleave = body.ondrop = null;
    if (held) renderStats(body, exam);
    else body.innerHTML = loadingHtml(exam, 'stats', 'Working out the statistics…');
    let subs = null;
    try {
      subs = await rpc('exam_submissions', { p_exam_id: examId });
    } catch (error) {
      if (!held) toast(error.message, 'err');
    }
    if (S.section !== 'exams' || EX.examId !== examId || EX.view !== 'stats') return;
    if (subs) EX.submissions = subs;
    else if (!held) EX.submissions = [];
    if (subs || !held) renderStats(body, exam);
  }

  // One question across submissions: a pool question by its pool id, else by its id (else its
  // place), so each student's own draw and order still meet in one row.
  const sameQuestionKey = (q, i) => (q?.pool ? `pool:${q.pool.id}` : q?.id ? `id:${q.id}` : `n:${i}`);
  const gradeNumber = (g, base) => {
    const total = parseFloat(g?.totalScore), max = parseFloat(g?.maxScore);
    if (!Number.isFinite(total)) return null;
    return Number.isFinite(max) && max > 0 ? total / max * base : total;
  };
  const meanOf = list => list.reduce((sum, v) => sum + v, 0) / list.length;
  function medianOf(list) {
    const sorted = [...list].sort((a, b) => a - b), mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  const letterOf = i => String.fromCharCode(97 + i);
  const isEmptyAnswer = given => given == null || given === '' || given === UNCONFIRMED;

  // Each question's numbers, in the exam's order (a pool question where it was first drawn).
  function questionStats(exam) {
    const rows = new Map();
    for (const sub of (EX.submissions || []).filter(s => s.source !== 'manual')) {
      const answers = sub.answers || {}, marks = sub.grades?.questionGrades || {};
      subQuestions(exam, sub).forEach((q, i) => {
        if (!q || q.type === 'text_only') return;
        const n = i + 1, key = sameQuestionKey(q, i);
        let st = rows.get(key);
        if (!st) {
          st = { key, q, first: i, order: rows.size, seen: 0, graded: 0, points: 0, full: 0, empty: 0, max: questionMaxPoints(q),
            options: q.type === 'multiple_select' ? (q.options || []).map(() => 0) : null, other: 0, tf: { True: 0, False: 0 }, answers: new Map() };
          rows.set(key, st);
        }
        st.first = Math.min(st.first, i);
        st.seen++;
        const given = answers[`ans-${n}`];
        if (isEmptyAnswer(given)) st.empty++;
        else if (q.type === 'multiple_select') {
          if (otherAnswer(answers, n)) st.other++;
          else {
            const index = answers[`ans-${n}_metadata`]?.originalIndex;
            const at = index != null && q.options?.[index] != null ? index : (q.options || []).indexOf(String(given));
            if (at >= 0) st.options[at]++;
          }
        } else if (q.type === 'true_false') {
          const value = /^true$/i.test(given) ? 'True' : /^false$/i.test(given) ? 'False' : '';
          if (value) st.tf[value]++;
        } else if (q.type === 'short_answer' || q.type === 'numeric') {
          const text = String(given).trim().replace(/\s+/g, ' ');
          const same = q.type === 'numeric' ? String(num(text.replace(/[^\d.,eE+-]/g, '')) ?? text.toLowerCase()) : plainWords(text);
          const seen = st.answers.get(same) || { text, count: 0, right: autoCheck(q, answers, n) };
          seen.count++;
          st.answers.set(same, seen);
        }
        const mark = marks[`q-${n}`];
        const points = parseFloat(mark?.points);
        if (mark && mark.points !== '' && mark.points != null && Number.isFinite(points)) {
          st.graded++;
          st.points += points;
          if (st.max > 0 && points >= st.max) st.full++;
        }
      });
    }
    return [...rows.values()].sort((a, b) => a.first - b.first || a.order - b.order);
  }

  // What is worth a second look, if anything.
  function statsFlag(st) {
    const { q } = st;
    if (st.options && q.correct_answers?.length) {
      const correct = new Set(q.correct_answers.map(String));
      const right = st.options.reduce((sum, count, i) => sum + (correct.has(String(q.options[i])) ? count : 0), 0);
      let worst = -1;
      st.options.forEach((count, i) => { if (!correct.has(String(q.options[i])) && (worst < 0 || count > st.options[worst])) worst = i; });
      if (worst >= 0 && st.options[worst] >= 3 && st.options[worst] > right) return `More chose ${letterOf(worst)}) than the correct answer: check the key.`;
    }
    if (q.type === 'true_false' && typeof q.answer === 'boolean') {
      const right = st.tf[q.answer ? 'True' : 'False'], wrong = st.tf[q.answer ? 'False' : 'True'];
      if (wrong >= 3 && wrong > right) return `More chose ${q.answer ? 'False' : 'True'} than the correct answer: check the key.`;
    }
    if (canAutograde(q) && st.answers.size) {
      const top = [...st.answers.values()].sort((a, b) => b.count - a.count)[0];
      if (top.count >= 3 && top.right === false && top.count >= (st.seen - st.empty) * 0.3) return `“${top.text}” is the commonest answer, and the key does not accept it.`;
    }
    if (st.graded >= 5 && st.max > 0 && st.points / (st.graded * st.max) < 0.25) return 'Most lost the points here: check the question and its key.';
    return '';
  }

  const STATS_SORTS = {
    average: st => (st.graded && st.max > 0 ? st.points / (st.graded * st.max) : null),
    empty: st => st.empty,
  };
  function sortStats(key) {
    const first = { average: 1, empty: -1 }[key];
    EX.statsSort = !first ? null : EX.statsSort?.key === key ? { key, dir: -EX.statsSort.dir } : { key, dir: first };
    const exam = examById(EX.examId);
    if (exam && EX.view === 'stats') renderStats(document.getElementById('section-body'), exam);
  }

  function renderStats(body, exam) {
    const base = parseFloat(exam.base) || 100;
    const anonymous = signInOf(exam) === 'anonymous';
    const expected = anonymous ? EX.data.codes.length : EX.data.students.length;
    const subs = EX.submissions || [];
    const paper = paperExam(exam);
    const online = subs.filter(s => s.source !== 'manual');
    const grades = subs.filter(s => s.status === 'graded').map(s => gradeNumber(s.grades, base)).filter(g => g != null);
    const left = online.filter(s => s.status !== 'graded').length;
    const count = n => NUMBER.format(n);
    const figures = [
      !paper && ['Submitted', count(online.length), expected ? `of ${count(expected)}` : ''],
      ['Graded', count(grades.length), left ? `${count(left)} to grade` : paper && expected ? `of ${count(expected)}` : ''],
      ...(grades.length ? [
        ['Average', fmt(meanOf(grades)), `of ${fmt(base)}`],
        ['Median', fmt(medianOf(grades)), `of ${fmt(base)}`],
        ['Highest', fmt(Math.max(...grades)), ''],
        ['Lowest', fmt(Math.min(...grades)), ''],
      ] : []),
    ].filter(Boolean);
    const stats = paper ? [] : sortRows(questionStats(exam), EX.statsSort, STATS_SORTS);
    const facts = [grades.length ? `Grades out of ${fmt(base)}, from the ${count(grades.length)} graded` : 'No grades yet',
      !paper && online.length && `answers from all ${count(online.length)} submission${online.length === 1 ? '' : 's'}`].filter(Boolean);
    body.innerHTML = `
      <div class="section-topbar" data-no-dirty>
        <div class="add-bar bar-nav"><button type="button" class="btn-sm btn-secondary" data-exam-action="back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All exams</button></div>
        ${examViewsHtml(exam, 'stats')}
      </div>
      <div class="exam-sub-head">
        <h3 class="qe-title">${x(examTitle(exam))}</h3>
        ${subs.length ? `<div class="exam-sub-facts"><span>${x(facts.join(', '))}</span></div>` : ''}
      </div>
      ${!subs.length ? `<div class="empty-content" data-no-dirty>${paper ? 'No grades yet: the statistics fill in as you grade.' : 'No submissions yet: the statistics fill in as students submit.'}</div>` : `
      <div class="stats-page" data-no-dirty>
        <dl class="stats-figures">${figures.map(([label, value, sub]) => `<div class="stats-figure"><dt>${label}</dt><dd><strong>${value}</strong>${sub ? `<span>${x(sub)}</span>` : ''}</dd></div>`).join('')}</dl>
        ${grades.length ? histogramHtml(grades, base) : '<p class="form-hint stats-none">Nothing is graded yet: the grades\' spread shows once you grade. What students answered is below.</p>'}
        ${stats.length ? questionStatsHtml(stats) : ''}
      </div>`}`;
  }

  // The grades in ten bands of the base (0–10, 10–20… out of 100): a column each, with how many
  // above it.
  function histogramHtml(grades, base) {
    const bands = Array(10).fill(0);
    grades.forEach(g => { bands[Math.min(9, Math.max(0, Math.floor(g / base * 10 + 1e-9)))]++; });
    const top = Math.max(...bands);
    const edge = i => fmt(i * base / 10);
    return `<section class="stats-block">
      <h4 class="stats-title">Grades</h4>
      <div class="stats-hist" role="list" aria-label="How many grades in each band, out of ${x(fmt(base))}">
        ${bands.map((n, i) => {
          const label = `${edge(i)} to ${edge(i + 1)}: ${count(n)} grade${n === 1 ? '' : 's'}`;
          return `<div class="stats-hist-col" role="listitem" style="--h:${top ? (n / top).toFixed(3) : 0}" title="${x(label)}" aria-label="${x(label)}">
            ${n ? `<span class="stats-hist-n">${count(n)}</span><span class="stats-hist-bar"></span>` : ''}</div>`;
        }).join('')}
      </div>
      <div class="stats-hist-axis" aria-hidden="true">${bands.map((n, i) => `<span>${edge(i)}</span>`).join('')}<span>${edge(10)}</span></div>
    </section>`;
    function count(n) { return NUMBER.format(n); }
  }

  function questionStatsHtml(stats) {
    const sort = EX.statsSort;
    const pooled = stats.some(st => st.q.pool);
    let number = 0;
    const rows = stats.map(st => {
      const { q } = st;
      const type = QUESTION_TYPES[q.type]?.label || 'Question';
      const text = paperText(q.prompt || '').replace(/\s+/g, ' ').trim() || (q.images?.length ? 'A figure' : '');
      const flag = statsFlag(st);
      const share = STATS_SORTS.average(st);
      const bar = (n, of, kind = '') => `<span class="stats-bar${kind}" aria-hidden="true"><span style="width:${of ? (n / of * 100).toFixed(1) : 0}%"></span></span>`;
      const line = (label, text, n, right, key = 'Correct', of = st.seen) => `<li class="${right ? 'is-right' : ''}">
          <span class="stats-opt-label">${label}</span><span class="stats-opt-text" title="${x(text)}">${x(text)}</span>
          ${bar(n, of)}<span class="stats-opt-n">${NUMBER.format(n)}</span>
          <span class="stats-opt-key">${right ? `<i class="fa-solid fa-check" aria-hidden="true"></i><span class="stats-opt-key-text">${key}</span>` : ''}</span></li>`;
      let detail = '';
      if (st.options) {
        const correct = new Set((q.correct_answers || []).map(String));
        detail = `<ol class="stats-options">${(q.options || []).map((o, i) => line(`${letterOf(i)})`, paperText(o).trim() || `Option ${letterOf(i)}`, st.options[i], correct.has(String(o)))).join('')}
          ${q.allow_other || st.other ? line(`${letterOf((q.options || []).length)})`, 'Other, written in', st.other, false) : ''}</ol>`;
      } else if (q.type === 'true_false') {
        detail = `<ol class="stats-options">${['True', 'False'].map(v => line('', v, st.tf[v], typeof q.answer === 'boolean' && String(q.answer) === v.toLowerCase())).join('')}</ol>`;
      } else if (st.answers.size) {
        const common = [...st.answers.values()].sort((a, b) => b.count - a.count).slice(0, 5);
        detail = `<p class="stats-common">Commonest answers${st.answers.size > 5 ? ` (of ${NUMBER.format(st.answers.size)} different)` : ''}</p>
          <ol class="stats-options is-answers">${common.map(a => line('', a.text, a.count, a.right === true, 'Accepted')).join('')}</ol>`;
      }
      const label = q.pool ? `<span class="stats-q-n">From the pool</span><span class="exam-chip"><i class="${POOL_ICON}" aria-hidden="true"></i>${x(moduleLabel(q.pool.module))}</span>`
        : `<span class="stats-q-n">${pooled ? 'Question' : `Question ${++number}`}</span>`;
      return `<tr>
        <td class="stats-q">
          <div class="stats-q-head">${label}<span class="stats-q-type">${x(type)}</span>${q.pool ? `<span class="stats-q-type">drawn by ${NUMBER.format(st.seen)}</span>` : ''}</div>
          ${text ? `<div class="stats-q-text">${x(text)}</div>` : ''}
          ${flag ? `<p class="stats-flag"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${x(flag)}</span></p>` : ''}
          ${detail}
        </td>
        <td class="stats-avg" data-label="Average">${share == null ? '<span class="exam-muted">Not graded</span>'
          : `${bar(share, 1, ` is-${share >= 0.7 ? 'high' : share >= 0.4 ? 'mid' : 'low'}`)}<span class="stats-avg-n"><strong>${Math.round(share * 100)}%</strong><span class="exam-muted">${fmt(st.points / st.graded)} of ${fmt(st.max)}</span></span>`}</td>
        <td class="stats-num" data-label="Full points">${st.graded ? `${NUMBER.format(st.full)}<span class="exam-muted"> of ${NUMBER.format(st.graded)}</span>` : '<span class="exam-muted">–</span>'}</td>
        <td class="stats-num" data-label="No answer">${st.empty ? `${NUMBER.format(st.empty)}<span class="exam-muted"> of ${NUMBER.format(st.seen)}</span>` : '<span class="exam-muted">None</span>'}</td>
      </tr>`;
    }).join('');
    return `<section class="stats-block">
      <h4 class="stats-title">Questions</h4>
      <div class="data-table-container">
        <table class="data-table stats-table">
          <thead><tr>
            <th>${sortHeadHtml('data-stats-sort', '', 'Question', null)}</th>
            <th${ariaSort(sort, 'average')}>${sortHeadHtml('data-stats-sort', 'average', 'Average', sort)}</th>
            <th>Full points</th>
            <th${ariaSort(sort, 'empty')}>${sortHeadHtml('data-stats-sort', 'empty', 'No answer', sort)}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
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
    const questions = subQuestions(exam, sub);
    _grading = { exam, sub, questions };
    EX.view = 'grading';
    S.section = 'exams'; // Ctrl+S saves the grades
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
          ${q.pool ? `<span class="gq-from" title="Drawn from the course's question pool"><i class="${POOL_ICON}" aria-hidden="true"></i>${x(moduleLabel(q.pool.module))}</span>` : ''}
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
            ${match == null ? (q.type === 'multiple_select' && otherAnswer(answers, n) ? '<span class="gq-match">Written in under Other: grade it by hand</span>' : '')
              : `<span class="gq-match is-${match ? 'yes' : 'no'}">${match ? 'Matches the correct answer' : 'Does not match the correct answer'}</span>`}</dd>
          ${key ? `<dt>${key.label}</dt><dd class="correct-answer">${key.html}</dd>` : ''}
          ${q.explanation ? `<dt>Notes</dt><dd class="exam-muted">${xh(q.explanation)}</dd>` : ''}
          <dt><label for="comment-q-${n}">Comment</label></dt>
          <dd><textarea id="comment-q-${n}" rows="1"></textarea>${earlierCommentsHtml(earlierComments(exam, sub, q, i), max)}</dd>
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
    const step = (s, icon, label, keys) => `<button type="button" class="btn-sm btn-secondary grading-step" ${s ? `data-nav="${x(s.id)}" title="${x(`${subName(s)} (${keys})`)}"` : 'disabled'} aria-label="${label}">${icon}</button>`;
    const header = COURSE_HEADERS.get(JSON.stringify([EX.course, EX.isArchive])) || {};
    const main = document.getElementById('main-area');
    lockHeight(main);
    // The page's head: back to the list, who is graded (with the exam and course under the name),
    // and the others one by one.
    main.innerHTML = `
      <section id="grading-page" class="grading-page" aria-labelledby="grading-title">
        <header class="grading-head">
          <button type="button" class="btn-sm btn-secondary grading-back" id="grading-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>${_gradingFrom === 'students' ? 'Students' : 'Grades'}</button>
          <div class="grading-who"><h2 id="grading-title">${x(subName(sub))}</h2>
            <div class="grading-of">${[examTitle(exam), header.code || EX.course].filter(Boolean).map(t => `<span>${x(t)}</span>`).join('')}</div></div>
          ${list.length > 1 ? `<div class="grading-steps">${step(prev, '<i class="fa-solid fa-chevron-left"></i>', 'Previous', 'Alt+←')}
            ${at >= 0 ? `<span class="grading-place">${at + 1} of ${list.length}</span>` : ''}
            ${step(next, '<i class="fa-solid fa-chevron-right"></i>', 'Next', 'Alt+→')}</div>` : ''}
        </header>
        <div class="section-topbar grading-topbar" data-no-dirty>
          ${paper ? `<span class="exam-topbar-note grading-total" aria-live="polite"><span id="grading-total" hidden></span>Grade <strong id="grading-base">0</strong> / ${fmt(exam.base)}</span>`
            : `<span class="exam-topbar-note grading-total" aria-live="polite"><span><strong id="grading-total">0</strong> of ${fmt(totalPoints(questions))} points</span>
              <span class="grading-grade">Grade <strong id="grading-base">0</strong> / ${fmt(exam.base)}</span></span>`}
          <span class="grading-actions">
          <button class="btn-sm btn-secondary" type="button" id="grading-auto" ${questions.some(canAutograde) ? '' : 'hidden'}
            title="Marks every question with a correct answer to compare with, Right or Wrong"><i class="fa-solid fa-wand-magic-sparkles"></i> Autograde</button>
          ${rowMenuHtml([
            { label: 'Download (PDF)', icon: 'fa-solid fa-file-arrow-down', attrs: 'id="grading-download"', title: 'This graded exam, for your records' },
            { separator: true },
            { label: 'Clear grading', icon: 'fa-solid fa-eraser', attrs: 'id="grading-clear"', danger: true, disabled: !sub.grades, title: 'Every point, comment and the feedback' },
          ], { label: 'More actions' })}
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
    page.onmousedown = e => { if (e.target.closest('[data-reuse]')) e.preventDefault(); };
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

  // Comments given to the same question in the other submissions, the commonest first, each with
  // the points it came with. They show under the comment while you write it; a press adds one
  // (and its points, when this question has none yet).
  function earlierComments(exam, sub, q, i) {
    const key = sameQuestionKey(q, i), pooled = hasPool(exam.questions);
    const found = new Map();
    for (const other of EX.submissions || []) {
      if (other.id === sub.id || other.source === 'manual' || !other.grades?.questionGrades) continue;
      const at = pooled ? subQuestions(exam, other).findIndex((oq, j) => sameQuestionKey(oq, j) === key) : i;
      const mark = at >= 0 ? other.grades.questionGrades[`q-${at + 1}`] : null;
      const text = String(mark?.comment || '').trim();
      if (!text || text.startsWith('Model answer:')) continue;
      const seen = found.get(text) || { text, count: 0, points: mark.points };
      seen.count++;
      found.set(text, seen);
    }
    return [...found.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  }

  function earlierCommentsHtml(list, max) {
    if (!list.length) return '';
    return `<div class="gq-reuse" role="group" aria-label="Earlier comments on this question"><span class="gq-reuse-label">Earlier comments</span>${list.map(c => {
      const points = c.points === '' || c.points == null || !Number.isFinite(parseFloat(c.points)) ? '' : String(parseFloat(c.points));
      const title = `${c.text}${points ? ` (${fmt(points)} of ${fmt(max)} points)` : ''}${c.count > 1 ? `, given ${c.count} times` : ''}`;
      return `<button type="button" class="gq-reuse-btn" data-reuse="${x(c.text)}" data-reuse-points="${points}" title="${x(title)}">
        <span class="gq-reuse-text">${x(c.text)}</span>${points ? `<span class="gq-reuse-points">${fmt(points)}/${fmt(max)}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }

  // An earlier comment: added to this one (unless it is there already), its points given when
  // none are yet.
  function useEarlierComment(btn) {
    const n = btn.closest('[data-q]')?.dataset.q;
    const box = document.getElementById(`comment-q-${n}`), points = document.getElementById(`points-q-${n}`);
    if (!box) return;
    const text = btn.dataset.reuse, now = box.value.trim();
    if (!now.includes(text)) box.value = now ? `${now}\n${text}` : text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    if (points && points.value.trim() === '' && btn.dataset.reusePoints !== '') {
      points.value = btn.dataset.reusePoints;
      points.dispatchEvent(new Event('input', { bubbles: true }));
    }
    box.focus();
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
      (await gradedPaperPdf(examById(exam.id) || exam, [sub]))
        .save(`${slug(examTitle(exam))}_${slug(sub.exam_code || `${shownNo(sub.student_no)}_${sub.student_name}`, true)}.pdf`);
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

  // Until Nov 2026 students confirmed each answer, and the exam page sent this instead of one
  // not confirmed (submissions from then still have it). A file is uploaded as soon as it is
  // chosen, though, so such a file is still there to see. Now every answer given is sent.
  const UNCONFIRMED = '[NOT CONFIRMED]';
  const UNCONFIRMED_TEXT = 'Not sent: not confirmed';

  function studentAnswerHtml(answer, type, sub, n) {
    if (type === 'attachment') return fileAnswerHtml(answer, sub, n);
    if (answer === UNCONFIRMED) return `<em>${UNCONFIRMED_TEXT}</em>`;
    if (answer == null || answer === '') return '<em>No answer</em>';
    const text = String(answer);
    if (type === 'multiple_select' && sub && otherAnswer(sub.answers, n)) return `<span class="answer-other">Other</span>${xh(text)}`;
    if (type === 'true_false' && /^(true|false)$/i.test(text)) return `<span class="answer-tf is-${text.toLowerCase()}">${x(text)}</span>`;
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
        ${answer === UNCONFIRMED ? '<p class="answer-file-note">Uploaded, but not confirmed.</p>'
          : answer == null || answer === '' ? '<p class="answer-file-note">Uploaded, then removed by the student: not given as the answer.</p>' : ''}`;
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
    const reuse = e.target.closest('[data-reuse]');
    if (reuse) return useEarlierComment(reuse);
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

  // A multiple-choice answer the student wrote themselves, under Other.
  const otherAnswer = (answers, n) => !!answers?.[`ans-${n}_metadata`]?.other;

  // Multiple choice: right when the chosen option is a correct one (its original position, when
  // recorded, survives the per-student shuffle). Short answer: one of the accepted answers,
  // ignoring capitals and spaces. Numeric: within the tolerance (a unit or comma is fine).
  // Whether question n's answer is right, or null when there is nothing to compare with. An
  // answer not confirmed in time is left for the grader: it was never sent.
  function autoCheck(q, answers, n) {
    const given = answers[`ans-${n}`];
    if (!canAutograde(q) || given === UNCONFIRMED) return null;
    if (q.type === 'multiple_select') {
      if (otherAnswer(answers, n)) return null; // their own answer: graded by hand
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
    if (q.type === 'multiple_select' && otherAnswer(answers, n)) return null; // written in under Other
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
    _grading.questions.forEach((q, i) => {
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
    const questions = subQuestions(exam, sub);
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
    const questions = _grading.questions;
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
    const { exam, sub, questions } = _grading;
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
      const status = allFilled ? 'graded' : 'submitted';
      await rpc('exam_save_grades', { p_submission_id: sub.id, p_grades: grades, p_status: status });
      toast(allFilled ? 'Graded' : 'Saved; some questions still have no points', 'ok');
      _grading.snapshot = gradingSnapshot();
      // Saved as sent: the list here changes at once, and the rest (other graders' work) catches
      // up behind, so the next student opens without waiting.
      for (const held of [sub, EX.submissions.find(s => s.id === sub.id)]) if (held) Object.assign(held, { grades, status });
      const held = examById(exam.id);
      if (held) held.graded_count = EX.submissions.filter(s => s.status === 'graded' && s.source !== 'manual').length;
      if (!leave || !onGradingPage()) return true;
      // On to the next one on the same page, or back to the list (which loads afresh).
      const next = nextId && EX.submissions.find(s => s.id === nextId);
      if (next) {
        openGrading(examById(exam.id) || exam, next);
        refreshAfterChange(exam.id).catch(() => { });
      } else await leaveGradingPage(true);
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
    const names = new Map(EX.data.students.map(s => [studentKey(s), s.full_name || s.email]));
    // A grade as it stands: a partly graded submission counts the points given so far.
    const rows = keys.map(key => {
      const s = byKey.get(key);
      const has = !!s?.grades && Number.isFinite(parseFloat(s.grades.totalScore));
      return { key, name: anonymous ? key : names.get(key) || key, grade: has ? eisGrade(s.grades, exam.base) : '',
        partial: has && s.status !== 'graded', submitted: !!s && s.source !== 'manual' };
    });
    const partial = rows.filter(r => r.partial).length;
    const waiting = rows.filter(r => r.submitted && !r.grade).length;
    const missing = keys.length ? '' : `<p class="exam-error">Paste the ${anonymous ? 'exam IDs' : 'class list'} on the Students tab first: EIS's order comes from there.</p>`;
    const notes = [partial && `${partial} partly graded: their grade counts the points given so far.`,
      waiting && `${waiting} submitted but not graded yet: left blank.`].filter(Boolean);
    const ov = overlay('exam-eis', { wide: false });
    ov.title(`Grades for EIS: ${examTitle(exam)}`);
    ov.body.innerHTML = `${missing}
      <p class="form-hint">Grades on the exam's base of ${fmt(exam.base)}, to two decimals, in the order of the ${anonymous ? 'exam IDs' : 'class list'} you pasted, under the headings Name and Total. Blank: no grade yet.</p>
      ${notes.length ? `<p class="form-hint eis-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>${x(notes.join(' '))}</span></p>` : ''}
      <div class="data-table-container eis-table"><table class="data-table"><thead><tr><th>#</th><th>Name</th><th>Total</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td>${i + 1}.</td><td>${x(r.name)}</td><td><strong>${x(r.grade)}</strong>${r.partial ? ' <span class="eis-partial" title="The points given so far">partly graded</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-secondary" type="button" data-eis-copy="both"><i class="fa-solid fa-copy" style="margin-right:5px"></i>Copy ${anonymous ? 'exam IDs' : 'names'} and grades</button>
      <button class="btn-sm" type="button" data-eis-copy="grades"><i class="fa-solid fa-copy" style="margin-right:5px"></i>Copy grades</button>`;
    ov.foot.onclick = async e => {
      const which = e.target.closest('[data-eis-copy]')?.dataset.eisCopy;
      if (!which) return;
      // With the headings EIS expects: Name (the name, or the exam ID) and Total.
      const text = [which === 'grades' ? 'Total' : 'Name\tTotal', ...rows.map(r => which === 'grades' ? r.grade : `${r.name}\t${r.grade}`)].join('\n');
      try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch { toast('Could not copy', 'err'); }
    };
    ov.open();
  }

  // EIS takes two decimals: 72.35, 72.4 or 72, as the grade has them.
  function eisGrade(grades, base) {
    const total = parseFloat(grades.totalScore), max = parseFloat(grades.maxScore), scale = parseFloat(base) || 100;
    if (!Number.isFinite(total)) return '';
    return String(Math.round((Number.isFinite(max) && max > 0 ? total / max * scale : total) * 100) / 100);
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
    localTimes();
    await loadScript(LIBS.jspdf);
    await loadScript(LIBS.autotable);
    const doc = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const clean = t => (typeof t === 'string' ? t.replace(/[\u202f\u2009\u00a0]/g, ' ') : t);
    const text = doc.text.bind(doc);
    doc.text = (t, ...rest) => text(Array.isArray(t) ? t.map(clean) : clean(t), ...rest);
    return doc;
  }
  // The course as the PDFs name it: code and title, the semester, the lecturers.
  function courseInfo() {
    const key = JSON.stringify([EX.course, EX.isArchive]);
    const header = COURSE_HEADERS.get(key) || {};
    const assigned = (typeof COURSE_LECTURERS !== 'undefined' && COURSE_LECTURERS.get(key)) || [];
    const lecturers = (assigned.length ? assigned.map(l => l.name)
      : Object.keys(header).filter(k => /^professor\d+$/.test(k)).map(k => header[k])).map(n => String(n || '').trim()).filter(Boolean);
    return {
      code: header.code || EX.course, title: header.title || '',
      name: [header.code || EX.course, header.title].filter(Boolean).join(' '),
      semester: [header.semester, header.year].filter(Boolean).join(' '), lecturers,
    };
  }
  // Exam IDs keep their case: EIS codes such as "aAauC" and "AAauc" are different students.
  const slug = (text, keepCase = false) => {
    const s = String(text || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
    return keepCase ? s : s.toLowerCase();
  };

  // ── The PDFs' look: plain and formal, for the university's records ──
  // At the top, what the document is (a small label in the blue) with the date it was made, the
  // exam as the title, the course under it and a rule in the blue; then the facts in two columns
  // of label and value; tables with a blue head and light rows; on every page a footer with the
  // course and exam, and the page number.
  const PDF_BLUE = [0, 69, 140];      // #00458c
  const PDF_TINT = [237, 242, 248];   // the blue, very light
  const PDF_INK = [28, 33, 40];
  const PDF_MUTED = [96, 102, 110];
  const PDF_RULE = [206, 212, 221];
  const PDF_RIGHT = [16, 110, 62];    // a right answer, a correct option

  function pdfHead(doc, w, { kind, title, subtitle }) {
    doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_BLUE);
    doc.text(kind.toUpperCase(), 15, 16, { charSpace: 0.45 });
    doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_MUTED);
    doc.text(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), 195, 16, { align: 'right' });
    w.y = 25;
    w.write(title, { size: 18, style: 'bold', color: PDF_INK, gap: 0.8 });
    if (subtitle) w.write(subtitle, { size: 11.5, color: PDF_MUTED, gap: 0 });
    w.y += 1.2;
    doc.setDrawColor(...PDF_BLUE); doc.setLineWidth(0.5); doc.line(15, w.y, 195, w.y);
    doc.setLineWidth(0.2);
    w.y += 7;
  }

  // Facts as [label, value] (empty ones left out), down the left column, then the right.
  function pdfFacts(doc, w, facts) {
    const items = facts.filter(f => f && f[1] != null && f[1] !== '' && f[1] !== false);
    if (!items.length) return;
    const half = Math.ceil(items.length / 2);
    let bottom = w.y;
    [items.slice(0, half), items.slice(half)].forEach((column, c) => {
      let y = w.y;
      const x = 15 + c * 92;
      column.forEach(([label, value]) => {
        doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_MUTED);
        doc.text(label, x, y);
        doc.setFontSize(10.5); doc.setTextColor(...PDF_INK);
        const lines = doc.splitTextToSize(String(value), 60);
        doc.text(lines, x + 27, y);
        y += lines.length * 4.8 + 1.8;
      });
      bottom = Math.max(bottom, y);
    });
    w.y = bottom + 4;
  }

  // A heading inside the document, with a thin rule over it.
  function pdfSection(doc, w, text, right = '') {
    if (w.y > 255) { doc.addPage(); w.y = 18; }
    doc.setDrawColor(...PDF_RULE); doc.line(15, w.y - 1, 195, w.y - 1);
    w.y += 4.5;
    doc.setFontSize(11.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_BLUE);
    doc.text(text, 15, w.y);
    if (right) { doc.setTextColor(...PDF_INK); doc.text(right, 195, w.y, { align: 'right' }); }
    w.y += 6;
  }

  // The tables' common style; each adds its columns.
  const pdfTable = (doc, options) => doc.autoTable({
    theme: 'grid',
    styles: { font: doc.pdfFont || 'times', fontSize: 10.5, cellPadding: { top: 2.1, bottom: 2.1, left: 2.6, right: 2.6 }, textColor: PDF_INK, lineColor: PDF_RULE, lineWidth: 0.2, valign: 'middle' },
    headStyles: { fillColor: PDF_BLUE, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9.5, lineColor: PDF_BLUE },
    alternateRowStyles: { fillColor: PDF_TINT },
    margin: { left: 15, right: 15, top: 18, bottom: 20 },
    ...options,
  });

  // Signature lines for the lecturer (their names under the first) and the date.
  function pdfSignature(doc, w, lecturers) {
    if (w.y > 245) { doc.addPage(); w.y = 30; } else w.y += 18;
    doc.setDrawColor(...PDF_INK); doc.setLineWidth(0.25);
    doc.line(15, w.y, 100, w.y); doc.line(135, w.y, 195, w.y);
    doc.setLineWidth(0.2);
    doc.setFontSize(10.5); doc.setFont(undefined, 'bold'); doc.setTextColor(...PDF_INK);
    if (lecturers.length) doc.text(doc.splitTextToSize(lecturers.join(', '), 85), 15, w.y + 5);
    doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_MUTED);
    doc.text(lecturers.length ? 'Lecturer, signature' : 'Lecturer, name and signature', 15, w.y + (lecturers.length ? 9.5 : 4.5));
    doc.text('Date', 135, w.y + 4.5);
    w.y += 14;
  }

  // parts: the pages of each student in a PDF of several ([{ from, to, label }]), numbered
  // on their own, so each student's pages can be printed and filed apart.
  function pdfFooters(doc, label, parts = null) {
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      const part = parts?.find(p => i >= p.from && i <= p.to) || { from: 1, to: pages, label };
      doc.setPage(i);
      doc.setDrawColor(...PDF_RULE); doc.setLineWidth(0.2); doc.line(15, 283, 195, 283);
      doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(...PDF_MUTED);
      if (part.label) doc.text(doc.splitTextToSize(part.label, 150)[0], 15, 288);
      doc.text(`Page ${i - part.from + 1} of ${part.to - part.from + 1}`, 195, 288, { align: 'right' });
    }
  }
  function savePdf(doc, name, label = '', parts = null) {
    pdfFooters(doc, label, parts);
    doc.save(name);
  }

  // Writes wrapped text, starting a new page when it runs past the bottom margin.
  function writer(doc) {
    const state = { y: 18 };
    state.write = (text, { x: left = 15, size = 10, style = 'normal', color = PDF_INK, gap = 1.5 } = {}) => {
      doc.setFontSize(size); doc.setFont(undefined, style); doc.setTextColor(...color);
      const lineHeight = size * 0.45;
      for (const line of doc.splitTextToSize(String(text), 180 - (left - 15))) {
        if (state.y + lineHeight > 277) { doc.addPage(); state.y = 18; }
        doc.text(line, left, state.y);
        state.y += lineHeight;
      }
      state.y += gap;
    };
    return state;
  }

  const examDateText = exam => (exam.starts_at ? (settingsOf(exam).date_only ? formatDate(exam.starts_at) : formatWhen(exam.starts_at)) : '');
  const footerLabel = exam => `${courseInfo().name}, ${examTitle(exam)}`;

  async function submissionPdfBlob(exam, sub) {
    return (await gradedPaperPdf(exam, [sub])).output('blob');
  }

  // Graded exams as one PDF, each student from a cover of their own (the exam form).
  async function exportReportsPdf(exam, subs) {
    if (!subs.length) return toast('No submissions to download');
    try {
      toast(`Preparing ${subs.length} graded exam${subs.length === 1 ? '' : 's'}…`);
      (await gradedPaperPdf(exam, subs)).save(`${slug(EX.course)}_${slug(examTitle(exam))}_graded.pdf`);
    } catch (error) {
      toast('Export failed: ' + error.message, 'err');
    }
  }
  // A file answer in the submission's PDF.
  function fileAnswerText(sub, n) {
    const file = answerFile(sub, n);
    const given = sub.answers?.[`ans-${n}`];
    if (file) return `File: ${file.name} (${formatBytes(file.size)}), in the ZIP${given === UNCONFIRMED ? '; uploaded, but not confirmed' : given == null || given === '' ? '; removed by the student' : ''}`;
    return given?.name ? 'File deleted' : given === UNCONFIRMED ? UNCONFIRMED_TEXT : '';
  }

  // A PDF per submission, and beside it the files the student uploaded, named by question.
  async function exportSubmissionsZip(exam) {
    const subs = sortedSubmissions(exam, true).filter(s => s.source !== 'manual');
    if (!subs.length) return;
    // Numbered by each student's own questions (with pool items, they differ).
    const fileQuestionsOf = sub => subQuestions(exam, sub).map((q, i) => (q.type === 'attachment' ? i + 1 : 0)).filter(Boolean);
    const numberOf = (sub, n) => subQuestions(exam, sub).slice(0, n).filter(q => q.type !== 'text_only').length;
    try {
      toast(`Preparing ${subs.length} submission${subs.length === 1 ? '' : 's'}${exam.file_count ? ' and their files' : ''}…`);
      await loadScript(LIBS.jszip);
      const zip = new window.JSZip();
      const failed = [];
      for (const sub of subs) {
        const base = `${slug(examTitle(exam))}_${slug(sub.exam_code || `${sub.student_no}_${sub.student_name}`, true)}`;
        zip.file(`${base}.pdf`, await submissionPdfBlob(exam, sub));
        for (const n of fileQuestionsOf(sub)) {
          const file = answerFile(sub, n);
          if (!file) continue;
          try { zip.file(`${base}_Q${numberOf(sub, n)}_${file.name.replace(/[\\/:*?"<>|]+/g, '_')}`, await downloadBlob(file.path)); }
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

  // The grade report, for the university: the course, the exam and its facts; everyone on the
  // class list in a numbered table (student ID, name, points, grade), whether graded or not (an
  // anonymous exam: the exam IDs that submitted); partly graded ones marked, with the points so
  // far; the average, highest and lowest; and lines for the lecturer's signature and the date.
  async function exportGradesPdf(exam) {
    const anonymous = exam.sign_in === 'anonymous';
    const base = parseFloat(exam.base) || 100;
    const hasGrade = s => !!s?.grades && Number.isFinite(parseFloat(s.grades.totalScore));
    const onBase = s => {
      const total = parseFloat(s.grades.totalScore), max = parseFloat(s.grades.maxScore);
      return max > 0 ? total / max * base : total;
    };
    const rows = rosterOf(exam).filter(r => !anonymous || r.sub);
    const shown = rows.map(r => {
      const s = r.sub;
      const grade = hasGrade(s) ? onBase(s) : null;
      const partial = grade != null && s.status !== 'graded';
      const points = hasGrade(s) && s.grades.maxScore ? `${fmt(s.grades.totalScore)} / ${fmt(s.grades.maxScore)}` : '';
      const note = grade != null ? `${fmt(grade)}${partial ? ' *' : ''}` : !s || s.source === 'manual' ? 'No submission' : 'Not graded';
      return { r, grade, partial, points, note };
    });
    try {
      const doc = await newPdf();
      const info = courseInfo();
      doc.pdfFont = await paperFont(doc, [info.name, info.semester, info.lecturers.join(' '), examTitle(exam), exam.hall,
        ...shown.flatMap(({ r }) => [r.code, r.student?.full_name, r.student?.student_no])]);
      doc.setFont(doc.pdfFont, 'normal');
      const w = writer(doc);
      pdfHead(doc, w, { kind: 'Grade report', title: examTitle(exam), subtitle: info.name });
      const graded = shown.filter(x => x.grade != null);
      pdfFacts(doc, w, [
        ['Lecturer', info.lecturers.join(', ')], ['Semester', info.semester],
        ['Type', typeLabel(exam.type)], ['Date', examDateText(exam)], ['Hall', exam.hall],
        ['Graded out of', fmt(base)], ['Weight', exam.weight != null && `${fmt(exam.weight)}% of the course grade`],
        ['Students', `${graded.length} with a grade, of ${shown.length}`],
      ]);
      const head = anonymous ? ['No.', 'Exam ID', 'Points', `Grade (of ${fmt(base)})`] : ['No.', 'Student ID', 'Student', 'Points', `Grade (of ${fmt(base)})`];
      const last = head.length - 1;
      pdfTable(doc, {
        startY: w.y,
        head: [head],
        body: shown.map(({ r, points, note }, i) => anonymous
          ? [i + 1, r.code, points, note]
          : [i + 1, shownNo(r.student?.student_no), r.student?.full_name || r.student?.email || '', points, note]),
        columnStyles: {
          0: { halign: 'right', cellWidth: 12, textColor: PDF_MUTED },
          1: { cellWidth: anonymous ? 'auto' : 30 },
          [last - 1]: { halign: 'right', cellWidth: 26 },
          [last]: { halign: 'right', cellWidth: 32, fontStyle: 'bold' },
        },
        didParseCell: data => {
          if (data.section === 'head' && (data.column.index === 0 || data.column.index >= last - 1)) data.cell.styles.halign = 'right';
          if (data.section === 'body' && data.column.index === last && shown[data.row.index]?.grade == null) {
            data.cell.styles.fontStyle = 'normal';
            data.cell.styles.textColor = PDF_MUTED;
          }
        },
      });
      w.y = doc.lastAutoTable.finalY + 7;
      if (shown.some(x => x.partial)) w.write('* Partly graded: the points given so far.', { size: 8.5, color: PDF_MUTED, gap: 1 });
      const grades = graded.map(x => x.grade).filter(Number.isFinite);
      if (grades.length) {
        const average = grades.reduce((sum, g) => sum + g, 0) / grades.length;
        w.write(`Average grade ${fmt(average)}, highest ${fmt(Math.max(...grades))}, lowest ${fmt(Math.min(...grades))}, out of ${fmt(base)}.`, { size: 10, color: PDF_MUTED });
      }
      pdfSignature(doc, w, info.lecturers);
      savePdf(doc, `${slug(EX.course)}_${slug(examTitle(exam))}_grades.pdf`, `${footerLabel(exam)}, grade report`);
      const partial = shown.filter(x => x.partial).length;
      if (partial) toast(`${partial} partly graded: their grades count the points given so far (marked *)`);
    } catch (error) {
      toast('Export failed: ' + error.message, 'err');
    }
  }


  // ── The exam paper: the questions to print, in the university's exam form ──
  // As the form EU-FRM-010-002: a cover with the logo, the faculty and department, the course and
  // the exam, the student's exam ID boxes (or name and student ID), the date, time, hall and
  // lecturer, the exam rules and Good luck; then the questions, each page headed with the logo,
  // the faculty, department and course, with the form's code and the page number at its foot.
  // True or false and multiple-choice questions in a row make one question, in parts (I, II…),
  // as on paper; a written question starts a page of its own, the rest of it for the working.
  // The answer key is the same paper with the answers marked in blue. A pool item prints one
  // student's draw (a variant). The settings are kept in this browser, per course.
  const PAPER_DEFAULTS = {
    faculty: 'Faculty of Architecture and Engineering',
    department: 'Department of Civil Engineering',
    form: 'EU-FRM-010-002-EN Pub. Date: 19/11/2019 Upd: 02',
    rules: ['The invigilator has full authority, and you must follow all their instructions.',
      'Cheating or using unauthorised devices will result in zero points and disciplinary action.',
      'Write your Exam ID in blue pen only. If you have forgotten it, wait for the attendance sheet.',
      'Show all steps clearly when solving problems so we can follow your work.',
      'If you need a calculator you must wait until someone finishes their exam to borrow theirs.'].join('\n'),
    marks: 'percent', space: 'normal', newPage: true,
  };
  const paperKey = () => `exam_paper:${String(EX.course || '').replace(/_(Fall|Spring|Summer)(\d{4})?$/, '')}`;
  function paperSettings() {
    const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
    return { ...PAPER_DEFAULTS, ...(read('exam_paper:last') || {}), ...(read(paperKey()) || {}) };
  }
  function savePaperSettings(settings) {
    const { group, variant, ...kept } = settings;
    try {
      localStorage.setItem(paperKey(), JSON.stringify(kept));
      localStorage.setItem('exam_paper:last', JSON.stringify({ faculty: kept.faculty, form: kept.form, rules: kept.rules }));
    } catch { }
  }

  function openPaperDialog(exam) {
    if (!exam || !questionCount(exam.questions)) return toast('This exam has no questions to print');
    const saved = paperSettings();
    const pool = hasPool(exam.questions);
    const ov = overlay('exam-paper');
    ov.title(`Exam paper: ${examTitle(exam)}`);
    const option = (value, label, current) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
    ov.body.innerHTML = `
      <p class="form-hint">The saved questions in the university's exam form, to print. The answer key is the same paper with the answers marked.</p>
      <div class="sg-grid exam-edit-grid paper-grid">
        <div class="form-group exam-edit-wide"><label class="form-label" for="paper-faculty">Faculty</label>
          <input type="text" id="paper-faculty" value="${x(saved.faculty)}"></div>
        <div class="form-group exam-edit-wide"><label class="form-label" for="paper-department">Department</label>
          <input type="text" id="paper-department" value="${x(saved.department)}"></div>
        <div class="form-group"><label class="form-label" for="paper-group">Group</label>
          <input type="text" id="paper-group" placeholder="e.g. Group A" value=""></div>
        ${pool ? `<div class="form-group"><label class="form-label" for="paper-variant">Variant</label>
          <input type="number" id="paper-variant" min="1" max="999" step="1" value="1">
          <p class="form-hint">Each variant draws its own questions from the pool.</p></div>` : ''}
        <div class="form-group"><label class="form-label" for="paper-marks">Marks</label>
          <select id="paper-marks">${option('percent', 'Share of the exam (/20%)', saved.marks)}${option('points', 'Points (/2 points)', saved.marks)}</select></div>
        <div class="form-group"><label class="form-label" for="paper-space">Space for answers</label>
          <select id="paper-space">${option('none', 'None', saved.space)}${option('normal', 'Normal', saved.space)}${option('large', 'Large', saved.space)}</select></div>
      </div>
      <label class="exam-inline-check"><input type="checkbox" id="paper-newpage" ${saved.newPage ? 'checked' : ''}>Written questions start a new page, the rest of it for the working</label>
      <div class="form-group paper-rules"><label class="form-label" for="paper-rules">Exam rules</label>
        <textarea id="paper-rules" rows="5">${x(saved.rules)}</textarea>
        <p class="form-hint">One a line, numbered I, II, III… on the cover.</p></div>
      <div class="form-group"><label class="form-label" for="paper-form">Form code</label>
        <input type="text" id="paper-form" value="${x(saved.form)}"></div>`;
    ov.foot.innerHTML = `<button class="btn-sm btn-secondary" type="button" data-paper="key"><i class="fa-solid fa-key" style="margin-right:5px"></i>Answer key</button>
      <button class="btn-sm" type="button" data-paper="paper"><i class="fa-regular fa-file-pdf" style="margin-right:5px"></i>Exam paper</button>`;
    ov.foot.onclick = async e => {
      const btn = e.target.closest('[data-paper]');
      if (!btn) return;
      const val = id => document.getElementById(id)?.value.trim() ?? '';
      const settings = {
        faculty: val('paper-faculty'), department: val('paper-department'), group: val('paper-group'),
        variant: Math.max(1, parseInt(val('paper-variant'), 10) || 1), marks: val('paper-marks') || 'percent',
        space: val('paper-space') || 'normal', newPage: document.getElementById('paper-newpage').checked,
        rules: document.getElementById('paper-rules').value, form: val('paper-form'),
      };
      savePaperSettings(settings);
      const buttons = [...ov.foot.querySelectorAll('button')];
      const face = btn.innerHTML;
      buttons.forEach(b => { b.disabled = true; });
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Preparing…';
      try {
        await exportPaperPdf(examById(exam.id) || exam, settings, btn.dataset.paper === 'key');
      } catch (error) {
        toast('Export failed: ' + error.message, 'err');
      } finally {
        buttons.forEach(b => { b.disabled = false; });
        btn.innerHTML = face;
      }
    };
    ov.open();
  }

  // A question image for the PDF: JPEG on white, with its size in pixels.
  const _paperImages = new Map();
  function paperImage(id) {
    const src = EX.images[id];
    if (!src) return Promise.resolve(null);
    if (!_paperImages.has(id)) _paperImages.set(id, new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0);
        resolve({ data: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height });
      };
      img.onerror = () => resolve(null);
      img.src = src;
    }));
    return _paperImages.get(id);
  }

  // Every PDF is in Times New Roman, as the university asks. The computer's own Times New Roman
  // is embedded when the browser may read it (Chrome and Edge ask once, "Use fonts installed on
  // your computer"): it looks the same everywhere and has Greek and the maths signs. Otherwise,
  // the PDF's standard Times (which PDF readers show in Times New Roman) when the text has only
  // Western European letters; with others (σ, τ, ≤, √, ş, ğ, superscripts…), Tinos, made to
  // match Times New Roman letter for letter, loaded once from the font CDN.
  const NOT_STANDARD = /[^\u0000-ÿŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]/;
  const TINOS = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/tinos@0.4.2/';
  const TINOS_FILES = { normal: '400Regular/Tinos_400Regular.ttf', bold: '700Bold/Tinos_700Bold.ttf', italic: '400Regular_Italic/Tinos_400Regular_Italic.ttf' };
  const TIMES_NAMES = { normal: 'TimesNewRomanPSMT', bold: 'TimesNewRomanPS-BoldMT', italic: 'TimesNewRomanPS-ItalicMT', bolditalic: 'TimesNewRomanPS-BoldItalicMT' };
  const _fontData = {};
  const toBase64 = bytes => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  // The computer's Times New Roman ({ style: base64 }), or null: asked once a session, as soon as
  // an export starts (the browser asks while the click is fresh).
  let _localTimes = null;
  function localTimes() {
    return _localTimes || (_localTimes = (async () => {
      if (typeof window.queryLocalFonts !== 'function') return null;
      try {
        const status = await navigator.permissions?.query({ name: 'local-fonts' }).catch(() => null);
        if (status?.state === 'denied') return null;
        const fonts = await window.queryLocalFonts({ postscriptNames: Object.values(TIMES_NAMES) });
        const byName = new Map(fonts.map(f => [f.postscriptName, f]));
        if (!byName.has(TIMES_NAMES.normal)) return null;
        const data = {};
        for (const [style, name] of Object.entries(TIMES_NAMES)) {
          const font = byName.get(name);
          if (font) data[style] = toBase64(new Uint8Array(await (await font.blob()).arrayBuffer()));
        }
        return data;
      } catch {
        return null;
      }
    })());
  }

  // Registers a family's styles on the PDF, each under its own font name, which PDF readers list
  // (a style it lacks takes the regular one).
  const TINOS_NAMES = { normal: 'Tinos-Regular', bold: 'Tinos-Bold', italic: 'Tinos-Italic', bolditalic: 'Tinos-Bold' };
  function addFamily(doc, family, data, names) {
    for (const style of ['normal', 'bold', 'italic', 'bolditalic']) {
      const have = data[style] ? style : style === 'bolditalic' && data.bold ? 'bold' : 'normal';
      const name = style === have ? names[style] : `${names[have]}-${style}`;
      doc.addFileToVFS(name, data[have]);
      doc.addFont(name, family, style);
    }
  }
  // Whether a family registered on the PDF has every letter of the texts.
  function familyCovers(doc, family, texts) {
    const font = doc.internal.getFont(family, 'normal');
    const has = font?.metadata?.characterToGlyph?.bind(font.metadata);
    if (!has) return false;
    const chars = new Set(texts.join('').replace(/\s/g, ''));
    return [...chars].every(c => has(c.codePointAt(0)) > 0);
  }

  // The PDF's font for these texts: the family name to use with setFont.
  async function paperFont(doc, texts) {
    texts = texts.filter(t => typeof t === 'string' && t);
    const local = await localTimes();
    if (local) {
      addFamily(doc, 'TimesNewRoman', local, TIMES_NAMES);
      if (familyCovers(doc, 'TimesNewRoman', texts)) return 'TimesNewRoman';
    }
    if (!texts.some(t => NOT_STANDARD.test(t))) return 'times';
    try {
      for (const [style, file] of Object.entries(TINOS_FILES)) {
        if (_fontData[style]) continue;
        const response = await fetch(TINOS + file);
        if (!response.ok) throw new Error('font');
        _fontData[style] = toBase64(new Uint8Array(await response.arrayBuffer()));
      }
      addFamily(doc, 'Tinos', _fontData, TINOS_NAMES);
      return 'Tinos';
    } catch {
      return 'times';
    }
  }

  // Question text for paper: the marks gone, m^2^ as m², H~2~O as H₂O, list lines with bullets.
  const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
  const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };
  const scripted = (text, map, mark) => ([...text].every(c => map[c]) ? [...text].map(c => map[c]).join('') : `${mark}${text}`);
  function paperText(text) {
    return String(text ?? '')
      .replace(/\^([^\s^]+)\^/g, (m, t) => scripted(t, SUP, '^'))
      .replace(/~([^\s~]+)~/g, (m, t) => scripted(t, SUB, '_'))
      .replace(/`([^`\n]+)`/g, '$1').replace(/\*\*\*|\*\*|__/g, '')
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1$2')
      .replace(/^\s*[-•]\s+/gm, '•  ');
  }

  // ── The exam form's pages, shared by the exam paper, its answer key and graded exams ──
  // A kit of drawing helpers on one PDF: the university's name as text (no logo), the cover,
  // each page's head (the name on the left; the faculty, department and course on the right)
  // and foot (the form's code, the page number), wrapped text, question headings, figures.
  const PAPER = { L: 15, R: 195, W: 180, TOP: 37, BOTTOM: 276, INK: [0, 0, 0], GREY: [90, 90, 90], BLUE: [16, 54, 160], GREEN: [16, 110, 62], RED: [176, 32, 32] };
  async function paperKit(doc, exam, opts, texts, imageIds = []) {
    const { L, R, W, TOP, BOTTOM, INK } = PAPER;
    const info = courseInfo();
    const font = await paperFont(doc, [info.name, opts.faculty, opts.department, opts.rules, examTitle(exam), info.lecturers.join(' '), ...texts]);
    const images = new Map();
    await Promise.all([...new Set(imageIds)].map(async id => images.set(id, await paperImage(id))));
    const k = { doc, info, opts, y: TOP, workPage: false, lastFigure: '' };
    const lh = k.lh = size => size * 0.3528 * 1.32;
    const set = k.set = (size, style = 'normal', color = INK) => { doc.setFont(font, style); doc.setFontSize(size); doc.setTextColor(...color); };
    const put = k.put = (text, x, y, options = {}) => doc.text(text, x, y, { baseline: 'top', ...options });
    // Lines one by one, so they sit level with what is beside them.
    k.putLines = (list, x, y, size) => list.forEach((line, i) => put(line, x, y + i * lh(size)));
    const courseLine = info.code && info.title ? `${info.code} – ${info.title}` : info.name;
    k.header = () => {
      set(10.5, 'bold'); put('EPOKA UNIVERSITY', L, 13);
      set(10, 'normal');
      [opts.faculty, opts.department, courseLine].filter(Boolean).forEach((line, i) => put(line, R, 10.5 + i * 4.6, { align: 'right' }));
      doc.setDrawColor(...INK); doc.setLineWidth(0.6); doc.line(L, 29.5, R, 29.5);
    };
    k.newPage = () => { doc.addPage(); k.header(); k.y = TOP; k.workPage = false; k.lastFigure = ''; };
    k.room = h => { if (k.y + h > BOTTOM) k.newPage(); };
    // Wrapped text from the cursor, page by page.
    k.para = (text, { x = L, width = W, size = 11, style = 'normal', color = INK, gap = 2.2, keep = 0 } = {}) => {
      set(size, style, color);
      const lines = doc.splitTextToSize(String(text ?? ''), width);
      k.room(Math.min(lines.length, 2) * lh(size) + keep);
      for (const line of lines) {
        k.room(lh(size));
        set(size, style, color);
        put(line, x, k.y);
        k.y += lh(size);
      }
      k.y += gap;
    };
    k.heading = (left, right, size = 11.5, color = INK) => {
      k.room(lh(size) + 12);
      set(size, 'bold');
      put(left, L, k.y);
      if (right) { set(size, 'bold', color); put(right, R, k.y, { align: 'right' }); }
      k.y += lh(size) + 2;
    };
    k.ring = (cx, cy, rx, color = PAPER.BLUE, ry = 3.1) => { doc.setDrawColor(...color); doc.setLineWidth(0.45); doc.ellipse(cx, cy, rx, ry, 'S'); };
    // A question's images; a figure the question before showed too is not printed again.
    k.figures = q => {
      const ids = imageIdsOf([q]);
      const key = ids.join(',');
      if (key && key === k.lastFigure) return;
      k.lastFigure = key;
      // As on screen, one size for each shape: a wide figure across the page, any other 80mm
      // wide; none taller than 100mm.
      for (const id of ids) {
        const img = images.get(id);
        if (!img) continue;
        let w = img.w / img.h >= 1.6 ? W : 80, h = img.h * w / img.w;
        if (h > 100) { h = 100; w = img.w * h / img.h; }
        k.room(h + 3);
        doc.addImage(img.data, 'JPEG', L + (W - w) / 2, k.y, w, h);
        k.y += h + 4;
      }
    };
    // The cover, on the current page. student: { code } (anonymous) or { name, no }, written in
    // blue into the boxes and on the line; with none, they are left to be filled in.
    k.cover = ({ key = false, student = null } = {}) => {
      set(24, 'bold'); put('EPOKA', 105, 18, { align: 'center' });
      set(10, 'normal'); put('UNIVERSITY', 105, 28, { align: 'center', charSpace: 1.4 });
      set(12.5, 'bold');
      let cy = 42;
      [opts.faculty, opts.department].filter(Boolean).forEach(line => { put(line.toUpperCase(), 105, cy, { align: 'center' }); cy += 7; });
      doc.setDrawColor(...INK); doc.setLineWidth(0.7); doc.line(L, cy + 3, R, cy + 3);
      cy += 11;
      set(12.5, 'bold'); put(courseLine.toUpperCase(), 105, cy, { align: 'center' });
      cy += 8;
      set(19, 'bold'); put(examTitle(exam).toUpperCase(), 105, cy, { align: 'center' });
      cy += 15;
      const anonymous = signInOf(exam) === 'anonymous';
      const boxes = (label, count, at, fill = '') => {
        set(11, 'normal'); put(label, 105, at, { align: 'center' });
        const bw = 11, bh = 12, left = 105 - count * bw / 2;
        doc.setDrawColor(...INK); doc.setLineWidth(0.5);
        for (let i = 0; i < count; i++) doc.rect(left + i * bw, at + 6, bw, bh);
        doc.setLineWidth(1.1); doc.line(left + 0.6, at + 6 + bh + 0.9, left + count * bw + 0.6, at + 6 + bh + 0.9);
        set(15, 'bold', PAPER.BLUE);
        [...String(fill)].slice(0, count).forEach((c, i) => put(c, left + i * bw + bw / 2, at + 8.4, { align: 'center' }));
        return at + 6 + bh + 8;
      };
      if (anonymous) cy = boxes("STUDENT'S EXAM ID", Math.max(5, String(student?.code || '').length, ...EX.data.codes.map(c => String(c).length).filter(n => n <= 10)), cy, student?.code || '');
      else {
        set(11, 'normal'); put('STUDENT NAME', 105, cy, { align: 'center' });
        doc.setDrawColor(...INK); doc.setLineWidth(0.4); doc.line(55, cy + 15, 155, cy + 15);
        if (student?.name) { set(13, 'bold', PAPER.BLUE); put(student.name, 105, cy + 8.5, { align: 'center' }); }
        cy += 21;
        cy = boxes('STUDENT ID', Math.min(12, Math.max(6, String(student?.no || '').length, ...EX.data.students.map(s => String(s.student_no || '').length))), cy, student?.no || '');
      }
      if (key) { set(15, 'bold', PAPER.BLUE); put('ANSWER KEY', 105, cy - 3, { align: 'center' }); cy += 7; }
      const starts = exam.starts_at ? new Date(exam.starts_at) : null;
      const two = n => String(n).padStart(2, '0');
      const facts = [
        ['DATE', starts ? `${two(starts.getDate())}-${two(starts.getMonth() + 1)}-${starts.getFullYear()}` : ''],
        ['TIME', starts && !settingsOf(exam).date_only ? `${two(starts.getHours())}:${two(starts.getMinutes())}` : ''],
        ['EXAM HALL', exam.hall || ''],
        ['LECTURER', info.lecturers.join(', ').toUpperCase()],
      ].filter(([, value]) => value);
      for (const [label, value] of facts) {
        set(11, 'normal'); put(label, 105, cy, { align: 'center' });
        set(12, 'bold'); put(value, 105, cy + 5.6, { align: 'center' });
        cy += 14.5;
      }
      doc.setDrawColor(...INK); doc.setLineWidth(0.7); doc.line(L, cy, R, cy);
      return cy + 7;
    };
    // Every page's foot: the form's code, and on the right what parts say (a cover's group,
    // the page within each student's pages).
    k.footers = (right = i => (i === 1 ? '' : `p. ${i}`)) => {
      const pages = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setDrawColor(...INK); doc.setLineWidth(0.5); doc.line(L, 284, R, 284);
        set(8, 'italic', PAPER.GREY);
        if (opts.form) put(opts.form, L, 286.5);
        set(9, 'normal', PAPER.GREY);
        const text = right(i);
        if (text) put(text, R, 286.5, { align: 'right' });
      }
    };
    return k;
  }

  async function exportPaperPdf(exam, opts, key) {
    localTimes(); // asked while the click is fresh
    const { L, R, W, TOP, INK, GREY, BLUE } = PAPER;
    const withPool = hasPool(exam.questions);
    if (withPool && !EX.pool) await loadPool();
    await Promise.all([loadImages(exam), withPool ? loadPoolImages() : null]);
    const questions = withPool ? drawnQuestions(exam.questions, sampleDraws(exam.questions, opts.variant)) : (exam.questions || []);
    const doc = await newPdf();
    const k = await paperKit(doc, exam, opts,
      questions.flatMap(q => [paperText(q.prompt), ...(q.options || []).map(paperText), ...(q.accepted_answers || []), q.explanation, q.unit, q.content]),
      questions.flatMap(q => imageIdsOf([q])));
    const { set, put, putLines, lh, para, heading, room, ring } = k;

    // ── The cover: then the exam rules and Good luck ──
    let cy = k.cover({ key });
    const rules = String(opts.rules || '').split('\n').map(r => r.trim()).filter(Boolean);
    const roman = n => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'][n] || String(n + 1);
    if (rules.length) {
      set(12, 'bold'); put('EXAM RULES', 105, cy, { align: 'center' });
      cy += 8;
      rules.forEach((rule, i) => {
        set(11, 'normal');
        put(`${roman(i)}.`, L + 2, cy);
        const lines = doc.splitTextToSize(paperText(rule), W - 14);
        putLines(lines, L + 12, cy, 11);
        cy += lines.length * lh(11) + 1.4;
      });
    }
    set(12.5, 'bold'); put('GOOD LUCK!', 105, Math.max(cy + 6, 255), { align: 'center' });

    const total = questions.reduce((sum, q) => sum + questionMaxPoints(q), 0) || 1;
    const marks = points => (opts.marks === 'points'
      ? `/${fmt(points)} ${Number(points) === 1 ? 'point' : 'points'}` : `/${fmt(points / total * 100)}%`);

    // ── The questions ──
    // True or false and multiple choice in a row: one question in parts; the rest one each.
    const objective = q => q.type === 'true_false' || q.type === 'multiple_select';
    const blocks = [];
    let notes = [];
    for (let i = 0; i < questions.length;) {
      const q = questions[i];
      if (q.type === 'text_only') { notes.push(q); i++; continue; }
      if (objective(q)) {
        let j = i;
        while (j < questions.length && objective(questions[j])) j++;
        const parts = [];
        questions.slice(i, j).forEach(item => {
          const last = parts[parts.length - 1];
          if (last?.type === item.type) last.items.push(item); else parts.push({ type: item.type, items: [item] });
        });
        blocks.push({ parts, notes });
        i = j;
      } else {
        blocks.push({ q, notes });
        i++;
      }
      notes = [];
    }
    if (notes.length) blocks.push({ notes });

    k.newPage();
    let number = 0;
    for (const block of blocks) {
      if (k.workPage) k.newPage();
      for (const note of block.notes) {
        para(paperText(note.prompt), { size: 11, gap: 3 });
        k.figures(note);
      }
      if (!block.q && !block.parts) continue;
      if (block.parts) {
        const points = block.parts.reduce((sum, part) => sum + part.items.reduce((s, q) => s + questionMaxPoints(q), 0), 0);
        heading(`QUESTION ${++number}`, marks(points));
        for (const [p, part] of block.parts.entries()) {
          const many = part.items.length > 1;
          const ask = part.type === 'true_false' ? `State if the following statement${many ? 's are' : ' is'} TRUE or FALSE.` : 'Circle the correct answer.';
          room(lh(11) * 3);
          set(11, 'bold');
          put(`${block.parts.length > 1 ? `${roman(p)}. ` : ''}${ask}`, L, k.y);
          if (block.parts.length > 1) put(marks(part.items.reduce((s, q) => s + questionMaxPoints(q), 0)), R, k.y, { align: 'right' });
          k.y += lh(11) + 2;
          for (const [i, q] of part.items.entries()) {
            if (part.type === 'true_false') paperTrueFalse(k, q, { letter: many ? `${String.fromCharCode(97 + i)}.` : '', circle: key ? q.answer : null });
            else paperChoice(k, q, { circle: key ? (q.correct_answers || []) : [] });
          }
          k.y += 3;
        }
        continue;
      }
      const q = block.q;
      const written = ['long_answer', 'code', 'attachment'].includes(q.type);
      if (written && opts.newPage && k.y > TOP + 1) k.newPage();
      heading(`QUESTION ${++number}`, marks(questionMaxPoints(q)));
      para(paperText(q.prompt), { size: 11, gap: 3 });
      k.figures(q);
      if (q.type === 'code' && q.content) paperCode(k, q.content);
      if (q.type === 'attachment' && q.allowed_types?.length) para(`To hand in as: ${q.allowed_types.join(', ')}`, { size: 9.5, style: 'italic', color: GREY });
      if (q.type === 'short_answer' || q.type === 'numeric') {
        paperAnswerLine(k, q, key ? (q.type === 'numeric' ? `${exact(q.answer)}${Number(q.tolerance) ? ` ± ${exact(q.tolerance)}` : ''}`
          : (q.accepted_answers || []).join('  or  ') || 'Graded by hand') : '');
      } else if (written) {
        if (key) para(q.explanation ? `Answer key: ${paperText(q.explanation)}` : 'Graded by hand.', { size: 10.5, style: 'italic', color: BLUE, gap: 3 });
        if (opts.newPage) k.workPage = true;
        else k.y += { none: 0, normal: q.type === 'attachment' ? 80 : 55, large: q.type === 'attachment' ? 130 : 95 }[opts.space] || 0;
      }
      if (key && !written && q.explanation) para(`Notes: ${paperText(q.explanation)}`, { size: 10, style: 'italic', color: BLUE });
      k.y += 4;
    }
    k.footers(i => (i === 1 ? (opts.group || '') : `p. ${i}`));
    doc.save(`${slug(EX.course)}_${slug(examTitle(exam))}${opts.group ? `_${slug(opts.group)}` : ''}${withPool ? `_v${opts.variant}` : ''}_${key ? 'answer_key' : 'paper'}.pdf`);
  }

  // A true or false statement: TRUE | FALSE, then the statement; circle: the answer to ring
  // (true or false), right: the correct one, in bold, when it is not the ringed one.
  function paperTrueFalse(k, q, { letter = '', circle = null, right = null, ringColor = PAPER.BLUE } = {}) {
    const { L, W } = PAPER;
    const { doc, set, put, putLines, lh } = k;
    set(11, 'normal');
    const statement = doc.splitTextToSize(paperText(q.prompt), W - 52);
    k.room(statement.length * lh(11) + 2);
    if (letter) put(letter, L + 2, k.y);
    const tx = L + 9;
    set(11, right === true && circle !== true ? 'bold' : 'normal', right === true && circle !== true ? PAPER.GREEN : PAPER.INK);
    put('TRUE', tx, k.y);
    const tw = doc.getTextWidth('TRUE');
    set(11, 'normal'); put(' | ', tx + tw, k.y);
    const bar = doc.getTextWidth(' | ');
    set(11, right === false && circle !== false ? 'bold' : 'normal', right === false && circle !== false ? PAPER.GREEN : PAPER.INK);
    put('FALSE', tx + tw + bar, k.y);
    if (typeof circle === 'boolean') {
      set(11, 'normal');
      const word = circle ? 'TRUE' : 'FALSE', wx = circle ? tx : tx + tw + bar, ww = doc.getTextWidth(word);
      k.ring(wx + ww / 2, k.y + lh(11) * 0.42, ww / 2 + 1.6, ringColor);
    }
    set(11, 'normal');
    putLines(statement, L + 44, k.y, 11);
    k.y += statement.length * lh(11) + 2.2;
    k.figures(q);
  }

  // A multiple-choice question: its text, then the options in as many columns as fit; circle:
  // the options to ring (the answer key's, or the student's), right: those to set in bold green.
  // With Other, a last line to write on; other: what the student wrote there (ringed).
  function paperChoice(k, q, { circle = [], right = [], ringColor = PAPER.BLUE, keyStyle = true, other = null } = {}) {
    const { L, W } = PAPER;
    const { doc, set, put, putLines, lh } = k;
    k.para(paperText(q.prompt), { size: 11, gap: 2, keep: lh(11) * 2 });
    k.figures(q);
    const options = (q.options || []).map((o, i) => ({ text: paperText(o), ringed: circle.includes(o), right: right.includes(o), i }));
    set(11, 'normal');
    const widest = Math.max(0, ...options.map(o => doc.getTextWidth(`${String.fromCharCode(97 + o.i)}) ${o.text}`)));
    const cols = widest + 6 <= W / 4 ? 4 : widest + 6 <= W / 2 ? 2 : 1;
    const colW = W / cols;
    for (let r = 0; r < options.length; r += cols) {
      const row = options.slice(r, r + cols);
      const height = Math.max(...row.map(o => doc.splitTextToSize(o.text, colW - 10).length)) * lh(11);
      k.room(height + 1.5);
      row.forEach((o, c) => {
        const ox = L + 4 + c * colW;
        const letter = `${String.fromCharCode(97 + o.i)})`;
        const strong = (keyStyle && o.ringed) || o.right;
        set(11, strong ? 'bold' : 'normal', o.right ? PAPER.GREEN : keyStyle && o.ringed ? ringColor : PAPER.INK);
        put(letter, ox, k.y);
        putLines(doc.splitTextToSize(o.text, colW - 10), ox + 6.5, k.y, 11);
        if (o.ringed) k.ring(ox + doc.getTextWidth(letter) / 2, k.y + lh(11) * 0.42, doc.getTextWidth(letter) / 2 + 1.8, ringColor);
      });
      k.y += height + 1.5;
    }
    if (q.allow_other) {
      k.room(lh(11) + 4);
      const ox = L + 4, letter = `${String.fromCharCode(97 + options.length)})`;
      set(11, other != null ? 'bold' : 'normal', other != null ? ringColor : PAPER.INK);
      put(letter, ox, k.y);
      set(11, 'normal');
      put('Other:', ox + 6.5, k.y);
      const lx = ox + 6.5 + doc.getTextWidth('Other: ') + 1;
      doc.setDrawColor(...PAPER.INK); doc.setLineWidth(0.3); doc.line(lx, k.y + lh(11) * 0.8, L + W * 0.62, k.y + lh(11) * 0.8);
      if (other != null) {
        k.ring(ox + doc.getTextWidth(letter) / 2, k.y + lh(11) * 0.42, doc.getTextWidth(letter) / 2 + 1.8, ringColor);
        set(11, 'bold', ringColor);
        put(doc.splitTextToSize(paperText(other), L + W * 0.62 - lx - 2)[0] || '', lx + 1.5, k.y - 0.4);
      }
      k.y += lh(11) + 3;
    }
    k.y += 3;
  }

  // Answer: and its line (a numeric answer's unit after it), with what is written on it in blue.
  function paperAnswerLine(k, q, written = '', color = PAPER.BLUE) {
    const { L, INK } = PAPER;
    const { doc, set, put } = k;
    k.room(12);
    set(11, 'normal'); put('Answer:', L, k.y + 4);
    doc.setDrawColor(...INK); doc.setLineWidth(0.3); doc.line(L + 17, k.y + 9, L + 105, k.y + 9);
    if (q.type === 'numeric' && q.unit) put(paperText(q.unit), L + 108, k.y + 4);
    if (written) {
      set(11, 'bold', color);
      put(doc.splitTextToSize(paperText(written), 86)[0], L + 19, k.y + 3.4);
    }
    k.y += 15;
  }

  // Code, or a written answer, in a light box, page by page.
  function paperCode(k, text, { mono = true, color = PAPER.INK } = {}) {
    const { L, W } = PAPER;
    const { doc, set, put } = k;
    const size = mono ? 9.5 : 10.5, step = mono ? 4.3 : 5;
    set(size, 'normal', color);
    if (mono) doc.setFont('courier', 'normal');
    const lines = doc.splitTextToSize(String(text), W - 8);
    for (let i = 0; i < lines.length;) {
      k.room(step * 2 + 4);
      const fit = Math.max(1, Math.min(lines.length - i, Math.floor((PAPER.BOTTOM - k.y - 4) / step)));
      doc.setFillColor(244, 244, 244); doc.rect(L, k.y, W, fit * step + 4, 'F');
      set(size, 'normal', color);
      if (mono) doc.setFont('courier', 'normal');
      lines.slice(i, i + fit).forEach((line, j) => put(line, L + 4, k.y + 2 + j * step));
      k.y += fit * step + 6;
      i += fit;
    }
    k.y += 2;
  }

  // ── A graded exam, in the same form: the cover with the student written in and the grade,
  // then each question with the answer as given (rings and lines in blue), the right one in
  // green, the points awarded and the comment; the feedback at the end. ──
  function gradedTexts(exam, sub) {
    const questions = subQuestions(exam, sub);
    return [sub.student_name, sub.exam_code, sub.grades?.feedback,
      ...questions.flatMap((q, i) => [paperText(q.prompt), ...(q.options || []).map(paperText), ...(q.accepted_answers || []), q.unit,
        typeof sub.answers?.[`ans-${i + 1}`] === 'string' ? sub.answers[`ans-${i + 1}`] : '', sub.grades?.questionGrades?.[`q-${i + 1}`]?.comment])];
  }

  function writeGradedPaper(k, exam, sub) {
    const { L, W, BLUE, GREEN, GREY, RED } = PAPER;
    const { doc, set, put, lh, para, heading } = k;
    const questions = subQuestions(exam, sub);
    const grades = sub.grades || {};
    const graded = Number.isFinite(parseFloat(grades.totalScore));
    const plainHtml = html => String(html).replace(/<br>/g, ' or ').replace(/<[^>]+>/g, '')
      .replace(/&[^;]+;/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m] || m));

    // ── The cover: the student written in, then the grade ──
    let cy = k.cover({ student: sub.exam_code ? { code: sub.exam_code } : { name: sub.student_name, no: shownNo(sub.student_no) } });
    set(12, 'bold'); put('GRADE', 105, cy, { align: 'center' });
    set(26, 'bold', graded ? BLUE : GREY); put(graded ? gradeOnBase(grades, exam.base) : 'Not graded', 105, cy + 7, { align: 'center' });
    cy += 20;
    set(10.5, 'normal', GREY);
    const lines = [
      graded && questions.length ? `${fmt(grades.totalScore)} of ${fmt(grades.maxScore)} points${sub.status !== 'graded' ? ', partly graded' : ''}` : '',
      sub.source === 'manual' ? 'No submission: the grade was entered by hand'
        : `Submitted ${formatWhen(sub.submitted_at)}${sub.late ? ', late' : ''}${sub.auto_submitted ? ', when time ran out' : ''}${sub.source === 'imported' ? ', from the backup file' : ''}`,
      grades.gradedAt ? `Graded${grades.gradedBy ? ` by ${grades.gradedBy}` : ''} on ${formatWhen(grades.gradedAt)}` : '',
    ].filter(Boolean);
    lines.forEach(line => { put(line, 105, cy, { align: 'center' }); cy += 5.6; });
    if (grades.feedback) {
      cy += 4;
      set(12, 'bold'); put('FEEDBACK', 105, cy, { align: 'center' });
      cy += 7;
      set(11, 'italic', BLUE);
      const feedback = doc.splitTextToSize(String(grades.feedback), W - 20);
      const fits = Math.floor((PAPER.BOTTOM - cy) / lh(11));
      // Too long for the cover: it goes after the questions instead.
      if (feedback.length <= fits) feedback.forEach((line, i) => put(line, 105, cy + i * lh(11), { align: 'center' }));
      else { set(10.5, 'italic', GREY); put('After the questions.', 105, cy, { align: 'center' }); }
    }
    const feedbackAtEnd = !!grades.feedback && cy > 0 && doc.splitTextToSize(String(grades.feedback), W - 20).length > Math.floor((PAPER.BOTTOM - cy) / lh(11));

    // ── The questions, one by one ──
    k.newPage();
    let number = 0;
    questions.forEach((q, i) => {
      const n = i + 1;
      if (q.type === 'text_only') {
        if (q.prompt) para(paperText(q.prompt), { size: 11, gap: 3 });
        k.figures(q);
        return;
      }
      number++;
      const g = grades.questionGrades?.[`q-${n}`] || {};
      const has = g.points !== '' && g.points != null;
      const max = questionMaxPoints(q);
      const status = has ? (Number(g.points) >= max ? GREEN : Number(g.points) <= 0 ? RED : BLUE) : GREY;
      heading(`QUESTION ${number}`, has ? `${fmt(g.points)} / ${fmt(max)}` : `Not graded / ${fmt(max)}`, 11.5, status);
      const given = sub.answers?.[`ans-${n}`];
      const unsent = given === UNCONFIRMED;
      const empty = given == null || given === '';
      if (q.type === 'true_false') {
        const answer = /^true$/i.test(given) ? true : /^false$/i.test(given) ? false : null;
        paperTrueFalse(k, q, { circle: answer, right: typeof q.answer === 'boolean' ? q.answer : null });
      } else if (q.type === 'multiple_select') {
        const written = otherAnswer(sub.answers, n) && typeof given === 'string' && given ? given : null;
        paperChoice(k, q, { circle: typeof given === 'string' && !written ? [given] : [], right: q.correct_answers || [], keyStyle: false, other: written });
      } else {
        para(paperText(q.prompt), { size: 11, gap: 3 });
        k.figures(q);
        if (q.type === 'short_answer' || q.type === 'numeric') paperAnswerLine(k, q, unsent || empty ? '' : String(given));
        else if (q.type === 'attachment') para(fileAnswerText(sub, n) || 'No file uploaded', { size: 10.5, color: BLUE });
        else if (!unsent && !empty) paperCode(k, String(given), { mono: q.type === 'code', color: BLUE });
      }
      if (unsent) para(UNCONFIRMED_TEXT, { size: 10, style: 'italic', color: GREY });
      else if (empty && q.type !== 'attachment') para('No answer', { size: 10, style: 'italic', color: GREY });
      const key = q.type === 'multiple_select' || q.type === 'true_false' ? null : answerKey(q);
      if (key) para(`${key.label}: ${plainHtml(key.html)}`, { size: 10, color: GREEN });
      if (g.comment) para(`Comment: ${g.comment}`, { size: 10.5, style: 'italic', color: BLUE });
      k.y += 4;
    });
    if (feedbackAtEnd) {
      heading('FEEDBACK');
      para(grades.feedback, { size: 11, style: 'italic', color: BLUE });
    }
  }

  // Graded exams in the exam form: one PDF, each student's pages from a cover of their own,
  // numbered on their own (so each can be printed and filed apart). One submission: its PDF.
  async function gradedPaperPdf(exam, subs) {
    const doc = await newPdf();
    const k = await paperKit(doc, exam, paperSettings(), subs.flatMap(sub => gradedTexts(exam, sub)),
      subs.flatMap(sub => subQuestions(exam, sub).flatMap(q => imageIdsOf([q]))));
    const parts = [];
    subs.forEach((sub, i) => {
      if (i) doc.addPage();
      k.lastFigure = '';
      const from = doc.internal.getNumberOfPages();
      writeGradedPaper(k, exam, sub);
      parts.push({ from, to: doc.internal.getNumberOfPages(), who: sub.exam_code || sub.student_name || '' });
    });
    k.footers(i => {
      const part = parts.find(p => i >= p.from && i <= p.to);
      if (!part) return '';
      return [part.who, i > part.from ? `p. ${i - part.from + 1}` : ''].filter(Boolean).join(', ');
    });
    return doc;
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
      <td class="gb-sticky gb-sticky-2 gb-name"><span class="gb-who" title="${x([s.full_name, s.student_no, s.email].filter(Boolean).join(', '))}">
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
    const picked = window.getSelection();
    if (picked && !picked.isCollapsed && tr.contains(picked.anchorNode)) return; // text selected, to copy
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
  // Numbers as this computer's settings write them (1,000.5, 1.000,5 or 1 000,5): to a tenth, and
  // points to a hundredth (pts). Fields and attributes keep plain numbers.
  const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const NUMBER_2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  function fmt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? NUMBER.format(Math.round(n * 10) / 10) : '';
  }
  function formatWhen(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }
  // A date without a time (an exam whose time is not set).
  function formatDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }
  // The exams list's date: "Wed 11 Nov, 13:40" (the year too when it is not this one).
  function listWhen(iso, dateOnly = false) {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
      ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }) }).replace(/^(\w+),/, '$1');
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
