-- Address pool (PPU addresses for ATOMIC/Helix activations + port-ins).
--
-- This schema was originally applied to PROD (lzjqegxazqlktttyybth) via
-- ad-hoc Supabase MCP migrations (claim_address_pool_entry_returns_row,
-- address_pool_usage_add_address_fields) that were never captured as a
-- migration file in this repo. It was never applied to the TEST project
-- (lwapudjjlwkskijefxdz) at all, which is why bulk-activator's ATOMIC path
-- fails on every SIM in test with:
--   PGRST202: Could not find the function public.claim_address_pool_entry(...)
--
-- This file documents the schema currently live on PROD and brings TEST to
-- parity. Safe to run on PROD too (CREATE TABLE IF NOT EXISTS / CREATE OR
-- REPLACE), but only applied to TEST as part of this fix.

CREATE TABLE IF NOT EXISTS address_pool_usage (
  address_id        text PRIMARY KEY,
  state              text NOT NULL,
  zip_code           text NOT NULL,
  last_used_at       timestamptz,
  use_count          integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  verify_failed_at   timestamptz,
  last_verify_error  text,
  street_number      text,
  street_name        text,
  street_direction   text,
  city               text
);

ALTER TABLE address_pool_usage ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS address_pool_usage_lru ON address_pool_usage (last_used_at NULLS FIRST, address_id);
CREATE INDEX IF NOT EXISTS address_pool_usage_state ON address_pool_usage (state);
CREATE INDEX IF NOT EXISTS address_pool_usage_verify_failed ON address_pool_usage (verify_failed_at);

-- Picks the least-recently-used PPU address, excluding a given state/zip and
-- any address quarantined by markAddressVerifyFailure() within the last 90
-- days. Returns NULL when the pool is exhausted (see pickNextPpuAddress).
CREATE OR REPLACE FUNCTION public.claim_address_pool_entry(p_exclude_state text DEFAULT NULL::text, p_exclude_zip text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  picked_row address_pool_usage%ROWTYPE;
BEGIN
  WITH candidate AS (
    SELECT address_id
      FROM address_pool_usage
     WHERE (p_exclude_state IS NULL OR state    <> p_exclude_state)
       AND (p_exclude_zip   IS NULL OR zip_code <> p_exclude_zip)
       AND (verify_failed_at IS NULL OR verify_failed_at < now() - INTERVAL '90 days')
       AND street_number IS NOT NULL  -- skip rows missing address details
       AND street_name   IS NOT NULL
     ORDER BY last_used_at ASC NULLS FIRST, address_id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE address_pool_usage u
     SET last_used_at = now(),
         use_count    = use_count + 1
    FROM candidate
   WHERE u.address_id = candidate.address_id
   RETURNING u.* INTO picked_row;

  IF picked_row.address_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id',              picked_row.address_id,
    'streetNumber',    picked_row.street_number,
    'streetName',      picked_row.street_name,
    'streetDirection', COALESCE(picked_row.street_direction, ''),
    'city',            picked_row.city,
    'state',           picked_row.state,
    'zipCode',         picked_row.zip_code
  );
END $function$;
