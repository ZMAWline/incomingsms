# Brief B — turn on the Offline SIM lifecycle (PR #109)

Status: IN PROGRESS — dry-run restarted at 2026-09-22 22:06 UTC (version `505b4387`; the 19:24 `--var` flags were dropped by later deploys and now live in wrangler.toml). Step 3: earliest digest read 2026-09-23 03:06 UTC (+5h; first hourly tick after that is 04:00 UTC). Step 5 = remove the `OFFLINE_LIFECYCLE_DRY_RUN` line from `src/bad-rental-remediator/wrangler.toml` and deploy with `scripts/deploy.sh bad-rental-remediator`. Owner: Zalmen. Created 2026-09-22 after the main-deploy run.

The code is live in PROD on `bad-rental-remediator` (version 89f93b91) and `dashboard` (77c607df). The PROD migration is applied. The feature is switched OFF.

Steps, in order:
1. Set `FINALIZER_RUN_SECRET` on `bad-rental-remediator` for test AND prod. It must equal the value already set on `reseller-sync`. Never print it.
2. Both flags are in `src/bad-rental-remediator/wrangler.toml` `[vars]` (PR #123); never use `--var` for them — a later deploy drops it.
3. Wait at least 5 hours so one full probe cycle completes.
4. Read the Slack digest of what it WOULD have done. Show the owner. Get a yes.
5. Delete the `OFFLINE_LIFECYCLE_DRY_RUN` line from wrangler.toml, merge, and deploy with `scripts/deploy.sh bad-rental-remediator`.
Also: TEST lacks the `hosting_port_status_checks` table, so the lifecycle migration is not on TEST. Optional: apply `migrations/20260804_hosting_port_status_checks.sql` then the lifecycle migration to TEST.
Done when: step 5 is deployed, `agent/current-state.md` records the version id and the date it was enabled.
