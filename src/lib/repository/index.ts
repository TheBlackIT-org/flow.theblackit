/**
 * Repository selection.
 *
 * Supabase when the environment provides credentials, browser-local otherwise.
 * The local path is the default so the project runs — and the test suite
 * passes — with no backend at all.
 *
 * The Supabase path builds **one** client and hands it to both the repository
 * and the auth port. See `client.ts` for why that matters.
 */

import { createAuthPort, type AuthPort } from '../auth';
import { createBackendClient, type BackendClient } from './client';
import { LocalRepository } from './local';
import { SupabaseRepository } from './supabase';
import type { WorkspaceRepository } from './types';

export interface RepoEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  /** Seed a sample workspace into an empty shared database. Off by default. */
  SEED_SAMPLE?: string;
  /**
   * Require a signed-in account before the board is shown. Off by default:
   * the failure mode of "forgot the flag" is the current behaviour, whereas the
   * failure mode of a default-on flag is locking the team out of a deployment
   * whose auth provider is not configured yet.
   */
  REQUIRE_LOGIN?: string;
}

/**
 * Read the public Supabase settings.
 *
 * Note the literal `import.meta.env.PUBLIC_*` references: Vite performs a
 * static textual replacement, so a dynamic lookup such as `env[key]` is NOT
 * substituted and silently yields undefined in the built bundle.
 */
export function readEnv(): RepoEnv {
  return {
    SUPABASE_URL: import.meta.env.PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
    SEED_SAMPLE: import.meta.env.PUBLIC_SEED_SAMPLE,
    REQUIRE_LOGIN: import.meta.env.PUBLIC_REQUIRE_LOGIN,
  };
}

/**
 * Whether to fill an empty shared database with sample content.
 *
 * Default **off**: a team's real workspace starts empty and they create their
 * own projects. Set `PUBLIC_SEED_SAMPLE=true` to get the demo content (useful
 * for a fresh environment or a showcase).
 */
export function shouldSeedSample(env: RepoEnv = readEnv()): boolean {
  return String(env.SEED_SAMPLE ?? '').toLowerCase() === 'true';
}

/**
 * Whether a signed-in account is required.
 *
 * Only meaningful with a backend configured: the browser-local workspace has
 * no accounts to sign in with, so the gate is ignored there by construction.
 */
export function shouldRequireLogin(env: RepoEnv = readEnv()): boolean {
  return String(env.REQUIRE_LOGIN ?? '').toLowerCase() === 'true';
}

export function isSupabaseConfigured(env: RepoEnv = readEnv()): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
}

export function createRepository(
  env: RepoEnv = readEnv(),
  client?: BackendClient,
): WorkspaceRepository {
  if (isSupabaseConfigured(env)) {
    return new SupabaseRepository({
      url: env.SUPABASE_URL as string,
      anonKey: env.SUPABASE_ANON_KEY as string,
      ...(client ? { client } : {}),
    });
  }
  return new LocalRepository();
}

/** Everything the app needs to talk to a shared, signed-in backend. */
export interface Backend {
  repository: WorkspaceRepository;
  auth: AuthPort;
  /** True when the board must wait for a session. */
  requireLogin: boolean;
}

/**
 * Build the repository and the auth port over one shared client.
 *
 * Kept together so it is impossible to construct a signed-in deployment whose
 * repository is still communicating as `anon`.
 */
export function createBackend(env: RepoEnv = readEnv()): Backend {
  const configured = isSupabaseConfigured(env);
  const client = configured
    ? createBackendClient({ url: env.SUPABASE_URL as string, anonKey: env.SUPABASE_ANON_KEY as string })
    : null;
  return {
    repository: createRepository(env, client ?? undefined),
    auth: createAuthPort(client),
    requireLogin: configured && shouldRequireLogin(env),
  };
}

export { LocalRepository } from './local';
export { SupabaseRepository, isForeignKeyViolation, isMissingSchemaError } from './supabase';
export { RepositoryHost, newMutationId } from './host';
export { createBackendClient } from './client';
export type { BackendClient } from './client';
export { NoAuth, SupabaseAuth, createAuthPort } from '../auth';
export type { AuthPort, AuthResult } from '../auth';
export { applyChange, sortByServerOrder } from './apply';
export * from './mappers';
export type * from './types';
