---
name: patch-dashboard
description: Safe dashboard patching workflow for src/dashboard/index.js and src/dashboard/public/index.html. Use for ANY change to the dashboard — new columns, buttons, API routes, UI features, bug fixes. Enforces verify-before-replace and the two-environment deploy rule. Triggers on: "add X to dashboard", "update dashboard to show Y", "fix dashboard Z", "add a column/button/tab/route to dashboard".
---

# Dashboard Patch Skill

> **Layout changed — read this first (updated 2026-09-08).**
> `src/dashboard/index.js` is now **pure LF** (0 CRLF lines) and no longer contains
> `getHTML()`. The frontend was extracted to `src/dashboard/public/index.html` by
> `scripts/extract_dashboard_frontend.mjs`. Earlier versions of this skill told you
> to normalize CRLF→LF and convert back to CRLF on write; doing that today rewrites
> **all 9,664 lines** and produces an unreviewable diff. Do not convert line endings.
> Verify before trusting any claim here: `git show main:src/dashboard/index.js | file -`.

`src/dashboard/index.js` is the Worker backend: routes, API handlers, cron. The
browser code lives in `src/dashboard/public/index.html`. They are separate files and
neither needs template-literal escaping any more.

## Critical Rules (enforce without exception)

1. **Never convert line endings.** Read, replace, write. No `replace(/\r\n/g, '\n')`
   and no `replace(/\n/g, '\r\n')`. If your diff touches more than the lines you
   meant to change, you did this — revert with `git checkout -- <file>` and retry.
2. **Verify the old string exists, and exactly once, before replacing.** Count
   matches and bail on 0 or 2+. A silent no-op or a wrong-site replace is the main
   failure mode now that escaping is no longer a concern.
3. **Confirm the diff is the size you expect** — `git diff --stat` before committing.
4. **Syntax-check after patching:** `node --input-type=module --check < src/dashboard/index.js`.
5. **Never pass patch scripts via bash heredoc** — bash strips `\` before backticks,
   silently corrupting the script. Use the `Write` tool to create `.js` files.
6. **Patch scripts must use `require()`, not ESM `import`** (they run as CommonJS).
7. **Delete `_fix_*.js` helper scripts before committing.** Stray root-level
   `_fix_*.js` files have leaked into PRs before (see the closed #17).

**Editing with a script vs. the Edit tool:** a script is still preferred for
multi-site or generated changes because it verifies match counts and is re-runnable.
For a one- or two-line change with a unique anchor, the Edit tool is now safe — the
CRLF and template-literal hazards that originally banned it are gone.

## Your Workflow (follow every step)

### Step 1 — Understand the change
Read the relevant section of `src/dashboard/index.js` to find exact strings to replace. Never guess.

### Step 2 — Write the patch script
Use the `Write` tool to create `_fix_<feature>.js` at the repo root.

**Patch script template:**
```js
// _fix_<feature>.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// NO line-ending conversion. The file is pure LF; round-tripping through CRLF
// rewrites every line.

const OLD = `exact string from file`;
const NEW = `replacement string`;

// Require exactly one match: 0 means the file moved on, 2+ means you'd hit the
// wrong site too.
const hits = content.split(OLD).length - 1;
if (hits !== 1) {
  console.error('PATCH FAILED: expected 1 match, found ' + hits + '. File may have changed.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
```

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

### Step 4 — Verify

**Check 1: the diff is the size you intended.**
```bash
git diff --stat src/dashboard/index.js
git diff src/dashboard/index.js
```
If this reports thousands of changed lines for a small edit, your script converted
line endings. Revert (`git checkout -- src/dashboard/index.js`) and remove the
conversion.

**Check 2: Worker module syntax.**
```bash
node --input-type=module --check < src/dashboard/index.js
```

**Check 3: tests.**
```bash
npm test
```

> **Removed:** older versions of this skill required a second `_check_frontend_js.js`
> pass that executed `getHTML()` via `vm` to validate the embedded browser JS. There is
> no `getHTML()` any more — the frontend lives in `src/dashboard/public/index.html`, a
> plain HTML file you can edit directly. That checker now fails with "getHTML not found"
> and should not be recreated.

### Step 5 — Deploy

**STOP. Ask yourself before running any deploy command:**
- Does `agent/current-state.md` say the dashboard redesign or any other change is "test only, not in production"?
- Are there changes in `src/dashboard/index.js` that were committed or noted as test-only?
- If YES to either: you MUST use `--env test` or you will deploy test-only changes to prod.

**This project has two dashboard environments:**
| Command | Deploys to | URL |
|---|---|---|
| `cd src/dashboard && npx wrangler deploy --env=""` | **prod** (`dashboard`) | `dashboard.zalmen-531.workers.dev` |
| `cd src/dashboard && npx wrangler deploy --env test` | **test** (`dashboard-test`) | `dashboard-test.zalmen-531.workers.dev` |

**Rule:** Never run `npx wrangler deploy` without an explicit `--env` flag. Always use `--env=""` for prod or `--env test` for test. The bare `npx wrangler deploy` command (no flag) also hits prod but triggers a confusing multi-env warning — avoid it.

**When in doubt, ask the user which environment before deploying.**

### Step 6 — Confirm
After deploy, verify the feature works via the correct dashboard URL.

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
