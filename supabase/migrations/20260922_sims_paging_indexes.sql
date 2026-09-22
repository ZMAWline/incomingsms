-- SIMs table paging: the flat view the dashboard pages, filters and sorts on,
-- the fleet-wide counts its filter menus show, and the one index the view
-- needs.
--
-- Why a view. GET /api/sims used to download every sims row with three
-- embedded tables and filter and sort in the browser. To page on the server
-- every column the SIMs table filters or sorts on has to be a plain column
-- PostgREST can filter and order by. Four of them live in other tables
-- (gateway code, current phone number, verification status, active reseller)
-- and PostgREST can neither order a parent by a to-many embed nor filter one
-- two levels deep (PGRST108). The view flattens them to one row per SIM.
--
-- The coalesce() defaults are the ones the dashboard has always shown
-- (vendor 'unknown', offline_state 'online', rotation every 24 h, auto-rotate
-- on, port-in not pending), so a filter matches exactly what is on screen.
--
-- The view is security_invoker, so it enforces the RLS of the tables under
-- it. Only the service role (which bypasses RLS) reads it.
--
-- SMS-in-24h and hosting-port status are not here. They are aggregates over
-- inbound_sms and hosting_port_status_checks that the dashboard already
-- fetches per page through get_sms_counts_24h and
-- get_hosting_port_status_summary.
--
-- Must be applied BEFORE the dashboard that reads sims_dashboard is deployed:
-- without the view, GET /api/sims answers 502.
--
-- Table size (2026-09-22): ~5,500 sims rows, projected 20k. At that size the
-- view's two per-SIM lookups (current number, active reseller) are index
-- probes; plain CREATE INDEX on reseller_sims locks writes to it for well
-- under a second. CONCURRENTLY is not possible through apply_migration.

CREATE OR REPLACE VIEW public.sims_dashboard
WITH (security_invoker = true) AS
SELECT
  s.id,
  s.iccid,
  s.imei,
  s.msisdn,
  s.port,
  s.status,
  COALESCE(s.vendor, 'unknown') AS vendor,
  s.gateway_host,
  s.carrier,
  COALESCE(s.rotation_interval_hours, 24) AS rotation_interval_hours,
  COALESCE(s.rotation_eligible, true) AS rotation_eligible,
  s.rotation_pause_reason,
  COALESCE(s.offline_state, 'online') AS offline_state,
  s.offline_since,
  s.mobility_subscription_id,
  s.gateway_id,
  s.last_mdn_rotated_at,
  s.last_rotation_at,
  s.activated_at,
  s.created_at,
  s.last_activation_error,
  s.last_notified_at,
  COALESCE(s.port_in_pending, false) AS port_in_pending,
  s.atomic_portin_status_code,
  s.atomic_portin_description,
  s.atomic_portin_checked_at,
  g.code AS gateway_code,
  g.name AS gateway_name,
  n.e164 AS phone_number,
  n.verification_status,
  rs.reseller_id,
  r.name AS reseller_name
FROM public.sims s
LEFT JOIN public.gateways g ON g.id = s.gateway_id
LEFT JOIN LATERAL (
  SELECT sn.e164, sn.verification_status
  FROM public.sim_numbers sn
  WHERE sn.sim_id = s.id AND sn.valid_to IS NULL
  ORDER BY sn.valid_from DESC NULLS LAST, sn.id DESC
  LIMIT 1
) n ON true
LEFT JOIN LATERAL (
  SELECT x.reseller_id
  FROM public.reseller_sims x
  WHERE x.sim_id = s.id AND x.active = true
  ORDER BY x.created_at DESC NULLS LAST
  LIMIT 1
) rs ON true
LEFT JOIN public.resellers r ON r.id = rs.reseller_id;

REVOKE ALL ON public.sims_dashboard FROM anon, authenticated;

-- { column: { value: count } } for every enum-like column the SIMs filter
-- menus list, over the whole fleet. Replaces counting the rows the browser
-- had loaded, which only ever saw one page once paging moved to the server.
CREATE OR REPLACE FUNCTION public.sims_dashboard_facets()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_object_agg(col, counts), '{}'::jsonb)
  FROM (
    SELECT col, jsonb_object_agg(val, n) AS counts
    FROM (
      SELECT col, val, count(*) AS n
      FROM public.sims_dashboard d
      CROSS JOIN LATERAL (VALUES
        ('gateway_code', d.gateway_code),
        ('port', d.port),
        ('status', d.status),
        ('vendor', d.vendor),
        ('verification_status', d.verification_status),
        ('offline_state', d.offline_state),
        ('reseller_name', d.reseller_name),
        ('reseller_id', d.reseller_id::text),
        ('carrier', d.carrier),
        ('gateway_host', d.gateway_host),
        ('atomic_portin_status_code', d.atomic_portin_status_code)
      ) AS v(col, val)
      WHERE val IS NOT NULL AND val <> ''
      GROUP BY col, val
    ) grouped
    GROUP BY col
  ) per_col;
$function$;

REVOKE ALL ON FUNCTION public.sims_dashboard_facets() FROM anon, authenticated, PUBLIC;

-- The view looks up each SIM's active reseller by sim_id. The primary key is
-- (reseller_id, sim_id), which cannot serve a lookup by sim_id alone.
CREATE INDEX IF NOT EXISTS idx_reseller_sims_sim_id_active
  ON public.reseller_sims (sim_id) WHERE active = true;
