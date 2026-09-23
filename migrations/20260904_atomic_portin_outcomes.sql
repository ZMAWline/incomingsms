-- Migration: persist ATOMIC port-in outcome details
-- Permanent port-in failures are terminal until an operator corrects and resubmits.

ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_reason_code TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_reason_description TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_submitted_at TIMESTAMPTZ;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_status_check_at TIMESTAMPTZ;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_status_attempted_at TIMESTAMPTZ;

-- One row per ATOMIC port-in result, so the reason a port failed survives the
-- next poll overwriting the sims columns above. Written by details-finalizer
-- (portinStatus completed / terminal failure / 14-day max age) and
-- bulk-activator (portinRequest rejected by the carrier). sim_id is nullable
-- because a rejected portinRequest can happen before any sims row exists.
-- raw_response is scrubbed of pin / password / accountNumber before insert.
CREATE TABLE IF NOT EXISTS atomic_portin_outcomes (
  id BIGSERIAL PRIMARY KEY,
  sim_id BIGINT REFERENCES sims(id) ON DELETE CASCADE,
  iccid TEXT NOT NULL,
  msisdn TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'abandoned')),
  source TEXT NOT NULL CHECK (source IN ('portin_status', 'max_age', 'portin_request', 'backfill')),
  carrier_code TEXT,
  carrier_reason_code TEXT,
  carrier_description TEXT,
  raw_response JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atomic_portin_outcomes_sim_recorded
  ON atomic_portin_outcomes (sim_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_atomic_portin_outcomes_iccid_recorded
  ON atomic_portin_outcomes (iccid, recorded_at DESC);
-- The backfill writes at most one row per SIM; re-running it is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_atomic_portin_outcomes_backfill
  ON atomic_portin_outcomes (sim_id) WHERE source = 'backfill';

-- Same access model as every other public table: service_role only.
ALTER TABLE atomic_portin_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON atomic_portin_outcomes FROM anon, authenticated;
REVOKE ALL ON SEQUENCE atomic_portin_outcomes_id_seq FROM anon, authenticated;

-- Backfill: one row per SIM whose sims columns already hold a final result.
--   failed    portinStatus 948 / 910 / 951
--   abandoned stopped by the 14-day max age
--   completed portinStatus 00, no longer pending, SIM active
-- carrier_description is the human reason: the statusReasonDescription a 951
-- embeds, else the carrier text without its "Error!!" prefix.
INSERT INTO atomic_portin_outcomes
  (sim_id, iccid, msisdn, outcome, source, carrier_code, carrier_reason_code, carrier_description, raw_response, recorded_at)
SELECT
  s.id,
  s.iccid,
  s.msisdn,
  CASE
    WHEN s.atomic_portin_status_code IN ('948', '910', '951') THEN 'failed'
    WHEN s.status_reason = 'atomic_portin_max_age' THEN 'abandoned'
    ELSE 'completed'
  END,
  'backfill',
  s.atomic_portin_status_code,
  s.atomic_portin_reason_code,
  NULLIF(btrim(COALESCE(
    substring(s.atomic_portin_description FROM 'statusReasonDescription\s*-\s*([^~]+)'),
    regexp_replace(COALESCE(s.atomic_portin_description, s.atomic_portin_reason_description, ''), '^Error!!', '')
  )), ''),
  jsonb_build_object(
    'statusCode', s.atomic_portin_status_code,
    'description', s.atomic_portin_description,
    'reasonCode', s.atomic_portin_reason_code,
    'reasonDescription', s.atomic_portin_reason_description
  ),
  COALESCE(s.atomic_portin_status_attempted_at, s.atomic_portin_checked_at, s.created_at, now())
FROM sims s
WHERE s.port_in_pending IS NOT TRUE
  AND (
    s.atomic_portin_status_code IN ('948', '910', '951')
    OR s.status_reason = 'atomic_portin_max_age'
    OR (s.atomic_portin_status_code = '00' AND s.status = 'active')
  )
ON CONFLICT (sim_id) WHERE source = 'backfill' DO NOTHING;
