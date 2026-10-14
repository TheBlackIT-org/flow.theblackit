/**
 * Sign-in tests.
 *
 * The auth port exists so the sign-in screen can be driven without a provider:
 * these run against a three-line stand-in for `supabase.auth`, and assert the
 * two things that are invisible in the UI — *which* call is made with which
 * options, and what a provider error turns into on screen.
 */
import { describe, expect, it } from 'vitest';
import {
  NoAuth,
  SupabaseAuth,
  createAuthPort,
  friendlyAuthError,
  looksLikeEmail,
  toAuthUser,
  type AuthClientLike,
  type AuthErrorLike,
  type AuthSessionLike,
} from '../src/lib/auth';

/* --------------------------------- harness -------------------------------- */

interface RecordingAuth {
  client: AuthClientLike;
  /** Session the fake currently holds. */
  session: AuthSessionLike | null;
  oauthCalls: Array<{ provider: string; options?: { redirectTo?: string; scopes?: string } }>;
  otpCalls: Array<{ email: string; options?: { emailRedirectTo?: string; shouldCreateUser?: boolean } }>;
  verifyCalls: Array<{ email: string; token: string; type: string }>;
  signOuts: number;
  /** Errors the next call should return. */
  failures: { oauth?: AuthErrorLike; otp?: AuthErrorLike; verify?: AuthErrorLike };
  /** Deliver an auth event as the provider would. */
  emit(event: string, session: AuthSessionLike | null): void;
  listeners(): number;
}

function recordingAuth(session: AuthSessionLike | null = null): RecordingAuth {
  const state: RecordingAuth = {
    session,
    oauthCalls: [],
    otpCalls: [],
    verifyCalls: [],
    signOuts: 0,
    failures: {},
    emit(event, next) {
      state.session = next;
      for (const cb of [...subs]) cb(event, next);
    },
    listeners: () => subs.length,
    client: null as unknown as AuthClientLike,
  };
  const subs: Array<(event: string, session: AuthSessionLike | null) => void> = [];

  state.client = {
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange(cb) {
        subs.push(cb);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                const i = subs.indexOf(cb);
                if (i >= 0) subs.splice(i, 1);
              },
            },
          },
        };
      },
      signInWithOAuth: async (args) => {
        state.oauthCalls.push(args);
        return { data: {}, error: state.failures.oauth ?? null };
      },
      signInWithOtp: async (args) => {
        state.otpCalls.push(args);
        return { data: {}, error: state.failures.otp ?? null };
      },
      verifyOtp: async (args) => {
        state.verifyCalls.push(args);
        if (!state.failures.verify) state.session = { user: { id: 'u-verified', email: args.email } };
        return { data: {}, error: state.failures.verify ?? null };
      },
      signOut: async () => {
        state.signOuts += 1;
        state.session = null;
        return { error: null };
      },
    },
  };
  return state;
}

const GITHUB_SESSION: AuthSessionLike = {
  user: {
    id: 'u-1',
    email: 'arjun@theblackit.com',
    user_metadata: { full_name: 'Arjun Menon', avatar_url: 'https://avatars.example/a.png' },
  },
};

/* --------------------------------- mapping -------------------------------- */

describe('mapping a session to an account', () => {
  it('reads the name and face the provider supplied', () => {
    expect(toAuthUser(GITHUB_SESSION)).toEqual({
      id: 'u-1',
      email: 'arjun@theblackit.com',
      name: 'Arjun Menon',
      avatarUrl: 'https://avatars.example/a.png',
    });
  });

  it('falls back to the local part of the email when no name is set', () => {
    const user = toAuthUser({ user: { id: 'u-2', email: 'sneha@theblackit.com', user_metadata: {} } });
    expect(user?.name).toBe('sneha');
  });

  it('prefers a real name over the email', () => {
    const user = toAuthUser({
      user: { id: 'u-3', email: 'x@y.com', user_metadata: { user_name: 'nithin' } },
    });
    expect(user?.name).toBe('nithin');
  });

  it('returns null when there is no session', () => {
    expect(toAuthUser(null)).toBeNull();
    expect(toAuthUser({ user: null })).toBeNull();
  });

  it('tolerates a missing email, which a private GitHub address produces', () => {
    const user = toAuthUser({ user: { id: 'u-4', user_metadata: { name: 'Meera' } } });
    expect(user).toEqual({ id: 'u-4', email: null, name: 'Meera', avatarUrl: null });
  });
});

/* ------------------------------- the provider ----------------------------- */

