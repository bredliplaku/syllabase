// Shared website addressing and public API helpers. No sign-in session is used here.
(function () {
    'use strict';

    function normalizeWebsite(value, includeWww = true) {
        const raw = String(value || '').trim();
        if (!raw) return null;
        let url;
        try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw); }
        catch { throw new Error('Enter a valid website address.'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash) {
            throw new Error('Use a website address without a port, query or fragment.');
        }
        const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
        if (hostname.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
            throw new Error('Enter a public domain or subdomain.');
        }
        const base_path = normalizePath(url.pathname).replace(/\/*$/, '/');
        if (base_path.length > 500 || !/^\/([A-Za-z0-9._~-]+\/)*$/.test(base_path)) {
            throw new Error('Use a directory path with letters, numbers, hyphens or underscores.');
        }
        return { hostname, base_path, include_www: !!includeWww };
    }

    function normalizePath(path) {
        if (/%2f|%5c|\\/i.test(path)) throw new Error('Encoded path separators are not supported.');
        const decoded = decodeURIComponent(path);
        // URL resolves dot segments; the registry stores case-sensitive directory paths.
        const url = new URL('https://path.invalid');
        url.pathname = decoded.replace(/\/+/g, '/');
        return url.pathname;
    }

    const websiteUrl = site => site?.hostname && site?.base_path ? `https://${site.hostname}${site.base_path}` : '';

    function adminUrl(site) {
        const url = new URL(site.base_path, location.origin);
        url.search = '?admin';
        return url.href;
    }

    function currentDirectory() {
        const path = normalizePath(location.pathname);
        if (path.endsWith('/')) return path;
        if (path.endsWith('/index.html')) return path.slice(0, -'index.html'.length);
        // Some hosts serve directory indexes without redirecting to a trailing slash.
        return path + '/';
    }

    async function rpc(name, params) {
        const config = window.TEACHING_CONFIG;
        const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
            method: 'POST', credentials: 'omit', cache: 'no-store',
            headers: {
                apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(params), signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error('The teaching service is unavailable.');
        return response.json();
    }

    async function pagedRows(name, params) {
        const result = [];
        for (let offset = 0; ; offset += 1000) {
            const page = await rpc(name, { ...params, p_offset: offset });
            if (!Array.isArray(page)) throw new Error('Invalid course response.');
            result.push(...page);
            if (page.length < 1000) return result;
        }
    }

    const rows = (site, archive, sheet = null) =>
        pagedRows('teaching_site_rows', { p_site_id: site.id, p_archive: archive, p_sheet_name: sheet });
    // The central page lists its owner's assigned courses, like a lecturer website.
    const centralRows = (archive, sheet = null) =>
        pagedRows('teaching_central_rows', { p_archive: archive, p_sheet_name: sheet });

    function routeCourse(site) {
        const path = normalizePath(location.pathname);
        const suffix = path === site.base_path.slice(0, -1) ? '' : path.slice(site.base_path.length);
        if (!suffix || suffix === 'index.html') return '';
        const parts = suffix.split('/').filter(Boolean);
        if (parts.length === 2 && parts[0] === 'course') parts.shift();
        // A malformed nested route must never silently open a different course.
        return parts.length === 1 ? decodeURIComponent(parts[0]) : '\u0000';
    }

    function loaderScript(fallback = false, lecturerId = '') {
        if (lecturerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lecturerId)) {
            throw new Error('Invalid lecturer ID. Reload Settings and try again.');
        }
        const src = new URL('embed.js', window.TEACHING_CONFIG.appBaseUrl).href
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        return `<script defer src="${src}"${lecturerId ? ` data-teaching-lecturer="${lecturerId}"` : ''}${fallback ? ' data-teaching-fallback' : ''}></script>`;
    }

    function loaderHtml(lecturerId) {
        if (!lecturerId) throw new Error('Save the lecturer account before downloading its website file.');
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#ffffff">
  <title>Syllabase</title>
  <!-- Replace /favicon.ico with the path to your website's own favicon. -->
  <link rel="icon" href="/favicon.ico">
  <!-- Keep the initial background in sync with the course page before it loads. -->
  <style id="teaching-startup-theme">
    html { color-scheme: light; background: var(--teaching-start-light, #fff); color: #333; }
    html[data-theme="dark"] { color-scheme: dark; background: #000; color: #e0e0e0; }
    @media (prefers-color-scheme: dark) {
      html:not([data-theme="light"]) { color-scheme: dark; background: #000; color: #e0e0e0; }
    }
    body { margin: 0; background: inherit; }
  </style>
  <script>
    (function () {
      let theme = 'auto';
      try { theme = localStorage.getItem('theme-preference') || 'auto'; } catch { }
      if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
      const light = new URLSearchParams(location.search).has('admin') ? '#f4f4f4' : '#ffffff';
      document.documentElement.style.setProperty('--teaching-start-light', light);
      const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.querySelector('meta[name="theme-color"]').content = dark ? '#000000' : light;
    })();
  </script>
  ${loaderScript(false, lecturerId)}
</head>
<body>
  <noscript>Please enable JavaScript to view content.</noscript>
</body>
</html>
`;
    }

    // Lecturer order, used everywhere lecturers are listed: by title, then A–Z by name.
    // Titles count only at the start of a name or after a comma ("Jane Doe, PhD"), so a
    // surname such as "Ma" is not mistaken for one. Untitled names come after titled ones.
    const TITLE_WORDS = new Set(['prof', 'professor', 'assoc', 'associate', 'asst', 'assist', 'assistant',
        'dr', 'phd', 'mr', 'mrs', 'ms', 'msc', 'ma', 'pm', 'ba', 'bsc', 'acad']);
    function splitLecturerName(name) {
        const [main, ...after] = String(name || '').split(',');
        const words = main.trim().split(/\s+/).filter(Boolean);
        const key = word => word.toLowerCase().replace(/\./g, '');
        const titles = [];
        while (words.length > 1 && TITLE_WORDS.has(key(words[0]))) titles.push(key(words.shift()));
        for (const part of after) {
            const tokens = part.trim().split(/\s+/).map(key).filter(Boolean);
            if (tokens.length && tokens.every(t => TITLE_WORDS.has(t))) titles.push(...tokens);
        }
        return { titles, name: words.join(' ') };
    }
    function lecturerTitleRank(name) {
        const titles = new Set(splitLecturerName(name).titles);
        if (titles.has('assoc') || titles.has('associate')) return 2;              // Assoc. Prof. (Dr.)
        if (titles.has('asst') || titles.has('assist') || titles.has('assistant')) return 2.5;
        if (titles.has('prof') || titles.has('professor')) return 1;              // Prof. (Dr.)
        if (titles.has('dr') || titles.has('phd')) return 3;                      // Dr. / PhD
        if (['mr', 'mrs', 'ms', 'msc', 'ma', 'pm'].some(t => titles.has(t))) return 4;
        if (titles.has('ba') || titles.has('bsc')) return 5;
        return 6;
    }
    function compareLecturers(a, b) {
        return lecturerTitleRank(a) - lecturerTitleRank(b) ||
            splitLecturerName(a).name.localeCompare(splitLecturerName(b).name, undefined, { sensitivity: 'base' }) ||
            String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
    }

    window.TeachingSites = { compareLecturers, normalizeWebsite, normalizePath, websiteUrl, adminUrl, currentDirectory, rpc, rows, centralRows, routeCourse, loaderHtml, loaderScript };
})();
