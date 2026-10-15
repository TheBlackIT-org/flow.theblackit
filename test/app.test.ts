/**
 * Integration tests: mount the real shell in a DOM, start the real app, and
 * drive it through the same clicks a person would make. These protect the
 * wiring that the domain unit tests cannot see — event delegation, rendering,
 * modal flows and the assistant hand-off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { BlackitFlowApp } from '../src/lib/app';
import { FlowDomain, seed } from '../src/lib/domain';
import { STORAGE_KEY } from '../src/lib/constants';

const SHELL = `
  <header class="top"><div class="top-in">
    <div class="brand">BlackIT Flow</div>
    <div class="ctrls" id="ctrls"></div>
    <div class="hp" id="hp"></div>
    <div class="menu" id="wsmenu"></div>
  </div></header>
  <div class="sub" id="sub"></div>
  <div class="wrap">
    <div class="chain" id="chain"></div>
    <div id="dropmark"></div>
  </div>
  <div class="welcome" id="welcome"></div>
  <div class="scrim" id="scrim"></div>
  <div class="modal" id="modal"></div>
  <button class="fab" id="fab" data-act="chat-toggle"></button>
  <div class="chat" id="chat"></div>
  <div class="toast" id="toast"></div>
`;

const FIXED_NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

/**
 * happy-dom ships its own DOM types which differ structurally from `lib.dom`,
 * so the harness deliberately works through `any` at the boundary.
 */
type AnyWin = Window & { confirm: (message?: string) => boolean };
type El = any; // the harness intentionally crosses the happy-dom/lib.dom boundary

let win: AnyWin;
let app: BlackitFlowApp;

function mount(workspaceSeed = true) {
  win = new Window({ url: 'http://localhost/' }) as unknown as AnyWin;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;
  g.HTMLElement = win.HTMLElement;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  win.document.body.innerHTML = SHELL;
  const domain = workspaceSeed
    ? new FlowDomain(seed(FIXED_NOW - 86_400_000), { storage: win.localStorage, now: FIXED_NOW })
    : FlowDomain.blank({ storage: win.localStorage });
  app = new BlackitFlowApp(domain);
  return app;
}

const $ = (sel: string): El => win.document.querySelector(sel);
const $$ = (sel: string): El[] => Array.from(win.document.querySelectorAll(sel));

/** Click through a real bubbling event so document delegation runs. */
/**
 * Click and let the delegated async handler settle. `FlowActions.run` became
 * async when task keys started being reserved server-side, so every click that
 * mutates has to be awaited before assertions.
 */
async function click(el: unknown): Promise<void> {
  if (!el) throw new Error('cannot click a missing element');
  (el as El).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();
}

