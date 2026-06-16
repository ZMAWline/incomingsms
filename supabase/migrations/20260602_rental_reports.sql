-- INC-3 Phase 1: bad-rental reporting intake.
--
-- One row per reseller-initiated "this rental isn't working" report, plus an
-- append-only event log for status transitions. Schema is intentionally
-- decoupled from INC-2 (rentals/reseller_rental_rates untouched).
--
-- See docs/superpowers/specs/2026-06-02-failed-rental-reporting-design.md
-- for the full design rationale (rev 5, approved 2026-06-02).
--
-- Identification: the report carries denormalized references to rental,
-- sim, sim_number, and e164 so historical lookups stay stable even if a
-- rental row is later edited or the SIM rotates. The active-report dedup
-- index (uq_rental_reports_open_rental) is the load-bearing guardrail
-- against double-reporting.

CREATE TABLE IF NOT EXISTS rental_reports (
    id BIGSERIAL PRIMARY KEY,
    reseller_id BIGINT NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    -- All four references are denormalized so the report survives schema/state
    -- churn elsewhere. rental_id is the authoritative join; the others are
    -- echoed for human/audit lookup and to make the response payload complete
    -- without an extra round trip.
    rental_id BIGINT NULL REFERENCES rentals(id) ON DELETE SET NULL,
    sim_id BIGINT NULL REFERENCES sims(id) ON DELETE SET NULL,
    sim_number_id BIGINT NULL REFERENCES sim_numbers(id) ON DELETE SET NULL,
    e164 TEXT NOT NULL,
    -- What the reseller actually said.
    reason_code TEXT NOT NULL DEFAULT 'no_sms_received'
        CHECK (reason_code IN ('no_sms_received','wrong_number','delayed_sms','other')),
    reason_note TEXT NULL,
    attempts INT NULL,
    first_attempt_at TIMESTAMPTZ NULL,
    client_request_id TEXT NULL,
    -- Triage lifecycle.
    status TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','in_triage','remediated','unable_to_reproduce','duplicate')),
    remediation_action TEXT NULL
        CHECK (remediation_action IS NULL OR remediation_action IN ('rotated','port_reset','sim_replaced','mdn_swapped','other')),
    duplicate_of BIGINT NULL REFERENCES rental_reports(id) ON DELETE SET NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    triaged_at TIMESTAMPTZ NULL,
    closed_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_reports_open
    ON rental_reports (reseller_id, status) WHERE status IN ('received','in_triage');
CREATE INDEX IF NOT EXISTS idx_rental_reports_rental
    ON rental_reports (rental_id);
CREATE INDEX IF NOT EXISTS idx_rental_reports_sim
    ON rental_reports (sim_id);
CREATE INDEX IF NOT EXISTS idx_rental_reports_e164
    ON rental_reports (e164);

-- Dedup: one open report per rental per reseller at any moment. Re-submitting
-- while a report is already received/in_triage returns the existing row
-- (handled in the worker; this index makes it a hard DB invariant).
CREATE UNIQUE INDEX IF NOT EXISTS uq_rental_reports_open_rental
    ON rental_reports (reseller_id, rental_id)
    WHERE status IN ('received','in_triage') AND rental_id IS NOT NULL;

CREATE OR REPLACE FUNCTION rental_reports_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rental_reports_updated_at ON rental_reports;
CREATE TRIGGER trg_rental_reports_updated_at
    BEFORE UPDATE ON rental_reports
    FOR EACH ROW EXECUTE FUNCTION rental_reports_touch_updated_at();

ALTER TABLE rental_reports ENABLE ROW LEVEL SECURITY;

-- Append-only event log. Status transitions and operator notes accumulate
-- here; never updated, only inserted.
CREATE TABLE IF NOT EXISTS rental_report_events (
    id BIGSERIAL PRIMARY KEY,
    report_id BIGINT NOT NULL REFERENCES rental_reports(id) ON DELETE CASCADE,
    from_status TEXT NULL,
    to_status TEXT NOT NULL,
    -- 'reseller' on intake, 'operator:<agent-or-user-id>' on triage,
    -- 'system' on any automated transition.
    actor TEXT NOT NULL,
    note TEXT NULL,
    evidence JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_report_events_report
    ON rental_report_events (report_id, created_at DESC);

ALTER TABLE rental_report_events ENABLE ROW LEVEL SECURITY;
