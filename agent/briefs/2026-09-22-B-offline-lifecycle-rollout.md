# Brief B — turn on the Offline SIM lifecycle (PR #109)

Status: IN PROGRESS — steps 1–2 and the optional TEST migration done 2026-09-22; waiting on step 3 (5h probe cycle, earliest digest read 2026-09-23 00:30 UTC). Owner: Zalmen. Created 2026-09-22 after the main-deploy run.

The code is live in PROD on `bad-rental-remediator` (version 89f93b91) and `dashboard` (77c607df). The PROD migration is applied. The feature is switched OFF.

Steps, in order:
1. Set `FINALIZER_RUN_SECRET` on `bad-rental-remediator` for test AND prod. It must equal the value already set on `reseller-sync`. Never print it.
2. Redeploy `bad-rental-remediator` with `--var OFFLINE_LIFECYCLE_ENABLED:true --var OFFLINE_LIFECYCLE_DRY_RUN:true` (from the main workspace, via `scripts/deploy.sh`).
3. Wait at least 5 hours so one full probe cycle completes.
4. Read the Slack digest of what it WOULD have done. Show the owner. Get a yes.
5. Redeploy with `OFFLINE_LIFECYCLE_ENABLED:true` and DRY_RUN removed.
Also: TEST lacks the `hosting_port_status_checks` table, so the lifecycle migration is not on TEST. Optional: apply `migrations/20260804_hosting_port_status_checks.sql` then the lifecycle migration to TEST.
Done when: step 5 is deployed, `agent/current-state.md` records the version id and the date it was enabled.
