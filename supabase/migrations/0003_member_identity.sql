-- =====================================================================
-- BlackIT Flow — member identity (sign-in)
--
-- Ties a Supabase auth account to a `members` row so the *Acting as* picker
-- can be replaced by a real signed-in identity.
--
-- `members.user_id` has existed since `0001_init.sql` (reserved for exactly
-- this). This migration adds the email an invite is addressed to, so a
-- teammate can be added before they have ever signed in: the first time an
-- account with that email signs in, it claims the row.
--
-- ---------------------------------------------------------------------
-- APPLY THIS BEFORE DEPLOYING THE CLIENT THAT REQUIRES LOGIN.
--
-- It is purely additive: the currently-deployed app never reads `email`, and
-- adding a nullable column cannot break a write that does not mention it. The
-- new client, however, sends `email` on every member write, and PostgREST
-- rejects a whole upsert when a column is unknown — the same failure that
-- `0002_add_mutation_ids.sql` exists to fix. Additive first, then deploy.
-- ---------------------------------------------------------------------
--
-- Safe to run more than once. Run it in the Supabase SQL Editor, or with:
--   supabase db push
-- =====================================================================

alter table members add column if not exists email text;

-- One account may own at most one member row across the whole deployment.
-- Partial, so the many members with no account yet (user_id is null) do not
-- collide with each other.
create unique index if not exists members_user_id_key
  on members (user_id)
  where user_id is not null;

-- One invite per email address per workspace. Case-insensitive, because
-- GitHub hands back whatever capitalisation the person used when they signed
-- up, and `Sneha@x.com` must claim the row invited as `sneha@x.com`.
create unique index if not exists members_workspace_email_key
  on members (workspace_id, lower(email))
  where email is not null;

-- Confirm the column and indexes now exist:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'members' order by column_name;
--   select indexname from pg_indexes
--    where schemaname = 'public' and tablename = 'members' order by indexname;
-- Expected: an `email` column, plus members_user_id_key and
--           members_workspace_email_key.
