// Public course catalog, course content, navigation and page interactions.
let isArchiveMode = false;
const lecturerSite = window.TEACHING_SITE || null;
let catalogSequence = 0;

// Isolate course preferences on websites sharing a hostname. Keep the central
// page's existing keys, and tolerate disabled browser storage.
function teachingStorage(kind) {
    const keyFor = key => lecturerSite && key !== 'theme-preference' ? `teaching_${lecturerSite.id}_${key}` : key;
    return {
        getItem(key) { try { return window[kind].getItem(keyFor(key)); } catch { return null; } },
        setItem(key, value) { try { window[kind].setItem(keyFor(key), value); } catch { } },
        removeItem(key) { try { window[kind].removeItem(keyFor(key)); } catch { } }
    };
}
const courseStorage = teachingStorage('localStorage');
const courseSessionStorage = teachingStorage('sessionStorage');

function requestedCourse() {
    let hash = '';
    try { hash = decodeURIComponent(window.location.hash.slice(1)); } catch { return '\u0000'; }
    if (hash && !hash.startsWith('module-')) return hash;
    return lecturerSite ? TeachingSites.routeCourse(lecturerSite) : '';
}

function matchSiteCourse(requested, names = availableCourses, codes = courseMap) {
    if (!requested) return '';
    if (names.includes(requested)) return requested;
    const compact = value => String(value).replace(/[\s_-]/g, '').toLowerCase();
    const matches = names.filter(name => compact(name) === compact(requested) || compact(codes[name] || '') === compact(requested));
    return matches.length === 1 ? matches[0] : '';
}

let availableCourses = [];
let currentCourse = '';
let courseViewSequence = 0;
let courseHeaderAnimation = null;
let courseMap = {};
let courseYearMap = {};
let courseSemesterMap = {};
let courseIconMap = {}; // header_decoration: the course's own icon on its tab
let courseTitleMap = {}; // Full course name, shown on the selected tab
let pendingNotifications = [];
let isInitializing = true;
let criticalErrorsOnly = true;
const courseData = { metadata: {}, modules: [] };
const courseDataCache = {};
let isProgrammaticScroll = false;

// Course content is authored by people with different access levels. It must never
// execute script on this origin, which also hosts the signed-in control panel.
function courseHtmlText(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeCourseUrl(value, imageOnly = false) {
    const raw = String(value || '').trim();
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
    try {
        // Relative content links belong to the app root, not courses/ or a lecturer's folder.
        const base = !/^[#?]/.test(raw) ? window.TEACHING_CONFIG.appBaseUrl : document.baseURI;
        const url = new URL(raw, base);
        const protocols = imageOnly ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:', 'tel:'];
        return protocols.includes(url.protocol) ? url.href : '';
    } catch { return ''; }
}

function courseActionButton(url, action, iconOnly = false) {
    const safeUrl = safeCourseUrl(url);
    if (!safeUrl) return '';
    const actions = {
        view: ['btn-blue', 'fa-regular fa-eye', 'View'],
        download: ['btn-green', 'fa-regular fa-save', 'Download'],
        open: ['btn-orange', 'fa-solid fa-external-link-alt', 'Open'],
        submit: ['btn-purple', 'fa-solid fa-upload', 'Submit']
    };
    const [color, icon, label] = actions[action];
    return `<button data-course-action="${courseHtmlText(safeUrl)}" class="${color}" aria-label="${label}"><span><i class="${icon}"></i>${iconOnly ? '' : ` ${label}`}</span></button>`;
}

function courseRichHtml(value) {
    // Fail closed if the sanitizer cannot load; the original content stays readable.
    if (!window.DOMPurify) return courseHtmlText(value);
    const fragment = window.DOMPurify.sanitize(String(value || ''), {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li',
            'a', 'img', 'span', 'div', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody',
            'tfoot', 'tr', 'th', 'td', 'hr', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'details', 'summary'],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'colspan', 'rowspan'],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false
    });
    fragment.querySelectorAll('a').forEach(link => {
        const url = safeCourseUrl(link.getAttribute('href'));
        if (url) link.setAttribute('href', url); else link.removeAttribute('href');
        link.setAttribute('rel', 'noopener noreferrer');
    });
    fragment.querySelectorAll('img').forEach(image => {
        const url = safeCourseUrl(image.getAttribute('src'), true);
        if (url) image.setAttribute('src', url); else image.removeAttribute('src');
    });
    const container = document.createElement('div');
    container.appendChild(fragment);
    return container.innerHTML;
}

function safeCourseColor(value) {
    const raw = String(value || '').trim();
    const names = ['primary', 'secondary', 'tertiary', 'accent', 'success', 'warning', 'info', 'danger'];
    if (names.includes(raw)) return `var(--${raw}-color)`;
    if (/^--[a-z][a-z0-9_-]*$/i.test(raw)) return `var(${raw})`;
    if (/^var\(--[a-z][a-z0-9_-]*\)$/i.test(raw)) return raw;
    // Reject declaration/attribute escapes and resource URLs before asking CSS to parse.
    if (/^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([0-9.,%+\-\s/degturnrad]+\))$/i.test(raw)
        && window.CSS?.supports('color', raw)) return raw;
    return 'var(--primary-color)';
}

// URLs are data, never JavaScript fragments. Rich text cannot add this attribute.
document.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-course-action]');
    if (button) handleActionClick(button, button.dataset.courseAction);
});

// Course tabs, the Archives button and module headers are divs marked role="button":
// Enter and Space press them, as they would a real button.
document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (target.getAttribute?.('role') !== 'button' || target.matches('button, a')) return;
    event.preventDefault();
    target.click();
});

function getCachePrefix() {
    return isArchiveMode ? 'archive_' : 'active_';
}

function applyClickFeedback(selector, duration = 1500) {
    document.addEventListener('click', function (event) {
        const button = event.target.closest(selector);

        if (button) {
            if (button.classList.contains('is-stuck')) return;

            button.classList.add('is-stuck');
            setTimeout(() => {
                button.classList.remove('is-stuck');
            }, duration);
        }
    });
}

function handleActionClick(button, url) {
    const safeUrl = safeCourseUrl(url);
    if (!safeUrl) return;
    // The pressed style renders (forced reflow) before the new tab opens, and clears
    // before the visitor returns.
    button.classList.add('is-stuck');
    void button.offsetHeight;
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
    setTimeout(() => {
        button.classList.remove('is-stuck');
    }, 1500);
}

function setupMobileFab() {
    const fab = document.getElementById('mobile-fab');
    const overlay = document.getElementById('fab-overlay');
    const menu = document.getElementById('mobile-fab-menu');

    const mq = window.matchMedia('(max-width: 1400px)');
    const applyFabVisibility = () => {
        if (!fab) return;
        if (mq.matches) fab.classList.add('is-ready');
        else fab.classList.remove('is-ready');
    };
    mq.addEventListener?.('change', applyFabVisibility);
    applyFabVisibility();

    if (!fab || !overlay || !menu) return;

    const toggleMenu = () => {
        fab.classList.toggle('active');
        overlay.classList.toggle('active');
        menu.classList.toggle('active');

        document.documentElement.classList.toggle('no-scroll');
        document.body.classList.toggle('no-scroll');
    };
    fab.addEventListener('click', toggleMenu);
    overlay.addEventListener('click', toggleMenu);
}

function init() {
    applyThemeDefaults();
    updateYear();
    applyOwnerBranding();
    // Opt-out kill switch: config.catCompanion === false removes the element,
    // after which every cat function no-ops on its null getElementById lookup.
    if (window.TEACHING_CONFIG && window.TEACHING_CONFIG.catCompanion === false) {
        const catEl = document.getElementById('cat-companion');
        if (catEl) catEl.remove();
    }
    initContainers();
    setupMobileFab();
    applyClickFeedback('#sort-button');
    setupThemeToggle();
    setupCatCompanion();
    checkUrlForCourse();
    loadModuleStates();
    setupSideNavToggle();
    applySideNavState();
    if (new URLSearchParams(window.location.search).has('archive')) {
        isArchiveMode = true;
    }

    initBackend();

    // Initialize faders immediately so skeletons have the fade effect
    setTimeout(() => {
        initializeScrollFaders();
    }, 50);

    window.addEventListener('scroll', updateActiveNavLink);

    window.addEventListener('hashchange', () => {
        const hash = requestedCourse();
        if (hash && availableCourses.length > 0) {
            if (availableCourses.includes(hash)) {
                if (hash !== currentCourse) selectCourse(hash);
            } else {
                // Trigger backend lookup if hash doesn't exist in current mode
                tryPublicAccess();
            }
        }
    });
}

function handleArchiveToggle(e) {
    e.preventDefault();

    // Hold the height and show skeletons while the other list loads.
    const courseContent = document.getElementById('course-content');
    const courseButtons = document.getElementById('course-buttons-container');

    if (courseContent) {
        // A perched cat lives inside the content about to be replaced: move it to <body>,
        // hidden until positionCatCompanion() re-perches it.
        const perchedCat = document.getElementById('cat-companion');
        if (perchedCat && perchedCat.parentElement === courseContent) {
            perchedCat.classList.remove('cat-perched');
            document.body.appendChild(perchedCat);
        }

        courseContent.style.minHeight = courseContent.offsetHeight + 'px';

        courseContent.innerHTML = `
                    <div class="skeleton-search"></div>
                    <div class="skeleton-module">
                        <div class="skeleton-module-header"></div>
                        <div class="skeleton-material-cards">
                            <div class="skeleton skeleton-material-card"></div>
                            <div class="skeleton skeleton-material-card"></div>
                        </div>
                    </div>
                    <div class="skeleton-module">
                        <div class="skeleton-module-header"></div>
                        <div class="skeleton-material-cards">
                            <div class="skeleton skeleton-material-card"></div>
                        </div>
                    </div>
                `;
    }

    if (courseButtons) {
        courseButtons.style.minHeight = courseButtons.offsetHeight + 'px';
        courseButtons.innerHTML = `
                    <div class="skeleton-tabs-wrapper" style="display: flex; gap: 2px;">
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                    </div>
                `;
    }

    isArchiveMode = !isArchiveMode;

    // A shareable URL for the list shown.
    const url = new URL(window.location);
    if (lecturerSite) url.pathname = lecturerSite.base_path;
    if (isArchiveMode) {
        url.searchParams.set('archive', '');
    } else {
        url.searchParams.delete('archive');
    }

    // Clean up the trailing '=' if it gets added by searchParams.set('', '')
    let newUrlString = url.toString().replace(/archive=(&|$)/, 'archive$1');

    // Wipe the hash so the toggle resets cleanly to the last remembered course for that view
    url.hash = '';

    // A history entry, so Back returns to the other list.
    window.history.pushState({ archive: isArchiveMode }, '', newUrlString || url);

    // Drop the hash so the reload doesn't read it as a requested course.
    if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    resetForModeSwitch();
}

// Back and forward switch between the active and archived lists.
window.addEventListener('popstate', (e) => {
    if (lecturerSite) {
        const archive = new URLSearchParams(location.search).has('archive');
        if (archive !== isArchiveMode) { isArchiveMode = archive; resetForModeSwitch(); return; }
        const course = matchSiteCourse(requestedCourse());
        if (course && course !== currentCourse) selectCourse(course);
        else if (!course && !location.hash.startsWith('#module-')) tryPublicAccess();
        return;
    }
    if (e.state && e.state.archive !== undefined) {
        if (isArchiveMode !== e.state.archive) {
            isArchiveMode = e.state.archive;
            resetForModeSwitch();
        }
    } else {
        // If there's no state object (e.g. back to initial load), check the URL again
        const urlParams = new URLSearchParams(window.location.search);
        const shouldBeArchive = urlParams.has('archive');
        if (isArchiveMode !== shouldBeArchive) {
            isArchiveMode = shouldBeArchive;
            resetForModeSwitch();
        }
    }
});

function resetForModeSwitch() {
    document.body.classList.add('is-loading');

    // Clear both lists' data so active and archived courses never mix.
    availableCourses = [];
    currentCourse = '';
    courseMap = {};
    courseYearMap = {};
    courseSemesterMap = {};
    courseIconMap = {};
    courseTitleMap = {};

    for (let key in courseDataCache) {
        delete courseDataCache[key];
    }

    courseStorage.removeItem('active_courseCodesCache');
    courseStorage.removeItem('archive_courseCodesCache');

    document.getElementById('course-buttons-container').innerHTML = '';
    const contentEl = document.getElementById('course-content');
    const perchedCat = document.getElementById('cat-companion');
    if (perchedCat && perchedCat.parentElement === contentEl) {
        // Out of the content about to be replaced, hidden until positionCatCompanion()
        // re-perches it.
        perchedCat.classList.remove('cat-perched');
        document.body.appendChild(perchedCat);
    }
    contentEl.innerHTML = '';

    initBackend();
}

function setupSideNavToggle() {
    const toggleBtn = document.getElementById('side-nav-toggle');
    const sideNav = document.getElementById('side-nav-container');

    if (!toggleBtn || !sideNav) return;

    toggleBtn.addEventListener('click', () => {
        sideNav.classList.toggle('collapsed');
        toggleBtn.classList.toggle('toggled');

        const isCollapsed = sideNav.classList.contains('collapsed');
        courseStorage.setItem('sideNavState', isCollapsed ? 'collapsed' : 'expanded');
    });
}

function applySideNavState() {
    const sideNav = document.getElementById('side-nav-container');
    const toggleBtn = document.getElementById('side-nav-toggle');
    const savedState = courseStorage.getItem('sideNavState');

    if (sideNav && toggleBtn && savedState === 'collapsed') {
        sideNav.classList.add('collapsed');
        toggleBtn.classList.add('toggled');
    }
}