/** A macrotask turn is enough for the queue-backed writes to be scheduled. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
function change(el: unknown, value: string): void {
  const e = el as El;
  e.value = value;
  e.dispatchEvent(new win.Event('change', { bubbles: true }));
}
function type(el: unknown, value: string): void {
  const e = el as El;
  e.value = value;
  e.dispatchEvent(new win.Event('input', { bubbles: true }));
}
function key(el: unknown, k: string): void {
  (el as El).dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
}

beforeEach(() => {
  mount();
  app.start();
});

afterEach(() => {
  win.close();
});

describe('boot', () => {
  it('renders the demo chain into the shell', async () => {
    expect($$('.row[data-task]').length).toBe(15); // project p1 has 15 tasks
    expect($('#ctrls').querySelectorAll('select').length).toBe(2);
    expect($('#sub .pct').textContent).toContain('%');
    expect($('#sub').querySelectorAll('.legend span').length).toBe(5);
  });

  it('shows the welcome screen when there is no saved workspace', async () => {
    mount(false);
    app.start();
    expect($('#welcome').classList.contains('on')).toBe(true);
    expect($('#welcome').textContent).toContain('BlackIT Flow');
    expect($('#welcome').textContent).toContain('Explore the demo');
  });

  it('shows the compact progress percentage in the header at rest', async () => {
    const hp = $('#hp');
    expect(hp.querySelector('.hppct')?.textContent).toBe('20%');
    expect(hp.querySelector('.hpbar')).not.toBeNull();
    // It only expands into the bar + count once the page is scrolled.
    expect($('.top-in').classList.contains('scrolled')).toBe(false);
    app.scrollState();
    expect($('.top-in').classList.contains('scrolled')).toBe(false); // scrollY is 0 here
  });

  it('clears the first-run guard once booted', async () => {
    expect(win.document.documentElement.classList.contains('first-run')).toBe(false);
  });
});

describe('status changes and claiming', () => {
  it('cycles a node status and recolours its card', async () => {
    const node = $('.row[data-task="t4"] .node');
    expect(node.className).toContain('todo');
    click(node);
    expect($('.row[data-task="t4"] .node').className).toContain('prog');
    expect(app.domain.findTask('t4')?.status).toBe('PROG');
    expect($('#toast').textContent).toContain('NE-4 → In Progress');
  });

  it('claims an unowned task and swaps the button for an owner', async () => {
    const row = $('.row[data-task="t4"]');
    expect(row.querySelector('.take')).not.toBeNull();
    click(row.querySelector('.take'));
    const after = $('.row[data-task="t4"]');
    expect(after.querySelector('.take')).toBeNull();
    expect(after.textContent).toContain('Arjun Menon');
    expect(app.domain.findTask('t4')?.status).toBe('PROG');
  });

  it('persists every change to localStorage', async () => {
    await click($('.row[data-task="t4"] .node'));
    const raw = win.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw!) as { tasks: { id: string; status: string }[] };
    expect(saved.tasks.find((t) => t.id === 't4')?.status).toBe('PROG');
  });

  it('changes status from the kebab menu', async () => {
    await click($('.row[data-task="t4"] .kebab'));
    expect($('[data-pop="t4"]').classList.contains('on')).toBe(true);
    await click($('[data-pop="t4"] [data-act="st"][data-val="BLOCK"]'));
    expect(app.domain.findTask('t4')?.status).toBe('BLOCK');
    expect($('.row[data-task="t4"] .card').className).toContain('block');
  });
});

describe('filters', () => {
  it('filters the chain by status chip', async () => {
    await click($$('#sub .chip').find((c) => c.dataset.val === 'BLOCK'));
    expect($$('.row[data-task]').length).toBe(1);
    expect($('.row[data-task] .key').textContent).toBe('NE-3');
  });

  it('filters by member', async () => {
    change($('[data-act="fmember"]'), 'm2');
    const rows = $$('.row[data-task]').map((r) => r.dataset.task);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((id) => app.domain.findTask(id!)?.assigneeIds.includes('m2'))).toBe(true);
  });

  it('shows the empty state when filters match nothing, then clears them', async () => {
    change($('[data-act="fmember"]'), 'none');
    await click($$('#sub .chip').find((c) => c.dataset.val === 'DONE'));
    expect($('#chain').textContent).toContain('Nothing matches these filters');
    await click($('#chain [data-act="clear-filters"]'));
    expect($$('.row[data-task]').length).toBe(15);
  });
});

describe('composer', () => {
  it('opens at the end, creates the task and closes', async () => {
    await click($('[data-act="compose-end"]'));
    expect($('#newTitle')).not.toBeNull();
    ($('#newTitle') as HTMLInputElement).value = 'Write the launch email';
    // The owner chips default to the acting member, so untick to test the
    // "not taken" path explicitly.
    await click($('.ownerchips .ownertoggle.on'));
    await click($('[data-act="create"]'));
    expect($('#newTitle')).toBeNull();
    const last = $$('.row[data-task]').at(-1)!;
    expect(last.textContent).toContain('Write the launch email');
    expect(last.querySelector('.take')).not.toBeNull();
    expect(app.domain.workspace.tasks.find((t) => t.title === 'Write the launch email')?.status).toBe(
      'TODO',
    );
  });

  it('pre-selects the acting member as owner, matching the prototype', async () => {
    await click($('[data-act="compose-end"]'));
    // Parity with the prototype: the acting member starts ticked.
    expect($$('.ownerchips .ownertoggle.on').map((b) => b.dataset.owner)).toEqual(['m1']);
    ($('#newTitle') as HTMLInputElement).value = 'Assigned by default';
    await click($('[data-act="create"]'));
    const created = app.domain.workspace.tasks.find((t) => t.title === 'Assigned by default')!;
    expect(created.assigneeIds).toEqual(['m1']);
    expect(created.status).toBe('PROG');
    expect($(`.row[data-task="${created.id}"] .take`)).toBeNull();
  });

  it('inserts BELOW the card whose + handle was pressed', async () => {
    await click($('.row[data-task="t3"] .plus'));
    // The composer sits under its anchor while it is open.
    const rowsWithComposer = $$('.row');
    const anchorIndex = rowsWithComposer.findIndex((r) => r.dataset.task === 't3');
    expect(rowsWithComposer[anchorIndex + 1]?.dataset.composer).toBe('1');

    ($('#newTitle') as HTMLInputElement).value = 'Inserted below';
    await click($('[data-act="create"]'));
    const ids = $$('.row[data-task]').map((r) => r.dataset.task);
    const insertedIndex = ids.findIndex(
      (id) => id !== 't3' && app.domain.findTask(id!)?.title === 'Inserted below',
    );
    expect(insertedIndex).toBe(ids.indexOf('t3') + 1);
  });

  it('still appends from the end-of-chain composer', async () => {
    await click($('[data-act="compose-end"]'));
    ($('#newTitle') as HTMLInputElement).value = 'Appended at the end';
    await click($('[data-act="create"]'));
    const ids = $$('.row[data-task]').map((r) => r.dataset.task);
    const created = app.domain.workspace.tasks.find((t) => t.title === 'Appended at the end')!;
    expect(ids.at(-1)).toBe(created.id);
  });

  it('keeps the append row available while inserting in the middle', async () => {
    // Composing at the end already *is* the append row, so it is not repeated.
    await click($('[data-act="compose-end"]'));
    expect($$('.addend').length).toBe(0);
    await click($('[data-act="cancel-compose"]'));

    // Inserting in the middle must leave the append row reachable.
    await click($('.row[data-task="t3"] .plus'));
    expect($$('.row[data-composer]').length).toBe(1);
    expect($$('.addend').length).toBe(1);
    await click($('.addend [data-act="compose-end"]'));
    expect($$('.row[data-composer]').length).toBe(1);
    expect($$('.addend').length).toBe(0);
  });

  it('cancels without creating anything', async () => {
    const before = app.domain.workspace.tasks.length;
    await click($('[data-act="compose-end"]'));
    await click($('[data-act="cancel-compose"]'));
    expect(app.domain.workspace.tasks.length).toBe(before);
    expect($('#newTitle')).toBeNull();
  });

  it('creates on Enter from the title field', async () => {
    await click($('[data-act="compose-end"]'));
    const title = $('#newTitle') as HTMLInputElement;
    title.value = 'Enter key task';
    key(title, 'Enter');
    await settle();
    expect(app.domain.workspace.tasks.some((t) => t.title === 'Enter key task')).toBe(true);
  });
});

describe('subtasks', () => {
  it('expands, ticks, adds and deletes a step', async () => {
    await click($('.row[data-task="t1"] .subtoggle'));
    expect($('.row[data-task="t1"] .subs').classList.contains('on')).toBe(true);

    await click($$('.row[data-task="t1"] .sbox')[2]);
    expect(app.domain.findTask('t1')?.subs[2]?.done).toBe(true);

    ($('[data-subinput="t1"]') as HTMLInputElement).value = 'New checklist item';
    await click($('[data-act="sub-add"][data-id="t1"]'));
    expect(app.domain.findTask('t1')?.subs.at(-1)?.t).toBe('New checklist item');

    const before = app.domain.findTask('t1')!.subs.length;
    await click($$('.row[data-task="t1"] .sdel').at(-1));
    expect(app.domain.findTask('t1')!.subs.length).toBe(before - 1);
  });

  it('returns focus to the subtask input after adding', async () => {
    await click($('.row[data-task="t1"] .subtoggle'));
    ($('[data-subinput="t1"]') as HTMLInputElement).value = 'Focus should come back';
    await click($('[data-act="sub-add"][data-id="t1"]'));
    // ctx.focus defers by 40ms; the harness waits it out.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(win.document.activeElement).toBe($('[data-subinput="t1"]'));
        resolve();
      }, 80);
    });
  });

  it('adds a subtask with the Enter key', async () => {
    await click($('.row[data-task="t1"] .subtoggle'));
    const input = $('[data-subinput="t1"]') as HTMLInputElement;
    input.value = 'Typed then entered';
    key(input, 'Enter');
    expect(app.domain.findTask('t1')?.subs.at(-1)?.t).toBe('Typed then entered');
  });

  it('puts two people on one step from the step picker', async () => {
    await click($('.row[data-task="t1"] .subtoggle'));
    const sub = app.domain.findTask('t1')!.subs[0]!;
    expect(sub.assigneeIds).toEqual([]);
    // An unclaimed step shows the placeholder, not faces.
    expect($('.row[data-task="t1"] .sassign.on')).toBeNull();

    await click($('.row[data-task="t1"] .sassign'));
    expect($('#modal').classList.contains('on')).toBe(true);
    // Checkboxes, exactly like the task assign modal: several people per step.
    expect($$('#modal input[type="checkbox"][name^="member:"]').length).toBe(
      app.domain.workspace.members.length,
    );

    ($('#modal [name="member:m5"]') as El).checked = true;
    ($('#modal [name="member:m3"]') as El).checked = true;
    await click($('#modal [data-act="submit-modal"]'));

    // Order follows the member list, not the tick order: a batch shares one
    // `assigned_at`, so the faces' order is cosmetic.
    expect(app.domain.findTask('t1')!.subs[0]!.assigneeIds).toEqual(['m3', 'm5']);
    // The row carries their faces rather than the placeholder.
    expect($('.row[data-task="t1"] .sassign.on')).not.toBeNull();
    expect($$('.row[data-task="t1"] .sassign .av').length).toBe(2);
  });

  it('takes one person off a step without disturbing the other', async () => {
    await click($('.row[data-task="t1"] .subtoggle'));
    const sub = app.domain.findTask('t1')!.subs[0]!;
    app.domain.setSubAssignees('t1', sub.id, ['m3', 'm5']);

    await click($('.row[data-task="t1"] .sassign'));
    ($('#modal [name="member:m5"]') as El).checked = false;
    await click($('#modal [data-act="submit-modal"]'));

    expect(app.domain.findTask('t1')!.subs[0]!.assigneeIds).toEqual(['m3']);
  });

  it('joins a step yourself from the picker footer', async () => {
    await click($('.row[data-task="t1"] .subtoggle'));
    app.domain.workspace.me = 'm1';

    await click($('.row[data-task="t1"] .sassign'));
    await click($('#modal [data-act="sub-assign-me"]'));

    expect(app.domain.findTask('t1')!.subs[0]!.assigneeIds).toEqual(['m1']);
    // The footer action closes the modal: its list is stale the moment it acts.
    expect($('#modal').classList.contains('on')).toBe(false);
  });

  it('keeps step owners when the task is edited through the modal', async () => {
    // The edit modal rebuilds every subtask row from the textarea. Matching on
    // text alone silently dropped the owners.
    await click($('.row[data-task="t1"] .subtoggle'));
    const sub = app.domain.findTask('t1')!.subs[0]!;
    app.domain.setSubAssignees('t1', sub.id, ['m4', 'm5']);

    await click($('.row[data-task="t1"] .kebab'));
    await click($('.row[data-task="t1"] [data-act="edit"]'));
    await click($('#modal [data-act="submit-modal"]'));

    expect(app.domain.findTask('t1')!.subs[0]!.assigneeIds).toEqual(['m4', 'm5']);
  });
});

describe('modals', () => {
  it('edits a task and saves the changes', async () => {
    await click($('.row[data-task="t1"] .kebab'));
    await click($('.row[data-task="t1"] [data-act="edit"]'));
    expect($('#modal').classList.contains('on')).toBe(true);
    ($('#modal [name="title"]') as HTMLInputElement).value = 'Renamed task';
    await click($('#modal [data-act="submit-modal"]'));
    expect($('#modal').classList.contains('on')).toBe(false);
    expect($('.row[data-task="t1"] h3').textContent).toBe('Renamed task');
  });

  it('keeps the modal open when the title is empty', async () => {
    await click($('.row[data-task="t1"] .kebab'));
    await click($('.row[data-task="t1"] [data-act="edit"]'));
    ($('#modal [name="title"]') as HTMLInputElement).value = '';
    await click($('#modal [data-act="submit-modal"]'));
    expect($('#modal').classList.contains('on')).toBe(true);
    expect($('#toast').textContent).toContain('A title is required');
  });

  it('creates a project and switches to it', async () => {
    await click($('[data-act="new-project"]'));
    ($('#modal [name="name"]') as HTMLInputElement).value = 'Website redesign';
    await click($('#modal [data-act="submit-modal"]'));
    expect(app.domain.currentProject?.name).toBe('Website redesign');
    expect(app.domain.currentProject?.key).toBe('WR');
    // A brand-new project opens the inline composer for its first task.
    expect($('#newTitle')).not.toBeNull();
    await click($('[data-act="cancel-compose"]'));
    expect($('#chain').textContent).toContain('has no tasks yet');
  });

  it('reassigns the owner and returns work to the open pool', async () => {
    await click($('.row[data-task="t1"] .kebab'));
    await click($('.row[data-task="t1"] [data-act="reassign"]'));
    // The modal lists every member as a checkbox, so two people can be ticked.
    expect($$('#modal input[type="checkbox"][name^="member:"]').length).toBe(
      app.domain.workspace.members.length,
    );
    ($('#modal [name="member:m3"]') as El).checked = false;
    ($('#modal [name="member:m5"]') as El).checked = true;
    await click($('#modal [data-act="submit-modal"]'));
    expect(app.domain.findTask('t1')!.assigneeIds).toEqual(['m5']);

    await click($('.row[data-task="t1"] .kebab'));
    await click($('.row[data-task="t1"] [data-act="unassign"]'));
    expect(app.domain.findTask('t1')!.assigneeIds).toEqual([]);
    expect($('.row[data-task="t1"] .take')).not.toBeNull();
  });

  it('puts two people on one task and lets a third join from the card', async () => {
    await click($('.row[data-task="t1"] .kebab'));
    await click($('.row[data-task="t1"] [data-act="reassign"]'));
    ($('#modal [name="member:m5"]') as El).checked = true;
    await click($('#modal [data-act="submit-modal"]'));
    expect(app.domain.findTask('t1')!.assigneeIds).toEqual(['m3', 'm5']);
    // Both faces are on the card, and the "+n" count is absent for two.
    expect($$('.row[data-task="t1"] .who .av').length).toBe(2);
    expect($('.row[data-task="t1"] .who').textContent).toContain('Sneha Thomas');
    expect($('.row[data-task="t1"] .who').textContent).toContain('Meera Suresh');

    // "Assign me too" is the self-service path onto somebody else's task.
    app.domain.workspace.me = 'm1';
    await click($('[data-act="cycle"][data-id="t1"]')); // re-render with me = m1
    const assignMe = $('.row[data-task="t1"] [data-act="assign-me"]');
    expect(assignMe).not.toBeNull();
    await click(assignMe);
    expect(app.domain.findTask('t1')!.assigneeIds).toEqual(['m3', 'm5', 'm1']);
    // Three is exactly the stack limit, so no overflow chip yet.
    expect($$('.row[data-task="t1"] .who .av').length).toBe(3);
    expect($('.row[data-task="t1"] .avmore')).toBeNull();
  });

  it('closes on Escape before anything else', async () => {
    await click($('[data-act="new-project"]'));
    expect($('#modal').classList.contains('on')).toBe(true);
    key(win.document.body, 'Escape');
    expect($('#modal').classList.contains('on')).toBe(false);
  });

  it('closes the modal from the scrim', async () => {
    await click($('[data-act="new-project"]'));
    await click($('#scrim'));
    expect($('#modal').classList.contains('on')).toBe(false);
  });
});

describe('team', () => {
  it('adds a teammate and keeps the list open on them', async () => {
    await click($('[data-act="team"]'));
    ($('#mNew') as HTMLInputElement).value = 'Devika Nair';
    await click($('#modal [data-act="add-member"]'));
    expect(app.domain.workspace.members.some((m) => m.name === 'Devika Nair')).toBe(true);
    expect($('#modal').classList.contains('on')).toBe(true);
    expect($('#modal').textContent).toContain('Devika Nair');
  });

  it('removes a teammate and frees their tasks', async () => {
    await click($('[data-act="team"]'));
    const before = app.domain.workspace.members.length;
    globalThis.confirm = () => true;
    await click($$('#modal [data-act="del-member"]').find((b) => b.dataset.id === 'm3'));
    expect(app.domain.workspace.members.length).toBe(before - 1);
    expect(app.domain.workspace.tasks.some((t) => t.assigneeIds.includes('m3'))).toBe(false);
  });

  it('switches the acting member and attributes new work to them', async () => {
    change($('[data-act="me"]'), 'm5');
    expect(app.domain.workspace.me).toBe('m5');
    await click($('[data-act="compose-end"]'));
    ($('#newTitle') as HTMLInputElement).value = 'Owned by Meera';
    await click($('[data-act="create"]'));
    const t = app.domain.workspace.tasks.find((x) => x.title === 'Owned by Meera')!;
    expect(t.createdBy).toBe('m5');
  });
});

describe('assistant', () => {
  it('opens, answers a chip and keeps the transcript', async () => {
    await click($('#fab'));
    expect($('#chat').classList.contains('on')).toBe(true);
    await click($$('#chat .chipsm').find((c) => c.textContent === 'What is blocked?'));
    expect($('#chat .msgs').textContent).toContain('NE-3');
    expect($$('#chat .msg.user').length).toBe(1);
  });

  it('drafts a task, previews it, and adds it on confirmation', async () => {
    await click($('#fab'));
    ($('#chatIn') as HTMLInputElement).value = 'add task Publish the beta invite for Meera due friday';
    await click($('#chat [data-act="chat-send"]'));
    expect($('#chat .preview')).not.toBeNull();
    expect($('#chat .preview').textContent).toContain('Meera Suresh');

    await click($('#chat [data-act="chat-add"]'));
    const created = app.domain.workspace.tasks.find((t) => t.title.includes('beta invite'))!;
    expect(created.assigneeIds).toEqual(['m5']);
    expect($$('.row[data-task]').some((r) => r.dataset.task === created.id)).toBe(true);
  });

  it('discards a draft without creating it', async () => {
    await click($('#fab'));
    ($('#chatIn') as HTMLInputElement).value = 'add task Something I will discard';
    await click($('#chat [data-act="chat-send"]'));
    await click($('#chat [data-act="chat-discard"]'));
    expect(app.domain.workspace.tasks.some((t) => t.title.includes('discard'))).toBe(false);
    expect($('#chat .msgs').textContent).toContain('Discarded');
  });

  it('completes a task when asked by key', async () => {
    await click($('#fab'));
    ($('#chatIn') as HTMLInputElement).value = 'NE-4 is done';
    await click($('#chat [data-act="chat-send"]'));
    expect(app.domain.findTask('t4')?.status).toBe('DONE');
    expect($('.row[data-task="t4"] .node').className).toContain('done');
  });

  it('sends with the Enter key', async () => {
    await click($('#fab'));
    const input = $('#chatIn') as HTMLInputElement;
    input.value = 'what is due this week?';
    key(input, 'Enter');
    expect($('#chat .msgs').textContent).toContain('Coming up');
  });

  it('greets again after the workspace is replaced', async () => {
    await click($('#fab'));
    await click($$('#chat .chipsm').find((c) => c.textContent === 'What is not taken?'));
    expect($$('#chat .msg').length).toBe(3); // greeting + question + answer
    globalThis.confirm = () => true;
    await click($('[data-act="wsmenu"]'));
    await click($('[data-pop="ws"] [data-act="ws-fresh"]'));
    await click($('#fab'));
    const greeting = $$('#chat .msg.bot')[0];
    expect(greeting.textContent).toContain('Hi');
    expect($$('#chat .msg').length).toBe(1);
  });
});

describe('workspace menu', () => {
  it('exports the workspace as JSON', async () => {
    let downloaded = '';
    const urlApi = globalThis.URL as unknown as {
      createObjectURL: (b: Blob) => string;
      revokeObjectURL: (u: string) => void;
    };
    urlApi.createObjectURL = (b: Blob & { __text?: string }) => {
      downloaded = b.__text ?? '';
      return 'blob:test';
    };
    urlApi.revokeObjectURL = () => {};
    const OriginalBlob = globalThis.Blob;
    class CapturingBlob extends OriginalBlob {
      __text: string;
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        this.__text = parts.map((p) => String(p)).join('');
      }
    }
    (globalThis as unknown as { Blob: unknown }).Blob = CapturingBlob;
    const createElement = win.document.createElement.bind(win.document);
    (win.document as unknown as { createElement: unknown }).createElement = (tag: string) => {
      const el = createElement(tag);
      if (tag === 'a') (el as unknown as HTMLAnchorElement).click = () => {};
      return el;
    };

    await click($('[data-act="wsmenu"]'));
    expect($('[data-pop="ws"]').classList.contains('on')).toBe(true);
    await click($('[data-pop="ws"] [data-act="ws-export"]'));
    const parsed = JSON.parse(downloaded) as { tasks: unknown[] };
    expect(parsed.tasks.length).toBe(32);
    expect($('#toast').textContent).toContain('Exported blackit-flow.json');
  });

  it('offers no demo-data actions in the project menu', async () => {
    await click($('[data-act="wsmenu"]'));
    const menu = $('[data-pop="ws"]');
    expect(menu.textContent).not.toContain('demo');
    expect(menu.querySelector('[data-act="reset"]')).toBeNull();
    expect(menu.querySelector('[data-act="ws-demo"]')).toBeNull();
    expect(menu.querySelector('[data-act="ws-fresh"]')).not.toBeNull();
    expect(menu.querySelector('[data-act="new-project"]')).not.toBeNull();
  });

  it('resets the whole workspace to fresh, but only after confirming', async () => {
    let asked = '';
    globalThis.confirm = (message?: string) => {
      asked = message ?? '';
      return true;
    };
    await click($('.row[data-task="t4"] .node'));
    await click($('[data-act="wsmenu"]'));
    await click($('[data-pop="ws"] [data-act="ws-fresh"]'));
    expect(asked).toContain('Reset everything');
    // A reset has to empty the *shared* workspace too. Keeping members behind
    // meant the next write pushed them straight back to the database.
    expect(app.domain.workspace.tasks).toEqual([]);
    expect(app.domain.workspace.projects).toEqual([]);
    expect(app.domain.workspace.members).toEqual([]);
    expect(app.domain.workspace.me).toBe(null);
    // Ready to set up from scratch.
    expect(app.domain.workspace.setup).toBe(false);
  });

  it('keeps the workspace untouched when the reset is declined', async () => {
    globalThis.confirm = () => false;
    await click($('.row[data-task="t4"] .node'));
    expect(app.domain.findTask('t4')?.status).toBe('PROG');
    await click($('[data-act="wsmenu"]'));
    await click($('[data-pop="ws"] [data-act="ws-fresh"]'));
    expect(app.domain.findTask('t4')?.status).toBe('PROG');
    expect(app.domain.workspace.tasks).toHaveLength(32);
    expect($('#welcome').classList.contains('on')).toBe(false);
  });

  it('declines destructive actions when confirm() is unavailable', async () => {
    const original = globalThis.confirm;
    // @ts-expect-error — simulating an environment without window.confirm.
    delete globalThis.confirm;
    await click($('.row[data-task="t4"] .node'));
    await click($('[data-act="wsmenu"]'));
    await click($('[data-pop="ws"] [data-act="ws-fresh"]'));
    expect(app.domain.workspace.tasks).toHaveLength(32);
    expect(app.domain.findTask('t4')?.status).toBe('PROG');
    globalThis.confirm = original;
  });
});

describe('wizard', () => {
  beforeEach(() => {
    mount(false);
    app.start();
  });

  it('walks three steps and builds the workspace', async () => {
    await click($('[data-act="welcome-fresh"]'));
    expect($('#modal').textContent).toContain('Set up your workspace');

    ($('#wzName') as HTMLInputElement).value = 'Arjun Menon';
    await click($('#modal [data-act="wz-next"]'));

    const project = $('#wzProject') as HTMLInputElement;
    project.value = 'Natil Evidayaa · Mobile App';
    type(project, project.value);
    // Same derivation as the prototype: initials of every word -> "NEMA".
    expect($('#wzKeyPrev')?.textContent).toBe('NEMA-1');
    expect($('#wzKeyPrev2')?.textContent).toBe('NEMA-2');
    ($('#wzProduct') as HTMLInputElement).value = 'Natil Evidayaa';
    await click($('#modal [data-act="wz-next"]'));

    ($('#wzTeam') as HTMLTextAreaElement).value = 'Nithin Raj\nSneha Thomas';
    await click($('#modal [data-act="wz-done"]'));

    expect($('#modal').classList.contains('on')).toBe(false);
    expect($('#welcome').classList.contains('on')).toBe(false);
    expect(app.domain.workspace.members.map((m) => m.name)).toEqual([
      'Arjun Menon',
      'Nithin Raj',
      'Sneha Thomas',
    ]);
    expect(app.domain.currentProject?.key).toBe('NEMA');
    expect($('#newTitle')).not.toBeNull();
  });

  it('refuses to continue without a name, then goes back a step', async () => {
    await click($('[data-act="welcome-fresh"]'));
    await click($('#modal [data-act="wz-next"]'));
    expect($('#toast').textContent).toContain('Your name is needed');
    expect($('#wzName')).not.toBeNull();

    ($('#wzName') as HTMLInputElement).value = 'Meera Suresh';
    await click($('#modal [data-act="wz-next"]'));
    expect($('#wzProject')).not.toBeNull();
    await click($('#modal [data-act="wz-back"]'));
    expect($('#wzName')).not.toBeNull();
  });

  it('can skip the team step', async () => {
    await click($('[data-act="welcome-fresh"]'));
    ($('#wzName') as HTMLInputElement).value = 'Solo Founder';
    await click($('#modal [data-act="wz-next"]'));
    ($('#wzProject') as HTMLInputElement).value = 'My Project';
    await click($('#modal [data-act="wz-next"]'));
    await click($('#modal [data-act="wz-skip"]'));
    expect(app.domain.workspace.members).toHaveLength(1);
    expect(app.domain.workspace.projects).toHaveLength(1);
  });

  it('loads the demo straight from the welcome screen', async () => {
    await click($('[data-act="welcome-demo"]'));
    expect(app.domain.workspace.tasks).toHaveLength(32);
    expect($('#welcome').classList.contains('on')).toBe(false);
    expect($$('.row[data-task]').length).toBe(15);
  });
});

describe('keyboard shortcuts', () => {
  it('Escape closes the composer when no modal or chat is open', async () => {
    await click($('[data-act="compose-end"]'));
    expect($('#newTitle')).not.toBeNull();
    key(win.document.body, 'Escape');
    expect($('#newTitle')).toBeNull();
  });

  it('Escape closes the assistant', async () => {
    await click($('#fab'));
    expect($('#chat').classList.contains('on')).toBe(true);
    key(win.document.body, 'Escape');
    expect($('#chat').classList.contains('on')).toBe(false);
  });
});

describe('drag to reorder', () => {
  /** Give every row a realistic stacked rect so the drop maths has geometry. */
  function layOutRows() {
    const rows = $$('.row[data-task]');
    let top = 200;
    rows.forEach((row) => {
      const height = 120;
      const rect = {
        top,
        bottom: top + height,
        height,
        left: 100,
        right: 800,
        width: 700,
        x: 100,
        y: top,
        toJSON: () => ({}),
      };
      row.getBoundingClientRect = () => rect as DOMRect;
      const card = row.querySelector('.card') as HTMLElement;
      card.getBoundingClientRect = () => rect as DOMRect;
      top += height + 26;
    });
    const wrap = $('.wrap');
    wrap.getBoundingClientRect = () =>
      ({ top: 0, bottom: top, height: top, left: 0, right: 940, width: 940, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    return rows;
  }

  function pointer(el: unknown, type: string, x: number, y: number) {
    const e = new win.MouseEvent(type, { bubbles: true, cancelable: true }) as unknown as El;
    Object.assign(e, { clientX: x, clientY: y, pointerType: 'mouse' });
    (el as El).dispatchEvent(e);
  }

  it('shows a ghost and a drop marker while dragging, then commits the move', async () => {
    layOutRows();
    const rowIds = $$('.row[data-task]').map((r) => r.dataset.task!);
    const movingId = rowIds[2]!; // NE-5, currently third
    const grip = $(`.row[data-task="${movingId}"] [data-grip]`);
    const statuses = new Map(app.domain.workspace.tasks.map((t) => [t.id, t.status]));

    pointer(grip, 'pointerdown', 200, 460);
    // Above the 6px threshold, so the drag actually starts.
    pointer(win.document.body, 'pointermove', 260, 470);
    expect($$('.dragghost').length).toBe(1);
    expect(win.document.body.classList.contains('reordering')).toBe(true);
    expect($(`.row[data-task="${movingId}"] .card`).classList.contains('dragging')).toBe(true);

    // Aim above the first row's midpoint to drop at the very top.
    pointer(win.document.body, 'pointermove', 260, 210);
    expect($('#dropmark').classList.contains('on')).toBe(true);

    pointer(win.document.body, 'pointerup', 260, 210);
    expect($$('.dragghost').length).toBe(0);
    expect(win.document.body.classList.contains('reordering')).toBe(false);
    expect($('#dropmark').classList.contains('on')).toBe(false);

    expect($$('.row[data-task]')[0]?.dataset.task).toBe(movingId);
    // Reordering is cosmetic: no status may change.
    app.domain.workspace.tasks.forEach((t) => expect(t.status).toBe(statuses.get(t.id)));
  });

  it('escapes a hostile task title in the drag ghost', async () => {
    layOutRows();
    const hostile = '<img src=x onerror="window.__xss=1">';
    app.domain.updateTask('t5', { title: hostile });
    layOutRows();
    const grip = $('.row[data-task="t5"] [data-grip]');
    pointer(grip, 'pointerdown', 200, 460);
    pointer(win.document.body, 'pointermove', 260, 470);
    const ghost = $$('.dragghost')[0]!;
    expect(ghost.querySelector('img')).toBeNull();
    expect(ghost.textContent).toContain(hostile);
    expect((win as unknown as { __xss?: number }).__xss).toBeUndefined();
    pointer(win.document.body, 'pointerup', 260, 470);
  });

  it('does not start a drag from the card body, only from the grip', async () => {
    layOutRows();
    const statuses = new Map(app.domain.workspace.tasks.map((t) => [t.id, t.status]));
    void statuses;
    // Press and pull on the card's own background: the prototype reordered
    // here, we deliberately require the grip handle.
    const card = $('.row[data-task="t5"] .card');
    pointer(card, 'pointerdown', 400, 460);
    pointer(win.document.body, 'pointermove', 460, 470);
    expect($$('.dragghost').length).toBe(0);
    expect(win.document.body.classList.contains('reordering')).toBe(false);
    pointer(win.document.body, 'pointerup', 460, 470);

    // The card title is selectable rather than draggable.
    const title = $('.row[data-task="t5"] h3');
    pointer(title, 'pointerdown', 400, 460);
    pointer(win.document.body, 'pointermove', 460, 470);
    expect($$('.dragghost').length).toBe(0);
    pointer(win.document.body, 'pointerup', 460, 470);

    // The grip still works.
    const grip = $('.row[data-task="t5"] [data-grip]');
    pointer(grip, 'pointerdown', 200, 460);
    pointer(win.document.body, 'pointermove', 260, 470);
    expect($$('.dragghost').length).toBe(1);
    pointer(win.document.body, 'pointerup', 260, 470);
  });

  it('leaves the chain untouched when the drag is cancelled', async () => {
    layOutRows();
    const before = $$('.row[data-task]').map((r) => r.dataset.task);
    const grip = $('.row[data-task="t5"] [data-grip]');
    pointer(grip, 'pointerdown', 200, 460);
    pointer(win.document.body, 'pointermove', 260, 470);
    pointer(win.document.body, 'pointercancel', 260, 470);
    expect($$('.dragghost').length).toBe(0);
    expect($$('.row[data-task]').map((r) => r.dataset.task)).toEqual(before);
  });

  it('does not reorder when a card is dropped back in place', async () => {
    layOutRows();
    const before = $$('.row[data-task]').map((r) => r.dataset.task);
    const grip = $('.row[data-task="t1"] [data-grip]');
    pointer(grip, 'pointerdown', 200, 220);
    pointer(win.document.body, 'pointermove', 260, 230);
    pointer(win.document.body, 'pointermove', 260, 240);
    pointer(win.document.body, 'pointerup', 260, 240);
    expect($$('.row[data-task]').map((r) => r.dataset.task)).toEqual(before);
  });
});

