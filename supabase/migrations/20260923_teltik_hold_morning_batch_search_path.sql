-- Pin search_path on teltik_hold_morning_batch (2026-09-23).
--
-- The function is SECURITY DEFINER (it runs as its owner, postgres) but had no
-- SET search_path, so it resolved `sims` and `reseller_sims` through the
-- caller's search_path. A caller who can put a same-named object earlier on
-- the path could make it run their code as postgres. Flagged by the 2026-09-18
-- review.
--
-- Body is byte-for-byte the PROD definition captured on 2026-09-23 with
-- pg_get_functiondef() (same as 20260918_teltik_hold_morning_batch.sql). The
-- only change is the SET clause. It needs only public (sims, reseller_sims);
-- everything else is pg_catalog, which is always searched. pg_temp is listed
-- last so temp objects can never shadow public ones.

CREATE OR REPLACE FUNCTION public.teltik_hold_morning_batch(p_batch integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_count int;
begin
  with picked as (
    select s.id,
           s.last_mdn_rotated_at AS last_rot,
           coalesce(s.rotation_interval_hours, 48) AS iv
    from sims s
    join reseller_sims rs on rs.sim_id = s.id and rs.active
    where s.vendor = 'teltik'
      and s.status = 'active'
      and s.rotation_hold_until is null
      and s.last_mdn_rotated_at is not null
      and extract(hour from s.last_mdn_rotated_at at time zone 'America/New_York') between 3 and 8
    order by extract(hour from s.last_mdn_rotated_at at time zone 'America/New_York') desc,
             s.last_mdn_rotated_at asc
    limit greatest(p_batch, 0)
  )
  update sims s
  set rotation_hold_until = (
    (date_trunc('day', (p.last_rot + make_interval(hours => p.iv)) at time zone 'America/New_York')
       + interval '1 day') at time zone 'America/New_York'
  )
  from picked p
  where s.id = p.id;
  get diagnostics v_count = row_count;
  return v_count;
end $function$;

-- PROD ACL: {postgres=X/postgres,service_role=X/postgres}. CREATE OR REPLACE
-- keeps it; restated so a fresh build ends up the same.
REVOKE ALL ON FUNCTION public.teltik_hold_morning_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.teltik_hold_morning_batch(integer) TO service_role;
