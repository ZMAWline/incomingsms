-- Canonical history of Teltik hosting port-status checks (task t_a71decd6).
-- Every /v1/port-status read — dashboard SIM query, teltik-host-check,
-- bad-rental-remediator probe, Sims bulk action, 12h scheduled sweep — inserts
-- one row per attempt. Latest status + uptime stats are DERIVED from this
-- table via get_hosting_port_status_summary(); there is no separate summary
-- table to drift. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS hosting_port_status_checks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sim_id      bigint,                          -- sims.id (no FK: keep history if SIM rows are deleted)
  iccid       text,
  vendor      text,                            -- SERVICE PROVIDER (atomic/wing_iot/teltik/helix), never inferred from host
  gateway_host text NOT NULL DEFAULT 'teltik', -- physical host
  mdn         text,                            -- resolved Teltik-known MDN used for the call (10-digit)
  mdn_source  text,                            -- e.g. teltik_inbound_sms_payload_mdn | teltik_get_phone_number_inventory | teltik_all_lines_inventory | db_current_mdn_unconfirmed | *_retry
  source      text NOT NULL,                   -- cron | manual_bulk | manual_sweep | single_query | bad_rental_remediator
  attempt     smallint NOT NULL DEFAULT 1,     -- 1 = first read, 2 = wrong-MDN retry
  http_status integer,                         -- NULL when no HTTP response (exception / skipped)
  state       text NOT NULL CHECK (state IN ('online','offline','unknown','error')),
  raw         jsonb,                           -- raw response body (or {"raw": text})
  error       text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);

-- Latest-by-sim lookups and per-sim stats windows.
CREATE INDEX IF NOT EXISTS idx_hpsc_sim_checked_at ON hosting_port_status_checks (sim_id, checked_at DESC);
-- Global stats / retention windows.
CREATE INDEX IF NOT EXISTS idx_hpsc_checked_at ON hosting_port_status_checks (checked_at DESC);

-- Per-SIM latest status + 24h/7d uptime, derived straight from history so
-- manual and automatic checks always count identically.
CREATE OR REPLACE FUNCTION get_hosting_port_status_summary(sim_ids bigint[])
RETURNS TABLE (
  sim_id bigint,
  last_state text,
  last_checked_at timestamptz,
  last_source text,
  last_mdn text,
  last_mdn_source text,
  last_http_status integer,
  last_error text,
  checks_24h integer,
  online_24h integer,
  checks_7d integer,
  online_7d integer
)
LANGUAGE sql STABLE AS $$
  WITH latest AS (
    SELECT DISTINCT ON (c.sim_id)
      c.sim_id, c.state, c.checked_at, c.source, c.mdn, c.mdn_source, c.http_status, c.error
    FROM hosting_port_status_checks c
    WHERE c.sim_id = ANY(sim_ids)
    ORDER BY c.sim_id, c.checked_at DESC, c.id DESC
  ),
  stats AS (
    SELECT c.sim_id,
      COUNT(*) FILTER (WHERE c.checked_at > now() - interval '24 hours')::int                       AS checks_24h,
      COUNT(*) FILTER (WHERE c.checked_at > now() - interval '24 hours' AND c.state = 'online')::int AS online_24h,
      COUNT(*)::int                                                                                  AS checks_7d,
      COUNT(*) FILTER (WHERE c.state = 'online')::int                                                AS online_7d
    FROM hosting_port_status_checks c
    WHERE c.sim_id = ANY(sim_ids) AND c.checked_at > now() - interval '7 days'
    GROUP BY c.sim_id
  )
  SELECT l.sim_id, l.state, l.checked_at, l.source, l.mdn, l.mdn_source, l.http_status, l.error,
         COALESCE(s.checks_24h, 0), COALESCE(s.online_24h, 0),
         COALESCE(s.checks_7d, 0), COALESCE(s.online_7d, 0)
  FROM latest l
  LEFT JOIN stats s ON s.sim_id = l.sim_id
$$;
