-- 2 of 2: run in the Supabase SQL editor after 1-schema.sql. Safe to run again (after an
-- update, for instance): it brings the tables up to date and replaces the functions.
-- Exams: the public.exam_* functions the course editor and /exam/ call.
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

-- The class-list row taking or submitting a named exam, signed in the way the exam asks for.
create or replace function exam_private.exam_student(e exam_private.exams, p_token text) returns exam_private.students
language plpgsql stable security definer set search_path = '' as $$
declare s exam_private.students;
begin
  select m.* into s from exam_private.my_students(p_token) m
    where m.sheet_name = e.sheet_name and m.is_archive = e.is_archive
      and case e.sign_in
        when 'google' then teaching_private.email() is not null and m.email = teaching_private.email()
        when 'student_id' then m.id = (select x.student_id from exam_private.sessions x
          where x.token_hash = exam_private.token_hash(p_token) and x.kind = 'student' and x.expires_at > now())
        else false end
    limit 1;
  if found then return s; end if;
  if exists (select 1 from exam_private.my_students(p_token) m where m.sheet_name = e.sheet_name and m.is_archive = e.is_archive) then
    if e.sign_in = 'google' then
      raise exception 'This exam needs your Google account: sign out, then sign in with Google' using errcode = '42501';
    end if;
    raise exception 'This exam needs your student ID: sign out, then sign in with your student ID and the exam password' using errcode = '42501';
  end if;
  raise exception 'You are not on this course''s class list' using errcode = '42501';
end $$;
revoke all on function exam_private.exam_student(exam_private.exams, text) from public, anon, authenticated;

