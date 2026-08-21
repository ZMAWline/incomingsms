-- Singleton row tracking the 12h hosting-port cron's rotation offset.
--
-- Bug this fixes: dashboard's scheduled() called runHostingPortSweep(env,
-- {source:'cron'}) with no offset, so `offset` defaulted to 0 on every
-- single invocation forever — the cron re-checked the same ~200 lowest-id
-- active Teltik sims every 12h and never advanced to the rest of the fleet.
-- Full-fleet coverage previously only happened via the manually-triggered
-- async job queue (hosting_port_status_jobs). See
-- src/shared/hosting-port-status.mjs#runRotatingCronSweep.
CREATE TABLE IF NOT EXISTS hosting_port_cron_state (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton
  next_offset integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO hosting_port_cron_state (id, next_offset)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
