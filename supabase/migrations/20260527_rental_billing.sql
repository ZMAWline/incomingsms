-- INC-2: forward-only rental-based billing (Option A), gated behind a flag.
-- This migration is the DATA foundation only. It does NOT change any billing
-- output: computeBillingBreakdown still defaults to billing_mode='legacy_simday'.
-- The legacy EST-day / 48h-block engine stays fully intact and reachable.
--
-- Two tables:
--   1. rentals               — one row per number lifetime per reseller. The
--                              UNIQUE constraint is the load-bearing dedup
--                              guardrail: a resend of number.online for the
--                              same sim_numbers lifetime can only ever hit the
--                              same row, so it cannot mint a second rental. A
--                              rotation mints a NEW sim_numbers row → new
--                              sim_number_id → a new rental.
--   2. reseller_rental_rates — per-carrier flat rental rate, effective-dated
--                              exactly like reseller_rates (data, not code).
--
-- Carrier buckets for rental billing collapse the vendor detail to the two
-- contractual rates: AT&T (atomic/helix/wing_iot) and T-Mobile (teltik).

-- ---------------------------------------------------------------------------
-- 1. rentals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rentals (
    id BIGSERIAL PRIMARY KEY,
    reseller_id BIGINT NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    sim_id BIGINT NOT NULL REFERENCES sims(id) ON DELETE CASCADE,
    -- The sim_numbers lifetime that this rental bills for. One rental per
    -- lifetime; rotation creates a new lifetime and therefore a new rental.
    sim_number_id BIGINT NOT NULL REFERENCES sim_numbers(id) ON DELETE CASCADE,
    -- Contractual carrier bucket: 'att' or 'tmobile'. Drives which rental rate
    -- applies. Stored (not derived at read time) so a later vendor remap can't
    -- retroactively change historical billing.
    carrier TEXT NOT NULL CHECK (carrier IN ('att','tmobile')),
    -- The MDN this rental covers, for human-readable invoices / shadow diffs.
    e164 TEXT NULL,
    -- TrustOTP (or any reseller) rental id echoed back on number.online, when
    -- the reseller returns one. NULL is allowed: the rental still exists for
    -- billing even if the reseller didn't echo an id.
    reseller_rental_id TEXT NULL,
    -- EST calendar date the rental was minted on. This is the billing date the
    -- forward-only cutover compares against (>= 2026-05-22). Computed by the
    -- writer in America/New_York to match the rest of the billing math.
    rental_date DATE NOT NULL,
    minted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Load-bearing dedup guardrail. sim_number_id already uniquely identifies a
    -- (sim, mdn, lifetime); pairing it with reseller_id makes "one rental per
    -- number lifetime per reseller" a hard DB invariant rather than app logic.
    CONSTRAINT uq_rentals_reseller_sim_number UNIQUE (reseller_id, sim_number_id)
);

CREATE INDEX IF NOT EXISTS idx_rentals_reseller_date
    ON rentals (reseller_id, rental_date);
CREATE INDEX IF NOT EXISTS idx_rentals_sim
    ON rentals (sim_id);

CREATE OR REPLACE FUNCTION rentals_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rentals_updated_at ON rentals;
CREATE TRIGGER trg_rentals_updated_at
    BEFORE UPDATE ON rentals
    FOR EACH ROW EXECUTE FUNCTION rentals_touch_updated_at();

ALTER TABLE rentals ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. reseller_rental_rates
-- ---------------------------------------------------------------------------
-- Per-carrier flat rate, one charge per rental regardless of days or SMS.
-- Effective-dated the same way reseller_rates is: pick the most recent rule
-- active on the rental_date for the carrier. vendor=NULL semantics are not
-- needed here because rental billing only has two carrier buckets.
CREATE TABLE IF NOT EXISTS reseller_rental_rates (
    id BIGSERIAL PRIMARY KEY,
    reseller_id BIGINT NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    carrier TEXT NOT NULL CHECK (carrier IN ('att','tmobile')),
    effective_from DATE NOT NULL,
    effective_to DATE NULL,
    rate NUMERIC(10,4) NOT NULL CHECK (rate >= 0),
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_reseller_rental_rates_lookup
    ON reseller_rental_rates (reseller_id, carrier, effective_from DESC);

CREATE OR REPLACE FUNCTION reseller_rental_rates_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reseller_rental_rates_updated_at ON reseller_rental_rates;
CREATE TRIGGER trg_reseller_rental_rates_updated_at
    BEFORE UPDATE ON reseller_rental_rates
    FOR EACH ROW EXECUTE FUNCTION reseller_rental_rates_touch_updated_at();

ALTER TABLE reseller_rental_rates ENABLE ROW LEVEL SECURITY;

-- NOTE: the approved flat rates ($1.10 AT&T, $1.60 T-Mobile, effective
-- 2026-05-22) are seeded for TrustOTP only as a SEPARATE, approval-gated step
-- at cutover time — NOT in this migration. Until rows exist, rental mode falls
-- back to qbo_customer_map.daily_rate so a misconfiguration can't silently
-- zero-rate an invoice.
