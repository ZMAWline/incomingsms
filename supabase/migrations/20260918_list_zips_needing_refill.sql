-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef(). This function was live in PROD but had NO definition
-- anywhere in the repo, so a database rebuild would have silently lost it.
--
-- Called by:
--   src/details-finalizer/index.js:2632 — supabaseRpc 'list_zips_needing_refill'
--
-- What it does: lists ZIP codes whose address pool is exhausted — every stored
-- address for that ZIP has failed carrier address verification and none are
-- left unfailed — so the finalizer knows which ZIPs to go scrape fresh
-- addresses for. Read-only; returns at most p_limit rows (default 5).
--
-- TEST DRIFT: this function does NOT exist at all in the TEST project
-- (lwapudjjlwkskijefxdz) as of 2026-09-18.

CREATE OR REPLACE FUNCTION public.list_zips_needing_refill(p_limit integer DEFAULT 5)
 RETURNS TABLE(state text, zip_code text, address_id text, street_number text, street_name text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT u.state, u.zip_code, u.address_id, u.street_number, u.street_name
  FROM address_pool_usage u
  WHERE u.verify_failed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM address_pool_usage u2
      WHERE u2.zip_code = u.zip_code
        AND u2.verify_failed_at IS NULL
    )
  ORDER BY u.verify_failed_at ASC
  LIMIT p_limit;
$function$;

-- Live PROD ACL: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- i.e. EXECUTE granted to PUBLIC plus the three Supabase roles. Read-only, not
-- SECURITY DEFINER, so it still runs under the caller's RLS.
GRANT EXECUTE ON FUNCTION public.list_zips_needing_refill(integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_zips_needing_refill(integer) TO anon;
GRANT EXECUTE ON FUNCTION public.list_zips_needing_refill(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_zips_needing_refill(integer) TO service_role;
