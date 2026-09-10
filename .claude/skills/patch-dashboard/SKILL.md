---
name: patch-dashboard
description: Safe dashboard change workflow. Use for ANY change to the dashboard — new columns, buttons, API routes, UI features, bug fixes. Routes you to the right file (frontend vs Worker), enforces the two syntax checks, and publishes via a per-version preview URL so parallel sessions cannot overwrite each other. Triggers on: "add X to dashboard", "update dashboard to show Y", "fix dashboard Z", "add a column/button/tab/route to dashboard".
---

# Dashboard Patch Skill

## Which file (read this first)

The dashboard is **two** files. Pick by what you are changing:

| Change | File | How to edit |
|---|---|---|
| UI — markup, frontend JS, tables, filters, modals | `src/dashboard/public/index.html` | **Edit tool, normally.** Plain LF file, no nested template literal. No escaping ceremony. |
| Server — API routes, Supabase queries, auth, the `select=` column lists that feed the UI | `src/dashboard/index.js` | Edit tool is fine. LF file, ~9.6k lines. |

Adding a UI feature that shows a new DB column usually touches **both**: add the column to the `sims?select=` list and its passthrough mapping in `index.js`, then render it in `public/index.html`.

> **History — do not re-apply the old rules.** Until 2026-06-12 the entire SPA lived inside a `getHTML()` template literal in `index.js`, which forced Node patch scripts and `\`` / `\${` escaping. `scripts/extract_dashboard_frontend.mjs` moved it to `public/index.html`, served as a Workers static asset (`serveApp` in `index.js`). `getHTML()` no longer exists and **neither file is CRLF**. Writing `\`` into `public/index.html` today inserts a literal backslash. If you find this skill still describing the old world below, fix the skill.

## Critical Rules

1. **Verify before you edit.** `grep -c "function getHTML" src/dashboard/index.js` should be `0` and `file src/dashboard/public/index.html` should not say CRLF. If either surprises you, stop and re-read the file before trusting this skill.
2. **Always syntax-check after editing — TWO checks required:** (a) outer Worker JS; (b) frontend JS. See Step 4.
3. **Publish with `wrangler versions upload --env test`, not `wrangler deploy`.** Several Claude
   sessions share this repo and one `dashboard-test` Worker; a plain deploy silently overwrites
   whatever another session shipped. Prod needs the user to say so in this session. See Step 5 —
   this is the rule most likely to cause real damage.
