-- Lock the public `anon` and `authenticated` roles out of the database.
--
-- What this does, in plain language:
--   Supabase gives every project a public "anon" key. Anyone who has it talks
--   to the database as the `anon` role (or `authenticated`, if they sign in
--   through Supabase Auth, which this project does not use). Until now both
--   roles held grants on every table in `public`. On PROD a 2026-09-08
--   migration (`anon_readonly_all_except_credential_tables`) added a
--   read-everything policy for anon on 60+ tables, including inbound SMS
--   bodies, carrier API logs and dashboard session rows. On TEST anon could
--   read AND write sims, gateways, resellers and more.
--
--   This migration:
--     1. Drops every row-level-security (RLS) policy that targets anon,
--        authenticated or PUBLIC.
--     2. Revokes every privilege anon and authenticated hold on tables,
--        views, sequences and functions in `public`, and revokes EXECUTE on
--        functions from PUBLIC (Postgres grants that to everyone by default).
--     3. Changes the default privileges so tables, sequences and functions
--        created later are no longer auto-granted to anon/authenticated.
--     4. Turns RLS on for every table in `public`. With no policies, RLS
--        denies every row to any role that does not bypass it.
--   Nothing is granted back: no code in this repo uses the anon key (every
--   Worker, script and portal uses SUPABASE_SERVICE_ROLE_KEY server-side, and
--   no browser page talks to Supabase directly).
--
-- Why the Workers are unaffected:
--   Every Worker authenticates as `service_role`. That role has the BYPASSRLS
--   attribute, so RLS never filters its queries, and this migration re-grants
--   it full table, sequence and function access explicitly. The `postgres`
--   role (owner of every table and SECURITY DEFINER function, and the role
--   pg_cron runs as) also has BYPASSRLS, so FORCE ROW LEVEL SECURITY would
--   change nothing and is not used.
--
-- Safe to re-run: every step is a REVOKE/GRANT/ENABLE or a DROP POLICY on
-- whatever policies still exist, so a second run is a no-op.
--
-- Rollback (not auto-applied): 20260922_lock_down_anon_ROLLBACK.sql.txt

-- 1. Drop every policy that grants rows to anon, authenticated or PUBLIC.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- 2. Revoke everything the public roles hold on existing objects.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, PUBLIC;

-- The backend role keeps full access (it already had it; this makes it explicit
-- now that PUBLIC no longer carries EXECUTE on functions).
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 3. Stop future objects from being auto-granted to the public roles.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, PUBLIC;

-- Objects created by supabase_admin (Supabase platform tooling) carry the same
-- defaults. Only a member of supabase_admin may change them, so skip with a
-- notice if the migration role is not.
DO $$
BEGIN
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, PUBLIC;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipped supabase_admin default privileges: %', SQLERRM;
END $$;

-- 4. RLS on for every table, including partitioned ones. No policies are
-- created, so non-bypass roles see zero rows even if a grant slips back in.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
