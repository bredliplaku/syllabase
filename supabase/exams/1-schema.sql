-- 1 of 2: the private exam tables and helpers. Applied as migration "exam_private_schema"; that
-- version also had attendance columns, a sealed_links table, a required student ID and a single
-- 'named' sign-in, which 2-functions.sql brings up to date.

-- Exams: class lists, exam IDs, exams, submissions and Student ID sign-in sessions.
-- The schema is not exposed through the API and has RLS with no policies: every read
-- and write goes through the public.exam_* functions, which check the caller themselves.
create schema exam_private;
revoke all on schema exam_private from public, anon, authenticated;

-- Who takes a course offering, pasted from the EIS class list.
create table exam_private.students (
  id uuid primary key default gen_random_uuid(),
  sheet_name text not null,
  is_archive boolean not null default false,
  student_no text not null default '',   -- optional; Student ID sign-in needs it
  full_name text not null default '',
  email text not null default '' check (email = lower(btrim(email))),
  programme text not null default '',
  exam_code text not null default '',    -- the lecturer's own label; no part in sign-in or results
  note text not null default '',          -- what followed the name in EIS, e.g. 'R EX'
  list_order integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint students_identity_check check (student_no <> '' or email <> '')
);
create unique index students_no_uq on exam_private.students (sheet_name, is_archive, student_no) where student_no <> '';
create unique index students_email_uq on exam_private.students (sheet_name, is_archive, email) where email <> '';
create index students_email_idx on exam_private.students (email);
create index students_no_idx on exam_private.students (student_no);

-- Anonymous exam IDs for a course offering. EIS randomises them every semester,
-- and they are never linked to a student here.
create table exam_private.exam_codes (
  sheet_name text not null,
  is_archive boolean not null default false,
  code text not null check (code <> ''),
  list_order integer not null default 0,
  primary key (sheet_name, is_archive, code)
);

create table exam_private.exams (
  id uuid primary key default gen_random_uuid(),
  sheet_name text not null,
  is_archive boolean not null default false,
  label text not null default '',
  type text not null check (type in ('quiz', 'assignment', 'project', 'midterm_project', 'final_project',
    'other', 'final_exam', 'midterm_exam', 'resit_exam', 'additional_exam')),
  starts_at timestamptz,
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  hall text not null default '',
  weight numeric check (weight is null or (weight >= 0 and weight <= 100)),
  grading_key text not null default '',   -- the Grading tab entry it counts as, e.g. midterm1_percentage
  base numeric not null default 100 check (base > 0),
  sign_in text not null default 'student_id', -- 'student_id', 'google' or 'anonymous' (exam IDs)
  constraint exams_sign_in_check check (sign_in in ('student_id', 'google', 'anonymous')),
  password_hash text,
  shuffle_questions boolean not null default true,
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  visible boolean not null default false, -- listed for students and on the course page
  results_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index exams_course_idx on exam_private.exams (sheet_name, is_archive);

-- Named submissions carry a snapshot of the student; anonymous ones only the exam ID.
create table exam_private.submissions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exam_private.exams (id) on delete cascade,
  student_id uuid references exam_private.students (id) on delete set null,
  student_no text not null default '',
  student_name text not null default '',
  student_email text not null default '',
  exam_code text,
  submitted_at timestamptz not null default now(),
  answers jsonb not null default '{}'::jsonb,
  fingerprint jsonb not null default '{}'::jsonb,
  auto_submitted boolean not null default false,
  late boolean not null default false,
  status text not null default 'submitted' check (status in ('submitted', 'graded')),
  grades jsonb,
  graded_at timestamptz,
  check ((student_no <> '') <> (exam_code is not null))
);
create unique index submissions_named_uq on exam_private.submissions (exam_id, student_no) where exam_code is null;
create unique index submissions_anon_uq on exam_private.submissions (exam_id, exam_code) where exam_code is not null;

