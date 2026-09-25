-- Server-side bulk jobs for the dashboard's per-SIM bulk buttons (rotate,
-- OTA, cancel, resume, suspend, restore, assign reseller, assign + notify,
-- send online, modify IMEI, retry activation, delete, carrier query).
--
-- Before this, each button looped in the browser with one fetch per SIM, so
-- locking the phone or closing the tab failed every remaining SIM. Now the
-- browser posts the whole list once; the dashboard Worker stores one
-- bulk_jobs row plus one bulk_job_items row per SIM and sends one Cloudflare
-- Queue message per item. The dashboard's queue consumer replays each item's
-- API call(s) server-side as the user who started the job. See
-- src/dashboard/bulk-jobs.mjs.
--
-- An item moves pending -> running -> done | failed, or pending -> cancelled.
-- The pending -> running claim is a conditional UPDATE (claim_bulk_job_item
-- below), which makes a queue redelivery a no-op instead of a second rotation.

CREATE TABLE IF NOT EXISTS public.bulk_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL,
  title              text NOT NULL,
  status             text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','done','cancelled','failed')),
  total_items        integer NOT NULL DEFAULT 0,
  spacing_ms         integer NOT NULL DEFAULT 0,
  created_by         text NOT NULL,
  created_by_user_id uuid,
  created_by_role    text NOT NULL,
  auth_type          text NOT NULL CHECK (auth_type IN ('session','break_glass')),
  cancel_requested   boolean NOT NULL DEFAULT false,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);

CREATE TABLE IF NOT EXISTS public.bulk_job_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES public.bulk_jobs(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  sim_id       bigint,
  label        text,
  steps        jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','failed','cancelled')),
  result       jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  UNIQUE (job_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status_created ON public.bulk_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_job_items_job_status ON public.bulk_job_items (job_id, status);
CREATE INDEX IF NOT EXISTS idx_bulk_job_items_job_finished ON public.bulk_job_items (job_id, finished_at);

-- Service-role only, like every other table the Workers own.
ALTER TABLE public.bulk_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bulk_job_items ENABLE ROW LEVEL SECURITY;

-- Claim one item for execution. The UPDATE ... WHERE status = 'pending' is
-- the whole idempotency story: a redelivered queue message, or a message for
-- an item the user cancelled, gets zero rows and the consumer skips it. An
-- RPC rather than a PATCH with return=representation, because the latter has
-- been seen to come back empty on rows it did update (hosting-port-status.mjs).
CREATE OR REPLACE FUNCTION public.claim_bulk_job_item(p_job_id uuid, p_seq integer)
RETURNS SETOF public.bulk_job_items
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE public.bulk_job_items
     SET status = 'running', started_at = now()
   WHERE job_id = p_job_id AND seq = p_seq AND status = 'pending'
  RETURNING *;
$$;

-- Close out a job once nothing is left to run, and fail items stuck in
-- 'running' past p_stale_after (the consumer died mid-item; a queue consumer
-- is killed at 15 minutes, so 20 is safely past it). Those are never
-- re-run: a rotation or cancel whose outcome is unknown must not fire twice.
-- Returns the job's status after settling.
CREATE OR REPLACE FUNCTION public.settle_bulk_job(p_job_id uuid, p_stale_after interval DEFAULT interval '20 minutes')
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE public.bulk_job_items
     SET status = 'failed', finished_at = now(),
         result = jsonb_build_object('error',
           'Interrupted: the server stopped while this SIM was running. The outcome is unknown; check the SIM before running it again.')
   WHERE job_id = p_job_id AND status = 'running' AND started_at < now() - p_stale_after;

  IF EXISTS (SELECT 1 FROM public.bulk_job_items
              WHERE job_id = p_job_id AND status IN ('pending', 'running')) THEN
    SELECT status INTO v_status FROM public.bulk_jobs WHERE id = p_job_id;
    RETURN v_status;
  END IF;

  UPDATE public.bulk_jobs
     SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'done' END,
         finished_at = now()
   WHERE id = p_job_id AND status = 'running';

  SELECT status INTO v_status FROM public.bulk_jobs WHERE id = p_job_id;
  RETURN v_status;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_bulk_job_item(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_bulk_job(uuid, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bulk_job_item(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_bulk_job(uuid, interval) TO service_role;
