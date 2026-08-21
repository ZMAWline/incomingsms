-- Every Teltik-hosted line whose LATEST recorded check is 'offline' right
-- now. Used by bad-rental-remediator's fleet-wide offline Slack digest
-- (src/bad-rental-remediator/notify.mjs#notifyOfflineFleetSummary) — that
-- alert used to only fire when a line already had an open bad-rental report
-- attached (a customer/reseller complaint), which misses the common case of
-- a line going offline with no report ever filed on it.
--
-- Latest-per-sim via DISTINCT ON, same pattern as
-- get_hosting_port_status_summary (migrations/20260804_hosting_port_status_checks.sql)
-- and already covered by the existing idx_hpsc_sim_checked_at index.
-- Filtering to state='offline' happens on the OUTER query, after the
-- per-sim latest row is picked — filtering inside the DISTINCT ON would
-- find "a line's most recent OFFLINE check" even if it's since recovered.
CREATE OR REPLACE FUNCTION get_teltik_currently_offline()
RETURNS TABLE (sim_id bigint, iccid text, mdn text, last_checked_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT sim_id, iccid, mdn, checked_at FROM (
    SELECT DISTINCT ON (c.sim_id) c.sim_id, c.iccid, c.mdn, c.state, c.checked_at
    FROM hosting_port_status_checks c
    WHERE c.sim_id IS NOT NULL
    ORDER BY c.sim_id, c.checked_at DESC
  ) latest
  WHERE latest.state = 'offline'
$$;
