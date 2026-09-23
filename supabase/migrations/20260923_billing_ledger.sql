-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.
-- Depends on bill_audit_lines (20260923_bill_audit_tables.sql). Also captures
-- touch_updated_at(), the trigger function billing_ledger and plan_rates share;
-- it was not in the repo either.

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$;

REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO service_role;

CREATE TABLE IF NOT EXISTS public.billing_ledger (
  id bigserial,
  sim_id integer NOT NULL,
  iccid text NOT NULL,
  vendor text NOT NULL,
  plan_name text,
  period_start date NOT NULL,
  period_end date NOT NULL,
  expected_amount numeric(10,4),
  expected_basis text,
  billed_amount numeric(10,4),
  bill_audit_line_id bigint,
  status text NOT NULL DEFAULT 'pending'::text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  invoice_no text,
  CONSTRAINT billing_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT billing_ledger_sim_id_vendor_period_start_key UNIQUE (sim_id, vendor, period_start),
  CONSTRAINT billing_ledger_check CHECK (period_end >= period_start),
  CONSTRAINT billing_ledger_status_check CHECK (status = ANY (ARRAY['pending'::text, 'billed'::text, 'over'::text, 'under'::text, 'missing'::text, 'phantom'::text, 'disputed'::text, 'resolved'::text])),
  CONSTRAINT billing_ledger_bill_audit_line_id_fkey FOREIGN KEY (bill_audit_line_id) REFERENCES public.bill_audit_lines(id) ON DELETE SET NULL,
  CONSTRAINT billing_ledger_sim_id_fkey FOREIGN KEY (sim_id) REFERENCES public.sims(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS billing_ledger_invoice_no_idx ON public.billing_ledger USING btree (invoice_no) WHERE (invoice_no IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_iccid_period ON public.billing_ledger USING btree (iccid, period_start);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_period ON public.billing_ledger USING btree (vendor, period_start, status);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_status_open ON public.billing_ledger USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'missing'::text, 'over'::text, 'under'::text, 'phantom'::text]));

CREATE OR REPLACE TRIGGER billing_ledger_touch BEFORE UPDATE ON public.billing_ledger FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.billing_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_ledger FROM anon, authenticated;
GRANT ALL ON public.billing_ledger TO service_role;
