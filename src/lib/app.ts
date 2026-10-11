/**
 * BlackIT Flow — browser adapter.
 *
 * Owns the `FlowDomain` instance, the delegated event listeners, the modal
 * and chat shells, and the pointer-driven reordering. All rendering is
 * delegated to `render.ts`, so markup is defined in exactly one place.
 */

import { FlowActions, type FlowActionsContext } from './actions';
import { APP_NAME } from './constants';
import { emptyWorkspace, esc, FlowDomain, seed } from './domain';
import {
  HOOKS,
  chatGreeting,
  fabIcon,
  modalShell,
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
  type ChatState,
} from './render';
import { dropTargetAt, markerTop, type RowRect } from './reorder';
import { RepositoryHost } from './repository/host';
import { createRepository, isSupabaseConfigured } from './repository';
import { SyncController, type SyncStatus } from './sync';
import type { PresencePeer } from './repository/types';
import type { ParsedTask, Workspace } from './types';

/** Copy shown on the document title and the assistant header. */
export { APP_NAME };

export class BlackitFlowApp {
  domain: FlowDomain;
  private readonly actions: FlowActions;
  private readonly host: RepositoryHost;
  private readonly sync: SyncController;
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

  constructor(options: { host?: RepositoryHost; workspace?: Workspace } = {}) {
    this.host = options.host ?? new RepositoryHost(createRepository());
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

    if (this.host.kind === 'supabase') {
      try {
        const { workspace } = await this.host.load();
        this.domain.adopt(workspace);
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
        this.syncError(error);
        this.sync.markSetupRequired(
          `Could not set up the shared workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.actions.refresh();
    this.renderSyncStatus();
    // The shell is only held back to avoid a flash of demo content.
    document.documentElement.classList.remove('first-run');

    // Realtime, presence and the reconnect/heartbeat safety nets.
    this.sync.start(this.domain.me);
    void this.loadActivity();
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
    };
  }

  /* ------------------------------ rendering ---------------------------- */

  private renderBar(): void {
    const el = document.querySelector(HOOKS.ctrls);
    if (el) el.innerHTML = renderControls(this.domain);
    const menu = document.querySelector(HOOKS.menu);
    // The popover moves with its button, so the slot is rebuilt wholesale.
    if (menu && !menu.querySelector('[data-act="wsmenu"]')) menu.innerHTML = renderMenuButton();
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
    const setup = this.domain.workspace.setup;
    document.body.classList.toggle('booting', !setup);
    el.classList.toggle('on', !setup);
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
    const blank: Workspace = {
      ...emptyWorkspace(),
      mode: mode === 'demo' ? 'demo' : 'live',
      setup: true,
      workspaceId: current.workspaceId,
      members: mode === 'demo' ? [] : current.members.map((m) => ({ ...m })),
      me: current.me,
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