function setupCatCompanion() {
    const cat = document.getElementById('cat-companion');
    const bubble = document.getElementById('cat-speech-bubble');
    if (!cat || !bubble) return;

    cat.setAttribute('role', 'button');
    cat.setAttribute('tabindex', '0');
    cat.setAttribute('aria-label', 'Cat Companion: Click for a message');

    let bubbleTimeout;
    let animationTimeout;
    let lastIndex = -1; // Track the last message to avoid repeats

    const messages = [
        // --- Study "Encouragement" ---
        "That's a lot of reading material. Have you considered just absorbing it through osmosis while you nap? 😴",
        "I see you have a deadline. I, too, have a deadline... for my next nap.",
        "Remember to take breaks. I recommend a 4-hour break for every 15 minutes of work. It's about balance. ⚖️",
        "You look stressed. Have you tried purring? It's been shown to lower heart rate. My heart rate, specifically.",
        "Is that a textbook or a doorstop? The line is often blurry. 🤔",
        "The key to productivity is a well-placed nap on the keyboard. It forces a mandatory break.",
        "You're still here? I admire your dedication. I would have taken a nap three lectures ago.",

        // --- Grade & Course Commentary ---
        "A CC grade? Excellent. It obviously stands for 'Cat Companion' approved. 👍",
        "Don't worry about that quiz score. The only thing that truly matters is the structural integrity of this cardboard box.",
        "That final exam percentage looks... significant. 😬",
        "Final exam coming up? Sounds stressful. You should probably pet me. It helps.",
        "Ah, the homework section. Also known as the 'generous donation to my nap-time-on-warm-laptop fund'.",

        // --- Technical "Support" ---
        "Psst. I helped build this page... mostly by sitting on the keyboard.",
        "I'm not sleeping, I'm compiling. It's a very complex process. ⏳",
        "Your computer is warm. This is good. It is performing its primary function as a heated bed.",
        "I have de-bugged your code by chasing the cursor. You're welcome. 😼",
        "The page is loading slowly because the data packets have to travel around me. I am a significant physical object.",
        "I've optimized the CSS. By sleeping on the warm laptop, I prevented the human from adding more `!important` tags.",

        // --- Sassy & Interactive ---
        "Go on, click me again. I dare you. 👀",
        "I am not a button. I am a supervisor. Please show some respect.",
        "Was that click necessary? I was in the middle of a very important... thought. 🤫",
        "Ah, the human requires attention. A brief scratch behind the ears would be an acceptable offering. 👑",
        "That clicking sound from your keyboard is disrupting my nap. Please type softer.",
        "Don't worry, I'm supervising. Every click you make is being carefully monitored from this very comfortable spot.",

        // --- Philosophical Musings ---
        "The meaning of life is finding the perfect sunbeam. Everything else is just... filler. ☀️",
        "If I fits, I sits. This is the first law of feline physics.",
        "To nap, or not to nap? That is the question. And the answer is always to nap. 😌",
        "My bones are merely a suggestion. It allows for optimal napping positions.",
        "I think, therefore I am... sleepy. 🥱",

        // --- General Commentary ---
        "You work hard so I can live a life of leisure. I appreciate your contribution to my well-being.",
        "Alert! The red dot has been sighted. All other tasks are now low priority. 🔴",
        "Blinking slowly at you. That's a sign of trust, you know. 😉",
        "Need a study buddy? I'm available for moral support, provided it doesn't involve moving.",
        "I see the food bowl is only 98% full. We need to talk about these service levels. 📉",
        "Sunbeam detected on the floor. Relocating to primary charging station.",

        // --- Local Albanian Flavour ---
        "Kalofsh një ditë të bukur!",
        "Mirë se vjen!",
        "Suksese në provime! 🤞",
        "Si je? Shpresoj që ditën e ke pasur të mbarë.",
        "Mos u streso, bëj një pushim.",
        "Po vjen koha e kafes. ☕"
    ];

    const triggerCatInteraction = () => {
        // --- Easter Egg Logic ---
        const chance = 10000;
        const randomNumber = Math.floor(Math.random() * chance);

        if (randomNumber === 0) {
            window.open('https://youtu.be/dQw4w9WgXcQ', '_blank');
            return;
        }

        // A different message from the last one.
        let randomIndex;
        do {
            randomIndex = Math.floor(Math.random() * messages.length);
        } while (randomIndex === lastIndex && messages.length > 1);
        lastIndex = randomIndex;

        if (bubble.classList.contains('visible')) {
            // If already visible, just swap text immediately and reset the "hide" timer
            bubble.textContent = messages[randomIndex];
            clearTimeout(bubbleTimeout);

            bubbleTimeout = setTimeout(() => {
                bubble.classList.remove('visible');
            }, 6000);
        } else {
            // If hidden, perform the standard pop-in animation
            clearTimeout(animationTimeout);

            animationTimeout = setTimeout(() => {
                bubble.textContent = messages[randomIndex];
                bubble.classList.add('visible');
            }, 50);

            bubbleTimeout = setTimeout(() => {
                bubble.classList.remove('visible');
            }, 6000);
        }
    };

    cat.addEventListener('click', (event) => {
        event.stopPropagation();
        triggerCatInteraction();
    });

    cat.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); // Prevent page scroll on Space
            event.stopPropagation();
            triggerCatInteraction();
        }
    });

    // A click elsewhere closes the bubble.
    document.addEventListener('click', (event) => {
        if (bubble.classList.contains('visible') && !cat.contains(event.target)) {
            bubble.classList.remove('visible');
        }
    });
}

// Below 1400px the mobile menu button takes the cat's corner, so it perches on a module
// header instead: a zero-height sibling before that module (.cat-perched in main.css)
// that moves with the modules as they open, close or re-sort.
function positionCatCompanion() {
    const cat = document.getElementById('cat-companion');
    if (!cat) return;

    if (!window.matchMedia('(max-width: 1400px)').matches) {
        if (cat.classList.contains('cat-perched')) {
            cat.classList.remove('cat-perched');
            document.body.appendChild(cat); // restore fixed positioning's normal containing block
        }
        return;
    }

    // The lowest-numbered module, not the last in the DOM, which changes with the sort order.
    const modules = document.querySelectorAll('#course-content .module:not(.hidden)');
    let targetModule = null;
    let lowestOrder = Infinity;
    modules.forEach(m => {
        const num = parseInt((m.id || '').replace('module-', ''), 10);
        const order = isNaN(num) ? Infinity : num;
        if (order < lowestOrder) {
            lowestOrder = order;
            targetModule = m;
        }
    });
    if (!targetModule) targetModule = modules[modules.length - 1]; // no numeric ids at all

    if (!targetModule) {
        // No module to perch on (empty search results, etc.) — fall back to hidden.
        cat.classList.remove('cat-perched');
        document.body.appendChild(cat);
        return;
    }

    cat.classList.add('cat-perched');
    targetModule.parentNode.insertBefore(cat, targetModule);
}

/* Theme selector logic */
function setupThemeToggle() {
    const KEY = 'theme-preference';
    const ICON = document.getElementById('theme-toggle-icon');
    const BTN = document.getElementById('theme-toggle');
    const icons = { auto: 'fa-solid fa-adjust', light: 'fa-regular fa-sun', dark: 'fa-regular fa-moon' };

    const getSaved = () => courseStorage.getItem(KEY) || 'auto';

    const applyTheme = (pref) => {
        const html = document.documentElement;
        if (pref === 'auto') {
            html.removeAttribute('data-theme');
        } else {
            html.setAttribute('data-theme', pref);
        }
        courseStorage.setItem(KEY, pref);
        updateUI(pref);
        updateThemeColorMeta();
    };

    const updateUI = (pref) => {
        const oldIcon = document.getElementById('theme-toggle-icon');
        if (oldIcon) {
            const i = document.createElement('i');
            i.id = 'theme-toggle-icon';
            i.className = icons[pref] || icons.auto;
            i.setAttribute('aria-hidden', 'true');
            oldIcon.replaceWith(i);
        }
        if (BTN) {
            const label = pref.charAt(0).toUpperCase() + pref.slice(1);
            BTN.setAttribute('aria-label', `Theme: ${label}`);
            BTN.title = `Theme: ${label}`;
        }
    };

    const currentIsDark = () => {
        const forced = document.documentElement.getAttribute('data-theme');
        if (forced) return forced === 'dark';
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    };

    const updateThemeColorMeta = () => {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute('content', currentIsDark() ? '#000000' : '#ffffff');
        }
    };

    const initialPref = getSaved();
    applyTheme(initialPref);

    if (BTN) {
        BTN.addEventListener('click', () => {
            const currentPref = getSaved();
            const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

            let newPref;
            if (currentPref === 'auto') {
                // If we are in auto mode, switch to the opposite of the system theme
                newPref = isSystemDark ? 'light' : 'dark';
            } else {
                // If we are in a manual mode (light or dark), switch back to auto
                newPref = 'auto';
            }
            applyTheme(newPref);

            // Immediately recalculate custom colors since the theme flipped
            if (typeof window.forceThemeColorRefresh === 'function') {
                window.forceThemeColorRefresh();
            }
        });
    }

    // Listen for system theme changes to update UI if in auto mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (getSaved() === 'auto') {
            applyTheme('auto');
            // Re-apply courses theme to recalculate bright/dark contrast colors
            if (courseData.metadata && courseData.metadata.theme_colours) {
                applyColorTheme(courseData.metadata);
            }
        }
    });

    // Re-applies the course colours after a theme change.
    window.forceThemeColorRefresh = () => {
        if (courseData.metadata && courseData.metadata.theme_colours) {
            applyColorTheme(courseData.metadata);
        }
    };
}

function getFileTypeClass(iconClass) {
    if (!iconClass) return '';
    const icon = String(iconClass).toLowerCase();
    if (icon.includes('pdf')) return 'ft-pdf';
    if (icon.includes('word')) return 'ft-word';
    if (icon.includes('excel')) return 'ft-excel';
    if (icon.includes('csv')) return 'ft-csv';
    if (icon.includes('powerpoint')) return 'ft-powerpoint';
    if (icon.includes('image')) return 'ft-image';
    if (icon.includes('video')) return 'ft-video';
    if (icon.includes('audio')) return 'ft-audio';
    if (icon.includes('code')) return 'ft-code';
    if (icon.includes('zip') || icon.includes('archive')) return 'ft-zip';
    return '';
}

// Save and load module states
// Structure: { moduleId: { userInteracted: boolean, state: boolean, sheetDefault: string } }
function saveModuleState(moduleId, isExpanded, wasUserInteraction = false) {
    const cacheKey = `moduleStates_${currentCourse}`;
    let states = {};
    try {
        const saved = courseStorage.getItem(cacheKey);
        if (saved) states = JSON.parse(saved);
    } catch (e) { /* ignore parse errors */ }

    const module = document.getElementById(moduleId);
    const sheetDefault = module ? module.dataset.initiallyCollapsed : 'false';

    states[moduleId] = {
        state: isExpanded,
        userInteracted: wasUserInteraction || (states[moduleId]?.userInteracted || false),
        sheetDefault: sheetDefault
    };

    courseStorage.setItem(cacheKey, JSON.stringify(states));
}

function loadModuleStates() {
}

function applyModuleStates() {
    const cacheKey = `moduleStates_${currentCourse}`;
    let savedStates = null;
    try {
        const saved = courseStorage.getItem(cacheKey);
        if (saved) savedStates = JSON.parse(saved);
    } catch (e) { /* ignore parse errors */ }

    document.querySelectorAll('.module').forEach(module => {
        const moduleId = module.id;
        const currentSheetDefault = module.dataset.initiallyCollapsed || 'false';

        const cached = savedStates ? savedStates[moduleId] : null;

        // Which state applies:
        // 1. If no cached state, use sheet default
        // 2. If cached state exists but user never interacted, use sheet default
        // 3. If user interacted AND sheet default hasn't changed, use cached state
        // 4. If user interacted BUT sheet default changed, reset to new sheet default

        let useSheetDefault = true;

        if (cached && cached.userInteracted) {
            if (cached.sheetDefault === currentSheetDefault) {
                useSheetDefault = false;
                if (cached.state) {
                    module.classList.add('active');
                } else {
                    module.classList.remove('active');
                }
            }
        }

        if (useSheetDefault) {
            const isInitiallyCollapsed = currentSheetDefault === 'true';
            if (isInitiallyCollapsed) {
                module.classList.remove('active');
            } else {
                module.classList.add('active');
            }
        }
    });
}

function updateScrollFaders(el) {
    const scrollable = el.scrollWidth > el.clientWidth;
    el.classList.toggle('is-scrollable', scrollable);

    if (scrollable) {
        const atStart = el.scrollLeft < 5;
        const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 5;
        el.classList.toggle('at-start', atStart);
        el.classList.toggle('at-end', atEnd);
    } else {
        el.classList.remove('at-start', 'at-end');
    }
}

function initializeScrollFaders() {
    const scrollContainers = document.querySelectorAll('.course-buttons-container, .course-tabs-wrapper, .course-info, .course-actions, .materials-grid, .project-groups-grid, .skeleton-actions, .skeleton-tabs-wrapper, .skeleton-info-grid');
    scrollContainers.forEach(el => {
        updateScrollFaders(el);
        el.addEventListener('scroll', () => updateScrollFaders(el), { passive: true });
    });
}

function toggleModule(moduleEl) {
    const content = moduleEl.querySelector('.module-content');
    if (!content) return;

    // Clear any inline styles to ensure scrollHeight is accurate
    content.style.maxHeight = '';

    if (moduleEl.classList.contains('active')) {
        // Closing: from the current height to 0.
        content.style.maxHeight = content.scrollHeight + 'px';
        requestAnimationFrame(() => {
            content.style.maxHeight = '0px';
            moduleEl.classList.remove('active');
        });
        saveModuleState(moduleEl.id, false, true);
    } else {
        // Opening: to the full height, then 'none' so the content can resize.
        moduleEl.classList.add('active');
        content.style.maxHeight = content.scrollHeight + 'px';

        const handleTransitionEnd = () => {
            if (moduleEl.classList.contains('active')) {
                content.style.maxHeight = 'none';
            }
            content.removeEventListener('transitionend', handleTransitionEnd);
        };
        content.addEventListener('transitionend', handleTransitionEnd);
        saveModuleState(moduleEl.id, true, true);
    }
}

function checkUrlForCourse() {
    const hash = window.location.hash.substring(1);
    if (hash && hash !== 'module-') {
        courseStorage.setItem('urlSelectedCourse', hash);
    }
}

