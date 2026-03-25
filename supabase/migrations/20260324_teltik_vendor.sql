-- Add vendor/carrier/rotation_interval columns to sims table
-- Existing rows remain unaffected (vendor='helix', carrier='att', rotation_interval_hours=24 by default)
-- Teltik rows on import: vendor='teltik', carrier='tmobile', rotation_interval_hours=48

ALTER TABLE sims
  ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT 'helix',
  ADD COLUMN IF NOT EXISTS carrier TEXT,
  ADD COLUMN IF NOT EXISTS rotation_interval_hours INTEGER NOT NULL DEFAULT 24;

UPDATE sims SET vendor = 'helix', carrier = 'att' WHERE vendor = 'helix';

CREATE INDEX IF NOT EXISTS idx_sims_vendor ON sims(vendor);
CREATE INDEX IF NOT EXISTS idx_sims_vendor_status ON sims(vendor, status);
