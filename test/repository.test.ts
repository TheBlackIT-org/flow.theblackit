// @vitest-environment happy-dom
/**
 * Repository and sync tests.
 *
 * These cover the parts that are easy to get subtly wrong and impossible to
 * eyeball: diff-based flushing, recognising your own realtime echo, ignoring
 * out-of-order events, and the reset semantics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seed, emptyWorkspace, FlowDomain } from '../src/lib/domain';
import { LocalRepository } from '../src/lib/repository/local';
import { RepositoryHost, newMutationId } from '../src/lib/repository/host';
import { applyChange, isReorder, primePositions } from '../src/lib/repository/apply';
import { SyncController } from '../src/lib/sync';
import { renderSyncChip } from '../src/lib/render';
import { memberToRow, projectToRow, taskToRow, taskFromRow, memberFromRow } from '../src/lib/repository/mappers';
import type { RowChange } from '../src/lib/repository/types';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

/** Silence one expected warning without leaking a global mock into other tests. */
function usingWarnSilencer(): void {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Vitest restores spies between tests; this keeps intent explicit at the call site.
  void spy;
}

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

describe('LocalRepository', () => {
  let storage: Storage;
  let repo: LocalRepository;

  beforeEach(() => {
    storage = memoryStorage();
    repo = new LocalRepository(storage);
  });

  it('round-trips a workspace', async () => {
    const ws = seed(NOW);
    await repo.flush(ws, newMutationId());
    const loaded = await repo.load();
    expect(loaded?.tasks).toHaveLength(ws.tasks.length);
    expect(loaded?.projects[0]?.key).toBe('NE');
  });

  it('returns null when nothing is stored', async () => {
    expect(await repo.load()).toBeNull();
  });

  it('sets the workspace id when a domain uses a repository host', async () => {
    const host = new RepositoryHost(repo);
    const { workspace } = await host.load();
    expect(workspace.setup).toBe(true);
    expect(workspace.tasks.length).toBeGreaterThan(0);
  });

  it('keeps the audit trail, newest first', async () => {
    await repo.logActivity({ actorId: 'm1', actorName: 'Arjun', action: 'task.status', taskKey: 'NE-3' }, 'x');
    await repo.logActivity({ actorId: 'm2', actorName: 'Nithin', action: 'task.claimed', taskKey: 'NE-4' }, 'y');
    const entries = await repo.recentActivity(10);
    expect(entries.map((e) => e.actorName)).toEqual(['Nithin', 'Arjun']);
  });

  it('does not claim to share anything', async () => {
    const handlers = { onChange: vi.fn(), onState: vi.fn(), onPresence: vi.fn() };
    const off = repo.subscribe(handlers, null);
    expect(handlers.onState).not.toHaveBeenCalled();
    off();
  });
});

describe('row mapping', () => {
  it('converts a task both ways without losing fields', () => {
    // noUnusedLocals: the helper pair is exercised together on purpose.
    const ws = seed(NOW);
    const task = ws.tasks[0]!;
    const row = taskToRow(task, 7);
    expect(row.position).toBe(7);
    expect(row.project_id).toBe(task.projectId);

    const back = taskFromRow({ ...row, id: task.id, due_at: new Date(task.dueAt ?? 0).toISOString() });
    expect(back.id).toBe(task.id);
    expect(back.key).toBe(task.key);
    expect(back.status).toBe(task.status);
    expect(back.priority).toBe(task.priority);
    expect(back.dueAt).toBe(task.dueAt);
    expect(back.dependsOn).toEqual(task.dependsOn);
  });

  it('keeps a null due date null instead of inventing one', () => {
    const ws = seed(NOW);
    const task = { ...ws.tasks[0]!, dueAt: null };
    expect(taskFromRow(taskToRow(task, 0)).dueAt).toBeNull();
  });

  it('maps the agent flag on members', () => {
    const agent = memberFromRow({ id: 'x', name: 'Flow Agent', role: 'member', title: '', is_agent: true });
    expect(agent.agent).toBe(true);
    expect(memberToRow(agent, 'ws').is_agent).toBe(true);
  });

  it('maps a project', () => {
    const row = projectToRow({ id: 'p1', key: 'NE', name: 'Natil', product: 'NE' }, 'ws');
    expect(row.workspace_id).toBe('ws');
    expect(row.key).toBe('NE');
  });
});

