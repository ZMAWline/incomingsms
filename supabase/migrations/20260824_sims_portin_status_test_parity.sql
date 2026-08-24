-- ATOMIC port-in status columns on `sims`.
--
-- Added to PROD (lzjqegxazqlktttyybth) ad-hoc alongside the portinRequest/
-- portinStatus feature (commits e84df7d, 4d665be) but never captured as a
-- migration file, and never applied to the TEST project (lwapudjjlwkskijefxdz)
-- — same pattern as the address_pool_usage gap fixed in
-- 20260824_address_pool_test_parity.sql. Every ATOMIC port-in in TEST fails
-- at the post-carrier-call `sims` upsert with:
--   PGRST204: Could not find the 'port_in_pending' column of 'sims' in the
--   schema cache
-- which masks the carrier's actual portinRequest/portinStatus result behind
-- an unrelated schema error.
--
-- This file documents the schema currently live on PROD and brings TEST to
-- parity. Safe to run on PROD too (IF NOT EXISTS), but only applied to TEST
-- as part of this fix.

ALTER TABLE sims
  ADD COLUMN IF NOT EXISTS port_in_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS atomic_portin_status_code text,
  ADD COLUMN IF NOT EXISTS atomic_portin_description text,
  ADD COLUMN IF NOT EXISTS atomic_portin_checked_at timestamptz;
