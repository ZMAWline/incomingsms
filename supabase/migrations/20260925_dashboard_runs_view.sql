-- One list for the dashboard's Runs page: bulk activation runs
-- (activation_runs, written by the bulk-activator Worker) and server-side bulk
-- SIM actions (bulk_jobs, written by the dashboard) side by side, newest
-- first, so every run has a run ID, a type, a source and who started it.
-- Each row keeps its own detail tables; the page opens the matching detail
-- view by run_type.
--
-- Status is passed through unchanged ('queued'/'processing' for activation,
-- 'running' for bulk). failed_items counts activation items waiting for a
-- retry as failed, since both need the operator's attention.
-- security_invoker keeps RLS in force for anyone but service_role.

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
  ) c ON true;

REVOKE ALL ON public.dashboard_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.dashboard_runs TO service_role;
