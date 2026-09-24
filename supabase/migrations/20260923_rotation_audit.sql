-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.rotation_audit (
  id bigserial,
  run_at timestamptz NOT NULL DEFAULT now(),
  ny_date date NOT NULL,
  trigger text NOT NULL,
  bucket_a_count integer NOT NULL DEFAULT 0,
  bucket_b_count integer NOT NULL DEFAULT 0,
  bucket_c_count integer NOT NULL DEFAULT 0,
  bucket_a_sim_ids integer[] NOT NULL DEFAULT '{}'::integer[],
  bucket_b_sim_ids integer[] NOT NULL DEFAULT '{}'::integer[],
  bucket_c_sim_ids integer[] NOT NULL DEFAULT '{}'::integer[],
  actions_taken jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer,
  caps_hit jsonb,
  CONSTRAINT rotation_audit_pkey PRIMARY KEY (id),
  CONSTRAINT rotation_audit_trigger_check CHECK (trigger = ANY (ARRAY['cron'::text, 'manual'::text, 'dry'::text]))
);

CREATE INDEX IF NOT EXISTS idx_rotation_audit_ny_date ON public.rotation_audit USING btree (ny_date DESC);
CREATE INDEX IF NOT EXISTS idx_rotation_audit_run_at ON public.rotation_audit USING btree (run_at DESC);

COMMENT ON TABLE public.rotation_audit IS 'One row per /reconcile-rotations run. Bucket A: stuck-pending wing_iot (status=provisioning OR active + rotation_status=mdn_pending). Bucket B: rotated-but-not-notified (last_notified_at < last_mdn_rotated_at). Bucket C: eligible-but-not-attempted (logged only). Used by dashboard Health widget.';

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.rotation_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rotation_audit FROM anon, authenticated;
GRANT ALL ON public.rotation_audit TO service_role;
