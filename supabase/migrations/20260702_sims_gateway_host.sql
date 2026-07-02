-- gateway_host: the physical gateway a SIM lives in, independent of carrier vendor.
--   'skyline' = our multi-port Skyline gateways. Support AT+EGMR IMEI writes and
--               AT-command SMS send. gateway_id/port are populated.
--   'teltik'  = Teltik-hosted gateway. Inbound SMS (webhook) + port reset ONLY.
--               NO IMEI write, NO AT-command SMS. gateway_id/port are null.
-- This splits apart the two things vendor used to conflate: carrier account
-- (atomic/helix/wing_iot/teltik) vs physical host. An ATOMIC (AT&T) SIM can now
-- live in EITHER a Skyline OR a Teltik gateway.
alter table public.sims
  add column if not exists gateway_host text not null default 'skyline';

alter table public.sims
  drop constraint if exists sims_gateway_host_check;
alter table public.sims
  add constraint sims_gateway_host_check check (gateway_host in ('skyline','teltik'));

-- Backfill: every teltik-vendor SIM is Teltik-hosted. Everything else keeps the
-- 'skyline' default (matches today's assumption that non-teltik => Skyline).
update public.sims set gateway_host = 'teltik' where vendor = 'teltik';

create index if not exists idx_sims_gateway_host on public.sims (gateway_host);
