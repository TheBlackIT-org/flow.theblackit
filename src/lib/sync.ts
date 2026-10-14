/**
 * Sync controller — everything between "the user clicked" and "everyone else
 * sees it".
 *
 * Flow of a local edit:
 *
 *   domain mutation → save() → persist hook → schedule() → flush()
 *                                            ↘ optimistic UI already rendered
 *
 * Flow of a remote edit:
 *
 *   provider → realtime event → applyChange() → render()
 *
 * Reliability rules:
 *  - Writes are **debounced and serialised**: a burst of keystrokes becomes one
 *    round trip, and two flushes never interleave their diffs.
 *  - **Echo suppression**: every write carries a mutation id; the origin drops
 *    its own echo instead of re-applying it.
 *  - **Resync on reconnect and on focus**, plus a slow heartbeat, because a
 *    closed laptop lid silently kills the socket and stale data is the worst
 *    failure mode in a shared tool.
 */

import { newMutationId, type RepositoryHost } from './repository/host';
import { applyChange, primePositions, sortByServerOrder } from './repository/apply';
import { isMissingSchemaError } from './repository/supabase';
import { setCurrentMutationId } from './repository/apply';
import type { ConnectionState, PresencePeer, RowChange } from './repository/types';
import type { MutationEvent } from './domain';
import type { Member, Workspace } from './types';

const WRITE_DEBOUNCE_MS = 220;
const HEARTBEAT_MS = 60_000;
const RESYNC_DEBOUNCE_MS = 400;
/**
 * How long to wait for the socket before giving up on "connecting". Without
 * this the header sits on "Connecting" forever when a project is unreachable,
 * which reads as "my work is not saved" — the most alarming possible signal.
 */
const CONNECT_TIMEOUT_MS = 8_000;
/** Backoff for a failed write: the change stays pending until it lands. */
const RETRY_BASE_MS = 1_500;
const RETRY_MAX_MS = 30_000;

export interface SyncStatus {
  state: ConnectionState;
  /** Changes not yet acknowledged by the backend. */
  pending: number;
  lastSyncedAt: number | null;
  error: string | null;
  /** Seconds until the next retry, when a write has failed. */
  retryInSeconds: number | null;
  /**
   * True when the backend is reachable but its schema has not been created.
   * Distinct from a generic error: the app still works locally, and the fix is
   * a one-time setup step rather than a retry.
   */
  setupRequired: boolean;
  /**
   * True when writes are reaching the backend but the realtime channel is not
   * connected. Saving works; only live updates are affected — which must not be
   * reported as "not saving".
   */
  realtimePaused: boolean;
}

export interface SyncCallbacks {
  /**
   * The workspace changed underneath us and the UI must re-render. When a
   * replacement snapshot is supplied the app adopts it; otherwise the existing
   * workspace was mutated in place.
   */
  onWorkspaceChanged(replacement?: Workspace): void;
  /** An `activity` row landed; the app refetches the feed. */
  onActivityChanged(): void;
  /** A `notifications` row landed; the app refetches the bell. */
  onNotificationsChanged(): void;
  onStatus(status: SyncStatus): void;
  onPresence(peers: PresencePeer[]): void;
}

export class SyncController {
  private readonly host: RepositoryHost;
  private readonly callbacks: SyncCallbacks;
  private readonly ownMutationIds = new Set<string>();

  private timer: number | null = null;
  private inFlight: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private heartbeat: number | null = null;
  private listeners: Array<() => void> = [];
  private pending = 0;
  private resyncTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryAttempt = 0;
  /** The workspace with unwritten changes, so a retry can pick it back up. */
  private dirty: Workspace | null = null;
  /** True once the channel has been live, so a reconnect can be detected. */
  private wasLive = false;
  private connectTimer: number | null = null;
  private status: SyncStatus = {
    state: 'offline',
    pending: 0,
    lastSyncedAt: null,
    error: null,
    retryInSeconds: null,
    setupRequired: false,
    realtimePaused: false,
  };
  private readonly enabled: boolean;

