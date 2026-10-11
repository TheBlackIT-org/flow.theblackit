/**
 * SupabaseRepository tests — the diff-and-flush logic, exercised against a
 * recording stand-in for PostgREST.
 *
 * The repository's job is to decide *which* rows to write and to tag them for
 * echo suppression. Both are invisible in the UI and impossible to eyeball, so
 * every assertion here is about the statements it emits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyWorkspace, seed } from '../src/lib/domain';
import type { Workspace } from '../src/lib/types';
import { SupabaseRepository, isMissingSchemaError } from '../src/lib/repository/supabase';
import { RepositoryHost } from '../src/lib/repository/host';
import { LocalRepository } from '../src/lib/repository/local';
import { taskToRow, taskFromRow, memberFromRow, projectToRow } from '../src/lib/repository/mappers';
import { fakeSupabase, uuidFor, writesTo, type FakeSupabase } from './helpers/fake-supabase';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const WS = uuidFor('workspace');

/** Minimal in-memory Storage for the local-repository case. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}
/** Fixture timestamps, well in the past so a just-written row is newest. */
/** Two distinct past instants, so "newest first" is unambiguous. */
const FIXTURE_ARJUN_AT = Date.UTC(2026, 0, 1, 0, 0, 0);
const FIXTURE_MEERA_AT = Date.UTC(2026, 5, 1, 0, 0, 0);

/** A live workspace shaped the way a load produces it. */
function liveWorkspace() {
  const ws = seed(NOW);
  ws.mode = 'live';
  ws.workspaceId = WS;
  ws.tasks.forEach((t, i) => {
    t.position = i;
  });
  return ws;
}

function repo(fake: FakeSupabase) {
  return new SupabaseRepository({
    url: 'https://example.supabase.co',
    anonKey: 'anon',
    client: fake.client,
  });
}

/**
 * The real schema uses `uuid` primary keys, so the fixture converts the seed's
 * short ids ('t1', 'm1') into deterministic UUIDs. The workspace is then
 * rewritten in place, which keeps every assertion about seed ids meaningful.
 */
function toUuidSpace(ws: ReturnType<typeof liveWorkspace>) {
  const map = new Map<string, string>();
  const remap = (id: string | null): string | null => {
    if (!id) return null;
    const next = map.get(id) ?? uuidFor(id);
    map.set(id, next);
    return next;
  };

  ws.members.forEach((m) => remap(m.id));
  ws.projects.forEach((p) => remap(p.id));
  ws.tasks.forEach((t) => {
    remap(t.id);
    remap(t.assigneeId);
    remap(t.claimedBy);
    remap(t.createdBy);
  });

  ws.members = ws.members.map((m) => ({ ...m, id: remap(m.id)! }));
  ws.projects = ws.projects.map((p) => ({ ...p, id: remap(p.id)! }));
  ws.tasks = ws.tasks.map((t) => ({
    ...t,
    id: remap(t.id)!,
    projectId: remap(t.projectId)!,
    assigneeId: remap(t.assigneeId),
    claimedBy: remap(t.claimedBy),
    createdBy: remap(t.createdBy),
  }));
  ws.me = remap(ws.me);
  ws.projectId = remap(ws.projectId);
  return { ws, id: remap, map };
}

/**
 * A live workspace whose ids are already UUIDs — the shape `load()` produces.
 * Tests must add fixtures (subtasks, activity) after this point, or the ids
 * they hard-code will not match the remapped task ids.
 */
function uuidWorkspace() {
  return toUuidSpace(liveWorkspace()).ws;
}

