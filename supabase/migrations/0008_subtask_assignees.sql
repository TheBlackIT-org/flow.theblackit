-- =====================================================================
-- BlackIT Flow — a subtask step can have more than one owner
--
-- `0006_subtask_assignee.sql` put a single `subtasks.assignee_id` on a step.
-- That was the wrong call: a step is often exactly the thing two people do
-- together ("pair on the empty state"), and there is no reason for a step to be
-- more exclusive than the task that contains it. Assignment becomes a join
-- table, the same shape as `task_assignees`.
--
-- ---------------------------------------------------------------------
-- EXPAND, DO NOT CONTRACT — the same pattern as 0005.
--
-- `subtasks.assignee_id` stays. A tab still running the previous build writes
-- it, and dropping the column underneath that tab would fail its writes. While
-- both exist, a trigger mirrors the old column into the join table, so a step
-- claimed in a stale tab is still visible to everybody on the new build.
-- The new client never writes `assignee_id`, so the mirror only ever runs for
-- old clients and the two cannot fight.
-- ---------------------------------------------------------------------
--
-- ADDITIVE. Apply before deploying the client that reads it. Safe to run more
-- than once.
-- =====================================================================

-- --------------------------------------------------------------- the table

create table if not exists subtask_assignees (
  subtask_id  uuid        not null references subtasks(id) on delete cascade,
  member_id   uuid        not null references members(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid        references members(id) on delete set null,
  mutation_id text,
  primary key (subtask_id, member_id)
);

create index if not exists subtask_assignees_member_idx on subtask_assignees (member_id);
create index if not exists subtask_assignees_subtask_idx on subtask_assignees (subtask_id, assigned_at);

-- The acting member and the timestamp, from the session rather than the
-- payload — the client neither tracks nor can forge either.
create or replace function subtask_assignee_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assigned_at is null then
    new.assigned_at := now();
  end if;
  if new.assigned_by is null then
    select m.id into new.assigned_by from members m where m.user_id = auth.uid() limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists subtask_assignees_defaults on subtask_assignees;
create trigger subtask_assignees_defaults
  before insert on subtask_assignees
  for each row execute function subtask_assignee_defaults();

-- A composite key needs both columns to identify the row a DELETE removed.
alter table subtask_assignees replica identity full;

-- ------------------------------------------------------------- backfill

insert into subtask_assignees (subtask_id, member_id, assigned_at, assigned_by)
select s.id,
       s.assignee_id,
       coalesce(s.assigned_at, now()),
       (select m.id from members m where m.user_id is not null and m.id = s.assignee_id limit 1)
  from subtasks s
 where s.assignee_id is not null
on conflict (subtask_id, member_id) do nothing;

-- ------------------------------------------- the bridge for stale clients

create or replace function mirror_subtask_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assignee_id is null then
    -- The old client could only name one person, so clearing it meant "nobody
    -- has this step"; anything else on the step came from the new client.
    delete from subtask_assignees where subtask_id = new.id;
  else
    insert into subtask_assignees (subtask_id, member_id, assigned_at, assigned_by)
    values (new.id, new.assignee_id, coalesce(new.assigned_at, now()), null)
    on conflict (subtask_id, member_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists subtasks_mirror_assignee on subtasks;
create trigger subtasks_mirror_assignee
  after insert or update of assignee_id on subtasks
  for each row execute function mirror_subtask_assignee();

-- ------------------------------------------------------ the notification
--
-- One notification per person who is put on a step, from the join table. The
-- trigger that watched the old column is dropped: the bridge above feeds this
-- one, so a stale tab still notifies and nobody is told twice.

create or replace function notify_subtask_assignees()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_key       text;
  v_text      text;
  v_actor     uuid := acting_member_id();
begin
  select p.workspace_id, t.key, s.text
    into v_workspace, v_key, v_text
    from subtasks s
    join tasks t on t.id = s.task_id
    join projects p on p.id = t.project_id
   where s.id = new.subtask_id;

  if v_workspace is null then
    return new;
  end if;
  if v_actor is not null and v_actor = new.member_id then
    return new;
  end if;

  insert into notifications
    (workspace_id, recipient_id, actor_id, actor_name, kind, task_id, task_key, summary)
  select v_workspace,
         new.member_id,
         v_actor,
         acting_member_name()::text,
         'subtask.assigned',
         t.id,
         coalesce(v_key, ''),
         coalesce(v_text, '')
    from tasks t
   where t.id = (select s.task_id from subtasks s where s.id = new.subtask_id);

  return new;
end;
$$;

drop trigger if exists subtask_assignees_notify on subtask_assignees;
create trigger subtask_assignees_notify
  after insert on subtask_assignees
  for each row execute function notify_subtask_assignees();

-- Superseded: notifications for steps now come from the join table.
drop trigger if exists subtasks_notify_assignment on subtasks;
drop function if exists notify_subtask_assignment();

-- ------------------------------------------------------------ row security
--
-- Permissive, to match the state a deployment is in before the
-- `0004_tighten_rls.sql` cutover, which drops this and scopes it per task.

alter table subtask_assignees enable row level security;

drop policy if exists subtask_assignees_anon_all on subtask_assignees;
create policy subtask_assignees_anon_all on subtask_assignees
  for all to anon, authenticated using (true) with check (true);

grant all on subtask_assignees to anon, authenticated;

-- -------------------------------------------------------------- realtime

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  begin
    alter publication supabase_realtime add table subtask_assignees;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;
end;
$$;

-- =====================================================================
-- Verify:
--   select t.key, s.text, m.name
--     from subtask_assignees a
--     join subtasks s on s.id = a.subtask_id
--     join tasks t on t.id = s.task_id
--     join members m on m.id = a.member_id
--    order by t.key, s.position, a.assigned_at;
-- Expected: one row per (step, member) pair, including anything the old
-- column described.
-- =====================================================================
