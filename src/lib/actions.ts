/**
 * BlackIT Flow — action layer.
 *
 * `FlowActions` is the only place that mutates the workspace in response to
 * user intent. It talks to the domain and to `AppContext` (a tiny port for
 * DOM reads, toasts and re-renders), which keeps the whole interaction map
 * readable in one file and keeps `app.ts` down to event plumbing.
 */

import { APP_NAME } from './constants';
import { esc, keyFrom, type FlowDomain } from './domain';
import {
  TEAM_FOOTER,
  editTaskBody,
  modalFooterSubmit,
  previewHtml,
  projectBody,
  reassignBody,
  teamBody,
  wizardBody,
  wizardFooter,
  type WizardState,
} from './render';
import type { ParsedTask, PriorityId } from './types';

export interface ModalState {
  onOK: ((data: Record<string, string>) => unknown) | null;
}

export interface FlowActionsContext {
  domain: FlowDomain;
  /** Replace the sticky-header controls. */
  renderBar(): void;
  /** Replace progress + filters. */
  renderSub(): void;
  /** Replace the whole chain. */
  renderChain(): void;
  /** Replace the assistant panel. */
  renderChat(): void;
  /** Replace the welcome overlay. */
  renderWelcome(): void;
  /** Toast a short message. */
  toast(message: string): void;
  /**
   * Send any queued write now and report whether the backend accepted it.
   * Resolves `true` for the browser-local repository, which has nothing to send.
   */
  commit(): Promise<boolean>;
  /**
   * Delete the shared workspace from the backend and forget it locally.
   *
   * Clearing only this browser is not a reset once the data is shared — the
   * next write would push the old members and projects straight back up.
   */
  resetSharedWorkspace(): Promise<void>;
  /** Inject modal markup and show it. */
  openModal(title: string, body: string, footer: string): void;
  /** Hide the modal and its scrim. */
  closeModal(): void;
  /** Read the values of every `[name]` field inside the modal. */
  formData(): Record<string, string>;
  /** Read a value by element id, or '' when absent. */
  value(id: string): string;
  /** Show the workspace menu popover, or toggle it. */
  toggleWorkspaceMenu(): void;
  /** Download the workspace as JSON. */
  exportJson(): void;
  /** True when removing an owned member has been confirmed. */
  confirm(message: string): boolean;
  /** Chat open flag + transcript, shared with the renderer. */
  chat: { open: boolean; msg: { who: 'bot' | 'user'; html: string }[]; pending: ParsedTask | null; preview: string | null };
  /** Swap in a brand-new workspace, persist it, and return the new domain. */
  replaceDomain(mode: 'demo' | 'fresh'): FlowDomain;
  /** Focus an element by id on the next frame. */
  focus(id: string): void;
}

export class FlowActions {
  private readonly ctx: FlowActionsContext;
  private wizard: WizardState | null = null;
  private modal: ModalState = { onOK: null };
  /** Task id whose subtask input should regain focus after a render. */
  focusSub: string | null = null;

  constructor(ctx: FlowActionsContext) {
    this.ctx = ctx;
  }

  /* ----------------------------- lifecycle ----------------------------- */

  boot(): void {
    this.ctx.renderWelcome();
    this.ctx.renderBar();
    this.ctx.renderSub();
    this.ctx.renderChain();
    this.ctx.renderChat();
  }

  /** Re-render everything a state change can affect, then restore focus. */
  refresh(): void {
    this.ctx.renderWelcome();
    this.ctx.renderBar();
    this.ctx.renderSub();
    this.ctx.renderChain();
    this.ctx.renderChat();
    if (this.focusSub) {
      this.ctx.focus(this.focusSub);
      this.focusSub = null;
    }
  }

  /* ------------------------------ modals ------------------------------- */

  private showModal(title: string, body: string, footer: string, onOK: ModalState['onOK'] = null): void {
    this.modal = { onOK };
    this.ctx.openModal(title, body, footer);
  }

  closeModal(): void {
    this.modal = { onOK: null };
    this.ctx.closeModal();
  }

  submitModal(): void {
    if (!this.modal.onOK) return;
    const result = this.modal.onOK(this.ctx.formData());
    if (result !== false) this.closeModal();
  }

  /* ------------------------------ actions ------------------------------ */