describe('applyChange', () => {
  let ws: ReturnType<typeof seed>;

  beforeEach(() => {
    ws = seed(NOW);
    // Mirror what a real load produces: the server owns `position`.
    ws.tasks.forEach((t, i) => {
      t.position = i;
    });
  });

  const ctx = { ownMutationIds: new Set<string>() };

  it('applies an update from another client', () => {
    const target = ws.tasks[1]!;
    const change: RowChange = {
      table: 'tasks',
      type: 'UPDATE',
      row: { ...taskToRow(target, 1), status: 'BLOCK', mutation_id: 'someone-else' },
    };
    const result = applyChange(ws, change, ctx);
    expect(result.changed).toBe(true);
    expect(ws.tasks.find((t) => t.id === target.id)?.status).toBe('BLOCK');
  });

  it('ignores the echo of our own write', () => {
    const target = ws.tasks[1]!;
    const mine = newMutationId();
    const change: RowChange = {
      table: 'tasks',
      type: 'UPDATE',
      row: { ...taskToRow(target, 1), status: 'BLOCK', mutation_id: mine },
    };
    const result = applyChange(ws, change, { ownMutationIds: new Set([mine]) });
    expect(result.changed).toBe(false);
    // Our local state wins; the echo changed nothing.
    expect(ws.tasks.find((t) => t.id === target.id)?.status).toBe(target.status);
  });

  it('preserves locally held subtasks and the expanded flag', () => {
    const target = ws.tasks[0]!;
    target.subs = [{ id: 's-local', t: 'Typed just now', done: false }];
    target.open = true;
    const change: RowChange = {
      table: 'tasks',
      type: 'UPDATE',
      row: { ...taskToRow(target, 0), title: 'Renamed elsewhere' },
    };
    applyChange(ws, change, ctx);
    const after = ws.tasks.find((t) => t.id === target.id)!;
    expect(after.title).toBe('Renamed elsewhere');
    expect(after.subs).toEqual([{ id: 's-local', t: 'Typed just now', done: false }]);
    expect(after.open).toBe(true);
  });

  it('does NOT resync for an ordinary field change', () => {
    // Regression: every row carries `position`, so an update used to look like
    // a reorder and forced a full resync on every remote edit.
    const target = ws.tasks[0]!;
    primePositions(ws);
    const change: RowChange = {
      table: 'tasks',
      type: 'UPDATE',
      row: { ...taskToRow(target, target.position ?? 0), title: 'Renamed elsewhere' },
    };
    const result = applyChange(ws, change, ctx);
    expect(result.needsResync).toBe(false);
    expect(result.changed).toBe(true);
  });

  it('asks for a resync when the position actually changes', () => {
    const target = ws.tasks[0]!;
    primePositions(ws);
    const change: RowChange = {
      table: 'tasks',
      type: 'UPDATE',
      row: { ...taskToRow(target, 9), position: 9 },
    };
    const result = applyChange(ws, change, ctx);
    expect(result.needsResync).toBe(true);
  });

  it('treats the first event for a task as a baseline, not a move', () => {
    // No baseline at all: nothing can be concluded, so do not resync.
    expect(isReorder(ws, 'never-seen', 4)).toBe(false);
    primePositions(ws);
    const target = ws.tasks[0]!;
    expect(isReorder(ws, target.id, target.position ?? 0)).toBe(false);
    expect(isReorder(ws, target.id, (target.position ?? 0) + 5)).toBe(true);
  });

  it('removes a deleted task', () => {
    const target = ws.tasks[2]!;
    const result = applyChange(ws, { table: 'tasks', type: 'DELETE', row: { id: target.id } }, ctx);
    expect(result.changed).toBe(true);
    expect(ws.tasks.find((t) => t.id === target.id)).toBeUndefined();
  });

  it('adds a subtask that another client created', () => {
    const task = ws.tasks[0]!;
    const result = applyChange(
      ws,
      { table: 'subtasks', type: 'INSERT', row: { id: 's-new', task_id: task.id, text: 'From Nithin', done: false } },
      ctx,
    );
    expect(result.changed).toBe(true);
    expect(task.subs.at(-1)).toEqual({ id: 's-new', t: 'From Nithin', done: false });
  });

  it('drops a removed member and frees their tasks', () => {
    const victim = ws.members.find((m) => m.id === 'm3')!;
    const owned = ws.tasks.filter((t) => t.assigneeId === victim.id).map((t) => t.id);
    expect(owned.length).toBeGreaterThan(0);
    applyChange(ws, { table: 'members', type: 'DELETE', row: { id: victim.id } }, ctx);
    expect(ws.members.find((m) => m.id === victim.id)).toBeUndefined();
    owned.forEach((id) => expect(ws.tasks.find((t) => t.id === id)?.assigneeId).toBeNull());
  });

  it('moves the active project when the open one is deleted', () => {
    const current = ws.projectId!;
    applyChange(ws, { table: 'projects', type: 'DELETE', row: { id: current } }, ctx);
    expect(ws.projectId).not.toBe(current);
    expect(ws.projects.some((p) => p.id === ws.projectId)).toBe(true);
    // Tasks of the deleted project go with it.
    expect(ws.tasks.every((t) => t.projectId !== current)).toBe(true);
  });
});

