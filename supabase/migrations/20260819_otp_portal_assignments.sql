-- OTP portal: private, token-gated page that hands out one free temporary
-- number from the existing storefront pool (shop_pool) so a trusted
-- non-admin user can watch for an incoming OTP. Purely additive — no
-- existing table is touched, and it never competes with a paying storefront
-- customer for a number: otp_portal_claim() rejects any sim currently held
-- by an active shop_rentals row.
--
-- Assignments are free (no shop_ledger entry), temporary (expires_at, short
-- TTL set by the worker), and self-expiring — nothing else in the system
-- needs to know this table exists.

create table if not exists otp_portal_assignments (
  id bigint generated always as identity primary key,
  session_token text not null unique,
  sim_id bigint not null references sims(id),
  e164 text not null,
  carrier text,
  assigned_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists otp_portal_assignments_sim_idx
  on otp_portal_assignments (sim_id, expires_at);

alter table otp_portal_assignments enable row level security;

-- Advisory-lock-serialized claim, same shape as shop_claim_rental
-- (20260612_storefront_v1.sql) but keyed on sim_id instead of customer_id —
-- there is no balance/customer concept here, every claim is free and
-- expires on its own. Rejects the sim if it's already held by another
-- unexpired otp_portal_assignments row OR an active shop_rentals row.
create or replace function otp_portal_claim(
  p_session_token text, p_sim_id bigint, p_e164 text, p_carrier text, p_ttl_minutes int
) returns bigint
language plpgsql security definer as $$
declare
  v_assignment_id bigint;
begin
  perform pg_advisory_xact_lock(825001, p_sim_id::int);
  if exists (
    select 1 from otp_portal_assignments where sim_id = p_sim_id and expires_at > now()
  ) then
    raise exception 'sim_taken';
  end if;
  if exists (
    select 1 from shop_rentals where sim_id = p_sim_id and status = 'active'
  ) then
    raise exception 'sim_taken';
  end if;
  insert into otp_portal_assignments (session_token, sim_id, e164, carrier, expires_at)
    values (p_session_token, p_sim_id, p_e164, p_carrier,
            now() + make_interval(mins => greatest(p_ttl_minutes, 1)))
    returning id into v_assignment_id;
  return v_assignment_id;
end $$;
