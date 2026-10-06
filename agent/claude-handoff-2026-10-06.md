# Claude handoff — IncomingSMS, 2026-10-06

## Start here

The owner asked for a gradual overhaul of this production platform and now wants Claude to continue. The dashboard works; the owner explicitly confirmed the SIMs table feels faster after the latest performance fix. Complete focused modules in separate worktrees. Merge tested work into main and deploy production only from `/root/projects/incomingsms` on up-to-date `main`. Do not redeploy this session's completed work just because an older note calls it pending.

Read `agent/BOOTSTRAP.md`, `agent/constraints.md`, relevant local skills, then this handoff. `agent/current-state.md` contains extensive historical material; its older status claims are not a current checklist.

## Completed and live

| Work | Result |
| --- | --- |
| Billing cleanup | Extracted invoices, rates and carrier ledger to `src/dashboard/billing/`; added request validation, checked/bounded billing DB writes and JSON 404 for unknown API routes. Existing stored prices were not rewritten. |
| Auth refactor | `auth-routes.mjs` is a small facade over `src/dashboard/auth/{common,session,invites,profile,users}.mjs`; browser controls live in `public/static/dashboard-auth.js`. Central permissions, crypto and API-key implementation remain in their established modules. |
| Auth failure handling | Failed logout retains the cookie for retry. Failed session revocation after password/user updates reports explicit partial success. Malformed cookies/expiry timestamps fail safely; failed identity checks clear stale UI identity and privileged controls. |
| SIM table performance | SIMs/messages start independently of `/stats`; ready SIM rows display without waiting for fleet facets/status counts. Late counts update controls without rebuilding rows. Owner confirmed improvement. Backend query/aggregation costs were not optimized. |
| Last-admin race | Database statement triggers serialize destructive admin changes via a private guard row; final-admin removal rolls back and the dashboard returns HTTP 409. Concurrent demotion, disabling and deletion are covered. This is resolved. |
| Verification tooling | `npm run check` runs incremental strict types, 19 Worker builds, both dashboard syntax checks and tests. PR CI uses it. Browser test harnesses load local scripts in document order. Deploy script retains freshness, check and live-var guards. |

Latest deployed source: **`c99c777`** (`deployed/prod`). Dashboard version: **`fa07d6d2-8e4b-4607-99a3-ce57c10c2b2b`**, verified at 100% traffic. Main additionally contains documentation commits. Other Workers retain their previously deployed versions.

Migration **`supabase/migrations/20261006_preserve_last_dashboard_admin.sql`** is applied to both TEST and PROD through official Supabase MCP `apply_migration`. Do not reapply it as pending. Trigger function: `public.preserve_last_dashboard_admin`; triggers: `preserve_last_dashboard_admin_update` and `preserve_last_dashboard_admin_delete`. Do not replace it with a separate application count-and-update check.

Last full check: **1,324 tests passed**, 19 bundles compile, type/syntax and DB-literal constraint checks pass. Real isolated PostgreSQL integration checks also pass:

```bash
npm ci
npm run check
npm run check:db-constraints
node scripts/test-dashboard-admin-guard.mjs
```

The last command requires root and local PostgreSQL 16 binaries. It creates and removes its own temporary cluster, touches no hosted DB and verifies concurrent READ COMMITTED/REPEATABLE READ transactions, bulk rollback, admin handover, primary-key changes, login updates, restricted privileges and migration reapplication.

## Pending engineering work, in order

1. **Finish systematic browser verification.** The owner confirmed normal dashboard use, but automated UI coverage uses mocked DOM/network and we did not exercise named-user login/logout, password changes, invites, roles, billing forms and SIM filtering/paging in a real signed-in browser. Use an isolated test account and verify actual preview DB bindings first. Record outcomes; fix observed defects. Do not disable the sole production admin to test the guard.
2. **Bound SIM statistics requests and measure remaining latency.** `loadSimStats()` in `src/dashboard/index.js` still calls bare `fetch` for `get_sms_counts_24h` and `get_hosting_port_status_summary`. Replace with shared bounded Supabase transport, explicitly handle HTTP/network failure and decide how unavailable statistics appear without silently becoming valid zero counts. Preserve derived filtering/sorting semantics. Add tests for slow/failed RPCs. Measure `/api/sims`, `/api/sims/facets`, `/api/sims/status-counts` and `/api/stats` before optimizing indexes or changing SQL. Existing frontend waits are already fixed.
3. **Review login throttling under concurrency.** `src/dashboard/auth/session.mjs` reads `failed_login_count`, increments it in JS and patches it. Assess whether concurrent failed logins undercount attempts, and whether failed throttle writes are handled. This is a source-level risk to investigate, not a newly demonstrated production incident. Use transactional DB changes if needed, with real concurrency tests.
4. **Make multi-step billing operations recoverable.** Extraction and checked writes do not make invoice/ledger operations transactional or retry-safe. Identify concrete partial-failure paths, define observable partial results and safe recovery/idempotency, and test failures before changing financial behavior. Never blindly retry invoice creation or customer notifications.
5. **Continue the module overhaul.** Choose the next module from an evidence-based audit of active SIM/run workflows; a SIM API/UI boundary is a reasonable candidate after task 2. Preserve API contracts, roles, audit behavior and carrier-side effects. Refactor one bounded area at a time, then add strict typing where it provides value. Most legacy JS remains outside strict type checking; the repository overhaul is not complete.
6. **Reconcile project documentation.** Historical current-state/decision-log entries still describe old OAuth, rollout, billing and deployment statuses. Recheck before marking anything open or acting. `README.md` has stale worker descriptions (e.g. QuickBooks sign-in) relative to the deployed Composio implementation. Avoid treating old line numbers or old incident counts as current evidence.

