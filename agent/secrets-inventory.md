# Secrets and keys inventory

Snapshot taken 2026-09-23 from the live Cloudflare workers (names only, never values).
Refresh it with `scripts/list-live-vars.py` (see "Keep this current").

## How we manage keys

1. **Secrets go in with `wrangler secret put`, nothing else.** From the worker's own dir:
   `cd src/<worker> && printf '%s' "$VALUE" | npx wrangler secret put <NAME>` for PROD, add `--env test` for TEST.
   Use `printf`, never `echo` (a trailing newline breaks URL secrets; constraints.md §4).
   A secret takes effect at once and survives every deploy.
2. **Flags and plain settings go in `wrangler.toml` `[vars]`** (and `[env.test.vars]`), never `--var` and never as a secret.
   `wrangler deploy` replaces every plain var with what the toml says.
3. **`scripts/deploy.sh` refuses a deploy that would drop a live var** (`scripts/check_live_vars.py`). If it stops you, add the var to the toml; do not reach for `--allow-var-drop`.
4. **Never paste a value into chat, a commit, a PR, a log, or a doc.** Pipe it from a file: `printf '%s' "$(cat ~/.config/incomingsms/<FILE>)" | npx wrangler secret put <NAME>`.
5. **Where the key files live on this server:**
   - `~/.config/cloudflare/env`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (wrangler login; auto-sourced by the shell).
   - `~/.config/incomingsms/`: `BAD_RENTAL_CSV_KEY`, `agent-api-key.prod`, `agent-api-key.test`.
   - GitHub Actions secrets (`gh secret list`): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `DASHBOARD_AUTH` (all set 2026-09-08), used by `.github/workflows/dashboard-pr-preview.yml`.
   - Supabase dashboard: the service-role and anon keys for PROD (`lzjqegxazqlktttyybth`) and TEST (`lwapudjjlwkskijefxdz`).
   - No `.dev.vars` files exist in the repo.
   - Vendor-held: ATOMIC (dan@wingalpha.com), Teltik (shlomo@teltik.com), Helix, TP-Link (KASA), Intuit (QuickBooks), NOWPayments, Resend, Slack.
6. **Rotating a shared secret:** every worker that holds it must get the new value in the same few minutes, or calls between them fail with 401. The "Lives in" column lists them all.

## Keep this current

```bash
python3 scripts/list-live-vars.py            # tab-separated rows + the three gap lists
python3 scripts/list-live-vars.py --markdown # same rows as a markdown table
```

Read-only; prints names only. Run it after adding or deleting any secret, then update the table and gap lists below. About 10 seconds.

## Headline findings (2026-09-23)

1. **kasa-control PROD has no auth.** It is on workers.dev (`workers_dev = true`), `GET /outlets` and `POST /outlet` (power on/off/reboot) have no check at all, and `/reboot-gateways` is open because `ADMIN_RUN_SECRET` is not set on it. Anyone with the URL can switch the power strips. Fix: add an auth check to every route and set `ADMIN_RUN_SECRET` on kasa-control.
2. **42 live secrets no code reads** (delete candidates, list below). Most are Wing IoT, SkyLine (`SK_*`) and Helix address leftovers.
3. **Helix login is blocked.** mdn-rotator's 04:20 and 04:25 ticks logged `Token failed: 429 too_many_attempts ... account has been blocked after multiple consecutive login attempts`. PROD has 0 active Helix SIMs, so nothing breaks, but the rotator still fetches a token on every tick, which keeps the account locked. Stop the token fetch and delete the `HX_*` secrets, or get the Helix account unblocked if Helix is coming back.
4. **TEST is far behind PROD:** 105 secrets PROD has are missing on TEST. `bad-rental-remediator-test` has only `ADMIN_RUN_SECRET` and `FINALIZER_RUN_SECRET` (no Supabase, no carrier keys), `sim-status-changer-test` and `teltik-worker-test` have no Supabase keys. TEST runs of those workers cannot work.
5. **Three flags are stored as secrets** (`HELIX_ENABLED`, `APEX_PPU_THEN_MDN_ENABLED`, `RECONCILIATION_ENABLED`). They work, but belong in `[vars]` so the toml shows the real setting.

## Inventory

One row per name. "Code that reads it" is the `src/` dirs that read `env.NAME` (src/shared is listed as `shared`; a worker that imports the shared module needs the name too). "Lives in" is what is deployed now: `secret` = Cloudflare secret, `[vars]` = wrangler.toml. `(test)` = the `--env test` worker. "Last set on record" is the latest date the notes mention setting it (agent/current-state.md, agent/decision-log.md); no rotation of any key is recorded anywhere.

