-- Reseller selling-side pricing rules: time-bounded, optionally per-vendor,
-- with volume tiers (all-at-rate). Falls back to qbo_customer_map.daily_rate
-- when no row matches a given (reseller, vendor, date).
--
-- tiers JSON shape (sorted by min_count, contiguous, last tier may have
-- max_count = null meaning "and up"):
--   [
--     { "min_count": 1,  "max_count": 50,   "rate": 0.50 },
--     { "min_count": 51, "max_count": 100,  "rate": 0.45 },
--     { "min_count": 101,"max_count": null, "rate": 0.40 }
--   ]
--
-- Rate units by vendor:
--   - atomic / helix / wing_iot : rate is per SIM-day
--   - teltik                    : rate is per block (one rental rotation)
--   - vendor = NULL             : rate is per SIM-day, applies to AT&T vendors
--                                 only (Teltik must have its own row)

CREATE TABLE IF NOT EXISTS reseller_rates (
    id BIGSERIAL PRIMARY KEY,
    reseller_id BIGINT NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    vendor TEXT NULL CHECK (vendor IS NULL OR vendor IN ('atomic','helix','wing_iot','teltik')),
    effective_from DATE NOT NULL,
    effective_to DATE NULL,
    tiers JSONB NOT NULL,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) >= 1)
);

CREATE INDEX IF NOT EXISTS idx_reseller_rates_lookup
    ON reseller_rates (reseller_id, vendor, effective_from DESC);

CREATE INDEX IF NOT EXISTS idx_reseller_rates_open
    ON reseller_rates (reseller_id, vendor)
    WHERE effective_to IS NULL;

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION reseller_rates_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reseller_rates_updated_at ON reseller_rates;
CREATE TRIGGER trg_reseller_rates_updated_at
    BEFORE UPDATE ON reseller_rates
    FOR EACH ROW EXECUTE FUNCTION reseller_rates_touch_updated_at();

ALTER TABLE reseller_rates ENABLE ROW LEVEL SECURITY;
