/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Public by design; ships in the client bundle. */
  readonly PUBLIC_SUPABASE_URL?: string;
  /** Supabase anon key. Public by design; safety comes from RLS policies. */
  readonly PUBLIC_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
