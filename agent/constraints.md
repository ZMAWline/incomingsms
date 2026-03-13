# Constraints & Hard Rules

These are non-negotiable. Violating them causes silent bugs, broken deploys, or data loss.

---

## 1. Dashboard File — CRLF & Template Literal Escaping

`src/dashboard/index.js` is a **CRLF file** containing a single giant `getHTML()` function whose return value is a template literal. All HTML and frontend JavaScript live inside this one template literal.

**Consequences:**
- The Edit tool fails silently or corrupts the file because it expects LF.
- You cannot write inline template literals in the frontend JS — they must use `\`` and `\${...}`.
- Any unescaped `` ` `` or `${` inside `getHTML()` closes or breaks the outer template literal.

**Rules:**
- Never use the Edit tool directly on `src/dashboard/index.js`. Always use a Node.js patch script.
- Patch script pattern: read file → normalize to LF → find/replace → convert back to CRLF → write.
- For whole-function rewrites: use `indexOf(startMarker)` + `indexOf(endMarker)` + slice/concat.
- Use string concatenation (`+`) when building replacement strings that contain backticks or `${`.
- After every patch, syntax-check: `node --input-type=module --check < src/dashboard/index.js`
- Run `_check_dash_script.js` to verify template literal integrity.
- Dynamic buttons in row HTML: every template literal in row HTML MUST be inside `\${...}`. A bare `` \`...\` `` not inside `\${...}` closes the outer template.

**Creating patch scripts:**
- Use the `Write` tool to create `.js` files. Never pass patch scripts via bash heredoc — bash heredoc strips `\` before `` ` ``.
- Run with `node _fix.js` (use `require()`, not ESM import in patch scripts).

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

## 11. Helix OTA Errors Come in Two Forms

Always check both locations:
1. `response.errorMessage` at root (HTTP 400) → `helix_timeout` status
2. `response.rejected[].message` (HTTP 200) → `data_mismatch` status

Checking only one will silently miss failures.
