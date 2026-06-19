-- Snapshot the per-day invoice line items at generation time so that
-- re-downloading an invoice from history reproduces the full breakdown
-- (previously the download fell back to a single summary/total line because
-- only aggregate sim_count/total were persisted).
--
-- Additive + nullable. Invoices generated before this column existed have
-- daily_breakdown = NULL and continue to re-download as a single summary line.
ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS daily_breakdown JSONB;
COMMENT ON COLUMN qbo_invoices.daily_breakdown IS 'Per-day line items snapshotted at invoice generation time: array of {date,sim_count,rate,amount,...}. NULL for invoices generated before 2026-06-19; those re-download as a single summary line.';
