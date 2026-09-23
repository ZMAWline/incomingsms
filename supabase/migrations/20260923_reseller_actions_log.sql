-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.reseller_actions_log (
  id bigserial,
  reseller_id bigint NOT NULL,
  action text NOT NULL,
  sim_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reseller_actions_log_pkey PRIMARY KEY (id),
  CONSTRAINT reseller_actions_log_action_check CHECK (action = ANY (ARRAY['portal_resend'::text, 'portal_resync'::text]))
);

CREATE INDEX IF NOT EXISTS reseller_actions_log_reseller_action_created_idx ON public.reseller_actions_log USING btree (reseller_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS reseller_actions_log_reseller_sim_created_idx ON public.reseller_actions_log USING btree (reseller_id, sim_id, created_at DESC) WHERE (sim_id IS NOT NULL);

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.reseller_actions_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reseller_actions_log FROM anon, authenticated;
GRANT ALL ON public.reseller_actions_log TO service_role;