-- Questions as students receive them while taking an exam: without anything that gives the
-- answer away (correct options, accepted answers, numeric answers, explanations).
create or replace function exam_private.student_questions(p_questions jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(q - array['correct_answers', 'accepted_answers', 'answer', 'tolerance', 'explanation'] order by ord), '[]'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as t(q, ord)
$$;
revoke all on function exam_private.student_questions(jsonb) from public, anon, authenticated;

-- ── Lecturers, admins and TAs (course editor: Exams and Students tabs) ──

-- Everything the two tabs show for one course offering.
create or replace function public.exam_course(p_sheet text, p_archive boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a text := exam_private.require_access(p_sheet, p_archive, false);
begin
  return jsonb_build_object(
    'access', a,
    'students', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'student_no', s.student_no,
        'full_name', s.full_name, 'email', s.email, 'programme', s.programme, 'exam_code', s.exam_code, 'note', s.note)
        order by s.list_order, s.full_name)
      from exam_private.students s where s.sheet_name = p_sheet and s.is_archive = p_archive), '[]'::jsonb),
    'codes', coalesce((select jsonb_agg(c.code order by c.list_order, c.code) from exam_private.exam_codes c
      where c.sheet_name = p_sheet and c.is_archive = p_archive), '[]'::jsonb),
    'exams', coalesce((select jsonb_agg((to_jsonb(e) - 'password_hash' - 'sheet_name' - 'is_archive') || jsonb_build_object(
        'has_password', e.password_hash is not null, 'ends_at', exam_private.ends_at(e), 'is_open', exam_private.is_open(e),
        'submission_count', (select count(*) from exam_private.submissions s where s.exam_id = e.id),
        'graded_count', (select count(*) from exam_private.submissions s where s.exam_id = e.id and s.status = 'graded'))
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
-- sets every field as given. A pasted row (no id) is matched by student ID, else by email;
-- it keeps the stored student ID, programme and exam ID where the paste has none (or takes the
-- student ID another course has for that email), and is added when nobody matches. Rows whose
-- student ID or email disagree with another course are refused, all together.
create or replace function public.exam_save_students(p_sheet text, p_archive boolean, p_students jsonb, p_remove uuid[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare x jsonb; ord bigint; v_id uuid; v_edit boolean; v_no text; v_email text; v_name text;
  v_programme text; v_code text; v_conflicts text[] := '{}';
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
        order by (v_no <> '' and s.student_no = v_no) desc limit 1;
    end if;
    if v_id is null then
      insert into exam_private.students (sheet_name, is_archive, student_no, full_name, email, programme, exam_code, note, list_order)
        values (p_sheet, p_archive, v_no, v_name, v_email, v_programme, v_code, btrim(coalesce(x->>'note', '')), ord);
    else
      update exam_private.students s set
        full_name = v_name, email = v_email,
        student_no = case when v_edit or v_no <> '' then v_no else s.student_no end,
        programme = case when v_edit or v_programme <> '' then v_programme else s.programme end,
        exam_code = case when v_edit or v_code <> '' then v_code else s.exam_code end,
        note = btrim(coalesce(x->>'note', '')), list_order = ord, updated_at = now()
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
create or replace function public.exam_save_exam(p_sheet text, p_archive boolean, p_exam jsonb, p_password text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid := nullif(p_exam->>'id', '')::uuid;
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if v_id is not null and not exists (select 1 from exam_private.exams
      where id = v_id and sheet_name = p_sheet and is_archive = p_archive) then
    raise exception 'This exam no longer exists'; end if;
  if v_id is null then
    insert into exam_private.exams (sheet_name, is_archive, type)
      values (p_sheet, p_archive, coalesce(p_exam->>'type', 'quiz')) returning id into v_id;
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
    questions = case when jsonb_typeof(p_exam->'questions') = 'array' then p_exam->'questions' else questions end,
    visible = coalesce((p_exam->>'visible')::boolean, false),
    results_published = coalesce((p_exam->>'results_published')::boolean, false),
    password_hash = case when p_password is null then password_hash when btrim(p_password) = '' then null
      else extensions.crypt(p_password, extensions.gen_salt('bf', 8)) end,
    updated_at = now()
  where id = v_id;
  return v_id;
end $$;

-- The questions editor: replaces an exam's questions.
create or replace function public.exam_save_questions(p_id uuid, p_questions jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  if jsonb_typeof(p_questions) is distinct from 'array' then raise exception 'Invalid questions'; end if;
  update exam_private.exams set questions = p_questions, updated_at = now() where id = p_id;
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
end $$;

create or replace function public.exam_submissions(p_exam_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found then raise exception 'This exam no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, false);
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'student_no', s.student_no,
      'student_name', s.student_name, 'student_email', s.student_email, 'exam_code', s.exam_code,
      'submitted_at', s.submitted_at, 'answers', s.answers, 'fingerprint', s.fingerprint,
      'auto_submitted', s.auto_submitted, 'late', s.late, 'status', s.status, 'grades', s.grades,
      'graded_at', s.graded_at) order by s.submitted_at)
    from exam_private.submissions s where s.exam_id = p_exam_id), '[]'::jsonb);
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

create or replace function public.exam_delete_submission(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  select x.* into e from exam_private.exams x join exam_private.submissions s on s.exam_id = x.id where s.id = p_id;
  if not found then raise exception 'This submission no longer exists'; end if;
  perform exam_private.require_access(e.sheet_name, e.is_archive, true);
  delete from exam_private.submissions where id = p_id;
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
     and not exists (select 1 from exam_private.exam_codes where sheet_name = p_name and is_archive = p_from_archive) then
    return; -- nothing to move (or already moved)
  end if;
  delete from exam_private.students where sheet_name = p_new_name and is_archive = not p_from_archive;
  delete from exam_private.exam_codes where sheet_name = p_new_name and is_archive = not p_from_archive;
  delete from exam_private.exams where sheet_name = p_new_name and is_archive = not p_from_archive;
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
end $$;

-- ── Students (/exam/) ──

-- A temporary sign-in for taking an exam: the student ID and the password of one of the
-- student's Student ID exams (set on the Exams tab), from an hour before it starts until it
-- closes. The session covers that course only and ends with the exam. Students without a
-- student ID sign in with Google.
create or replace function public.exam_student_sign_in(p_student_no text, p_password text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s exam_private.students; e exam_private.exams; v_student uuid; v_exam uuid; token text; until timestamptz;
begin
  select st.id, x.id into v_student, v_exam from exam_private.students st
    join exam_private.exams x on x.sheet_name = st.sheet_name and x.is_archive = st.is_archive
  where not st.is_archive and st.student_no <> '' and st.student_no = btrim(coalesce(p_student_no, ''))
    and x.sign_in = 'student_id' and x.visible and x.password_hash is not null
    and now() >= x.starts_at - interval '1 hour' and now() <= exam_private.ends_at(x) + interval '10 minutes'
    and x.password_hash = extensions.crypt(coalesce(p_password, ''), x.password_hash)
  order by x.starts_at desc limit 1;
  if v_student is null then
    perform pg_sleep(0.7);
    raise exception 'Wrong student ID or password' using errcode = '28P01';
  end if;
  select * into s from exam_private.students where id = v_student;
  select * into e from exam_private.exams where id = v_exam;
  until := exam_private.ends_at(e) + interval '15 minutes';
  token := exam_private.new_session('student', s.id, e.id, null, until);
  return jsonb_build_object('token', token, 'expires_at', until, 'name', s.full_name, 'student_no', s.student_no);
end $$;

-- Whether the caller signed in with this exam's password, so starting it doesn't ask again.
create or replace function exam_private.signed_in_for(p_exam uuid, p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from exam_private.sessions x where x.token_hash = exam_private.token_hash(p_token)
    and x.kind = 'student' and x.exam_id = p_exam and x.expires_at > now())
$$;
revoke all on function exam_private.signed_in_for(uuid, text) from public, anon, authenticated;

create or replace function public.exam_sign_out(p_token text) returns void
language sql volatile security definer set search_path = '' as $$
  delete from exam_private.sessions where token_hash = exam_private.token_hash(p_token)
$$;

-- The caller's courses, each with its listed exams: current ones first, then archived (past)
-- ones, newest first, whose grades stay visible but whose exams cannot be started.
create or replace function public.exam_dashboard(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'email', exam_private.my_email(p_token),
    'signed_in_by', case when teaching_private.email() is not null then 'google'
      when exists (select 1 from exam_private.my_students(p_token)) then 'student_id' end,
    'courses', coalesce((select jsonb_agg(jsonb_build_object(
        'sheet_name', s.sheet_name,
        'archived', s.is_archive,
        'code', exam_private.course_meta(s.sheet_name, s.is_archive, 'code'),
        'title', exam_private.course_meta(s.sheet_name, s.is_archive, 'title'),
        'semester', exam_private.course_meta(s.sheet_name, s.is_archive, 'semester'),
        'year', exam_private.course_meta(s.sheet_name, s.is_archive, 'year'),
        'student', jsonb_build_object('name', s.full_name, 'student_no', s.student_no),
        'exams', coalesce((select jsonb_agg(exam_private.exam_summary(e) || jsonb_build_object(
            'submitted_at', sub.submitted_at, 'status', sub.status, 'late', sub.late,
            'score', case when e.results_published then sub.grades->'totalScore' end,
            'max_score', case when e.results_published then sub.grades->'maxScore' end,
            'password_entered', exam_private.signed_in_for(e.id, p_token))
            order by e.starts_at nulls last, e.created_at)
          from exam_private.exams e
          left join exam_private.submissions sub on sub.exam_id = e.id and sub.exam_code is null
            and (sub.student_id = s.id or sub.student_no = exam_private.student_key(s))
          where e.sheet_name = s.sheet_name and e.is_archive = s.is_archive and e.visible), '[]'::jsonb))
        order by s.is_archive, exam_private.course_meta(s.sheet_name, s.is_archive, 'year') desc nulls last,
          exam_private.course_meta(s.sheet_name, s.is_archive, 'code'))
      from exam_private.my_students(p_token) s), '[]'::jsonb));
end $$;

-- Starts a named exam: on the class list and signed in as the exam asks, open now, password
-- if set (unless the student signed in with it), not yet submitted.
create or replace function public.exam_start(p_exam_id uuid, p_token text, p_password text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or not e.visible then raise exception 'This exam is not available'; end if;
  if e.sign_in = 'anonymous' then raise exception 'Sign in with your exam ID for this exam'; end if;
  if e.is_archive then raise exception 'This course is archived: its exams are closed'; end if;
  s := exam_private.exam_student(e, p_token);
  if not exam_private.is_open(e) then raise exception 'This exam is not open now'; end if;
  if e.password_hash is not null and not exam_private.signed_in_for(e.id, p_token)
      and e.password_hash <> extensions.crypt(coalesce(p_password, ''), e.password_hash) then
    perform pg_sleep(0.5);
    raise exception 'The exam password is incorrect' using errcode = '28P01';
  end if;
  if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code is null
      and (student_id = s.id or student_no = exam_private.student_key(s))) then
    raise exception 'You have already submitted this exam'; end if;
  return exam_private.exam_summary(e) || jsonb_build_object('questions', exam_private.student_questions(e.questions),
    'student', jsonb_build_object('name', s.full_name, 'email', s.email, 'student_no', s.student_no));
end $$;

-- Accepted until 10 minutes after the end; marked late after the end itself.
create or replace function public.exam_submit(p_exam_id uuid, p_token text, p_submission jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; s exam_private.students;
begin
  select * into e from exam_private.exams where id = p_exam_id;
  if not found or e.sign_in = 'anonymous' then raise exception 'This exam is not available'; end if;
  if e.is_archive then raise exception 'This course is archived: its exams are closed'; end if;
  s := exam_private.exam_student(e, p_token);
  if exam_private.ends_at(e) is null or now() < e.starts_at then raise exception 'This exam is not open'; end if;
  if now() > exam_private.ends_at(e) + interval '10 minutes' then
    raise exception 'This exam has closed. Keep your backup file and contact your lecturer.'; end if;
  insert into exam_private.submissions (exam_id, student_id, student_no, student_name, student_email,
      answers, fingerprint, auto_submitted, late)
    values (e.id, s.id, exam_private.student_key(s), s.full_name, s.email, coalesce(p_submission->'answers', '{}'::jsonb),
      coalesce(p_submission->'fingerprint', '{}'::jsonb), coalesce((p_submission->>'auto_submitted')::boolean, false),
      now() > exam_private.ends_at(e));
  return jsonb_build_object('submitted_at', now());
exception when unique_violation then
  raise exception 'You have already submitted this exam';
end $$;

-- A named exam's result, once the lecturer publishes results.
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
  return exam_private.exam_summary(e) || jsonb_build_object('questions', e.questions,
    'submission', case when sub.id is null then null else jsonb_build_object('submitted_at', sub.submitted_at,
      'answers', sub.answers, 'grades', sub.grades, 'status', sub.status, 'late', sub.late,
      'auto_submitted', sub.auto_submitted) end);
end $$;

-- ── Anonymous exams: exam ID + exam password, with no student identity ──

create or replace function public.exam_anonymous_start(p_code text, p_password text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e exam_private.exams; v_code text := btrim(coalesce(p_code, '')); token text;
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
  if exists (select 1 from exam_private.submissions where exam_id = e.id and exam_code = v_code) then
    raise exception 'This exam ID has already submitted the exam'; end if;
  token := exam_private.new_session('anonymous', null, e.id, v_code, exam_private.ends_at(e) + interval '15 minutes');
  return exam_private.exam_summary(e) || jsonb_build_object('questions', exam_private.student_questions(e.questions),
    'token', token, 'exam_code', v_code);
end $$;

create or replace function public.exam_anonymous_submit(p_token text, p_submission jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare x exam_private.sessions; e exam_private.exams;
begin
  select * into x from exam_private.sessions
    where token_hash = exam_private.token_hash(p_token) and kind = 'anonymous' and expires_at > now();
  if not found then raise exception 'Your exam session has expired. Keep your backup file and contact your lecturer.'; end if;
  select * into e from exam_private.exams where id = x.exam_id;
  insert into exam_private.submissions (exam_id, exam_code, answers, fingerprint, auto_submitted, late)
    values (e.id, x.exam_code, coalesce(p_submission->'answers', '{}'::jsonb),
      coalesce(p_submission->'fingerprint', '{}'::jsonb), coalesce((p_submission->>'auto_submitted')::boolean, false),
      now() > exam_private.ends_at(e));
  delete from exam_private.sessions where token_hash = x.token_hash;
  return jsonb_build_object('submitted_at', now());
exception when unique_violation then
  raise exception 'This exam ID has already submitted the exam';
end $$;

-- What an exam ID took in one course offering, with results where published. Exam IDs are
-- reshuffled every semester, so the same ID belongs to other students in other offerings:
-- the lookup never leaves the offering. The exam ID is the student's secret.
create or replace function public.exam_code_results(p_sheet text, p_archive boolean, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_code text := btrim(coalesce(p_code, '')); result jsonb;
begin
  select jsonb_agg(exam_private.exam_summary(e) || jsonb_build_object(
      'course_semester', exam_private.course_meta(e.sheet_name, e.is_archive, 'semester'),
      'course_year', exam_private.course_meta(e.sheet_name, e.is_archive, 'year'),
      'questions', case when e.results_published then e.questions end,
      'submission', jsonb_build_object('submitted_at', s.submitted_at, 'status', s.status, 'late', s.late,
        'answers', case when e.results_published then s.answers end,
        'grades', case when e.results_published then s.grades end)) order by e.starts_at)
    into result
  from exam_private.submissions s join exam_private.exams e on e.id = s.exam_id
  where v_code <> '' and s.exam_code = v_code and e.sign_in = 'anonymous'
    and e.sheet_name = p_sheet and e.is_archive = p_archive;
  if result is null then perform pg_sleep(0.3); end if;
  return coalesce(result, '[]'::jsonb);
end $$;

-- For the sign-in page's grade lookup: the course offerings with anonymous exams, current
-- ones first, then past ones, newest first. Course pages are public, so this is too.
create or replace function public.exam_result_courses() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c order by (c->>'archived')::boolean, c->>'year' desc nulls last, c->>'code'), '[]'::jsonb)
  from (select jsonb_build_object('sheet_name', e.sheet_name, 'archived', e.is_archive,
      'code', exam_private.course_meta(e.sheet_name, e.is_archive, 'code'),
      'title', exam_private.course_meta(e.sheet_name, e.is_archive, 'title'),
      'semester', exam_private.course_meta(e.sheet_name, e.is_archive, 'semester'),
      'year', exam_private.course_meta(e.sheet_name, e.is_archive, 'year')) c
    from exam_private.exams e where e.sign_in = 'anonymous' and e.visible
    group by e.sheet_name, e.is_archive) t
$$;

-- ── Public course pages: the schedule of listed exams ──

create or replace function public.exam_schedule(p_sheet text, p_archive boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('label', e.label, 'type', e.type, 'starts_at', e.starts_at,
    'duration_minutes', e.duration_minutes, 'hall', e.hall, 'weight', e.weight, 'sign_in', e.sign_in,
    'has_questions', jsonb_array_length(e.questions) > 0)
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
    'exam_delete_submission(uuid)', 'exam_move_course(text, boolean, text)', 'exam_delete_course(text, boolean)',
    'exam_save_questions(uuid, jsonb)', 'exam_grading_links(text, boolean)', 'exam_rename_grading_keys(text, boolean, jsonb)',
    'exam_check_students(text, boolean, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'exam_student_sign_in(text, text)', 'exam_sign_out(text)', 'exam_dashboard(text)',
    'exam_start(uuid, text, text)', 'exam_submit(uuid, text, jsonb)', 'exam_my_result(uuid, text)',
    'exam_anonymous_start(text, text)', 'exam_anonymous_submit(text, jsonb)', 'exam_code_results(text, boolean, text)',
    'exam_result_courses()', 'exam_schedule(text, boolean)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
