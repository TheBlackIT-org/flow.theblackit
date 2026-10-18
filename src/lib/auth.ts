/**
 * Sign-in.
 *
 * The app talks to `AuthPort`, never to a provider SDK, for the same reason it
 * talks to `WorkspaceRepository` rather than PostgREST: the browser-local
 * build has no accounts at all, and the sign-in screen has to be testable
 * without a network. Two implementations exist:
 *
 *   SupabaseAuth — GitHub OAuth, with an emailed link/code as the fallback for
 *                  anyone without a GitHub account.
 *   NoAuth       — the browser-local workspace. `configured` is false and the
 *                  app keeps the *Acting as* picker it was built around.
 *
 * No passwords are handled here or anywhere else. There is nothing to hash,
 * reset, or leak.
 */

import type { AuthUser } from './types';

/** The slice of an auth error this module reports. Keeps the SDK out of tests. */
export interface AuthErrorLike {
  message: string;
}

export interface AuthSessionLike {
  user: {
    id: string;
    email?: string | null;
    user_metadata?: Record<string, unknown> | null;
    app_metadata?: Record<string, unknown> | null;
  } | null;
}

/**
 * The slice of `supabase.auth` this module uses. `createClient(...)` satisfies
 * it, and so does a three-line stand-in in the tests.
 */
