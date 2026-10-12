-- Nightly MDN rotation runs on the dashboard's Runs page.
--
-- Rotation has no run of its own: mdn-rotator (atomic, plus helix/wing when
-- re-enabled) and teltik-worker each rotate a batch every few minutes inside
-- the NY 0-8 window. One rotation_runs row is that whole night for one
-- vendor; each tick adds its counts through record_rotation_tick().
--
-- done_items / failed_items count attempts, so a SIM that fails and then
-- succeeds on an in-window retry counts once in each.

CREATE TABLE IF NOT EXISTS public.rotation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ny_date date NOT NULL,
  vendor text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_tick_at timestamptz NOT NULL DEFAULT now(),
  ticks integer NOT NULL DEFAULT 0,
  done_items integer NOT NULL DEFAULT 0,
  failed_items integer NOT NULL DEFAULT 0,
  breaker_trips integer NOT NULL DEFAULT 0,
  backfilled boolean NOT NULL DEFAULT false,
  CONSTRAINT rotation_runs_night_vendor UNIQUE (ny_date, vendor)
);

ALTER TABLE public.rotation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rotation_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rotation_runs TO service_role;

-- One tick's counts. A tick that rotated and failed nothing writes nothing,
-- so a night with no work for a vendor has no row.
CREATE OR REPLACE FUNCTION public.record_rotation_tick(
  p_vendor text, p_done integer, p_failed integer, p_breaker_tripped boolean)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO rotation_runs AS r (ny_date, vendor, ticks, done_items, failed_items, breaker_trips)
  SELECT (now() AT TIME ZONE 'America/New_York')::date, p_vendor, 1, p_done, p_failed,
         CASE WHEN p_breaker_tripped THEN 1 ELSE 0 END
   WHERE p_done + p_failed > 0
  ON CONFLICT (ny_date, vendor) DO UPDATE
     SET last_tick_at  = now(),
         ticks         = r.ticks + 1,
         done_items    = r.done_items + EXCLUDED.done_items,
         failed_items  = r.failed_items + EXCLUDED.failed_items,
         breaker_trips = r.breaker_trips + EXCLUDED.breaker_trips;
$function$;

REVOKE ALL ON FUNCTION public.record_rotation_tick(text, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_rotation_tick(text, integer, integer, boolean) TO service_role;

-- History before the workers recorded ticks: one row per NY night and vendor
-- from sim_numbers, counting each new number that replaced an earlier one
-- (a SIM's first number is its activation, not a rotation). Failures were
-- never kept per night, so backfilled rows show 0 failed.
INSERT INTO public.rotation_runs (ny_date, vendor, started_at, last_tick_at, done_items, backfilled)
SELECT (n.valid_from AT TIME ZONE 'America/New_York')::date,
       s.vendor,
       min(n.valid_from),
       max(n.valid_from),
       count(*),
       true
  FROM public.sim_numbers n
  JOIN public.sims s ON s.id = n.sim_id
 WHERE s.vendor IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.sim_numbers p WHERE p.sim_id = n.sim_id AND p.valid_from < n.valid_from)
 GROUP BY 1, 2
ON CONFLICT (ny_date, vendor) DO NOTHING;

-- The Runs page list gains rotation nights. A night is running until its
-- last tick is 30 minutes old (ticks run every 5 minutes in the window).
CREATE OR REPLACE VIEW public.dashboard_runs WITH (security_invoker = true) AS
SELECT r.id,
       'activation'::text                          AS run_type,
       r.source,
       'Activation'::text                          AS title,
       r.status,
       r.total_items,
       r.done_items,
       r.failed_items + r.retry_needed_items       AS failed_items,
       r.created_by,
       r.created_at,
       r.finished_at
  FROM public.activation_runs r
UNION ALL
SELECT j.id,
       'bulk'::text,
       'dashboard'::text,
       j.title,
       j.status,
       j.total_items,
       c.done_items,
       c.failed_items,
       j.created_by,
       j.created_at,
       j.finished_at
  FROM public.bulk_jobs j
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE i.status = 'done')::int   AS done_items,
           count(*) FILTER (WHERE i.status = 'failed')::int AS failed_items
      FROM public.bulk_job_items i
     WHERE i.job_id = j.id
  ) c ON true
UNION ALL
SELECT o.id,
       'rotation'::text,
       'cron'::text,
       'MDN rotation · ' || o.vendor || ' · ' || to_char(o.ny_date, 'YYYY-MM-DD'),
       CASE WHEN o.last_tick_at > now() - interval '30 minutes' THEN 'running' ELSE 'done' END,
       o.done_items + o.failed_items,
       o.done_items,
       o.failed_items,
       'nightly cron'::text,
       o.started_at,
       CASE WHEN o.last_tick_at > now() - interval '30 minutes' THEN NULL ELSE o.last_tick_at END
  FROM public.rotation_runs o;

REVOKE ALL ON public.dashboard_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.dashboard_runs TO service_role;
