# Decision Log

Each entry: **what was decided**, **why**, **consequence / what not to undo**.

---

## 2026-04-24 — DB-driven polling replaces Cloudflare Queues on the rotation hot path

**Decision:** `mdn-rotator` no longer uses Cloudflare Queues for scheduled rotations. Each 5-min cron tick (UTC `*/5 4-11 * * *`, narrowed by an NY-hour gate to NY 0–5) calls `processRotationBatch(env, {limit: 60, concurrency: 3})` inline via `ctx.waitUntil`. Eligibility is a DB query filtered by `status='active' AND rotation_eligible=true AND vendor IN (helix,atomic,wing_iot) AND reseller active AND claim-slot predicate`. Each SIM's atomic claim still goes through the `claim_rotation_slot` RPC. Teltik already ran this way and is unchanged.

**Why:**
1. Reproducible CF Queue delivery stall observed on 2026-04-24: after a `/run` queued 41 eligible SIMs, only `max_batch_size` (25 then 10) were processed; the remaining sat unprocessed despite the consumer being idle and messages unacked on our side. A second `/run` click delivered another single batch and idled. This happened with `max_concurrency=1` and `max_retries=0` and standard ack semantics — reproducible across multiple tests; the queue did not re-deliver on its own timetable. Cloudflare documentation doesn't describe this behavior; the working hypothesis is consumer-warmup pacing at low message volume.
2. The symptom is catastrophic for a daily-rotation workload: an entire night's eligible SIMs would need ~20 manual `/run` clicks to drain. Unacceptable even before counting operator friction.
3. Teltik's queue-free inline loop has worked without any such issue. Porting that pattern to mdn-rotator is a small structural change with no new external dependency.
4. `claim_rotation_slot` is atomic, so bounded parallelism (concurrency=3) inside the tick is safe — two workers can't both claim the same SIM.

**Consequence:**
- `mdn-rotation-queue` producer + consumer bindings in `src/mdn-rotator/wrangler.toml` and the consumer branch in `async queue(batch, env)` are currently dead code. Keep them until one verified overnight run, then remove in a small PR.
- `queueSimsForRotation` function in `src/mdn-rotator/index.js` is no longer called by any route. Remove alongside the queue bindings.
- `fix-sim-queue` stays — low-volume, no delivery-stall symptoms.
- Cron cadence is now 5 min (12 ticks/night inside NY 0–5) instead of 20 min. Per-tick budget is 60 SIMs × ~10s ÷ 3 parallel ≈ 3.3 min wall clock — well inside Workers' paid 15-min scheduled-invocation limit.
- `/run` HTTP endpoint is now the correct way to drain on-demand; one call processes up to 60 eligible SIMs inline before returning. No enqueue step.
- Do not reintroduce CF Queues on the rotation hot path without first proving the delivery-stall was resolved (CF runtime change, different consumer config, etc.). If needed, add a feature flag and canary it.

---

## 2026-04-24 — Rotation eligibility uses NY calendar day, not rolling 24h

**Decision:** `claim_rotation_slot` eligibility for ≤24h vendors (`rotation_interval_hours <= 24`: helix, atomic, wing_iot) is "rotated before today's NY calendar midnight." Multi-day vendors (teltik, interval 48h) keep the rolling `NOW() - interval '<N> hours'` check.

**Why:**
1. Under the "rolling 24h" rule paired with a fixed 12 AM – 6 AM NY rotation window, a SIM rotated at 5:40 AM NY yesterday needs >26 hours to elapse — which overshoots the end of today's window. The SIM can't rotate today and must wait until tomorrow's window, repeating indefinitely. Over weeks, SIMs drift later and exit the window entirely.
2. "Once per NY calendar day" removes the cadence drift: the moment NY midnight rolls over, every SIM rotated yesterday becomes eligible, regardless of exact elapsed time. 12 window-ticks × 60 SIMs = 720 slots/night is ample for ~470 active SIMs.
3. Teltik's 48h interval is a real-time constraint (not "not more than once per two calendar days") — kept rolling.

**Consequence:**
- The `claim_rotation_slot` branch on `rotation_interval_hours <= 24` uses `last_mdn_rotated_at < today_ny_midnight`. `> 24` branch uses `last_mdn_rotated_at < NOW() - (rotation_interval_hours || ' hours')::interval`.
- Adding a new vendor: set `rotation_interval_hours` appropriately. ≤24 means NY-day semantics automatically.
- Do NOT pre-emptively switch teltik to NY-day; doing so would allow two rotations within 48h (e.g. rotate 11 PM Mon → eligible again Tue midnight = 1h later).

---

## 2026-04-24 — Rotation stamp (`last_mdn_rotated_at`) lands via RPC before any external API call

**Decision:** All vendor rotation functions (`rotateAtomicSim`, `rotateWingIotSim`, Helix inline in `rotateSingleSim`, `rotateOneTeltikSim`) call `claim_rotation_slot(sim_id, force)` as their first step. The RPC performs a single atomic `UPDATE sims SET last_mdn_rotated_at=NOW(), rotation_status='rotating', rotation_source='auto'|'manual' WHERE <eligibility predicate>` and returns true/false. External API calls are made ONLY when the RPC returned true.

**Why:**
1. On 2026-04-24 we observed two separate schema/code drift incidents where a DB CHECK constraint rejected a PATCH containing the rotation stamp, rolling back the entire transaction. In both cases — `rotation_status='mdn_pending'` (Wing IoT, 1,020 burns in a day) and `status='rotation_failed'` inside `increment_rotation_fail` (3-strikes cap silently broken since inception) — the code assumed "the call returned" meant "the state persisted." It didn't.
2. Pre-redesign Atomic/Helix stamped `last_mdn_rotated_at` at the END of the rotation via `updateSimRotationTimestamp`, after all API + DB writes. Any throw in between left the SIM eligible to re-rotate, burning another MDN on the next cron tick.
3. The RPC pattern stamps FIRST in a guaranteed-minimal UPDATE that touches only fields in known-allowed enum values. Even if a downstream PATCH fails, the stamp is durable. At worst we miss one rotation; never a double burn.

