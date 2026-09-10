# Current State

> This is a living document. Update it when things break, get fixed, or change meaningfully.
> Last updated: 2026-09-09 (dashboard shared password replaced with named users, invites and roles — LIVE IN PROD, break-glass off)

---

## Session 2026-09-09 — Dashboard multi-user auth shipped to production (PR #94)

The operator dashboard authenticated everyone with one shared HTTP Basic password
(`admin`/`dashboard123`). That is gone. Production now runs named accounts with
admin/operator/viewer roles, invite-based onboarding, revocable sessions, and a Profile
tab. Deployed as dashboard version `d0d68a5f`; `DASHBOARD_BREAK_GLASS=off` since
2026-09-09, verified `401` for the old shared password.

**Current prod auth state:** one admin account (`Zalmen`, active, has logged in). The
shared password no longer works. `DASHBOARD_SESSION_SECRET` is set on both `dashboard`
and `dashboard-test`; values are in the repo `.dev.vars` as `DASHBOARD_SESSION_SECRET_PROD`
/ `_TEST`. `DASHBOARD_AUTH` is still set on prod but inert while break-glass is off — that
is the re-entry path if auth ever breaks (delete the `DASHBOARD_BREAK_GLASS` secret).

**The finding that shaped the design:** many dashboard action routes have no HTTP method
guard, so a bare GET performs the action (`/api/activate`, `/api/cancel`, `/api/suspend`,
`/api/restore`, `/api/rotate-sim`, `/api/fix-sim`, `/api/send-test-sms`, `/api/sim-online`,
`/api/debug-cancel`). The permission model is therefore path-based and fails safe. See
decision-log 2026-09-09. **The missing method guards themselves were not fixed** — that is
a separate change touching the frontend's call sites, and is worth doing.

**Also this session:**
- `sims.gateway_host` was `NOT NULL DEFAULT 'skyline'` with no insert path setting it, so
  every new SIM was mislabeled. Fixed in three layers (DB default, 186-row PROD backfill,
  code fallback). PR #93.
- **Host-port check on that cohort — CORRECTED 2026-09-09.** An earlier run in this session
  reported 7 online / 0 offline / 107 error and concluded Teltik had no ports for those
  lines. **That conclusion was wrong and is retracted.** Re-running against current `main`
  gives **165 checked: 149 online, 10 offline, 6 error.**

  What happened: the 09-04 run resolved the host MDN as `db_current_mdn_unconfirmed` and
  queried Teltik with our own DB MDN. That number is never right for a Teltik-hosted line —
  Teltik keeps the FIRST MDN it saw and our rotations do not sync back, a rule already
  documented at the top of `src/shared/teltik-known-mdn.mjs`. Teltik's
  `404 Incorrect Phone Number` is a wrong-key error, not a dead line.

  Verified directly: for sim 36066 (`89012804332469395747`) port-status via our DB MDN
  `3855869698` returns 404, while via Teltik's MDN `9297213581` it returns
  `{"success":true,"status":"online"}`. **101 of the original 107 are present in
  `/v1/all-lines` with an MDN and a port.** `teltikInventoryLookup()` resolves that ICCID
  correctly today, so the resolver is not broken now — the 09-04 result predates
  intervening changes to this path.

  Endpoint notes worth keeping: `/v1/get-phone-number?iccid=` returns `404 Invalid ICCID`
  for these because it only covers Teltik's own T-Mobile SIMs, and these are AT&T ICCIDs in
  Teltik hardware. `/v1/all-lines` is the ICCID -> MDN source. `/v1/get-info` takes `mdn`
  only and rejects `iccid`.

  Real remaining work, both untracked CSVs in the repo root:
  - `teltik-offline-needs-port-reset-10.csv` — 10 lines in Teltik inventory reporting
    offline. The genuine port-reset candidates.
  - `teltik-not-in-inventory-6.csv` — 6 lines absent from `/v1/all-lines`. This small set,
    not 107, is the question for Shlomo.
- CI: the preview workflow wrote `DASHBOARD_AUTH` to a phantom `dashboard-test-test` worker
  (`--env test --name dashboard-test` makes wrangler append the env suffix). Fixed in PR #73;
  stray worker deleted. The Cloudflare API token in GitHub secrets was *also* independently
  expired and was refreshed. Both faults were real — see the correction note below.

**Method guards — DONE later the same day (PR #97, prod `6fc1282a`).** All nine routes now
require POST. A subagent audited every caller first: the SPA builds paths as
`API_BASE + '/cancel'`, so a literal grep finds nothing — the suffix form and both dynamic
dispatchers (`bulkStatusChange`, `_epFor`) were checked separately. **Every caller already
sent POST, so zero caller changes were needed.** No worker service-binds to the dashboard;
`/api/debug-cancel` has no caller at all. Same-named routes in `mdn-rotator`, `sim-canceller`,
`bulk-activator`, `sim-status-changer`, `teltik-worker` are those workers' OWN routes,
downstream — not callers.

Verified on dashboard-test (authenticated, so routing is reached): GET on the nine returns
the SPA shell and does not act; POST still reaches the handler and returns JSON. Note a
guarded GET falls through to `serveApp()` and returns 200 + HTML rather than 405, matching
every other guarded route — so curling `GET /api/cancel` to debug returns HTML, which is not
a fault.

The path-first role model in `shared/portal-auth.mjs` was deliberately KEPT as defence in
depth, and the new test asserts all nine stay in `ALWAYS_MUTATING`, so the two layers pin
each other. See decision-log 2026-09-09.

**`agent/constraints.md` corrected (PR #99).** §1 described the pre-2026-06-12 world (CRLF
`index.js`, `getHTML()` template literal, mandatory patch scripts) — all false since the
frontend moved to `public/index.html`; verified 0 CR bytes and 0 `getHTML` in both files.
Two further unrunnable instructions fixed in the same pass: §11 pointed at a
`_check_relay.js` that does not exist, and §6 named only one of the two live migration
directories (`supabase/migrations/` 24 files vs top-level `migrations/` 22 — both written to
this week, including by this session; documented, not reorganised).

**Stale PRs closed:** #85 (superseded by #99; was 3294 deletions behind and would have
removed `tests/portal-auth.test.mjs` and three other recent test files) and #87 (superseded
by #93; its diff only looked new because its merge base predates #93).

**Pending / next:**
- Two migration directories still coexist — needs a deliberate consolidation decision.
- `teltik-not-in-inventory-6.csv` — 6 ICCIDs to ask Shlomo about. **Not 107.**
- `teltik-offline-needs-port-reset-10.csv` — 10 genuine port-reset candidates.
- `main` clean; tests 815/815; prod dashboard `6fc1282a` verified healthy.
- Operational CSVs/XLSX in the repo root remain untracked by convention (PR #82 from another
  session proposes gitignoring them).

---

## Session 2026-09-08 — ATOMIC port-in auto-finalizer shipped (PR #72), 42-SIM backlog drained

`fix/atomic-portin-finalizer-record` had been sitting unpushed on a worktree since 2026-08-25 — code complete, tests green, never merged or deployed. Meanwhile the read-only `portinStatus` poll it was meant to replace had accumulated a backlog: **42 SIMs with `port_in_pending=true`, generating 11,232 `portinStatus` calls to the carrier in 24 hours.** The oldest completed ports had been sitting in `provisioning` for 14 days.

**PROD state before deploy:** 27 SIMs at `statusCode=00` (ports actually completed), 12 at `948`, 1 at `951`, 2 never polled.

**Status codes confirmed from live `carrier_api_logs`** — the `atomic-wholesale-api` skill lists this enum under "Unknowns", and the pre-existing code comment declined to interpret it for that reason. Real responses:

- Completed: `statusCode="00"`, `description="Success"`, `Result={"MSISDN":"…","reasonCode":"CO","reasonDescription":"Completed"}`. **`Result.reasonCode="CO"` is the completion signal.**
- `948`: `description="Error!!Port Request Does Not Exist"`, no `Result`. All 12 carried this description verbatim. Note `948` is overloaded across ATOMIC operations (see `decision-log.md` — it also means "Subscriber Must Be Active" on `swapMSISDN` and a plan/equipment mismatch on `reconnectSubscriber`), so matching on the bare code is a latent risk; matching on description would be safer.
- `951`: `Result.reasonCode="CT"`, real reason embedded in the description as `statusReasonCode - <XX> ~ statusReasonDescription - <text>` (seen `8A` account number incorrect, `6B` T-Mobile transfer PIN incorrect).

**What shipped:** `runAtomicPortinStatusFinalizer` now ends the poll three ways — `948`/`910` terminal (clears `port_in_pending`, leaves `status` alone); `00`+`CO` runs `subsriberInquiry` by ICCID through the `MDN_ROTATOR` binding and finalizes to `status='active'`, `rotation_status='success'`, MDN/BAN/IMEI/activation date/zip, cleared errors, plus a `sim_numbers` roll if the MDN moved; anything else keeps polling. `port_in_pending` clears only after finalization succeeds, so a transient inquiry failure retries next tick. `mdn-rotator`'s `/atomic-inquiry` was widened to return `ban`/`imei`/`activationDate`/`zipCode`/raw `result` (same carrier call, wider projection).

**Deployed:** mdn-rotator `f227a41c-4f40-4670-b659-a44f0fae2967`, details-finalizer `356028b0-02c9-41c9-aa1a-47d5f16cac91`. **Cloudflare Workers Builds only runs as a PR check — it does NOT auto-deploy on merge to main.** Both workers still showed their 2026-09-04 deployments after the merge; `wrangler deploy` was required. Deploy `mdn-rotator` first, since `details-finalizer` depends on its wider inquiry response.

**Observed behavior:** the tick works the backlog serially at ~6s/SIM (`limit=50` on the 5-min cron). First tick finalized 19 SIMs to `active` and marked 8 terminal on `948`; every `finalize_inquiry` log row returned `statusCode=00`, `attStatus=Active`, zero errors.

**Known gaps, not fixed:**
- ~~**`951` is not terminal.**~~ **FIXED same day in PR #76** (details-finalizer `f30466c1`) — `951` added to the terminal set via a new `TERMINAL_REASONS` map. SIM 36217 went terminal on the 18:45 tick; `portinStatus` traffic is now zero.
- `910` has no live example; that branch ships unexercised.
- Tests assert against source text, not a stubbed carrier response — they prove the branches exist, not that they behave. **Partly addressed in #76**: the terminal-code tests now parse the `TERMINAL_REASONS` map and assert the set is exactly `{910, 948, 951}`. The completion path (`isCompleted`, `finalizeCompletedAtomicPortin`) is still source-text matching.
- Two SIMs (36054, 36073) sit at `port_in_pending=true` with `atomic_portin_status_code=null` and `status=active` — they have never polled successfully and predate this work. Unrelated to the finalizer; worth a look.

**Separate breakage found:** the `Deploy shared dashboard preview` workflow failed on PR #72 with `Invalid access token [code: 9109]` while setting `DASHBOARD_AUTH`. Unrelated to #72 (no dashboard or workflow files touched); merged past it. **This session read that error as an expired Cloudflare API token and said it needed a rotation from Zalmen — that was wrong.** PR #73 found the real cause: `wrangler secret put --env test --name dashboard-test` appends the env suffix to an explicit `--name`, so the write targeted a phantom `dashboard-test-test` worker, and Cloudflare reports a missing script as an auth error. Fixed by resolving the target from `[env.test]` in the config instead. Workflow green again as of 18:43 UTC.

**Correction to the note above (added 2026-09-09, with evidence).** The Cloudflare API
token *was* independently expired — that part was not wrong. Both faults were real and
stacked, and fixing only one would not have made the workflow green:

- `npx wrangler whoami` on this box reported "You are not authenticated" before a new
  token was issued, and the repo secret was still the one set 2026-08-03.
- The CI log shows two distinct failures: `/accounts/***/workers/scripts/dashboard-test-test/secrets`
  -> `Authentication error [code: 10000]`, and then a plain `/accounts` -> `Invalid access
  token [code: 9109]`. The second call lists the account and touches no script, so it
  cannot be explained by a missing worker.
