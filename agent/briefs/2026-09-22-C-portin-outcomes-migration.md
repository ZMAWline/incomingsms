# Brief C — the unapplied port-in outcomes migration (PR #79)

Status: DONE 2026-09-23 (branch `feat/portin-outcomes-wired`, deployed to PROD 2026-09-23 in ship 8, PR #127). Owner: Zalmen. Created 2026-09-22 after the main-deploy run.

PR #79 merged `migrations/20260904_atomic_portin_outcomes.sql` and a module that records each ATOMIC port-in result. The migration is NOT applied to PROD or TEST, and no worker calls the module yet.

Decide first: is this feature wanted now? If yes: read the migration, apply it to TEST then PROD via the Supabase connector's apply_migration, verify the table exists, then wire the module into `details-finalizer` (where port-in completion is recorded, around the `finalize_inquiry` logging) on a branch with tests, PR, owner's yes, merge, then `/main-deploy` from the main workspace. If no: delete the module and migration on a branch, PR, merge, and note the decision in `agent/decision-log.md`.
Done when: either the table exists in PROD and the worker writes to it, or the code is removed. `agent/current-state.md` records which.

## Outcome (2026-09-23)

Kept the feature. The sims columns from PR #79 were already live in PROD and written by #110; what was missing was a history the owner can read.

- `migrations/20260904_atomic_portin_outcomes.sql` now also creates `atomic_portin_outcomes` (one row per final port-in result: completed / failed / abandoned, carrier code, the carrier's human reason, scrubbed raw response, time) and backfills one row per SIM that already had a final result. Idempotent. Applied as `atomic_portin_outcomes` to TEST (1 backfill row) and PROD (164 rows: 146 completed, 18 failed).
- Writers: details-finalizer on CO completion (after finalizing), on 948 / 910 / 951, and on the 14-day max-age stop; bulk-activator when the carrier rejects a portinRequest. A failed history write is logged and never blocks finalization.
- Dashboard: `GET /api/sims/:id/portin-outcomes`; a "Port-in result" line in the SIM detail pop-up; the SIMs table port-in badge hover shows the latest reason.
- Deploy details-finalizer, bulk-activator and dashboard with `/main-deploy` after merge.