**Consequence:**
- Every new rotation code path MUST begin with `claim_rotation_slot`. Do not reintroduce any "stamp at the end" pattern.
- Manual paths pass `force=true`, bypassing the interval + eligibility predicates but still stamping atomically.
- Queue consumers, HTTP handlers, and dashboard service-binding routes all share the same RPC gate. The `force` boolean is the ONLY difference between auto and manual.
- When adding a new `rotation_status` enum value in code, update the `check_rotation_status` constraint in the same migration AND add to the allowlist in `scripts/check_db_constraints.mjs`. `npm run check:db-constraints` runs as a `predeploy` hook.

---

## 2026-04-24 — Teltik billing blocks align to MDN rotations, not to cycle-start day pairs

**Decision:** Teltik 48h billing blocks are computed per-rotation, not by pairing consecutive calendar days from cycle_start. For each `sim_numbers` row in the cycle window, block = `[valid_from, min(next_rotation_valid_from, valid_from + rotation_interval_hours))`. A block is billable iff the sim had any SMS on any EST date the block touches, and the block is assigned to the cycle containing its `valid_from` EST date (never split). The per-sim 48h clock comes from `sims.rotation_interval_hours` (default 48).

**Why:**
1. The previous logic paired consecutive calendar days `(start, start+1)`, `(start+2, start+3)`, etc. from `cycle_start`. This produced two bugs:
   - A single physical 48h rotation window (e.g., rotation at noon Apr 6 → noon Apr 8) spans 3 calendar dates, so SMS on different dates could bill TWO pair-blocks for ONE rotation.
   - A block whose rotation timestamp straddles a cycle boundary would either be double-counted (billed in both cycles) or dropped (billed in neither) depending on how SMS dates fell.
2. The authoritative source of "when did the SIM get a new MDN" is `sim_numbers.valid_from`, which is stamped at each rotation event. Aligning billing to this data removes the impedance mismatch with the carrier's reality.
3. Using `min(next_rotation, valid_from + 48h)` as the block upper bound (instead of always `+48h`) prevents overlap when rotations fire <48h apart (≈110 of 885 TrustOTP rotations in Apr 5–23 were under 48h). Overlapping blocks would have let the same SMS trigger two billings.

**Consequence:**
- Teltik billing cost per cycle moves. TrustOTP Apr 5–23: +$436 (649 blocks × $2.20 block rate, vs. 452 before pagination fix / 601 before rotation fix).
- If a Teltik SIM has NO rotations within a cycle (unusual — would mean rotator never fired for it in 48h+), that SIM's SMS in the cycle are NOT billed (they belong to the last-started block, which was billed in the prior cycle). This matches user intent: "next cycle won't count that extra day because it's in the 48 block that was billed already."
- `sims.rotation_interval_hours` is authoritative for block size. If a future vendor (not Teltik) is added with a different block interval, set that column and the existing code handles it — no new branch needed.
- The handler issues a second PostgREST query for `sim_numbers` in a widened window (`cycle_start - 2 days` to `cycle_end + 3 days`). Don't narrow this without understanding: a rotation whose valid_from is within the cycle can have a block that extends beyond, and we need the subsequent rotation to bound it.

---

## 2026-04-24 — Paginate PostgREST reads in billing handlers (Supabase caps at 1000 regardless of `&limit`)

**Decision:** Added `supabaseGetAllArray(env, pathWithoutLimit)` helper to `src/dashboard/index.js` that loops over `offset+limit=1000` until a short batch returns. Both billing handlers (`handleBillingPreview`, `handleBillingDownloadInvoice`) use it for their `reseller_sims` query. The caller passes the path WITHOUT a `limit` or `offset` — the helper appends them.

**Why:**
1. Supabase's PostgREST server silently caps every response at 1000 rows regardless of the URL's `&limit=<N>` parameter. This was discovered while debugging TrustOTP (1213 active reseller_sims): the dashboard billing preview was returning only 146 of 202 Teltik sims. The earlier session-level memory ("Default row limit 1000 → add `&limit=5000`") reflects an incorrect assumption — the parameter does NOT override the server cap. The `&limit=5000` pattern is therefore partially misleading; it works only for datasets already under 1000.
2. Alternatives considered: raising Supabase's `db-max-rows` config (admin-level, impacts every query project-wide) or using PostgreSQL `Range` headers. Offset pagination is the least-invasive, local change — touches one helper and two call sites.
3. Pagination order needs to be stable across pages. `reseller_sims` has no `id` column (composite PK on `reseller_id + sim_id`); the helper callers add `&order=sim_id.asc` explicitly.

**Consequence:**
- Any PostgREST query that could legitimately return >1000 rows (sims, reseller_sims, inbound_sms over long windows, sim_sms_daily across many sims) should use `supabaseGetAllArray` going forward — NOT `supabaseGet` with `&limit=5000`. The `&limit=5000` idiom in existing code is mostly safe-by-accident (datasets happen to be small); do not use it as a precedent.
- If the helper's page size (1000) ever needs to be raised, verify the Supabase `db-max-rows` setting first. Raising the helper's page size beyond the server cap silently truncates again.
- The helper returns the first non-array response as-is (for error passthrough). Callers that expect arrays should guard with `Array.isArray(rsSims)` (both billing handlers already do).

---

## 2026-04-23 — SMS Usage analytics: Postgres RPC returning a single JSONB blob

**Decision:** The SMS Usage tab is backed by a single Postgres RPC, `get_sms_usage_summary(p_cycle_start, p_today, p_trend_days)`, that returns one JSONB object with all five views: `vendors`, `wing`, `wing_top`, `wing_bottom`, `trend`. Billing-cycle anchor (`BILLING_CYCLE_ANCHOR_DAY = 5`) lives Worker-side; the Worker computes `p_cycle_start` in EST and passes it into the RPC. Worker edge-caches the response 60s in `caches.default`. Frontend polls every 120s while the tab is visible.

