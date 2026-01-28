-- Helix API call logging table
-- Tracks all API requests and responses for debugging

CREATE TABLE IF NOT EXISTS helix_api_logs (
  id BIGSERIAL PRIMARY KEY,
  worker TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  request_body JSONB,
  response_status INTEGER,
  response_body JSONB,
  success BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying recent logs
CREATE INDEX IF NOT EXISTS idx_helix_api_logs_created_at ON helix_api_logs(created_at DESC);

-- Index for filtering by worker
CREATE INDEX IF NOT EXISTS idx_helix_api_logs_worker ON helix_api_logs(worker);

-- Index for filtering by success/failure
CREATE INDEX IF NOT EXISTS idx_helix_api_logs_success ON helix_api_logs(success);

-- Auto-delete logs older than 30 days (optional - run as cron or manually)
-- DELETE FROM helix_api_logs WHERE created_at < NOW() - INTERVAL '30 days';
