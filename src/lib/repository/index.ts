/**
 * Repository selection.
 *
 * Supabase when the environment provides credentials, browser-local otherwise.
 * The local path is the default so the project runs — and the test suite
 * passes — with no backend at all.
 */

import { LocalRepository } from './local';
import { SupabaseRepository } from './supabase';
import type { WorkspaceRepository } from './types';

export interface RepoEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  /** Seed a sample workspace into an empty shared database. Off by default. */
  SEED_SAMPLE?: string;
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

export function isSupabaseConfigured(env: RepoEnv = readEnv()): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
}

export function createRepository(env: RepoEnv = readEnv()): WorkspaceRepository {
  if (isSupabaseConfigured(env)) {
    return new SupabaseRepository({
      url: env.SUPABASE_URL as string,
      anonKey: env.SUPABASE_ANON_KEY as string,
    });
  }
  return new LocalRepository();
}

export { LocalRepository } from './local';
export { SupabaseRepository } from './supabase';
export { RepositoryHost, newMutationId } from './host';
export { applyChange, sortByServerOrder } from './apply';
export * from './mappers';
export type * from './types';
