/**
 * BlackIT Flow — browser adapter.
 *
 * Owns the `FlowDomain` instance, the delegated event listeners, the modal
 * and chat shells, and the pointer-driven reordering. All rendering is
 * delegated to `render.ts`, so markup is defined in exactly one place.
 */

import { FlowActions, type FlowActionsContext } from './actions';
import { NoAuth, type AuthPort } from './auth';
import { APP_NAME, STORAGE_KEY } from './constants';
import { emptyWorkspace, esc, FlowDomain, seed } from './domain';
import {
  HOOKS,
  chatGreeting,
  fabIcon,
  modalShell,
  renderAuthScreen,
  renderChain,
  renderChat,
  renderControls,
  renderMenuButton,
  renderActivityFeed,
  renderSetupBanner,
  renderSyncErrorBanner,
  renderSyncChip,
  renderHeadProgress,
  renderSubBar,
  renderWelcome,
  type AuthScreenState,
  type ChatState,
} from './render';
import { dropTargetAt, markerTop, type RowRect } from './reorder';
import { RepositoryHost } from './repository/host';
import { createBackend } from './repository';
import { SyncController, type SyncStatus } from './sync';
import type { PresencePeer } from './repository/types';
import type { AuthUser, Member, ParsedTask, Workspace } from './types';

/** Copy shown on the document title and the assistant header. */
export { APP_NAME };

export interface AppOptions {
  host?: RepositoryHost;
  workspace?: Workspace;
  /** Injectable for tests; production builds it from the environment. */
  auth?: AuthPort;
  /** Require a session before the board is shown. */
  requireLogin?: boolean;
}

export class BlackitFlowApp {
  domain: FlowDomain;
  private readonly actions: FlowActions;
  private readonly host: RepositoryHost;
  private readonly sync: SyncController;
  private readonly auth: AuthPort;
  /** True when this deployment shows a sign-in screen before the board. */
  private readonly requireLogin: boolean;
  /** The signed-in account, or null while signed out. */
  private account: AuthUser | null = null;
  /** Non-null while the sign-in overlay owns the screen. */
  private authScreen: AuthScreenState | null = null;
  /** The member row this account is bound to, once the backend says so. */
  private boundMemberId: string | null = null;
  /** True while one boot pass is running, so two cannot interleave. */
  private adopting = false;
  /** The account the ⋯ menu was last built for; null = signed out. */
  private renderedMenuAccount: string | null | undefined = undefined;
  private unsubscribeAuth: (() => void) | null = null;
  private presence: PresencePeer[] = [];
  private syncStatus: SyncStatus = {
    state: 'offline',
    pending: 0,
    lastSyncedAt: null,
    error: null,
    retryInSeconds: null,
    setupRequired: false,
    realtimePaused: false,
  };
  private readonly chat: ChatState & { pending: ParsedTask | null; preview: string | null } = {
    open: false,
    msg: [],
    pending: null,
    preview: null,
  };
  private scrolled = false;
  private drag: {
    id: string;
    card: HTMLElement;
    x: number;
    y: number;
    lastY: number;
    active: boolean;
    w: number;
    ghost?: HTMLElement;
  } | null = null;
  private dropAnchor: string | null = null;
  /**
   * False until the initial workspace load has finished.
   *
   * The welcome overlay is driven by `workspace.setup`, which is only known
   * once the backend load resolves. Rendering it before then flashed the
   * welcome screen on every reload before the real workspace replaced it.
   */
  private ready = false;