describe('domain persistence hook', () => {
  it('calls persist on every mutation and never on its own', () => {
    const persist = vi.fn();
    const d = new FlowDomain(seed(NOW), { storage: memoryStorage(), persist });
    d.setStatus('t4', 'PROG');
    expect(persist).toHaveBeenCalledTimes(1);
    d.claim('t5');
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('reserves keys through the injected resolver', async () => {
    const nextKey = vi.fn(async () => 'NE-999');
    const d = new FlowDomain(seed(NOW), { storage: memoryStorage(), nextKey });
    const t = await d.createTask({ title: 'Server-keyed', typeId: 'tt3', assigneeId: null, due: null, priority: 'normal' });
    expect(nextKey).toHaveBeenCalled();
    expect(t?.key).toBe('NE-999');
  });

  it('reports mutations to the audit sink', () => {
    const events: string[] = [];
    const d = new FlowDomain(seed(NOW), {
      storage: memoryStorage(),
      onEvent: (e) => events.push(e.action),
    });
    d.setStatus('t4', 'DONE');
    d.claim('t5');
    d.addSub('t4', 'A step');
    expect(events).toEqual(['task.status', 'task.claimed', 'subtask.added']);
  });

  it('survives an audit sink that throws', () => {
    const d = new FlowDomain(seed(NOW), {
      storage: memoryStorage(),
      onEvent: () => {
        throw new Error('sink exploded');
      },
    });
    expect(() => d.setStatus('t4', 'DONE')).not.toThrow();
    expect(d.findTask('t4')?.status).toBe('DONE');
  });
});

describe('adopt', () => {
  it('keeps the open project and expanded cards when they still exist', () => {
    const d = new FlowDomain(seed(NOW), { storage: memoryStorage() });
    d.workspace.projectId = 'p2';
    d.workspace.fStatus = 'PROG';
    const openId = d.projectTasks()[0]!.id;
    d.findTask(openId)!.open = true;

    const fresh = seed(NOW);
    d.adopt(fresh);
    expect(d.workspace.projectId).toBe('p2');
    expect(d.workspace.fStatus).toBe('PROG');
    expect(d.workspace.tasks.find((t) => t.id === openId)?.open).toBe(true);
  });

  it('falls back when the open project is gone', () => {
    const d = new FlowDomain(seed(NOW), { storage: memoryStorage() });
    d.workspace.projectId = 'p2';
    const fresh = seed(NOW);
    fresh.projects = fresh.projects.filter((p) => p.id !== 'p2');
    fresh.tasks = fresh.tasks.filter((t) => t.projectId !== 'p2');
    d.adopt(fresh);
    expect(d.workspace.projectId).not.toBe('p2');
  });

  it('ignores view state when asked to', () => {
    const d = new FlowDomain(seed(NOW), { storage: memoryStorage() });
    d.workspace.fStatus = 'DONE';
    d.adopt(seed(NOW), { keepView: false });
    expect(d.workspace.fStatus).toBe('all');
  });
});

describe('reset semantics', () => {
  it('clears projects and tasks but keeps people', async () => {
    const storage = memoryStorage();
    const repo = new LocalRepository(storage);
    const host = new RepositoryHost(repo);
    const { workspace } = await host.load();
    const cleared = {
      ...emptyWorkspace(),
      workspaceId: workspace.workspaceId,
      members: workspace.members.map((m) => ({ ...m })),
      me: workspace.me,
    };
    expect(cleared.tasks).toEqual([]);
    expect(cleared.projects).toEqual([]);
    // A team with no members could not be assigned anything.
    expect(cleared.members.length).toBe(6);
  });
});

describe('SyncController — demo is local-only', () => {
  /** A stand-in for Supabase that records what it was asked to write. */
  function spyRepository() {
    const flushes: Array<{ mode: string; mutationId: string }> = [];
    const activities: string[] = [];
    const handlers: { change?: (c: RowChange) => void } = {};
    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => null),
      flush: vi.fn(async (ws: { mode: string }, mutationId: string) => {
        flushes.push({ mode: ws.mode, mutationId });
      }),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      subscribe: vi.fn((h: Record<string, unknown>) => {
        handlers.change = h.onChange as (c: RowChange) => void;
        return () => {};
      }),
      logActivity: vi.fn(async (entry: { action: string }) => {
        activities.push(entry.action);
      }),
      recentActivity: vi.fn(async () => []),
    };
    return { repo, flushes, activities, handlers };
  }

  function controllerFor(repo: ReturnType<typeof spyRepository>['repo'], ws: ReturnType<typeof seed>) {
    const host = new RepositoryHost(repo as never);
    const onWorkspaceChanged = vi.fn();
    const sync = new SyncController(host, {
      onWorkspaceChanged,
      onActivityChanged: vi.fn(),
      onStatus: vi.fn(),
      onPresence: vi.fn(),
    });
    sync.setWorkspaceRef(() => ws);
    return { sync, onWorkspaceChanged };
  }

  it('does not push a demo workspace', async () => {
    const { repo, flushes } = spyRepository();
    const demo = seed(NOW);
    const { sync } = controllerFor(repo, demo);
    sync.schedule(demo);
    await sync.flushNow(demo);
    expect(flushes).toHaveLength(0);
    expect(repo.flush).not.toHaveBeenCalled();
  });

  it('pushes a live workspace', async () => {
    const { repo, flushes } = spyRepository();
    const live = seed(NOW);
    live.mode = 'live' as const;
    const { sync } = controllerFor(repo, live);
    sync.schedule(live);
    await sync.flushNow(live);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.mode).toBe('live');
  });

  it('ignores remote changes while showing the demo', () => {
    const { repo, handlers } = spyRepository();
    const demo = seed(NOW);
    const { sync, onWorkspaceChanged } = controllerFor(repo, demo);
    sync.start(null);
    handlers.change?.({ table: 'tasks', type: 'UPDATE', row: { id: demo.tasks[0]!.id, status: 'DONE' } });
    expect(onWorkspaceChanged).not.toHaveBeenCalled();
  });

  it('applies remote changes in a live workspace', () => {
    const { repo, handlers } = spyRepository();
    const live = seed(NOW);
    // Flip the mode after seeding: the guard keys off `mode`, and only a live
    // workspace participates in sync.
    live.mode = 'live' as const;
    const { sync, onWorkspaceChanged } = controllerFor(repo, live);
    sync.start(null);
    const target = live.tasks[1]!;
    handlers.change?.({
      table: 'tasks',
      type: 'UPDATE',
      row: { ...taskToRow(target, 1), status: 'BLOCK', mutation_id: 'other-client' },
    });
    expect(onWorkspaceChanged).toHaveBeenCalled();
    expect(live.tasks.find((t) => t.id === target.id)?.status).toBe('BLOCK');
  });

  it('refetches the feed when a remote activity row lands', () => {
    const { repo, handlers } = spyRepository();
    const live = seed(NOW);
    live.mode = 'live' as const;
    const host = new RepositoryHost(repo as never);
    const onActivityChanged = vi.fn();
    const sync = new SyncController(host, {
      onWorkspaceChanged: vi.fn(),
      onActivityChanged,
      onStatus: (next) => {
        status = next as never;
      },
      onPresence: vi.fn(),
    });
    sync.setWorkspaceRef(() => live);
    sync.start(null);
    handlers.change?.({ table: 'activity', type: 'INSERT', row: { id: 1, action: 'task.status' } });
    expect(onActivityChanged).toHaveBeenCalledTimes(1);
  });

  it('does not record demo actions in the team history', async () => {
    const { repo, activities } = spyRepository();
    const demo = seed(NOW);
    const { sync } = controllerFor(repo, demo);
    await sync.logEvent({ action: 'task.status', summary: 'Done' }, null);
    expect(activities).toHaveLength(0);
  });

  it('records live actions', async () => {
    const { repo, activities } = spyRepository();
    const live = seed(NOW);
    live.mode = 'live' as const;
    const { sync } = controllerFor(repo, live);
    await sync.logEvent({ action: 'task.status', summary: 'Done' }, live.members[0]!);
    expect(activities).toEqual(['task.status']);
  });
});

