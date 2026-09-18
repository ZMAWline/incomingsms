-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef(). Live in PROD, NO definition anywhere in the repo.
-- Found during the same audit that turned up claim_rotation_slot; it was not on
-- the original missing list.
--
-- Called by:
--   src/details-finalizer/index.js:1609 — POST /rest/v1/rpc/attempts_today
--   (referenced in src/shared/rotation-playbook.mjs:24)
--
-- What it does: counts how many times a given remediation action has already
-- been tried on a given SIM today, where "today" is a New York calendar day.
-- The finalizer uses it as a per-day attempt cap so a failing SIM is not retried
-- forever. Read-only.
--
-- TEST DRIFT: this function does NOT exist at all in the TEST project
-- (lwapudjjlwkskijefxdz) as of 2026-09-18.

CREATE OR REPLACE FUNCTION public.attempts_today(p_sim_id bigint, p_action text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT count(*)::int
  FROM remediation_attempts
  WHERE sim_id = p_sim_id
    AND action = p_action
    AND created_at >= (date_trunc('day', (now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York');
$function$;

-- Live PROD ACL: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.attempts_today(bigint, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.attempts_today(bigint, text) TO anon;
GRANT EXECUTE ON FUNCTION public.attempts_today(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attempts_today(bigint, text) TO service_role;
