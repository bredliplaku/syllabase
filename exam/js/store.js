/* ==========================================================================
   store.js — the student page's connection to the exam database (/exam/).

   Every read and write goes through the public.exam_* database functions,
   which check the caller themselves:
   - Google sign-in: a Supabase session, stored apart from the course editor's
     so signing in here never signs anyone into the editor (or out of it).
     Class lists are matched by email.
   - Student ID sign-in: a token from exam_student_sign_in, for the course of
     the exam whose password was used, valid until shortly after that exam ends.
   - Anonymous exams use a second client that never carries a session, so those
     requests can't be tied to a signed-in student.
   Submissions carry the attempt's submit key, so answers kept on the device
   while the connection was gone are taken once it is back, signed in or not.

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

    // This browser, for "one device at a time": kept, so a reload or a reboot is the same device.
    const DEVICE_KEY = 'examDeviceId';
    let device = null;
    function deviceId() {
        if (device) return device;
        try { device = localStorage.getItem(DEVICE_KEY); } catch { }
        if (!device) {
            device = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            try { localStorage.setItem(DEVICE_KEY, device); } catch { }
        }
        return device;
    }

    // An error carries offline = true when the request never reached the server.
    async function call(client, fn, args) {
        let result;
        try {
            result = await client.rpc(fn, args);
        } catch (e) {
            throw Object.assign(new Error('No connection. Check the internet and try again.'), { offline: true });
        }
        const { data, error } = result;
        if (error) {
            const offline = !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed/i.test(error.message || '');
            throw Object.assign(new Error(offline ? 'No connection. Check the internet and try again.' : (error.message || 'Something went wrong. Please try again.')),
                { offline, code: error.code, hint: error.hint });
        }
        return data;
    }

    // A file answer, straight to Storage at the path exam_upload_start gave (its policy lets
    // that one file in). A plain request rather than the client's, for the progress.
    function uploadFile(target, file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const path = target.path.split('/').map(encodeURIComponent).join('/');
            xhr.open('POST', `${cfg.supabaseUrl}/storage/v1/object/${encodeURIComponent(target.bucket)}/${path}`);
            xhr.setRequestHeader('apikey', cfg.supabaseAnonKey);
            xhr.setRequestHeader('Authorization', `Bearer ${cfg.supabaseAnonKey}`);
            xhr.setRequestHeader('x-upsert', 'false');
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) return resolve();
                let message = '';
                try { message = JSON.parse(xhr.responseText).message || ''; } catch { }
                reject(new Error(message || `The upload was refused (${xhr.status})`));
            };
            xhr.onerror = () => reject(new Error('The upload failed. Check the connection and try again'));
            xhr.send(file);
        });
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
            const data = await call(anonymous, 'exam_student_sign_in', { p_student_no: studentNo, p_password: password, p_device: deviceId() });
            localStorage.setItem(STUDENT_KEY, JSON.stringify(data));
            return data;
        },

        // Also frees this device's exams for another device at once. Without a connection the
        // Google sign-in is still forgotten here (supabase-js keeps it when it can't reach the
        // server), so the next student at this computer never finds it.
        async signOut() {
            const t = token();
            try { localStorage.removeItem(STUDENT_KEY); } catch { }
            await call(anonymous, 'exam_sign_out', { p_token: t, p_device: deviceId() }).catch(() => { });
            const result = await sb.auth.signOut({ scope: 'local' }).catch(error => ({ error }));
            if (result?.error) { try { localStorage.removeItem(`sb-${projectRef}-exam-auth-token`); } catch { } }
        },
        // The Student ID sign-in is over (the server says so): forget it here.
        forgetStudentSession() { try { localStorage.removeItem(STUDENT_KEY); } catch { } },
        // The server keeps the sign-in going for as long as an exam runs (exam_heartbeat).
        extendStudentSession(until) {
            const s = studentSession();
            if (!s || !until || Date.parse(until) <= Date.parse(s.expires_at)) return;
            try { localStorage.setItem(STUDENT_KEY, JSON.stringify({ ...s, expires_at: until })); } catch { }
        },
        token,
        deviceId,

        // Every 30 seconds while signed in with a student ID or taking an exam: keeps both going,
        // with the answers so far. examToken: an anonymous exam's session.
        heartbeat: (examId, examToken, draft) => call(examToken ? anonymous : sb, 'exam_heartbeat', {
            p_token: examToken || token(), p_device: deviceId(), p_exam_id: examId || null, p_draft: draft || null,
        }),

        // --- Signed in ---
        dashboard: () => call(sb, 'exam_dashboard', { p_token: token() }),
        startExam: (examId, password) => call(sb, 'exam_start', { p_exam_id: examId, p_token: token(), p_password: password || null, p_device: deviceId() }),
        submitExam: (examId, submission) => call(sb, 'exam_submit', { p_exam_id: examId, p_token: token(), p_submission: submission }),
        myResult: examId => call(sb, 'exam_my_result', { p_exam_id: examId, p_token: token() }),

        // --- The exam being taken. examToken: an anonymous exam's session (else the sign-in's) ---
        // As it is now (its questions or time may have changed), for the device taking it.
        current: (examId, examToken) => call(examToken ? anonymous : sb, 'exam_current', {
            p_exam_id: examId, p_token: examToken || token(), p_device: deviceId(),
        }),
        images: (examId, examToken) => (examToken
            ? call(anonymous, 'exam_images', { p_exam_id: examId, p_token: examToken })
            : call(sb, 'exam_images', { p_exam_id: examId, p_token: token() })),
        // A file answer: where it may go (question: its position in the exam, from 1), then the file.
        startUpload: (examId, examToken, question, file) => call(examToken ? anonymous : sb, 'exam_upload_start', {
            p_exam_id: examId, p_token: examToken || token(), p_question: question, p_name: file.name, p_size: file.size, p_device: deviceId(),
        }),
        uploadFile,

        // --- Anonymous: never sent with the student's session ---
        anonymousStart: (code, password) => call(anonymous, 'exam_anonymous_start', { p_code: code, p_password: password, p_device: deviceId() }),
        anonymousSubmit: (examToken, submission) => call(anonymous, 'exam_anonymous_submit', { p_token: examToken || '', p_submission: submission }),

        // --- Lecturers: whether this Google account teaches (the course editor's own check) ---
        async teachingAccess() {
            const { data: { session } } = await sb.auth.getSession();
            if (!session) return null;
            // null: no teaching access; false: it could not be checked (offline, say).
            return call(sb, 'teaching_access', {}).catch(() => false);
        },
        // The Google sign-in, handed to the lecturers' Syllatest (exam/manage/), which keeps its
        // sign-in where the course editor does: moved, not copied, so only one page refreshes
        // it. The account just chosen replaces one signed in there before.
        handOverSession() {
            const editorKey = `sb-${projectRef}-auth-token`, examKey = `sb-${projectRef}-exam-auth-token`;
            try {
                const stored = localStorage.getItem(examKey);
                if (!stored) return false;
                localStorage.setItem(editorKey, stored);
                localStorage.setItem(`${editorKey}-last-used`, String(Date.now()));
                localStorage.removeItem(examKey);
                return true;
            } catch { return false; }
        },
    };
})();