describe('custom type field', () => {
  it('reveals the free-text box when "Other…" is chosen', async () => {
    await click($('[data-act="compose-end"]'));
    const select = $('#newType') as HTMLSelectElement;
    const free = $('#newTypeCustom') as HTMLInputElement;
    expect(free.hidden).toBe(true);
    change(select, '__custom');
    expect(free.hidden).toBe(false);
    change(select, 'tt3');
    expect(free.hidden).toBe(true);
  });

  it('saves a task with the typed type name', async () => {
    await click($('[data-act="compose-end"]'));
    ($('#newTitle') as HTMLInputElement).value = 'Spike the flaky test';
    change($('#newType'), '__custom');
    ($('#newTypeCustom') as HTMLInputElement).value = 'Spike';
    await click($('[data-act="create"]'));
    const t = app.domain.workspace.tasks.find((x) => x.title === 'Spike the flaky test')!;
    expect(t.typeId).toBe('Spike');
    expect($('#chain').textContent).toContain('Spike');
  });

  it('refuses a custom type with no name', async () => {
    await click($('[data-act="compose-end"]'));
    ($('#newTitle') as HTMLInputElement).value = 'No type given';
    change($('#newType'), '__custom');
    await click($('[data-act="create"]'));
    expect(app.domain.workspace.tasks.some((x) => x.title === 'No type given')).toBe(false);
    // The composer stays open so the mistake can be corrected.
    expect($('#newTitle')).not.toBeNull();
  });

  it('a custom type survives the edit round-trip', async () => {
    // Create through the UI so the whole path is exercised, then reopen it.
    await click($('[data-act="compose-end"]'));
    ($('#newTitle') as HTMLInputElement).value = 'Round-trip me';
    change($('#newType'), '__custom');
    ($('#newTypeCustom') as HTMLInputElement).value = 'Investigation';
    await click($('[data-act="create"]'));
    const t = app.domain.workspace.tasks.find((x) => x.title === 'Round-trip me')!;
    await click($(`[data-act="menu"][data-id="${t.id}"]`));
    await click($(`[data-act="edit"][data-id="${t.id}"]`));
    // The modal shows "Other…" plus the text, not a fallback type.
    expect(($('[name="typeId"]') as HTMLSelectElement).value).toBe('__custom');
    expect(($('[name="typeFree"]') as HTMLInputElement).value).toBe('Investigation');

    // And saving with no change keeps it.
    await click($('[data-act="submit-modal"]'));
    expect(app.domain.findTask(t.id)?.typeId).toBe('Investigation');
  });
});
