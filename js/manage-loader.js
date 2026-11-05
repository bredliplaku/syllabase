// Syllatest for lecturers (exam/manage/): mounts the course editor's own page (the site's
// index.html) at this address, as embed.js does on lecturer websites, in Syllatest mode: only
// the Exams, Grading and Students tabs (js/course-editor.js), Syllatest's name, and a sign-in
// that goes through the exam page. The editor's markup lives in index.html alone, so a change
// there reaches this page too.
(function () {
  'use strict';
  const appBase = new URL('../', document.currentScript.src); // the site's root, beside js/
  const studentPage = new URL('../', location.href);           // /exam/
  // Not needed here: the homepage's course list, One Tap and the Drive picker (the tabs that
  // use Drive are not shown).
  const SKIP = [/\/js\/course-finder\.js$/, /accounts\.google\.com\/gsi\//, /apis\.google\.com\/js\/api\.js/];

  function showError() {
    const main = document.createElement('main');
    main.style.cssText = 'max-width:40rem;margin:12vh auto;padding:24px;font:16px/1.6 system-ui';
    main.innerHTML = '<h1 style="color:inherit">Syllatest is unavailable</h1><p>Please try again shortly.</p>';
    const retry = document.createElement('button');
    retry.textContent = 'Try again';
    retry.onclick = () => location.reload();
    main.append(retry);
    document.body.replaceChildren(main);
  }

  // The site's own scripts must load; another site's (icons, libraries) failing only warns.
  function loadScript(src, attributes = {}) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
      script.async = false; // run in the page's order, downloaded side by side
      script.onload = resolve;
      script.onerror = () => {
        if (new URL(src).origin === appBase.origin) reject(new Error(`${src} could not load`));
        else { console.warn(`Syllatest: ${src} could not load.`); resolve(); }
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
  }

  // A script's data-* and crossorigin attributes, as the editor's page gives them.
  function attributesOf(script) {
    const attributes = Object.fromEntries(Object.entries(script.data).map(([key, value]) =>
      [`data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value]));
    if (script.crossorigin !== null) attributes.crossorigin = script.crossorigin;
    return attributes;
  }

  async function mount() {
    const response = await fetch(new URL('index.html', appBase), { credentials: 'omit', cache: 'no-cache' });
    if (!response.ok) throw new Error('The editor could not load.');
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const scripts = [...page.querySelectorAll('script[src]')]
      .map(script => ({ src: new URL(script.getAttribute('src'), appBase).href, data: { ...script.dataset },
        crossorigin: script.getAttribute('crossorigin') }))
      .filter(script => !SKIP.some(re => re.test(script.src)));
    page.querySelectorAll('script').forEach(node => node.remove());
    // Its addresses are the site root's.
    page.querySelectorAll('link[href], img[src], source[src], a[href]').forEach(node => {
      const attr = node.hasAttribute('href') ? 'href' : 'src';
      const value = node.getAttribute(attr);
      if (/^(#|[a-z]+:|\/\/)/i.test(value)) return;
      node.setAttribute(attr, new URL(value, appBase).href);
    });
    makeSyllatest(page);
    window.TEACHING_SYLLATEST = true;

    // Its styles (not its title, icons or theme colour: this page's own), loaded before the
    // page shows, so it never appears unstyled.
    const styles = [...page.head.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"]')];
    const loaded = styles.filter(link => link.rel === 'stylesheet').map(link => new Promise(resolve => {
      link.onload = link.onerror = resolve;
      setTimeout(resolve, 15000);
    }));
    document.head.append(...styles);
    // The loading skeleton first, as the editor's page runs it from its <head>.
    const skeleton = scripts.find(script => /\/js\/skeleton\.js$/.test(script.src));
    const skeletonRun = skeleton ? loadScript(skeleton.src, attributesOf(skeleton)).catch(() => { }) : Promise.resolve();
    await Promise.all(loaded);
    await Promise.race([skeletonRun, new Promise(resolve => setTimeout(resolve, 1000))]);
    document.body.className = page.body.className;
    document.body.replaceChildren(...page.body.childNodes);
    document.getElementById('teaching-startup-theme')?.remove();
    // Then its scripts, in their order. The editor starts at once (the document has loaded).
    await Promise.all(scripts.filter(script => script !== skeleton).map(script => loadScript(script.src, attributesOf(script))));
  }

  function start() {
    mount().catch(error => {
      console.error('Syllatest:', error);
      showError();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
