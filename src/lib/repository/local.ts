/**
 * Browser-local repository.
 *
 * This is the original behaviour of the prototype: the workspace is one JSON
 * blob in `localStorage`. It is still the default, which means the app runs
 * with no backend, the demo playground stays free of real data, and the test
 * suite needs no network.
 */

import { STORAGE_KEY } from '../constants';
import { normalise } from '../domain';
import type { AuthUser, Member, Workspace } from '../types';
import type {
  ActivityEntry,
  ActivityRecord,
  NotificationRecord,
  SubscribeHandlers,
  WorkspaceRepository,
} from './types';

export class LocalRepository implements WorkspaceRepository {
  readonly kind = 'local' as const;
  private readonly storage: Storage | null;
  /** Local audit trail, capped so it cannot grow without bound. */
  private activity: ActivityRecord[] = [];
  private nextActivityId = 1;

  constructor(storage?: Storage | null) {
    this.storage =
      storage !== undefined ? storage : typeof localStorage === 'undefined' ? null : localStorage;
    this.activity = this.readActivity();
  }

  private get activityKey(): string {
    return `${STORAGE_KEY}:activity`;
  }

  private readActivity(): ActivityRecord[] {
    try {
      const raw = this.storage?.getItem(this.activityKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ActivityRecord[];
      this.nextActivityId = (parsed[0]?.id ?? 0) + 1;
      return parsed;
    } catch {
      return [];
    }
  }

  async load(): Promise<Workspace | null> {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) return normalise(JSON.parse(raw)) ?? null;
    } catch {
      /* corrupt payload — fall through to "empty" */
    }
    return null;
  }

  async bootstrap(ws: Workspace, _name: string): Promise<Workspace> {
    void _name;
    await this.flush(ws);
    return ws;
  }

  async flush(ws: Workspace, _mutationId?: string): Promise<void> {
    void _mutationId;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(ws));
    } catch {
      /* private mode / quota — the session still works in memory */
    }
  }

  async nextTaskKey(projectId: string, fallback: () => string): Promise<string> {
    // No shared sequence locally, so the client-side count stays authoritative.
    void projectId;
    return fallback();
  }

  async linkAccount(_user: AuthUser): Promise<Member | null> {
    // There is no sign-in without a backend, so nothing is ever bound here and
    // the app keeps the *Acting as* picker this repository was built around.
    void _user;
    return null;
  }

  async claimMember(_memberId: string, _user: AuthUser): Promise<Member | null> {
    void _memberId;
    void _user;
    return null;
  }

  subscribe(_handlers: SubscribeHandlers, _me: unknown): () => void {
    // A single browser cannot race itself; there is nothing to subscribe to.
    void _handlers;
    void _me;
    return () => {};
  }

  async logActivity(entry: ActivityEntry, _mutationId: string): Promise<void> {
    void _mutationId;
    const record: ActivityRecord = { ...entry, id: this.nextActivityId++, createdAt: Date.now() };
    this.activity = [record, ...this.activity].slice(0, 100);
    try {
      this.storage?.setItem(this.activityKey, JSON.stringify(this.activity));
    } catch {
      /* ignore */
    }
  }

  async recentActivity(limit: number): Promise<ActivityRecord[]> {
    return this.activity.slice(0, limit);
  }

  /**
   * There is no bell without a backend.
   *
   * Notifications are written by database triggers, so a browser-local
   * workspace has none to show — the app hides the bell rather than presenting
   * an empty one that can never fill.
   */
  async recentNotifications(_memberId: string, _limit: number): Promise<NotificationRecord[]> {
    void _memberId;
    void _limit;
    return [];
  }

  async markNotificationsRead(_memberId: string, _ids: number[] | 'all'): Promise<void> {
    void _memberId;
    void _ids;
    /* nothing to mark */
  }

  /**
   * Used by tests and the "reset to fresh" path. Async to match the shared
   * repository, which has real rows to delete.
   */
  async clear(): Promise<void> {
    try {
      this.storage?.removeItem(STORAGE_KEY);
      this.storage?.removeItem(this.activityKey);
    } catch {
      /* ignore */
    }
    this.activity = [];
  }
}
