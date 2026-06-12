-- Storefront v1 — customer-facing day-rental shop (shop_* namespace).
-- Purely ADDITIVE: no existing table is touched. Stock is opt-in only via
-- shop_pool, so storefront sales can never collide with reseller-allocated
-- SIMs by accident.

create table if not exists shop_customers (
  id bigint generated always as identity primary key,
  email text not null unique,
  password_hash text not null,                 -- pbkdf2$<iters>$<salt_b64>$<hash_b64>
  status text not null default 'active' check (status in ('active','banned')),
  telegram_chat_id text,                       -- phase 2: telegram bot linkage
  api_token text unique,                       -- phase 2: bot/API access
  created_at timestamptz not null default now()
);

create table if not exists shop_sessions (
  token text primary key,
  customer_id bigint not null references shop_customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists shop_sessions_customer_idx on shop_sessions (customer_id);

-- Money is append-only: balance == sum(amount_cents). No mutable balance column.
create table if not exists shop_ledger (
  id bigint generated always as identity primary key,
  customer_id bigint not null references shop_customers(id),
  amount_cents bigint not null,                -- positive credit, negative debit
  kind text not null check (kind in ('deposit','rental','refund','admin_adjust')),
  ref text,
  created_at timestamptz not null default now()
);
create index if not exists shop_ledger_customer_idx on shop_ledger (customer_id, created_at desc);

create or replace view shop_balances as
  select customer_id, coalesce(sum(amount_cents), 0)::bigint as balance_cents
  from shop_ledger group by customer_id;

-- Explicit stock allocation: ONLY sims listed here are sellable.
create table if not exists shop_pool (
  sim_id bigint primary key references sims(id),
  added_at timestamptz not null default now(),
  note text
);

create table if not exists shop_rentals (
  id bigint generated always as identity primary key,
  customer_id bigint not null references shop_customers(id),
  sim_id bigint not null references sims(id),
  e164 text not null,
  carrier text,
  price_cents bigint not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  status text not null default 'active' check (status in ('active','ended','cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists shop_rentals_customer_idx on shop_rentals (customer_id, created_at desc);
-- One active rental per SIM, enforced by the database, not application code.
create unique index if not exists shop_rentals_one_active_per_sim
  on shop_rentals (sim_id) where status = 'active';

create table if not exists shop_deposits (
  id bigint generated always as identity primary key,
  customer_id bigint not null references shop_customers(id),
  processor text not null default 'nowpayments',
  invoice_id text unique,
  pay_currency text,
  amount_cents bigint not null,
  status text not null default 'pending' check (status in ('pending','confirmed','failed','expired')),
  raw jsonb,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists shop_prices (
  id bigint generated always as identity primary key,
  vendor text not null unique,                 -- 'teltik' | 'atomic' | 'wing_iot' | 'helix' | 'default'
  daily_price_cents bigint not null
);
insert into shop_prices (vendor, daily_price_cents)
  values ('default', 300)
  on conflict (vendor) do nothing;

-- Atomic claim: advisory lock per customer kills the concurrent-balance race;
-- the partial unique index kills the concurrent same-SIM race.
create or replace function shop_claim_rental(
  p_customer_id bigint, p_sim_id bigint, p_e164 text,
  p_carrier text, p_price_cents bigint, p_hours int
) returns bigint
language plpgsql security definer as $$
declare
  v_balance bigint;
  v_rental_id bigint;
begin
  perform pg_advisory_xact_lock(815001, p_customer_id::int);
  select coalesce(sum(amount_cents), 0) into v_balance
    from shop_ledger where customer_id = p_customer_id;
  if v_balance < p_price_cents then
    raise exception 'insufficient_balance';
  end if;
  insert into shop_rentals (customer_id, sim_id, e164, carrier, price_cents, ends_at)
    values (p_customer_id, p_sim_id, p_e164, p_carrier, p_price_cents,
            now() + make_interval(hours => greatest(p_hours, 1)))
    returning id into v_rental_id;
  insert into shop_ledger (customer_id, amount_cents, kind, ref)
    values (p_customer_id, -p_price_cents, 'rental', 'rental:' || v_rental_id);
  return v_rental_id;
end $$;

-- Idempotent deposit confirmation (payment processors retry webhooks).
create or replace function shop_confirm_deposit(
  p_invoice_id text, p_amount_cents bigint, p_raw jsonb
) returns boolean
language plpgsql security definer as $$
declare
  v_dep shop_deposits%rowtype;
begin
  update shop_deposits
     set status = 'confirmed', confirmed_at = now(), raw = coalesce(p_raw, raw),
         amount_cents = coalesce(p_amount_cents, amount_cents)
   where invoice_id = p_invoice_id and status = 'pending'
   returning * into v_dep;
  if not found then
    return false;  -- already confirmed (retry) or unknown invoice
  end if;
  insert into shop_ledger (customer_id, amount_cents, kind, ref)
    values (v_dep.customer_id, v_dep.amount_cents, 'deposit', 'deposit:' || v_dep.id);
  return true;
end $$;

alter table shop_customers enable row level security;
alter table shop_sessions  enable row level security;
alter table shop_ledger    enable row level security;
alter table shop_pool      enable row level security;
alter table shop_rentals   enable row level security;
alter table shop_deposits  enable row level security;
alter table shop_prices    enable row level security;
