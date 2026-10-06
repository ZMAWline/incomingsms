-- get_hosting_port_status_summary: one indexed probe per SIM instead of a
-- sort over the whole check history.
--
-- The previous body picked each SIM's latest check with DISTINCT ON over every
-- hosting_port_status_checks row for the requested SIMs (~135 per SIM, 620k in
-- all), which sorts the full history, spilling to disk. On PROD 2026-10-06 the
-- whole Teltik fleet (4,611 SIMs) took 9.6-26 s, and the dashboard's SIMs
-- sort/filter on host port answered 503 when a 500-SIM chunk passed the 15 s
-- Supabase timeout.
--
-- Now, per requested SIM: the latest check is a LIMIT 1 read of
-- idx_hpsc_sim_latest in (checked_at DESC, id DESC) order, and the 24 h / 7 d
-- counts are a range read of the same index, which carries `state` so the
-- counts never visit the table.
--
-- Same signature, columns and results. Checked on PROD before applying: for
-- all 4,611 Teltik-hosted SIMs the old and new bodies returned the same 4,477
-- rows (EXCEPT ALL both ways empty). As before, a SIM with no checks returns
-- no row, and a repeated id returns one row.
--
-- Plain CREATE INDEX on ~620k rows blocks inserts into
-- hosting_port_status_checks for a few seconds; the checkers wait, not fail.

create index if not exists idx_hpsc_sim_latest
  on public.hosting_port_status_checks (sim_id, checked_at desc, id desc)
  include (state);

create or replace function public.get_hosting_port_status_summary(sim_ids bigint[])
returns table(
  sim_id bigint, last_state text, last_checked_at timestamptz, last_source text,
  last_mdn text, last_mdn_source text, last_http_status integer, last_error text,
  checks_24h integer, online_24h integer, checks_7d integer, online_7d integer
)
language sql
stable
as $$
  SELECT ids.sim_id, l.state, l.checked_at, l.source, l.mdn, l.mdn_source, l.http_status, l.error,
         st.checks_24h, st.online_24h, st.checks_7d, st.online_7d
  FROM (SELECT DISTINCT unnest(sim_ids) AS sim_id) ids
  CROSS JOIN LATERAL (
    SELECT c.state, c.checked_at, c.source, c.mdn, c.mdn_source, c.http_status, c.error
    FROM hosting_port_status_checks c
    WHERE c.sim_id = ids.sim_id
    ORDER BY c.checked_at DESC, c.id DESC
    LIMIT 1
  ) l
  CROSS JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE c.checked_at > now() - interval '24 hours')::int                       AS checks_24h,
      COUNT(*) FILTER (WHERE c.checked_at > now() - interval '24 hours' AND c.state = 'online')::int AS online_24h,
      COUNT(*)::int                                                                                  AS checks_7d,
      COUNT(*) FILTER (WHERE c.state = 'online')::int                                                AS online_7d
    FROM hosting_port_status_checks c
    WHERE c.sim_id = ids.sim_id AND c.checked_at > now() - interval '7 days'
  ) st
$$;
