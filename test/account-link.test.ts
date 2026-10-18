/**
 * Account linking.
 *
 * `linkAccount` is the joining point between "somebody signed in" and "we know
 * which teammate that is". Getting it wrong is not a cosmetic bug: it either
 * locks a real teammate out, or silently hands them somebody else's identity.
 * These tests pin down both halves.
 */
import { describe, expect, it } from 'vitest';
import { SupabaseRepository } from '../src/lib/repository/supabase';
import { fakeSupabase, uuidFor, type FakeSupabase } from './helpers/fake-supabase';
import type { AuthUser } from '../src/lib/types';

const WS = uuidFor('workspace');
const ARJUN = uuidFor('m-arjun');
const SNEHA = uuidFor('m-sneha');

function repo(fake: FakeSupabase): SupabaseRepository {
  return new SupabaseRepository({
    url: 'https://example.supabase.co',
    anonKey: 'anon',
    client: fake.client,
  });
}

/** A member row shaped the way PostgREST returns one. */
function memberRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ARJUN,
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

function account(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'auth-1',
    email: 'arjun@theblackit.com',
    name: 'Arjun Menon',
    avatarUrl: null,
    ...over,
  };
}

describe('linkAccount', () => {
  it('finds the row that already names this account', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [memberRow({ user_id: 'auth-1', email: 'arjun@theblackit.com' })],
    });
    const member = await repo(fake).linkAccount(account());
    expect(member?.id).toBe(ARJUN);
    expect(member?.name).toBe('Arjun Menon');
  });

  it('does not hand over a row bound to somebody else', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [memberRow({ user_id: 'auth-9', email: 'arjun@theblackit.com' })],
    });
    // Same email, different account id: the bound row wins, so this account is
    // simply not a member rather than an impersonator.
    const member = await repo(fake).linkAccount(account());
    expect(member).toBeNull();
  });

  it('claims an unclaimed invite and writes the account id back', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [memberRow({ id: SNEHA, name: 'Sneha Thomas', email: 'sneha@theblackit.com' })],
    });
    const repository = repo(fake);
    const member = await repository.linkAccount(account({ id: 'auth-2', email: 'sneha@theblackit.com' }));

    expect(member?.id).toBe(SNEHA);
    expect(member?.userId).toBe('auth-2');
    // The claim is persisted, so the next sign-in takes the direct path.
    const stored = fake.tables.members?.[0] as Record<string, unknown>;
    expect(stored.user_id).toBe('auth-2');
    // And the second call finds it without matching on email at all.
    expect((await repository.linkAccount(account({ id: 'auth-2', email: null })))?.id).toBe(SNEHA);
  });

  it('matches an invite case-insensitively', async () => {
    // GitHub returns whatever capitalisation the person used when they signed up.
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [memberRow({ id: SNEHA, email: 'Sneha.Thomas@TheBlackIT.com' })],
    });
    const member = await repo(fake).linkAccount(account({ id: 'auth-2', email: 'sneha.thomas@theblackit.com' }));
    expect(member?.id).toBe(SNEHA);
  });

  it('ignores surrounding whitespace in the invite', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [memberRow({ id: SNEHA, email: '  sneha@theblackit.com  ' })],
    });
    const member = await repo(fake).linkAccount(account({ id: 'auth-2', email: 'sneha@theblackit.com' }));
    expect(member?.id).toBe(SNEHA);
  });

  it('returns null when nobody invited this address, and changes nothing', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [memberRow({ id: SNEHA, email: 'sneha@theblackit.com' })],
    });
    const member = await repo(fake).linkAccount(account({ email: 'stranger@elsewhere.com' }));
    expect(member).toBeNull();
    expect((fake.tables.members?.[0] as Record<string, unknown>).user_id).toBeNull();
  });

  it('cannot claim anything without an email', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      members: [memberRow({ email: 'arjun@theblackit.com' })],
    });
    // A private GitHub address comes back null; there is nothing to match on.
    expect(await repo(fake).linkAccount(account({ email: null }))).toBeNull();
  });

  it('returns null on a brand-new deployment, where nobody exists yet', async () => {
    const fake = fakeSupabase({});
    // No workspace row: this account is the first one through the door, and the
    // setup wizard creates and binds the owner row instead.
    expect(await repo(fake).linkAccount(account())).toBeNull();
  });

  it('names the migration to run when the email column is missing', async () => {
    const fake = fakeSupabase({
      workspaces: [{ id: WS }],
      // Rows exist but carry no `email` key at all: PostgREST omits a column
      // that the database does not have.
      members: [{ id: ARJUN, workspace_id: WS, name: 'Arjun Menon', user_id: null }],
    });
    // Reporting "not invited" here would send the person asking an owner for an
    // invitation they already have.
    await expect(repo(fake).linkAccount(account())).rejects.toThrow(/0003_member_identity\.sql/);
  });

  it('surfaces a read failure instead of pretending nobody is invited', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members: [memberRow({ email: 'a@b.com' })] });
    fake.failures.set('members', 'permission denied for table members');
    await expect(repo(fake).linkAccount(account())).rejects.toThrow(/permission denied/);
  });
});

