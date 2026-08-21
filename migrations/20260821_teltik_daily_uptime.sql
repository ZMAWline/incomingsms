-- Daily fleet-wide uptime % for Teltik-hosted lines, over a trailing window
-- (default 30 days). Used by the teltik-portal Analytics tab.
--
-- hosting_port_status_checks is inherently Teltik-only (every row is a
-- Teltik /v1/port-status read — see migrations/20260804_hosting_port_status_checks.sql),
-- so no vendor/gateway_host filter is needed here, unlike per-sim queries
-- that also cover non-Teltik-hosted lines elsewhere in the schema.
--
-- generate_series provides the day axis so days with zero checks still show
-- up as a zero row instead of a gap in the chart.
CREATE OR REPLACE FUNCTION get_teltik_daily_uptime(days_back integer DEFAULT 30)
RETURNS TABLE (day date, checks integer, online_checks integer)
LANGUAGE sql STABLE AS $$
  SELECT d::date,
    COUNT(c.id)::int,
    COUNT(c.id) FILTER (WHERE c.state = 'online')::int
  FROM generate_series(current_date - (days_back - 1), current_date, interval '1 day') d
  LEFT JOIN hosting_port_status_checks c ON date_trunc('day', c.checked_at) = d
  GROUP BY d
  ORDER BY d;
$$;
