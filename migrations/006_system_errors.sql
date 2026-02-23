-- System-wide error tracking table
-- Captures errors from dashboard actions, automated workers (MDN rotation, etc.),
-- and any other system operations for centralized monitoring and resolution tracking.

CREATE TABLE IF NOT EXISTS system_errors (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,              -- e.g. 'mdn-rotator', 'bulk-activator', 'dashboard', 'sim-canceller'
    action TEXT,                        -- e.g. 'rotate', 'activate', 'cancel', 'ota_refresh', 'fix_sim'
    sim_id BIGINT REFERENCES sims(id), -- nullable, not all errors relate to a SIM
    iccid TEXT,                         -- denormalized for easy display
    error_message TEXT NOT NULL,
    error_details JSONB,               -- full error context (request/response bodies, stack traces, etc.)
    severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning', 'critical')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,                  -- who resolved it (e.g. 'admin', 'auto')
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for the errors page queries
CREATE INDEX IF NOT EXISTS idx_system_errors_status ON system_errors(status);
CREATE INDEX IF NOT EXISTS idx_system_errors_created_at ON system_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_errors_sim_id ON system_errors(sim_id);
CREATE INDEX IF NOT EXISTS idx_system_errors_source ON system_errors(source);

-- Enable RLS (service role key bypasses, but good practice)
ALTER TABLE system_errors ENABLE ROW LEVEL SECURITY;

-- Policy: allow all operations for service role (our workers use service_role key)
CREATE POLICY "Service role full access" ON system_errors
    FOR ALL USING (true) WITH CHECK (true);
