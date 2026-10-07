// Course editor: suggestion lists under text fields, and the file types a material's Subtitle
// suggests (each with its icon). Load before js/course-editor.js, which registers the sources.

// ── File types ──
// [label, icon, extensions, other words it is found by]. The label is what the Subtitle gets.
// Icons are Font Awesome Free; the course page colours file icons by name (pdf, word, excel…).
const FILE_TYPES = [
  // Documents
  ['PDF Document', 'fa-regular fa-file-pdf', 'pdf', 'acrobat portable'],
  ['Word Document', 'fa-regular fa-file-word', 'doc docx docm dot dotx', 'microsoft msword'],
  ['PowerPoint Presentation', 'fa-regular fa-file-powerpoint', 'ppt pptx pptm pps ppsx pot potx', 'microsoft slides deck'],
  ['Excel Spreadsheet', 'fa-regular fa-file-excel', 'xls xlsx xlsm xlsb xlt xltx', 'microsoft workbook sheet'],
  ['CSV File', 'fa-solid fa-file-csv', 'csv tsv', 'comma separated values data table'],
  ['Text File', 'fa-regular fa-file-lines', 'txt log', 'plain notepad'],
  ['Rich Text Document', 'fa-regular fa-file-lines', 'rtf', ''],
  ['Markdown Document', 'fa-brands fa-markdown', 'md markdown', 'readme'],
  ['Google Doc', 'fa-regular fa-file-word', 'gdoc', 'docs document'],
  ['Google Slides', 'fa-regular fa-file-powerpoint', 'gslides', 'presentation deck'],
  ['Google Sheets', 'fa-regular fa-file-excel', 'gsheet', 'spreadsheet'],
  ['Google Form', 'fa-solid fa-clipboard-list', 'gform', 'forms survey questionnaire'],
  ['Google Drawing', 'fa-regular fa-file-image', 'gdraw', 'drawings'],
  ['OpenDocument Text', 'fa-regular fa-file-word', 'odt ott', 'libreoffice openoffice writer'],
  ['OpenDocument Presentation', 'fa-regular fa-file-powerpoint', 'odp otp', 'libreoffice openoffice impress slides'],
  ['OpenDocument Spreadsheet', 'fa-regular fa-file-excel', 'ods ots', 'libreoffice openoffice calc'],
  ['Keynote Presentation', 'fa-regular fa-file-powerpoint', 'key', 'apple slides'],
  ['Pages Document', 'fa-regular fa-file-word', 'pages', 'apple'],
  ['Numbers Spreadsheet', 'fa-regular fa-file-excel', 'numbers', 'apple'],
  ['eBook', 'fa-solid fa-book', 'epub mobi azw3', 'kindle electronic book'],
  ['LaTeX Document', 'fa-regular fa-file-code', 'tex latex cls sty', 'overleaf'],
  ['BibTeX References', 'fa-solid fa-book-bookmark', 'bib ris enw', 'bibliography citations zotero mendeley'],
  ['OneNote Notebook', 'fa-solid fa-book-open', 'one onetoc2', 'microsoft notes'],
  ['Visio Diagram', 'fa-solid fa-diagram-project', 'vsd vsdx', 'microsoft flowchart'],
  ['Project Plan', 'fa-solid fa-chart-gantt', 'mpp', 'microsoft gantt schedule timeline'],
  // Course material
  ['Lecture Slides', 'fa-regular fa-file-powerpoint', '', 'presentation powerpoint deck'],
  ['Lecture Notes', 'fa-regular fa-file-lines', '', 'class notes'],
  ['Lecture Recording', 'fa-solid fa-video', '', 'video recorded class'],
  ['Course Syllabus', 'fa-solid fa-list-check', '', 'outline course plan'],
  ['Textbook', 'fa-solid fa-book', '', 'book coursebook'],
  ['Book Chapter', 'fa-solid fa-book-open', '', 'reading'],
  ['Reading', 'fa-solid fa-book-open-reader', '', 'article required recommended'],
  ['Research Paper', 'fa-solid fa-newspaper', '', 'article journal publication conference'],
  ['Case Study', 'fa-solid fa-magnifying-glass', '', 'analysis example'],
  ['Handout', 'fa-regular fa-file-lines', '', 'sheet'],
  ['Worksheet', 'fa-solid fa-table-list', '', 'exercises activity'],
  ['Exercises', 'fa-solid fa-pencil', '', 'practice problems questions'],
  ['Problem Set', 'fa-solid fa-pencil', '', 'exercises practice questions'],
  ['Solutions', 'fa-solid fa-square-check', '', 'answers answer key solved'],
  ['Homework', 'fa-solid fa-file-pen', '', 'assignment hw task'],
  ['Assignment Brief', 'fa-solid fa-file-pen', '', 'homework instructions task requirements'],
  ['Project Brief', 'fa-solid fa-diagram-project', '', 'description requirements instructions'],
  ['Lab Manual', 'fa-solid fa-flask', '', 'laboratory experiment practical'],
  ['Lab Report Template', 'fa-solid fa-vial', '', 'laboratory experiment'],
  ['Report Template', 'fa-regular fa-file-word', '', 'format'],
  ['Template', 'fa-regular fa-file', '', 'format blank'],
  ['Rubric', 'fa-solid fa-table-cells', '', 'grading criteria marking scheme assessment'],
  ['Past Exam', 'fa-solid fa-file-signature', '', 'previous paper midterm final questions'],
  ['Sample Exam', 'fa-solid fa-file-signature', '', 'practice mock midterm final questions'],
  ['Quiz', 'fa-solid fa-question', '', 'test'],
  ['Formula Sheet', 'fa-solid fa-square-root-variable', '', 'formulas equations'],
  ['Cheat Sheet', 'fa-solid fa-note-sticky', '', 'reference card summary'],
  ['Summary', 'fa-solid fa-list-ul', '', 'overview recap review'],
  ['Glossary', 'fa-solid fa-spell-check', '', 'terms definitions vocabulary'],
  ['Tutorial', 'fa-solid fa-chalkboard-user', '', 'how to walkthrough'],
  ['Guide', 'fa-solid fa-compass', '', 'guidelines instructions manual'],
  ['Standard', 'fa-solid fa-scale-balanced', '', 'code regulation eurocode norm'],
  ['Specification', 'fa-solid fa-file-contract', '', 'requirements spec'],
  ['Schedule', 'fa-regular fa-calendar', '', 'timetable calendar plan'],
  ['Certificate', 'fa-solid fa-certificate', '', 'award'],
  ['Form', 'fa-solid fa-clipboard-list', '', 'application request'],
  // Images and design
  ['Image', 'fa-regular fa-file-image', 'jpg jpeg png gif webp bmp tif tiff heic heif avif', 'picture photo'],
  ['SVG Image', 'fa-regular fa-file-image', 'svg', 'vector graphic'],
  ['Photo', 'fa-regular fa-file-image', '', 'picture image'],
  ['Site Photos', 'fa-regular fa-images', '', 'visit pictures images'],
  ['Diagram', 'fa-solid fa-diagram-project', 'drawio', 'flowchart chart'],
  ['Chart', 'fa-solid fa-chart-line', '', 'graph plot'],
  ['Infographic', 'fa-solid fa-chart-pie', '', 'chart visual'],
  ['Poster', 'fa-regular fa-image', '', ''],
  ['Photoshop File', 'fa-regular fa-file-image', 'psd', 'adobe'],
  ['Illustrator File', 'fa-regular fa-file-image', 'ai eps', 'adobe vector'],
  ['Figma Design', 'fa-brands fa-figma', 'fig', 'ui prototype'],
  ['Canva Design', 'fa-solid fa-palette', '', 'poster presentation'],
  // Video and audio
  ['Video', 'fa-regular fa-file-video', 'mp4 mov avi mkv webm wmv m4v', 'movie clip film'],
  ['YouTube Video', 'fa-brands fa-youtube', '', 'video link'],
  ['Screen Recording', 'fa-solid fa-display', '', 'screencast video'],
  ['Animation', 'fa-solid fa-film', '', 'animated video'],
  ['Audio', 'fa-regular fa-file-audio', 'mp3 wav m4a ogg flac aac wma', 'sound music recording'],
  ['Podcast', 'fa-solid fa-podcast', '', 'episode audio'],
  // Archives
  ['ZIP Archive', 'fa-regular fa-file-zipper', 'zip', 'compressed folder'],
  ['RAR Archive', 'fa-regular fa-file-zipper', 'rar', 'compressed winrar'],
  ['7-Zip Archive', 'fa-regular fa-file-zipper', '7z', 'compressed 7zip'],
  ['TAR Archive', 'fa-regular fa-file-zipper', 'tar gz tgz bz2 xz', 'compressed gzip tarball'],
  // Code and data
  ['Source Code', 'fa-regular fa-file-code', '', 'program code'],
  ['Python Script', 'fa-brands fa-python', 'py pyw', 'code'],
  ['Jupyter Notebook', 'fa-regular fa-file-code', 'ipynb', 'colab python notebook'],
  ['Java Source', 'fa-brands fa-java', 'java jar class', 'code'],
  ['JavaScript File', 'fa-brands fa-js', 'js mjs cjs ts tsx jsx', 'typescript node code'],
  ['HTML Page', 'fa-brands fa-html5', 'html htm', 'web page'],
  ['CSS Stylesheet', 'fa-brands fa-css3-alt', 'css scss sass less', 'styles'],
  ['C / C++ Source', 'fa-regular fa-file-code', 'c h cpp cc cxx hpp', 'cplusplus code'],
  ['C# Source', 'fa-regular fa-file-code', 'cs', 'csharp dotnet code'],
  ['MATLAB Script', 'fa-regular fa-file-code', 'm mlx mat', 'octave code'],
  ['Simulink Model', 'fa-solid fa-gears', 'slx mdl', 'matlab simulation'],
  ['R Script', 'fa-brands fa-r-project', 'r rmd rdata rds', 'rstudio statistics code'],
  ['SQL Script', 'fa-solid fa-database', 'sql', 'query database'],
  ['JSON File', 'fa-regular fa-file-code', 'json', 'data'],
  ['XML File', 'fa-regular fa-file-code', 'xml', 'data'],
  ['YAML File', 'fa-regular fa-file-code', 'yaml yml', 'config'],
  ['Shell Script', 'fa-solid fa-terminal', 'sh bash bat cmd ps1', 'batch powershell terminal'],
  ['Dataset', 'fa-solid fa-database', 'parquet h5 hdf5 sav dta', 'data'],
  ['Database', 'fa-solid fa-database', 'db sqlite accdb mdb', 'access data'],
  ['GitHub Repository', 'fa-brands fa-github', '', 'git repo code'],
  ['Software', 'fa-solid fa-laptop-code', 'exe msi dmg apk', 'program installer app setup'],
  ['Arduino Sketch', 'fa-solid fa-microchip', 'ino', 'microcontroller code'],
  // Engineering
  ['AutoCAD Drawing', 'fa-solid fa-compass-drafting', 'dwg dxf dwf', 'cad drawing plan'],
  ['Technical Drawing', 'fa-solid fa-compass-drafting', '', 'plan blueprint section elevation'],
  ['Revit Model', 'fa-solid fa-building', 'rvt rfa rte', 'bim autodesk'],
  ['SketchUp Model', 'fa-solid fa-cube', 'skp', '3d'],
  ['3D Model', 'fa-solid fa-cube', 'stl obj fbx 3ds step stp iges igs 3dm blend', 'cad blender rhino'],
  ['SAP2000 Model', 'fa-solid fa-building', 'sdb s2k', 'csi structural analysis'],
  ['ETABS Model', 'fa-solid fa-building', 'edb e2k', 'csi structural analysis'],
  ['SolidWorks Part', 'fa-solid fa-gear', 'sldprt sldasm slddrw', 'cad assembly'],
  ['GIS Data', 'fa-solid fa-map-location-dot', 'shp kml kmz geojson gpx qgz', 'map qgis arcgis google earth'],
  ['Map', 'fa-solid fa-map', '', 'location'],
  ['Calculation Sheet', 'fa-solid fa-calculator', '', 'calculations design'],
  ['Simulation', 'fa-solid fa-gears', '', 'model analysis'],
  ['Bill of Quantities', 'fa-solid fa-list-ol', '', 'boq estimate cost'],
  ['Survey Data', 'fa-solid fa-ruler-combined', '', 'surveying measurements'],
  // Web
  ['Website', 'fa-solid fa-globe', 'url', 'web site page'],
  ['Web Link', 'fa-solid fa-link', '', 'url'],
  ['Online Quiz', 'fa-solid fa-circle-question', '', 'kahoot test'],
  ['Online Meeting', 'fa-solid fa-video', '', 'zoom teams meet call'],
  ['Online Course', 'fa-solid fa-graduation-cap', '', 'mooc coursera edx'],
  ['Wikipedia Article', 'fa-brands fa-wikipedia-w', '', 'wiki'],
  ['Google Drive Folder', 'fa-brands fa-google-drive', '', 'folder'],
  ['Folder', 'fa-regular fa-folder', '', 'directory'],
].map(([label, icon, ext, words]) => ({
  label, icon, ext: ext ? ext.split(' ') : [],
  words: [...new Set(foldText(`${label} ${words}`).split(' ').filter(Boolean))]
}));
const FILE_TYPE_ICONS = new Set(FILE_TYPES.map(t => t.icon));
// The types most courses use, most used first: they lead among equally good matches, so "p"
// offers PDF and PowerPoint before Photo and Poster.
const COMMON_FILE_TYPES = ['PDF Document', 'PowerPoint Presentation', 'Word Document', 'Excel Spreadsheet', 'Lecture Slides',
  'Lecture Notes', 'Video', 'Image', 'ZIP Archive', 'Homework', 'Solutions', 'Past Exam', 'Lab Manual', 'Textbook',
  'Reading', 'YouTube Video', 'Website', 'Python Script', 'Dataset', 'AutoCAD Drawing'];
