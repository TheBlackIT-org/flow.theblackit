/**
 * The notification bell.
 *
 * Notifications are per *person*, written by database triggers, and delivered
 * over Realtime — which makes the interesting parts invisible in the UI: that
 * another member's rows never leak in, that the badge counts only unread ones,
 * and that marking read actually round-trips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { BlackitFlowApp } from '../src/lib/app';
import { NoAuth } from '../src/lib/auth';
import { emptyWorkspace, seed } from '../src/lib/domain';
import { RepositoryHost } from '../src/lib/repository/host';
import { LocalRepository } from '../src/lib/repository/local';
import { SupabaseRepository } from '../src/lib/repository/supabase';
import { renderBell } from '../src/lib/render';
import type { NotificationRecord } from '../src/lib/repository/types';
import { fakeSupabase, uuidFor, type FakeSupabase } from './helpers/fake-supabase';

const SHELL = `
  <header class="top"><div class="top-in">
    <div class="brand">BlackIT Flow</div>
    <div class="ctrls" id="ctrls"></div>
    <div class="hp" id="hp"></div>
    <div class="menu" id="wsmenu"></div>
    <div class="live" id="live"></div>
  </div></header>
  <div class="sub" id="sub"></div>
  <div class="wrap"><div class="chain" id="chain"></div><div id="dropmark"></div></div>
  <div class="welcome" id="welcome"></div>
  <div class="scrim" id="scrim"></div>
  <div class="modal" id="modal"></div>
  <button class="fab" id="fab" data-act="chat-toggle"></button>
  <div class="chat" id="chat"></div>
  <div class="toast" id="toast"></div>
`;

type AnyWin = Window & { confirm: (message?: string) => boolean };
type El = any;

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const WS = uuidFor('ws-notif');
const ME = uuidFor('m-me');
const OTHER = uuidFor('m-other');
const PROJ = uuidFor('p-notif');
const TASK = uuidFor('t-notif');

let win: AnyWin;

const $ = (sel: string): El => win.document.querySelector(sel);
const $$ = (sel: string): El[] => Array.from(win.document.querySelectorAll(sel));

async function settle(ms = 0): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

async function click(el: unknown): Promise<void> {
  if (!el) throw new Error('cannot click a missing element');
  (el as El).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();
}

function mountDom(): void {
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
}

/** A shared workspace with one bound member, a task, and three bell entries. */
function sharedHost(): { fake: FakeSupabase; host: RepositoryHost } {
  const fake = fakeSupabase({
    workspaces: [{ id: WS, name: 'BlackIT Flow' }],
    members: [
      { id: ME, workspace_id: WS, name: 'Arjun Menon', role: 'owner', title: '', user_id: 'auth-1' },
      { id: OTHER, workspace_id: WS, name: 'Sneha Thomas', role: 'member', title: '', user_id: 'auth-2' },
    ],
    projects: [{ id: PROJ, workspace_id: WS, key: 'NE', name: 'Natil Evidayaa', product: '' }],
    tasks: [
      {
        id: TASK,
        project_id: PROJ,
        key: 'NE-1',
        position: 0,
        title: 'Chat with nearby Keralites',
        status: 'PROG',
        created_at: new Date(NOW).toISOString(),
      },
    ],
    notifications: [
      {
        id: 1,
        workspace_id: WS,
        recipient_id: ME,
        actor_name: 'Sneha Thomas',
        kind: 'task.assigned',
        task_id: TASK,
        task_key: 'NE-1',
        summary: '',
        created_at: new Date(NOW).toISOString(),
        read_at: null,
      },
      {
        id: 2,
        workspace_id: WS,
        recipient_id: ME,
        actor_name: 'Rahul Krishnan',
        kind: 'task.status',
        task_id: TASK,
        task_key: 'NE-1',
        summary: 'BLOCK',
        created_at: new Date(NOW - 60_000).toISOString(),
        read_at: new Date(NOW).toISOString(),
      },
      {
        id: 3,
        workspace_id: WS,
        recipient_id: OTHER,
        actor_name: 'Nobody Should See This',
        kind: 'task.assigned',
        task_id: TASK,
        task_key: 'NE-1',
        summary: '',
        created_at: new Date(NOW).toISOString(),
        read_at: null,
      },
    ],
  });
  const host = new RepositoryHost(
    new SupabaseRepository({ url: 'https://example.supabase.co', anonKey: 'anon', client: fake.client }),
    { seedSample: false },
  );
  return { fake, host };
}

async function startApp(host: RepositoryHost): Promise<BlackitFlowApp> {
  const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth: new NoAuth() });
  await app.start();
  await settle();
  return app;
}

beforeEach(() => mountDom());
afterEach(() => win.close());

