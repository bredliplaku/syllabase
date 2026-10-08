// Permanent entry point for lecturer websites. The same index, styles and scripts
// served by the central teaching application are mounted at the caller's URL.
(function () {
    'use strict';
    if (window.__teachingLoaderStarted) return;
    window.__teachingLoaderStarted = true;
    const entry = document.currentScript;
    const appBase = new URL('./', entry.src);
    const fallback = entry.hasAttribute('data-teaching-fallback');
    const lecturerId = entry.getAttribute('data-teaching-lecturer');
    const adminMode = new URLSearchParams(location.search).has('admin');
    // Preserve the host's full icon set and manifest, resolving paths before mounting.
    const iconLinks = 'link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]';
    const uploadedIcons = [...document.querySelectorAll(iconLinks)].map(link => {
        const copy = link.cloneNode(true);
        copy.href = link.href;
        return copy;
    });
    if (!uploadedIcons.some(link => link.relList.contains('icon'))) {
        const fallbackIcon = document.createElement('link');
        fallbackIcon.rel = 'icon';
        fallbackIcon.href = new URL('/favicon.ico', location.origin).href;
        uploadedIcons.push(fallbackIcon);
    }
    let startupTheme;
    let mounted = false;

    function prepareTheme() {
        const root = document.documentElement;
        let theme = 'auto';
        try { theme = localStorage.getItem('theme-preference') || 'auto'; } catch { }
        if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
        else root.removeAttribute('data-theme');
        root.style.setProperty('--teaching-start-light', adminMode ? '#f4f4f4' : '#ffffff');
        startupTheme = document.getElementById('teaching-startup-theme');
        // Older downloads get the same background as soon as this loader arrives.
        if (!startupTheme) {
            startupTheme = document.createElement('style');
            startupTheme.id = 'teaching-startup-theme';
            startupTheme.textContent = `
                html { color-scheme: light; background: var(--teaching-start-light, #fff); color: #333; }
                html[data-theme="dark"] { color-scheme: dark; background: #000; color: #e0e0e0; }
                @media (prefers-color-scheme: dark) {
                    html:not([data-theme="light"]) { color-scheme: dark; background: #000; color: #e0e0e0; }
                }
                body { margin: 0; background: inherit; }
            `;
            document.head.appendChild(startupTheme);
        }
        const oldStatus = document.querySelector('body > p[role="status"]');
        if (oldStatus?.textContent.trim() === 'Loading courses…') oldStatus.remove();
    }

    // Do this before requesting config or course data. A 404 fallback must leave
    // unrelated pages alone until its address has resolved to a teaching site.
    if (!fallback) prepareTheme();

    function loadScript(src, attributes = {}, ordered = true) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
            script.async = !ordered;
            const timeout = setTimeout(() => {
                script.remove(); reject(new Error('A teaching resource took too long to load.'));
            }, 20000);
            script.onload = () => { clearTimeout(timeout); resolve(); };
            script.onerror = () => { clearTimeout(timeout); reject(new Error('A teaching resource could not load.')); };
            script.src = src;
            document.head.appendChild(script);
        });
    }

    // The Font Awesome kit only loads on domains allowed in its settings. Elsewhere, use
    // the same free SVG icons and v4 names from jsDelivr (@7: latest 7.x, like the kit).
    const ICON_FALLBACK = 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@7/js/';
    function loadIconFallback() {
        const attributes = { crossorigin: 'anonymous' };
        loadScript(ICON_FALLBACK + 'all.min.js', attributes, false)
            .then(() => loadScript(ICON_FALLBACK + 'v4-shims.min.js', attributes, false))
            .catch(error => console.warn('Teaching loader: icons unavailable.', error));
    }

    let failed = false;
    function showError(message) {
        failed = true; // A page still loading is not shown over the message.
        if (fallback && !mounted) return; // Leave unrelated 404 pages untouched.
        document.body.className = '';
        const main = document.createElement('main');
        main.style.cssText = 'max-width:40rem;margin:12vh auto;padding:24px;font:16px/1.6 system-ui';
        const title = document.createElement('h1'); title.textContent = adminMode ? 'Admin unavailable' : 'Courses unavailable';
        title.style.color = 'inherit';
        const detail = document.createElement('p'); detail.textContent = message;
        const retry = document.createElement('button'); retry.textContent = 'Try again';
        retry.onclick = () => location.reload();
        main.append(title, detail, retry);
        document.body.replaceChildren(main);
    }

    // The page, its styles and its loading skeleton depend only on ?admin, not on whose
    // website this is, so they load alongside that lookup and the page appears as soon
    // as they arrive, its skeleton up until its scripts take over. Returns those scripts.
    async function showPage() {
        if (fallback) prepareTheme();
        // The admin is the app's root index; the public course page lives in courses/.
        const pageBase = new URL(adminMode ? './' : 'courses/', appBase);
        const response = await fetch(new URL('index.html', pageBase), {
            credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error('The teaching page could not load.');
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const scripts = [...page.querySelectorAll('script[src]')].map(script => ({
            src: new URL(script.getAttribute('src'), pageBase).href,
            crossorigin: script.getAttribute('crossorigin')
        })).filter(script => !['js/config.js', 'js/sites.js', 'js/skeleton.js'].some(path => script.src === new URL(path, appBase).href));
        // Inline scripts in the central document normalise its own path/theme.
        // Do not run its redirect on a lecturer's nested URL.
        page.querySelectorAll('script, base, #teaching-startup-theme').forEach(node => node.remove());
        page.querySelectorAll('link[href], img[src], source[src]').forEach(node => {
            const attr = node.hasAttribute('href') ? 'href' : 'src';
            node.setAttribute(attr, new URL(node.getAttribute(attr), pageBase).href);
        });
        // Remove before mounting so the cat never flashes on lecturer websites.
        page.getElementById('cat-companion')?.remove();
        page.querySelectorAll(iconLinks).forEach(link => link.remove());
        page.head.append(...uploadedIcons);
        // Downloaded now, so they run without delay, in order, once the lecturer is known.
        for (const script of scripts) {
            const preload = document.createElement('link');
            preload.rel = 'preload';
            preload.as = 'script';
            preload.href = script.src;
            if (script.crossorigin !== null) preload.crossOrigin = script.crossorigin;
            page.head.append(preload);
        }
        const forcedTheme = document.documentElement.dataset.theme;
        const dark = forcedTheme === 'dark' || (forcedTheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        const themeColor = page.querySelector('meta[name="theme-color"]');
        if (themeColor) themeColor.content = dark ? '#000000' : adminMode ? '#f4f4f4' : '#ffffff';
        document.documentElement.lang = page.documentElement.lang || 'en';

        const styles = [...page.querySelectorAll('link[rel="stylesheet"]')];
        const loadedStyles = styles.map(link => new Promise((resolve, reject) => {
            const required = new URL(link.href).origin === appBase.origin;
            const fail = () => required ? reject(new Error('The teaching styles could not load.')) : resolve();
            const timeout = setTimeout(fail, 20000);
            link.onload = () => { clearTimeout(timeout); resolve(); };
            link.onerror = () => { clearTimeout(timeout); fail(); };
        }));
        // Keep the initial background while styles download. Replacing the entire
        // head without this briefly restores the browser's default white canvas. Scripts
        // stay: config.js and sites.js may still be loading.
        document.head.replaceChildren(startupTheme, ...document.head.querySelectorAll('script'), ...page.head.childNodes);
        // Chooses the loading skeleton (signed in or out, the course's colour) before the
        // page appears, as the central page does from its <head>. A lecturer's id keys
        // their own sign-in.
        const skeleton = loadScript(new URL('js/skeleton.js', appBase).href, {
            'data-page': adminMode ? 'admin' : 'course', 'data-embedded': '',
            ...(lecturerId ? { 'data-site': lecturerId } : {})
        }).catch(() => { });
        await Promise.all(loadedStyles);
        // Never holds the page up: at most a moment longer than the styles.
        await Promise.race([skeleton, new Promise(resolve => setTimeout(resolve, 1000))]);
        if (failed) return scripts;
        // This is a complete page, not a widget inside the host website's layout.
        mounted = true;
        document.body.className = page.body.className;
        document.body.replaceChildren(...page.body.childNodes);
        startupTheme.remove();
        return scripts;
    }

    // Which lecturer's website this is.
    async function findSite() {
        await loadScript(new URL('js/config.js', appBase).href);
        await loadScript(new URL('js/sites.js', appBase).href);
        if (lecturerId) {
            const site = await window.TeachingSites.rpc('teaching_resolve_lecturer', { p_id: lecturerId });
            if (site) site.base_path = window.TeachingSites.currentDirectory();
            return site;
        }
        // Older generic files and the optional 404 snippet use saved addresses.
        return window.TeachingSites.rpc('teaching_resolve_site', {
            p_hostname: location.hostname, p_path: window.TeachingSites.normalizePath(location.pathname)
        });
    }

    // Once the lecturer is known: the host website's links, then the page's scripts.
    async function finishPage(scripts, site) {
        // Navigation belongs to the host website; copyright stays with the app. Back leads
        // to its course page, and is left out where that is the root, as Home goes there.
        const coursePage = window.TeachingSites.sitePage(site);
        const rootPage = new URL('/', location.origin).href;
        document.querySelectorAll('#footer-back, #signin-back').forEach(back => {
            back.href = coursePage;
            back.hidden = back.id === 'footer-back' && coursePage === rootPage;
        });
        const home = document.getElementById('footer-home');
        if (home) { home.href = rootPage; home.hidden = false; }
        const signIn = document.getElementById('footer-admin');
        if (signIn) signIn.href = window.TeachingSites.adminUrl(site);
        const owner = window.TEACHING_CONFIG.owner || {};
        const name = document.getElementById('footer-owner');
        if (name && owner.name) name.textContent = owner.name;
        const startYear = document.getElementById('footer-start-year');
        if (startYear && owner.startYear) startYear.textContent = owner.startYear;
        const currentYear = document.getElementById('currentYear');
        if (currentYear) currentYear.textContent = new Date().getFullYear();
        window.TEACHING_SITE = site;
        window.TEACHING_EMBEDDED_ADMIN = adminMode;
        window.TEACHING_CONFIG.catCompanion = false;
        window.TEACHING_CONFIG.owner = {
            ...owner, homeUrl: '/'
        };
        // Preserve dependency order. Page controllers start immediately if DOMContentLoaded
        // has already fired, which is the normal case for this asynchronous loader.
        for (const script of scripts) {
            const loading = loadScript(script.src, script.crossorigin ? { crossorigin: script.crossorigin } : {});
            await (new URL(script.src).hostname === 'kit.fontawesome.com' ? loading.catch(loadIconFallback) : loading);
        }
    }

    async function start() {
        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }
        try {
            if (lecturerId && !['https:', 'http:'].includes(location.protocol)) {
                showError('Upload this file to a website to view its courses.'); return;
            }
            if (adminMode && !window.isSecureContext) {
                showError('Open this admin page over HTTPS to sign in.'); return;
            }
            // A 404 fallback leaves unrelated pages alone until its address resolves.
            const shown = fallback ? null : showPage();
            shown?.catch(() => { }); // Reported below, once the lookup is done.
            const site = await findSite();
            if (!site) { showError('This lecturer’s courses are not available.'); return; }
            await finishPage(await (shown || showPage()), site);
        } catch (error) {
            console.error('Teaching loader:', error);
            showError('Please try again shortly.');
        }
    }
    start();
})();
