-- Permanent night-guard: widen teltik_hold_morning_batch from NY hours 6-8 to
-- 3-8 (applied via MCP 2026-07-06 as migration "teltik_hold_widen_3_8").
--
-- Why: Teltik hard-enforces a 48h minimum between rotations and 48h is exactly
-- two days, so a line's rotation clock-time can only move LATER, never earlier.
-- Measured drift is ~30 min per cycle (cron tick granularity: the line just-
-- misses the tick exactly 48h after its last rotation) = ~15 min/day. Every
-- line therefore marches from midnight toward morning; the 6-8am pool refilled
-- at ~100 lines/day, exactly cancelling the migration's 100/night drain (pool
-- stuck at ~730 for 3 weeks). Catching drifters at 3am keeps anchors in the
-- 0-3am band. The hour-desc ordering still drains the worst offenders (7-8am)
-- before touching 3-5am lines. This guard is now PERMANENT — do not turn
-- TELTIK_NIGHT_MIGRATION off (see decision-log 2026-07-06).

create or replace function teltik_hold_morning_batch(p_batch int default 100)
returns int language plpgsql security definer as $$
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
end $$;
