-- Index for the sims_dashboard view's current-number lookup.
--
-- The view joins each SIM to its current number with
--   WHERE sim_id = s.id AND valid_to IS NULL
--   ORDER BY valid_from DESC NULLS LAST, id DESC LIMIT 1
-- and the only index was sim_numbers(sim_id). Every rotation leaves a closed
-- row behind, so each probe read ~44 history rows and sorted them: 2.5 ms per
-- SIM. Measured on PROD 2026-10-06 (5,532 SIMs, 338,729 sim_numbers rows): the
-- 1,000-row page of `sims_dashboard?select=id,gateway_host,vendor` took
-- 2.7 s, and GET /api/sims sorted on SMS count, which reads every SIM through
-- the view, took 17-24 s end to end. The stats RPCs themselves take 13-66 ms
-- per 500 SIMs warm.
--
-- This partial index holds only the open rows (about one per SIM) in the
-- view's order, so the probe is a single index read with no sort. It is
-- additive: no view or function changes. Plain CREATE INDEX on ~5.5k index
-- entries blocks writes to sim_numbers for milliseconds.

create index if not exists idx_sim_numbers_current
  on public.sim_numbers (sim_id, valid_from desc nulls last, id desc)
  include (e164, verification_status)
  where valid_to is null;
