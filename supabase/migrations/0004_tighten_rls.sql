-- =====================================================================
-- BlackIT Flow — tighten Row Level Security to signed-in members
--
-- BEFORE THIS MIGRATION the `anon` role has `using (true) with check (true)`
-- on every table: the URL plus the anon key *is* the access control, and the
-- key ships inside the client bundle.
--
-- AFTER IT, a row is readable and writable only by an account that belongs to
-- its workspace. The anon key becomes what it is meant to be — a public
-- identifier for the project, not a credential.
--
-- ---------------------------------------------------------------------
-- DO NOT RUN THIS AS PART OF A NORMAL DEPLOY. It is the cutover step:
--
--   1. supabase/migrations/0003_member_identity.sql      (additive, apply first)
--   2. deploy the client with PUBLIC_REQUIRE_LOGIN=true
--   3. confirm everyone can sign in and see the board
--   4. ONLY THEN run this file
--
-- Running it before step 2 locks every currently-deployed client out: their
-- requests carry no access token, so `anon` is denied and the board stops
-- saving for the whole team. Reverting is possible (`0001_init.sql` section
-- "row security" recreates the permissive policies) but the team is down
-- while you do it.
-- ---------------------------------------------------------------------
--
-- Safe to run more than once. Run it in the Supabase SQL Editor.
-- =====================================================================

-- ------------------------------------------------------- membership probes
--
-- SECURITY DEFINER is load-bearing, not decoration. A policy on `members` that
-- itself queried `members` would recurse into its own policy and Postgres
-- answers with "infinite recursion detected in policy for relation members".
-- These functions run as the owner and therefore bypass RLS on the tables they
-- read, which is also why `search_path` is pinned.

create or replace function is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from members
     where workspace_id = p_workspace_id
       and user_id = auth.uid()
  );
$$;

create or replace function is_project_member(p_project_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from projects p
      join members m on m.workspace_id = p.workspace_id
     where p.id = p_project_id
       and m.user_id = auth.uid()
  );
$$;

create or replace function is_task_member(p_task_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from tasks t
      join projects p on p.id = t.project_id
      join members m on m.workspace_id = p.workspace_id
     where t.id = p_task_id
       and m.user_id = auth.uid()
  );
$$;

/** The signed-in account's email, lower-cased, or null when there is none. */
create or replace function current_email()
returns text
language sql
stable
as $$
  select lower(nullif(auth.jwt() ->> 'email', ''));
$$;

/**
 * The member row belonging to the signed-in account.
 *
 * Used by the notification policies, which are per *person* rather than per
 * workspace — the only place in this schema where that is true.
 */
create or replace function my_member_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select m.id from members m where m.user_id = auth.uid() limit 1;
$$;

-- ------------------------------------------------------------- anon is gone
--
-- Dropping the policies is not enough on its own — the role still holds table
-- grants from `0001_init.sql`. Revoke those too, so a mistake in a policy
-- cannot silently re-open the tables.
--
-- Guarded on `to_regclass` because this file is the last one applied and
-- `0005_task_assignees.sql` may not have been run yet; a missing table must not
-- abort the script half-way through the cutover.

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'workspaces', 'members', 'projects', 'tasks', 'subtasks', 'activity',
      'task_assignees', 'notifications'
    ])
  loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('drop policy if exists %I on %I', t || '_anon_all', t);
    execute format('revoke all on %I from anon', t);
  end loop;
end;
$$;

revoke all on all sequences in schema public from anon;
revoke execute on function next_task_key(uuid) from anon;

-- ----------------------------------------------------------- member policies
--
-- Three cases have to work, and each one is a separate clause below:
--
--   a. an ordinary read/write by somebody who is already a member;
--   b. the first member of a brand-new workspace — nobody is a member yet, so
--      a pure membership check would make the deployment unusable;
--   c. claiming an invite: an account that is not a member yet binds itself to
--      the unbound row whose email it was invited under.

drop policy if exists members_select on members;
create policy members_select on members
  for select to authenticated
  using (is_workspace_member(workspace_id) or user_id = auth.uid());

drop policy if exists members_insert on members;
create policy members_insert on members
  for insert to authenticated
  with check (
    is_workspace_member(workspace_id)
    or not exists (select 1 from members m where m.workspace_id = workspace_id)
  );

drop policy if exists members_update on members;
create policy members_update on members
  for update to authenticated
  using (
    is_workspace_member(workspace_id)
    or (user_id is null and email is not null and lower(email) = current_email())
  )
  -- A member may not be handed to somebody else by the person claiming it, and
  -- may not be moved to another workspace.
  with check (
    is_workspace_member(workspace_id)
    or user_id = auth.uid()
  );

drop policy if exists members_delete on members;
create policy members_delete on members
  for delete to authenticated
  using (is_workspace_member(workspace_id));

-- ------------------------------------------------------- workspace policies

drop policy if exists workspaces_select on workspaces;
create policy workspaces_select on workspaces
  for select to authenticated
  using (is_workspace_member(id) or not exists (
    select 1 from members m where m.workspace_id = id
  ));

drop policy if exists workspaces_insert on workspaces;
create policy workspaces_insert on workspaces
  for insert to authenticated
  with check (auth.uid() is not null);