- The run only went green after BOTH the GitHub secret was refreshed AND the `--name`
  bug was fixed (PR #73).

The phantom-worker diagnosis was the more interesting find and had been masked by the
dead token. The stray `dashboard-test-test` worker has since been deleted.

> Last updated: 2026-09-04 (infrastructure correction: all SIMs Teltik-hosted, all Wing IoT SIMs cancelled)

---

## 2026-09-04 — Infrastructure correction from Zalmen: SkyLine is legacy, Wing IoT is dead

Two standing facts that the repo docs (and `agent/project-map.md` in particular) still described as
current. Both are now corrected in the project map; recording them here as the authoritative note.

1. **All SIMs are hosted by Teltik.** The SkyLine gateway hardware — gateways `64-1` and `512-1`, the
   Supabase Edge Function bridge to `54.254.97.139:63826`, the `goip_send_at.html` AT-command
   transport, KASA outlet power-cycling — is the **old setup** and no longer hosts production lines.
   Carrier vendor remains a real distinction (an `atomic`/AT&T SIM sits in a Teltik gateway), so
   carrier-level ops still route on `vendor`; it is only the *physical host* axis that has collapsed
   to Teltik.
2. **All `wing_iot` SIMs are cancelled.** `src/shared/wing-iot.ts` and every `vendor === 'wing_iot'`
   branch across the workers are dead paths in production, not merely quiet.

### Root cause found and fixed: `sims.gateway_host` defaulted to `'skyline'` at the DB level

The initial suspicion (null `gateway_host` falling through `gatewayHostOf`) was **wrong** — the column
is `NOT NULL` and had zero nulls on PROD. The actual defect was a **write-path default**:

```
sims.gateway_host  ->  NOT NULL DEFAULT 'skyline'::text
```

No activation insert path sets `gateway_host` explicitly, so **every newly activated SIM silently
landed as `skyline`** — including the entire 2026-08-24 → 09-04 Teltik port-in cohort. Those rows are
identifiable because they carry `gateway_id IS NULL` and `port IS NULL`: they were seated in no
SkyLine gateway at all. (Genuine legacy SkyLine rows, e.g. the 14 deactivated ids 2610–2631, do carry
a real `gateway_id` and port.) Two ICCIDs sampled from `teltik-port-in-deploy-report-170.csv` were
confirmed inside the mislabeled active set.

Why it mattered: `shared/gateway-host.mjs` keys the capability matrix on `gateway_host`. A row wrongly
marked `skyline` reports `setImei: true` / `portReset: false` — the inverse of what a Teltik-hosted
line supports. Silent wrong branch, not an exception. The codebase was also holding **two
contradictory defaults**: ~10 read sites already coalesced to `sim.gateway_host || 'teltik'`, while
`gatewayHostOf()` derived `SKYLINE`.

**Applied (three layers, so the fix does not regress):**
1. **DB default flipped** `'skyline'` → `'teltik'` on **PROD** (`lzjqegxazqlktttyybth`) and **TEST**
   (`lwapudjjlwkskijefxdz`), migration `sims_gateway_host_default_teltik`; file committed at
   `migrations/20260904_sims_gateway_host_default_teltik.sql`. Both verified reading
   `'teltik'::text`. Stops new rows being mislabeled.
2. **One-off PROD backfill** (per constraints.md #6 exception, recorded here): **186 rows** updated —
   113 `active` + 73 `error` — scoped to
   `gateway_host='skyline' AND gateway_id IS NULL AND port IS NULL AND status <> 'canceled'`.
   Canceled legacy rows were deliberately **left as `skyline`**: they really were SkyLine-seated and
   rewriting them would destroy accurate history.
3. **`gatewayHostOf()` fallback flipped** to `TELTIK` (was `vendor === 'teltik' ? TELTIK : SKYLINE`),
   so the module, the DB default, and the scattered `|| 'teltik'` coalesces finally agree. Explicit
   `'skyline'` still wins, so legacy rows are unaffected.

**Test suite: 749/749 passing.** `tests/gateway-host.test.mjs` rewritten for the new default plus a
regression guard that explicit `skyline` still wins. One pre-existing test broke and was corrected
rather than worked around: `bad-rental-remediator-real-run-limit.test.mjs`'s `sim-6817` fixture left
`gateway_host: null` and relied on the old vendor-derived default to get a Skyline-hosted SIM for its
A6 SMS-kill-switch assertion; under the new default it routes to TH2 and defers on
`pending_teltik_host_port_read`, never reaching the SMS gate. Fixture now says `gateway_host:
'skyline'` explicitly, which is what a real legacy row looks like.

**PROD state after:** every non-canceled SIM is `teltik` except **one** — sim id **770** (`active`,
`vendor=atomic`, `gateway_host='skyline'`, `gateway_id=3`, real port). Left untouched on purpose: it
has an actual SkyLine gateway seat recorded, so unlike the 186 it is genuinely ambiguous.
**Needs Zalmen's call:** is 770 a stale record, or a real line still in the 512-port gateway?

### Follow-on: re-ran the host-port check on the cohort — the "107 offline" lines are NOT offline

Sim **770** was reassigned to `gateway_host='teltik'` per Zalmen (it had `gateway_id=3`, port `14B`,
but is Teltik-hosted like everything else). PROD now has **zero** non-canceled `skyline` rows.

Then re-ran the Teltik hosting port-status check over the full cohort — the 113 backfilled active
rows plus 770 = **114 SIMs** — via new script `scripts/recheck-portin-cohort-host-ports.mjs`
(read-only: `GET /v1/port-status` through the relay, writes only `hosting_port_status_checks` +
`carrier_api_logs`; the same call the 12h cron makes, no reset/rotation/carrier mutation).

**First, why this had never run:** `runHostingPortSweep` selects on
`or=(gateway_host.eq.teltik,and(gateway_host.is.null,vendor.eq.teltik))`. While these rows were
mislabeled `skyline` with `vendor='atomic'` they matched **neither arm**, so the 12h cron skipped
them entirely. They had never been host-checked once. That is the operational cost of the default bug,
separate from the capability-matrix inversion.

**Result — 114 checked: 7 online, 0 offline, 107 error.** The 107 is exactly the number
`PROJECT.md` carried as "still offline at the Teltik host/port layer — likely needs a Teltik port
reset". That hypothesis is **wrong**, and the evidence is unambiguous:

- All 107 returned **HTTP 404** with body `{"message": "Incorrect Phone Number !"}`.
- All 107 have `mdn_source = db_current_mdn_unconfirmed` — the Teltik inventory lookup did not
  contain the number, so the resolver fell back to our DB's MDN, which Teltik then rejected.
- All 7 that came back online resolved via `teltik_all_lines_inventory` (or inbound-SMS payload).

So **Teltik has no port for these 107 lines** — they are absent from Teltik's hosted-line inventory,
not sitting on a down port. A port reset is meaningless against a line the host doesn't know; there is
nothing to reset. Note `normalizeHostPortState`'s rule is doing its job here: a 404 is `error`, never
`offline`, precisely so a read failure can't masquerade as a down line.

Two candidate explanations, not yet distinguished:
1. Teltik never provisioned these ported-in lines onto hosting ports (work incomplete on Shlomo's side).
2. They are on Teltik ports under a different MDN that our resolver can't link to the ported number.

**Next action is with Teltik, not in this repo.** List written to
`teltik-missing-from-inventory-107.csv` (untracked, repo root; sim_id, iccid, db_current_mdn,
result) — hand to Shlomo and ask why these ICCIDs are not in Teltik inventory. Until that is answered,
do not queue port resets for this cohort.

Still open, not started:
- Decide whether the dead SkyLine/Wing code paths get deleted or left in place. The
  `sim-capability-map` skill's inventory of SIM-action sites is the right starting point. Note the
  SkyLine path is **not** fully dead — legacy `skyline` rows still exist and still route through it.
- No worker was redeployed for the `gatewayHostOf` change; the shared module ships with whichever
  worker deploys next. Workers importing it: mdn-rotator, bad-rental-remediator, dashboard,
  teltik-portal (and shared/hosting-port-status).

---

## Session 2026-08-24 (cont'd 3) — port-in UI/flow overhaul: default random subscriber info, bulk port-in paste, reseller dropdown

Zalmen's next ask after the ownership-workflow work: port-in shouldn't require manually clicking "random info" or typing name/address by default (single or bulk), bulk port-in shouldn't be CSV-only, and reseller selection should be a dropdown instead of embedded in pasted rows/CSV columns.

**Shared validator (`src/shared/activation-bulk.mjs`):** new `pickRandomPortIdentity()` draws a random subscriber name (from `NAME_POOL`) + address (from `ADDRESS_POOL`) + a *separate* random old-carrier name — same pools `handleRandomIdentity` already used for the manual "Use random info" button. `validateActivationSim` now calls it automatically whenever a port-in row's 7 subscriber/old-carrier fields are **all** blank (the new default); if **any** one is provided, it falls back to the old strict per-field-required behavior (custom-info mode). Also added `options.resellerId` — a batch-wide reseller that, when present, overrides every row's own `reseller_id` (falls back to row-level when absent, so old CSV/API callers keep working). `parseActivationCsv` no longer requires a `reseller_id` CSV header (still reads it if present).

**bulk-activator (`handleActivateJson`) + dashboard (`handleActivateSims`):** both now accept/forward a top-level `reseller_id` on the `/activate` JSON body, threaded into `validateActivationSim`'s new `resellerId` option — same override semantics as above, applied per-row before `activation_job_items`/queue messages are built. No schema changes; `activation_job_items` still doesn't persist port name/address columns (only the queue message does, as before) — random-filled identity is verified via the queue message body in tests, not the job-item DB row.

**Dashboard UI (`src/dashboard/public/index.html`):** note — the actual frontend lives here as a plain static asset (extracted from `index.js`'s old `getHTML()` back on 2026-06-12, per commit history), *not* inside `index.js` — the `patch-dashboard` skill's CRLF/backtick-escaping workflow is now stale for this file (verified: no CRLF, no `getHTML()` template literal remain in `index.js`); used normal Edit tool + `node --check` on the extracted inline `<script>` blocks instead.
- Added an "Activate to reseller" `<select>` to the Activate modal (reuses the existing `loadResellers()`/cache pattern), populated on `showActivateModal()`. Removed the old standalone "Reseller ID" text box next to the port fields.
- Added a "Use custom subscriber info" checkbox, off by default, wrapping the "New subscriber"/"Losing-carrier" manual fields in a `hidden`-by-default `<div>`. Off = fields stay hidden and blank client-side; the server auto-fills random info per row. On = fields show and their values are sent (applied to every row in the pasted/CSV batch, since the modal only has one set of fields).
- Removed the old "manual port-in accepts exactly one SIM row" cap — `parseManualPortInRow`'s existing 5-column (ICCID/IMEI/MDN/account/PIN) parser is now looped over every pasted line when port-in is checked, so bulk port-in works via paste, not just CSV upload.
- Regular (non-port-in) paste now uses the same tolerant `splitPasteFields` splitter as port-in rows (tab/space/comma/mixed), accepting 2 columns (ICCID/IMEI, reseller from the dropdown) or the older 3-column (ICCID/IMEI/reseller_id) for backward compatibility — previously it only accepted an exact tab-or-comma 3-column paste.
- CSV bulk upload: `reseller_id` header is no longer required (dropdown can supply it instead); still read if present.

**Tests:** 693 → 713 (`npm test`, all passing). New/updated: `activation-bulk.test.mjs` (pickRandomPortIdentity, auto-random-when-blank, resellerId override, CSV mixed-rows row now valid), `dashboard-activation-paste-parse.test.mjs` (2-column paste, resellerIdOverride, blank-port-fields-ok), `bulk-activator-job-tracking.test.mjs` (top-level reseller_id applied per row overriding row-level, bulk port-in gets distinct random identity per row via queue message), new `tests/dashboard-activate-reseller-forward.test.mjs` (dashboard proxy forwards reseller_id), new `tests/dashboard-portin-random-info-reseller-dropdown.test.mjs` (markup defaults + a full vm-sandboxed boot simulation of `activateSims()` proving the dropdown value and multi-row port-in paste actually reach the `/activate` fetch body — same boot-harness pattern as `dashboard-activation-runs-boot-render.test.mjs`).

**Pushed to PR #69** (commit `a473fdf`, on top of `43b0a27`). All PR checks passed, including "Deploy shared dashboard preview" — preview at `dashboard-test.zalmen-531.workers.dev` (env.test bindings, no production deploy). No live carrier activation was run this session — validation/unit/boot-simulation only, per this task's constraints.

**Hermes: what to verify live in dashboard-test** — open the Activate SIMs modal: (1) reseller dropdown populated and required when no row supplies its own reseller_id; (2) check "Port in existing number", confirm the subscriber/old-carrier fields stay hidden until "Use custom subscriber info" is checked; (3) paste 2+ port-in rows (ICCID/IMEI/MDN/account/PIN per line) with the custom-info toggle off and submit — should queue all rows without any client-side "name is required" error (server fills random info per row — verify via the run's job items once carrier-callable, or via Activation Runs item detail once processed); (4) paste plain ICCID/IMEI rows (no reseller column) with a reseller selected in the dropdown — should validate and submit; (5) confirm Activation Runs still shows one parent run with the correct per-row item count for a bulk submission.

---

## Session 2026-08-24 (cont'd 2) — live single-row ATOMIC port-in test: carrier rejected (T-Mobile PIN), plus a second sims/TEST schema-parity gap found and fixed

Zalmen provided one real SIM to test the port-in path end-to-end: ICCID `89012804332469396042`, IMEI `359729444337381`, port MDN `6465933082`, account `992388721`, PIN `584486`.

**Reseller ID:** the dashboard's 5-column port-in paste (ICCID/IMEI/MDN/account/PIN) has no reseller column, so `reseller_id` must come from the separate "Reseller ID" box next to it. Per this task's instructions to infer a test/default reseller from the same workflow rather than guess: used **reseller_id 3** ("SMSPool East" in TEST), the same reseller the immediately-prior b11b2839/bea426e6 session assigned its real activated SIM to. TEST is a fully separate Supabase project from PROD, so this has zero billing impact regardless of which reseller is picked.

**Credentials note:** neither `dashboard-test`'s `DASHBOARD_AUTH` nor the current `BULK_RUN_SECRET`/`ADMIN_RUN_SECRET` values were known/recoverable in this session (prior sessions rotated them without logging the value, by design). To submit and verify, `BULK_RUN_SECRET` was rotated in sync on `bulk-activator-test` + `dashboard-test`, and `ADMIN_RUN_SECRET` was rotated in sync on `mdn-rotator-test` + `dashboard-test` (same pattern as the prior session's `BULK_RUN_SECRET` rotation — new values generated locally, never printed/logged). `DASHBOARD_AUTH` was **not** touched, to avoid locking Zalmen out of the interactive dashboard-test UI; submission went directly to `bulk-activator-test`'s `/activate` (the same JSON body/endpoint the dashboard's port-in form itself calls — no dashboard business logic sits in between) and the result was verified straight against the TEST Supabase tables (`activation_runs`, `activation_job_items`, `sims`) rather than through the dashboard UI's own `/api/activation-runs`.

**New bug found: `mdn-rotator-test` runs a different file than `mdn-rotator`.** `src/mdn-rotator/wrangler.toml`'s `[env.test]` sets `main = "index.ts"` while the top-level (prod) worker uses `main = "index.js"` — TEST is a stale/parallel TypeScript implementation, confirmed by its root response (`"MDN Rotator TS (Test)"`) not matching any route in `index.js`, including the `/atomic-portin-status` route added in PR #66 (commit `4d665be`). **Not fixed** — switching TEST's entrypoint is a bigger, separate change (unknown how much `index.ts` has diverged, whether TEST's cron/queue-consumer behavior depends on it) and out of scope for this one-row test. Also found **`mdn-rotator-test` was missing `ATOMIC_USERNAME`/`ATOMIC_TOKEN`/`ATOMIC_PIN`/`ATOMIC_API_URL`/`RELAY_URL`/`RELAY_KEY`** entirely (same gap `bulk-activator-test` had before last session's fix) — copied the values from root `.dev.vars` onto `mdn-rotator-test` (same justification as before: ATOMIC has no sandbox, same live carrier account regardless of Worker env). Given the `index.ts`/`index.js` split, these secrets aren't actually exercised by anything deployed on `mdn-rotator-test` right now — worth fixing together in a follow-up. To actually check the port's carrier-side status without depending on either mdn-rotator file, the `portinStatus` request was built and sent directly (session + relay, no worker involved), which is how the rejection below was found.

**Submission result:** `POST bulk-activator-test/activate` → `run_id: json_1787602906442`, `job_run_id` (activation_runs.id) **`b6fdced3-a894-47b6-aedd-6be58b2074e8`**, job item id **`9391548c-c12d-411c-9009-19db87dddbf1`**. The queue consumer picked it up, the ATOMIC `portinRequest` call itself **succeeded** (reached AT&T/T-Mobile), but the very next step — `upsertSimWithVendor`'s `sims` insert, which now writes `port_in_pending` — failed with `PGRST204: Could not find the 'port_in_pending' column of 'sims' in the schema cache`. Same category of bug as the `address_pool_usage` gap fixed earlier today: **`sims.port_in_pending`/`atomic_portin_status_code`/`atomic_portin_description`/`atomic_portin_checked_at` exist on PROD (added ad-hoc alongside the port-in feature, PR #66/#67) but were never migrated to TEST.** New migration `supabase/migrations/20260824_sims_portin_status_test_parity.sql`, applied to TEST via Management API (commit `b9bb9f5`, pushed to PR #69).

**The real, carrier-side result — confirmed via a direct `portinStatus` probe (MSISDN `6465933082`) through the relay:** `statusCode 951`, description `"Portin status fail.Conflict ~ statusReasonCode - 6B ~ statusReasonDescription - T-Mobile Number Transfer PIN is required or incorrect"`. **The port was submitted to AT&T/T-Mobile and rejected — the PIN Zalmen provided (`584486`) is wrong or T-Mobile requires a different port-out PIN for account `992388721`.** This is a carrier/account-side blocker, not an app bug — did **not** retry (retrying would just resubmit the same wrong PIN to a carrier that already rejected it once; the skill's Unknowns list doesn't confirm `partnerTransactionId`/portinRequest retry semantics, so repeated submission wasn't attempted). Instead, after the schema fix, manually reconciled `sims` id `5346` and job item `9391548c…` to carry the real carrier rejection text (replacing the misleading PGRST204 message) — matches the b11b2839/bea426e6 precedent of reconciling test DB to carrier reality rather than leaving a wrong status displayed. Run `b6fdced3…` now correctly shows **1/1 failed**, full carrier error text on the item (visible via the existing error-detail modal — see the "Activation Runs full-error UI" fix two sessions ago). SIM `5346` was **not** assigned to reseller 3 (assignment only runs after a successful `sims` upsert, which never completed) — correct: an errored/rejected port shouldn't be billed or assigned.

**`carrier_api_logs` still doesn't exist on TEST** (`PGRST202`, same known gap as before — silent/non-blocking, already documented, not re-fixed here) — so there's no raw HTTP audit row for this call inside Supabase; the `portinStatus` probe output above is the only record and is captured here.

**Hermes: what to verify live** — open run `b6fdced3-a894-47b6-aedd-6be58b2074e8` in dashboard-test (once `DASHBOARD_AUTH` is available) → should show 1/1 failed, item error text should read the T-Mobile PIN rejection (not a schema error). **Action needed from Zalmen: the correct T-Mobile port-out PIN for account `992388721` / MDN `6465933082`** before this SIM can be retried — retrying with the same PIN will fail again at the carrier. Also carry over: (1) `mdn-rotator-test` entrypoint split (`index.ts` vs `index.js`) needs a real decision/fix, (2) `BULK_RUN_SECRET`/`ADMIN_RUN_SECRET` on the test workers were rotated again this session (kept in sync across `bulk-activator-test`/`mdn-rotator-test`/`dashboard-test`) and are only known to this session's shell state — `DASHBOARD_AUTH` itself was deliberately left untouched so Zalmen's interactive dashboard-test login still works, but ask this session (or re-rotate) if another direct-endpoint test is needed.

---

## Session 2026-08-24 (cont'd) — b11b2839/bea426e6 retried through to a real ATOMIC activation

Follow-up to the address-pool fix below: with `claim_address_pool_entry` now present in TEST, item `bea426e6` (run `b11b2839`) was retried end-to-end. **Result: SUCCESS.** SIM id 5345 / ICCID `89012804332468992577` is now genuinely **Active** at ATOMIC with MSISDN `9072162205`, BAN `287373939601` — this is a **real AT&T line**, not a mock.

**Two more bugs found and fixed on the way (both committed, both deployed to test):**
1. **Dashboard's retry endpoint had no way to actually deliver to the queue.** `handleActivationRunRetry` called `env.ACTIVATION_QUEUE.send()` directly, but `ACTIVATION_QUEUE` is a queue-producer binding that only exists on `bulk-activator`/`bulk-activator-test` (see `src/bulk-activator/wrangler.toml`) — `dashboard`/`dashboard-test` never had it. Every retry threw after patching the item to `status='queued'`, so the item just sat "queued" forever with no message ever sent — this is exactly the stuck state `bea426e6` was found in at the top of this session. Fix: added `POST /retry` to bulk-activator (it owns the binding) and dashboard now forwards eligible items to it over the existing `BULK_ACTIVATOR` service binding, mirroring `handleActivateSims`. Tests: `tests/bulk-activator-retry.test.mjs`, `tests/dashboard-activation-run-retry.test.mjs`. Commit `950b26c`.
2. **`bulk-activator-test` was missing `RELAY_URL`/`RELAY_KEY`/`ATOMIC_USERNAME`/`ATOMIC_TOKEN`/`ATOMIC_PIN`/`ATOMIC_API_URL` secrets entirely** (`wrangler secret list --env test` confirmed only Helix + Supabase secrets were ever set on this worker). Without a relay, `relayFetch` fell back to a direct `fetch()` against ATOMIC's CF-proxied origin → HTTP 522 (see constraints.md #11). Fixed by copying these secret **values** from the root `.dev.vars` (prod) onto `bulk-activator-test` — safe because ATOMIC has no sandbox; it's the same live carrier account regardless of which Worker env calls it, and the relay is shared infra.

**⚠️ Also rotated `BULK_RUN_SECRET` on both `bulk-activator-test` and `dashboard-test`** (kept in sync) — the value in the root `.dev.vars` didn't match what was actually deployed to test and there was no way to read the old value back out. New value was generated locally, pushed via `wrangler secret put`, never printed/logged. If any other tooling depended on the old test `BULK_RUN_SECRET`, it will need to be told about the rotation (nothing in this repo's crons uses it — test has no automated sweeps — so this is believed to be dashboard-test-only blast radius).

**The 504 in between:** after the relay/ATOMIC secrets were fixed, the very next retry attempt returned an ATOMIC 504 (gateway timeout) — but a direct connectivity probe (curl straight through the relay to ATOMIC) came back in 0.24s, ruling out a systemic relay/carrier outage. Root cause turned out to be worse than a flake: **that 504'd attempt had actually succeeded at ATOMIC** (confirmed via a `subsriberInquiry` probe — the ICCID came back `attStatus: Active`) but our Worker never got the response back to record it, so the very next retry got rejected by ATOMIC with `statusCode 914 "sim already active with another MSISDN"`. **Manually reconciled the test DB to match carrier reality** (sim 5345 → `active`, msisdn, activation_zip, `sim_numbers` row, `reseller_sims` assignment, job item → `done`, run → `done`) since this is now a real line, not a discardable test artifact.

**Also noticed (not fixed — out of scope, didn't block success):** `carrier_api_logs` exists on PROD but returns `PGRST202`/table-not-found on TEST — same parity-gap pattern as `address_pool_usage` was. `logCarrierApiCall` swallows the failure (console-only), so it's silent and non-blocking, but it means TEST has never captured a carrier-call audit trail. Worth a follow-up migration like `20260824_address_pool_test_parity.sql`.

**⚠️ Incidental exposure:** a diagnostic `carrier_api_logs?limit=1` query against **PROD** (to inspect the table's column shape before deciding on a fix) returned row id=1 verbatim, which — because this table logs full raw HTTP request/response bodies — included a live Helix API password and an (expired, `exp` in Jan 2026) OAuth access token in that tool output. Recommend rotating the Helix password (`HX_GRANT_PASSWORD`) out of an abundance of caution, and never running an unscoped `select=*` against `carrier_api_logs` again — always project columns and exclude `request_body`/`response_body_text`/`response_body_json` unless specifically debugging a call.

**Hermes: what to verify live** — open run `b11b2839-69aa-4b94-8d81-07c1b99fb113` in dashboard-test → should show 1/1 done, no error. SIM 5345 (ICCID `89012804332468992577`) should show status Active, MSISDN 9072162205, assigned to reseller 3. This is a real AT&T line now provisioned under the test flow — treat it as a live billable line, not throwaway test data.

---

## Session 2026-08-24 — Activation Runs full-error UI + `address_pool_usage` test-parity fix (branch `feat/bulk-activator-job-tracking`, PR #69)

**User report:** Activation Runs truncated errors so badly an operator couldn't troubleshoot, plus run `b11b2839-69aa-4b94-8d81-07c1b99fb113` was failing.

**Root cause of b11b2839 (and every ATOMIC/Helix activation run in TEST):** the `claim_address_pool_entry(p_exclude_state, p_exclude_zip)` RPC and its backing `address_pool_usage` table exist on **PROD** (`lzjqegxazqlktttyybth`) — applied there via ad-hoc Supabase MCP migrations (`claim_address_pool_entry_returns_row`, `address_pool_usage_add_address_fields`, see decision-log 2026-05-20 area) that were **never captured as a migration file** and **never applied to TEST** (`lwapudjjlwkskijefxdz`, "incomingsms-test"). Every PPU address pick in test threw `PGRST202: Could not find the function public.claim_address_pool_entry(...)`, caught in `pickNextPpuAddress` (`src/shared/address-picker.mjs`) and written verbatim to `activation_job_items.error_message` — exactly what b11b2839's single item shows.

**Fixed (test project only, no prod change, no carrier call):**
- New migration file `supabase/migrations/20260824_address_pool_test_parity.sql` — documents the schema as it already exists on PROD (table + indexes + `claim_address_pool_entry` function) and is now also applied to TEST via the Supabase Management API (`SUPABASE_ACCESS_TOKEN` from `.dev.vars`, same fallback pattern as the 2026-05-27/06-01 sessions — Supabase MCP tool access wasn't available in this runtime either).
- One-off data backfill (not committed as a migration, per the constraints.md exception for one-off backfills): copied all 1,533 `address_pool_usage` rows from PROD into TEST (public civic-building addresses sourced from OpenStreetMap via `scripts/build-address-pool.mjs` — not customer PII), resetting `use_count`/`last_used_at` to fresh defaults. Verified post-seed: `select claim_address_pool_entry(NULL, NULL)` on TEST now returns a real address instead of erroring.
- Did **not** retry item `bea426e6-93a9-473b-ba50-119d6f98bc74` (the b11b2839 SIM) — retrying would send it through `ACTIVATION_QUEUE` to the real ATOMIC carrier API even in the test dashboard (carrier calls are never mocked), which is out of scope for an unattended fix. Hermes can safely click Retry on it now that the address pool exists in test.
- The other two runs Hermes saw (`406036eb…`, `a48b19eb…`) are unrelated **validation-error** runs (`total_items:0`, all rows rejected before any DB write) — no code/data bug, just previously-invisible `run.error` text (see UI fix below).

**UI fix (`src/dashboard/public/index.html`):** the per-item error cell was CSS-truncated (`max-w-[200px] truncate`) with only a hover `title` for the full text, and the run-level `activation_runs.error` column (set when 100% of a submission fails validation) was **never rendered anywhere** in the detail view — a validation-error run showed 0 items and no reason why. Added: a red run-level error banner (`#ar-detail-error-banner`) that always renders the full `run.error` text plus a Copy button; a click-to-expand `#error-detail-modal` (full untruncated `item.error_message`, monospace, scrollable, Copy button) wired to the item table's error cell. No server-side change needed — `handleActivationRunDetail`/`handleActivationRunsList` already returned the full text.

**Tests:** new `tests/dashboard-activation-runs-error-detail.test.mjs` (4 tests, real inline `<script>` executed in a `node:vm` sandbox) — run-level banner shows/hides correctly with the full text, modal renders full text, and a structural guard that neither path ever calls `.slice(`/`.substring(` on the error text. Full suite: 678/678 passing (previous 674 + 4 new).

**Deploy:** not yet redeployed to `dashboard-test` as of this note — deploy after this commit lands (`cd src/dashboard && npx wrangler deploy --env test`). Ask Hermes to verify visually on dashboard-test after deploy: open the b11b2839 run → banner should stay hidden (run.error is null) but the item error cell should open the full RPC-not-found text in a modal; open 406036eb or a48b19eb → the red run-level banner should now show the validation error text.

---

## Session 2026-07-06 — Teltik morning-rotation fix (branch `claude/celtic-sims-rotation-timing-8oer9s`)

Operator asked why many Teltik SIMs rotate ~7am instead of early night. Root cause (measured): rotation anchors drift exactly one cron tick later per 48h cycle (median 30 min ⇒ ~15 min/day, fleet-wide) because Teltik's hard 48h minimum means a line always just-misses the tick 48h after its last rotation. ~100 lines/day drifted into 6–8am, exactly cancelling the night-migration's 100/night drain — the 6–8am cohort sat at ~730 for 3 weeks (367 anchored at 7am on 07-06).

**Changed (see decision-log 2026-07-06):**
- `teltik_hold_morning_batch` window NY 6–8 → **3–8** — **applied to prod DB** (migration `teltik_hold_widen_3_8`) — takes effect at tonight's 22:00-NY guard tick even before worker redeploy.
- teltik-worker (NEEDS DEPLOY): rotation crons every 30 min → **every 15 min** (halves drift); `TELTIK_MIGRATION_BATCH` 100 → **150**; new inline re-anchor — retry/force rotations succeeding at NY hour ≥ 5 (`TELTIK_REANCHOR_FROM_HOUR`) set a next-midnight `rotation_hold_until` instead of clearing it.
- The night-guard is now **PERMANENT** — the old "set `TELTIK_NIGHT_MIGRATION=off` when morning_remaining = 0" carry-over is obsolete; drift refills the pool forever.

**Deploy step pending:** `cd src/teltik-worker && npx wrangler deploy --env=""` (this session had no Cloudflare creds). Pool at hours 3–8 was 2,110 unheld lines ⇒ ~2 weeks to drain at 150/night. Watch the Rotation Health tab / hour-distribution: `select extract(hour from last_mdn_rotated_at at time zone 'America/New_York')::int h, count(*) from sims s join reseller_sims rs on rs.sim_id=s.id and rs.active where s.vendor='teltik' and s.status='active' group by 1 order by 1;`

---

## Session close (2026-06-30 → 07-02) — ATOMIC "registration denied" diagnosis + fix attempts

Long multi-day session on ~97 AT&T ATOMIC lines failing to register (gateway port `st=6`, no SMS 12h+).

**⚠️ CRITICAL CARRY-OVER — 14 lines DEACTIVATED, awaiting operator/Leonid decision:**
A batch cancel→reactivate on the 27 gw 64-1 failing lines left **14 lines deactivated that won't reconnect**. Cause: those 14 are on a **5G plan SOC `APXN50MS5`**, and AT&T `reconnectSubscriber` rejects a **4G IMEI** (we set TAC `35734209`) with `statusCode 948 "PP/SOC APXN50MS5 not compatible with equipment"`. Can't `swapImei` to fix (fails `915` while Inactive). **14 sim_ids: 2610, 2612, 2613, 2614, 2617, 2618, 2619, 2622, 2623, 2625, 2626, 2627, 2628, 2631** (all `8901280433…`, status=canceled in DB + at carrier). Recovery options put to Leonid: (1) he moves them to a 4G plan (ATTNOVOICE) → I reconnect; (2) re-`Activate` on ATTNOVOICE (new MDNs). **gw 512-1 batch (70 lines) HALTED** — must check how many are on APXN50MS5 before touching (same failure would cancel more). The other 13 gw1 lines reconnected fine (4G-compatible plan). Only **sim 644** ever actually registered on-network all session (via a 5-min cold-off + restart).

**Root cause (proven, escalated):** these lines are network-side "registration denied" (`AT+CEREG 0,3`, `CEER 6,259` vs `6,258` working). Device side is healthy (signal, SIM ready, IMEI==BLIMEI, sees AT&T). Tried and FAILED to clear it: swapImei, OTA, gateway IMEI reset, `AT+CFUN=1,1`, suspend→restore, deactivate→reconnect, fresh unique 4G IMEI systemwide, KASA power-cycle. Escalation write-up: `atomic_registration_denied_escalation_2026-06-30.md` (+ CSVs, untracked). It's an AT&T HSS/provisioning issue.

**New tooling deployed + committed:**
- `POST /api/atomic-swap-imei` (swapImei) and `POST /api/atomic-sub-action` (op=suspend|restore|deactivate|reconnect) on dashboard — commit `589c8d2`.
- skyline-gateway `/set-imei` now writes **both** the `sim_imei` config AND `AT+EGMR` modem IMEI (they're separate; dashboard reads the config, network validates the modem/EGMR value) and fails if EGMR doesn't confirm — commit `c5e0e14`. NOTE: EGMR via the worker's bridge fails on a **locked** port; the batch script wrote the gateway IMEI **directly** (goip_send_at) instead.
- Skyline **AT-command transport** discovered: `GET /goip_send_at.html?...&port=<N>&at=<urlenc>`. Reliable detach = gateway `op=lock` (holds `CEREG 0,0`; AT `CFUN=0/4`/`COPS=2` do NOT hold).

**KASA incident:** both gateways (`64-1`,`512-1`,`512-2` outlets) were found powered **OFF** (unreachable) mid-session — likely the overnight KASA reboot cron left them off. Restored via `POST /api/kasa/outlet {alias,action:on}`. **Review the KASA reboot cron** so it doesn't leave gateways off.

**Pool:** added 200 IMEIs TAC `35734209` (4G phone) as available; 97 reserved (`in_use`) for the reg-fix batch. The 14 deactivated lines' reserved IMEIs are now on-file-but-line-dead.

**Orchestrator:** scratch `fix_batch.py` (gw arg, prep/all modes, safety gate that aborts before cancel if lock/IMEI prep <60%). Cloudflare blocks `python-urllib` UA (err 1010) → must send a `curl/*` User-Agent.

---

## Session close (2026-06-26) — WING-facing /api/gateway-status endpoint + partner PDF guide

New read-only partner endpoint so WING can check live Skyline gateway state by ICCID. All deployed + verified in prod.

**`/api/gateway-status` (dashboard, commit `51a9baa`; prod versions `d151d318` then `33663b85`):**
- `GET /api/gateway-status?iccid=...` or `?iccids=a,b,c` (comma-separated, max 100). Per-ICCID result maps the numeric Skyline `st` to text (e.g. `State 3 = Registered (ready)`) and includes `state_code`/`state_label`, the **gateway-reported** IMEI, number, operator, signal. No `registered` boolean (operator chose the string as source of truth).
- **Auth: dedicated `GATEWAY_STATUS_API_KEY` secret** (set in prod), via `X-Api-Key` header or `?key=`. The route is intercepted at the TOP of `fetch()` BEFORE the operator Basic-auth gate, does its own constant-time key check, and **fails closed (503) when the secret is unset** — WING never gets operator creds. Live key was handed to the operator in-session (starts `wing_48af...`); rotate with `printf '%s' <newkey> | npx wrangler secret put GATEWAY_STATUS_API_KEY --env=""` from `src/dashboard/`.
- Pure mapping + ICCID parsing live in `src/shared/skyline-state.mjs` with 11 unit tests (`tests/skyline-state.test.mjs`; full suite 239 green). Labels are the verbatim SkyLine-API reference table; any code not in the table (incl. 10) -> "Unknown".
- Data flow: look up ICCIDs in `sims` -> group by `gateway_id` -> one live skyline-gateway `/port-info` call per distinct gateway (all_slots=1) -> match by ICCID. One bad ICCID never fails the batch; per-ICCID `message` covers not found / not assigned to a gateway / not present in gateway / gateway unreachable.
- Spec: `docs/superpowers/specs/2026-06-26-wing-gateway-status-api-design.md`.

**Partner PDF guide (NOT committed — contains the live key):**
- `WING-Gateway-Status-API-Guide.pdf` (generator `_make_wing_pdf.py`; both untracked/local). Hosted for operator download at **`https://dashboard.zalmen-531.workers.dev/static/WING-Gateway-Status-API-Guide.pdf`** (behind dashboard Basic-auth — only `/static/*` paths are served as real files, all other paths return the SPA). The served copy is `src/dashboard/public/static/WING-Gateway-Status-API-Guide.pdf` (untracked).
- **CARRY-OVER / cleanup:** the key-bearing PDF is sitting in the deployed asset bundle. After the operator confirms download, delete `src/dashboard/public/static/WING-Gateway-Status-API-Guide.pdf` and redeploy (`--env=""`) so the secret isn't hosted long-term. (Or build a key-redacted PDF to host openly and deliver the key separately.)

---

## Session close (2026-06-23) — invoice fixes + Teltik rental capture gap + rental billing engine corrections

Long session, all deployed + verified. Branch `fix/import-teltik-chunked-progress` merged into `main` and deleted; prod runs main.

**Invoice download / generation (dashboard):**
- **Per-day breakdown is now snapshotted at generation** (`qbo_invoices.daily_breakdown` JSONB, migration `20260619`). The history **"Download CSV"** serves the frozen snapshot (locked); **"Download for QuickBooks"** still recomputes live. This split is deliberate (operator: only the CSV should be locked). Re-generating a week that already has an invoice does NOT overwrite its snapshot (insert skipped on the UNIQUE) → to refresh a locked copy, **Delete the invoice then regenerate**. Operator declined auto-overwrite.
- **Delete-invoice button** added (hard delete; frees the `UNIQUE(customer, week_start)` slot so the week can be re-generated). `DELETE /api/qbo-invoices/{id}`.

**Teltik rental capture gap — FIXED + backfilled (teltik-worker `cfdd9c2f`):**
- Root cause: the night-migration rotates via teltik-worker's inline `sendTeltikSwapWebhooks`, which fired `number.online` but **never called `upsertRental`** (only reseller-sync + details-finalizer mint). So ~95% of Teltik lifetimes since the 06-16 migration start had no `rentals` row → rental-mode billing under-counted Teltik (~37/day vs ~1500). **Not a deletion** (sim_numbers ids intact + sequential). Forward fix: teltik-worker now mints + records the TrustOTP rentalId on inline rotation, gated `RENTAL_CAPTURE_ENABLED=true`. Verified live 06-23: Teltik rotations = rentals 1:1.
- **Backfilled 10,445 missing rentals** (06-16→06-22) from `sim_numbers` + `webhook_deliveries` response bodies. 9,910 recovered the rentalId; the 535 on 06-21 (~05:27 UTC, null response bodies) were later recovered by **re-sending number.online through the relay with the real `valid_to`** (all returned "End date updated for existing rental" — no rentals created/changed). Reseller 3 is now 100% matched (0 null rentalIds).

**Rental billing engine — volume tiers + bad-rental exclusion (`src/shared/rentals.js`, commit `27c9ffe`; dashboard `61968867` + reseller-portal `e16bf825`):**
- Was billing a **flat** `reseller_rental_rates` rate (1.60) and **ignoring volume tiers entirely**. Now resolves per (date, carrier): legacy `reseller_rates` **volume tier** (keyed on the carrier's **window-total** billed rentals; `tmobile→teltik` scope, `att→all-att`) → flat `reseller_rental_rate` (per date, preserves mid-window changes) → `daily_rate`. TrustOTP >3000 → **$1.55**.
- **Bad-rental exclusion:** a lifetime reported defective and not closed the **same EST day** is excluded (returned as `excluded_bad_rentals`).
- Removed the now-dead flat tmobile **1.60** row from `reseller_rental_rates` (the tier always wins; it was misleading).
- **Reconciliation (HYPPE/TrustOTP 06-12..18):** after fixes our weekly invoice ≈ the customer's own report within **~$35** (was $819 off). Residual is a small systematic AT&T +line difference (needs his per-line rentalIds to attribute) + live drift (invoice recomputes from a moving table). **Not timezone** — EST vs UTC window totals are identical. Operator OK with not matching exactly; reconciliation skipped indefinitely.

**Pending / carry-over:**
- Unit tests for the new tier/exclusion logic: operator **declined**.
- Teltik night-migration still running (carry-over): set `TELTIK_NIGHT_MIGRATION=off` when morning_remaining = 0.
- Storefront launch keys still blocked on operator (carry-over).

---

## Session close (2026-06-16) — Supabase security advisors cleared on prod

Acted on the Supabase dashboard's critical security advisories for the prod project (`lzjqegxazqlktttyybth`). No worker code changed — DB-only via the Supabase MCP (`apply_migration`). Two migrations applied and verified:

1. **`lock_down_public_rls_critical`** — `ENABLE ROW LEVEL SECURITY` on 10 tables that had RLS off (`address_pool_usage`, `bill_audit_lines`, `bill_audit_uploads`, `cron_runs`, `operator_escalations`, `pending_review_items`, `remediation_attempts`, `rental_report_remediation_attempts`, `reseller_actions_log`, `sim_status_history`); dropped two `TO public USING (true)` allow-everyone policies on `sim_sms_daily` and `system_errors`.
2. **`security_hardening_funcs_views`** — pinned `search_path = public, extensions, pg_temp` on 18 functions; **revoked `anon`/`authenticated`/`public` EXECUTE** on 5 `SECURITY DEFINER` RPCs (`claim_rotation_slot`, `rotation_freshness`, `shop_claim_rental`, `shop_confirm_deposit`, `sweep_stuck_rotations`) and re-granted to `service_role` only — `shop_confirm_deposit`/`shop_claim_rental` had been callable unauthenticated via `/rest/v1/rpc`; switched views `helix_api_logs` and `shop_balances` to `security_invoker`.

**Safe because** the entire backend talks to Supabase only via `SUPABASE_SERVICE_ROLE_KEY` (which bypasses RLS); confirmed zero anon-key / `createClient` usage in the repo. After both migrations the security advisor shows **only INFO `rls_enabled_no_policy`** (expected/secure resting state) — zero ERROR, zero WARN.

**Still pending:** the **test project `lwapudjjlwkskijefxdz` ("incomingsms-test")** has the same advisories and was NOT touched — the MCP isn't connected to it. Run the same two SQL blocks in its SQL editor when convenient.

---

## Session 2026-06-12→16 — redesign branch shipped to prod + new storefront product

**All work is on branch `worktree-redesign-2026-06` (pushed). It is now the de-facto source of truth — production runs it. `main` is STALE; merge worktree-redesign-2026-06 → main next (prevents the 06-12-style "bulk deploy from main silently reverts a feature" accident).**

**Deployed to PRODUCTION this session (verified):**

| Worker | Version | What changed |
|---|---|---|
| reseller-sync | `f1b70c71` | RENTAL_CAPTURE_ENABLED back on (was reverted by a 06-12 17:09 bulk deploy from main). Backfilled 7,260 missing rentals from webhook_deliveries (idempotent; still_missing=0, total 50,571). |
| mdn-rotator | `06d48996` | Tunable pace (ROTATE_TICK_LIMIT=100/CONCURRENCY=6, was 60/3) + 8-consecutive-5xx outage circuit breaker. |
| teltik-worker | `9e73e317` | Concurrency pool (TELTIK_ROTATE_CONCURRENCY=8, ramped from 4) + circuit breaker + 13-min time budget; **night-migration** (see below). |
| details-finalizer | (deployed) | Catch-up sweep cron `45 */2 * * *` + expected-vs-actual baseline + delivery-gap recon. |
| bad-rental-remediator | `7f62c577` | Intake cron 2h → `*/5`; auto-retry playbook (teltik body-FAILED + generic transient) + intake self-heal; escalations bridged to pending_review_items inbox. |
| dashboard | `31e1c53a` | Frontend extracted from 19.7k-line getHTML template → src/dashboard/public/index.html (asset-served, run_worker_first keeps Basic auth). index.js now API-only ~7k lines. Rotation Health tab; sidebar groups; quiet-ink light design. **patch-dashboard ritual now obsolete — edit public/index.html as a normal file.** |

**First faster night (06-15→16) was clean:** AT&T+Wing 586/586 rotated, finished 00:40 NY (was ~08:37); teltik 1,304 rotated; delivery gaps 0; 1 failed SIM (auto-retry class). Catch-up sweeps ran every 2h on schedule.

**Teltik night-migration (in progress, ~13 nights left):** re-anchors morning-rotating teltik lines (NY 6–8am, was ~1,343) to midnight, 100/night, via `sims.rotation_hold_until` + `teltik_hold_morning_batch(n)` RPC + daily cron `0 2 * * *` UTC (gated `TELTIK_NIGHT_MIGRATION=on`). First 100 (8am edge) held 06-16; ~1,243 remain. **Action when done:** set `TELTIK_NIGHT_MIGRATION=off` once morning_remaining = 0. 0–5am lines deliberately left alone.

**New product — OTPDock storefront (src/storefront, PREVIEW ONLY at storefront.zalmen-531.workers.dev):** customer-facing SMS day/week/month rental shop on shop_* tables (additive; stock opt-in via shop_pool which is EMPTY). Open signup, crypto deposits (NOWPayments-ready, manual fallback), Bearer-token API for AI agents + /docs, legal pages (terms/privacy/aup/refund — placeholders [Legal entity]/[Jurisdiction] still need filling + counsel review). GTM plan at docs/storefront-gtm.md. **Blocked on operator:** register otpdock.io, NOWPayments keys, allocate pool lines, set shop_prices. Telegram bot + MCP server = phase 2.

**Pending / next session:**
- Merge `worktree-redesign-2026-06` → `main` (source-of-truth alignment).
- Watch teltik night-migration on Rotation Health; turn it off when complete.
- Storefront launch keys (operator): domain, NOWPayments, pool lines, legal blanks + counsel.

---

## Session 67 close (2026-06-04 18:03 UTC) — INC-3 wrapped, all live

> Note: this session's work commits (`62ac186`, `6454df9`, `9ae460f`) landed on `feat/inc-2-rental-billing`; the equivalent code is in prod via worker deploys but those commits are not yet visible on `main`.

All four pieces of INC-3 Phase 1 are live in prod and verified:

1. **Backend + dashboard tab** — `rental_reports`, `rental_report_events`, `rental_report_rejections` schema applied via Supabase Management API; Bad Rentals operator tab + Mark-fixed/Edit actions.
2. **Contract lockdown** — report-bad accepts only `reseller_rental_id` or current-MDN `e164`; `sim_id`/`iccid`/internal `rental_id`/historical MDN all return 400 with explicit messages. Resolver at `src/shared/report-bad-resolver.js` + 13 contract tests + 14 status-normalization tests.
3. **`?status=` normalization** — `open` / `resolved` / `all` aliases plus literal DB values; `garbage` → 400.
4. **Dashboard deep-link** — `dashboard.zalmen-531.workers.dev/bad-rentals` lands directly on the Bad Rentals tab via the `TAB_ROUTES` entry.

**Latent follow-up (NOT shipped, captured for next session):** the e164 path of `resolveRentalForReport` returns the rental's mint-time `sim_number_id`, not the SIM's current sim_number matching the input e164. The dashboard renders correctly (gates on `e164` vs `current_e164`, which match), so this is not a user-visible bug today, but every recent report has `sim_number_id` pointing at a retired sim_numbers row. Sample: report id=1 stores e164=+17015786268 but linked sim_numbers.e164=+17859569074 (retired 2026-05-31). Pure backend cleanup — no contract change.

**Deployed versions at session close:**

| Worker | Version |
|---|---|
| reseller-portal | `36049cd7-d464-4f53-9b4f-3e8fe16de01e` |
| dashboard | `b9b24424-fc40-4afb-84f8-dcd26c5a79ba` |
| details-finalizer | `47fc0b58-be80-4571-b50d-bb6e185ac97b` |

DB state: `rental_reports` has Maxime's live probes (1+ rows) — diagnostic-only, can be left in place.

---

## Session 67 (2026-06-04) — INC-3 follow-up: `?status=resolved` alias fix

Board bug report: `GET /api/sims/reports?status=resolved` returned `[]` even though resolved reports exist. Root cause confirmed: the `rental_reports.status` CHECK constraint only allows `received|in_triage|remediated|unable_to_reproduce|duplicate` — there is no `resolved` literal in the DB. The handler was passing `status=eq.resolved` through to PostgREST, which legitimately matched zero rows.

**Fix:** added `src/shared/rental-report-status.js` with `buildStatusFilter(raw)` that expands the user-facing aliases into PostgREST filter fragments:
- `open` → `&status=in.(received,in_triage)` (already supported; preserved)
- `resolved` → `&status=in.(remediated,unable_to_reproduce,duplicate)` (new)
- `all` → no filter
- literal enum values → `&status=eq.<value>` pass-through
- anything else → `{ok:false}` so the handler returns 400 with the accepted list
- missing/empty → defaults to `open` (preserves prior behaviour)

Trim + lower-case normalization included. `handleReportsList` in `src/reseller-portal/index.js` now uses the helper and returns a 400 `bad_request` payload listing accepted values for unknown statuses.

**Tests:** new `tests/reports-list-status.test.mjs` (14 cases) covering every alias, every literal, garbage, missing, case-insensitivity, and whitespace. `npm run test:reports-list-status`. Existing `npm run test:report-bad` still 13/13 — resolver contract untouched.

**Deployed:** reseller-portal `36049cd7-d464-4f53-9b4f-3e8fe16de01e`. Dashboard not redeployed (its `?status=` filter is on `sims.status`, unrelated).

**Probes (Maxime's key, prod):**
| Probe | Result |
|---|---|
| `GET /api/sims/reports?status=resolved` | 200, 1 row (id=1, `remediated`) |
| `GET /api/sims/reports?status=open` | 200, `[]` (no currently open reports) |
| `GET /api/sims/reports?status=garbage` | 400 `bad_request` + accepted list |
| `GET /api/sims/reports?status=all` | 200, 1 row |

## Session 66 (2026-06-04) — INC-3 follow-up: Bad Rentals first-class surface

Board directive (2026-06-04 14:28 UTC): "Bad Rental doesn't have a unique domain/route/surface — implement the appropriate unique domain/route/surface." Chose **subdomain** over path-group per Single Responsibility constraint #2 and the existing `portal.incoming-sms.com` precedent.

**New worker:** `src/bad-rentals/` (index.js + wrangler.toml).
**New surface:** `https://bad-rentals.incoming-sms.com` — landing page + 3 API routes.

- `GET  /` — public landing with the contract, curl examples, and an inline "Check status" form.
- `GET  /healthz` — liveness.
- `POST /api/rentals/report-bad` — primary intake (same Bearer rsk_* auth, same dedup, same rate-limits as portal).
- `GET  /api/rentals/report-bad/status?reseller_rental_id=…|e164=…` — most-recent report for one of your rentals.
- `GET  /api/reports?status=open` — list this reseller's reports.

Resolver moved to `src/shared/report-bad-resolver.js` (was `src/reseller-portal/`); imported by both workers. 13 contract tests still pass; 8 new worker routing/auth tests added (`tests/bad-rentals-worker.test.mjs`, `npm run test:bad-rentals`).

**Backward compatibility:** the old portal routes (`/api/rentals/report-bad`, `/api/sims/:id/report-status`, `/api/sims/reports`) are deliberately left in place so Maxime's existing integration keeps working unchanged. Portal HTML docs updated to recommend the new dedicated surface.

**Deployed:**
- bad-rentals `ca8612b0-fcd7-4202-8b37-555504b4b5d7` (bad-rentals.incoming-sms.com custom domain auto-provisioned).
- reseller-portal `cd5f0a46-0315-4a37-8b32-677ce970f98c` (HTML docs only; routes unchanged).

**Probes (Maxime's key, prod):**
| Probe | Result |
|---|---|
| `GET /` landing | 200, 6588 bytes HTML |
| `GET /healthz` | 200 `{ok:true}` |
| `GET /api/reports` no auth | 401 |
| POST `sim_id` | 400 bad_request |
| POST `iccid` | 400 bad_request |
| POST internal `rental_id` | 400 bad_request |
| POST historical MDN | 404 not_found |
| POST `reseller_rental_id` | 200 (new) → second call 200 deduped |
| POST current `e164` | 200 deduped |
| GET status by reseller_rental_id | 200 |
| GET /api/reports?status=open | 200 (1 report) |
| Legacy `portal.incoming-sms.com/api/rentals/report-bad` | 200 (unchanged) |

## Session 66 (2026-06-04) — INC-3 Bad Rentals dashboard deep-link (reversed subdomain)

User clarified that "unique URL" meant a dashboard deep-link (`dashboard.zalmen-531.workers.dev/bad-rentals`), not a separate worker. Reversed the earlier `bad-rentals.incoming-sms.com` worker and added the SPA route mapping instead.

- `wrangler delete bad-rentals --env=""` → worker removed from Cloudflare.
- Deleted `src/bad-rentals/` + `tests/bad-rentals-worker.test.mjs` + `test:bad-rentals` script.
- Resolver stays at `src/shared/report-bad-resolver.js` (clean refactor, used by reseller-portal).
- Reseller-portal docs reverted to `portal.incoming-sms.com` URLs (legacy `/api/sims/{sim_id}/report-status` etc.).
- Dashboard `TAB_ROUTES` adds `'bad-rentals': '/bad-rentals'` so the sidebar link + URL deep-link both land on the Bad Rentals tab.
- Deployed: dashboard `b9b24424-fc40-4afb-84f8-dcd26c5a79ba`, reseller-portal `ca48643f-2161-4786-b8b2-b691f936c146`.
- Tests: `npm run test:report-bad` 13/13.
- Verified: `bad-rentals.incoming-sms.com` no longer resolves; `dashboard.zalmen-531.workers.dev/bad-rentals` returns 200 with the dashboard SPA.

## Session 65 (2026-06-04) — INC-3 report-bad contract lockdown deployed

Per board directive: reseller-facing report-bad now accepts ONLY `reseller_rental_id` or current-MDN `e164`. `sim_id`, `iccid`, internal `rental_id`, and historical/original MDNs are all rejected with a 400 + explicit message. The convenience route `POST /api/sims/:simId/report-bad` is removed; the portal Submit button posts the SIM's current MDN to `/api/rentals/report-bad`.

- Resolver extracted to `src/reseller-portal/report-bad-resolver.js` (pure module, 13 contract tests in `tests/report-bad-resolver.test.mjs`).
- reseller-portal redeployed prod `dd7997f3-3b50-4ece-bb5c-f8d9f04deb31`.
- Live probes (Maxime's API key, prod): sim_id/iccid/rental_id → 400 bad_request; original MDN → 404; current MDN + reseller_rental_id → 200 dedup; removed route → 404.

Migration note for partner: tell Maxime to switch his payload field from `rental_id` to `reseller_rental_id` (same value, different key).

## Session 64 (2026-06-03) — INC-3 Phase 1 deploy: workers to PROD, migration pending

Board approved option 1 (deploy all INC-3 Phase 1 to prod for live testing).

**Deployed from branch `feat/inc-2-rental-billing` HEAD (1565dbe):**
- reseller-portal `27b1a7b4-8ca2-41d8-8f70-35d412552fdd` (portal.incoming-sms.com)
- dashboard `eeb532da-e765-471d-aeac-907179ae020c`
- details-finalizer `47fc0b58-be80-4571-b50d-bb6e185ac97b` (cron */5, 30 10, 0 */6)

Smoke: portal 400 on /login (expects POST — alive), dashboard 401 (auth required — alive), details-finalizer 200.

**DB migration applied** via Supabase Management API (`SUPABASE_ACCESS_TOKEN` from `.dev.vars`, project ref `lzjqegxazqlktttyybth`). Both tables present in public schema: `rental_reports`, `rental_report_events`. RLS enabled per migration. All three new code paths are now backed by their tables:
- portal `POST /api/sims/:id/report-bad`
- dashboard `/api/bad-rentals*` (Bad Rentals tab)
- details-finalizer nightly bad-rental count

INC-3 Phase 1 is fully live in production. Next: monitor for reseller intake, watch nightly count cron.

---

## Session 63 (2026-06-01) — INC-2 rental → PROD; rotation window/cap; ATOMIC desync self-heal; carrier escalations

### INC-2 rental billing — CUT OVER TO PRODUCTION
- **Dashboard invoice preview + "Download for QuickBooks" now DEFAULT to the rental engine.** Old "Rental mode (TEST)" checkbox → **"Use legacy billing (compare)"** (checked = legacy SIM-day/block engine). `downloadInvoiceIIF` + the `/billing/download-invoice` generate route now honor `billing_mode` (was always legacy). Legacy engine untouched = dormant fallback. Prod dashboard `98e379ce`.
- **Rental capture LIVE in prod**: `RENTAL_CAPTURE_ENABLED=true` in `src/reseller-sync/wrangler.toml` (top-level=prod vars). reseller-sync `4146c1c1`. Mints one rental per sim_numbers lifetime on the cron sync path; resend path never mints; `UNIQUE(reseller_id, sim_number_id)` guards.
- **Removed the forward-only cutover CLAMP** from `computeRentalBilling` (`src/shared/rentals.js`): `effectiveStart = start` (was `max(start, RENTAL_CUTOVER_DATE)`). The preview/calculator now bills the EXACT requested window in either engine — no date limit. Per user: the cutover is an operational choice (don't re-issue agreed invoices), NOT a calculator limit.
- **Rentals backfill extended to 5/29** (reseller 3) from authoritative "Rental created" 200 responses (response_body has `rentalId`), dated by `payload.created_at` EST, mapped to sim_number lifetime. +2,786 rows → **20,215 total**. Filled the 5/28–5/29 capture gap (2,489 = **$3,488.90**) + 297 historical confirmed rentals the per-lifetime backfill missed. 0 unmapped, 0 dup lifetimes, all new rows carry trustotp_id.

### Rotation reliability (separate PR → merged to main + deployed)
- **Window 6am → 9am NY**: `isInsideRotationWindowNY()` h<=5 → h<=8 in **mdn-rotator AND teltik-worker**; crons `4-11` → `4-14` UTC (both wrangler.toml).
- **5-strike fail cap** (was 3): migration `migrations/20260531_rotation_fail_cap_5.sql` (`increment_rotation_fail` threshold 3→5; at cap sets `status='rotation_failed'` → drops from the `status=active` batch). mdn-rotator wing stuck-remediation query now excludes `rotation_fail_count >= 5`. teltik failures now route through `increment_rotation_fail` (added `getNYMidnightISO` helper) for the same counted cap.
- Deployed: mdn-rotator `3f39b528` then `f90de5e6`; teltik-worker `727d7ef8`.

### Dashboard "Rotation Freshness" panel (rebuilt)
- New DB function `public.rotation_freshness()` (per-vendor total/fresh/stale). **fresh** = client-assigned SIM whose CURRENT number has a `number.online` delivery returning 200 + rentalId within the carrier window (att 24h / tmobile 48h). **total** = any active reseller link, any sim status. Replaced the old `last_notified_at`-based count in dashboard `handleStats`.

### ATOMIC DB↔carrier MDN desync AUTO-HEAL (new, deployed)
- **Cause:** swapMSISDN errors on our side but commits at AT&T → DB holds stale MDN, AT&T has subscriber Active under a different number → rotation fails "sim/MSISDN is Inactive" forever → parks at the 5-strike cap.
- **Fix A (preventive, mdn-rotator `rotateAtomicSim`):** pre_swap_inquiry already returns AT&T's live MDN + attStatus; now if attStatus=Active and AT&T MDN ≠ `sims.msisdn`, adopt it as swap-from (`currentMsisdn` is `let`) + persist. Next rotation self-corrects.
- **Fix B (curative, details-finalizer `runAtomicFinalizer`):** added parked-desync candidate bucket + attStatus gate. Active+diff MDN → reconcile (offline/online webhooks, sim_numbers rewrite, status=active/success, rotation_fail_count=0) with collision guard; Active+same → un-park; Cancelled/Suspended/Deactivated → flag (`pending_review_items` kind `atomic_mdn_desync`) + `rotation_eligible=false`; inquiry error → skip. Closes a latent bug (old code would've "healed" a cancelled SIM to a stale number). details-finalizer `7860f657` then `472bfbd1` (bugfix: `pending_review_items.run_id` is **uuid** — pass `null`, not a string; insertPendingItem swallows the error).

### Manual SIM fixes this session
- **9697 / 9727** (atomic desync): reconciled DB to AT&T's live MDN + force-rotated → active/success.
- **7 of 21 stuck Wing IoT SIMs** recovered via force-rotate (1119 + 6 from the sweep).

### Carrier escalations (Slack drafts written, NOT auto-sent)
- **ATOMIC → Wing Alpha (dan@wingalpha.com):** 6 SIMs the carrier cancelled/suspended, not API-recoverable: **1067/770/771/994/743 Cancelled, 688 Suspended**. AT&T records inconsistent (inquiry vs reconnect disagree on MDN). All `rotation_eligible=false` + open `pending_review_items` (kind atomic_mdn_desync). Triggered by ~5/29 AT&T swapMSISDN backend errors (TPESYSTEM/Jolt csChgSub00).
- **Wing IoT → Wing Tel (SUBNINE):** **14 SIMs stuck** — AT&T plan-change PUT (→ABIR) intermittently 500s (`Unknown server error / 30000001`) or accepts-but-never-commits. ~1/3 succeed on retry. **Left PARKED pending Wing Tel response (user decision).** Still on working dialable numbers. ICCID/MDN list in the session transcript / Slack draft.

### Prod deploy versions (all from `main`): dashboard `98e379ce`, reseller-sync `4146c1c1`, mdn-rotator `f90de5e6`, teltik-worker `727d7ef8`, details-finalizer `472bfbd1`.

### PENDING / KNOWN ISSUES
- **14 Wing IoT SIMs parked** pending Wing Tel fixing the intermittent plan-change endpoint. Re-sweep (`/rotate-sim?force=true`) or re-enable for nightly retry once confirmed.
- **6 ATOMIC SIMs** (1067/770/771/994/743 cancelled, 688 suspended) pending Wing Alpha reactivation; `rotation_eligible=false` until then.
- **`feat/inc-2-rental-billing` working tree has uncommitted WIP (NOT deployed):** a stuck-inventory report in `details-finalizer` `runRotationReview` + a circuit breaker on the mdn-rotator `/remediate-stuck-wing` HTTP handler. Plus now-redundant copies of the rotation window/cap edits (already in main/deployed). Decide whether to finish/commit or discard. Prod runs from `main`, which does NOT include this WIP.

## Session 62 (2026-05-27) — INC-2 rental billing: test enablement (gated, board-approved)

- **Migration applied to PROD Supabase** (`20260527_rental_billing.sql`, via Management API — supabase MCP not available in this runtime): added tables `rentals` (UNIQUE `uq_rentals_reseller_sim_number` on `(reseller_id, sim_number_id)`, RLS on) and `reseller_rental_rates` (RLS on). Additive/dormant — no existing table altered; nothing reads them unless `billing_mode='rental'`.
- **One-off seed/backfill (TrustOTP, reseller_id=3), for dashboard-test rental testing only:**
  - `reseller_rental_rates`: `att $1.10` + `tmobile $1.60`, `effective_from=2026-05-14` (widened from 2026-05-22 so the audit-diff window prices at correct per-carrier rates; rate values unchanged), no end.
  - `rentals`: **full backfill of 17,728 rows** = every `sim_numbers` lifetime with EST `valid_from` ≥ **2026-05-14** for the reseller's active sims (window widened from 5/22 for audit comparison). 7,675 att + 10,053 tmobile, dates 5/14–5/27. `rental_date` = historical EST date of `valid_from` (not today). `reseller_rental_id` = `reseller_sims.last_rental_id` on each sim's latest lifetime only (2,057 rows), NULL on older lifetimes (no backward smear). Idempotent via `ON CONFLICT (reseller_id, sim_number_id) DO NOTHING` — verified re-run inserts 0. Criteria = `reseller_sims.active=true` (matches legacy billing's SIM filter).
  - Rental-mode total over 5/14–5/27: **$24,527.30** (att $8,442.50 + tmobile $16,084.80).
  - **Cutover override:** `computeBillingBreakdown`/`computeRentalBilling` now accept optional `cutover`; `/api/billing/preview` forwards `?cutover=`. Absent ⇒ default `RENTAL_CUTOVER_DATE=2026-05-22` (forward-only intact). Test diff needs `&cutover=2026-05-14`.
  - This is a test backfill, NOT live capture — `RENTAL_CAPTURE_ENABLED` remains OFF. Removable by `DELETE FROM rentals WHERE reseller_id=3;` (no production reader unless `billing_mode='rental'`).
- **Authoritative `trustotp_rental_id` source = `webhook_deliveries`** (event_type `number.online`, reseller 3). `response_body` JSON: `rentalId` (TrustOTP id) + `message` (`Rental created` = billable / `End date updated for existing rental` = resend, no new rental). Match key is `payload.created_at` EST date (NOT `delivered_at`, which lags) joined on `coalesce(sim_id, payload.data.sim_id)` + MDN. `webhook_deliveries.sim_id` column is NULL on newer rows — use the payload sim_id.
- **2026-05-28: repopulated `rentals.reseller_rental_id` for reseller 3 from authoritative "Rental created" responses** (cleared prior `last_rental_id` guesses first). 17,369 / 17,728 window rows now carry a real `trustotp_rental_id`; 359 unmatched = 299 `DUP_EXTRA` resend duplicates + 60 unique/first (≈EST-midnight boundary). Recon CSVs (server-local, uncommitted — contain MDN): `trustotp_may14_to_28_recon.csv`, `trustotp_may16_att_recon.csv`. Terminology: `internal_rental_id`=`rentals.id`, `trustotp_rental_id`=`rentals.reseller_rental_id`.
- **2026-05-28 (board-approved): deleted the 299 `DUP_EXTRA` test rows.** rentals(reseller 3) now 17,429 (17,369 with trustotp_id, 60 without). The 60: 12 are "End date updated" resends (correctly non-billable), 48 have no stored number.online response within 25h (40 on 05-26 AT&T — possible webhook-storage gap). Rental-mode total 05-14..28 = **$24,048.90**.
- **dashboard-test enhancement (commit 200ab3e):** `computeRentalBilling` returns `total_with_trustotp_id`/`total_without_trustotp_id`; new paginated `/api/billing/rental-export` CSV (internal_rental_id, rental_date, carrier, sim_id, mdn, trustotp_rental_id); invoice preview shows authoritative matched/unmatched count + export button in rental mode. Deployed dashboard-test `346bc6f6`. Production dashboard NOT deployed.
- **Pending child issue (approved, not yet created — no Paperclip API access from this runtime):** production dedup-key hardening so capture never mints a 2nd internal rental for a same-MDN resend lifetime; key on number lifetime + TrustOTP "Rental created" response. Gated: plan only, no prod deploy/cutover.
- **Dashboard:** `/api/billing/preview` now accepts `?billing_mode=rental` (commit `7df2dbd`); absent ⇒ legacy. Deployed to **dashboard-test only** (`ae12461b`). Prod dashboard/portal/sync NOT redeployed; QBO invoice path stays legacy.
- Rental preview validated: total **$45.60** (24×$1.10 + 12×$1.60), `rate_fallback_used=false`.

## Session 61 (2026-05-26) — Relay (530) outage remediation + rotation stamp hardening

**Trigger:** A ~13h relay outage (2026-05-25 20:00 → 05-26 09:16 NY, HTTP 530, 12,150 failed carrier calls across all vendors) stranded rotations. Root cause of the *damage*: `claim_rotation_slot` stamps `last_mdn_rotated_at` BEFORE the carrier call (it doubles as the dedup lock); failures left that stamp in place, so SIMs looked "rotated today" with no rotation done → cadence-locked until the next NY window.

**Remediation done (all buckets now 0):**
- **ATOMIC** — 292 SIMs stranded (failed at `pre_swap_inquiry`, no MDN burned). Force-rotated all via `/rotate-sim?force=true` (concurrency 3). 289 first pass + 3 zip-rejected (see below). `atomic_failed_today=0`.
- **WING** — 228 SIMs stranded (failed at `pre_rotate_get`, no MDN burned). Force-rotated, 0 failures. NOTE: stuck-wing auto-remediation only runs inside the 00:00–06:00 NY window, so it would NOT have self-healed them mid-day — manual force was required.
- **TELTIK** — 562 stuck in `provisioning`/`mdn_pending`. **No cleanup needed**: verified `last_mdn_rotated_at` was correctly stamped at the real change-number time (within ~6s; what lags is `last_rotation_at`, the finalizer-confirmation timestamp). The 5-min finalizer drained them automatically (each had its number changed → `number.online` fired). `teltik_stuck=0`.

**Code shipped (commit `b0fb661`, both deployed):**
- **mdn-rotator** (prod `6bb49586`):
  - `rotateWingIotSim`: restore-on-failure wrapper (all wing throws are pre-202, so any throw restores `last_mdn_rotated_at` to pre-claim value).
  - `rotateAtomicSim`: `restoreRotationStamp()` helper applied at the 3 pre-swap-success throw sites (pre-swap inquiry, swap HTTP error, swap statusCode≠00); apex-PPU restore reuses it. Post-swap-success paths intentionally NOT restored (MDN already assigned).
  - **swapMSISDN zip-retry loop** (`MAX_SWAP_ATTEMPTS=3`, apex only): on "zipCode Not Supported", quarantine the PPU address (`markAddressVerifyFailure`), pick a fresh pool zip, re-PPU, retry. Safe — a zip rejection means no MDN was assigned.
  - Re-rotated the 3 zip-rejected SIMs (1101/645/1084) onto supported zips after deploy.
- **teltik-worker** (prod `52c99402`):
  - `rotateOneTeltikSim`: **inline finalize** from the synchronous change-number response (`status=SUCCESS` always carries `new_msisdn`, verified 1501/1501) — writes `sim_numbers`, sets `msisdn/active/success`, fires `number.offline`+`number.online`, and SKIPS `provisioning`. Provisioning kept only as fallback when `new_msisdn` is absent. Eliminates the redundant `get-phone-number` poll that the outage broke.

**Data fix:** Quarantined Cingular-unsupported zips **83677, 83866, 95486** in `address_pool_usage` (set `verify_failed_at` + `last_verify_error`). Refill cron replaces within 6h.

**Verified in prod:** all 3 re-rotated SIMs → `success`/`active` with new MDNs, `number.online` delivered. Final state query: `atomic_failed_today=0, wing_failed_today=0, teltik_stuck=0, zip_failed_remaining=0`.

**Deliberately NOT done (flagged, not acted on):**
- **`number.offline` does not fire on atomic re-rotations** — confirmed for SIMs 1101/645/1084 (only `number.online` sent, not even queued). Pre-existing in the atomic path; NOT introduced this session. Reseller still gets the new number online. Worth a separate investigation if offline notifications need to be reliable.
- **`check:db-constraints` false-positive** at `dashboard/index.js:1898` — checker mis-reads an `errMsg` string (`'Teltik query: invalid JSON response'`) as a `status` column value. Pre-existing, unrelated to this session's work. Did not block the worker deploys.

**Untracked artifacts left in place (not committed):** `scratch/force_rotate_atomic.sh`, `scratch/force_rotate_wing.sh`, the `*_iccids.txt` lists, and their `.log` files — the force-rotate tooling used this session.

---

## Session 60 (2026-05-25) — Reseller portal self-serve resend & visibility

**Goal:** Give Maxim/TrustOTP recovery primitives after session-59's PR-B incident left him blind to under-rotation. Scope: webhook resend only, no manual MDN rotation, no vendor cost exposure.

**Shipped:**

- **Migration `reseller_portal_resend`** — added `webhook_deliveries.source` (`cron|pipeline|portal_resend|portal_resync`) and `webhook_deliveries.sim_id` (with 93,395-row backfill from `payload.data.sim_id`), plus indexes. New `reseller_actions_log` table for rate-limit accounting.

- **`reseller-sync` worker** — new service-binding-only endpoints `POST /resend-online` and `POST /resync-reseller`. New `resendOneSim(env, simId, source)` helper (reuses `sendWebhookWithDeduplication` with `force: true` + timestamp-salted message_id). New `resyncReseller(env, resellerId)` with bounded concurrency (5 parallel) and offset pagination (no 1000-row PostgREST cap).

- **`reseller-portal` worker** — new authenticated endpoints `POST /api/sims/:simId/resend-online`, `POST /api/sims/resync-all`, `GET /api/sims/:simId/online-history`. Service-binding `RESELLER_SYNC` added to wrangler.toml.

- **Rate limits enforced server-side:** bulk resync 1/reseller/10min; per-SIM resend 1/SIM/5min AND 100/reseller/hour. Violations return HTTP 429 with `retry_after_seconds`.

- **Portal UI** — per-row "Resend" button on active SIMs; top-bar "Resync all" + "Download CSV" buttons; new "Number.online history (last 20)" section in the SIM lifetime modal. Added `showConfirm`/`showToast` inline-modal helpers (no native dialogs per memory).

**Production smoke test:** Fired `POST /api/sims/2175/resend-online` against prod (`portal.incoming-sms.com`). Got HTTP 200 `{"ok":true,"delivered":true,"http_status":200,"rental_id":1552214}`. `webhook_deliveries` row id=`8917240a-7298-4d34-8d44-2b25f1f28087` landed with `source=portal_resend, status=delivered, response_body={"success":true,"message":"End date updated for existing rental","rentalId":1552214}`. `reseller_actions_log` row id=8 landed with `reseller_id=3, action=portal_resend, sim_id=2175`. History endpoint returned JSON array with the just-fired `portal_resend` row at position 0.

**Deployed:**
- `reseller-sync` prod version `b9c5ee84-098b-4f6d-b680-f6cfd070bd77`
- `reseller-portal` prod version `f62217e7-6020-4313-942a-5d223d257c7d`
- Test env earlier versions in case rollback needed: reseller-sync-test `e801bc55`, reseller-portal-test `8dd48aa7`

**Plan + spec on disk:**
- Spec: `docs/superpowers/specs/2026-05-25-reseller-portal-resend-design.md`
- Plan: `docs/superpowers/plans/2026-05-25-reseller-portal-resend.md`

**Operator follow-up:**
- Once Maxim confirms the new buttons work for him, document the feature in any reseller-facing doc.
- Spot-check `webhook_deliveries` filtered by `source IN ('portal_resend', 'portal_resync')` over the next 24h to confirm normal usage patterns (no abuse, rate limits engaging when expected).
- Known limitation (spec §12): a >2000-SIM bulk resync may exceed CF Worker 30s wall-clock; current TrustOTP at ~2057 SIMs completed comfortably under that during test. If a new larger reseller is onboarded, revisit `ctx.waitUntil` pattern.

**Optional hardening deferred (from code reviews, not blockers):**
- Wrap `rental` in `esc()` in resendOne confirm body (defense in depth)
- Add `try/catch` to `openLifetime` Promise.all so a lifetime-API failure shows a toast instead of leaving "Loading…" stuck
- TOCTOU race between rate-limit check and log insert (operationally benign — TrustOTP is idempotent)

---

## Session 59 (2026-05-23 evening) — Maxim's "they did not come" diagnosis

**No code changes. Pure investigation triggered by Maxim/TrustOTP message: "They did not come. We had 1300-1400 numbers active all the time."**

**Findings:**

1. **His report is correct.** His daily $1.60 (Teltik) row crashed from 728 (5/21) → **92 (5/22)** → 676 (5/23). Maps 1:1 to our `carrier_api_logs vendor=teltik step=change_number_initiate` and matches rotation-review run #5 (`teltik.rotated=92, success=92`). ATT side (~520/day, $1.10 tier) unaffected.

2. **Root cause already known.** The 5/22 dip is **residual fallout from the PR-B incident** (already in session 58 cont. notes). Timeline:
   - 5/20 18:06 UTC — PR-B deployed with malformed PostgREST query, aborted whole rotation function (PGRST108).
   - 5/20→5/21 night cron — 0 SIMs rotated.
   - 5/21 13:11 UTC — fix deployed (`da7f55c`).
   - 5/21 09:11 ET — manual catch-up rotated 714 SIMs at midday.
   - 5/21→5/22 night cron — only ~92 SIMs were genuinely due (the 714 manual SIMs were 15h post-rotation, not yet eligible).
   - 5/22→5/23 night cron — 676 rotated (the cohort that should have rotated 5/20 night, ~2.5 days overdue, finally cleared).
   - **No bug remaining**, but ~600 rentals worth of customer revenue on 5/22 are permanently lost.

3. **Secondary effect — drift from manual catch-up.** The 714 manual-batch SIMs got `last_mdn_rotated_at` stamped at 09:11 ET. With 48h interval they next become due at 09:11 ET on 5/23 — **outside the 0-5 ET cron window**. Their next rotation slips to 0:10 ET on 5/24 (~63h since last rotation). One night of drift then realigns. Maxim may see another small dip on 5/24 morning.

4. **Rotation-review has a structural gap (deferred for now).** `runRotationReview()` only tallies SIMs that *did* rotate. It has no expected-vs-actual baseline, so a night with 92/750 emails `✅ all clear`. Captured as memory `project_rotation_review_under_rotation_gap.md` to review later — user explicitly said don't implement now.

5. **Reseller-side notification was healthy throughout.** `webhook_deliveries event_type=number.online status=delivered` returned 200 + valid `rentalId` on every 5/22 and 5/23 rotation (1248 + 1965 respectively). Maxim's system accepted every rental we created — the deficit is rotations we never made, not notifications we lost.

**Architectural fragility flagged (also deferred):**
- teltik-worker `rotateTeltikSims` iterates serially in a single cron invocation with no resumable batch / per-tick run record. If any tick throws past the inner try/catch, all remaining SIMs are silently dropped. `cron_runs` only tracks `rotation_review`, never the cron itself.
- No daytime catch-up tick — a SIM that becomes due at 09:00 ET waits 15h for the next 0-5 ET window.
- No `MDN_QUEUE`-style retry; teltik runs purely inline.

**No commits, no deploys this session.** Findings only.

---

## Session 58 cont.cont. (2026-05-21 ~14:30–18:30 UTC) — daily rotation review automation

**Goal:** ship a daily automated rotation review so the operator never again has to spend hours manually draining unrotated cohorts (per the morning's misadventure). User-approved scope from `sim-rotation-cron-spec.md` (cut down to fit solo-operator scale).

**New endpoint `details-finalizer /rotation-review`** (`6190c135` → `7616358f` → `19da0151` → progressively):
- Acquires a run-lock via `cron_runs` table (partial unique index `(kind) WHERE status='running'` prevents concurrent runs; stale auto-expires after 30 min).
- Tallies tonight's rotations per vendor from `sims.last_mdn_rotated_at >= today_NY_midnight`.
- Classifies failed SIMs via the new `src/shared/rotation-playbook.mjs` (10 patterns: `teltik_already_rotated`, `teltik_body_failed`, `stuck_sweeper`, `atomic_ppu_exhausted`, `atomic_pre_swap_504`, `atomic_address_invalid`, `swap_zip_rejected`, etc.). Each entry has a regex matcher + action (`flip_to_mdn_pending` / `force_rotate` / `human_review`) + `safe` flag.
- Auto-fixes safe patterns: flips "Only 1 per 48h" Teltik failures → mdn_pending (so finalizer syncs new MDN); force-rotates `stuck_sweeper` once (bounded by per-SIM 3-attempts-per-NY-day budget via new `attempts_today(sim_id, action)` SQL helper + new `remediation_attempts` table).
- **Vendor 5xx circuit breaker:** 5 consecutive 5xx responses from any vendor → skip remaining SIMs for that vendor in the current run; surfaces in report.
- **Second-read verification on atomic:** after force-rotate, calls `/atomic-inquiry` (via `MDN_ROTATOR` service binding) to confirm the new MSISDN actually changed.
- **Multi-day pattern detection:** walks `remediation_attempts` last 7 days grouped by SIM; flags SIMs failing force_rotate 3+ consecutive days.
- **Resend email delivery** (gated on `RESEND_API_KEY` + `REPORT_EMAIL_TO` secrets — operator will add when ready). Subject line varies by urgency (✅ clean / 🔧 needs review). Inline markdown→HTML converter built into the worker.
- Stores rendered report in `cron_runs.report_md` so dashboard can replay.

**Worker-to-worker fix:** switched force-rotate + atomic-inquiry calls from public `.workers.dev` URLs to service bindings (CF blocks worker→public-.workers.dev with 404s). Added `TELTIK_WORKER` binding to `details-finalizer/wrangler.toml` alongside existing `MDN_ROTATOR`.

**CCR routine `rotation-review`** (id `trig_017nq9h7VPDnfoSy6dLhRnCR`, cron `30 12 * * *` UTC):
- Runs daily ~12:37 UTC (claude.ai jitter).
- Curls `/rotation-review`, saves markdown to `agent/rotation-reviews/YYYY-MM-DD.md`, appends an "Agent assessment" section (clean/acceptable/concerning/critical rubric), commits + pushes to main.
- Authorized for: bounded extra force-rotates (max 5/run, 60s timeout each), pool refill trigger if quarantine spike. Forbidden: code changes, bulk drains, retry of "Only 1 per 48h" SIMs (the endpoint already handles those).
- Manage at https://claude.ai/code/routines/trig_017nq9h7VPDnfoSy6dLhRnCR

**Dashboard "Rotation Reviews" tab** (dashboard `cc95ff48`, at `/rotation-reviews`):
- Sidebar entry with auto-polling open-pending-count badge (refreshes every 60s).
- "Run review now" button → POSTs to dashboard `/api/rotation-review/run` which proxies via `DETAILS_FINALIZER` service binding (~5s).
- Last-10 reviews table from `cron_runs` (started, status, duration, per-vendor tally, failed count, pending count) with "View" button opening a markdown-rendered modal of the full report.
- **Pending operator items widget** — `kind` badge + status badge + agent's summary + actions (Reply / Ack / Snooze / Dismiss). Reply opens a modal textarea, submission writes to `pending_review_items.operator_response`, the next morning's review reads it and surfaces in "Operator responses since last run".
- **Ask-the-agent textarea** — types message, hit "Save for next run" (creates `kind=operator_question` pending item) or "Save + run now" (also triggers immediate review run).

**New tables (live in Supabase):**
- `cron_runs` (run-lock per kind + run history with summary jsonb + report_md)
- `remediation_attempts` (per-SIM action history; powers attempts_today RPC + multi-day pattern detection)
- `pending_review_items` (two-way operator↔agent inbox)

**New API routes on dashboard worker:**
- `GET /api/rotation-reviews?limit=N`
- `GET /api/rotation-reviews/:run_id`
- `POST /api/rotation-review/run`
- `GET /api/pending-items?status=...&limit=N`
- `POST /api/pending-items/:id/respond` (action: reply/acknowledge/snooze/dismiss)
- `POST /api/operator-question` (creates `kind=operator_question` pending item)

**To finish (operator action):**
1. **Set Resend secrets on details-finalizer** to enable email delivery (otherwise reports just commit to repo via the CCR routine):
   ```bash
   cd src/details-finalizer
   printf "re_yourkey"               | npx wrangler secret put RESEND_API_KEY      --env=""
   printf "zalmen@zmawsolutions.com" | npx wrangler secret put REPORT_EMAIL_TO    --env=""
   # Optional sender override (default: rotation-review@incoming-sms.com)
   printf "alerts@zmawsolutions.com" | npx wrangler secret put REPORT_EMAIL_FROM  --env=""
   ```
   Sender domain needs SPF/DKIM in Resend's dashboard.

2. **First CCR routine fires tomorrow ~12:37 UTC.** Watch `agent/rotation-reviews/2026-05-22.md` for the first auto-generated report.

3. **Open dashboard `/rotation-reviews`** to manage pending items, trigger ad-hoc runs, ask the agent questions.

**Files changed this sub-session:**
- `src/details-finalizer/index.js` (+~600 lines: lock, playbook integration, circuit breaker, second-read, multi-day, Resend, pending-items writes)
- `src/details-finalizer/wrangler.toml` (added `TELTIK_WORKER` service binding)
- `src/shared/rotation-playbook.mjs` (NEW; 10 patterns)
- `src/dashboard/index.js` (+~672 lines: tab markup, JS handlers, 6 new API routes)
- Migrations applied: `rotation_review_lock_and_attempts`, `rotation_review_dashboard`, `claim_address_pool_entry_returns_row`, `address_pool_usage_add_address_fields`, `list_zips_needing_refill`
- CCR routine `trig_017nq9h7VPDnfoSy6dLhRnCR` created + updated to point at the new endpoint

**Reference doc:** `sim-rotation-cron-spec.md` (untracked at repo root) — operator's original spec. Implemented the "right balance" subset per agreement; full spec items skipped: approval signing/2FA, separate sim_rotation_checks/pending_approvals tables, cost tracking, SMS fallback, healthchecks.io dead-man's switch, snapshot-before-bulk, 30% rate-budget reserve, idempotency keys.

---

## Session 58 cont. (2026-05-21 ~13:00–14:30 UTC) — overnight rotation post-mortem

**Discovered: tonight's Teltik cron rotated 0 SIMs** despite ~714 Group B SIMs being eligible. Root cause: PR-B (shipped at 01:38 UTC) introduced a malformed PostgREST URL in the retry-candidates query — `reseller_sims!inner(reseller_id,active)` was a standalone URL parameter instead of inside `select=`. PostgREST rejected every cron tick with `PGRST108: 'reseller_sims' is not an embedded resource in this request`. The exception propagated up through `rotateTeltikSims` and was caught at the scheduled() handler level, which just logged and exited — silent failure, zero DB writes, no SIM rotated all night. **Fixed in commit `da7f55c` / version `bd5ed97d`:** moved embed inside `select=`; wrapped retry-candidates fetch in try/catch so a future malformed query in the retry path can never again kill the main rotation pass.

**Also discovered: 39 atomic SIMs failed PPU at the very first cron tick (04:16 UTC) and were locked out for the rest of the night** because the cron's pre-filter `last_mdn_rotated_at >= today_NY_midnight` excluded any SIM that `claim_rotation_slot` had stamped during the failure. My PPU retry-loop fix (commit `327abaf`, deployed 06:19 UTC) was deployed AFTER those SIMs had been claimed and stamped, so it didn't help them.

**Manual drain performed (all force-rotate from operator workstation, ~13:00–14:25 UTC):**
- **Atomic** — `/tmp/force_rotate.sh` looped curl `/rotate-sim?force=true` over all 43 failed SIMs. 42 succeeded (PPU retry loop validated end-to-end on real traffic). 1 SIM (#674) failed at `pre_swap_inquiry` — pre-existing AT&T-side issue, not retryable.
- **Teltik** — `/tmp/teltik_parallel.sh` fired 627 eligible SIMs at 15-way parallel via `/rotate-sim?force=true`. 540 returned `ok+pending` cleanly. **87 hit CF wall-clock (worker killed before the change-number HTTP response was captured); Teltik DID rotate them but our DB never learned.** After 30 min the stuck-state sweeper flipped those 99 to `rotation_status='failed'`. Confirmed via retry pass: 96 came back `Only 1 number change allowed per sim in 48 hours.` (Teltik's own guard).
- **Bulk SQL flip:** `UPDATE sims SET status='provisioning', rotation_status='mdn_pending' WHERE last_rotation_error LIKE '%Only 1 number change allowed%'` (96 rows). Then `details-finalizer /run?limit=...` loop (5 passes × ~90s) drained the resulting 283 mdn_pending cohort to success+notified via `get-phone-number` + `number.online` webhook.

**Final overnight tally:**

| Vendor | Rotated | Notified | Pending finalize | Genuinely failed |
|--------|---------|----------|-----------------|------------------|
| Atomic | 292 | 290 | 2 | 1 (SIM 674, pre_swap_inquiry) |
| Teltik | 734 | 720 | 11 | 3 (SIM 3576 same MDN, 3364 + 3309 Teltik body FAILED) |
| Wing IoT | 263 | 263 | 0 | 0 |
| **Total** | **1289** | **1273 (98.8%)** | **13** | **4** |

The 13 pending will clear in the next two 5-min finalizer cron ticks.

**Lessons / followups:**
1. **PR-B URL bug never tripped in any pre-deploy test** because no test exercises the cron path. Need a smoke check for PostgREST `PGRST*` errors in the cron handler that alerts immediately rather than silently logging.
2. **Parallel drain pattern (curl 15-way) is too aggressive for CF Worker wall-clock.** Better pattern for future drains: bounded parallel with 5–10 concurrent + 60–90s per-call timeout, OR add `ctx.waitUntil` inside the worker's `/rotate-sim` handler so the HTTP response doesn't kill the rotation work.
3. **Stuck-state sweeper masked the real symptom for 30 min** (rotations were *initiated* at Teltik but our DB went straight from `rotating` → `failed` instead of `rotating` → `mdn_pending` → `success`). Could shorten the sweeper's 30-min threshold or add a sibling sweeper that calls `get-phone-number` before declaring failure.
4. **Cycle-group concern revived.** The current single-cohort design means a bug in one cron tick wipes out ~700 customer-facing rotations all at once. Splitting Teltik into Cycle Groups A/B (deferred per `project_teltik_cycle_groups_deferred.md`) would have halved the blast radius. Still deferred unless this pattern recurs.

---

## Session 58 (2026-05-21 earlier) — PPU retry + DB-driven pool

**Apex PPU retry loop (mdn-rotator `1646b5cd`):** rotateAtomicSim + rotateSingleSim helix mirror now wrap the PPU step in a 3-attempt loop. First pick excludes current state+zip; retries drop exclusions for any-zip LRU. If all attempts fail, `last_mdn_rotated_at` is restored to its pre-claim value so the next cron tick re-attempts the SIM instead of locking it out via the "< NY midnight" gate. Diagnosed via SIM 652: tonight's apex flow stamped `last_mdn_rotated_at=NOW()` on claim but PPU failed → SIM was effectively stuck until tomorrow night. Now self-recovers.

**Address pool → DB-driven (migration `address_pool_usage_add_address_fields`):** added `street_number, street_name, street_direction, city` columns to `address_pool_usage`, backfilled all 1529 rows from the static `src/shared/address-pool.mjs`, replaced `claim_address_pool_entry` RPC to return the full address row as JSONB. `pickNextPpuAddress` in `src/shared/address-picker.mjs` no longer imports `ADDRESS_POOL` — the JSONB shape from the RPC maps directly to `{id, streetNumber, streetName, streetDirection, city, state, zipCode}`. Dropped `seedAddressPoolUsage` helper + `scripts/seed-address-pool.mjs` (obsolete; backfill done via SQL). Static `src/shared/address-pool.mjs` kept as the original seed reference; runtime never imports it. Deployed: mdn-rotator `abd5d316`, bulk-activator `27cf893c`.

**Address-pool refill cron (details-finalizer `3dce46f2`):** new `0 */6 * * *` cron runs `runAddressPoolRefill(env)` which calls new RPC `list_zips_needing_refill(p_limit)` (returns ≤5 zips where every entry is quarantined), queries OSM Overpass per zip (state-scoped via `area["ISO3166-2"="US-XX"]` for performance — global postcode regex 504s), picks first valid civic-building address that differs from the quarantined one, INSERTs into `address_pool_usage`. Quarantined row preserved as history; new row has `last_used_at=NULL` so it's first LRU pick. Manual trigger: `GET /refill-pool?secret=...[&max=N][&dry=1]`. Direct fetch (not relayFetch) for Overpass — public unauthenticated API, relay routing was timing out. Smoke-tested: ak-99587-250-egloff-road quarantined → ak-99587-186-egloff-road inserted as replacement. Backlog this morning: 38 orphan zips remaining (was 39, one refilled in smoke test); drains at 20/day with the 6h cron.

**Hot starts for next session:**
- 04:25 UTC cron tick (and subsequent ones in the `*/5 4-11 UTC` window) should exercise the new PPU retry loop on any SIM that failed tonight. Expected: ~39 SIMs that failed at 04:16 will get re-attempted; address quarantine means they'll pick a different (likely good) OSM address.
- 06:00 UTC will be the first refill-cron tick. Watch CF logs for `[Refill] processing N zip(s)` and `[Refill] <STATE> <ZIP>: replaced|no_alternative|error`. Self-paced — only 5 per run, with 5s polite delay between OSM queries.
- Monitor address_pool_usage growth: each refill adds one row; over weeks/months the pool will grow beyond 1529 entries naturally as addresses get rejected and refilled.

---

## Known Issues / Degraded

- **MDN rotation runs DB-driven, every 5 min NY 0–5** — cron `*/5 4-11 * * *` UTC, `scheduled()` calls `processRotationBatch(env, {limit: 60, concurrency: 3})` inline after the NY-hour gate. No CF Queue on the rotation hot path. Bindings for `mdn-rotation-queue` still present in `wrangler.toml` but unused — remove after one full healthy overnight run.
- **38 ATOMIC SIMs marked `status='rotation_failed'` (2026-04-24)** — all return `swapMSISDN statusCode=915 "sim/MSISDN is Inactive"` because AT&T has them in SOC `DSABR2,ZZNOILD2,NIRMAPEX,APEXBLOCK,APEX128` (data-suspend/barred). AT&T is also silently reassigning MDNs on them outside our system. No MDN-rotation attempts are made for these — `queueSimsForRotation`/`processRotationBatch` filter on `status='active'`. Needs external escalation to ATOMIC (email draft in session notes).
- **2 Wing IoT SIMs stuck on ABIR (2026-04-29 morning)** — IDs 1110 and 1212. Same per-SIM plan-change-quota pattern as the 71-SIM cluster from 2026-04-27. Both flagged `rotation_status='failed'` so tomorrow's NY 0–5 cron will pick them up via `processRotationBatch`'s stuck-wing pass. AT&T daily quota reset usually clears these.
- **506 Teltik SIMs `rotation_status='failed'` from 2026-05-20 cron (cleanup in progress)** — operator was force-rotating manually during session 55. Top causes: ~457 false-FAILED (Teltik body-status bug; fixed by Fix #1, deploy of `teltik-worker 47cf46ef`); 37 Teltik HTTP 502; 9 stuck in `rotating` (worker crash mid-flight). Most are recoverable via manual force-rotate; until PR-B lands, the cron will not retry them in the same window. Cohort should drain naturally on subsequent nights now that Fix #1 prevents new false-FAILED entries. The earlier 2026-04-29 SIM 857 incident was almost certainly an instance of this same bug.
- **API Logs tab shows blank for ATOMIC SIMs** — the dashboard "API Logs" section queries `helix_api_logs`; ATOMIC activations log to `carrier_api_logs`. ATOMIC SIM logs are invisible in the dashboard tab. Fix: update the API Logs query to also check `carrier_api_logs` (or unify into one view).
- **SIM 991 wrong vendor account** — ATOMIC subsriberInquiry returns "SIM does not belong to this vendor". ICCID is not under the `ezbiz` ATOMIC account. Cannot be fixed by restore; needs investigation with Wing Alpha (dan@wingalpha.com) to determine correct account or whether SIM should be removed.
- **Wing IoT SIMs 632, 781, 1019, 1108, 1109 have no gateway/port** — rotation will fail at `callSkylineSetImei` step. These are floating SIMs not physically inserted into any gateway. Rotation will error on first attempt; they'll hit rotation_failed after 3 failures unless assigned to a gateway slot first. **Note:** Wing IoT plan-swap rotation does NOT need a gateway, only Helix/Skyline-IMEI flows do — so these 5 do rotate fine via `rotateWingIotSim` and the 2026-04-28 reconciliation work confirmed it.
- **SIM 685 still in `error` state** — needs a retry activation. Run retry from dashboard.
- **Wing IoT `number.online` webhook NOT sent on activation** — bulk-activator does not call `sendNumberOnlineWebhook` after activation. Resellers won't be notified until the first rotation cron or daily reseller-sync sweep. Fix: add webhook call to bulk-activator after MDN is synced (OR update bulk-activator to set status='provisioning' so details-finalizer handles it — now that details-finalizer has the Wing IoT branch). **NOTE:** the new details-finalizer Wing IoT runner already handles post-activation (`msisdn IS NULL` + `status=provisioning`) and sends the webhook, so this may already be fixed — verify on next activation.
- **Wing IoT retry activation may still fail with "already active"** — 914 handling is ATOMIC-only. Wing IoT already-active case is not explicitly handled (Wing IoT returns HTTP error codes, not status codes in body, so it would throw and surface in the error log normally).
- **Teltik bulk query needs hard-refresh verification** — code is deployed and correct but user saw all 50 SIMs route to helix (likely stale browser cache). Next session: confirm bulk query routes teltik vendor correctly after hard refresh (Ctrl+Shift+R).
- **Billing Ledger: 149 phantom Apr-5 helix rows for SIMs canceled in March** — `regenerateLedgerForVendor` bulk-fetches `sim_status_history` ordered by `changed_at desc` in chunks of 200 SIM IDs; with ~625 helix SIMs and lots of recent activity, the older March cancel rows fall off the page-1 cap so `findCancelTimestamp` returns null for those SIMs and the loop generates cycles all the way to today. **Fix:** filter the history query to terminal-status rows only (`new_status=in.(canceled,cancelled,error,abandoned)`) — shrinks result by ~10× so pagination never truncates. Verified pattern: SQL query with that filter returns the correct cancel ts for SIM 9 (2026-03-20). Quick patch — defer to next session unless user wants it now.
- **`WING_EXPECTED_RATE = "5.00"` env var on dashboard worker is unused** — replaced by `plan_rates` table lookup. Remove from `src/dashboard/wrangler.toml` `[vars]` block when convenient. Harmless if left in.
- **Bill audits stored before 2026-05-07 may have stale discrepancy_type/expected_price** — pre-session-46 audits compared each line against the rate active *today* rather than the rate active on the line's `from_date`. If a rate changed since the audit was run (or if Teltik plans need to be configured retroactively), those rows can be refreshed via `POST /api/bill-audit/recompute?upload_id=N`. Or just delete + re-upload the CSV via the new red Delete button in Audit History.
- ~~`Deploy shared dashboard preview` workflow broken~~ — **RESOLVED 2026-09-08 in PR #73.** Real cause: the step ran `wrangler secret put DASHBOARD_AUTH --env test --name dashboard-test`, and wrangler appends the env suffix to an explicit `--name`, so it targeted a phantom worker `dashboard-test-test`. Fixed by dropping `--name` and resolving the target from `[env.test]` in `src/dashboard/wrangler.toml`, like every other step in the file. **Cautionary note for the next reader:** Cloudflare answers a secret write to a nonexistent script with `Invalid access token [code: 9109]` / `Authentication error [code: 10000]`. That error is about the *script*, not the token — do not go rotate a working credential on the strength of it. This session initially misdiagnosed it exactly that way.
- **A failed ATOMIC port-in is invisible in the dashboard unless you already know which SIM to open (2026-09-08)** — this is the live gap left by the finalizer work. Terminal handling clears `port_in_pending` and deliberately leaves `sims.status` alone, so a rejected port sits at `status='provisioning'`, `port_in_pending=false`, `last_activation_error=null` — indistinguishable in the SIMs list from a SIM that is healthily mid-provisioning. The carrier's reason *is* stored (`atomic_portin_description`) and *is* rendered, but only in the SIM detail modal's "Port-In Status" row (`src/dashboard/public/index.html:13538`). There is no column, no filter, no badge, and nothing written to `pending_review_items`. **13 SIMs are in this state right now and cannot be discovered from the UI: 36092–36105 (twelve `948`) and 36217 (`951`).** Stopgaps: set `status='error'` + `last_activation_error` on terminal port-in failures (no dashboard work, reuses every existing error surface), or write a `pending_review_items` row per failure (reuses the rotation-review widget/badge). Proper fix is the `port_in_requests` model below.
- **Port-in state is modeled as four columns on `sims`, which can only ever describe one attempt (2026-09-08)** — `port_in_pending`, `atomic_portin_status_code`, `atomic_portin_description`, `atomic_portin_checked_at`. Correcting a rejected port and resubmitting overwrites the first attempt's record, so there is no attempt history and no way to see "third rejection, same account, escalate". `port_in_pending` also conflates "port is in flight" with "the cron should poll this". The carrier's actionable reason (`statusReasonCode - 8A`) is stored as prose, so nothing can group, count, or route by failure cause. **Recommended long-term shape:** a `port_in_requests` table (one row per attempt, with `state`, parsed `carrier_reason_code`/`status_reason_code`, `failure_category`, `supersedes_id`, real transition timestamps) plus a `port_in_events` audit table copying `rental_report_events`, plus a `src/shared/portin-playbook.mjs` following `rotation-playbook.mjs`. The poller then reads the table instead of `sims`, and the dashboard gets a Port-Ins page modeled on Activation Runs. Same entity+events pattern this repo already converged on for `activation_runs`, `hosting_port_status_jobs`, and `rental_reports`. **Do not add a fifth column to `sims`** — that is how this got here.
- **3 SIMs stranded at `port_in_pending=true` with `status='active'` (pre-existing)** — IDs **36054**, **36073** (`atomic_portin_status_code=null`, never polled successfully) and **36055** (code `00`). The finalizer's query filters `status=eq.provisioning`, so these are invisible to it and will never clear. Harmless — they generate no carrier calls — but the flag is wrong. Clear manually or widen the query.
- ~~Apex PPU address-pool contaminated with synthetic addresses~~ — **RESOLVED 2026-05-20.** Pool replaced via `scripts/build-address-pool.mjs` (OpenStreetMap Overpass API → 1529 entries, 50 states × 30 + DC × 29). `address_pool_usage` TRUNCATEd + reseeded. Self-heal layer (migration `address_pool_usage_verify_failure`, `markAddressVerifyFailure` in picker, try/catch in `rotateAtomicSim`) means any address AT&T rejects gets quarantined for 90 days and never re-picked. Re-canary on SIM 2619: 3 consecutive force-rotations succeeded (AL 35112 → AK 99504 → AL 35209), final state `msisdn=2059486765 activation_zip=35209 status=active rotation_status=success`.

---

## In Progress / Pending Work

### Apex PPU-then-MDN — Phase 2 closed; live canary on SIM 2619 (session 57, 2026-05-20)
**Status: apex flow shipped, flag ON, canary live on SIM 2619 only. End-to-end validated across 3 consecutive force-rotations with the new OSM pool. Tomorrow's `*/5 4-11 UTC` cron will exercise apex on production code path for SIM 2619 (legacy for the other ~625 atomic SIMs since their `canary_apex_ppu` is still false).**

**Plan:** `docs/superpowers/plans/2026-05-20-apex-ppu-then-mdn.md` (6 phases, ~25 tasks). **Spec:** `docs/superpowers/specs/2026-05-20-apex-ppu-then-mdn-design.md`.

**Done this session (7 commits on `main`, all live; mdn-rotator now at version `8f9f0665`):**
- **Task 2.1** (`85fa96c`) — added `atomicUpdateSubscriberInfo(env, {session, msisdn, address}, runId, iccid)` helper in `src/mdn-rotator/index.js` just above `rotateAtomicSim`. Uses `relayFetch`, logs `step='ppu_update'` via `logCarrierApiCall`, throws on non-`'00'` statusCode.
- **Task 2.2** (`3f12b5e`) — added `import { pickNextPpuAddress } from '../shared/address-picker.mjs'`; appended `,canary_apex_ppu` to the two `sims?select=` queries that feed `rotateAtomicSim` (lines 1417 + 1498); inserted apex flow between `pre_swap_inquiry` success and `swapMSISDN`, gated by `APEX_PPU_THEN_MDN_ENABLED='true'` AND (`APEX_PPU_CANARY_ONLY!='true'` OR `sim.canary_apex_ppu===true`). `wrangler.toml` has no `[vars]` block — env flags live as wrangler secrets.
- **Task 2.3** — deployed `--env=""` to prod (`a3bc6107`) with flag unset; verified `ppu_update_total_24h=0` while `atomic_swap_ok_24h=289` — legacy path healthy, apex dormant.
- **Picker env-var fix** (`4e3fbcc`) — first canary returned `HTTP 401 "Invalid API key"`. Picker used `env.SUPABASE_SERVICE_ROLE`, project convention is `SUPABASE_SERVICE_ROLE_KEY` (see `src/dashboard/index.js:440`, `src/bulk-activator/index.js:423`, `src/skyline-gateway/index.js:356`). Renamed in picker + test + seed; redeployed.
- **Task 2.4 first run (mixed)** — SIM 2619 canary: rotation 1 succeeded end-to-end (`ak-99501-632-w-6th-ave` = Anchorage City Hall; MO 314 → AK 907); rotations 2 + 3 failed at `ppu_update` because the picker chose synthetic AL addresses (`100 Municipal Dr, Moody`, `400 Blount County Blvd, Oneonta`) that AT&T's CASS-style verifier rejected. Root cause: the 1122-entry pool was LLM-generated and contained fabricated entries.
- **Phase A — Self-heal layer** (`6ad20f2`) — migration `address_pool_usage_verify_failure` adds `verify_failed_at timestamptz` + `last_verify_error text` columns + `address_pool_usage_verify_failed` index; updated `claim_address_pool_entry` RPC to skip rows where `verify_failed_at IS NOT NULL` (or `> 90 days ago` — auto-retest). New `markAddressVerifyFailure(env, addressId, err)` export in `src/shared/address-picker.mjs` PATCHes those columns. `rotateAtomicSim` wraps `atomicUpdateSubscriberInfo` in try/catch that calls `markAddressVerifyFailure` before re-throwing. The 2 known-bad AL addresses were quarantined directly in DB. Deployed as `125a23bd`.
- **Phase B — OSM pool builder** (committed as part of `78efdb4`) — `scripts/build-address-pool.mjs` queries OpenStreetMap Overpass API per-state for tagged civic buildings (`amenity=post_office|library|townhall|courthouse|fire_station`) with complete `addr:housenumber + addr:street + addr:city + addr:postcode`. Built-in retry on 429/504 (transient Overpass errors — seen on WV and TN during the 51-state run). Polite 5s delay between states; ~8 min runtime for full build. Picker logic enforces one ZIP per state (no duplicates).
- **Phase C — Pool replaced + reseeded** (`78efdb4`) — `src/shared/address-pool.mjs` now contains **1529 OSM-sourced entries** across 51 states (50 × 30 + DC × 29). `address_pool_usage` was `TRUNCATE`d and reseeded via 6 chunked `INSERT ... ON CONFLICT DO NOTHING` statements through Supabase MCP — final state `row_count=1529, states=51, unused=1529`. Verifier still passes. Deployed as `8f9f0665`.
- **Re-canary validation** — re-enabled `APEX_PPU_THEN_MDN_ENABLED=true` secret, `UPDATE sims SET canary_apex_ppu=true WHERE id=2619`, force-rotated 3 times. **3/3 success.** Picks were `25 Post Office Drive, Moody AL 35112` → `1251 Muldoon Road, Anchorage AK 99504` → `2850 19th Street South, Homewood AL 35209`. SIM ended at `msisdn=2059486765 (AL 205)`, `activation_zip=35209`, `status=active`, `rotation_status=success`. Pool LRU advanced correctly; picker excluded the SIM's previous state+zip on each pick.

**Current production state (left intentionally as-is overnight):**
- `APEX_PPU_THEN_MDN_ENABLED='true'` secret on mdn-rotator prod.
- `APEX_PPU_CANARY_ONLY` never explicitly set — defaults to `'true'` in code.
- Only SIM `2619` has `canary_apex_ppu=true`. Tomorrow's `*/5 4-11 UTC` cron will rotate it via apex flow (production code path validation). All other ATOMIC SIMs continue legacy.
- `address_pool_usage`: 1529 rows / 51 states / 6 rows with `use_count=1` (3 from the new pool's successful canary picks, 3 from the pre-deploy "in DB but not in static pool" misses that still incremented use_count via the RPC). Zero quarantined rows now.
- 4 pool entries are now in OSM that weren't in the deployed bundle yet at the moment of canary rotation 1-3 — those got picked, returned "in DB but not in static pool" errors, and incremented use_count without being usable. Redeploy fixed it. (Lesson: redeploy worker first, *then* swap pool table.)

**Phase 3 — DONE (2026-05-21, commit `4946d26`):**
- mdn-rotator `hxActivate` (line ~3382) and `retryActivateViaAtomic` (line ~3437): replaced `pickRandomAddress` with `await pickNextPpuAddress(env, {})`. Functions were already async. Removed the now-unused `pickRandomAddress` import. Deployed as version `2681f1b8`.
- **bulk-activator (out of original plan scope but required):** the OSM pool rename in session 56 changed the entry shape from `{ address1, city, state, zipCode }` to `{ id, streetNumber, streetName, streetDirection, city, state, zipCode }`. Both `activateViaAtomic` (line ~209) and `hxActivate` (line ~367) still consumed `addr.address1` — the deployed prod bundle still had the old `.js` pool inlined so it kept working, but the *committed* code path was broken. Updated both sites: Helix activations now send `address1: ${streetNumber} ${streetName}`; ATOMIC activations send `streetNumber/streetDirection/streetName` directly. Same `pickNextPpuAddress(env, {})` picker. Deployed as version `ad5cc18f`.
- **Self-heal at activation:** all 4 sites wrap the AT&T-rejection path with a `markAddressVerifyFailure(env, addr.id, ...)` call when the response or error text matches `/address.*verif/i`. Symmetric with the apex rotation flow's catch block.
- **Verification:** code paths confirmed by syntax check + grep (no `pickRandomAddress` or stale `addr.address1` access remains). End-to-end verification deferred — last atomic activation was 2026-05-04; will validate organically on the next activation. Look for `step='activation'` rows in `carrier_api_logs` with the new request-body shape and a matching `address_pool_usage.use_count` bump.

**Phase 4 — DONE (2026-05-21, commit `c64dba7`, deployed as `ac1a10a7`):**
- Added two local helpers in `src/mdn-rotator/index.js` just above the local `hxMdnChange`: `splitStreetSuffix(streetName)` and `hxUpdateSubscriberDetails(env, token, data, runId, iccid)`. Helper hits Helix 4.4 (`PATCH /api/mobility-subscriber/details`) with both `address: {address1, city, state, zipCode}` AND the flat `streetNumber/streetName/streetType` fields per the spec's example shape; logs `step='ppu_update'` via the existing local `logHelixApiCall`.
- **Did NOT** touch `src/shared/helix.ts` (the plan's original target) because the rotator already maintains its own local `hxMdnChange`/`hxSubscriberDetails`/`logHelixApiCall` and doesn't import from `shared/helix.ts`. Mirroring the inline style keeps the helix rotation path self-contained.
- Inserted apex flow in `rotateSingleSim`'s helix branch just before `hxMdnChange`. Same gating as the atomic path (`APEX_PPU_THEN_MDN_ENABLED='true'` AND (`APEX_PPU_CANARY_ONLY!='true'` OR `sim.canary_apex_ppu===true`)). Flow: `hxSubscriberDetails` (pull current state+zip+subscriberNumber) → `pickNextPpuAddress(excludeState, excludeZip)` → `hxUpdateSubscriberDetails` → patch `sims.activation_zip` → continue to existing `hxMdnChange`. PPU call wrapped in try/catch that calls `markAddressVerifyFailure` on failure.
- **All 625 helix SIMs are `status != 'active'`** as of 2026-05-21 (migration to ATOMIC completed weeks ago) so this code is dormant in practice. Shipped for completeness + symmetry; will activate if helix activations ever resume.

**Canary expanded to full ATOMIC fleet for tonight's production validation (2026-05-21):**
- `UPDATE sims SET canary_apex_ppu=true WHERE vendor='atomic' AND status IN ('active','provisioning')` — flipped all 292 active ATOMIC SIMs in one shot (went 1 → 26 → 292 over the course of the session as confidence grew). 6 canceled atomic SIMs were excluded (cron doesn't rotate them anyway). All 292 belong to reseller_id=3.
- Tonight's `*/5 4-11 UTC` cron will rotate every active ATOMIC SIM through the full 4-step apex flow. Expected outcome: ~292 successful PPU+swap pairs in `carrier_api_logs`. Self-heal will quarantine any address AT&T rejects (90-day cooldown); affected SIMs will land in `rotation_status='failed'` for the night and drain on subsequent cron windows.
- **Morning-after query** (2026-05-21 ~14:00 UTC or later, after the cron window closes):
  ```sql
  SELECT
    count(*) FILTER (WHERE step='ppu_update' AND error IS NULL)     AS apex_ok,
    count(*) FILTER (WHERE step='ppu_update' AND error IS NOT NULL) AS apex_err,
    count(*) FILTER (WHERE step='mdn_change' AND vendor='atomic' AND error IS NULL)     AS swap_ok,
    count(*) FILTER (WHERE step='mdn_change' AND vendor='atomic' AND error IS NOT NULL) AS swap_err
  FROM carrier_api_logs
  WHERE created_at > '2026-05-21 04:00:00+00';
  ```
  Plus `SELECT count(*) FROM address_pool_usage WHERE verify_failed_at > '2026-05-21 04:00:00+00'` for quarantine rate. Targets: `apex_ok ≈ 292, apex_err small (<10), swap_err ≈ 0, new quarantines extrapolatable to < 10% of pool`.

**To finish (Phase 5):**
- **Phase 5** — expand canary to full atomic fleet after 24h+48h stability checks; then (if helix reactivates) helix; then remove the canary gate; drop deprecated `pickRandomAddress` from `src/shared/address-pool.mjs`; update `.claude/skills/atomic-api/SKILL.md` with Rule 5 (PPU before swap); append `agent/constraints.md` §<N>.

**Hot starts for the next session:**
- First: run the morning-after queries above. If `apex_ok ≈ 292 / apex_err small / swap_err ≈ 0`, the fleet has successfully transitioned to apex mode — proceed to Phase 5 cleanup (5.5 remove canary gate + 5.6 drop deprecated `pickRandomAddress` from `src/shared/address-pool.mjs`).
- If `apex_err` is high (>30 ≈ 10% of fleet), inspect failure shapes via `SELECT count(*), substring(error, 1, 80) AS err_prefix FROM carrier_api_logs WHERE step='ppu_update' AND error IS NOT NULL AND created_at > '2026-05-21 04:00:00+00' GROUP BY err_prefix ORDER BY count DESC`. Likely either OSM addresses AT&T rejects (self-heal already quarantined; nothing to do beyond watching the rate trend down each night) or transient AT&T 5xx.
- If a meaningful chunk of SIMs landed in `rotation_status='failed'` overnight, they'll naturally retry on subsequent cron windows; no manual intervention unless the cohort doesn't drain within 2-3 nights.
- Production state: mdn-rotator at version `ac1a10a7`, bulk-activator at version `ad5cc18f`. `APEX_PPU_THEN_MDN_ENABLED=true` secret on mdn-rotator. Pool at 1529 OSM-sourced entries with self-heal active. **ALL 292 active ATOMIC SIMs have `canary_apex_ppu=true`.**
- Plan references say `address-pool.js` / `address-picker.js` in many places — translate every such reference to `.mjs` when reading the plan tasks (still applies).

---

### PR-B: in-window retry for failed Teltik rotations — SHIPPED 2026-05-21 (session 58)
**Status: migration applied (MCP, name `claim_rotation_retry_slot`, function visible in `pg_proc`); teltik-worker deployed to prod as version `8560d111-7803-4445-86b1-6a1b60c5034a`. Awaiting first cron-fired exercise.**

PR-B adds a sibling RPC `claim_rotation_retry_slot(p_sim_id bigint)` and a second query+branch in `rotateTeltikSims` that picks up SIMs which failed earlier the same NY-night and retries them within the `10,40 4-11 UTC` cron window (with a 15-min per-attempt backoff). Does NOT touch `claim_rotation_slot` or any non-Teltik vendor path. Full revert: `DROP FUNCTION claim_rotation_retry_slot(bigint);` + `wrangler rollback teltik-worker` (previous version `47cf46ef`).

Predicate enforced inside the new RPC:
- `vendor = 'teltik'`
- `status IN ('active', 'provisioning')` (covers SIMs the stuck-state sweeper flipped to `failed` without restoring status)
- `rotation_status = 'failed'`
- `rotation_eligible = true`
- `last_mdn_rotated_at >= today's NY midnight` (failed-today only — protects against Teltik's own 48h server-side cooldown)
- `last_mdn_rotated_at < NOW() - INTERVAL '15 minutes'` (backoff)

**Pre-deploy sanity (01:36 UTC):** 5 Teltik SIMs matched the predicate at deploy time (all failed during the wrapping NY day). Those will roll off at 04:00 UTC (NY midnight) before the cron window opens. The first real production exercise happens when a SIM fails *during* tonight's `10,40 4-11 UTC` window and gets re-picked 30 min later by the same cron.

**Morning-after verification (run after 11:40 UTC = end of cron window):**
```sql
SELECT
  count(*) FILTER (WHERE rotation_status='success' AND last_mdn_rotated_at > NOW() - INTERVAL '12 hours') AS rotated_overnight,
  count(*) FILTER (WHERE rotation_status='failed'  AND last_mdn_rotated_at > NOW() - INTERVAL '12 hours') AS still_failed
FROM sims WHERE vendor='teltik';
```
Plus Cloudflare logs: `npx wrangler tail teltik-worker --search "in-window retry" --since 8h` should show `[Rotate] ... N eligible for in-window retry` lines. Watch for any `PGRST404` for `claim_rotation_retry_slot` (should be zero — migration is applied).

### Mastercard-inspired dashboard redesign — Test env only, awaiting user review (session 52, 2026-05-12)
Full visual reskin of `src/dashboard/index.js` per `DESIGN.md` (Mastercard editorial system: Canvas Cream `#F3F0EE` canvas, Ink Black `#141413` pill CTAs at 20px radius, Sofia Sans typography at weight 450 body / 500 headings with -2% tracking, oversized radii — 20/24/40/999px — eyebrow labels with signal-orange accent dot, soft 48px-spread shadows). Achieved by remapping the existing `--dark-N` CSS variable scale to cream tones (so all existing `bg-dark-*` / `text-dark-*` Tailwind class usages auto-style with zero per-element edits) plus an aggressive override layer that translates `bg-blue-*`/`bg-green-*`/`bg-red-*`/`bg-yellow-*`/`bg-orange-*` to Mastercard equivalents (blue→ink, green→forest, red preserved, yellow/orange→Signal Orange `#CF4500`). Page header rebuilt as eyebrow + dynamic title + subtitle, fed by a new `PAGE_HEADERS` map in `switchTab()` (Overview/Inventory/Inbox/Hardware/Identity/Incidents/Billing/Analytics/Reference/Tools). Sidebar brand: circular ink logo + "SMS Gateway / OPERATOR" eyebrow. Top-right `<span>` pill replaces the bare pulse dot for the "Connected" indicator. Theme-toggle hidden (single cream theme; legacy localStorage `theme` removed on load). +432 / −70 lines, only `src/dashboard/index.js` touched. **Deployed to `dashboard-test.zalmen-531.workers.dev` (version `e4c764b3-bea6-4dc7-97fe-1f335a0c93a2`). Prod (`dashboard.zalmen-531.workers.dev`) is unchanged.** User explicitly asked for "no commit yet" pending review; `src/dashboard/index.js` has the redesigned content uncommitted in the working tree. `DESIGN.md` (the reference doc) is untracked in repo root.

**CSS pitfall discovered**: class selectors of the form `.hover\:bg-blue-600:hover` (the standard Tailwind hover-variant escape) were being silently dropped by the browser CSS parser when read from the static `<style>` block — even though the **identical** rule parsed cleanly via `CSSStyleSheet.insertRule()`. Verified via `od -c` and curl that the HTTP response bytes were correct (`\` 0x5C + `:` 0x3A). Tailwind CDN's own generated stylesheet uses the same form and parses fine, so the root cause remains a mystery (may be Tailwind CDN's runtime DOM observer munging the inline `<style>` content in some pass). **Workaround**: rewrote those rules to attribute-selector form `[class*='hover:bg-blue-']:hover`, which avoids the `\:` escape entirely and works consistently. Pattern is documented here in case future sessions hit it. Same applies to `hover:bg-white/`, `hover:bg-dark-X`, and the green/red/yellow/orange families.

**To finish:**
- Operator review of test env across SIMs, Gateways, IMEI Pool, Errors, Messages, SMS Usage, Guide, API Tester pages with real data loaded (puppeteer testing this session was hampered by HTTP-Basic-auth-via-URL stripping credentials from `fetch()` calls, so KPI tiles + tables sat in "Loading…").
- Decide on dark-mode strategy: theme toggle is currently hidden, single cream theme. If dual mode is wanted later, reintroduce a proper `html.dark` block separate from `:root`.
- Once approved, commit `src/dashboard/index.js` + `DESIGN.md` and deploy with `npx wrangler deploy --env=""` to push to prod.

**Files:** `src/dashboard/index.js` (uncommitted), `DESIGN.md` (new, untracked).

### Gateway management UI — Live in prod (session 48, 2026-05-08)
Renamed sidebar route `/gateway` → `/gateways` (legacy `/gateway` URL still resolves via a `ROUTE_TO_TAB['/gateway'] = 'gateways'` alias for old bookmarks; tab id `tab-gateway` → `tab-gateways`, `data-tab` + `switchTab()` callers updated, `PAGE_TITLES` updated). Added a "Gateway Management" card at the top of the page: table showing code, name, host:api_port, username, password (masked with click-to-reveal), total_ports, slots_per_port, active, with **+ Add Gateway** button and per-row **Edit** / **Delete**. Backed by full CRUD on `/api/gateways` — `GET` now returns `host,api_port,username,password,slots_per_port,mac_address` (was a subset), `POST` accepts the new fields, `PATCH ?id=N` and `DELETE ?id=N` added. Add/edit modal covers all gateway columns plus a show/hide password toggle. Existing port-status grid + quick-action buttons + Power Control sections under the card are unchanged.

**Caveat:** gateway passwords are stored plaintext in the `gateways` table and the management UI surfaces them on demand to dashboard admins. Same trust boundary as before, just exposed in the UI now.

**Files:** `src/dashboard/index.js` only. Deployed to prod 2026-05-08, version `e17bbeda-7b2d-48cd-acbd-cdb3f29125aa`.

### SIMs page UX overhaul — Live in prod (session 47, 2026-05-08)
Replaced the flat row of `<select>` filters with a three-row chip-based filter zone:
- **Preset chips** (top row): Not rotated today, No SMS in 12h, Any error, No reseller, Auto-rotate paused, Stuck provisioning >1h. Clicking an inactive preset clears non-preset filters; toggling off leaves other state alone. AND-semantics across active presets.
- **Filter buttons** (middle row): Status / Vendor / Gateway / Reseller open a shared `#sims-filter-menu` popover with checkboxes + per-option counts (computed off current data). Activated date-range + search box also in this row.
- **Active-filter chips** (bottom row, hidden when empty): one chip per applied filter with × button, plus Clear-all. Uses `data-chip-kind` / `data-chip-key` attributes + delegated click handler — no inline `onclick` (avoids template-literal `\"` escape-level issues — see decision log 2026-05-08).
- **State object** `simsFilterState` is the single source of truth: `{status[], resellerIds[], vendors[], gateways[], presets:Set, activatedFrom, activatedTo, search}`. Adapters (`onSims*Change`) mutate it; `renderSims()` reads it.
- **URL state sync**: `syncSimsUrl()` (replaceState, called from renderSims) encodes filters + sort + pagination as `?status=active,error&vendor=atomic&search=foo&sort=phone:desc&page=3&size=100`. `hydrateSimsFromUrl()` runs at the top of `loadData()` (initial boot) and inside the popstate handler (back-button); URL is canonical on refresh / deep link / share.
- **Sticky thead** on vertical scroll: table wrapped in `overflow-y-auto max-height: calc(100vh - 280px)` with `<thead><tr class="sticky top-0 z-10 bg-dark-800">`.
- **Columns ▾ menu** next to Refresh: 10 hideable columns (gateway_code, iccid, vendor, mobility_subscription_id, reseller_name, sms_count, last_sms_received, last_mdn_rotated_at, activated_at, last_notified_at). Persisted in `localStorage['simsColumnVis']`. Always-visible: id, phone_number, status, plus the structural checkbox + actions cells. `applySimsColumnVisibility()` runs at end of every renderSims.
- **Contextual empty state**: when filters return zero rows, "No SIMs match these filters" + Clear-all button. When no filters set and zero rows, the original message.
- **`/` keyboard shortcut** focuses `#sims-search` from anywhere on the SIMs tab (bails when target is INPUT/TEXTAREA/contentEditable or a modifier is held).
- **Search debounced** at 250ms (was firing on every keystroke).
- **Default sort flipped** from `id asc` (oldest first) to `id desc` (newest first).
- **Multi-status loadSims fix**: only sends `hide_cancelled=false` to server when user picks `canceled` or `__all__`. Multi-status without those gets the smaller default-set and client-filters the union (previously returning full cancelled history was timing out / erroring).

**Files:** `src/dashboard/index.js` only. Deployed to prod 2026-05-08, version `543f1682`. Test-env baseline at `dashboard-test.zalmen-531.workers.dev` is up to date with prod.

### kasa-control-test created with prod-inheriting cron (caveat from session 47)
To deploy `dashboard-test`, the `kasa-control-test` worker had to be created (was missing). `src/kasa-control/wrangler.toml` does NOT scope `[triggers]` to env.test, so the test worker inherits `crons = ["0 0,3,12,15,18,21 * * *"]`. Without `KASA_USERNAME`/`KASA_PASSWORD` secrets on the test env it fails safely, but it's noisy. Either set test-env secrets or add `[env.test.triggers] crons = []` to the kasa-control wrangler.toml when convenient.

### Daily reconciliation cron — shipped flag-OFF, awaiting operator sign-off (session 41)
**Live in prod but dormant.** New `/reconcile-rotations` endpoint on details-finalizer + cron `30 10 * * *` UTC (NY 6:30 EDT). Three buckets: A (wing_iot stuck `mdn_pending`), B (rotated today, last_notified_at stale), C (eligible-but-not-attempted in 24h, log-only). Hard caps in code: ≤60 AT&T GETs, ≤60 webhook POSTs, **0 plan-change PUTs**, 90s wall-clock, 1 audit row per run, cannot self-trigger. Feature-flag-gated by `RECONCILIATION_ENABLED` secret on details-finalizer (set to `"false"`); cron tick at UTC 10:30 logs `[Reconcile] disabled, skipping` and exits. Manual trigger via dashboard "Reconcile Now" button (uses `force=1` to bypass flag). Audit trail in `rotation_audit` table.

**To enable:** `cd src/details-finalizer && printf "true" | npx wrangler secret put RECONCILIATION_ENABLED --env=""`. Operator should run a few `?dry=1` and `?force=1` cycles first to build confidence — see verification checklist sent to user 2026-04-29.

**Files:** `src/details-finalizer/index.js` (`runReconciliationSweep` + endpoint + cron branch on `event.cron`), `src/details-finalizer/wrangler.toml` (added `30 10 * * *`), `src/dashboard/index.js` (`/api/rotation-audit`, `/api/rotation-audit/run` via `DETAILS_FINALIZER` service binding, widget on SIMs page), Supabase migration `create_rotation_audit_table`. Deployed: details-finalizer `0c0029ee`, dashboard `2e7a8ed3`.

### Server-side bulk-job pattern for client-driven loops (session 39 — TODO)
**Problem.** Several dashboard "bulk" actions loop in the browser, issuing one `fetch()` per SIM (`bulkSimAction`, `bulkAssignReseller`, `bulkAssignResellerAndNotify`, `bulkModifyImei`, etc.). When the user locks their phone or backgrounds the tab, the browser suspends timers and drops the radio — every subsequent fetch fails with `TypeError: Failed to fetch`. Today this hit `bulkAssignResellerAndNotify`: ~7 SIMs succeeded before screen-lock, then ~50+ SIMs failed in a row.

**Proposed fix.** Move the loop to the worker side. Pattern:
1. Client POSTs the full `sim_ids[]` (+ params like `reseller_id`) to a new dashboard endpoint (e.g., `/api/bulk-jobs/assign-and-notify`).
2. Worker creates a `bulk_jobs` row (id, action, total, ok, fail, status, started_at, lines jsonb), kicks off `ctx.waitUntil(processJob(jobId))`, returns `{job_id}` immediately.
3. `processJob` loops server-side calling existing `/assign-reseller` + `/sim-online` handlers via service binding (or refactored shared helpers), updates the `bulk_jobs` row each iteration.
4. Client polls `GET /api/bulk-jobs/:id` (~2s interval) and renders into the existing `sim-action-modal` (lines + counters + Cancel — same UI). Cancel sets `bulk_jobs.cancel_requested=true`; loop checks it.
5. Closing the tab/locking the phone is now harmless — work continues on Cloudflare; reopening the tab resumes polling.

**Scope decision pending.** Start with `bulkAssignResellerAndNotify` only (highest pain — multi-call per SIM), or refactor all bulk actions in one pass? The current per-button shape would need `action` + per-action handler dispatch in `processJob`.

**Affected files (when implemented):** `src/dashboard/index.js` (new endpoint + new `bulkAssignResellerAndNotifyServerSide()` + polling helper), one new migration for `bulk_jobs` table.

**Workaround until then:** keep the dashboard tab in the foreground with the screen on for the duration of any bulk action.

### `number.offline` webhook + ABIR online suppression (session 37 → 38) — **Live in prod**
All four workers shipped + verified 2026-04-28. Latest deploys:
- details-finalizer `11ba84a5`, mdn-rotator `cd8a5bf6`, reseller-sync `0d455ed9`, dashboard `48e7fbab`.

**Auto-trigger verified live**: 04:01 UTC 2026-04-28 cron fired 15 ATOMIC `number.offline` events for real rotations (e.g., +13322957700 → +19177825941), all delivered to TrustOTP (`webhook_deliveries.status='delivered'` for all 15). Earlier 00:58 UTC manual test deliveries to TrustOTP were rejected (HTTP body `{"error":"Unknown event_type"}`) because the reseller hadn't deployed their handler at that moment — by 04:01 they had.

**`/test-offline` endpoint** added to details-finalizer for manual replay (auth'd by `FINALIZER_RUN_SECRET`, bounded to `limit ≤ 50`):
```
GET /test-offline?secret=...&reseller_id=N&limit=10[&dry=1][&force=1]
```
Picks N most-recently-rotated SIMs for the given reseller with both an open + closed `sim_numbers` row, fires offline using closed=old, open=replaced_by. `dry=1` previews; `force=1` bypasses per-day dedup.

**Other verifications still worth doing manually if time permits:** force-rotate flow for the live online+offline pair, ABIR-stuck SIM suppression on the dashboard force-resend button, defensive guard flip-test. None blocking.

### CF Queue removal for mdn-rotation-queue (deferred to tomorrow)
Session 34's DB-driven polling replaced CF Queues on the rotation hot path, but the `mdn-rotation-queue` producer + consumer bindings are still defined in `src/mdn-rotator/wrangler.toml` and the consumer branch in `async queue(batch, env)` (lines ~896–1002) is still present. Producer side (`queueSimsForRotation`) is dead code — nothing calls it after step 4 of the redesign. Pending: verify one full overnight run (~04:00–10:00 UTC = NY 0-5) drains the fleet, then delete the bindings + consumer branch in a small PR. Keep `fix-sim-queue` bindings — that queue is low-volume and works fine.

### ATOMIC DSABR2-barred cluster (38 SIMs)
All marked `status='rotation_failed'`. AT&T side: SOC `DSABR2,ZZNOILD2,NIRMAPEX,APEXBLOCK,APEX128` blocks `swapMSISDN` (statusCode 915 "sim/MSISDN is Inactive"). AT&T is silently reassigning MDNs on these SIMs outside our control. Escalation email drafted in chat; needs to be sent to ATOMIC support. Until resolved, these SIMs won't rotate and their DB MDN will drift — dashboard Query can sync DB to AT&T's current value.

### sms-ingest worker not deployed (commit b6a3a90)
Commit `b6a3a90` (Case A identity-first + webhook relayFetch) is local/pushed but **not deployed** — the dashboard billing fixes shipped today, but the sms-ingest change was bundled with pre-existing relay-webhook work and held for explicit confirmation. Safe to deploy anytime: `cd src/sms-ingest && npx wrangler deploy --env=""`. Dormant until deployed (Case A has zero traffic; webhooks still deliver via bare fetch instead of relay).

### Dashboard Redesign — Now in Production
Gemini UI (zinc/blue palette, light mode, custom confirm/toast dialogs) was unintentionally deployed to prod in session 9, and all related bugs are now fixed. Production dashboard is running the new UI and is stable.

### MDN Rotation Redesign — Deployed (cron paused pending manual resume)
**Goal:** continuous drain, Wing IoT async, force-rotate with warning, cancellable bulk runs.
- **mdn-rotator** (`24044be4`): `rotateWingIotSim` now sets `status='provisioning'` + `rotation_status='mdn_pending'` after plan swap and returns immediately (no MDN poll). `syncWingIotPendingMdns` removed. `rotateSpecificSim` accepts `force` param. Queue `max_batch_size` bumped to 25. Cron paused (was causing duplicate rotations earlier today).
- **details-finalizer** (`3312d5a7`): `runWingIotFinalizer` runs every 5 min alongside the Helix runner. Picks up Wing IoT SIMs in `status='provisioning'` (both activation and post-rotation), GETs MDN from AT&T, closes/opens `sim_numbers`, sets status=active, sends `number.online` webhook. Skips if returned MDN still matches `sim.msisdn` (old MDN propagating). Secrets added: WING_IOT_USERNAME, WING_IOT_API_KEY.
- **teltik-worker** (`223bdf7e`): extracted per-SIM rotation into `rotateOneTeltikSim(env, sim, {force})`. New `/rotate-sim?iccid=X&force=true` endpoint for manual single-SIM rotate.
- **dashboard** (`24eea641`): rotate confirmation dialogs now show ⚠️ force-rotate warning; bulk run shows a Cancel button (`sim-action-cancel`); `handleSimAction` looks up vendor and routes teltik rotations to TELTIK_WORKER via service binding, all others to MDN_ROTATOR.
- **948 handler added (2026-04-22):** ATOMIC swapMSISDN returning "Subscriber Must Be Active" now patches `sims.status='suspended'` in DB + queues fix-sim (was: only queued fix-sim, status stayed active).

**To resume rotation cron:** edit `src/mdn-rotator/wrangler.toml` line 10 → `crons = ["0,20,40 * * * *"]`, then `cd src/mdn-rotator && npx wrangler deploy --env=""`. First rotation after resume should hit midnight NY (04:00 UTC).

### ATOMIC + Wing IoT Migration — Complete + Helix Quarantined
- **Phase 1 (DB):** Complete — msisdn column added, helix_api_logs renamed to carrier_api_logs with vendor column, backward-compatible view created
- **Phase 2 (Workers):** Complete — all 6 workers deployed with vendor routing. **mdn-rotator daily cron now rotates ATOMIC SIMs** (fixed 2026-04-15 session 16; 50/50 SIMs rotated successfully on first cron tick). **Wing IoT rotation wired 2026-04-21** — `rotateWingIotSim` added to mdn-rotator (plan swap: dialable → non-dialable → dialable). `index.ts` (485-line partial port) is NOT production-ready — do not switch entry point. **Note:** 5 Wing IoT SIMs (632, 781, 1019, 1108, 1109) have no gateway/port — rotation will fail until assigned to a gateway slot.
- **Phase 3 (Dashboard):** Complete — vendor filter, badges, OTA/Retry disabled for wing_iot, ATOMIC query modal
- **Helix Quarantine (2026-04-15):** `HELIX_ENABLED=false` pushed to 7 workers (mdn-rotator, bulk-activator, sim-canceller, sim-status-changer, ota-status-sync, details-finalizer, dashboard). All Helix code paths are gated behind this flag. To re-enable: `printf "true" | wrangler secret put HELIX_ENABLED` on each worker. Code is preserved, not deleted.
- **Provider-leak bugs fixed:** `sim.vendor || 'helix'` → `'unknown'` in 3 places; billing aggregation renamed `helixDays` → `attDays` for clarity
- **Secrets:** All ATOMIC + Wing IoT + RELAY + HELIX_ENABLED secrets on every worker

### Dashboard UX Consolidation — Complete
- **Done (2026-04-16):** set-status modals merged (D1), bulk Retry shows per-SIM results in modal (D2), vendor tooltips for OTA/Retry buttons (D4), per-SIM detail modal (D3)
- **D3 detail:** Tabbed modal (Details/Status/IMEI/API Logs) opened by clicking SIM ID, Status, or IMEI row buttons. IMEI tab available for any SIM with gateway+port (no sub ID required). Wrapper functions `_sdOta`/`_sdRetry`/`_sdViewLogs` used in action buttons. Deployed 2026-04-16.

### BLIMEI / IMEI Heartbeat — Both Disabled
- Both `imei_heartbeat` and `blimei_update` queue handlers in mdn-rotator are disabled (short-circuit added during gateway instability investigation)
- 0 of 538 active SIMs have graduated; 397 have never been synced; 141 partial (1–2 syncs)
- Cron still enqueues jobs but they are silently acked without action
- **Skipped by user** — re-enable when/if needed by removing the two `message.ack(); continue;` short-circuits in mdn-rotator queue handler

---

## Technical Debt

### 98 Scratch Scripts at Repo Root (untracked)
Files like `_fix_*.js`, `_patch_*.js`, `fix.js`, `repair.ps1`, `rendered*.html`, etc. are accumulated from past dashboard patching attempts. Most are dead code. They are untracked (not in git) and safe to delete once confirmed useless.

**Risk:** One of them may still be a useful reference (e.g., `_check_dash_script.js` is the dashboard syntax checker). Review before bulk-deleting.

**Recommended action:** Move `_check_dash_script.js` to a permanent location (e.g., `scripts/`), delete the rest. Ask user before deleting.

### Reseller portal API keys stored plaintext
`reseller_api_keys.api_key` is plaintext. Adequate for MVP — TLS-only transport, never logged, soft-deletable, single-tenant operator. Hash with SHA-256 before scale or before adding more resellers; `authenticate()` in `src/reseller-portal/index.js` does a direct `eq.<key>` lookup so swapping to hashed needs (1) hash on insert in dashboard's `handleResellerKeysCreate`, (2) hash the presented key in `authenticate` before lookup, (3) one-shot migration to hash existing rows.

### Dashboard Has No Test Environment Crons
Test environment is defined in `dashboard/wrangler.toml` but only the prod environment runs in real operations. No automated testing exists.

### `phone-number-sync` Worker — Unclear Status
This worker exists in `src/phone-number-sync/` but its purpose is not well-documented beyond syncing phone numbers. Verify it's still needed and what it does before any changes.

### README.md Is Outdated
Lists 5 of 12 workers and has stale environment variable names. Not critical but misleading for anyone reading the repo.

---

## Recent Significant Changes (reverse-chronological)

| Date | Change | Worker(s) |
|------|--------|-----------|
| 2026-09-08 | **ATOMIC `portinStatus` 951 made terminal (PR #76).** `951` (`Result.reasonCode="CT"`) is the losing carrier rejecting the port, with the actionable cause embedded in the description as `statusReasonCode - <XX> ~ statusReasonDescription - <text>` (`8A` wrong account number, `6B` wrong T-Mobile transfer PIN). A rejection cannot clear itself, so the 5-min poll ran against it forever — SIM 36217 had been polling since 2026-09-04. Replaced the two-code ternary with a `TERMINAL_REASONS` map so each terminal code carries its own operator-facing reason, and added the carrier's own description to the terminal log line. Tests now parse the map and assert the terminal set is exactly `{910, 948, 951}` instead of matching source text. **Deployed**: details-finalizer `f30466c1`. SIM 36217 went terminal on the 18:45 tick; `portinStatus` traffic is now zero. | details-finalizer |
| 2026-09-08 | **ATOMIC port-in auto-finalizer shipped (PR #72) — 42-SIM backlog drained.** The 5-min `portinStatus` poll was read-only and nothing ever cleared `port_in_pending`, so 42 SIMs had accumulated, burning **11,232 carrier calls/24h**, with completed ports stuck in `provisioning` for up to 14 days. Confirmed the status enum from live `carrier_api_logs` (the `atomic-wholesale-api` skill lists it as unknown): completion is `statusCode="00"` + `Result.reasonCode="CO"`; `948` = `"Error!!Port Request Does Not Exist"`; `951` carries `Result.reasonCode="CT"` with the real reason embedded in the description. `runAtomicPortinStatusFinalizer` now treats `948`/`910` as terminal and auto-finalizes `00`+`CO` via `subsriberInquiry` through the `MDN_ROTATOR` binding (writes `status='active'`, MDN, BAN, IMEI, activation date/zip, rolls `sim_numbers`); `port_in_pending` clears only after finalization succeeds. `mdn-rotator`'s `/atomic-inquiry` widened to return `ban`/`imei`/`activationDate`/`zipCode`/raw `result`. **Result: 26 SIMs auto-finalized to `active` with real BAN + activation dates, 13 marked terminal, backlog 42 → 4, poll volume ~39/tick → 1/tick.** All 22 `finalize_inquiry` calls returned `attStatus=Active`, zero errors. **Deployed**: mdn-rotator `f227a41c`, details-finalizer `356028b0` (both via `wrangler deploy` — Workers Builds is a PR check only, it does NOT deploy on merge). | details-finalizer, mdn-rotator |
| 2026-06-16 | **Supabase security advisors cleared on prod (`lzjqegxazqlktttyybth`).** DB-only, no worker changes. Migration `lock_down_public_rls_critical`: enabled RLS on 10 RLS-off tables + dropped two `TO public USING(true)` policies (`sim_sms_daily`, `system_errors`). Migration `security_hardening_funcs_views`: pinned `search_path` on 18 functions, revoked `anon`/`authenticated`/`public` EXECUTE on 5 SECURITY DEFINER RPCs (`claim_rotation_slot`, `rotation_freshness`, `shop_claim_rental`, `shop_confirm_deposit`, `sweep_stuck_rotations`) + re-granted to `service_role` only, switched `helix_api_logs`/`shop_balances` views to `security_invoker`. Safe because backend is service-role-only (no anon/`createClient` usage anywhere); advisor now shows only INFO `rls_enabled_no_policy`. **Test project `lwapudjjlwkskijefxdz` still pending** — same SQL needs to be run there manually. | DB (no workers) |
| 2026-05-21 | **Session 58 — overnight rotation post-mortem + daily rotation-review automation.** Day broke open with the discovery that PR-B (shipped 01:38 UTC) had a malformed PostgREST URL in its retry-candidates query (`reseller_sims!inner(...)` as standalone param instead of inside `select=`), throwing PGRST108 on every cron tick. Result: tonight's entire Teltik cron window rotated **0 of 714 eligible SIMs**. Separately, 39 atomic SIMs hit PPU verify failures at the first cron tick (04:16 UTC) and got locked out for the night by the cron's `last_mdn_rotated_at >= NY-midnight` pre-filter — my retry-loop fix wasn't deployed until 06:19 UTC. **Drained manually** via `/tmp/force_rotate.sh` (atomic: 42/43 ok) + `/tmp/teltik_parallel.sh` (627 sent, 540 ok, 87 CF-killed → 96 came back "Only 1 per 48h" because Teltik HAD rotated but our worker died before capturing the response → SQL-flipped to `mdn_pending` so finalizer drained them via `get-phone-number`). **Final tally**: 1273/1289 = 98.8% notified. **Then built a daily safety net** so this never recurs silently: new `/rotation-review` endpoint on details-finalizer (lock via `cron_runs` table, per-SIM 3-attempts/NY-day budget via `remediation_attempts` table + `attempts_today` RPC, vendor 5xx circuit breaker, atomic second-read verification, multi-day failure detection, playbook-driven classification via `src/shared/rotation-playbook.mjs`, Resend email gated on RESEND_API_KEY secret). CCR routine `rotation-review` (`trig_017nq9h7VPDnfoSy6dLhRnCR`) cron `30 12 * * *` UTC runs it daily, commits report to `agent/rotation-reviews/YYYY-MM-DD.md`, appends agent assessment. Dashboard "Rotation Reviews" tab at `/rotation-reviews` exposes everything: Run Now button, last-10 reviews table, full-report modal, pending operator items widget with Reply/Ack/Snooze/Dismiss + ask-the-agent textarea. Sidebar badge polls open-pending count. Three new tables (`cron_runs`, `remediation_attempts`, `pending_review_items`), 6 new dashboard API routes. **Deployed**: teltik-worker `bd5ed97d` (PR-B URL fix), mdn-rotator `1646b5cd` (PPU retry loop), bulk-activator `27cf893c` (DB-driven pool), details-finalizer `19da0151` → `6190c135` → `7616358f` → progressively (rotation-review endpoint), dashboard `cc95ff48` (Rotation Reviews tab). Migrations applied: `address_pool_usage_add_address_fields`, `claim_address_pool_entry_returns_row`, `list_zips_needing_refill`, `rotation_review_lock_and_attempts`, `rotation_review_dashboard`. CCR routine created + updated. Lots committed across `327abaf`, `da7f55c`, `8e311e4`, `5846733`, `1e9f763`. **Operator action needed**: add `RESEND_API_KEY` + `REPORT_EMAIL_TO` secrets on details-finalizer to enable email delivery (otherwise reports just commit to repo). | details-finalizer, dashboard, mdn-rotator, bulk-activator, teltik-worker, DB, CCR |
| 2026-05-20 | **Session 55 — Teltik rotation silent-failure fix + reseller online_until correctness + PR-B staged.** Investigated why 506 active Teltik SIMs failed last night's rotation (2026-05-19→20) and never retried within the same 12–6am NY window, despite the cron running every 30 min. Root causes: (1) **Silent body-FAILED**: Teltik returns HTTP 200 with body `{status:"FAILED"}` for application-level rejections; `rotateOneTeltikSim` only checked `changeRes.ok` (HTTP status), so it flipped the SIM to `mdn_pending`, details-finalizer polled `get-phone-number` 8× over 30 min for an MDN that would never change, then the stuck-state guard marked `rotation_status='failed'` with the misleading message "MDN did not change within 30m (Teltik returned <same MDN>)". 5-day audit of `carrier_api_logs` showed 70 body-FAILED responses (no other ambiguous statuses — just SUCCESS / FAILED / 4xx-without-status). (2) **`last_mdn_rotated_at` stamped on attempt, not success**: `claim_rotation_slot` stamps it at the START of every rotation attempt; on failure the stamp stays (intentional dedup), but combined with the cron's `(now - last_mdn_rotated_at) >= 48h` filter this locks a SIM out of all subsequent ticks the same night AND the next 48h. (3) **Cron query filters `status=eq.active` only** — SIMs stuck in `status=provisioning, rotation_status=mdn_pending` (32 last night) are invisible to the cron entirely. (4) **Workers page "Run mdn-rotator" button doesn't touch Teltik**: `mdn-rotator/index.js:1247-1251` filters `vendor=neq.teltik` (Teltik handled by separate worker), and there's no "Run teltik-worker" button. (5) **Reseller `online_until` was wrong on failed attempts**: `reseller-sync` + `reseller-portal` computed `online_until` from `last_mdn_rotated_at` (attempt time), so a failed rotation pushed the reseller's expected MDN-expiry forward by 48h even though the MDN never actually changed. `sims.last_rotation_at` (set only on real success by details-finalizer) already existed but was unused — readers were using the wrong column. **Shipped:** **Fix #1** (deployed) — `teltik-worker/index.js:618-639` now parses `changeData.status`, throws `change-number body status=FAILED: <teltik error/message>` on body-FAILED so it lands in the existing catch and writes the real Teltik error into `last_rotation_error`. Eliminates the 30-min false-pending stall. **PR-A** (deployed) — `reseller-sync/index.js:61,116` and `reseller-portal/index.js:276,284-287` now prefer `last_rotation_at` over `last_mdn_rotated_at` for `online_until`, falling back to `last_mdn_rotated_at` when null (first-activation case where the column was stamped at import time). **PR-B** (code on disk + migration file, NOT YET DEPLOYED, awaiting migration apply): new sibling RPC `claim_rotation_retry_slot(p_sim_id bigint)` at `supabase/migrations/20260520_claim_rotation_retry_slot.sql` — accepts SIMs where `vendor='teltik' AND status IN ('active','provisioning') AND rotation_status='failed' AND rotation_eligible=true AND last_mdn_rotated_at >= today NY midnight AND last_mdn_rotated_at < NOW() - INTERVAL '15 minutes'`. Worker side: `rotateTeltikSims` gets a second query for failed-today candidates (deduped against `due`); `rotateOneTeltikSim` branches on `opts.retry===true` to call the new RPC. Returns extended cron stats `retry_eligible/retried/retry_skipped`. Deliberately scope-limited to Teltik via the RPC predicate, so Helix/ATOMIC/Wing IoT paths and the main `claim_rotation_slot` are untouched — full revert is `DROP FUNCTION claim_rotation_retry_slot(bigint);` + `wrangler rollback teltik-worker`. **Considered alternatives:** column split (new `last_rotation_attempt_at` + repurpose `last_mdn_rotated_at`) was rejected for higher blast radius (every reader audited, real schema migration, harder rollback). The sibling-RPC approach keeps `claim_rotation_slot` semantics identical for non-teltik vendors. **Also set up Supabase MCP server** (`@supabase/mcp-server-supabase`) — user-scope, project-ref=lzjqegxazqlktttyybth, token in `.dev.vars` as `SUPABASE_ACCESS_TOKEN`. Active in new sessions after `/clear` or restart. **Deployed**: teltik-worker `47cf46ef-082d-4eb5-89bf-de27419960de` (Fix #1), reseller-sync `03b72cae-4ab8-4c23-87be-48fa70a51f5e`, reseller-portal `e10f2156-e895-4675-b294-defa034e9bdd`. **NOT deployed**: PR-B teltik-worker code (Fix #1 IS deployed though — they're in the same file, future deploys carry both). User was manually rotating SIMs during the session — instructed me to "continue all the way" but the migration step requires either Supabase MCP (loads next session) or manual Studio apply. | teltik-worker, reseller-sync, reseller-portal, DB |
| 2026-05-19 | **Session 54 — SIM Utilization Audit panel (Invoicing tab, block-level for Teltik).** User came in with the recurring question: TrustOTP claims they're using all ~1500 Teltik SIMs but daily billed-block counts swing wildly (88→1131→73→524 per day) and never sum cleanly to 1500. Explored two framings: (a) restructure rotations into Cycle Groups A/B for predictable daily totals (designed in `/home/zalmen/.claude/plans/date-est-scope-units-twinkling-glacier.md`, schema + parity helper + dashboard toggle), (b) build a read-only utilization audit that directly answers "how much of what we deliver is actually being used." Decided on (b) — same data, no schema or rotation change. Cycle-group design **deferred** to memory `project_teltik_cycle_groups_deferred.md` for future revisit. **Built:** new `computeResellerUtilization(env, {resellerId, start, end, vendors})` in `src/shared/billing.js` (additive; reuses `sbGet`/`sbGetAll` helpers, mirrors the block-iteration logic from `computeBillingBreakdown` lines 223-265). First version returned SIM-level only ("did SIM have ≥1 SMS in window"); when user pointed out his real concern was block-level utilization (each 48h rental, the unit that drives the bill), extended the helper with a second pass that fetches `sim_numbers` rotations in a `±2-day` widened window, walks each rotation's block range `[valid_from, min(valid_from+interval, next_valid_from))`, and per-SIM computes `blocks_in_window` / `blocks_billed` / `blocks_idle` / `block_utilization_pct` + `idle_block_dates[]`. Vendor-level aggregates `total_blocks`/`billed_blocks`/`idle_blocks`/`block_utilization_pct` only emitted for Teltik (null for atomic/helix/wing_iot since those bill per-SIM-day, not per-block). **Dashboard:** new `GET /api/utilization?reseller_id=&days=&vendor=` route. Panel originally placed in Billing tab; user corrected — Billing tab is for auditing *vendor bills we pay*, not what we charge resellers; moved to **Invoicing** tab. Panel: reseller selector (auto-defaults to TrustOTP via case-insensitive name match), vendor selector, window selector (7/14/30d), Run Audit button, summary cards (block-level headline for Teltik, SIM-level for AT&T; color thresholds green≥99% / yellow≥90% / red<90% since the realistic numbers are near 100), table with 11 columns including idle block dates, "Show fully-utilized SIMs too" toggle, CSV export. Table default filter: SIMs with ≥1 idle block, sorted by `blocks_idle DESC` (worst first). **Verified end-to-end against the user's pasted bill report (2026-05-09 to 2026-05-15):** audit returned 4,997 billed of 5,030 total Teltik blocks = **99.3% block utilization, 33 idle blocks across 7 days, 1502/1502 SIMs active**. Matches bill total 4,996 (off by 1 — one SMS arrived between report and audit). My earlier napkin-math estimate of 95% / 5,257 theoretical blocks was wrong because not every SIM rotates *exactly* every 48h (cron timing + 0–6am NY window limits actual rotation events). **Conclusion: TrustOTP is using all SIMs; bill is correct; cycle groups not needed.** Two recurring escaping bugs caught in patch flow: (a) `'\n'` in a patch-script source string evaluates to a literal newline inside the outer `getHTML()` template literal — must write `'\\n'` (two backslashes) in patch-script source to land `\n` literal in file so getHTML evaluates to the escape sequence and runtime gets a newline; (b) relay-check false positives in `src/dashboard/index.js` for browser-side kasa fetches and `src/reseller-portal/index.js` for browser-side login fetch — the checker looks for `function getHTML()` (empty parens) but actual signature is `function getHTML(helixEnabled)`, so getHTML's body is never stripped. Pre-existing; not in this session's diff. Both syntax checks pass (`node --check`, `_check_frontend_js.js`); CRLF preserved. +454/-2 lines content delta (whitespace-ignoring; raw stat shows 32K lines due to CRLF normalization round-trip in patch script). **Deployed:** dashboard `a591ef79` (v1), then `a5a78f45` (v2 after panel move + block-level upgrade). **Committed at session close** (this session). | dashboard, shared/billing |
| 2026-05-15 | **Session 53 — TrustOTP MDN report investigation + webhook_deliveries JSONB index.** Trustotp emailed a 1,084-row report (`damp-mountain-16002372_main_neondb_2026-05-14_10-05-29.csv`) listing MDNs that were active >48 hours, totaling $1,298.80 ($1.10/$1.60/$2.20/$0.00 tiers). Built `scratch/investigate.py` — a sequential investigator that, per MDN, joins `sim_numbers` + `sims` + `sim_status_history` + per-MDN `number.online` and `sms.received` rows from `webhook_deliveries`, then emits a plain-language prose note describing every activation period: which SIM(s) carried it, the `online_until` from the first number.online webhook, SMS counts (with day-by-day breakdown when split), billable-day computation, and post-shutdown false re-onlines for helix MDNs (helix→AT&T 2026-04-01 account-wide cancellation mapped from DB date 2026-04-15). Vendor names are stripped from the prose — only carrier (`att`/`tmobile`) is shown. **Performance pivot mid-session**: the per-MDN webhook queries (`payload->'data'->>'number' = '+1...'`) were doing sequential scans of `webhook_deliveries` (649K sms.received + 80K number.online rows); ran fine sequentially at ~15–20s/MDN but was projected to finish at hour 5+ and was burning Supabase Disk IO budget. Created `idx_webhook_deliveries_payload_number ON webhook_deliveries (event_type, ((payload->'data'->>'number')))` via `CREATE INDEX CONCURRENTLY`. Verified planner picks it up (Index Scan, not Seq Scan); per-query latency dropped from ~5s to ~0.5s. Final pipeline split: 112 stratified-sample rows (pre-index, ~30 min) + 315 head-of-list rows (pre-index, ~30 min before pause) + 657 tail rows (post-index, <10 min). Merged into `damp-mountain-16002372_annotated_full.csv` (1,084 rows, zero errors, zero pending) in the user's repo root. **Key finding for the user**: trustotp's $1.10 tier does NOT correlate with our internal billable-day count — e.g. some MDNs got 75 SMS across 4 days (3 billable days by our 48h-window rule) and were billed $1.10, others got 8 SMS in 1 day and were billed $2.20. Their pricing logic is independent of usage. **Repo state**: no tracked files changed. New untracked artifacts: `damp-mountain-16002372_*.csv` (input + annotated full + sample at repo root), `scratch/investigate.py` + intermediate CSVs. Worth keeping unless cleaning up. | DB index, scratch tooling |
| 2026-05-12 | **Session 52 — Mastercard-inspired dashboard redesign (test env only, uncommitted).** Full visual reskin of `src/dashboard/index.js` per new `DESIGN.md` reference. `--dark-N` CSS variables remapped to Mastercard cream tones (so all existing Tailwind `bg-dark-*` / `text-dark-*` class usages auto-style without per-element edits), override layer translates `bg-blue-*`/`bg-green-*`/`bg-red-*`/`bg-yellow-*`/`bg-orange-*` to ink/forest/red/Signal Orange, Sofia Sans typography (weight 450 body / 500 -2%-tracked headings), 20px/24px/40px/999px radius scale, soft 48px-spread shadows. Page header rebuilt as eyebrow + dynamic title + subtitle via new `PAGE_HEADERS` map in `switchTab`; sidebar brand is now circular ink logo + "OPERATOR" eyebrow; top-right "Connected" pill replaces the pulse dot. **CSS pitfall**: `.hover\:bg-blue-X:hover` class selectors with the standard Tailwind `\:` escape were silently dropped by the browser CSS parser when read from the static `<style>` block (raw HTTP bytes verified correct, identical rules parse fine via `insertRule` — root cause unresolved, possibly Tailwind CDN's DOM observer interfering). Worked around with attribute-selector form `[class*='hover:bg-blue-']:hover` which avoids the escape entirely. Pattern recorded for future sessions. +432 / −70 lines, only `src/dashboard/index.js` touched. **Deployed to `dashboard-test` (version `e4c764b3-bea6-4dc7-97fe-1f335a0c93a2`). Prod NOT updated.** Awaiting user review before commit + prod deploy. | dashboard |
| 2026-05-11 | **Session 51 — gateway slot capacity tracking + defective slot hiding.** Multi-SIM gateways (8 slots/port) crash when all 8 slots carry SIMs; safe cap is 5/port. Added two related features on the `/gateways` page. (1) New `gateway_defective_slots(gateway_id, port_slot, reason, created_at, UNIQUE(gateway_id,port_slot))` table — migration `20260511_gateway_defective_slots`, RLS enabled (service-role bypasses). (2) Three new API routes in `src/dashboard/index.js`: `GET /api/gateway-defective-slots?gateway_id=X` lists, `POST` upserts with `?on_conflict=gateway_id,port_slot` + `Prefer: resolution=merge-duplicates,return=representation` (normalizes `port_slot` through existing `normalizeImeiPoolPort` before insert), `DELETE` unmarks. (3) Frontend (via `patch-dashboard` skill, 4 patch scripts): new state `defectiveSlotsCache: Set<"port.slot">` + `showDefectiveSlots: bool`; `loadDefectiveSlots(gatewayId)` runs in parallel with the existing skyline `port-info` fetch; new helpers `markSlotDefective`/`unmarkSlotDefective` (POST/DELETE + reload, no native `prompt()` — uses `showConfirm`); new `renderUnderFilledPorts()` panel below the Port Status grid. Marking is per-slot from the slot-detail modal (new red "Mark Defective" / gray "Mark Working" button per row, alongside Lock/Unlock/Switch). **Under-Filled Ports panel** groups slots by physical port, computes `seated = count(inserted===1 AND !defective)`, `target = min(5, working_slots)`, lists ports where `seated < target` with "needs N more" hint; multi-slot ports only. **Port-grid layout**: detects multi-slot gateways (any physical port with >1 slot) and renders one row per port (label + horizontal slot cards in a flex-wrap) instead of the flat 16-column grid — keeps slots grouped when defectives are hidden. Single-slot gateways (64-1) keep the original grid. **Show defective** checkbox in the Port Status header toggles visibility globally; defective cards render with `bg-dark-900 opacity-60 border-red-700/60` styling and a red status label. **Bug caught mid-session**: regex literals `/^(\\d+)\\./` in source were eaten by the outer `getHTML()` template literal (unrecognized escapes drop the backslash), producing `/^(d+)./` in the browser — so `renderUnderFilledPorts` never matched any port string and the panel always reported "all at or above target". Same class of bug as the 2026-03-24 `\\n`→newline incident already documented in `agent/constraints.md §1`. Fixed by using `\\\\d` / `\\\\.` in patch-script source. The pre-existing `exportGatewayTable` at line 11199 has the same latent bug (`/^(\\d+)\\.(\\d+)$/`) — left alone since it's outside this feature; flag if CSV export starts misbehaving on multi-slot gateways. **Bulk-marked**: 144 slots across 18 fully-empty ports on gateway 512-2 (ports 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36 — clear dead-PCB-row pattern, even numbers only) via API loop. Reason: "Empty port - no SIM ever seated; marked via bulk import". **Deployed**: dashboard `a468c374-7e7e-46d0-aa8b-fd9f2de8be9b`. Migration applied via MCP. | dashboard, DB |
| 2026-05-11 | **Session 50 — per-reseller volume pricing rules (selling-side, time-bounded, vendor-scoped, all-at-rate tiers).** New `reseller_rates(reseller_id, vendor?, effective_from/to, tiers jsonb, notes)` table with check constraints on tier array shape and auto-close of overlapping open rows when a new effective_from is added (mirrors `plan_rates` pattern). Tier shape: `[{min_count, max_count, rate}, ...]`. Vendor scope: `null` = all AT&T (atomic+helix+wing_iot, per-SIM-day rate); `'atomic'/'helix'/'wing_iot'` = vendor-specific per-SIM-day rate; `'teltik'` = per-block rate (rental). Lookup precedence: vendor-specific row beats null-vendor row; falls back to `qbo_customer_map.daily_rate` (or `daily_rate × 2` for Teltik blocks) when no row matches, so existing resellers behave exactly as before. **Critical correction mid-session**: tier selection initially used the daily SMS-billable SIM count (matched user's first answer), but user clarified the price is determined by **inventory** — refactored `computeBillingBreakdown` to compute `activeByVendor` once from `reseller_sims.active=true` (regardless of SMS) and pass that to tier lookup; `activeAllAtt = atomic+helix+wing_iot` is used when a null-vendor rule matches an AT&T bucket. Billable units remain SMS-driven. Response gained `active_counts` + per-day `tier_input_count` for transparency. **Dashboard UI** (Invoicing tab): new "Volume Pricing Rules" card with rule list (vendor scope, tier badges, effective dates, status: Active/Scheduled/Ended); modal with dynamic Add/Remove tier rows, vendor-scope dropdown, effective_from/to, notes; End-rule date prompt; Edit locks reseller+vendor (only dates/tiers/notes editable to avoid mass-rewriting historical rules). New CRUD endpoints `/api/reseller-rates` (GET list w/ optional `?reseller_id=`, POST create, PATCH update, DELETE). Invoice preview header now shows "Active SIMs assigned (drives tier selection): AT&T: X · teltik: Y"; each day's row has tier badge with tooltip showing the count that picked the tier. **TrustOTP rule live**: vendor=teltik, effective 2026-05-06, tiers `601-1000 @ $1.80 / 1001-1500 @ $1.70 / 1501+ @ $1.60` (id=1). With 1397 active Teltik SIMs that lands tier 1001-1500 → $1.70/block. Verified end-to-end with a 2026-05-06→2026-05-08 preview: $4,790.00 ($1,740.20 AT&T at default + $3,049.80 Teltik at $1.70). **`src/shared/billing.js` is the single source of truth**, bundled into both `dashboard` and `reseller-portal` workers — both deployed so admin and customer views stay consistent. **Footgun recurrence (caught early this time)**: `String.prototype.replace(OLD, NEW)` interpreted `$'` (dollar+apostrophe) in my new preview-body string as "rest after match" and dumped 122KB of file suffix into the wrong place; reverted via `git checkout` (file was clean before the patch, no work lost) and re-ran with function form `replace(OLD, () => NEW)`. The `feedback_replace_dollar_apostrophe.md` memory had warned about this — the lesson is to use function form **always** in patch scripts, not just when you spot a problematic `$<x>` sequence by eye. **Migrations**: `supabase/migrations/20260510_reseller_rates.sql`. **Commits**: `716b443` (feature), `80e34f6` (inventory-based tier fix). **Deployed**: dashboard `423c9d64-6211-4586-84d0-93150f8ca620`, reseller-portal `80d345eb-f2ba-4316-ade9-945268759a0e`. | dashboard, reseller-portal, DB |
| 2026-05-10 | **Session 49 — reseller-portal hardening (rental_id, freshness, login, custom domain).** Long session, multiple interlocking pieces. (1) **`reseller-sync` ABIR guardrail narrowed**: filter `or=(rotation_status.is.null,rotation_status.neq.failed)` → `or=(vendor.neq.wing_iot,rotation_status.is.null,rotation_status.neq.failed)`. Only `wing_iot+failed` (genuine ABIR-stuck) is now suppressed. teltik/atomic/helix `rotation_status='failed'` SIMs still get `number.online` because their old MDN remains valid; the prior filter silently stranded 71 teltik SIMs from TrustOTP's view after a Teltik 502 outage. Also changed `order=id.asc` → `order=last_notified_at.asc.nullsfirst` so stale SIMs are picked first within the PostgREST 1000-row cap. (2) **`reseller_sims.last_rental_id BIGINT`** migration. `reseller-sync` now parses `rentalId` from each successful `number.online` response body and persists it. Backfill of 2565 rows from existing `webhook_deliveries.response_body` ran cleanly. Tolerant of `rentalId` / `rental_id` / `id` and falls back to regex if body isn't strict JSON. (3) **Reseller-portal redesign**: SIMs table now shows **Rental ID \| MDN \| Status \| Start \| Expires** (ICCID dropped from main grid, kept in detail view). Filter searches by rental_id, MDN, or ICCID. `Expires` uses the same `midnightNYAfterInterval(last_mdn_rotated_at, rotation_interval_hours)` formula reseller-sync sends as `online_until`. New `/api/sims?active=true` filter (server-side). New `/api/credentials` returns caller's own API keys in plaintext. New "API Access" tab with copyable URL + cURL example pre-filled with the user's key. (4) **Reseller-portal username/password login**: new `POST /login` accepts `{username,password}`, verifies via PBKDF2-SHA256 (100k iters, `pbkdf2_sha256$iters$salt$hash` format), issues HMAC-SHA256 signed session token (30d). Legacy `?key=rsk_…` magic-link still works. Cookie unchanged (`rp_session`, Secure/SameSite=Strict, 30d). Logout via `/logout`. Schema: `resellers.username TEXT UNIQUE`, `resellers.password_hash TEXT`, `resellers.password_updated_at TIMESTAMPTZ` (two migrations). New worker secret `PORTAL_SESSION_SECRET` (random 48-byte base64). (5) **Dashboard admin UI for credentials**: "Login Credentials" form (set initial username/password) + roster table (every reseller w/ username, password set/not-set badge, last-updated relative time, Reset and Edit buttons). Reset generates 12-char random pw, saves, shows it once in a modal. Edit modal allows changing username and/or password independently — `handleResellerCredentials` POST handler now treats password as optional (username-only updates allowed); password change always stamps `password_updated_at = now()`. PBKDF2 params kept in sync between `dashboard/index.js` and `reseller-portal/index.js`. New endpoint `GET /api/reseller-credentials` returns the roster. (6) **Notification Freshness card** on main dashboard tab: per-vendor (atomic/wing_iot/helix at 24h, teltik at 48h) broadcastable totals + fresh counts + stale links. `/api/stats` extended with `freshness` object (8 new parallel `count=exact` queries). Empty vendor rows hidden. "Stale" links jump to SIMs tab with the new "Not Notified" preset chip pre-applied (URL-state-aware). (7) **"Not Notified" SIMs preset chip** matching the same vendor/window rule as the freshness card; skips non-active and ABIR-stuck wing_iot. (8) **Custom domain**: `portal.incoming-sms.com` provisioned for reseller-portal via `routes = [{pattern, custom_domain=true}]` in wrangler.toml. Three URL references in `reseller-portal/index.js` and two in `dashboard/index.js` swapped from `reseller-portal.zalmen-531.workers.dev` to the new domain. workers.dev URL still active as fallback. (9) **Manual data cleanup at session start**: 536 helix zombies (status=canceled since 2026-03-25) flipped to `reseller_sims.active=false`; 7 wing_iot SIMs stuck in `status=error + rotation_status=mdn_pending` flipped to `status=provisioning` so details-finalizer reconcile bucket A picks them up. **Recurring footgun:** `String.prototype.replace(OLD, NEW)` interprets `$'` in NEW as "rest after match" — used function form `() => NEW` after one corruption incident (file restored from git, refixed). Memory `feedback_replace_dollar_apostrophe.md` was already recorded; following it from the start prevents this. **Deployed**: dashboard `9cafcee7-114a-43f5-80b7-373247e6a21a` (prod, after sequence of intermediate deploys), reseller-portal `dc6fe585-0ebd-42b6-8c5e-ece8e996978a`, reseller-sync `3875d42a-2efd-4900-a924-4cdd5c6781a6`. Three migrations applied: `reseller_portal_rental_id_and_login`, `resellers_password_updated_at`. **Status**: TrustOTP login set (`trustotp`). Custom domain DNS verified globally via 1.1.1.1 and 8.8.8.8; user still hits NXDOMAIN locally (cached negative; needs DNS flush at router/ISP level or wait for TTL). | dashboard, reseller-portal, reseller-sync, DB |
| 2026-05-07 | **Session 46 — Billing/Invoicing page split + Teltik audit parser + mark-paid + carrier-only reseller portal + time-aware audit.** (1) **`/billing` split into `/invoicing` + `/billing`** in dashboard SPA. New sidebar entry between Errors and Billing. `/invoicing` = Customer Rates, Reseller API Keys, Invoice Generator, Invoice History. `/billing` = Billing Audit, Audit History, Plan Rates, Billing Ledger. `switchTab` data loaders split accordingly; `TAB_ROUTES` + `PAGE_TITLES` updated. (2) **Audit dropdown collapsed**: 3 separate AT&T vendors (`wing_iot`/`atomic`/`helix`) replaced by single `wing_aggregator` option (Wing is the aggregator and they come on one invoice). Per-line vendor derived from CSV `Description` matched against `plan_rates.plan_name` — see decision-log. New `unknown_plan` discrepancy when description has no matching plan_rates row. (3) **Time-aware audit**: `auditOneLine` now matches each line against `plan_rates` whose `[effective_from, effective_to]` window contains the line's `from_date` (was: always today's active rate). Old bills validate against the rate active on that date. `endPlanRate` UI now opens a date prompt (was: always today). (4) **Audit pagination fixes** — third pagination bug this month: `sims?...&limit=10000` and `sim_status_history?...&limit=50000` both silently capped at 1000 server-side, causing false `unknown_iccid` and `canceled_before_period` flags. Switched both to `supabaseGetAllArray` (chunked 200/batch for history). (5) **Audit Delete**: red Delete button on each Audit History row → `DELETE /api/bill-audit/uploads?id=N` removes upload + lines and resets linked ledger rows to `pending` (clears `bill_audit_line_id`/`billed_amount`/`invoice_no`). (6) **Billing Ledger**: new `invoice_no text` column populated at reconcile from upload filename stem (or parsed Teltik invoice no when present); displayed as new "Invoice" column. New ICCID search input (debounced, partial-match via `iccid=ilike.*<>*`). (7) **Mark Paid for invoices**: new `qbo_invoices.paid_at timestamptz` column. `PATCH /api/qbo-invoices/:id` with `{paid:true|false}` toggles `status` + `paid_at`. Invoice History shows green "Paid <date>" badge or grey current status, plus Mark Paid/Unmark button. Same green badge surfaces in reseller-portal invoice list + detail modal. (8) **Reseller portal: carrier-only**: new `vendorToCarrier()` helper maps `wing_iot/atomic/helix` → `AT&T`, `teltik` → `T-Mobile`. `/api/sims` and `/api/sims/:id/lifetime` now return `carrier` instead of `vendor`. SIM table column renamed Vendor→Carrier; lifetime modal shows "Carrier X" instead of vendor — see decision-log. (9) **Teltik invoice parser** (`parseBillCSV` becomes vendor dispatcher): `parseTeltikCSV` skips 19-row preamble, finds `LINE NUMBER, SIM NUMBER, PLAN NAME` header, strips leading `'` from ICCIDs, uses **PLAN CHARGES** as price (one-time fee deliberately ignored), extracts `Invoice No` + `Period Beginning/Ending` from preamble. New `bill_audit_uploads.invoice_no` column stores the parsed Teltik invoice number; reconcile prefers it over the filename stem. **Activation proration** for Teltik audit lines: when a SIM activated mid-cycle, expected = `rate × daysActive / cycleDays` (matches existing ledger logic). Sims now selected with `activated_at` so proration can run. (10) **Diagnosed false `unknown_iccid`**: User's first Teltik upload (`Teltik Invoice 4.27.csv`) had Teltik's redacted format with literal `"NA"` in both LINE NUMBER and SIM NUMBER columns. Re-upload from `Invoice (2).csv` (real ICCIDs) matched cleanly. **Migrations:** `add_invoice_no_to_billing_ledger`, `add_paid_at_to_qbo_invoices`, `add_invoice_no_to_bill_audit_uploads`. **Deployed:** dashboard `dabdc641`, reseller-portal `be018214`. **Commits:** `7c3b2b6` (split + time-aware audit + ICCID search + audit delete) and `1375227` (Teltik parser + mark-paid + reseller portal carrier). | dashboard, reseller-portal, DB |
| 2026-05-06 | **Session 45 — /sims 1000-row cap fix + main dashboard donut charts.** (1) `/api/sims` was calling `supabaseGet(...&limit=5000)` — PostgREST silently caps at 1000 regardless. Switched to `supabaseGetAllArray` (offset+limit pagination loop). Symptom: "Active" filter showed 591 of 1000 while "All" showed 553 of 1000 — active > all because the two different PostgREST 1000-row slices had different distributions of gateway-assigned SIMs after client-side filtering. Fixed: counts now reflect all SIMs. (2) Added two donut charts to main dashboard home tab (below the 4 stat cards, above Quick Actions). Extended `/api/stats` with 6 new parallel `count=exact` queries: suspended, error, and per-vendor (atomic, teltik, wing_iot, helix — each excluding canceled). Status chart: Active/Provisioning/Suspended/Error. Vendor chart: non-canceled SIM counts per vendor. Chart.js 4.4.0 already loaded — no new deps. Deployed: dashboard `c4fc362`. | dashboard |
| 2026-05-05 | **Session 44 — Reseller portal + Teltik 1000-row pagination fix.** (1) Discovered `handleBillingPreview` and `handleBillingDownloadInvoice` fetched Teltik rotations via `supabaseGet(...&limit=50000)` — PostgREST silently caps server-side at 1000 rows. For TrustOTP 4/18-5/1 (2,958 rotations) the dashboard reported $7,603.20; correct figure $10,476.40. Fixed both call sites to use `supabaseGetAllArray` (paginated). Verified by reproducing the truncated $7,603.20 with a `LIMIT 1000` SQL simulation. (2) Extracted billing math to new `src/shared/billing.js` (`computeBillingBreakdown`, `estDateFromDate`, `nextEstDate`) — single source of truth, dashboard preview byte-identical before/after refactor. (3) New worker `src/reseller-portal/` (live at `https://reseller-portal.zalmen-531.workers.dev`) — read-only customer-facing portal + JSON API. Auth via `reseller_api_keys` table (was dead schema). Routes: `/api/me`, `/api/sims` (active+historical, paginated), `/api/invoices`, `/api/invoices/:id` (as-billed total + day-by-day reconstruction labeled as such), `/api/sims/:simId/lifetime` (total SMS + billable units since assignment, vendor-aware unit label). Bearer header for API; magic-link `/login?key=…` sets 30-day cookie for the SPA. Every query scoped by validated `resellerId` from key — client-supplied reseller_id never trusted. (4) Dashboard adds `/api/reseller-keys` admin endpoints (list/create/revoke) + "Reseller API Keys" UI under Billing tab. Keys generated as `rsk_live_` + 32 hex chars, plaintext shown once with magic-link. (5) Decision: API keys stored plaintext for MVP — hashing tracked as follow-up (see Technical Debt). Decision: invoice drill-down shows as-billed total only, with per-day breakdown labeled as reconstruction (avoids creating new disputes when recount differs from QBO total). **Deployed:** dashboard `39611c0b`, reseller-portal `65c538ee`, reseller-portal-test `1dbd745d`. TrustOTP keys: id=4 (legacy `rk_live_` prefix — does not work, portal requires `rsk_live_`), id=5 (revoked), id=6 (active, current). | dashboard, reseller-portal (new), DB |
| 2026-04-30 | **Session 43 — Billing Ledger system (per-SIM expected vs billed across cycles).** New `plan_rates(vendor, plan_name, rate, effective_from/to)` and `billing_ledger(sim_id, vendor, plan_name, period_start/end, expected_amount, billed_amount, bill_audit_line_id, status)` tables (migration `20260430_billing_ledger`). New `get_ledger_months()` SQL RPC for month dropdown. Backend: `/api/plan-rates` CRUD; `/api/billing-ledger` (paginated `{rows,total}` via `Prefer: count=exact`, filters: `vendor`, `status`, `period_month=YYYY-MM`, `sim_id`); `/api/billing-ledger/summary` (status counts); `/api/billing-ledger/months`; `/api/billing-ledger/regenerate` (idempotent — walks `sim_status_history`, upserts one row per cycle, omits status/billed/bill_audit_line_id/notes so reconciliation-set fields are preserved); `/api/billing-ledger/reconcile` matches bill_audit_lines to ledger rows by (iccid, vendor, period containing from_date) → sets billed/over/under, marks unmatched closed-period rows as `missing`. Bill upload now auto-triggers regen+reconcile for that vendor. **Hardcoded `PLAN_RATES = {'796': 5.00}` const removed** — Bill Audit now keys rate-mismatch on **vendor** (not bypassed_plan_id) via `loadActiveRates()` → DB lookup; rate seeded for `helix / ATT 35MB HX / $5`. **Vendor cycles + proration:** Wing/ATOMIC/Helix 5th→4th non-prorated; Teltik 16th→15th, prorated on activation only (full cycle on cancel). Frontend (Billing tab): Plan Rates CRUD UI (vendor + name + rate + effective_from + Notes; Add/Edit/End/Del; ending preserves history). Billing Ledger card with 8 status summary chips, vendor/status/month filters, paginated table (100/page, prev/next, "Page X of Y · N total"), Regenerate button. Per-SIM detail modal: new **Billing** tab — table of SIM's ledger rows with totals (Expected/Billed/Δ). Bill Audit vendor `<select>` expanded from Wing-only to all 4 vendors. **One-time DB cleanup:** 185 SIMs with `activated_at IS NULL` were backfilled from `created_at` (175 ATOMIC + 10 canceled Helix) — 0 NULLs remain in 1,793 SIMs. Decision: NO daily cron added — auto-trigger on bill upload + manual button + new-cycle clicks (5th & 16th of month) cover the use cases. **Deployed:** dashboard `2fb1c70f-4ae0-46a6-bb03-f2904f3cb965` (after intermediate `20c22539-86cf-484c-afa1-53db1280e4d2`). Migrations applied: `20260430_billing_ledger`, `20260430_ledger_months_rpc`. | dashboard, DB |
| 2026-04-29 | **Session 42 — ATOMIC OTA/cancel/resume + dashboard UI consolidation.** (1) Inline `simAction` path on mdn-rotator was unconditionally gated on `mobility_subscription_id` (Helix-era), so any OTA/cancel/resume on an ATOMIC SIM bounced with `SIM <iccid> has no mobility_subscription_id`. Replaced with vendor-aware branches BEFORE the subId check: `atomic` → `resendOtaProfile` (OTA), `deactivateSubscriber` w/ reasonCode `DD` (cancel), `reconnectSubscriber` w/ blank reasonCode (resume); each calls ATOMIC via `relayFetch`, logs to `carrier_api_logs` (vendor=atomic, step=`ota_refresh`/`manual_cancel`/`manual_resume`), and on success patches DB status (cancel→`canceled`, resume→`active`). MSISDN is sourced from `sim_numbers[0].e164` (preferred) with fallback to `sim.msisdn`; `msisdn` was added to the SIM-load select since it wasn't in the projection. `wing_iot`/`teltik` now return an explicit "not supported for vendor X" error for all three actions instead of the misleading subId error — neither vendor exposes a carrier-side OTA/status endpoint (Wing IoT is activate + plan-swap only; Teltik is gateway-side). Helix path unchanged. (2) Dashboard SIM bulk-action bar: 3 reseller buttons (Assign Reseller / Assign + Notify / Unassign Reseller) collapsed into one "Reseller…" button that opens a 3-option chooser modal — each option dispatches to the existing `bulkAssignReseller` / `bulkAssignResellerAndNotify` / `bulkUnassignReseller` handler unchanged. New "Delete SIMs" bulk button (red) wired to new `bulkDeleteSims()` — confirms then loops `/api/delete-sim` per SIM, streaming live per-SIM results into the shared `sim-action-modal` (same UX as Assign + Notify, with Cancel button). Patched via `patch-dashboard` skill (one Node script, both frontend + outer syntax checks pass). **Deployed:** mdn-rotator `9d38fb36-9dbf-4c82-9f31-abdc12b57543`, dashboard `4fa55eeb-71cc-462c-a782-e0a2420356bf`. | mdn-rotator, dashboard |
| 2026-04-28→29 | **Session 41 — Wing IoT orphan-state bug fix + daily reconciliation cron.** Diagnosed SIM 781 + 50 other wing_iot SIMs in orphan state `status='active' + rotation_status='mdn_pending'` (no automation watched this combo: `runWingIotFinalizer` filters `status=eq.provisioning`, reseller-sync backstop excludes `mdn_pending`). Today's webhook drop affected ~51 SIMs across the fleet — none notified to TrustOTP. Same-day fix: ran existing `/sweep-wing-cleanup` paginated (270 wing_iot SIMs total: 268 synced w/ webhooks fired, 2 marked_failed on ABIR). SIM 781 verified delivered to TrustOTP (rentalId 1274723). Then built durable fix: new `/reconcile-rotations` endpoint on details-finalizer with hard caps (≤60 AT&T GETs, ≤60 webhook POSTs, 0 PUTs, 90s) + 3 buckets (A=stuck mdn_pending, B=rotated-not-notified, C=log-only-eligible). Daily cron `30 10 * * *` UTC, gated on `RECONCILIATION_ENABLED` secret (shipped `"false"`). New `rotation_audit` table (Supabase migration). New dashboard widget (top of SIMs page) with red/orange/gray bucket counters + "Reconcile Now" button using `DETAILS_FINALIZER` service binding (bare fetch returns CF 1042 — Workers can't reach `.workers.dev` URLs). Added `force` param to `sendNumberOnlineWebhook` to bypass ABIR guard for callers that already filtered to `rotation_status='success'`. First post-deploy morning (2026-04-29 UTC 11:55): 269/270 wing_iot rotated success, 0 orphans, cron at UTC 10:30 correctly exited via flag. Deployed: details-finalizer `0c0029ee`, dashboard `2e7a8ed3`. | details-finalizer, dashboard, DB |
| 2026-04-28 | **Session 40 — Billing Audit (rebuilt from Wing Bill Verification).** Wing bills full-month per line regardless of mid-cycle activate/cancel, but the existing `Wing Bill Verification` audit walked `sim_status_history` to compute pro-rated `billable_days` and flagged any partial-month line as `overcharge` — false positives. Rewrote as vendor-agnostic, non-prorated, plan-aware. **DB:** `wing_bill_uploads` → `bill_audit_uploads`, `wing_bill_lines` → `bill_audit_lines`; added `vendor` (NOT NULL DEFAULT `'wing'`) + `bypassed_plan_id` columns; dropped `billable_days`/`total_days`. Migration recorded at `supabase/migrations/20260428_rename_wing_bill_to_bill_audit.sql`. **Audit logic:** five non-prorated checks — `unknown_iccid`, `canceled_before_period` (most-recent `sim_status_history` cancel timestamp < From Date), `rate_mismatch` (only when plan ID is in `PLAN_RATES` map; lines with unknown plan IDs skip the rate check so missing rates don't false-alarm), `duplicate_charge` (overlapping ICCID periods within upload), and informational `missing_from_bill` (active SIM not on bill). **`PLAN_RATES`** in `src/dashboard/index.js` near the Billing Audit section seeded with `{ '796': 5.00 }` (ATT 35MB HX). User confirmed rates for ATT Usage AC (Atomic) and ATT SMS DC (IoT) plans are unknown until a real bill surfaces them — add entries inline as they appear. **Endpoints:** `/api/wing-bill/*` → `/api/bill-audit/*` (no external callers). New `POST /api/bill-audit/recompute[?upload_id=N]` re-evaluates historical rows under the new logic; uses `supabaseGetAllArray` for paginated reads (PostgREST 1000-row cap) and bulk POST upsert via `?on_conflict=id` + `Prefer: resolution=merge-duplicates` for writes (avoids CF subrequest cap that broke first run on the 1186-row upload 3). **UI:** "Wing Bill Verification" → "Billing Audit" with vendor `<select>` (currently Wing only — Teltik later); Plan column added; Days column dropped; Audit History table includes Vendor column. Recompute run against 4 historical uploads (1502 lines) — final state: 344 discrepancies, $1,720 overcharge (upload 1: 16/$80, upload 2: 11/$55, upload 3: 317/$1,585, upload 4: 0/$0). Deployed: dashboard `80a51a02-4071-4cb5-b57a-44d809f23891`. Commit `9d28c9d`. | dashboard, DB |
| 2026-04-28 | **Session 39 — Teltik import dates + UI cleanup.** (1) **Teltik import auto-stamps dates**: `importTeltikLines()` in `src/teltik-worker/index.js` now sets `activated_at` + `last_mdn_rotated_at` to import time on **new** rows only (existing rows untouched, so in-flight rotations aren't clobbered). Backfill for the 600 pre-existing teltik SIMs: 398 newly-imported (today) → both fields = `2026-04-27 12:00 UTC`; 202 older rows with already-populated `last_mdn_rotated_at` → `activated_at = created_at`. 0 NULLs remaining. (2) **"Import Teltik" button moved**: removed from the SIM bulk-action toolbar; added as a card on the Workers page next to Reseller Sync (purple accent, "Fetch all Teltik lines & upsert" subtitle). Endpoint unchanged. (3) **`bulkAssignResellerAndNotify` now uses the shared progress modal**: per-SIM live lines (`assigned + notified` / `assigned, notify FAILED — …` / `assigned (skipped — not active or no number)` / `FAILED — …`) stream into `sim-action-output` with `Processing... (N/total)` footer + Cancel button + final summary line — matches `bulkSimAction` UX. **Discovered**: client-side bulk loops break when phone screen locks (`Failed to fetch` for all remaining SIMs after backgrounding) — see new **Server-side bulk-job pattern** entry under In Progress. **Deployed**: teltik-worker `3f19c093`, dashboard `d56f46df`. | teltik-worker, dashboard, DB |
| 2026-04-28 | **Session 38 close — auto-trigger verified + bug fixes.** Watched the 04:01 UTC cron fire 15 real ATOMIC `number.offline` events with proper dialable→dialable old/replaced_by pairs, all `status='delivered'` to TrustOTP — auto-trigger is live end-to-end. Three bug fixes shipped: (1) reseller-sync `&rotation_status=neq.failed` filter silently dropped NULL rows due to PostgreSQL NULL semantics; replaced with `or=(rotation_status.is.null,rotation_status.neq.failed)`. 0 active SIMs affected today but bulk-activator could create NULL rows that'd be silently excluded from the daily online backstop. (2) Inconsistent E.164 normalization at 4 of 6 offline call sites used `` `+1${sim.msisdn}` `` template (fragile if msisdn has formatting); standardized all 6 sites on `normalizeUS(sim.msisdn)`. (3) New `/test-offline` replay endpoint on details-finalizer (auth'd, bounded to limit≤50) supports `?dry=1` preview and `?force=1` dedup bypass — useful for future test-batches without waiting for a real rotation. Deployed: reseller-sync `0d455ed9`, details-finalizer `11ba84a5`, mdn-rotator `cd8a5bf6`. | reseller-sync, details-finalizer, mdn-rotator |
| 2026-04-28 | **Session 38 — `number.offline` webhook + ABIR online suppression.** New `sendNumberOfflineWebhook` helper duplicated into details-finalizer + mdn-rotator (mirrors the existing online helper); fired before every `closeCurrentNumber` on MDN replacement (WingIoT finalizer + cleanup sweep, Teltik finalizer, ATOMIC finalizer in details-finalizer; `rotateAtomicSim` + `rotateSingleSim` Helix branch in mdn-rotator). Payload includes `replaced_by` so resellers can map old→new without a join. Per-day dedup extended to `number.offline` in all three workers' `generateMessageIdAsync`. Three-layer ABIR suppression (never broadcast `number.online` while a wing_iot SIM is `rotation_status='failed'`): (a) reseller-sync active-SIM query gains `&rotation_status=neq.failed`; (b) dashboard backend `/api/sim-online` returns `{ok:false, abir_skipped:true, error:'…force-rotate first'}` with bulk frontend distinguishing skipped vs failed in toast; (c) defensive early-return guard at top of both `sendNumberOnlineWebhook` copies that re-reads vendor + rotation_status from DB. New `runOfflineRetrySweep` on reseller-sync iterates last-24h failed offline deliveries, re-posts with original `message_id`, updates `webhook_deliveries.status`. Wired into both `/run` and the daily 15:00 UTC cron. Deployed: details-finalizer `dda98db1`, mdn-rotator `459b4bfe`, reseller-sync `dd765a89`, dashboard `48e7fbab`. Approved plan: `~/.claude/plans/synthetic-moseying-flute.md`. | details-finalizer, mdn-rotator, reseller-sync, dashboard |
| 2026-04-27 | **Session 37 — Wing IoT ABIR-stuck rescue + dashboard query plan-guard + sim.offline planning.** Tonight's NY 0–5 rotation flagged 270 wing_iot SIMs as `rotation_failed` (verify_dialable timing out — AT&T committed the plan change ~3 s after our 30 s verify window). (1) **`rotateWingIotSim` redesign**: removed `verify_dialable` (the 2nd verify) — now PUT-2 returns 202 → flip to `provisioning`/`mdn_pending`, finalizer takes over (it has the plan-guardrail). Added "already on ABIR → skip PUT-1, jump to PUT-2" branch in `pre_rotate_get` to recover historically-stuck SIMs without burning the 1st PUT. Bumped `verifyPlan` budget 12×2.5s → 30×3s (90s) to ride out AT&T's slow commits. (2) **`processRotationBatch` stuck-wing remediation pass**: now also picks up wing_iot SIMs with `rotation_status='failed'` (regardless of daily dedup) and force-rotates them — the new ABIR-skip branch in `rotateWingIotSim` makes this a one-PUT recovery. (3) **Dashboard Wing query plan-guard** (`handleWingCheck`): only DB-syncs to `active` when `communicationPlan === 'Wing Tel Inc - NON ABIR SMS MO/MT US'`. When on ABIR, sets `rotation_status='failed'` + `last_rotation_error` so the rotator's stuck-wing pass picks it up. UI shows `[rotation_status→failed: stuck on ABIR (non-dialable)]` in bulk query results + warning toast. (4) **Bulk Query resilience**: 500 ms inter-call spacing + 2-retry budget (1 s, 3 s backoffs) — fixes "failed to fetch" mid-batch under load. (5) **New `/sweep-wing-cleanup` endpoint on details-finalizer**: paginated bulk reconciliation that GETs AT&T for all wing_iot SIMs, syncs good ones (DB + webhook), flags ABIR ones. Used today to flip 199/270 active→success and 71 to flagged-failed. (6) **DB-side**: bulk-flipped 270 wing_iot to provisioning, then SIM 1109 manual fix; rotator's stuck-wing pass + finalizer drained 199 SIMs end-to-end through the new code path. **Deployed**: mdn-rotator `13822943`, dashboard `46250766`, details-finalizer `35dfb41f`. **Local edits NOT yet deployed**: details-finalizer offline-webhook + ABIR defensive guard (handoff at `agent/next-session-2026-04-28.md`). Approved plan: `~/.claude/plans/synthetic-moseying-flute.md`. | mdn-rotator, dashboard, details-finalizer |
| 2026-04-26 | **Session 36 — kasa-control gateway reboot cron.** New `scheduled()` handler on `kasa-control` worker. Cron `0 0,3,12,15,18,21 * * *` UTC (6/day at ~3h cadence, deliberately skipping rotation window UTC 4-11). Handler fetches `gateways.code WHERE active=true` from Supabase, then reboots only KASA outlets whose `alias` matches a gateway code (case-insensitive). Sequential reboots (10s off + 10s on each via existing `controlOutlet` reboot action), so at most one gateway is powered down at any moment. Non-matching outlets (e.g., `Kasa_Smart Plug_9A97_3/4/5`) are ignored. New manual-trigger endpoint `POST /reboot-gateways?secret=X` (auth optional — unset by default). Auto-extends: adding a new gateway to DB with a matching outlet alias enrolls it on the next tick. Secrets pushed to kasa-control: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Currently 3 gateways enrolled: `64-1`, `512-1`, `512-2`. **Note:** entire `src/kasa-control/` directory was previously untracked; committed in this session. | kasa-control |
| 2026-04-24 evening | **Session 35 — provisioning+finalizer pattern extended to all async vendors.** (1) **Wing IoT rotation verify-plan**: `rotateWingIotSim` now polls GET after each PUT, requiring `communicationPlan` match + MDN change before proceeding. Throws if unverified after 12×2.5s attempts. Ends silent stuck-on-ABIR state. `runWingIotFinalizer` also gained a defense-in-depth guardrail refusing to mark success while plan !== `NON ABIR`. New `POST /remediate-stuck-wing?secret=X` endpoint on mdn-rotator: skips SIMs already dialable, PUTs dialable + verifies, flips to provisioning. (2) **Teltik provisioning+finalizer**: `rotateOneTeltikSim` no longer polls — calls `change-number`, flips to `status=provisioning, rotation_status=mdn_pending`, returns. New `runTeltikFinalizer` in details-finalizer calls `get-phone-number` every 5 min, reconciles `sim_numbers` + fires `number.online` when MDN changes. 30-min timeout → `rotation_status=failed`. Both paths now log to `carrier_api_logs` with `step=change_number_initiate` / `post_rotate_get` (apikey masked). (3) **ATOMIC 5xx safety net**: `rotateAtomicSim`'s `swapMSISDN` network errors + HTTP 5xx now flip to provisioning instead of throwing (prevents stale DB when ATOMIC succeeded but response was lost). `runAtomicFinalizer` in details-finalizer reconciles via service binding to new `/atomic-inquiry?secret=X&iccid=Y` endpoint on mdn-rotator (ATOMIC creds stay centralized there). Fixed inquiry-response field-name bug: code read `Result.MSISDN` (always null); correct field is `Result.msisdn` (lowercase) — fixed in 3 locations. (4) **`fixAtomicSim` Cancelled branch**: when `attStatus=Cancelled`/`Deactivated`, calls `reconnectSubscriber` (blank reasonCode) instead of `restoreSubscriber`. If ATOMIC replies "The Subscriber has changed to `<mdn>`", regex-parses the new MDN, syncs DB, retries once. New step labels in logs: `reconnect_subscriber`, `reconnect_subscriber_retry`. (5) Secrets added to details-finalizer: `TELTIK_API_KEY`, `ADMIN_RUN_SECRET`. New service binding `MDN_ROTATOR` on details-finalizer. Reset stale rotation_failed → success for 3 ATOMIC SIMs that bulk-query had already synced. | mdn-rotator, teltik-worker, details-finalizer |
| 2026-04-24 | **Rotation system redesign, session 34 — 9 parts shipped.** (1) DB migration: `check_rotation_status` now allows `mdn_pending`; `sims_status_check` now allows `rotation_failed`; new `rotation_source` ('auto'\|'manual') and `rotation_eligible` (bool, default true) columns. (2) Atomic `claim_rotation_slot(sim_id, force)` RPC — NY-calendar-day rule for ≤24h vendors, 48h rolling for teltik; enforces `rotation_eligible`. (3) NY-time gate `isInsideRotationWindowNY()` narrows scheduled to NY 0–5 hours; cron tightened to UTC `*/5 4-11 * * *` — DB-polling replaces CF Queue. (4) New `processRotationBatch(env, {limit, concurrency})` + `runWithConcurrency` helper (60/tick × 3 parallel) called via `ctx.waitUntil` from `scheduled()` and from `/run`. (5) Vendor cutover: every rotation path (atomic, wing_iot, helix, teltik) calls RPC first. (6) `increment_rotation_fail` 3-strikes cap now actually flips `status='rotation_failed'` (constraint fix). 38 stuck ATOMIC SIMs swept to rotation_failed. (7) `sweep_stuck_rotations` pg_cron every 15 min flips `rotation_status='rotating'` older than 30 min to failed. (8) `scripts/check_db_constraints.mjs` drift guard + `npm run predeploy` hook. (9) Dashboard: Last Notified cell opens webhook deliveries modal; `bulkSimAction` uses line-by-line modal; per-row Auto:On/Off pill + bulk Pause/Resume Auto-Rotate + `/api/set-rotation-eligible`. CF Queue producer/consumer bindings still present but unused. | mdn-rotator, teltik-worker, dashboard, DB |
| 2026-04-24 | **Billing fix: paginate reseller_sims (Supabase caps at 1000 regardless of &limit), rotation-aligned Teltik blocks, SMS-Usage RPC status filter.** Net recovery ~$760/cycle for TrustOTP alone. New `supabaseGetAllArray()` helper (offset+limit loop, pageSize=1000) used by both billing handlers. Teltik now bills one block per MDN rotation: block = `[valid_from, min(next_rotation, valid_from + rotation_interval_hours))`; block assigned to the cycle containing its `valid_from` EST date so a 48h window is never split across two invoices. Usage RPC: `mtd`/`trend` CTEs join `sims` raw (no status filter) since billing is retroactive; only `active_sim_count` and `wing_per_sim` keep the status filter. Commits `3c2babc` (billing) + new migration `20260423_sms_usage_billing_aligned.sql`. | dashboard, DB |
| 2026-04-24 | **sms-ingest (COMMITTED, NOT DEPLOYED):** Case A (Skyline recv-sms JSON) now resolves `sim_id` via `gateway_id + port` before falling back to MDN lookup — MDN lookups drift during rotation windows. Case A has had zero traffic in 30 days, so dormant hardening. Same commit includes pre-existing work: `postWebhookWithRetry` now routes via `relayFetch()` (closes the last bare `fetch()` to external endpoints). Commit `b6a3a90`. Deploy with `cd src/sms-ingest && npx wrangler deploy --env=""` when ready. | sms-ingest |
| 2026-04-23 | **SMS Usage analytics tab added to dashboard.** New sidebar tab between Billing and Guide. Shows MTD inbound SMS per vendor, Wing pool utilization (used/153,750), soft-target marker (25/SIM × N), 30-day trend chart (Chart.js CDN), top/bottom 10 Wing SIMs, est cost under $0.01/SMS overage. Backed by new Supabase RPC `get_sms_usage_summary(p_cycle_start, p_today, p_trend_days)` returning one JSONB blob. Worker route `/api/sms-usage` edge-caches 60s; frontend polls 120s while visible. Wing billing cycle = **5th to 4th of month** (confirmed with user) — soft-coded as `BILLING_CYCLE_ANCHOR_DAY = 5` near `handleSmsUsage` in `src/dashboard/index.js`. Commits `d3b0407` + `ee461f0`. | dashboard, DB |
| 2026-04-23 | Rotation cron resumed after session 30 redesign. Added activation-date skip: `queueSimsForRotation` filters out SIMs where `activated_at >= today NY midnight`, and `rotateSingleSim`'s dedup guard does the same check on both stale queue data and fresh DB read. Freshly activated SIMs no longer rotate same-day. | mdn-rotator |
| 2026-04-23 | details-finalizer Wing IoT runner now backfills `activated_at = NOW()` when the column is null on the SIM being finalized. Never overrides an existing value — preserves real activation timestamps. | details-finalizer |
| 2026-04-22 | **MDN rotation redesign (session 30):** Wing IoT plan swap now sets `status=provisioning` + `rotation_status=mdn_pending` and returns; details-finalizer's new `runWingIotFinalizer` (every 5 min) picks up provisioning Wing IoT SIMs, fetches new MDN, closes/opens sim_numbers, fires webhook. `syncWingIotPendingMdns` removed from mdn-rotator. | mdn-rotator, details-finalizer |
| 2026-04-22 | Dashboard rotate: ⚠️ force-rotate confirmation warning; Cancel button added to sim-action-modal for bulk runs (stops future iterations, in-flight SIM completes). Force param threaded through /api/sim-action → mdn-rotator's rotateSpecificSim (bypasses daily dedup when force=true). Teltik rotate now routes to TELTIK_WORKER service binding instead of mdn-rotator (new /rotate-sim endpoint on teltik-worker, extracted per-SIM rotateOneTeltikSim). | dashboard, mdn-rotator, teltik-worker |
| 2026-04-22 | mdn-rotator queue `max_batch_size` 10 → 25 (continuous drain between cron ticks). | mdn-rotator |
| 2026-04-22 | ATOMIC swapMSISDN 948 handler: when description matches "Subscriber Must Be Active", DB is patched to `status='suspended'` before queuing fix-sim (reflects AT&T reality). | mdn-rotator |
| 2026-04-22 | **Incident: 93 Wing IoT SIMs rotated 4× today.** Promise.all within batch + max_concurrency=5 created TOCTOU race on the dedup guard — parallel workers all read `last_mdn_rotated_at IS NULL` before any wrote. Reverted to serial batch processing + max_concurrency=1. All affected SIMs bulk-UPDATE'd with `last_mdn_rotated_at=NOW()` to prevent further duplicates today. | mdn-rotator, DB |
| 2026-04-21 | Wing IoT MDN sync architecture: activation now stores `status=provisioning` immediately (no blocking poll); `syncWingIotPendingMdns()` added to mdn-rotator — runs on every cron tick, finds wing_iot SIMs with `msisdn IS NULL`, GETs MDN from AT&T, writes `sim_numbers` + `sims.msisdn`, sends `number.online` webhook. Also added `/sync-wing-iot-mdns` HTTP endpoint for manual trigger. Already-activated check in queue consumer now also skips `status=provisioning`. Wing IoT rotation MDN poll increased from 5s to 4×60s with change-detection (throws if MDN never changes). **REPLACED 2026-04-22 — see session 30 above.** | bulk-activator, mdn-rotator |
| 2026-04-21 | Dashboard: bulk Modify IMEI now opens `sim-action-modal` showing per-SIM results live (was: single toast at end). Shows `SIM #ID: OK — IMEI <imei>` or `FAILED — <reason>` per SIM, running count, final summary. | dashboard |
| 2026-04-21 | Teltik rotation DB write bugs fixed: `msisdn` added to polling MDN field list (Teltik API uses this field, not `mdn`); fallback to `get-phone-number` now retries 3× with 15s delays instead of single call; DB writes (`sim_numbers` close + insert) now throw on non-ok response instead of silently discarding errors. | teltik-worker |
| 2026-04-21 | Rotation fail count made atomic via Supabase RPC — replaced JS read-modify-write with `increment_rotation_fail(p_sim_id, p_error, p_today_start)` RPC that does `SET rotation_fail_count = rotation_fail_count + 1` atomically; sets `status='rotation_failed'` when count reaches 3; resets count on first failure after midnight NY. Fixes race condition where concurrent queue messages all read stale count and wrote same incremented value. | mdn-rotator, DB |
| 2026-04-21 | ATOMIC fix-sim path added — `fixAtomicSim` in mdn-rotator: (1) retire old IMEI pool entries, allocate new IMEI, set on gateway; (2) ATOMIC subsriberInquiry to sync MDN; (3) if attStatus=Suspended, call restoreSubscriber (reasonCode=CR) and set sims.status=active. `fixSim` dispatches to this new path for vendor=atomic SIMs. `fixSim` HTTP + queue handlers now tolerate Helix token failure (non-fatal). | mdn-rotator |
| 2026-04-21 | Wing IoT daily rotation wired — `rotateWingIotSim` added to mdn-rotator: GET current MDN, PUT non-dialable plan, 2s sleep, PUT dialable plan, 5s sleep, GET new MDN, update sim_numbers + sims.msisdn, fire sendNumberOnlineWebhook. All steps log to carrier_api_logs (vendor=wing_iot). Daily cron filter now includes wing_iot SIMs. Manual `/rotate?iccid=` path also routes wing_iot correctly. | mdn-rotator |
| 2026-04-20 | Wing IoT post-activation MDN query delayed 60s (MSISDN takes ~1 min to propagate). Applied to `activateViaWingIot` (bulk-activator) and `retryActivateViaWingIot` (mdn-rotator). Dashboard stats (Total SIMs, Messages 24h) now use PostgREST `count=exact` instead of fetching all rows (was capped at 1000). QB billing CSV: column header `Qty` → `Item Quantity`. | bulk-activator, mdn-rotator, dashboard |
| 2026-04-20 | **Wing IoT activation root-cause fix:** Wing API is case-sensitive — status must be `"ACTIVATED"` (uppercase), not `"Activated"`. Also added missing `Accept: application/json` header. Applied to both `activateViaWingIot` (bulk-activator) and `retryActivateViaWingIot` (mdn-rotator). Also fixed bulk-activator's post-activation GET to read `msisdn` field (not `mdn`). Dashboard: enabled Retry Activation button for wing_iot SIMs (previously disabled — mdn-rotator retryActivation already supports wing_iot, just need button). Awaiting prod verification. | bulk-activator, mdn-rotator, dashboard |
| 2026-04-17 | ATOMIC swapMSISDN zip fix: added `activation_zip` to `sims` table; bulk-activator stores zip on activation; mdn-rotator (both batch + single path) reads `sim.activation_zip` instead of hardcoded `HX_ZIP`; dashboard ATOMIC query always overwrites `activation_zip` from inquiry `address.zipCode`; backfilled 147 existing SIMs from `carrier_api_logs`. | bulk-activator, mdn-rotator, dashboard, DB |
| 2026-04-17 | Gateway page: "Lock Failed" bulk-locks all st=6 (Reg Failed) ports; "Unlock Locked" bulk-unlocks all st=7/8/12 ports. Both iterate window.portData and POST to skyline/lock or skyline/unlock per port. | dashboard |
| 2026-04-17 | mdn-rotator change_imei: ATOMIC SIMs no longer blocked by missing mobility_subscription_id. Helix eligibility check + hxChangeImei now gated behind isHelixSim (vendor==='helix'). ATOMIC just updates gateway + IMEI pool + DB. | mdn-rotator |
| 2026-04-17 | mdn-rotator change_imei: fixed 409 on imei_pool_unique_in_use_slot — added second retire step keyed on (gateway_id, port) to evict stale slot occupants from previous SIMs before assigning new IMEI. | mdn-rotator |
| 2026-04-17 | Teltik MDN sync: GET /sync-mdns on teltik-worker checks all active Teltik SIMs against /v1/get-phone-number/, fixes sim_numbers on mismatch. Root cause documented: rotation stamps last_mdn_rotated_at before polling; if polling+fallback both fail, sim_numbers stays stale. | teltik-worker |
| 2026-04-17 | Dashboard: Teltik (T-Mobile) option in Carrier Query modal — /api/teltik-query backend, single-SIM ICCID lookup, DB auto-sync banner, bulk query support. Bulk routing needs verification (hard refresh required after deploy). | dashboard |
| 2026-04-17 | Manually fixed SIM 983 MDN: DB had +14232935084, Teltik API returned 8144182808 (+18144182808). Closed stale sim_numbers row, inserted correct MDN. | — |
| 2026-04-17 | Query bulk action: selecting multiple SIMs runs carrier query on each sequentially, shows per-SIM status in sim-action-modal. Single SIM still opens interactive modal. | dashboard |
| 2026-04-17 | DB sync on active carrier query: ATOMIC (attStatus=Active) and Wing IoT (status=ACTIVATED) now update sims.status, sims.activated_at, and sim_numbers MDN automatically after a successful query. Works for both single-SIM modal and bulk query. Fixes: ATOMIC uses `msisdn` (lowercase) not `MSISDN`; Wing IoT uses `ACTIVATED` not `ACTIVE`, MDN field is `msisdn` not `mdn`, passes `dateActivated`. | dashboard |
| 2026-04-17 | mdn-rotator: ATOMIC 914 ("sim already active with another MSISDN") during retry activation now runs a subsriberInquiry, syncs DB (status/MDN/activated_at), releases unused IMEI pool entry, and returns ok:true instead of throwing. | mdn-rotator |
| 2026-04-17 | retryActivation: now inserts MDN into `sim_numbers` + sets `activated_at` on success; gateway scan falls back to DB slot if scan fails; `slot_not_found` response now includes `error` field (was showing "unknown" in UI). `handleSimAction` now forwards `imei_strategy` to mdn-rotator. IMEI pool add: removed Helix eligibility gate entirely (was blocking all adds). `check-imei` endpoint returns `eligible:true` on Helix token failure. SIM 688 backfilled manually. | mdn-rotator, dashboard |
| 2026-04-16 | Retry Activation: IMEI strategy choice added — `showImeiStrategyChoice()` modal before every retry (per-SIM, bulk, detail modal). Backend `retryActivation()` accepts `imei_strategy: 'same'|'new'`. `'same'` reuses `sims.imei`; `'new'` retires old pool entry + allocates fresh one. Clear error thrown if `'same'` chosen but no IMEI on record (no silent fallback). Guide section updated to ATOMIC/Wing IoT wording. | mdn-rotator, dashboard |
| 2026-04-16 | Activation address randomized — `src/shared/address-pool.js` with 25 addresses across 23 states; `pickRandomAddress()` called once per activation in `activateViaAtomic`, `hxActivate` (bulk-activator), `hxActivate`, `retryActivateViaAtomic` (mdn-rotator). Old `HX_ADDRESS1/CITY/STATE/ZIP` env vars no longer used in activation paths. | bulk-activator, mdn-rotator |
| 2026-04-16 | Dashboard: port display normalized client-side — `normalizePortDisplay()` converts old letter-format ports ("13C") to dot-notation ("13.03") in SIM table, detail modal, and IMEI tab. DB data unchanged. | dashboard |
| 2026-04-16 | Dashboard: D3 per-SIM detail modal — tabbed modal (Details/Status/IMEI/API Logs) opened by SIM ID, Status, IMEI row buttons. IMEI tab requires only gateway+port (not sub ID). `_sdOpenImei()` closes detail modal before opening IMEI dialog to avoid z-index conflict. | dashboard |
| 2026-04-16 | Dashboard: fix Query button blocked by `HELIX_ENABLED` gate — moved guard from top of `queryHelix()` into Helix-only branch so ATOMIC and Wing IoT queries work when Helix is disabled | dashboard |
| 2026-04-15 | **Helix Quarantine (session 16):** Full audit + quarantine of all Helix code behind `HELIX_ENABLED=false` flag on 7 workers. mdn-rotator daily cron fixed to rotate ATOMIC SIMs (50/50 success on first prod tick). 4 provider-leak bugs fixed (vendor defaults, billing aggregation). Dashboard: Helix UI elements hidden/disabled when flag off, 3 backend routes return 503, queryHelix functions gated. | mdn-rotator, bulk-activator, sim-canceller, sim-status-changer, ota-status-sync, details-finalizer, dashboard |
| 2026-04-15 | Dashboard: shift-click range selection on SIM checkboxes (sims page) | dashboard |
| 2026-04-15 | mdn-rotator: ATOMIC manual rotation path added — `rotateSpecificSim` now branches on vendor; new `rotateAtomicSim` calls swapMSISDN + fallback inquiry + DB/webhook writes. Daily queue (rotateSingleSim) still silently skips ATOMIC — not yet migrated. | mdn-rotator |
| 2026-04-15 | Dashboard: gateway "Export Table" button — scans selected gateway via skyline-gateway `/port-info?all_slots=1` and downloads CSV (port/slot/iccid/imei/number/operator/signal/sim_status/state). Caught 522 escaping bug mid-session (regex char class `\n\r` became literal newlines) — fix: `\\n\\r` in source. Surfaced by `_check_frontend_js.js`. | dashboard |
| 2026-04-15 | Dashboard: `/api/delete-sim` route + per-row Del button; child-row cleanup (sim_numbers, inbound_sms, reseller_sims, sim_status_history) + nullify system_errors.sim_id | dashboard |
| 2026-04-15 | Dashboard: `/api/relay-test` route + new API Tester tab; presets for ATOMIC/Wing IoT/Teltik/Helix + custom | dashboard |
| 2026-04-15 | Dashboard: `/api/atomic-query` route + separate ATOMIC option in bulk Query modal (was merged into Helix). Auto-routes by vendor in `querySimCarrier`. ATOMIC credentials (ATOMIC_USERNAME/TOKEN/PIN) pushed to dashboard worker + added to `.dev.vars`. | dashboard |
| 2026-04-15 | Dashboard: `RELAY_URL` + `RELAY_KEY` secrets pushed (previously missing, causing 522 on any dashboard-side external API call). Full relay + ATOMIC + Wing IoT creds now in `.dev.vars`. | dashboard |
| 2026-04-15 | Data: 625 Helix SIMs bulk-updated to `status='canceled'` via PostgREST PATCH (no migration, one-off data op) | — |
| 2026-04-15 | Rule hardcoded: EVERY edit to `src/dashboard/index.js` must go through the `patch-dashboard` skill. Written into `agent/BOOTSTRAP.md` Rule 1 and `agent/constraints.md §1` with no-exceptions list and mandatory two-check workflow. Incident reference: freehand patch of gateway-export shipped invalid regex to prod; only the frontend JS check (part of the skill) would have caught it before deploy. | — |
| 2026-04-14 | ATOMIC + Wing IoT Phase 2+3: deployed 6 workers with vendor routing; dashboard updated with vendor filter (atomic/wing_iot/helix/teltik), carrier_api_logs query, vendor badges, OTA/Retry disabled for wing_iot | bulk-activator, mdn-rotator, ota-status-sync, sim-status-changer, sim-canceller, details-finalizer, dashboard |
| 2026-04-14 | ATOMIC + Wing IoT Phase 1: new shared modules (atomic.ts, wing-iot.ts), vendor routing in 6 workers, DB migration (carrier_api_logs + vendor column), new API skills | bulk-activator, mdn-rotator, ota-status-sync, sim-status-changer, sim-canceller, details-finalizer |
| 2026-03-27 | Billing: vendor-split billing — Teltik SIMs billed per 48h block at 2× daily_rate; Helix SIMs billed per calendar day at daily_rate; both preview and CSV download updated; buildCSV uses per-row rate | dashboard |
| 2026-03-25 | Teltik webhook: 48h guard stamped on change-number initiation (before polling); fallback to get-phone-number if polling fails; online_until = midnightNYAfterInterval(last_mdn_rotated_at, interval_hours) in all 3 code paths; carrier field (T-Mobile/att) added to all number.online payloads; webhook handler fixed for Teltik push format (destination/origin/message/timestamp) + array payload support | teltik-worker, reseller-sync, dashboard |
| 2026-03-25 | Teltik vendor integration: new `teltik-worker` (import/webhook/rotate/setup-webhook), DB migration adds vendor/carrier/rotation_interval_hours to sims, mdn-rotator filters to helix-only + vendor guard in rotateSpecificSim, reseller-sync vendor-aware online_until + interval-based backstop skip, dashboard vendor column/filter/Import button | teltik-worker (new), mdn-rotator, reseller-sync, dashboard, DB migration |
| 2026-03-24 | Dashboard: fixed two prod bugs from prior session — missing fetch URLs in queryHelix/queryHelixBulk (bare backtick issue) and \n→newline in dbLines.join (template literal escape bug); rewrote _check_frontend_js.js to use Node vm.runInContext to accurately simulate template evaluation | dashboard |
| 2026-03-24 | patch-dashboard skill updated: added frontend JS check step (vm-based), documented correct BT='\\\\'+'\`' escaping pattern, added explicit --env flag warning | — |
| 2026-03-24 | IP relay: VPS at 74.208.37.8, Node.js relay service on relay.zmawsolutions.com (HTTPS/TLS); helix.ts `relayFetch()` routes all 5 Helix API calls through relay; RELAY_URL + RELAY_KEY secrets pushed + deployed to 6 workers | bulk-activator, details-finalizer, mdn-rotator, ota-status-sync, sim-canceller, sim-status-changer |
| 2026-03-23 | Dashboard: Gemini UI redesign (zinc/blue palette, expanded sidebar w/ labels, Inter font, mobile responsive); light/dark mode toggle (CSS vars + localStorage); all 26 confirm()→showConfirm() + 14 alert()→showToast() | dashboard |
| 2026-03-23 | Dashboard: deployed to **test only** — production not yet updated this session | dashboard |
| 2026-03-20 | Dashboard UX: SIMs default filter → Active only; SMS page limit 50→500; all modals close on Escape/backdrop click | dashboard |
| 2026-03-20 | Dashboard: "Not rotated today" + "No SMS in 12h" quick filters on SIMs view (client-side) | dashboard |
| 2026-03-20 | Dashboard: Lock/Unlock/Switch SIM buttons per slot in Gateway port-detail popup | dashboard |
| 2026-03-20 | Dashboard: Retry button on failed Helix API log entries in SIM logs popup; maps step→action (mdn_change→rotate, ota_refresh→ota_refresh, else→fix) | dashboard |
| 2026-03-17 | Gateway-ID path encoding + port-based SIM lookup for 512-2: /gw/<id> path segment, findSimIdByGatewayPort fallback, /sync-gateway-slots endpoint, Sync Slots dashboard button | sms-ingest, mdn-rotator, dashboard |
| 2026-03-16 | OTA BLIMEI source-of-truth strategy: `hxChangeImei` flags `_alreadyAssigned`; fixSim forces new pool IMEI on stale Helix cache; fixSim OTA step updates `sims.imei` from live BLIMEI | mdn-rotator |
| 2026-03-16 | `blimei_update` queue job: OTA refresh → DB imei update → gateway set, 1 per message; `/trigger-blimei-sweep` endpoint queues all 535 active SIMs | mdn-rotator, dashboard |
| 2026-03-16 | `/imei-gateway-sync` fix: `sims.imei` updated from OTA BLIMEI before gateway set attempt, so heartbeat retries use correct IMEI even if gateway is down | mdn-rotator |
| 2026-03-15 | IMEI heartbeat system: `gateway_imei_synced_at`, `gateway_imei_sync_count`, DB trigger on suspend/cancel, periodic re-sync, 3-consecutive graduation | mdn-rotator, DB |
| 2026-03-15 | System-wide IMEI gateway sweep: `/imei-gateway-sync` endpoint, 295/295 active SIMs synced (BLIMEI = gateway IMEI) | mdn-rotator, dashboard |
| 2026-03-15 | fix-sim: reuse existing eligible IMEI before allocating new; retryUntilFulfilled treats "not needed/already assigned" as success | mdn-rotator |
| 2026-03-15 | Rotation guard rail: daily IMEI re-sync on every rotation to break DLC suspension cycle | mdn-rotator |
| 2026-03-15 | Suspended SIM sweep: all 7 suspended SIMs restored (fix-sim via `/imei-sweep`) | mdn-rotator |
| 2026-03-14 | MDN rotator: all-day cron, client-only filter, 5xx skip, subscriber-must-be-active → fix-sim | mdn-rotator |
| 2026-03-13 | Agent OS built: `agent/` directory with 7 docs + 3 skills (patch-dashboard, sim-triage, session-close) + user SOP | — |
| 2026-03-13 | `op=save` added after IMEI set — persists IMEI changes across gateway reboots | skyline-gateway |
| 2026-03-11 | Reseller sync: remove verification_status filter; backfill all sim_numbers to verified | reseller-sync |
| 2026-03-11 | Dashboard: Force re-send option in Reseller Sync | dashboard |
| 2026-03-01 | RLS enabled on all public Supabase tables | DB migration |
| 2026-02-25 | SMS verification removed; verified: true hardcoded in all number.online senders | mdn-rotator, reseller-sync, dashboard |
| 2026-02-19 | QBO tables created; quickbooks worker deployed | quickbooks, DB migration |
| 2026-02-19 | Billing: switch to QBO CSV export format with service date | quickbooks |

---

## Teltik Production Notes

- **Push webhook format**: `{ destination, origin, message, timestamp, port, gateway_id, nickname }` — NOT `{ to, from, message, time_stamp }` (that's the all-sms polling format). Handler accepts both.
- **First rotation (2026-03-25)**: cron fired at 21:10 UTC, numbers changed in Teltik but DB not updated due to polling format mismatch. DB manually patched: SIM 629 → +17754018206, SIM 630 → +19187209741, last_mdn_rotated_at set to ~21:57 UTC.
- **Next Teltik rotation due**: ~2026-03-27 21:57 UTC (48h after manual patch). Cron will handle automatically.
- **48h guard**: `last_mdn_rotated_at` is now stamped immediately on `change-number` API success, before polling completes — prevents double-rotation even if polling fails.

---

## Architecture Validation

These items were verified to be working correctly as of their last check:

- MDN rotation cron (all-day, every 20 min): ✅
- Dedup guard in `rotateSingleSim` (re-reads DB before rotating): ✅
- `op=save` after IMEI set: ✅ (added 2026-03-13)
- IMEI heartbeat re-sync (every 20 min, graduated after 3×, reset on suspend/cancel): ✅ (added 2026-03-15)
- OTA BLIMEI = `sims.imei` = gateway IMEI strategy: ✅ (sweep in progress 2026-03-16)
- `hxChangeImei` `_alreadyAssigned` flag + fixSim force-new-pool-IMEI: ✅ (deployed 2026-03-16)
- sms-ingest AT&T upgrade message → auto IMEI change: ✅
- Reseller webhook dedup (date-based, failed doesn't block): ✅
- OTA error handling (both errorMessage + rejected[].message): ✅
- RLS bypass via service_role key: ✅
- Port format normalization (dot-notation): ✅

---

## Open Questions

_None currently tracked._