/**
 * The bootstrap for a workspace that existed before sign-in: rows with names,
 * no emails, and nobody bound. Without it every teammate of an existing team is
 * locked out — there is nothing for `linkAccount` to match.
 */
describe('claimMember', () => {
  const UNBOUND = [
    memberRow({ id: ARJUN, name: 'Shithin', email: null, user_id: null }),
    memberRow({ id: SNEHA, name: 'Anu', email: null, user_id: null }),
  ];

  it('binds an unclaimed row by name and writes the account id back', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members: structuredClone(UNBOUND) });
    const member = await repo(fake).claimMember(SNEHA, account({ email: 'anu@theblackit.com' }));

    expect(member?.name).toBe('Anu');
    expect(member?.userId).toBe('auth-1');
    const stored = fake.tables.members?.find((r) => (r as { id: string }).id === SNEHA);
    expect(stored).toMatchObject({ user_id: 'auth-1' });
    // The other row is untouched: claiming is one row, once.
    const other = fake.tables.members?.find((r) => (r as { id: string }).id === ARJUN);
    expect(other).toMatchObject({ user_id: null });
  });

  it('refuses as soon as anybody in the workspace is bound', async () => {
    const members = structuredClone(UNBOUND);
    (members[0] as Record<string, unknown>).user_id = 'someone-else';
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members });

    // The bootstrap window is closed: from here on it is email invitations
    // only, so a name pick can never be an impersonation route.
    expect(await repo(fake).claimMember(SNEHA, account())).toBeNull();
    const untouched = fake.tables.members?.find((r) => (r as { id: string }).id === SNEHA);
    expect(untouched).toMatchObject({ user_id: null });
  });

  it('refuses an id that is not a member of this workspace', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members: structuredClone(UNBOUND) });
    expect(await repo(fake).claimMember(uuidFor('m-nobody'), account())).toBeNull();
  });

  it('does nothing on a deployment with no workspace', async () => {
    const fake = fakeSupabase({});
    expect(await repo(fake).claimMember(ARJUN, account())).toBeNull();
  });

  it('keeps the row unbound when the claim write fails', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members: structuredClone(UNBOUND) });
    fake.failures.set('members', 'permission denied for table members');
    await expect(repo(fake).claimMember(ARJUN, account())).rejects.toThrow(/permission denied/);
  });

  it('only ever updates a row that is still unbound', async () => {
    const fake = fakeSupabase({ workspaces: [{ id: WS }], members: structuredClone(UNBOUND) });
    await repo(fake).claimMember(ARJUN, account());

    // Two people racing: the update is filtered on `user_id is null`, so the
    // loser's write matches nothing and cannot steal a bound row.
    const update = fake.calls.find((c) => c.table === 'members' && c.method === 'update');
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'id', value: ARJUN },
        { op: 'is', column: 'user_id', value: null },
      ]),
    );
  });
});
