-- INC-13: tag every imei_pool row as phone or router.
-- Wing IoT requires ROUTER IMEIs; AT&T (ATOMIC/Helix) requires PHONE IMEIs.
-- All existing pool entries are phone IMEIs per operator confirmation.

ALTER TABLE imei_pool
  ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT 'phone';

ALTER TABLE imei_pool
  DROP CONSTRAINT IF EXISTS imei_pool_device_type_check;

ALTER TABLE imei_pool
  ADD CONSTRAINT imei_pool_device_type_check
    CHECK (device_type IN ('phone', 'router'));

-- Explicitly stamp every existing row (idempotent — DEFAULT already applied).
UPDATE imei_pool SET device_type = 'phone' WHERE device_type IS NULL;

CREATE INDEX IF NOT EXISTS imei_pool_device_type_status_idx
  ON imei_pool (device_type, status);
