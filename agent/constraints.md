# Constraints & Hard Rules

These are non-negotiable. Violating them causes silent bugs, broken deploys, or data loss.

---

## 1. Dashboard File — ALL Edits Go Through the `patch-dashboard` Skill

**ABSOLUTE RULE: every edit to `src/dashboard/index.js` — without exception — must be performed via the `patch-dashboard` skill.** Invoke it at the start of any dashboard task using the `Skill` tool (`skill: "patch-dashboard"`). This applies to:
- New features, buttons, tabs, columns, API routes
- Bug fixes of any size, including one-character typos
- Renames, label changes, style tweaks
- Reverts and rollbacks

**You may NOT:**
- Use the Edit tool on `src/dashboard/index.js`.
- Write a patch script freehand without reading the skill's SKILL.md first.
- Skip either of the two required syntax checks (outer Worker + frontend JS).
- Deploy with bare `npx wrangler deploy` — always `--env=""` (prod) or `--env test`.

`src/dashboard/index.js` is a **CRLF file** containing a single giant `getHTML()` function whose return value is a template literal. All HTML and frontend JavaScript live inside this one template literal.

**Consequences:**
- The Edit tool fails silently or corrupts the file because it expects LF.
- You cannot write inline template literals in the frontend JS — they must use `\`` and `\${...}`.
- Any unescaped `` ` `` or `${` inside `getHTML()` closes or breaks the outer template literal.
- `\n`, `\r`, `\t` inside the source get evaluated by the template literal at runtime — to produce those characters as escape sequences in the browser JS (e.g. inside a regex character class), the source must contain `\\n`, `\\r`, `\\t`. Skipping the frontend JS check hides this class of bug (incident: 2026-04-15 gateway-export regex broke prod because only the outer Worker check was run).

**Workflow (enforced by the skill, summarized here):**
- Read the relevant section of `src/dashboard/index.js` first. Never guess.
- Use the `Write` tool to create `_fix_<feature>.js` at the repo root. Never pass patch scripts via bash heredoc — bash strips `\` before `` ` ``.
- Patch scripts use `require()`, not ESM import. Pattern: read file → normalize to LF → find/replace → CRLF → write.
- Use string concatenation (`+`) when building replacement strings containing backticks or `${`.
- For whole-function rewrites: use `indexOf(startMarker)` + `indexOf(endMarker)` + slice/concat.
- Dynamic buttons in row HTML must be wrapped in `\${...}`. A bare `` \`...\` `` not inside `\${...}` closes the outer template.
- After every patch, run BOTH syntax checks:
  ```bash
  node --input-type=module --check < src/dashboard/index.js   # outer Worker module
  node _check_frontend_js.js                                    # frontend JS (executes getHTML via vm)
  ```
  Both must pass before deploy. Check 1 alone is insufficient — it treats the frontend JS as a string and misses escaping bugs.
- Deploy with explicit env: `cd src/dashboard && npx wrangler deploy --env=""` (prod) or `--env test`.

---

## 2. Single Responsibility — Never Mix Worker Concerns

Each worker does one job. Do not add unrelated logic to an existing worker because it "shares code" or has access to the same bindings.

If a new operation doesn't clearly fit an existing worker's stated purpose, create a new worker in `src/<new-worker>/`.

Signs you are about to violate this:
- "I'll just add this to mdn-rotator since it already calls Helix"
- "I'll branch on a `type` field in the queue consumer"
- "I'll add a second cron to this worker for a different job"

---

## 3. `op=save` After Every IMEI Write

After calling `op=set` on the SkyLine gateway to change an IMEI, always follow with `op=save`.

The gateway stores IMEI changes in RAM only. Without `op=save`, a device reboot reverts all IMEI changes and the line will be re-suspended by AT&T.

`handleSetImei` in `src/skyline-gateway/index.js` already does this. Do not remove or skip it.

---

## 4. Secrets — Never Use `echo`, Always Use `printf`

```bash
# WRONG — appends newline, corrupts the secret
echo "my-secret" | wrangler secret put MY_SECRET

# CORRECT
printf "my-secret" | wrangler secret put MY_SECRET
```

This is especially critical for URL-valued secrets (SUPABASE_URL, webhook URLs) where a trailing newline causes silent HTTP failures.

---

## 5. PostgREST Quirks — Known Traps

- **Default row limit is 1000.** For large tables, always append `&limit=5000` (or appropriate value).
- **FK disambiguation:** When a table has multiple FK relationships to another table, use explicit syntax: `sims!imei_pool_sim_id_fkey(...)`.
- **Upsert requires:** `?on_conflict=<column>` in URL + `Prefer: resolution=merge-duplicates` header.
- **Nested filter limit (PGRST108):** Cannot filter on a column 3+ levels deep via top-level query param. Fix: add the column to `select` and filter client-side.
- **RLS is enabled** on all public tables. Workers use service_role key and bypass RLS automatically. If a query returns empty unexpectedly, check if you're accidentally using the anon key.

---

## 6. DB Migrations — Always Via MCP Tool

Never alter schema by running SQL directly in the Supabase dashboard console for persistent changes.

Process:
1. Create a migration file: `supabase/migrations/<YYYYMMDD>_<description>.sql`
2. Apply via `mcp__supabase__apply_migration`
3. The migration is recorded and reproducible

**Exception:** One-off data backfills can be run via `mcp__supabase__execute_sql` without a migration file, but note it in `agent/current-state.md`.

---

## 7. IMEI Pool Status Values

`imei_pool.status` is constrained to exactly: `available`, `in_use`, `retired`, `blocked`.

- `retired` — permanently removed from a gateway slot. Never reuse.
- `available` — can be allocated. `allocateImeiFromPool` filters on this.
- Old IMEIs removed from a gateway slot must be marked `retired`, not deleted.

---

## 8. Port Format in DB

`imei_pool.port` and `sims.port` store dot-notation zero-padded format: `"13.03"` not `"13C"` or `"13.3"`.

`normalizePortSlot()` in `src/skyline-gateway/index.js` handles all input formats → `"13.03"`.
`normalizeImeiPoolPort()` in `src/dashboard/index.js` normalizes before DB queries.

When working with gateway API responses, always normalize before storing.

---

## 9. `verified: true` is Hardcoded — Do Not Add Verification Logic

SMS number verification was removed 2026-02-25. All three `number.online` senders (mdn-rotator, `/api/sim-online`, reseller-sync) hardcode `verified: true`. All new `sim_numbers` rows are inserted with `verification_status = 'verified'`. Do not add verification gates.

---

## 10. Things That Require User Confirmation Before Touching

- Any change to cron schedules (affects real-time operations)
- Any change to queue `max_retries` or `max_batch_size`
- Any force-push or reset on the `main` branch
- Any deletion or mutation of `imei_pool` records
- Removing or changing a service binding in a wrangler.toml
- Running `wrangler delete` on any worker
- Any change to the Helix token fetch logic or token cache TTL

---

## 11. All External API Calls Must Go Through `relayFetch`

Cloudflare Workers cannot reach Cloudflare-proxied origins directly (results in HTTP 522/521). The VPS relay at `relay.zmawsolutions.com` routes all outbound requests around this restriction.

**Rule: every `fetch()` call to an external API must use `relayFetch(env, url, init)` — no exceptions.**

**What needs relay:**
- Carrier APIs: ATOMIC (`solutionsatt-atomic.telgoo5.com`), Helix, Wing IoT (`restapi19.att.com`), Teltik (`api.smsgateway.xyz`)
- Reseller webhooks (external customer URLs)
- QuickBooks Online (`oauth.platform.intuit.com`, `quickbooks.api.intuit.com`)
- Any other third-party HTTP endpoint

**What does NOT need relay (exempt — direct fetch is correct):**
- Supabase (`env.SUPABASE_URL`) — Supabase is not CF-proxied
- Service bindings (`env.MDN_ROTATOR.fetch(...)`, `env.SKYLINE_GATEWAY.fetch(...)`) — internal CF routing
- KV/DO operations — not HTTP

**Standard `relayFetch` pattern (copy exactly into each JS worker):**
```js
function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}
```

For TypeScript workers, add typed version:
```ts
function relayFetch(env: Env, url: string, init?: RequestInit): Promise<Response> {
    if (env.RELAY_URL && env.RELAY_KEY) {
        return fetch(`${env.RELAY_URL}/${url}`, {
            ...init,
            headers: { ...(init?.headers as Record<string, string> || {}), 'x-relay-key': env.RELAY_KEY },
        });
    }
    return fetch(url, init);
}
```

**Before adding a new external API call, run the relay lint check:**
```bash
node _check_relay.js
```
This script flags any `await fetch(` calls to non-Supabase URLs that don't go through `relayFetch`.

---

## 12. Helix OTA Errors Come in Two Forms

Always check both locations:
1. `response.errorMessage` at root (HTTP 400) → `helix_timeout` status
2. `response.rejected[].message` (HTTP 200) → `data_mismatch` status

Checking only one will silently miss failures.