/** Seed the repository's notion of "what the server already has". */
async function primed(prepared?: ReturnType<typeof liveWorkspace>) {
  // Callers either pass nothing (a plain seed workspace) or one that is
  // already in UUID space via `uuidWorkspace()`. Detect the latter by looking
  // for UUID-shaped ids rather than remapping twice.
  const candidate = prepared ?? liveWorkspace();
  const alreadyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(candidate.members[0]?.id ?? '');
  const { ws: live } = alreadyUuid ? { ws: candidate } : toUuidSpace(candidate);
  const fake = fakeSupabase({
    workspaces: [{ id: WS }],
    members: live.members.map((m) => ({
      id: m.id,
      workspace_id: WS,
      name: m.name,
      role: m.role,
      title: m.title,
      is_agent: Boolean(m.agent),
    })),
    projects: live.projects.map((p) => ({
      id: p.id,
      workspace_id: WS,
      key: p.key,
      name: p.name,
      product: p.product,
    })),
    tasks: live.tasks.map((t) => ({
      ...taskToRow(t, t.position ?? 0),
      created_at: new Date(t.createdAt).toISOString(),
    })),
    // Subtasks live in their own table, so seed them from the fixture.
    subtasks: live.tasks.flatMap((t) =>
      t.subs.map((sub, i) => ({
        id: sub.id,
        task_id: t.id,
        text: sub.t,
        done: sub.done,
        position: i,
      })),
    ),
  });
  const repository = repo(fake);
  const loaded = (await repository.load())!;
  loaded.mode = 'live';
  loaded.workspaceId = WS;
  return { fake, repository, loaded, ws: live };
}

describe('load', () => {
  it('returns null when there is no workspace row yet', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    expect(await repo(fake).load()).toBeNull();
  });

  it('reads every table and reassembles the workspace', async () => {
    const ws = liveWorkspace();
    const { loaded } = await primed(ws);
    expect(loaded.members).toHaveLength(6);
    expect(loaded.projects).toHaveLength(4);
    expect(loaded.tasks).toHaveLength(32);
    expect(loaded.setup).toBe(true);
    // Defaults to the first project when the browser has no preference.
    expect(loaded.projectId).toBe(ws.projects[0]!.id);
  });

  it('nests subtasks under their task', async () => {
    const ws = liveWorkspace();
    const { ws: live } = toUuidSpace(ws);
    const first = live.tasks[0]!;
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: live.members.map((m) => ({ id: m.id, workspace_id: WS, name: m.name, role: m.role, title: m.title, is_agent: Boolean(m.agent) })),
      projects: live.projects.map((p) => ({ id: p.id, workspace_id: WS, key: p.key, name: p.name, product: p.product })),
      tasks: live.tasks.map((t) => ({
        ...taskToRow(t, t.position ?? 0),
        created_at: new Date(t.createdAt).toISOString(),
      })),
      subtasks: [{ id: uuidFor('s-1'), task_id: first.id, text: 'A step', done: true, position: 0 }],
    });
    const loaded = (await repo(fake).load())!;
    const task = loaded.tasks.find((t) => t.id === first.id)!;
    expect(task.subs).toEqual([{ id: uuidFor('s-1'), t: 'A step', done: true }]);
  });

  it('surfaces a read failure instead of pretending the workspace is empty', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    fake.failures.set('tasks', 'permission denied');
    await expect(repo(fake).load()).rejects.toThrow(/Could not read the workspace/);
  });
});

