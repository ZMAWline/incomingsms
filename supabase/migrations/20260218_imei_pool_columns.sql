-- Add gateway tracking columns to imei_pool
ALTER TABLE imei_pool ADD COLUMN IF NOT EXISTS gateway_id INTEGER REFERENCES gateways(id);
ALTER TABLE imei_pool ADD COLUMN IF NOT EXISTS port TEXT;
ALTER TABLE imei_pool ADD COLUMN IF NOT EXISTS slot INTEGER;

-- Add 'blocked' as a valid status (check constraint if one exists, otherwise just documentation)
-- Update any existing entries that have gateway info in notes
UPDATE imei_pool
SET gateway_id = (
  CASE
    WHEN notes LIKE '%gateway 1 %' THEN 1
    WHEN notes LIKE '%gateway 2 %' THEN 2
    ELSE NULL
  END
),
port = (
  CASE
    WHEN notes ~ 'port (\w+)' THEN (regexp_match(notes, 'port (\w+)'))[1]
    ELSE NULL
  END
)
WHERE notes LIKE '%Imported from gateway%' AND gateway_id IS NULL;
