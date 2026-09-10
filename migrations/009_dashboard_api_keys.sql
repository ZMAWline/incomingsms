-- =========================================================
-- Agent API: per-caller API keys + a general dashboard audit trail.
--
-- Why keys and not a shared secret: an external AI agent drives the same
-- carrier-touching routes a human operator drives, so its credential has to be
-- nameable, role-scoped and revocable on its own without disturbing anyone
-- else. A key carries a role from the same three-role vocabulary the portal
-- already uses (admin/operator/viewer) and is checked by the same canAccess()
-- matrix, so an operator key is fenced exactly like an operator human.
--
-- Only the SHA-256 of the full key is stored, the same treatment
-- dashboard_sessions and dashboard_invites give their tokens: a read of this
-- table never yields a usable credential. key_prefix is the first 12
-- characters ("zmaw_test_ab") and exists purely so the UI can tell two keys
-- apart in a list.
-- =========================================================

CREATE TABLE IF NOT EXISTS dashboard_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  role         text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  enabled      boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- Every authenticated request hits this lookup, so it must be an index probe.
CREATE INDEX IF NOT EXISTS dashboard_api_keys_key_hash_idx
  ON dashboard_api_keys (key_hash);

ALTER TABLE dashboard_api_keys ENABLE ROW LEVEL SECURITY;

-- =========================================================
-- dashboard_audit_log: who did what, from the authenticated principal only.
--
-- Distinct from system_errors (failures) and carrier_api_logs (one row per
-- carrier HTTP call). This is the operator-intent layer: one row per acting
-- request against /api/*, whether it succeeded or not. It answers "which
-- caller suspended this line at 03:14" without reconstructing it from carrier
-- traffic.
--
-- actor is NEVER taken from the request body. Several handlers accept
-- body.actor for display in their own domain tables; that value is unverified
-- and is deliberately not what lands here.
-- =========================================================

CREATE TABLE IF NOT EXISTS dashboard_audit_log (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  actor        text,
  actor_type   text CHECK (actor_type IN ('user', 'api_key', 'break_glass', 'anonymous')),
  role         text,
  method       text,
  path         text,
  sim_id       text,
  iccid        text,
  mdn          text,
  action       text,
  request_body jsonb,
  status       integer,
  ok           boolean,
  duration_ms  integer,
  error        text,
  ip           text,
  user_agent   text
);

-- The audit tab reads newest-first, optionally narrowed by actor or path.
CREATE INDEX IF NOT EXISTS dashboard_audit_log_ts_idx     ON dashboard_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS dashboard_audit_log_actor_idx  ON dashboard_audit_log (actor, ts DESC);
CREATE INDEX IF NOT EXISTS dashboard_audit_log_path_idx   ON dashboard_audit_log (path, ts DESC);
CREATE INDEX IF NOT EXISTS dashboard_audit_log_sim_id_idx ON dashboard_audit_log (sim_id, ts DESC);

ALTER TABLE dashboard_audit_log ENABLE ROW LEVEL SECURITY;
