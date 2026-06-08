-- INC-17 / INC-16a — Bad-rental auto-remediator data model additions.
-- See docs/superpowers/plans/2026-06-07-bad-rental-auto-remediation.md §J.

create table if not exists rental_report_remediation_attempts (
  id               bigserial primary key,
  report_id        bigint not null references rental_reports(id) on delete cascade,
  attempt_no       int    not null,
  mode             text   not null,
  action           text   not null,
  attempted_at     timestamptz not null default now(),
  outcome          text   not null,
  evidence         jsonb,
  error_message    text,
  next_review_at   timestamptz
);

create index if not exists rrra_report_idx
  on rental_report_remediation_attempts (report_id, attempted_at desc);

create index if not exists rrra_next_review_idx
  on rental_report_remediation_attempts (next_review_at)
  where next_review_at is not null;

alter table rental_reports
  add column if not exists auto_remediation_state text,
  add column if not exists last_auto_attempt_at   timestamptz,
  add column if not exists escalation_reason      text,
  add column if not exists verify_pending_nonce   text,
  add column if not exists verify_pending_sent_at timestamptz;

-- Index used by the remediator's intake query: cheap scan of open reports
-- whose auto state is not paused/locked/verify-pending.
create index if not exists rental_reports_auto_state_idx
  on rental_reports (auto_remediation_state, received_at)
  where status in ('received','in_triage');
