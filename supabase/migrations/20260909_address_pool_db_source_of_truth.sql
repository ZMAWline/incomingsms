-- Moves the port-in / PPU address pool from a code array to a DB table so a
-- carrier-rejected address can actually be DELETED at runtime.
--
-- Before this, src/shared/address-pool.mjs was the source of truth and a
-- Worker could only flag rows in address_pool_usage. That flag was applied on
-- ANY UpdateSubscriberInfo failure — including 500s, 504s and Invalid MSISDN —
-- which quarantined 1070 of 1521 addresses, of which only 13 were genuinely
-- bad. 391 were flagged in a single day during a carrier outage.
--
-- address_pool_usage is left alone: it still owns LRU/claim state for the Apex
-- PPU picker. This table owns membership — if a row is gone, the address is
-- gone, everywhere, permanently.

create table if not exists address_pool (
  address_id       text primary key,
  street_number    text        not null,
  street_name      text        not null,
  street_direction text        not null default '',
  city             text        not null,
  state            text        not null,
  zip_code         text        not null,
  created_at       timestamptz not null default now()
);

comment on table address_pool is
  'Membership list for the fake-identity address pool. Deleting a row removes the address from rotation permanently. Seeded from src/shared/address-pool.mjs, which is now seed data only.';

create index if not exists address_pool_state_zip_idx on address_pool (state, zip_code);

-- A delete is permanent, so keep the evidence for it somewhere. Without this
-- there is no way to answer "why is this address gone" or to spot a rule that
-- is deleting too much — which is exactly the failure this migration exists to
-- undo.
create table if not exists address_pool_deletions (
  id           bigserial primary key,
  address_id   text        not null,
  reason       text,
  carrier_step text,
  deleted_at   timestamptz not null default now()
);

comment on table address_pool_deletions is
  'Audit trail for address_pool deletions. Rows here are NOT excluded from the pool — address_pool membership is the only source of truth.';

create index if not exists address_pool_deletions_address_idx on address_pool_deletions (address_id, deleted_at desc);

alter table address_pool enable row level security;
alter table address_pool_deletions enable row level security;
