// Chooses the loading skeleton before the first paint, from what this browser already
// knows. Sets on <html> (read by the "Skeleton loaders" styles in css/main.css):
//   data-skeleton="signed-in" | "signed-out"  a stored session, or none: the panel or the
//                                             sign-in page is drawn while it is checked
//   data-skeleton-course[="archive"]          the panel will reopen a course (archived)
//   data-skeleton-admin                       ?admin: the sign-in button above the list
//   data-skeleton-finder="open"               the signed-out course list starts open
//   --skel-brand                              the colour of the course being opened
// Load it without defer in <head>, naming the page in data-page. On a lecturer website,
// embed.js runs it just before mounting the page, with data-embedded and, when the file
// names its lecturer, that lecturer's id in data-site (their own sign-in is kept under it).
(function () {
    'use strict';
    const root = document.documentElement;
    const options = document.currentScript?.dataset || {};
    // Older copies of embed.js run this after the lecturer is known, with no attributes.
    const embedded = 'embedded' in options || !!window.TEACHING_SITE;
    const siteId = options.site || window.TEACHING_SITE?.id || '';
    const page = options.page || (window.TEACHING_EMBEDDED_ADMIN ? 'admin' : 'course');
    const COLOURS_KEY = 'skeleton_colours';

    const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
    const readJson = key => { try { return JSON.parse(read(key)); } catch { return null; } };
    const colour = value => {
        const hex = String(value || '').trim().replace(/^(?!#)/, '#');
        return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? hex : '';
    };
    const escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // A Supabase session that can still refresh, as the pages themselves check it.
    function storedSession(pattern) {
        try {
            return Object.keys(localStorage).some(key => {
                if (!pattern.test(key)) return false;
                const data = JSON.parse(localStorage.getItem(key));
                return !!(data?.access_token && data?.refresh_token);
            });
        } catch { return false; }
    }

    // Returning from Google: the new session is still in the address.
    const returning = /(^#|&)access_token=/.test(location.hash) || new URLSearchParams(location.search).has('code');
    // Project references have no hyphens, so the exam portal's own session never counts here.
    // A lecturer website's file without its lecturer's id: any lecturer's sign-in here.
    const teachingKey = !embedded ? /^sb-[a-z0-9]+-auth-token$/
        : new RegExp(`^sb-[a-z0-9]+-teaching-${siteId ? escape(siteId) : '[\\w-]+'}-auth-token$`);

    function courseColour(course) {
        const saved = readJson(COLOURS_KEY);
        if (!saved || typeof saved !== 'object') return '';
        const courses = saved.courses && typeof saved.courses === 'object' ? saved.courses : {};
        return colour(course && Object.hasOwn(courses, course) ? courses[course] : saved.last);
    }

    let signedIn = false, course = '';
    if (page === 'admin' || page === 'timetable-admin') {
        signedIn = returning || storedSession(teachingKey);
    } else if (page === 'exam') {
        // Signed in with Google or a student ID, or an anonymous exam to resume.
        const student = readJson('examStudentSession');
        const exam = readJson('examAppState');
        signedIn = returning || storedSession(/^sb-[a-z0-9]+-exam-auth-token$/)
            || !!(student?.token && Date.parse(student.expires_at) > Date.now())
            || !!(exam?.examDetails?.Kind === 'anonymous' && exam.examEndTime > Date.now());
    }

    if (page === 'admin') {
        const adminPage = !!window.TEACHING_EMBEDDED_ADMIN || new URLSearchParams(location.search).has('admin');
        if (signedIn) {
            const last = readJson('admin_last_course');
            if (Array.isArray(last) && last[0]) {
                course = String(last[0]);
                root.dataset.skeletonCourse = last[1] ? 'archive' : '';
            }
        } else {
            // As js/course-finder.js opens it: the homepage starts open, ?admin closed.
            const open = read(adminPage ? 'course_finder_open_admin' : 'course_finder_open');
            if (open === null ? !adminPage : open === '1') root.dataset.skeletonFinder = 'open';
        }
        if (adminPage) root.dataset.skeletonAdmin = '';
    } else if (page === 'course') {
        try {
            const hash = decodeURIComponent(location.hash.slice(1));
            if (!hash.startsWith('module-')) course = hash;
        } catch { }
    }

    root.dataset.skeleton = signedIn ? 'signed-in' : 'signed-out';
    const brand = (page === 'course' || (page === 'admin' && course)) ? courseColour(course) : '';
    if (brand) root.style.setProperty('--skel-brand', brand);

    // The course page and the panel call this as they show a course in its colours, so
    // the next skeleton for it starts in the same colour.
    window.TeachingSkeleton = {
        rememberColour(name, value) {
            if (!name) return;
            const hex = colour(value);
            try {
                const saved = readJson(COLOURS_KEY);
                const courses = saved?.courses && typeof saved.courses === 'object' ? saved.courses : {};
                // Re-added at the end, so the oldest courses are the first dropped.
                delete courses[name];
                if (hex) courses[name] = hex;
                Object.keys(courses).slice(0, -60).forEach(key => delete courses[key]);
                localStorage.setItem(COLOURS_KEY, JSON.stringify({ last: hex, courses }));
            } catch { }
        }
    };
})();
