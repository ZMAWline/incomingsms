-- Offline SIM lifecycle: pause rotation, close the reseller rental, restore on
-- recovery (branch `unassign-offline-sims-from-reseller`).
--
-- Today the only consumer of hosting_port_status_checks is a Slack digest for
-- humans (src/bad-rental-remediator/notify.mjs#notifyOfflineFleetSummary). A
-- Teltik-hosted line can sit offline for days while reseller_sims.active stays
-- true, so the reseller keeps counting our dead line as a broken rental. These
-- columns give the hourly lifecycle tick
-- (src/bad-rental-remediator/offline-lifecycle.mjs) the state it needs to act
-- on that signal exactly once per transition.
--
-- Design notes:
--   * offline_state is a LATCH, not a reading. The current reading lives in
--     hosting_port_status_checks; this column records which transition we have
--     already executed, so a line offline for a week is notified once.
--   * rotation_pause_reason distinguishes "we paused rotation" from "an
--     operator paused rotation". Recovery only un-pauses when the value is
--     'host_offline'; NULL means hands off.
--   * reseller_sims rows are never deleted on unassign. active=false plus
--     deactivated_reason/_at keeps reseller_id around as the restore target.
--
-- Apply to TEST first, then PROD. NOTE: claim_rotation_slot
-- (supabase/migrations/20260918_claim_rotation_slot.sql) does NOT exist in the
-- TEST project; apply it there too or the force-rotate recovery leg cannot be
-- exercised in TEST.

-- ---------------------------------------------------------------------------
-- sims: the offline latch + the rotation-pause provenance
-- ---------------------------------------------------------------------------

ALTER TABLE public.sims
  ADD COLUMN IF NOT EXISTS offline_state text NOT NULL DEFAULT 'online',
  ADD COLUMN IF NOT EXISTS offline_since timestamptz,
  ADD COLUMN IF NOT EXISTS offline_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotation_pause_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sims_offline_state_check'
  ) THEN
    ALTER TABLE public.sims
      ADD CONSTRAINT sims_offline_state_check
      CHECK (offline_state IN ('online', 'offline'));
  END IF;
END $$;

COMMENT ON COLUMN public.sims.offline_state IS
  'Latch for the offline lifecycle: which transition has already been executed. Not a live reading (that is hosting_port_status_checks).';
COMMENT ON COLUMN public.sims.offline_since IS
  'Set when the offline transition executed, cleared on recovery.';
COMMENT ON COLUMN public.sims.offline_notified_at IS
  'When the number.offline (reason=line_offline) webhook was sent for this outage.';
COMMENT ON COLUMN public.sims.rotation_pause_reason IS
  'Why rotation_eligible is false. ''host_offline'' means the lifecycle tick paused it and recovery may resume it; NULL means an operator did, and recovery must not touch it.';

-- Hourly tick candidate scan: every SIM still latched offline.
CREATE INDEX IF NOT EXISTS idx_sims_offline_state
  ON public.sims (offline_state)
  WHERE offline_state = 'offline';

-- ---------------------------------------------------------------------------
-- reseller_sims: survive the unassign so recovery knows where to restore
-- ---------------------------------------------------------------------------

ALTER TABLE public.reseller_sims
  ADD COLUMN IF NOT EXISTS deactivated_reason text,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

COMMENT ON COLUMN public.reseller_sims.deactivated_reason IS
  'Why active was flipped to false. ''host_offline'' rows are the ones the offline lifecycle tick restores on recovery; NULL means an operator unassigned the line.';
COMMENT ON COLUMN public.reseller_sims.deactivated_at IS
  'When active was flipped to false by the offline lifecycle tick.';

CREATE INDEX IF NOT EXISTS idx_reseller_sims_deactivated_reason
  ON public.reseller_sims (sim_id)
  WHERE deactivated_reason IS NOT NULL;

-- ---------------------------------------------------------------------------
-- get_teltik_recovered_lines(): the mirror of get_teltik_currently_offline
-- ---------------------------------------------------------------------------
-- Lines whose LATEST recorded check is 'online' but which are still latched
-- offline, i.e. exactly the recovery-transition candidates. Same DISTINCT ON
-- shape as get_teltik_currently_offline
-- (migrations/20260821_teltik_currently_offline.sql): the state filter lives on
-- the OUTER query, after the per-sim latest row is picked, because filtering
-- inside the DISTINCT ON would find "the most recent ONLINE check" even on a
-- line that has since gone down again.

DROP FUNCTION IF EXISTS get_teltik_recovered_lines();

CREATE OR REPLACE FUNCTION get_teltik_recovered_lines()
RETURNS TABLE (sim_id bigint, iccid text, mdn text, vendor text, last_checked_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT latest.sim_id, latest.iccid, latest.mdn, s.vendor, latest.checked_at
  FROM (
    SELECT DISTINCT ON (c.sim_id) c.sim_id, c.iccid, c.mdn, c.state, c.checked_at
    FROM hosting_port_status_checks c
    WHERE c.sim_id IS NOT NULL
    ORDER BY c.sim_id, c.checked_at DESC
  ) latest
  JOIN sims s ON s.id = latest.sim_id
  WHERE latest.state = 'online'
    AND s.status = 'active'
    AND s.offline_state = 'offline'
$$;

REVOKE ALL ON FUNCTION public.get_teltik_recovered_lines() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teltik_recovered_lines() TO service_role;