/* --------------------------------- rendering ------------------------------ */

describe('renderBell', () => {
  const record = (over: Partial<NotificationRecord> = {}): NotificationRecord => ({
    id: 1,
    kind: 'task.assigned',
    actorId: null,
    actorName: 'Sneha Thomas',
    taskId: 't1',
    taskKey: 'NE-1',
    summary: '',
    createdAt: NOW,
    readAt: null,
    ...over,
  });

  it('counts only the unread entries', () => {
    const html = renderBell([record(), record({ id: 2, readAt: NOW })], 'supabase');
    expect(html).toContain('bellcount');
    expect(html).toContain('>1<');
  });

  it('has no badge when everything is read', () => {
    const html = renderBell([record({ readAt: NOW })], 'supabase');
    expect(html).not.toContain('bellcount');
    // The "Mark all read" shortcut is pointless with nothing unread.
    expect(html).not.toContain('notif-read-all');
  });

  it('caps the badge rather than spelling out a big number', () => {
    const many = Array.from({ length: 12 }, (_, i) => record({ id: i + 1 }));
    expect(renderBell(many, 'supabase')).toContain('9+');
  });

  it('phrases each kind for a person', () => {
    const html = renderBell(
      [
        record(),
        record({ id: 2, kind: 'subtask.assigned', summary: 'Design the empty state' }),
        record({ id: 3, kind: 'task.status', summary: 'BLOCK' }),
      ],
      'supabase',
    );
    expect(html).toContain('put you on');
    expect(html).toContain('handed you a step in');
    expect(html).toContain('Design the empty state');
    // A status is a code in the database and a word on screen.
    expect(html).toContain('Blocked');
  });

  it('says so when there is nothing yet', () => {
    expect(renderBell([], 'supabase')).toContain('Nothing yet');
  });

  it('renders no bell at all without a backend', () => {
    // Notifications are written by database triggers; an empty bell in the
    // browser-local build would be a promise the app cannot keep.
    expect(renderBell([record()], 'local')).toBe('');
  });

  it('marks a task-less notification instead of pointing at nothing', () => {
    const html = renderBell([record({ taskId: null, taskKey: '' })], 'supabase');
    expect(html).toContain('a task since deleted');
  });
});

/* ---------------------------------- the app ------------------------------- */

describe('the bell in the header', () => {
  it('shows this member’s unread count and never anybody else’s', async () => {
    const { host } = sharedHost();
    await startApp(host);

    expect($('.bell')).not.toBeNull();
    expect($('.bellcount').textContent).toBe('1');
    const panel = $('[data-pop="notifs"]').textContent;
    expect(panel).toContain('Sneha Thomas');
    expect(panel).toContain('Rahul Krishnan');
    // The third row belongs to another member and must not appear at all.
    expect(panel).not.toContain('Nobody Should See This');
    expect($$('.notifrow').length).toBe(2);
  });

  it('opens on click and closes again', async () => {
    const { host } = sharedHost();
    await startApp(host);

    await click($('[data-act="notif-toggle"]'));
    expect($('[data-pop="notifs"]').classList.contains('on')).toBe(true);
    await click($('[data-act="notif-toggle"]'));
    expect($('[data-pop="notifs"]').classList.contains('on')).toBe(false);
  });

  it('jumps to the task a notification is about, and marks it read', async () => {
    const { host } = sharedHost();
    const app = await startApp(host);
    // Start somewhere else, so the jump is observable.
    app.domain.workspace.projectId = null;

    await click($('[data-act="notif-toggle"]'));
    await click($('.notifrow.unread'));

    expect(app.domain.workspace.projectId).toBe(PROJ);
    // And the board really shows it, rather than just pointing at the project.
    // (`enter` is a one-shot animation flag the render consumes, so it is
    // deliberately null by the time this runs.)
    expect($(`.row[data-task="${TASK}"]`)).not.toBeNull();
    // Read in the database, not just on screen: the badge is gone.
    expect($('.bellcount')).toBeNull();
  });

  it('clears the whole badge with the one shortcut', async () => {
    const { host } = sharedHost();
    await startApp(host);
    expect($('.bellcount')).not.toBeNull();

    await click($('[data-act="notif-toggle"]'));
    await click($('[data-act="notif-read-all"]'));

    expect($('.bellcount')).toBeNull();
    // And the shortcut goes with it, leaving no dead control.
    expect($('.bell .bellcount')).toBeNull();
  });

  it('has no bell in the browser-local build', async () => {
    const host = new RepositoryHost(new LocalRepository(win.localStorage as unknown as Storage));
    const app = new BlackitFlowApp({ workspace: seed(NOW), host, auth: new NoAuth() });
    await app.start();
    expect($('.bell')).toBeNull();
  });
});
