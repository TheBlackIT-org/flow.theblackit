-- =====================================================================
-- BlackIT Flow — notifications
--
-- An in-app bell. Nothing is emailed and no push service is involved: rows are
-- written here by triggers, streamed over Realtime to the one person they are
-- for, and read from the bell in the header.
--
-- ---------------------------------------------------------------------
-- WHY TRIGGERS AND NOT THE CLIENT
--
-- The client could write a notification row whenever it assigns somebody. It
-- must not:
--   * every open tab would write its own copy, so one assignment would arrive
--     four times for a team of four;
--   * an assignment made from a tab that is closed a second later would never
--     notify anybody, and that is exactly when notification matters most;
--   * the actor would be whatever the client claimed, which is not evidence.
-- A trigger runs once, in the database, in the same transaction as the change
-- it describes, and reads the actor from the session.
-- ---------------------------------------------------------------------
--
-- ADDITIVE. Apply it before deploying the client that reads the table.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
-- =====================================================================

-- --------------------------------------------------------------- the table

create table if not exists notifications (
  id           bigserial   primary key,
  workspace_id uuid        not null references workspaces(id) on delete cascade,
  -- Who it is for. Cascades: a removed member's bell goes with them.
  recipient_id uuid        not null references members(id) on delete cascade,
  -- Who did it. Null when nobody was signed in, which is the pre-sign-in case.
  actor_id     uuid        references members(id) on delete set null,
  actor_name   text        not null default '',
  -- 'task.assigned' | 'subtask.assigned' | 'task.status'
  kind         text        not null,
  task_id      uuid        references tasks(id) on delete cascade,
  task_key     text        not null default '',
  -- Free text for the row: the step that changed hands, or the new status.
  summary      text        not null default '',
  created_at   timestamptz not null default now(),
  -- Null means unread. A timestamp rather than a boolean, so "when did you see
  -- this" is answerable later.
  read_at      timestamptz,
  mutation_id  text
);

-- The bell reads one recipient's newest rows; the badge counts their unread.
create index if not exists notifications_recipient_idx
  on notifications (recipient_id, created_at desc);
create index if not exists notifications_unread_idx
  on notifications (recipient_id)
  where read_at is null;

-- ------------------------------------------------------------- the actor
--
-- Who is acting, from the session rather than from the payload. SECURITY
-- DEFINER so it can read `members` regardless of the caller's policies, and
-- stable so Postgres evaluates it once per statement.

create or replace function acting_member_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select m.id from members m where m.user_id = auth.uid() limit 1;
$$;

create or replace function acting_member_name()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(m.name, '') from members m where m.user_id = auth.uid() limit 1;
$$;

-- -------------------------------------------- somebody joined a task

create or replace function notify_task_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_key       text;
  v_actor     uuid := acting_member_id();
begin
  select p.workspace_id, t.key
    into v_workspace, v_key
    from tasks t
    join projects p on p.id = t.project_id
   where t.id = new.task_id;

  if v_workspace is null then
    return new;
  end if;

  -- Nobody needs telling about their own click.
  if v_actor is not null and v_actor = new.member_id then
    return new;
  end if;

  insert into notifications
    (workspace_id, recipient_id, actor_id, actor_name, kind, task_id, task_key, summary)
  values
    (v_workspace, new.member_id, v_actor, acting_member_name()::text, 'task.assigned',
     new.task_id, coalesce(v_key, ''), '');

  return new;
end;
$$;

drop trigger if exists task_assignees_notify on task_assignees;
create trigger task_assignees_notify
  after insert on task_assignees
  for each row execute function notify_task_assignment();

-- ---------------------------------------------- somebody got a step

create or replace function notify_subtask_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_key       text;
  v_actor     uuid := acting_member_id();
begin
  -- Only when a step actually lands on somebody. Unassigning is not news.
  if new.assignee_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id then
    return new;
  end if;

  select p.workspace_id, t.key
    into v_workspace, v_key
    from tasks t
    join projects p on p.id = t.project_id
   where t.id = new.task_id;

  if v_workspace is null then
    return new;
  end if;
  if v_actor is not null and v_actor = new.assignee_id then
    return new;
  end if;

  insert into notifications
    (workspace_id, recipient_id, actor_id, actor_name, kind, task_id, task_key, summary)
  values
    (v_workspace, new.assignee_id, v_actor, acting_member_name()::text, 'subtask.assigned',
     new.task_id, coalesce(v_key, ''), new.text);

  return new;
end;
$$;

drop trigger if exists subtasks_notify_assignment on subtasks;
create trigger subtasks_notify_assignment
  after insert or update of assignee_id on subtasks
  for each row execute function notify_subtask_assignment();

-- -------------------------------------- a task you are on changed state
--
-- Only the three states somebody else needs to know about. EVERY status change
-- would turn the bell into a firehose: a task moving to In Progress is not news
-- to the person who moved it, and the people on the task already see the board.
-- Blocked is a problem worth interrupting for, Done is the answer to "is it
-- ready", and In Review is the hand-off.

create or replace function notify_task_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_actor     uuid := acting_member_id();
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status not in ('BLOCK', 'REVIEW', 'DONE') then
    return new;
  end if;

  select p.workspace_id into v_workspace
    from projects p where p.id = new.project_id;
  if v_workspace is null then
    return new;
  end if;

  -- One row per person on the task, minus whoever moved it.
  insert into notifications
    (workspace_id, recipient_id, actor_id, actor_name, kind, task_id, task_key, summary)
  select v_workspace,
         a.member_id,
         v_actor,
         acting_member_name()::text,
         'task.status',
         new.id,
         new.key,
         new.status
    from task_assignees a
   where a.task_id = new.id
     and (v_actor is null or a.member_id <> v_actor);

  return new;
end;
$$;

drop trigger if exists tasks_notify_status on tasks;
create trigger tasks_notify_status
  after update of status on tasks
  for each row execute function notify_task_status();

-- ------------------------------------------------------------ row security
--
-- Permissive to match the state a deployment is in before the
-- `0004_tighten_rls.sql` cutover, which drops this policy and replaces it with
-- "you can read and mark read your own rows, and nothing else".

alter table notifications enable row level security;

drop policy if exists notifications_anon_all on notifications;
create policy notifications_anon_all on notifications
  for all to anon, authenticated using (true) with check (true);

grant all on notifications to anon, authenticated;
grant all on sequence notifications_id_seq to anon, authenticated;

-- -------------------------------------------------------------- realtime

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  begin
    alter publication supabase_realtime add table notifications;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;
end;
$$;

-- =====================================================================
-- Verify:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'notifications'
--    order by column_name;
--
--   -- Assign somebody (in the app, signed in as a different person), then:
--   select n.kind, m.name as recipient, n.actor_name, n.task_key, n.summary
--     from notifications n join members m on m.id = n.recipient_id
--    order by n.created_at desc limit 10;
-- Expected: one row per notification, and never a row whose recipient is the
-- person who made the change.
-- =====================================================================
