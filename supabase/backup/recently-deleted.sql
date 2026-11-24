-- Recently deleted: what the editor deletes is kept for 30 days and can be put back.
-- Run in the Supabase SQL editor after supabase/exams/2-functions.sql. Safe to run again. Until
-- it has run, the editor does not show Recently deleted.
--
-- What is kept: a course's content (modules, materials, announcements, assignments, links, Info
-- fields), a whole course (with its lecturers' assignments and its exam data), exams with their
-- submissions, questions taken out of an exam or the question pool, single submissions,
-- students and exam codes taken off the lists, and the question images these need.
-- Not kept: files students uploaded (Storage's free 1 GB would fill; download them first),
-- sign-ins and exams in progress, and submissions handed back (kept with the attempt anyway).
--
-- Where: in the database, in the private schema "bin" (not in Storage, not reachable through the
-- API). A deleted row moves there, so deleting does not make the database bigger: its space is
-- freed 30 days later instead. The bin keeps at most 50 MB; past that, the oldest go first. Both
-- are set in bin.keep_days and bin.most_bytes below.
--
-- How: triggers on the tables keep each deleted row (and each question taken out of an exam or
-- the pool, by its id), grouped by the action that deleted them (its transaction). Lecturers and
-- admins see and restore their course's (public.bin_list, public.bin_restore), from the course's
-- ⋯ menu; admins also whole courses (public.bin_courses, public.bin_restore_course), from the
-- sidebar.

create schema if not exists bin;
revoke all on schema bin from public, anon, authenticated;

create table if not exists bin.items (
  id bigint generated always as identity primary key,
  batch bigint not null default txid_current(),   -- what one action deleted together
  deleted_at timestamptz not null default now(),
  deleted_by text,                                 -- the email of who deleted it
  source text not null,       -- course_rows, assignments, bindings, exams, submissions, reviews,
                              -- exam_question, pool_question, pools, students, exam_codes, images
  kind text not null default '',  -- a course row's type, a question's type, else as source
  sheet_name text,            -- the course offering ('pool:<course>' for the question pool)
  is_archive boolean,
  ref text,                   -- the item's own key: row_uid, exam id, question id…
  parent text,                -- what it was in: a question's or submission's exam
  pos integer,                -- its place there (a question's, from 0)
  label text not null default '',
  data jsonb not null,        -- the row, or the question
  blob bytea                  -- an image's bytes
);
create index if not exists items_course_idx on bin.items (sheet_name, is_archive, deleted_at desc);
create index if not exists items_batch_idx on bin.items (batch);
create index if not exists items_deleted_idx on bin.items (deleted_at);
alter table bin.items enable row level security;
revoke all on bin.items from public, anon, authenticated;

create table if not exists bin.state (
  singleton boolean primary key default true check (singleton),
  tidied_at timestamptz not null default now()
);
insert into bin.state default values on conflict do nothing;
alter table bin.state enable row level security;
revoke all on bin.state from public, anon, authenticated;

-- How long, and how much.
create or replace function bin.keep_days() returns integer language sql immutable set search_path = '' as $$ select 30 $$;
create or replace function bin.most_bytes() returns bigint language sql immutable set search_path = '' as $$ select 50::bigint * 1024 * 1024 $$;

-- ── Keeping ──

create or replace function bin.who() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(teaching_private.email(), nullif(auth.jwt()->>'email', ''))
$$;

-- A name for the list: plain text, on one line, at most 200 characters.
create or replace function bin.plain(p text) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g')), 200)
$$;

create or replace function bin.question_label(q jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when q->>'type' = 'pool' then 'Draws ' || coalesce(q->>'count', '1') || ' from the question pool'
    else coalesce(nullif(bin.plain(q->>'prompt'), ''),
      nullif(bin.plain(regexp_replace(coalesce(q->>'template', ''), '\[\[[^\]]*\]\]', '___', 'g')), ''), 'A question') end
$$;

create or replace function bin.keep(p_source text, p_kind text, p_sheet text, p_archive boolean, p_ref text,
  p_parent text, p_pos integer, p_label text, p_data jsonb, p_blob bytea default null) returns void
language sql volatile security definer set search_path = '' as $$
  insert into bin.items (source, kind, sheet_name, is_archive, ref, parent, pos, label, data, blob, deleted_by)
  values (p_source, coalesce(p_kind, ''), p_sheet, p_archive, p_ref, p_parent, p_pos, bin.plain(p_label), p_data, p_blob, bin.who())
$$;

-- Questions in p_old whose id is not in p_new: taken out.
create or replace function bin.removed_questions(p_old jsonb, p_new jsonb)
returns table (q jsonb, pos integer)
language sql immutable set search_path = '' as $$
  select t.q, (t.ord - 1)::integer
  from jsonb_array_elements(case jsonb_typeof(p_old) when 'array' then p_old else '[]'::jsonb end) with ordinality t(q, ord)
  where jsonb_typeof(t.q) = 'object' and coalesce(t.q->>'id', '') <> ''
    and not exists (select 1 from jsonb_array_elements(case jsonb_typeof(p_new) when 'array' then p_new else '[]'::jsonb end) n(q)
      where n.q->>'id' = t.q->>'id')
$$;

-- Old ones out (30 days), then the oldest while over the size; at most once an hour.
create or replace function bin.tidy() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_total bigint;
begin
  update bin.state set tidied_at = now() where singleton and tidied_at < now() - interval '1 hour';
  if not found then return; end if;
  delete from bin.items where deleted_at < now() - make_interval(days => bin.keep_days());
  select coalesce(sum(pg_column_size(i.*)), 0) into v_total from bin.items i;
  if v_total > bin.most_bytes() then
    delete from bin.items where id in (select t.id from (
      select i.id, sum(pg_column_size(i.*)) over (order by i.id desc) running from bin.items i) t
      where t.running > bin.most_bytes());
  end if;
end $$;

create or replace function bin.on_tidy() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform bin.tidy();
  return null;
end $$;

-- A course row: its type, and its name as the editor shows it.
create or replace function bin.on_course_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform bin.keep('course_rows', coalesce(nullif(old.type, ''), 'row'), old.sheet_name, old.is_archive, old.row_uid, null, old.row_index,
    case old.type when 'announcement' then old.e when 'button' then old.b when 'funfact' then old.b
      when 'project_description' then old.b when 'metadata' then old.b
      else coalesce(nullif(btrim(old.c), ''), old.b) end, to_jsonb(old));
  return null;
end $$;

-- A lecturer's assignment to a course, and their name's binding (gone with a deleted course).
create or replace function bin.on_assignment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform bin.keep('assignments', 'assignment', old.sheet_name, old.is_archive, old.email, null, null, old.email, to_jsonb(old));
  return null;
end $$;

create or replace function bin.on_binding() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform bin.keep('bindings', 'binding', old.sheet_name, old.is_archive, old.name_row_uid, null, null, old.email, to_jsonb(old));
  return null;
end $$;

-- An exam deleted; or questions taken out of it (a save of its questions), each with its place.
create or replace function bin.on_exam() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform bin.keep('exams', 'exam', old.sheet_name, old.is_archive, old.id::text, null, null,
      coalesce(nullif(btrim(old.label), ''), initcap(replace(old.type, '_', ' '))), to_jsonb(old));
    -- Its submissions and reviews, deleted with it (before it, by the database): its course.
    update bin.items i set sheet_name = old.sheet_name, is_archive = old.is_archive
      where i.batch = txid_current() and i.parent = old.id::text and i.sheet_name is null;
    return null;
  end if;
  insert into bin.items (source, kind, sheet_name, is_archive, ref, parent, pos, label, data, deleted_by)
    select 'exam_question', coalesce(nullif(r.q->>'type', ''), 'question'), new.sheet_name, new.is_archive, r.q->>'id',
      new.id::text, r.pos, bin.question_label(r.q), r.q, bin.who()
    from bin.removed_questions(old.questions, new.questions) r;
  return null;
end $$;

-- The question pool: questions taken out of it.
create or replace function bin.on_pool() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform bin.keep('pools', 'pool', 'pool:' || old.course, false, old.course, null, null, 'Question pool', to_jsonb(old));
    return null;
  end if;
  insert into bin.items (source, kind, sheet_name, is_archive, ref, parent, pos, label, data, deleted_by)
    select 'pool_question', coalesce(nullif(r.q->>'type', ''), 'question'), 'pool:' || new.course, false, r.q->>'id',
      new.course, r.pos, bin.question_label(r.q), r.q, bin.who()
    from bin.removed_questions(old.questions, new.questions) r;
  return null;
end $$;

-- A submission. One handed back to the student (exam_return_submission, exam_return_new_paper)
-- is kept with the attempt, so it is not kept here.
create or replace function bin.on_submission() returns trigger
language plpgsql security definer set search_path = '' as $$
declare e exam_private.exams;
begin
  if exists (select 1 from exam_private.attempts a where a.exam_id = old.exam_id and a.returned_at = now()
      and a.who = case when old.exam_code is not null then 'code:' || old.exam_code else old.student_no end) then
    return null;
  end if;
  select * into e from exam_private.exams where id = old.exam_id;
  perform bin.keep('submissions', 'submission', e.sheet_name, e.is_archive, old.id::text, old.exam_id::text, null,
    coalesce(nullif(old.exam_code, ''), nullif(old.student_name, ''), old.student_no), to_jsonb(old));
  return null;
end $$;

-- A review of what was recorded: kept only when its exam goes (one cleared by hand is not).
create or replace function bin.on_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from exam_private.exams e where e.id = old.exam_id) then return null; end if;
  perform bin.keep('reviews', 'review', null, null, old.who, old.exam_id::text, null, old.who, to_jsonb(old));
  return null;
end $$;

create or replace function bin.on_student() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform bin.keep('students', 'student', old.sheet_name, old.is_archive, old.id::text, null, old.list_order,
    coalesce(nullif(old.full_name, ''), nullif(old.email, ''), old.student_no), to_jsonb(old));
  return null;
end $$;

create or replace function bin.on_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform bin.keep('exam_codes', 'exam_code', old.sheet_name, old.is_archive, old.code, null, old.list_order, old.code, to_jsonb(old));
  return null;
end $$;

-- A question image (no question shows it any more, or its course went): its bytes apart.
create or replace function bin.on_image() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform bin.keep('images', 'image', old.sheet_name, old.is_archive, old.id::text, null, null, '', to_jsonb(old) - 'data', old.data);
  return null;
end $$;

-- The triggers: a row-level one keeps, a statement-level one tidies.
drop trigger if exists bin_keep on public.course_rows;
create trigger bin_keep after delete on public.course_rows for each row execute function bin.on_course_row();
drop trigger if exists bin_tidy on public.course_rows;
create trigger bin_tidy after delete on public.course_rows for each statement execute function bin.on_tidy();

drop trigger if exists bin_keep on exam_private.exams;
create trigger bin_keep after delete on exam_private.exams for each row execute function bin.on_exam();
drop trigger if exists bin_keep_questions on exam_private.exams;
create trigger bin_keep_questions after update of questions on exam_private.exams for each row
  when (old.questions is distinct from new.questions) execute function bin.on_exam();
drop trigger if exists bin_tidy on exam_private.exams;
create trigger bin_tidy after delete on exam_private.exams for each statement execute function bin.on_tidy();

drop trigger if exists bin_keep_questions on exam_private.pools;
create trigger bin_keep_questions after update of questions on exam_private.pools for each row
  when (old.questions is distinct from new.questions) execute function bin.on_pool();
drop trigger if exists bin_keep on exam_private.pools;
create trigger bin_keep after delete on exam_private.pools for each row execute function bin.on_pool();

drop trigger if exists bin_keep on exam_private.submissions;
create trigger bin_keep after delete on exam_private.submissions for each row execute function bin.on_submission();
drop trigger if exists bin_tidy on exam_private.submissions;
create trigger bin_tidy after delete on exam_private.submissions for each statement execute function bin.on_tidy();

drop trigger if exists bin_keep on exam_private.reviews;
create trigger bin_keep after delete on exam_private.reviews for each row execute function bin.on_review();

drop trigger if exists bin_keep on exam_private.students;
create trigger bin_keep after delete on exam_private.students for each row execute function bin.on_student();
drop trigger if exists bin_tidy on exam_private.students;
create trigger bin_tidy after delete on exam_private.students for each statement execute function bin.on_tidy();

drop trigger if exists bin_keep on exam_private.exam_codes;
create trigger bin_keep after delete on exam_private.exam_codes for each row execute function bin.on_code();

drop trigger if exists bin_keep on exam_private.images;
create trigger bin_keep after delete on exam_private.images for each row execute function bin.on_image();
drop trigger if exists bin_tidy on exam_private.images;
create trigger bin_tidy after delete on exam_private.images for each statement execute function bin.on_tidy();

-- The lecturers' assignments and name bindings, where they exist.
do $$ begin
  if to_regclass('public.teaching_assignments') is not null then
    execute 'drop trigger if exists bin_keep on public.teaching_assignments';
    execute 'create trigger bin_keep after delete on public.teaching_assignments for each row execute function bin.on_assignment()';
  end if;
  if to_regclass('teaching_private.professor_bindings') is not null then
    execute 'drop trigger if exists bin_keep on teaching_private.professor_bindings';
    execute 'create trigger bin_keep after delete on teaching_private.professor_bindings for each row execute function bin.on_binding()';
  end if;
end $$;

-- ── Putting back ──

-- A kept row back in its table; false when it can't go back as it was (another has its place
-- or its key, or what it belonged to is gone).
create or replace function bin.put_back(p_table regclass, p_data jsonb) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_table is null then return false; end if;
  execute format('insert into %s select * from jsonb_populate_record(null::%s, $1)', p_table, p_table) using p_data;
  return true;
exception when unique_violation or foreign_key_violation or check_violation or not_null_violation then
  return false;
end $$;

-- The images these questions show that the bin has and the database does not.
create or replace function bin.put_back_images(p_questions jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare i bin.items;
begin
  for i in select distinct on (b.ref) b.* from bin.items b
      where b.source = 'images' and b.ref in (select unnest(exam_private.image_ids(p_questions))::text)
        and not exists (select 1 from exam_private.images x where x.id::text = b.ref)
      order by b.ref, b.id desc loop
    if bin.put_back('exam_private.images', i.data || jsonb_build_object('data', '\x' || encode(i.blob, 'hex'))) then
      delete from bin.items where id = i.id;
    end if;
  end loop;
end $$;

-- A submission back to its exam: to its student when they are on the class list again.
create or replace function bin.put_back_submission(i bin.items) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_data jsonb := i.data;
begin
  if not exists (select 1 from exam_private.exams e where e.id::text = i.parent) then return false; end if;
  if v_data->>'student_id' is not null and not exists (select 1 from exam_private.students s where s.id::text = v_data->>'student_id') then
    v_data := v_data || jsonb_build_object('student_id', null);
  end if;
  return bin.put_back('exam_private.submissions', v_data);
end $$;

-- An exam back, with its submissions and reviews deleted with it, and the images it and its
-- papers show. Its students' uploaded files were deleted with it and do not come back.
create or replace function bin.put_back_exam(i bin.items) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare d bin.items;
begin
  if exists (select 1 from exam_private.exams e where e.id::text = i.ref) then return true; end if;
  if not bin.put_back('exam_private.exams', i.data) then return false; end if;
  for d in select * from bin.items where batch = i.batch and parent = i.ref and source = 'submissions' order by id loop
    if bin.put_back_submission(d) then delete from bin.items where id = d.id; end if;
  end loop;
  for d in select * from bin.items where batch = i.batch and parent = i.ref and source = 'reviews' order by id loop
    if bin.put_back('exam_private.reviews', d.data) then delete from bin.items where id = d.id; end if;
  end loop;
  perform bin.put_back_images(i.data->'questions');
  perform bin.put_back_images(exam_private.drawn_copies((i.ref)::uuid));
  return true;
end $$;

-- A student back on the class list, and to their submissions (which kept their name and ID).
create or replace function bin.put_back_student(i bin.items) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from exam_private.students s where s.id::text = i.ref) then return true; end if;
  if not bin.put_back('exam_private.students', i.data) then return false; end if;
  update exam_private.submissions s set student_id = (i.data->>'id')::uuid
    from exam_private.exams e
    where s.exam_id = e.id and e.sheet_name = i.sheet_name and e.is_archive = i.is_archive
      and s.student_id is null and s.exam_code is null and coalesce(i.data->>'student_no', '') <> '' and s.student_no = i.data->>'student_no';
  return true;
end $$;

-- A course row back; one whose place (row_uid) or Info field is taken again counts as back.
create or replace function bin.put_back_row(i bin.items) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.course_rows r where r.row_uid = i.ref) then return true; end if;
  if i.kind = 'metadata' and exists (select 1 from public.course_rows r where r.sheet_name = i.sheet_name
      and r.is_archive = i.is_archive and r.type = 'metadata' and lower(btrim(r.b)) = lower(btrim(i.data->>'b'))) then
    return true;
  end if;
  return bin.put_back('public.course_rows', i.data);
end $$;

-- What a list or restore call may see: lecturers and admins of the course (its pool too).
create or replace function bin.mine(i bin.items, p_sheet text, p_archive boolean) returns boolean
language sql stable set search_path = '' as $$
  select (i.sheet_name = p_sheet and i.is_archive = p_archive) or i.sheet_name = 'pool:' || exam_private.course_base(p_sheet)
$$;

-- ── For the editor ──

-- Whether this file has run (the editor shows Recently deleted then).
create or replace function public.bin_ready() returns boolean
language sql stable set search_path = '' as $$ select true $$;

-- What was deleted in a course offering (and from its question pool) in the last 30 days, one
-- entry an action: a course's content deleted in one save; an exam (with how many submissions
-- went with it); questions taken out of an exam, or of the pool; submissions; students; exam
-- codes. Newest first. Each: its ids (to restore it), what it was (kind), when and by whom, how
-- many, the first items' kinds and names, and the exam it was in.
create or replace function public.bin_list(p_sheet text, p_archive boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  perform bin.tidy();
  return coalesce((select jsonb_agg(g.entry order by g.at desc) from (
    select max(k.deleted_at) at, jsonb_build_object(
      'key', k.key, 'kind', k.family, 'ids', jsonb_agg(k.id order by k.pos nulls last, k.id), 'count', count(*),
      'deleted_at', max(k.deleted_at), 'deleted_by', min(k.deleted_by), 'parent', min(k.parent),
      'parent_label', min(k.parent_label), 'with', coalesce(sum(k.with_count), 0),
      'items', to_jsonb((array_agg(jsonb_build_object('kind', k.kind, 'label', k.label) order by k.pos nulls last, k.id))[1:20])) entry
    from (
      select i.id, i.kind, i.label, i.pos, i.parent, i.deleted_at, i.deleted_by,
        case i.source when 'course_rows' then 'content' when 'exams' then 'exam' when 'submissions' then 'submissions'
          when 'exam_question' then 'questions' when 'pool_question' then 'pool' when 'students' then 'students' else 'codes' end family,
        case when i.source = 'exams' then 'exam:' || i.id else i.source || ':' || i.batch || ':' || coalesce(i.parent, '') end key,
        case when i.source in ('submissions', 'exam_question') then coalesce(
          (select coalesce(nullif(btrim(x.label), ''), initcap(replace(x.type, '_', ' '))) from exam_private.exams x where x.id::text = i.parent),
          (select e.label from bin.items e where e.source = 'exams' and e.ref = i.parent order by e.id desc limit 1)) end parent_label,
        case when i.source = 'exams' then (select count(*) from bin.items s where s.batch = i.batch and s.source = 'submissions' and s.parent = i.ref) end with_count
      from bin.items i
      where bin.mine(i, p_sheet, p_archive)
        and i.source in ('course_rows', 'exams', 'submissions', 'exam_question', 'pool_question', 'students', 'exam_codes')
        -- An exam's submissions deleted with it are part of it.
        and not (i.source = 'submissions' and exists (select 1 from bin.items e where e.batch = i.batch and e.source = 'exams' and e.ref = i.parent))
    ) k
    group by k.key, k.family) g), '[]'::jsonb);
end $$;

-- Puts entries of the list back (their ids, as bin_list gave them): content rows; students and
-- exam codes; exams with what went with them; submissions; questions, each at its old place in
-- its exam (saved as the questions editor saves them, so answers and grades follow) or in the
-- pool. What can't go back stays in the bin: { restored, kept, notes }.
create or replace function public.bin_restore(p_sheet text, p_archive boolean, p_ids bigint[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare i bin.items; e exam_private.exams; v_done bigint[] := '{}'; v_kept integer := 0; v_notes text[] := '{}';
  v_qs jsonb; v_parent text; v_at integer;
begin
  perform exam_private.require_access(p_sheet, p_archive, true);
  if exists (select 1 from bin.items b where b.id = any(p_ids) and b.source = 'course_rows') then
    lock table public.course_rows in share row exclusive mode;
  end if;
  -- In order: what others need first.
  for i in select * from bin.items b where b.id = any(p_ids) and bin.mine(b, p_sheet, p_archive)
      and b.source in ('course_rows', 'students', 'exam_codes', 'exams', 'submissions')
      order by array_position(array['course_rows', 'students', 'exam_codes', 'exams', 'submissions'], b.source), b.pos nulls last, b.id
      for update loop
    if (case i.source
        when 'course_rows' then bin.put_back_row(i)
        when 'students' then bin.put_back_student(i)
        when 'exam_codes' then exists (select 1 from exam_private.exam_codes c where c.sheet_name = i.sheet_name
          and c.is_archive = i.is_archive and c.code = i.ref) or bin.put_back('exam_private.exam_codes', i.data)
        when 'exams' then bin.put_back_exam(i)
        else exists (select 1 from exam_private.submissions s where s.id::text = i.ref) or bin.put_back_submission(i) end) then
      v_done := v_done || i.id;
    else
      v_kept := v_kept + 1;
      v_notes := v_notes || case i.source
        when 'submissions' then i.label || ' has another submission now, or the exam is gone'
        when 'students' then i.label || ' is on the class list again with another student ID or email'
        else i.label || ' could not go back' end;
    end if;
  end loop;
  -- Questions, exam by exam, each at its place.
  for v_parent in select distinct b.parent from bin.items b where b.id = any(p_ids) and b.source = 'exam_question' and bin.mine(b, p_sheet, p_archive) loop
    select * into e from exam_private.exams x where x.id::text = v_parent;
    if not found then
      v_kept := v_kept + (select count(*) from bin.items b where b.id = any(p_ids) and b.source = 'exam_question' and b.parent = v_parent);
      v_notes := v_notes || 'Their exam is deleted: restore the exam first'::text;
      continue;
    end if;
    v_qs := e.questions;
    for i in select * from bin.items b where b.id = any(p_ids) and b.source = 'exam_question' and b.parent = v_parent order by b.pos, b.id for update loop
      if not exists (select 1 from jsonb_array_elements(v_qs) q where q->>'id' = i.ref) then
        v_at := least(greatest(coalesce(i.pos, 0), 0), jsonb_array_length(v_qs));
        v_qs := case when v_at >= jsonb_array_length(v_qs) then v_qs || jsonb_build_array(i.data)
          else jsonb_insert(v_qs, array[v_at::text], i.data) end;
      end if;
      v_done := v_done || i.id;
    end loop;
    perform bin.put_back_images(v_qs);
    perform public.exam_save_questions(e.id, v_qs);
  end loop;
  -- Pool questions, each at its place.
  if exists (select 1 from bin.items b where b.id = any(p_ids) and b.source = 'pool_question' and bin.mine(b, p_sheet, p_archive)) then
    v_qs := exam_private.pool_questions(p_sheet);
    for i in select * from bin.items b where b.id = any(p_ids) and b.source = 'pool_question' and bin.mine(b, p_sheet, p_archive)
        order by b.pos, b.id for update loop
      if not exists (select 1 from jsonb_array_elements(v_qs) q where q->>'id' = i.ref) then
        v_at := least(greatest(coalesce(i.pos, 0), 0), jsonb_array_length(v_qs));
        v_qs := case when v_at >= jsonb_array_length(v_qs) then v_qs || jsonb_build_array(i.data)
          else jsonb_insert(v_qs, array[v_at::text], i.data) end;
      end if;
      v_done := v_done || i.id;
    end loop;
    perform bin.put_back_images(v_qs);
    perform public.exam_save_pool(p_sheet, p_archive, v_qs);
  end if;
  delete from bin.items where id = any(v_done);
  return jsonb_build_object('restored', cardinality(v_done), 'kept', v_kept, 'notes', to_jsonb(v_notes));
end $$;

-- Whole courses deleted (admins): each deletion of a course's content that took its code or
-- title, newest first, with its name, how many rows, and the exams and students deleted with it
-- (exam_delete_course, right after). exists: a course has that name again.
create or replace function public.bin_courses() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if coalesce(public.teaching_role(), '') not in ('admin', 'global_admin') then
    raise exception 'Only admins can restore deleted courses' using errcode = '42501'; end if;
  perform bin.tidy();
  return coalesce((select jsonb_agg(jsonb_build_object('sheet_name', c.sheet_name, 'is_archive', c.is_archive, 'batch', c.batch,
      'deleted_at', c.deleted_at, 'deleted_by', c.deleted_by, 'rows', c.n, 'code', c.code, 'title', c.title,
      'semester', c.semester, 'year', c.year,
      'exists', exists (select 1 from public.course_rows r where r.sheet_name = c.sheet_name and r.is_archive = c.is_archive),
      'exams', (select count(*) from bin.items x where x.source = 'exams' and x.sheet_name = c.sheet_name and x.is_archive = c.is_archive
        and x.deleted_at between c.deleted_at and c.deleted_at + interval '10 minutes'),
      'students', (select count(*) from bin.items x where x.source in ('students', 'exam_codes') and x.sheet_name = c.sheet_name
        and x.is_archive = c.is_archive and x.deleted_at between c.deleted_at and c.deleted_at + interval '10 minutes'))
      order by c.deleted_at desc)
    from (select i.sheet_name, i.is_archive, i.batch, max(i.deleted_at) deleted_at, min(i.deleted_by) deleted_by, count(*) n,
        max(case when i.kind = 'metadata' and lower(btrim(i.data->>'b')) = 'code' then i.data->>'c' end) code,
        max(case when i.kind = 'metadata' and lower(btrim(i.data->>'b')) = 'title' then i.data->>'c' end) title,
        max(case when i.kind = 'metadata' and lower(btrim(i.data->>'b')) = 'semester' then i.data->>'c' end) as semester,
        max(case when i.kind = 'metadata' and lower(btrim(i.data->>'b')) = 'year' then i.data->>'c' end) as year
      from bin.items i where i.source = 'course_rows'
      group by i.sheet_name, i.is_archive, i.batch
      having count(*) filter (where i.kind = 'metadata' and lower(btrim(i.data->>'b')) in ('code', 'title')) > 0) c), '[]'::jsonb);
end $$;

-- A deleted course back (admins), as it was: its content, its lecturers, then its exam data
-- deleted with it (class list, exam codes, exams with their submissions, images). Not while
-- another course has its name. { restored, kept }
create or replace function public.bin_restore_course(p_name text, p_archive boolean, p_batch bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare i bin.items; v_at timestamptz; v_done bigint[] := '{}'; v_kept integer := 0;
begin
  if coalesce(public.teaching_role(), '') not in ('admin', 'global_admin') then
    raise exception 'Only admins can restore deleted courses' using errcode = '42501'; end if;
  lock table public.course_rows in share row exclusive mode;
  if exists (select 1 from public.course_rows r where r.sheet_name = p_name and r.is_archive = p_archive) then
    raise exception 'A course named % exists now: rename or delete it first', p_name; end if;
  select max(b.deleted_at) into v_at from bin.items b where b.batch = p_batch and b.source = 'course_rows'
    and b.sheet_name = p_name and b.is_archive = p_archive;
  if v_at is null then raise exception 'This course is no longer in Recently deleted'; end if;
  for i in select * from bin.items b where b.batch = p_batch and b.sheet_name = p_name and b.is_archive = p_archive
      and b.source in ('course_rows', 'assignments', 'bindings')
      order by array_position(array['course_rows', 'assignments', 'bindings'], b.source), b.id for update loop
    if (case i.source
        when 'course_rows' then bin.put_back_row(i)
        when 'assignments' then coalesce(bin.put_back(to_regclass('public.teaching_assignments'), i.data), false)
        else coalesce(bin.put_back(to_regclass('teaching_private.professor_bindings'), i.data), false) end) then
      v_done := v_done || i.id;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;
  -- Its exam data, deleted right after it.
  for i in select * from bin.items b where b.sheet_name = p_name and b.is_archive = p_archive
      and b.source in ('students', 'exam_codes', 'images', 'exams')
      and b.deleted_at between v_at and v_at + interval '10 minutes'
      order by array_position(array['students', 'exam_codes', 'images', 'exams'], b.source), b.id for update loop
    if (case i.source
        when 'students' then bin.put_back_student(i)
        when 'exam_codes' then bin.put_back('exam_private.exam_codes', i.data)
        when 'images' then exists (select 1 from exam_private.images x where x.id::text = i.ref)
          or bin.put_back('exam_private.images', i.data || jsonb_build_object('data', '\x' || encode(i.blob, 'hex')))
        else bin.put_back_exam(i) end) then
      v_done := v_done || i.id;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;
  delete from bin.items where id = any(v_done);
  return jsonb_build_object('restored', cardinality(v_done), 'kept', v_kept);
end $$;

-- Only signed-in lecturers and admins, through these; the checks are inside.
revoke all on all functions in schema bin from public, anon, authenticated;
revoke all on function public.bin_ready(), public.bin_list(text, boolean), public.bin_restore(text, boolean, bigint[]),
  public.bin_courses(), public.bin_restore_course(text, boolean, bigint) from public, anon;
grant execute on function public.bin_ready(), public.bin_list(text, boolean), public.bin_restore(text, boolean, bigint[]),
  public.bin_courses(), public.bin_restore_course(text, boolean, bigint) to authenticated;
