/**
 * Sign-in integration: the real app, the real shell, a real (fake-backed)
 * Supabase repository, and a stand-in auth service.
 *
 * These protect the joins that no unit test can see — the gate that decides
 * whether the board may be shown at all, the binding of an account to a member
 * row, and the invitation round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { parseTeammate } from '../src/lib/actions';
import { BlackitFlowApp } from '../src/lib/app';
import { NoAuth, type AuthPort, type AuthResult } from '../src/lib/auth';
import { STORAGE_KEY } from '../src/lib/constants';
import { emptyWorkspace, seed } from '../src/lib/domain';
import { RepositoryHost } from '../src/lib/repository/host';
import { LocalRepository } from '../src/lib/repository/local';
import { SupabaseRepository } from '../src/lib/repository/supabase';
import type { AuthUser } from '../src/lib/types';
import { fakeSupabase, uuidFor, type FakeSupabase } from './helpers/fake-supabase';

const SHELL = `
  <header class="top"><div class="top-in">
    <div class="brand">BlackIT Flow</div>
    <div class="ctrls" id="ctrls"></div>
    <div class="hp" id="hp"></div>
    <div class="menu" id="wsmenu"></div>
    <div class="acct" id="acct"></div>
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

type AnyWin = Window & { confirm: (message?: string) => boolean };
type El = any; // happy-dom's DOM types differ structurally from lib.dom

let win: AnyWin;

const WS = uuidFor('workspace');
const OWNER = uuidFor('m-owner');

const ACCOUNT: AuthUser = {
  id: 'auth-1',
  email: 'arjun@theblackit.com',
  name: 'Arjun Menon',
  avatarUrl: null,
};

/* --------------------------------- harness -------------------------------- */

class FakeAuth implements AuthPort {
  readonly configured = true;
  user: AuthUser | null;
  githubCalls = 0;
  signOuts = 0;
  linksSent: string[] = [];
  codes: Array<{ email: string; code: string }> = [];
  failGitHub: string | null = null;
  failCode: string | null = null;
  private listeners: Array<(user: AuthUser | null) => void> = [];

  constructor(user: AuthUser | null) {
    this.user = user;
  }

  currentUser = async (): Promise<AuthUser | null> => this.user;

  onChange = (cb: (user: AuthUser | null) => void): (() => void) => {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  };

  signInWithGitHub = async (): Promise<AuthResult> => {
    this.githubCalls += 1;
    return this.failGitHub ? { ok: false, message: this.failGitHub } : { ok: true, message: 'Redirecting to GitHub…' };
  };

  sendEmailLink = async (email: string): Promise<AuthResult> => {
    if (!email.includes('@')) return { ok: false, message: 'That does not look like an email address.' };
    this.linksSent.push(email);
    return { ok: true, message: `Sent. Check ${email}` };
  };

  verifyEmailCode = async (email: string, code: string): Promise<AuthResult> => {
    this.codes.push({ email, code });
    if (this.failCode) return { ok: false, message: this.failCode };
    this.user = { id: 'auth-1', email, name: 'Arjun Menon', avatarUrl: null };
    this.emit(this.user);
    return { ok: true, message: 'Signed in.' };
  };

  signOut = async (): Promise<void> => {
    this.signOuts += 1;
    this.user = null;
    this.emit(null);
  };

  emit(user: AuthUser | null): void {
    for (const cb of [...this.listeners]) cb(user);
  }
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

/** A shared workspace with whatever member rows the case needs. */
function sharedHost(members: Array<Record<string, unknown>>): {
  fake: FakeSupabase;
  host: RepositoryHost;
} {
  const fake = fakeSupabase({ workspaces: [{ id: WS }], members, projects: [], tasks: [], subtasks: [] });
  return { fake, host: supabaseHost(fake) };
}

function supabaseHost(fake: FakeSupabase): RepositoryHost {
  return new RepositoryHost(
    new SupabaseRepository({ url: 'https://example.supabase.co', anonKey: 'anon', client: fake.client }),
    { seedSample: false },
  );
}

function memberRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: OWNER,
    workspace_id: WS,
    name: 'Arjun Menon',
    role: 'owner',
    title: '',
    is_agent: false,
    user_id: null,
    email: null,
    ...over,
  };
}

function localHost(): RepositoryHost {
  return new RepositoryHost(new LocalRepository(win.localStorage as unknown as Storage));
}

const $ = (sel: string): El => win.document.querySelector(sel);
const set = (sel: string, value: string): void => {
  const el = $(sel);
  if (!el) throw new Error(`missing ${sel}`);
  el.value = value;
};

async function settle(ms = 0): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function click(el: unknown): Promise<void> {
  if (!el) throw new Error('cannot click a missing element');
  (el as El).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();
}

beforeEach(() => mountDom());
afterEach(() => win.close());

