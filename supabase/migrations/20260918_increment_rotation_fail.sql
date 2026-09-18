-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef().
--
-- UNLIKE the other files added on 2026-09-18, this function DOES already have a
-- repo definition: migrations/20260531_rotation_fail_cap_5.sql. That file's body
-- matches PROD exactly. It has drifted in one way only: the live PROD copy has
-- `SET search_path TO 'public','extensions','pg_temp'` and the repo file does
-- not, so replaying the 20260531 file against PROD would silently drop the
-- pinned search_path. This file supersedes it and records PROD as it actually is.
--
-- Called by:
--   src/teltik-worker/index.js:994  — supabaseRpc 'increment_rotation_fail'
--   src/mdn-rotator/index.js:4625   — POST /rest/v1/rpc/increment_rotation_fail
--
-- What it does: records one rotation failure for a SIM. The count resets to 1 on
-- the first failure of a new day (the caller passes the New York day boundary as
-- p_today_start) and otherwise increments. At 5 failures the SIM's status flips
-- to 'rotation_failed', which drops it out of the auto-rotation batch until a
-- human force-rotates it successfully.
--
-- NOTE for reviewers: the 5-strike flip is a second UPDATE in the same
-- transaction as the increment. That is why the pre-2026-04-24 version of this
-- function silently never capped anything — the status value it wrote was not in
-- the sims_status_check CHECK constraint, so the whole transaction rolled back
-- including the increment. scripts/check_db_constraints.mjs exists to catch that
-- class of bug; 'rotation_failed' is in its allowlist.
--
-- TEST DRIFT: this function does NOT exist at all in the TEST project
-- (lwapudjjlwkskijefxdz) as of 2026-09-18.

CREATE OR REPLACE FUNCTION public.increment_rotation_fail(p_sim_id bigint, p_error text, p_today_start timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_new_count integer;
BEGIN
  UPDATE sims
  SET
    rotation_fail_count = CASE
      WHEN last_rotation_at IS NULL OR last_rotation_at < p_today_start THEN 1
      ELSE rotation_fail_count + 1
    END,
    rotation_status = 'failed',
    last_rotation_error = p_error,
    last_rotation_at = now()
  WHERE id = p_sim_id
  RETURNING rotation_fail_count INTO v_new_count;

  IF v_new_count >= 5 THEN
    UPDATE sims SET status = 'rotation_failed' WHERE id = p_sim_id;
  END IF;

  RETURN v_new_count;
END;
$function$;

-- Live PROD ACL: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.increment_rotation_fail(bigint, text, timestamp with time zone) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_rotation_fail(bigint, text, timestamp with time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.increment_rotation_fail(bigint, text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_rotation_fail(bigint, text, timestamp with time zone) TO service_role;
