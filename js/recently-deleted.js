// Recently deleted: what the editor deleted in the last 30 days, put back with one click.
// - A course's (its ⋯ menu, lecturers and admins): content removed in a save (a module with its
//   files, an announcement, an Info field…), exams with their submissions, questions taken out
//   of an exam or the question pool, submissions, students and exam codes.
// - Deleted courses (the sidebar, admins): a whole course, with its exam data.
// The bin is in the database (supabase/backup/recently-deleted.sql); until that has run, the
// menu item and the sidebar button stay hidden. Uses the editor's globals (sb, S, x, toast…).
(function () {
  'use strict';

  const KEEP_DAYS = 30;
  const Bin = window.Bin = { ready: null };

  // ── Whether the bin exists: asked once a session, as soon as a lecturer or admin is signed in ──
  let probing = null;
  function probe() {
    if (probing || Bin.ready !== null) return probing;
    probing = (async () => {
      try { const { error } = await sb.rpc('bin_ready'); Bin.ready = !error; }
      catch { Bin.ready = false; }
      document.documentElement.toggleAttribute('data-bin', Bin.ready);
      syncSidebar();
    })();
    return probing;
  }
  const managing = () => ['global_admin', 'admin', 'lecturer'].includes(S.access?.role);
  function syncSidebar() {
    const button = document.getElementById('sb-bin');
    if (button) button.hidden = !(Bin.ready && isCourseAdmin());
  }
  // Runs with the editor's own access check (signing in, Settings, a course opened).
  const baseControls = window.renderAccessControls;
  window.renderAccessControls = function (...args) {
    const out = baseControls?.apply(this, args);
    if (managing()) probe();
    syncSidebar();
    return out;
  };

  // ── What each entry is ──
  const CONTENT = {
    module: ['Module', 'modules', 'fa-solid fa-layer-group'],
    material: ['File', 'files', 'fa-regular fa-file'],
    funfact: ['Fun fact', 'fun facts', 'fa-regular fa-lightbulb'],
    announcement: ['Announcement', 'announcements', 'fa-solid fa-bullhorn'],
    project: ['Assignment', 'assignments', 'fa-solid fa-diagram-project'],
    project_file: ['Assignment file', 'assignment files', 'fa-regular fa-file'],
    project_description: ['Assignment description', 'assignment descriptions', 'fa-solid fa-align-left'],
    project_group: ['Project group', 'project groups', 'fa-solid fa-people-group'],
    group_file: ['Group file', 'group files', 'fa-regular fa-file'],
    button: ['Link', 'links', 'fa-solid fa-link'],
    metadata: ['Info field', 'Info fields', 'fa-solid fa-circle-info'],
  };
  const TOP = ['module', 'project', 'announcement', 'button', 'project_group', 'material', 'project_file', 'group_file', 'funfact', 'project_description', 'metadata'];
  const contentOf = kind => CONTENT[kind] || ['Item', 'items', 'fa-regular fa-file'];
  const NUMBER = new Intl.NumberFormat();
  const count = (n, one, many) => `${NUMBER.format(n)} ${n === 1 ? one : many}`;
  // An Info field by its key: "header_decoration" is "Header decoration".
  const fieldName = key => { const s = String(key || '').replace(/_/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
  const listed = names => names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');

  // { icon, name, sub } for an entry of public.bin_list.
  function describe(g) {
    const items = g.items || [], first = items[0] || {}, n = g.count, from = g.parent_label || 'an exam';
    switch (g.kind) {
      case 'content': {
        const top = [...items].sort((a, b) => TOP.indexOf(a.kind) - TOP.indexOf(b.kind))[0] || first;
        const kinds = new Map();
        items.forEach(i => kinds.set(i.kind, (kinds.get(i.kind) || 0) + 1));
        // The kinds of what went, the main one first: "Module, 2 files".
        const parts = [...kinds].sort((a, b) => TOP.indexOf(a[0]) - TOP.indexOf(b[0]))
          .map(([kind, k], i) => { const [one, many] = contentOf(kind); const word = k === 1 ? one : many; return k === 1 ? (i ? word.toLowerCase() : word) : `${NUMBER.format(k)} ${word}`; });
        const more = n - items.length;
        return { icon: contentOf(top.kind)[2], name: top.kind === 'metadata' ? fieldName(top.label) : top.label || contentOf(top.kind)[0],
          sub: parts.join(', ') + (more > 0 ? `, ${count(more, 'more item', 'more items')}` : '') };
      }
      case 'exam':
        return { icon: 'fa-solid fa-file-pen', name: first.label || 'Exam', sub: g.with ? `Exam, with ${count(g.with, 'submission', 'submissions')}` : 'Exam' };
      case 'questions':
        return n === 1 ? { icon: 'fa-solid fa-list-check', name: first.label, sub: `Question from ${from}` }
          : { icon: 'fa-solid fa-list-check', name: count(n, 'question', 'questions'), sub: `From ${from}` };
      case 'pool':
        return n === 1 ? { icon: 'fa-solid fa-layer-group', name: first.label, sub: 'Question from the question pool' }
          : { icon: 'fa-solid fa-layer-group', name: count(n, 'question', 'questions'), sub: 'From the question pool' };
      case 'submissions':
        return n === 1 ? { icon: 'fa-regular fa-file-lines', name: first.label, sub: `Submission to ${from}` }
          : { icon: 'fa-regular fa-file-lines', name: count(n, 'submission', 'submissions'), sub: `To ${from}` };
      case 'students':
        return n === 1 ? { icon: 'fa-solid fa-user', name: first.label, sub: 'Student, from the class list' }
          : { icon: 'fa-solid fa-users', name: count(n, 'student', 'students'), sub: listed(items.map(i => i.label)) };
      default:
        return n === 1 ? { icon: 'fa-solid fa-hashtag', name: first.label, sub: 'Exam code' }
          : { icon: 'fa-solid fa-hashtag', name: count(n, 'exam code', 'exam codes'), sub: listed(items.map(i => i.label)) };
    }
  }

  // When: "Just now", "12 min ago", "3 h ago", "Yesterday, 14:05", then "Mon 23 Nov, 14:05".
  function when(iso) {
    const d = new Date(iso), mins = Math.round((Date.now() - d) / 60000);
    const clock = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const day = t => { const x = new Date(t); return Math.round(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86400000); };
    const days = day(Date.now()) - day(d);
    if (days === 0) return `${Math.round(mins / 60)} h ago`;
    if (days === 1) return `Yesterday, ${clock}`;
    return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }).replace(',', '')}, ${clock}`;
  }
  const byWhom = email => (!email ? '' : email === S.access?.email ? 'by you' : `by ${email}`);
  const fullWhen = iso => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ── The dialog (the exam dialogs' look; js/dialogs.js closes it) ──
  function dialog(title) {
    let el = document.getElementById('bin-dialog');
    if (!el) {
      el = document.createElement('div');
      el.className = 'modal-overlay exam-overlay';
      el.id = 'bin-dialog';
      el.innerHTML = `<div class="modal bin-modal" role="dialog" aria-modal="true" aria-labelledby="bin-dialog-title">
        <div class="modal-head"><h3 id="bin-dialog-title"></h3>
          <button class="btn-ghost btn-icon modal-close" type="button" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="modal-body" id="bin-dialog-body"></div>
        <div class="modal-foot" id="bin-dialog-foot"></div>
      </div>`;
      document.body.appendChild(el);
    }
    el.querySelector('#bin-dialog-title').textContent = title;
    const body = el.querySelector('#bin-dialog-body'), foot = el.querySelector('#bin-dialog-foot');
    foot.innerHTML = `<span class="foot-start bin-note">Kept for ${KEEP_DAYS} days, then deleted for good</span>
      <button type="button" class="btn-sm btn-secondary" data-close>Close</button>`;
    body.innerHTML = '<div class="bin-loading" role="status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Loading…</div>';
    el.classList.add('open');
    return { el, body };
  }

  const rowHtml = (key, { icon, name, sub }, at, by, { disabled = false, title = '' } = {}) => `<div class="bin-row" role="listitem" data-bin-key="${x(key)}">
      <span class="bin-icon" aria-hidden="true"><i class="${icon}"></i></span>
      <span class="bin-what" title="${x([name, sub].filter(Boolean).join('\n'))}"><span class="bin-name">${x(name)}</span><span class="bin-sub">${x(sub)}</span></span>
      <span class="bin-when" title="${x(`Deleted ${fullWhen(at)}${by ? ` ${by}` : ''}`)}"><span>${x(when(at))}</span><span class="bin-sub">${x(by)}</span></span>
      <button type="button" class="btn-sm btn-secondary bin-restore" data-bin-restore="${x(key)}" ${disabled ? 'disabled' : ''}${title ? ` title="${x(title)}"` : ''}><i class="fa-solid fa-rotate-left" aria-hidden="true"></i>Restore</button>
    </div>`;
  const emptyHtml = text => `<div class="bin-empty"><i class="fa-regular fa-trash-can" aria-hidden="true"></i><span>${x(text)}</span></div>`;
  const failed = error => `<p class="exam-error">${x(error?.message || 'Recently deleted could not be loaded')}</p>`;

  // A row restored: it folds away; the list says so when it was the last.
  function removeRow(body, key, emptyText) {
    const row = body.querySelector(`[data-bin-key="${CSS.escape(key)}"]`);
    if (!row) return;
    row.classList.add('is-gone');
    setTimeout(() => {
      row.remove();
      if (!body.querySelector('.bin-row')) body.innerHTML = emptyHtml(emptyText);
    }, 260);
  }
  async function restoring(btn, run) {
    const face = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>Restoring…';
    try { return await run(); }
    catch (error) { toast('Restore failed: ' + (error?.message || error), 'err'); return null; }
    finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = face; } }
  }

  // ── A course's ──
  window.openRecentlyDeleted = async function () {
    const course = S.course, isArchive = S.isArchive;
    if (!course) return;
    // Restoring reloads the tab: changes not saved go first (or stay, with the dialog shut).
    if (typeof confirmLeaveIfDirty === 'function' && !(await confirmLeaveIfDirty())) return;
    const header = COURSE_HEADERS.get(JSON.stringify([course, isArchive]));
    const { el, body } = dialog(`Recently Deleted: ${header?.code || course}`);
    const empty = `Nothing was deleted from this course in the last ${KEEP_DAYS} days.`;
    const { data, error } = await sb.rpc('bin_list', { p_sheet: course, p_archive: isArchive });
    if (S.course !== course || !el.classList.contains('open')) return;
    if (error) { body.innerHTML = failed(error); return; }
    const entries = new Map((data || []).map(g => [g.key, g]));
    body.innerHTML = entries.size ? `<div class="bin-list" role="list">${[...entries.values()].map(g => rowHtml(g.key, describe(g), g.deleted_at, byWhom(g.deleted_by))).join('')}</div>` : emptyHtml(empty);
    body.onclick = async e => {
      const btn = e.target.closest('[data-bin-restore]');
      const g = btn && entries.get(btn.dataset.binRestore);
      if (!g) return;
      const result = await restoring(btn, async () => {
        const { data: out, error: err } = await sb.rpc('bin_restore', { p_sheet: course, p_archive: isArchive, p_ids: g.ids });
        if (err) throw err;
        return out;
      });
      if (!result) return;
      if (result.kept) {
        toast(`Not restored: ${(result.notes || []).join('. ') || `${result.kept} could not go back`}`, 'err');
        if (!result.restored) return;
      } else toast('Restored', 'ok');
      entries.delete(g.key);
      removeRow(body, g.key, empty);
      // The open tab shows it again.
      if (S.course === course && S.isArchive === isArchive && typeof loadSection === 'function') loadSection(S.section);
    };
  };

  // ── Deleted courses (admins) ──
  window.openDeletedCourses = async function () {
    if (!isCourseAdmin()) return;
    const { el, body } = dialog('Deleted Courses');
    const empty = `No course was deleted in the last ${KEEP_DAYS} days.`;
    const { data, error } = await sb.rpc('bin_courses');
    if (!el.classList.contains('open')) return;
    if (error) { body.innerHTML = failed(error); return; }
    const entries = new Map((data || []).map(c => [`${c.sheet_name}|${c.is_archive}|${c.batch}`, c]));
    const nameOf = c => [c.code, c.title].filter(Boolean).join(' ') || c.sheet_name;
    body.innerHTML = entries.size ? `<div class="bin-list" role="list">${[...entries].map(([key, c]) => rowHtml(key, {
      icon: 'fa-solid fa-book', name: nameOf(c),
      sub: [[c.semester, c.year].filter(Boolean).join(' '), c.is_archive && 'archived', c.exams && count(c.exams, 'exam', 'exams'),
        c.students && count(c.students, 'student or exam code', 'students and exam codes')].filter(Boolean).join(', ') || c.sheet_name,
    }, c.deleted_at, byWhom(c.deleted_by), c.exists ? { disabled: true, title: `A course named ${c.sheet_name} exists now` } : {})).join('')}</div>` : emptyHtml(empty);
    body.onclick = async e => {
      const btn = e.target.closest('[data-bin-restore]');
      const c = btn && entries.get(btn.dataset.binRestore);
      if (!c) return;
      const result = await restoring(btn, async () => {
        const { data: out, error: err } = await sb.rpc('bin_restore_course', { p_name: c.sheet_name, p_archive: c.is_archive, p_batch: c.batch });
        if (err) throw err;
        return out;
      });
      if (!result) return;
      toast(result.kept ? `${nameOf(c)} restored, but ${count(result.kept, 'item', 'items')} could not go back` : `${nameOf(c)} restored`, result.kept ? 'err' : 'ok');
      entries.delete(btn.dataset.binRestore);
      removeRow(body, btn.dataset.binRestore, empty);
      // Back in the sidebar, with its lecturers' access.
      try { if (typeof refreshTeachingAccess === 'function') await refreshTeachingAccess(); } catch { }
      if (typeof loadSidebar === 'function') loadSidebar();
    };
  };
})();