**Why:**
1. The alternatives were (a) query `sim_sms_daily` directly via PostgREST and aggregate client-side, or (b) split into multiple RPCs/endpoints. Option (a) ships ~12–18K rows per page load; option (b) multiplies round-trips. A single RPC returns ~100 rows total, with cycle-boundary math centralized in Postgres where `sim_sms_daily.est_date` is authoritative.
2. The billing-cycle anchor lives Worker-side (not in Postgres) because it's a configuration value that changes with business agreements, not a data-schema invariant. Shipping it to the RPC as a parameter keeps the RPC reusable if we ever want per-vendor anchors.
3. 60s edge cache + 120s poll was chosen because `sim_sms_daily` is trigger-fed (millisecond lag from `inbound_sms`), so staleness is bounded by cache TTL, not by ingestion latency. Polling faster than the cache TTL just wastes cache bandwidth.

**Consequence:**
- When adding new SMS-usage metrics (e.g., per-reseller, per-gateway), extend the RPC rather than creating a parallel endpoint. The RPC's CTE structure (active_sims → mtd → vendor_totals / wing_per_sim) is the template.
- `BILLING_CYCLE_ANCHOR_DAY` is soft-coded in `src/dashboard/index.js` — change there when the Wing cycle date changes. If other vendors (Teltik, ATOMIC) ever get cycle-aware metrics, add a per-vendor anchor map rather than a single constant.
- Chart.js is now loaded from CDN in the dashboard `<head>` (jsdelivr, v4.4.0). If additional charts are added elsewhere, reuse the same tag — don't pull a second library.
- `$` in a string passed as `replacement` to `String.prototype.replace(searchString, replacement)` is a pattern ("$'" = text-after-match, "$&" = match, "$$" = literal `$`). During patch-script work on the dashboard, ALWAYS use function-form replace: `content.replace(OLD, () => NEW)`. This is now documented in `patching-gotchas.md` memory; do not rediscover it.

---

## 2026-04-23 — Cron rotation skips SIMs activated today

**Decision:** `queueSimsForRotation` (mdn-rotator) and the dedup guard in `rotateSingleSim` both filter out SIMs where `activated_at >= today NY midnight`. A SIM activated today will not be rotated by the cron until tomorrow's midnight NY. Manual rotate via the dashboard still works (it uses `force=true` which bypasses both rotation and activation guards).

**Why:**
1. Freshly activated SIMs often take 1–5 minutes for the MDN to fully propagate at the carrier. Rotating on the same day risks a race where the rotation plan-swap hits the carrier before activation is fully settled — which is how several "MDN change failed" errors have shown up historically.
2. Resellers who just received a new MDN via activation webhook shouldn't have it changed again the same day — they haven't had time to dispatch it to an end user yet.
3. The cron path is the right place for this guard: scheduled runs are meant to be non-destructive; only the manual Rotate button (which shows a force-rotate warning) should override.

**Consequence:**
- `activated_at` is now a load-bearing column for rotation eligibility. Any worker that activates SIMs **must** stamp `activated_at` at activation time — otherwise the SIM will be eligible for rotation on day-zero.
- details-finalizer backfills `activated_at = NOW()` when null (see 2026-04-23 details-finalizer change), so Wing IoT activations are covered. ATOMIC bulk-activator already stamps it directly.
- The skip comparison is `activated_at >= today NY midnight` (DST-aware), same shape as the rotation guard.
- Do not add "override activation-date skip" to the cron path — if you need to rotate a same-day-activated SIM, use the dashboard Rotate button with the force warning.

---

## 2026-04-22 — Wing IoT rotation is two-phase: mdn-rotator flips status, details-finalizer fetches MDN

**Decision:** `rotateWingIotSim` in mdn-rotator does the plan swap (PUT non-dialable → PUT dialable), stamps `last_mdn_rotated_at` + `rotation_status='mdn_pending'`, sets `sims.status='provisioning'`, and returns immediately. It does NOT poll AT&T for the new MDN. A second worker (details-finalizer, every 5 min) picks up `vendor='wing_iot' AND status='provisioning'`, GETs the MDN, closes/opens `sim_numbers`, sets status back to `active`, and fires the `number.online` webhook.

**Why:** AT&T takes ~1 minute to assign a new MDN after the dialable plan swap. Polling inside the rotation queue consumer held the queue open 4+ min per SIM (tried 4×60s). With 55 Wing IoT SIMs and `max_concurrency=1`, that's 3–4 hours to drain the queue. Moving the MDN fetch to a separate worker on its own cadence:
- Decouples API rate: rotation queue drains fast, MDN sync runs on a 5-min timer
- Uses `status='provisioning'` as the unified signal (same state as new-activation flow) — rest of the system already filters on `status='active'` so a provisioning SIM is correctly excluded
- Sidesteps the temptation to parallelize rotations (which caused the 4×-rotation incident earlier that day)

**Consequence:**
- **Do not put blocking API polls in the rotation queue consumer for any vendor.** ATOMIC is OK (MDN comes back in the swap response synchronously); everything else should follow the provisioning-pattern.
- The ~1 min gap between plan swap and new MDN is observable: reseller may receive the `number.online` webhook 1–5 min after `last_mdn_rotated_at` is stamped. If immediacy matters, reduce details-finalizer cron interval.
- `syncWingIotPendingMdns` in mdn-rotator is deleted — do not re-add. Reuse the details-finalizer runner.

---

## 2026-04-22 — Dashboard rotate button always force-rotates (with explicit warning)

**Decision:** The per-SIM and bulk Rotate buttons in the dashboard always pass `force: true` through to the backend, bypassing the `last_mdn_rotated_at < today NY midnight` dedup guard. The confirmation dialog explicitly warns the user: "⚠️ This will force-rotate even if already rotated today." The cron path does NOT use force — only the manual dashboard path does.