function darkenHex(hex, amount = 0.25) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = Math.max(0, Math.round(parseInt(hex.substring(0, 2), 16) * (1 - amount)));
    const g = Math.max(0, Math.round(parseInt(hex.substring(2, 4), 16) * (1 - amount)));
    const b = Math.max(0, Math.round(parseInt(hex.substring(4, 6), 16) * (1 - amount)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function lightenHex(hex, amount = 0.4) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = Math.min(255, Math.round(parseInt(hex.substring(0, 2), 16) + (255 - parseInt(hex.substring(0, 2), 16)) * amount));
    const g = Math.min(255, Math.round(parseInt(hex.substring(2, 4), 16) + (255 - parseInt(hex.substring(2, 4), 16)) * amount));
    const b = Math.min(255, Math.round(parseInt(hex.substring(4, 6), 16) + (255 - parseInt(hex.substring(4, 6), 16)) * amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function checkIsDarkActive() {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced) return forced === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyColorTheme(metadata) {
    if (metadata.theme_colours) {
        const isDark = checkIsDarkActive();
        // A copy: the cached course data must stay unchanged.
        const originalColors = metadata.theme_colours.split(',').map(c => c.trim());
        let colors = [...originalColors];

        // In dark mode, lighten slightly so colours stand out from the #121212 background.
        if (isDark) {
            colors = colors.map(c => lightenHex(c, 0.1));
        }

        if (colors.length >= 5) {
            document.body.setAttribute('data-theme-color', 'custom');
            document.documentElement.style.setProperty('--theme-primary', colors[0]);
            document.documentElement.style.setProperty('--theme-primary-dark', isDark ? lightenHex(colors[0], 0.2) : darkenHex(colors[0], 0.25));
            // Keep the header distinct regardless of theme
            if (isDark) {
                document.documentElement.style.setProperty('--course-header-bg1', darkenHex(colors[0], 0.4));
                document.documentElement.style.setProperty('--course-header-bg2', darkenHex(colors[0], 0.6));
            } else {
                document.documentElement.style.setProperty('--course-header-bg1', colors[0]);
                document.documentElement.style.setProperty('--course-header-bg2', darkenHex(colors[0], 0.25));
            }

            document.documentElement.style.setProperty('--theme-secondary', colors[1]);
            document.documentElement.style.setProperty('--theme-tertiary', colors[2]);
            document.documentElement.style.setProperty('--theme-accent', colors[3]);
            document.documentElement.style.setProperty('--theme-success', colors[4]);
        }
    } else {
        document.body.removeAttribute('data-theme-color');
        // Clear the previous course's colours.
        ['--theme-primary', '--theme-primary-dark', '--course-header-bg1', '--course-header-bg2', '--theme-secondary', '--theme-tertiary', '--theme-accent', '--theme-success'].forEach(prop => {
            document.documentElement.style.removeProperty(prop);
        });
    }

    const decorationContainer = document.getElementById('header-decoration');
    const newIconClass = metadata.header_decoration?.toLowerCase() || 'fa-square';
    if (decorationContainer.dataset.currentIcon === newIconClass) return;
    decorationContainer.dataset.currentIcon = newIconClass;
    decorationContainer.innerHTML = `<i class="fa-solid ${courseHtmlText(newIconClass)}"></i>`;
}

function showMainContent() {
    const loadingIndicator = document.getElementById('app-loading');
    const mainContainer = document.getElementById('main-container');
    if (loadingIndicator) {
        loadingIndicator.style.opacity = '0';
        setTimeout(() => { loadingIndicator.style.display = 'none'; }, 500);
    }
    if (mainContainer) {
        mainContainer.classList.remove('content-hidden');

        // Release the temporary minHeight locks placed by handleArchiveToggle
        const courseContent = document.getElementById('course-content');
        const courseButtons = document.getElementById('course-buttons-container');
        if (courseContent) courseContent.style.minHeight = '';
        if (courseButtons) courseButtons.style.minHeight = '';
    }
}

function initContainers() {
    const timetableContainer = document.getElementById('timetable-container');
    if (timetableContainer) {
        timetableContainer.style.display = 'none';
    }

    // Delegated once on the (never-replaced) container — safe across
    // every innerHTML swap loadTimetable() does inside it.
    const nativeContainer = document.getElementById('native-timetable-container');
    if (nativeContainer) {
        wireTimetableTooltips(nativeContainer);
    }

    // Re-fit the timetable, and re-check the cat's perch breakpoint, on resize / orientation change.
    let ttResizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(ttResizeTimer);
        ttResizeTimer = setTimeout(() => {
            const c = document.getElementById('native-timetable-container');
            if (c && c.classList.contains('visible')) fitTimetable(c);
            positionCatCompanion();
        }, 150);
    });
}

// The timetable/class pair currently shown (or being fetched); lets a
// late fetch response recognise it has been superseded or dismissed.
let activeTimetableKey = null;
// Bumped by every open, close and reset, so a close's delayed hide only acts if nothing
// happened since (a quick close, open, close otherwise cut the second collapse short).
let ttGeneration = 0;
const timetableKeyOf = btn => `${btn.dataset.timetableId || ''}::${btn.dataset.classId || ''}`;

// Remembers, per course, whether a timetable was left open and which one.
function saveTimetableState(open, index) {
    const cacheKey = `timetableState_${currentCourse}`;
    try {
        if (open) courseStorage.setItem(cacheKey, JSON.stringify({ open: true, index }));
        else courseStorage.removeItem(cacheKey);
    } catch (e) { /* ignore */ }
}

function restoreTimetableState() {
    let saved = null;
    try { saved = JSON.parse(courseStorage.getItem(`timetableState_${currentCourse}`)); } catch (e) { /* ignore */ }
    if (!saved || !saved.open) return;
    const btn = document.getElementById(`timetable-btn-${saved.index}`);
    if (btn) toggleTimetable(saved.index, btn.dataset.btnName || 'Timetable');
}

async function toggleTimetable(index, btnName) {
    const timetableContainer = document.getElementById("timetable-container");
    const container = document.getElementById("native-timetable-container");
    const inner = container.querySelector('.tt-inner');

    const clickedButton = document.getElementById(`timetable-btn-${index}`);
    const targetTimetableId = clickedButton.dataset.timetableId;
    const targetClassId = clickedButton.dataset.classId;

    const isCurrentlyActive = clickedButton.classList.contains('active');
    const allTimetableBtns = document.querySelectorAll('.timetable-btn');
    const generation = ++ttGeneration;

    if (isCurrentlyActive) {
        // Hide the open timetable.
        activeTimetableKey = null;
        saveTimetableState(false);
        hideTtPopover();
        container.classList.remove('visible'); // animates the collapse
        clickedButton.classList.remove('active');

        // Wait for the collapse transition itself before display:none: a timer matching the
        // CSS duration fires early under load. The fallback covers a transition that never
        // fires (reduced motion).
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            container.removeEventListener('transitionend', onEnd);
            clearTimeout(fallback);
            // Only fully hide if nothing was opened (or closed again) during the collapse.
            if (generation === ttGeneration && !activeTimetableKey) timetableContainer.style.display = 'none';
        };
        const onEnd = e => { if (e.target === container && e.propertyName === 'grid-template-rows') finish(); };
        container.addEventListener('transitionend', onEnd);
        const fallback = setTimeout(finish, 600);
        return;
    }

    // Show or switch.
    allTimetableBtns.forEach(btn => btn.classList.remove('active'));
    clickedButton.classList.add('active');

    const requestKey = timetableKeyOf(clickedButton);
    activeTimetableKey = requestKey;
    saveTimetableState(true, index);

    timetableContainer.style.display = '';
    inner.innerHTML = '<div class="iframe-loader"></div>';
    // Commit the collapsed (0fr) state before .visible opens it, or the browser skips the
    // animation (rAF alone is unreliable after display:none).
    void container.offsetHeight;
    container.classList.add('visible');

    try {
        // A public Supabase Edge Function (verify_jwt off) proxies EIS, which sends no CORS
        // headers, and returns the table. The headers only match the page's other calls.
        const response = await fetch(
            `${SUPABASE_URL}/functions/v1/eis-timetable?tId=${encodeURIComponent(targetTimetableId || '')}&cId=${encodeURIComponent(targetClassId || '')}${lecturerSite ? '&lecturer=' + encodeURIComponent(lecturerSite.id) : ''}`,
            { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
        );
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const html = await response.text();
        // The user may have switched timetables (or closed this one)
        // while the request was in flight — drop stale responses.
        if (activeTimetableKey !== requestKey) return;
        if (!html.includes('<table')) {
            inner.innerHTML = html.includes('tt-error')
                ? DOMPurify.sanitize(html)
                : '<div class="tt-error">No timetable found for this class.</div>';
            return;
        }
        // The proxy only strips <script>; this is the real sanitising. FORCE_BODY keeps the
        // allowed <style> tags, which DOMPurify otherwise drops from a fragment.
        inner.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
        fitTimetable(container);
    } catch (error) {
        console.error('Timetable load error:', error);
        if (activeTimetableKey !== requestKey) return;
        inner.innerHTML = '<div class="tt-error">Could not load the timetable. Please try again later.</div>';
    }
}

function initBackend() {
    // The message also clears the loading skeleton, which otherwise stays up.
    const fail = () => {
        showSiteMessage('Courses unavailable', 'Please try again shortly.', true);
        showImprovedNotification('error', 'Connection Error', 'Failed to connect to backend.');
    };
    tryPublicAccess().then(success => {
        if (success) showMainContent(); else fail();
    }).catch(fail);
}

function selectInitialCourse() {
    if (availableCourses.length === 0) return;
    const urlCourse = courseStorage.getItem('urlSelectedCourse');
    const prefix = isArchiveMode ? 'archive_' : 'active_';
    const lastCourse = courseStorage.getItem(prefix + 'lastSelectedCourse');

    // The requested course, one carried over a tryPublicAccess() reload, then the last
    // course in this mode.
    const hash = lecturerSite ? matchSiteCourse(requestedCourse()) : requestedCourse();

    selectCourse(
        (hash && availableCourses.includes(hash)) ? hash :
            (urlCourse && availableCourses.includes(urlCourse) ? urlCourse :
                (lastCourse && availableCourses.includes(lastCourse) ? lastCourse : availableCourses[0]))
    );
    courseStorage.removeItem('urlSelectedCourse');
}

async function tryPublicAccess() {
    const sequence = ++catalogSequence;
    const archive = isArchiveMode;
    try {
        const rows = await fetchPublicCatalog();
        if (sequence !== catalogSequence || archive !== isArchiveMode) return true;

        const seen = new Set();
        availableCourses = [];
        const codes = {};
        const years = {};
        const semesters = {};
        const icons = {};
        const titles = {};
        rows.forEach(r => {
            if (!seen.has(r.sheet_name)) { seen.add(r.sheet_name); availableCourses.push(r.sheet_name); }
            const bKey = String(r.b || '').trim().toLowerCase();
            if (bKey === 'code') codes[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'year') years[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'semester') semesters[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'header_decoration') icons[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'title') titles[r.sheet_name] = String(r.c || '').trim();
        });

        Object.assign(courseMap, codes);
        Object.assign(courseYearMap, years);
        Object.assign(courseSemesterMap, semesters);
        Object.assign(courseIconMap, icons);
        Object.assign(courseTitleMap, titles);
        availableCourses.sort((a, b) => courseOrder(a, b));
        try {
            courseStorage.setItem(getCachePrefix() + 'courseCodesCache', JSON.stringify({
                codes, years, semesters, icons, titles, timestamp: Date.now()
            }));
        } catch (e) { }

        await populateCourseButtons();
        if (sequence !== catalogSequence || archive !== isArchiveMode) return true;

        if (lecturerSite) {
            const requested = requestedCourse();
            if (requested && !matchSiteCourse(requested)) {
                if (!isArchiveMode && !new URLSearchParams(location.search).has('archive')) {
                    const archived = await TeachingSites.rows(lecturerSite, true);
                    if (sequence !== catalogSequence || archive !== isArchiveMode) return true;
                    const codes = {};
                    for (const row of archived) {
                        if (String(row.b).trim().toLowerCase() === 'code') codes[row.sheet_name] = row.c;
                    }
                    if (matchSiteCourse(requested, [...new Set(archived.map(row => row.sheet_name))], codes)) {
                        isArchiveMode = true;
                        const url = new URL(location.href); url.searchParams.set('archive', '');
                        history.replaceState({ archive: true }, '', url);
                        resetForModeSwitch(); return true;
                    }
                }
                showSiteMessage('Course not available', 'Choose a course above or return to the course list.');
                return true;
            }
        }

        const hash = requestedCourse();
        if (!lecturerSite && hash && !availableCourses.includes(hash)) {
            if (!isArchiveMode && !new URLSearchParams(window.location.search).has('archive')) {
                isArchiveMode = true;
                const url = new URL(window.location);
                url.searchParams.set('archive', '');
                let newUrlString = url.toString().replace(/archive=(&|$)/, 'archive$1');
                window.history.replaceState({ archive: true }, '', newUrlString || url);
                resetForModeSwitch();
                return true;
            }
        }

        // Nothing to list: offer the current courses, or everyone's on the Syllabase homepage.
        if (!availableCourses.length) {
            if (isArchiveMode) {
                showSiteMessage('No archived courses', 'Past courses will appear here once archived.', false,
                    { label: 'Current courses', onclick: handleArchiveToggle });
            } else {
                showSiteMessage('No active courses', 'Courses will appear here when assigned.', false,
                    { label: 'Browse all courses', onclick: () => { location.href = window.TEACHING_CONFIG.appBaseUrl; } });
            }
            return true;
        }

        selectInitialCourse();
        return true;
    } catch (error) {
        console.error('Error during Supabase access:', error);
        return sequence !== catalogSequence || archive !== isArchiveMode;
    }
}

const SUPABASE_URL = window.TEACHING_CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = window.TEACHING_CONFIG.supabaseAnonKey;

// action: { label, onclick } replaces the default button (Try again, or Course list).
function showSiteMessage(title, message, retry = false, action = null) {
    ++courseViewSequence;
    currentCourse = '';
    document.body.classList.add('teaching-empty', 'theme-ready');
    document.body.classList.remove('is-loading', 'is-switching');
    document.getElementById('course-code').textContent = lecturerSite?.display_name || window.TEACHING_CONFIG.owner?.name || '';
    document.getElementById('course-title').textContent = title;
    const decoration = document.getElementById('header-decoration');
    decoration.replaceChildren();
    delete decoration.dataset.currentIcon;
    const content = document.getElementById('course-content');
    const cat = document.getElementById('cat-companion');
    if (cat && content.contains(cat)) document.body.appendChild(cat);
    const detail = document.createElement('p'); detail.className = 'teaching-site-message'; detail.textContent = message;
    const button = document.createElement('button'); button.textContent = action?.label || (retry ? 'Try again' : 'Course list');
    button.onclick = action?.onclick || (() => {
        history.replaceState({ archive: isArchiveMode }, '', (lecturerSite?.base_path || location.pathname) + location.search);
        resetForModeSwitch();
    });
    content.replaceChildren(detail, button);
    document.title = title;
    showMainContent();
}

// Both catalogs are limited to their owner's assigned courses: a lecturer's
// website to theirs, and the central page to the configured admin's.
function fetchPublicCatalog() {
    return lecturerSite ? TeachingSites.rows(lecturerSite, isArchiveMode) : TeachingSites.centralRows(isArchiveMode);
}

// Lecturers assigned in Settings ([{ name, photo }]), or null if unavailable; the header
// then falls back to the lecturer entries stored with the course.
async function fetchCourseLecturers(sheetName) {
    try {
        const rows = await TeachingSites.rpc('teaching_lecturers', { p_sheet_name: sheetName, p_archive: isArchiveMode });
        return Array.isArray(rows) ? rows.map(r => ({ name: r.name, photo: r.photo || '' })) : null;
    } catch { return null; }
}

async function fetchPublicSheetData(sheetName) {
    const rows = await (lecturerSite ? TeachingSites.rows(lecturerSite, isArchiveMode, sheetName) :
        TeachingSites.centralRows(isArchiveMode, sheetName));
    return rows.map(r => [r.type, r.b, r.c, r.d, r.e, r.f, r.g, r.h, r.i, r.j]);
}

function yearStart(y) {
    const m = String(y || '').match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : -1;
}

// Course order, shared with the admin sidebar and Settings: newest academic year first,
// then Summer → Spring → Fall, then course number with the code's letters as tie-break
// (CE 123, ARCH 203, CE 345). Courses without a year or semester come last.
const SEMESTER_ORDER = ['Summer', 'Spring', 'Fall'];
function semesterRank(s) {
    const m = String(s || '').match(/^\s*(Fall|Spring|Summer)/);
    const i = m ? SEMESTER_ORDER.indexOf(m[1]) : -1;
    return i === -1 ? SEMESTER_ORDER.length : i;
}
function courseOrder(a, b, useCourseMap = true) {
    return (yearStart(courseYearMap[b]) - yearStart(courseYearMap[a]))
        || (semesterRank(courseSemesterMap[a]) - semesterRank(courseSemesterMap[b]))
        || compareCourseCodes(useCourseMap ? (courseMap[a] || a) : a, useCourseMap ? (courseMap[b] || b) : b);
}

// Strips academic and professional titles (Prof., Dr., Assoc., Acad., MSc., Mr., Ms., Mrs. and combinations)
function stripTitles(str) {
    let s = String(str || '').trim();
    const titleToken = /\b(?:Prof(?:essor)?|Dr|Assoc(?:\.?\s*Prof(?:essor)?)?|Acad(?:emician)?|M\.?Sc|Mr|Ms|Mrs)\.?/i;
    const titlePattern = new RegExp(`^(?:${titleToken.source}\\s*)+`, 'i');
    const stripped = s.replace(titlePattern, '').trim();
    return stripped || s;
}

// Extracts the course number (e.g. 211 from "CE 211") and prefix text (e.g. "CE").
function parseCourseCode(str) {
    const s = String(str || '').trim();
    const cleanStr = stripTitles(s);
    const match = cleanStr.match(/^(.*?)(?:[\s\-_]*)(\d+)(.*)$/);
    if (match) {
        const prefix = match[1].trim();
        const num = parseInt(match[2], 10);
        const suffix = match[3].trim();
        const text = [prefix, suffix].filter(Boolean).join(' ').trim();
        return {
            hasNum: true,
            num,
            text: text || cleanStr,
            raw: s,
            clean: cleanStr,
        };
    }
    return {
        hasNum: false,
        num: Infinity,
        text: cleanStr,
        raw: s,
        clean: cleanStr,
    };
}

function compareCourseCodes(aCode, bCode) {
    // Cross-listed codes ("SWE / CE 101") come after all single codes, A–Z among themselves.
    const crossA = String(aCode || '').includes('/'), crossB = String(bCode || '').includes('/');
    if (crossA !== crossB) return crossA ? 1 : -1;
    if (crossA) return String(aCode).localeCompare(String(bCode), undefined, { numeric: true, sensitivity: 'base' });
    const a = parseCourseCode(aCode);
    const b = parseCourseCode(bCode);

    if (a.hasNum && b.hasNum) {
        if (a.num !== b.num) return a.num - b.num;
        const textCmp = a.text.localeCompare(b.text, undefined, { sensitivity: 'base' });
        if (textCmp !== 0) return textCmp;
        return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
    }

    if (a.hasNum && !b.hasNum) return -1;
    if (!a.hasNum && b.hasNum) return 1;

    const cleanCmp = a.clean.localeCompare(b.clean, undefined, { numeric: true, sensitivity: 'base' });
    if (cleanCmp !== 0) return cleanCmp;

    return a.raw.localeCompare(b.raw, undefined, { numeric: true, sensitivity: 'base' });
}

function formatCourseCode(code) {
    return code.replace(/_/g, ' ');
}

async function populateCourseButtons() {
    const sequence = catalogSequence;
    const archive = isArchiveMode;
    const container = document.getElementById('course-buttons-container');
    if (!container) return;
    container.innerHTML = '';
    // A selected tab grows to its full course name and the previous one shrinks back,
    // which can change how the tabs wrap: re-round the rows once that settles, and
    // bring the grown tab into view when the tab bar scrolls sideways (mobile).
    if (!container._tabGrowth) {
        container._tabGrowth = true;
        container.addEventListener('transitionend', event => {
            if (event.propertyName !== 'grid-template-columns' || !event.target.classList.contains('course-button-full')) return;
            const wrapper = event.target.closest('.course-tabs-wrapper');
            if (!wrapper) return;
            updateButtonRows(wrapper);
            updateScrollFaders(wrapper);
            const button = event.target.closest('.course-button.active');
            if (button && wrapper.scrollWidth > wrapper.clientWidth) {
                button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            }
        });
    }

    const createCourseButton = (sheetName, label) => {
        const button = document.createElement('div');
        button.setAttribute('class', 'course-button' + (currentCourse === sheetName ? ' active' : ''));
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        // The course's own header icon (or the generic list icon), then its code. The
        // selected tab drops the icon (the header already shows it) and grows to show
        // the full course name in place of the code.
        const icon = /^[a-z0-9 -]+$/i.test(courseIconMap[sheetName] || '') ? courseIconMap[sheetName].toLowerCase() : 'fa-th-list';
        const code = formatCourseCode(label);
        const title = (courseTitleMap[sheetName] || '').trim();
        const full = title && title.toLowerCase() !== code.toLowerCase() ? title : '';
        button.classList.toggle('has-full-name', !!full);
        if (full) button.title = `${code} ${full}`;
        button.innerHTML = `<i class="fa-solid ${courseHtmlText(icon)} fa-fw course-button-icon" aria-hidden="true"></i>` +
            `<span class="course-button-label"><span class="course-button-swap course-button-code"><span>${courseHtmlText(code)}</span></span>` +
            (full ? `<span class="course-button-swap course-button-full"><span>${courseHtmlText(full)}</span></span>` : '') + `</span>`;
        button.dataset.sheet = sheetName;
        button.onclick = () => selectCourse(sheetName);
        return button;
    };

    const createArchiveButton = () => {
        const button = document.createElement('div');
        button.setAttribute('class', 'course-button archive-course-btn');
        button.setAttribute('role', 'button');
        button.tabIndex = 0;

        if (isArchiveMode) {
            button.innerHTML = `<i class="fa-solid fa-arrow-left"></i><span>&nbsp; Back</span>`;
            button.title = 'Back to Active Courses';
            button.style.backgroundColor = 'transparent';
            button.style.border = '1.5px solid var(--primary-color)';
            button.style.color = 'var(--primary-color)';
            button.style.boxShadow = 'none';
        } else {
            button.innerHTML = `<i class="fa-solid fa-box-archive"></i><span class="desktop-only">&nbsp; Archives</span>`;
            button.title = 'View Past Courses';
            button.style.backgroundColor = 'transparent';
            button.style.border = '1px solid #e0e0e0';
            button.style.color = '#757575';
            button.style.boxShadow = 'none';
        }

        button.onclick = handleArchiveToggle;
        button.setAttribute('aria-label', button.title); // Phones hide the label text.
        return button;
    };

    const updateFaderForButtons = () => {
        container.querySelectorAll('.course-tabs-wrapper').forEach(tabsWrapper => {
            updateScrollFaders(tabsWrapper);
        });
    };

    const renderButtons = (useCourseMap) => {
        container.innerHTML = '';

        if (!isArchiveMode) {
            container.classList.remove('is-archive-mode');
            const archiveBtn = createArchiveButton();

            availableCourses.sort((a, b) => courseOrder(a, b, useCourseMap));

            const tabsWrapper = document.createElement('div');
            tabsWrapper.setAttribute('class', 'course-tabs-wrapper');
            tabsWrapper.addEventListener('scroll', () => updateScrollFaders(tabsWrapper), { passive: true });

            availableCourses.forEach((sheetName, index) => {
                const label = useCourseMap ? (courseMap[sheetName] || sheetName) : sheetName;
                const btn = createCourseButton(sheetName, label);

                if (availableCourses.length === 1) {
                    btn.style.borderRadius = '20px';
                } else {
                    if (index === 0) btn.style.borderRadius = '20px 8px 8px 20px';
                    if (index === availableCourses.length - 1) btn.style.borderRadius = '8px 20px 20px 8px';
                }

                tabsWrapper.appendChild(btn);
            });

            if (archiveBtn) archiveBtn.style.marginLeft = '2px';
            container.appendChild(tabsWrapper);
            if (archiveBtn) container.appendChild(archiveBtn);

            updateFaderForButtons();

            if (!tabsWrapper._resizeObserver) {
                tabsWrapper._resizeObserver = new ResizeObserver(() => updateButtonRows(tabsWrapper));
                tabsWrapper._resizeObserver.observe(tabsWrapper);
            } else {
                updateButtonRows(tabsWrapper);
            }
        } else {
            // Archive: grouped by academic year, newest first.
            container.classList.add('is-archive-mode');

            // Top navigation bar with the Back button
            const navBar = document.createElement('div');
            navBar.className = 'archive-nav-bar';
            const backBtn = createArchiveButton();
            navBar.appendChild(backBtn);
            container.appendChild(navBar);

            const yearGroups = {};
            availableCourses.forEach(sheetName => {
                const yr = (courseYearMap[sheetName] || '').trim() || 'Other';
                if (!yearGroups[yr]) yearGroups[yr] = [];
                yearGroups[yr].push(sheetName);
            });

            const sortedYears = Object.keys(yearGroups).sort((a, b) => {
                const yA = yearStart(a);
                const yB = yearStart(b);
                if (yA !== yB) return yB - yA;
                return a.localeCompare(b);
            });

            const yearsContainer = document.createElement('div');
            yearsContainer.className = 'archive-years-container';

            sortedYears.forEach(yr => {
                const courses = yearGroups[yr];
                courses.sort((a, b) => courseOrder(a, b, useCourseMap));

                const yearGroup = document.createElement('div');
                yearGroup.className = 'archive-year-group';

                const yearLabel = document.createElement('div');
                yearLabel.className = 'archive-year-label';
                yearLabel.innerHTML = `<i class="fa-regular fa-calendar"></i> `;
                yearLabel.append(document.createTextNode(yr));
                yearGroup.appendChild(yearLabel);

                const tabsWrapper = document.createElement('div');
                tabsWrapper.className = 'course-tabs-wrapper';
                tabsWrapper.addEventListener('scroll', () => updateScrollFaders(tabsWrapper), { passive: true });

                courses.forEach((sheetName, index) => {
                    const label = useCourseMap ? (courseMap[sheetName] || sheetName) : sheetName;
                    const btn = createCourseButton(sheetName, label);

                    if (courses.length === 1) {
                        btn.style.borderRadius = '20px';
                    } else {
                        if (index === 0) btn.style.borderRadius = '20px 8px 8px 20px';
                        if (index === courses.length - 1) btn.style.borderRadius = '8px 20px 20px 8px';
                    }

                    tabsWrapper.appendChild(btn);
                });

                yearGroup.appendChild(tabsWrapper);
                yearsContainer.appendChild(yearGroup);

                if (!tabsWrapper._resizeObserver) {
                    tabsWrapper._resizeObserver = new ResizeObserver(() => updateButtonRows(tabsWrapper));
                    tabsWrapper._resizeObserver.observe(tabsWrapper);
                } else {
                    updateButtonRows(tabsWrapper);
                }
            });

            container.appendChild(yearsContainer);
            updateFaderForButtons();
        }
    };

    try {
        await fetchCourseCodes();
        if (sequence !== catalogSequence || archive !== isArchiveMode) return;
        renderButtons(true);
    } catch (err) {
        renderButtons(false);
    }
}

// Dynamically tags info-item chips in .course-info by which visual row they sit on
function updateInfoItemRows() {
    const courseInfoEl = document.getElementById('course-info');
    if (!courseInfoEl) return;

    // Collect ALL .info-item descendants (professors-container has display:contents
    // so its children participate in the same flex row as the direct .info-item spans)
    const items = Array.from(courseInfoEl.querySelectorAll('.info-item'))
        .filter(el => el.offsetParent !== null);

    items.forEach(el => {
        el.classList.remove('first-in-row', 'last-in-row', 'only-in-row', 'middle-in-row');
    });

    if (items.length === 0) return;

    // Group by offsetTop (fuzzy ±5px for subpixel zoom)
    const rows = {};
    items.forEach(el => {
        const top = el.offsetTop;
        const existingKey = Object.keys(rows).find(k => Math.abs(parseInt(k) - top) < 5);
        if (existingKey) {
            rows[existingKey].push(el);
        } else {
            rows[top] = [el];
        }
    });

    const rowArrays = Object.values(rows);
    rowArrays.sort((a, b) => a[0].offsetTop - b[0].offsetTop);

    rowArrays.forEach((rowItems, index) => {
        if (rowItems.length === 1) {
            rowItems[0].classList.add(index === 0 ? 'only-in-row' : 'middle-in-row');
        } else {
            rowItems[0].classList.add('first-in-row');
            rowItems[rowItems.length - 1].classList.add('last-in-row');
        }
    });
}

// Dynamically tags buttons that fall onto new lines so CSS can round their outer edges
function updateButtonRows(container) {
    const buttons = Array.from(container.children).filter(b => b.style.display !== 'none');
    if (buttons.length === 0) return;

    buttons.forEach(b => {
        b.classList.remove('first-in-row', 'last-in-row', 'only-in-row', 'grow-row', 'middle-in-row');
    });

    // Group by vertical position, with a tolerance for subpixel zoom.
    const rows = {};
    buttons.forEach(btn => {
        const top = btn.offsetTop;
        const existingRowKey = Object.keys(rows).find(k => Math.abs(parseInt(k) - top) < 5);

        if (existingRowKey) {
            rows[existingRowKey].push(btn);
        } else {
            rows[top] = [btn];
        }
    });

    const rowArrays = Object.values(rows);
    rowArrays.sort((a, b) => a[0].offsetTop - b[0].offsetTop);

    rowArrays.forEach((rowButtons, index) => {
        if (rowButtons.length === 1) {
            if (index === 0) {
                rowButtons[0].classList.add('only-in-row'); // Fully round isolated buttons on first line
            } else {
                rowButtons[0].classList.add('middle-in-row'); // Treat solitary wrapped buttons as middle
            }
        } else if (rowButtons.length > 1) {
            rowButtons[0].classList.add('first-in-row');
            rowButtons[rowButtons.length - 1].classList.add('last-in-row');
        }
    });
}

async function fetchCourseCodes() {
    const sequence = catalogSequence;
    const archive = isArchiveMode;
    const prefix = getCachePrefix();
    const CACHE_KEY = prefix + 'courseCodesCache';
    const CACHE_EXPIRY = 5 * 60 * 1000;

    try {
        const cached = courseStorage.getItem(CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed.codes && Date.now() - parsed.timestamp < CACHE_EXPIRY) {
                Object.assign(courseMap, parsed.codes);
                if (parsed.years) Object.assign(courseYearMap, parsed.years);
                if (parsed.semesters) Object.assign(courseSemesterMap, parsed.semesters);
                if (parsed.icons) Object.assign(courseIconMap, parsed.icons);
                if (parsed.titles) Object.assign(courseTitleMap, parsed.titles);
                return courseMap;
            } else if (parsed.data && Date.now() - parsed.timestamp < CACHE_EXPIRY) {
                Object.assign(courseMap, parsed.data);
                return courseMap;
            }
        }
    } catch (e) { }

    try {
        const rows = await fetchPublicCatalog();
        if (sequence !== catalogSequence || archive !== isArchiveMode) return courseMap;
        const codes = {};
        const years = {};
        const semesters = {};
        const icons = {};
        const titles = {};
        rows.forEach(r => {
            const bKey = String(r.b || '').trim().toLowerCase();
            if (bKey === 'code') codes[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'year') years[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'semester') semesters[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'header_decoration') icons[r.sheet_name] = String(r.c || '').trim();
            if (bKey === 'title') titles[r.sheet_name] = String(r.c || '').trim();
        });
        Object.assign(courseMap, codes);
        Object.assign(courseYearMap, years);
        Object.assign(courseSemesterMap, semesters);
        Object.assign(courseIconMap, icons);
        Object.assign(courseTitleMap, titles);
        try {
            courseStorage.setItem(CACHE_KEY, JSON.stringify({
                codes, years, semesters, icons, titles, timestamp: Date.now()
            }));
        } catch (e) { }
        return courseMap;
    } catch (error) {
        console.error('Course codes fetch failed:', error);
    }

    availableCourses.forEach(sheetName => { if (!courseMap[sheetName]) courseMap[sheetName] = sheetName; });
    return courseMap;
}

function setupSearchFilter() {
    const searchBar = document.getElementById('search-bar');
    if (!searchBar) return;

    searchBar.addEventListener('input', () => {
        const query = searchBar.value.toLowerCase().trim();
        const modules = document.querySelectorAll('.module');

        let visibleModules = 0;
        modules.forEach(module => {
            const moduleTitle = module.querySelector('.module-title')?.textContent.toLowerCase() || '';
            const materialCards = module.querySelectorAll('.material-card');
            let hasMatch = moduleTitle.includes(query);

            materialCards.forEach(card => {
                const materialTitle = card.querySelector('.material-title')?.textContent.toLowerCase() || '';
                const materialDesc = card.querySelector('.material-description')?.textContent.toLowerCase() || '';
                if (materialTitle.includes(query) || materialDesc.includes(query)) {
                    hasMatch = true;
                }
            });

            const projectGroupCards = module.querySelectorAll('.project-group-card');
            projectGroupCards.forEach(card => {
                const topic = card.querySelector('.project-group-title')?.textContent.toLowerCase() || '';
                const description = card.querySelector('.project-group-description')?.textContent.toLowerCase() || '';
                if (topic.includes(query) || description.includes(query)) {
                    hasMatch = true;
                }
            });

            if (hasMatch) {
                module.classList.remove('hidden');
                visibleModules++;
            } else {
                module.classList.add('hidden');
            }
        });

        let noResultsEl = document.getElementById('no-search-results');
        if (visibleModules === 0 && !noResultsEl) {
            noResultsEl = document.createElement('div');
            noResultsEl.id = 'no-search-results';
            noResultsEl.setAttribute('class', 'empty-content');
            noResultsEl.innerHTML = '<i class="fa-solid fa-search"></i><br>No modules match your search.';
            document.getElementById('course-content').appendChild(noResultsEl);
        } else if (visibleModules > 0 && noResultsEl) {
            noResultsEl.remove();
        }

        positionCatCompanion();
    });
}

function selectCourse(sheetName) {
    if (lecturerSite && !availableCourses.includes(sheetName)) return;
    if (lecturerSite && !currentCourse) document.body.classList.add('is-loading');
    document.body.classList.remove('teaching-empty');
    const sequence = ++courseViewSequence;
    const archive = isArchiveMode;
    courseHeaderAnimation?.cancel();
    // If not the initial load, start the loading state
    if (currentCourse) {
        document.body.classList.add('is-switching');
    }
    document.body.classList.remove('theme-ready'); // Hide themed elements to prevent flash

    const prefix = isArchiveMode ? 'archive_' : 'active_';
    courseStorage.setItem(prefix + 'lastSelectedCourse', sheetName);
    currentCourse = sheetName;
    if (lecturerSite) {
        const path = lecturerSite.base_path + window.location.search + '#' + encodeURIComponent(sheetName);
        if (location.pathname !== lecturerSite.base_path) history.replaceState({ archive: isArchiveMode }, '', path);
        else if (location.hash !== '#' + encodeURIComponent(sheetName)) history.pushState({ archive: isArchiveMode }, '', path);
    } else window.location.hash = sheetName;

    // Remove fab-visible so it re-animates on new course load
    const fabEl = document.getElementById('mobile-fab');
    if (fabEl) fabEl.classList.remove('fab-visible');

    resetUIElements();
    document.querySelectorAll('.course-button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sheet === sheetName);
    });

    fetchCourseData(sheetName).then(async data => {
        if (sequence !== courseViewSequence || archive !== isArchiveMode) return;
        if (data) {
            Object.assign(courseData, data);
            window.currentCourseData = data; // Expose globally for dismissal re-renders

            let titleBase = data.metadata.code ? `${formatCourseCode(data.metadata.code)} ${data.metadata.title || 'Course'}` : 'Course Materials';
            let announcementCount = 0;
            document.title = titleBase;

            updateCourseMetadata(data.metadata, data.lecturers);
            populateActionButtons(data.actionButtons, data.metadata);
            restoreTimetableState();
            applyColorTheme(data.metadata);
            renderAnnouncements(data.announcements);
            loadExamSchedule(sheetName, sequence, archive);
            setupSortAndRender();

            // Complete the header's icon layout before revealing its title and metadata.
            const header = document.getElementById('course-header');
            try { await window.FontAwesome?.dom?.i2svg({ node: header }); } catch { }
            if (sequence !== courseViewSequence || archive !== isArchiveMode) return;
            updateInfoItemRows();
            document.body.classList.add('theme-ready');
            document.body.classList.remove('is-loading');
            document.body.classList.remove('is-switching');
            if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                courseHeaderAnimation = header.animate([
                    { opacity: 0, transform: 'translateY(12px)' },
                    { opacity: 1, transform: 'translateY(0)' }
                ], { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' });
            }

            setTimeout(() => {
                if (sequence !== courseViewSequence || archive !== isArchiveMode) return;
                const cat = document.getElementById('cat-companion');
                if (cat) cat.classList.add('visible');

                const fab = document.getElementById('mobile-fab');
                if (fab && !fab.classList.contains('nav-hidden')) fab.classList.add('fab-visible');

            }, 250); // Lets rendering finish first.

            // Prefetch other courses in background for faster switching
            setTimeout(() => {
                if (sequence !== courseViewSequence || archive !== isArchiveMode) return;
                availableCourses.forEach(c => {
                    if (c !== sheetName && !courseDataCache[getCachePrefix() + c]) fetchCourseData(c).catch(() => { });
                });
            }, 1000);
        } else {
            document.body.classList.remove('is-switching');
            if (lecturerSite) showSiteMessage('Course not available', 'This course may have been moved or unassigned.', true);
        }
    }).catch(() => {
        if (sequence !== courseViewSequence || archive !== isArchiveMode) return;
        document.body.classList.remove('is-switching');
        if (lecturerSite) showSiteMessage('Course unavailable', 'Please try again shortly.', true);
    });
}

function setupSortAndRender() {
    const sortButton = document.getElementById('sort-button');
    if (!sortButton) return;

    // Modules sort by their ID (number).
    const getSortableValue = (module) => {
        if (module.id) {
            const num = parseInt(module.id, 10);
            return isNaN(num) ? Infinity : num;
        }
        return Infinity;
    };

    const sortModules = (order) => {
        courseData.modules.sort((a, b) => {
            const valA = getSortableValue(a);
            const valB = getSortableValue(b);
            if (order === 'asc') return valA - valB;
            else return valB - valA;
        });
    };

    const renderContent = () => {
        const contentDiv = document.getElementById('course-content');
        // A perched cat lives inside contentDiv, about to be replaced: move it out first;
        // positionCatCompanion() re-perches it below.
        const perchedCat = document.getElementById('cat-companion');
        if (perchedCat && perchedCat.parentElement === contentDiv) {
            document.body.appendChild(perchedCat);
        }
        contentDiv.innerHTML = generateCourseContentHtml(courseData.modules);
        document.querySelectorAll('.module-header').forEach(header => {
            // toggleModule() saves the new state itself. Saving again here would still see
            // 'active' on a closing module (removed in a later frame) and undo the collapse.
            header.onclick = () => toggleModule(header.parentNode);
        });
        applyModuleStates();
        setupSearchFilter();
        initializeScrollFaders();
        positionCatCompanion();
    };

    const updateButtonState = (order) => {
        const oldIcon = sortButton.querySelector('i, svg');
        if (oldIcon) {
            const i = document.createElement('i');
            i.className = order === 'asc' ? 'fa-solid fa-sort-amount-up' : 'fa-solid fa-sort-amount-down';
            oldIcon.replaceWith(i);
        }
        sortButton.title = order === 'asc' ? 'Sort Descending' : 'Sort Ascending';
        sortButton.dataset.order = order;
    };

    let sortOrders = JSON.parse(courseStorage.getItem('courseSortOrders')) || {};
    let currentOrder = sortOrders[currentCourse] || 'desc';

    sortModules(currentOrder);
    updateButtonState(currentOrder);
    renderContent();

    sortButton.onclick = () => {
        sortButton.classList.remove('rotating');
        void sortButton.offsetWidth;
        sortButton.classList.add('rotating');

        const newOrder = sortButton.dataset.order === 'asc' ? 'desc' : 'asc';
        sortOrders[currentCourse] = newOrder;
        courseStorage.setItem('courseSortOrders', JSON.stringify(sortOrders));

        sortModules(newOrder);
        updateButtonState(newOrder);
        renderContent();
    };
}

async function fetchCourseData(sheetName, forceRefresh = false) {
    const cacheKeyString = getCachePrefix() + sheetName;

    if (!forceRefresh && courseDataCache[cacheKeyString]) {
        return courseDataCache[cacheKeyString];
    }

    // Stale-while-revalidate: show cached data instantly, refresh in background
    // On page reload the in-memory cache is empty, so check sessionStorage
    if (!forceRefresh) {
        try {
            const cached = courseSessionStorage.getItem('courseData_' + cacheKeyString);
            if (cached) {
                const { data } = JSON.parse(cached);
                courseDataCache[cacheKeyString] = data;
                // Return stale data NOW, but revalidate in background
                revalidateCourseInBackground(sheetName, cacheKeyString);
                return data;
            }
        } catch (e) { /* ignore parse errors */ }
    }

    try {
        const [rows, lecturers] = await Promise.all([fetchPublicSheetData(sheetName, 'A2:J'), fetchCourseLecturers(sheetName)]);
        const data = rows.length === 0 ? null : processCourseData(rows);
        if (data) data.lecturers = lecturers;
        if (data) {
            courseDataCache[cacheKeyString] = data;
            try { courseSessionStorage.setItem('courseData_' + cacheKeyString, JSON.stringify({ data })); } catch (e) { }
        }
        return data;
    } catch (error) {
        showImprovedNotification('error', 'Data Error', 'Failed to fetch course data');
        throw error;
    }
}

// Background revalidation: fetch fresh data and re-render if it changed
function revalidateCourseInBackground(sheetName, cacheKeyString) {
    Promise.all([fetchPublicSheetData(sheetName, 'A2:J'), fetchCourseLecturers(sheetName)]).then(([rows, lecturers]) => {
        const freshData = rows.length === 0 ? null : processCourseData(rows);
        if (freshData) freshData.lecturers = lecturers;
        if (!freshData) return;

        courseDataCache[cacheKeyString] = freshData;
        try { courseSessionStorage.setItem('courseData_' + cacheKeyString, JSON.stringify({ data: freshData })); } catch (e) { }

        // If this is the currently displayed course and data actually changed,
        // silently re-render the UI
        if (cacheKeyString === getCachePrefix() + currentCourse) {
            const oldJSON = JSON.stringify(courseData);
            const newJSON = JSON.stringify(freshData);
            if (oldJSON !== newJSON) {
                Object.assign(courseData, freshData);
                window.currentCourseData = freshData;

                let titleBase = freshData.metadata.code ? `${formatCourseCode(freshData.metadata.code)} ${freshData.metadata.title || 'Course'}` : 'Course Materials';
                document.title = titleBase;

                updateCourseMetadata(freshData.metadata, freshData.lecturers);
                populateActionButtons(freshData.actionButtons, freshData.metadata);
                applyColorTheme(freshData.metadata);
                renderAnnouncements(freshData.announcements);
                setupSortAndRender();
            }
        }
    }).catch(() => { /* silent fail — stale data is still displayed */ });
}

function processCourseData(rows) {
    const data = { metadata: {}, modules: [], actionButtons: [], announcements: [] };
    let currentModule = null;

    // A PigeonFiles submission is a material or project file marked 'pigeon' in column i.
    const getMaterialObject = (r) => r[8] === 'pigeon' ? {
        kind: 'pigeon', icon: r[1] || 'fa-solid fa-dove', title: r[2], description: r[3],
        link: r[4], fileName: r[5], maxSize: r[6], deadline: r[7], fileTypes: r[9]
    } : {
        icon: r[1], title: r[2], description: r[3],
        viewLink: r[4], downloadLink: r[5], openLink: r[6],
        fileTypeClass: getFileTypeClass(r[1])
    };

    const parseModuleRow = (row, type) => {
        const colFValue = String(row[5] || '').toLowerCase().trim();
        if (!colFValue) return null;
        const defaults = type === 'project'
            ? { icon: 'fa-solid fa-flask', title: 'Untitled Project' }
            : { icon: 'fa-solid fa-folder', title: 'Untitled Module' };
        return {
            type: type === 'project' ? 'project' : 'standard',
            id: row[1] || Date.now().toString(),
            order: parseFloat(row[1]) || 0, // shared module/project Order (col b) — see sort below
            title: row[2] || defaults.title,
            icon: row[3] || defaults.icon,
            moduleNumber: row[4] || '',
            isInitiallyCollapsed: colFValue === 'hide',
            materials: [], funFacts: [],
            ...(type === 'project' ? { groups: [] } : {})
        };
    };

    rows.forEach(row => {
        if (!row || row.length === 0) return;
        const type = String(row[0] || '').toLowerCase();

        if (type === 'metadata') {
            const key = String(row[1] || '').toLowerCase().replace(/\s+/g, '_');
            if (key) {
                data.metadata[key] = row[2] || '';
                if (row[3]) data.metadata[key + '_status'] = row[3];
            }
        } else if (type === 'button') {
            data.actionButtons.push({
                name: row[1] || 'Button',
                icon: row[2] || 'fa-solid fa-external-link-alt',
                link: row[3] || '#',
                colorClass: row[4] || 'btn-primary'
            });
        } else if (type === 'module' || type === 'project') {
            const parsed = parseModuleRow(row, type);
            if (parsed) {
                currentModule = parsed;
                data.modules.push(currentModule);
            } else {
                currentModule = null; // Reset so materials don't attach to previous module
            }
        } else if (type === 'announcement') {
            // Expect format: type, icon, color, time, title, text, actionLink, actionIcons, visibility
            const iconStr = row[1] || 'fa-solid fa-bullhorn';
            const colorStr = row[2] || 'var(--warning-color)';
            const timeStr = row[3] || '';
            const titleStr = row[4] || '';
            const textStr = row[5] || '';
            const actionLinkStr = row[6] || '';
            const actionIconsStr = row[7] || '';
            const visibilityStr = String(row[8] || 'HIDE').toUpperCase().trim();

            if (timeStr || titleStr || textStr) {
                data.announcements.push({
                    icon: iconStr,
                    color: colorStr,
                    time: timeStr,
                    title: titleStr,
                    text: textStr,
                    actionLink: actionLinkStr,
                    actionIcons: actionIconsStr,
                    visibility: visibilityStr
                });
            }
        } else if (type === 'project_description' && currentModule) {
            currentModule.materials.push({ isDescription: true, text: row[1] || row[2] || '' });
        } else if (type === 'material' && currentModule && currentModule.type === 'standard') {
            currentModule.materials.push(getMaterialObject(row));
        } else if (type === 'project_file' && currentModule && currentModule.type === 'project') {
            currentModule.materials.push(getMaterialObject(row));
        } else if (type === 'project_group' && currentModule && currentModule.type === 'project') {
            const group = { topic: row[1], description: row[2], students: [], files: [] };
            for (let i = 3; i < row.length; i++) { if (row[i]) group.students.push(row[i]); }
            if (group.students.length > 0) currentModule.groups.push(group);
        } else if (type === 'group_file' && currentModule?.type === 'project' && currentModule.groups.length > 0) {
            currentModule.groups[currentModule.groups.length - 1].files.push(getMaterialObject(row));
        } else if (type === 'funfact' && currentModule) {
            currentModule.funFacts.push({ text: row[1] || '' });
        }
    });

    data.announcements.reverse(); // Show newest announcements first (opposite of backend)

    // Modules and projects share one Order number (col b); highest first, as in the admin.
    // The sort is stable, so equal Orders keep their row order.
    data.modules.sort((a, b) => b.order - a.order);
    return data;
}


// A timetable button: its icon, then its name. While open (.active) the icon folds away and
// the name turns bold, like the course tabs; data-label keeps room for the bold text.
function timetableBtnHtml(name) {
    return `<i class="fa-solid fa-calendar-week timetable-btn-icon" aria-hidden="true"></i>` +
        `<span class="timetable-btn-label" data-label="${courseHtmlText(name)}">${courseHtmlText(name)}</span>`;
}

function populateActionButtons(buttons, metadata) {
    const container = document.getElementById('course-action-buttons');
    if (!container) return;
    container.innerHTML = '';

    const timetableContainer = document.getElementById('timetable-container');

    let addedAny = false;
    for (let i = 1; i <= 10; i++) {
        const tId = metadata[`timetable${i}_id`] !== undefined ? metadata[`timetable${i}_id`] : (i === 1 ? metadata['timetable_id'] : undefined);
        const cId = metadata[`class${i}_id`] !== undefined ? metadata[`class${i}_id`] : (i === 1 ? metadata['class_id'] : undefined);

        // Hidden in the editor's Links tab: kept, but not shown.
        if (tId !== undefined && tId !== '' && metadata[`timetable${i}_hidden`] !== '1') {
            const btnName = metadata[`timetable${i}_name`] || 'Timetable';
            const btnColor = metadata[`timetable${i}_colour`] || 'btn-primary';

            const timetableBtn = document.createElement('button');
            timetableBtn.id = `timetable-btn-${i}`;
            timetableBtn.setAttribute('class', `timetable-btn ${btnColor}`);
            timetableBtn.innerHTML = timetableBtnHtml(btnName);
            timetableBtn.dataset.timetableId = tId;
            timetableBtn.dataset.classId = cId !== undefined ? cId : '';
            timetableBtn.dataset.btnName = btnName;
            timetableBtn.onclick = () => toggleTimetable(i, btnName);
            // A background refresh rebuilds the buttons: the open timetable's stays active.
            if (activeTimetableKey && timetableKeyOf(timetableBtn) === activeTimetableKey && !container.querySelector('.timetable-btn.active')) {
                timetableBtn.classList.add('active');
                saveTimetableState(true, i);
            }
            container.appendChild(timetableBtn);
            addedAny = true;
        }
    }
    // The open timetable was removed from the course meanwhile: close it.
    if (activeTimetableKey && !container.querySelector('.timetable-btn.active')) {
        activeTimetableKey = null;
        ttGeneration++;
        saveTimetableState(false);
        hideTtPopover();
        document.getElementById('native-timetable-container')?.classList.remove('visible');
        if (timetableContainer) timetableContainer.style.display = 'none';
    }

    buttons.forEach(buttonData => {
        const button = document.createElement('button');
        button.setAttribute('class', buttonData.colorClass);
        button.innerHTML = `<i class="${courseHtmlText(buttonData.icon)}"></i> ${courseHtmlText(buttonData.name)}`;
        button.onclick = () => handleActionClick(button, buttonData.link);
        container.appendChild(button);
    });

    // Track wrapped rows for proper CSS edge rounding
    if (!container._resizeObserver) {
        container._resizeObserver = new ResizeObserver(() => updateButtonRows(container));
        container._resizeObserver.observe(container);
    } else {
        updateButtonRows(container);
    }
}

// The editor's date and time, "DD-MM-YYYY, HH:MM", as local time.
function parseCourseDateTime(value) {
    const m = String(value || '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})[,\s]+(\d{1,2}):(\d{2})/);
    return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5]) : null;
}

