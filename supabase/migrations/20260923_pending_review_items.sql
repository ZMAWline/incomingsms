-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.pending_review_items (
  id bigserial,
  kind text NOT NULL,
  summary text NOT NULL,
  details_md text,
  run_id uuid,
  sim_id bigint,
  status text NOT NULL DEFAULT 'open'::text,
  operator_response text,
  responded_by text,
  agent_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT pending_review_items_pkey PRIMARY KEY (id),
  CONSTRAINT pending_review_items_status_chk CHECK (status = ANY (ARRAY['open'::text, 'answered'::text, 'acknowledged'::text, 'snoozed'::text, 'dismissed'::text]))
);

CREATE INDEX IF NOT EXISTS pending_review_items_kind_status ON public.pending_review_items USING btree (kind, status);
CREATE INDEX IF NOT EXISTS pending_review_items_sim ON public.pending_review_items USING btree (sim_id) WHERE (sim_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS pending_review_items_status_created ON public.pending_review_items USING btree (status, created_at DESC);

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.pending_review_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pending_review_items FROM anon, authenticated;
GRANT ALL ON public.pending_review_items TO service_role;