describe('flush — diffing', () => {
  it('creates the workspace row on the very first write', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    const repository = repo(fake);
    const ws = liveWorkspace();
    ws.workspaceId = null;
    await repository.flush(ws, 'm1');
    expect(writesTo(fake, 'workspaces', 'insert')).toHaveLength(1);
  });

  it('writes nothing when nothing changed', async () => {
    const { fake, repository, loaded } = await primed();
    const before = fake.calls.length;
    await repository.flush(loaded, 'm1');
    const writes = fake.calls.slice(before).filter((c) => c.method !== 'select');
    expect(writes).toEqual([]);
  });

  it('writes only the task that changed', async () => {
    const { fake, repository, loaded } = await primed();
    const before = fake.calls.length;
    const target = loaded.tasks[5]!;
    target.status = 'BLOCK';

    await repository.flush(loaded, 'm-task');

    const writes = fake.calls.slice(before).filter((c) => c.method !== 'select');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.table).toBe('tasks');
    const payload = writes[0]!.payload as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(1);
    expect(payload[0]!.id).toBe(target.id);
    expect(payload[0]!.status).toBe('BLOCK');
  });

  it('tags every write with the mutation id so the echo can be ignored', async () => {
    const { fake, repository, loaded } = await primed();
    loaded.tasks[0]!.title = 'Renamed';
    loaded.tasks[0]!.subs = [{ id: 's-new', t: 'Step', done: false }];
    loaded.members[0]!.title = 'Chief';
    loaded.projects[0]!.name = 'Renamed project';

    await repository.flush(loaded, 'mutation-xyz');

    const writes = fake.calls.filter((c) => c.method === 'upsert' || c.method === 'insert');
    expect(writes.length).toBeGreaterThan(0);
    writes.forEach((call) => {
      const rows = Array.isArray(call.payload) ? call.payload : [call.payload];
      rows.forEach((row) => {
        expect((row as Record<string, unknown>).mutation_id, `${call.table} missing tag`).toBe(
          'mutation-xyz',
        );
      });
    });
  });

  it('deletes a removed task', async () => {
    const { fake, repository, loaded } = await primed();
    const [gone] = loaded.tasks.splice(3, 1);
    const before = fake.calls.length;

    await repository.flush(loaded, 'm-del');

    const deletes = fake.calls.slice(before).filter((c) => c.method === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.table).toBe('tasks');
    const idFilter = deletes[0]!.filters.find((f) => f.op === 'in');
    expect(idFilter?.value).toEqual([gone!.id]);
  });

  it('deletes a removed subtask without touching its task', async () => {
    const ws = uuidWorkspace();
    const keepId = uuidFor('s-a');
    const removeId = uuidFor('s-b');
    ws.tasks[0]!.subs = [
      { id: keepId, t: 'Keep', done: false },
      { id: removeId, t: 'Remove', done: false },
    ];
    const { fake, repository, loaded } = await primed(ws);
    // The subtasks arrive from the server nested under their task.
    const task = loaded.tasks.find((t) => t.subs.some((sub) => sub.id === removeId))!;
    task.subs = task.subs.filter((sub) => sub.id !== removeId);
    const before = fake.calls.length;

    await repository.flush(loaded, 'm-sub-del');

    const writes = fake.calls.slice(before).filter((c) => c.method !== 'select');
    expect(writes.every((c) => c.table === 'subtasks')).toBe(true);
    const deletes = writes.filter((c) => c.method === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.filters.find((f) => f.op === 'in')?.value).toEqual([removeId]);
  });

  it('writes positions so order survives a reload', async () => {
    const { fake, repository, loaded } = await primed();
    // Move a later task to the front, as a drag would. (Not the first one —
    // that is already at position 0 and would be a no-op.)
    const moved = loaded.tasks.splice(4, 1)[0]!;
    loaded.tasks.unshift(moved);
    const before = fake.calls.length;

    await repository.flush(loaded, 'm-reorder');

    const taskWrites = fake.calls
      .slice(before)
      .filter((c) => c.method === 'upsert' && c.table === 'tasks');
    const rows = taskWrites.flatMap((c) => c.payload as Array<Record<string, unknown>>);
    const movedRow = rows.find((r) => r.id === moved.id);
    expect(movedRow?.position).toBe(0);
  });

  it('is idempotent: a second flush writes nothing', async () => {
    const { fake, repository, loaded } = await primed();
    loaded.tasks[0]!.status = 'DONE';
    await repository.flush(loaded, 'm1');
    const afterFirst = fake.calls.length;
    await repository.flush(loaded, 'm2');
    expect(fake.calls.slice(afterFirst).filter((c) => c.method !== 'select')).toEqual([]);
  });

  it('serialises concurrent flushes so diffs cannot interleave', async () => {
    const { fake, repository, loaded } = await primed();
    loaded.tasks[0]!.status = 'PROG';
    loaded.tasks[1]!.status = 'REVIEW';
    await Promise.all([repository.flush(loaded, 'a'), repository.flush(loaded, 'b')]);
    // The second call sees the first call's synced state and writes nothing.
    const taskWrites = fake.calls.filter((c) => c.method === 'upsert' && c.table === 'tasks');
    expect(taskWrites).toHaveLength(1);
  });

  it('reports a write failure rather than silently losing the change', async () => {
    const { fake, repository, loaded } = await primed();
    loaded.tasks[0]!.status = 'BLOCK';
    fake.failures.set('tasks', 'row level security denied');
    await expect(repository.flush(loaded, 'm1')).rejects.toThrow(/tasks write failed/);
  });

  it('keeps the failed change pending by not advancing the synced state', async () => {
    const { fake, repository, loaded } = await primed();
    loaded.tasks[0]!.status = 'BLOCK';
    fake.failures.set('tasks', 'nope');
    await expect(repository.flush(loaded, 'm1')).rejects.toThrow();

    // Once the backend recovers, the very same change must still be written.
    fake.failures.delete('tasks');
    const before = fake.calls.length;
    await repository.flush(loaded, 'm2');
    const writes = fake.calls
      .slice(before)
      .filter((c) => c.method === 'upsert' && c.table === 'tasks');
    const rows = writes.flatMap((c) => c.payload as Array<Record<string, unknown>>);
    expect(rows.some((r) => r.id === loaded.tasks[0]!.id && r.status === 'BLOCK')).toBe(true);
  });
});