**Why:** The prior behavior was inconsistent: Wing IoT clicks silently failed with "already rotated today", ATOMIC clicks silently force-rotated. The user needs to be able to intentionally re-rotate a SIM if something went wrong — that's the whole purpose of a manual button. The risk is accidental double-rotations (today's incident). The mitigation: a visible warning in the confirmation dialog so the click is never unintentional, plus a reseller-facing concern in the warning text.

**Consequence:**
- **Do not remove the warning text.** It's the only thing between the user and an AT&T-breaking duplicate rotation.
- The daily dedup guard still applies on the cron path, which is where accidental duplicates are most likely.
- If you add other "manual rotate" paths (e.g., slack slash command, CLI), they must also pass `force: true` AND show an equivalent warning — the backend will otherwise block them.

---

## 2026-04-22 — Never parallelize rotation within a single CF Worker invocation

**Decision:** The mdn-rotator queue consumer processes messages **serially** within a batch (`for … of`), not in parallel (`Promise.all`). `max_concurrency` stays at 1. This is a hard rule.

**Why:** An earlier attempt to increase throughput combined `max_batch_size=10 + Promise.all + max_concurrency=5`. With duplicate messages from multiple cron ticks (the same SIM queued 4–5 times across ticks), 50 workers were in-flight simultaneously. All of them read `last_mdn_rotated_at IS NULL` *before any of them wrote*, all passed the TOCTOU dedup check, and all called the AT&T API. Result: 93 Wing IoT SIMs received 4 plan swaps each in 15 minutes. AT&T assigned 4 different MDNs to each SIM in rapid succession — exactly the carrier-relationship-damaging scenario we were trying to prevent.

