/* ==========================================================================
   store.js — the student page's connection to the exam database (/exam/).

   Every read and write goes through the public.exam_* database functions,
   which check the caller themselves:
   - Google sign-in: a Supabase session, stored apart from the course editor's
     so signing in here never signs anyone into the editor (or out of it).
     Class lists are matched by email.
   - Student ID sign-in: a token from exam_student_sign_in, for the course of
     the exam whose password was used, valid until shortly after that exam ends.
   - Anonymous exams and grades looked up by exam ID use a second client that
     never carries a session, so those requests can't be tied to a signed-in student.

   Plain (non-module) script: examStore is a window global. Load it after the
   Supabase library and ../js/config.js, and before js/scripts.js.
   ========================================================================== */

const examStore = (() => {
    const cfg = window.TEACHING_CONFIG;
    const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
    const STUDENT_KEY = 'examStudentSession'; // localStorage: { token, expires_at, name, student_no }

    const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { flowType: 'implicit', storageKey: `sb-${projectRef}-exam-auth-token`, detectSessionInUrl: true, persistSession: true },
    });
    const anonymous = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { storageKey: `sb-${projectRef}-exam-anonymous`, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    function studentSession() {
        try {
            const s = JSON.parse(localStorage.getItem(STUDENT_KEY) || 'null');
            if (s?.token && Date.parse(s.expires_at) > Date.now()) return s;
        } catch { }
        try { localStorage.removeItem(STUDENT_KEY); } catch { }
        return null;
    }
    const token = () => studentSession()?.token || null;

    async function call(client, fn, args) {
        const { data, error } = await client.rpc(fn, args);
        if (error) throw new Error(error.message || 'Something went wrong. Please try again.');
        return data;
    }

    return {
        // { via: 'google', email, name, picture } | { via: 'student_id', name, student_no } | null
        async currentUser() {
            const { data: { session } } = await sb.auth.getSession();
            if (session) {
                const u = session.user, meta = u.user_metadata || {};
                return { via: 'google', email: (u.email || '').toLowerCase(), name: meta.full_name || meta.name || u.email,
                    picture: [meta.avatar_url, meta.picture].find(url => /^https:\/\//.test(url || '')) || '' };
            }
            const s = studentSession();
            return s ? { via: 'student_id', name: s.name, student_no: s.student_no, email: '' } : null;
        },

        // Google always asks which account: lab computers often have several signed in.
        async signInWithGoogle() {
            try { localStorage.removeItem(STUDENT_KEY); } catch { }
            const { error } = await sb.auth.signInWithOAuth({
                provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname, queryParams: { prompt: 'select_account' } },
            });
            if (error) throw new Error(error.message);
        },

        // Sign-outs end this page's Google sign-in only ('local'): the default would also end
        // the same account's sign-ins elsewhere, such as a lecturer's course editor.
        async signInWithStudentId(studentNo, password) {
            await sb.auth.signOut({ scope: 'local' }).catch(() => { });
            const data = await call(anonymous, 'exam_student_sign_in', { p_student_no: studentNo, p_password: password });
            localStorage.setItem(STUDENT_KEY, JSON.stringify(data));
            return data;
        },

        async signOut() {
            const t = token();
            try { localStorage.removeItem(STUDENT_KEY); } catch { }
            if (t) await call(anonymous, 'exam_sign_out', { p_token: t }).catch(() => { });
            await sb.auth.signOut({ scope: 'local' }).catch(() => { });
        },

        // --- Signed in ---
        dashboard: () => call(sb, 'exam_dashboard', { p_token: token() }),
        startExam: (examId, password) => call(sb, 'exam_start', { p_exam_id: examId, p_token: token(), p_password: password || null }),
        submitExam: (examId, submission) => call(sb, 'exam_submit', { p_exam_id: examId, p_token: token(), p_submission: submission }),
        myResult: examId => call(sb, 'exam_my_result', { p_exam_id: examId, p_token: token() }),

        // --- Anonymous: never sent with the student's session ---
        anonymousStart: (code, password) => call(anonymous, 'exam_anonymous_start', { p_code: code, p_password: password }),
        anonymousSubmit: (examToken, submission) => call(anonymous, 'exam_anonymous_submit', { p_token: examToken, p_submission: submission }),
        // Exam IDs are reshuffled every semester: a lookup names its course offering.
        codeResults: (sheet, archive, code) => call(anonymous, 'exam_code_results', { p_sheet: sheet, p_archive: archive, p_code: code }),
        resultCourses: () => call(anonymous, 'exam_result_courses', {}),
    };
})();
