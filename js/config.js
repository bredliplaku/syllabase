// Shared browser configuration for teaching, timetable and lecturer websites.
// Publish this file with the site. The anon key and Google client ID are public;
// database policies enforce access. Never put a service-role key or secret here.
window.TEACHING_CONFIG = {
    // Derived from this script, including when loaded on a lecturer's domain.
    appBaseUrl: new URL('../', document.currentScript.src).href,
    // --- Supabase (public course page + admin) ---
    supabaseUrl: 'https://sreqxyznaymvksygradu.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyZXF4eXpuYXltdmtzeWdyYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMDQ5NzksImV4cCI6MjA5NTc4MDk3OX0.-B-vzU8ZRkUnEp697N0nclLvomdP2k-dt9fPcJNV-gY',

    // --- Google Sign-In (admin login only; public page ignores this) ---
    googleClientId: '740588046540-975b4g8i4915hps31p1ioi0e000f4boi.apps.googleusercontent.com',

    // --- Google Drive Picker (admin file forms only; optional) ---
    // Lets the Drive buttons browse or upload to your Drive instead of pasting a link.
    // Leave blank to still use the picker with just your OAuth token — a Google Cloud
    // API key (developer key) only removes Google's quota nag and is otherwise optional.
    // Restrict the key to the Picker API + your site's referrer before committing it.
    googleApiKey: '',

    // --- PigeonFiles (admin only; optional) ---
    // Where lecturers create the upload pages that PigeonFiles submission cards link to.
    // The card's form links here. Leave blank to hide that link.
    pigeonUrl: 'https://pigeonfiles.com/',

    // --- Floating cat companion on the main public course page (true = shown) ---
    // Lecturer websites disable it in embed.js.
    catCompanion: true,

    // --- Copyright and footer links (public page + admin) ---
    // Lecturer websites retain this copyright; the end year updates automatically.
    owner: {
        name: 'Bredli Plaku',
        startYear: 2023,
        homeUrl: '/',              // root of the website the visitor is on
    },

    // --- Default colour palette. Applied to both the public page and admin.
    //     On the public page, a course's own custom colours still override these. ---
    theme: {
        primary: '#3949ab',
        primaryDark: '#1a237e',
        secondary: '#ffa726',
        tertiary: '#2196F3',
        accent: '#9c27b0',
        success: '#43a047',
    },
};