/* --------------------------------- the gate -------------------------------- */

describe('the sign-in gate', () => {
  it('shows the sign-in card and holds the board back when there is no session', async () => {
    const auth = new FakeAuth(null);
    const { host } = sharedHost([]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });

    await app.start();

    expect($('#welcome').classList.contains('on')).toBe(true);
    expect($('#welcome').textContent).toContain('Sign in to BlackIT Flow');
    // `booting` is what hides .top/.sub/.wrap/.fab in the stylesheet.
    expect(win.document.body.classList.contains('booting')).toBe(true);
    // The pre-hydration guard must be lifted, or the 6s failsafe announces that
    // the app failed to start while the sign-in card is sitting there.
    expect(win.document.documentElement.classList.contains('first-run')).toBe(false);
    // No identity is invented while signed out.
    expect(app.domain.workspace.me).toBeNull();
  });

  it('leaves the browser-local workspace login-free', async () => {
    // The gate is ignored without an auth service: there is nothing to sign in
    // to, and the demo has to keep working exactly as it did.
    const app = new BlackitFlowApp({
      workspace: seed(Date.UTC(2026, 9, 10)),
      host: localHost(),
      auth: new NoAuth(),
      requireLogin: true,
    });

    await app.start();

    expect($('#welcome').textContent).not.toContain('Sign in to BlackIT Flow');
    expect($('#welcome').classList.contains('on')).toBe(false);
    expect($('#chain').querySelectorAll('.row[data-task]').length).toBeGreaterThan(0);
  });

  it('starts GitHub sign-in from the button', async () => {
    const auth = new FakeAuth(null);
    const { host } = sharedHost([]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();

    await click($('[data-act="auth-github"]'));

    expect(auth.githubCalls).toBe(1);
  });

  it('keeps a failed GitHub hand-off on the sign-in card, with a readable reason', async () => {
    const auth = new FakeAuth(null);
    auth.failGitHub = 'GitHub sign-in is not enabled on this project yet.';
    const { host } = sharedHost([]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();

    await click($('[data-act="auth-github"]'));

    expect($('#welcome').textContent).toContain('not enabled');
    expect($('#welcome').textContent).toContain('Sign in to BlackIT Flow');
  });
});

/* ------------------------------- email links ------------------------------ */

describe('the email fallback', () => {
  it('moves to the code step once a link has been sent', async () => {
    const auth = new FakeAuth(null);
    const { host } = sharedHost([]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();

    set('#authEmail', 'sneha@theblackit.com');
    await click($('[data-act="auth-email"]'));

    expect(auth.linksSent).toEqual(['sneha@theblackit.com']);
    expect($('#welcome').textContent).toContain('Check your email');
    expect($('#authCode')).toBeTruthy();
  });

  it('reports a bad code without losing the step', async () => {
    const auth = new FakeAuth(null);
    auth.failCode = 'That code is not valid any more. Request a fresh one.';
    const { host } = sharedHost([]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();

    set('#authEmail', 'sneha@theblackit.com');
    await click($('[data-act="auth-email"]'));
    set('#authCode', '000000');
    await click($('[data-act="auth-code"]'));

    expect(auth.codes).toEqual([{ email: 'sneha@theblackit.com', code: '000000' }]);
    expect($('#welcome').textContent).toContain('not valid any more');
    expect($('#authCode')).toBeTruthy();
  });

  it('can go back to a different email address', async () => {
    const auth = new FakeAuth(null);
    const { host } = sharedHost([]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();

    set('#authEmail', 'sneha@theblackit.com');
    await click($('[data-act="auth-email"]'));
    await click($('[data-act="auth-other"]'));

    expect($('#welcome').textContent).toContain('Sign in to BlackIT Flow');
    expect($('#authEmail')).toBeTruthy();
  });
});

/* -------------------------------- binding --------------------------------- */

describe('binding an account to a member', () => {
  it('opens the board when the account already owns a member row', async () => {
    const auth = new FakeAuth(ACCOUNT);
    const { host } = sharedHost([memberRow({ user_id: 'auth-1', email: 'arjun@theblackit.com' })]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });

    await app.start();

    expect(app.domain.workspace.me).toBe(OWNER);
    expect($('#welcome').classList.contains('on')).toBe(false);
    expect(win.document.body.classList.contains('booting')).toBe(false);
    // The header names the signed-in person, and the impersonation picker is
    // gone: there is nothing left to act as.
    expect($('#acct').textContent).toContain('Arjun Menon');
    expect($('#ctrls').querySelector('[data-act="me"]')).toBeNull();
  });

  it('claims an invitation addressed to the signed-in email', async () => {
    const auth = new FakeAuth({ ...ACCOUNT, email: 'sneha@theblackit.com' });
    const { fake, host } = sharedHost([
      memberRow({ id: uuidFor('m-sneha'), name: 'Sneha Thomas', email: 'Sneha@TheBlackIT.com' }),
    ]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });

    await app.start();

    expect(app.domain.workspace.me).toBe(uuidFor('m-sneha'));
    // The claim is written back so the next sign-in needs no email match.
    expect(fake.tables.members?.[0]).toMatchObject({ user_id: 'auth-1' });
  });

  it('refuses the board to an account nobody invited', async () => {
    const auth = new FakeAuth({ ...ACCOUNT, email: 'stranger@elsewhere.com' });
    const { host } = sharedHost([memberRow({ user_id: 'someone-else', email: 'arjun@theblackit.com' })]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });

    await app.start();

    expect($('#welcome').textContent).toContain('Not on this workspace yet');
    expect(win.document.body.classList.contains('booting')).toBe(true);
    // Critically: not silently acting as the first member in the table.
    expect(app.domain.workspace.me).toBeNull();
  });

  it('lets an invited person in without a reload', async () => {
    const auth = new FakeAuth({ ...ACCOUNT, email: 'sneha@theblackit.com' });
    const { fake, host } = sharedHost([memberRow({ user_id: 'someone-else' })]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();
    expect($('#welcome').textContent).toContain('Not on this workspace yet');

    // The owner adds the invitation while this person is looking at the screen.
    const SNEHA = uuidFor('m-sneha');
    (fake.tables.members ?? []).push(
      memberRow({ id: SNEHA, name: 'Sneha Thomas', email: 'sneha@theblackit.com' }),
    );

    await click($('[data-act="auth-retry"]'));

    expect(app.domain.workspace.me).toBe(SNEHA);
    expect($('#welcome').classList.contains('on')).toBe(false);
  });

  it('names the missing migration instead of blaming the invitation', async () => {
    const auth = new FakeAuth(ACCOUNT);
    // Rows exist, but with no `email` column: the schema predates sign-in.
    const { fake } = sharedHost([]);
    fake.tables.members = [{ id: OWNER, workspace_id: WS, name: 'Arjun Menon', user_id: null }];
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host: supabaseHost(fake), auth, requireLogin: true });

    await app.start();

    expect($('#welcome').textContent).toContain('0003_member_identity.sql');
  });
});