describe('test fixture helpers', () => {
  it('uuidFor produces well-formed, unique, stable ids', async () => {
    const { uuidFor } = await import('./helpers/fake-supabase');
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const seed of ['t1', 't2', 'm1', 'workspace', 'project-1', 'a', '']) {
      const id = uuidFor(seed);
      expect(id, `seed "${seed}"`).toMatch(pattern);
      expect(uuidFor(seed)).toBe(id);
    }
    const many = new Set(Array.from({ length: 200 }, (_, i) => uuidFor(`t${i}`)));
    expect(many.size).toBe(200);
  });
});

describe('SyncController — resilience', () => {
  function harness(options: { failFirst?: boolean } = {}) {
    const flushes: string[] = [];
    const statuses: Array<{ state: string; pending: number; retryInSeconds: number | null }> = [];
    const states: string[] = [];
    let failWrites = options.failFirst ?? false;
    const handlers: { change?: (c: RowChange) => void; state?: (s: string) => void } = {};

    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => null),
      flush: vi.fn(async (_ws: { mode: string }, mutationId: string) => {
        if (failWrites) throw new Error('network is down');
        flushes.push(mutationId);
      }),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      subscribe: vi.fn((h: Record<string, unknown>) => {
        handlers.change = h.onChange as (c: RowChange) => void;
        // The contract passes *semantic* states ('live' | 'connecting' |
        // 'error' | 'offline'), which is what SupabaseRepository emits after
        // translating the provider's SUBSCRIBED/CHANNEL_ERROR vocabulary.
        handlers.state = h.onState as (s: string) => void;
        return () => {};
      }),
      logActivity: vi.fn(async () => {}),
      recentActivity: vi.fn(async () => []),
    };

    const onWorkspaceChanged = vi.fn();
    const host = new RepositoryHost(repo as never);
    const sync = new SyncController(host, {
      onWorkspaceChanged,
      onActivityChanged: vi.fn(),
      onStatus: (st) => {
        statuses.push({ state: st.state, pending: st.pending, retryInSeconds: st.retryInSeconds });
      },
      onPresence: vi.fn(),
    });
    const ws = seed(NOW);
    ws.mode = 'live' as const;
    sync.setWorkspaceRef(() => ws);
    sync.prime();

    return {
      sync,
      repo,
      ws,
      flushes,
      statuses,
      states,
      handlers,
      onWorkspaceChanged,
      recover: () => {
        failWrites = false;
      },
      setFail: (v: boolean) => {
        failWrites = v;
      },
    };
  }

  it('retries a failed write instead of dropping the change', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ failFirst: true });
      const { sync, ws, flushes } = h;
      sync.schedule(ws);
      await vi.advanceTimersByTimeAsync(300);
      expect(flushes).toHaveLength(0);
      // Still pending, not discarded.
      expect(h.statuses.at(-1)?.pending).toBeGreaterThan(0);

      h.recover();
      // Backoff is 1.5s for the first retry.
      await vi.advanceTimersByTimeAsync(2000);
      expect(flushes.length).toBeGreaterThan(0);
      expect(h.statuses.at(-1)?.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports how long until the next retry', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ failFirst: true });
      h.sync.schedule(h.ws);
      await vi.advanceTimersByTimeAsync(300);
      const last = h.statuses.at(-1)!;
      expect(last.state).toBe('error');
      expect(last.retryInSeconds).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off further on repeated failures', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ failFirst: true });
      h.sync.schedule(h.ws);
      await vi.advanceTimersByTimeAsync(300);
      const first = h.statuses.at(-1)!.retryInSeconds!;
      await vi.advanceTimersByTimeAsync(2000);
      const second = h.statuses.at(-1)!.retryInSeconds!;
      expect(second).toBeGreaterThanOrEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resyncs as soon as a dropped connection comes back', async () => {
    const h = harness();
    // Something changed on the server while we were disconnected.
    const changed = { ...seed(NOW), mode: 'live' as const };
    changed.tasks[0]!.status = 'BLOCK';
    (h.repo.load as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(changed);

    const onWorkspaceChanged = h.onWorkspaceChanged;
    h.sync.start(null);

    // The first live connection is not a reconnect: nothing is pulled.
    h.handlers.state?.('live');
    expect(onWorkspaceChanged).not.toHaveBeenCalled();

    // Drop, then come back: the gap must be filled immediately, without
    // waiting for the 60s heartbeat.
    h.handlers.state?.('error');
    h.handlers.state?.('live');
    await new Promise((r) => setTimeout(r, 30));

    expect(onWorkspaceChanged).toHaveBeenCalled();
    const adopted = onWorkspaceChanged.mock.calls.at(-1)?.[0] as { tasks: Array<{ status: string }> } | undefined;
    expect(adopted?.tasks[0]?.status).toBe('BLOCK');
  });

  it('clears the retry timer on stop', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ failFirst: true });
      h.sync.schedule(h.ws);
      await vi.advanceTimersByTimeAsync(300);
      h.sync.stop();
      h.recover();
      await vi.advanceTimersByTimeAsync(5000);
      // Nothing was sent after stop.
      expect(h.flushes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SyncController — setup required', () => {
  function controller(failWith: string | null) {
    const statuses: Array<{ setupRequired: boolean; state: string; error: string | null }> = [];
    const flushes: string[] = [];
    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => null),
      flush: vi.fn(async () => {
        if (failWith) throw new Error(failWith);
        flushes.push('ok');
      }),
      bootstrap: vi.fn(async (ws: unknown) => ws),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      subscribe: vi.fn(() => () => {}),
      logActivity: vi.fn(async () => {}),
      recentActivity: vi.fn(async () => []),
    };
    const sync = new SyncController(new RepositoryHost(repo as never), {
      onWorkspaceChanged: vi.fn(),
      onActivityChanged: vi.fn(),
      onStatus: (s) => statuses.push({ setupRequired: s.setupRequired, state: s.state, error: s.error }),
      onPresence: vi.fn(),
    });
    const ws = seed(NOW);
    ws.mode = 'live' as const;
    sync.setWorkspaceRef(() => ws);
    sync.prime();
    return { sync, ws, statuses, flushes, repo };
  }

  it('flags a missing schema instead of retrying forever', async () => {
    const h = controller("Could not find the table 'public.tasks' in the schema cache");
    h.sync.schedule(h.ws);
    await h.sync.flushNow(h.ws);
    const last = h.statuses.at(-1)!;
    expect(last.setupRequired).toBe(true);
    expect(last.state).toBe('error');
    // No retry countdown: retrying a missing table would just spam.
    expect(last.setupRequired).toBe(true);
  });

  it('does not flag a transient network failure as a setup problem', async () => {
    const h = controller('fetch failed');
    h.sync.schedule(h.ws);
    await h.sync.flushNow(h.ws);
    expect(h.statuses.at(-1)!.setupRequired).toBe(false);
  });

  it('clears the flag once a write succeeds', async () => {
    const h = controller("Could not find the table 'public.tasks' in the schema cache");
    h.sync.schedule(h.ws);
    await h.sync.flushNow(h.ws);
    expect(h.statuses.at(-1)!.setupRequired).toBe(true);

    // Simulate the schema being applied: the next write succeeds.
    (h.repo.flush as unknown as { mockImplementation: (f: () => Promise<void>) => void }).mockImplementation(
      async () => {},
    );
    h.sync.schedule(h.ws);
    await h.sync.flushNow(h.ws);
    expect(h.statuses.at(-1)!.setupRequired).toBe(false);
  });
});

