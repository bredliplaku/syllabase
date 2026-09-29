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

    function loadScript(src, attributes = {}) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value));
            script.async = false;
            const timeout = setTimeout(() => {
                script.remove(); reject(new Error('A teaching resource took too long to load.'));
            }, 20000);
            script.onload = () => { clearTimeout(timeout); resolve(); };
            script.onerror = () => { clearTimeout(timeout); reject(new Error('A teaching resource could not load.')); };
            script.src = src;
            document.head.appendChild(script);
        });
    }

    function showError(message) {
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

    async function mount(site) {
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
        })).filter(script => !['js/config.js', 'js/sites.js'].some(path => script.src === new URL(path, appBase).href));
        // Inline scripts in the central document normalise its own path/theme.
        // Do not run its redirect on a lecturer's nested URL.
        page.querySelectorAll('script, base, #teaching-startup-theme').forEach(node => node.remove());
        page.querySelectorAll('link[href], img[src], source[src]').forEach(node => {
            const attr = node.hasAttribute('href') ? 'href' : 'src';
            node.setAttribute(attr, new URL(node.getAttribute(attr), pageBase).href);
        });
        // Navigation belongs to the host website; copyright stays with the app.
        // The admin's back links lead from ?admin to this website's own course page.
        // The central admin hides Home, being the root itself; here it leads to this
        // website's root. The footer's Back appears only when it leads somewhere else:
        // at website.com/?admin both would go to website.com, so only Home shows.
        const coursePage = window.TeachingSites.sitePage(site);
        const rootPage = new URL('/', location.origin).href;
        page.querySelectorAll('#footer-back, #signin-back').forEach(back => {
            back.href = coursePage;
            back.hidden = back.id === 'footer-back' && coursePage === rootPage;
        });
        const home = page.getElementById('footer-home');
        if (home) { home.href = rootPage; home.hidden = false; }
        const signIn = page.getElementById('footer-admin');
        if (signIn) signIn.href = window.TeachingSites.adminUrl(site);
        const owner = window.TEACHING_CONFIG.owner || {};
        const name = page.getElementById('footer-owner');
        if (name && owner.name) name.textContent = owner.name;
        const startYear = page.getElementById('footer-start-year');
        if (startYear && owner.startYear) startYear.textContent = owner.startYear;
        const currentYear = page.getElementById('currentYear');
        if (currentYear) currentYear.textContent = new Date().getFullYear();
        // Remove before mounting so the cat never flashes on lecturer websites.
        page.getElementById('cat-companion')?.remove();
        page.querySelectorAll(iconLinks).forEach(link => link.remove());
        page.head.append(...uploadedIcons);
        const forcedTheme = document.documentElement.dataset.theme;
        const dark = forcedTheme === 'dark' || (forcedTheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        const themeColor = page.querySelector('meta[name="theme-color"]');
        if (themeColor) themeColor.content = dark ? '#000000' : adminMode ? '#f4f4f4' : '#ffffff';
        document.documentElement.lang = page.documentElement.lang || 'en';

        const styles = [...page.querySelectorAll('link[rel="stylesheet"]')];
        const loadedStyles = styles.map(link => new Promise((resolve, reject) => {
            const required = new URL(link.href).origin === appBase.origin;
            const failed = () => required ? reject(new Error('The teaching styles could not load.')) : resolve();
            const timeout = setTimeout(failed, 20000);
            link.onload = () => { clearTimeout(timeout); resolve(); };
            link.onerror = () => { clearTimeout(timeout); failed(); };
        }));
        // This is a complete page, not a widget inside the host website's layout.
        mounted = true;
        // Keep the initial background while styles download. Replacing the entire
        // head without this briefly restores the browser's default white canvas.
        document.head.replaceChildren(startupTheme, ...page.head.childNodes);
        await Promise.all(loadedStyles);
        document.body.className = page.body.className;
        document.body.replaceChildren(...page.body.childNodes);
        startupTheme.remove();
        window.TEACHING_SITE = site;
        window.TEACHING_EMBEDDED_ADMIN = adminMode;
        window.TEACHING_CONFIG.catCompanion = false;
        window.TEACHING_CONFIG.owner = {
            ...owner, homeUrl: '/'
        };
        // Preserve dependency order. Page controllers start immediately if DOMContentLoaded
        // has already fired, which is the normal case for this asynchronous loader.
        for (const script of scripts) {
            await loadScript(script.src, script.crossorigin ? { crossorigin: script.crossorigin } : {});
        }
    }

    async function start() {
        if (document.readyState === 'loading') {
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }
        try {
            await loadScript(new URL('js/config.js', appBase).href);
            await loadScript(new URL('js/sites.js', appBase).href);
            let site;
            if (lecturerId) {
                if (!['https:', 'http:'].includes(location.protocol)) {
                    showError('Upload this file to a website to view its courses.'); return;
                }
                site = await window.TeachingSites.rpc('teaching_resolve_lecturer', { p_id: lecturerId });
                if (site) site.base_path = window.TeachingSites.currentDirectory();
            } else {
                // Older generic files and the optional 404 snippet use saved addresses.
                site = await window.TeachingSites.rpc('teaching_resolve_site', {
                    p_hostname: location.hostname, p_path: window.TeachingSites.normalizePath(location.pathname)
                });
            }
            if (!site) { showError('This lecturer’s courses are not available.'); return; }
            if (adminMode && !window.isSecureContext) {
                showError('Open this admin page over HTTPS to sign in.'); return;
            }
            await mount(site);
        } catch (error) {
            console.error('Teaching loader:', error);
            showError('Please try again shortly.');
        }
    }
    start();
})();