// Extensions a list of accepted file types may name without a dot.
const FILE_EXTENSIONS = new Set(('pdf doc docx ppt pptx pps ppsx xls xlsx xlsm csv tsv txt rtf md odt ods odp key pages ' +
    'numbers epub tex bib jpg jpeg png gif webp bmp tif tiff heic svg psd ai eps mp4 mov avi mkv webm mp3 wav m4a ogg ' +
    'flac zip rar 7z tar gz py ipynb java js ts html css c h cpp cs m mlx mat r rmd sql json xml yaml yml sh ino dwg ' +
    'dxf rvt rfa skp stl obj step stp iges igs sdb edb shp kml kmz geojson').split(' '));

// A PigeonFiles submission: Submit opens the lecturer's upload page; below it, the file
// name format, the accepted types, the size limit (a bare number is MB) and the deadline
// with the time left. A list of extensions ("pdf, .docx") reads "PDF, DOCX"; other text,
// such as "Any PDF or Word file", stays as typed.
function pigeonCardHtml(m) {
    const typeList = String(m.fileTypes || '').trim();
    const extensions = typeList.split(/[\s,;/|]+/).filter(Boolean);
    const fileTypes = extensions.every(t => /^\.[a-z0-9]{1,5}$/i.test(t) || FILE_EXTENSIONS.has(t.toLowerCase()))
        ? extensions.map(t => t.replace(/^\./, '').toUpperCase()).join(', ') : typeList;
    const due = parseCourseDateTime(m.deadline);
    let when = '', state = '';
    if (due) {
        const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const days = Math.round((day(due) - day(new Date())) / 86400000);
        if (due.getTime() <= Date.now()) { when = 'Closed'; state = ' is-closed'; }
        else {
            when = days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `${days} days left`;
            if (days <= 1) state = ' is-soon';
        }
    }
    const size = String(m.maxSize || '').trim();
    const facts = [];
    if (m.fileName) facts.push(['fa-regular fa-file', 'File name', `<code>${courseHtmlText(m.fileName)}</code>`]);
    if (fileTypes) facts.push(['fa-solid fa-filter', 'File types', courseHtmlText(fileTypes)]);
    if (size) facts.push(['fa-solid fa-weight-hanging', 'Max size', courseHtmlText(/^\d+(\.\d+)?$/.test(size) ? `${size} MB` : size)]);
    if (m.deadline) facts.push(['fa-regular fa-clock', 'Deadline', courseHtmlText(due ? due.toLocaleString('en-GB',
        { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : m.deadline) +
        (when ? ` <span class="pigeon-when">${when}</span>` : '')]);
    return `
            <div class="material-card pigeon-card${state}">
                <div class="material-card-header">
                    <i class="${courseHtmlText(m.icon)} material-icon"></i>
                    <div class="material-info">
                        <div class="material-title">${courseHtmlText(m.title || 'Submission')}</div>
                        <div class="material-description">${courseRichHtml(m.description)}</div>
                    </div>
                </div>
                <div class="material-card-actions">${courseActionButton(m.link, 'submit')}</div>
                ${facts.length ? `<dl class="pigeon-facts">${facts.map(([icon, label, value]) =>
                    `<div><dt><i class="${icon}" aria-hidden="true"></i>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>` : ''}
            </div>`;
}

function generateProjectModuleHtml(module) {
    const moduleId = `module-${module.id}`;
    let filesHtml = '';

    if (module.materials.length > 0) {
        const materialCount = module.materials.filter(m => !m.isDescription).length;
        let gridClass = 'materials-grid';
        if (materialCount === 1) gridClass += ' materials-1';
        else if (materialCount === 2) gridClass += ' materials-2';

        let inGrid = false;
        module.materials.forEach(material => {
            if (material.isDescription) {
                if (inGrid) { filesHtml += `</div>`; inGrid = false; }
                filesHtml += `<div class="project-module-description">${courseRichHtml(material.text)}</div>`;
            } else if (material.kind === 'pigeon') {
                if (!inGrid) { filesHtml += `<div class="${gridClass}">`; inGrid = true; }
                filesHtml += pigeonCardHtml(material);
            } else {
                if (!inGrid) { filesHtml += `<div class="${gridClass}">`; inGrid = true; }
                filesHtml += `
            <div class="material-card ${courseHtmlText(material.fileTypeClass || '')}">
                <div class="material-card-header">
                    <i class="${courseHtmlText(material.icon || 'fa-regular fa-file-alt')} material-icon"></i>
                    <div class="material-info">
                        <div class="material-title">${courseHtmlText(material.title)}</div>
                        <div class="material-description">${courseRichHtml(material.description)}</div>
                    </div>
                </div>
<div class="material-card-actions">
    ${courseActionButton(material.viewLink, 'view')}
    ${courseActionButton(material.downloadLink, 'download')}
    ${courseActionButton(material.openLink, 'open')}
</div>
            </div>`;
            }
        });
        if (inGrid) filesHtml += `</div>`;
    }

    let groupsHtml = '';
    if (module.groups.length > 0) {
        const scrollClass = module.groups.length > 6 ? ' desktop-scrollable is-scrollable' : '';
        groupsHtml += `<div class="project-groups-grid${scrollClass}">`;
        module.groups.forEach(group => {
            let studentsList = '<ul class="student-list">';
            group.students.forEach((student, index) => {
                // If the name is N/A, we skip this entry.
                // If it's the first entry (index 0), then no one gets the 'leader' underline.
                if (student.trim().toUpperCase() === 'N/A') return;

                const className = index === 0 ? 'class="leader"' : '';

                let displayName = courseHtmlText(student);
                const match = student.match(/^(.*?)\s+(R|R\s+EX)$/i);
                if (match) {
                    displayName = `${courseHtmlText(match[1])} <span class="student-status-warning">${courseHtmlText(match[2].toUpperCase())}</span>`;
                }

                studentsList += `<li ${className}>${displayName}</li>`;
            });
            studentsList += '</ul>';

            let groupFilesHtml = '';
            if (group.files && group.files.length > 0) {
                groupFilesHtml += '<div class="group-files-container">';
                group.files.forEach(file => {
                    groupFilesHtml += `
                    <div class="group-material-card ${courseHtmlText(file.fileTypeClass || '')}">
                        <i class="${courseHtmlText(file.icon || 'fa-regular fa-file-alt')} material-icon"></i>
                        <div class="material-info">
                            <div class="material-title">${courseHtmlText(file.title)}</div>
                            <div class="material-description">${courseRichHtml(file.description)}</div>
                        </div>
                        <div class="material-card-actions">
                             ${courseActionButton(file.viewLink, 'view', true)}
 ${courseActionButton(file.downloadLink, 'download', true)}
                        </div>
                    </div>`;
                });
                groupFilesHtml += '</div>';
            }

            groupsHtml += `
            <div class="project-group-card">
                <div class="project-group-title">${courseHtmlText(group.topic)}</div>
                ${group.description ? `<div class="project-group-description">${courseRichHtml(group.description)}</div>` : ''}
                ${studentsList}
                ${groupFilesHtml}
            </div>`;
        });
        groupsHtml += `</div>`;
    }

    let funFactsHtml = '';
    module.funFacts.forEach(funFact => {
        funFactsHtml += `<div class="fun-fact"><i class="fa-solid fa-lightbulb fun-fact-icon"></i><span class="fun-fact-text">${courseRichHtml(funFact.text)}</span></div>`;
    });

    return `
    <div class="module module-project" id="${courseHtmlText(moduleId)}" data-initially-collapsed="${module.isInitiallyCollapsed === true}">
        <div class="module-header" role="button" tabindex="0">
            ${module.moduleNumber ? `<span class="module-background-number">${courseHtmlText(module.moduleNumber)}</span>` : ''}
            <span class="module-title"><i class="${courseHtmlText(module.icon)}"></i> ${courseHtmlText(module.title)}</span>
            <i class="fa-solid fa-chevron-down module-toggle-chevron"></i>
        </div>
        <div class="module-content">
            ${filesHtml}
            ${groupsHtml}
            ${funFactsHtml}
        </div>
    </div>`;
}

function resetUIElements() {
    const timetableBtns = document.querySelectorAll('.timetable-btn');
    timetableBtns.forEach(btn => btn.classList.remove('active'));

    activeTimetableKey = null;
    ttGeneration++;
    hideTtPopover();
    const nativeContainer = document.getElementById('native-timetable-container');
    if (nativeContainer) {
        nativeContainer.classList.remove('visible');
    }

    const timetableContainer = document.getElementById('timetable-container');
    if (timetableContainer) {
        timetableContainer.style.display = 'none';
    }

    const announcementBanner = document.getElementById('announcement-banner');
    if (announcementBanner) {
        announcementBanner.style.display = 'none';
        announcementBanner.innerHTML = '';
    }

    const examSchedule = document.getElementById('exam-schedule');
    if (examSchedule) examSchedule.hidden = true;
}

// ── Exam schedule ──
// A compact schedule of an active course's upcoming exams (date, duration, hall; never
// questions or results). An exam open now links to the exam app. Hidden when there are none
// or the exam functions are not installed.
const EXAM_TYPE_INFO = {
    quiz: ['Quiz', 'fa-solid fa-question'],
    assignment: ['Assignment', 'fa-solid fa-book'],
    project: ['Project', 'fa-solid fa-diagram-project'],
    midterm_project: ['Midterm Project', 'fa-solid fa-diagram-project'],
    final_project: ['Final Project', 'fa-solid fa-diagram-project'],
    other: ['Other', 'fa-solid fa-ellipsis'],
    final_exam: ['Final Exam', 'fa-solid fa-graduation-cap'],
    midterm_exam: ['Midterm Exam', 'fa-solid fa-pen-to-square'],
    resit_exam: ['Resit Exam', 'fa-solid fa-rotate'],
    additional_exam: ['Additional Exam', 'fa-solid fa-plus'],
};
const examScheduleCache = {};

async function loadExamSchedule(sheetName, sequence, archive) {
    const section = document.getElementById('exam-schedule');
    if (!section) return;
    if (archive) { section.hidden = true; return; }
    const key = getCachePrefix() + sheetName;
    if (examScheduleCache[key]) renderExamSchedule(examScheduleCache[key]);
    let exams;
    try {
        exams = await TeachingSites.rpc('exam_schedule', { p_sheet: sheetName, p_archive: false });
    } catch { return; }
    if (!Array.isArray(exams)) return;
    examScheduleCache[key] = exams;
    if (sequence === courseViewSequence && archive === isArchiveMode) renderExamSchedule(exams);
}

function renderExamSchedule(exams) {
    const section = document.getElementById('exam-schedule');
    const now = Date.now();
    // Finished exams drop off the schedule.
    exams = exams.filter(e => !e.starts_at || Date.parse(e.starts_at) + (e.duration_minutes || 0) * 60000 > now);
    if (!exams.length) { section.hidden = true; return; }
    const examUrl = new URL('exam/', window.TEACHING_CONFIG.appBaseUrl).href;
    const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const items = exams.map(exam => {
        const [typeLabel, icon] = EXAM_TYPE_INFO[exam.type] || ['Exam', 'fa-solid fa-file-pen'];
        const start = exam.starts_at ? new Date(exam.starts_at) : null;
        const end = start && exam.duration_minutes ? start.getTime() + exam.duration_minutes * 60000 : start?.getTime();
        let when = '', state = '';
        if (start) {
            const days = Math.round((day(start) - day(new Date())) / 86400000);
            if (end <= now && start.getTime() < now) { when = 'Done'; state = 'is-past'; }
            else if (start.getTime() <= now) { when = 'Now'; state = 'is-now'; }
            else when = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`;
        }
        const meta = [];
        if (start) meta.push(`<span><i class="fa-regular fa-calendar" aria-hidden="true"></i>${courseHtmlText(start.toLocaleString('en-GB',
            { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>`);
        if (exam.duration_minutes) meta.push(`<span><i class="fa-regular fa-clock" aria-hidden="true"></i>${courseHtmlText(exam.duration_minutes)} min</span>`);
        if (exam.hall) meta.push(`<span><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${courseHtmlText(exam.hall)}</span>`);
        // Only an exam taken online links to the exam app; one held on paper just says Now.
        const action = state === 'is-now' && exam.has_questions
            ? `<a class="exam-schedule-go" href="${courseHtmlText(examUrl)}"><i class="fa-solid fa-play" aria-hidden="true"></i>Go to exam</a>`
            : when ? `<span class="exam-schedule-when">${when}</span>` : '';
        return `<li class="exam-schedule-item ${state}">
            <span class="exam-schedule-icon"><i class="${icon}" aria-hidden="true"></i></span>
            <span class="exam-schedule-name">${courseHtmlText(exam.label || typeLabel)}</span>
            ${meta.length ? `<span class="exam-schedule-meta">${meta.join('')}</span>` : ''}
            ${action}
        </li>`;
    }).join('');
    section.innerHTML = `<ul class="exam-schedule-list">${items}</ul>`;
    section.hidden = false;
}