4. If you do need a scripted edit (large mechanical change across many call sites), use the `Write` tool to create `_fix_<feature>.js` at the repo root and `require()` in it — never a bash heredoc, which strips `\` before backticks.
5. **Verify what is running, not what wrangler printed.** An "Uploaded" line and a 401 both
   prove nothing. See Step 6.

## Your Workflow (follow every step)

### Step 1 — Understand the change
Read the relevant section of the file you identified above to find the exact strings to change. Never guess.

### Step 2 — Make the edit
Use the Edit tool. Only fall back to a `_fix_<feature>.js` patch script for large mechanical edits.

**Patch script template:**
```js
// _fix_<feature>.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Verify old string exists before replacing
const OLD = `exact string from file`;
const NEW = `replacement string`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
```

Point `filePath` at `src/dashboard/public/index.html` for UI changes. Both files are LF — do not add CRLF conversion, and do not escape backticks or `${`. Write the code exactly as it should appear in the file.

**For whole-function replacement**, use positional patching instead of string replace:
```js
const start = content.indexOf('async function myFunc(');
const end = content.indexOf('\nasync function ', start + 1);
if (start === -1 || end === -1) { console.error('markers not found'); process.exit(1); }
content = content.slice(0, start) + newFunctionCode + content.slice(end);
```

### Step 3 — Run the patch
```bash
node _fix_<feature>.js
```

### Step 4 — Syntax check (TWO checks — both required)

**Check 1: outer Worker module syntax**
```bash
node --input-type=module --check < src/dashboard/index.js
```

**Check 2: frontend JS inside `<script>` tags**
```bash
node _check_frontend_js.js
```
`_check_frontend_js.js` is committed at the repo root. It pulls every inline `<script>` block out of `public/index.html` and runs `node --check` over each one.

**Why two checks?** Check 1 only validates the Worker module, which no longer contains any frontend code. A syntax error in `public/index.html` is invisible to it — the Worker deploys fine and the browser gets broken JS, so `loadData()` never runs and the page renders empty. That is the recurring "data not loading" bug.

If either check fails, read the error line number, fix it, and re-check.

### Step 5 — Publish

**Default to `versions upload`. It cannot clobber anyone.**

```bash
cd src/dashboard && npx wrangler versions upload --env test
```

That uploads your build and prints a unique preview URL
(`https://<version-id>-dashboard-test.zalmen-531.workers.dev`) **without changing
what `dashboard-test` serves**. The version inherits every secret and binding, so
Supabase, sessions and break-glass all work. Give that URL to the user.

**Why this is the default.** `dashboard-test` is one shared Worker with no
locking: the last deploy wins, silently, whatever branch it came from. Several
Claude sessions run against this repo at once, each told to "deploy to test", and
they overwrite each other. On 2026-09-09 a deploy from `main` replaced three
commits of another session's work and served the wrong build for ~40 minutes; it
happened again at 16:08 the next day. A preview URL is per-version and immutable,
so parallel sessions cannot collide.

Cost: the preview is a different hostname, and the session cookie is host-only,
so the user signs in once per preview URL. Their account and role are unchanged —
same database.

**Promoting to live test** — only when the user asks for `dashboard-test` itself:

```bash
cd src/dashboard && npx wrangler versions deploy --env test
```

**Deploying to prod — never without the user explicitly saying so in this
session.** Before you even offer it:

- Does `agent/current-state.md` mark anything "test only, not in production"?
- Are there test-only changes sitting in `src/dashboard/index.js`?
- If YES to either, a prod deploy ships them too. Say so, and stop.

```bash
cd src/dashboard && npx wrangler deploy --env=""      # prod: dashboard.zalmen-531.workers.dev
```

**Never run `npx wrangler deploy` with no `--env`.** It hits prod and prints a
confusing multi-env warning. There is also a repo test asserting no command
combines `--env` with an explicit `--name`; do not work around it.

| Command | Effect |
|---|---|
| `versions upload --env test` | new preview URL, nothing else changes — **use this** |
| `versions deploy --env test` | promotes a version to `dashboard-test` |
| `deploy --env test` | overwrites `dashboard-test` immediately — avoid while other sessions are running |
| `deploy --env=""` | **prod**, only on explicit instruction |

### Step 6 — Confirm what is actually running

`wrangler` printing "Uploaded" proves the upload happened, not that your code is
being served — another session may have deployed over it seconds later. A 401
proves nothing either: the auth gate returns 401 for any `/api/*` path, including
routes that do not exist.

Verify by reading the deployed bundle back and grepping for a symbol you added:

```bash
set -a; . ~/.config/cloudflare/env; set +a
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/dashboard-test" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | grep -c myNewFunctionName
```

For frontend changes, re-run the publish command: "No updated asset files to
upload" means Cloudflare's copy hash-matches your local `public/index.html`.

Then open the preview URL and check the feature.

### Step 7 — Commit
```bash
git add src/dashboard/index.js
git commit -m "Dashboard: <what was added/changed>"
```

## SPA Routes Reference
`/sims`, `/messages`, `/workers`, `/gateway`, `/imei-pool`, `/errors`, `/billing`

## PostgREST Reminders (for new API routes)
- Default row limit 1000 → always add `&limit=5000` for SIM/message queries
- FK disambiguation: `sims!imei_pool_sim_id_fkey(...)`
- Upsert: `?on_conflict=<col>` + `Prefer: resolution=merge-duplicates`
- Nested filter (3+ levels deep): add column to `select`, filter client-side (PGRST108)
- RLS: service_role key bypasses automatically — no extra headers needed
