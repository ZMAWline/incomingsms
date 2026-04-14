-- Migration: Add support for ATOMIC and Wing IoT carriers
-- Date: 2026-04-13

-- Add MSISDN column for ATOMIC (uses 10-digit MDN instead of mobilitySubscriptionId)
ALTER TABLE sims ADD COLUMN IF NOT EXISTS msisdn TEXT;
CREATE INDEX IF NOT EXISTS idx_sims_msisdn ON sims(msisdn) WHERE msisdn IS NOT NULL;

-- Rename helix_api_logs to carrier_api_logs with vendor column
ALTER TABLE helix_api_logs RENAME TO carrier_api_logs;
ALTER TABLE carrier_api_logs ADD COLUMN IF NOT EXISTS vendor TEXT DEFAULT 'helix';
CREATE INDEX IF NOT EXISTS idx_carrier_api_logs_vendor ON carrier_api_logs(vendor);

-- Backward-compatible view for existing code that references helix_api_logs
CREATE OR REPLACE VIEW helix_api_logs AS
  SELECT * FROM carrier_api_logs WHERE vendor = 'helix';
