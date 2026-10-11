/**
 * Storage abstraction.
 *
 * The app talks to a `WorkspaceRepository`, never to `localStorage` or to
 * Supabase directly. Two implementations exist:
 *
 *   LocalRepository     — the original browser-local behaviour. Used by the
 *                         demo playground and whenever Supabase is not
 *                         configured, so development needs no backend.
 *   SupabaseRepository  — shared Postgres + Realtime. The live team workspace.
 *
 * `domain.ts` keeps its synchronous in-memory workspace; persistence happens
 * behind this interface, which is why the rules, rendering and CSS do not care
 * which implementation is active.
 */

import type { Member, Workspace } from '../types';

/** A single row change delivered by the backend. */
export interface RowChange {
  table: 'tasks' | 'subtasks' | 'projects' | 'members' | 'activity';
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Row payload (for DELETE, the primary key fields). */
  row: Record<string, unknown>;
  /** Present on DELETE, where `row` only carries the identity columns. */
  old?: Record<string, unknown>;
}

export type ConnectionState = 'offline' | 'connecting' | 'live' | 'error';

/** Append-only audit entry. */
export interface ActivityEntry {
  actorId: string | null;
  actorName: string;
  action: string;
  taskKey?: string;
  summary?: string;
}

export interface ActivityRecord extends ActivityEntry {
  id: number;
  createdAt: number;
}

export interface PresencePeer {
  memberId: string;
  memberName: string;
  onlineAt: number;
}

export interface SubscribeHandlers {
  /** A row changed somewhere else. */
  onChange(change: RowChange): void;
  /** The socket state changed; the app uses this to resync after a drop. */
  onState(state: ConnectionState): void;
  /** Who else has the board open right now. */
  onPresence(peers: PresencePeer[]): void;
}

export interface WorkspaceRepository {
  readonly kind: 'local' | 'supabase';

  /** Full workspace snapshot. Returns null when the backend is empty. */
  load(): Promise<Workspace | null>;

  /**
   * Delete every row the workspace owns, returning the backend to the state a
   * brand-new deployment is in.
   *
   * Clearing only the browser is not enough once the data is shared: the next
   * write would push the old members and projects straight back up.
   */
  clear(): Promise<void>;

  /**
   * Create the shared workspace and seed its content in one pass.
   *
   * Separate from `flush` because seeding has to set up derived server state —
   * notably each project's `task_counter` — that an ordinary row write must
   * never touch. Implementations without derived state (the browser-local one)
   * can simply fall back to a flush.
   */
  bootstrap(ws: Workspace, name: string): Promise<Workspace>;

  /**
   * Persist the workspace. Implementations diff against the last synced state
   * and write only what changed. `mutationId` tags the write so other clients
   * can recognise (and the origin can ignore) the echo.
   */
  flush(ws: Workspace, mutationId: string): Promise<void>;

  /** Atomically reserve the next task key for a project (NE-1, NE-2, …). */
  nextTaskKey(projectId: string, fallback: () => string): Promise<string>;

  /** Realtime (or polling) updates plus presence. Returns an unsubscribe fn. */
  subscribe(handlers: SubscribeHandlers, me: Member | null): () => void;

  /** Record an action in the audit trail. Never throws. */
  logActivity(entry: ActivityEntry, mutationId: string): Promise<void>;

  /** The most recent activity entries, newest first. */
  recentActivity(limit: number): Promise<ActivityRecord[]>;
}