function getDismissedAnnouncements() {
    try {
        return JSON.parse(courseStorage.getItem('dismissedAnnouncements') || '[]');
    } catch (e) {
        return [];
    }
}

function updateAnnouncementCorners() {
    document.querySelectorAll('.announcement-row-group').forEach(group => {
        const rows = Array.from(group.querySelectorAll('.announcement-row:not(.swipe-dismissing)'));

        group.querySelectorAll('.announcement-row').forEach(row => {
            row.classList.remove('first-in-col', 'last-in-col', 'middle-in-col', 'only-in-col');
        });

        if (rows.length === 1) {
            rows[0].classList.add('only-in-col');
        } else if (rows.length > 1) {
            rows.forEach((row, index) => {
                if (index === 0) row.classList.add('first-in-col');
                else if (index === rows.length - 1) row.classList.add('last-in-col');
                else row.classList.add('middle-in-col');
            });
        }
    });
}

function dismissAnnouncement(id, cardElement) {
    const dismissed = getDismissedAnnouncements();
    if (!dismissed.includes(id)) {
        dismissed.push(id);
        courseStorage.setItem('dismissedAnnouncements', JSON.stringify(dismissed));
    }

    if (cardElement) {
        // If they passed the inner card instead of the row, find it
        const targetRow = cardElement.classList.contains('announcement-row') ? cardElement : cardElement.closest('.announcement-row');
        if (targetRow) targetRow.classList.add('swipe-dismissing');
        else cardElement.classList.add('swipe-dismissing');

        updateAnnouncementCorners();

        setTimeout(() => {
            // Force a re-render of announcements from the cached data source
            if (window.currentCourseData && window.currentCourseData.announcements) {
                renderAnnouncements(window.currentCourseData.announcements);
            }
        }, 300); // Wait for transition
    }
}