describe('SupabaseAuth', () => {
  it('reports no account before anybody signs in', async () => {
    const fake = recordingAuth();
    expect(await new SupabaseAuth(fake.client).currentUser()).toBeNull();
  });

  it('reports the signed-in account', async () => {
    const fake = recordingAuth(GITHUB_SESSION);
    expect((await new SupabaseAuth(fake.client).currentUser())?.email).toBe('arjun@theblackit.com');
  });

  it('asks GitHub for the email scope, without which a private address is null', async () => {
    const fake = recordingAuth();
    const result = await new SupabaseAuth(fake.client).signInWithGitHub();
    expect(result.ok).toBe(true);
    expect(fake.oauthCalls).toHaveLength(1);
    expect(fake.oauthCalls[0]?.provider).toBe('github');
    expect(fake.oauthCalls[0]?.options?.scopes).toContain('user:email');
  });

  it('surfaces an unconfigured provider as something a person can act on', async () => {
    const fake = recordingAuth();
    fake.failures.oauth = { message: 'Provider is not enabled' };
    const result = await new SupabaseAuth(fake.client).signInWithGitHub();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Supabase');
  });

  it('refuses to send a link to something that is not an address', async () => {
    const fake = recordingAuth();
    const result = await new SupabaseAuth(fake.client).sendEmailLink('not-an-email');
    expect(result.ok).toBe(false);
    // Nothing was sent: the provider is never asked to guess.
    expect(fake.otpCalls).toHaveLength(0);
  });

  it('trims the address and lets anyone create an account', async () => {
    const fake = recordingAuth();
    const result = await new SupabaseAuth(fake.client).sendEmailLink('  sneha@theblackit.com ');
    expect(result.ok).toBe(true);
    expect(fake.otpCalls[0]?.email).toBe('sneha@theblackit.com');
    // Membership, not sign-up, is the gate — the "not invited" screen.
    expect(fake.otpCalls[0]?.options?.shouldCreateUser).toBe(true);
  });

  it('passes a rate limit through as advice rather than a status code', async () => {
    const fake = recordingAuth();
    fake.failures.otp = { message: 'Email rate limit exceeded' };
    const result = await new SupabaseAuth(fake.client).sendEmailLink('a@b.com');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/wait a minute/i);
  });

  it('rejects a code that is not a number without calling the provider', async () => {
    const fake = recordingAuth();
    const result = await new SupabaseAuth(fake.client).verifyEmailCode('a@b.com', 'abc');
    expect(result.ok).toBe(false);
    expect(fake.verifyCalls).toHaveLength(0);
  });

  it('verifies a numeric code and ends up signed in', async () => {
    const fake = recordingAuth();
    const auth = new SupabaseAuth(fake.client);
    const result = await auth.verifyEmailCode('a@b.com', '123456');
    expect(result.ok).toBe(true);
    expect(fake.verifyCalls[0]).toEqual({ email: 'a@b.com', token: '123456', type: 'email' });
    expect((await auth.currentUser())?.id).toBe('u-verified');
  });

  it('says so when a code has expired instead of repeating the raw error', async () => {
    const fake = recordingAuth();
    fake.failures.verify = { message: 'Token has expired or is invalid' };
    const result = await new SupabaseAuth(fake.client).verifyEmailCode('a@b.com', '000000');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not valid any more/i);
  });

  it('delivers sign-in and sign-out to a listener', async () => {
    const fake = recordingAuth();
    const auth = new SupabaseAuth(fake.client);
    const seen: Array<string | null> = [];
    const off = auth.onChange((user) => seen.push(user?.id ?? null));

    fake.emit('SIGNED_IN', GITHUB_SESSION);
    fake.emit('SIGNED_OUT', null);
    expect(seen).toEqual(['u-1', null]);

    off();
    expect(fake.listeners()).toBe(0);
    fake.emit('SIGNED_IN', GITHUB_SESSION);
    expect(seen).toHaveLength(2);
  });

  it('ends the session on sign-out', async () => {
    const fake = recordingAuth(GITHUB_SESSION);
    const auth = new SupabaseAuth(fake.client);
    await auth.signOut();
    expect(fake.signOuts).toBe(1);
    expect(await auth.currentUser()).toBeNull();
  });
});

/* --------------------------------- helpers -------------------------------- */

describe('error translation', () => {
  it('keeps an unrecognised message rather than swallowing it', () => {
    expect(friendlyAuthError('Something specific went wrong')).toBe('Something specific went wrong');
  });

  it('has something to say even with an empty message', () => {
    expect(friendlyAuthError('')).toMatch(/try again/i);
  });

  it('recognises the shapes people actually hit', () => {
    expect(friendlyAuthError('Email rate limit exceeded')).toMatch(/wait a minute/i);
    expect(friendlyAuthError('Provider is not enabled')).toMatch(/GitHub sign-in is not enabled/i);
    expect(friendlyAuthError('Signups not allowed for otp')).toMatch(/invite/i);
  });
});

describe('email shape', () => {
  it('accepts ordinary addresses', () => {
    expect(looksLikeEmail('a.b+c@theblackit.com')).toBe(true);
  });

  it('rejects the near misses', () => {
    for (const bad of ['', 'nope', 'a@b', '@b.com', 'a b@c.com']) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });
});

/* ------------------------------- local mode -------------------------------- */

describe('NoAuth', () => {
  it('is what the browser-local workspace gets', () => {
    const auth = createAuthPort(null);
    expect(auth).toBeInstanceOf(NoAuth);
    expect(auth.configured).toBe(false);
  });

  it('never claims an account', async () => {
    const auth = new NoAuth();
    expect(await auth.currentUser()).toBeNull();
    expect((await auth.signInWithGitHub()).ok).toBe(false);
    expect((await auth.sendEmailLink('a@b.com')).ok).toBe(false);
    expect((await auth.verifyEmailCode('a@b.com', '123456')).ok).toBe(false);
    // Must not throw: the app calls this on every sign-out path.
    await expect(auth.signOut()).resolves.toBeUndefined();
  });

  it('has nothing to unsubscribe from', () => {
    const auth = new NoAuth();
    const off = auth.onChange(() => {});
    expect(() => off()).not.toThrow();
  });
});
