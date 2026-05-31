-- INC: raise the rotation-failure cap from 3 to 5.
--
-- increment_rotation_fail() is called by mdn-rotator (and, as of this change,
-- teltik-worker) on every rotation failure. It increments rotation_fail_count
-- (reset to 1 on the first failure of the NY day) and flips sims.status to
-- 'rotation_failed' once the count reaches the cap — which drops the SIM out of
-- the status=active rotation batch and the in-window retry queries, so no
-- further auto attempts occur until a manual force-rotate succeeds.
--
-- Only change vs the prior version: threshold 3 -> 5 (more retry headroom before
-- a SIM is parked for manual review). Fails 1-4 keep status='active' so the next
-- cron tick retries (the per-vendor wrappers / claim_rotation_retry_slot restore
-- eligibility). Apply with: supabase MCP apply_migration or the Management API.
--
-- ROLLBACK: re-run this file with `>= 5` changed back to `>= 3`.

create or replace function increment_rotation_fail(p_sim_id bigint, p_error text, p_today_start timestamptz)
returns integer
language plpgsql
as $$
DECLARE
  v_new_count integer;
BEGIN
  -- Atomic increment (reset to 1 if this is the first failure of the day)
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

  -- Mark rotation_failed once the cap is reached (was 3, now 5)
  IF v_new_count >= 5 THEN
    UPDATE sims SET status = 'rotation_failed' WHERE id = p_sim_id;
  END IF;

  RETURN v_new_count;
END;
$$;
