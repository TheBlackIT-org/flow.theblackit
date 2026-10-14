/**
 * Supabase repository: shared Postgres + Realtime.
 *
 * Design notes that matter:
 *
 *  - `load()` reads a whole workspace snapshot once.
 *  - `flush()` diffs against the last synced snapshot and writes only the rows
 *    that actually changed, so an edit is a handful of upserts rather than a
 *    rewrite of every task.
 *  - Every write is tagged with a `mutation_id`. The origin client ignores the
 *    echo of its own write; other clients apply it. This is what stops a
 *    remote event from stomping on local typing.
 *  - Reordering rewrites the `position` of several rows, so it is not treated
 *    as an incremental event: the app resyncs instead.
 */

import { createClient } from '@supabase/supabase-js';
import { emptyWorkspace } from '../domain';
import type { AuthUser, Member, Subtask, Task, Workspace } from '../types';
import {
  iso,
  memberFromRow,
  ms,
  memberToRow,
  projectFromRow,
  projectToRow,
  str,
  strOrNull,
  subtaskFromRow,
  subtaskToRow,
  taskAssigneeToRow,
  taskFromRow,
  taskToRow,
  type Row,
} from './mappers';
import type {
  ActivityEntry,
  ActivityRecord,
  PresencePeer,
  SubscribeHandlers,
  WorkspaceRepository,
} from './types';

const ACTIVITY_LIMIT = 40;
/** Subset of a `Workspace` that is stored server-side. */
const TABLES = ['members', 'projects', 'tasks', 'subtasks', 'task_assignees', 'activity'] as const;
/** Tables the realtime channel listens to. */
const SYNCED_TABLES = ['tasks', 'subtasks', 'projects', 'members', 'task_assignees', 'activity'] as const;

/* --------------------------------- helpers -------------------------------- */

const stable = (value: unknown): string => JSON.stringify(value ?? null);

/* -------------------------------- repository ------------------------------- */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  /** Browsers remember which project they were last looking at. */
  activeProjectStorageKey?: string;
  /**
   * Test seam: supply a stand-in for the Supabase client. Production always
   * builds the real one from the URL and anon key.
   */
  client?: SupabaseLikeClient;
}

/** The slice of the Supabase client this repository actually uses. */
export interface SupabaseLikeClient {
  from(table: string): SupabaseLikeQuery;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: SupabaseError | null }>;
  channel(name: string, opts?: unknown): SupabaseLikeChannel;
  removeChannel(channel: unknown): PromiseLike<unknown>;
}

export interface SupabaseError {
  message: string;
}

export interface SupabaseLikeResult {
  data: unknown;
  error: SupabaseError | null;
}

/** PostgREST is chainable: every builder method returns the same object. */
export interface SupabaseLikeQuery extends PromiseLike<SupabaseLikeResult> {
  select(columns?: string): SupabaseLikeQuery;
  insert(values: unknown): SupabaseLikeQuery;
  upsert(values: unknown): SupabaseLikeQuery;
  update(values: unknown): SupabaseLikeQuery;
  delete(): SupabaseLikeQuery;
  eq(column: string, value: unknown): SupabaseLikeQuery;
  in(column: string, values: unknown[]): SupabaseLikeQuery;
  /** `column is null` — PostgREST cannot express that with `eq`. */
  is(column: string, value: unknown): SupabaseLikeQuery;
  order(column: string, opts?: unknown): SupabaseLikeQuery;
  limit(count: number): SupabaseLikeQuery;
  single(): SupabaseLikeQuery;
}

export interface SupabaseLikeChannel {
  on(type: string, filter: unknown, cb: (payload: unknown) => void): SupabaseLikeChannel;
  subscribe(cb: (status: string) => void): SupabaseLikeChannel;
  track(payload: Record<string, unknown>): PromiseLike<unknown>;
  presenceState(): Record<string, Array<Record<string, unknown>>>;
}

