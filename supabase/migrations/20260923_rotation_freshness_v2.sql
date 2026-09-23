-- rotation_freshness v2 (2026-09-23). Same name, same arguments (none), same
-- return columns, so the dashboard call in src/dashboard/index.js is unchanged.
--
-- Two changes from 20260918_rotation_freshness.sql:
--
-- 1. Window. Was hardcoded off sims.carrier (48h T-Mobile, 24h otherwise). Now
--    uses the SIM's own sims.rotation_interval_hours, the interval
--    claim_rotation_slot enforces, and falls back to the old 48/24 when it is
--    null. window_hours is still max(window) per vendor.
--
-- 2. "Alive" check. Was LIKE '%"rentalId"%' on the stored partner reply. Now,
--    when the reply is a JSON object, the SIM is fresh only if the object's
--    top-level rentalId is present and not null. A reply that is not valid
--    JSON still falls back to the old text match, so a non-JSON reply shape
--    cannot drop the counts to zero. As of 2026-09-23 every recent
--    number.online reply in PROD is {"success", "message", "rentalId"}.
--
-- Before replacing, the new body ran on PROD side by side with the old one
-- under a temporary name; see agent/decision-log.md 2026-09-23 for the numbers.

CREATE OR REPLACE FUNCTION public.rotation_freshness()
 RETURNS TABLE(vendor text, window_hours integer, total bigint, fresh bigint, stale bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with assigned_sims as (
    select s.id, s.vendor,
      coalesce(s.rotation_interval_hours,
               case when s.carrier = 'tmobile' then 48 else 24 end) as win_h,
      sn.e164
    from sims s
    join reseller_sims rs on rs.sim_id = s.id and rs.active = true
    left join sim_numbers sn on sn.sim_id = s.id and sn.valid_to is null
  ),
  fresh_ids as (
    select distinct a.id
    from assigned_sims a
    join webhook_deliveries wd
      on wd.event_type = 'number.online'
     and wd.status = 'delivered'
     and (wd.payload->'data'->>'number') = a.e164
     and (wd.payload->'data'->>'sim_id') = a.id::text
     and wd.delivered_at >= now() - make_interval(hours => a.win_h)
     and case
           when wd.response_body is json object
             then (wd.response_body::jsonb ->> 'rentalId') is not null
           else wd.response_body like '%"rentalId"%'
         end
  )
  select a.vendor,
    max(a.win_h)::int as window_hours,
    count(*)::bigint as total,
    count(*) filter (where fi.id is not null)::bigint as fresh,
    count(*) filter (where fi.id is null)::bigint as stale
  from assigned_sims a
  left join fresh_ids fi on fi.id = a.id
  group by a.vendor
  order by a.vendor;
$function$;

REVOKE ALL ON FUNCTION public.rotation_freshness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotation_freshness() TO service_role;
