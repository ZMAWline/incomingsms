-- =========================================================
-- dashboard_audit_log retention: keep 90 days, purge nightly.
--
-- The audit log takes a row per acting request against /api/*, including a
-- redacted copy of the request body (up to 8 KB each). Nothing ever deleted
-- from it, so it was the one table in the schema growing without bound —
-- flagged as an open item when the Agent API shipped.
--
-- Why pg_cron and not the dashboard Worker: this database already runs its
-- other retention job this way (`delete-old-sms`, jobid 1, nightly at 03:00),
-- and a purge that lives in the database keeps running whether or not the
-- Worker is deployed, whether or not its cron triggers are enabled. TEST has
-- Worker crons disabled entirely, so a Worker-side purge would never have run
-- there at all.
--
-- AUDIT_LOG_RETENTION_DAYS lives in exactly one place: the `retention_days`
-- default below. The scheduled job calls the function with no arguments, so
-- changing that default changes the policy everywhere. Pass an explicit value
-- only for a one-off manual purge.
-- =========================================================

-- Nightly job needs pg_cron. Already present on PROD; a no-op there.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- The index the purge scans by (`ts < cutoff`, oldest first) already exists
-- from migration 009 as dashboard_audit_log_ts_idx ON (ts DESC) — a btree is
-- readable in either direction, so no second index is warranted here.

-- =========================================================
-- purge_dashboard_audit_log(retention_days) -> rows deleted
--
-- Deletes in batches of at most 5000 and loops until a batch comes back
-- empty, so a large first run is never one enormous DELETE statement holding
-- a multi-gigabyte snapshot open.
--
-- On transaction scope, honestly: a plpgsql FUNCTION runs in a single
-- transaction, so the row locks each batch takes are only released when the
-- whole call commits. That is fine for this table specifically — the audit
-- log is insert-only, rows are never updated, and INSERTs do not contend with
-- the row locks of a DELETE. What the batching buys is bounded work per
-- statement, not per-batch lock release.
-- =========================================================

CREATE OR REPLACE FUNCTION public.purge_dashboard_audit_log(retention_days int DEFAULT 90)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  batch_size CONSTANT int := 5000;
  cutoff     timestamptz;
  batch      bigint;
  purged     bigint := 0;
BEGIN
  -- A null or non-positive window would mean "delete the entire audit trail".
  -- That is never what a caller means, so refuse rather than guess.
  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'purge_dashboard_audit_log: retention_days must be >= 1 (got %)', retention_days;
  END IF;

  cutoff := now() - make_interval(days => retention_days);

  LOOP
    DELETE FROM public.dashboard_audit_log
     WHERE ctid IN (
       SELECT ctid
         FROM public.dashboard_audit_log
        WHERE ts < cutoff
        ORDER BY ts
        LIMIT batch_size
     );
    GET DIAGNOSTICS batch = ROW_COUNT;
    purged := purged + batch;
    EXIT WHEN batch = 0;
  END LOOP;

  IF purged > 0 THEN
    RAISE NOTICE 'purge_dashboard_audit_log: deleted % row(s) older than % (retention_days=%)',
      purged, cutoff, retention_days;
  END IF;

  RETURN purged;
END;
$fn$;

COMMENT ON FUNCTION public.purge_dashboard_audit_log(int) IS
  'Deletes dashboard_audit_log rows older than retention_days (default 90) in batches of 5000. Returns the number of rows deleted. Scheduled nightly as pg_cron job purge-dashboard-audit-log.';

-- SECURITY DEFINER, so only the roles that already administer the database may
-- call it. The dashboard reaches Supabase as service_role.
REVOKE ALL ON FUNCTION public.purge_dashboard_audit_log(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_dashboard_audit_log(int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_dashboard_audit_log(int) TO service_role;

-- =========================================================
-- Nightly schedule: 04:10 UTC (pg_cron's cron.timezone is GMT).
--
-- Deliberately not on the hour and clear of the 03:00 delete-old-sms job, so
-- the two retention jobs never overlap.
--
-- Re-running this migration re-points the existing job rather than creating a
-- duplicate: pg_cron matches on jobname.
-- =========================================================
SELECT cron.schedule(
  'purge-dashboard-audit-log',
  '10 4 * * *',
  $job$SELECT public.purge_dashboard_audit_log();$job$
);