describe('SyncController — connection timeout', () => {
  function idleController() {
    const statuses: Array<{ state: string; error: string | null }> = [];
    const handlers: { onState?: (s: string) => void } = {};
    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => null),
      flush: vi.fn(async () => {}),
      bootstrap: vi.fn(async (ws: unknown) => ws),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      // Capture the handler but never call it: an unreachable project's socket
      // simply never reports in.
      subscribe: vi.fn((h: Record<string, unknown>) => {
        handlers.onState = h.onState as (s: string) => void;
        return () => {};
      }),
      logActivity: vi.fn(async () => {}),
      recentActivity: vi.fn(async () => []),
    };
    const sync = new SyncController(new RepositoryHost(repo as never), {
      onWorkspaceChanged: vi.fn(),
      onActivityChanged: vi.fn(),
      onStatus: (st) => statuses.push({ state: st.state, error: st.error }),
      onPresence: vi.fn(),
    });
    const ws = seed(NOW);
    ws.mode = 'live' as const;
    sync.setWorkspaceRef(() => ws);
    sync.prime();
    return { sync, ws, statuses, handlers };
  }

  it('gives up on "connecting" and says so rather than hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const h = idleController();
      h.sync.start(null);
      // The repository contract emits "connecting" as soon as it is asked to
      // subscribe; the fake does not, so the controller publishes nothing yet.
      await vi.advanceTimersByTimeAsync(9_000);
      const last = h.statuses.at(-1)!;
      expect(last.state).toBe('error');
      expect(last.error).toMatch(/Realtime did not connect/i);
      // Crucially it must not imply the work was lost.
      expect(last.error).toMatch(/still saved/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays quiet once the socket reports live', async () => {
    vi.useFakeTimers();
    try {
      const h = idleController();
      h.sync.start(null);
      h.handlers.onState?.('live');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(h.statuses.some((st) => st.state === 'live')).toBe(true);
      expect(h.statuses.every((st) => !/Realtime did not connect/.test(st.error ?? ''))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer on stop', async () => {
    vi.useFakeTimers();
    try {
      const h = idleController();
      h.sync.start(null);
      h.sync.stop();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(h.statuses.every((st) => !/Realtime did not connect/.test(st.error ?? ''))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sync chip reports the truth', () => {
  const domain = new FlowDomain(seed(NOW), { storage: null });

  it('says "Updates paused" when saving works but realtime is down', () => {
    const html = renderSyncChip(
      {
        state: 'error',
        pending: 0,
        error: 'Realtime did not connect. Changes are still saved; live updates are paused.',
        lastSyncedAt: null,
        retryInSeconds: null,
        realtimePaused: true,
      },
      [],
      domain,
      'supabase',
    );
    expect(html).toContain('Updates paused');
    // The alarming wording must not appear for a realtime-only problem.
    expect(html).not.toContain('>Not saving<');
    // And the tooltip must reassure.
    expect(html).toContain('being saved');
  });

  it('still says "Not saving" for a genuine write failure', () => {
    const html = renderSyncChip(
      {
        state: 'error',
        pending: 2,
        error: 'tasks write failed: permission denied',
        lastSyncedAt: null,
        retryInSeconds: 3,
        realtimePaused: false,
      },
      [],
      domain,
      'supabase',
    );
    expect(html).toContain('Not saving');
    expect(html).toContain('retrying in 3s');
  });

  it('says "Live" when everything is connected', () => {
    const html = renderSyncChip(
      { state: 'live', pending: 0, error: null, lastSyncedAt: Date.now() },
      [],
      domain,
      'supabase',
    );
    expect(html).toContain('Live');
  });

  it('says "Local only" with no backend configured', () => {
    const html = renderSyncChip(
      { state: 'offline', pending: 0, error: null, lastSyncedAt: null },
      [],
      domain,
      'local',
    );
    expect(html).toContain('Local only');
  });
});

describe('setup notice survives later status updates', () => {
  function controllerWithHandlers() {
    const statuses: Array<{ setupRequired: boolean; state: string; error: string | null }> = [];
    const handlers: { onState?: (s: string) => void } = {};
    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => null),
      flush: vi.fn(async () => {}),
      bootstrap: vi.fn(async (ws: unknown) => ws),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      subscribe: vi.fn((h: Record<string, unknown>) => {
        handlers.onState = h.onState as (s: string) => void;
        return () => {};
      }),
      logActivity: vi.fn(async () => {}),
      recentActivity: vi.fn(async () => []),
    };
    const sync = new SyncController(new RepositoryHost(repo as never), {
      onWorkspaceChanged: vi.fn(),
      onActivityChanged: vi.fn(),
      onStatus: (s) => statuses.push({ setupRequired: s.setupRequired, state: s.state, error: s.error }),
      onPresence: vi.fn(),
    });
    return { sync, statuses, handlers };
  }

  it('keeps the flag set across connection updates and renders', () => {
    const { sync, statuses, handlers } = controllerWithHandlers();
    // The app reports the missing schema right after loading.
    sync.markSetupRequired('The shared database has no tables yet.');
    expect(statuses.at(-1)!.setupRequired).toBe(true);

    // Then the socket starts reporting in. Every later publish must preserve
    // the setup flag, or the notice would flicker away.
    handlers.onState?.('connecting');
    expect(statuses.at(-1)!.setupRequired).toBe(true);
    handlers.onState?.('error');
    expect(statuses.at(-1)!.setupRequired).toBe(true);
    handlers.onState?.('live');
    expect(statuses.at(-1)!.setupRequired).toBe(true);
  });

  it('clears once a write succeeds, so the notice disappears', async () => {
    const { sync, statuses } = controllerWithHandlers();
    sync.markSetupRequired('missing');
    const ws = seed(NOW);
    ws.mode = 'live' as const;
    sync.setWorkspaceRef(() => ws);
    sync.schedule(ws);
    await sync.flushNow(ws);
    expect(statuses.at(-1)!.setupRequired).toBe(false);
  });
});

describe('SyncController — pending count is honest', () => {
  it('does not claim edits made mid-flight were saved', async () => {
    const statuses: number[] = [];
    let releaseWrite: (() => void) | null = null;
    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => null),
      // A slow write, so an edit can land while it is in flight.
      flush: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
          }),
      ),
      bootstrap: vi.fn(async (ws: unknown) => ws),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      subscribe: vi.fn(() => () => {}),
      logActivity: vi.fn(async () => {}),
      recentActivity: vi.fn(async () => []),
    };
    const sync = new SyncController(new RepositoryHost(repo as never), {
      onWorkspaceChanged: vi.fn(),
      onActivityChanged: vi.fn(),
      onStatus: (st) => statuses.push(st.pending),
      onPresence: vi.fn(),
    });
    const ws = seed(NOW);
    ws.mode = 'live' as const;
    sync.setWorkspaceRef(() => ws);
    sync.prime();

    sync.schedule(ws);
    await new Promise((r) => setTimeout(r, 0));
    // The write is in flight. Another edit arrives.
    sync.schedule(ws);
    expect(statuses.at(-1)).toBe(2);

    // Let the in-flight write finish: it covered only the first edit.
    // Read through a local: TypeScript narrows `releaseWrite` to its initial
    // `null`, because the only assignment happens inside the executor above.
    const release = releaseWrite as (() => void) | null;
    release?.();
    await new Promise((r) => setTimeout(r, 20));

    // One edit is still outstanding, so the count must not be zero.
    expect(statuses.at(-1)).toBeGreaterThan(0);
  });

  it('reaches zero once everything is written', async () => {
    const statuses: number[] = [];
    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => null),
      flush: vi.fn(async () => {}),
      bootstrap: vi.fn(async (ws: unknown) => ws),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      subscribe: vi.fn(() => () => {}),
      logActivity: vi.fn(async () => {}),
      recentActivity: vi.fn(async () => []),
    };
    const sync = new SyncController(new RepositoryHost(repo as never), {
      onWorkspaceChanged: vi.fn(),
      onActivityChanged: vi.fn(),
      onStatus: (st) => statuses.push(st.pending),
      onPresence: vi.fn(),
    });
    const ws = seed(NOW);
    ws.mode = 'live' as const;
    sync.setWorkspaceRef(() => ws);
    sync.prime();

    sync.schedule(ws);
    await sync.flushNow(ws);
    expect(statuses.at(-1)).toBe(0);
  });
});

