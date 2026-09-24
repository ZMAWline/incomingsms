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
-- get_recent_hosting_port_checks(): newest N checks per SIM, one row per SIM
-- ---------------------------------------------------------------------------
-- The lifecycle decides on the newest few checks of every candidate. A plain
-- PostgREST read ordered by (sim_id, checked_at desc) returns each SIM's full
-- history, so the first SIMs use up the row limit (1000 by default) and the
-- rest are never decided. This caps the history per SIM in the database and
-- folds it into one row per SIM, so a batch of 500 SIMs is at most 500 rows.
--
-- p_since bounds how far back the history goes. The caller passes a window
-- wider than the 6h freshness rule, because only the NEWEST check has to be
-- recent; the check before it may come from the previous probe cycle.

CREATE INDEX IF NOT EXISTS idx_hosting_port_status_checks_sim_checked_at
  ON public.hosting_port_status_checks (sim_id, checked_at DESC);

DROP FUNCTION IF EXISTS get_recent_hosting_port_checks(bigint[], integer, timestamptz);

CREATE OR REPLACE FUNCTION get_recent_hosting_port_checks(
  p_sim_ids bigint[], p_per_sim integer, p_since timestamptz
)
RETURNS TABLE (sim_id bigint, checks jsonb)
LANGUAGE sql STABLE AS $$
  SELECT ranked.sim_id,
         jsonb_agg(jsonb_build_object('state', ranked.state, 'checked_at', ranked.checked_at)
                   ORDER BY ranked.checked_at DESC)
  FROM (
    SELECT c.sim_id, c.state, c.checked_at,
           row_number() OVER (PARTITION BY c.sim_id ORDER BY c.checked_at DESC) AS rn
    FROM hosting_port_status_checks c
    WHERE c.sim_id = ANY (p_sim_ids)
      AND c.checked_at >= p_since
  ) ranked
  WHERE ranked.rn <= p_per_sim
  GROUP BY ranked.sim_id
$$;

REVOKE ALL ON FUNCTION public.get_recent_hosting_port_checks(bigint[], integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_recent_hosting_port_checks(bigint[], integer, timestamptz) TO service_role;
