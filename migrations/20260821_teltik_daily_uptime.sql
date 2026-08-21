-- Daily fleet-wide uptime for Teltik-hosted lines, over a trailing window
-- (default 30 days). Used by the teltik-portal Analytics tab.
--
-- Per-line, not per-check-row: for each day, count DISTINCT lines checked
-- that day and how many had 'online' as their LAST recorded state that day.
-- A raw per-check-row aggregate was tried first and rejected — check
-- frequency varies wildly by source (bad_rental_remediator repeatedly
-- probes lines already flagged in open trouble reports; the 12h cron only
-- covers a rotating slice — see runRotatingCronSweep in
-- src/shared/hosting-port-status.mjs), so counting every row double/triple
-- counts flaky lines and skews the percentage down. Counting distinct lines
-- per day is immune to that: a line probed 50 times by the remediator still
-- counts once, using its last state of the day.
--
-- hosting_port_status_checks is inherently Teltik-only (every row is a
-- Teltik /v1/port-status read — see migrations/20260804_hosting_port_status_checks.sql),
-- so no vendor/gateway_host filter is needed here.
--
-- generate_series provides the day axis so days with zero checks still show
-- up as a zero row instead of a gap in the chart.
CREATE OR REPLACE FUNCTION get_teltik_daily_uptime(days_back integer DEFAULT 30)
RETURNS TABLE (day date, lines_checked integer, online_lines integer)
LANGUAGE sql STABLE AS $$
  WITH daily_last AS (
    SELECT date_trunc('day', c.checked_at)::date AS day, c.sim_id,
      (array_agg(c.state ORDER BY c.checked_at DESC))[1] AS last_state
    FROM hosting_port_status_checks c
    WHERE c.checked_at >= current_date - (days_back - 1)
      AND c.sim_id IS NOT NULL
    GROUP BY 1, 2
  ),
  days AS (
    SELECT generate_series(current_date - (days_back - 1), current_date, interval '1 day')::date AS day
  )
  SELECT d.day,
    COALESCE(COUNT(dl.sim_id), 0)::int AS lines_checked,
    COALESCE(COUNT(dl.sim_id) FILTER (WHERE dl.last_state = 'online'), 0)::int AS online_lines
  FROM days d
  LEFT JOIN daily_last dl ON dl.day = d.day
  GROUP BY d.day
  ORDER BY d.day;
$$;
