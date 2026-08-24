-- Activation job tracking: one parent run + one child item per SIM.
-- Enables dashboard visibility into pending/processing/done/failed/retry-needed
-- with exact errors and safe retry controls.

-- Parent run table
CREATE TABLE IF NOT EXISTS activation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL DEFAULT 'json'
                    CHECK (source IN ('csv','json','dashboard')),
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','processing','done','failed','cancelled')),
  total_items     integer NOT NULL DEFAULT 0,
  queued_items    integer NOT NULL DEFAULT 0,
  processing_items integer NOT NULL DEFAULT 0,
  done_items      integer NOT NULL DEFAULT 0,
  failed_items    integer NOT NULL DEFAULT 0,
  retry_needed_items integer NOT NULL DEFAULT 0,
  skipped_items   integer NOT NULL DEFAULT 0,
  created_by      text,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Child item table (one per SIM)
CREATE TABLE IF NOT EXISTS activation_job_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES activation_runs(id) ON DELETE CASCADE,
  iccid           text NOT NULL,
  imei            text,
  reseller_id     bigint,
  vendor          text NOT NULL DEFAULT 'atomic',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','queued','processing','done','failed','retry_needed','skipped')),
  attempt         integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  error_message   text,
  carrier_log_id  bigint,  -- reference to carrier_api_logs.id
  sim_id          bigint,  -- reference to sims.id (after activation)
  queued_at       timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, iccid)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_activation_runs_status_created ON activation_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activation_job_items_run_status ON activation_job_items (run_id, status);
CREATE INDEX IF NOT EXISTS idx_activation_job_items_iccid ON activation_job_items (iccid);
CREATE INDEX IF NOT EXISTS idx_activation_job_items_sim_id ON activation_job_items (sim_id);