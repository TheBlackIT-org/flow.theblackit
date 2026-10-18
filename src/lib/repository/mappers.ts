/**
 * Row ⇄ domain mapping.
 *
 * Kept separate from the Supabase client so the mapping can be unit tested
 * without a network, and so `apply.ts` can reuse it for realtime payloads.
 */

import type { Member, PriorityId, Project, StatusId, Subtask, Task } from '../types';

export type Row = Record<string, unknown>;

export function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

export function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function str(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/* -------------------------------- → domain -------------------------------- */

export function memberFromRow(row: Row): Member {
  const member: Member = {
    id: str(row.id),
    name: str(row.name, 'Unnamed'),
    role: (str(row.role, 'member') as Member['role']) ?? 'member',
    title: str(row.title),
  };
  if (row.is_agent) member.agent = true;
  // Present from `0003_member_identity.sql`. Read defensively so a deployment
  // that has not run it yet still loads (the columns come back undefined).
  if (row.email !== undefined) member.email = strOrNull(row.email);
  if (row.user_id !== undefined) member.userId = strOrNull(row.user_id);
  return member;
}

export function projectFromRow(row: Row): Project {
  const project: Project = {
    id: str(row.id),
    key: str(row.key, 'PRJ'),
    name: str(row.name, 'Untitled project'),
    product: str(row.product),
  };
  if (row.task_counter !== undefined && row.task_counter !== null) {
    project.taskCounter = Number(row.task_counter);
  }
  return project;
}

export function taskFromRow(row: Row): Task {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    key: str(row.key),
    position: Number(row.position ?? 0),
    title: str(row.title),
    typeId: str(row.type_id, 'tt3'),
    stage: str(row.stage, 'New'),
    status: str(row.status, 'TODO') as StatusId,
    // Assignees live in their own table, so they are attached by `load()`
    // rather than read from a column here. The legacy `tasks.assignee_id`
    // column survives the transition but is deliberately ignored: two sources
    // of truth for the same fact would drift the first time one was written.
    assigneeIds: [],
    priority: str(row.priority, 'normal') as PriorityId,
    estimate: Number(row.estimate ?? 3),
    dueAt: ms(row.due_at),
    dependsOn: Array.isArray(row.depends_on) ? (row.depends_on as unknown[]).map(String) : [],
    description: str(row.description),
    createdAt: ms(row.created_at) ?? Date.now(),
    createdBy: strOrNull(row.created_by),
    claimedBy: strOrNull(row.claimed_by),
    claimedAt: ms(row.claimed_at),
    completedAt: ms(row.completed_at),
    subs: [],
    open: false,
  };
}

/** One row of the task ⇄ member join table. */
export interface TaskAssigneeRow {
  taskId: string;
  memberId: string;
}

export function taskAssigneeFromRow(row: Row): TaskAssigneeRow {
  return { taskId: str(row.task_id), memberId: str(row.member_id) };
}

export function taskAssigneeToRow(a: TaskAssigneeRow): Row {
  // `assigned_at` and `assigned_by` are filled in by the database: the client
  // does not track when or by whom each person was added, and a trigger can
  // read the actor from the session rather than trusting the payload.
  return { task_id: a.taskId, member_id: a.memberId };
}

export function subtaskFromRow(row: Row): Subtask {
  return {
    id: str(row.id),
    t: str(row.text),
    done: Boolean(row.done),
    // Attached by `load()` from `subtask_assignees`. The legacy
    // `subtasks.assignee_id` column survives the transition but is ignored
    // here: two sources of truth for the same fact would drift.
    assigneeIds: [],
  };
}

/** One row of the subtask ⇄ member join table. */
export interface SubtaskAssigneeRow {
  subtaskId: string;
  memberId: string;
}

export function subtaskAssigneeToRow(a: SubtaskAssigneeRow): Row {
  // `assigned_at` and `assigned_by` are filled in by the database.
  return { subtask_id: a.subtaskId, member_id: a.memberId };
}

/* -------------------------------- → row ---------------------------------- */

export function memberToRow(m: Member, workspaceId: string): Row {
  return {
    id: m.id,
    workspace_id: workspaceId,
    name: m.name,
    role: m.role,
    title: m.title,
    is_agent: Boolean(m.agent),
    // The invite address. `user_id` is deliberately absent: it is set by the
    // one-off claim (`linkAccount`) and must never ride along on an ordinary
    // member edit, or a diff-flush would rewrite the binding.
    email: m.email ?? null,
  };
}

export function projectToRow(p: Project, workspaceId: string, isNew = false): Row {
  const row: Row = {
    id: p.id,
    workspace_id: workspaceId,
    key: p.key,
    name: p.name,
    product: p.product,
  };
  // `task_counter` is NOT NULL, so an INSERT must carry a value. A project made
  // through the UI has no counter yet, which made every project insert fail
  // with "null value in column task_counter".
  //
  // An UPDATE still omits an unknown counter, so an ordinary edit never resets
  // a sequence the server owns.
  if (p.taskCounter !== undefined) row.task_counter = p.taskCounter;
  else if (isNew) row.task_counter = 0;
  return row;
}

/**
 * `position` is passed in rather than read from `t.position`: the domain
 * reorders the task array and does not maintain a position field, so the array
 * index is the only authoritative order. Reading the field made a drag produce
 * an unchanged row, and the change was silently never written.
 */
export function taskToRow(t: Task, position: number): Row {
  return {
    id: t.id,
    project_id: t.projectId,
    key: t.key,
    position,
    title: t.title,
    description: t.description,
    stage: t.stage,
    status: t.status,
    type_id: t.typeId,
    priority: t.priority,
    estimate: t.estimate,
    // No `assignee_id`: the join table owns assignment now. Omitting the column
    // leaves the legacy value untouched instead of clobbering it on every save.
    due_at: iso(t.dueAt),
    depends_on: t.dependsOn,
    created_by: t.createdBy,
    created_at: iso(t.createdAt),
    claimed_by: t.claimedBy,
    claimed_at: iso(t.claimedAt),
    completed_at: iso(t.completedAt),
  };
}

export function subtaskToRow(s: Subtask, taskId: string, position: number): Row {
  return {
    id: s.id,
    task_id: taskId,
    text: s.t,
    done: s.done,
    position,
    // No `assignee_id`: the join table owns step assignment now. Omitting the
    // column leaves the legacy value untouched instead of clobbering it.
  };
}
