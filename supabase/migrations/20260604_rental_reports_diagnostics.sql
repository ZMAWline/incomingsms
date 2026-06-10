-- INC-3 diagnostic storage for bad-rental intake.
--
-- Two additions to make malformed/wrong-shape submissions debuggable instead
-- of disappearing into a 4xx response:
--
-- 1. rental_reports.raw_payload + source  - capture the body and the route
--    that produced each successful insert.
-- 2. rental_report_rejections             - log payloads we rejected so the
--    operator can see what the reseller actually sent (arrays, wrong keys,
--    parse failures, unowned identifiers, rate-limited attempts).
--
-- Additive only. RLS enabled on the new table; existing rental_reports RLS
-- policy is unchanged.

ALTER TABLE rental_reports ADD COLUMN IF NOT EXISTS raw_payload JSONB NULL;
ALTER TABLE rental_reports ADD COLUMN IF NOT EXISTS source TEXT NULL;

CREATE TABLE IF NOT EXISTS rental_report_rejections (
    id BIGSERIAL PRIMARY KEY,
    -- Nullable: auth failures or pre-auth parse errors won't know the reseller.
    reseller_id BIGINT NULL REFERENCES resellers(id) ON DELETE SET NULL,
    -- Route/handler tag, e.g. 'api/rentals/report-bad', 'api/sims/:id/report-bad'.
    source TEXT NOT NULL,
    -- One of: parse_error | bad_request | not_found | ambiguous | rate_limited | internal_error.
    rejection_code TEXT NOT NULL,
    rejection_message TEXT NULL,
    -- The parsed JSON when parse succeeded; null when parse failed.
    raw_payload JSONB NULL,
    -- Raw request body text when JSON parse failed or shape wasn't an object
    -- (e.g. reseller sent a top-level array). Capped to 8 KiB at insert time.
    raw_body_text TEXT NULL,
    http_status INT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_report_rejections_reseller_time
    ON rental_report_rejections (reseller_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_rental_report_rejections_code
    ON rental_report_rejections (rejection_code, received_at DESC);

ALTER TABLE rental_report_rejections ENABLE ROW LEVEL SECURITY;