## Operational follow-ups — separate from the code overhaul

The latest committed report, `agent/rotation-reviews/2026-10-06.md`, is a snapshot generated at 12:34 UTC, not a fresh live audit:

- 41 SIMs aged over six hours in stuck states (31 Atomic and 10 Teltik); 42 total stuck (32 Atomic and 10 Teltik). Its concluding prose says “32 of 41”; use the table for the distinction and requery live state.
- 200 previously open operator items, one newly created item, and 12 open bad-rental reports.
- No failures in that night's rotation window and zero delivery gaps, despite the aged backlog. Do not let the healthy nightly tally hide the persistent backlog.

Start with read-only diagnosis of these cohorts; do not mass-reactivate, cancel, reset or rotate SIMs based on this handoff. Carrier-side remediation needs its own scope and verified current state.

Other follow-ups to verify against newer evidence:

- Confirm the next TrustOTP weekly run on **2026-10-09 at 17:00 UTC** bills repeat rentals at $1 and preserves rental dates; code/migrations were already deployed under PR #144. Revised invoices 1455/1456/1458 were previously recorded as not re-emailed; confirm with the owner/current accounting state before any send. This handoff does not authorize sending messages.
- The old ledger “149 phantom Helix rows” note describes pagination truncation. Current extracted ledger queries use `supabaseGetAllArray`, so reproduce/reconcile before declaring that defect still present or changing historical ledger data.
- The old `mdn-rotator-test` TypeScript-entrypoint mismatch is **not present in current config**: both prod and test use `index.js`. Verify deployed test code if parity matters; do not blindly apply that old TODO.
- Earlier native QuickBooks OAuth reconnect tasks are superseded by the Composio implementation. Do not revive the removed OAuth/KV flow.

## Environment and release rules

- PROD Supabase: `lzjqegxazqlktttyybth`; separate TEST project: `lwapudjjlwkskijefxdz`. Worktrees share whichever database they target. Secret presence alone does not prove a Worker is configured for the expected project.
- Test has historical schema gaps, including rentals; verify requirements before preview testing. Read-only Cloudflare settings previously confirmed dashboard-test binds to named `*-test` Workers.
- **ATOMIC has no sandbox.** A test Worker can still use the live carrier account. Do not activate/cancel/rotate lines as a generic test.
- Apply schema changes through Supabase MCP `apply_migration`, separately from deployment, test first and verify PROD schema before shipping dependent code.
- Use the dashboard patch skill and both syntax checks. Plain LF files; no old template-literal escaping workflow.
- Deploy changed Workers only with `scripts/deploy.sh`; dashboard production needs `--env=""`. Never bypass freshness/live-var/check guards or use `ALLOW_UNSAFE_DEPLOY=1`.
- Cron, queue and service-binding changes require the repository's explicit operator confirmation. Keep legacy integrations behind their switches.
- Per-version previews use `wrangler versions upload --env test`; shared dashboard-test can be overwritten by another session. Version previews have host-only session cookies and service bindings resolve deployed test Workers, not coordinated preview versions.
- Use `npm`/`package-lock.json`. The original untracked `pnpm-lock.yaml` in the cetacean worktree is scaffolding noise; leave it alone.
- Credentials were used locally but are not included here. No temporary `/tmp` script is required to understand or reproduce the repository changes. Supabase's official hosted MCP supports existing personal access credentials; use the configured connector or an authorized MCP client without printing credentials.

## Suggested message to Claude

> Read `agent/BOOTSTRAP.md`, `agent/current-state.md`, and `agent/claude-handoff-2026-10-06.md`. Continue the pending engineering tasks in order, starting with browser verification and bounded SIM statistics requests. The billing/auth refactor, SIM loading fix and last-admin race fix are already deployed. Work in isolated worktrees, verify each module, merge tested changes, and deploy production from main only. Recheck historical operational notes before acting, and keep real carrier/accounting actions separate from the refactor.