  constructor(options: AppOptions = {}) {
    // One backend object, so the repository and the auth port cannot end up on
    // two different clients — a signed-in deployment whose data client is still
    // anonymous would look like it worked and share nothing.
    const backend = options.host ? null : createBackend();
    this.auth = options.auth ?? backend?.auth ?? new NoAuth();
    this.requireLogin = Boolean(options.requireLogin ?? backend?.requireLogin) && this.auth.configured;
    this.host = options.host ?? new RepositoryHost(backend!.repository);
    this.sync = new SyncController(this.host, {
      onWorkspaceChanged: (replacement) => this.onWorkspaceChanged(replacement),
      onActivityChanged: () => void this.loadActivity(),
      onStatus: (status) => this.onSyncStatus(status),
      onPresence: (peers) => this.onPresence(peers),
    });
    // The domain owns the rules; the app owns where the data lives.
    this.domain = new FlowDomain(options.workspace ?? FlowDomain.hydrate().workspace, {
      persist: (ws, options) => this.sync.schedule(ws, options),
      nextKey: (projectId, fallback) => this.host.nextTaskKey(projectId, fallback),
      onEvent: (event) => void this.sync.logEvent(event, this.domain.me),
    });
    this.sync.setWorkspaceRef(() => this.domain.workspace);
    this.actions = new FlowActions(this.buildContext());
  }

  /* ------------------------------- boot -------------------------------- */

  async start(): Promise<void> {
    this.injectStaticIcons();
    this.actions.boot();
    this.bind();
    this.scrollState();

    let user: AuthUser | null = null;
    if (this.requireLogin) user = await this.auth.currentUser();

    if (this.requireLogin && !user) {
      // Everything the board would show is held back: no workspace has been
      // read yet, and `me` is nobody.
      this.showAuth({ step: 'signin', email: '', message: '', account: null });
    } else {
      await this.adoptSession(user);
    }

    // Registered *after* the first pass on purpose. Supabase replays the
    // current session as an INITIAL_SESSION event the moment a listener
    // attaches, so subscribing first would boot the workspace twice.
    this.unsubscribeAuth = this.auth.onChange((next) => {
      // Fire-and-forget, but not silently: a rejected promise here would be an
      // unhandled rejection with no way for anybody to see what happened.
      void this.onAuthUser(next).catch((error: unknown) => this.syncError(error));
    });
  }

  /**
   * Bind `user` to a member and show the workspace it belongs to.
   *
   * Also the retry path: `auth-retry` calls it again after an owner has added
   * the invitation, and a sign-in event routes here through `onAuthUser`.
   */
  private async adoptSession(user: AuthUser | null): Promise<void> {
    // A verified code can arrive twice within a millisecond: the provider
    // fires SIGNED_IN and the click handler calls `resumeSession()` as well.
    // One boot per session.
    if (this.adopting) return;
    this.adopting = true;
    try {
      await this.adoptSessionOnce(user);
    } finally {
      this.adopting = false;
    }
  }

  private async adoptSessionOnce(user: AuthUser | null): Promise<void> {
    this.account = user;
    this.authScreen = null;
    this.boundMemberId = null;

    if (this.host.kind === 'supabase' && user) {
      // Bind before loading. `me` has to be the signed-in person: the load path
      // otherwise falls back to the first member row, which would quietly make
      // everybody act as whoever was created first.
      try {
        const member: Member | null = await this.host.linkAccount(user);
        this.boundMemberId = member?.id ?? null;
      } catch (error) {
        this.sync.stop();
        this.showAuth(this.authScreenFor({ step: 'error', message: errorMessage(error) }));
        return;
      }
    }

    if (this.host.kind === 'supabase') {
      try {
        const { workspace } = await this.host.load();
        // Signed in, but no member row names this account while the workspace
        // already has a team. A workspace nobody has claimed yet predates
        // sign-in — its rows have names but no email, so the only way in is to
        // pick one. Once anybody is bound that offer is gone for good, and the
        // answer becomes "ask an owner to invite you".
        if (user && !this.boundMemberId && workspace.members.length) {
          this.sync.stop();
          if (workspace.members.every((m) => !m.userId)) {
            this.showAuth(
              this.authScreenFor({
                step: 'claim',
                claimable: workspace.members.map((m) => ({ id: m.id, name: m.name, title: m.title })),
              }),
            );
          } else {
            this.showAuth(this.authScreenFor({ step: 'not-invited' }));
          }
          return;
        }
        if (this.boundMemberId) workspace.me = this.boundMemberId;
        // The server decides who you are once there is a signed-in account, and
        // `adopt` preserves the *previous* workspace's `me` (the per-browser
        // "Acting as" choice) by default — which would quietly discard the
        // binding and leave the board acting as nobody. Without an account that
        // choice is still the only identity there is, so it is kept.
        this.domain.adopt(workspace, { keepView: !user });
        // `load()` returns a fallback workspace rather than throwing when the
        // tables are absent, so the setup gap is reported from here. The
        // controller owns the flag, which keeps later status updates from
        // clearing it.
        if (this.host.schemaMissing) {
          this.sync.markSetupRequired('The shared database has no tables yet.');
        }
      } catch (error) {
        // A failure here means the shared workspace could not be created, so
        // it has to be visible rather than only in the console.
        if (this.requireLogin && user) {
          this.sync.stop();
          this.showAuth(this.authScreenFor({ step: 'error', message: errorMessage(error) }));
          return;
        }
        this.syncError(error);
        this.sync.markSetupRequired(
          `Could not set up the shared workspace: ${errorMessage(error)}`,
        );
      }
    }

    // Something is always shown, even when the load fails.
    this.ready = true;
    this.actions.refresh();
    this.renderSyncStatus();
    // The shell is only held back to avoid a flash of demo content.
    document.documentElement.classList.remove('first-run');

    // Realtime, presence and the reconnect/heartbeat safety nets. Restarted
    // rather than started once: a retry can land on a different member row, and
    // presence is keyed by that member.
    this.sync.stop();
    this.sync.start(this.domain.me);
    void this.loadActivity();
  }

