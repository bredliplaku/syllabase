// Course finder on the signed-out page: every lecturer's courses, each opened on the
// lecturer's own page (/bplaku/#CE_121).
// - Homepage: the list starts open, and its open state and filters are remembered.
// - ?admin, including a lecturer website's admin (which loads this same page): the
//   list starts closed with its own remembered open state, and filters are not saved,
//   so the homepage's stay as they were. A lecturer website starts on its lecturer.
(function () {
  'use strict';

  const root = document.getElementById('course-finder');
  if (!root) return;
  const adminPage = !!window.TEACHING_EMBEDDED_ADMIN || new URLSearchParams(location.search).has('admin');
  const site = window.TEACHING_SITE || null;
  // Shown before the login screen appears, so loading never moves the sign-in button.
  root.hidden = false;
  document.getElementById('login-screen').classList.add(adminPage ? 'is-admin' : 'is-home');
  // Signing in is what ?admin is for: its button goes above the list, not below.
  if (adminPage) root.before(document.getElementById('signin-action'));

  const OPEN_KEY = adminPage ? 'course_finder_open_admin' : 'course_finder_open';
  const FILTERS_KEY = 'course_finder_filters';
  const stored = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { } }
  };
  const toggle = document.getElementById('finder-toggle');
  const results = document.getElementById('finder-results');
  const termSelect = document.getElementById('finder-term');
  let courses = [], started = false;
  let query = '', filter = 'active', term = '', lecturer = '';

  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  // Accents are optional when searching: "gjergj" finds "Gjergj", "e" finds "ë".
  const fold = text => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  function semesterName(course) {
    const value = String(course.semester || '').trim();
    const match = value.match(/\b(Fall|Spring|Summer)\b/i);
    return match ? match[1][0].toUpperCase() + match[1].slice(1).toLowerCase() : value;
  }
  function yearName(course) {
    const value = String(course.year || '').trim();
    const years = value.match(/(\d{4})\D*(\d{4})?/);
    return years ? (years[2] ? `${years[1]}–${years[2]}` : years[1]) : value;
  }
  const courseTerm = course => [semesterName(course), yearName(course)].filter(Boolean).join(' ');
  // The course's own primary colour, the first of its theme_colours.
  function courseColour(course) {
    const colour = String(course.theme_colours || '').split(',')[0].trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour) ? colour : '';
  }
  const avatar = person => userAvatar(stripTitles(person.name), person.photo, 'finder-avatar');

  // ── Open and closed ──
  function setOpen(open, remember = true) {
    root.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (remember) stored.set(OPEN_KEY, open ? '1' : '0');
  }

  toggle.addEventListener('click', () => {
    const open = !root.classList.contains('is-open');
    setOpen(open);
    // On a short screen the list opens below the fold: bring it up once it has opened.
    if (open) setTimeout(() => {
      if (toggle.getBoundingClientRect().bottom > window.innerHeight * 0.7) {
        const motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        root.scrollIntoView({ behavior: motion, block: 'start' });
      }
    }, 320);
  });

  const openState = stored.get(OPEN_KEY);
  if (openState === null ? !adminPage : openState === '1') {
    root.classList.add('finder-instant');
    setOpen(true, false);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('finder-instant')));
  }

  // ── Data ──
  // A lecturer's saved website, or the folder named after their email handle
  // (bplaku@… → /bplaku/). A folder counts only when it holds their own website file.
  async function lecturerPage(person) {
    if (person.website) return person.website;
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(person.slug || '')) return null;
    const url = new URL(person.slug + '/', window.TEACHING_CONFIG.appBaseUrl);
    try {
      const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) });
      if (response.ok && (await response.text()).includes(`data-teaching-lecturer="${person.id}"`)) return url.href;
    } catch { }
    return null;
  }

  const courseUrl = (course, person) =>
    person.url + (course.is_archive ? '?archive' : '') + '#' + encodeURIComponent(course.sheet_name);

  async function load() {
    const directory = await TeachingSites.rpc('teaching_directory', {});
    // The lecturer website this admin belongs to opens its courses on itself.
    const found = await Promise.all((directory?.lecturers || []).map(async person => ({
      id: person.id, name: person.name || person.slug, photo: person.photo || '',
      url: person.id === site?.id ? new URL(site.base_path, location.origin).href : await lecturerPage(person)
    })));
    const pages = new Map(found.filter(person => person.url).map(person => [person.id, person]));
    // Courses without a published lecturer page have nowhere to open.
    courses = (directory?.courses || []).map(course => {
      const people = (course.lecturers || []).map(id => pages.get(id)).filter(Boolean)
        .sort((a, b) => TeachingSites.compareLecturers(a.name, b.name));
      const text = [course.code, course.title, course.sheet_name, course.semester, course.year, courseTerm(course),
        ...people.map(person => person.name)].join(' ');
      return { ...course, icon: course.header_decoration, term: courseTerm(course), lecturers: people, search: fold(text) };
    }).filter(course => course.lecturers.length).sort(courseOrder);
    if (!courses.length) { hide(); return; }
    const current = courses.filter(course => !course.is_archive).length;
    const people = new Set(courses.flatMap(course => course.lecturers.map(person => person.id))).size;
    document.getElementById('finder-summary').textContent = current
      ? `${plural(current, 'current course')} · ${plural(people, 'lecturer')}`
      : `${plural(courses.length, 'past course')} · ${plural(people, 'lecturer')}`;
    chooseFilters();
    results.removeAttribute('aria-busy');
    render();
  }

  // A lecturer website's admin starts on its lecturer; the homepage returns to its last
  // filters, where they still match a course. Otherwise: current courses, or past ones
  // when there are none.
  function chooseFilters() {
    const offered = person => courses.some(course => course.lecturers.some(p => p.id === person));
    if (site && offered(site.id)) lecturer = site.id;
    else if (!adminPage) {
      let saved = {};
      try { saved = JSON.parse(stored.get(FILTERS_KEY)) || {}; } catch { }
      if (['active', 'archived', 'all'].includes(saved.filter)) filter = saved.filter;
      if (saved.lecturer && offered(saved.lecturer)) lecturer = saved.lecturer;
      if (saved.term && courses.some(course => inTab(course) && hasLecturer(course) && course.term === saved.term)) term = saved.term;
      if (courses.some(course => inTab(course) && hasLecturer(course))) return;
    }
    filter = courses.some(course => !course.is_archive && hasLecturer(course)) ? 'active' : 'archived';
    term = '';
  }

  function saveFilters() {
    if (!adminPage) stored.set(FILTERS_KEY, JSON.stringify({ filter, term, lecturer }));
  }

  function hide() {
    root.hidden = true;
  }

  // ── Filtering ──
  const inTab = course => filter === 'all' || course.is_archive === (filter === 'archived');
  const hasLecturer = course => !lecturer || course.lecturers.some(person => person.id === lecturer);
  const inTerm = course => !term || course.term === term;
  function visibleCourses() {
    const words = fold(query).trim().split(/\s+/);
    return courses.filter(course => inTab(course) && inTerm(course) && hasLecturer(course) &&
      words.every(word => course.search.includes(word)));
  }

  // The term list follows the tab and lecturer; it appears once there is a choice.
  function renderTerms() {
    const terms = [...new Set(courses.filter(course => inTab(course) && hasLecturer(course))
      .map(course => course.term).filter(Boolean))];
    if (term && !terms.includes(term)) terms.push(term);
    termSelect.innerHTML = `<option value="">All terms</option>` +
      terms.map(value => `<option value="${x(value)}"${value === term ? ' selected' : ''}>${x(value)}</option>`).join('');
    termSelect.closest('.finder-term').hidden = terms.length < 2 && !term;
  }

  // Lecturer chips follow the tab and term; they appear once there is a choice.
  function renderLecturers() {
    const container = document.getElementById('finder-lecturers');
    const people = new Map();
    for (const course of courses.filter(course => inTab(course) && inTerm(course))) {
      for (const person of course.lecturers) people.set(person.id, person);
    }
    if (lecturer && !people.has(lecturer)) {
      const chosen = courses.flatMap(course => course.lecturers).find(person => person.id === lecturer);
      if (chosen) people.set(lecturer, chosen);
    }
    container.hidden = people.size < 2 && !lecturer;
    const list = [...people.values()].sort((a, b) => TeachingSites.compareLecturers(a.name, b.name));
    container.innerHTML = `<button type="button" class="finder-chip finder-chip-all" data-lecturer="" aria-pressed="${!lecturer}">Everyone</button>` +
      list.map(person => `<button type="button" class="finder-chip" data-lecturer="${x(person.id)}" title="${x(person.name)}"
        aria-pressed="${person.id === lecturer}">${avatar(person)}${x(stripTitles(person.name))}</button>`).join('');
  }

  function card(course) {
    const code = course.code || course.sheet_name;
    const title = course.title && course.title !== code ? course.title : '';
    // Every lecturer's page shows the same course; prefer the one being filtered by.
    const primary = course.lecturers.find(person => person.id === lecturer) || course.lecturers[0];
    const names = course.lecturers.length > 1
      ? course.lecturers.map(person => `<a href="${x(courseUrl(course, person))}">${x(person.name)}</a>`).join(', ')
      : x(primary.name);
    const colour = courseColour(course);
    return `<li class="finder-card"${colour ? ` style="--course:${colour}"` : ''}>
      <span class="finder-card-icon" aria-hidden="true"><i class="${x(course.icon || 'fa-solid fa-graduation-cap')}"></i></span>
      <span class="finder-card-text">
        <a class="finder-card-link" href="${x(courseUrl(course, primary))}">
          ${title ? `<span class="finder-card-code">${x(code)}</span>` : ''}
          <span class="finder-card-title">${x(title || code)}</span></a>
        <span class="finder-card-people"><span class="finder-avatars">${course.lecturers.slice(0, 3).map(avatar).join('')}</span>
          <span class="finder-card-names">${names}</span></span>
      </span>
      <i class="fa-solid fa-arrow-right finder-card-arrow" aria-hidden="true"></i>
    </li>`;
  }

  function render() {
    renderTerms();
    renderLecturers();
    const visible = visibleCourses();
    // Grouped under their term, newest first (the courses are already in that order).
    const groups = new Map();
    for (const course of visible) {
      const key = `${course.is_archive}|${course.term}`;
      if (!groups.has(key)) groups.set(key, { term: course.term || 'Other', past: course.is_archive, courses: [] });
      groups.get(key).courses.push(course);
    }
    results.innerHTML = [...groups.values()].map(group => `<section class="finder-group">
      <h3 class="finder-group-title">${x(group.term)}${group.past && filter === 'all' ? '<span class="finder-group-tag">Past</span>' : ''}</h3>
      <ul class="finder-grid">${group.courses.map(card).join('')}</ul></section>`).join('');

    const tabTotal = courses.filter(inTab).length;
    const empty = document.getElementById('finder-empty');
    empty.hidden = visible.length > 0;
    empty.querySelector('p').textContent = tabTotal ? 'No courses match.' :
      filter === 'archived' ? 'No past courses yet.' : 'No current courses yet.';
    document.getElementById('finder-reset').hidden = !tabTotal;
    document.getElementById('finder-status').textContent = plural(visible.length, 'course');

    const counts = { active: courses.filter(course => !course.is_archive).length, all: courses.length };
    counts.archived = counts.all - counts.active;
    root.querySelectorAll('[data-finder-filter]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.finderFilter === filter));
    });
    root.querySelectorAll('[data-filter-count]').forEach(label => { label.textContent = String(counts[label.dataset.filterCount]); });
  }

  // ── Events ──
  const rerender = () => { if (courses.length) render(); };
  // Search text is not remembered; the tab, term and lecturer are (homepage only).
  const refilter = () => { saveFilters(); rerender(); };
  document.getElementById('finder-search').addEventListener('input', event => { query = event.target.value; rerender(); });
  root.querySelectorAll('[data-finder-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.finderFilter; refilter();
  }));
  termSelect.addEventListener('change', () => { term = termSelect.value; refilter(); });
  document.getElementById('finder-lecturers').addEventListener('click', event => {
    const chip = event.target.closest('[data-lecturer]');
    if (!chip) return;
    lecturer = chip.dataset.lecturer === lecturer ? '' : chip.dataset.lecturer;
    refilter();
  });
  document.getElementById('finder-reset').addEventListener('click', () => {
    query = ''; term = ''; lecturer = '';
    document.getElementById('finder-search').value = '';
    refilter();
  });

  // Called when the login screen appears, so signed-in visits never load the list.
  window.showCourseFinder = function () {
    if (started) return;
    started = true;
    load().catch(error => { console.error('Course finder:', error); hide(); });
  };
})();