// Drive's own formats, by the end of their MIME type (application/vnd.google-apps.*).
const GOOGLE_FILE_TYPES = { document: 'Google Doc', presentation: 'Google Slides', spreadsheet: 'Google Sheets',
  form: 'Google Form', drawing: 'Google Drawing', folder: 'Google Drive Folder' };

// Lower case, accents removed and spaces collapsed, for matching typed text.
function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const fileTypeNamed = label => FILE_TYPES.find(t => t.label === label) || null;

// The file types typed text could mean, best first: the label itself, then an extension
// (".pptx", "dwg"), then a label or other word that starts with it ("slid" → Lecture Slides),
// then every typed word starting one ("lab rep" → Lab Report Template). Ties go to the common
// types, then to shorter labels.
function matchFileTypes(query, limit = 6) {
  const q = foldText(query).replace(/^\./, '');
  if (!q) return [];
  const tokens = q.split(' ');
  const scored = [];
  for (const type of FILE_TYPES) {
    const label = foldText(type.label);
    const score = label === q ? 6 : type.ext.includes(q) ? 5 : label.startsWith(q) ? 4
      : type.words.some(w => w.startsWith(q)) ? 3
        : tokens.length > 1 && tokens.every(t => type.ext.includes(t) || type.words.some(w => w.startsWith(t))) ? 2
          : q.length > 2 && label.includes(q) ? 1 : 0;
    const common = COMMON_FILE_TYPES.indexOf(type.label);
    if (score) scored.push({ type, score: score + (common < 0 ? -label.length / 1000 : 0.9 - common / 100) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.type);
}

// The type text names exactly, by label or extension ("PDF Document", "pdf").
function fileTypeExact(value) {
  const q = foldText(value).replace(/^\./, '');
  return q ? FILE_TYPES.find(t => foldText(t.label) === q) || FILE_TYPES.find(t => t.ext.includes(q)) || null : null;
}

// The type of a file from Drive: its Google format, else its extension, else its kind.
function fileTypeOf(name, mimeType) {
  const google = /^application\/vnd\.google-apps\.(\w+)/.exec(mimeType || '');
  if (google && GOOGLE_FILE_TYPES[google[1]]) return fileTypeNamed(GOOGLE_FILE_TYPES[google[1]]);
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1].toLowerCase();
  const byExt = ext && FILE_TYPES.find(t => t.ext.includes(ext));
  if (byExt) return byExt;
  const kind = /^(image|video|audio|text)\//.exec(mimeType || '')?.[1];
  return kind ? fileTypeNamed({ image: 'Image', video: 'Video', audio: 'Audio', text: 'Text File' }[kind]) : null;
}

// ── Suggestion list ──
// A text field with data-suggest="<name>" lists SUGGEST_SOURCES[name].items(input) under it as
// it is focused and typed in: arrows move, Enter picks, Escape closes. Each item is
// { value, label, icon?, badge?, detail? }; source.picked(input, item) runs after a pick. The
// list is fixed to the viewport (the edit panel clips overflow), shows at most six rows, and
// opens above the field when there is more room there.
const SUGGEST_SOURCES = {};
const Suggest = (() => {
  const ROW = 38, ROWS = 6;
  let list = null, state = null;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

  function element() {
    if (list) return list;
    list = document.createElement('ul');
    list.id = 'suggest-list';
    list.className = 'suggest-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    // mousedown, not click: picking must not blur the field first.
    list.addEventListener('mousedown', event => {
      event.preventDefault();
      const option = event.target.closest('[data-index]');
      if (option) pick(Number(option.dataset.index));
    });
    document.body.appendChild(list);
    return list;
  }

  function highlight(label, query) {
    const q = query.trim().toLowerCase();
    const at = q ? label.toLowerCase().indexOf(q) : -1;
    return at < 0 ? esc(label) : `${esc(label.slice(0, at))}<mark>${esc(label.slice(at, at + q.length))}</mark>${esc(label.slice(at + q.length))}`;
  }

  function show(input) {
    const source = SUGGEST_SOURCES[input.dataset.suggest];
    const items = source ? source.items(input) : [];
    if (!items.length) return hide();
    // The first match is ready for Enter while typing; an empty field just offers the list.
    state = { input, source, items, active: input.value.trim() ? 0 : -1 };
    render();
    place();
  }

  function render() {
    const { input, items, active } = state;
    element().innerHTML = items.map((item, i) => `<li id="suggest-${i}" class="suggest-item${i === active ? ' is-active' : ''}"
        role="option" aria-selected="${i === active}" data-index="${i}">
      ${item.icon ? `<i class="${esc(item.icon)} suggest-icon" aria-hidden="true"></i>` : ''}
      <span class="suggest-label">${highlight(item.label, input.value)}</span>
      ${item.badge ? `<span class="suggest-badge">${esc(item.badge)}</span>` : ''}
      ${item.detail ? `<span class="suggest-detail">${esc(item.detail)}</span>` : ''}</li>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `suggest-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function place() {
    const rect = state.input.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const wanted = Math.min(state.items.length, ROWS) * ROW + 10;
    const up = below < wanted && above > below;
    Object.assign(list.style, {
      left: `${Math.max(8, rect.left)}px`,
      width: `${Math.min(Math.max(rect.width, 220), window.innerWidth - 16)}px`,
      maxHeight: `${Math.max(ROW * 2, Math.min(wanted, up ? above : below))}px`,
      top: up ? '' : `${rect.bottom + 4}px`,
      bottom: up ? `${window.innerHeight - rect.top + 4}px` : ''
    });
  }

  function hide() {
    if (list) list.hidden = true;
    if (state) {
      state.input.setAttribute('aria-expanded', 'false');
      state.input.removeAttribute('aria-activedescendant');
    }
    state = null;
  }

  function pick(index) {
    const current = state, item = current?.items[index];
    if (!item) return;
    hide();
    current.input.value = item.value;
    // change, not input: it marks the draft edited without reopening the list.
    current.input.dispatchEvent(new Event('change', { bubbles: true }));
    current.source.picked?.(current.input, item);
  }

  const isField = el => el?.matches?.('input[data-suggest]');
  document.addEventListener('focusin', event => {
    if (!isField(event.target)) return;
    event.target.setAttribute('role', 'combobox');
    event.target.setAttribute('aria-autocomplete', 'list');
    event.target.setAttribute('aria-controls', 'suggest-list');
    show(event.target);
  });
  document.addEventListener('input', event => { if (isField(event.target)) show(event.target); });
  document.addEventListener('focusout', event => { if (state && event.target === state.input) hide(); });
  // Capture phase, so Escape closes the list before the editor's own Escape closes the panel.
  document.addEventListener('keydown', event => {
    if (!isField(event.target)) return;
    if (!state || event.target !== state.input) {
      if (event.key === 'ArrowDown') { event.preventDefault(); show(event.target); }
      return;
    }
    const count = state.items.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      state.active = (state.active + (event.key === 'ArrowDown' ? 1 : count - 1 + (state.active < 0 ? 1 : 0))) % count;
      render();
    } else if (event.key === 'Enter' && state.active >= 0) {
      event.preventDefault();
      pick(state.active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  }, true);
  window.addEventListener('resize', () => { if (state) place(); });
  document.addEventListener('scroll', event => { if (state && event.target !== list) place(); }, true);

  // Redraws an open field's list, say once its data has loaded.
  return { refresh: input => { if (document.activeElement === input) show(input); } };
})();
