-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef(). This function was live in PROD but had NO definition
-- anywhere in the repo, so a database rebuild would have silently lost it.
--
-- Called by:
--   src/teltik-worker/index.js:86 and :144 — supabaseRpc 'teltik_hold_morning_batch'
--
-- What it does: Teltik SIMs that last rotated between 03:00 and 08:59 New York
-- time would keep rotating in that same early-morning window forever. This
-- pushes their next rotation to the following calendar day by setting
-- rotation_hold_until, in batches of p_batch (default 100), so the fleet drifts
-- out of the overnight window instead of being reset all at once.
--
-- NOTE for reviewers, two things worth knowing:
--   1. Unlike every other function captured in this batch, the live PROD copy
--      has NO `SET search_path`. It is SECURITY DEFINER without a pinned
--      search_path, which is the shape Supabase's own linter flags. Reproduced
--      here exactly as live; hardening it is a separate decision, not a capture.
--   2. It only picks rows where rotation_hold_until IS NULL, so re-running it is
--      safe, but it takes no lock beyond the UPDATE — two concurrent cron ticks
--      would each pick a batch and the second would simply update fewer rows.
--
-- TEST DRIFT: this function does NOT exist at all in the TEST project
-- (lwapudjjlwkskijefxdz) as of 2026-09-18.

CREATE OR REPLACE FUNCTION public.teltik_hold_morning_batch(p_batch integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
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

-- Live PROD ACL: {postgres=X/postgres,service_role=X/postgres}
-- PUBLIC / anon / authenticated have NO execute. SECURITY DEFINER + mutates sims.
REVOKE ALL ON FUNCTION public.teltik_hold_morning_batch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teltik_hold_morning_batch(integer) FROM anon;
REVOKE ALL ON FUNCTION public.teltik_hold_morning_batch(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.teltik_hold_morning_batch(integer) TO service_role;
