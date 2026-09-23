-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.cron_runs (
  id bigserial,
  run_id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'running'::text,
  summary jsonb,
  report_md text,
  CONSTRAINT cron_runs_pkey PRIMARY KEY (id),
  CONSTRAINT cron_runs_status_chk CHECK (status = ANY (ARRAY['running'::text, 'completed'::text, 'aborted'::text, 'stale'::text]))
);

CREATE INDEX IF NOT EXISTS cron_runs_kind_started ON public.cron_runs USING btree (kind, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cron_runs_one_active_per_kind ON public.cron_runs USING btree (kind) WHERE (status = 'running'::text);

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_runs FROM anon, authenticated;
GRANT ALL ON public.cron_runs TO service_role;