function clearAllAnnouncements() {
    if (window.currentCourseData && window.currentCourseData.announcements) {
        const visibleIds = window.currentCourseData.announcements.map((ann) => btoa(encodeURIComponent(currentCourse + (ann.title || '') + (ann.text || '') + (ann.time || ''))));
        const dismissed = getDismissedAnnouncements();

        visibleIds.forEach(id => {
            if (!dismissed.includes(id)) {
                dismissed.push(id);
            }
        });

        courseStorage.setItem('dismissedAnnouncements', JSON.stringify(dismissed));
        renderAnnouncements(window.currentCourseData.announcements);
    }
}

function toggleAnnouncements() {
    const collapsedDiv = document.getElementById('announcements-collapsed-view');
    const toggleBtn = document.getElementById('announcements-toggle-btn');

    if (collapsedDiv && toggleBtn) {
        if (collapsedDiv.style.maxHeight && collapsedDiv.style.maxHeight !== '0px') {
            collapsedDiv.style.maxHeight = '0px';
            collapsedDiv.style.opacity = '0';
            collapsedDiv.dataset.expanded = 'false';
            toggleBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i> Show older';

            // Wait for the CSS transition to finish before hiding it structurally
            setTimeout(() => {
                if (collapsedDiv.style.maxHeight === '0px') {
                    collapsedDiv.style.display = 'none';
                }
            }, 300); // 0.3s matches the CSS transition time
        } else {
            collapsedDiv.style.display = 'flex';

            // Force a reflow so the browser registers the flex display before applying height
            void collapsedDiv.offsetHeight;

            collapsedDiv.style.maxHeight = collapsedDiv.scrollHeight + 'px';
            collapsedDiv.style.opacity = '1';
            collapsedDiv.dataset.expanded = 'true';
            toggleBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Hide older';
        }
    }
}

