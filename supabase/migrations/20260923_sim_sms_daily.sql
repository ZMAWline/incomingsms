-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.sim_sms_daily (
  sim_id bigint NOT NULL,
  est_date date NOT NULL,
  sms_count integer NOT NULL DEFAULT 0,
  CONSTRAINT sim_sms_daily_pkey PRIMARY KEY (sim_id, est_date),
  CONSTRAINT sim_sms_daily_sim_id_fkey FOREIGN KEY (sim_id) REFERENCES public.sims(id)
);

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.sim_sms_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sim_sms_daily FROM anon, authenticated;
GRANT ALL ON public.sim_sms_daily TO service_role;