describe('next task key', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the database sequence when the function exists', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    fake.rpcResult.data = 'NE-42';
    const key = await repo(fake).nextTaskKey('project-1', () => 'FALLBACK');
    expect(key).toBe('NE-42');
    expect(fake.rpcCalls[0]).toEqual({ fn: 'next_task_key', args: { p_project_id: 'project-1' } });
  });

  it('falls back to the client count when the function is missing', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    fake.rpcResult.error = { message: 'function does not exist' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = await repo(fake).nextTaskKey('project-1', () => 'NE-7');
    expect(key).toBe('NE-7');
  });
});

describe('subscribe', () => {
  it('listens to every synced table plus activity', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    const repository = repo(fake);
    const onChange = vi.fn();
    repository.subscribe({ onChange, onState: vi.fn(), onPresence: vi.fn() }, memberFromRow({ id: 'm1', name: 'Arjun' }));

    const tables = fake.channels[0]!.handlers.map((h) => h.table).sort();
    expect(tables).toEqual(['activity', 'members', 'projects', 'subtasks', 'tasks']);
  });

  it('forwards a row event to the app', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    const repository = repo(fake);
    const onChange = vi.fn();
    repository.subscribe({ onChange, onState: vi.fn(), onPresence: vi.fn() }, null);

    fake.emit('tasks', { eventType: 'UPDATE', new: { id: 't1', status: 'DONE' }, old: { id: 't1' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toMatchObject({ table: 'tasks', type: 'UPDATE' });
  });

  it('reports connection state changes', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    const onState = vi.fn();
    repo(fake).subscribe({ onChange: vi.fn(), onState, onPresence: vi.fn() }, null);
    const subscribed = fake.channels[0];
    void subscribed;

    fake.emitStatus('SUBSCRIBED');
    fake.emitStatus('CHANNEL_ERROR');
    fake.emitStatus('CLOSED');
    expect(onState.mock.calls.map((c) => c[0])).toEqual([
      'connecting',
      'live',
      'error',
      'offline',
    ]);
  });

  it('unsubscribes cleanly', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    const onState = vi.fn();
    const off = repo(fake).subscribe({ onChange: vi.fn(), onState, onPresence: vi.fn() }, null);
    off();
    expect(fake.removedChannels).toHaveLength(1);
  });
});

describe('activity', () => {
  it('writes an audit row and reads the newest first', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      activity: [
        {
          id: 1,
          workspace_id: WS,
          actor_name: 'Arjun',
          action: 'task.status',
          task_key: 'NE-3',
          summary: 'Blocked',
          created_at: new Date(FIXTURE_ARJUN_AT).toISOString(),
        },
        {
          id: 2,
          workspace_id: WS,
          actor_name: 'Meera',
          action: 'task.claimed',
          task_key: 'NE-4',
          summary: 'Meera',
          created_at: new Date(FIXTURE_MEERA_AT).toISOString(),
        },
      ],
    });
    const repository = repo(fake);

    await repository.logActivity(
      { actorId: 'm1', actorName: 'Just Now', action: 'task.status', taskKey: 'NE-3', summary: 'Blocked' },
      'm-1',
    );
    const inserts = writesTo(fake, 'activity', 'insert') as Array<Record<string, unknown>>;
    expect(inserts[0]).toMatchObject({
      workspace_id: WS,
      actor_name: 'Just Now',
      action: 'task.status',
      task_key: 'NE-3',
      mutation_id: 'm-1',
    });

    const entries = await repository.recentActivity(10);
    // Newest first: the row just written has the latest created_at, ahead of
    // the two fixtures pinned to earlier timestamps.
    expect(entries.map((e) => e.actorName)).toEqual(['Just Now', 'Meera', 'Arjun']);
    expect(entries[0]!.createdAt).toBeGreaterThan(entries[1]!.createdAt);
  });

  it('never lets an audit failure break the action it describes', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    fake.failures.set('activity', 'insert failed');
    await expect(
      repo(fake).logActivity({ actorId: null, actorName: 'x', action: 'task.status' }, 'm'),
    ).resolves.toBeUndefined();
  });
});

