# Brief C — the unapplied port-in outcomes migration (PR #79)

Status: OPEN. Owner: Zalmen. Created 2026-09-22 after the main-deploy run.

PR #79 merged `migrations/20260904_atomic_portin_outcomes.sql` and a module that records each ATOMIC port-in result. The migration is NOT applied to PROD or TEST, and no worker calls the module yet.

Decide first: is this feature wanted now? If yes: read the migration, apply it to TEST then PROD via the Supabase connector's apply_migration, verify the table exists, then wire the module into `details-finalizer` (where port-in completion is recorded, around the `finalize_inquiry` logging) on a branch with tests, PR, owner's yes, merge, then `/main-deploy` from the main workspace. If no: delete the module and migration on a branch, PR, merge, and note the decision in `agent/decision-log.md`.
Done when: either the table exists in PROD and the worker writes to it, or the code is removed. `agent/current-state.md` records which.