  /** Re-run the post-sign-in path. Used by "Check again" and a verified code. */
  async resumeSession(): Promise<void> {
    const user = this.requireLogin ? await this.auth.currentUser() : null;
    if (this.requireLogin && !user) {
      this.showAuth({ step: 'signin', email: '', message: '', account: null });
      return;
    }
    // The sign-in event can beat the click handler here; if this account's
    // board is already up there is nothing to rebuild.
    if (user && this.account?.id === user.id && this.ready) return;
    await this.adoptSession(user);
  }

  /**
   * React to a session change that happened outside the boot path: a sign-out
   * in another tab, a revoked token, a sign-in from another tab.
   */
  private async onAuthUser(user: AuthUser | null): Promise<void> {
    if (!this.requireLogin) return;
    // A token refresh re-delivers the same account; nothing to rebuild.
    if (user && this.account?.id === user.id) return;
    if (!user && !this.account) return;

    if (!user) {
      this.sync.stop();
      this.ready = false;
      // Drop the account *and* the board behind it. The overlay covers the
      // page, but the previous account's workspace would still be sitting in
      // the DOM — names, tasks and all — for anyone who looks.
      this.account = null;
      this.domain.adopt(emptyWorkspace(), { keepView: false });
      this.showAuth({ step: 'signin', email: '', message: 'You have been signed out.', account: null });
      return;
    }
    await this.adoptSession(user);
  }

  /** Show the sign-in overlay and hand it the whole screen. */
  private showAuth(state: AuthScreenState): void {
    this.authScreen = state;
    // Reveal the document: the pre-hydration guard hides the shell and a
    // 6-second failsafe would otherwise announce that the app failed to start.
    document.documentElement.classList.remove('first-run');
    this.renderWelcome();
    this.actions.refresh();
  }

  /** The overlay state, carrying the account once there is one. */
  private authScreenFor(patch: Partial<AuthScreenState>): AuthScreenState {
    const base: AuthScreenState = {
      step: 'signin',
      email: this.account?.email ?? this.authScreen?.email ?? '',
      message: '',
      account: this.account,
    };
    return { ...base, ...patch };
  }

  /** End the session, forget the cached workspace, and start over. */
  async signOut(): Promise<void> {
    this.sync.stop();
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    await this.auth.signOut();
    try {
      localStorage.removeItem(STORAGE_KEY);
      // Per-browser project choice: meaningless to the next person.
      localStorage.removeItem('blackit_flow_active_project');
    } catch {
      /* private mode — the reload below still re-reads the session */
    }
    // A reload is the only honest "signed out" state: it re-runs the boot path
    // rather than leaving half of the previous account's board on screen.
    if (typeof window.location?.reload === 'function') window.location.reload();
  }