/* ------------------------------- first run -------------------------------- */

describe('first-run setup while signed in', () => {
  it('binds the account to the owner row the wizard creates, and invites by email', async () => {
    // A brand-new deployment: no workspace row at all, so nobody can be bound
    // yet and the wizard is the only way to create the first member.
    const fake = fakeSupabase({});
    const auth = new FakeAuth(ACCOUNT);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host: supabaseHost(fake), auth, requireLogin: true });

    await app.start();
    expect($('#welcome').textContent).toContain('Start fresh');

    await click($('[data-act="welcome-fresh"]'));
    set('#wzName', 'Arjun Menon');
    set('#wzTitle', 'Founder');
    await click($('[data-act="wz-next"]'));
    set('#wzProject', 'Flow internal tool');
    await click($('[data-act="wz-next"]'));
    set('#wzTeam', 'Sneha Thomas <sneha@theblackit.com>\nRahul Krishnan');
    await click($('[data-act="wz-done"]'));

    const members = app.domain.workspace.members;
    const owner = members.find((m) => m.name === 'Arjun Menon');
    expect(owner?.role).toBe('owner');
    // The signed-in account is bound now, so the next visit skips the wizard.
    expect(owner?.email).toBe('arjun@theblackit.com');
    expect(owner?.userId).toBe('auth-1');

    const sneha = members.find((m) => m.name === 'Sneha Thomas');
    expect(sneha?.email).toBe('sneha@theblackit.com');
    // An invitation, not a binding: it is claimed on her first sign-in.
    expect(sneha?.userId).toBeUndefined();

    // A bare name still works — the browser-local build's format survives.
    expect(members.find((m) => m.name === 'Rahul Krishnan')?.email).toBeUndefined();
  });
});

/* ----------------------------- other tabs -------------------------------- */

