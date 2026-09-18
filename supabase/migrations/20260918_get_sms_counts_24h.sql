-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef(). Live in PROD, NO definition anywhere in the repo.
-- Additional missing function found during this audit; not on the original list.
--
-- Called by:
--   src/dashboard/index.js:1188 — callRpc('rpc/get_sms_counts_24h', chunk)
--   (surfaced to operators in src/dashboard/public/index.html:3056)
--
-- What it does: for a batch of SIM ids, returns how many inbound SMS each one
-- received in the last 24 hours and when the most recent one arrived. The
-- dashboard calls it in chunks to fill the "SMS 24h" column. Read-only.
--
-- TEST DRIFT: this is the ONE function in this batch that DOES exist on TEST
-- (lwapudjjlwkskijefxdz). The two copies are functionally identical and have
-- identical ACLs; they differ only in SQL keyword case (PROD stores the body
-- uppercased, TEST lowercased). No action needed.

CREATE OR REPLACE FUNCTION public.get_sms_counts_24h(sim_ids bigint[])
 RETURNS TABLE(sim_id bigint, sms_count bigint, last_received timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT sim_id, COUNT(*) AS sms_count, MAX(received_at) AS last_received
  FROM inbound_sms
  WHERE sim_id = ANY(sim_ids)
    AND received_at >= NOW() - INTERVAL '24 hours'
  GROUP BY sim_id;
$function$;

-- Live PROD ACL: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.get_sms_counts_24h(bigint[]) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sms_counts_24h(bigint[]) TO anon;
GRANT EXECUTE ON FUNCTION public.get_sms_counts_24h(bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sms_counts_24h(bigint[]) TO service_role;
