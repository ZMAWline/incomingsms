-- carrier_api_logs: request/response audit trail for ATOMIC/Helix/Wing IoT
-- carrier calls, written by src/bulk-activator, src/mdn-rotator, src/dashboard,
-- and other workers via logCarrierApiCall().
--
-- This table exists on PROD (lzjqegxazqlktttyybth) — it accreted there via
-- ad-hoc Supabase MCP calls (originally created as helix_api_logs, later
-- renamed with a `vendor` column added) that were never captured as a
-- migration file in this repo. It does NOT exist on TEST (lwapudjjlwkskijefxdz)
-- at all, which is why Activation Run items successfully activated in TEST
-- (e.g. run b11b2839-69aa-4b94-8d81-07c1b99fb113) show no carrier logs: both
-- the INSERT from logCarrierApiCall() and the SELECT from
-- handleActivationRunDetail() fail against a table that isn't there
-- (PGRST202), and both call sites swallow that failure instead of surfacing it.
--
-- This file documents the schema currently live on PROD (columns/types
-- verified via the Supabase Management API) and brings TEST to parity. Safe
-- to run on PROD too (CREATE TABLE IF NOT EXISTS), but only applied to TEST
-- as part of this fix.

CREATE TABLE IF NOT EXISTS carrier_api_logs (
  id                  bigserial PRIMARY KEY,
  run_id              text NOT NULL,
  step                text NOT NULL,
  iccid               text,
  imei                text,
  vendor              text DEFAULT 'helix',
  request_url         text NOT NULL,
  request_method      text NOT NULL,
  request_headers     jsonb,
  request_body        jsonb,
  response_status     integer,
  response_ok         boolean,
  response_headers    jsonb,
  response_body_text  text,
  response_body_json  jsonb,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE carrier_api_logs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_carrier_api_logs_iccid ON carrier_api_logs (iccid);
CREATE INDEX IF NOT EXISTS idx_carrier_api_logs_run_id ON carrier_api_logs (run_id);
CREATE INDEX IF NOT EXISTS idx_carrier_api_logs_step ON carrier_api_logs (step);
CREATE INDEX IF NOT EXISTS idx_carrier_api_logs_created_at ON carrier_api_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_carrier_api_logs_vendor ON carrier_api_logs (vendor);