describe('a session that changes elsewhere', () => {
  it('follows a sign-out in another tab, and clears the board behind the card', async () => {
    const auth = new FakeAuth(ACCOUNT);
    const { host } = sharedHost([memberRow({ user_id: 'auth-1' })]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();
    expect($('#acct').textContent).toContain('Arjun Menon');

    // The provider reports the sign-out this tab did not perform.
    auth.emit(null);
    await settle();

    expect($('#welcome').textContent).toContain('You have been signed out');
    expect(win.document.body.classList.contains('booting')).toBe(true);
    // Not just covered up: the previous account's workspace is gone from the
    // DOM as well as from the screen.
    expect($('#acct').textContent).not.toContain('Arjun Menon');
    expect($('#chain').textContent).not.toContain('Arjun Menon');
    expect(app.domain.workspace.members).toHaveLength(0);
  });

  it('ignores a refresh of the same account', async () => {
    const auth = new FakeAuth(ACCOUNT);
    const { host } = sharedHost([memberRow({ user_id: 'auth-1' })]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();

    // A token refresh re-delivers the same session; nothing may be rebuilt.
    auth.emit(ACCOUNT);
    await settle();

    expect(app.domain.workspace.me).toBe(OWNER);
    expect($('#welcome').classList.contains('on')).toBe(false);
  });
});

/* ------------------------ the pre-sign-in bootstrap ----------------------- */

describe('a workspace that predates sign-in', () => {
  /** Names but no emails: exactly what an existing team's rows look like. */
  const LEGACY = [
    memberRow({ id: OWNER, name: 'Shithin', role: 'member', email: null, user_id: null }),
    memberRow({ id: uuidFor('m-anu'), name: 'Anu', role: 'member', email: null, user_id: null }),
  ];

  it('offers the names instead of locking everybody out', async () => {
    const auth = new FakeAuth(ACCOUNT);
    const { host } = sharedHost(structuredClone(LEGACY));
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });

    await app.start();

    expect($('#welcome').textContent).toContain('Which one of these are you?');
    expect($('#welcome').textContent).toContain('Shithin');
    expect($('#welcome').textContent).toContain('Anu');
    // And nothing is assumed on their behalf: no identity until they choose.
    expect(app.domain.workspace.me).toBeNull();
  });

  it('binds the chosen name and opens the board', async () => {
    const auth = new FakeAuth(ACCOUNT);
    const { fake, host } = sharedHost(structuredClone(LEGACY));
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();

    await click($(`[data-act="auth-claim"][data-id="${OWNER}"]`));

    expect(app.domain.workspace.me).toBe(OWNER);
    expect($('#welcome').classList.contains('on')).toBe(false);
    expect(fake.tables.members?.find((r) => (r as { id: string }).id === OWNER)).toMatchObject({
      user_id: 'auth-1',
    });
  });

  it('never offers the picker again once somebody is bound', async () => {
    // The first colleague claims a name…
    const first = new FakeAuth(ACCOUNT);
    const { fake, host } = sharedHost(structuredClone(LEGACY));
    const firstApp = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth: first, requireLogin: true });
    await firstApp.start();
    await click($(`[data-act="auth-claim"][data-id="${OWNER}"]`));
    expect(firstApp.domain.workspace.me).toBe(OWNER);

    // …and from then on the only way in is an invitation.
    const second = new FakeAuth({ ...ACCOUNT, id: 'auth-2', email: 'anu@theblackit.com' });
    const secondApp = new BlackitFlowApp({
      workspace: emptyWorkspace(),
      host: supabaseHost(fake),
      auth: second,
      requireLogin: true,
    });
    await secondApp.start();

    expect($('#welcome').textContent).toContain('Not on this workspace yet');
    expect($('#welcome').textContent).not.toContain('Which one of these are you?');
  });
});

/* -------------------------------- sign out -------------------------------- */

describe('signing out', () => {
  it('ends the session and forgets the cached workspace', async () => {
    const auth = new FakeAuth(ACCOUNT);
    const { host } = sharedHost([memberRow({ user_id: 'auth-1' })]);
    const app = new BlackitFlowApp({ workspace: emptyWorkspace(), host, auth, requireLogin: true });
    await app.start();
    win.localStorage.setItem(STORAGE_KEY, '{"members":[]}');

    await click($('#wsmenu [data-act="auth-signout"]'));

    expect(auth.signOuts).toBe(1);
    // The next person at this browser must not see the previous account's board
    // flash up before their own session resolves.
    expect(win.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

/* ----------------------------- teammate lines ----------------------------- */

describe('parsing a teammate line', () => {
  it('reads the shapes people actually type', () => {
    expect(parseTeammate('Nithin Raj <nithin@theblackit.com>')).toEqual({
      name: 'Nithin Raj',
      email: 'nithin@theblackit.com',
    });
    expect(parseTeammate('Sneha Thomas, sneha@theblackit.com')).toEqual({
      name: 'Sneha Thomas',
      email: 'sneha@theblackit.com',
    });
  });

  it('keeps a bare name working, for the browser-local build', () => {
    expect(parseTeammate('Rahul Krishnan')).toEqual({ name: 'Rahul Krishnan', email: null });
  });

  it('falls back to the local part when only an address is given', () => {
    expect(parseTeammate('meera@theblackit.com')).toEqual({ name: 'meera', email: 'meera@theblackit.com' });
  });

  it('does not mistake a name for an address', () => {
    expect(parseTeammate('Arjun Menon').email).toBeNull();
  });
});