| Name | Code that reads it | Lives in (live Cloudflare) | What it grants | How to rotate | Last set on record |
|---|---|---|---|---|---|
| `ADMIN_RUN_SECRET` | bad-rental-remediator, dashboard, details-finalizer, kasa-control, mdn-rotator, sms-ingest, teltik-worker | secret: bad-rental-remediator,bad-rental-remediator(test),dashboard,dashboard(test),details-finalizer,mdn-rotator,mdn-rotator(test),sms-ingest,teltik-worker | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | 2026-04-24 |
| `APEX_PPU_THEN_MDN_ENABLED` | mdn-rotator | secret: mdn-rotator | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `ASSIGNMENT_TTL_MINUTES` | otp-portal | [vars]: otp-portal | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `ATOMIC_API_URL` | bad-rental-remediator, bulk-activator, dashboard, mdn-rotator, ota-status-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),mdn-rotator,mdn-rotator(test),ota-status-sync,sim-canceller,sim-status-changer | AT&T ATOMIC (telgoo5) wholesale API login: activate, swap MDN, suspend, cancel AT&T lines. | Vendor: ask dan@wingalpha.com for new ATOMIC credentials, then `printf '%s' "$NEW" \| npx wrangler secret put <NAME> [--env test]` in every worker dir listed, then redeploy not needed (secrets apply at once). | unknown |
| `ATOMIC_PIN` | bad-rental-remediator, bulk-activator, dashboard, mdn-rotator, ota-status-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,mdn-rotator,mdn-rotator(test),ota-status-sync,sim-canceller,sim-status-changer | AT&T ATOMIC (telgoo5) wholesale API login: activate, swap MDN, suspend, cancel AT&T lines. | Vendor: ask dan@wingalpha.com for new ATOMIC credentials, then `printf '%s' "$NEW" \| npx wrangler secret put <NAME> [--env test]` in every worker dir listed, then redeploy not needed (secrets apply at once). | unknown |
| `ATOMIC_TOKEN` | bad-rental-remediator, bulk-activator, dashboard, mdn-rotator, ota-status-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,mdn-rotator,mdn-rotator(test),ota-status-sync,sim-canceller,sim-status-changer | AT&T ATOMIC (telgoo5) wholesale API login: activate, swap MDN, suspend, cancel AT&T lines. | Vendor: ask dan@wingalpha.com for new ATOMIC credentials, then `printf '%s' "$NEW" \| npx wrangler secret put <NAME> [--env test]` in every worker dir listed, then redeploy not needed (secrets apply at once). | unknown |
| `ATOMIC_USERNAME` | bad-rental-remediator, bulk-activator, dashboard, mdn-rotator, ota-status-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,mdn-rotator,mdn-rotator(test),ota-status-sync,sim-canceller,sim-status-changer | AT&T ATOMIC (telgoo5) wholesale API login: activate, swap MDN, suspend, cancel AT&T lines. | Vendor: ask dan@wingalpha.com for new ATOMIC credentials, then `printf '%s' "$NEW" \| npx wrangler secret put <NAME> [--env test]` in every worker dir listed, then redeploy not needed (secrets apply at once). | 2026-04-15 |
| `BAD_RENTAL_CSV_KEY` | dashboard | secret: dashboard,dashboard(test) | Lets the escalation CSV be downloaded from the dashboard. | New random value into `~/.config/incomingsms/BAD_RENTAL_CSV_KEY`, then put in src/dashboard both envs. | 2026-09-18 |
| `BAD_RENTAL_REMEDIATOR_ADMIN_SECRET` | dashboard | secret: dashboard,dashboard(test) | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |
| `BULK_RUN_SECRET` | bulk-activator, dashboard | secret: bulk-activator,bulk-activator(test),dashboard,dashboard(test) | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |
| `CANCEL_SECRET` | dashboard, sim-canceller | secret: dashboard,dashboard(test),sim-canceller,sim-canceller(test) | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |
| `COMPOSIO_API_KEY` | **none** | secret: dashboard | Composio integration key (no code reads it). | Delete candidate. | unknown |
| `CRON_BATCH` | **none** | secret: dashboard(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `CRON_WAIT_MS` | **none** | secret: dashboard(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `DASHBOARD_AUTH` | dashboard | secret: dashboard,dashboard(test) | Dashboard basic-auth credentials (also a GitHub Actions secret for PR previews). | Put a new value in src/dashboard (both envs) and `gh secret set DASHBOARD_AUTH`. | 2026-09-08 |
| `DASHBOARD_BREAK_GLASS` | dashboard | secret: dashboard | Emergency dashboard login that bypasses normal user auth. | New random value, put in src/dashboard; store it offline. | unknown |
| `DASHBOARD_ENV` | dashboard | [vars]: dashboard,dashboard(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `DASHBOARD_SESSION_SECRET` | dashboard | secret: dashboard,dashboard(test) | Signs dashboard login sessions. | `openssl rand -base64 48`, put in src/dashboard (both envs); logs every user out. | unknown |
| `FINALIZER_RUN_SECRET` | bad-rental-remediator, dashboard, details-finalizer, reseller-sync | secret: bad-rental-remediator,bad-rental-remediator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),reseller-sync,reseller-sync(test) | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | 2026-09-22 |
| `GATEWAY_SECRET` | sms-ingest | secret: dashboard(test),sms-ingest,sms-ingest(test) | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |
| `GATEWAY_STATUS_API_KEY` | dashboard | secret: dashboard | Lets the Wing gateway-status API caller read dashboard status. | New random value, put in src/dashboard, give it to the caller. | unknown |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **none** | secret: dashboard(test) | Google service account for the Sheets export (TEST only; no code reads it now). | Delete candidate, or rotate in Google Cloud IAM > service account > keys. | unknown |
| `HELIX_ENABLED` | bulk-activator, dashboard, details-finalizer, ota-status-sync, sim-canceller, sim-status-changer | secret: bulk-activator,dashboard,details-finalizer,mdn-rotator,ota-status-sync,sim-canceller,sim-status-changer | Flag, not a secret: turns Helix code paths on/off. | Move to `[vars]` in wrangler.toml; `wrangler secret delete` after. | 2026-04-15 |
| `HX_ACTIVATION_CLIENT_ID` | bulk-activator, dashboard, mdn-rotator | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_ADDRESS1` | **none** | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | 2026-04-16 |
| `HX_API_BASE` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, ota-status-sync, phone-number-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),mdn-rotator,mdn-rotator(test),ota-status-sync,phone-number-sync,phone-number-sync(test),reseller-sync,sim-canceller,sim-canceller(test),sim-status-changer | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_AUDIENCE` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, ota-status-sync, phone-number-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),mdn-rotator,mdn-rotator(test),ota-status-sync,phone-number-sync,phone-number-sync(test),reseller-sync,sim-canceller,sim-canceller(test),sim-status-changer | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_BAN` | bulk-activator, mdn-rotator | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_CITY` | **none** | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_CLIENT_ID` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, ota-status-sync, phone-number-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),mdn-rotator,mdn-rotator(test),ota-status-sync,phone-number-sync,phone-number-sync(test),reseller-sync,sim-canceller,sim-canceller(test),sim-status-changer | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_FAN` | bulk-activator, mdn-rotator | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_GRANT_PASSWORD` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, ota-status-sync, phone-number-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),mdn-rotator,mdn-rotator(test),ota-status-sync,phone-number-sync,phone-number-sync(test),reseller-sync,sim-canceller,sim-canceller(test),sim-status-changer | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_GRANT_USERNAME` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, ota-status-sync, phone-number-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),mdn-rotator,mdn-rotator(test),ota-status-sync,phone-number-sync,phone-number-sync(test),reseller-sync,sim-canceller,sim-canceller(test),sim-status-changer | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_PLAN_ID` | bulk-activator, mdn-rotator | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_STATE` | **none** | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_TOKEN_URL` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, ota-status-sync, phone-number-sync, shared, sim-canceller, sim-status-changer | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),mdn-rotator,mdn-rotator(test),ota-status-sync,phone-number-sync,phone-number-sync(test),reseller-sync,sim-canceller,sim-canceller(test),sim-status-changer | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | unknown |
| `HX_ZIP` | mdn-rotator | secret: bulk-activator,bulk-activator(test),dashboard(test),mdn-rotator | Helix (AT&T SOLO) OAuth client/login and activation defaults. Helix is quarantined (`HELIX_ENABLED`), token login is currently blocked (429). | Vendor: get new Helix OAuth client/password from the Helix account owner, then `wrangler secret put` in each dir listed. | 2026-04-17 |
| `KASA_PASSWORD` | kasa-control | secret: kasa-control | TP-Link cloud login for the KASA power strips. | Change the TP-Link account password, then put both names in src/kasa-control. | unknown |
| `KASA_USERNAME` | kasa-control | secret: kasa-control | TP-Link cloud login for the KASA power strips. | Change the TP-Link account password, then put both names in src/kasa-control. | unknown |
| `LOGIN_SESSION_TTL_MINUTES` | otp-portal, teltik-portal | [vars]: otp-portal,teltik-portal | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `OFFLINE_LIFECYCLE_DRY_RUN` | bad-rental-remediator | [vars] not deployed: bad-rental-remediator(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | 2026-09-22 |
| `OFFLINE_LIFECYCLE_ENABLED` | bad-rental-remediator | [vars]: bad-rental-remediator; [vars] not deployed: bad-rental-remediator(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | 2026-09-23 |
| `OTP_PORTAL_PASSWORD_HASH` | otp-portal | secret: otp-portal | Login and session signing for the OTP portal. | Same as the Teltik portal. | unknown |
| `OTP_PORTAL_SESSION_SECRET` | otp-portal | secret: otp-portal | Login and session signing for the OTP portal. | Same as the Teltik portal. | unknown |
| `OTP_PORTAL_USERNAME` | otp-portal | secret: otp-portal | Login and session signing for the OTP portal. | Same as the Teltik portal. | unknown |
| `PORTAL_SESSION_SECRET` | reseller-portal | secret: reseller-portal | Signs reseller-portal login sessions. | `openssl rand -base64 48 \| tr -d '\n'`, `wrangler secret put` in src/reseller-portal (logs every reseller out). | 2026-05-10 |
| `QBO_CLIENT_ID` | quickbooks | secret: quickbooks | QuickBooks Online OAuth app credentials (invoices). | Intuit developer portal > app > Keys: regenerate the client secret, put in src/quickbooks, then re-run the OAuth connect flow. | unknown |
| `QBO_CLIENT_SECRET` | quickbooks | secret: quickbooks | QuickBooks Online OAuth app credentials (invoices). | Intuit developer portal > app > Keys: regenerate the client secret, put in src/quickbooks, then re-run the OAuth connect flow. | unknown |
| `QBO_REDIRECT_URI` | quickbooks | secret: quickbooks | QuickBooks Online OAuth app credentials (invoices). | Intuit developer portal > app > Keys: regenerate the client secret, put in src/quickbooks, then re-run the OAuth connect flow. | unknown |
| `RECONCILIATION_ENABLED` | details-finalizer | secret: details-finalizer | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | 2026-04-29 |
| `RELAY_KEY` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, kasa-control, mdn-rotator, ota-status-sync, phone-number-sync, quickbooks, reseller-sync, shared, sim-canceller, sim-status-changer, sms-ingest, storefront, teltik-portal, teltik-worker | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,details-finalizer,kasa-control,mdn-rotator,mdn-rotator(test),ota-status-sync,sim-canceller,sim-status-changer | Access to the outbound relay at relay.zmawsolutions.com (VPS 74.208.37.8) that fronts all carrier calls. | Set a new key on the relay service on the VPS, then `wrangler secret put RELAY_KEY` in every dir listed, same minute (old key stops working at once). | 2026-04-15 |
| `RELAY_URL` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, kasa-control, mdn-rotator, ota-status-sync, phone-number-sync, quickbooks, reseller-sync, shared, sim-canceller, sim-status-changer, sms-ingest, storefront, teltik-portal, teltik-worker | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,details-finalizer,kasa-control,mdn-rotator,mdn-rotator(test),ota-status-sync,sim-canceller,sim-status-changer | Access to the outbound relay at relay.zmawsolutions.com (VPS 74.208.37.8) that fronts all carrier calls. | Set a new key on the relay service on the VPS, then `wrangler secret put RELAY_KEY` in every dir listed, same minute (old key stops working at once). | 2026-04-15 |
| `RENTAL_CAPTURE_ENABLED` | reseller-sync, teltik-worker | [vars]: reseller-sync,teltik-worker | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `RESELLER_WEBHOOK_URL` | **none** | secret: dashboard(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `SESSION_SECRET` | **none** | secret: storefront | Storefront session signing per the toml comment; no code reads it. | Delete candidate (confirm storefront login first). | 2026-05-10 |
| `SHEET_CSV_URL` | bulk-activator | secret: bulk-activator,dashboard(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `SKYLINE_BRIDGE_SECRET` | skyline-gateway | secret: dashboard(test),skyline-gateway,skyline-gateway(test) | Shared secret between workers and the skyline-gateway worker / Supabase Edge bridge (legacy SkyLine). | Generate `openssl rand -base64 32`; put the same value on skyline-gateway, every caller listed, and the Supabase Edge Function secret. | unknown |
| `SKYLINE_SECRET` | bad-rental-remediator, dashboard, mdn-rotator, skyline-gateway | secret: bad-rental-remediator,dashboard,dashboard(test),mdn-rotator,skyline-gateway,skyline-gateway(test) | Shared secret between workers and the skyline-gateway worker / Supabase Edge bridge (legacy SkyLine). | Generate `openssl rand -base64 32`; put the same value on skyline-gateway, every caller listed, and the Supabase Edge Function secret. | unknown |
| `SK_HOST` | **none** | secret: dashboard(test),details-finalizer,details-finalizer(test) | Old SkyLine gateway HTTP login (legacy hardware, no production SIMs). | Do not rotate: delete candidate. | unknown |
| `SK_PASSWORD` | **none** | secret: dashboard(test),details-finalizer,details-finalizer(test) | Old SkyLine gateway HTTP login (legacy hardware, no production SIMs). | Do not rotate: delete candidate. | unknown |
| `SK_PORT` | **none** | secret: dashboard(test),details-finalizer,details-finalizer(test) | Old SkyLine gateway HTTP login (legacy hardware, no production SIMs). | Do not rotate: delete candidate. | unknown |
| `SK_USERNAME` | **none** | secret: dashboard(test),details-finalizer,details-finalizer(test) | Old SkyLine gateway HTTP login (legacy hardware, no production SIMs). | Do not rotate: delete candidate. | unknown |
| `SLACK_NOTIFY_SUCCESS` | mdn-rotator | secret: dashboard(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `SLACK_WEBHOOK_URL` | bad-rental-remediator, mdn-rotator | secret: bad-rental-remediator,dashboard(test),mdn-rotator | Posts to the ops Slack channel. | Slack app > Incoming Webhooks: add a new URL, put it in each dir listed, delete the old one. | unknown |
| `STATUS_SECRET` | dashboard, sim-status-changer | secret: dashboard,dashboard(test),sim-status-changer | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |
| `SUPABASE_SERVICE_ROLE_KEY` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, kasa-control, mdn-rotator, ota-status-sync, reseller-portal, reseller-sync, shared, sim-canceller, sim-status-changer, skyline-gateway, sms-ingest, storefront, teltik-worker | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),kasa-control,mdn-rotator,mdn-rotator(test),ota-status-sync,otp-portal,phone-number-sync,phone-number-sync(test),reseller-portal,reseller-portal(test),reseller-sync,reseller-sync(test),sim-canceller,sim-canceller(test),sim-status-changer,skyline-gateway,skyline-gateway(test),sms-ingest,sms-ingest(test),storefront,teltik-portal,teltik-worker | Full read/write on the whole database, bypasses RLS. The most powerful key. | Supabase dashboard > Project Settings > API keys (PROD lzjqegxazqlktttyybth, TEST lwapudjjlwkskijefxdz): create a new secret key, `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` in every dir listed (PROD and `--env test` with the matching project), check each worker, then revoke the old key. | 2026-04-26 |
| `SUPABASE_URL` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, kasa-control, mdn-rotator, ota-status-sync, reseller-portal, reseller-sync, shared, sim-canceller, sim-status-changer, skyline-gateway, sms-ingest, storefront, teltik-portal, teltik-worker | secret: bad-rental-remediator,bulk-activator,bulk-activator(test),dashboard,dashboard(test),details-finalizer,details-finalizer(test),kasa-control,mdn-rotator,mdn-rotator(test),ota-status-sync,otp-portal,phone-number-sync,phone-number-sync(test),reseller-portal,reseller-portal(test),reseller-sync,reseller-sync(test),sim-canceller,sim-canceller(test),sim-status-changer,skyline-gateway,skyline-gateway(test),sms-ingest,sms-ingest(test),storefront,teltik-portal,teltik-worker | Not secret: which Supabase project a worker talks to. | Does not rotate. Must match the project of the service-role key. | 2026-04-26 |
| `SYNC_SECRET` | dashboard, phone-number-sync | secret: dashboard,dashboard(test),phone-number-sync,phone-number-sync(test) | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |
| `TELTIK_API_KEY` | bad-rental-remediator, dashboard, details-finalizer, shared, teltik-portal, teltik-worker | secret: bad-rental-remediator,dashboard,details-finalizer,teltik-portal,teltik-worker | Teltik SMS gateway API (api.smsgateway.xyz): every hosted line: read SMS, change number, reset ports. | Vendor: ask shlomo@teltik.com for a new API key, then `wrangler secret put TELTIK_API_KEY` in each dir listed. | 2026-04-24 |
| `TELTIK_LIFECYCLE_SECRET` | teltik-worker | secret: teltik-worker | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |
| `TELTIK_MIGRATION_BATCH` | teltik-worker | [vars]: teltik-worker | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `TELTIK_NIGHT_MIGRATION` | teltik-worker | [vars]: teltik-worker | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | 2026-06-16 |
| `TELTIK_PORTAL_PASSWORD_HASH` | teltik-portal | secret: teltik-portal | Login and session signing for the Teltik portal. | Password: new PBKDF2 hash, `wrangler secret put`. Session secret: `openssl rand -base64 48` (logs everyone out). | unknown |
| `TELTIK_PORTAL_SESSION_SECRET` | teltik-portal | secret: teltik-portal | Login and session signing for the Teltik portal. | Password: new PBKDF2 hash, `wrangler secret put`. Session secret: `openssl rand -base64 48` (logs everyone out). | unknown |
| `TELTIK_PORTAL_USERNAME` | teltik-portal | secret: teltik-portal | Login and session signing for the Teltik portal. | Password: new PBKDF2 hash, `wrangler secret put`. Session secret: `openssl rand -base64 48` (logs everyone out). | unknown |
| `TELTIK_REANCHOR_FROM_HOUR` | **none** | [vars]: teltik-worker | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | 2026-07-06 |
| `TELTIK_ROTATE_CONCURRENCY` | teltik-worker | [vars]: teltik-worker | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `TELTIK_WEBHOOK_SECRET` | teltik-worker | secret: teltik-worker | Proves inbound SMS webhooks really come from Teltik. | New random value, `wrangler secret put` on teltik-worker, then re-run `/setup-webhook` so Teltik posts with the new value. | unknown |
| `WING_EXPECTED_RATE` | **none** | [vars]: dashboard,dashboard(test) | Plain setting, not a secret. | Change in wrangler.toml `[vars]`, then deploy with scripts/deploy.sh. | unknown |
| `WING_IOT_API_KEY` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, shared | secret: bad-rental-remediator,bulk-activator,dashboard,details-finalizer,mdn-rotator | Wing IoT (AT&T IoT) REST login. All Wing SIMs are cancelled; dead in PROD. | Do not rotate: delete (`npx wrangler secret delete <NAME>`) once the Wing code paths are removed. | unknown |
| `WING_IOT_BASE_URL` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, shared | secret: bulk-activator,mdn-rotator | Wing IoT (AT&T IoT) REST login. All Wing SIMs are cancelled; dead in PROD. | Do not rotate: delete (`npx wrangler secret delete <NAME>`) once the Wing code paths are removed. | unknown |
| `WING_IOT_USERNAME` | bad-rental-remediator, bulk-activator, dashboard, details-finalizer, mdn-rotator, shared | secret: bad-rental-remediator,bulk-activator,dashboard,details-finalizer,mdn-rotator | Wing IoT (AT&T IoT) REST login. All Wing SIMs are cancelled; dead in PROD. | Do not rotate: delete (`npx wrangler secret delete <NAME>`) once the Wing code paths are removed. | unknown |
| `WORKER_SECRET` | ota-status-sync | secret: ota-status-sync | Shared secret one worker sends to another (or an admin sends) to call a protected endpoint. | `openssl rand -hex 32`, put the SAME value in every dir listed, in the same minute, both envs as needed. | unknown |

### Live secrets no code reads (delete candidates) (42)
- bulk-activator: HX_ADDRESS1
- bulk-activator: HX_CITY
- bulk-activator: HX_STATE
- bulk-activator: HX_ZIP
- bulk-activator-test: HX_ADDRESS1
- bulk-activator-test: HX_CITY
- bulk-activator-test: HX_STATE
- bulk-activator-test: HX_ZIP
- dashboard: COMPOSIO_API_KEY
- dashboard-test: CRON_BATCH
- dashboard-test: CRON_WAIT_MS
- dashboard-test: GATEWAY_SECRET
- dashboard-test: GOOGLE_SERVICE_ACCOUNT_JSON
- dashboard-test: HX_ADDRESS1
- dashboard-test: HX_BAN
- dashboard-test: HX_CITY
- dashboard-test: HX_FAN
- dashboard-test: HX_PLAN_ID
- dashboard-test: HX_STATE
- dashboard-test: HX_ZIP
- dashboard-test: RESELLER_WEBHOOK_URL
- dashboard-test: SHEET_CSV_URL
- dashboard-test: SKYLINE_BRIDGE_SECRET
- dashboard-test: SK_HOST
- dashboard-test: SK_PASSWORD
- dashboard-test: SK_PORT
- dashboard-test: SK_USERNAME
- dashboard-test: SLACK_NOTIFY_SUCCESS
- dashboard-test: SLACK_WEBHOOK_URL
- details-finalizer: SK_HOST
- details-finalizer: SK_PASSWORD
- details-finalizer: SK_PORT
- details-finalizer: SK_USERNAME
- details-finalizer-test: SK_HOST
- details-finalizer-test: SK_PASSWORD
- details-finalizer-test: SK_PORT
- details-finalizer-test: SK_USERNAME
- mdn-rotator: HELIX_ENABLED
- mdn-rotator: HX_ADDRESS1
- mdn-rotator: HX_CITY
- mdn-rotator: HX_STATE
- storefront: SESSION_SECRET

Also delete candidates: every `WING_IOT_*` and `SK_*` name (Wing cancelled, SkyLine retired) once their code paths are removed.

### Code reads with no live value that matter

The script lists 171 of these; most are harmless (optional settings with defaults, `RELAY_*` where the worker falls back to a direct call, dead Wing/Helix paths). The ones with real effect:

- **kasa-control (PROD): `ADMIN_RUN_SECRET`** missing, so `/reboot-gateways` is open (finding 1).
- **storefront (PROD): `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`** missing, so crypto deposits are off (manual mode, IPN returns 503). Intended if crypto is not launched.
- **details-finalizer (PROD): `RESEND_API_KEY`, `REPORT_EMAIL_FROM`, `REPORT_EMAIL_TO`** missing, so the report email is never sent.
- **sms-ingest, reseller-sync, teltik-worker, teltik-portal, quickbooks, storefront, phone-number-sync (PROD): `RELAY_URL`/`RELAY_KEY`** missing, so their outbound calls go direct, not through the relay (constraints.md §11 says every external call uses the relay).
- **bad-rental-remediator (PROD): `OFFLINE_LIFECYCLE_MAX_ACTIONS`** not set, so the code default cap applies.
- **reseller-portal-test: `PORTAL_SESSION_SECRET`**, **quickbooks-test: `QBO_*`**, and the TEST gaps in finding 4.
- `otp-portal-test`, `storefront-test`, `teltik-portal-test` are declared in wrangler.toml but not deployed (API 404).

### Non-PROD env missing a secret PROD has (105)
- bad-rental-remediator (test): ATOMIC_API_URL
- bad-rental-remediator (test): ATOMIC_PIN
- bad-rental-remediator (test): ATOMIC_TOKEN
- bad-rental-remediator (test): ATOMIC_USERNAME
- bad-rental-remediator (test): HX_API_BASE
- bad-rental-remediator (test): HX_AUDIENCE
- bad-rental-remediator (test): HX_CLIENT_ID
- bad-rental-remediator (test): HX_GRANT_PASSWORD
- bad-rental-remediator (test): HX_GRANT_USERNAME
- bad-rental-remediator (test): HX_TOKEN_URL
- bad-rental-remediator (test): RELAY_KEY
- bad-rental-remediator (test): RELAY_URL
- bad-rental-remediator (test): SKYLINE_SECRET
- bad-rental-remediator (test): SLACK_WEBHOOK_URL
- bad-rental-remediator (test): SUPABASE_SERVICE_ROLE_KEY
- bad-rental-remediator (test): SUPABASE_URL
- bad-rental-remediator (test): TELTIK_API_KEY
- bad-rental-remediator (test): WING_IOT_API_KEY
- bad-rental-remediator (test): WING_IOT_USERNAME
- bulk-activator (test): HELIX_ENABLED
- bulk-activator (test): SHEET_CSV_URL
- bulk-activator (test): WING_IOT_API_KEY
- bulk-activator (test): WING_IOT_BASE_URL
- bulk-activator (test): WING_IOT_USERNAME
- dashboard (test): ATOMIC_PIN
- dashboard (test): ATOMIC_TOKEN
- dashboard (test): ATOMIC_USERNAME
- dashboard (test): COMPOSIO_API_KEY
- dashboard (test): DASHBOARD_BREAK_GLASS
- dashboard (test): GATEWAY_STATUS_API_KEY
- dashboard (test): HELIX_ENABLED
- dashboard (test): RELAY_KEY
- dashboard (test): RELAY_URL
- dashboard (test): TELTIK_API_KEY
- dashboard (test): WING_IOT_API_KEY
- dashboard (test): WING_IOT_USERNAME
- details-finalizer (test): ADMIN_RUN_SECRET
- details-finalizer (test): HELIX_ENABLED
- details-finalizer (test): RECONCILIATION_ENABLED
- details-finalizer (test): RELAY_KEY
- details-finalizer (test): RELAY_URL
- details-finalizer (test): TELTIK_API_KEY
- details-finalizer (test): WING_IOT_API_KEY
- details-finalizer (test): WING_IOT_USERNAME
- kasa-control (test): KASA_PASSWORD
- kasa-control (test): KASA_USERNAME
- kasa-control (test): RELAY_KEY
- kasa-control (test): RELAY_URL
- kasa-control (test): SUPABASE_SERVICE_ROLE_KEY
- kasa-control (test): SUPABASE_URL
- mdn-rotator (test): APEX_PPU_THEN_MDN_ENABLED
- mdn-rotator (test): HELIX_ENABLED
- mdn-rotator (test): HX_ACTIVATION_CLIENT_ID
- mdn-rotator (test): HX_ADDRESS1
- mdn-rotator (test): HX_BAN
- mdn-rotator (test): HX_CITY
- mdn-rotator (test): HX_FAN
- mdn-rotator (test): HX_PLAN_ID
- mdn-rotator (test): HX_STATE
- mdn-rotator (test): HX_ZIP
- mdn-rotator (test): SKYLINE_SECRET
- mdn-rotator (test): SLACK_WEBHOOK_URL
- mdn-rotator (test): WING_IOT_API_KEY
- mdn-rotator (test): WING_IOT_BASE_URL
- mdn-rotator (test): WING_IOT_USERNAME
- quickbooks (test): QBO_CLIENT_ID
- quickbooks (test): QBO_CLIENT_SECRET
- quickbooks (test): QBO_REDIRECT_URI
- reseller-portal (test): PORTAL_SESSION_SECRET
- reseller-sync (test): HX_API_BASE
- reseller-sync (test): HX_AUDIENCE
- reseller-sync (test): HX_CLIENT_ID
- reseller-sync (test): HX_GRANT_PASSWORD
- reseller-sync (test): HX_GRANT_USERNAME
- reseller-sync (test): HX_TOKEN_URL
- sim-canceller (test): ATOMIC_API_URL
- sim-canceller (test): ATOMIC_PIN
- sim-canceller (test): ATOMIC_TOKEN
- sim-canceller (test): ATOMIC_USERNAME
- sim-canceller (test): HELIX_ENABLED
- sim-canceller (test): RELAY_KEY
- sim-canceller (test): RELAY_URL
- sim-status-changer (test): ATOMIC_API_URL
- sim-status-changer (test): ATOMIC_PIN
- sim-status-changer (test): ATOMIC_TOKEN
- sim-status-changer (test): ATOMIC_USERNAME
- sim-status-changer (test): HELIX_ENABLED
- sim-status-changer (test): HX_API_BASE
- sim-status-changer (test): HX_AUDIENCE
- sim-status-changer (test): HX_CLIENT_ID
- sim-status-changer (test): HX_GRANT_PASSWORD
- sim-status-changer (test): HX_GRANT_USERNAME
- sim-status-changer (test): HX_TOKEN_URL
- sim-status-changer (test): RELAY_KEY
- sim-status-changer (test): RELAY_URL
- sim-status-changer (test): STATUS_SECRET
- sim-status-changer (test): SUPABASE_SERVICE_ROLE_KEY
- sim-status-changer (test): SUPABASE_URL
- sms-ingest (test): ADMIN_RUN_SECRET
- teltik-worker (test): ADMIN_RUN_SECRET
- teltik-worker (test): SUPABASE_SERVICE_ROLE_KEY
- teltik-worker (test): SUPABASE_URL
- teltik-worker (test): TELTIK_API_KEY
- teltik-worker (test): TELTIK_LIFECYCLE_SECRET
- teltik-worker (test): TELTIK_WEBHOOK_SECRET

