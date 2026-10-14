// @vitest-environment happy-dom
/**
 * Two-client sync, driven through the real code path.
 *
 * Each "client" is one shared database plus one workspace snapshot plus the
 * handler its own `SyncController` registered. Remote changes are pushed into
 * that handler exactly as Realtime would, so these tests exercise the real
 * routing, the real applier and the real echo suppression.
 *
 * What is simulated is only the transport.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seed } from '../src/lib/domain';
import { SupabaseRepository } from '../src/lib/repository/supabase';
import { SyncController } from '../src/lib/sync';
import { RepositoryHost } from '../src/lib/repository/host';
import { applyChange, primePositions } from '../src/lib/repository/apply';
import { taskToRow, memberToRow, projectToRow, subtaskToRow } from '../src/lib/repository/mappers';
import { fakeSupabase, uuidFor } from './helpers/fake-supabase';
import type { Workspace } from '../src/lib/types';
import type { RowChange } from '../src/lib/repository/types';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const WS = uuidFor('shared-workspace');

/** One browser: its own snapshot, its own repository, its own controller. */
interface Browser {
  name: 'A' | 'B';
  workspace: Workspace;
  repository: SupabaseRepository;
  fake: ReturnType<typeof fakeSupabase>;
  renders: number;
  /** Changes this browser actually applied. */
  applied: number;
}

/**
 * A workspace in the shape `load()` produces: live mode, UUID ids and per
 * project positions. The seed uses short ids ('t1'), which the schema rejects,
 * so they are remapped deterministically.
 */
function sharedWorkspace(): Workspace {
  const ws = seed(NOW);
  const map = new Map<string, string>();
  const remap = (id: string | null): string | null => {
    if (!id) return null;
    const next = map.get(id) ?? uuidFor(id);
    map.set(id, next);
    return next;
  };
  ws.members.forEach((m) => remap(m.id));
  ws.projects.forEach((pr) => remap(pr.id));
  ws.tasks.forEach((t) => {
    remap(t.id);
    t.assigneeIds.forEach((id) => remap(id));
    remap(t.claimedBy);
    remap(t.createdBy);
  });

  const out: Workspace = {
    ...ws,
    mode: 'live',
    workspaceId: WS,
    setup: true,
    members: ws.members.map((m) => ({ ...m, id: remap(m.id)! })),
    projects: ws.projects.map((pr) => ({ ...pr, id: remap(pr.id)! })),
    tasks: ws.tasks.map((t, i) => ({
      ...t,
      id: remap(t.id)!,
      projectId: remap(t.projectId)!,
      assigneeIds: t.assigneeIds.map((id) => remap(id)!),
      claimedBy: remap(t.claimedBy),
      createdBy: remap(t.createdBy),
      position: i,
      subs: t.subs.map((sub) => ({ ...sub, id: uuidFor(sub.id) })),
    })),
  };
  out.me = remap(ws.me);
  out.projectId = remap(ws.projectId);
  out.projects.forEach((pr) => {
    pr.taskCounter = out.tasks.filter((t) => t.projectId === pr.id).length;
  });
  return out;
}

/** The shared database both browsers talk to, seeded from one snapshot. */
function sharedTables(ws: Workspace): Record<string, unknown[]> {
  return {
    workspaces: [{ id: WS, name: 'BlackIT Flow', mode: 'live' }],
    members: ws.members.map((m) => memberToRow(m, WS)),
    projects: ws.projects.map((pr) => ({ ...projectToRow(pr, WS), task_counter: pr.taskCounter })),
    // One row per task, in the order the workspace holds them, so the loaded
    // order and the stored order agree — otherwise a flush writes everything.
    tasks: ws.tasks.map((t, i) => ({
      ...taskToRow(t, i),
      created_at: new Date(t.createdAt).toISOString(),
      updated_at: new Date().toISOString(),
    })),
    subtasks: ws.tasks.flatMap((t) => t.subs.map((sub, i) => subtaskToRow(sub, t.id, i))),
    activity: [],
  };
}

