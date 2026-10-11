/**
 * Repository host.
 *
 * Holds the active `WorkspaceRepository` and loads (or bootstraps) the
 * workspace from it. The host is deliberately mutable so the app can swap
 * between the local demo playground and the shared backend without rebuilding
 * the domain or any of its closures.
 */

import { emptyWorkspace, initialWorkspace, normalise, seed } from '../domain';
import { isMissingSchemaError } from './supabase';
import { shouldSeedSample } from './index';
import { STORAGE_KEY } from '../constants';
import type { Workspace } from '../types';
import type { ActivityEntry, ActivityRecord, PresencePeer, WorkspaceRepository } from './types';

export interface LoadResult {
  workspace: Workspace;
  /** True when the backend was empty and we created the shared workspace. */
  bootstrapped: boolean;
}

/** A write that failed only because the tables do not exist yet. */
function isSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isMissingSchemaError(message);
}

/** The shared workspace is named once, on first run. */
const WORKSPACE_NAME = 'BlackIT Flow';

export class RepositoryHost {
  private repo: WorkspaceRepository;
  /** Whether an empty backend should be filled with sample content. */
  private readonly seedSample: boolean;

  constructor(repo: WorkspaceRepository, options: { seedSample?: boolean } = {}) {
    this.repo = repo;
    this.seedSample = options.seedSample ?? shouldSeedSample();
  }

  get current(): WorkspaceRepository {
    return this.repo;
  }

  get kind(): 'local' | 'supabase' {
    return this.repo.kind;
  }

  /**
   * True when the backend is configured but its schema has not been created.
   * Read after `load()`; the app surfaces it as a setup notice.
   */
  get schemaMissing(): boolean {
    if (this.repo.kind !== 'supabase') return false;
    return Boolean((this.repo as { isSchemaMissing?: boolean }).isSchemaMissing);
  }

  /** Swap the backing store, keeping anything already held by the app. */
  use(repo: WorkspaceRepository): void {
    this.repo = repo;
  }

  /**
   * Read the workspace. When the backend has never been initialised, seed it
   * with the sample data so the team has something to edit rather than an
   * empty page — the seed is real, editable data from that moment on.
   */
  /** Empty the shared workspace. Used by "Reset to a fresh project". */
  async clear(): Promise<void> {
    await this.repo.clear();
  }

  async load(): Promise<LoadResult> {
    const existing = await this.repo.load();

    // A workspace row with no projects means a previous bootstrap died partway
    // (a rejected write, a dropped connection). Treating that as "set up"
    // leaves the team staring at an empty board with no way back, so top it up
    // instead — the seed is idempotent, so this cannot duplicate anything.
    if (
      existing &&
      this.repo.kind === 'supabase' &&
      this.seedSample &&
      existing.projects.length === 0
    ) {
      const repaired = await this.repairSharedWorkspace(existing);
      return { workspace: repaired, bootstrapped: true };
    }

    if (existing) {
      return { workspace: this.migrateBrowserState(existing), bootstrapped: false };
    }

    // The shared backend needs UUID keys; the demo seed's short ids are fine
    // only for the browser-local workspace.
    const emptyShared = this.repo.kind === 'supabase' && !this.seedSample;
    const seeded = emptyShared
      ? { ...emptyWorkspace(), mode: 'live' as const }
      : this.repo.kind === 'supabase'
        ? initialWorkspace()
        : this.migrateBrowserState(seed());
    seeded.mode = this.repo.kind === 'supabase' ? 'live' : 'demo';
    // `setup: false` means "this visitor has not started yet", which is what
    // shows the welcome screen. An empty shared workspace is exactly that
    // state, so it must not be forced to true — that suppressed the welcome
    // for every first-time visitor.
    seeded.setup = !emptyShared;
    seeded.workspaceId = null;

    if (this.repo.kind === 'supabase') {
      // The schema may be absent. Creating the workspace would fail, and the
      // right behaviour then is to keep working locally until it is applied —
      // the app surfaces a setup notice.
      if (this.schemaMissing) return { workspace: seeded, bootstrapped: false };
      // Nothing to publish: the database stays empty until the team creates
      // their first project.
      if (emptyShared) return { workspace: seeded, bootstrapped: false };
      try {
        const created = await this.createSharedWorkspace(seeded);
        return { workspace: created, bootstrapped: true };
      } catch (error) {
        if (isSchemaError(error)) return { workspace: seeded, bootstrapped: false };
        // Anything else is a genuine failure. Swallowing it here once left a
        // half-created workspace on the server with nobody told — the local
        // copy still worked, so the app looked fine while sharing was broken.
        console.error('BlackIT Flow: could not create the shared workspace', error);
        throw error;
      }
    }
    return { workspace: seeded, bootstrapped: true };
  }

  /**
   * The Supabase repository derives the workspace from the backend, so a first
   * write has to create the workspace row before the normal flush can work.
   * We do that by loading once (which returns null), then letting `flush`
   * create it on demand.
   */
  private async createSharedWorkspace(ws: Workspace): Promise<Workspace> {
    // `bootstrap` seeds derived server state (project task counters) that a
    // plain flush would leave at zero.
    return this.repo.bootstrap(ws, WORKSPACE_NAME);
  }

  /**
   * Fill in the content of an existing but empty workspace. The row is already
   * there, so this seeds projects and tasks into it rather than creating a
   * second workspace.
   */
  private async repairSharedWorkspace(existing: Workspace): Promise<Workspace> {
    console.warn('BlackIT Flow: the shared workspace was incomplete; seeding its projects and tasks.');
    const seedData = initialWorkspace();
    const filled: Workspace = {
      ...existing,
      mode: 'live',
      setup: true,
      members: existing.members.length ? existing.members : seedData.members,
      projects: seedData.projects,
      tasks: seedData.tasks,
    };
    await this.repo.bootstrap(filled, WORKSPACE_NAME);
    return (await this.repo.load()) ?? filled;
  }

  /** Carry over the per-browser choices the server does not store. */
  private migrateBrowserState(ws: Workspace): Workspace {
    const normal = normalise(ws) ?? ws;
    return {
      ...normal,
      mode: this.repo.kind === 'supabase' ? 'live' : normal.mode,
      setup: true,
    };
  }

  /* ---------------- pass-throughs used by the app ---------------- */

  subscribe(handlers: Parameters<WorkspaceRepository['subscribe']>[0], me: Parameters<WorkspaceRepository['subscribe']>[1]): () => void {
    return this.repo.subscribe(handlers, me);
  }

  nextTaskKey(projectId: string, fallback: () => string): Promise<string> {
    return this.repo.nextTaskKey(projectId, fallback);
  }

  logActivity(entry: ActivityEntry, mutationId: string): Promise<void> {
    return this.repo.logActivity(entry, mutationId);
  }

  recentActivity(limit: number): Promise<ActivityRecord[]> {
    return this.repo.recentActivity(limit);
  }

  flush(ws: Workspace, mutationId: string): Promise<void> {
    return this.repo.flush(ws, mutationId);
  }
}

/** Unique enough to correlate a write with the realtime echo it produces. */
export function newMutationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type { PresencePeer };
export { STORAGE_KEY };
