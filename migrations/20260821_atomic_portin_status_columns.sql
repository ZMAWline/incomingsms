-- Migration: ATOMIC port-in status tracking
-- Date: 2026-08-21
--
-- port_in_pending distinguishes SIMs awaiting an ATOMIC portinRequest
-- completion from other status='provisioning' states (e.g. a stuck
-- swapMSISDN, which already uses rotation_status='mdn_pending' and is owned
-- by the existing ATOMIC finalizer bucket). Set true by bulk-activator when
-- a portinRequest is submitted; cleared only by an operator, since the
-- carrier's portinStatus enum/completion signal is not independently
-- confirmed (see atomic-wholesale-api skill "Unknowns").
--
-- atomic_portin_status_code / atomic_portin_description / _checked_at record
-- the carrier's raw portinStatus response as returned, without interpretation.

ALTER TABLE sims ADD COLUMN IF NOT EXISTS port_in_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_status_code TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_description TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sims_atomic_port_in_pending
  ON sims(vendor, status)
  WHERE port_in_pending = true;
