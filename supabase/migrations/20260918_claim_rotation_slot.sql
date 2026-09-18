-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef(). This function was live in PROD but had NO definition
-- anywhere in the repo, so a database rebuild would have silently lost it.
--
-- Called by:
--   src/mdn-rotator/index.js:1514 (and :1759, :2028) — supabaseRpc 'claim_rotation_slot'
--   src/teltik-worker/index.js:888                   — supabaseRpc 'claim_rotation_slot'
--
-- What it does: the atomic "may this SIM rotate right now?" gate. It performs a
-- single conditional UPDATE and returns true only if it claimed the slot, so two
-- workers racing on the same SIM cannot both rotate it. It also stamps
-- last_mdn_rotated_at / rotation_status='rotating' / rotation_source as part of
-- the same statement — the claim and the cadence stamp are inseparable.
--
-- NOTE for reviewers: the concurrency safety here is row-level UPDATE locking,
-- not an advisory lock and not SELECT ... FOR UPDATE. Two concurrent calls both
-- reach the UPDATE; the second blocks on the row lock, then re-evaluates the
-- WHERE clause against the first transaction's committed row and matches zero
-- rows, returning false. That is correct, but it depends on the eligibility
-- predicate living in the WHERE clause. Moving any of it into a prior SELECT
-- would reintroduce the double-rotation race.
--
-- TEST DRIFT: this function does NOT exist at all in the TEST project
-- (lwapudjjlwkskijefxdz) as of 2026-09-18. Applying it there is a separate,
-- deliberate decision — this file only records PROD truth.

CREATE OR REPLACE FUNCTION public.claim_rotation_slot(p_sim_id bigint, p_force boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_updated int;
  v_now     timestamptz := NOW();
  v_ny_today timestamptz :=
    (date_trunc('day', v_now AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York';
BEGIN
  UPDATE public.sims s
  SET
    last_mdn_rotated_at = v_now,
    rotation_status     = 'rotating',
    rotation_source     = CASE WHEN p_force THEN 'manual' ELSE 'auto' END
  WHERE s.id = p_sim_id
    AND (
      p_force
      OR (
        -- operator opt-out applies only to scheduled (auto) rotations
        s.rotation_eligible = true
        AND (s.activated_at IS NULL OR s.activated_at < v_ny_today)
        AND (
          -- daily vendors: at most once per NY calendar day
          (COALESCE(s.rotation_interval_hours, 24) <= 24
            AND (s.last_mdn_rotated_at IS NULL OR s.last_mdn_rotated_at < v_ny_today))
          OR
          -- multi-day vendors (teltik = 48h): rolling interval window
          (COALESCE(s.rotation_interval_hours, 24) > 24
            AND (s.last_mdn_rotated_at IS NULL
                 OR s.last_mdn_rotated_at
                    < v_now - (s.rotation_interval_hours::text || ' hours')::interval))
        )
      )
    );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$function$;

-- Live PROD ACL: {postgres=X/postgres,service_role=X/postgres}
-- i.e. PUBLIC / anon / authenticated have NO execute. Workers call it with the
-- service_role key. Keep it that way: it is SECURITY DEFINER and it mutates sims.
REVOKE ALL ON FUNCTION public.claim_rotation_slot(bigint, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_rotation_slot(bigint, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.claim_rotation_slot(bigint, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_rotation_slot(bigint, boolean) TO service_role;
