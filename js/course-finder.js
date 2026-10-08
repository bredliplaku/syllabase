// Course finder on the signed-out page: every lecturer's courses, each opened on the
// lecturer's own page (/bplaku/#CE_121).
// - Homepage: starts open; its open state and filters are remembered.
// - ?admin (also a lecturer website's): starts closed with its own open state; filters
//   are not saved. A lecturer website starts on its lecturer.
(function () {
  'use strict';

  const root = document.getElementById('course-finder');
  if (!root) return;
  const screen = document.getElementById('login-screen');
  const adminPage = !!window.TEACHING_EMBEDDED_ADMIN || new URLSearchParams(location.search).has('admin');
  const site = window.TEACHING_SITE || null;
  // Shown before the login screen appears, so loading never moves the sign-in button.
  root.hidden = false;
  screen.classList.add(adminPage ? 'is-admin' : 'is-home');
  // Signing in is what ?admin is for: its button goes above the list, not below.
  if (adminPage) root.before(document.getElementById('signin-action'));

  const OPEN_KEY = adminPage ? 'course_finder_open_admin' : 'course_finder_open';
  const FILTERS_KEY = 'course_finder_filters';
  // A row names up to this many lecturers; beyond it, the first ones and "+N more".
  const LECTURERS_SHOWN = 3;
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
  function courseColour(course) {
    const colour = String(course.theme_colours || '').split(',')[0].trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour) ? colour : '';
  }
  const avatar = person => userAvatar(stripTitles(person.name), person.photo, 'finder-avatar');

  // ── Open and closed ──
  function setOpen(open, remember = true) {
    root.classList.toggle('is-open', open);
    screen.classList.toggle('finder-open', open);
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
    }, 280);
  });

  const openState = stored.get(OPEN_KEY);
  if (openState === null ? !adminPage : openState === '1') {
    root.classList.add('finder-instant');
    setOpen(true, false);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('finder-instant')));
  }

  // ── Data ──
  async function load() {
    const directory = await TeachingSites.directory();
    // The lecturer website this admin belongs to opens its courses on itself.
    const pages = new Map(directory.lecturers.map(person => ({
      id: person.id, name: person.name || person.slug, photo: person.photo || '',
      url: person.id === site?.id ? TeachingSites.sitePage(site) : person.url
    })).filter(person => person.url).map(person => [person.id, person]));
    // Courses without a published lecturer page have nowhere to open.
    courses = directory.courses.map(course => {
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
      ? `${plural(current, 'current course')}, ${plural(people, 'lecturer')}`
      : `${plural(courses.length, 'past course')}, ${plural(people, 'lecturer')}`;
    chooseFilters();
    results.removeAttribute('aria-busy');
    render();
  }

  function hide() {
    root.hidden = true;
    screen.classList.remove('finder-open');
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

  // A lecturer website's admin starts on its lecturer; the homepage returns to its last
  // filters while they still match a course. Otherwise: current courses, or past ones
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

  const faces = course => `<span class="finder-faces">${course.lecturers.slice(0, LECTURERS_SHOWN)
    .map(person => userAvatar(stripTitles(person.name), person.photo, 'finder-avatar finder-face')).join('')}</span>`;
  function lecturerNames(course) {
    const people = course.lecturers;
    if (people.length === 1) return x(people[0].name);
    const link = person => `<a href="${x(TeachingSites.courseLink(person.url, course.sheet_name, course.is_archive))}">${x(person.name)}</a>`;
    if (people.length <= LECTURERS_SHOWN) return people.map(link).join(', ');
    const rest = people.slice(LECTURERS_SHOWN - 1);
    return people.slice(0, LECTURERS_SHOWN - 1).map(link).join(', ') +
      `, <span class="finder-row-more" title="${x(rest.map(person => person.name).join(', '))}">+${rest.length} more</span>`;
  }

  function row(course) {
    const code = course.code || course.sheet_name;
    const title = course.title && course.title !== code ? course.title : '';
    // Every lecturer's page shows the same course; prefer the one being filtered by.
    const primary = course.lecturers.find(person => person.id === lecturer) || course.lecturers[0];
    const colour = courseColour(course);
    return `<div class="finder-row"${colour ? ` style="--course:${colour}"` : ''}>
      <span class="finder-row-icon" aria-hidden="true"><i class="${x(course.icon || 'fa-solid fa-graduation-cap')}"></i></span>
      <a class="finder-row-code" href="${x(TeachingSites.courseLink(primary.url, course.sheet_name, course.is_archive))}"
        aria-label="${x([code, title].filter(Boolean).join(' '))}">${x(code)}</a>
      <span class="finder-row-title">${x(title)}</span>
      <span class="finder-row-people">${faces(course)}<span class="finder-row-names">${lecturerNames(course)}</span></span>
      <span class="finder-row-go" aria-hidden="true"><i class="fa-solid fa-arrow-right"></i></span>
    </div>`;
  }

  function render() {
    renderTerms();
    renderLecturers();
    const visible = visibleCourses();
    // Grouped under their term, newest first (the courses are already in that order).
    const terms = new Map();
    for (const course of visible) {
      const key = `${course.is_archive}|${course.term}`;
      if (!terms.has(key)) terms.set(key, { term: course.term || 'Other', past: course.is_archive, courses: [] });
      terms.get(key).courses.push(course);
    }
    results.innerHTML = [...terms.values()].map(group =>
      `<h3 class="finder-term-row"><span>${x(group.term)}${group.past && filter === 'all' ? ' (past)' : ''}</span>` +
      `<span class="finder-term-count">${plural(group.courses.length, 'course')}</span></h3>` +
      group.courses.map(row).join('')).join('');
    results.hidden = !visible.length;
    // Room for the most photos in a row, so every row's names start in line.
    results.style.setProperty('--faces', String(Math.max(1, ...visible.map(course => Math.min(course.lecturers.length, LECTURERS_SHOWN)))));

    const tabTotal = courses.filter(inTab).length;
    const empty = document.getElementById('finder-empty');
    empty.hidden = visible.length > 0;
    empty.querySelector('span').textContent = tabTotal ? 'No courses match.' :
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
  const search = document.getElementById('finder-search');
  search.addEventListener('input', event => { query = event.target.value; rerender(); });
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const links = results.querySelectorAll('.finder-row-code');
    if (links.length === 1) links[0].click();
  });
  // "/" jumps to the search while the list is open.
  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || !root.classList.contains('is-open')) return;
    if (event.target.closest?.('input, select, textarea, [contenteditable]') || !screen.getClientRects().length) return;
    event.preventDefault();
    search.focus();
  });
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
    search.value = '';
    refilter();
  });

  // Called when the login screen appears, so signed-in visits never load the list.
  window.showCourseFinder = function () {
    if (started) return;
    started = true;
    load().catch(error => { console.error('Course finder:', error); hide(); });
  };
})();
