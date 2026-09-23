-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.teltik_lifecycle_events (
  event_id text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL,
  processed_at timestamptz,
  outcome text,
  error text,
  sim_id bigint,
  CONSTRAINT teltik_lifecycle_events_pkey PRIMARY KEY (event_id),
  CONSTRAINT teltik_lifecycle_events_sim_id_fkey FOREIGN KEY (sim_id) REFERENCES public.sims(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS teltik_lifecycle_events_event_type_idx ON public.teltik_lifecycle_events USING btree (event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS teltik_lifecycle_events_received_at_idx ON public.teltik_lifecycle_events USING btree (received_at DESC);
CREATE INDEX IF NOT EXISTS teltik_lifecycle_events_sim_id_idx ON public.teltik_lifecycle_events USING btree (sim_id) WHERE (sim_id IS NOT NULL);

COMMENT ON TABLE public.teltik_lifecycle_events IS 'Dedup + audit log for Teltik lifecycle webhook events. event_id is supplied by Teltik for idempotency.';

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.teltik_lifecycle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.teltik_lifecycle_events FROM anon, authenticated;
GRANT ALL ON public.teltik_lifecycle_events TO service_role;
