-- ============================================================================
-- timetable_rows.sql — incremental migration for an EXISTING project.
--
-- schema.sql is the full from-scratch schema and groups tables, policies and
-- grants by concern, so the timetable pieces are spread through it. This file
-- is the same thing gathered into one block you can paste in one go.
--
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- Safe to re-run: every statement is idempotent (create if not exists /
-- drop policy if exists). It does not touch course_rows or admins.
-- ============================================================================

-- ─── The table ──────────────────────────────────────────────────────────────
-- Backs /timetable/ and /timetable/admin/. Same generic-slot design as
-- course_rows — `type` says what the row is and b–j hold that type's fields —
-- but a separate table, so a timetable row can never surface in a course list.
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
--   ² 'timetable' (needs both EIS ids) or 'lecturer' (needs one)
--   ³ '1' if hidden from the public page (toggled per-entry in the admin) —
--     just a value in the already-existing `e` slot, no schema change needed.
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

-- ─── Row-Level Security ─────────────────────────────────────────────────────
-- Same shape as course_rows: the department timetable is public, and only an
-- account listed in `admins` can change it.
alter table public.timetable_rows enable row level security;

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
grant select on public.timetable_rows to anon, authenticated;
grant insert, update, delete on public.timetable_rows to authenticated;

-- ─── Check it worked ────────────────────────────────────────────────────────
-- Expect: 1 table, 2 policies ("public read" + admin_crud), rls_enabled = true.
select
    (select count(*) from pg_tables
       where schemaname = 'public' and tablename = 'timetable_rows')   as table_created,
    (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'timetable_rows')   as policies,
    (select relrowsecurity from pg_class
       where oid = 'public.timetable_rows'::regclass)                  as rls_enabled;
