# Session Bootstrap — IncomingSMS

> Read this file first. It takes 3 minutes and orients you completely.

## What This Project Is

A production SIM card management platform. Twelve Cloudflare Workers + Supabase handle: receiving SMS from physical gateways, activating SIM cards via the Helix AT&T API, rotating phone numbers (MDNs) daily, notifying resellers via webhooks, and billing via QuickBooks Online. The hardware is SkyLine multi-port GSM gateways.

Owner/operator: Zalmen. Single-developer project. No CI. Manual deploy per worker.

---

## Read Order for a New Session

1. **This file** — orientation + rules + maintenance protocol
2. **`agent/current-state.md`** — what's broken, what's in progress right now
3. **`agent/project-map.md`** — if you need to understand a specific worker or data flow
4. **`agent/constraints.md`** — before touching the dashboard or DB schema
5. **`agent/decision-log.md`** — before questioning why something was built a certain way

The `.claude/` memory files contain supplementary reference material (Helix endpoints, gateway bridge details, patching gotchas). They are loaded automatically.

---

## The 8 Rules You Cannot Break

**1. EVERY edit to `src/dashboard/index.js` MUST go through the `patch-dashboard` skill. No exceptions.**
Before touching the dashboard for any reason — new feature, bug fix, one-line tweak, adding a column, changing a label — invoke the skill first (`Skill` tool with `skill: "patch-dashboard"`). The skill enforces the CRLF-safe Node.js patch-script workflow, the two required syntax checks (outer Worker + frontend JS via `_check_frontend_js.js`), and the explicit-`--env` deploy rule. Do not write a patch script freehand, do not use the Edit tool, do not deploy without running both syntax checks. Violations have repeatedly broken prod (see the 2026-04-15 regex-in-char-class incident where a freehand patch produced invalid regex only the frontend check would have caught). The dashboard file uses CRLF line endings and embeds ALL frontend JS inside a template literal — every backtick and `${...}` must be escaped. Standard tools silently corrupt it.

**2. Always call `op=save` after setting an IMEI on the gateway.**
The gateway does not persist IMEI changes across reboots unless you explicitly flush to flash. The `handleSetImei` function in `src/skyline-gateway/index.js` already does this — do not remove it.

**3. Each worker does one job. Do not add unrelated logic to an existing worker.**
If a new capability doesn't clearly belong to an existing worker, create a new one. This is the primary architectural rule.

**4. Never use `echo` to pipe secrets to `wrangler secret put`.**
`echo` appends a trailing newline which corrupts the secret (especially URLs). Use `printf "value" | wrangler secret put NAME`.

**5. Apply DB schema changes via `mcp__supabase__apply_migration`, never by hand.**
Keep migration files in `supabase/migrations/` with a timestamp prefix. Test migrations on the branch DB first if in doubt.

**6. Shared code belongs in `src/shared/`. Do not copy-paste between workers.**
Wrangler/esbuild bundles shared modules automatically via relative imports.

**7. All external API calls must use `relayFetch(env, url, init)` — never bare `fetch(url)`.**
CF Workers cannot reach CF-proxied origins (causes HTTP 522). The relay at `relay.zmawsolutions.com` solves this. Every new carrier API call, webhook, or third-party HTTP call must go through `relayFetch`. Supabase calls and service bindings are exempt. Run `node _check_relay.js` before deploying to verify. See `agent/constraints.md §11` for the full pattern.

**8. Build in worktrees. Deploy production from an up-to-date `main` -- never from a feature branch.**
`wrangler deploy` REPLACES the whole worker with the current working copy. It is not a patch. So deploying from a checkout that is behind `main` silently reverts every commit that checkout never saw -- tests pass, nothing errors, a working feature just stops working. That is the 2026-06-12 `RENTAL_CAPTURE_ENABLED` revert (`agent/current-state.md`), and the `fix/atomic-portin-finalizer-record` branch that sat unmerged for weeks while the carrier backlog grew.
The sequence, every time: work in your own worktree -> `git fetch origin && git rebase origin/main` (this is the step that pulls the other agents' work in) -> re-run `npm test` **after** the rebase -> merge to `main` -> deploy from a `main` checkout. To see your own branch running without touching production, use `scripts/deploy.sh <worker> --env test`.
`scripts/deploy.sh` now enforces this: a production deploy from a non-`main` or behind-`main` checkout is refused outright. The override is `ALLOW_UNSAFE_DEPLOY=1` and it means "I accept that I may be reverting other work in production" -- never use it to get past a refusal you did not read.
**The DB is not worktree-isolated.** There is one Supabase instance and no copies of it. Additive migrations (new column, new index, new function) are safe to land while another agent is mid-task. Renames, drops, type changes and function-signature changes are not -- the other agent's running code still expects the old shape and breaks the moment the migration lands. Hold those until the parallel work has merged, then do them in one pass.

---

## Quick Reference

### Deploy a worker
```bash
cd src/<worker-name>
npx wrangler deploy
# Or for a specific env:
npx wrangler deploy --env test
```

### Add a secret to a worker
```bash
cd src/<worker-name>
printf "the-secret-value" | npx wrangler secret put SECRET_NAME
```

### Syntax-check the dashboard after any patch (TWO checks required — both non-negotiable)
```bash
node --input-type=module --check < src/dashboard/index.js   # outer Worker module
node _check_frontend_js.js                                   # frontend JS inside <script>
```
Check 1 alone is insufficient — escaping bugs in the frontend JS appear as strings to Node and pass Check 1 while breaking the browser. The `patch-dashboard` skill runs both automatically; do not skip either.

### Trigger a manual MDN rotation run
```
GET https://mdn-rotator.zalmen-531.workers.dev/run?secret=<ADMIN_RUN_SECRET>
```

### Trigger reseller sync manually
```
GET https://reseller-sync.zalmen-531.workers.dev/run?secret=<WORKER_SECRET>&force=true
```

### Worker URLs (production)
All workers: `https://<worker-name>.zalmen-531.workers.dev`

### Dashboard
URL: `https://dashboard.zalmen-531.workers.dev`
Auth: `admin / dashboard123`

---

## Cloudflare Account
- Account ID: `5313f8b98e20a8915418b2683ad7278c`
- Supabase project ref: `lzjqegxazqlktttyybth`

---

## Maintenance Protocol

**After any code change:**
- Deploy the affected worker(s)
- Syntax-check the dashboard if you touched it
- Commit with a descriptive message (one line summary + why)

**After a significant decision or architectural change:**
- Add an entry to `agent/decision-log.md`

**When starting work on a new feature or bug:**
- Check `agent/current-state.md` for related open items before designing a solution

**When finishing a session with work in progress:**
- Update `agent/current-state.md` with the current status, what was done, and what remains

**When something breaks in production:**
- Record it in `agent/current-state.md` under "Known Issues" immediately
- Root cause + fix go in `agent/decision-log.md` if it reveals a non-obvious constraint

**Monthly (roughly):**
- Prune resolved items from `current-state.md`
- Delete scratch scripts from root that are no longer needed
- Update `agent/project-map.md` if workers were added or removed

**Do not update `agent/` files for routine deployments or minor code tweaks.** These files track structure and state, not every change.