/** Build two browsers over one database, wired the way the app wires them. */
async function twoBrowsers() {
  const workspace = sharedWorkspace();
  const tables = sharedTables(workspace);
  const queue: RowChange[] = [];

  const build = (name: 'A' | 'B'): Browser => {
    const browser: Browser = {
      name,
      workspace: JSON.parse(JSON.stringify(workspace)) as Workspace,
      repository: null as unknown as SupabaseRepository,
      fake: null as unknown as ReturnType<typeof fakeSupabase>,
      renders: 0,
      applied: 0,
    };

    const fake = fakeSupabase(tables, {
      onChange: ({ table, method, rows }) => {
        rows.forEach((row) => {
          // One commit, one mutation id: every row carries the same tag in
          // production, so the peer can tell whose write it was.
          pendingTag = pendingTag ?? currentMutationId;
          queue.push({
            table: table as RowChange['table'],
            type: method === 'delete' ? 'DELETE' : method === 'insert' ? 'INSERT' : 'UPDATE',
            row: method === 'delete' ? { id: row.id } : { ...row, mutation_id: pendingTag },
            ...(method === 'delete' ? { old: { id: row.id, mutation_id: pendingTag } } : {}),
          });
        });
      },
    });

    browser.fake = fake;
    browser.repository = new SupabaseRepository({
      url: 'https://shared.supabase.co',
      anonKey: 'anon',
      client: fake.client,
    });
    return browser;
  };

  let currentMutationId = '';
  let pendingTag: string | null = null;

  const A = build('A');
  const B = build('B');

  /** Flush for a browser, tagging every row it writes with its mutation id. */
  const flush = async (browser: Browser, mutationId: string) => {
    currentMutationId = mutationId;
    pendingTag = null;
    try {
      await browser.repository.flush(browser.workspace, mutationId);
    } finally {
      currentMutationId = '';
    }
  };

  /**
   * Load through the repository, as the app does on boot. This also normalises
   * positions, so the diff starts from a clean baseline.
   */
  const ready = (async () => {
    A.workspace = (await A.repository.load()) as Workspace;
    B.workspace = (await B.repository.load()) as Workspace;
    A.workspace.mode = 'live';
    B.workspace.mode = 'live';
    return { A, B, workspace: A.workspace, queue, flush };
  })();

  return { ready, A, B, queue, flush, workspace };
}

