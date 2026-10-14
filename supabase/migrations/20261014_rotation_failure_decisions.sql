-- =========================================================
-- Rotation failures: operator decisions, applied automatically.
--
-- Triage 2026-10-13 of the SIMs left in the inbox found four recurring
-- failure patterns. The operator decided what each one means (2026-10-14),
-- and this job applies that decision every time the pattern shows up again,
-- instead of leaving the SIM parked until someone reads the inbox.
--
--   RETRY  — status='rotation_failed' with a carrier-side error that has
--            been seen to clear on a later day:
--              * ATOMIC swapMSISDN "A Resource Required By Service Is Not
--                Available"
--              * Teltik change-number body status=FAILED
--              * Teltik change-number HTTP 502
--            The SIM goes back to status='active', rotation_status='ready',
--            rotation_fail_count=0, so mdn-rotator / teltik-worker pick it
--            up on their next run. At most once per NY day (only when the
--            last attempt was before NY midnight), so the existing
--            5-attempts-per-day cap still bounds carrier calls.
--   CANCEL — status in ('rotation_failed','error') and ATOMIC says the line
--            is gone or is not ours:
--              * attStatus=Cancelled / status not Active (got "Cancelled")
--              * "sim does not belong to this MVNO" / "... to this vendor"
--            The SIM is set to 'canceled' with the same cleanup as the
--            dashboard's deactivateSimAssignments(): close the current
--            number and end the reseller assignment. Skipped when the SIM
--            received an SMS in the last 7 days — a line that still receives
--            messages is not cancelled, whatever an old error string says.
--
-- "MDN unchanged within 30m" (SIM still active) is deliberately NOT here:
-- the operator chose to let the next normal rotation retry it.
--
-- sims.status_reason records which rule acted; trg_sim_status_change writes
-- sim_status_history for every status change.
-- =========================================================

CREATE OR REPLACE FUNCTION public.apply_rotation_failure_decisions()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ny_midnight timestamptz :=
    date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York';
  v_retried integer;
  v_canceled integer;
BEGIN
  UPDATE public.sims
  SET status = 'active',
      rotation_status = 'ready',
      rotation_fail_count = 0,
      status_reason = 'auto-retry: carrier-side rotation failure (operator decision 2026-10-14)'
  WHERE status = 'rotation_failed'
    AND (last_rotation_at IS NULL OR last_rotation_at < v_ny_midnight)
    AND (
      (vendor = 'atomic' AND last_rotation_error ILIKE '%Resource Required By Service Is Not Available%')
      OR (vendor = 'teltik' AND last_rotation_error ILIKE '%change-number body status=FAILED%')
      OR (vendor = 'teltik' AND last_rotation_error ILIKE '%change-number failed 502%')
    );
  GET DIAGNOSTICS v_retried = ROW_COUNT;

  WITH dead AS (
    UPDATE public.sims s
    SET status = 'canceled',
        status_reason = 'auto-cancel: ATOMIC reports line cancelled or not ours (operator decision 2026-10-14)'
    WHERE s.status IN ('rotation_failed', 'error')
      AND s.vendor = 'atomic'
      AND (
        s.last_rotation_error ILIKE '%attStatus=Cancelled%'
        OR s.last_rotation_error ILIKE '%status not Active (got "Cancelled")%'
        OR s.last_rotation_error ILIKE '%does not belong to this MVNO%'
        OR s.last_rotation_error ILIKE '%does not belong to this vendor%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.inbound_sms i
        WHERE i.sim_id = s.id AND i.received_at > now() - interval '7 days')
    RETURNING s.id
  ),
  numbers AS (
    UPDATE public.sim_numbers n SET valid_to = now()
    FROM dead WHERE n.sim_id = dead.id AND n.valid_to IS NULL
  ),
  assignments AS (
    UPDATE public.reseller_sims r SET active = false
    FROM dead WHERE r.sim_id = dead.id AND r.active
  )
  SELECT count(*) INTO v_canceled FROM dead;

  RETURN jsonb_build_object('retried', v_retried, 'canceled', v_canceled);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_rotation_failure_decisions() FROM PUBLIC, anon, authenticated;

-- Every 15 minutes, just before dismiss-stale-review-items (7-59/15), so the
-- inbox items for SIMs canceled here close in the same cycle.
SELECT cron.schedule(
  'apply-rotation-failure-decisions',
  '4-59/15 * * * *',
  $job$SELECT public.apply_rotation_failure_decisions();$job$
);