  async run(action: string, element: HTMLElement, event?: Event): Promise<void> {
    const id = element.dataset.id ?? '';
    const val = element.dataset.val ?? '';
    const domain = this.ctx.domain;

    switch (action) {
      case 'cycle': {
        const t = domain.cycleStatus(id);
        this.ctx.renderBar();
        this.ctx.renderSub();
        this.ctx.renderChain();
        if (t) this.ctx.toast(`${t.key} → ${statusLabel(t.status)}`);
        break;
      }

      case 'claim': {
        const r = domain.claim(id);
        this.ctx.toast(r.message);
        if (r.ok) this.refresh();
        break;
      }

      case 'st': {
        const t = domain.setStatus(id, val as never);
        this.ctx.toast(`${t ? t.key : 'Task'} → ${statusLabel(val)}`);
        this.refresh();
        break;
      }

      case 'sub':
        domain.toggleSub(id, Number(element.dataset.idx));
        this.ctx.renderChain();
        this.ctx.renderSub();
        this.ctx.renderBar();
        break;

      case 'subs':
        domain.toggleSubtasks(id);
        this.ctx.renderChain();
        break;

      case 'sub-add': {
        const t = domain.findTask(id);
        const text = this.ctx.value(`[data-subinput="${id}"]`).trim();
        if (!text) {
          this.ctx.toast('Type the subtask first');
          break;
        }
        domain.addSub(id, text);
        this.focusSub = `[data-subinput="${id}"]`;
        // refresh() re-renders and then restores focus to the same input.
        this.refresh();
        if (t) this.ctx.toast(`Subtask added to ${t.key}`);
        break;
      }

      case 'sub-del': {
        domain.removeSub(id, Number(element.dataset.idx));
        this.ctx.renderChain();
        this.ctx.toast('Subtask removed');
        break;
      }

      case 'edit':
        this.editTask(id);
        break;

      case 'reassign':
        this.reassignModal(id);
        break;

      case 'unassign': {
        const r = domain.reassign(id, null);
        this.ctx.toast(r.message);
        this.refresh();
        break;
      }

      case 'delete':
        this.deleteTask(id);
        break;

      case 'menu':
        element.parentElement?.querySelector('.pop')?.classList.toggle('on');
        break;

      case 'insert':
        domain.workspace.composer = 1;
        domain.workspace.composerAnchor = element.dataset.anchor ?? null;
        domain.save();
        this.ctx.renderChain();
        this.ctx.focus('#newTitle');
        break;

      case 'compose-end':
        domain.workspace.composer = 1;
        domain.workspace.composerAnchor = null;
        domain.save();
        this.ctx.renderChain();
        this.ctx.focus('#newTitle');
        break;

      case 'cancel-compose':
        domain.workspace.composer = null;
        domain.workspace.composerAnchor = null;
        domain.save();
        this.ctx.renderChain();
        break;

      case 'create': {
        const title = this.ctx.value('#newTitle').trim();
        if (!title) {
          this.ctx.toast('Give the task a title first');
          break;
        }
        // "Other…" swaps the select for a free-text box, so the typed name is
        // stored as the task's type and rendered as-is.
        const pickedType = this.ctx.value('#newType');
        const customType = this.ctx.value('#newTypeCustom').trim();
        if (pickedType === '__custom' && !customType) {
          this.ctx.toast('Type a name for the new type, or pick one from the list');
          this.ctx.focus('#newTypeCustom');
          break;
        }
        const created = await domain.createTask({
          title,
          typeId: pickedType === '__custom' ? customType : pickedType,
          assigneeId: this.ctx.value('#newOwner') || null,
          due: this.ctx.value('#newDue') || null,
          priority: (this.ctx.value('#newPrio') || 'normal') as PriorityId,
          desc: this.ctx.value('#newDesc'),
        });
        this.refresh();
        if (created) {
          // Confirm the write before claiming success. The optimistic card is
          // already on screen, but saying "added" while the request is still in
          // flight loses the task if the tab is refreshed in that window.
          const saved = await this.ctx.commit();
          const owner = domain.member(created.assigneeId);
          const who = owner ? ` · assigned to ${owner.name}` : ' · not taken yet';
          this.ctx.toast(saved ? `${created.key} added${who}` : `${created.key} is not saved yet${who}`);
        }
        break;
      }

      case 'clear-filters':
        domain.clearFilters();
        this.refresh();
        break;

      case 'fstatus':
        domain.workspace.fStatus = val;
        domain.save();
        this.refresh();
        break;

      case 'new-project':
        this.openProjectModal();
        break;

      case 'team':
        this.openTeamModal();
        break;

      case 'add-member': {
        const name = this.ctx.value('#mNew').trim();
        const title = this.ctx.value('#mTitle').trim();
        if (!name) {
          this.ctx.toast('Type a name first');
          break;
        }
        const m = domain.addMember(name, title);
        this.openTeamModal();
        this.refresh();
        this.ctx.toast(`${m.name} added to the team`);
        break;
      }

      case 'del-member':
        this.deleteMember(id);
        break;

      case 'wsmenu':
        this.ctx.toggleWorkspaceMenu();
        break;

      case 'live-menu': {
        const pop = element.parentElement?.querySelector('[data-pop="live"]');
        pop?.classList.toggle('on');
        // Opening the chip also reveals the audit feed beside it.
        document.getElementById('activity-panel')?.classList.toggle('on', Boolean(pop?.classList.contains('on')));
        break;
      }

      case 'activity-close':
        document.getElementById('activity-panel')?.classList.remove('on');
        break;

      case 'ws-fresh':
        void this.startFresh();
        break;

      case 'ws-export':
        this.ctx.exportJson();
        break;

      case 'ws-help':
        this.ctx.chat.open = true;
        this.ctx.renderChat();
        break;

      case 'ws-task':
        if (!domain.currentProject) this.openProjectModal();
        else {
          domain.workspace.composer = 1;
          domain.workspace.composerAnchor = null;
          domain.save();
          this.ctx.renderChain();
          this.ctx.focus('#newTitle');
        }
        break;

      case 'welcome-fresh':
        this.openWizard();
        break;

      case 'welcome-demo':
        // Nothing to lose here — the welcome screen only shows on first run.
        this.loadDemo();
        break;

      case 'welcome-home':
        this.closeModal();
        break;

      case 'wz-next':
        this.wizardNext();
        break;

      case 'wz-back':
        this.readWizard();
        if (this.wizard) this.wizard.step -= 1;
        this.renderWizard();
        break;

      case 'wz-skip':
        this.finishSetup(true);
        break;

      case 'wz-done':
        this.finishSetup(false);
        break;

      case 'chat-toggle': {
        this.ctx.chat.open = !this.ctx.chat.open;
        this.ctx.renderChat();
        if (this.ctx.chat.open) this.ctx.focus('#chatIn');
        break;
      }

      case 'chat-close':
        this.ctx.chat.open = false;
        this.ctx.renderChat();
        break;

      case 'chat-chip':
        this.chatSend(element.textContent ?? '');
        break;

      case 'chat-send':
        this.chatSend(this.ctx.value('#chatIn'));
        break;

      case 'chat-discard':
        this.ctx.chat.pending = null;
        this.ctx.chat.preview = null;
        this.ctx.chat.msg.push({ who: 'bot', html: 'Discarded. Tell me another one whenever you like.' });
        this.ctx.renderChat();
        break;

      case 'chat-add':
        await this.addAssistantTask();
        break;

      case 'close-modal':
        this.closeModal();
        break;

      case 'submit-modal':
        this.submitModal();
        break;

      default:
        break;
    }
    void event;
  }