function renderAnnouncements(announcements) {
    const banner = document.getElementById('announcement-banner');
    if (!banner) return;

    // Generate reproducible IDs and filter out dismissed ones
    const dismissedIds = getDismissedAnnouncements();
    const visibleAnnouncements = (announcements || []).map((ann) => {
        const id = btoa(encodeURIComponent(currentCourse + (ann.title || '') + (ann.text || '') + (ann.time || '')));
        return { ...ann, id };
    }).filter(ann => !dismissedIds.includes(ann.id));

    if (visibleAnnouncements.length === 0) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }

    let html = '';

    const renderCardHtml = (ann) => {
        const cssColorVar = safeCourseColor(ann.color);

        let infoHtml = '';
        if (ann.icon) {
            const profMatch = ann.icon.match(/^professor(\d+)$/i);
            if (profMatch && window.currentCourseData && window.currentCourseData.metadata) {
                const profNum = profMatch[1];
                const photoUrl = safeCourseUrl(window.currentCourseData.metadata[`professor${profNum}_photo`], true);
                const profName = window.currentCourseData.metadata[`professor${profNum}`];
                if (photoUrl) {
                    infoHtml += `<img src="${courseHtmlText(photoUrl)}" alt="Lecturer" class="announcement-avatar" style="border-color: ${cssColorVar};">`;
                } else {
                    // Fallback if professor specified but no photo provided
                    infoHtml += `<i class="fa-solid fa-user-circle announcement-icon" style="color: ${cssColorVar};"></i>`;
                }
                if (profName) {
                    // Strip common academic titles and prefixes before grabbing the first name
                    const titleRegex = /^(?:assoc\.|prof\.|dr\.|mr\.|ms\.|mrs\.|ing\.|eng\.|prof|dr|mr|ms|mrs|ing|eng)\s+/gi;
                    const cleanName = profName.replace(titleRegex, '').replace(titleRegex, '').trim();
                    const firstName = cleanName.split(' ')[0];
                    infoHtml += `<div class="announcement-prof-name" style="color: ${cssColorVar};">${courseHtmlText(firstName)}</div>`;
                }
            } else {
                infoHtml += `<i class="${courseHtmlText(ann.icon)} announcement-icon" style="color: ${cssColorVar};"></i>`;
            }
        }

        let timeHtml = '';
        if (ann.time) {
            timeHtml = `<span class="announcement-date" style="color: ${cssColorVar};">${courseHtmlText(ann.time)}</span>`;
        }

        let actionHtml = '';
        if (ann.actionLink) {
            const links = ann.actionLink.split(',').map(l => l.trim()).filter(l => l);
            const icons = (ann.actionIcons || '').split(',').map(i => i.trim());
            if (links.length > 0) {
                actionHtml = '<div class="material-card-actions">';
                links.forEach((link, i) => {
                    const safeUrl = safeCourseUrl(link);
                    if (!safeUrl) return;
                    const btnBgStyle = ann.color ? `background-color: ${cssColorVar}; border-color: rgba(0,0,0,0.15);` : '';
                    const defaultClass = ann.color ? '' : 'btn-primary';

                    let posClass = '';
                    if (links.length === 1) posClass = 'only-in-row';
                    else if (i === 0) posClass = 'first-in-row';
                    else if (i === links.length - 1) posClass = 'last-in-row';
                    else posClass = 'middle-in-row';

                    const iconClass = icons[i] || 'fa-solid fa-up-right-from-square';

                    actionHtml += `
                                <button data-course-action="${courseHtmlText(safeUrl)}" class="${defaultClass} ${posClass}" style="${btnBgStyle}" title="Open Link">
                                    <i class="${courseHtmlText(iconClass)}" style="margin-right: 0;"></i>
                                </button>`;
                });
                actionHtml += '</div>';
            }
        }
        return `
                    <div class="announcement-row" id="ann-row-${ann.id}">
                        <div class="announcement-card swipeable-announcement" style="--card-accent: ${cssColorVar};">
                            <div class="announcement-icon-wrapper">
                                ${infoHtml}
                            </div>
                            <div class="announcement-content-wrapper">
                                <div class="announcement-header-row">
                                    <div class="announcement-header-info">
                                        ${ann.title ? `<span class="announcement-title" style="color: ${cssColorVar};">${courseHtmlText(ann.title)}</span>` : ''}
                                    </div>
                                    ${timeHtml}
                                </div>
                                <div class="announcement-text">${courseRichHtml(ann.text)}</div>
                            </div>
                        </div>
                        ${actionHtml}
                    </div>
                `;
    };

    // Render highlighted announcements (SHOW) normally
    const initialAnnouncements = visibleAnnouncements.filter(ann => ann.visibility === 'SHOW');
    const collapsedAnnouncements = visibleAnnouncements.filter(ann => ann.visibility !== 'SHOW');

    if (initialAnnouncements.length === 0 && collapsedAnnouncements.length === 0) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }

    if (initialAnnouncements.length === 0 && collapsedAnnouncements.length > 0) {
        html += `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 15px; color: #757575; font-size: 0.9em; flex-wrap: wrap;">
                    <span style="user-select: none; -webkit-user-select: none;"><i class="fa-solid fa-bullhorn"></i> There are no new announcements...</span>
                    <button id="announcements-toggle-btn" class="show-more-announcements" onclick="toggleAnnouncements()" style="margin: 0 0 0 auto !important; font-size: 1em;">
                        <i class="fa-solid fa-chevron-down"></i> Show older
                    </button>
                </div>`;
    } else {
        html += `<div id="announcements-active-view" class="announcement-row-group">`;
        initialAnnouncements.forEach(ann => {
            html += renderCardHtml(ann);
        });
        html += `</div>`;
    }

    // Render the rest in a collapsible container if they exist
    if (collapsedAnnouncements.length > 0) {
        html += `<div id="announcements-collapsed-view" class="announcements-collapsed announcement-row-group" style="max-height: 0px; opacity: 0; display: none;">`;
        collapsedAnnouncements.forEach(ann => {
            html += renderCardHtml(ann);
        });
        html += `</div>`;

        if (initialAnnouncements.length > 0) {
            html += `<button id="announcements-toggle-btn" class="show-more-announcements" onclick="toggleAnnouncements()"><i class="fa-solid fa-chevron-down"></i> Show older</button>`;
        }
    }

    // Preserve expanded state before re-rendering
    const existingCollapsedDiv = document.getElementById('announcements-collapsed-view');
    const wasExpanded = existingCollapsedDiv && existingCollapsedDiv.dataset.expanded === 'true';

    banner.innerHTML = html;
    banner.style.display = 'flex';

    updateAnnouncementCorners();

    // Restore expanded state instantly if it was open before dismissal
    if (wasExpanded) {
        const newCollapsedDiv = document.getElementById('announcements-collapsed-view');
        const newToggleBtn = document.getElementById('announcements-toggle-btn');
        if (newCollapsedDiv && newToggleBtn) {
            newCollapsedDiv.style.display = 'flex';
            newCollapsedDiv.style.maxHeight = 'none';
            newCollapsedDiv.style.opacity = '1';
            newCollapsedDiv.dataset.expanded = 'true';
            newToggleBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Hide older';

            // Small delay then calculate absolute height bounds so future toggles work correctly
            setTimeout(() => {
                if (newCollapsedDiv.dataset.expanded === 'true') {
                    newCollapsedDiv.style.maxHeight = newCollapsedDiv.scrollHeight + 'px';
                }
            }, 50);
        }
    }

    // Swipe left to dismiss, by touch or mouse.
    const swipeables = banner.querySelectorAll('.swipeable-announcement');
    swipeables.forEach(card => {
        let startX = 0;
        let currentX = 0;
        let startY = 0;
        let isDragging = false;
        let hasMoved = false;
        let intentLocked = false;   // true once we decide horizontal or vertical
        let isHorizontal = false;   // true = horizontal swipe intent, false = vertical scroll
        const row = card.closest('.announcement-row');
        const annId = row.id.replace('ann-row-', '');

        const getSiblings = () => {
            const group = row.closest('.announcement-row-group');
            if (!group) return [];
            const siblings = [];
            if (row.previousElementSibling && row.previousElementSibling.classList.contains('announcement-row')) {
                siblings.push(row.previousElementSibling.querySelector('.announcement-card'));
            }
            if (row.nextElementSibling && row.nextElementSibling.classList.contains('announcement-row')) {
                siblings.push(row.nextElementSibling.querySelector('.announcement-card'));
            }
            return siblings.filter(s => s); // remove nulls attached to elements without cards
        };

        const handleStart = (clientX, clientY) => {
            startX = clientX;
            startY = clientY;
            isDragging = true;
            hasMoved = false;
            intentLocked = false;
            isHorizontal = false;
            card.style.transition = 'none';

            getSiblings().forEach(sibling => {
                sibling.style.transition = 'none';
            });
        };

        const handleMove = (clientX, clientY, e) => {
            if (!isDragging) return;
            currentX = clientX;
            const diffX = currentX - startX;
            const diffY = clientY - startY;

            // On first significant move, determine gesture intent
            if (!intentLocked && (Math.abs(diffX) > 4 || Math.abs(diffY) > 4)) {
                intentLocked = true;
                isHorizontal = Math.abs(diffX) >= Math.abs(diffY);
            }

            // If intent is vertical (scroll), release control immediately
            if (intentLocked && !isHorizontal) {
                isDragging = false;
                card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                card.style.transform = '';
                card.style.opacity = '';

                getSiblings().forEach(sibling => {
                    sibling.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                    sibling.style.transform = '';
                });
                return;
            }

            // Require at least 5px of horizontal movement before considering it a drag vs a click
            if (Math.abs(diffX) > 5) {
                hasMoved = true;
                card.classList.add('is-dragging');
                if (e && e.cancelable) e.preventDefault(); // Prevent scroll while dragging horizontally
            }

            if (!hasMoved) return;

            // Swipe left to dismiss (negative diffX)
            // Swipe right bounces back (positive diffX)
            let targetX = diffX;
            if (diffX < 0) {
                const triggerThreshold = Math.min(250, window.innerWidth * 0.4);
                card.style.transform = `translateX(${diffX}px)`;
                card.style.opacity = Math.max(0, 1 - (Math.abs(diffX) / triggerThreshold));
            } else if (diffX > 0) {
                const elasticStretch = (1 - Math.exp(-diffX / 150)) * 100;
                targetX = elasticStretch;
                card.style.transform = `translateX(${elasticStretch}px)`;
            }

            getSiblings().forEach(sibling => {
                sibling.style.transform = `translateX(${targetX * 0.04}px)`;
            });
        };

        const handleEnd = () => {
            if (!isDragging) return;
            isDragging = false;
            card.classList.remove('is-dragging');

            if (!hasMoved) {
                // Just a click: restore the transitions.
                card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                getSiblings().forEach(sibling => {
                    sibling.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                });
                return;
            }

            const diffX = currentX - startX;

            card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
            getSiblings().forEach(sibling => {
                sibling.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                sibling.style.transform = ''; // swap sibling back immediately
            });

            const triggerThreshold = Math.min(250, window.innerWidth * 0.4);

            if (diffX < -triggerThreshold) { // Swipe left threshold to dismiss
                dismissAnnouncement(annId, row);
            } else { // Snap back
                card.style.transform = '';
                card.style.opacity = '';
            }
            hasMoved = false;
        };

        card.addEventListener('touchstart', (e) => handleStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
        card.addEventListener('touchmove', (e) => handleMove(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
        card.addEventListener('touchend', handleEnd);
        card.addEventListener('touchcancel', handleEnd);

        const onMouseMove = (e) => handleMove(e.clientX, e.clientY, e);
        const onMouseUp = () => {
            handleEnd();
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        card.addEventListener('mousedown', (e) => {
            if (e.target.closest('button') || e.target.closest('a')) return;
            handleStart(e.clientX, e.clientY);
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    });
}

function updateCourseMetadata(metadata, lecturers = null) {
    document.getElementById('course-code').textContent = metadata.code ? formatCourseCode(metadata.code) : 'Course Code';

    // Lecturers assigned in Settings (display name and photo); courses nobody is assigned
    // to use the lecturer entries stored with the course.
    const profContainer = document.getElementById('professors-container');
    if (profContainer) {
        profContainer.innerHTML = '';
        let people = Array.isArray(lecturers) && lecturers.length ? lecturers.map(l => ({ name: l.name, photo: safeCourseUrl(l.photo, true) })) : [];
        if (!people.length) {
            people = Object.keys(metadata).filter(key => /^professor\d+$/.test(key) && metadata[key])
                .map(key => ({ name: metadata[key], photo: safeCourseUrl(metadata[`${key}_photo`], true) }));
        }
        // By title (Prof., Assoc. Prof., Dr., …), then name.
        people.sort((a, b) => TeachingSites.compareLecturers(a.name, b.name));
        for (const person of people) {
            const item = document.createElement('span');
            item.className = 'info-item professor-item';
            item.innerHTML = (person.photo
                ? `<img src="${courseHtmlText(person.photo)}" alt="" class="professor-photo" referrerpolicy="no-referrer"><i class="fa-solid fa-user-circle" style="display:none;"></i>`
                : '<i class="fa-solid fa-user-circle"></i>') + ` ${courseHtmlText(person.name)}`;
            const photo = item.querySelector('img');
            photo?.addEventListener('error', () => {
                photo.style.display = 'none';
                photo.nextElementSibling.style.display = 'inline-block';
            });
            profContainer.appendChild(item);
        }
        if (!people.length) {
            const item = document.createElement('span');
            item.className = 'info-item';
            item.innerHTML = '<i class="fa-solid fa-user-circle"></i> Instructor';
            profContainer.appendChild(item);
        }
    }

    document.getElementById('course-title').textContent = metadata.title || 'Course Title';
    // Archived courses add their academic year ("Fall Semester 2023–2024").
    const semesterText = metadata.semester || 'Unknown Semester';
    document.getElementById('course-semester').textContent = (isArchiveMode && metadata.year) ? `${semesterText} ${metadata.year}` : semesterText;
    document.getElementById('course-level').textContent = metadata.level || 'Undergraduate';
    const creditsContainer = document.getElementById('course-credits-container');
    if (metadata.credits) {
        document.getElementById('course-credits').textContent = metadata.credits + ' ECTS';
        if (creditsContainer) creditsContainer.style.display = '';
    } else if (creditsContainer) {
        creditsContainer.style.display = 'none';
    }

    const courseType = metadata.type || 'Compulsory';
    document.getElementById('course-type').textContent = courseType;
    const typeContainer = document.getElementById('course-type-container');
    if (typeContainer) {
        typeContainer.innerHTML = courseType.toLowerCase() === 'elective' ? '<i class="fa-regular fa-circle"></i> <span id="course-type">Elective</span>' : '<i class="fa-solid fa-exclamation-circle"></i> <span id="course-type">Compulsory</span>';
    }
    // Archived courses are finished: no week counter or term progress.
    const weekInfoItem = document.getElementById('week-info-item');
    const progressBarContainer = document.getElementById('progress-bar-container');
    if (isArchiveMode) {
        if (weekInfoItem) weekInfoItem.style.display = 'none';
        if (progressBarContainer) progressBarContainer.style.display = 'none';
    } else {
        if (weekInfoItem) weekInfoItem.style.display = '';
        if (progressBarContainer) progressBarContainer.style.display = '';
        const hStart = metadata.holiday_startdate || metadata.holiday_start_date || metadata.holidaystartdate || metadata.holiday_start;
        updateWeekProgress(metadata.startdate, metadata.enddate, metadata.holidayweeks, hStart);
    }

    const evaluationDisplay = document.getElementById('evaluation-display');
    if (hasEvaluationData(metadata)) {
        evaluationDisplay.style.display = 'block';
        generateGradeDistribution(metadata);
    } else {
        evaluationDisplay.style.display = 'none';
    }

    // After layout, so the rows can be measured.
    requestAnimationFrame(() => updateInfoItemRows());

    // Reinstall a ResizeObserver on course-info so rows re-compute if the chip set reflows
    const courseInfoEl = document.getElementById('course-info');
    if (courseInfoEl && !courseInfoEl._infoRowObserver) {
        courseInfoEl._infoRowObserver = new ResizeObserver(() => updateInfoItemRows());
        courseInfoEl._infoRowObserver.observe(courseInfoEl);
    }
}

function generateCourseContentHtml(modules) {
    const sideNav = document.getElementById('side-nav-container');
    const sideNavToggle = document.getElementById('side-nav-toggle');
    const mobileFab = document.getElementById('mobile-fab');
    const mobileMenu = document.getElementById('mobile-fab-menu');
    const sortButton = document.getElementById('sort-button');
    const searchBar = document.getElementById('search-bar');
    const searchContainer = searchBar ? searchBar.parentElement : null;

    // With one module or none there is nothing to navigate, search or sort.
    const moduleCount = modules ? modules.length : 0;

    if (moduleCount <= 1) {
        if (sideNav) sideNav.style.display = 'none';
        if (sideNavToggle) sideNavToggle.style.display = 'none';
        if (mobileFab) { mobileFab.classList.remove('fab-visible'); mobileFab.classList.add('nav-hidden'); }

        if (sortButton) {
            sortButton.disabled = true;
            sortButton.classList.add('disabled-look');
        }
        if (searchBar) searchBar.disabled = true;
        if (searchContainer) searchContainer.classList.add('disabled-look');

    } else {
        // The CSS media queries decide whether the navigation shows.
        if (sideNav) sideNav.style.display = '';
        if (sideNavToggle) sideNavToggle.style.display = '';
        if (mobileFab) { mobileFab.classList.remove('nav-hidden'); }

        if (sortButton) {
            sortButton.disabled = false;
            sortButton.classList.remove('disabled-look');
        }
        if (searchBar) searchBar.disabled = false;
        if (searchContainer) searchContainer.classList.remove('disabled-look');
    }

    sideNav.querySelectorAll('.side-nav-item').forEach(item => item.remove());
    if (mobileMenu) mobileMenu.innerHTML = '';

    if (!modules || modules.length === 0) {
        return '<div class="empty-content"><i class="fa-solid fa-box-open"></i><br>No modules have been added to this course yet.</div>';
    }

    const handleNavClick = (e) => {
        e.preventDefault();
        isProgrammaticScroll = true;

        sideNav.querySelectorAll('.side-nav-item').forEach(link => link.classList.remove('active'));
        e.currentTarget.classList.add('active');

        const targetId = e.currentTarget.getAttribute('href');
        const targetElement = document.getElementById(targetId.slice(1));

        if (targetElement) {
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (history.pushState) { history.pushState(null, null, targetId); }
            else { location.hash = targetId; }
        }

        setTimeout(() => { isProgrammaticScroll = false; }, 1000);
    };

    let html = '';
    modules.forEach(module => {
        const moduleId = `#module-${module.id}`;

        const navItem = document.createElement('a');
        navItem.setAttribute('class', 'side-nav-item');
        navItem.href = moduleId;
        navItem.innerHTML = `<i class="${courseHtmlText(module.icon)}"></i> <span>${courseHtmlText(module.title)}</span>`;
        navItem.addEventListener('click', handleNavClick);
        sideNav.appendChild(navItem);

        if (mobileMenu) {
            const mobileNavItem = document.createElement('a');
            mobileNavItem.setAttribute('class', 'mobile-fab-menu-item');
            mobileNavItem.href = moduleId;
            mobileNavItem.innerHTML = `${courseHtmlText(module.title)} <i class="${courseHtmlText(module.icon)}"></i>`;
            mobileNavItem.addEventListener('click', (e) => {
                handleNavClick(e);
                document.getElementById('mobile-fab')?.click();
            });
            mobileMenu.appendChild(mobileNavItem);
        }

        if (module.type === 'project') {
            html += generateProjectModuleHtml(module);
        } else {
            const materialCount = module.materials.filter(m => !m.isDescription).length;
            let gridClass = 'materials-grid';
            if (materialCount === 1) gridClass += ' materials-1';
            else if (materialCount === 2) gridClass += ' materials-2';

            html += `
            <div class="module" id="module-${courseHtmlText(module.id)}" data-initially-collapsed="${module.isInitiallyCollapsed === true}">
                <div class="module-header" role="button" tabindex="0">
                    ${module.moduleNumber ? `<span class="module-background-number">${courseHtmlText(module.moduleNumber)}</span>` : ''}
                    <span class="module-title"><i class="${courseHtmlText(module.icon)}"></i> ${courseHtmlText(module.title)}</span>
                    <i class="fa-solid fa-chevron-down module-toggle-chevron"></i>
                </div>
                <div class="module-content">`;

            let inGrid = false;
            module.materials.forEach(material => {
                if (material.isDescription) {
                    if (inGrid) { html += `</div>`; inGrid = false; }
                    html += `<div class="project-module-description">${courseRichHtml(material.text)}</div>`;
                } else if (material.kind === 'pigeon') {
                    if (!inGrid) { html += `<div class="${gridClass}">`; inGrid = true; }
                    html += pigeonCardHtml(material);
                } else {
                    if (!inGrid) { html += `<div class="${gridClass}">`; inGrid = true; }
                    html += `
                    <div class="material-card ${courseHtmlText(material.fileTypeClass || '')}">
                        <div class="material-card-header">
                            <i class="${courseHtmlText(material.icon)} material-icon"></i>
                            <div class="material-info">
                                <div class="material-title">${courseHtmlText(material.title)}</div>
                                <div class="material-description">${courseRichHtml(material.description)}</div>
                            </div>
                        </div>
                        <div class="material-card-actions">
                            ${courseActionButton(material.viewLink, 'view')}
${courseActionButton(material.downloadLink, 'download')}
${courseActionButton(material.openLink, 'open')}
                        </div>
                    </div>`;
                }
            });
            if (inGrid) { html += `</div>`; }
            module.funFacts.forEach(funFact => {
                html += `<div class="fun-fact"><i class="fa-solid fa-lightbulb fun-fact-icon"></i><span class="fun-fact-text">${courseRichHtml(funFact.text)}</span></div>`;
            });
            html += `</div></div>`;
        }
    });
    return html;
}

function updateActiveNavLink() {
    if (isProgrammaticScroll) return;

    let activeModuleId = '';
    const modules = document.querySelectorAll('.module');
    const navLinks = document.querySelectorAll('.side-nav-item');
    const offset = window.innerHeight / 2;
    modules.forEach(module => {
        const rect = module.getBoundingClientRect();
        if (rect.top <= offset && rect.bottom >= offset) {
            activeModuleId = module.id;
        }
    });
    navLinks.forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === `#${activeModuleId}`);
    });
}

function calculateWeek(startDate, endDate, holidayWeeks = 0, holidayStart = null) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date();
    const oneWeek = 7 * 24 * 60 * 60 * 1000;

    const totalWeeks = Math.ceil((end - start) / oneWeek) - (parseInt(holidayWeeks || 0));
    const rawWeek = Math.ceil((today - start) / oneWeek);

    if (rawWeek < 1) return 1;

    let adjustedWeek = rawWeek;

    if (holidayStart && holidayWeeks > 0) {
        const hStart = new Date(holidayStart);
        const holidayStartWeek = Math.ceil((hStart - start) / oneWeek);

        if (rawWeek >= holidayStartWeek) {
            if (rawWeek < holidayStartWeek + parseInt(holidayWeeks)) {
                // In holiday period: return last active week
                return Math.max(1, holidayStartWeek - 1);
            } else {
                // Past holiday: subtract duration
                adjustedWeek = rawWeek - parseInt(holidayWeeks);
            }
        }
    } else {
        if (parseInt(holidayWeeks || 0) > 0) {
            adjustedWeek = rawWeek - parseInt(holidayWeeks || 0);
        }
    }

    return Math.min(Math.max(adjustedWeek, 1), totalWeeks);
}

function updateWeekProgress(startDate = "2025-02-24", endDate = "2025-06-14", holidayWeeks = 0, holidayStart = null) {
    const weekCounter = document.getElementById('week-counter');
    weekCounter.textContent = `Week ${calculateWeek(startDate, endDate, holidayWeeks, holidayStart)}`;
    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date();
    const totalDuration = end - start;
    const elapsedDuration = today - start;
    let progressPercentage = Math.min(Math.max((elapsedDuration / totalDuration) * 100, 0), 100);
    document.getElementById('progress-bar').style.width = progressPercentage + '%';
}

// Grading categories, in display order. Mirrors GRADING_CATEGORIES in js/course-editor.js.
// `legacyKey` still reads older single, un-numbered keys.
const GRADING_CATEGORIES = [
    { id: 'hw', singular: 'Homework', plural: 'Homeworks' },
    { id: 'project', singular: 'Project', plural: 'Projects', legacyKey: 'term_project_percentage' },
    { id: 'casestudy', singular: 'Case Study', plural: 'Case Studies' },
    { id: 'lab', singular: 'Laboratory', plural: 'Laboratories' },
    { id: 'quiz', singular: 'Quiz', plural: 'Quizzes' },
    { id: 'midterm', singular: 'Midterm', plural: 'Midterms', legacyKey: 'midterm_percentage' },
    { id: 'final', singular: 'Final', plural: 'Final', fixed: true, key: 'final_percentage' },
    { id: 'attendance', singular: 'Attendance', plural: 'Attendance', fixed: true, key: 'attendance_percentage' },
    { id: 'other', singular: 'Other', plural: 'Other' },
];

// Existing numbered + legacy entries for a category, e.g. quiz1_percentage, quiz2_percentage.
function gradingItemsFor(cat, metadata) {
    if (cat.fixed) return [{ key: cat.key }];
    const re = new RegExp(`^${cat.id}(\\d+)_percentage$`);
    const nums = [];
    for (const k of Object.keys(metadata)) {
        const m = k.match(re);
        if (m) nums.push(parseInt(m[1], 10));
    }
    nums.sort((a, b) => a - b);
    const items = nums.map(n => ({ key: `${cat.id}${n}_percentage` }));
    if (cat.legacyKey && metadata[cat.legacyKey]) items.push({ key: cat.legacyKey });
    return items;
}

function hasEvaluationData(metadata) {
    return GRADING_CATEGORIES.some(cat =>
        gradingItemsFor(cat, metadata).some(item => parseFloat(metadata[item.key]) > 0)
    );
}


function generateGradeDistribution(metadata) {
    const bar = document.getElementById('distribution-bar');
    const legend = document.getElementById('distribution-legend');
    bar.innerHTML = '';
    legend.innerHTML = '';

    const colorSets = {
        hw: ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.19)', 'rgba(255,255,255,0.16)', 'rgba(255,255,255,0.13)'],
        project: ['rgba(255,255,255,0.38)', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0.32)'],
        casestudy: ['rgba(255,255,255,0.44)', 'rgba(255,255,255,0.41)'],
        lab: ['rgba(255,255,255,0.50)', 'rgba(255,255,255,0.47)'],
        quiz: ['rgba(255,255,255,0.30)', 'rgba(255,255,255,0.27)', 'rgba(255,255,255,0.24)', 'rgba(255,255,255,0.21)'],
        midterm: ['rgba(255,255,255,0.42)', 'rgba(255,255,255,0.39)'],
        final: ['rgba(255,255,255,0.48)'],
        attendance: ['rgba(255,255,255,0.15)'],
        other: ['rgba(255,255,255,0.20)', 'rgba(255,255,255,0.17)'],
    };
    const legendColors = {
        hw: 'rgba(255,255,255,0.6)', project: 'rgba(255,255,255,0.7)', casestudy: 'rgba(255,255,255,0.66)',
        lab: 'rgba(255,255,255,0.72)', quiz: 'rgba(255,255,255,0.65)', midterm: 'rgba(255,255,255,0.75)',
        final: 'rgba(255,255,255,0.8)', attendance: 'rgba(255,255,255,0.55)', other: 'rgba(255,255,255,0.58)',
    };

    GRADING_CATEGORIES.forEach(cat => {
        const colors = colorSets[cat.id] || ['rgba(255,255,255,0.3)'];
        let totalPercentage = 0;
        let nonZeroCount = 0;
        let colorIndex = 0;
        gradingItemsFor(cat, metadata).forEach(item => {
            const percentage = parseFloat(metadata[item.key]) || 0;
            if (percentage > 0) {
                const segment = document.createElement('div');
                segment.setAttribute('class', 'distribution-segment');
                segment.style.width = `${percentage}%`;

                const statusKey = item.key + '_status';
                const isDone = (metadata[statusKey] || '').trim().toUpperCase() === 'DONE';
                segment.style.backgroundColor = isDone ? 'var(--success-color)' : colors[colorIndex % colors.length];

                const display = percentage % 1 === 0 ? percentage.toFixed(0) : percentage + '';
                segment.innerHTML = `<div class="segment-percentage">${display}%</div>`;
                bar.appendChild(segment);
                totalPercentage += percentage;
                nonZeroCount++;
                colorIndex++;
            }
        });

        if (totalPercentage > 0) {
            const legendItem = document.createElement('div');
            legendItem.setAttribute('class', 'legend-item');
            legendItem.style.width = `${totalPercentage}%`;
            legendItem.textContent = nonZeroCount > 1 ? cat.plural : cat.singular;
            legendItem.style.color = legendColors[cat.id] || colors[0];
            legend.appendChild(legendItem);
        }
    });
}

