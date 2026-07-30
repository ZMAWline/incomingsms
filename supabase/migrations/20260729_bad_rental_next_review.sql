-- Bad-rental reviewer deferral gate (t_688c3e93 operating-loop fixes).
-- Non-terminal outcomes (cooldown, classify_only tick, pending vendor read)
-- park the report until next_review_at instead of being re-fetched every
-- 5-minute tick. NULL = eligible now. The worker tolerates this column being
-- absent (legacy-query fallback) so the migration can land before or after
-- the worker deploy.

alter table rental_reports
  add column if not exists next_review_at timestamptz;

create index if not exists rental_reports_next_review_idx
  on rental_reports (next_review_at)
  where next_review_at is not null;
