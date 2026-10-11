-- =====================================================================
-- BlackIT Flow — initial schema
--
-- Internal team tool, no authentication: the client talks to PostgREST with
-- the anon key and Row Level Security grants the `anon` role full access.
--
-- The URL + anon key are therefore the only thing protecting this data.
-- Do not publish them outside the team.
--
-- Run this in the Supabase dashboard → SQL Editor → New query → Run.
-- It is idempotent: running it twice is safe.
-- =====================================================================

-- ---------------------------------------------------------------- tables

create table if not exists workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  mode       text        not null default 'live',
  created_at timestamptz not null default now()
);

create table if not exists members (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid        not null references workspaces(id) on delete cascade,
  name         text        not null,
  role         text        not null default 'member',
  title        text        not null default '',
  is_agent     boolean     not null default false,
  -- Unused while there is no sign-in. Exists so adding auth later needs no
  -- migration of live data, only a policy change.
  user_id      uuid,
  -- Echo-suppression tag: every synced table carries one so a client can
  -- recognise (and ignore) the realtime echo of its own write.
  mutation_id  text,
  created_at   timestamptz not null default now()
);

create table if not exists projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid        not null references workspaces(id) on delete cascade,
  key          text        not null,
  name         text        not null,
  product      text        not null default '',
  -- Server-side sequence for task keys, so two people creating a task at the
  -- same moment cannot both be handed NE-8.
  task_counter integer     not null default 0,
  mutation_id  text,
  created_at   timestamptz not null default now()
);

create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid        not null references projects(id) on delete cascade,
  key          text        not null,
  position     integer     not null default 0,
  title        text        not null,
  description  text        not null default '',
  stage        text        not null default 'New',
  status       text        not null default 'TODO',
  type_id      text        not null default 'tt3',
  priority     text        not null default 'normal',
  estimate     integer     not null default 3,
  assignee_id  uuid        references members(id) on delete set null,
  due_at       timestamptz,
  depends_on   text[]      not null default '{}',
  created_by   uuid        references members(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  claimed_by   uuid        references members(id) on delete set null,
  claimed_at   timestamptz,
  completed_at timestamptz,
  -- Set by the client that made the change. Other clients use it to recognise
  -- and ignore the echo of a write they already applied locally.
  mutation_id  text
);

create table if not exists subtasks (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid    not null references tasks(id) on delete cascade,
  text        text    not null,
  done        boolean not null default false,
  position    integer not null default 0,
  -- Same echo-suppression tag the tasks table carries.
  mutation_id text
);

-- Append-only trail: survives refreshes, so it doubles as the audit log the
-- browser-only version never had.
create table if not exists activity (
  id           bigserial primary key,
  workspace_id uuid        not null references workspaces(id) on delete cascade,
  actor_id     uuid,
  actor_name   text        not null default '',
  action       text        not null,
  task_key     text        not null default '',
  summary      text        not null default '',
  mutation_id  text,
  created_at   timestamptz not null default now()
);

-- --------------------------------------------------------------- indexes

create index if not exists members_workspace_idx   on members (workspace_id);
create index if not exists projects_workspace_idx  on projects (workspace_id);
create index if not exists tasks_project_pos_idx   on tasks (project_id, position);
create index if not exists tasks_assignee_idx      on tasks (assignee_id);
create index if not exists subtasks_task_pos_idx   on subtasks (task_id, position);
create index if not exists activity_workspace_idx  on activity (workspace_id, created_at desc);

-- ------------------------------------------------- task key generation

-- Atomically reserve the next key for a project: NE-1, NE-2, …
--
-- Self-healing: it also refuses to return a key that already exists. Without
-- this, seeding a project whose tasks are NE-1…NE-15 while task_counter is
-- still 0 would hand the next task a duplicate NE-1, and keep doing so.
create or replace function next_task_key(p_project_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key      text;
  v_counter  integer;
  v_candidate text;
  v_highest  integer;
begin
  update projects
     set task_counter = task_counter + 1
   where id = p_project_id
  returning key, task_counter into v_key, v_counter;

  if v_key is null then
    raise exception 'project % does not exist', p_project_id;
  end if;

  v_candidate := v_key || '-' || v_counter;

  -- Already taken? Jump past the highest suffix this project has used.
  if exists (select 1 from tasks where project_id = p_project_id and key = v_candidate) then
    select coalesce(max((regexp_match(key, '-(\d+)$'))[1]::integer), 0)
      into v_highest
      from tasks
     where project_id = p_project_id;

    v_counter := greatest(v_highest, v_counter) + 1;

    update projects set task_counter = v_counter where id = p_project_id;
    v_candidate := v_key || '-' || v_counter;
  end if;

  return v_candidate;
end;
$$;

-- Bump updated_at on every write so clients can order events.
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_touch_updated_at on tasks;
create trigger tasks_touch_updated_at
  before update on tasks
  for each row execute function touch_updated_at();

-- --------------------------------------------------------- row security
--
-- RLS is ON, with a permissive policy for the anon role. It is deliberately
-- permissive because this deployment has no sign-in; the point of enabling it
-- rather than disabling it is that tightening to real accounts later becomes a
-- change of policy, not a change of schema or client.

alter table workspaces enable row level security;
alter table members    enable row level security;
alter table projects   enable row level security;
alter table tasks      enable row level security;
alter table subtasks   enable row level security;
alter table activity   enable row level security;

do $$
declare
  t text;
begin
  for t in
    select unnest(array['workspaces', 'members', 'projects', 'tasks', 'subtasks', 'activity'])
  loop
    execute format('drop policy if exists %I on %I', t || '_anon_all', t);
    execute format(
      'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end;
$$;

-- -------------------------------------------------------------- realtime
--
-- Realtime only broadcasts rows from tables that are in this publication, and
-- a DELETE only carries the primary key unless the replica identity is full.

alter table tasks     replica identity full;
alter table subtasks  replica identity full;
alter table projects  replica identity full;
alter table members   replica identity full;
-- `activity` is append-only and read with a fetch, so it keeps the default
-- identity: nothing needs its old row values.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  for t in
    select unnest(array['tasks', 'subtasks', 'projects', 'members', 'activity'])
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- grants

grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant execute on function next_task_key(uuid) to anon, authenticated;

-- =====================================================================
-- Done. Verify with:
--   select tablename from pg_publication_tables where pubname = 'supabase_realtime';
--   select key, task_counter from projects;
-- =====================================================================
