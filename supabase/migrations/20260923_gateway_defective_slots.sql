-- captured from PROD 2026-09-23 (lzjqegxazqlktttyybth) with pg_attribute / pg_get_constraintdef /
-- pg_indexes. The table existed in PROD but no migration in this repo created it.
-- IF NOT EXISTS throughout: a no-op on PROD, builds the table on TEST or a rebuild.

CREATE TABLE IF NOT EXISTS public.gateway_defective_slots (
  id bigserial,
  gateway_id bigint NOT NULL,
  port_slot text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gateway_defective_slots_pkey PRIMARY KEY (id),
  CONSTRAINT gateway_defective_slots_gateway_id_port_slot_key UNIQUE (gateway_id, port_slot),
  CONSTRAINT gateway_defective_slots_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS gateway_defective_slots_gateway_id_idx ON public.gateway_defective_slots USING btree (gateway_id);

-- PROD: RLS on, no policies; only service_role holds grants.
ALTER TABLE public.gateway_defective_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gateway_defective_slots FROM anon, authenticated;
GRANT ALL ON public.gateway_defective_slots TO service_role;