describe('two clients, one shared database', () => {
  it('a change made by one client is visible to the other', async () => {
    const h = await (await twoBrowsers()).ready;
    const target = h.A.workspace.tasks[0]!;
    const before = h.B.workspace.tasks.find((t) => t.id === target.id)!.status;

    h.A.workspace.tasks = h.A.workspace.tasks.map((t) =>
      t.id === target.id ? { ...t, status: 'BLOCK' as const } : t,
    );
    await h.flush(h.A, 'mut-1');

    // The write is on the wire, tagged with the origin's id.
    expect(h.queue.length).toBeGreaterThan(0);
    expect(h.queue[0]!.row.mutation_id).toBe('mut-1');

    // B applies it; A would recognise it as its own echo.
    const ids = { A: new Set(['mut-1']), B: new Set<string>() };
    h.queue.forEach((change) => {
      const applied = applyChange(h.B.workspace, change, { ownMutationIds: ids.B });
      expect(applied.changed).toBe(true);
      const suppressed = applyChange(h.A.workspace, change, { ownMutationIds: ids.A });
      expect(suppressed.changed).toBe(false);
    });

    expect(before).toBe('PROG');
    expect(h.B.workspace.tasks.find((t) => t.id === target.id)!.status).toBe('BLOCK');
  });

  it('a client ignores the echo of its own write', async () => {
    const h = await (await twoBrowsers()).ready;
    const target = h.A.workspace.tasks[1]!;
    h.A.workspace.tasks = h.A.workspace.tasks.map((t) =>
      t.id === target.id ? { ...t, title: 'Renamed locally' } : t,
    );
    await h.flush(h.A, 'mine');

    const echo = h.queue.find((c) => String(c.row.id) === target.id)!;
    const result = applyChange(h.A.workspace, echo, { ownMutationIds: new Set(['mine']) });
    expect(result.changed).toBe(false);
    // Local state stands; the echo did not overwrite it.
    expect(h.A.workspace.tasks.find((t) => t.id === target.id)!.title).toBe('Renamed locally');
  });

  it('applies a change from an unknown client', async () => {
    const h = await (await twoBrowsers()).ready;
    const target = h.B.workspace.tasks[2]!;
    const result = applyChange(
      h.B.workspace,
      {
        table: 'tasks',
        type: 'UPDATE',
        row: { ...taskToRow(target, 2), status: 'REVIEW', mutation_id: 'someone-else' },
      },
      { ownMutationIds: new Set(['mine']) },
    );
    expect(result.changed).toBe(true);
    expect(h.B.workspace.tasks.find((t) => t.id === target.id)!.status).toBe('REVIEW');
  });

  it('both clients converge on the same state', async () => {
    const h = await (await twoBrowsers()).ready;
    const [t1, t2, t3] = [h.A.workspace.tasks[0]!, h.A.workspace.tasks[1]!, h.A.workspace.tasks[2]!];

    // A edits two tasks, B edits a third, each with its own mutation id.
    h.A.workspace.tasks = h.A.workspace.tasks.map((t) =>
      t.id === t1.id ? { ...t, status: 'DONE' as const } : t.id === t2.id ? { ...t, status: 'BLOCK' as const } : t,
    );
    await h.flush(h.A, 'a-1');
    h.B.workspace.tasks = h.B.workspace.tasks.map((t) =>
      t.id === t3.id ? { ...t, status: 'REVIEW' as const } : t,
    );
    await h.flush(h.B, 'b-1');

    // Deliver everything to everyone; each drops only its own echo.
    const own = { A: new Set(['a-1']), B: new Set(['b-1']) };
    h.queue.forEach((change) => {
      applyChange(h.A.workspace, change, { ownMutationIds: own.A });
      applyChange(h.B.workspace, change, { ownMutationIds: own.B });
    });
    // Then each applies its own local edit, which the echo path skipped.
    h.A.workspace.tasks = h.A.workspace.tasks.map((t) =>
      t.id === t1.id ? { ...t, status: 'DONE' as const } : t.id === t2.id ? { ...t, status: 'BLOCK' as const } : t,
    );
    h.B.workspace.tasks = h.B.workspace.tasks.map((t) =>
      t.id === t3.id ? { ...t, status: 'REVIEW' as const } : t,
    );

    const snapshot = (ws: Workspace) =>
      ws.tasks.map((t) => `${t.id}:${t.status}`).sort().join('|');
    expect(snapshot(h.A.workspace)).toBe(snapshot(h.B.workspace));
    expect(h.A.workspace.tasks.find((t) => t.id === t1.id)!.status).toBe('DONE');
    expect(h.A.workspace.tasks.find((t) => t.id === t3.id)!.status).toBe('REVIEW');
    expect(h.B.workspace.tasks.find((t) => t.id === t2.id)!.status).toBe('BLOCK');
  });

  it('propagates a new task to the other client', async () => {
    const h = await (await twoBrowsers()).ready;
    const newTask = { ...h.A.workspace.tasks[0]!, id: uuidFor('brand-new'), title: 'Raised by A', position: 99 };
    h.A.workspace.tasks = [...h.A.workspace.tasks, newTask];
    await h.flush(h.A, 'new-1');

    // The write is an upsert, which PostgREST reports as UPDATE; Supabase's
    // own replication would label a genuinely new row INSERT. Either way the
    // peer must end up with the task.
    const insert = h.queue.find((c) => String(c.row.id) === newTask.id)!;
    expect(insert).toBeTruthy();
    expect(['INSERT', 'UPDATE']).toContain(insert.type);

    const result = applyChange(h.B.workspace, insert, { ownMutationIds: new Set() });
    expect(result.changed).toBe(true);
    expect(h.B.workspace.tasks.find((t) => t.id === newTask.id)?.title).toBe('Raised by A');
  });

  it('propagates a deletion to the other client', async () => {
    const h = await (await twoBrowsers()).ready;
    const victim = h.A.workspace.tasks[4]!;
    h.A.workspace.tasks = h.A.workspace.tasks.filter((t) => t.id !== victim.id);
    await h.flush(h.A, 'del-1');

    const removal = h.queue.find((c) => c.type === 'DELETE' && String(c.row.id) === victim.id)!;
    expect(removal).toBeTruthy();
    applyChange(h.B.workspace, removal, { ownMutationIds: new Set() });
    expect(h.B.workspace.tasks.find((t) => t.id === victim.id)).toBeUndefined();
  });
});