  /* ------------------------------ sync glue ----------------------------- */

  private onWorkspaceChanged(replacement?: Workspace): void {
    if (replacement) this.domain.adopt(replacement);
    this.actions.refresh();
    // Someone else acted; their entry has landed in the audit trail.
    void this.loadActivity();
  }

  private onSyncStatus(status: SyncStatus): void {
    this.syncStatus = status;
    this.renderSyncStatus();
  }

  private onPresence(peers: PresencePeer[]): void {
    this.presence = peers;
    this.renderSyncStatus();
  }

  private syncError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Blackit Flow sync error:', message);
    this.syncStatus = { ...this.syncStatus, state: 'error', error: message };
    this.renderSyncStatus();
  }

  /** Writes the live chip in the header: connection, pending writes, people. */
  private renderSyncStatus(): void {
    const el = document.querySelector(HOOKS.live);
    if (el) el.innerHTML = renderSyncChip(this.syncStatus, this.presence, this.domain, this.host.kind);
    // A missing schema is fixed by running one SQL file, so say so plainly
    // instead of leaving it to the console.
    const banner = document.querySelector(HOOKS.setupBanner);
    if (banner) {
      const status = this.syncStatus;
      const showError = status.state === 'error' && Boolean(status.error) && !status.setupRequired;
      banner.innerHTML = status.setupRequired
        ? renderSetupBanner()
        : showError
          ? renderSyncErrorBanner(status.error!, status.pending, status.retryInSeconds)
          : '';
      banner.classList.toggle('on', status.setupRequired || showError);
    }
  }

  private async loadActivity(): Promise<void> {
    if (this.host.kind !== 'supabase') return;
    const entries = await this.host.recentActivity(20);
    this.renderActivity(entries);
  }

  private renderActivity(entries: Awaited<ReturnType<RepositoryHost['recentActivity']>>): void {
    const el = document.querySelector(HOOKS.activity);
    if (el) el.innerHTML = renderActivityFeed(entries);
  }

  /** The `#fab` glyph depends on chat state, so it is set on the client. */
  private injectStaticIcons(): void {
    const fab = document.querySelector<HTMLElement>(HOOKS.fab);
    if (fab) fab.innerHTML = fabIcon(this.chat.open);
  }

  /* ------------------------------ context ------------------------------ */

  private buildContext(): FlowActionsContext {
    const self = this;
    return {
      get domain(): FlowDomain {
        return self.domain;
      },
      renderBar: () => self.renderBar(),
      renderSub: () => self.renderSub(),
      renderChain: () => self.renderChain(),
      renderChat: () => self.renderChat(),
      renderWelcome: () => self.renderWelcome(),
      toast: (message) => self.toast(message),
      commit: () => self.sync.flushNow(self.domain.workspace),
      resetSharedWorkspace: async () => {
        // Stop the sync loop first, or a queued write could re-create the data
        // immediately after it is deleted.
        self.sync.stop();
        try {
          await self.host.clear();
        } catch (error) {
          self.syncError(error);
        }
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* private mode — the in-memory reset below still applies */
        }
        // A full reload is the only honest "fresh" state: it re-runs the load
        // path against an empty backend rather than guessing at one. Guarded
        // so a non-browser environment can still exercise the reset.
        if (typeof window.location?.reload === 'function') window.location.reload();
      },
      openModal: (title, body, footer) => {
        const modal = document.querySelector<HTMLElement>(HOOKS.modal);
        if (!modal) return;
        modal.innerHTML = modalShell(title, body, footer);
        // Apply the markup's own choice explicitly. Relying on the parser to
        // honour `<option selected>` leaves the first option selected in some
        // DOM implementations, which silently shows the wrong value.
        modal.querySelectorAll('select').forEach((select) => {
          const chosen = select.querySelector<HTMLOptionElement>('option[selected]');
          if (chosen) select.value = chosen.value;
        });
        modal.classList.add('on');
        document.querySelector(HOOKS.scrim)?.classList.add('on');
      },
      closeModal: () => {
        document.querySelector(HOOKS.modal)?.classList.remove('on');
        document.querySelector(HOOKS.scrim)?.classList.remove('on');
      },
      formData: () => self.formData(),
      value: (selector) => self.value(selector),
      toggleWorkspaceMenu: () => {
        document.querySelector('[data-pop="ws"]')?.classList.toggle('on');
      },
      exportJson: () => self.exportJson(),
      // No confirm() available (non-browser embed / test): treat a destructive
      // action as declined rather than performing it unreviewed.
      confirm: (message) =>
        typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : false,
      chat: this.chat,
      replaceDomain: (mode) => self.replaceDomain(mode),
      focus: (selector) => self.focus(selector),
      auth: this.auth,
      account: () => self.account,
      authState: () => self.authScreen,
      renderAuth: (state) => {
        if (!state) {
          self.authScreen = null;
          self.renderWelcome();
          return;
        }
        self.showAuth(state);
      },
      resumeSession: () => self.resumeSession(),
      claimMember: async (memberId) => {
        if (!self.account) return null;
        return await self.host.claimMember(memberId, self.account);
      },
      signOut: () => self.signOut(),
    };
  }

  /* ------------------------------ rendering ---------------------------- */

  private renderBar(): void {
    const el = document.querySelector(HOOKS.ctrls);
    if (el) el.innerHTML = renderControls(this.domain, this.account);
    const menu = document.querySelector(HOOKS.menu);
    // The popover moves with its button, so the slot is rebuilt wholesale — but
    // only when the identity behind it changed (or it is missing). Rebuilding
    // it on every refresh would close an open menu under the pointer.
    const menuKey = this.account?.id ?? null;
    if (
      menu &&
      (menuKey !== this.renderedMenuAccount || !menu.querySelector('[data-act="wsmenu"]'))
    ) {
      menu.innerHTML = renderMenuButton(this.account);
      this.renderedMenuAccount = menuKey;
    }
    const hp = document.querySelector(HOOKS.headProgress);
    if (hp) hp.innerHTML = renderHeadProgress(this.domain, this.scrolled);
  }

  private renderSub(): void {
    const el = document.querySelector(HOOKS.sub);
    if (el) el.innerHTML = renderSubBar(this.domain);
  }

  private renderChain(): void {
    const el = document.querySelector(HOOKS.chain);
    if (!el) return;
    el.innerHTML = renderChain(this.domain);
    if (this.domain.workspace.enter) {
      this.domain.workspace.enter = null;
      this.domain.save();
    }
  }

  private renderChat(): void {
    // Mirrors the prototype's `chatInit()`: the opening line is recreated
    // whenever the panel renders, so a workspace swap is never greeted with an
    // empty transcript.
    this.actions.ensureGreeting(chatGreeting(this.domain));
    const chat = document.querySelector<HTMLElement>(HOOKS.chat);
    const fab = document.querySelector<HTMLElement>(HOOKS.fab);
    if (fab) fab.innerHTML = fabIcon(this.chat.open);
    if (!chat) return;
    chat.classList.toggle('on', this.chat.open);
    chat.innerHTML = renderChat(this.domain, this.chat);
    const msgs = chat.querySelector<HTMLElement>('#msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  private renderWelcome(): void {
    const el = document.querySelector<HTMLElement>(HOOKS.welcome);
    if (!el) return;
    // The sign-in card lives in the same fixed overlay as the first-run
    // welcome: exactly one of them can own the screen, and `booting` keeps the
    // board hidden behind it.
    if (this.authScreen) {
      document.body.classList.add('booting');
      el.classList.add('on');
      el.innerHTML = renderAuthScreen(this.authScreen);
      return;
    }
    const setup = this.domain.workspace.setup;
    // Until `ready`, hold the shell back with the loader rather than guess.
    document.body.classList.toggle('booting', !this.ready || !setup);
    el.classList.toggle('on', this.ready && !setup);
    el.innerHTML = renderWelcome(this.domain);
  }

  /* ------------------------------- bits -------------------------------- */

  private value(selector: string): string {
    const el = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
    return el ? el.value : '';
  }

  private formData(): Record<string, string> {
    const out: Record<string, string> = {};
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('#modal [name]').forEach((el) => {
      out[el.name] = el.value;
    });
    return out;
  }

  private focus(selector: string): void {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(selector);
      el?.focus();
    }, 40);
  }

  private toast(message: string): void {
    const host = document.querySelector(HOOKS.toast);
    if (!host) return;
    const d = document.createElement('div');
    d.textContent = message;
    host.appendChild(d);
    window.setTimeout(() => {
      d.style.opacity = '0';
      d.style.transition = 'opacity .3s';
      window.setTimeout(() => d.remove(), 320);
    }, 2300);
  }

  private exportJson(): void {
    try {
      const blob = new Blob([JSON.stringify(this.domain.workspace, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'blackit-flow.json';
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this.toast('Exported blackit-flow.json');
    } catch {
      this.toast('Export is not available here');
    }
  }

  /**
   * Wipe the workspace back to a blank slate.
   *
   * Projects, tasks and the audit trail go; **people stay**, because a team
   * with no members has nobody to select in *Acting as* and therefore cannot
   * claim or be assigned anything. The deleted rows propagate to every other
   * client through the normal flush, so a reset resets it for everyone.
   */
  replaceDomain(mode: 'demo' | 'fresh'): FlowDomain {
    const current = this.domain.workspace;
    // A "fresh" reset empties everything. Carrying the members over meant the
    // next write pushed them back to the shared database, so a reset could
    // never actually clear the team.
    const blank: Workspace = {
      ...emptyWorkspace(),
      mode: mode === 'demo' ? 'demo' : 'live',
      setup: mode === 'demo',
      workspaceId: mode === 'demo' ? current.workspaceId : null,
      members: [],
      me: null,
      fMember: 'all',
      fStatus: 'all',
      composer: 1,
      composerAnchor: null,
    };
    if (mode === 'demo') {
      const sample = seed();
      blank.members = sample.members;
      blank.me = sample.me;
      blank.projects = sample.projects;
      blank.tasks = sample.tasks;
    }
    // Whatever we end up with, land on a project that actually exists —
    // otherwise the chain renders empty even though the tasks are there.
    blank.projectId = blank.projects[0]?.id ?? null;
    if (!blank.me) blank.me = blank.members[0]?.id ?? null;
    this.domain.adopt(blank, { keepView: false });
    this.domain.save();
    return this.domain;
  }

  /* ------------------------------ scroll ------------------------------- */

  scrollState(): void {
    const next = window.scrollY > 130;
    if (next === this.scrolled) return;
    this.scrolled = next;
    document.querySelector('.top-in')?.classList.toggle('scrolled', next);
    if (next) this.animateHeadProgress();
  }

  private animateHeadProgress(): void {
    const pctEl = document.querySelector<HTMLElement>('#hpPct');
    if (!pctEl) return;
    const { pct } = this.domain.progress();
    const fills = Array.from(document.querySelectorAll<HTMLElement>('#hp .hpbar i'));
    fills.forEach((f) => {
      f.style.width = '0%';
    });
    requestAnimationFrame(() => {
      fills.forEach((f) => {
        f.style.width = `${f.dataset.w ?? '0'}%`;
      });
    });
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 720);
      pctEl.textContent = `${Math.round(pct * k)}%`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ----------------------------- listeners ----------------------------- */

  private bind(): void {
    document.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('change', (e) => this.onChange(e));

    // If a write is still in flight, let the browser ask before discarding it.
    // Creating a task is committed immediately, so this stays out of the way.
    window.addEventListener('beforeunload', (e) => {
      if (this.syncStatus.pending === 0) return;
      e.preventDefault();
      e.returnValue = '';
    });
    document.addEventListener('keydown', (e) => this.onKeydown(e));
    document.addEventListener('input', (e) => this.onInput(e));
    document.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    document.addEventListener('pointermove', (e) => this.onPointerMove(e), { passive: false });
    document.addEventListener('pointerup', () => this.onPointerUp());
    document.addEventListener('pointercancel', () => this.endDrag(false));
    window.addEventListener('scroll', () => {
      this.scrollState();
      if (this.drag?.active) this.updateMarker(this.drag.lastY);
    }, { passive: true });
    document.querySelector(HOOKS.scrim)?.addEventListener('click', () => this.actions.closeModal());
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-act]');
    const act = button?.dataset.act ?? '';

    // Any click outside an open popover closes the ones that aren't the target.
    if (!target.closest('.pop')) {
      const keep = act === 'menu' ? button?.dataset.id : undefined;
      document.querySelectorAll<HTMLElement>('.pop.on').forEach((p) => {
        if (!(act === 'menu' && p.dataset.pop === keep)) p.classList.remove('on');
      });
    }
    if (!button || !act) return;
    // Async because a few actions reserve server-side state (task keys).
    // Failures surface through the sync status indicator, not an unhandled rejection.
    void this.actions.run(act, button, e).catch((error: unknown) => {
      console.error('Action failed', act, error);
      this.syncError(error);
    });
  }

  private onChange(e: Event): void {
    const target = e.target as HTMLElement;
    // "Other…" in a Type field swaps the select for a free-text box. Handled
    // before the data-act lookup because these selects carry no action.
    //
    // Checked structurally rather than with `instanceof HTMLSelectElement`:
    // that constructor is absent outside a real browser, and a ReferenceError
    // here would kill every change event in the document.
    const isSelect = target.tagName === 'SELECT';
    if (isSelect && target.getAttribute('data-role') === 'type') {
      const free = target.parentElement?.querySelector<HTMLInputElement>('.typefree');
      const custom = (target as HTMLSelectElement).value === '__custom';
      if (free) {
        free.hidden = !custom;
        if (custom) free.focus();
      }
      return;
    }
    const el = target.closest<HTMLInputElement | HTMLSelectElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'project') {
      this.domain.workspace.projectId = el.value;
      this.domain.workspace.composer = null;
      this.domain.save();
      this.actions.refresh();
    }
    if (act === 'me') {
      if (el.value && this.domain.member(el.value)) {
        this.domain.workspace.me = el.value;
        this.domain.save();
        this.actions.refresh();
      }
    }
    if (act === 'fmember') {
      this.domain.workspace.fMember = el.value;
      this.domain.save();
      this.actions.refresh();
    }
    if (act === 'mrole') {
      const m = this.domain.member(el.dataset.id ?? null);
      if (m) {
        m.role = el.value as never;
        this.domain.save();
      }
    }
  }

  private onInput(e: Event): void {
    const el = e.target as HTMLElement;
    if (el.id === 'wzProject') this.actions.syncWizardKeyPreview((el as HTMLInputElement).value);
  }

  private onKeydown(e: KeyboardEvent): void {
    const el = e.target as HTMLElement;
    if (el?.id === 'chatIn' && e.key === 'Enter') {
      e.preventDefault();
      this.actions.chatSend((el as HTMLInputElement).value);
      return;
    }
    if (el?.dataset?.subinput && e.key === 'Enter') {
      e.preventDefault();
      const btn = document.querySelector<HTMLElement>(`[data-act="sub-add"][data-id="${el.dataset.subinput}"]`);
      btn?.click();
      return;
    }
    if (e.key === 'Enter' && this.domain.workspace.composer !== null && el?.id === 'newTitle') {
      document.querySelector<HTMLElement>('[data-act="create"]')?.click();
      return;
    }
    if (e.key !== 'Escape') return;
    if (document.querySelector(HOOKS.modal)?.classList.contains('on')) {
      this.actions.closeModal();
    } else if (this.chat.open) {
      this.chat.open = false;
      this.renderChat();
    } else if (this.domain.workspace.composer !== null) {
      this.domain.workspace.composer = null;
      this.domain.workspace.composerAnchor = null;
      this.domain.save();
      this.renderChain();
    } else {
      document.querySelectorAll<HTMLElement>('.pop.on').forEach((p) => p.classList.remove('on'));
    }
  }

  /* ---------------------------- reordering ----------------------------- */

  private onPointerDown(e: PointerEvent): void {
    const target = e.target as HTMLElement;
    // Reordering is deliberately limited to the grip handle. Dragging from
    // anywhere on the card made text selection and clicking unreliable.
    if (!target.closest('[data-grip]')) return;
    const card = target.closest<HTMLElement>('.card');
    if (!card) return;
    const row = card.closest<HTMLElement>('.row[data-task]');
    if (!row?.dataset.task) return;
    this.drag = {
      id: row.dataset.task,
      card,
      x: e.clientX,
      y: e.clientY,
      lastY: e.clientY,
      active: false,
      w: card.getBoundingClientRect().width,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag) return;
    if (!this.drag.active) {
      if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) < 6) return;
      this.startDrag();
    }
    e.preventDefault();
    this.drag.lastY = e.clientY;
    const g = this.drag.ghost;
    if (g) {
      g.style.left = `${Math.min(e.clientX + 16, window.innerWidth - this.drag.w - 12)}px`;
      g.style.top = `${e.clientY - 20}px`;
    }
    if (e.clientY < 92) window.scrollBy(0, -16);
    else if (e.clientY > window.innerHeight - 92) window.scrollBy(0, 16);
    this.updateMarker(e.clientY);
  }

  private onPointerUp(): void {
    if (this.drag?.active) this.endDrag(true);
    else this.drag = null;
  }

  private startDrag(): void {
    if (!this.drag) return;
    this.drag.active = true;
    document.body.classList.add('reordering');
    document.body.classList.add('grabbing-grip');
    this.drag.card.classList.add('dragging');
    const t = this.domain.findTask(this.drag.id);
    const g = document.createElement('div');
    g.className = 'dragghost';
    g.style.width = `${this.drag.w}px`;
    // esc() matters here: a task title is user input and this is innerHTML.
    g.innerHTML = t
      ? `<div class="gk">${esc(t.key)} · ${esc(statusLabelOf(t.status))}</div><div class="gt">${esc(t.title)}</div>`
      : '';
    document.body.appendChild(g);
    this.drag.ghost = g;
  }

  private updateMarker(y: number): void {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.row[data-task]'));
    const mark = document.querySelector<HTMLElement>(HOOKS.dropmark);
    const wrap = document.querySelector<HTMLElement>('.wrap');
    if (!rows.length || !mark || !wrap) return;
    const measured: RowRect[] = rows.map((r) => ({
      id: r.dataset.task ?? '',
      rect: r.getBoundingClientRect() as DOMRect,
    }));
    this.dropAnchor = dropTargetAt(measured, y);
    const sample = rows[0]!.querySelector('.card')!.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    mark.style.left = `${sample.left - wr.left}px`;
    mark.style.right = `${Math.max(0, wr.right - sample.right)}px`;
    mark.style.top = `${markerTop(measured, y, wr.top)}px`;
    mark.classList.add('on');
  }

  private endDrag(commit: boolean): void {
    if (!this.drag) return;
    const mark = document.querySelector<HTMLElement>(HOOKS.dropmark);
    this.drag.ghost?.remove();
    this.drag.card.classList.remove('dragging');
    document.body.classList.remove('reordering');
    document.body.classList.remove('grabbing-grip');
    mark?.classList.remove('on');
    const { id } = this.drag;
    const anchor = this.dropAnchor;
    this.drag = null;
    this.dropAnchor = null;
    if (!commit || !anchor) return;
    const position = this.domain.moveTask(id, anchor);
    if (position === null) return;
    this.actions.refresh();
    const t = this.domain.findTask(id);
    this.toast(`${t ? t.key : 'Task'} moved to position ${position}`);
  }
}

/** Short status label for the drag ghost — mirrors the domain's status table. */
function statusLabelOf(id: string): string {
  const labels: Record<string, string> = {
    DONE: 'Done',
    PROG: 'In Progress',
    REVIEW: 'In Review',
    BLOCK: 'Blocked',
    TODO: 'Not Taken',
  };
  return labels[id] ?? id;
}

/** The one place a thrown value becomes a sentence for the sign-in screen. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