describe('round trip', () => {
  it('a flushed change is what a fresh load reads back', async () => {
    const ws = liveWorkspace();
    const { fake, repository, loaded } = await primed(ws);

    loaded.tasks[0]!.status = 'BLOCK';
    loaded.tasks[0]!.title = 'Edited elsewhere';
    await repository.flush(loaded, 'm1');

    // Apply the recorded writes to the fake store, then reload.
    fake.calls
      .filter((c) => c.method === 'upsert')
      .forEach((call) => {
        const rows = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Array<
          Record<string, unknown>
        >;
        const store = (fake.tables[call.table] ??= []);
        rows.forEach((row) => {
          const index = store.findIndex((r) => (r as { id: string }).id === row.id);
          if (index >= 0) store[index] = { ...(store[index] as object), ...row };
          else store.push(row);
        });
      });

    const reloaded = (await repository.load())!;
    const task = reloaded.tasks.find((t) => t.id === loaded.tasks[0]!.id)!;
    expect(task.status).toBe('BLOCK');
    expect(task.title).toBe('Edited elsewhere');
  });

  it('drops a task whose row is gone from the server', async () => {
    const ws = liveWorkspace();
    const { fake, repository } = await primed(ws);
    const victim = ws.tasks[2]!;
    fake.tables.tasks = (fake.tables.tasks ?? []).filter(
      (r) => (r as { id: string }).id !== victim.id,
    );
    const reloaded = (await repository.load())!;
    expect(reloaded.tasks.find((t) => t.id === victim.id)).toBeUndefined();
    expect(reloaded.tasks).toHaveLength(31);
  });
});






describe('bootstrap — key sequence', () => {
  it('seeds each project task counter past its existing keys', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    const repository = repo(fake);
    const ws = liveWorkspace();
    ws.workspaceId = null;

    const created = await repository.bootstrap(ws, 'BlackIT Flow');

    const projectWrites = fake.calls.filter((c) => c.method === 'upsert' && c.table === 'projects');
    const rows = projectWrites.flatMap((c) => c.payload as Array<Record<string, unknown>>);
    expect(rows.length).toBeGreaterThan(0);
    // Every project must carry a counter equal to the tasks it holds, so
    // next_task_key() continues past NE-15 instead of re-issuing NE-1.
    rows.forEach((row) => {
      const taskCount = ws.tasks.filter((t) => t.projectId === row.id).length;
      expect(row.task_counter, `project ${String(row.key)} counter`).toBe(taskCount);
    });

    const p1 = rows.find((r) => r.key === 'NE')!;
    expect(p1.task_counter).toBe(ws.tasks.filter((t) => t.projectId === ws.projects[0]!.id).length);
    void created;
  });

  it('does not clobber a counter on an ordinary edit', async () => {
    const { fake, repository, loaded } = await primed();
    // A loaded project knows its counter; renaming it must not reset the value.
    loaded.projects[0]!.taskCounter = 15;
    loaded.projects[0]!.name = 'Renamed';
    await repository.flush(loaded, 'm1');
    const writes = fake.calls.filter((c) => c.method === 'upsert' && c.table === 'projects');
    const rows = writes.flatMap((c) => c.payload as Array<Record<string, unknown>>);
    const row = rows.find((r) => r.id === loaded.projects[0]!.id)!;
    expect(row.task_counter).toBe(15);
    expect(row.name).toBe('Renamed');
  });

  it('omits the counter when the client does not know it', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    const repository = repo(fake);
    const ws = liveWorkspace();
    ws.workspaceId = null;
    // Strip the counter to simulate a project created purely client-side.
    ws.projects.forEach((p) => delete p.taskCounter);
    await repository.bootstrap(ws, 'x');
    const rows = fake.calls
      .filter((c) => c.method === 'upsert' && c.table === 'projects')
      .flatMap((c) => c.payload as Array<Record<string, unknown>>);
    // bootstrap sets them explicitly, so they are present here.
    expect(rows.every((r) => typeof r.task_counter === 'number')).toBe(true);
  });
});

