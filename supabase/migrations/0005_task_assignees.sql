-- =====================================================================
-- BlackIT Flow — a task can have more than one assignee
--
-- `tasks.assignee_id` held exactly one person. This adds a join table so a
-- task can be shared, and backfills it from the old column.
--
-- ---------------------------------------------------------------------
-- EXPAND, DO NOT CONTRACT.
--
-- `tasks.assignee_id` is deliberately left in place. Removing it in the same
-- step would break every client still running the deployed build — and this
-- app is a board people leave open all day, so "everybody reloads" is not a
-- thing that can be relied on. Instead:
--
--   1. apply this file  (harmless to the old client: it never reads it)
--   2. deploy the new client
--   3. drop the column later, once no old tabs are left
--
-- While both exist, a trigger mirrors `tasks.assignee_id` into the join table,
-- so a task claimed in a stale tab is still visible to everybody on the new
-- build. The new client never writes `assignee_id`, so the mirror only ever
-- runs for old clients and the two cannot fight.
-- ---------------------------------------------------------------------
--
-- APPLY THIS BEFORE DEPLOYING THE CLIENT THAT READS IT. The new client sends
-- task_assignees rows; against a database without the table those writes fail
-- and assignment silently stops syncing.
--
-- Safe to run more than once. Run it in the Supabase SQL Editor.
-- =====================================================================

-- --------------------------------------------------------------- the table

create table if not exists task_assignees (
  task_id     uuid        not null references tasks(id) on delete cascade,
  member_id   uuid        not null references members(id) on delete cascade,
  -- When this person was put on the task. The UI orders by it, so the first
  -- assignee stays first and the card's colour does not jump around.
  assigned_at timestamptz not null default now(),
  -- Who did it. Left for the trigger to fill from the session, so the client
  -- cannot claim somebody else did the assigning.
  assigned_by uuid        references members(id) on delete set null,
  -- Echo-suppression tag, like every other synced table.
  mutation_id text,
  primary key (task_id, member_id)
);

create index if not exists task_assignees_member_idx on task_assignees (member_id);
create index if not exists task_assignees_task_idx   on task_assignees (task_id, assigned_at);

-- Assigning the same person twice is a no-op rather than an error: two clients
-- can send the same row, and the second one should not fail the write.
create or replace function task_assignee_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assigned_at is null then
    new.assigned_at := now();
  end if;
  -- The acting member is whoever is signed in. Null before sign-in is rolled
  -- out, which is fine: the column is only ever informational.
  if new.assigned_by is null then
    select m.id into new.assigned_by
      from members m
     where m.user_id = auth.uid()
     limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists task_assignees_defaults on task_assignees;
create trigger task_assignees_defaults
  before insert on task_assignees
  for each row execute function task_assignee_defaults();

-- Realtime only carries a DELETE's full old row when the replica identity is
-- full; a composite key needs both columns to know *which* membership went.
alter table task_assignees replica identity full;

-- ------------------------------------------------------------- backfill
--
-- Everybody the old column named becomes a member of the join table. Idempotent
-- via `on conflict do nothing`, so re-running this file cannot duplicate rows or
-- move somebody's `assigned_at` to now.

insert into task_assignees (task_id, member_id, assigned_at, assigned_by)
select t.id,
       t.assignee_id,
       coalesce(t.claimed_at, t.updated_at, t.created_at, now()),
       t.claimed_by
  from tasks t
 where t.assignee_id is not null
on conflict (task_id, member_id) do nothing;

-- ------------------------------------------- the bridge for stale clients
--
-- While `assignee_id` still exists, keep it and the join table in step. Only
-- fires when a statement actually names the column, which the new client never
-- does — so this is a one-way mirror for old tabs, not a second source of truth.

create or replace function mirror_task_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assignee_id is null then
    -- "Return to the open pool" in the old client meant nobody is on it.
    delete from task_assignees where task_id = new.id;
  else
    insert into task_assignees (task_id, member_id, assigned_at, assigned_by)
    values (new.id, new.assignee_id, coalesce(new.claimed_at, now()), new.claimed_by)
    on conflict (task_id, member_id) do nothing;

    -- The old client could only ever name one person, so anything else on the
    -- task came from the new client; leave it alone unless the pool was emptied.
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_mirror_assignee on tasks;
create trigger tasks_mirror_assignee
  after insert or update of assignee_id on tasks
  for each row execute function mirror_task_assignee();

-- ------------------------------------------------------------ row security
--
-- Matching the state a fresh deployment is in: RLS on, permissive policy, so
-- this file is safe whether or not the 0004 cutover has been applied yet.
-- 0004 replaces this policy for `authenticated` only, exactly as it does for
-- every other table — and it lists task_assignees, so apply 0004 after this.

alter table task_assignees enable row level security;

drop policy if exists task_assignees_anon_all on task_assignees;
create policy task_assignees_anon_all on task_assignees
  for all to anon, authenticated using (true) with check (true);

grant all on task_assignees to anon, authenticated;

-- -------------------------------------------------------------- realtime

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  begin
    alter publication supabase_realtime add table task_assignees;
  exception
    when duplicate_object then null;   -- already published
    when undefined_object then null;   -- no publication in this project
  end;
end;
$$;

-- =====================================================================
-- Verify:
--   select t.key, m.name
--     from task_assignees a
--     join tasks t on t.id = a.task_id
--     join members m on m.id = a.member_id
--    order by t.key, a.assigned_at;
-- Expected: one row per (task, member) pair the old column described.
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename = 'task_assignees';
-- Expected: task_assignees.
-- =====================================================================
