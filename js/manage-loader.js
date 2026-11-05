// Mounts another page of this site at this address, as embed.js does on lecturer websites, so
// each page's markup lives in one file only. data-page names which:
// - syllatest (exam/manage/, the default): the course editor's own page (the site's index.html)
//   in Syllatest mode: only the Exams, Grading and Students tabs (js/course-editor.js),
//   Syllatest's name, and a sign-in that goes through the exam page.
// - timetable (/timetable/?manage): the timetable's panel, timetable/manage.html. The public
//   timetable's index.html runs this, and reads the rest of itself as hidden text.
// The mounted page's inline scripts are left out; its stylesheets and scripts load in its order.
(function () {
  'use strict';
  const loader = document.currentScript;
  const siteRoot = new URL('../', loader.src); // the site's root, beside js/
  const studentPage = new URL('../', location.href); // Syllatest's: /exam/

  const PAGES = {
    syllatest: {
      src: new URL('index.html', siteRoot),
      name: 'Syllatest',
      // Not needed here: the homepage's course list, One Tap and the Drive picker (the tabs
      // that use Drive are not shown).
      skip: [/\/js\/course-finder\.js$/, /accounts\.google\.com\/gsi\//, /apis\.google\.com\/js\/api\.js/],
      prepare: page => { makeSyllatest(page); window.TEACHING_SYLLATEST = true; },
      ownTitle: true, // this page's title, not the editor's
    },
    timetable: {
      src: new URL('manage.html', location.href),
      name: 'The timetable panel',
      skip: [],
      prepare: null,
      ownTitle: false,
    },
  };
  const config = PAGES[loader.dataset.page] || PAGES.syllatest;
  const base = config.src; // the mounted page's relative addresses are its own

  function showError() {
    const main = document.createElement('main');
    main.style.cssText = 'max-width:40rem;margin:12vh auto;padding:24px;font:16px/1.6 system-ui';
    main.innerHTML = `<h1 style="color:inherit">${config.name} is unavailable</h1><p>Please try again shortly.</p>`;
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.onclick = () => location.reload();
    main.append(retry);
    bodyElement().replaceChildren(main);
  }

  // The page's <body> (made if a page has none).
  function bodyElement() {
    if (!document.body) document.documentElement.append(document.createElement('body'));
    return document.body;
  }

  // The site's own scripts must load; another site's (icons, libraries) failing only warns.
  function loadScript(src, attributes = {}) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
      script.async = false; // run in the page's order, downloaded side by side
      script.onload = resolve;
      script.onerror = () => {
        if (new URL(src).origin === siteRoot.origin) reject(new Error(`${src} could not load`));
        else { console.warn(`${config.name}: ${src} could not load.`); resolve(); }
      };
      script.src = src;
      document.head.appendChild(script);
    });
  }

  // What makes the editor's page Syllatest's: its name, and a sign-in card for lecturers in
  // place of the homepage's course list.
  function makeSyllatest(page) {
    page.getElementById('course-finder')?.remove();
    page.querySelector('.signin-link')?.remove();
    const title = page.querySelector('.signin-title');
    if (title) title.textContent = 'Syllatest';
    const tagline = page.querySelector('.signin-tagline');
    if (tagline) tagline.textContent = 'For lecturers: your courses’ exams, grading and students';
    const back = page.getElementById('signin-back');
    if (back) {
      back.href = studentPage.href;
      back.hidden = false;
      back.lastChild.textContent = 'Syllatest for students';
    }
    const topTitle = page.querySelector('#admin-app .top-bar-title');
    if (topTitle) topTitle.innerHTML = '<i class="fa-solid fa-clipboard-question syllatest-logo" aria-hidden="true"></i><span class="top-bar-title-text">Syllatest</span>';
    const empty = page.querySelector('.no-course p');
    if (empty) empty.textContent = 'Choose a course from the list to manage its exams.';
    // Signed in without teaching access (a student): "No Access", and the way to their exams.
    const refused = page.querySelector('#error-screen .error-card');
    if (refused) {
      refused.querySelector('h2').textContent = 'No Access';
      // A button like Sign out beside it (the site's buttons are <button>s).
      const link = page.createElement('button');
      link.type = 'button';
      link.className = 'btn-secondary error-student-link';
      link.dataset.href = studentPage.href;
      link.setAttribute('onclick', 'location.href = this.dataset.href');
      link.innerHTML = '<i class="fa-solid fa-arrow-left" style="margin-right:6px" aria-hidden="true"></i>Syllatest for students';
      refused.querySelector('button')?.before(link);
    }
  }

  // A script's data-* and crossorigin attributes, as the mounted page gives them.
  function attributesOf(script) {
    const attributes = Object.fromEntries(Object.entries(script.data).map(([key, value]) =>
      [`data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value]));
    if (script.crossorigin !== null) attributes.crossorigin = script.crossorigin;
    return attributes;
  }

  async function mount() {
    const response = await fetch(config.src, { credentials: 'omit', cache: 'no-cache' });
    if (!response.ok) throw new Error(`${config.src} could not load.`);
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const scripts = [...page.querySelectorAll('script[src]')]
      .map(script => ({ src: new URL(script.getAttribute('src'), base).href, data: { ...script.dataset },
        crossorigin: script.getAttribute('crossorigin') }))
      .filter(script => !config.skip.some(re => re.test(script.src)));
    page.querySelectorAll('script').forEach(node => node.remove());
    page.querySelectorAll('link[href], img[src], source[src], a[href]').forEach(node => {
      const attr = node.hasAttribute('href') ? 'href' : 'src';
      const value = node.getAttribute(attr);
      if (/^(#|\?|[a-z]+:|\/\/)/i.test(value)) return;
      node.setAttribute(attr, new URL(value, base).href);
    });
    config.prepare?.(page);
    if (!config.ownTitle && page.title) document.title = page.title;

    // Its styles (not its icons or theme colour: this page's own), loaded before the page
    // shows, so it never appears unstyled.
    const styles = [...page.head.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"]')];
    const loaded = styles.filter(link => link.rel === 'stylesheet').map(link => new Promise(resolve => {
      link.onload = link.onerror = resolve;
      setTimeout(resolve, 15000);
    }));
    document.head.append(...styles);
    // The loading skeleton first, as the page runs it from its <head>.
    const skeleton = scripts.find(script => /\/js\/skeleton\.js$/.test(script.src));
    const skeletonRun = skeleton ? loadScript(skeleton.src, attributesOf(skeleton)).catch(() => { }) : Promise.resolve();
    await Promise.all(loaded);
    await Promise.race([skeletonRun, new Promise(resolve => setTimeout(resolve, 1000))]);
    const body = bodyElement();
    body.className = page.body.className;
    body.replaceChildren(...page.body.childNodes);
    document.getElementById('teaching-startup-theme')?.remove();
    // Then its scripts, in their order. The page starts at once (the document has loaded).
    await Promise.all(scripts.filter(script => script !== skeleton).map(script => loadScript(script.src, attributesOf(script))));
  }

  function start() {
    mount().catch(error => {
      console.error(`${config.name}:`, error);
      showError();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