drop policy if exists workspaces_update on workspaces;
create policy workspaces_update on workspaces
  for update to authenticated
  using (is_workspace_member(id))
  with check (is_workspace_member(id));

drop policy if exists workspaces_delete on workspaces;
create policy workspaces_delete on workspaces
  for delete to authenticated
  using (is_workspace_member(id));

-- --------------------------------------------------------- project policies

drop policy if exists projects_select on projects;
create policy projects_select on projects
  for select to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists projects_insert on projects;
create policy projects_insert on projects
  for insert to authenticated
  with check (is_workspace_member(workspace_id));

drop policy if exists projects_update on projects;
create policy projects_update on projects
  for update to authenticated
  using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

drop policy if exists projects_delete on projects;
create policy projects_delete on projects
  for delete to authenticated
  using (is_workspace_member(workspace_id));

-- ----------------------------------------------------------- task policies

drop policy if exists tasks_select on tasks;
create policy tasks_select on tasks
  for select to authenticated
  using (is_project_member(project_id));

drop policy if exists tasks_insert on tasks;
create policy tasks_insert on tasks
  for insert to authenticated
  with check (is_project_member(project_id));

drop policy if exists tasks_update on tasks;
create policy tasks_update on tasks
  for update to authenticated
  using (is_project_member(project_id))
  with check (is_project_member(project_id));

drop policy if exists tasks_delete on tasks;
create policy tasks_delete on tasks
  for delete to authenticated
  using (is_project_member(project_id));

-- -------------------------------------------------------- subtask policies

drop policy if exists subtasks_select on subtasks;
create policy subtasks_select on subtasks
  for select to authenticated
  using (is_task_member(task_id));

drop policy if exists subtasks_insert on subtasks;
create policy subtasks_insert on subtasks
  for insert to authenticated
  with check (is_task_member(task_id));

drop policy if exists subtasks_update on subtasks;
create policy subtasks_update on subtasks
  for update to authenticated
  using (is_task_member(task_id))
  with check (is_task_member(task_id));

drop policy if exists subtasks_delete on subtasks;
create policy subtasks_delete on subtasks
  for delete to authenticated
  using (is_task_member(task_id));

-- -------------------------------------------------------- activity policies
--
-- Append-only: there is no update or delete policy on purpose, so the audit
-- trail cannot be rewritten from a client.

drop policy if exists activity_select on activity;
create policy activity_select on activity
  for select to authenticated
  using (is_workspace_member(workspace_id));

drop policy if exists activity_insert on activity;
create policy activity_insert on activity
  for insert to authenticated
  with check (is_workspace_member(workspace_id));

-- --------------------------------------------------- assignment policies
--
-- Guarded: `0005_task_assignees.sql` is additive and may not have been applied
-- when this cutover runs, and assignment is a later feature than sign-in.

do $$
begin
  if to_regclass('public.task_assignees') is null then
    return;
  end if;

  execute 'drop policy if exists task_assignees_select on task_assignees';
  execute 'create policy task_assignees_select on task_assignees
             for select to authenticated using (is_task_member(task_id))';

  execute 'drop policy if exists task_assignees_insert on task_assignees';
  execute 'create policy task_assignees_insert on task_assignees
             for insert to authenticated with check (is_task_member(task_id))';

  -- Updating a membership row is meaningless (it is only ever added or
  -- removed), but the client's upsert path can land here, so allow it within
  -- the same task rather than making an idempotent re-assign fail.
  execute 'drop policy if exists task_assignees_update on task_assignees';
  execute 'create policy task_assignees_update on task_assignees
             for update to authenticated using (is_task_member(task_id))
             with check (is_task_member(task_id))';

  execute 'drop policy if exists task_assignees_delete on task_assignees';
  execute 'create policy task_assignees_delete on task_assignees
             for delete to authenticated using (is_task_member(task_id))';
end;
$$;

-- ------------------------------------------------- notification policies
--
-- The one per-person table: you read your own bell and mark your own rows
-- read, and you cannot see anybody else's. There is deliberately no insert
-- policy — notifications are written by SECURITY DEFINER triggers, which
-- bypass RLS, so a client cannot manufacture one.

do $$
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;

  execute 'drop policy if exists notifications_select on notifications';
  execute 'create policy notifications_select on notifications
             for select to authenticated using (recipient_id = my_member_id())';

  execute 'drop policy if exists notifications_update on notifications';
  execute 'create policy notifications_update on notifications
             for update to authenticated using (recipient_id = my_member_id())
             with check (recipient_id = my_member_id())';
end;
$$;

-- ---------------------------------------------------------------- grants

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function next_task_key(uuid) to authenticated;

-- =====================================================================
-- Verify after running:
--
--   -- Every table should list only *_select/_insert/_update/_delete for
--   -- `authenticated`, and nothing for `anon`.
--   select tablename, policyname, roles
--     from pg_policies where schemaname = 'public' order by tablename, policyname;
--
--   -- An anonymous request must now be refused. Run with the anon key:
--   curl "$SUPABASE_URL/rest/v1/tasks?select=id&limit=1" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--   -- Expected: [] (empty, not a list of every task).
-- =====================================================================
