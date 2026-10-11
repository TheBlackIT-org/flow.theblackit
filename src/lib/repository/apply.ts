/**
 * Applies remote row changes to the in-memory workspace.
 *
 * Two rules keep this from fighting the local user:
 *
 *  1. **Echo suppression.** A change carrying a `mutation_id` this browser
 *     emitted is dropped — we already applied it optimistically. Without this,
 *     a slow round trip would overwrite keystrokes made in the meantime.
 *  2. **Ordering.** Reordering rewrites the `position` of several rows, which
 *     cannot be reconstructed from one event, so that case asks the caller for
 *     a full resync instead of guessing.
 */

import { memberFromRow, projectFromRow, subtaskFromRow, taskFromRow } from './mappers';
import type { Workspace } from '../types';
import type { RowChange } from './types';

export interface ApplyResult {
  /** The workspace changed and the UI should re-render. */
  changed: boolean;
  /** The change cannot be applied incrementally; resync from the backend. */
  needsResync: boolean;
}

/**
 * The mutation id this browser is currently writing. Kept here because the
 * applier is the only consumer that needs to recognise the echo.
 */
let currentMutationId: string | null = null;
export function setCurrentMutationId(id: string | null): void {
  currentMutationId = id;
}
export function getCurrentMutationId(): string | null {
  return currentMutationId;
}

export interface ApplyContext {
  /** Mutation ids this browser produced, so their echoes are ignored. */
  ownMutationIds: Set<string>;
}

const str = (value: unknown, fallback = ''): string =>
  value === null || value === undefined ? fallback : String(value);

export function applyChange(ws: Workspace, change: RowChange, ctx: ApplyContext): ApplyResult {
  const tag = str(change.row?.mutation_id ?? change.old?.mutation_id, '');
  if (tag && ctx.ownMutationIds.has(tag)) return NOTHING;

  switch (change.table) {
    case 'tasks':
      return applyTask(ws, change);
    case 'subtasks':
      return applySubtask(ws, change);
    case 'projects':
      return applyProject(ws, change);
    case 'members':
      return applyMember(ws, change);
    case 'activity':
      // Handled by the controller before it gets here: the feed is refetched,
      // not patched into the workspace.
      return NOTHING;
    default:
      return NOTHING;
  }
}

/**
 * Last server position seen per task, per workspace. Weak so it cannot leak a
 * workspace that has been replaced.
 */
const lastKnownPosition = new WeakMap<Workspace, Map<string, number | undefined>>();

function trackPosition(ws: Workspace, id: string, position: number | undefined): void {
  let map = lastKnownPosition.get(ws);
  if (!map) {
    map = new Map();
    lastKnownPosition.set(ws, map);
  }
  map.set(id, position);
}

/**
 * Seed the position baseline from a fresh snapshot. Called after a load or a
 * resync: without it the first event for a task looks like a move and triggers
 * a pointless resync.
 */
export function primePositions(ws: Workspace): void {
  const map = new Map<string, number | undefined>();
  ws.tasks.forEach((t) => map.set(t.id, t.position));
  lastKnownPosition.set(ws, map);
}

/**
 * Whether an event's position differs from the baseline. Exported so the rule
 * can be tested without driving a whole controller.
 */
export function isReorder(ws: Workspace, taskId: string, position: number | undefined): boolean {
  const baseline = lastKnownPosition.get(ws)?.get(taskId);
  if (position === undefined) return false;
  if (baseline === undefined) return false;
  return position !== baseline;
}

const NOTHING: ApplyResult = { changed: false, needsResync: false };
const CHANGED: ApplyResult = { changed: true, needsResync: false };

/* --------------------------------- tasks --------------------------------- */

function applyTask(ws: Workspace, change: RowChange): ApplyResult {
  const id = str(change.row?.id ?? change.old?.id);
  if (!id) return NOTHING;
  const index = ws.tasks.findIndex((t) => t.id === id);

  if (change.type === 'DELETE') {
    if (index < 0) return NOTHING;
    ws.tasks.splice(index, 1);
    return CHANGED;
  }

  const incoming = taskFromRow(change.row);
  if (index < 0) {
    ws.tasks.push(incoming);
    // A task can arrive for a project we are not showing; that is fine, the
    // chain filters by project at render time.
    return CHANGED;
  }

  const held = ws.tasks[index]!;
  // Subtasks and the collapsed/expanded flag are held locally (subtasks have
  // their own table and their own events).
  incoming.subs = held.subs;
  incoming.open = held.open;

  // Every row carries `position`, so its mere presence proves nothing. Only a
  // value that differs from the one we already hold is a real reorder — and a
  // reorder cannot be reconstructed from a single event, so it triggers a
  // resync instead of the incremental fast path.
  const orderChanged = isReorder(ws, id, incoming.position);
  trackPosition(ws, id, incoming.position);
  ws.tasks[index] = incoming;

  return orderChanged ? { changed: true, needsResync: true } : CHANGED;
}

/* -------------------------------- subtasks -------------------------------- */

function applySubtask(ws: Workspace, change: RowChange): ApplyResult {
  const id = str(change.row?.id ?? change.old?.id);
  const taskId = str(change.row?.task_id ?? change.old?.task_id);
  const task = ws.tasks.find((t) => t.id === taskId);
  if (!task || !id) return NOTHING;

  const index = task.subs.findIndex((s) => s.id === id);
  if (change.type === 'DELETE') {
    if (index < 0) return NOTHING;
    task.subs.splice(index, 1);
    return CHANGED;
  }

  const sub = subtaskFromRow(change.row);
  if (index < 0) task.subs.push(sub);
  else task.subs[index] = sub;
  return CHANGED;
}

/* -------------------------------- projects -------------------------------- */

function applyProject(ws: Workspace, change: RowChange): ApplyResult {
  const id = str(change.row?.id ?? change.old?.id);
  if (!id) return NOTHING;
  const index = ws.projects.findIndex((p) => p.id === id);

  if (change.type === 'DELETE') {
    if (index < 0) return NOTHING;
    ws.projects.splice(index, 1);
    ws.tasks = ws.tasks.filter((t) => t.projectId !== id);
    if (ws.projectId === id) ws.projectId = ws.projects[0]?.id ?? null;
    return CHANGED;
  }

  const project = projectFromRow(change.row);
  if (index < 0) ws.projects.push(project);
  else ws.projects[index] = project;
  return CHANGED;
}

/* --------------------------------- members -------------------------------- */

function applyMember(ws: Workspace, change: RowChange): ApplyResult {
  const id = str(change.row?.id ?? change.old?.id);
  if (!id) return NOTHING;
  const index = ws.members.findIndex((m) => m.id === id);

  if (change.type === 'DELETE') {
    if (index < 0) return NOTHING;
    ws.members.splice(index, 1);
    ws.tasks.forEach((t) => {
      if (t.assigneeId === id) t.assigneeId = null;
      if (t.claimedBy === id) t.claimedBy = null;
    });
    if (ws.me === id) ws.me = ws.members[0]?.id ?? null;
    return CHANGED;
  }

  const member = memberFromRow(change.row);
  if (index < 0) ws.members.push(member);
  else ws.members[index] = member;
  return CHANGED;
}

/**
 * Reorder the cached tasks to match server positions, then keep only the
 * active project's tasks contiguous. Used after a position change.
 */
export function sortByServerOrder(ws: Workspace, rows: Array<{ id: string; position: number }>): void {
  const rank = new Map(rows.map((r) => [r.id, r.position]));
  ws.tasks.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}