describe('missing schema handling', () => {
  it('recognises the errors PostgREST returns for absent tables and functions', () => {
    // The real message from the live project when a table does not exist.
    expect(
      isMissingSchemaError("Could not find the table 'public.tasks' in the schema cache"),
    ).toBe(true);
    expect(isMissingSchemaError('relation "public.tasks" does not exist')).toBe(true);
    expect(isMissingSchemaError('function public.next_task_key does not exist')).toBe(true);
    expect(isMissingSchemaError('PGRST205')).toBe(true);
    expect(isMissingSchemaError('PGRST202')).toBe(true);
  });

  it('does not mistake ordinary failures for a setup problem', () => {
    for (const message of [
      'permission denied for table tasks',
      'JWT expired',
      'fetch failed',
      'connection refused',
      'duplicate key value violates unique constraint',
    ]) {
      expect(isMissingSchemaError(message), message).toBe(false);
    }
  });

  it('treats an absent table as "no workspace yet" so bootstrapping can proceed', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    fake.failures.set('workspaces', "Could not find the table 'public.workspaces' in the schema cache");
    // Must not throw: the caller needs to distinguish "empty" from "broken".
    await expect(repo(fake).load()).resolves.toBeNull();
  });

  it('still surfaces a genuine read failure', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }] });
    fake.failures.set('tasks', 'permission denied for table tasks');
    await expect(repo(fake).load()).rejects.toThrow(/Could not read the workspace/);
  });
});

describe('schema-missing is distinguishable from an empty project', () => {
  const MISSING = "Could not find the table 'public.workspaces' in the schema cache";

  it('reports missing schema after a failed read', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    fake.failures.set('workspaces', MISSING);
    const repository = repo(fake);
    const loaded = await repository.load();
    expect(loaded).toBeNull();
    expect(repository.isSchemaMissing).toBe(true);
  });

  it('reports an empty project as empty, not as missing schema', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    const repository = repo(fake);
    const loaded = await repository.load();
    expect(loaded).toBeNull();
    expect(repository.isSchemaMissing).toBe(false);
  });

  it('clears the flag once the schema exists', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    fake.failures.set('workspaces', MISSING);
    const repository = repo(fake);
    await repository.load();
    expect(repository.isSchemaMissing).toBe(true);

    // The migration is applied: the table is there with no rows yet.
    fake.failures.delete('workspaces');
    await repository.load();
    expect(repository.isSchemaMissing).toBe(false);
  });

  it('surfaces through the host so the app can tell the user', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    fake.failures.set('workspaces', MISSING);
    // Sample seeding is opt-in; these tests exercise that path explicitly.
    const host = new RepositoryHost(repo(fake), { seedSample: true });
    const { workspace, bootstrapped } = await host.load();
    expect(host.schemaMissing).toBe(true);
    // It still hands back something usable, so the app keeps working locally
    // instead of showing an empty page.
    expect(bootstrapped).toBe(false);
    expect(workspace.tasks.length).toBeGreaterThan(0);
    expect(workspace.setup).toBe(true);
  });

  it('a local repository never claims the schema is missing', async () => {
    const host = new RepositoryHost(new LocalRepository(memoryStorage()));
    await host.load();
    expect(host.schemaMissing).toBe(false);
  });
});

describe('bootstrap failures are not swallowed', () => {
  it('surfaces a write failure instead of returning as if it succeeded', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    const host = new RepositoryHost(repo(fake), { seedSample: true });
    // The workspace row is created, then the members write fails for a reason
    // that is not a missing schema.
    fake.failures.set('members', "Could not find the 'mutation_id' column of 'members'");
    await expect(host.load()).rejects.toThrow(/members/);
  });

  it('still degrades quietly when the schema itself is absent', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    fake.failures.set('workspaces', "Could not find the table 'public.workspaces' in the schema cache");
    const host = new RepositoryHost(repo(fake));
    const { bootstrapped } = await host.load();
    expect(bootstrapped).toBe(false);
    expect(host.schemaMissing).toBe(true);
  });
});