function updateYear() {
    const yearEl = document.getElementById('currentYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
}

// Fills the footer's owner-specific bits from config.js so the
// markup itself stays identical across deployments (only config.js differs).
function applyOwnerBranding() {
    const owner = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.owner) || {};
    const name = document.getElementById('footer-owner');
    if (name && owner.name) name.textContent = owner.name;
    const startYear = document.getElementById('footer-start-year');
    if (startYear && owner.startYear) startYear.textContent = owner.startYear;
    const home = document.getElementById('footer-home');
    if (home && owner.homeUrl) home.href = owner.homeUrl;
}

// Applies the default colour palette from config.js as CSS custom properties.
// Runs before any per-course theming, so a course's own colours still override.
function applyThemeDefaults() {
    const t = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.theme) || {};
    const root = document.documentElement.style;
    const map = {
        '--primary-color': t.primary,
        '--primary-dark': t.primaryDark,
        '--secondary-color': t.secondary,
        '--tertiary-color': t.tertiary,
        '--accent-color': t.accent,
        '--success-color': t.success,
    };
    Object.entries(map).forEach(([prop, val]) => { if (val) root.setProperty(prop, val); });
}

function showImprovedNotification(type, title, message, duration) {
    if (type === 'success' && title === 'Course Loaded') return;
    if (isInitializing || criticalErrorsOnly) {
        if (!(type === 'error' && (title.includes('Critical') || message.includes('Permission denied')))) {
            pendingNotifications.push({ type, title, message, duration });
            return;
        }
    }
    const safeRemove = (el) => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
    };
    const area = document.getElementById('notification-area');
    if (!area) return;
    area.querySelectorAll(`.in-page-notification-${type}`).forEach(n => {
        n.classList.add('removing');
        setTimeout(() => safeRemove(n), 300);
    });
    const allNotifs = area.querySelectorAll('.in-page-notification');
    if (allNotifs.length >= 2) {
        const oldest = allNotifs[0];
        oldest.classList.add('removing');
        setTimeout(() => safeRemove(oldest), 300);
    }
    const notification = document.createElement('div');
    notification.setAttribute('class', `in-page-notification in-page-notification-${type}`);
    let icon = 'info-circle';
    if (type === 'success') icon = 'check-circle';
    if (type === 'error') icon = 'times-circle';
    if (type === 'warning') icon = 'exclamation-circle';
    notification.innerHTML = `<i class="fa-solid fa-${icon}"></i><div style="flex-grow:1;"><strong>${courseHtmlText(title)}</strong><br>${courseHtmlText(message)}</div><button class="notification-close">&times;</button>`;
    area.appendChild(notification);
    notification.querySelector('.notification-close').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        notification.classList.add('removing');
        setTimeout(() => safeRemove(notification), 300);
    };
    if (type !== 'error') {
        setTimeout(() => {
            notification.classList.add('removing');
            setTimeout(() => safeRemove(notification), 300);
        }, duration || 5000);
    }
}

function processPendingNotifications() {
    if (pendingNotifications.length > 0) {
        const unique = {};
        for (const n of pendingNotifications) {
            unique[n.type + n.title] = n;
        }
        Object.values(unique).forEach(n => showImprovedNotification(n.type, n.title, n.message, n.duration));
        pendingNotifications = [];
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