-- Student ID sign-ins and anonymous exam attempts. Only a hash of each token is kept.
create table exam_private.sessions (
  token_hash text primary key,
  kind text not null check (kind in ('student', 'anonymous')),
  student_id uuid references exam_private.students (id) on delete cascade,
  exam_id uuid references exam_private.exams (id) on delete cascade,
  exam_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table exam_private.students enable row level security;
alter table exam_private.exam_codes enable row level security;
alter table exam_private.exams enable row level security;
alter table exam_private.submissions enable row level security;
alter table exam_private.sessions enable row level security;

-- ── Helpers ──

-- 'manage' for admins and the course's lecturers, 'grade' for its TAs (Student role), else null.
create function exam_private.course_access(p_sheet text, p_archive boolean) returns text
language plpgsql stable security definer set search_path = '' as $$
declare r text := public.teaching_role();
begin
  if r = 'admin' then return 'manage'; end if;
  if r is null or r not in ('lecturer', 'student') or not exists (
    select 1 from public.teaching_assignments a where a.email = teaching_private.email()
      and a.sheet_name = p_sheet and a.is_archive = p_archive) then return null; end if;
  return case r when 'lecturer' then 'manage' else 'grade' end;
end $$;

create function exam_private.require_access(p_sheet text, p_archive boolean, p_manage boolean) returns text
language plpgsql stable security definer set search_path = '' as $$
declare a text := exam_private.course_access(p_sheet, p_archive);
begin
  if a is null or (p_manage and a <> 'manage') then
    raise exception 'You do not have permission to change this course''s exams' using errcode = '42501';
  end if;
  return a;
end $$;

create function exam_private.token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create function exam_private.new_session(p_kind text, p_student uuid, p_exam uuid, p_code text, p_until timestamptz) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from exam_private.sessions where expires_at < now();
  insert into exam_private.sessions (token_hash, kind, student_id, exam_id, exam_code, expires_at)
    values (exam_private.token_hash(token), p_kind, p_student, p_exam, p_code, p_until);
  return token;
end $$;

-- The class-list rows the caller is: by their Google email, or by a Student ID sign-in.
create function exam_private.my_students(p_token text) returns setof exam_private.students
language sql stable security definer set search_path = '' as $$
  select s.* from exam_private.students s
  where (teaching_private.email() is not null and s.email <> '' and s.email = teaching_private.email())
     or s.id = (select x.student_id from exam_private.sessions x
                where x.token_hash = exam_private.token_hash(p_token) and x.kind = 'student' and x.expires_at > now())
$$;

-- The signed-in student's email: Google's, or the Student ID sign-in's class-list email.
create function exam_private.my_email(p_token text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(teaching_private.email(), (select nullif(s.email, '') from exam_private.sessions x
    join exam_private.students s on s.id = x.student_id
    where x.token_hash = exam_private.token_hash(p_token) and x.kind = 'student' and x.expires_at > now()))
$$;

create function exam_private.course_meta(p_sheet text, p_archive boolean, p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select c from public.course_rows where sheet_name = p_sheet and is_archive = p_archive
    and type = 'metadata' and b = p_key order by row_index desc limit 1
$$;

-- Questions as students receive them: without anything that gives the answer away.
create function exam_private.student_questions(p_questions jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(q - array['correct_answers', 'accepted_answers', 'answer', 'tolerance', 'explanation'] order by ord), '[]'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as t(q, ord)
$$;

create function exam_private.ends_at(e exam_private.exams) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when e.starts_at is not null and e.duration_minutes is not null
    then e.starts_at + make_interval(mins => e.duration_minutes) end
$$;

-- Online now: listed, has questions, and inside its start + duration window.
create function exam_private.is_open(e exam_private.exams) returns boolean
language sql stable set search_path = '' as $$
  select e.visible and jsonb_array_length(e.questions) > 0 and e.starts_at is not null
    and e.duration_minutes is not null and now() >= e.starts_at and now() < exam_private.ends_at(e)
$$;

-- An exam as students see it: no password, no correct answers, no questions.
create function exam_private.exam_summary(e exam_private.exams) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'label', e.label, 'type', e.type, 'starts_at', e.starts_at,
    'duration_minutes', e.duration_minutes, 'ends_at', exam_private.ends_at(e), 'hall', e.hall,
    'weight', e.weight, 'base', e.base, 'sign_in', e.sign_in, 'shuffle_questions', e.shuffle_questions,
    'has_password', e.password_hash is not null, 'question_count', jsonb_array_length(e.questions),
    'is_open', exam_private.is_open(e), 'results_published', e.results_published,
    'sheet_name', e.sheet_name,
    'course_code', exam_private.course_meta(e.sheet_name, e.is_archive, 'code'),
    'course_title', exam_private.course_meta(e.sheet_name, e.is_archive, 'title'))
$$;

revoke all on all functions in schema exam_private from public, anon, authenticated;