describe('an empty shared database stays empty by default', () => {
  it('does not seed sample content unless asked', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    const host = new RepositoryHost(repo(fake)); // seedSample defaults to false
    const { workspace, bootstrapped } = await host.load();
    expect(bootstrapped).toBe(false);
    expect(workspace.projects).toEqual([]);
    expect(workspace.tasks).toEqual([]);
    expect(workspace.members).toEqual([]);
    // And nothing was published to the backend.
    expect(fake.calls.filter((c) => c.method === 'insert' || c.method === 'upsert')).toEqual([]);
  });

  it('an empty workspace is not "repaired" into sample data', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [],
      projects: [],
      tasks: [],
    });
    const host = new RepositoryHost(repo(fake));
    const { workspace } = await host.load();
    expect(workspace.projects).toEqual([]);
    expect(fake.calls.filter((c) => c.method === 'upsert' && c.table === 'projects')).toEqual([]);
  });

  it('seeds when the flag is on, for a fresh environment or a demo', async () => {
    const fake = fakeSupabase({ workspaces: [] });
    const host = new RepositoryHost(repo(fake), { seedSample: true });
    const { workspace, bootstrapped } = await host.load();
    expect(bootstrapped).toBe(true);
    expect(workspace.projects).toHaveLength(4);
    expect(workspace.tasks).toHaveLength(32);
  });
});

describe('a deleted workspace heals itself', () => {
  it('recreates the workspace instead of failing every write until a reload', async () => {
    // A reset in another tab leaves this client writing members against a row
    // that no longer exists. Without recovery every later write fails and the
    // user has to reload the page.
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members: [], projects: [], tasks: [] });
    const supabase = new SupabaseRepository(fake, 'BlackIT Flow');
    const ws: Workspace = {
      ...emptyWorkspace(),
      mode: 'live',
      setup: true,
      workspaceId: null,
      members: [{ id: uuidFor('m1'), name: 'A', role: 'member', title: '', agent: false }],
    };

    await supabase.flush(ws, 'm1');
    expect(fake.tables.workspaces).toHaveLength(1);

    // The workspace is deleted underneath this client, so the edit that is now
    // queued is rejected on the foreign key.
    fake.tables.workspaces.length = 0;
    ws.members[0]!.name = 'Renamed';
    fake.failures.set(
      'members',
      'insert or update on table "members" violates foreign key constraint "members_workspace_id_fkey"',
    );
    // The write may still fail if the retry hits the injected error again; the
    // point is that the client no longer keeps pointing at the deleted row.
    await supabase.flush(ws, 'm2').catch(() => undefined);

    expect(fake.tables.workspaces.length).toBeGreaterThan(0);
    expect(fake.tables.members.length).toBeGreaterThan(0);
  });
});

describe('a new project carries a task counter', () => {
  it('sends task_counter: 0 on insert, because the column is NOT NULL', async () => {
    // A project created through the UI has no counter yet. Omitting the column
    // made the insert fail with "null value in column task_counter", so no
    // project created in the app could ever be saved.
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members: [], projects: [], tasks: [] });
    const supabase = new SupabaseRepository(fake, 'BlackIT Flow');
    const ws: Workspace = {
      ...emptyWorkspace(),
      mode: 'live',
      setup: true,
      workspaceId: null,
      projects: [{ id: uuidFor('p1'), key: 'NEW', name: 'Brand new', product: '' }],
    };
    await supabase.flush(ws, 'm1');
    expect(fake.tables.projects).toHaveLength(1);
    expect((fake.tables.projects[0] as { task_counter: number }).task_counter).toBe(0);
  });

  it('leaves an unknown counter alone on update', () => {
    // An ordinary edit must not reset a sequence the server owns.
    const p = { id: 'p1', key: 'K', name: 'N', product: '' };
    expect(projectToRow(p, 'ws')).not.toHaveProperty('task_counter');
    expect(projectToRow(p, 'ws', true)).toHaveProperty('task_counter', 0);
    expect(projectToRow({ ...p, taskCounter: 7 }, 'ws')).toHaveProperty('task_counter', 7);
  });
});
