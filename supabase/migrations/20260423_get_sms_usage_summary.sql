-- SMS Usage Analytics RPC
-- Returns a single JSONB blob with MTD per-vendor rollup, Wing-specific stats,
-- top/bottom 10 Wing SIMs, and N-day trend for the new dashboard analytics tab.
-- Worker computes cycle boundary in America/New_York and passes dates in.

CREATE OR REPLACE FUNCTION public.get_sms_usage_summary(
  p_cycle_start date,
  p_today       date,
  p_trend_days  int DEFAULT 30
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH
active_sims AS (
  SELECT id, vendor FROM sims WHERE status = 'active'
),
mtd AS (
  SELECT s.vendor, d.sim_id, SUM(d.sms_count)::bigint AS sms
  FROM sim_sms_daily d
  JOIN active_sims s ON s.id = d.sim_id
  WHERE d.est_date BETWEEN p_cycle_start AND p_today
  GROUP BY s.vendor, d.sim_id
),
vendor_totals AS (
  SELECT m.vendor,
         COALESCE(SUM(m.sms),0)::bigint AS sms_count,
         COUNT(DISTINCT m.sim_id)::int  AS sim_count_with_sms,
         (SELECT COUNT(*) FROM active_sims a WHERE a.vendor = m.vendor)::int AS active_sim_count
  FROM mtd m
  GROUP BY m.vendor
),
wing_per_sim AS (
  SELECT a.id AS sim_id, COALESCE(m.sms,0)::bigint AS sms
  FROM active_sims a
  LEFT JOIN mtd m ON m.sim_id = a.id
  WHERE a.vendor = 'wing_iot'
),
wing_stats AS (
  SELECT COUNT(*)::int AS wing_sim_count,
         COALESCE(SUM(sms),0)::bigint AS wing_sms_total,
         COALESCE(ROUND(AVG(sms)::numeric, 2), 0) AS wing_avg,
         COALESCE(MIN(sms),0)::bigint AS wing_min,
         COALESCE(MAX(sms),0)::bigint AS wing_max
  FROM wing_per_sim
),
wing_top AS (
  SELECT sim_id, sms FROM wing_per_sim ORDER BY sms DESC, sim_id ASC LIMIT 10
),
wing_bottom AS (
  SELECT sim_id, sms FROM wing_per_sim ORDER BY sms ASC, sim_id ASC LIMIT 10
),
trend AS (
  SELECT d.est_date, s.vendor, SUM(d.sms_count)::bigint AS sms
  FROM sim_sms_daily d
  JOIN active_sims s ON s.id = d.sim_id
  WHERE d.est_date > p_today - p_trend_days AND d.est_date <= p_today
  GROUP BY d.est_date, s.vendor
)
SELECT jsonb_build_object(
  'cycle_start', p_cycle_start,
  'today',       p_today,
  'vendors',     (SELECT jsonb_agg(row_to_json(vt)) FROM vendor_totals vt),
  'wing',        (SELECT row_to_json(ws) FROM wing_stats ws),
  'wing_top',    (SELECT jsonb_agg(jsonb_build_object('sim_id',sim_id,'sms',sms)) FROM wing_top),
  'wing_bottom', (SELECT jsonb_agg(jsonb_build_object('sim_id',sim_id,'sms',sms)) FROM wing_bottom),
  'trend',       (SELECT jsonb_agg(jsonb_build_object('d',est_date,'v',vendor,'s',sms) ORDER BY est_date) FROM trend)
);
$$;

GRANT EXECUTE ON FUNCTION public.get_sms_usage_summary(date,date,int) TO service_role;
