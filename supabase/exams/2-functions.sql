-- 2 of 2: run in the Supabase SQL editor after 1-schema.sql. Safe to run again (after an
-- update, for instance): it brings the tables up to date and replaces the functions.
-- Exams: the public.exam_* functions the course editor and /exam/ call, the question images,
-- and the private Storage bucket exam-uploads (students' file answers) with its policies.
-- Needs the exam_private schema (already applied as migration "exam_private_schema").
-- Does not modify any existing function: archiving/restoring/deleting a course is
-- followed by exam_move_course / exam_delete_course from the editor.

-- What the applied schema has but no longer uses: attendance from the EIS class list,
-- and the encrypted exam-ID links (students now just enter their exam ID).
drop function if exists public.exam_links(text), public.exam_add_link(text, text), public.exam_remove_link(text, uuid);
-- Grades by exam ID now name the course offering too (exam IDs are reused across semesters).
drop function if exists public.exam_code_results(text);
drop table if exists exam_private.sealed_links;
-- Student ID sign-in uses the exam's own password (Exams tab): the course-wide class password
-- and its settings are gone.
drop function if exists public.exam_save_settings(text, boolean, boolean, text);
drop table if exists exam_private.course_settings;
alter table exam_private.students drop column if exists attendance_theory, drop column if exists attendance_practice;

-- Students need a name and an email; the student ID is optional (Student ID sign-in needs
-- it). Each is unique in a course offering when given. exam_code is the lecturer's own
-- label for pinpointing a student: it plays no part in sign-in or results.
alter table exam_private.students drop constraint if exists students_student_no_check;
alter table exam_private.students drop constraint if exists students_sheet_name_is_archive_student_no_key;
alter table exam_private.students alter column student_no set default '';
alter table exam_private.students add column if not exists exam_code text not null default '';
create unique index if not exists students_no_uq on exam_private.students (sheet_name, is_archive, student_no) where student_no <> '';
create unique index if not exists students_email_uq on exam_private.students (sheet_name, is_archive, email) where email <> '';
alter table exam_private.students drop constraint if exists students_identity_check;
alter table exam_private.students add constraint students_identity_check check (student_no <> '' or email <> '');

-- Who a named submission belongs to: the student ID, or the email when there is none.
create or replace function exam_private.student_key(s exam_private.students) returns text
language sql immutable set search_path = '' as $$ select coalesce(nullif(s.student_no, ''), s.email) $$;
revoke all on function exam_private.student_key(exam_private.students) from public, anon, authenticated;

-- How students sign in to an exam: 'student_id' (with the exam's password, set on the Exams
-- tab), 'google' (the class list's Google account), or 'anonymous' (exam IDs). The
-- applied schema had 'named', which allowed either of the first two.
alter table exam_private.exams drop constraint if exists exams_sign_in_check;
update exam_private.exams set sign_in = 'student_id' where sign_in not in ('student_id', 'google', 'anonymous');
alter table exam_private.exams alter column sign_in set default 'student_id';
alter table exam_private.exams add constraint exams_sign_in_check check (sign_in in ('student_id', 'google', 'anonymous'));

-- What the exam page does while an exam is taken (exam_private.clean_settings), and what it
-- recorded: when the student left the page, and for how long.
alter table exam_private.exams add column if not exists settings jsonb not null default '{}'::jsonb;
-- The exam password as the lecturer typed it, shown to them in the exam's settings (it is read
-- out or written on the board). Only the course's managers get it (exam_course); students are
-- checked against password_hash. Passwords set before this was kept stay hash-only until set again.
alter table exam_private.exams add column if not exists password_text text;
alter table exam_private.submissions add column if not exists activity jsonb not null default '{}'::jsonb;

-- Images shown with questions (a drawing to reproduce, a figure). Kept here beside the
-- questions and sent only to students taking the exam, so there is no link to pass on. The
-- exams of a course offering share them, so a duplicated exam keeps its images.
create table if not exists exam_private.images (
  id uuid primary key default gen_random_uuid(),
  sheet_name text not null,
  is_archive boolean not null default false,
  mime text not null check (mime in ('image/webp', 'image/png', 'image/jpeg')),
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists images_course_idx on exam_private.images (sheet_name, is_archive);
alter table exam_private.images enable row level security;

-- Files students upload as answers. The files are in the private Storage bucket exam-uploads,
-- at <exam id>/<upload id>/<file name>. A row is the ticket that lets one file go there, and
-- says whose answer it is: the student's key (student ID, or email) or the exam ID.
create table if not exists exam_private.uploads (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references exam_private.exams (id) on delete cascade,
  student_key text,
  exam_code text,
  question integer not null check (question > 0), -- position in the exam's questions, from 1
  file_name text not null,
  size_bytes bigint not null check (size_bytes > 0),
  path text not null unique,
  created_at timestamptz not null default now(),
  check ((student_key is null) <> (exam_code is null))
);
create index if not exists uploads_exam_idx on exam_private.uploads (exam_id);
alter table exam_private.uploads enable row level security;

-- One device at a time. A sign-in (Student ID, or an anonymous exam's) belongs to the device
-- (browser) that made it, which checks in every 30 seconds (exam_heartbeat); it ends after 30
-- minutes without one, and at ends_at in any case. An exam in progress belongs to one device
-- too, with the answers so far (the draft). Another device can take it over only when the
-- lecturer allows it (exam_allow_move: a computer that broke down), and carries on from the
-- draft; or when the lecturer handed it back (device 'returned'). Never by itself: a student
-- could otherwise give their exam to someone at another computer and take it back.
alter table exam_private.sessions add column if not exists device text;
alter table exam_private.sessions add column if not exists last_seen timestamptz not null default now();
alter table exam_private.sessions add column if not exists ends_at timestamptz;
create table if not exists exam_private.attempts (
  exam_id uuid not null references exam_private.exams (id) on delete cascade,
  who text not null,       -- the student's key (student ID, or email), or 'code:' and the exam ID
  device text not null,
  last_seen timestamptz not null default now(),
  draft jsonb,             -- answers, confirmations and the leave record, as last sent
  draft_at timestamptz,
  primary key (exam_id, who)
);
alter table exam_private.attempts enable row level security;
-- Where an exam was taken from, for the lecturer: each network (IP address, as the request
-- arrived) and device (browser) it was used from, with when and how often. Copied to the
-- submission.
alter table exam_private.attempts add column if not exists network jsonb not null default '[]'::jsonb;
-- When the lecturer allowed the exam to move to another computer (exam_allow_move): the next
-- device that takes it, within 30 minutes, has it. Cleared when one does.
alter table exam_private.attempts add column if not exists move_allowed_at timestamptz;
alter table exam_private.submissions add column if not exists network jsonb not null default '[]'::jsonb;
-- Where a submission came from: 'online' (the exam page), 'manual' (a grade the lecturer
-- entered without one: a paper exam, or a student who did not take it) or 'imported' (from the
-- student's backup file). delivery: how a late one arrived (kept on the device while offline,
-- sent after the end) or who imported it.
alter table exam_private.submissions add column if not exists source text not null default 'online';
alter table exam_private.submissions drop constraint if exists submissions_source_check;
alter table exam_private.submissions add constraint submissions_source_check check (source in ('online', 'manual', 'imported'));
alter table exam_private.submissions add column if not exists delivery jsonb;
-- An exam in progress can always be submitted with its submit key (given when it starts, kept
-- on the device), also once the sign-in has ended: answers kept through a lost connection are
-- sent when it is back. returned: submissions the lecturer handed back, so the student could
-- carry on with the exam.
alter table exam_private.attempts add column if not exists submit_key_hash text;
alter table exam_private.attempts add column if not exists returned jsonb not null default '[]'::jsonb;
alter table exam_private.attempts add column if not exists returned_at timestamptz;
-- Files for a question that was removed keep question 0.
alter table exam_private.uploads drop constraint if exists uploads_question_check;
alter table exam_private.uploads add constraint uploads_question_check check (question >= 0);
-- Question pools: a course's questions for every semester it is taught, each assigned to a
-- module, which its exams draw from (see "Question pools" below). course: the course's sheet
-- name without the archive stamp (CE_121 for CE_121 and CE_121_Fall2526). draws: the
-- questions a student drew, kept with the attempt and then with the submission.
create table if not exists exam_private.pools (
  course text primary key,
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  updated_at timestamptz not null default now()
);
alter table exam_private.pools enable row level security;
alter table exam_private.attempts add column if not exists draws jsonb;
alter table exam_private.submissions add column if not exists draws jsonb;
-- paper: which paper the student is on, 0 for the first. A submission handed back as a new paper
-- (exam_return_new_paper) starts the next: new draws from the pool and a new order.
alter table exam_private.attempts add column if not exists paper integer not null default 0;
-- Groups (see "Groups" below): a student's group in the course offering ('' for none), an
-- exam's sittings, one a group, each at its own time (group_plan), and the sitting an exam ID
-- started in (grp).
alter table exam_private.students add column if not exists group_name text not null default '';
alter table exam_private.exams add column if not exists group_plan jsonb not null default '{}'::jsonb;
alter table exam_private.attempts add column if not exists grp text;
-- Grades by exam ID are gone: anyone who knew another student's exam ID could read that
-- student's grade and answers. Anonymous grades reach students through EIS, and their answers
-- through the lecturer.
drop function if exists public.exam_code_results(text, boolean, text);
drop function if exists public.exam_result_courses();
-- These now take the device: the old versions go, so the new ones replace them.
drop function if exists public.exam_student_sign_in(text, text);
drop function if exists public.exam_sign_out(text);
drop function if exists public.exam_start(uuid, text, text);
drop function if exists public.exam_anonymous_start(text, text);
drop function if exists public.exam_upload_start(uuid, text, integer, text, bigint);

-- Private: lecturers download through the policies at the end of this file. 50 MB is the
-- free plan's largest file.
insert into storage.buckets (id, name, public, file_size_limit)
  values ('exam-uploads', 'exam-uploads', false, 52428800)
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- The class-list row taking or submitting a named exam, signed in the way the exam asks for.
-- A Student ID sign-in opens only the exam whose password it was made with: another exam of the
-- course (at the same time, say) needs its own password, so a sign-in again.
create or replace function exam_private.exam_student(e exam_private.exams, p_token text) returns exam_private.students
language plpgsql stable security definer set search_path = '' as $$
declare s exam_private.students;
begin
  select m.* into s from exam_private.my_students(p_token) m
    where m.sheet_name = e.sheet_name and m.is_archive = e.is_archive
      and case e.sign_in
        when 'google' then teaching_private.email() is not null and m.email = teaching_private.email()
        when 'student_id' then m.id = (select x.student_id from exam_private.sessions x
          where x.token_hash = exam_private.token_hash(p_token) and x.kind = 'student' and x.expires_at > now()
            and x.exam_id = e.id)
        else false end
    limit 1;
  if found then return s; end if;
  if exists (select 1 from exam_private.my_students(p_token) m where m.sheet_name = e.sheet_name and m.is_archive = e.is_archive) then
    if e.sign_in = 'google' then
      raise exception 'This exam needs your Google account: sign out, then sign in with Google' using errcode = '42501';
    end if;
    if exists (select 1 from exam_private.sessions x where x.token_hash = exam_private.token_hash(p_token)
        and x.kind = 'student' and x.expires_at > now()) then
      raise exception 'You signed in with another exam''s password. To take this exam, sign out, then sign in with your student ID and this exam''s password'
        using errcode = '42501', hint = 'other_exam';
    end if;
    raise exception 'This exam needs your student ID: sign out, then sign in with your student ID and the exam password' using errcode = '42501';
  end if;
  raise exception 'You are not on this course''s class list' using errcode = '42501';
end $$;
revoke all on function exam_private.exam_student(exam_private.exams, text) from public, anon, authenticated;

-- Questions as students receive them while taking an exam: without anything that gives the
-- answer away (correct options, accepted answers, numeric answers, explanations), nor where
-- a question drawn from the course's pool came from.
create or replace function exam_private.student_questions(p_questions jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(q - array['correct_answers', 'accepted_answers', 'answer', 'tolerance', 'explanation', 'pool', 'module', 'apart'] order by ord), '[]'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as t(q, ord)
$$;
revoke all on function exam_private.student_questions(jsonb) from public, anon, authenticated;

-- ── Question ids ──
-- Every question keeps a short id. Answers, grades and files are stored by position (ans-1,
-- q-1, question 1); when questions are added, removed or moved, also while an exam runs, they
-- follow their question by its id. A repeated id (a copied question) gets a new one.
create or replace function exam_private.with_question_ids(p_questions jsonb) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare q jsonb; seen text[] := '{}'; result jsonb := '[]'::jsonb; v_id text;
begin
  for q in select t.q from jsonb_array_elements(case jsonb_typeof(p_questions) when 'array' then p_questions else '[]'::jsonb end)
      with ordinality t(q, ord) order by t.ord loop
    if jsonb_typeof(q) = 'object' then
      v_id := q->>'id';
      if v_id is null or v_id !~ '^[A-Za-z0-9_-]{4,40}$' or v_id = any(seen) then
        v_id := left(replace(gen_random_uuid()::text, '-', ''), 12);
        q := q || jsonb_build_object('id', v_id);
      end if;
      seen := seen || v_id;
    end if;
    result := result || jsonb_build_array(q);
  end loop;
  return result;
end $$;
revoke all on function exam_private.with_question_ids(jsonb) from public, anon, authenticated;

-- The questions' ids in order ('' for one without).
create or replace function exam_private.question_ids(p_questions jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(coalesce(t.q->>'id', '') order by t.ord), '{}'::text[])
  from jsonb_array_elements(case jsonb_typeof(p_questions) when 'array' then p_questions else '[]'::jsonb end) with ordinality t(q, ord)
$$;
revoke all on function exam_private.question_ids(jsonb) from public, anon, authenticated;

-- Which version of the questions students have: it changes whenever what they see changes.
create or replace function exam_private.questions_version(p_questions jsonb) returns text
language sql immutable set search_path = '' as $$ select md5(exam_private.student_questions(p_questions)::text) $$;
revoke all on function exam_private.questions_version(jsonb) from public, anon, authenticated;

-- Answers given to one version of the questions (p_from: its ids, in order), moved to the
-- positions of another (p_to: the questions). Answers to questions no longer there are kept
-- under "_removed", by id. Without ids, an answer stays where it was.
create or replace function exam_private.remap_answers(p_answers jsonb, p_from jsonb, p_to jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; m text[]; v_id text; j integer; result jsonb := '{}'::jsonb; removed jsonb; v_to text[];
begin
  if jsonb_typeof(p_answers) is distinct from 'object' or jsonb_typeof(p_from) is distinct from 'array' then return p_answers; end if;
  v_to := exam_private.question_ids(p_to);
  removed := case when jsonb_typeof(p_answers->'_removed') = 'object' then p_answers->'_removed' else '{}'::jsonb end;
  for k, v in select * from jsonb_each(p_answers) loop
    m := regexp_match(k, '^ans-(\d+)(_metadata)?$');
    if m is null then
      if k <> '_removed' then result := result || jsonb_build_object(k, v); end if;
      continue;
    end if;
    v_id := nullif(p_from ->> (m[1]::integer - 1), '');
    if v_id is null then result := result || jsonb_build_object(k, v); continue; end if;
    j := array_position(v_to, v_id);
    if j is not null then
      result := result || jsonb_build_object('ans-' || j || coalesce(m[2], ''), v);
    elsif m[2] is null then
      removed := removed || jsonb_build_object(v_id, v);
    end if;
  end loop;
  if removed <> '{}'::jsonb then result := result || jsonb_build_object('_removed', removed); end if;
  return result;
end $$;
revoke all on function exam_private.remap_answers(jsonb, jsonb, jsonb) from public, anon, authenticated;

-- Grades follow their questions the same way; those of removed questions go.
create or replace function exam_private.remap_grades(p_grades jsonb, p_from jsonb, p_to jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; m text[]; v_id text; j integer; result jsonb := '{}'::jsonb; v_to text[];
begin
  if jsonb_typeof(p_grades->'questionGrades') is distinct from 'object' or jsonb_typeof(p_from) is distinct from 'array' then return p_grades; end if;
  v_to := exam_private.question_ids(p_to);
  for k, v in select * from jsonb_each(p_grades->'questionGrades') loop
    m := regexp_match(k, '^q-(\d+)$');
    v_id := case when m is not null then nullif(p_from ->> (m[1]::integer - 1), '') end;
    if v_id is null then result := result || jsonb_build_object(k, v); continue; end if;
    j := array_position(v_to, v_id);
    if j is not null then result := result || jsonb_build_object('q-' || j, v); end if;
  end loop;
  return p_grades || jsonb_build_object('questionGrades', result);
end $$;
revoke all on function exam_private.remap_grades(jsonb, jsonb, jsonb) from public, anon, authenticated;

-- A question's points: information is worth nothing, a question without points 1 (as the
-- course editor counts them).
create or replace function exam_private.question_max(q jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case when q->>'type' = 'text_only' then 0
    when jsonb_typeof(q->'points') = 'number' and (q->>'points')::numeric >= 0 then (q->>'points')::numeric
    when q->>'points' ~ '^\s*\d+(\.\d+)?\s*$' then (q->>'points')::numeric
    else 1 end
$$;
revoke all on function exam_private.question_max(jsonb) from public, anon, authenticated;

-- The total and the points available, worked out again from the questions (after they changed).
create or replace function exam_private.retotal(p_grades jsonb, p_questions jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_grades->'questionGrades') = 'object' and jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) > 0 then
      p_grades || jsonb_build_object('totalScore', round(t.total, 1)::text, 'maxScore', t.available,
        'percentage', round(case when t.available > 0 then t.total / t.available * 100 else 0 end, 1)::text || '%')
    else p_grades end
  from (select coalesce(sum(case when q.q->>'type' <> 'text_only' and jsonb_typeof(p_grades->'questionGrades'->('q-' || q.ord)->'points') = 'number'
        then (p_grades->'questionGrades'->('q-' || q.ord)->>'points')::numeric end), 0) total,
      coalesce(sum(exam_private.question_max(q.q)), 0) available
    from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) with ordinality q(q, ord)) t
$$;
revoke all on function exam_private.retotal(jsonb, jsonb) from public, anon, authenticated;

-- Every question has points: the submission is graded.
create or replace function exam_private.grades_complete(p_grades jsonb, p_questions jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(q.q->>'type' = 'text_only' or coalesce(jsonb_typeof(p_grades->'questionGrades'->('q-' || q.ord)->'points') = 'number', false)), true)
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) with ordinality q(q, ord)
$$;
revoke all on function exam_private.grades_complete(jsonb, jsonb) from public, anon, authenticated;

-- Answers by question id ("#3" for a position without one), to compare two versions.
create or replace function exam_private.answers_by_id(p_answers jsonb, p_ids jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(coalesce(nullif(case when jsonb_typeof(p_ids) = 'array' then p_ids ->> (t.n - 1) end, ''), '#' || t.n), t.v), '{}'::jsonb)
  from (select substring(e.k from '^ans-(\d+)$')::integer n, e.v
    from jsonb_each(case when jsonb_typeof(p_answers) = 'object' then p_answers else '{}'::jsonb end) e(k, v)
    where e.k ~ '^ans-\d+$') t
$$;
revoke all on function exam_private.answers_by_id(jsonb, jsonb) from public, anon, authenticated;

-- How a submission sent after the end arrived: when the device was last online, when it last
-- saved its answers here, when they were collected on the device (it says so itself), and
-- which questions (their positions now) were answered differently from that last save.
create or replace function exam_private.late_delivery(p_prev exam_private.attempts, p_submission jsonb, p_questions jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('last_online', p_prev.last_seen, 'draft_at', p_prev.draft_at,
    'collected_at', p_submission->>'collected_at',
    'changed', (select jsonb_agg(c.pos order by c.pos) from (
        select distinct case when s.k like '#%' then substr(s.k, 2)::integer else array_position(exam_private.question_ids(p_questions), s.k) end pos
        from jsonb_each(exam_private.answers_by_id(p_submission->'answers', p_submission->'question_ids')) s(k, v)
        where s.v not in ('"[NOT CONFIRMED]"'::jsonb, '"[TEXT_ONLY_NO_ANSWER_REQUIRED]"'::jsonb)
          and s.v is distinct from exam_private.answers_by_id(p_prev.draft->'answers', p_prev.draft->'question_ids') -> s.k) c
      where c.pos is not null)))
$$;
revoke all on function exam_private.late_delivery(exam_private.attempts, jsonb, jsonb) from public, anon, authenticated;

-- ── Groups: one exam, a sitting for each group ──
-- The Students tab splits a course offering's students into groups (students.group_name: A, B…,
-- '' for none), for a class that takes its exams in turns (a lab with fewer computers than
-- students). An exam can then be taken by each group at its own time and hall, for the exam's
-- duration: exams.group_plan = {sittings: [{group, starts_at, hall}], others, moves}. Every
-- student takes it in one sitting: their group's, or, moved for this exam only (moves, by
-- class-list id), another group's. A student without a group, or of a group with no sitting,
-- takes it with "others" (else the first sitting). They can start, carry on and submit only in
-- their own sitting (with its usual 10 minutes, and a day for answers kept offline), so nobody
-- takes it with another group. An exam ID is never linked to a student: it takes the sitting
-- open when it first starts. The exam's starts_at is its first sitting's, and ends_at the last
-- one's end. Pool items draw for each group from its own share of the pool first (draw_pool),
-- so groups get different questions wherever the pool has enough.
create or replace function exam_private.sittings(e exam_private.exams) returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(e.group_plan->'sittings') = 'array' then e.group_plan->'sittings' else '[]'::jsonb end
$$;

create or replace function exam_private.has_sittings(e exam_private.exams) returns boolean
language sql immutable set search_path = '' as $$ select jsonb_array_length(exam_private.sittings(e)) > 0 $$;

-- The sitting a group takes the exam in: its own, else the one for everyone else, else the
-- first; '' without sittings.
create or replace function exam_private.sitting_group(e exam_private.exams, p_group text) returns text
language sql immutable set search_path = '' as $$
  select case when not exam_private.has_sittings(e) then ''
    else coalesce((select x->>'group' from jsonb_array_elements(exam_private.sittings(e)) x where x->>'group' = p_group limit 1),
      (select x->>'group' from jsonb_array_elements(exam_private.sittings(e)) x where x->>'group' = e.group_plan->>'others' limit 1),
      exam_private.sittings(e)->0->>'group') end
$$;

-- When a sitting starts and ends (the exam's own time without sittings).
create or replace function exam_private.sitting_start(e exam_private.exams, p_sitting text) returns timestamptz
language sql stable set search_path = '' as $$
  select coalesce((select (x->>'starts_at')::timestamptz from jsonb_array_elements(exam_private.sittings(e)) x
    where x->>'group' = p_sitting limit 1), e.starts_at)
$$;
create or replace function exam_private.sitting_end(e exam_private.exams, p_sitting text) returns timestamptz
language sql stable set search_path = '' as $$
  select exam_private.sitting_start(e, p_sitting) + make_interval(mins => e.duration_minutes)
$$;

-- A sitting's place (0 for the first), for each group's share of the pool.
create or replace function exam_private.sitting_index(e exam_private.exams, p_sitting text) returns integer
language sql immutable set search_path = '' as $$
  select coalesce((select (t.ord - 1)::integer from jsonb_array_elements(exam_private.sittings(e)) with ordinality t(x, ord)
    where t.x->>'group' = p_sitting limit 1), 0)
$$;

-- The sitting a class-list row takes this exam in.
create or replace function exam_private.student_sitting(e exam_private.exams, s exam_private.students) returns text
language sql immutable set search_path = '' as $$
  select exam_private.sitting_group(e, coalesce(nullif(e.group_plan->'moves'->>(s.id::text), ''), s.group_name))
$$;

-- The same for whoever takes it: a student's key, or 'code:' and the exam ID (the sitting its
-- attempt started in).
create or replace function exam_private.who_sitting(e exam_private.exams, p_who text) returns text
language sql stable security definer set search_path = '' as $$
  select case when not exam_private.has_sittings(e) then ''
    when p_who like 'code:%' then exam_private.sitting_group(e, (select a.grp from exam_private.attempts a where a.exam_id = e.id and a.who = p_who))
    else exam_private.sitting_group(e, (select coalesce(nullif(e.group_plan->'moves'->>(s.id::text), ''), s.group_name)
      from exam_private.students s where s.sheet_name = e.sheet_name and s.is_archive = e.is_archive and exam_private.student_key(s) = p_who limit 1)) end
$$;
create or replace function exam_private.who_start(e exam_private.exams, p_who text) returns timestamptz
language sql stable security definer set search_path = '' as $$ select exam_private.sitting_start(e, exam_private.who_sitting(e, p_who)) $$;
create or replace function exam_private.who_end(e exam_private.exams, p_who text) returns timestamptz
language sql stable security definer set search_path = '' as $$ select exam_private.sitting_end(e, exam_private.who_sitting(e, p_who)) $$;

-- The exam's end: its last sitting's (1-schema.sql's, with sittings).
create or replace function exam_private.ends_at(e exam_private.exams) returns timestamptz
language sql stable set search_path = '' as $$
  select case when e.starts_at is not null and e.duration_minutes is not null
    then greatest(e.starts_at, (select max((x->>'starts_at')::timestamptz) from jsonb_array_elements(exam_private.sittings(e)) x))
      + make_interval(mins => e.duration_minutes) end
$$;

-- When the first sitting ends: from then on, what its students started and left is submitted.
create or replace function exam_private.first_end(e exam_private.exams) returns timestamptz
language sql stable set search_path = '' as $$
  select least(e.starts_at, (select min((x->>'starts_at')::timestamptz) from jsonb_array_elements(exam_private.sittings(e)) x))
    + make_interval(mins => e.duration_minutes)
$$;

-- The sitting open now ('' for an exam without sittings), or null.
create or replace function exam_private.open_sitting(e exam_private.exams) returns text
language sql stable set search_path = '' as $$
  select case when e.starts_at is null or e.duration_minutes is null then null
    when not exam_private.has_sittings(e) then case when now() >= e.starts_at and now() < exam_private.ends_at(e) then '' end
    else (select t.x->>'group' from jsonb_array_elements(exam_private.sittings(e)) with ordinality t(x, ord)
      where now() >= (t.x->>'starts_at')::timestamptz and now() < (t.x->>'starts_at')::timestamptz + make_interval(mins => e.duration_minutes)
      order by t.ord limit 1) end
$$;

-- Online now: listed, has questions, and a sitting (or its one time) is on.
create or replace function exam_private.is_open(e exam_private.exams) returns boolean
language sql stable set search_path = '' as $$
  select e.visible and jsonb_array_length(e.questions) > 0 and exam_private.open_sitting(e) is not null
$$;

-- Whether a class-list row takes this exam: everyone, unless it is one group's only.
create or replace function exam_private.takes_exam(e exam_private.exams, s exam_private.students) returns boolean
language sql immutable set search_path = '' as $$
  select nullif(e.group_plan->>'only', '') is null or s.group_name = e.group_plan->>'only'
$$;

-- A group as students read it: a letter or number alone as "Group A"; a name as it is ("Lab 1").
create or replace function exam_private.group_label(p_group text) returns text
language sql immutable set search_path = '' as $$
  select case when btrim(coalesce(p_group, '')) ~ '^[[:alnum:]]{1,3}$' then 'Group ' || btrim(p_group) else btrim(coalesce(p_group, '')) end
$$;

-- Open now for one sitting.
create or replace function exam_private.is_open_for(e exam_private.exams, p_sitting text) returns boolean
language sql stable set search_path = '' as $$
  select e.visible and jsonb_array_length(e.questions) > 0 and coalesce(now() >= exam_private.sitting_start(e, p_sitting)
    and now() < exam_private.sitting_end(e, p_sitting), false)
$$;

-- A group plan as saved: each sitting with a group (40 characters at most, each once) and a
-- valid start, in the order given, and its hall; others; moves by class-list id. Or "only": the
-- exam is one group's alone (its own paper, say), at the exam's own time: then no sittings.
create or replace function exam_private.clean_group_plan(p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare x jsonb; v_group text; v_at timestamptz; v_sittings jsonb := '[]'::jsonb; v_seen text[] := '{}'; v_moves jsonb := '{}'::jsonb;
  k text; v text; v_only text;
begin
  if jsonb_typeof(p) is distinct from 'object' then return '{}'::jsonb; end if;
  v_only := nullif(left(btrim(coalesce(p->>'only', '')), 40), '');
  if v_only is not null then return jsonb_build_object('sittings', '[]'::jsonb, 'moves', '{}'::jsonb, 'only', v_only); end if;
  if jsonb_typeof(p->'sittings') = 'array' then
    for x in select t.x from jsonb_array_elements(p->'sittings') with ordinality t(x, ord) order by t.ord loop
      continue when jsonb_typeof(x) is distinct from 'object';
      v_group := left(btrim(coalesce(x->>'group', '')), 40);
      continue when v_group = '' or v_group = any(v_seen);
      begin v_at := (x->>'starts_at')::timestamptz; exception when others then v_at := null; end;
      continue when v_at is null;
      v_seen := v_seen || v_group;
      v_sittings := v_sittings || jsonb_build_array(jsonb_build_object('group', v_group, 'starts_at', v_at, 'hall', left(btrim(coalesce(x->>'hall', '')), 80)));
    end loop;
  end if;
  if jsonb_typeof(p->'moves') = 'object' then
    for k, v in select * from jsonb_each_text(p->'moves') loop
      if k ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and btrim(coalesce(v, '')) <> '' then
        v_moves := v_moves || jsonb_build_object(lower(k), left(btrim(v), 40));
      end if;
    end loop;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('sittings', v_sittings, 'others', nullif(left(btrim(coalesce(p->>'others', '')), 40), ''), 'moves', v_moves));
end $$;

do $$
declare f text;
begin
  foreach f in array array['sittings(exam_private.exams)', 'has_sittings(exam_private.exams)', 'sitting_group(exam_private.exams, text)',
    'sitting_start(exam_private.exams, text)', 'sitting_end(exam_private.exams, text)', 'sitting_index(exam_private.exams, text)',
    'student_sitting(exam_private.exams, exam_private.students)', 'who_sitting(exam_private.exams, text)', 'who_start(exam_private.exams, text)',
    'who_end(exam_private.exams, text)', 'ends_at(exam_private.exams)', 'first_end(exam_private.exams)', 'open_sitting(exam_private.exams)',
    'is_open(exam_private.exams)', 'is_open_for(exam_private.exams, text)', 'clean_group_plan(jsonb)',
    'takes_exam(exam_private.exams, exam_private.students)', 'group_label(text)'] loop
    execute format('revoke all on function exam_private.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ── Question pools ──
-- A course keeps one pool of questions for every semester, each assigned to a module (by its
-- title, in "module"). An exam draws from it with a pool item among its questions:
-- {type: 'pool', id, count, points, modules, kinds, exclude}: count questions of these modules
-- and types (all when none are chosen), leaving out those in exclude, worth points each. Every
-- student draws their own when they start: in a pool item's place they get the questions it
-- drew (ids "<item id>-<pool question id>"). Questions that share an "apart" (linked: alike,
-- or giving each other away) never come together for one student. The draws keep copies of
-- the questions: a submission keeps the questions as the student had them, whatever later
-- happens to the pool. While the exam is taken, changes to the pool reach the student.

-- The course a sheet name belongs to: without the archive stamp (CE_121_Fall2526 is CE_121).
create or replace function exam_private.course_base(p_sheet text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(coalesce(p_sheet, ''), '_(Fall|Spring|Summer)(\d{4})?$', '')
$$;
revoke all on function exam_private.course_base(text) from public, anon, authenticated;

create or replace function exam_private.has_pool(p_questions jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from jsonb_array_elements(case jsonb_typeof(p_questions) when 'array' then p_questions else '[]'::jsonb end) q
    where q->>'type' = 'pool')
$$;
revoke all on function exam_private.has_pool(jsonb) from public, anon, authenticated;

create or replace function exam_private.pool_questions(p_sheet text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.questions from exam_private.pools p where p.course = exam_private.course_base(p_sheet)), '[]'::jsonb)
$$;
revoke all on function exam_private.pool_questions(text) from public, anon, authenticated;

-- How many questions a pool item draws (at most 100).
create or replace function exam_private.pool_count(p_item jsonb) returns integer
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_item->'count') = 'number' then least(100, greatest(0, floor((p_item->>'count')::numeric)))::integer
    when p_item->>'count' ~ '^\s*\d+\s*$' then least(100, (p_item->>'count')::integer) else 1 end
$$;
revoke all on function exam_private.pool_count(jsonb) from public, anon, authenticated;

-- The pool's questions a pool item can draw.
create or replace function exam_private.pool_candidates(p_item jsonb, p_pool jsonb) returns setof jsonb
language sql immutable set search_path = '' as $$
  select q from jsonb_array_elements(case jsonb_typeof(p_pool) when 'array' then p_pool else '[]'::jsonb end) q
  where jsonb_typeof(q) = 'object' and coalesce(q->>'id', '') <> '' and coalesce(q->>'type', '') not in ('', 'pool', 'text_only')
    and (jsonb_typeof(p_item->'modules') is distinct from 'array' or jsonb_array_length(p_item->'modules') = 0
      or p_item->'modules' ? coalesce(q->>'module', ''))
    and (jsonb_typeof(p_item->'kinds') is distinct from 'array' or jsonb_array_length(p_item->'kinds') = 0
      or p_item->'kinds' ? (q->>'type'))
    and not coalesce(jsonb_typeof(p_item->'exclude') = 'array' and p_item->'exclude' ? (q->>'id'), false)
$$;
revoke all on function exam_private.pool_candidates(jsonb, jsonb) from public, anon, authenticated;

-- How many more questions a pool item could draw than it asks for: its candidates, one of each
-- linked set, less its count.
create or replace function exam_private.pool_room(p_item jsonb, p_pool jsonb) returns integer
language sql immutable set search_path = '' as $$
  select (select count(distinct coalesce(nullif(c.q->>'apart', ''), 'id:' || (c.q->>'id')))::integer
    from exam_private.pool_candidates(p_item, p_pool) c(q)) - exam_private.pool_count(p_item)
$$;
revoke all on function exam_private.pool_room(jsonb, jsonb) from public, anon, authenticated;

-- One student's draws for an exam's pool items, by item id. Every student gets exactly the
-- count each item asks for, whenever the pool can give that many (the editor refuses to save an
-- exam whose items ask for more than the pool can give). A question comes once in an exam, and
-- one of a linked set ("apart") at most: each unlinked question, and each linked set, is one
-- "unit" that goes to one item. First what the student drew before (p_old) and can still have,
-- in its order, so a student keeps their questions when the exam or the pool changes; then new
-- questions in an order of their own (p_seed), the items with the least room to spare first.
-- When an item is still short (another item, or a linked set, took what it needed), units move
-- between items along an augmenting path until it has its count: drawing item by item alone left
-- some students with 28 or 29 questions of 30.
-- With groups (p_homes sittings, the student's p_home of them): each item's units are dealt out
-- between the groups in turn, in an order of the exam's own (p_salt), and a student takes their
-- group's units before any other, so groups get different questions as far as the pool allows.
drop function if exists exam_private.draw_pool(jsonb, jsonb, text, jsonb);
create or replace function exam_private.draw_pool(p_questions jsonb, p_pool jsonb, p_seed text, p_old jsonb,
  p_salt text, p_home integer, p_homes integer) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  item jsonb; e jsonb; v_item text; v_items text[] := '{}'; v_rooms jsonb := '{}'::jsonb;
  v_want jsonb := '{}'::jsonb; v_have jsonb := '{}'::jsonb; v_elig jsonb := '{}'::jsonb;
  v_owner jsonb := '{}'::jsonb; v_draws jsonb := '{}'::jsonb;
  v_queue text[]; v_seen text[]; v_parent jsonb; v_found jsonb; v_cur text; v_next text; v_u text; v_step jsonb;
begin
  -- Each item's candidates as units, in the order it takes them: its earlier draws, then its own.
  for item in select t.q from jsonb_array_elements(case jsonb_typeof(p_questions) when 'array' then p_questions else '[]'::jsonb end)
      with ordinality t(q, ord) where t.q->>'type' = 'pool' and coalesce(t.q->>'id', '') <> '' order by t.ord loop
    v_item := item->>'id';
    continue when v_item = any(v_items);
    v_items := v_items || v_item;
    v_want := v_want || jsonb_build_object(v_item, exam_private.pool_count(item));
    v_have := v_have || jsonb_build_object(v_item, 0);
    v_rooms := v_rooms || jsonb_build_object(v_item, exam_private.pool_room(item, p_pool));
    v_elig := v_elig || jsonb_build_object(v_item, coalesce((
      select jsonb_agg(jsonb_build_object('u', c.u, 'q', c.q, 'old', old.n is not null)
        order by old.n nulls last, (coalesce(p_homes, 1) > 1 and c.home <> coalesce(p_home, 0)), md5(p_seed || ':' || v_item || ':' || (c.q->>'id')))
      from (select x.q, x.u, (dense_rank() over (order by md5(coalesce(p_salt, '') || ':' || v_item || ':' || x.u)) - 1) % greatest(coalesce(p_homes, 1), 1) home
        from (select c0.q, coalesce(nullif(c0.q->>'apart', ''), 'id:' || (c0.q->>'id')) u
          from exam_private.pool_candidates(item, p_pool) c0(q)) x) c
      left join lateral (select o.n from jsonb_array_elements(case when jsonb_typeof(p_old->v_item) = 'array' then p_old->v_item else '[]'::jsonb end)
        with ordinality o(v, n) where o.v->>'id' = c.q->>'id' limit 1) old on true), '[]'::jsonb));
  end loop;

  -- 1. What each item drew before, in the exam's order.
  foreach v_item in array v_items loop
    for e in select x from jsonb_array_elements(v_elig->v_item) x loop
      exit when (v_have->>v_item)::integer >= (v_want->>v_item)::integer;
      continue when not (e->>'old')::boolean or v_owner ? (e->>'u');
      v_owner := v_owner || jsonb_build_object(e->>'u', jsonb_build_object('i', v_item, 'q', e->'q'));
      v_have := v_have || jsonb_build_object(v_item, (v_have->>v_item)::integer + 1);
    end loop;
  end loop;

  -- 2. New questions, the items with the least room first.
  for v_item in select i from unnest(v_items) with ordinality u(i, ord) order by (v_rooms->>i)::integer, ord loop
    for e in select x from jsonb_array_elements(v_elig->v_item) x loop
      exit when (v_have->>v_item)::integer >= (v_want->>v_item)::integer;
      continue when v_owner ? (e->>'u');
      v_owner := v_owner || jsonb_build_object(e->>'u', jsonb_build_object('i', v_item, 'q', e->'q'));
      v_have := v_have || jsonb_build_object(v_item, (v_have->>v_item)::integer + 1);
    end loop;
  end loop;

  -- 3. Items still short: a free unit reached through items that can each give one up for
  -- another they can also take.
  foreach v_item in array v_items loop
    while (v_have->>v_item)::integer < (v_want->>v_item)::integer loop
      v_queue := array[v_item]; v_seen := array[v_item]; v_parent := '{}'::jsonb; v_found := null;
      while coalesce(array_length(v_queue, 1), 0) > 0 and v_found is null loop
        v_cur := v_queue[1];
        v_queue := v_queue[2:];
        for e in select x from jsonb_array_elements(v_elig->v_cur) x loop
          v_u := e->>'u';
          if not (v_owner ? v_u) then
            v_found := jsonb_build_object('i', v_cur, 'u', v_u, 'q', e->'q');
            exit;
          end if;
          v_next := v_owner->v_u->>'i';
          continue when v_next = any(v_seen);
          v_seen := v_seen || v_next;
          v_parent := v_parent || jsonb_build_object(v_next, jsonb_build_object('i', v_cur, 'u', v_u, 'q', e->'q'));
          v_queue := v_queue || v_next;
        end loop;
      end loop;
      exit when v_found is null; -- the pool has no more to give
      v_cur := v_found->>'i';
      v_owner := v_owner || jsonb_build_object(v_found->>'u', jsonb_build_object('i', v_cur, 'q', v_found->'q'));
      while v_cur <> v_item loop
        v_step := v_parent->v_cur;
        v_owner := v_owner || jsonb_build_object(v_step->>'u', jsonb_build_object('i', v_step->>'i', 'q', v_step->'q'));
        v_cur := v_step->>'i';
      end loop;
      v_have := v_have || jsonb_build_object(v_item, (v_have->>v_item)::integer + 1);
    end loop;
  end loop;

  foreach v_item in array v_items loop
    v_draws := v_draws || jsonb_build_object(v_item, coalesce((select jsonb_agg(t.x->'q' order by t.n)
      from jsonb_array_elements(v_elig->v_item) with ordinality t(x, n)
      where v_owner->(t.x->>'u')->>'i' = v_item and v_owner->(t.x->>'u')->'q'->>'id' = t.x->'q'->>'id'), '[]'::jsonb));
  end loop;
  return v_draws;
end $$;
revoke all on function exam_private.draw_pool(jsonb, jsonb, text, jsonb, text, integer, integer) from public, anon, authenticated;

-- The questions with each pool item replaced by what it drew (p_draws), worth the item's points.
-- "pool" says where a drawn question came from (students don't get it).
create or replace function exam_private.drawn_questions(p_questions jsonb, p_draws jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case when not exam_private.has_pool(p_questions) then p_questions else (
    select coalesce(jsonb_agg(x.q order by x.ord, x.n), '[]'::jsonb) from (
      select t.ord, 0::bigint n, t.q from jsonb_array_elements(p_questions) with ordinality t(q, ord)
      where t.q->>'type' is distinct from 'pool'
      union all
      select t.ord, d.n, (d.c - 'module' - 'apart' - 'points') || jsonb_build_object('id', (t.q->>'id') || '-' || (d.c->>'id'),
          'points', exam_private.question_max(t.q),
          'pool', jsonb_build_object('item', t.q->>'id', 'id', d.c->>'id', 'module', coalesce(d.c->>'module', '')))
      from jsonb_array_elements(p_questions) with ordinality t(q, ord)
        cross join lateral jsonb_array_elements(case when jsonb_typeof(p_draws->(t.q->>'id')) = 'array' then p_draws->(t.q->>'id') else '[]'::jsonb end)
          with ordinality d(c, n)
      where t.q->>'type' = 'pool' and jsonb_typeof(d.c) = 'object') x) end
$$;
revoke all on function exam_private.drawn_questions(jsonb, jsonb) from public, anon, authenticated;

-- A student's draws for an exam (p_who: their key, or 'code:' and the exam ID), from what they
-- drew before; null for an exam without pool items. A new paper draws with another seed. With
-- sittings, from their group's share of the pool first.
create or replace function exam_private.draws_for(e exam_private.exams, p_who text, p_old jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when exam_private.has_pool(e.questions) then
    exam_private.draw_pool(e.questions, exam_private.pool_questions(e.sheet_name), md5(e.id::text || ':' || p_who
      || coalesce(':paper' || nullif((select a.paper from exam_private.attempts a where a.exam_id = e.id and a.who = p_who), 0)::text, '')), p_old,
      e.id::text, exam_private.sitting_index(e, exam_private.who_sitting(e, p_who)), greatest(1, jsonb_array_length(exam_private.sittings(e)))) end
$$;

-- The order a student's questions and options come in (the page shuffles with it): their own
-- key on the first paper, another on each new one. Null: the page uses the key it has.
create or replace function exam_private.paper_seed(p_exam uuid, p_who text) returns text
language sql stable security definer set search_path = '' as $$
  select case when a.paper > 0 then p_who || ':paper' || a.paper end
  from exam_private.attempts a where a.exam_id = p_exam and a.who = p_who
$$;
revoke all on function exam_private.paper_seed(uuid, text) from public, anon, authenticated;
revoke all on function exam_private.draws_for(exam_private.exams, text, jsonb) from public, anon, authenticated;

-- The questions a student taking the exam has now, as stored with their attempt.
create or replace function exam_private.taken_questions(e exam_private.exams, p_who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when exam_private.has_pool(e.questions) then exam_private.drawn_questions(e.questions,
      exam_private.draws_for(e, p_who, (select a.draws from exam_private.attempts a where a.exam_id = e.id and a.who = p_who)))
    else e.questions end
$$;
revoke all on function exam_private.taken_questions(exam_private.exams, text) from public, anon, authenticated;

-- The same, keeping the draws with the attempt (claimed first). When they changed (the pool or
-- the exam did), the student's files follow their questions.
create or replace function exam_private.take_questions(e exam_private.exams, p_who text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_old jsonb; v_draws jsonb; v_from text[]; v_to text[];
begin
  if not exam_private.has_pool(e.questions) then return e.questions; end if;
  select a.draws into v_old from exam_private.attempts a where a.exam_id = e.id and a.who = p_who;
  v_draws := exam_private.draws_for(e, p_who, v_old);
  if v_draws is distinct from v_old then
    update exam_private.attempts set draws = v_draws where exam_id = e.id and who = p_who;
    if v_old is not null then
      v_from := exam_private.question_ids(exam_private.drawn_questions(e.questions, v_old));
      v_to := exam_private.question_ids(exam_private.drawn_questions(e.questions, v_draws));
      if v_from is distinct from v_to then
        update exam_private.uploads u set question = coalesce(array_position(v_to, v_from[u.question]), 0)
          where u.exam_id = e.id and coalesce(u.student_key, 'code:' || u.exam_code) = p_who
            and u.question >= 1 and coalesce(v_from[u.question], '') <> '';
      end if;
    end if;
  end if;
  return exam_private.drawn_questions(e.questions, v_draws);
end $$;
revoke all on function exam_private.take_questions(exam_private.exams, text) from public, anon, authenticated;

-- Draws made up again from a backup file's question ids, for a student with no attempt.
create or replace function exam_private.draws_from_ids(p_questions jsonb, p_pool jsonb, p_ids jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(s.q->>'id', coalesce((select jsonb_agg(p.q order by i.n)
      from jsonb_array_elements_text(case jsonb_typeof(p_ids) when 'array' then p_ids else '[]'::jsonb end) with ordinality i(v, n)
      join jsonb_array_elements(case jsonb_typeof(p_pool) when 'array' then p_pool else '[]'::jsonb end) p(q)
        on jsonb_typeof(p.q) = 'object' and (s.q->>'id') || '-' || (p.q->>'id') = i.v), '[]'::jsonb)), '{}'::jsonb)
  from jsonb_array_elements(case jsonb_typeof(p_questions) when 'array' then p_questions else '[]'::jsonb end) s(q)
  where s.q->>'type' = 'pool' and coalesce(s.q->>'id', '') <> ''
$$;
revoke all on function exam_private.draws_from_ids(jsonb, jsonb, jsonb) from public, anon, authenticated;

-- Existing questions get their ids.
update exam_private.exams set questions = exam_private.with_question_ids(questions)
  where exists (select 1 from jsonb_array_elements(questions) q where jsonb_typeof(q) = 'object' and coalesce(q->>'id', '') = '');

-- ── An exam a student opened is theirs: submitted at the end, whatever happens ──
-- Starting an exam (the attempt) registers the student for it. When it is over and they have
-- not submitted (the page closed, the computer off, gone to another room), it is submitted
-- for them from the answers the server last had (the page sends them as the student answers,
-- and every 30 seconds), marked automatic and dated at the end. It runs when anyone next looks
-- (the lecturer's lists, the Grades page, a student's dashboard) and before an exam's time is
-- changed. The device can still send what it kept while offline, until a day after the end:
-- that takes its place unless it is graded. Not for an exam handed back after its end: that
-- waits for the new end. With sittings, each attempt at its own sitting's end.
create or replace function exam_private.finalize_attempts(e exam_private.exams, p_grace interval default interval '2 minutes') returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare a exam_private.attempts; st exam_private.students; v_end timestamptz;
  v_draws jsonb; v_questions jsonb; v_answers jsonb; v_live jsonb; v_activity jsonb; v_delivery jsonb; n integer := 0;
begin
  if exam_private.ends_at(e) is null or now() <= exam_private.first_end(e) + p_grace or jsonb_array_length(e.questions) = 0 then return 0; end if;
  for a in select * from exam_private.attempts x where x.exam_id = e.id
      and not exists (select 1 from exam_private.submissions u where u.exam_id = e.id
        and case when x.who like 'code:%' then u.exam_code = substr(x.who, 6) else u.exam_code is null and u.student_no = x.who end)
      for update skip locked
  loop
    v_end := exam_private.who_end(e, a.who);
    continue when v_end is null or now() <= v_end + p_grace or (a.returned_at is not null and a.returned_at > v_end);
    begin
      v_draws := case when exam_private.has_pool(e.questions) then coalesce(a.draws, exam_private.draws_for(e, a.who, null)) end;
      v_questions := exam_private.drawn_questions(e.questions, v_draws);
      v_answers := case when jsonb_typeof(a.draft->'answers') = 'object'
        then exam_private.remap_answers(a.draft->'answers', a.draft->'question_ids', v_questions) else '{}'::jsonb end;
      v_live := case when jsonb_typeof(a.draft->'integrity') = 'object' then a.draft->'integrity' else '{}'::jsonb end;
      v_activity := jsonb_build_object(
        'count', round(coalesce(case when jsonb_typeof(v_live->'count') = 'number' then (v_live->>'count')::numeric end, 0))::integer,
        'total_seconds', round(coalesce(case when jsonb_typeof(v_live->'total') = 'number' then (v_live->>'total')::numeric end, 0)),
        'leaves', case when jsonb_typeof(v_live->'leaves') = 'array' then v_live->'leaves' else '[]'::jsonb end,
        'cooldown', exam_private.clean_settings(e.settings)->>'leave' = 'cooldown',
        'cooldown_seconds_total', round(coalesce(case when jsonb_typeof(v_live->'cooldownTotal') = 'number' then (v_live->>'cooldownTotal')::numeric end, 0)));
      v_delivery := jsonb_strip_nulls(jsonb_build_object('by', 'server', 'draft_at', a.draft_at, 'last_online', a.last_seen));
      if a.who like 'code:%' then
        insert into exam_private.submissions (exam_id, exam_code, submitted_at, answers, activity, network, auto_submitted, delivery, draws)
          values (e.id, substr(a.who, 6), v_end, v_answers, v_activity, a.network, true, v_delivery, v_draws)
          on conflict do nothing;
      else
        select x.* into st from exam_private.students x
          where x.sheet_name = e.sheet_name and x.is_archive = e.is_archive and exam_private.student_key(x) = a.who limit 1;
        insert into exam_private.submissions (exam_id, student_id, student_no, student_name, student_email, submitted_at,
            answers, activity, network, auto_submitted, delivery, draws)
          values (e.id, st.id, a.who, coalesce(st.full_name, ''), coalesce(st.email, ''), v_end,
            v_answers, v_activity, a.network, true, v_delivery, v_draws)
          on conflict do nothing;
      end if;
      n := n + 1;
    exception when others then
      null; -- one unreadable draft does not stop the others
    end;
  end loop;
  return n;
end $$;
revoke all on function exam_private.finalize_attempts(exam_private.exams, interval) from public, anon, authenticated;

-- The same for every exam of a course that is over.
create or replace function exam_private.finalize_course(p_sheet text, p_archive boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  for e in select * from exam_private.exams x where x.sheet_name = p_sheet and x.is_archive = p_archive
      and exam_private.first_end(x) < now() - interval '2 minutes'
      and exists (select 1 from exam_private.attempts a where a.exam_id = x.id) loop
    perform exam_private.finalize_attempts(e);
  end loop;
end $$;
revoke all on function exam_private.finalize_course(text, boolean) from public, anon, authenticated;

-- A submission the server made from the last saved answers, not graded yet: what the device
-- kept while offline may take its place.
create or replace function exam_private.replaceable(s exam_private.submissions) returns boolean
language sql immutable set search_path = '' as $$
  select s.source = 'online' and s.delivery->>'by' = 'server' and s.status <> 'graded' and s.grades is null
$$;
revoke all on function exam_private.replaceable(exam_private.submissions) from public, anon, authenticated;

-- Late: arrived more than a minute after the end. The page submits by itself when time runs
-- out, and that submission reaches the server a moment after the end: it is not late.
create or replace function exam_private.arrives_late(e exam_private.exams) returns boolean
language sql stable set search_path = '' as $$
  select now() > exam_private.ends_at(e) + interval '1 minute'
$$;
revoke all on function exam_private.arrives_late(exam_private.exams) from public, anon, authenticated;

-- Submissions marked late before that minute was allowed, though they arrived within it.
update exam_private.submissions s set late = false, delivery = null
  from exam_private.exams e
  where e.id = s.exam_id and s.late and s.source = 'online'
    and s.submitted_at <= exam_private.ends_at(e) + interval '1 minute';

-- An exam's settings with their defaults: the name watermark (always on), what leaving the
-- page does, 'record' (only recorded) or 'cooldown' (also a red screen and a countdown of the
-- same length each time, 5 seconds to 5 minutes), and date_only: a date without a time (an exam
-- on paper whose time is not set; starts_at is then that day's midnight).
create or replace function exam_private.clean_settings(s jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'watermark', true,
    'date_only', coalesce(jsonb_typeof(s->'date_only') = 'boolean' and (s->>'date_only')::boolean, false),
    'leave', case when s->>'leave' in ('record', 'cooldown') then s->>'leave' else 'cooldown' end,
    'cooldown_seconds', case when jsonb_typeof(s->'cooldown_seconds') = 'number'
      then least(300, greatest(5, round((s->>'cooldown_seconds')::numeric)::integer)) else 15 end)
$$;
revoke all on function exam_private.clean_settings(jsonb) from public, anon, authenticated;

-- The images questions show: the ids in each question's "images" list and its options' "option_images".
create or replace function exam_private.image_ids(p_questions jsonb) returns uuid[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct t.id::uuid), '{}'::uuid[]) from (
    select i #>> '{}' id
    from jsonb_array_elements(case jsonb_typeof(p_questions) when 'array' then p_questions else '[]'::jsonb end) q,
      jsonb_array_elements(case jsonb_typeof(q->'images') when 'array' then q->'images' else '[]'::jsonb end
        || case jsonb_typeof(q->'option_images') when 'array' then q->'option_images' else '[]'::jsonb end) i
    where jsonb_typeof(i) = 'string') t
  where t.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
revoke all on function exam_private.image_ids(jsonb) from public, anon, authenticated;

-- The images the questions show, from their course offering or the course's pool (kept as
-- sheet name 'pool:<course>'), as data URLs by id.
create or replace function exam_private.images_for(p_sheet text, p_archive boolean, p_questions jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(i.id, 'data:' || i.mime || ';base64,' || translate(encode(i.data, 'base64'), E'\n', '')), '{}'::jsonb)
  from exam_private.images i
  where ((i.sheet_name = p_sheet and i.is_archive = p_archive) or (i.sheet_name = 'pool:' || exam_private.course_base(p_sheet) and not i.is_archive))
    and i.id = any(exam_private.image_ids(p_questions))
$$;
revoke all on function exam_private.images_for(text, boolean, jsonb) from public, anon, authenticated;

-- The questions every submission and attempt of an exam drew from the pool, as one list.
create or replace function exam_private.drawn_copies(p_exam uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c.q), '[]'::jsonb) from (
    select d.value draws from exam_private.submissions s, jsonb_each(case when jsonb_typeof(s.draws) = 'object' then s.draws else '{}'::jsonb end) d
      where s.exam_id = p_exam
    union all
    select d.value from exam_private.attempts a, jsonb_each(case when jsonb_typeof(a.draws) = 'object' then a.draws else '{}'::jsonb end) d
      where a.exam_id = p_exam) t,
    jsonb_array_elements(case when jsonb_typeof(t.draws) = 'array' then t.draws else '[]'::jsonb end) c(q)
$$;
revoke all on function exam_private.drawn_copies(uuid) from public, anon, authenticated;

-- Removes a course offering's images that no exam shows any more. A day's grace keeps the
-- ones just added to questions that are still being edited.
create or replace function exam_private.prune_images(p_sheet text, p_archive boolean) returns void
language sql volatile security definer set search_path = '' as $$
  delete from exam_private.images i
  where i.sheet_name = p_sheet and i.is_archive = p_archive and i.created_at < now() - interval '1 day'
    and not exists (select 1 from exam_private.exams e where e.sheet_name = p_sheet and e.is_archive = p_archive
      and i.id = any(exam_private.image_ids(e.questions)))
$$;
revoke all on function exam_private.prune_images(text, boolean) from public, anon, authenticated;

-- The same for a course's pool: its images that neither the pool, nor an exam of the course in
-- any semester, nor what students drew from it show any more.
create or replace function exam_private.prune_pool_images(p_course text) returns void
language sql volatile security definer set search_path = '' as $$
  delete from exam_private.images i
  where i.sheet_name = 'pool:' || p_course and not i.is_archive and i.created_at < now() - interval '1 day'
    and not (i.id = any(exam_private.image_ids(coalesce((select p.questions from exam_private.pools p where p.course = p_course), '[]'::jsonb))))
    and not exists (select 1 from exam_private.exams e where exam_private.course_base(e.sheet_name) = p_course
      and (i.id = any(exam_private.image_ids(e.questions)) or i.id = any(exam_private.image_ids(exam_private.drawn_copies(e.id)))))
$$;
revoke all on function exam_private.prune_pool_images(text) from public, anon, authenticated;

-- An exam as students see it: no password, no correct answers, no questions.
create or replace function exam_private.exam_summary(e exam_private.exams) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'label', e.label, 'type', e.type, 'starts_at', e.starts_at,
    'duration_minutes', e.duration_minutes, 'ends_at', exam_private.ends_at(e), 'hall', e.hall,
    'weight', e.weight, 'base', e.base, 'sign_in', e.sign_in, 'shuffle_questions', e.shuffle_questions,
    'settings', exam_private.clean_settings(e.settings),
    'has_password', e.password_hash is not null, 'question_count', jsonb_array_length(e.questions),
    'is_open', exam_private.is_open(e), 'results_published', e.results_published,
    'sheet_name', e.sheet_name,
    'course_code', exam_private.course_meta(e.sheet_name, e.is_archive, 'code'),
    'course_title', exam_private.course_meta(e.sheet_name, e.is_archive, 'title'),
    -- The course's theme colours ("#3949ab, #ffa726, …"): Syllatest takes the first for its buttons.
    'course_colours', exam_private.course_meta(e.sheet_name, e.is_archive, 'theme_colours'),
    -- One group's only (else null).
    'for_group', nullif(e.group_plan->>'only', ''))
$$;
revoke all on function exam_private.exam_summary(exam_private.exams) from public, anon, authenticated;

-- An exam as one student sees it: with sittings, their own sitting's time, hall and whether it
-- is open now, and which it is.
create or replace function exam_private.summary_for(e exam_private.exams, p_sitting text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select exam_private.exam_summary(e) || case when exam_private.has_sittings(e) then jsonb_build_object(
      'starts_at', exam_private.sitting_start(e, p_sitting), 'ends_at', exam_private.sitting_end(e, p_sitting),
      'hall', coalesce(nullif((select x->>'hall' from jsonb_array_elements(exam_private.sittings(e)) x where x->>'group' = p_sitting limit 1), ''), e.hall),
      'is_open', exam_private.is_open_for(e, p_sitting), 'group', p_sitting)
    else '{}'::jsonb end
$$;
revoke all on function exam_private.summary_for(exam_private.exams, text) from public, anon, authenticated;

-- The uploaded files of an exam that are in Storage (not deleted since).
create or replace function exam_private.stored_uploads(p_exam uuid) returns setof exam_private.uploads
language sql stable security definer set search_path = '' as $$
  select u.* from exam_private.uploads u
  where u.exam_id = p_exam and exists (select 1 from storage.objects o where o.bucket_id = 'exam-uploads' and o.name = u.path)
$$;
revoke all on function exam_private.stored_uploads(uuid) from public, anon, authenticated;

-- ── Lecturers, admins and TAs (course editor: Exams and Students tabs) ──

-- Everything the two tabs show for one course offering.
create or replace function public.exam_course(p_sheet text, p_archive boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a text := exam_private.require_access(p_sheet, p_archive, false);
begin
  perform exam_private.finalize_course(p_sheet, p_archive);
  return jsonb_build_object(
    'access', a,
    'students', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'student_no', s.student_no,
        'full_name', s.full_name, 'email', s.email, 'programme', s.programme, 'exam_code', s.exam_code, 'note', s.note,
        'group_name', s.group_name)
        order by s.list_order, s.full_name)
      from exam_private.students s where s.sheet_name = p_sheet and s.is_archive = p_archive), '[]'::jsonb),
    'codes', coalesce((select jsonb_agg(c.code order by c.list_order, c.code) from exam_private.exam_codes c
      where c.sheet_name = p_sheet and c.is_archive = p_archive), '[]'::jsonb),
    'exams', coalesce((select jsonb_agg((to_jsonb(e) - 'password_hash' - 'password_text' - 'sheet_name' - 'is_archive') || jsonb_build_object(
        'settings', exam_private.clean_settings(e.settings),
        'has_password', e.password_hash is not null,
        'password', case when a = 'manage' then e.password_text end, 'ends_at', exam_private.ends_at(e), 'is_open', exam_private.is_open(e),
        'open_sitting', exam_private.open_sitting(e),
        -- Submitted from the exam page (or a backup file), and how many of those are graded;
        -- grades entered without a submission are not counted.
        'submission_count', (select count(*) from exam_private.submissions s where s.exam_id = e.id and s.source <> 'manual'),
        'graded_count', (select count(*) from exam_private.submissions s where s.exam_id = e.id and s.status = 'graded' and s.source <> 'manual'),
        'file_count', (select count(*) from exam_private.stored_uploads(e.id)),
        'file_bytes', (select coalesce(sum(u.size_bytes), 0) from exam_private.stored_uploads(e.id) u))
        order by e.starts_at nulls last, e.created_at)
      from exam_private.exams e where e.sheet_name = p_sheet and e.is_archive = p_archive), '[]'::jsonb));
end $$;

-- A person keeps one student ID and one email in every course. Against the other courses:
-- 'student_id' when this student ID has another email there, 'email' when this email has
-- another student ID there; null when consistent.
create or replace function exam_private.identity_conflict(p_sheet text, p_archive boolean, p_no text, p_email text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_no <> '' and exists (select 1 from exam_private.students o where o.student_no = p_no and o.email <> p_email
      and not (o.sheet_name = p_sheet and o.is_archive = p_archive)) then 'student_id'
    when p_no <> '' and exists (select 1 from exam_private.students o where o.email = p_email and o.student_no <> '' and o.student_no <> p_no
      and not (o.sheet_name = p_sheet and o.is_archive = p_archive)) then 'email' end
$$;
revoke all on function exam_private.identity_conflict(text, boolean, text, text) from public, anon, authenticated;

-- The student ID another course has for this email, to fill in a paste that has none.
create or replace function exam_private.student_no_elsewhere(p_sheet text, p_archive boolean, p_email text) returns text
language sql stable security definer set search_path = '' as $$
  select o.student_no from exam_private.students o
  where o.email = p_email and o.student_no <> '' and not (o.sheet_name = p_sheet and o.is_archive = p_archive)
  order by o.updated_at desc limit 1
$$;
revoke all on function exam_private.student_no_elsewhere(text, boolean, text) from public, anon, authenticated;

-- What a paste would change, for the Students tab's preview: per row, an identity conflict
-- with another course, the student ID filled in from another course, or the name used there
-- (same student ID and email, so the same person).
create or replace function public.exam_check_students(p_sheet text, p_archive boolean, p_students jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  return coalesce((select jsonb_agg(r) from (
    select jsonb_strip_nulls(jsonb_build_object('student_no', t.no, 'email', t.email,
        'conflict', exam_private.identity_conflict(p_sheet, p_archive, t.no, t.email),
        'student_no_elsewhere', case when t.no = '' then exam_private.student_no_elsewhere(p_sheet, p_archive, t.email) end,
        'name_elsewhere', (select o.full_name from exam_private.students o
          where o.email = t.email and (t.no = '' or o.student_no = t.no) and lower(o.full_name) <> lower(t.name)
            and not (o.sheet_name = p_sheet and o.is_archive = p_archive) order by o.updated_at desc limit 1))) r
    from (select btrim(coalesce(x->>'student_no', '')) no, lower(btrim(coalesce(x->>'email', ''))) email, btrim(coalesce(x->>'full_name', '')) name
      from jsonb_array_elements(coalesce(p_students, '[]'::jsonb)) x) t) q
  where q.r ?| array['conflict', 'student_no_elsewhere', 'name_elsewhere']), '[]'::jsonb);
end $$;

-- Saves students in the given order and removes p_remove. A row with an id is an edit and
-- sets every field as given. A pasted row (no id) is matched by email (which keeps the
-- student's exams and grades), else by student ID. It replaces the stored details (the editor
-- asks first) but keeps the student ID, programme, exam ID and note where the paste has none (or takes the
-- student ID another course has for that email), and is added when nobody matches. Rows whose
-- student ID or email disagree with another course are refused, all together. The group stays
-- as it is unless the row gives one (group_name, '' for none).
create or replace function public.exam_save_students(p_sheet text, p_archive boolean, p_students jsonb, p_remove uuid[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare x jsonb; ord bigint; v_id uuid; v_edit boolean; v_no text; v_email text; v_name text;
  v_programme text; v_code text; v_group text; v_conflicts text[] := '{}';
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if jsonb_typeof(coalesce(p_students, '[]'::jsonb)) <> 'array' then raise exception 'Invalid class list'; end if;
  delete from exam_private.students
    where sheet_name = p_sheet and is_archive = p_archive and id = any(coalesce(p_remove, '{}'::uuid[]));
  for x, ord in select t.x, t.ord from jsonb_array_elements(coalesce(p_students, '[]'::jsonb)) with ordinality as t(x, ord) loop
    v_edit := coalesce(x->>'id', '') <> '';
    v_no := btrim(coalesce(x->>'student_no', ''));
    v_email := lower(btrim(coalesce(x->>'email', '')));
    v_name := btrim(coalesce(x->>'full_name', ''));
    v_programme := btrim(coalesce(x->>'programme', ''));
    v_code := btrim(coalesce(x->>'exam_code', ''));
    v_group := left(btrim(coalesce(x->>'group_name', '')), 40);
    if v_name = '' or v_email = '' then raise exception 'Every student needs a name and an email'; end if;
    if v_no = '' and not v_edit then v_no := coalesce(exam_private.student_no_elsewhere(p_sheet, p_archive, v_email), ''); end if;
    if exam_private.identity_conflict(p_sheet, p_archive, v_no, v_email) is not null then
      v_conflicts := v_conflicts || case when v_no <> '' then v_no else v_email end;
    end if;
    if v_edit then
      select s.id into v_id from exam_private.students s
        where s.id = (x->>'id')::uuid and s.sheet_name = p_sheet and s.is_archive = p_archive;
      if not found then raise exception 'A student was removed meanwhile. Reload and try again.'; end if;
    else
      v_id := null;
      select s.id into v_id from exam_private.students s
        where s.sheet_name = p_sheet and s.is_archive = p_archive
          and ((v_no <> '' and s.student_no = v_no) or s.email = v_email)
        order by (s.email = v_email) desc limit 1;
    end if;
    if v_id is null then
      insert into exam_private.students (sheet_name, is_archive, student_no, full_name, email, programme, exam_code, note, list_order, group_name)
        values (p_sheet, p_archive, v_no, v_name, v_email, v_programme, v_code, btrim(coalesce(x->>'note', '')), ord, v_group);
    else
      update exam_private.students s set
        full_name = v_name, email = v_email,
        group_name = case when x ? 'group_name' then v_group else s.group_name end,
        student_no = case when v_edit or v_no <> '' then v_no else s.student_no end,
        programme = case when v_edit or v_programme <> '' then v_programme else s.programme end,
        exam_code = case when v_edit or v_code <> '' then v_code else s.exam_code end,
        -- A paste brings EIS's note ('R EX'); without one, the note typed in the editor stays.
        note = case when v_edit or btrim(coalesce(x->>'note', '')) <> '' then btrim(coalesce(x->>'note', '')) else s.note end,
        list_order = ord, updated_at = now()
      where s.id = v_id;
    end if;
  end loop;
  if cardinality(v_conflicts) > 0 then
    raise exception 'Another course has a different email or student ID for: %. A student keeps the same student ID and email in every course.',
      array_to_string(v_conflicts, ', ');
  end if;
exception when unique_violation then
  raise exception 'Two students cannot share a student ID or an email';
end $$;

-- Replaces the course offering's exam IDs, keeping the pasted order.
create or replace function public.exam_save_codes(p_sheet text, p_archive boolean, p_codes text[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if exists (select 1 from unnest(coalesce(p_codes, '{}'::text[])) c where btrim(c) <> '' and btrim(c) !~ '^\S{1,32}$') then
    raise exception 'Exam IDs must be single words of at most 32 characters'; end if;
  delete from exam_private.exam_codes where sheet_name = p_sheet and is_archive = p_archive;
  insert into exam_private.exam_codes (sheet_name, is_archive, code, list_order)
    select p_sheet, p_archive, btrim(c), min(ord)::integer
    from unnest(coalesce(p_codes, '{}'::text[])) with ordinality as t(c, ord)
    where btrim(c) <> '' group by btrim(c);
end $$;

-- Adds (no id) or updates an exam's settings. p_password null keeps it, '' clears it. Questions
-- change only when p_exam has them (a duplicate); the questions editor uses exam_save_questions.
-- The sign-in stays as it is once anyone has started or submitted the exam: their attempts and
-- submissions belong to a student or to an exam ID, and would no longer match.
create or replace function public.exam_save_exam(p_sheet text, p_archive boolean, p_exam jsonb, p_password text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid := nullif(p_exam->>'id', '')::uuid; v_sign_in text;
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if v_id is not null and not exists (select 1 from exam_private.exams
      where id = v_id and sheet_name = p_sheet and is_archive = p_archive) then
    raise exception 'This exam no longer exists'; end if;
  if v_id is not null then
    select sign_in into v_sign_in from exam_private.exams where id = v_id;
    if coalesce(nullif(p_exam->>'sign_in', ''), 'student_id') <> v_sign_in
        and (exists (select 1 from exam_private.submissions where exam_id = v_id and source <> 'manual')
          or exists (select 1 from exam_private.attempts where exam_id = v_id)) then
      raise exception 'The sign-in cannot change: students have already taken this exam'; end if;
  end if;
  if v_id is null then
    insert into exam_private.exams (sheet_name, is_archive, type)
      values (p_sheet, p_archive, coalesce(p_exam->>'type', 'quiz')) returning id into v_id;
  else
    -- Over at its old time: what was started then is submitted before the time moves (a new
    -- time, for the next group say, does not reopen it for those who started).
    perform exam_private.finalize_attempts(x, interval '0') from exam_private.exams x where x.id = v_id;
  end if;
  update exam_private.exams set
    label = btrim(coalesce(p_exam->>'label', '')),
    type = coalesce(p_exam->>'type', type),
    starts_at = nullif(p_exam->>'starts_at', '')::timestamptz,
    duration_minutes = nullif(p_exam->>'duration_minutes', '')::integer,
    hall = btrim(coalesce(p_exam->>'hall', '')),
    weight = nullif(p_exam->>'weight', '')::numeric,
    grading_key = coalesce(p_exam->>'grading_key', ''),
    base = coalesce(nullif(p_exam->>'base', '')::numeric, 100),
    sign_in = coalesce(nullif(p_exam->>'sign_in', ''), 'student_id'),
    shuffle_questions = coalesce((p_exam->>'shuffle_questions')::boolean, true),
    settings = case when jsonb_typeof(p_exam->'settings') = 'object' then exam_private.clean_settings(p_exam->'settings') else settings end,
    group_plan = case when jsonb_typeof(p_exam->'group_plan') = 'object' then exam_private.clean_group_plan(p_exam->'group_plan') else group_plan end,
    questions = case when jsonb_typeof(p_exam->'questions') = 'array' then exam_private.with_question_ids(p_exam->'questions') else questions end,
    visible = coalesce((p_exam->>'visible')::boolean, false),
    results_published = coalesce((p_exam->>'results_published')::boolean, false),
    password_hash = case when p_password is null then password_hash when btrim(p_password) = '' then null
      else extensions.crypt(p_password, extensions.gen_salt('bf', 8)) end,
    password_text = case when p_password is null then password_text when btrim(p_password) = '' then null
      else p_password end,
    updated_at = now()
  where id = v_id;
  -- One group's only: not for exam IDs, which are never linked to a student (or a group).
  update exam_private.exams set group_plan = group_plan - 'only' where id = v_id and sign_in = 'anonymous' and group_plan ? 'only';
  -- With sittings, the exam starts with the first.
  update exam_private.exams x set starts_at = (select min((s->>'starts_at')::timestamptz) from jsonb_array_elements(exam_private.sittings(x)) s)
    where x.id = v_id and exam_private.has_sittings(x);
  return v_id;
end $$;

-- ── Groups (Students tab, and an exam's sittings) ──

-- Sets students' groups: {class-list id: group} ('' for none).
create or replace function public.exam_set_groups(p_sheet text, p_archive boolean, p_groups jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if jsonb_typeof(p_groups) is distinct from 'object' then raise exception 'Invalid groups'; end if;
  update exam_private.students s set group_name = left(btrim(g.value), 40), updated_at = now()
    from jsonb_each_text(p_groups) g
    where s.id::text = lower(g.key) and s.sheet_name = p_sheet and s.is_archive = p_archive;
end $$;

-- Other course offerings the caller can see whose students have groups, to copy them from: each
-- with its groups and how many of this offering's students are on its list.
create or replace function public.exam_group_sources(p_sheet text, p_archive boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  return coalesce((select jsonb_agg(jsonb_build_object('sheet_name', d.sheet_name, 'archived', d.is_archive,
      'code', exam_private.course_meta(d.sheet_name, d.is_archive, 'code'), 'title', exam_private.course_meta(d.sheet_name, d.is_archive, 'title'),
      'semester', exam_private.course_meta(d.sheet_name, d.is_archive, 'semester'), 'year', exam_private.course_meta(d.sheet_name, d.is_archive, 'year'),
      'groups', (select jsonb_object_agg(k.group_name, k.n) from (select o.group_name, count(*) n from exam_private.students o
        where o.sheet_name = d.sheet_name and o.is_archive = d.is_archive and o.group_name <> '' group by o.group_name) k),
      'matched', (select count(*) from exam_private.students me where me.sheet_name = p_sheet and me.is_archive = p_archive
        and exists (select 1 from exam_private.students o where o.sheet_name = d.sheet_name and o.is_archive = d.is_archive
          and ((me.email <> '' and o.email = me.email) or (me.student_no <> '' and o.student_no = me.student_no)))))
      order by d.is_archive, exam_private.course_meta(d.sheet_name, d.is_archive, 'year') desc nulls last, exam_private.course_meta(d.sheet_name, d.is_archive, 'code'))
    from (select distinct s.sheet_name, s.is_archive from exam_private.students s
      where s.group_name <> '' and not (s.sheet_name = p_sheet and s.is_archive = p_archive)) d
    where exam_private.course_access(d.sheet_name, d.is_archive) is not null), '[]'::jsonb);
end $$;

-- Copies another offering's groups: each student takes their group there (matched by email, else
-- student ID); those not on its list, or without a group there, get none. Returns how many got one.
create or replace function public.exam_copy_groups(p_sheet text, p_archive boolean, p_from_sheet text, p_from_archive boolean) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  perform exam_private.require_access(p_from_sheet, p_from_archive, false);
  update exam_private.students me set updated_at = now(), group_name = coalesce((select o.group_name from exam_private.students o
      where o.sheet_name = p_from_sheet and o.is_archive = p_from_archive
        and ((me.email <> '' and o.email = me.email) or (me.student_no <> '' and o.student_no = me.student_no))
      order by (o.email = me.email) desc limit 1), '')
    where me.sheet_name = p_sheet and me.is_archive = p_archive;
  select count(*) into n from exam_private.students where sheet_name = p_sheet and is_archive = p_archive and group_name <> '';
  return n;
end $$;

-- One student takes this exam with another group (p_group), or with their own again (null or
-- ''): the exam's moves. Returns them.
create or replace function public.exam_set_move(p_exam_id uuid, p_student uuid, p_group text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; v_moves jsonb;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  if not exists (select 1 from exam_private.students where id = p_student and sheet_name = e.sheet_name and is_archive = e.is_archive) then
    raise exception 'This student is not on the course''s class list'; end if;
  v_moves := case when jsonb_typeof(e.group_plan->'moves') = 'object' then e.group_plan->'moves' else '{}'::jsonb end - p_student::text;
  if btrim(coalesce(p_group, '')) <> '' then v_moves := v_moves || jsonb_build_object(p_student::text, left(btrim(p_group), 40)); end if;
  update exam_private.exams set group_plan = coalesce(group_plan, '{}'::jsonb) || jsonb_build_object('moves', v_moves), updated_at = now()
    where id = e.id;
  return v_moves;
end $$;

-- Groups are each course offering's own, so two courses can put the same student in different
-- groups, at times that overlap. For the exam settings to warn before saving: the students of
-- this offering who would have another published exam (of any course, this one's too) at the
-- time being set (p_starts_at, p_duration, and the groups' times in p_plan, as exam_save_exam
-- takes it; p_exam_id the exam itself, null while it is new). Each: the student, their group
-- and time here, and the other exam's time and their group there; its course and name only
-- where the caller teaches that course too, else that it is another course's.
create or replace function public.exam_time_clashes(p_sheet text, p_archive boolean, p_exam_id uuid,
    p_starts_at timestamptz, p_duration integer, p_plan jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  perform exam_private.require_access(p_sheet, p_archive, false);
  if coalesce(p_duration, 0) <= 0 then return '[]'::jsonb; end if;
  e.id := p_exam_id; e.sheet_name := p_sheet; e.is_archive := p_archive;
  e.starts_at := p_starts_at; e.duration_minutes := p_duration;
  e.group_plan := exam_private.clean_group_plan(coalesce(p_plan, '{}'::jsonb));
  if e.starts_at is null and not exam_private.has_sittings(e) then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('student', c.student_id, 'name', c.full_name,
      'group', nullif(c.grp, ''), 'starts_at', c.st, 'other_exam', c.other_id, 'other_group', nullif(c.ogrp, ''),
      'other_starts_at', c.ost, 'other_ends_at', c.oen, 'same_course', c.same_course,
      'course', case when c.mine then c.ocode end, 'exam', case when c.mine then c.olabel end,
      'type', case when c.mine then c.otype end) order by c.ost, c.full_name)
    from (select distinct on (s.id, o.id) s.id student_id, s.full_name, here.grp, here.st, o.id other_id,
        there.grp ogrp, there.st ost, there.en oen, (o.sheet_name = p_sheet and o.is_archive = p_archive) same_course,
        exam_private.course_access(o.sheet_name, o.is_archive) is not null mine,
        exam_private.course_meta(o.sheet_name, o.is_archive, 'code') ocode, o.label olabel, o.type otype
      from exam_private.students s
      cross join lateral (select exam_private.student_sitting(e, s) grp) g
      cross join lateral (select g.grp, exam_private.sitting_start(e, g.grp) st, exam_private.sitting_end(e, g.grp) en) here
      join exam_private.students s2 on s2.email = s.email or (s.student_no <> '' and s2.student_no = s.student_no)
      join exam_private.exams o on o.sheet_name = s2.sheet_name and o.is_archive = s2.is_archive
      cross join lateral (select exam_private.student_sitting(o, s2) grp) og
      cross join lateral (select og.grp, exam_private.sitting_start(o, og.grp) st, exam_private.sitting_end(o, og.grp) en) there
      where s.sheet_name = p_sheet and s.is_archive = p_archive and here.st is not null and exam_private.takes_exam(e, s)
        and o.visible and not o.is_archive and o.id is distinct from p_exam_id and exam_private.takes_exam(o, s2)
        and o.starts_at is not null and o.duration_minutes is not null
        and coalesce((o.settings->>'date_only')::boolean, false) = false
        and there.st < here.en and here.st < there.en
      order by s.id, o.id) c), '[]'::jsonb);
end $$;

-- The questions editor: replaces an exam's questions, then drops images no exam shows. Also
-- while the exam runs: submissions' answers, grades and files follow their questions by id
-- (answers to a removed question are kept under "_removed"), and their totals are worked out
-- again, each by the questions it had (with what it drew from the pool). Students taking it
-- get the new version at their next check-in. Grade-only entries keep their grade.
create or replace function public.exam_save_questions(p_id uuid, p_questions jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; v_new jsonb; v_from jsonb; v_to jsonb; s exam_private.submissions; a exam_private.attempts;
  v_old_ids text[]; v_new_ids text[];
begin
  select * into e from exam_private.exams where id = p_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  if jsonb_typeof(p_questions) is distinct from 'array' then raise exception 'Invalid questions'; end if;
  v_new := exam_private.with_question_ids(p_questions);
  update exam_private.exams set questions = v_new, updated_at = now() where id = p_id;
  if v_new is distinct from e.questions then
    for s in select * from exam_private.submissions x where x.exam_id = p_id and x.source <> 'manual' loop
      v_from := to_jsonb(exam_private.question_ids(exam_private.drawn_questions(e.questions, s.draws)));
      v_to := exam_private.drawn_questions(v_new, s.draws);
      update exam_private.submissions set
          answers = exam_private.remap_answers(s.answers, v_from, v_to),
          grades = case when s.grades is null then null else exam_private.retotal(exam_private.remap_grades(s.grades, v_from, v_to), v_to) end,
          status = case when jsonb_typeof(s.grades->'questionGrades') = 'object' then
            case when exam_private.grades_complete(exam_private.remap_grades(s.grades, v_from, v_to), v_to) then 'graded' else 'submitted' end
            else s.status end
        where id = s.id;
    end loop;
    -- Files: each student's by their own questions (a file is kept with the attempt's owner).
    for a in select * from exam_private.attempts x where x.exam_id = p_id loop
      v_old_ids := exam_private.question_ids(exam_private.drawn_questions(e.questions, a.draws));
      v_new_ids := exam_private.question_ids(exam_private.drawn_questions(v_new, a.draws));
      if v_old_ids is distinct from v_new_ids then
        update exam_private.uploads u set question = coalesce(array_position(v_new_ids, v_old_ids[u.question]), 0)
          where u.exam_id = p_id and coalesce(u.student_key, 'code:' || u.exam_code) = a.who
            and u.question >= 1 and coalesce(v_old_ids[u.question], '') <> '';
      end if;
    end loop;
    v_old_ids := exam_private.question_ids(exam_private.drawn_questions(e.questions, null));
    v_new_ids := exam_private.question_ids(exam_private.drawn_questions(v_new, null));
    update exam_private.uploads u set question = coalesce(array_position(v_new_ids, v_old_ids[u.question]), 0)
      where u.exam_id = p_id and u.question >= 1 and coalesce(v_old_ids[u.question], '') <> ''
        and not exists (select 1 from exam_private.attempts x where x.exam_id = p_id and x.who = coalesce(u.student_key, 'code:' || u.exam_code));
  end if;
  perform exam_private.prune_images(e.sheet_name, e.is_archive);
end $$;

-- The questions editor: adds an image (base64, already scaled down by the editor) for the
-- course offering's questions, and returns its id. The questions list it in "images".
create or replace function public.exam_add_image(p_sheet text, p_archive boolean, p_mime text, p_data text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_data bytea; v_id uuid;
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if p_mime is null or p_mime not in ('image/webp', 'image/png', 'image/jpeg') then
    raise exception 'Images must be WebP, PNG or JPEG'; end if;
  begin
    v_data := decode(regexp_replace(coalesce(p_data, ''), '^data:[^,]*,', ''), 'base64');
  exception when others then
    raise exception 'This image could not be read';
  end;
  if length(v_data) = 0 then raise exception 'This image is empty'; end if;
  if length(v_data) > 3 * 1024 * 1024 then raise exception 'Images can be at most 3 MB'; end if;
  insert into exam_private.images (sheet_name, is_archive, mime, data) values (p_sheet, p_archive, p_mime, v_data)
    returning id into v_id;
  return v_id;
end $$;

-- The questions editor, preview and grading: the images an exam's saved questions show, and
-- those of the questions students drew from the pool.
create or replace function public.exam_get_images(p_exam_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, false);
  return exam_private.images_for(e.sheet_name, e.is_archive, e.questions || exam_private.drawn_copies(e.id));
end $$;

-- ── Question pools (Exams tab: Question pool, and pool items in an exam's questions) ──

-- The course's pool, from any of its offerings.
create or replace function public.exam_pool(p_sheet text, p_archive boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, false);
  return jsonb_build_object('course', exam_private.course_base(p_sheet), 'questions', exam_private.pool_questions(p_sheet),
    'updated_at', (select p.updated_at from exam_private.pools p where p.course = exam_private.course_base(p_sheet)));
end $$;

-- The images the pool's questions show.
create or replace function public.exam_pool_images(p_sheet text, p_archive boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, false);
  return exam_private.images_for(p_sheet, p_archive, exam_private.pool_questions(p_sheet));
end $$;

-- Replaces the pool's questions (each with an id; questions only, no information or pool
-- items) and returns them. Their images (added with exam_add_image to this offering) become
-- the course's, for every semester; those no longer shown go a day later.
create or replace function public.exam_save_pool(p_sheet text, p_archive boolean, p_questions jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_course text := exam_private.course_base(p_sheet); v_new jsonb;
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if jsonb_typeof(p_questions) is distinct from 'array' then raise exception 'Invalid questions'; end if;
  if exists (select 1 from jsonb_array_elements(p_questions) q where jsonb_typeof(q) <> 'object'
      or coalesce(q->>'type', '') in ('', 'pool', 'text_only')) then
    raise exception 'The pool takes questions only'; end if;
  v_new := exam_private.with_question_ids(p_questions);
  insert into exam_private.pools (course, questions, updated_at) values (v_course, v_new, now())
    on conflict (course) do update set questions = excluded.questions, updated_at = now();
  update exam_private.images i set sheet_name = 'pool:' || v_course, is_archive = false
    where i.id = any(exam_private.image_ids(v_new)) and i.sheet_name not like 'pool:%'
      and exam_private.course_base(i.sheet_name) = v_course;
  perform exam_private.prune_pool_images(v_course);
  return v_new;
end $$;

-- Links pool questions (p_ids) so that a student gets one of them at most (p_apart: the
-- link's name), or unlinks them (p_apart null or ''). Returns the pool's questions.
create or replace function public.exam_link_pool(p_sheet text, p_archive boolean, p_ids text[], p_apart text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_course text := exam_private.course_base(p_sheet); v_apart text := nullif(btrim(coalesce(p_apart, '')), '');
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if v_apart is not null and v_apart !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'Invalid link'; end if;
  update exam_private.pools p set updated_at = now(), questions = (select coalesce(jsonb_agg(case
      when t.q->>'id' = any(coalesce(p_ids, '{}'::text[])) then case when v_apart is null then t.q - 'apart' else t.q || jsonb_build_object('apart', v_apart) end
      else t.q end order by t.ord), '[]'::jsonb) from jsonb_array_elements(p.questions) with ordinality t(q, ord))
    where p.course = v_course;
  return exam_private.pool_questions(p_sheet);
end $$;

-- For the Grading tab: which entries exams count as, and whether their grades are visible
-- (those entries are Done and locked).
create or replace function public.exam_grading_links(p_sheet text, p_archive boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, false);
  return coalesce((select jsonb_agg(jsonb_build_object('grading_key', e.grading_key, 'label', e.label, 'type', e.type,
      'results_published', e.results_published) order by e.starts_at nulls last)
    from exam_private.exams e where e.sheet_name = p_sheet and e.is_archive = p_archive and e.grading_key <> ''), '[]'::jsonb);
end $$;

-- After the Grading tab renumbers its entries (removing Quiz 1 makes Quiz 2 quiz1_percentage):
-- exams follow their entry to its new key, or become Custom ('') when it was removed.
create or replace function public.exam_rename_grading_keys(p_sheet text, p_archive boolean, p_map jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if jsonb_typeof(p_map) is distinct from 'object' then raise exception 'Invalid key map'; end if;
  update exam_private.exams e set grading_key = m.value, updated_at = now()
    from jsonb_each_text(p_map) m
    where e.sheet_name = p_sheet and e.is_archive = p_archive and e.grading_key = m.key;
end $$;

-- Quick toggles from the exam list; null keeps the current value.
create or replace function public.exam_set_exam_flags(p_id uuid, p_visible boolean, p_results_published boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  update exam_private.exams set visible = coalesce(p_visible, visible),
    results_published = coalesce(p_results_published, results_published), updated_at = now() where id = p_id;
end $$;

create or replace function public.exam_delete_exam(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  delete from exam_private.exams where id = p_id;
  perform exam_private.prune_images(e.sheet_name, e.is_archive);
  perform exam_private.prune_pool_images(exam_private.course_base(e.sheet_name));
end $$;

create or replace function public.exam_submissions(p_exam_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, false);
  perform exam_private.finalize_attempts(e);
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'student_no', s.student_no,
      'student_name', s.student_name, 'student_email', s.student_email, 'exam_code', s.exam_code,
      'submitted_at', s.submitted_at, 'answers', s.answers, 'fingerprint', s.fingerprint,
      'activity', s.activity, 'network', s.network, 'auto_submitted', s.auto_submitted, 'late', s.late, 'status', s.status,
      'grades', s.grades, 'graded_at', s.graded_at, 'source', s.source, 'delivery', s.delivery,
      -- With pool items: the questions this student had, with what they drew.
      'questions', case when exam_private.has_pool(e.questions) then exam_private.drawn_questions(e.questions, s.draws) end,
      -- The files this student (or exam ID) uploaded and that are still stored.
      'files', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'question', u.question, 'name', u.file_name,
          'size', u.size_bytes, 'path', u.path, 'uploaded_at', u.created_at) order by u.created_at)
        from exam_private.stored_uploads(e.id) u
        where case when s.exam_code is null then u.student_key = s.student_no else u.exam_code = s.exam_code end), '[]'::jsonb))
      order by s.submitted_at)
    from exam_private.submissions s where s.exam_id = p_exam_id), '[]'::jsonb);
end $$;

-- Submissions: every stored file of an exam, to download or delete them all. Deleting goes
-- through Storage (the policies below), which removes the files themselves.
create or replace function public.exam_upload_paths(p_exam_id uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, false);
  return coalesce((select array_agg(u.path order by u.created_at) from exam_private.stored_uploads(e.id) u), '{}'::text[]);
end $$;

create or replace function public.exam_save_grades(p_submission_id uuid, p_grades jsonb, p_status text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select x.* into e from exam_private.exams x join exam_private.submissions s on s.exam_id = x.id where s.id = p_submission_id;
  if not found then raise exception 'This submission no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, false);
  if p_status not in ('submitted', 'graded') then raise exception 'Invalid status'; end if;
  update exam_private.submissions set grades = p_grades, status = p_status, graded_at = now() where id = p_submission_id;
end $$;

-- An answer key fixed after students submitted (Grades: Regrade). A submission keeps copies of
-- the pool questions it drew, with the answer keys they had then; this gives those copies the
-- new keys and saves the grades worked out again with them, all in one go. Each change:
-- {submission, keys: {pool item id: {pool question id: the key}}, grades, status}, keys and
-- grades each optional. Only the answer key's fields change (correct_answers, accepted_answers,
-- answer, tolerance, explanation): the questions stay as the students saw them. Returns how many
-- submissions changed.
create or replace function public.exam_update_answer_keys(p_exam_id uuid, p_changes jsonb) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; c jsonb; s exam_private.submissions; v_draws jsonb; n integer := 0;
  v_fields text[] := array['correct_answers', 'accepted_answers', 'answer', 'tolerance', 'explanation'];
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'Invalid changes'; end if;
  for c in select t.c from jsonb_array_elements(p_changes) t(c) loop
    if jsonb_typeof(c) <> 'object' or coalesce(c->>'submission', '') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Invalid changes'; end if;
    select * into s from exam_private.submissions x where x.id = (c->>'submission')::uuid and x.exam_id = e.id;
    if not found then raise exception 'A submission is no longer there: refresh the list and try again'; end if;
    v_draws := s.draws;
    if jsonb_typeof(c->'keys') = 'object' and jsonb_typeof(s.draws) = 'object' then
      select coalesce(jsonb_object_agg(d.item, case when jsonb_typeof(d.list) = 'array' and jsonb_typeof(c->'keys'->d.item) = 'object' then
          (select coalesce(jsonb_agg(case when jsonb_typeof(q.q) = 'object' and jsonb_typeof(c->'keys'->d.item->(q.q->>'id')) = 'object'
              then (q.q - v_fields) || (select coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb)
                from jsonb_each(c->'keys'->d.item->(q.q->>'id')) k where k.key = any(v_fields) and k.value <> 'null'::jsonb)
              else q.q end order by q.ord), '[]'::jsonb)
            from jsonb_array_elements(d.list) with ordinality q(q, ord))
          else d.list end), '{}'::jsonb)
        into v_draws from jsonb_each(s.draws) d(item, list);
    end if;
    if jsonb_typeof(c->'grades') = 'object' then
      if coalesce(c->>'status', '') not in ('submitted', 'graded') then raise exception 'Invalid status'; end if;
      update exam_private.submissions set draws = v_draws, grades = c->'grades', status = c->>'status', graded_at = now() where id = s.id;
    elsif v_draws is distinct from s.draws then
      update exam_private.submissions set draws = v_draws where id = s.id;
    else
      continue;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.exam_delete_submission(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select x.* into e from exam_private.exams x join exam_private.submissions s on s.exam_id = x.id where s.id = p_id;
  if not found then raise exception 'This submission no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  delete from exam_private.submissions where id = p_id;
end $$;

-- Submissions: who started the exam (with or without submitting), from which device and when
-- last seen, whether it is open on a device now, and how often it was handed back. who: the
-- student's key (student ID, or email), or 'code:' and the exam ID.
create or replace function public.exam_attempts(p_exam_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, false);
  return coalesce((select jsonb_agg(jsonb_build_object('who', a.who, 'last_seen', a.last_seen, 'live', a.last_seen > now() - interval '2 minutes',
      'sitting', case when exam_private.has_sittings(e) then exam_private.who_sitting(e, a.who) end,
      'draft_at', a.draft_at, 'returned', jsonb_array_length(a.returned), 'returned_at', a.returned_at,
      'move_allowed_until', case when a.device <> 'returned' and exam_private.can_move(a) then a.move_allowed_at + interval '30 minutes' end))
    from exam_private.attempts a where a.exam_id = p_exam_id), '[]'::jsonb);
end $$;

-- Lets a student carry on an exam in progress on another computer (lecturers only): theirs
-- broke down, or has to be changed. For 30 minutes the next computer that starts it takes it,
-- with the answers last saved (the draft), and the one before stops. p_who: the student's key
-- (student ID, or email), or 'code:' and the exam ID. Returns until when.
create or replace function public.exam_allow_move(p_exam_id uuid, p_who text) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; v_at timestamptz;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  update exam_private.attempts set move_allowed_at = now() where exam_id = e.id and who = p_who
    returning move_allowed_at into v_at;
  if v_at is null then raise exception 'They have not started this exam: they can start it on any computer'; end if;
  return v_at + interval '30 minutes';
end $$;

-- Hands a submission back to the student (lecturers only): it is taken off, kept with the
-- attempt, and its answers become the draft the exam carries on from, the unconfirmed ones as
-- the student last had them. The student can go on while the exam is open: extend its time if
-- it has ended. Its grades go with it.
create or replace function public.exam_return_submission(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; sub exam_private.submissions; a exam_private.attempts; v_who text; v_ids text[];
  v_answers jsonb := '{}'::jsonb; v_conf jsonb := '{}'::jsonb; v_old jsonb; v_draft jsonb; n integer; v jsonb;
begin
  select * into sub from exam_private.submissions where id = p_id;
  if not found then raise exception 'This submission no longer exists'; end if;
  select * into e from exam_private.exams where id = sub.exam_id;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  if sub.source = 'manual' then raise exception 'There is nothing to hand back: no answers were submitted'; end if;
  v_who := case when sub.exam_code is not null then 'code:' || sub.exam_code else sub.student_no end;
  select * into a from exam_private.attempts where exam_id = e.id and who = v_who for update;
  v_ids := exam_private.question_ids(exam_private.drawn_questions(e.questions, sub.draws));
  -- The last draft by question id: what the student had typed, also where it was not confirmed.
  v_old := exam_private.answers_by_id(a.draft->'answers', a.draft->'question_ids');
  for n in 1 .. coalesce(array_length(v_ids, 1), 0) loop
    v := sub.answers -> ('ans-' || n);
    if v is not null and v not in ('"[NOT CONFIRMED]"'::jsonb, '"[TEXT_ONLY_NO_ANSWER_REQUIRED]"'::jsonb) then
      v_answers := v_answers || jsonb_build_object('ans-' || n, v);
      v_conf := v_conf || jsonb_build_object('q-' || n, true);
      if sub.answers ? ('ans-' || n || '_metadata') then
        v_answers := v_answers || jsonb_build_object('ans-' || n || '_metadata', sub.answers -> ('ans-' || n || '_metadata'));
      end if;
    elsif v_old ? coalesce(nullif(v_ids[n], ''), '#' || n) then
      v_answers := v_answers || jsonb_build_object('ans-' || n, v_old -> coalesce(nullif(v_ids[n], ''), '#' || n));
    end if;
  end loop;
  v_draft := jsonb_build_object('answers', v_answers, 'confirmations', v_conf, 'question_ids', to_jsonb(v_ids),
    'integrity', jsonb_build_object('count', coalesce((sub.activity->>'count')::integer, 0),
      'total', coalesce((sub.activity->>'total_seconds')::numeric, 0),
      'leaves', coalesce(sub.activity->'leaves', '[]'::jsonb), 'away', null, 'cooldownLeft', 0,
      'cooldownTotal', coalesce((sub.activity->>'cooldown_seconds_total')::numeric, 0)));
  -- On any computer: the next one that starts it takes it (exam_private.can_move).
  insert into exam_private.attempts (exam_id, who, device, last_seen)
    values (e.id, v_who, 'returned', now() - interval '1 hour')
    on conflict (exam_id, who) do update set device = 'returned', move_allowed_at = null,
      last_seen = least(exam_private.attempts.last_seen, now() - interval '1 hour');
  update exam_private.attempts set draft = v_draft, draft_at = now(), returned_at = now(), draws = coalesce(sub.draws, draws),
      returned = returned || jsonb_build_array(jsonb_build_object('submitted_at', sub.submitted_at, 'returned_at', now(),
        'returned_by', teaching_private.email(), 'answers', sub.answers, 'activity', sub.activity, 'grades', sub.grades,
        'auto_submitted', sub.auto_submitted, 'late', sub.late))
    where exam_id = e.id and who = v_who;
  delete from exam_private.submissions where id = sub.id;
end $$;

-- Hands a submission back as a new paper (lecturers only): the submission, its answers and its
-- grade are taken off (kept with the attempt, as with a hand back), the answers so far are
-- cleared, files uploaded for it are kept but answer nothing, and the student starts again with
-- a new draw from the pool and the questions and options in a new order. While the exam is
-- open: extend its time if it has ended.
create or replace function public.exam_return_new_paper(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; sub exam_private.submissions; v_who text;
begin
  select * into sub from exam_private.submissions where id = p_id;
  if not found then raise exception 'This submission no longer exists'; end if;
  select * into e from exam_private.exams where id = sub.exam_id;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  if sub.source = 'manual' then raise exception 'There is nothing to hand back: no answers were submitted'; end if;
  v_who := case when sub.exam_code is not null then 'code:' || sub.exam_code else sub.student_no end;
  -- On any computer: the next one that starts it takes it (exam_private.can_move).
  insert into exam_private.attempts (exam_id, who, device, last_seen)
    values (e.id, v_who, 'returned', now() - interval '1 hour')
    on conflict (exam_id, who) do update set device = 'returned', move_allowed_at = null,
      last_seen = least(exam_private.attempts.last_seen, now() - interval '1 hour');
  update exam_private.attempts set draft = null, draft_at = null, draws = null, paper = paper + 1, returned_at = now(),
      submit_key_hash = null,
      returned = returned || jsonb_build_array(jsonb_build_object('submitted_at', sub.submitted_at, 'returned_at', now(),
        'returned_by', teaching_private.email(), 'new_paper', true, 'answers', sub.answers, 'activity', sub.activity,
        'grades', sub.grades, 'draws', sub.draws, 'auto_submitted', sub.auto_submitted, 'late', sub.late))
    where exam_id = e.id and who = v_who;
  update exam_private.uploads set question = 0
    where exam_id = e.id and coalesce(student_key, 'code:' || exam_code) = v_who;
  delete from exam_private.submissions where id = sub.id;
end $$;

-- A submission the lecturer adds for a student (p_student: the class-list row) or an exam ID
-- (p_code) that has none: with no answers, to enter a grade (an exam held on paper, or a
-- student who did not take it), or with the answers from the student's backup file
-- (p_submission: its answers, question_ids, activity and fingerprint). Not while the exam
-- still takes answers; a student who then submits takes the place of a grade-only one.
-- Returns its id, for exam_save_grades.
create or replace function public.exam_add_submission(p_exam_id uuid, p_student uuid, p_code text, p_submission jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students; v_code text := nullif(btrim(coalesce(p_code, '')), ''); v_id uuid;
  v_answers jsonb; v_import boolean; v_draws jsonb;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  v_answers := case when jsonb_typeof(p_submission->'answers') = 'object' then p_submission->'answers' end;
  v_import := v_answers is not null;
  perform exam_private.require_access(e.sheet_name, e.is_archive, v_import);
  if jsonb_array_length(e.questions) > 0 and e.starts_at is not null and now() >= e.starts_at
     and (exam_private.ends_at(e) is null or now() <= exam_private.ends_at(e) + interval '10 minutes') then
    raise exception 'The exam is still taking answers: grade it once it has closed'; end if;
  -- What a student with pool items drew: kept with their attempt, else read from the file.
  if v_import and exam_private.has_pool(e.questions) then
    select a.draws into v_draws from exam_private.attempts a where a.exam_id = e.id
      and a.who = coalesce('code:' || v_code, (select exam_private.student_key(st) from exam_private.students st where st.id = p_student));
    v_draws := coalesce(v_draws, exam_private.draws_from_ids(e.questions, exam_private.pool_questions(e.sheet_name), p_submission->'question_ids'));
  end if;
  if v_import then
    v_answers := exam_private.remap_answers(v_answers, p_submission->'question_ids', exam_private.drawn_questions(e.questions, v_draws));
  end if;
  if e.sign_in = 'anonymous' then
    if v_code is null or not exists (select 1 from exam_private.exam_codes c where c.sheet_name = e.sheet_name and c.is_archive = e.is_archive and c.code = v_code) then
      raise exception 'This exam ID is not on the course''s list'; end if;
    if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code = v_code) then
      raise exception 'This exam ID already has a submission'; end if;
    insert into exam_private.submissions (exam_id, exam_code, answers, fingerprint, activity, source, delivery, submitted_at, draws)
      values (e.id, v_code, coalesce(v_answers, '{}'::jsonb),
        case when jsonb_typeof(p_submission->'fingerprint') = 'object' then p_submission->'fingerprint' else '{}'::jsonb end,
        case when jsonb_typeof(p_submission->'activity') = 'object' then p_submission->'activity' else '{}'::jsonb end,
        case when v_import then 'imported' else 'manual' end,
        jsonb_strip_nulls(jsonb_build_object('added_by', teaching_private.email(), 'file_time', p_submission->>'file_time')), now(), v_draws)
      returning id into v_id;
  else
    select * into s from exam_private.students where id = p_student and sheet_name = e.sheet_name and is_archive = e.is_archive;
    if not found then raise exception 'This student is not on the course''s class list'; end if;
    if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code is null
        and (student_id = s.id or student_no = exam_private.student_key(s))) then
      raise exception 'This student already has a submission'; end if;
    insert into exam_private.submissions (exam_id, student_id, student_no, student_name, student_email, answers, fingerprint,
        activity, source, delivery, submitted_at, draws)
      values (e.id, s.id, exam_private.student_key(s), s.full_name, s.email, coalesce(v_answers, '{}'::jsonb),
        case when jsonb_typeof(p_submission->'fingerprint') = 'object' then p_submission->'fingerprint' else '{}'::jsonb end,
        case when jsonb_typeof(p_submission->'activity') = 'object' then p_submission->'activity' else '{}'::jsonb end,
        case when v_import then 'imported' else 'manual' end,
        jsonb_strip_nulls(jsonb_build_object('added_by', teaching_private.email(), 'file_time', p_submission->>'file_time')), now(), v_draws)
      returning id into v_id;
  end if;
  return v_id;
end $$;

-- The Students tab's grade table: every submission of the course offering's exams, its status
-- and points. Exam IDs are listed as they are, never matched to students.
create or replace function public.exam_gradebook(p_sheet text, p_archive boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, false);
  perform exam_private.finalize_course(p_sheet, p_archive);
  return coalesce((select jsonb_agg(jsonb_build_object('exam_id', s.exam_id, 'student_no', s.student_no, 'student_id', s.student_id,
      'exam_code', s.exam_code, 'status', s.status, 'source', s.source, 'late', s.late,
      'total', s.grades->'totalScore', 'max', s.grades->'maxScore'))
    from exam_private.submissions s join exam_private.exams e on e.id = s.exam_id
    where e.sheet_name = p_sheet and e.is_archive = p_archive), '[]'::jsonb);
end $$;

-- One student across courses: every class-list row of the same person (the same email or
-- student ID) in the course offerings the caller can see, with their named exams and grades.
-- Anonymous exams are never matched to a student, so they are not here.
create or replace function public.exam_student_record(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare st exam_private.students;
begin
  select * into st from exam_private.students where id = p_student;
  if not found then raise exception 'This student is no longer on the list'; end if;
  perform exam_private.require_access(st.sheet_name, st.is_archive, false);
  return coalesce((select jsonb_agg(jsonb_build_object('sheet_name', o.sheet_name, 'archived', o.is_archive, 'current', o.id = st.id,
      'code', exam_private.course_meta(o.sheet_name, o.is_archive, 'code'),
      'title', exam_private.course_meta(o.sheet_name, o.is_archive, 'title'),
      'semester', exam_private.course_meta(o.sheet_name, o.is_archive, 'semester'),
      'year', exam_private.course_meta(o.sheet_name, o.is_archive, 'year'),
      'student', jsonb_build_object('id', o.id, 'student_no', o.student_no, 'full_name', o.full_name, 'email', o.email,
        'programme', o.programme, 'note', o.note),
      'exams', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'label', e.label, 'type', e.type, 'starts_at', e.starts_at,
          'weight', e.weight, 'base', e.base, 'results_published', e.results_published, 'question_count', jsonb_array_length(e.questions),
          'submission', (select jsonb_build_object('status', x.status, 'source', x.source, 'late', x.late, 'submitted_at', x.submitted_at,
              'total', x.grades->'totalScore', 'max', x.grades->'maxScore')
            from exam_private.submissions x where x.exam_id = e.id and x.exam_code is null
              and (x.student_id = o.id or x.student_no = exam_private.student_key(o)) limit 1))
          order by e.starts_at nulls last, e.created_at)
        from exam_private.exams e where e.sheet_name = o.sheet_name and e.is_archive = o.is_archive and e.sign_in <> 'anonymous'), '[]'::jsonb))
      order by o.id <> st.id, o.is_archive, exam_private.course_meta(o.sheet_name, o.is_archive, 'year') desc nulls last,
        exam_private.course_meta(o.sheet_name, o.is_archive, 'code'))
    from exam_private.students o
    where (o.id = st.id or (st.email <> '' and o.email = st.email) or (st.student_no <> '' and o.student_no = st.student_no))
      and exam_private.course_access(o.sheet_name, o.is_archive) is not null), '[]'::jsonb);
end $$;

-- After teaching_move_course (archive or restore): moves the course's exam data to its new
-- name. Only once the move has happened (source gone, destination there), by someone who
-- manages the destination; safe to call again.
create or replace function public.exam_move_course(p_name text, p_from_archive boolean, p_new_name text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.course_rows where sheet_name = p_name and is_archive = p_from_archive) then
    raise exception 'The course has not moved'; end if;
  if not exists (select 1 from public.course_rows where sheet_name = p_new_name and is_archive = not p_from_archive) then
    raise exception 'The course''s new location does not exist'; end if;
  perform exam_private.require_access(p_new_name, not p_from_archive, true);
  if not exists (select 1 from exam_private.exams where sheet_name = p_name and is_archive = p_from_archive)
     and not exists (select 1 from exam_private.students where sheet_name = p_name and is_archive = p_from_archive)
     and not exists (select 1 from exam_private.exam_codes where sheet_name = p_name and is_archive = p_from_archive)
     and not exists (select 1 from exam_private.images where sheet_name = p_name and is_archive = p_from_archive) then
    return; -- nothing to move (or already moved)
  end if;
  delete from exam_private.students where sheet_name = p_new_name and is_archive = not p_from_archive;
  delete from exam_private.exam_codes where sheet_name = p_new_name and is_archive = not p_from_archive;
  delete from exam_private.exams where sheet_name = p_new_name and is_archive = not p_from_archive;
  delete from exam_private.images where sheet_name = p_new_name and is_archive = not p_from_archive;
  update exam_private.images set sheet_name = p_new_name, is_archive = not p_from_archive
    where sheet_name = p_name and is_archive = p_from_archive;
  update exam_private.students set sheet_name = p_new_name, is_archive = not p_from_archive
    where sheet_name = p_name and is_archive = p_from_archive;
  update exam_private.exam_codes set sheet_name = p_new_name, is_archive = not p_from_archive
    where sheet_name = p_name and is_archive = p_from_archive;
  update exam_private.exams set sheet_name = p_new_name, is_archive = not p_from_archive
    where sheet_name = p_name and is_archive = p_from_archive;
end $$;

-- After teaching_delete_course: removes the course's exam data. Admins only, and only once
-- the course itself is gone; safe to call again.
create or replace function public.exam_delete_course(p_name text, p_archive boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.teaching_role() is distinct from 'admin' then
    raise exception 'Only admins can delete courses' using errcode = '42501'; end if;
  if exists (select 1 from public.course_rows where sheet_name = p_name and is_archive = p_archive) then
    raise exception 'The course still exists'; end if;
  delete from exam_private.exams where sheet_name = p_name and is_archive = p_archive;
  delete from exam_private.students where sheet_name = p_name and is_archive = p_archive;
  delete from exam_private.exam_codes where sheet_name = p_name and is_archive = p_archive;
  delete from exam_private.images where sheet_name = p_name and is_archive = p_archive;
end $$;

-- ── Students (/exam/) ──

-- ── One device at a time ──
-- The device is a random id the exam page keeps in the browser. "Live" means it checked in
-- within the last 2 minutes.
create or replace function exam_private.open_session(p_kind text, p_student uuid, p_exam uuid, p_code text,
  p_until timestamptz, p_device text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from exam_private.sessions where expires_at < now();
  insert into exam_private.sessions (token_hash, kind, student_id, exam_id, exam_code, device, last_seen, ends_at, expires_at)
    values (exam_private.token_hash(token), p_kind, p_student, p_exam, p_code, p_device, now(), p_until,
      least(p_until, now() + interval '30 minutes'));
  return token;
end $$;
revoke all on function exam_private.open_session(text, uuid, uuid, text, timestamptz, text) from public, anon, authenticated;

-- The caller's IP address and browser, from the request's headers: Cloudflare's
-- cf-connecting-ip (set by Supabase's edge, so a browser can't fake it), else the proxies'.
create or replace function exam_private.request_header(p_name text) returns text
language sql stable set search_path = '' as $$
  select nullif(btrim(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> p_name), '')
$$;
revoke all on function exam_private.request_header(text) from public, anon, authenticated;

create or replace function exam_private.client_ip() returns text
language sql stable set search_path = '' as $$
  select left(coalesce(exam_private.request_header('cf-connecting-ip'), exam_private.request_header('x-real-ip'),
    nullif(btrim(split_part(exam_private.request_header('x-forwarded-for'), ',', 1)), '')), 64)
$$;
revoke all on function exam_private.client_ip() from public, anon, authenticated;

-- Whether another device may take this exam in progress: the lecturer handed it back, or
-- allowed it to move (within the last 30 minutes).
create or replace function exam_private.can_move(a exam_private.attempts) returns boolean
language sql stable set search_path = '' as $$
  select a.device = 'returned' or coalesce(a.move_allowed_at > now() - interval '30 minutes', false)
$$;
revoke all on function exam_private.can_move(exam_private.attempts) from public, anon, authenticated;

-- Takes an exam in progress for this device (or keeps it), refused when it is another
-- device's and the lecturer has not let it move (exam_private.can_move), and notes the network
-- and device it came from. Returns the attempt, with the draft another device left.
create or replace function exam_private.claim_attempt(p_exam uuid, p_who text, p_device text) returns exam_private.attempts
language plpgsql volatile security definer set search_path = '' as $$
declare a exam_private.attempts; v_ip text := exam_private.client_ip();
  v_agent text := left(coalesce(exam_private.request_header('user-agent'), ''), 300);
begin
  if coalesce(btrim(p_device), '') = '' then raise exception 'Reload the page and try again'; end if;
  select * into a from exam_private.attempts where exam_id = p_exam and who = p_who for update;
  if found and a.device <> p_device and not exam_private.can_move(a) then
    raise exception 'This exam was started on another computer. To carry on here, ask your lecturer to let you continue on this computer, then try again.'
      using errcode = 'P0001', hint = 'other_device';
  end if;
  insert into exam_private.attempts (exam_id, who, device, last_seen) values (p_exam, p_who, p_device, now())
    on conflict (exam_id, who) do update set device = excluded.device, last_seen = now(),
      move_allowed_at = case when exam_private.attempts.device = excluded.device then exam_private.attempts.move_allowed_at end
    returning * into a;
  -- One entry per network and device: first and last seen, and how many calls (at most 50 entries).
  update exam_private.attempts set network = case
      when exists (select 1 from jsonb_array_elements(a.network) e where e->>'ip' is not distinct from v_ip and e->>'device' = p_device)
      then (select jsonb_agg(case when e->>'ip' is not distinct from v_ip and e->>'device' = p_device
          then e || jsonb_build_object('last', now(), 'calls', coalesce((e->>'calls')::integer, 0) + 1) else e end order by ord)
        from jsonb_array_elements(a.network) with ordinality t(e, ord))
      when jsonb_array_length(a.network) >= 50 then a.network
      else a.network || jsonb_build_array(jsonb_build_object('ip', v_ip, 'device', p_device, 'agent', v_agent,
        'first', now(), 'last', now(), 'calls', 1)) end
    where exam_id = p_exam and who = p_who
    returning * into a;
  return a;
end $$;
revoke all on function exam_private.claim_attempt(uuid, text, text) from public, anon, authenticated;

-- A temporary sign-in for taking one exam: the student ID and the password of one of the
-- student's Student ID exams (set on the Exams tab), from an hour before it starts until it
-- ends. Not once the student has submitted it (unless the lecturer hands it back), and not
-- after the end: changing the exam's time opens it again. The session opens that exam only
-- (exam_private.exam_student), ends with it, or after 30 minutes without the page checking
-- in. One device at a time: refused while another device is live with the student's sign-in,
-- or has one of their exams in progress (until the lecturer lets it move, exam_allow_move);
-- the silent sign-ins are signed out. Students without a student ID sign in with Google. Refusals other than a wrong student ID or password say why, with a hint for the
-- page: opens_at:<time>, exam_over, submitted or not_scheduled. With sittings, by the student's
-- own sitting's time.
create or replace function public.exam_student_sign_in(p_student_no text, p_password text, p_device text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s exam_private.students; e exam_private.exams; v_student uuid; v_exam uuid; token text; until timestamptz;
  v_start timestamptz; v_end timestamptz;
begin
  -- The exam whose password this is: one that can be signed in to now first, then the one
  -- nearest in time (a password used again for another exam).
  select st.id, x.id into v_student, v_exam from exam_private.students st
    join exam_private.exams x on x.sheet_name = st.sheet_name and x.is_archive = st.is_archive
    cross join lateral (select exam_private.sitting_start(x, exam_private.student_sitting(x, st)) gs) w
  where not st.is_archive and st.student_no <> '' and st.student_no = btrim(coalesce(p_student_no, ''))
    and x.sign_in = 'student_id' and x.visible and x.password_hash is not null and exam_private.takes_exam(x, st)
    and x.password_hash = extensions.crypt(coalesce(p_password, ''), x.password_hash)
  order by coalesce(now() >= w.gs - interval '1 hour' and now() <= w.gs + make_interval(mins => x.duration_minutes), false) desc,
    abs(extract(epoch from (w.gs - now()))) nulls last
  limit 1;
  if v_student is null then
    perform pg_sleep(0.7);
    raise exception 'Wrong student ID or password' using errcode = '28P01';
  end if;
  if coalesce(btrim(p_device), '') = '' then raise exception 'Reload the page and try again'; end if;
  select * into s from exam_private.students where id = v_student;
  select * into e from exam_private.exams where id = v_exam;
  v_start := exam_private.sitting_start(e, exam_private.student_sitting(e, s));
  v_end := exam_private.sitting_end(e, exam_private.student_sitting(e, s));
  if v_end is null then
    raise exception 'This exam has no date and time yet: ask your lecturer' using errcode = 'P0001', hint = 'not_scheduled';
  end if;
  if now() > v_end then
    raise exception 'This exam is over, so its password no longer signs in' using errcode = 'P0001',
      hint = case when exam_private.has_sittings(e) then 'group_over:' || exam_private.student_sitting(e, s) else 'exam_over' end;
  end if;
  if now() < v_start - interval '1 hour' then
    raise exception 'This exam has not opened yet: you can sign in from an hour before it starts'
      using errcode = 'P0001', hint = 'opens_at:' || to_char(v_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;
  if exists (select 1 from exam_private.submissions u where u.exam_id = e.id and u.exam_code is null and u.source <> 'manual'
      and (u.student_id = s.id or u.student_no = exam_private.student_key(s))) then
    raise exception 'You have already submitted this exam, so its password no longer signs you in'
      using errcode = 'P0001', hint = 'submitted';
  end if;
  -- An exam of theirs in progress on another computer (not submitted, still taking answers),
  -- which the lecturer has not let move: signing in here would only sign that one out.
  if exists (select 1 from exam_private.attempts a join exam_private.exams x on x.id = a.exam_id
      where a.who = exam_private.student_key(s) and x.sheet_name = s.sheet_name and x.is_archive = s.is_archive
        and a.device <> p_device and not exam_private.can_move(a)
        and now() <= exam_private.ends_at(x) + interval '10 minutes'
        and not exists (select 1 from exam_private.submissions u where u.exam_id = x.id and u.exam_code is null
          and u.source <> 'manual' and u.student_no = a.who)) then
    raise exception 'Your exam was started on another computer. To carry on here, ask your lecturer to let you continue on this computer, then sign in again.'
      using errcode = 'P0001', hint = 'other_device';
  end if;
  if exists (select 1 from exam_private.sessions x where x.kind = 'student' and x.student_id = s.id
        and x.expires_at > now() and x.device is distinct from p_device and x.last_seen > now() - interval '2 minutes')
     and not exists (select 1 from exam_private.attempts a join exam_private.exams x on x.id = a.exam_id
        where a.who = exam_private.student_key(s) and x.sheet_name = s.sheet_name and x.is_archive = s.is_archive
          and exam_private.can_move(a)) then
    raise exception 'You are signed in on another device. Sign out there first; if that computer stopped working, try again in 2 minutes.'
      using errcode = 'P0001', hint = 'other_device';
  end if;
  delete from exam_private.sessions where kind = 'student' and student_id = s.id;
  until := v_end + interval '15 minutes';
  token := exam_private.open_session('student', s.id, e.id, null, until, p_device);
  return jsonb_build_object('token', token, 'expires_at', until, 'name', s.full_name, 'student_no', s.student_no,
    'exam_id', e.id, 'server_now', now());
end $$;

-- Whether the caller signed in with this exam's password, so starting it doesn't ask again.
create or replace function exam_private.signed_in_for(p_exam uuid, p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from exam_private.sessions x where x.token_hash = exam_private.token_hash(p_token)
    and x.kind = 'student' and x.exam_id = p_exam and x.expires_at > now())
$$;
revoke all on function exam_private.signed_in_for(uuid, text) from public, anon, authenticated;

-- Ends the sign-in. This device's exams in progress no longer show as open on it (they stay
-- this device's: another one needs the lecturer's leave, exam_allow_move).
create or replace function public.exam_sign_out(p_token text, p_device text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  delete from exam_private.sessions where token_hash = exam_private.token_hash(p_token);
  if coalesce(btrim(p_device), '') <> '' then
    update exam_private.attempts set last_seen = now() - interval '1 hour' where device = p_device;
  end if;
end $$;

-- Every 30 seconds from the exam page while signed in with a student ID or taking an exam,
-- and when it opens a saved exam. Keeps the sign-in going (30 minutes more), and the exam on
-- this device with the answers so far (p_draft). Says where things stand: signed_in (false
-- once the Student ID sign-in is over, or taken by another device) and exam: 'ok',
-- 'elsewhere' (another device is live on it), 'submitted', 'closed' (no longer taking
-- answers) or 'signed_out'; with 'ok', the exam's end (it may have been extended) and the
-- version of its questions (they may have been changed), so the page catches up. While an
-- exam is taken, its sign-in lasts until 15 minutes after the exam's end, however long the
-- connection is gone.
create or replace function public.exam_heartbeat(p_token text, p_device text, p_exam_id uuid, p_draft jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare x exam_private.sessions; e exam_private.exams; s exam_private.students; v_who text; v_exam text;
  a exam_private.attempts; v_questions jsonb; v_paper integer;
begin
  select * into x from exam_private.sessions where token_hash = exam_private.token_hash(p_token) and expires_at > now();
  if x.token_hash is not null and x.device is not distinct from p_device then
    update exam_private.sessions set last_seen = now(), expires_at = least(coalesce(ends_at, expires_at), now() + interval '30 minutes')
      where token_hash = x.token_hash;
  end if;
  if p_exam_id is not null then
    select * into e from exam_private.exams where id = p_exam_id;
    if not found then
      v_exam := 'closed';
    else
      if e.sign_in = 'anonymous' then
        v_who := case when x.kind = 'anonymous' and x.exam_id = e.id then 'code:' || x.exam_code end;
      else
        begin
          s := exam_private.exam_student(e, p_token);
          v_who := exam_private.student_key(s);
        exception when others then
          v_who := null;
        end;
      end if;
      if v_who is null then
        v_exam := 'signed_out';
      elsif exists (select 1 from exam_private.submissions u where u.exam_id = e.id and u.source <> 'manual' and
          case when e.sign_in = 'anonymous' then u.exam_code = substr(v_who, 6) else u.exam_code is null and u.student_no = v_who end) then
        v_exam := 'submitted';
      elsif exam_private.who_end(e, v_who) is null or now() > exam_private.who_end(e, v_who) + interval '10 minutes' then
        v_exam := 'closed';
      else
        select * into a from exam_private.attempts where exam_id = e.id and who = v_who;
        if found and a.device <> p_device and not exam_private.can_move(a) then
          v_exam := 'elsewhere';
        else
          perform exam_private.claim_attempt(e.id, v_who, p_device);
          -- The page sends the draft only when it changed since the last one that got through.
          if jsonb_typeof(p_draft) = 'object' and length(p_draft::text) <= 1000000 then
            update exam_private.attempts set draft = p_draft, draft_at = now() where exam_id = e.id and who = v_who;
          end if;
          v_questions := exam_private.take_questions(e, v_who);
          select paper into v_paper from exam_private.attempts where exam_id = e.id and who = v_who;
          v_exam := 'ok';
          if x.token_hash is not null and x.device is not distinct from p_device then
            update exam_private.sessions set ends_at = greatest(coalesce(ends_at, now()), exam_private.who_end(e, v_who) + interval '15 minutes'),
                expires_at = greatest(coalesce(ends_at, now()), exam_private.who_end(e, v_who) + interval '15 minutes')
              where token_hash = x.token_hash;
          end if;
        end if;
      end if;
    end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('signed_in', x.token_hash is not null and x.kind = 'student' and x.device is not distinct from p_device,
    'exam', v_exam,
    -- Until when the Student ID sign-in lasts now, for the page to keep it as long.
    'session_until', case when x.token_hash is not null and x.kind = 'student' and x.device is not distinct from p_device
      then (select y.expires_at from exam_private.sessions y where y.token_hash = x.token_hash) end,
    'ends_at', case when v_exam = 'ok' then exam_private.who_end(e, v_who) end,
    'version', case when v_exam = 'ok' then exam_private.questions_version(v_questions) end,
    'paper', v_paper,
    -- The server's clock: the page times the exam by it, whatever the computer's clock says.
    'server_now', now()));
end $$;

-- The caller's courses, each with its listed exams: current ones first, then archived (past)
-- ones, newest first, whose grades stay visible but whose exams cannot be started.
create or replace function public.exam_dashboard(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform exam_private.finalize_course(s.sheet_name, s.is_archive) from exam_private.my_students(p_token) s;
  return jsonb_build_object(
    'email', exam_private.my_email(p_token),
    'signed_in_by', case when teaching_private.email() is not null then 'google'
      when exists (select 1 from exam_private.my_students(p_token)) then 'student_id' end,
    -- The one exam a Student ID sign-in opens (the one whose password it was made with).
    'signed_in_exam', (select x.exam_id from exam_private.sessions x where x.token_hash = exam_private.token_hash(p_token)
      and x.kind = 'student' and x.expires_at > now()),
    'server_now', now(),
    'courses', coalesce((select jsonb_agg(jsonb_build_object(
        'sheet_name', s.sheet_name,
        'archived', s.is_archive,
        'code', exam_private.course_meta(s.sheet_name, s.is_archive, 'code'),
        'title', exam_private.course_meta(s.sheet_name, s.is_archive, 'title'),
        'semester', exam_private.course_meta(s.sheet_name, s.is_archive, 'semester'),
        'year', exam_private.course_meta(s.sheet_name, s.is_archive, 'year'),
        'colours', exam_private.course_meta(s.sheet_name, s.is_archive, 'theme_colours'),
        'student', jsonb_build_object('name', s.full_name, 'student_no', s.student_no, 'group', nullif(s.group_name, '')),
        -- Each exam at the student's own sitting's time (with sittings).
        'exams', coalesce((select jsonb_agg(exam_private.summary_for(e, exam_private.student_sitting(e, s)) || jsonb_build_object(
            'submitted_at', case when sub.source <> 'manual' then sub.submitted_at end, 'status', sub.status, 'late', sub.late,
            'source', sub.source,
            'score', case when e.results_published then sub.grades->'totalScore' end,
            'max_score', case when e.results_published then sub.grades->'maxScore' end,
            -- Handed back by the lecturer: the student can carry on while it is open.
            'returned', sub.id is null and exists (select 1 from exam_private.attempts a where a.exam_id = e.id
              and a.who = exam_private.student_key(s) and a.returned_at is not null),
            -- Handed back as a new paper, not begun yet: new questions, the old answers gone.
            'new_paper', sub.id is null and exists (select 1 from exam_private.attempts a where a.exam_id = e.id
              and a.who = exam_private.student_key(s) and a.returned_at is not null and a.paper > 0 and a.draft is null),
            -- Begun and not submitted (on another computer, say): Start carries on where it was.
            'started', sub.id is null and exists (select 1 from exam_private.attempts a where a.exam_id = e.id
              and a.who = exam_private.student_key(s)),
            'password_entered', exam_private.signed_in_for(e.id, p_token))
            order by e.starts_at nulls last, e.created_at)
          from exam_private.exams e
          left join exam_private.submissions sub on sub.exam_id = e.id and sub.exam_code is null
            and (sub.student_id = s.id or sub.student_no = exam_private.student_key(s))
          where e.sheet_name = s.sheet_name and e.is_archive = s.is_archive and e.visible
            and (exam_private.takes_exam(e, s) or sub.id is not null)), '[]'::jsonb))
        order by s.is_archive, exam_private.course_meta(s.sheet_name, s.is_archive, 'year') desc nulls last,
          exam_private.course_meta(s.sheet_name, s.is_archive, 'code'))
      from exam_private.my_students(p_token) s), '[]'::jsonb));
end $$;

-- Starts a named exam: on the class list and signed in as the exam asks, open now, password
-- if set (unless the student signed in with it), not yet submitted, and not live on another
-- device. Comes with the draft when another device had started it (a crashed computer). With
-- sittings, only in the student's own (hint group_time:<group>|<start>, in another's).
create or replace function public.exam_start(p_exam_id uuid, p_token text, p_password text, p_device text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students; a exam_private.attempts; v_questions jsonb; v_sitting text;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or not e.visible then raise exception 'This exam is not available'; end if;
  if e.sign_in = 'anonymous' then raise exception 'Sign in with your exam ID for this exam'; end if;
  if e.is_archive then raise exception 'This course is archived: its exams are closed'; end if;
  s := exam_private.exam_student(e, p_token);
  -- One group's only: the others can't start it (one moved out of it after starting carries on).
  if not exam_private.takes_exam(e, s) and not exists (select 1 from exam_private.attempts t where t.exam_id = e.id and t.who = exam_private.student_key(s)) then
    raise exception 'This exam is only for %, and you are not in it. If that is wrong, ask your lecturer.', exam_private.group_label(e.group_plan->>'only');
  end if;
  v_sitting := exam_private.student_sitting(e, s);
  if not exam_private.is_open_for(e, v_sitting) then
    if exam_private.has_sittings(e) and exam_private.is_open(e) then
      raise exception 'Another group is taking this exam now: yours (%) takes it at its own time', v_sitting
        using errcode = 'P0001', hint = 'group_time:' || v_sitting || '|' || to_char(exam_private.sitting_start(e, v_sitting) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    end if;
    raise exception 'This exam is not open now';
  end if;
  if e.password_hash is not null and not exam_private.signed_in_for(e.id, p_token)
      and e.password_hash <> extensions.crypt(coalesce(p_password, ''), e.password_hash) then
    perform pg_sleep(0.5);
    raise exception 'The exam password is incorrect' using errcode = '28P01';
  end if;
  if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code is null and source <> 'manual'
      and (student_id = s.id or student_no = exam_private.student_key(s))) then
    raise exception 'You have already submitted this exam'; end if;
  a := exam_private.claim_attempt(e.id, exam_private.student_key(s), p_device);
  v_questions := exam_private.take_questions(e, exam_private.student_key(s));
  return exam_private.summary_for(e, v_sitting) || jsonb_build_object('questions', exam_private.student_questions(v_questions),
    'version', exam_private.questions_version(v_questions),
    'student', jsonb_build_object('name', s.full_name, 'email', s.email, 'student_no', s.student_no),
    'draft', a.draft, 'draft_at', a.draft_at, 'returned', a.returned_at is not null,
    'seed', exam_private.paper_seed(e.id, exam_private.student_key(s)), 'paper', a.paper,
    'submit_key', exam_private.new_submit_key(e.id, exam_private.student_key(s)), 'server_now', now());
end $$;

-- A new submit key for an attempt (only its hash is kept): the device that started the exam
-- can submit it with this until a day after the end, signed in or not.
create or replace function exam_private.new_submit_key(p_exam uuid, p_who text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_key text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  update exam_private.attempts set submit_key_hash = exam_private.token_hash(v_key) where exam_id = p_exam and who = p_who;
  return v_key;
end $$;
revoke all on function exam_private.new_submit_key(uuid, text) from public, anon, authenticated;

-- The exam in progress as it is now, for the device taking it (after a reload, or when its
-- questions or time changed): the questions, the end and a new submit key. Only once the
-- student has started it (so no password again), until it stops taking answers.
create or replace function public.exam_current(p_exam_id uuid, p_token text, p_device text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students; v_who text; v_code text; v_questions jsonb;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or not e.visible or e.is_archive then raise exception 'This exam is not available'; end if;
  if e.sign_in = 'anonymous' then
    select x.exam_code into v_code from exam_private.sessions x where x.token_hash = exam_private.token_hash(p_token)
      and x.kind = 'anonymous' and x.exam_id = e.id and x.expires_at > now();
    if v_code is null then raise exception 'Your exam session has expired' using errcode = '42501'; end if;
    v_who := 'code:' || v_code;
  else
    s := exam_private.exam_student(e, p_token);
    v_who := exam_private.student_key(s);
  end if;
  if not exists (select 1 from exam_private.attempts where exam_id = e.id and who = v_who) then
    raise exception 'Start the exam from your dashboard'; end if;
  if exists (select 1 from exam_private.submissions u where u.exam_id = e.id and u.source <> 'manual'
      and case when v_code is not null then u.exam_code = v_code else u.exam_code is null and u.student_no = v_who end) then
    raise exception 'You have already submitted this exam'; end if;
  if exam_private.who_start(e, v_who) is null or now() < exam_private.who_start(e, v_who) or now() > exam_private.who_end(e, v_who) + interval '10 minutes' then
    raise exception 'This exam is not taking answers now'; end if;
  perform exam_private.claim_attempt(e.id, v_who, p_device);
  v_questions := exam_private.take_questions(e, v_who);
  return exam_private.summary_for(e, exam_private.who_sitting(e, v_who)) || jsonb_build_object('questions', exam_private.student_questions(v_questions),
    'version', exam_private.questions_version(v_questions), 'submit_key', exam_private.new_submit_key(e.id, v_who),
    'server_now', now());
end $$;

-- Taken until 10 minutes after the end, and marked late a minute after it. Answers kept on
-- the device while the connection was gone are taken until a day after the end, with how they
-- arrived (exam_private.late_delivery) for the lecturer to judge. With the attempt's submit
-- key, the sign-in may have ended meanwhile. Answers given to an older version of the questions
-- (p_submission.question_ids) move to the questions' places now. A student the lecturer gave a
-- grade without a submission takes its place.
create or replace function public.exam_submit(p_exam_id uuid, p_token text, p_submission jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students; a exam_private.attempts; prev exam_private.attempts;
  v_existing exam_private.submissions; v_msg text; v_answers jsonb; v_late boolean; v_draws jsonb; v_questions jsonb;
  v_start timestamptz; v_end timestamptz;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or e.sign_in = 'anonymous' then raise exception 'This exam is not available'; end if;
  if e.is_archive then raise exception 'This course is archived: its exams are closed'; end if;
  begin
    s := exam_private.exam_student(e, p_token);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    select st.* into s from exam_private.attempts x
      join exam_private.students st on st.sheet_name = e.sheet_name and st.is_archive = e.is_archive and exam_private.student_key(st) = x.who
    where x.exam_id = e.id and x.submit_key_hash is not null and x.submit_key_hash = exam_private.token_hash(p_submission->>'submit_key')
    limit 1;
    if not found then raise exception '%', v_msg using errcode = '42501'; end if;
  end;
  -- Their own sitting's time (the exam's, without sittings).
  v_start := exam_private.who_start(e, exam_private.student_key(s));
  v_end := exam_private.who_end(e, exam_private.student_key(s));
  if v_end is null or now() < v_start then raise exception 'This exam is not open'; end if;
  if now() > v_end + interval '1 day' then
    raise exception 'This exam has closed. Keep your backup file and contact your lecturer.'; end if;
  select * into v_existing from exam_private.submissions where exam_id = e.id and exam_code is null
    and (student_id = s.id or student_no = exam_private.student_key(s)) limit 1;
  if v_existing.id is not null and v_existing.source <> 'manual' and not exam_private.replaceable(v_existing) then
    raise exception 'You have already submitted this exam'; end if;
  if now() > v_end + interval '10 minutes' and not exists (select 1 from exam_private.attempts
      where exam_id = e.id and who = exam_private.student_key(s)) then
    raise exception 'This exam has closed. Keep your backup file and contact your lecturer.'; end if;
  select * into prev from exam_private.attempts where exam_id = e.id and who = exam_private.student_key(s);
  a := exam_private.claim_attempt(e.id, exam_private.student_key(s), p_submission->>'device');
  -- With pool items: the questions as the student last had them (their attempt's draws).
  v_draws := case when exam_private.has_pool(e.questions) then coalesce(a.draws, exam_private.draws_for(e, exam_private.student_key(s), null)) end;
  v_questions := exam_private.drawn_questions(e.questions, v_draws);
  v_answers := exam_private.remap_answers(coalesce(p_submission->'answers', '{}'::jsonb), p_submission->'question_ids', v_questions);
  v_late := now() > v_end + interval '1 minute';
  if v_existing.id is not null then
    update exam_private.submissions set answers = v_answers, fingerprint = coalesce(p_submission->'fingerprint', '{}'::jsonb),
        activity = case when jsonb_typeof(p_submission->'activity') = 'object' then p_submission->'activity' else '{}'::jsonb end,
        network = a.network, auto_submitted = coalesce((p_submission->>'auto_submitted')::boolean, false), late = v_late,
        source = 'online', status = 'submitted', submitted_at = now(), draws = v_draws,
        delivery = case when v_late then exam_private.late_delivery(prev, p_submission, v_questions) end
      where id = v_existing.id;
  else
    insert into exam_private.submissions (exam_id, student_id, student_no, student_name, student_email,
        answers, fingerprint, activity, network, auto_submitted, late, delivery, draws)
      values (e.id, s.id, exam_private.student_key(s), s.full_name, s.email, v_answers,
        coalesce(p_submission->'fingerprint', '{}'::jsonb),
        case when jsonb_typeof(p_submission->'activity') = 'object' then p_submission->'activity' else '{}'::jsonb end,
        a.network, coalesce((p_submission->>'auto_submitted')::boolean, false), v_late,
        case when v_late then exam_private.late_delivery(prev, p_submission, v_questions) end, v_draws);
  end if;
  update exam_private.attempts set submit_key_hash = null where exam_id = e.id and who = exam_private.student_key(s);
  return jsonb_build_object('submitted_at', now());
exception when unique_violation then
  raise exception 'You have already submitted this exam';
end $$;

-- While taking an exam: the images its questions show. Signed in as the exam asks (or with
-- the anonymous exam's session), from its start until it stops taking answers.
create or replace function public.exam_images(p_exam_id uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e exam_private.exams; v_who text;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or not e.visible or e.is_archive then raise exception 'This exam is not available'; end if;
  if e.sign_in = 'anonymous' then
    select 'code:' || x.exam_code into v_who from exam_private.sessions x where x.token_hash = exam_private.token_hash(p_token)
      and x.kind = 'anonymous' and x.exam_id = e.id and x.expires_at > now();
    if v_who is null then raise exception 'Your exam session has expired' using errcode = '42501'; end if;
  else
    v_who := exam_private.student_key(exam_private.exam_student(e, p_token));
  end if;
  if exam_private.who_start(e, v_who) is null or now() < exam_private.who_start(e, v_who) or now() > exam_private.who_end(e, v_who) + interval '10 minutes' then
    raise exception 'This exam is not open now'; end if;
  return exam_private.images_for(e.sheet_name, e.is_archive, exam_private.taken_questions(e, v_who));
end $$;

-- A file answer: checks that the student may upload it now (signed in as the exam asks, or
-- with the anonymous exam's session; the exam taking answers; not submitted yet; a file
-- question; an allowed type and size), and says where it goes in the exam-uploads bucket.
-- The Storage policy then lets that one file in for an hour.
create or replace function public.exam_upload_start(p_exam_id uuid, p_token text, p_question integer, p_name text, p_size bigint,
  p_device text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students; q jsonb; v_key text; v_code text; v_ext text; v_max numeric;
  v_name text := btrim(coalesce(p_name, '')); v_id uuid := gen_random_uuid(); v_path text;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or not e.visible or e.is_archive then raise exception 'This exam is not available'; end if;
  if e.sign_in = 'anonymous' then
    select x.exam_code into v_code from exam_private.sessions x where x.token_hash = exam_private.token_hash(p_token)
      and x.kind = 'anonymous' and x.exam_id = e.id and x.expires_at > now();
    if v_code is null then raise exception 'Your exam session has expired' using errcode = '42501'; end if;
    if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code = v_code and source <> 'manual') then
      raise exception 'This exam ID has already submitted the exam'; end if;
  else
    s := exam_private.exam_student(e, p_token);
    v_key := exam_private.student_key(s);
    if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code is null and source <> 'manual'
        and (student_id = s.id or student_no = v_key)) then
      raise exception 'You have already submitted this exam'; end if;
  end if;
  if exam_private.who_start(e, coalesce(v_key, 'code:' || v_code)) is null or now() < exam_private.who_start(e, coalesce(v_key, 'code:' || v_code))
     or now() > exam_private.who_end(e, coalesce(v_key, 'code:' || v_code)) + interval '10 minutes' then
    raise exception 'This exam is not taking answers now'; end if;
  perform exam_private.claim_attempt(e.id, coalesce(v_key, 'code:' || v_code), p_device);
  q := case when p_question >= 1 then exam_private.take_questions(e, coalesce(v_key, 'code:' || v_code)) -> (p_question - 1) end;
  if q is null or q->>'type' is distinct from 'attachment' then raise exception 'This question takes no file'; end if;
  if v_name = '' or length(v_name) > 200 then raise exception 'The file needs a name of at most 200 characters'; end if;
  v_ext := lower(coalesce(substring(v_name from '(\.[^.]+)$'), ''));
  if jsonb_typeof(q->'allowed_types') = 'array' and jsonb_array_length(q->'allowed_types') > 0
     and not exists (select 1 from jsonb_array_elements_text(q->'allowed_types') t(v) where lower(t.v) = v_ext) then
    raise exception 'This question takes only % files',
      (select string_agg(t.v, ', ') from jsonb_array_elements_text(q->'allowed_types') t(v));
  end if;
  v_max := least(50, coalesce(case when jsonb_typeof(q->'max_size_mb') = 'number' then (q->>'max_size_mb')::numeric end, 50));
  if p_size is null or p_size <= 0 then raise exception 'This file is empty'; end if;
  if p_size > v_max * 1048576 then raise exception 'This file is too large: at most % MB', v_max; end if;
  if (select count(*) from exam_private.uploads u where u.exam_id = e.id and u.question = p_question
      and (u.student_key = v_key or u.exam_code = v_code)) >= 20 then
    raise exception 'Too many uploads for this question: ask your lecturer'; end if;
  v_path := e.id || '/' || v_id || '/' || coalesce(nullif(left(regexp_replace(v_name, '[^A-Za-z0-9._-]+', '_', 'g'), 100), ''), 'file');
  insert into exam_private.uploads (id, exam_id, student_key, exam_code, question, file_name, size_bytes, path)
    values (v_id, e.id, v_key, v_code, p_question, v_name, p_size, v_path);
  return jsonb_build_object('id', v_id, 'bucket', 'exam-uploads', 'path', v_path);
end $$;

-- Storage policy (exam-uploads, insert): a path exam_upload_start handed out in the last
-- hour, while its exam still takes answers. A path takes one file (uploads never overwrite).
create or replace function public.exam_upload_allowed(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from exam_private.uploads u join exam_private.exams e on e.id = u.exam_id
    where u.path = p_path and u.created_at > now() - interval '1 hour'
      and now() <= exam_private.ends_at(e) + interval '10 minutes')
$$;

-- Storage policies (exam-uploads, read and delete): the caller's access to the exam the file
-- was uploaded for, 'manage' (lecturers and admins) or 'grade' (assistants), else null.
create or replace function public.exam_upload_access(p_path text) returns text
language sql stable security definer set search_path = '' as $$
  select exam_private.course_access(e.sheet_name, e.is_archive)
  from exam_private.uploads u join exam_private.exams e on e.id = u.exam_id where u.path = p_path
$$;

-- A named exam's result, once the lecturer publishes results: the grade and the feedback.
create or replace function public.exam_my_result(p_exam_id uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students; sub exam_private.submissions;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or not e.visible then raise exception 'This exam is not available'; end if;
  select m.* into s from exam_private.my_students(p_token) m
    where m.sheet_name = e.sheet_name and m.is_archive = e.is_archive limit 1;
  if not found then raise exception 'You are not on this course''s class list' using errcode = '42501'; end if;
  if not e.results_published then raise exception 'Results are not published yet'; end if;
  select * into sub from exam_private.submissions where exam_id = e.id and exam_code is null
    and (student_id = s.id or student_no = exam_private.student_key(s)) limit 1;
  -- The grade and the lecturer's feedback only: the questions, the answers and each question's
  -- points are not sent (they stay confidential; students see them with the lecturer).
  return exam_private.exam_summary(e) || jsonb_build_object(
    'submission', case when sub.id is null then null else jsonb_build_object('submitted_at', sub.submitted_at,
      'grades', case when sub.grades is null then null else jsonb_strip_nulls(jsonb_build_object(
        'totalScore', sub.grades->'totalScore', 'maxScore', sub.grades->'maxScore', 'feedback', sub.grades->'feedback')) end,
      'status', sub.status, 'source', sub.source) end);
end $$;

-- ── Anonymous exams: exam ID + exam password, with no student identity ──

-- Starts an anonymous exam: one device at a time per exam ID, with the draft another device
-- left (a crashed computer), or the answers the lecturer handed back.
-- With sittings, an exam ID takes the sitting open when it first starts, and only that one.
create or replace function public.exam_anonymous_start(p_code text, p_password text, p_device text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; v_code text := btrim(coalesce(p_code, '')); token text; a exam_private.attempts; v_questions jsonb;
  v_sitting text;
begin
  select x.* into e from exam_private.exams x
  where x.sign_in = 'anonymous' and not x.is_archive and exam_private.is_open(x) and x.password_hash is not null
    and x.password_hash = extensions.crypt(coalesce(p_password, ''), x.password_hash)
    and exists (select 1 from exam_private.exam_codes c
      where c.sheet_name = x.sheet_name and c.is_archive = x.is_archive and c.code = v_code)
  order by x.starts_at desc limit 1;
  if not found then
    perform pg_sleep(0.5);
    raise exception 'Exam ID or password is incorrect, or the exam is not open' using errcode = '28P01';
  end if;
  if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code = v_code and source <> 'manual') then
    raise exception 'This exam ID has already submitted the exam'; end if;
  a := exam_private.claim_attempt(e.id, 'code:' || v_code, p_device);
  if exam_private.has_sittings(e) then
    update exam_private.attempts set grp = coalesce(grp, exam_private.open_sitting(e)) where exam_id = e.id and who = 'code:' || v_code;
    v_sitting := exam_private.who_sitting(e, 'code:' || v_code);
    if not exam_private.is_open_for(e, v_sitting) then
      raise exception 'This exam ID started the exam with another group, whose time is over' using errcode = 'P0001', hint = 'group_over:' || v_sitting;
    end if;
  else
    v_sitting := '';
  end if;
  token := exam_private.open_session('anonymous', null, e.id, v_code, exam_private.sitting_end(e, v_sitting) + interval '15 minutes', p_device);
  v_questions := exam_private.take_questions(e, 'code:' || v_code);
  return exam_private.summary_for(e, v_sitting) || jsonb_build_object('questions', exam_private.student_questions(v_questions),
    'version', exam_private.questions_version(v_questions),
    'token', token, 'exam_code', v_code, 'draft', a.draft, 'draft_at', a.draft_at, 'returned', a.returned_at is not null,
    'seed', exam_private.paper_seed(e.id, 'code:' || v_code), 'paper', a.paper,
    'submit_key', exam_private.new_submit_key(e.id, 'code:' || v_code), 'server_now', now());
end $$;

-- As exam_submit, for an exam ID: with the exam's session, or once that has ended (answers kept
-- on the device while offline) with the attempt's submit key and p_submission.exam_id.
create or replace function public.exam_anonymous_submit(p_token text, p_submission jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare x exam_private.sessions; e exam_private.exams; a exam_private.attempts; prev exam_private.attempts; v_code text;
  v_existing exam_private.submissions; v_answers jsonb; v_late boolean; v_draws jsonb; v_questions jsonb; v_end timestamptz;
begin
  select * into x from exam_private.sessions
    where token_hash = exam_private.token_hash(p_token) and kind = 'anonymous' and expires_at > now();
  if found then
    v_code := x.exam_code;
    select * into e from exam_private.exams where id = x.exam_id;
  else
    select at.* into prev from exam_private.attempts at
      where at.exam_id = case when p_submission->>'exam_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (p_submission->>'exam_id')::uuid end
        and at.who like 'code:%' and at.submit_key_hash is not null
        and at.submit_key_hash = exam_private.token_hash(p_submission->>'submit_key');
    if not found then raise exception 'Your exam session has expired. Keep your backup file and contact your lecturer.'; end if;
    v_code := substr(prev.who, 6);
    select * into e from exam_private.exams where id = prev.exam_id;
  end if;
  select * into v_existing from exam_private.submissions where exam_id = e.id and exam_code = v_code;
  if v_existing.id is not null and v_existing.source <> 'manual' and not exam_private.replaceable(v_existing) then
    raise exception 'This exam ID has already submitted the exam'; end if;
  v_end := exam_private.who_end(e, 'code:' || v_code);
  if now() > v_end + interval '1 day' then
    raise exception 'This exam has closed. Keep your backup file and contact your lecturer.'; end if;
  select * into prev from exam_private.attempts where exam_id = e.id and who = 'code:' || v_code;
  a := exam_private.claim_attempt(e.id, 'code:' || v_code, p_submission->>'device');
  v_draws := case when exam_private.has_pool(e.questions) then coalesce(a.draws, exam_private.draws_for(e, 'code:' || v_code, null)) end;
  v_questions := exam_private.drawn_questions(e.questions, v_draws);
  v_answers := exam_private.remap_answers(coalesce(p_submission->'answers', '{}'::jsonb), p_submission->'question_ids', v_questions);
  v_late := now() > v_end + interval '1 minute';
  if v_existing.id is not null then
    update exam_private.submissions set answers = v_answers, fingerprint = coalesce(p_submission->'fingerprint', '{}'::jsonb),
        activity = case when jsonb_typeof(p_submission->'activity') = 'object' then p_submission->'activity' else '{}'::jsonb end,
        network = a.network, auto_submitted = coalesce((p_submission->>'auto_submitted')::boolean, false), late = v_late,
        source = 'online', status = 'submitted', submitted_at = now(), draws = v_draws,
        delivery = case when v_late then exam_private.late_delivery(prev, p_submission, v_questions) end
      where id = v_existing.id;
  else
    insert into exam_private.submissions (exam_id, exam_code, answers, fingerprint, activity, network, auto_submitted, late, delivery, draws)
      values (e.id, v_code, v_answers, coalesce(p_submission->'fingerprint', '{}'::jsonb),
        case when jsonb_typeof(p_submission->'activity') = 'object' then p_submission->'activity' else '{}'::jsonb end,
        a.network, coalesce((p_submission->>'auto_submitted')::boolean, false), v_late,
        case when v_late then exam_private.late_delivery(prev, p_submission, v_questions) end, v_draws);
  end if;
  update exam_private.attempts set submit_key_hash = null where exam_id = e.id and who = 'code:' || v_code;
  if x.token_hash is not null then delete from exam_private.sessions where token_hash = x.token_hash; end if;
  return jsonb_build_object('submitted_at', now());
exception when unique_violation then
  raise exception 'This exam ID has already submitted the exam';
end $$;

-- ── Public course pages: the schedule of listed exams ──

create or replace function public.exam_schedule(p_sheet text, p_archive boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('label', e.label, 'type', e.type, 'starts_at', e.starts_at,
    'duration_minutes', e.duration_minutes, 'hall', e.hall, 'weight', e.weight, 'sign_in', e.sign_in,
    'has_questions', jsonb_array_length(e.questions) > 0, 'date_only', exam_private.clean_settings(e.settings)->'date_only',
    -- With sittings: each group's time and hall, and the last one's end.
    'ends_at', exam_private.ends_at(e), 'sittings', case when exam_private.has_sittings(e) then exam_private.sittings(e) end,
    'for_group', nullif(e.group_plan->>'only', ''))
    order by e.starts_at nulls last, e.created_at), '[]'::jsonb)
  from exam_private.exams e where e.sheet_name = p_sheet and e.is_archive = p_archive and e.visible
$$;

-- ── Grants: lecturer functions need a session; student and public ones work without ──
do $$
declare f text;
begin
  foreach f in array array[
    'exam_course(text, boolean)', 'exam_save_students(text, boolean, jsonb, uuid[])',
    'exam_save_codes(text, boolean, text[])',
    'exam_save_exam(text, boolean, jsonb, text)', 'exam_set_exam_flags(uuid, boolean, boolean)',
    'exam_delete_exam(uuid)', 'exam_submissions(uuid)', 'exam_save_grades(uuid, jsonb, text)',
    'exam_update_answer_keys(uuid, jsonb)', 'exam_delete_submission(uuid)', 'exam_move_course(text, boolean, text)', 'exam_delete_course(text, boolean)',
    'exam_save_questions(uuid, jsonb)', 'exam_grading_links(text, boolean)', 'exam_rename_grading_keys(text, boolean, jsonb)',
    'exam_check_students(text, boolean, jsonb)', 'exam_add_image(text, boolean, text, text)', 'exam_get_images(uuid)',
    'exam_upload_paths(uuid)', 'exam_upload_access(text)', 'exam_attempts(uuid)', 'exam_allow_move(uuid, text)', 'exam_return_submission(uuid)', 'exam_return_new_paper(uuid)',
    'exam_add_submission(uuid, uuid, text, jsonb)', 'exam_gradebook(text, boolean)', 'exam_student_record(uuid)',
    'exam_pool(text, boolean)', 'exam_pool_images(text, boolean)', 'exam_save_pool(text, boolean, jsonb)',
    'exam_link_pool(text, boolean, text[], text)', 'exam_set_groups(text, boolean, jsonb)', 'exam_group_sources(text, boolean)',
    'exam_copy_groups(text, boolean, text, boolean)', 'exam_set_move(uuid, uuid, text)',
    'exam_time_clashes(text, boolean, uuid, timestamptz, integer, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'exam_student_sign_in(text, text, text)', 'exam_sign_out(text, text)', 'exam_dashboard(text)',
    'exam_start(uuid, text, text, text)', 'exam_submit(uuid, text, jsonb)', 'exam_my_result(uuid, text)',
    'exam_anonymous_start(text, text, text)', 'exam_anonymous_submit(text, jsonb)', 'exam_current(uuid, text, text)',
    'exam_schedule(text, boolean)', 'exam_images(uuid, text)',
    'exam_upload_start(uuid, text, integer, text, bigint, text)', 'exam_upload_allowed(text)',
    'exam_heartbeat(text, text, uuid, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

-- ── Storage: the exam-uploads bucket ──
-- Students upload a file answer to the path exam_upload_start gave them (with no session for
-- anonymous exams and Student ID sign-ins, so anon too). Lecturers, admins and assistants of
-- the exam's course download the files; lecturers and admins delete them.
drop policy if exists "Exam uploads: students upload their answers" on storage.objects;
create policy "Exam uploads: students upload their answers" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'exam-uploads' and public.exam_upload_allowed(name));
drop policy if exists "Exam uploads: the course's lecturers and assistants read" on storage.objects;
create policy "Exam uploads: the course's lecturers and assistants read" on storage.objects
  for select to authenticated
  using (bucket_id = 'exam-uploads' and public.exam_upload_access(name) is not null);
drop policy if exists "Exam uploads: the course's lecturers delete" on storage.objects;
create policy "Exam uploads: the course's lecturers delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'exam-uploads' and public.exam_upload_access(name) = 'manage');
