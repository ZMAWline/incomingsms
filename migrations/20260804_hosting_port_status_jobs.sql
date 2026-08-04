-- Durable Workers-page "Hosting Port Check" sweep jobs. The dashboard enqueues
-- one row per manual full sweep; the dashboard worker's 1-minute scheduled
-- tick drains the oldest pending job one bounded batch (max_sims) at a time,
-- persisting next_offset/totals after every batch, so the sweep continues even
-- if the operator's browser closes. Idempotent: safe to re-run.
--
-- Lifecycle: queued (ready for next batch) -> running (batch in flight)
-- -> queued -> ... -> done | failed | cancelled. A batch that crashes mid-run
-- is reclaimed once updated_at goes stale (lease in code, JOB_LEASE_MS).

CREATE TABLE IF NOT EXISTS hosting_port_status_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL DEFAULT 'manual_sweep' -- hosting_port_status_checks.source used for the batches
                    CHECK (source IN ('cron','manual_bulk','manual_sweep','single_query','bad_rental_remediator')),
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','done','failed','cancelled')),
  next_offset     integer NOT NULL DEFAULT 0,           -- id-ordered sims offset for the NEXT batch
  max_sims        integer NOT NULL DEFAULT 200,         -- batch size per tick (server cap 200)
  batches         integer NOT NULL DEFAULT 0,           -- batches completed so far
  total_available integer,                              -- fleet size from the first batch's count
  totals          jsonb NOT NULL DEFAULT '{"checked":0,"online":0,"offline":0,"unknown":0,"error":0,"wrong_mdn_retries":0}'::jsonb,
  error           text,
  created_by      text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Claim query: status filter + created_at.asc ordering, and updated_at for
-- the stale-lease reclaim condition.
CREATE INDEX IF NOT EXISTS idx_hpsj_status_created_at
  ON hosting_port_status_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_hpsj_updated_at
  ON hosting_port_status_jobs (updated_at);
