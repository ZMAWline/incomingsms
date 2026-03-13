# Workflows — Repeatable Operations

---

## 1. Deploy a Worker

```bash
cd src/<worker-name>
npx wrangler deploy
```

For a test environment:
```bash
npx wrangler deploy --env test
```

**After deploying:** Verify the worker URL responds. For workers with service bindings, the binding is resolved by name — no action needed unless a bound worker was also renamed.

---

## 2. Add a New Worker

1. Create `src/<new-worker>/index.js` — export default with `fetch(request, env, ctx)`
2. Create `src/<new-worker>/wrangler.toml`:
```toml
name = "<new-worker>"
main = "index.js"
compatibility_date = "2024-01-01"
account_id = "5313f8b98e20a8915418b2683ad7278c"

[observability]
enabled = true

[env.test]
name = "<new-worker>-test"
```
3. If it needs secrets, add them: `printf "value" | npx wrangler secret put SECRET_NAME`
4. If the dashboard needs to call it, add a service binding to `src/dashboard/wrangler.toml` and deploy dashboard
5. Add the worker to `agent/project-map.md` worker registry
6. Deploy: `cd src/<new-worker> && npx wrangler deploy`

---

## 3. Patch the Dashboard (Safe Approach)

**Never edit `src/dashboard/index.js` directly with the Edit tool.** Always use a Node.js script.

### Template for a patch script:

```js
// _fix_<feature>.js — run with: node _fix_<feature>.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// --- YOUR CHANGE HERE ---
// Use string concatenation (NOT template literals) when building
// replacement strings that contain backticks or ${...}
const oldStr = `exact string to find`;
const newStr = `replacement string`;

if (!content.includes(oldStr)) {
  console.error('ERROR: old string not found — file may have changed');
  process.exit(1);
}
content = content.replace(oldStr, newStr);
// --- END CHANGE ---

// Convert back to CRLF before writing
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done.');
```

### After every patch:
```bash
node --input-type=module --check < src/dashboard/index.js
```

### For whole-function replacement:
Use positional patching:
```js
const start = content.indexOf('function myFunc(');
const end = content.indexOf('\nfunction ', start + 1); // find next function
content = content.slice(0, start) + newFunctionCode + content.slice(end);
```

### Creating the patch script:
Use the `Write` tool (not bash heredoc — heredoc strips backslashes before backticks).

---

## 4. Apply a Database Migration

1. Create the SQL file: `supabase/migrations/<YYYYMMDD>_<description>.sql`
2. Apply via MCP tool: `mcp__supabase__apply_migration` with the SQL content
3. Verify with `mcp__supabase__execute_sql` if needed

**For one-off data backfills** (not schema changes): use `mcp__supabase__execute_sql` directly. Note what you ran in `agent/current-state.md`.

---

## 5. Add a Secret to a Worker

```bash
cd src/<worker-name>
printf "the-secret-value" | npx wrangler secret put SECRET_NAME
```

To list existing secrets (without values):
```bash
npx wrangler secret list
```

---

## 6. Update Shared Code

1. Edit the file in `src/shared/`
2. All workers that import it will pick up the change on their next deploy — **you must redeploy every worker that uses it** if you want the change live immediately
3. For a frequently-used helper (e.g., `subscriber-sync.js`), consider which workers need the update and deploy them: mdn-rotator, details-finalizer, bulk-activator

---

## 7. Debug a Production Issue

### Check worker logs:
```bash
cd src/<worker-name>
npx wrangler tail
```

### Check Supabase logs:
Use `mcp__supabase__get_logs` with the relevant service.

### Check Helix API logs:
Query `helix_api_logs` table:
```sql
SELECT * FROM helix_api_logs
WHERE sim_id = <id>
ORDER BY created_at DESC
LIMIT 20;
```

### Check webhook delivery status:
```sql
SELECT * FROM webhook_deliveries
WHERE sim_id = <id>
ORDER BY created_at DESC
LIMIT 10;
```

### Force a reseller sync for a specific SIM:
Use the dashboard "Reseller Sync" button with "Skip dedup" checked, or:
```
GET https://reseller-sync.zalmen-531.workers.dev/run?secret=<SECRET>&force=true
```

### Re-trigger details finalization for a SIM:
Set `sims.status = 'provisioning'` via dashboard "Re-finalize" action or direct DB PATCH.

---

## 8. Rotate an MDN Manually

Via dashboard: SIM row → action dropdown → "Rotate MDN"

Via API:
```
POST https://mdn-rotator.zalmen-531.workers.dev/rotate-sim
Authorization: Basic admin:<ADMIN_RUN_SECRET>
Content-Type: application/json

{"sim_id": 123}
```

---

## 9. Fix a SIM (Full Fix Flow)

Via dashboard: SIM row → action → "Fix SIM"

This is async (runs via fix-sim-queue). Results appear in Helix API Logs in the dashboard.

Fix flow: allocate IMEI from pool → set on gateway → subscriber_details → OTA → Cancel → Resume (8s delay) → hxChangeImei → DB update.

---

## 10. Check Gateway Health

```
GET https://skyline-gateway.zalmen-531.workers.dev/health
```

For port status:
```
GET https://skyline-gateway.zalmen-531.workers.dev/port-info?gateway_id=1&port=13.03&secret=<SKYLINE_SECRET>
```
