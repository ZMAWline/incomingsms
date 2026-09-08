-- Migration: persist ATOMIC port-in outcome details
-- Permanent port-in failures are terminal until an operator corrects and resubmits.

ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_reason_code TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_reason_description TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_submitted_at TIMESTAMPTZ;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_status_check_at TIMESTAMPTZ;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS atomic_portin_status_attempted_at TIMESTAMPTZ;
