-- Teltik night-migration (applied via MCP 2026-06-16 as migration
-- "teltik_night_migration"). Re-anchors morning-rotating Teltik lines to
-- midnight, 100/day, by deferring each past its next due slot. Additive:
-- one nullable column + one function. Nothing existing is modified.

alter table sims add column if not exists rotation_hold_until timestamptz;
comment on column sims.rotation_hold_until is
  'If set and in the future, teltik-worker skips this SIM until then. Used to defer a morning-anchored line past its next due slot so it re-rotates at the following NY midnight. Cleared automatically on rotation.';

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
      and extract(hour from s.last_mdn_rotated_at at time zone 'America/New_York') between 6 and 8
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