export class SupabaseRepository implements WorkspaceRepository {
  readonly kind = 'supabase' as const;
  private readonly client: SupabaseLikeClient;
  private workspaceId: string | null = null;
  /**
   * True when the backend answered but its schema is absent. `load()` cannot
   * simply throw here — returning "no workspace" is a legitimate result for a
   * fresh project — so the two cases are reported separately.
   */
  private schemaMissing = false;
  /** Last state written to / read from the server, for diffing. */
  private synced: Workspace | null = null;
  private activeProjectKey: string;
  /** Set while a flush is in flight so bursts collapse into one write. */
  private flushChain: Promise<void> = Promise.resolve();
  private activity: ActivityRecord[] = [];
  private nextActivityId = 1;

  constructor(config: SupabaseConfig) {
    this.client =
      config.client ??
      (createClient(config.url, config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 20 } },
      }) as unknown as SupabaseLikeClient);
    this.activeProjectKey = config.activeProjectStorageKey ?? 'blackit_flow_active_project';
  }

  /** The active project choice is per browser, not shared. */
  private readActiveProject(): string | null {
    try {
      return localStorage.getItem(this.activeProjectKey);
    } catch {
      return null;
    }
  }

  private writeActiveProject(id: string): void {
    try {
      localStorage.setItem(this.activeProjectKey, id);
    } catch {
      /* ignore */
    }
  }

  /** Resolve (and cache) which workspace this browser is working in. */
  private async ensureWorkspaceId(): Promise<string | null> {
    if (this.workspaceId) return this.workspaceId;
    const { data, error } = await this.client
      .from('workspaces')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      // A project whose migration has not been applied answers with a generic
      // PostgREST error. Treat that as "no workspace yet" so the first write
      // can create one; anything else (auth, network) is a real failure.
      if (isMissingSchemaError(error.message)) {
        console.warn(
          'BlackIT Flow: the database schema is missing. Run supabase/migrations/0001_init.sql. ',
          error.message,
        );
        this.schemaMissing = true;
        return null;
      }
      throw new Error(`Could not read workspaces: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{ id?: string }>;
    const id = rows[0]?.id ?? null;
    this.workspaceId = id;
    // A successful read proves the schema is there.
    this.schemaMissing = false;
    return id;
  }

  /**
   * Create the single shared workspace row. Runs once, on the first write to a
   * fresh project; every later write reuses the id.
   */
  private async createWorkspace(): Promise<string> {
    const { data, error } = await this.client
      .from('workspaces')
      .insert({ name: 'BlackIT Flow', mode: 'live' })
      .select('id')
      .single();
    if (error || !data) {
      throw new Error(`Could not create the shared workspace: ${error?.message ?? 'no row returned'}`);
    }
    const id = (data as { id: string }).id;
    this.workspaceId = id;
    return id;
  }

  /**
   * Create the workspace row, then seed projects/members/tasks.
   *
   * The task counter is set from the number of tasks each project holds. Doing
   * it here (rather than in `flush`) means a seeded project's sequence starts
   * after its existing keys instead of at zero — otherwise the first new task
   * would collide with `NE-1`.
   */
  async bootstrap(ws: Workspace, name: string): Promise<Workspace> {
    const seeded: Workspace = {
      ...ws,
      mode: 'live',
      setup: true,
      projects: ws.projects.map((p) => ({
        ...p,
        taskCounter: ws.tasks.filter((t) => t.projectId === p.id).length,
      })),
    };
    this.synced = null; // force the first flush to write everything
    await this.flush(seeded, 'bootstrap');
    const stored = await this.load();
    return stored ?? seeded;
  }

  /**
   * Empty the shared workspace.
   *
   * Children first: tasks reference projects, subtasks reference tasks, so
   * deleting a parent first would be rejected by the foreign keys. PostgREST
   * also refuses an unfiltered DELETE, hence the always-true predicate.
   */
  async clear(): Promise<void> {
    const id = await this.ensureWorkspaceId();
    if (id) {
      const projectIds = (
        await this.client.from('projects').select('id').eq('workspace_id', id)
      ).data as Array<{ id: string }> | null;
      const taskIds = projectIds?.length
        ? ((
            await this.client
              .from('tasks')
              .select('id')
              .in('project_id', projectIds.map((p) => p.id))
          ).data as Array<{ id: string }> | null)
        : [];

      if (taskIds?.length) {
        const ids = taskIds.map((t) => t.id);
        await this.assert('subtasks', this.client.from('subtasks').delete().in('task_id', ids));
      }
      if (projectIds?.length) {
        await this.assert(
          'tasks',
          this.client.from('tasks').delete().in('project_id', projectIds.map((p) => p.id)),
        );
      }
      await this.assert('activity', this.client.from('activity').delete().eq('workspace_id', id));
      await this.assert('projects', this.client.from('projects').delete().eq('workspace_id', id));
      await this.assert('members', this.client.from('members').delete().eq('workspace_id', id));
    }
    if (id) {
      await this.assert('workspaces', this.client.from('workspaces').delete().eq('id', id));
    }

    // The next load must see an empty database, not the cached snapshot.
    this.synced = null;
    this.workspaceId = null;
  }

  /* ------------------------------- load ------------------------------ */

  async load(): Promise<Workspace | null> {
    const id = await this.ensureWorkspaceId();
    if (!id) return null;

    const [members, projects, tasks, subtasks, assignees] = await Promise.all([
      this.client.from('members').select('*').eq('workspace_id', id),
      this.client.from('projects').select('*').eq('workspace_id', id),
      this.client.from('tasks').select('*').order('position', { ascending: true }),
      this.client.from('subtasks').select('*').order('position', { ascending: true }),
      this.client.from('task_assignees').select('*'),
    ]);

    const firstError = [members, projects, tasks, subtasks, assignees].find((r) => r.error)?.error;
    if (firstError) throw new Error(`Could not read the workspace: ${firstError.message}`);

    const memberRows = (members.data ?? []) as Row[];
    const projectRows = (projects.data ?? []) as Row[];
    const taskRows = (tasks.data ?? []) as Row[];
    const subtaskRows = (subtasks.data ?? []) as Row[];
    const assigneeRows = (assignees.data ?? []) as Row[];

    // The workspace is genuinely empty: create it and return what we seeded.
    void id;
    const projectIds = new Set(projectRows.map((p) => str(p.id)));
    const scopedTasks = taskRows.filter((t) => projectIds.has(str(t.project_id)));
    const taskIds = new Set(scopedTasks.map((t) => str(t.id)));

    const byTask = new Map<string, Subtask[]>();
    subtaskRows
      .filter((s) => taskIds.has(str(s.task_id)))
      .forEach((s) => {
        const list = byTask.get(str(s.task_id)) ?? [];
        list.push(subtaskFromRow(s));
        byTask.set(str(s.task_id), list);
      });

    // Assignment is a join table: a task's people are every row naming it, and
    // rows for tasks outside this workspace's projects are ignored. `assigned_at`
    // orders them, so the first person to be put on a task stays first — which
    // is what the card shows and what its colour is derived from.
    const byTaskAssignees = new Map<string, Array<{ memberId: string; at: number }>>();
    assigneeRows
      .filter((a) => taskIds.has(str(a.task_id)))
      .forEach((a) => {
        const list = byTaskAssignees.get(str(a.task_id)) ?? [];
        list.push({ memberId: str(a.member_id), at: ms(a.assigned_at) ?? 0 });
        byTaskAssignees.set(str(a.task_id), list);
      });

    // `taskRows` arrives ordered by `position` (the query asks for it), and
    // scopedTasks preserves that order. Renumber the cached positions to match
    // array order per project: if the stored positions disagreed with the sort
    // order — legacy rows, or several clients writing at once — a drag would
    // otherwise compare equal and never be persisted.
    const tasksOut: Task[] = scopedTasks.map((row) => {
      const task = taskFromRow(row);
      task.subs = byTask.get(task.id) ?? [];
      task.assigneeIds = (byTaskAssignees.get(task.id) ?? [])
        .sort((a, b) => a.at - b.at)
        .map((a) => a.memberId);
      return task;
    });
    const counters = new Map<string, number>();
    tasksOut.forEach((task) => {
      const next = counters.get(task.projectId) ?? 0;
      task.position = next;
      counters.set(task.projectId, next + 1);
    });

    const storedActive = this.readActiveProject();
    const projectId =
      storedActive && projectRows.some((p) => str(p.id) === storedActive)
        ? storedActive
        : (projectRows[0] ? str(projectRows[0].id) : null);

    const ws: Workspace = {
      ...emptyWorkspace(),
      mode: 'live',
      setup: true,
      workspaceId: id,
      members: memberRows.map(memberFromRow),
      projects: projectRows.map(projectFromRow),
      tasks: tasksOut,
      projectId,
      me: memberRows[0] ? str(memberRows[0].id) : null,
    };

    this.synced = clone(ws);
    return ws;
  }

  /* ------------------------------- flush ----------------------------- */

  async flush(ws: Workspace, mutationId: string): Promise<void> {
    // Serialise flushes so two rapid edits cannot interleave their diffs.
    const run = this.flushChain.then(() => this.doFlush(ws, mutationId));
    this.flushChain = run.catch(() => {});
    return run;
  }

  private async doFlush(ws: Workspace, mutationId: string): Promise<void> {
    try {
      await this.writeOnce(ws, mutationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The workspace this client is writing to no longer exists — a reset in
      // another tab, or an offline client that was mid-write. Drop the cached
      // id and let the next attempt create a fresh workspace, otherwise every
      // write fails until someone reloads the page.
      if (!isForeignKeyViolation(message)) throw error;
      console.warn('BlackIT Flow: the shared workspace was deleted; creating a new one.');
      this.workspaceId = null;
      ws.workspaceId = null;
      this.synced = null;
      await this.writeOnce(ws, mutationId);
    }
  }

  private async writeOnce(ws: Workspace, mutationId: string): Promise<void> {
    // A brand-new project has no workspace row yet, so the very first write
    // creates it before anything can reference it.
    const id = ws.workspaceId ?? this.workspaceId ?? (await this.ensureWorkspaceId()) ?? (await this.createWorkspace());
    this.workspaceId = id;
    ws.workspaceId = id;
    const prev = this.synced;
    const tag = { mutation_id: mutationId };

    const nextProjects = index(ws.projects);
    const nextMembers = index(ws.members);
    const nextTasks = index(ws.tasks);
    const nextSubs = index(ws.tasks.flatMap((t) => t.subs));
    const taskPosition = new Map(ws.tasks.map((t, i) => [t.id, i]));
    const subPosition = new Map(
      ws.tasks.flatMap((t) => t.subs.map((s, i) => [s.id, i] as const)),
    );
    // Which subtask belonged to which task *before* this edit. Reading it from
    // the new state instead would drop exactly the subtasks that were deleted,
    // since a removed subtask has no owner to look up any more.
    const prevTaskOfSub = new Map(
      (prev?.tasks ?? []).flatMap((t) => t.subs.map((s) => [s.id, t.id] as const)),
    );

    const prevProjects = index(prev?.projects ?? []);
    const prevMembers = index(prev?.members ?? []);
    const prevTasks = index(prev?.tasks ?? []);
    const prevSubs = index(prev?.tasks.flatMap((t) => t.subs) ?? []);

    /* ---- members & projects: small tables, upsert whole rows ---- */
    const memberRows = [...nextMembers.values()]
      .filter((m) => stable(memberToRow(m, id)) !== stable(prevMembers.get(m.id) ? memberToRow(prevMembers.get(m.id)!, id) : null))
      .map((m) => ({ ...memberToRow(m, id), ...tag }));
    if (memberRows.length) await this.assert('members', this.client.from('members').upsert(memberRows));

    const projectRows = [...nextProjects.values()]
      .map((p) => {
        const before = prevProjects.get(p.id);
        // `isNew` decides whether an unknown counter is sent as 0: the column
        // is NOT NULL, so an insert without it is rejected outright.
        return { row: projectToRow(p, id, !before), before };
      })
      .filter(({ row, before }) => stable(row) !== stable(before ? projectToRow(before, id) : null))
      .map(({ row }) => ({ ...row, ...tag }));
    if (projectRows.length) await this.assert('projects', this.client.from('projects').upsert(projectRows));

    /* ---- tasks ---- */
    // The comparison value for a task includes its array index, so a reorder
    // is detected even though the domain does not maintain `position` itself.
    const prevPosition = new Map((prev?.tasks ?? []).map((t, i) => [t.id, i]));
    const taskRows = ws.tasks
      .map((t) => taskToRow(t, taskPosition.get(t.id) ?? 0))
      .filter((row) => {
        const before = prevTasks.get(str(row.id));
        return stable(row) !== stable(before ? taskToRow(before, prevPosition.get(before.id) ?? 0) : null);
      })
      .map((row) => ({ ...row, ...tag }));
    if (taskRows.length) await this.assert('tasks', this.client.from('tasks').upsert(taskRows));

    /* ---- subtasks ---- */
    const subRows = ws.tasks
      .flatMap((t) => t.subs.map((s) => subtaskToRow(s, t.id, subPosition.get(s.id) ?? 0)))
      .filter((row) => stable(row) !== stable(prevSubs.get(str(row.id)) ? subtaskToRow(prevSubs.get(str(row.id))!, str(row.task_id), subPosition.get(str(row.id)) ?? 0) : null))
      .map((row) => ({ ...row, ...tag }));
    if (subRows.length) await this.assert('subtasks', this.client.from('subtasks').upsert(subRows));

    /* ---- task ⇄ member assignment ---- */
    // Membership is the whole row, so it is only ever inserted or deleted —
    // never merged. Comparing `task|member` strings against the last synced
    // snapshot is therefore enough to find both halves of the diff.
    const key = (taskId: string, memberId: string) => `${taskId}|${memberId}`;
    const prevAssigneeKeys = new Set(
      (prev?.tasks ?? []).flatMap((t) => t.assigneeIds.map((m) => key(t.id, m))),
    );
    const nextAssigneeKeys = new Set(ws.tasks.flatMap((t) => t.assigneeIds.map((m) => key(t.id, m))));

    const addedAssignees = ws.tasks.flatMap((t) =>
      t.assigneeIds
        .filter((m) => !prevAssigneeKeys.has(key(t.id, m)))
        .map((m) => ({ ...taskAssigneeToRow({ taskId: t.id, memberId: m }), ...tag })),
    );
    if (addedAssignees.length) {
      await this.assert('task_assignees', this.client.from('task_assignees').upsert(addedAssignees));
    }

    // Removals are grouped per task. A single `in` over both columns would be a
    // cross product and would delete pairs that are still wanted — e.g. moving
    // somebody from one task to another would remove them from both.
    const removals = new Map<string, string[]>();
    (prev?.tasks ?? []).forEach((t) => {
      const gone = t.assigneeIds.filter((m) => !nextAssigneeKeys.has(key(t.id, m)));
      // If the task itself is gone the foreign key cascade already cleared it.
      if (gone.length && nextTasks.has(t.id)) removals.set(t.id, gone);
    });
    for (const [taskId, memberIds] of removals) {
      await this.assert(
        'task_assignees',
        this.client.from('task_assignees').delete().eq('task_id', taskId).in('member_id', memberIds),
      );
    }

    /* ---- deletions, deepest first ---- */
    const goneSubs = [...prevSubs.keys()].filter((sid) => {
      if (nextSubs.has(sid)) return false;
      // If its parent task also went, the foreign key cascade already removed
      // it; deleting again would be a wasted round trip.
      const parent = prevTaskOfSub.get(sid);
      return parent === undefined || nextTasks.has(parent);
    });
    if (goneSubs.length) await this.assert('subtasks', this.client.from('subtasks').delete().in('id', goneSubs));

    const goneTasks = [...prevTasks.keys()].filter((tid) => !nextTasks.has(tid));
    if (goneTasks.length) await this.assert('tasks', this.client.from('tasks').delete().in('id', goneTasks));

    const goneProjects = [...prevProjects.keys()].filter((pid) => !nextProjects.has(pid));
    if (goneProjects.length)
      await this.assert('projects', this.client.from('projects').delete().in('id', goneProjects));

    const goneMembers = [...prevMembers.keys()].filter((mid) => !nextMembers.has(mid));
    if (goneMembers.length)
      await this.assert('members', this.client.from('members').delete().in('id', goneMembers));

    // The server is now the same as what we hold.
    this.synced = clone(ws);
  }

  private async assert(label: string, result: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
    const { error } = await result;
    if (error) throw new Error(`${label} write failed: ${error.message}`);
  }

  /* ------------------------------- keys ------------------------------ */

  /**
   * Reserve the next key. Must be awaited *before* the task object is built,
   * otherwise the row would be written with a stale key.
   */
  async nextTaskKey(projectId: string, fallback: () => string): Promise<string> {
    const { data, error } = await this.client.rpc('next_task_key', { p_project_id: projectId });
    if (error || !data) {
      // Older deployments without the function still work, just less safely.
      console.warn('next_task_key unavailable, falling back to a client-side count', error?.message);
      return fallback();
    }
    return String(data);
  }

  /* ------------------------------ identity --------------------------- */

  /**
   * Bind a signed-in account to its member row.
   *
   * The row is found two ways, in order of authority:
   *   1. it already names this account (`user_id`), so a returning teammate
   *      signs straight back in even if they changed their email;
   *   2. it is an unclaimed invite whose `email` matches, and claiming writes
   *      `user_id` back so every later sign-in takes path 1.
   *
   * Matching happens here rather than in SQL because `email` may not exist yet
   * on a deployment that has not run `0003_member_identity.sql`, and a failed
   * `ilike` would be indistinguishable from "no invite". Reading the unclaimed
   * rows and comparing in JS can tell those two cases apart, and says so.
   */
  async linkAccount(user: AuthUser): Promise<Member | null> {
    const id = this.workspaceId ?? (await this.ensureWorkspaceId());
    // No workspace yet: this account is the first one through the door. The
    // setup wizard creates the owner row and binds it, so there is nothing to
    // link to here.
    if (!id) return null;

    const bound = await this.client
      .from('members')
      .select('*')
      .eq('workspace_id', id)
      .eq('user_id', user.id)
      .limit(1);
    if (bound.error) throw new Error(`Could not read your member row: ${bound.error.message}`);
    const boundRow = ((bound.data ?? []) as Row[])[0];
    if (boundRow) return memberFromRow(boundRow);

    const email = (user.email ?? '').trim().toLowerCase();
    if (!email) return null;

    const open = await this.client
      .from('members')
      .select('*')
      .eq('workspace_id', id)
      .is('user_id', null);
    if (open.error) throw new Error(`Could not read the team: ${open.error.message}`);
    const openRows = (open.data ?? []) as Row[];

    // PostgREST omits a column that does not exist, so its absence on rows that
    // clearly exist means the identity migration has not been applied. Without
    // this check the app would report "you are not invited", which is wrong and
    // sends the person asking an owner for an invite they already have.
    if (openRows.length && !openRows.some((row) => 'email' in row)) {
      throw new Error(
        'This database has no members.email column yet. Run supabase/migrations/0003_member_identity.sql, then reload.',
      );
    }

    const match = openRows.find((row) => str(row.email).trim().toLowerCase() === email);
    if (!match) return null;

    const claimed = await this.client
      .from('members')
      .update({ user_id: user.id })
      .eq('id', str(match.id));
    if (claimed.error) throw new Error(`Could not claim your invite: ${claimed.error.message}`);

    return memberFromRow({ ...match, user_id: user.id });
  }

  /**
   * The one-time bootstrap for a workspace that predates sign-in.
   *
   * Those member rows have names but no email, so there is nothing for
   * `linkAccount` to match and every teammate would be locked out. While
   * *nobody* in the workspace is bound, an account may claim one row by
   * choosing its name. The guard is re-checked here rather than trusted from
   * the UI, and the update itself only touches a row that is still unbound, so
   * two people racing cannot both win.
   */
  async claimMember(memberId: string, user: AuthUser): Promise<Member | null> {
    const id = this.workspaceId ?? (await this.ensureWorkspaceId());
    if (!id) return null;

    const existing = await this.client.from('members').select('*').eq('workspace_id', id);
    if (existing.error) throw new Error(`Could not read the team: ${existing.error.message}`);
    const rows = (existing.data ?? []) as Row[];

    // Anybody already bound means the bootstrap is over: from here on the way
    // in is an email invitation, not a name pick.
    if (rows.some((row) => strOrNull(row.user_id))) return null;

    const target = rows.find((row) => str(row.id) === memberId);
    if (!target) return null;

    const claimed = await this.client
      .from('members')
      .update({ user_id: user.id })
      .eq('id', memberId)
      .is('user_id', null)
      .select('id')
      .single();
    if (claimed.error) throw new Error(`Could not claim ${str(target.name, 'that name')}: ${claimed.error.message}`);
    // No row came back: somebody else claimed it between the read and the write.
    if (!claimed.data) return null;

    return memberFromRow({ ...target, user_id: user.id });
  }

  /* ----------------------------- realtime ---------------------------- */

  subscribe(handlers: SubscribeHandlers, me: Member | null): () => void {
    handlers.onState('connecting');
    const channel = this.client.channel('blackit-flow', {
      config: { presence: { key: me?.id ?? 'anonymous' } },
    });

    SYNCED_TABLES.forEach((table) => {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (raw: unknown) => {
          const payload = raw as { eventType?: string; new?: Row; old?: Row };
          const type = String(payload.eventType ?? '').toUpperCase();
          if (type !== 'INSERT' && type !== 'UPDATE' && type !== 'DELETE') return;
          handlers.onChange({
            table,
            type,
            row: (payload.new ?? {}) as Row,
            old: (payload.old ?? {}) as Row,
          });
        },
      );
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState() as Record<string, Array<Record<string, unknown>>>;
      const peers: PresencePeer[] = [];
      Object.values(state).forEach((entries) => {
        entries.forEach((entry) => {
          peers.push({
            memberId: str(entry.memberId),
            memberName: str(entry.memberName),
            onlineAt: Number(entry.onlineAt ?? Date.now()),
          });
        });
      });
      handlers.onPresence(peers);
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        handlers.onState('live');
        if (me) {
          void channel.track({ memberId: me.id, memberName: me.name, onlineAt: Date.now() });
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        handlers.onState('error');
        // The socket library retries on its own; the app also resyncs on focus.
      } else if (status === 'CLOSED') {
        handlers.onState('offline');
      }
    });

    return () => {
      void this.client.removeChannel(channel);
      handlers.onState('offline');
    };
  }

  /* ------------------------------ activity --------------------------- */

  async logActivity(entry: ActivityEntry, mutationId: string): Promise<void> {
    const id = this.workspaceId ?? (await this.ensureWorkspaceId());
    if (!id) return;
    try {
      await this.client.from('activity').insert({
        workspace_id: id,
        actor_id: entry.actorId,
        actor_name: entry.actorName,
        action: entry.action,
        task_key: entry.taskKey ?? '',
        summary: entry.summary ?? '',
        mutation_id: mutationId,
      });
    } catch {
      // The audit trail must never break the action it is describing.
    }
  }

  async recentActivity(limit: number): Promise<ActivityRecord[]> {
    const id = this.workspaceId ?? (await this.ensureWorkspaceId());
    if (!id) return [];
    const { data, error } = await this.client
      .from('activity')
      .select('*')
      .eq('workspace_id', id)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, ACTIVITY_LIMIT));
    if (error || !data) return [];
    this.activity = (data as Row[]).map((row) => ({
      id: Number(row.id ?? 0),
      actorId: strOrNull(row.actor_id),
      actorName: str(row.actor_name),
      action: str(row.action),
      taskKey: str(row.task_key),
      summary: str(row.summary),
      // The row's own timestamp. Using the local clock here made every entry in
      // the feed read "just now", no matter how old it was.
      createdAt: ms(row.created_at) ?? Date.now(),
    }));
    this.nextActivityId = (this.activity[0]?.id ?? 0) + 1;
    return this.activity;
  }

  /**
   * Whether the last read found the schema absent. The app uses this to tell a
   * teammate why nothing is shared, instead of leaving it to the console.
   */
  get isSchemaMissing(): boolean {
    return this.schemaMissing;
  }

  /** Diagnostics for the console: which workspace and project are active. */
  debug(): { workspaceId: string | null; tables: readonly string[] } {
    return { workspaceId: this.workspaceId, tables: TABLES };
  }
}

/* --------------------------------- utils --------------------------------- */

/**
 * PostgREST reports an absent table/function with a schema-cache or
 * "does not exist" message. Both mean "the migration has not been applied",
 * which is a recoverable state rather than a failure.
 */
/**
 * True when a write failed because the row it references is gone — almost
 * always `workspace_id` pointing at a workspace that has been deleted since
 * this client cached it.
 */
export function isForeignKeyViolation(message: string): boolean {
  return /foreign key constraint|23503/i.test(message);
}

export function isMissingSchemaError(message: string): boolean {
  return /schema cache|does not exist|relation .* does not exist|PGRST20[0-9]/i.test(message);
}

function index<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.map((item) => [item.id, item]));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

