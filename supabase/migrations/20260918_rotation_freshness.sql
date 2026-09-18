-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef(). Live in PROD, NO definition anywhere in the repo.
-- Additional missing function found during this audit; not on the original list.
--
-- Called by:
--   src/dashboard/index.js:956 — POST /rest/v1/rpc/rotation_freshness
--
-- What it does: per vendor, counts how many assigned SIMs have proven they are
-- reachable recently ("fresh") versus not ("stale"). A SIM counts as fresh if a
-- 'number.online' webhook for its current number was delivered inside its
-- vendor window (48h for T-Mobile, 24h otherwise) AND the receiving system
-- answered with a body containing "rentalId". Read-only.
--
-- NOTE for reviewers: freshness is decided by a LIKE '%"rentalId"%' match on the
-- stored HTTP response body, so a downstream partner changing its response shape
-- would silently mark the whole fleet stale. The window is also hardcoded off
-- s.carrier ('tmobile' => 48h), not off sims.rotation_interval_hours, so it can
-- disagree with the interval claim_rotation_slot actually enforces.
--
-- TEST DRIFT: this function does NOT exist at all in the TEST project
-- (lwapudjjlwkskijefxdz) as of 2026-09-18.

CREATE OR REPLACE FUNCTION public.rotation_freshness()
 RETURNS TABLE(vendor text, window_hours integer, total bigint, fresh bigint, stale bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with assigned_sims as (
    select s.id, s.vendor,
      case when s.carrier = 'tmobile' then 48 else 24 end as win_h,
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
     and wd.response_body like '%"rentalId"%'
     and wd.delivered_at >= now() - make_interval(hours => a.win_h)
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

-- Live PROD ACL: {postgres=X/postgres,service_role=X/postgres}
-- PUBLIC / anon / authenticated have NO execute. It is SECURITY DEFINER, so it
-- reads past RLS — keep it fenced to service_role.
REVOKE ALL ON FUNCTION public.rotation_freshness() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rotation_freshness() FROM anon;
REVOKE ALL ON FUNCTION public.rotation_freshness() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rotation_freshness() TO service_role;
