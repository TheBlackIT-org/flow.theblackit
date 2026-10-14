/**
 * The one Supabase client the app uses.
 *
 * Auth and data share it on purpose. When the repository built its own client,
 * a live session would have lived in a different object from the one making
 * requests, so every query would still go out as `anon`; and Realtime only
 * authenticates a channel through the client that opened it. One client means
 * one session, applied consistently to REST, Realtime and presence.
 *
 * `persistSession` is what makes a sign-in survive a reload. The previous
 * client was deliberately sessionless because there was no sign-in; keeping it
 * that way would have signed everybody out on every refresh.
 */

import { createClient } from '@supabase/supabase-js';
import type { AuthClientLike } from '../auth';
import type { SupabaseLikeClient } from './supabase';

export type BackendClient = SupabaseLikeClient & AuthClientLike;

export interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

export function createBackendClient({ url, anonKey }: SupabaseCredentials): BackendClient {
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Handles the `#access_token=…` fragment an OAuth redirect comes back
      // with, so the sign-in completes without an intermediate page.
      detectSessionInUrl: true,
    },
    realtime: { params: { eventsPerSecond: 20 } },
  }) as unknown as BackendClient;
}
