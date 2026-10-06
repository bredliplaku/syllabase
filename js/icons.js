// Font Awesome icon fields, shared by the course editor and the timetable admin. A field
// takes an icon's class ("fa-solid fa-circle-user") or the tag Font Awesome copies
// (<i class="fa-solid fa-circle-user"></i>) and keeps the class.

// The class from either form.
function faIconClass(value) {
  const text = String(value || '').trim();
  const match = text.match(/class\s*=\s*["']([^"']*)["']/i);
  return (match ? match[1] : text.replace(/<\/?i\b[^>]*>/gi, '')).trim().replace(/\s+/g, ' ');
}

// A comma-separated list of classes, with pasted tags turned into their classes.
function faIconList(value) {
  const text = String(value || '');
  if (!/[<>]/.test(text)) return text;
  return [...text.matchAll(/class\s*=\s*["']([^"']*)["']/gi)].map(m => m[1].trim().replace(/\s+/g, ' ')).join(', ');
}

// A preview's markup. Font Awesome's script replaces each <i> with an <svg>, so previews
// are redrawn with a new <i>; changing the class of the old one does nothing.
function faIconHtml(cls, fallback = 'fa-solid fa-question') {
  const value = faIconClass(cls) || fallback;
  return `<i class="${value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}" aria-hidden="true"></i>`;
}

// Fields marked data-fa-icon (one icon) or data-fa-list (several) turn a pasted tag into
// its class as it arrives. An icon field redraws the .fa-preview beside it and any
// previews listed by id in data-fa-preview.
document.addEventListener('input', event => {
  const input = event.target;
  if (!input.matches?.('[data-fa-icon], [data-fa-list]')) return;
  const list = input.matches('[data-fa-list]');
  if (/[<>]|class\s*=/i.test(input.value)) input.value = list ? faIconList(input.value) : faIconClass(input.value);
  if (list) return;
  const previews = [input.closest('.icon-input-wrap')?.querySelector('.fa-preview'),
    ...(input.dataset.faPreview || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id))];
  for (const preview of previews.filter(Boolean)) preview.innerHTML = faIconHtml(input.value, preview.dataset.fallback);
});