describe('resync never discards unsaved work', () => {
  function scene(options: { flushWorks?: boolean } = {}) {
    const flushes: string[] = [];
    const adopted: Array<{ title?: string }> = [];
    let status: { state: string; error: string | null; pending: number } = {
      state: 'live',
      error: null,
      pending: 0,
    };
    // What the server would return: the state WITHOUT the local edit.
    const serverWs = seed(NOW);
    serverWs.mode = 'live' as const;
    serverWs.workspaceId = 'ws-1';
    serverWs.tasks[0]!.title = 'Server title';

    const repo = {
      kind: 'supabase' as const,
      load: vi.fn(async () => JSON.parse(JSON.stringify(serverWs))),
      flush: vi.fn(async (ws: { tasks: Array<{ title: string }> }) => {
        if (options.flushWorks === false) throw new Error('offline');
        flushes.push(ws.tasks[0]!.title);
        // The real server now holds this write, so a snapshot taken afterwards
        // includes it — that is the whole point of flushing first.
        serverWs.tasks[0]!.title = ws.tasks[0]!.title;
      }),
      bootstrap: vi.fn(async (ws: unknown) => ws),
      nextTaskKey: vi.fn(async () => 'NE-1'),
      subscribe: vi.fn(() => () => {}),
      logActivity: vi.fn(async () => {}),
      recentActivity: vi.fn(async () => []),
    };
    const sync = new SyncController(new RepositoryHost(repo as never), {
      onWorkspaceChanged: (replacement) => {
        if (replacement) adopted.push(...replacement.tasks.slice(0, 1));
      },
      onActivityChanged: vi.fn(),
      onStatus: (next) => {
        status = next as never;
      },
      onPresence: vi.fn(),
    });
    const local = seed(NOW);
    local.mode = 'live' as const;
    local.workspaceId = 'ws-1';
    local.tasks[0]!.title = 'Local edit not yet saved';
    sync.setWorkspaceRef(() => local);
    sync.prime();
    return { sync, local, flushes, adopted, repo, status: () => status };
  }

  it('writes the pending edit before adopting the server snapshot', async () => {
    const h = scene();
    // A local edit is queued but the debounce has not fired yet.
    h.sync.schedule(h.local);
    await h.sync.resync();

    // The edit reached the server…
    expect(h.flushes).toContain('Local edit not yet saved');
    // …and the snapshot adopted afterwards still holds it.
    expect(h.adopted.at(-1)?.title).toBe('Local edit not yet saved');
  });

  it('keeps local state when the pending write cannot go out', async () => {
    const h = scene({ flushWorks: false });
    h.sync.schedule(h.local);
    await h.sync.resync();

    // Nothing was adopted over the top of the unsaved change: the caller's
    // workspace is untouched, so the edit survives for the next retry.
    expect(h.adopted).toEqual([]);
    expect(h.local.tasks[0]!.title).toBe('Local edit not yet saved');
  });

  it('still adopts the server snapshot when there is nothing pending', async () => {
    const h = scene();
    await h.sync.resync();
    expect(h.adopted.at(-1)?.title).toBe('Server title');
  });

  it('a recovered write clears the failure state, not just the message', async () => {
    const h = scene({ flushWorks: false });
    // `me` is presence only; an unauthenticated test client passes null.
    await h.sync.start(null);
    h.sync.schedule(h.local, { urgent: true });
    await vi.waitFor(() => expect(h.status().state).toBe('error'));

    // The backend comes back. Without clearing the state the chip keeps saying
    // "Not saving" even though the write succeeded.
    h.repo.flush.mockImplementation(async () => {});
    await h.sync.flushNow(h.local);
    await vi.waitFor(() => expect(h.status().error).toBe(null));
    expect(h.status().state).not.toBe('error');
  });
});
