-- =========================================================
-- sims.gateway_host: flip the column default from 'skyline' to 'teltik'.
--
-- Context (2026-09-04): all production SIMs are now hosted by Teltik. The
-- SkyLine gateway hardware is the legacy setup and seats no live lines.
--
-- The column was created NOT NULL DEFAULT 'skyline' back when SkyLine was the
-- only host. No activation insert path sets gateway_host explicitly, so every
-- newly activated SIM silently landed as 'skyline' — including the entire
-- 2026-08-24 → 2026-09-04 Teltik port-in cohort (113 active + 73 error rows,
-- all with gateway_id IS NULL and port IS NULL, i.e. seated in no SkyLine
-- gateway at all).
--
-- Why this matters beyond cosmetics: shared/gateway-host.mjs keys the capability
-- matrix on gateway_host. A row wrongly marked 'skyline' reports
-- setImei: true / portReset: false — the exact inverse of what a Teltik-hosted
-- line actually supports. The failure mode is a silent wrong branch (an IMEI
-- write attempted against a host that cannot do it, a port reset skipped on a
-- host that can), not an exception.
--
-- Data correction for the already-affected rows is a separate one-off backfill
-- (scoped to non-canceled rows with no SkyLine gateway seat), recorded in
-- agent/current-state.md. Canceled legacy rows keep 'skyline' — they really
-- were SkyLine-seated, and rewriting them would destroy accurate history.
-- =========================================================

ALTER TABLE public.sims
  ALTER COLUMN gateway_host SET DEFAULT 'teltik';
