-- =====================================================================
-- BlackIT Flow — a subtask step can be somebody's
--
-- A task's steps were anonymous: the task had owners, the steps inside it did
-- not, so "who is writing the empty state?" had no answer in the tool.
--
-- One person per step, deliberately. A subtask is a single action, so sharing
-- one would mean nothing; a task is where work is shared.
--
-- ---------------------------------------------------------------------
-- ADDITIVE. Apply it before deploying the client that writes the column: the
-- new client sends `assignee_id` on every subtask write, and PostgREST rejects
-- a whole upsert when a column is unknown. The currently-deployed client never
-- mentions the column, so it is unaffected by this file.
-- ---------------------------------------------------------------------
--
-- Safe to run more than once. Run it in the Supabase SQL Editor.
-- =====================================================================

alter table subtasks
  add column if not exists assignee_id uuid references members(id) on delete set null;

-- When the step was handed over. Stamped by the trigger below rather than sent
-- by the client, so the client never has to track it (and cannot forge it).
alter table subtasks
  add column if not exists assigned_at timestamptz;

create index if not exists subtasks_assignee_idx on subtasks (assignee_id);

-- ------------------------------------------------------------- the stamp

create or replace function subtask_assignee_stamp()
returns trigger
language plpgsql
as $$
begin
  -- `is distinct from` rather than `<>`: a step going from unassigned to
  -- unassigned must not look like a change, and NULL comparisons would.
  if new.assignee_id is distinct from old.assignee_id then
    new.assigned_at := case when new.assignee_id is null then null else now() end;
  end if;
  return new;
end;
$$;

drop trigger if exists subtasks_assignee_stamp on subtasks;
create trigger subtasks_assignee_stamp
  before update on subtasks
  for each row execute function subtask_assignee_stamp();

-- ------------------------------------------------------------ row security
--
-- Nothing to do. `subtasks` already has RLS enabled and is covered by the
-- `0004_tighten_rls.sql` cutover, which scopes it through `is_task_member()`.
-- The new column inherits that policy — a column is not a security boundary.

-- -------------------------------------------------------------- realtime
--
-- Also nothing to do: `subtasks` is already published with a full replica
-- identity, so an UPDATE to this column reaches every subscriber, and
-- `replica identity full` is only strictly needed for deletes.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'subtasks'
  ) then
    begin
      alter publication supabase_realtime add table subtasks;
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end if;
end;
$$;

-- =====================================================================
-- Verify:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'subtasks'
--      and column_name in ('assignee_id', 'assigned_at');
-- Expected: both columns.
--
--   select t.key, s.text, m.name
--     from subtasks s
--     join tasks t on t.id = s.task_id
--     left join members m on m.id = s.assignee_id
--    order by t.key, s.position;
-- Expected: every step, with a name only where one has been assigned.
-- =====================================================================