  /* --------------------------- task operations -------------------------- */

  private deleteTask(id: string): void {
    const t = this.ctx.domain.findTask(id);
    if (!t) return;
    if (!this.ctx.confirm(`Delete ${t.key} · ${t.title}?`)) return;
    this.ctx.domain.deleteTask(id);
    this.refresh();
    this.ctx.toast(`${t.key} deleted`);
  }

  private deleteMember(id: string): void {
    const domain = this.ctx.domain;
    const m = domain.member(id);
    if (!m) return;
    const owned = domain.workspace.tasks.filter((t) => t.assigneeId === id).length;
    if (domain.workspace.members.length <= 1) {
      this.ctx.toast('Keep at least one member');
      return;
    }
    if (owned && !this.ctx.confirm(`${m.name} owns ${owned} tasks. Move them to the open pool and remove?`)) {
      return;
    }
    const r = domain.removeMember(id);
    if (!r.ok) {
      this.ctx.toast(r.message);
      return;
    }
    this.openTeamModal();
    this.refresh();
    this.ctx.toast(r.message);
  }

  private editTask(id: string): void {
    const domain = this.ctx.domain;
    const t = domain.findTask(id);
    if (!t) return;
    this.showModal(
      `Edit ${t.key}`,
      editTaskBody(domain, t),
      modalFooterSubmit('Save changes'),
      (d) => {
        const title = d.title ?? '';
        if (!title.trim()) {
          this.ctx.toast('A title is required');
          return false;
        }
        // The modal's Type select offers "Other…" plus a free-text box; keep
        // whichever the user actually filled in.
        const chosenType = d.typeId ?? '';
        const freeType = (d.typeFree ?? '').trim();
        if (chosenType === '__custom' && !freeType) {
          this.ctx.toast('Type a name for the new type, or pick one from the list');
          return false;
        }
        domain.updateTask(t.id, {
          title,
          typeId: chosenType === '__custom' ? freeType : chosenType,
          description: d.description ?? '',
          stage: (d.stage ?? '').trim() || t.stage,
          priority: (d.priority ?? t.priority) as PriorityId,
          dueAt: d.due ? new Date(`${d.due}T12:00:00`).getTime() : null,
        });
        const lines = (d.subs ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        domain.replaceSubs(t.id, lines);
        this.refresh();
        this.ctx.toast('Changes saved');
        return true;
      },
    );
  }

  private reassignModal(id: string): void {
    const domain = this.ctx.domain;
    const t = domain.findTask(id);
    if (!t) return;
    this.showModal(`Reassign ${t.key}`, reassignBody(domain, t), modalFooterSubmit('Reassign'), (d) => {
      const r = domain.reassign(t.id, d.owner || null);
      this.refresh();
      this.ctx.toast(r.message);
      return true;
    });
  }

  private openProjectModal(): void {
    const domain = this.ctx.domain;
    this.showModal('New project', projectBody(domain), modalFooterSubmit('Create project'), (d) => {
      const name = (d.name ?? '').trim();
      if (!name) {
        this.ctx.toast('Give the project a name');
        return false;
      }
      const p = domain.createProject(name, d.key ?? '', d.product ?? '');
      this.refresh();
      this.ctx.toast(`${p.key} created · add the first task`);
      return true;
    });
  }

  private openTeamModal(): void {
    const domain = this.ctx.domain;
    this.showModal('Team', teamBody(domain), TEAM_FOOTER, null);
  }

  /* ------------------------------- assistant ---------------------------- */

  chatSend(text: string): void {
    const value = String(text ?? '').trim();
    if (!value) return;
    const chat = this.ctx.chat;
    chat.msg.push({ who: 'user', html: esc(value) });
    const result = this.ctx.domain.reply(value);
    chat.pending = result.pending;
    chat.preview = result.pending
      ? previewHtml(result.pending, this.ctx.domain.currentProject?.name ?? APP_NAME)
      : null;
    chat.msg.push({ who: 'bot', html: result.html + (chat.preview ?? '') });
    if (result.mutated) {
      this.ctx.renderBar();
      this.ctx.renderSub();
      this.ctx.renderChain();
    }
    this.ctx.renderChat();
    this.ctx.focus('#chatIn');
  }

  /**
   * The assistant's opening line. Called on every render of the panel, exactly
   * like the prototype's `chatInit()`, so a workspace swap (demo / reset /
   * wizard) always greets the person again instead of opening empty.
   */
  ensureGreeting(greeting: { who: 'bot' | 'user'; html: string }): void {
    if (!this.ctx.chat.msg.length) this.ctx.chat.msg.push(greeting);
  }

  private async addAssistantTask(): Promise<void> {
    const p = this.ctx.chat.pending;
    if (!p) return;
    const t = await this.ctx.domain.addAssistantTask(p);
    this.ctx.chat.pending = null;
    this.ctx.chat.preview = null;
    if (!t) return;
    this.refresh();
    const owner = p.owner;
    this.ctx.chat.msg.push({
      who: 'bot',
      html: `Added <b>${esc(t.key)}</b> to the end of the chain${
        owner ? ` and assigned it to ${esc(owner.name)}` : ' · it is in the open pool'
      }.`,
    });
    this.ctx.renderChat();
  }

  /* -------------------------------- wizard ------------------------------ */

  openWizard(): void {
    this.wizard = { step: 1, name: '', title: 'Founder · Product', project: '', product: '', team: '' };
    this.renderWizard();
  }

  private renderWizard(): void {
    if (!this.wizard) return;
    this.showModal(
      'Set up your workspace',
      wizardBody(this.wizard),
      wizardFooter(this.wizard.step),
      null,
    );
  }

  private readWizard(): void {
    if (!this.wizard) return;
    const step = this.wizard.step;
    if (step === 1) {
      this.wizard.name = this.ctx.value('#wzName');
      this.wizard.title = this.ctx.value('#wzTitle');
    }
    if (step === 2) {
      this.wizard.project = this.ctx.value('#wzProject');
      this.wizard.product = this.ctx.value('#wzProduct');
    }
    if (step === 3) this.wizard.team = this.ctx.value('#wzTeam');
  }

  private wizardNext(): void {
    this.readWizard();
    if (!this.wizard) return;
    if (this.wizard.step === 1 && !this.wizard.name.trim()) {
      this.ctx.toast('Your name is needed');
      return;
    }
    if (this.wizard.step === 2 && !this.wizard.project.trim()) {
      this.ctx.toast('Give your project a name');
      return;
    }
    this.wizard.step += 1;
    this.renderWizard();
  }

  /** Keeps the `WZ-1` / `WZ-2` preview in step 2 in sync with the name field. */
  syncWizardKeyPreview(value: string): void {
    if (!this.wizard || this.wizard.step !== 2) return;
    const doc = document;
    const k = keyFrom(value);
    const a = doc.getElementById('wzKeyPrev');
    const b = doc.getElementById('wzKeyPrev2');
    if (a) a.textContent = `${k}-1`;
    if (b) b.textContent = `${k}-2`;
  }

  private finishSetup(skipTeam: boolean): void {
    this.readWizard();
    const wz = this.wizard;
    if (!wz) return;
    if (!wz.name.trim()) {
      wz.step = 1;
      this.renderWizard();
      this.ctx.toast('Your name is needed');
      return;
    }
    if (!wz.project.trim()) {
      wz.step = 2;
      this.renderWizard();
      this.ctx.toast('Give your first project a name');
      return;
    }
    const domain = this.ctx.domain;
    const me = domain.addMember(wz.name, wz.title || 'Owner', 'owner');
    domain.workspace.me = me.id;
    const p = domain.createProject(wz.project, keyFrom(wz.project), wz.product.trim() || wz.project);
    if (!skipTeam) {
      wz.team
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((n) => domain.addMember(n, '', 'member'));
    }
    domain.workspace.mode = 'fresh';
    domain.workspace.setup = true;
    domain.workspace.fMember = 'all';
    domain.workspace.fStatus = 'all';
    domain.workspace.composer = 1;
    domain.workspace.composerAnchor = null;
    domain.save();
    this.ctx.chat.msg = [];
    this.ctx.chat.open = false;
    this.wizard = null;
    this.closeModal();
    this.refresh();
    void p;
    this.ctx.toast('Workspace ready · add your first task');
  }

  /* ----------------------------- workspace ------------------------------ */

  /** Only reachable from the first-run welcome screen, so nothing to confirm. */
  loadDemo(): void {
    this.replaceWorkspace('demo');
  }

  /** Wipe every project, task and member back to a blank workspace. */
  async startFresh(): Promise<void> {
    // Destructive and shared: the confirmation is the only guard, so it is not
    // skippable when confirm() is unavailable (it resolves to false there).
    const ok = this.ctx.confirm(
      'Reset everything? Projects, tasks and teammates will be deleted for everyone.',
    );
    if (!ok) return;
    await this.ctx.resetSharedWorkspace();
    this.replaceWorkspace('fresh');
  }

  private replaceWorkspace(mode: 'demo' | 'fresh'): void {
    this.ctx.closeModal();
    this.ctx.chat.msg = [];
    this.ctx.chat.open = false;
    this.ctx.chat.pending = null;
    this.ctx.chat.preview = null;
    this.wizard = null;
    this.modal = { onOK: null };
    this.ctx.replaceDomain(mode);
    this.refresh();
    if (mode === 'demo') this.ctx.toast('Demo data loaded');
    else this.ctx.toast('Fresh workspace ready');
  }
}

function statusLabel(id: string): string {
  const labels: Record<string, string> = {
    DONE: 'Done',
    PROG: 'In Progress',
    REVIEW: 'In Review',
    BLOCK: 'Blocked',
    TODO: 'Not Taken',
  };
  return labels[id] ?? id;
}

