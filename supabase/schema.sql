-- ============================================================================
-- schema.sql — database for the Teaching course website + admin panel.
--
-- Mirrors the two tables and the Row-Level Security the app actually uses,
-- taken from the live project's introspection (information_schema + pg_policies).
--
-- To use: Supabase dashboard → SQL Editor → New query → paste all of this → Run.
--
-- Note: the author's live database also contains other tables (course_materials,
-- course_modules, course_announcements, …). The Teaching app does NOT use them —
-- it reads and writes `course_rows` (a generic type + b–j slot store) and reads
-- `admins`. Only those two are recreated here.
-- ============================================================================

-- ─── course_rows ────────────────────────────────────────────────────────────
-- One row per piece of course content. `type` says what the row is
-- (metadata / module / material / announcement / funfact / project / …) and the
-- generic slots b–j hold that type's fields, parsed per-type by the app.
create table if not exists public.course_rows (
    row_uid    text    not null primary key,
    sheet_name text    not null,
    is_archive boolean not null default false,
    row_index  integer not null,
    type       text    not null default '',
    -- The introspection paste stopped at `type`, but the app selects b–j from
    -- this table (…&select=type,b,c,d,e,f,g,h,i,j), so they exist as text slots:
    b text, c text, d text, e text, f text, g text, h text, i text, j text
);

create index if not exists course_rows_lookup_idx
    on public.course_rows (sheet_name, is_archive, row_index);

-- ─── timetable_rows ─────────────────────────────────────────────────────────
-- Backs the department Class Timetable page (/timetable/) and its admin portal
-- (/timetable/admin/). Same generic-slot design as course_rows — `type` says what
-- the row is and b–j hold that type's fields — but a separate table, so a
-- timetable row can never surface in a course listing.
--
--   type            section          b            c              d           e
--   ─────────────── ──────────────── ──────────── ────────────── ─────────── ──────────
--   setting         'settings'       key¹        value           —           —
--   info_item       'settings'       icon class  text            —           —
--   action_button   'settings'       label       icon class      url         css class
--   category        'settings'       name        icon class      kind²       —
--   entry           <category name>  label       timetable_id    class_id    hidden³
--   lecturer        <category name>  label       lecturer_id     —           hidden³
--
--   ¹ semester_start | semester_end | holiday_start | holiday_weeks
--   ² 'timetable' (EIS class timetable, needs both ids) or 'lecturer' (EIS live
--     lecturer view, needs one id). An explicit column rather than the old
--     sheet-named-"Lecturers" convention, which broke silently on rename.
--   ³ '1' if the admin toggled this entry hidden — kept in the table (so it
--     can be found and re-shown) but skipped by the public page.
--
-- row_index orders rows within a section: the tab order of categories, and the
-- button order of the entries inside each category.
create table if not exists public.timetable_rows (
    row_uid   text    not null primary key,
    section   text    not null,
    row_index integer not null,
    type      text    not null,
    b text, c text, d text, e text, f text, g text, h text, i text, j text
);

create index if not exists timetable_rows_lookup_idx
    on public.timetable_rows (section, row_index);

-- ─── admins ─────────────────────────────────────────────────────────────────
-- The edit allowlist, keyed by Google account email. A signed-in user may edit
-- iff their email is here. The public course page never reads this table.
create table if not exists public.admins (
    id      uuid not null default gen_random_uuid() primary key,
    name    text not null,
    surname text not null,
    email   text not null unique   -- unique: the app looks admins up by email
);

-- ─── Row-Level Security ─────────────────────────────────────────────────────
alter table public.course_rows    enable row level security;
alter table public.timetable_rows enable row level security;
alter table public.admins         enable row level security;

-- admins: a signed-in user may read ONLY their own row — that's the app's
-- "am I an admin?" lookup. The allowlist is managed in the Supabase table
-- editor, never from the browser.
drop policy if exists self_read on public.admins;
create policy self_read
    on public.admins for select
    to authenticated
    using (email = (auth.jwt() ->> 'email'));

-- course_rows: everyone can READ (the public site + anonymous visitors);
-- only an admin can INSERT/UPDATE/DELETE.
drop policy if exists "public read" on public.course_rows;
create policy "public read"
    on public.course_rows for select
    to public
    using (true);

-- (Kept from the live project; redundant with "public read" since the public
--  role already covers anon. Harmless — drop it if you prefer.)
drop policy if exists anon_read on public.course_rows;
create policy anon_read
    on public.course_rows for select
    to anon
    using (true);

drop policy if exists admin_crud on public.course_rows;
create policy admin_crud
    on public.course_rows for all
    to authenticated
    using (exists (
        select 1 from public.admins
        where admins.email = (auth.jwt() ->> 'email')
    ))
    with check (exists (
        select 1 from public.admins
        where admins.email = (auth.jwt() ->> 'email')
    ));

-- timetable_rows: same shape as course_rows — the department timetable is public,
-- and only an admin can edit it.
drop policy if exists "public read" on public.timetable_rows;
create policy "public read"
    on public.timetable_rows for select
    to public
    using (true);

drop policy if exists admin_crud on public.timetable_rows;
create policy admin_crud
    on public.timetable_rows for all
    to authenticated
    using (exists (
        select 1 from public.admins
        where admins.email = (auth.jwt() ->> 'email')
    ))
    with check (exists (
        select 1 from public.admins
        where admins.email = (auth.jwt() ->> 'email')
    ));

-- ─── Grants (PostgREST needs these alongside the policies above) ─────────────
grant select on public.course_rows to anon, authenticated;
grant insert, update, delete on public.course_rows to authenticated;
grant select on public.timetable_rows to anon, authenticated;
grant insert, update, delete on public.timetable_rows to authenticated;
grant select on public.admins to authenticated;

-- ─── Bootstrap: make yourself the first admin ───────────────────────────────
-- Replace the email with your own Google account, then this row lets you in.
insert into public.admins (name, surname, email)
values ('Your', 'Name', 'you@example.edu')
on conflict (email) do nothing;

-- ─── Optional: auto-enable RLS on any future public table ───────────────────
-- The live project has this event trigger as a safety net so a newly created
-- table is never accidentally left world-writable. Not required for the app to
-- work (course_rows/admins already have RLS above). Skip this block if your
-- role can't create event triggers.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
      exception when others then
        raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    end if;
  end loop;
end;
$$;

drop event trigger if exists rls_auto_enable_trg;
create event trigger rls_auto_enable_trg
    on ddl_command_end
    when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    execute function public.rls_auto_enable();
