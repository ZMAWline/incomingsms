-- rental_report_remediation_attempts has grown to 550k+ rows with no index
-- covering (action, attempted_at) — a query filtering on action + a recent
-- time window (e.g. the teltik-portal Analytics tab's reset-attempts count)
-- forces a sequential scan and hits Postgres's statement_timeout on this
-- table's size (confirmed live: error 57014, "canceling statement due to
-- statement timeout"). Partial index scoped to just the two Teltik reset
-- actions this query (and any future one like it) actually cares about,
-- keeping the index small relative to the full table.
-- CONCURRENTLY: this table is actively written by bad-rental-remediator
-- every ~15 minutes; a plain CREATE INDEX would take an exclusive lock for
-- the duration of the build over 550k+ rows. Must be run outside a
-- transaction block (not via a transaction-wrapped migration runner).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rrra_teltik_reset_attempted_at
  ON rental_report_remediation_attempts (attempted_at DESC)
  WHERE action IN ('teltik_reset_port', 'teltik_reset_network');