export interface AuthClientLike {
  auth: {
    getSession(): PromiseLike<{ data: { session: AuthSessionLike | null }; error: AuthErrorLike | null }>;
    onAuthStateChange(
      cb: (event: string, session: AuthSessionLike | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
    signInWithOAuth(args: {
      provider: string;
      options?: { redirectTo?: string; scopes?: string };
    }): PromiseLike<{ data: unknown; error: AuthErrorLike | null }>;
    signInWithOtp(args: {
      email: string;
      options?: { emailRedirectTo?: string; shouldCreateUser?: boolean };
    }): PromiseLike<{ data: unknown; error: AuthErrorLike | null }>;
    verifyOtp(args: {
      email: string;
      token: string;
      type: 'email';
    }): PromiseLike<{ data: unknown; error: AuthErrorLike | null }>;
    signOut(): PromiseLike<{ error: AuthErrorLike | null }>;
  };
}

export interface AuthResult {
  ok: boolean;
  /** Shown verbatim on the sign-in screen, so it must be written for a person. */
  message: string;
}

export interface AuthPort {
  /** False in the browser-local workspace: there is no service to sign in to. */
  readonly configured: boolean;
  /** The signed-in account right now, or null. */
  currentUser(): Promise<AuthUser | null>;
  /** Every sign-in, sign-out and token refresh. Returns an unsubscribe fn. */
  onChange(cb: (user: AuthUser | null) => void): () => void;
  signInWithGitHub(): Promise<AuthResult>;
  /** Email a sign-in link (and a code, when the template includes one). */
  sendEmailLink(email: string): Promise<AuthResult>;
  /** Enter the code from that email instead of clicking the link. */
  verifyEmailCode(email: string, code: string): Promise<AuthResult>;
  signOut(): Promise<void>;
}

/* --------------------------------- helpers -------------------------------- */

export function toAuthUser(session: AuthSessionLike | null): AuthUser | null {
  const user = session?.user;
  if (!user?.id) return null;
  const meta = user.user_metadata ?? {};
  const email = typeof user.email === 'string' && user.email ? user.email : null;
  const name =
    firstString([meta['full_name'], meta['name'], meta['user_name'], meta['preferred_username']]) ??
    (email ? email.split('@')[0] : null) ??
    '';
  const avatar =
    firstString([meta['avatar_url'], meta['picture']]) ??
    (typeof user.app_metadata?.['avatar_url'] === 'string' ? String(user.app_metadata['avatar_url']) : null);
  return {
    id: user.id,
    email,
    name: name || email || 'Teammate',
    avatarUrl: avatar,
  };
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Deliberately permissive: the provider is the authority on what is valid. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Rate limits and misconfiguration both arrive as raw provider text. A person
 * staring at a sign-in screen needs to know what to do next, not the status
 * code, so the common cases are translated and anything else is passed through.
 */
export function friendlyAuthError(message: string): string {
  const text = message ?? '';
  if (/rate limit|too many/i.test(text)) {
    return 'Too many sign-in emails just now. Wait a minute, then try again — or use GitHub.';
  }
  if (/provider is not enabled|unsupported provider/i.test(text)) {
    return 'GitHub sign-in is not enabled on this project yet. Turn the provider on in Supabase → Authentication → Providers.';
  }
  if (/not found|no user|signups not allowed/i.test(text)) {
    return 'That address has no account here yet. Ask an owner to invite you, or sign in with GitHub.';
  }
  if (/invalid.*token|token has expired|otp_expired/i.test(text)) {
    return 'That code is not valid any more. Request a fresh one.';
  }
  return text || 'Sign-in failed. Try again.';
}

/* ------------------------------- Supabase --------------------------------- */

/** Where the provider sends the browser back to. Origin alone breaks subpath
 *  deployments, so the current path is kept. */
function redirectTarget(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return `${window.location.origin}${window.location.pathname}`;
}

export class SupabaseAuth implements AuthPort {
  readonly configured = true;
  private readonly client: AuthClientLike;

  constructor(client: AuthClientLike) {
    this.client = client;
  }

  async currentUser(): Promise<AuthUser | null> {
    const { data, error } = await this.client.auth.getSession();
    if (error) return null;
    return toAuthUser(data.session);
  }

  onChange(cb: (user: AuthUser | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      cb(toAuthUser(session));
    });
    return () => data.subscription.unsubscribe();
  }

  async signInWithGitHub(): Promise<AuthResult> {
    // `user:email` matters: without it GitHub reports a private address as
    // null, and the invite it is meant to match cannot be found.
    const { error } = await this.client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: redirectTarget(), scopes: 'read:user user:email' },
    });
    if (error) return { ok: false, message: friendlyAuthError(error.message) };
    // Success means the browser is on its way to GitHub.
    return { ok: true, message: 'Redirecting to GitHub…' };
  }

  async sendEmailLink(email: string): Promise<AuthResult> {
    const address = email.trim();
    if (!looksLikeEmail(address)) return { ok: false, message: 'That does not look like an email address.' };
    const { error } = await this.client.auth.signInWithOtp({
      email: address,
      options: {
        emailRedirectTo: redirectTarget(),
        // Anyone may create an account; the workspace gate is membership, not
        // sign-up. Close sign-ups in the Supabase dashboard once the team is in.
        shouldCreateUser: true,
      },
    });
    if (error) return { ok: false, message: friendlyAuthError(error.message) };
    return { ok: true, message: `Sent. Check ${address} — the link signs you in, or type the code below.` };
  }

  async verifyEmailCode(email: string, code: string): Promise<AuthResult> {
    const address = email.trim();
    const token = code.trim();
    if (!address) return { ok: false, message: 'Enter the email you asked the link for.' };
    if (!/^\d{4,10}$/.test(token)) return { ok: false, message: 'The code is the number in the email.' };
    const { error } = await this.client.auth.verifyOtp({ email: address, token, type: 'email' });
    if (error) return { ok: false, message: friendlyAuthError(error.message) };
    return { ok: true, message: 'Signed in.' };
  }

  async signOut(): Promise<void> {
    try {
      await this.client.auth.signOut();
    } catch {
      // A failed sign-out still ends the local session in practice; the caller
      // clears the cached workspace and reloads either way.
    }
  }
}

/* ------------------------------ local mode -------------------------------- */

/**
 * The browser-local workspace has no accounts. This keeps the interface total
 * so nothing downstream has to ask whether sign-in exists.
 */
export class NoAuth implements AuthPort {
  readonly configured = false;

  async currentUser(): Promise<AuthUser | null> {
    return null;
  }

  onChange(_cb: (user: AuthUser | null) => void): () => void {
    void _cb;
    return () => {};
  }

  async signInWithGitHub(): Promise<AuthResult> {
    return { ok: false, message: 'Sign-in needs a shared database.' };
  }

  async sendEmailLink(_email: string): Promise<AuthResult> {
    void _email;
    return { ok: false, message: 'Sign-in needs a shared database.' };
  }

  async verifyEmailCode(_email: string, _code: string): Promise<AuthResult> {
    void _email;
    void _code;
    return { ok: false, message: 'Sign-in needs a shared database.' };
  }

  async signOut(): Promise<void> {
    /* nothing to end */
  }
}

/** Pick the implementation the deployment actually has. */
export function createAuthPort(client: AuthClientLike | null): AuthPort {
  return client ? new SupabaseAuth(client) : new NoAuth();
}
