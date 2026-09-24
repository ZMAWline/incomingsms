-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.
-- Depends on touch_updated_at() (20260923_billing_ledger.sql).

CREATE TABLE IF NOT EXISTS public.plan_rates (
  id bigserial,
  vendor text NOT NULL,
  plan_name text NOT NULL,
  rate numeric(10,4) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_rates_pkey PRIMARY KEY (id),
  CONSTRAINT plan_rates_check CHECK ((effective_to IS NULL) OR (effective_to >= effective_from)),
  CONSTRAINT plan_rates_rate_check CHECK (rate >= (0)::numeric)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_rates_active_unique ON public.plan_rates USING btree (vendor, plan_name) WHERE (effective_to IS NULL);
CREATE INDEX IF NOT EXISTS idx_plan_rates_lookup ON public.plan_rates USING btree (vendor, effective_from, effective_to);

CREATE OR REPLACE TRIGGER plan_rates_touch BEFORE UPDATE ON public.plan_rates FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.plan_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_rates FROM anon, authenticated;
GRANT ALL ON public.plan_rates TO service_role;
