-- =========================================================
-- Per-account saved filters for the SIMs table.
--
-- PR #104 shipped named saved filters in localStorage, which made them
-- per-browser: an operator who set up "Teltik offline" on the office machine
-- did not have it at home, and clearing site data lost the lot. They are a
-- per-person working set, so the account is the right owner.
--
-- `owner` is the authenticated principal's username, the same text the audit
-- trail puts in dashboard_audit_log.actor: a real account's username, the
-- literal 'break-glass', or 'apikey:<name>'. It is deliberately NOT
-- dashboard_users.id — break-glass and API-key callers have no row there
-- (resolveUser/breakGlassUser/resolveApiKeyUser in src/dashboard, where only
-- the session path carries an id), and a nullable FK would collapse every
-- keyless caller into one shared bucket. Text keeps the three principal kinds
-- in separate namespaces without a FK that two of them cannot satisfy.
--
-- Renaming a dashboard user therefore orphans their saved filters. That is
-- accepted: usernames are not renamed today, and the alternative costs the
-- break-glass and API-key cases.
--
-- `filter` is the whole captured view — server-side selections, toolbar
-- controls, search text, per-column filters and the sort. jsonb rather than
-- columns because the shape belongs to the frontend's SIMS_COLUMNS registry
-- and changes with it; the API validates size and type, not schema, and the
-- UI drops filters naming a column that no longer exists.
--
-- NOTE: TEST and PROD are DIFFERENT Supabase projects
-- (lwapudjjlwkskijefxdz and lzjqegxazqlktttyybth). Apply this to BOTH.
-- =========================================================

CREATE TABLE IF NOT EXISTS dashboard_saved_filters (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner      text NOT NULL,
  name       text NOT NULL,
  filter     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

-- Every read is "list mine", and the upsert path resolves ON CONFLICT through
-- the UNIQUE constraint above, so this covers both.
CREATE INDEX IF NOT EXISTS dashboard_saved_filters_owner_idx
  ON dashboard_saved_filters (owner, name);

-- RLS on with no policies, per the 2026-06-16 decision: every worker reaches
-- Supabase with the service-role key (which bypasses RLS) and nothing
-- client-side touches the DB directly, so this fully denies anon/authenticated
-- without affecting the app. Do NOT add anon policies here.
ALTER TABLE dashboard_saved_filters ENABLE ROW LEVEL SECURITY;
