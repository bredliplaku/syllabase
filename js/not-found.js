// A page that is not one: an old address (?admin), or a part of another page opened on its own
// (timetable/manage.html). It shows the website's own "not found" page (/404.html), at the
// address typed, with no redirect. The page that loads this has already made the rest of
// itself inert (it writes <plaintext hidden>, so what follows is read as hidden text and none
// of it loads); once it has been read, the 404 page replaces it whole.
(function () {
  'use strict';
  const FALLBACK = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Page not found</title></head>'
    + '<body><p style="font:16px/1.6 system-ui;margin:20vh auto;max-width:30rem;padding:0 24px">Page not found. <a href="/">Home</a></p></body></html>';

  async function show() {
    let html = FALLBACK;
    try {
      const response = await fetch('/404.html', { cache: 'no-cache' });
      if (response.ok) html = await response.text();
    } catch { }
    document.open();
    document.write(html);
    document.close();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
  else show();
})();
