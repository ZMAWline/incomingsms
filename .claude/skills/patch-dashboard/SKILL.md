---
name: patch-dashboard
description: Safe dashboard patching workflow for src/dashboard/index.js. Use for ANY change to the dashboard — new columns, buttons, API routes, UI features, bug fixes. Enforces CRLF/escaping rules automatically. Triggers on: "add X to dashboard", "update dashboard to show Y", "fix dashboard Z", "add a column/button/tab/route to dashboard".
---

# Dashboard Patch Skill

The dashboard file (`src/dashboard/index.js`) uses **CRLF line endings** and embeds ALL frontend JS inside a single `getHTML()` template literal. Standard editing tools corrupt it. This skill enforces the only safe approach.

## Critical Rules (enforce without exception)

1. **Never use the Edit tool** on `src/dashboard/index.js`. Always use a Node.js patch script.
2. **Never pass patch scripts via bash heredoc** — bash strips `\` before backticks, silently corrupting the script. Use the `Write` tool to create `.js` files.
3. **Patch scripts must use `require()`, not ESM `import`** (they run as CommonJS with `node _fix.js`).
4. **Inner template literals inside `getHTML()`** must use `\`` and `\${...}`. Never unescaped `` ` `` or `${`.
5. **Build replacement strings with concatenation (`+`)** when they contain backticks or `${`. Do not use template literals to build those strings.
6. **CRITICAL escaping rule for backtick/`${` in replacement strings:** In your patch script, to write `\`` (escaped backtick for inside getHTML template) into the file, use `'\\' + '`'` — NOT `'\`'`. The expression `'\`'` is just a plain backtick in JS. Always test: `console.log('\\' + '\`')` should show `\``.
7. **Always syntax-check after patching — TWO checks required:** (a) outer Worker JS; (b) frontend JS. See Step 4.
8. **Dynamic row buttons** must be wrapped in `\${...}`. A bare `` \`...\` `` not inside `\${...}` closes the outer template.

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

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// Verify old string exists before replacing
const OLD = `exact string from file`;  // use string concat if it contains backticks
const NEW = `replacement string`;       // use string concat if it contains backticks

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
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

**Escaping reminder for row HTML in the patch script:**
- Unconditional button: `\${\`<button ...>\`}`
- Conditional button: `\${condition ? \`<button ...>\` : ''}`
- Any JS expression: `\${expr}`
- String variable reference: `\${varName}`

**Correct way to build escaped backtick/`${` in a patch script replacement string:**
```js
// To produce \` in the file (escaped backtick for inside getHTML template):
const BT = '\\' + '`';    // '\\' = one backslash, '`' = backtick → \`
// To produce \${ in the file (escaped template expression):
const DS = '\\' + '${';   // \${
// Then use:
'fetch(' + BT + DS + 'API_BASE}/endpoint' + BT + ', {'
// Writes:  fetch(\`\${API_BASE}/endpoint\`, {   ← correct in file
```
**WRONG:** `const Q = '\`'` — `'\`'` is just a plain backtick `` ` `` in JavaScript, NOT `\``. This was the root cause of the recurring data-not-loading bug.

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
(`_check_frontend_js.js` lives at the repo root. If it's missing, create it — see template below.)

**Why two checks?** Check 1 only validates the outer Worker module. Escaping bugs in the frontend JS (e.g. an unescaped `${` or a missing `\`` on a `fetch()` URL) appear as a *string* to Node — the outer module passes but the browser gets broken JS, and `loadData()` never runs. This is the root cause of the recurring "data not loading" bug.

**`_check_frontend_js.js` template (create if missing):**
```js
const fs = require('fs');
const cp = require('child_process');
const src = fs.readFileSync('src/dashboard/index.js', 'utf8');
const scriptStart = src.lastIndexOf('<script>');
const scriptEnd = src.lastIndexOf('</script>');
if (scriptStart === -1 || scriptEnd === -1) { console.error('script tags not found'); process.exit(1); }
const browserJs = src.slice(scriptStart + 8, scriptEnd).replace(/\\`/g, '`').replace(/\\\${/g, '${');
fs.writeFileSync('_frontend_check_tmp.js', browserJs, 'utf8');
try {
  cp.execSync('node --input-type=module --check < _frontend_check_tmp.js', { stdio: ['inherit','inherit','inherit'], shell: true });
  console.log('Frontend JS OK');
} catch(e) { console.error('Frontend JS has syntax errors!'); process.exit(1); }
finally { fs.unlinkSync('_frontend_check_tmp.js'); }
```

If either check fails, the patch broke something. Read the error line number, fix the script, and re-run from Step 2.

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
