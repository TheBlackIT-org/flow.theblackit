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
    case 'task_assignees':
      return applyTaskAssignee(ws, change);
    case 'subtask_assignees':
      return applySubtaskAssignee(ws, change);
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
  // So are assignees: they live in the join table, so a `tasks` row arrives
  // with an empty list and would otherwise wipe everybody off the card.
  incoming.assigneeIds = held.assigneeIds;

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
  if (index < 0) {
    // A genuinely new step: nobody is on it yet.
    task.subs.push(sub);
  } else {
    // Step owners live in the join table, so this row arrives with an empty
    // list. Overwriting from it would empty the step on every remote edit.
    sub.assigneeIds = task.subs[index]!.assigneeIds;
    task.subs[index] = sub;
  }
  return CHANGED;
}

/* --------------------------- subtask assignees ---------------------------- */

/** One person joining or leaving a subtask step. */
function applySubtaskAssignee(ws: Workspace, change: RowChange): ApplyResult {
  const subtaskId = str(change.row?.subtask_id ?? change.old?.subtask_id);
  const memberId = str(change.row?.member_id ?? change.old?.member_id);
  if (!subtaskId || !memberId) return NOTHING;

  for (const task of ws.tasks) {
    const sub = task.subs.find((s) => s.id === subtaskId);
    if (!sub) continue;
    const present = sub.assigneeIds.includes(memberId);
    if (change.type === 'DELETE') {
      if (!present) return NOTHING;
      sub.assigneeIds = sub.assigneeIds.filter((id) => id !== memberId);
      return CHANGED;
    }
    if (present) return NOTHING;
    // Appended rather than prepended, matching what `load()` does with
    // `assigned_at` so the two agree on who is first.
    sub.assigneeIds.push(memberId);
    return CHANGED;
  }
  return NOTHING;
}

/* ----------------------------- task assignees ----------------------------- */

/**
 * One person joining or leaving a task.
 *
 * The join row carries only `task_id` and `member_id`, so the change is applied
 * as a set membership edit. Order matters to the UI (the first assignee owns the
 * card's colour), so a new row is appended rather than inserted at the front —
 * matching what `load()` does by sorting on `assigned_at`.
 */
function applyTaskAssignee(ws: Workspace, change: RowChange): ApplyResult {
  const taskId = str(change.row?.task_id ?? change.old?.task_id);
  const memberId = str(change.row?.member_id ?? change.old?.member_id);
  if (!taskId || !memberId) return NOTHING;
  const task = ws.tasks.find((t) => t.id === taskId);
  // The task may belong to a project this client is not showing yet; the later
  // `tasks` insert will arrive with the assignee list from the join rows.
  if (!task) return NOTHING;

  const present = task.assigneeIds.includes(memberId);
  if (change.type === 'DELETE') {
    if (!present) return NOTHING;
    task.assigneeIds = task.assigneeIds.filter((id) => id !== memberId);
    // The "took it" credit belongs to whoever is actually still on the task.
    if (task.claimedBy === memberId) {
      task.claimedBy = task.assigneeIds[0] ?? null;
      task.claimedAt = task.claimedBy ? task.claimedAt : null;
    }
    return CHANGED;
  }

  if (present) return NOTHING;
  task.assigneeIds.push(memberId);
  if (task.assigneeIds.length === 1) {
    task.claimedBy = memberId;
    task.claimedAt = Date.now();
  }
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
      if (t.assigneeIds.includes(id)) t.assigneeIds = t.assigneeIds.filter((x) => x !== id);
      if (t.claimedBy === id) {
        t.claimedBy = t.assigneeIds[0] ?? null;
        t.claimedAt = t.claimedBy ? t.claimedAt : null;
      }
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