  constructor(host: RepositoryHost, callbacks: SyncCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    // The local repository has nothing to sync with.
    this.enabled = host.kind === 'supabase';
  }

  /* ------------------------------ lifecycle ----------------------------- */

  /**
   * Called once by the domain's persist hook.
   *
   * The demo playground is browser-local by contract: it must never write its
   * sample data into the team's shared database.
   */
  schedule(ws: Workspace, options: { urgent?: boolean } = {}): void {
    if (!this.enabled) return;
    if (ws.mode === 'demo') return;
    this.dirty = ws;
    this.pending += 1;
    this.publish({ pending: this.pending });
    if (this.timer !== null) window.clearTimeout(this.timer);
    // Creating a task or project is the moment a user is most likely to close
    // the tab, so it goes straight out instead of waiting out the debounce.
    const delay = options.urgent ? 0 : WRITE_DEBOUNCE_MS;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush(ws);
    }, delay);
  }

  /**
   * Write immediately — used before a destructive action, on page hide, and to
   * confirm a newly created task reached the backend.
   *
   * Resolves to `true` when the write was accepted. The browser-local
   * repository and the demo workspace have nothing to send, so both report
   * success: there is no remote copy that could be missing.
   */
  async flushNow(ws: Workspace): Promise<boolean> {
    if (!this.enabled) return true;
    // Same contract as schedule(): a local playground is never published.
    if (ws.mode === 'demo') return true;
    this.dirty = ws;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    return await this.flush(ws);
  }

  /**
   * Write the workspace. Resolves to `true` when the backend accepted it.
   *
   * It deliberately does NOT reject: a failed write is retried and must not
   * surface as an unhandled rejection. Callers that need the outcome — notably
   * `resync`, which must not adopt a snapshot over unsaved work — check the
   * return value.
   */
  private async flush(ws: Workspace): Promise<boolean> {
    if (this.inFlight) await this.inFlight.catch(() => {});
    const mutationId = newMutationId();
    this.ownMutationIds.add(mutationId);
    setCurrentMutationId(mutationId);

    // How many edits this write covers. Anything scheduled *while* it is in
    // flight is not included, so zeroing the counter on success would claim
    // those were saved too.
    const claimed = Math.max(1, this.pending);

    let ok = false;
    const run = this.host
      .flush(ws, mutationId)
      .then(() => {
        ok = true;
        // Subtract what this write covered, leaving newer edits accounted for.
        this.pending = Math.max(0, this.pending - claimed);
        this.dirty = this.pending > 0 ? this.dirty : null;
        if (this.pending > 0) {
          // More work arrived mid-flight; send it right away.
          this.scheduleAgain();
        }
        this.retryAttempt = 0;
        if (this.retryTimer !== null) {
          window.clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.publish({
          // A write that succeeded proves the backend is reachable, so clear
          // the error *state* as well as the message — otherwise the chip keeps
          // saying "Not saving" after the next write goes through.
          state: 'live' as const,
          pending: this.pending,
          lastSyncedAt: Date.now(),
          error: null,
          retryInSeconds: null,
          setupRequired: false,
          realtimePaused: false,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // The change is NOT dropped: the dirty workspace stays queued and we
        // retry with backoff, because silently losing a teammate's edit is the
        // worst thing this layer can do.
        this.pending = Math.max(1, this.pending);
        this.dirty = this.dirty ?? ws;
        // A missing schema is a setup step, not a transient failure: retrying
        // it forever would just spam. Surface it and let the user run the SQL.
        if (isMissingSchemaError(message)) {
          this.publish({ error: message, state: 'error', setupRequired: true, retryInSeconds: null });
          return;
        }
        this.scheduleRetry(message);
      })
      .finally(() => {
        this.inFlight = null;
        // Keep the id long enough that a slow echo is still recognised.
        window.setTimeout(() => this.ownMutationIds.delete(mutationId), 30_000);
      });

    this.inFlight = run;
    await run;
    return ok;
  }

  /** Re-arm the write for edits that landed while a flush was in flight. */
  private scheduleAgain(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.dirty) void this.flush(this.dirty);
    }, WRITE_DEBOUNCE_MS);
  }

  /** Retry an unwritten change, backing off so a dead network is not hammered. */
  private scheduleRetry(message: string): void {
    this.retryAttempt += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.retryAttempt - 1), RETRY_MAX_MS);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      const ws = this.dirty;
      if (ws) void this.flush(ws);
    }, delay);
    this.publish({
      error: message,
      state: 'error',
      pending: Math.max(1, this.pending),
      retryInSeconds: Math.round(delay / 1000),
    });
  }

  /** Route a domain mutation to the audit trail. */
  async logEvent(event: MutationEvent, member: Member | null): Promise<void> {
    if (!this.enabled) return;
    // Demo actions are not part of the team's history.
    if (this.workspaceRef?.()?.mode === 'demo') return;
    await this.host.logActivity(
      {
        actorId: member?.id ?? null,
        actorName: member?.name ?? 'Someone',
        action: event.action,
        taskKey: event.taskKey,
        summary: event.summary,
      },
      newMutationId(),
    );
  }

  /**
   * Report that the backend's schema is absent. Called by the app after a load
   * finds no tables — the state lives here so every later `publish` preserves
   * it rather than racing with it.
   */
  markSetupRequired(message: string): void {
    this.publish({ setupRequired: true, error: message });
  }

  /* ------------------------------- realtime ----------------------------- */

  start(me: Member | null): void {
    if (!this.enabled) return;
    this.unsubscribe = this.host.subscribe(
      {
        onChange: (change) => this.handleChange(change),
        onState: (state) => {
          if (state === 'live' && this.connectTimer !== null) {
            window.clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
          if (state === 'live') this.status = { ...this.status, realtimePaused: false };
          this.publish({ state });
          if (state !== 'live') return;
          // A reconnect, not the first connection: whatever happened while the
          // socket was down is missing, so fill the gap immediately instead of
          // waiting up to a minute for the heartbeat.
          if (this.wasLive) void this.resync();
          this.wasLive = true;
        },
        onPresence: (peers) => this.callbacks.onPresence(peers),
      },
      me,
    );

    // A dropped socket is invisible until data is stale, so we also resync on
    // focus and on a slow heartbeat.
    const onFocus = () => void this.resync();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    // A refresh or a closed tab must not lose a queued write. `pagehide` fires
    // in cases `beforeunload` does not (bfcache, mobile backgrounding); the
    // request is sent as the page tears down, so it is best-effort but it
    // covers the common case of editing and immediately reloading.
    const onHide = () => {
      if (!this.dirty || (this.pending === 0 && this.timer === null)) return;
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
      void this.flush(this.dirty);
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHide();
    });

    this.listeners.push(() => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('pagehide', onHide);
    });

    this.heartbeat = window.setInterval(() => void this.resync(), HEARTBEAT_MS);

    // The socket may never call back at all. Rather than claim "Connecting"
    // forever, fall back to a truthful "offline" and say so.
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.wasLive) return;
      this.publish({
        state: 'error',
        realtimePaused: true,
        error: 'Realtime did not connect. Changes are still saved; live updates are paused.',
      });
    }, CONNECT_TIMEOUT_MS);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.forEach((off) => off());
    this.listeners = [];
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    if (this.resyncTimer !== null) window.clearTimeout(this.resyncTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
  }

  private handleChange(change: RowChange): void {
    const ws = this.workspaceRef?.();
    if (!ws) return;
    // A local playground is not a participant in the shared workspace.
    if (ws.mode === 'demo') return;

    // Neither of these is workspace state: they are fetched whole rather than
    // patched, so a change is a signal to refetch rather than a diff to apply.
    // Patching a bell incrementally would also have to reconstruct "which rows
    // are mine and unread" from a single row event, which is exactly the kind
    // of guess that gets a badge wrong.
    if (change.table === 'activity' || change.table === 'notifications') {
      const tag = String(change.row?.mutation_id ?? '');
      if (tag && this.ownMutationIds.has(tag)) return;
      if (change.table === 'activity') this.callbacks.onActivityChanged();
      else this.callbacks.onNotificationsChanged();
      return;
    }

    const result = applyChange(ws, change, { ownMutationIds: this.ownMutationIds });
    if (!result.changed) return;

    if (result.needsResync) {
      // Position rewrites cannot be reconstructed from one event.
      if (this.resyncTimer === null) {
        this.resyncTimer = window.setTimeout(() => {
          this.resyncTimer = null;
          void this.resync();
        }, RESYNC_DEBOUNCE_MS);
      }
      return;
    }
    this.callbacks.onWorkspaceChanged();
  }

  /** The workspace the controller should mutate; set by the app. */
  private workspaceRef: (() => Workspace | null) | null = null;

  setWorkspaceRef(fn: () => Workspace | null): void {
    this.workspaceRef = fn;
  }

  /**
   * Re-read the ordering baseline from the current workspace. Must be called
   * after a snapshot is installed — the constructor runs before the first load,
   * so priming there would baseline an empty workspace and make the first
   * remote event look like a reorder.
   */
  prime(): void {
    const ws = this.workspaceRef?.();
    if (ws) primePositions(ws);
  }

  /**
   * Pull the authoritative snapshot. Used after a reconnect, after a position
   * change, and on the heartbeat — the cheap insurance against silent drift.
   */
  async resync(): Promise<void> {
    if (!this.enabled) return;
    const ws = this.workspaceRef?.();
    if (!ws || ws.mode === 'demo') return;

    // Anything still queued must reach the server BEFORE we adopt its
    // snapshot. Otherwise a resync — a reconnect, the heartbeat, a window
    // focus — would overwrite an edit that had not been written yet, and the
    // user's change would vanish with no error.
    if (this.dirty && (this.pending > 0 || this.retryTimer !== null)) {
      // Pause the retry timer first: it would otherwise fire mid-resync,
      // succeed against a recovered network, and clear the guard below before
      // the snapshot is adopted.
      if (this.retryTimer !== null) {
        window.clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      const wrote = await this.flush(this.dirty);
      if (!wrote) {
        // Do not adopt a snapshot that cannot contain the pending change. The
        // next retry, focus or heartbeat will try again.
        this.scheduleRetry('Could not save before refreshing');
        return;
      }
    }

    try {
      const fresh = await this.host.current.load();
      if (!fresh) return;
      // Preserve the per-browser view state the server does not own.
      fresh.projectId = ws.projectId && fresh.projects.some((p) => p.id === ws.projectId)
        ? ws.projectId
        : fresh.projectId;
      fresh.me = ws.me;
      fresh.fMember = ws.fMember;
      fresh.fStatus = ws.fStatus;
      fresh.composer = ws.composer;
      fresh.composerAnchor = ws.composerAnchor;
      fresh.enter = null;

      // Preserve expanded cards so a resync does not collapse the UI.
      const open = new Set(ws.tasks.filter((t) => t.open).map((t) => t.id));
      fresh.tasks.forEach((t) => {
        t.open = open.has(t.id);
      });
      sortByServerOrder(fresh, fresh.tasks.map((t) => ({ id: t.id, position: t.position ?? 0 })));
      primePositions(fresh);

      this.callbacks.onWorkspaceChanged(fresh);
      this.publish({ state: 'live', lastSyncedAt: Date.now(), error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({
        error: message,
        state: 'error',
        setupRequired: isMissingSchemaError(message),
      });
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private publish(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    try {
      this.callbacks.onStatus(this.status);
    } catch (error) {
      // A UI listener must never be able to break the sync loop.
      console.error('BlackIT Flow: status listener failed', error);
    }
  }
}
