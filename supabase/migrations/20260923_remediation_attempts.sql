-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.remediation_attempts (
  id bigserial,
  sim_id bigint NOT NULL,
  run_id uuid,
  action text NOT NULL,
  result text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remediation_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT remediation_attempts_result_chk CHECK (result = ANY (ARRAY['ok'::text, 'fail'::text]))
);

CREATE INDEX IF NOT EXISTS remediation_attempts_created ON public.remediation_attempts USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS remediation_attempts_sim_created ON public.remediation_attempts USING btree (sim_id, created_at DESC);

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.remediation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.remediation_attempts FROM anon, authenticated;
GRANT ALL ON public.remediation_attempts TO service_role;
