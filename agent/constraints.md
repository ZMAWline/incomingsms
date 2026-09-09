# Constraints & Hard Rules

These are non-negotiable. Violating them causes silent bugs, broken deploys, or data loss.

---

## 1. Dashboard — Two Files, Normal Edits, Two Mandatory Syntax Checks

The dashboard is **two** files. Pick by what you are changing:

| Change | File |
|---|---|
| UI — markup, frontend JS, tables, filters, modals | `src/dashboard/public/index.html` |
| Server — API routes, Supabase queries, auth, the `select=` column lists feeding the UI | `src/dashboard/index.js` |

**Both are plain LF files. Edit them with the normal Edit tool.** No patch scripts, no CRLF conversion, no backtick or `${` escaping.

Adding a UI feature that surfaces a new DB column usually touches both: add the column to the `?select=` list and its passthrough in `index.js`, then render it in `public/index.html`.

**Still non-negotiable:**
- Run BOTH syntax checks after any dashboard edit:
  ```bash
  node --input-type=module --check < src/dashboard/index.js   # Worker module
  node _check_frontend_js.js                                   # inline <script> blocks in public/index.html
  ```
  Check 1 alone is insufficient. It validates only the Worker; a syntax error in `public/index.html` is invisible to it, so the Worker deploys fine and the browser gets broken JS — `loadData()` never runs and the page renders empty. That is the recurring "data not loading" bug.
- Deploy with an explicit env: `cd src/dashboard && npx wrangler deploy --env=""` (prod) or `--env test`. Never bare `npx wrangler deploy`.
- Read the section you are changing before editing it. Never guess.

**Invoke the `patch-dashboard` skill** at the start of a dashboard task — it routes you to the right file and restates these checks. Its SKILL.md is current; this section is the summary.

> **History — do NOT re-apply the old rules.** Until 2026-06-12 the whole SPA lived inside a `getHTML()` template literal in a CRLF `index.js`, which forced Node patch scripts and `\``/`\${` escaping. `scripts/extract_dashboard_frontend.mjs` moved it to `public/index.html`, served as a Workers static asset via `serveApp()`. **`getHTML()` no longer exists and neither file has a single CR byte** (verified 2026-09-09: `grep -c 'function getHTML'` = 0, `tr -cd '\r' | wc -c` = 0 for both). Writing `\`` into `public/index.html` today inserts a literal backslash and breaks the page. This section described the pre-06-12 world until 2026-09-09 and cost real time; if you find it stale again, fix it here rather than working around it.

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

> **Two migration directories exist and both are in active use** (observed 2026-09-09):
> `supabase/migrations/` (24 files, the one named above) and a top-level `migrations/`
> (22 files). Recent sessions have written to both — e.g. `20260909_address_pool_db_source_of_truth.sql`
> landed in the former while `20260908_dashboard_users_auth.sql` and
> `20260904_sims_gateway_host_default_teltik.sql` landed in the latter. **Prefer
> `supabase/migrations/`** per the process above. Nothing has been moved, because it is not
> established whether the split is meaningful (CLI-managed vs ad-hoc/MCP-applied) and other
> sessions reference both paths. Worth a deliberate decision and a consolidation.

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

**Before adding a new external API call, check it by hand:**
```bash
grep -rn "await fetch(" src/<worker>/ | grep -v "SUPABASE_URL" | grep -v relayFetch
```
Anything that survives that filter is a direct call to a third party and must go through `relayFetch`.

> `_check_relay.js` used to be referenced here as a lint script. **It does not exist in the repo** (verified 2026-09-09) — the instruction was unrunnable. Use the grep above, or write the script and restore the reference.

---

## 12. Helix OTA Errors Come in Two Forms

Always check both locations:
1. `response.errorMessage` at root (HTTP 400) → `helix_timeout` status
2. `response.rejected[].message` (HTTP 200) → `data_mismatch` status

Checking only one will silently miss failures.