**Consequence:**
- **Do not** set `max_concurrency > 1` on `mdn-rotation-queue`.
- **Do not** wrap the batch loop in `Promise.all`.
- To increase throughput, increase `max_batch_size` (currently 25) — that still processes serially inside one invocation, no TOCTOU.
- The dedup guard in `rotateSingleSim` cannot prevent this race by design (it's a DB read, not a DB lock). Any future "speed it up" proposal that reintroduces parallelism must use a DB-level lock / RPC / UPDATE-RETURNING to atomically claim the SIM, not a read-then-check pattern.

---

## 2026-04-21 — Rotation fail count incremented via Supabase RPC, not in JS

**Decision:** `updateSimRotationError` (mdn-rotator) no longer reads `rotation_fail_count`, increments it in JS, and writes it back. Instead it calls an RPC: `increment_rotation_fail(p_sim_id, p_error, p_today_start)` which runs `UPDATE sims SET rotation_fail_count = rotation_fail_count + 1 WHERE id = $1 RETURNING rotation_fail_count` atomically in the DB.

**Why:** Concurrent queue messages were all racing to increment the same column. The JS approach: (1) SELECT rotation_fail_count, (2) add 1 in JS, (3) UPDATE — lets every concurrent message read the same stale value and write the same incremented value. With 5 failing SIMs each firing multiple concurrent queue messages, all of them read `count=1` and wrote `count=2`, so the column was stuck at 2 and `status='rotation_failed'` was never set, even after 30+ failures across multiple days. The RPC does the increment server-side in a single statement, so no read-modify-write window.

**Consequence:**
- Any future "increment a counter on concurrent access" pattern must use an RPC or raw SQL (`UPDATE ... SET col = col + 1`), not a JS read-modify-write cycle.
- The `increment_rotation_fail` RPC also resets the count to 1 on the first failure after midnight NY (`last_rotation_at < p_today_start`), so per-day retry limits work correctly across days.
- The function is `SECURITY DEFINER` — it runs as the DB owner, bypassing RLS. Intentional: mdn-rotator queue handler uses service role anyway.

---

## 2026-04-21 — ATOMIC fix-sim uses a new IMEI every time, not the existing one

**Decision:** `fixAtomicSim` always retires all existing IMEI pool entries for the SIM and allocates a fresh one before running subsriberInquiry + restore. It does not try to reuse the current `sims.imei`.

**Why:** The suspended ATOMIC SIMs (DSABR2 SOC) were likely suspended due to IMEI-related network issues (DLC suspension cycle, same as the Helix pattern). Reusing the same IMEI that caused suspension would likely lead to re-suspension after restore. A fresh IMEI breaks the cycle — same reasoning as the Helix fix-sim path that was already established.

**Consequence:**
- `fixAtomicSim` always burns an IMEI pool entry. Call it only when genuinely needed (suspended, or after 3 rotation failures), not as a routine maintenance step.
- If the IMEI pool is exhausted, `fixAtomicSim` will throw at allocation step. The error is surfaced in the queue handler as a failed job.

---

## 2026-04-20 — Wing IoT API is case-sensitive; uses UPPERCASE status values

**Decision:** Always send `"status": "ACTIVATED"` (uppercase) in Wing IoT PUT activations, not `"Activated"` (title case). Always include `Accept: application/json` header.

**Why:** Empirically verified. 100% of historical code-path Wing IoT PUTs used `"Activated"` and failed with HTTP 500 + `{"errorCode":"30000001","errorMessage":"Unknown server error"}`. The dashboard API tester succeeded with `"ACTIVATED"` (202 response with `{iccid:"..."}` body). Wing's own GET response returns all statuses in uppercase (`"INVENTORY"`, `"ACTIVATED"`, etc.) — that's their canonical form. The `wing-iot` skill documentation in `.claude/skills/wing-iot/SKILL.md` shows title case `"Activated"` — **the skill doc is wrong**, the API is case-sensitive.

**Consequence:**
- Any future Wing IoT code (activation, status changes, MDN rotation) must use uppercase status strings: `"ACTIVATED"`, `"DEACTIVATED"`, `"INVENTORY"`.
- Do NOT trust the wing-iot skill docs on status casing — verify against actual Wing API responses.
- Consider updating the `wing-iot` skill to correct the casing (future cleanup).
- Reading Wing responses: keep case-insensitive comparisons (e.g. `.toLowerCase()` as in `handleWingCheck`) for defense in depth.
- Always include `Accept: application/json` on PUT requests to Wing IoT — the successful API tester call did, and the old code didn't.

---

## 2026-04-15 — Helix quarantined via HELIX_ENABLED flag (not deleted)

**Decision:** Quarantine all Helix code behind an `env.HELIX_ENABLED === 'true'` feature flag across 7 workers, rather than deleting the code.

**Why:** User confirmed Helix may return in the future. A flag is a single-bit toggle to re-enable vs rebuilding from scratch. The 625 canceled Helix SIMs and their historical `carrier_api_logs` entries remain visible in the dashboard for audit purposes (the vendor filter shows "Helix (disabled)" and historical logs are still viewable via the per-SIM API Logs modal).

**Consequence:**
- Do NOT delete `src/shared/helix.ts`, HX_* secrets, TOKEN_CACHE KV, or `helix_api_logs` backward-compat view.
- Do NOT add new Helix UI or call `helix.ts` functions without first flipping `HELIX_ENABLED=true` and notifying the user.
- To re-enable: `printf "true" | wrangler secret put HELIX_ENABLED` on all 7 workers, then redeploy.
- When inserting new SIMs, `vendor` MUST be one of: `atomic`, `wing_iot`, `teltik`. Never default to `helix`.

---

## 2026-04-15 — Surgical fixes over providers.ts abstraction

**Decision:** Fix the ATOMIC cron bug and provider-leak bugs via surgical per-worker patches. Do NOT build a shared `src/shared/providers.ts` abstraction layer that wraps all vendor APIs behind a unified interface.

**Why:** Blast-radius minimization on a single-developer production system. The ~15 vendor-switch sites across 7 workers each handle different vendor-specific semantics (different error handling, different response shapes, different retry logic). A shared abstraction would need to unify all of these, creating a large-surface refactor with high regression risk. The surgical approach: 2 patches to mdn-rotator's cron/queue handler, 5 flag guards to other workers, 4 dashboard bug fixes. Total: +172/-61 lines across 7 files. Low blast radius, fully tested.

**Consequence:**
- Each worker continues to do its own `if (vendor === ...)` switch. This is deliberate, not accidental.
- If a future vendor is added, it needs branches in each relevant worker — not a single central registration.
- If the switch-site count grows past ~20, reconsider the abstraction.

---

## 2026-04-15 — mdn-rotator stays on index.js (not index.ts)

**Decision:** Port the vendor branching from `index.ts` INTO the production `index.js`, rather than switching the wrangler entry point to `index.ts`.

**Why:** `index.ts` (485 lines) is an incomplete stub — it has placeholder Slack summaries (`"Not implemented"`), `secret = "TODO"`, missing endpoints (`/imei-gateway-sync`, `/trigger-blimei-sweep`, etc.), and no fix-sim queue handler. The production `index.js` (3217 lines) has all of these. Switching entry would have broken 80%+ of the worker's functionality.

**Consequence:**
- `index.ts` is dead code. Do not try to switch the entry point to it.
- Future changes to mdn-rotator go in `index.js`.
- The test env (`[env.test]`) still points `main = "index.ts"` — this was temporarily flipped to `index.js` for canary testing and reverted.

---

## 2026-04-15 — Dashboard edits MUST go through the `patch-dashboard` skill

**Decision:** Every change to `src/dashboard/index.js` — without exception and regardless of size — must be performed by invoking the `patch-dashboard` skill (`Skill` tool, `skill: "patch-dashboard"`) before writing any patch script. Freehand patch scripts are prohibited even when they appear to follow the pattern. This rule is now hardcoded in `agent/BOOTSTRAP.md` Rule 1, `agent/constraints.md §1`, and the user's auto-memory.

**Why:** On 2026-04-15 a freehand `_add_gateway_export.js` patch shipped invalid JS to prod: the CSV-escape helper contained `/[",\n\r]/` which became a multi-line regex literal after the template literal evaluated `\n` and `\r` as escape sequences. The outer-Worker syntax check (Check 1) read the frontend JS as a string and passed. Only Check 2 (`_check_frontend_js.js`, which executes `getHTML()` via `vm` and syntax-checks the extracted browser JS) would have caught it — and I had skipped it because I didn't invoke the skill. The skill enforces both checks and the `--env=""` deploy.

**Consequence:**
- Do NOT handcraft a patch script and run the outer-module check only. Always open the skill first so the frontend-JS check runs.
- Do NOT deploy the dashboard with bare `npx wrangler deploy` — always `--env=""` (prod) or `--env test`.
- If a future session discovers this rule is overbearing (e.g. a docs-only change), the skill itself must be amended — not bypassed.
- `_check_frontend_js.js` is load-bearing. Do not delete.

---

## 2026-04-14 — ATOMIC + Wing IoT migration architecture

**Decision:** Multi-vendor routing based on `sims.vendor` column. Each worker checks vendor and routes to appropriate API:
- `helix`: Legacy Helix API (deprecated, kept for existing SIMs)
- `atomic`: New AT&T ATOMIC API (uses MSISDN as identifier, credentials in body)
- `wing_iot`: AT&T IoT API (uses ICCID, Basic Auth, MDN rotation via plan swap)
- `teltik`: T-Mobile API (separate integration, unchanged)

**Why:** Helix API is being deprecated. ATOMIC and Wing IoT are replacement AT&T providers with different API patterns. ATOMIC is full-featured (suspend/restore/cancel/OTA). Wing IoT is simpler (no suspend/restore/OTA/cancel API — only activation and plan changes). Cannot mass-migrate existing Helix SIMs — they stay on Helix until ops fail.

**Consequence:**
- `carrier_api_logs` (renamed from `helix_api_logs`) now has `vendor` column — all log queries should filter by vendor when needed
- ATOMIC uses `sims.msisdn` as identifier; Helix uses `mobility_subscription_id` — both columns may be populated
- details-finalizer only processes `vendor='helix'` SIMs (ATOMIC/Wing IoT get MDN at activation)
- Wing IoT SIMs cannot be suspended/restored/cancelled via API — only DB status update
- Do NOT remove Helix code paths — existing Helix SIMs will continue using them until individually migrated

---

## 2026-03-25 — Teltik 48h rotation guard stamped before polling completes

**Decision:** In `rotateTeltikSims`, `sims.last_mdn_rotated_at` is written to DB immediately after the `change-number` API call succeeds (before the polling loop), not after polling confirms the new MDN.

**Why:** Contractual obligation — Teltik SIMs may not be rotated more than once per 48 hours. The first real rotation showed Teltik changed the number successfully but our polling loop timed out (unrecognized status strings), so `last_mdn_rotated_at` stayed null. The next cron would have re-rotated within minutes of the first rotation.

**Consequence:** If `change-number` is called but rotation ultimately fails (Teltik error), the 48h clock is already ticking — the SIM won't retry until the next interval. This is intentional: a failed rotation is safer than a double-rotation. Do not move the stamp back to after polling.

---

## 2026-03-25 — Teltik webhook push format differs from polling API format

**Decision:** `handleTeltikSmsWebhook` reads `body.destination || body.to || body.mdn` for the recipient MDN and `body.origin || body.from` for the sender. It also handles array payloads (Teltik may batch-push).

**Why:** Teltik's `/v1/forward-url` push format is `{ destination, origin, message, timestamp, port, gateway_id, nickname }`. The `/v1/all-sms` polling format is `{ to, from, message, time_stamp }`. These are different. The original handler only read `to`/`from`/`time_stamp`, so all real pushes silently returned 200 OK without inserting anything. Confirmed by capturing a live push in `wrangler tail`.

**Consequence:** Keep both field-name fallbacks in the handler — the polling format appears in backfill scenarios. Do not simplify to just `destination`.

---

## 2026-03-24 — Frontend JS check must execute getHTML() via vm, not regex substitution

**Decision:** `_check_frontend_js.js` uses Node `vm.runInContext` to actually execute the `getHTML()` function and extract the resulting HTML string, rather than regex-replacing `\`` → `` ` `` and `\${` → `${` on the raw file text.

**Why:** The regex approach misses all other template literal escape evaluations: `\n` → newline, `\t` → tab, `\\` → `\`, etc. A file with `dbLines.join('\n')` (single backslash-n inside single-quoted string) passed the regex check because node's own `--check` sees `'\n'` as a valid newline escape — but the template literal evaluates `\n` to a literal newline char, so the browser actually receives an unclosed string literal → syntax error. This caused recurring "data not loading" bugs that appeared fixed but weren't.

**Consequence:** Always use `node _check_frontend_js.js` (the vm-based version at the repo root) as Step 4b. Never revert to the regex version. The check must faithfully reproduce what the browser receives.

---

## 2026-03-24 — All Helix API calls routed through static-IP VPS relay

**Decision:** A Node.js HTTP relay service runs on VPS 74.208.37.8 (`relay.zmawsolutions.com`, HTTPS/TLS). All 5 Helix API call sites in `src/shared/helix.ts` use `relayFetch(env, url, init)` instead of `fetch(url, init)`. When `env.RELAY_URL` + `env.RELAY_KEY` are set, requests are rewritten to `https://relay.zmawsolutions.com/<original-url>` with an `x-relay-key` header; the relay strips the key and forwards to AT&T. If either var is unset, falls back to direct fetch.

**Why:** Helix/AT&T API may require IP whitelisting. Cloudflare Workers egress from a large pool of shared IPs (no static IP). The VPS provides a single stable IP (74.208.37.8) that can be whitelisted with AT&T.

**Consequence:** Relay is a single point of failure for all Helix operations if VPS goes down. PM2 auto-restarts on crash; systemd auto-starts PM2 on reboot. Relay key stored in Cloudflare secrets per worker. VPS credentials: root@74.208.37.8, relay key in `/opt/relay/.env`. TLS cert auto-renews via certbot systemd timer (expires 2026-06-22). Do not remove the `relayFetch` fallback logic — it allows the relay to be bypassed by deleting the secrets if needed.

---

## 2026-03-23 — CSS custom property pattern for dashboard light/dark theme

**Decision:** Dashboard theme colors use `rgb(var(--dark-NNN) / <alpha-value>)` CSS variable pattern in the Tailwind config rather than hardcoded hex values. `:root` defines dark defaults (dark-950 = `5 5 7`, dark-100 = `244 244 245`). `html.light` overrides flip the scale (dark-950 = white, dark-100 = near-black). Toggle persisted in `localStorage`. `html.light .text-gray-*` overrides are required because Tailwind built-in `text-gray-200/300/400/500` classes (used 435 times in the dashboard) are hardcoded to near-white values and must be explicitly remapped.

**Why:** The dashboard uses ~170 `text-gray-300` and ~125 `text-gray-400` classes (from older pre-Gemini code) alongside the custom `dark-*` color tokens. Without the `text-gray-*` overrides, those classes are invisible on light backgrounds. The CSS var pattern allows opacity utilities (`bg-dark-800/50`) to continue working.

**Consequence:** Any future dashboard text elements must use `text-dark-*` classes (not `text-gray-*`) so they automatically adapt to both themes. If `text-gray-*` classes are added, a corresponding `html.light .text-gray-*` override must be added to the `<style>` block. Do not remove the `html.light` overrides or replace the CSS var values in Tailwind config with hex.

---

## 2026-03-18 — Gateway identity encoded in push URL path for MAC-less gateways

**Decision:** For gateways that cannot be configured to include `mac` or `iccid` in their SMS push params (specifically 512-2, gateway id=4), the gateway ID is encoded in the push URL path as `/s/<secret>/gw/<id>`. sms-ingest extracts it from `pathParts[3]` when `pathParts[2] === "gw"`. SIM lookup falls back to `gateway_id + port` DB query when ICCID is absent. A background slot sync fires when the port lookup misses.

**Why:** 512-2 only sends `?port=...&sender=...`. Without MAC the gateway can't be identified; without ICCID the SIM can't be found. URL path encoding is the only device-configuration knob available without firmware changes.

**Consequence:** `/sync-gateway-slots` in mdn-rotator must be run once after any physical SIM reshuffle in 512-2 (or when a new SIM is inserted) to keep the `sims.port` mapping current. The dashboard "Sync Slots" button does this. The first SMS from an unmapped slot triggers an automatic background sync so the second SMS routes correctly. Do not remove the `gatewayIdFromPath` extraction or the port-based fallback.

---

## 2026-03-16 — OTA BLIMEI is the source of truth for sims.imei

**Decision:** AT&T's live OTA BLIMEI (from `hxOtaRefresh` `serviceCharacteristic[name=BLIMEI].value`) is the authoritative value for `sims.imei`. The gateway slot IMEI must match it. `hxChangeImei` is only used when a line is suspended. When Helix returns "already assigned" (`_alreadyAssigned: true`), the Helix cache is stale vs AT&T live state — `fixSim` retires the pool entry, allocates a fresh IMEI, and retries to force a real AT&T update.

**Why:** Three-way IMEI mismatch discovered (SIM 525): `sims.imei` (Helix stale cache), OTA BLIMEI (AT&T live), gateway NWIMEI (physical slot) — all different. Helix's `change_imei` "not needed" response means its internal cache matches, not that AT&T agrees. Only OTA refresh queries AT&T directly and returns the live billing IMEI.

**Consequence:** `fixSim` OTA step now patches `sims.imei = otaBlimei` after OTA refresh. `/imei-gateway-sync` updates `sims.imei` from OTA BLIMEI **before** attempting the gateway set, so heartbeat retries use the correct value even when gateway is temporarily down. Do not revert the pre-gateway DB update order.

---

## 2026-03-16 — blimei_update queue job for system-wide sweep

**Decision:** System-wide BLIMEI sweep uses a `blimei_update` queue job type (one message per SIM) rather than batch HTTP calls to `/imei-gateway-sync`. Triggered via `/trigger-blimei-sweep` POST endpoint.

**Why:** Batch approach failed — Cloudflare Worker 30s CPU limit was exceeded when processing 10–15 OTA calls sequentially in a single request. Some SIMs' OTA calls hang (Helix timeout), causing the entire batch to hang with no timeout. Queue approach processes one SIM at a time with independent timeouts and retries.

**Consequence:** To re-run the sweep in future, POST to `https://dashboard.zalmen-531.workers.dev/api/trigger-blimei-sweep` (Basic auth). The `/imei-gateway-sync` endpoint still exists for targeted single-batch operations (≤20 SIMs) but should not be used for full-fleet sweeps.

---

## 2026-03-15 — IMEI heartbeat graduation: 3 consecutive successes skip re-sync

**Decision:** SIMs that successfully pass `callSkylineSetImei` 3 consecutive times are "graduated" and excluded from the heartbeat re-sync queue. The DB trigger `trg_reset_imei_sync_on_suspend` resets `gateway_imei_sync_count = 0` and `gateway_imei_synced_at = NULL` whenever `sims.status` changes to `suspended` or `canceled`.

**Why:** Without graduation, all ~500 active SIMs would be re-queued every few hours indefinitely, creating unnecessary queue load. SIMs only need active monitoring until the gateway has consistently held their IMEI. Graduation stops the churn. Suspension resets confidence since the SIM is in a bad state again.

**Consequence:** New `gateway_imei_sync_count INT NOT NULL DEFAULT 0` and `gateway_imei_synced_at TIMESTAMPTZ` columns on `sims`. DB trigger auto-resets on status change — do not bypass by updating status via raw SQL without acknowledging this. The heartbeat uses `gateway_imei_sync_count=lt.3` PostgREST filter to skip graduated SIMs.

---

## 2026-03-15 — Rotation guard rail: re-sync gateway IMEI on every daily rotation

**Decision:** Every `rotateSingleSim` call now fires `callSkylineSetImei` (fire-and-forget) at the end, re-confirming the IMEI on the physical gateway even if no IMEI change was needed.

**Why:** Root cause of DLC suspensions: gateway loses IMEI after reboot, AT&T nightly check finds BLIMEI ≠ NWIMEI and suspends. The rotation fires daily for every SIM, making it the ideal backstop to re-anchor the gateway IMEI each day. The heartbeat handles intra-day reboots.

**Consequence:** The guard rail is fire-and-forget — it never fails the rotation. The `callSkylineSetImei` has its own 3× retry for transient 502s. Do not make this blocking.

---

## 2026-03-15 — IMEI sync sweep uses OTA refresh to get BLIMEI; subscriber details as fallback for null att_ban

**Decision:** The `/imei-gateway-sync` endpoint uses two paths: (1) for SIMs with known unique BLIMEI from cached OTA data, set gateway directly; (2) for SIMs with duplicate/stale BLIMEI, run fresh OTA refresh. For SIMs with `att_ban=null`, falls back to `hxSubscriberDetails` which returns `billingImei` directly, backfilling `att_ban` in the DB as a side effect.

**Why:** OTA refresh requires att_ban + phone number, which some older SIMs were missing. Subscriber details doesn't need att_ban and returns the BLIMEI (`billingImei` field). This avoids skipping those SIMs entirely.

**Consequence:** When att_ban is null and mobility_subscription_id is set, subscriber details is called during sweep. This is the correct fallback. Do not short-circuit this path.

---

## 2026-03-13 — `op=save` after IMEI set on gateway

**Decision:** `handleSetImei` in skyline-gateway now calls `op=save` immediately after a successful `op=set`.

**Why:** IMEI changes are stored in RAM only. After a device reboot, all changes revert and AT&T suspends the line. This was causing repeated suspensions.

**Consequence:** Do not remove the save call. The gateway UI "System Settings → Save and Reboot → Save" was the only previous fix — this automates it.

---

## 2026-03-11 — All `sim_numbers` rows backfilled to `verified`; reseller-sync no longer filters by verification_status

**Decision:** All existing `pending` sim_numbers rows set to `verified`. reseller-sync query removed `verification_status` filter.

**Why:** Verification was removed 2026-02-25 but the reseller-sync query still filtered on it, causing some SIMs to be silently skipped.

**Consequence:** `verification_status` column still exists but is always `verified`. Do not add logic that branches on its value.

---

## 2026-03-01 — RLS enabled on all public tables

**Decision:** Applied RLS to all Supabase public tables.

**Why:** Security hardening.

**Consequence:** Workers use `service_role` key, which bypasses RLS automatically — no code changes needed. If a new worker ever uses the anon key, it will hit RLS denials.

---

## 2026-02-25 — SMS verification removed

**Decision:** Removed SMS-based phone number verification. All `number.online` senders hardcode `verified: true`.

**Why:** Verification was causing false negatives and was not providing real value.

**Consequence:** Do not add back verification gates. Any `sim_numbers` insert should set `verification_status = 'verified'` directly.

---

## 2026-02-19 — QBO tables added; quickbooks worker deployed

**Decision:** Added `qbo_customer_map` and `qbo_invoices` tables. Deployed `quickbooks` worker.

**Why:** Automated billing against resellers via QuickBooks Online.

**Consequence:** Worker is deployed. OAuth flow requires QBO credentials (QBO_CLIENT_ID, QBO_CLIENT_SECRET) to be set as secrets. Redirect URI: `https://dashboard.zalmen-531.workers.dev/api/qbo/callback`.

---

## ~2026-02 — Queue-based fix-sim, not direct service binding call

**Decision:** `fix-sim` operations go through `fix-sim-queue` (max_batch_size=1) rather than being called directly via service binding.

**Why:** The fix-sim flow (allocate IMEI → set gateway → subscriber_details → OTA → Cancel → Resume → hxChangeImei → DB update) takes much longer than the 30-second service-binding timeout. Putting it in a queue gives it up to the queue's execution timeout and allows retries.

**Consequence:** Fix-sim returns immediately; results appear in Helix API Logs. Do not try to make this synchronous.

---

## ~2026-02 — Supabase bridge via Edge Function for gateway communication

**Decision:** The skyline-gateway worker does not call the physical gateway directly. It POSTs to a Supabase Edge Function that relays the request.

**Why:** Cloudflare Workers cannot reach Cloudflare-proxied IPs (error 1003 on direct IP, error 521 on proxied domain). This is an internal routing loop in Cloudflare's infrastructure with no workaround on the CF side.

**Consequence:** Supabase Edge Function must remain deployed. Auth is via `x-bridge-secret` header. If the bridge goes down, all gateway operations fail with 502. Required secrets: `SKYLINE_SECRET` (skyline-gateway worker auth) and `SKYLINE_BRIDGE_SECRET` (bridge auth).

---

## ~2026-01 — Date-based dedup for `number.online` webhooks

**Decision:** Dedup key for `number.online` is `(simId, iccid, number, YYYY-MM-DD UTC)`. Only `delivered` records block re-sends; `failed` records do not.

**Why:** Prevents triple-sending on the same day (mdn-rotator + dashboard + reseller-sync all send to the same reseller). `failed` records are not blocking so a transient failure doesn't permanently suppress delivery.

**Consequence:** If a SIM has a delivered record for today, reseller-sync will skip it. Use `force=true` param on `/run` to bypass dedup. The dashboard "Skip dedup" checkbox does this.

---

## 2026-03-14 — MDN rotation cron runs all day

**Decision:** Cron changed from `"0,20,40 4-15 * * *"` + `"0 16 * * *"` to `"0,20,40 * * * *"` (every 20 min, all 24 hours). Hour gate removed from `scheduled()` handler.

**Why:** Some SIMs get Helix 5xx errors and are skipped each run. With a limited window (4–16 UTC) there was no guarantee all SIMs would get rotated by noon. Running all day means every skipped SIM gets another attempt 20 minutes later until it succeeds.

**Consequence:** `queueSimsForRotation` already filters by `last_mdn_rotated_at >= NY midnight`, so runs after all SIMs are done are fast no-ops. Safe to run 24/7. The `getNYMidnightISO()` dedup guard handles the DST boundary correctly at runtime — the cron itself no longer needs to be DST-aware.

---

## ~2025-12 — No Supabase CLI auth

**Decision:** All DB operations from workers use the PostgREST API with service_role key, not the Supabase CLI. Migrations are applied via MCP tool.

**Why:** No CLI login token configured in the project. MCP tool works without it.

**Consequence:** `supabase db push` and similar CLI commands will fail. Use `mcp__supabase__apply_migration` instead.

---

## ~2025-12 — `sms-ingest` updates `sims.gateway_id/port` before triggering IMEI change

**Decision:** When the sms-ingest worker receives an AT&T "upgrade your device" message, it calls `updateSimPortAndGateway` BEFORE triggering the auto-IMEI-change in mdn-rotator. Port conflict resolution evicts any other SIM claiming the same `(gateway_id, port)` first.

**Why:** The IMEI change flow needs accurate port location to set the IMEI on the right gateway slot. Port conflict resolution prevents two SIMs claiming the same physical slot.

**Consequence:** Do not reorder these steps. The conflict eviction must happen before the IMEI set.
