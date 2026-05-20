-- claim_rotation_retry_slot: in-window retry path for Teltik rotations that
-- failed today. Sibling of claim_rotation_slot (does NOT modify the main RPC).
--
-- The main claim_rotation_slot enforces a 48h rolling gate via last_mdn_rotated_at,
-- which is correct for the normal cadence but means a failed attempt locks the SIM
-- out for the rest of the night (and another 48h). This retry RPC accepts a SIM if:
--   - vendor = 'teltik'
--   - status IN ('active', 'provisioning')  (stuck mid-rotation is eligible too)
--   - rotation_status = 'failed'  (must have been marked failed by the worker or
--                                  the stuck-state sweeper)
--   - rotation_eligible = true
--   - last_mdn_rotated_at >= today's NY midnight  (failed during current NY day,
--                                                  protects against Teltik's own
--                                                  48h server-side cooldown)
--   - last_mdn_rotated_at < NOW() - INTERVAL '15 minutes'  (short per-attempt backoff)
--
-- On success: stamps last_mdn_rotated_at=NOW(), rotation_status='rotating',
-- rotation_source='auto'. Returns true. The caller then issues Teltik change-number
-- and follows the normal mdn_pending → finalizer flow.
--
-- Revertible: DROP FUNCTION claim_rotation_retry_slot(bigint);

CREATE OR REPLACE FUNCTION claim_rotation_retry_slot(p_sim_id bigint)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated int;
  v_today_ny_start timestamptz;
BEGIN
  -- Start of today's NY calendar date, as a UTC timestamptz.
  v_today_ny_start := date_trunc('day', (NOW() AT TIME ZONE 'America/New_York'))
                      AT TIME ZONE 'America/New_York';

  UPDATE sims
  SET last_mdn_rotated_at = NOW(),
      rotation_status = 'rotating',
      rotation_source = 'auto'
  WHERE id = p_sim_id
    AND vendor = 'teltik'
    AND status IN ('active', 'provisioning')
    AND rotation_status = 'failed'
    AND rotation_eligible = true
    AND last_mdn_rotated_at IS NOT NULL
    AND last_mdn_rotated_at >= v_today_ny_start
    AND last_mdn_rotated_at < NOW() - INTERVAL '15 minutes';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_rotation_retry_slot(bigint) TO service_role;
