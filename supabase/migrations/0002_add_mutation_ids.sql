-- =====================================================================
-- BlackIT Flow — add mutation_id to members and projects
--
-- `0001_init.sql` created these two tables without `mutation_id`, but the
-- client tags every synced row with one so it can recognise and drop the
-- realtime echo of its own write. PostgREST rejects the whole upsert when a
-- column is unknown, which left a freshly bootstrapped workspace with only its
-- `workspaces` row written.
--
-- Safe to run more than once. Run this in the Supabase SQL Editor.
-- =====================================================================

alter table members  add column if not exists mutation_id text;
alter table projects add column if not exists mutation_id text;

-- Confirm both columns now exist:
--   select table_name, column_name
--     from information_schema.columns
--    where table_schema = 'public' and column_name = 'mutation_id'
--    order by table_name;
-- Expected: activity, members, projects, subtasks, tasks.

-- ---------------------------------------------------------------------
-- Make sure every synced table is in the realtime publication.
--
-- `0001_init.sql` adds them, but a project created before `workspaces` existed
-- would not have it. This is idempotent: adding a table that is already a
-- member is harmless, and the exception it raises is caught below.
-- ---------------------------------------------------------------------

do $$
declare
  t text;
begin
  for t in
    select unnest(array['tasks', 'subtasks', 'projects', 'members', 'activity', 'workspaces'])
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception
      when duplicate_object then null;      -- already published
      when undefined_object then null;      -- no publication in this project
    end;
  end loop;
end;
$$;

select tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime'
 order by tablename;
