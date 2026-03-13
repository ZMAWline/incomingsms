# Recommended Skills / Reusable Agent Workflows

Ranked by impact. Each entry explains what the skill does and why it's worth building.

---

## Tier 1 — Build These First

### 1. `deploy-worker`
**What:** Guided deploy workflow — takes a worker name, validates the wrangler.toml exists, runs `wrangler deploy`, optionally runs `wrangler tail` to confirm it's live.

**Why:** Deploy is the most common operation. A skill prevents mistakes (deploying to wrong env, forgetting to set secrets, missing a dependent worker redeploy when shared code changed).

**Triggers on:** "deploy X", "push X worker", "update and push"

---

### 2. `patch-dashboard`
**What:** Dashboard-safe patching workflow. Reads the current dashboard file, creates a patch script using `Write` tool (never heredoc), runs it, syntax-checks, deploys.

**Why:** The dashboard CRLF/escaping issue has broken production multiple times. Every session that touches the dashboard has to re-learn the rules. A skill encodes the safe approach so it's never skipped.

**Triggers on:** any request to add/modify dashboard UI, buttons, columns, tabs, or API routes

---

### 3. `sim-triage`
**What:** Diagnostic workflow for a broken SIM. Takes a SIM ID, queries `helix_api_logs`, `sims`, `sim_numbers`, `webhook_deliveries`, and `system_errors` in one pass, returns a structured summary: status, last rotation, last notification, last error, last Helix call result.

**Why:** "Why is this SIM suspended/not working?" is a frequent support question. Currently requires manually querying 4-5 tables. A skill saves 5-10 minutes per incident.

**Triggers on:** "SIM X is broken", "why is SIM X suspended", "diagnose SIM X"

---

## Tier 2 — High Value

### 4. `add-worker`
**What:** Scaffolds a new worker — creates `src/<name>/index.js` with boilerplate export, creates `wrangler.toml` from template, adds it to `agent/project-map.md`, prompts for secrets and service bindings.

**Why:** Worker creation has 6 steps with easy-to-miss parts (adding service bindings to dashboard wrangler.toml, updating project-map.md). A skill makes it one command.

**Triggers on:** "create a new worker", "add a worker for X"

---

### 5. `db-migration`
**What:** Migration workflow — takes a description and SQL, creates the migration file with timestamp, applies via MCP tool, verifies via execute_sql.

**Why:** Easy to forget the file creation step and just run SQL directly. This makes migrations reproducible and tracked.

**Triggers on:** "add a column", "create a table", "alter schema", "run a migration"

---

### 6. `session-close`
**What:** End-of-session checklist — confirms all changed files are committed, all deployed workers are syntactically valid, updates `agent/current-state.md` with what was done and what's pending, asks if any decisions need logging.

**Why:** Sessions end abruptly. Without a close routine, in-progress state is lost and the next session has to re-discover what changed.

**Triggers on:** "wrap up", "I'm done for now", "end session", "close out"

---

### 7. `reseller-debug`
**What:** Diagnostic for a reseller not receiving webhooks. Takes reseller ID, checks `webhook_deliveries` for recent history, checks `sims.last_notified_at` for their SIMs, checks dedup records for today, tests the webhook URL if accessible.

**Why:** Reseller webhook failures are the most common user-facing complaint and require querying multiple tables to diagnose.

**Triggers on:** "reseller X isn't getting notifications", "webhook not working for X"

---

## Tier 3 — Nice to Have

### 8. `imei-audit`
**What:** Reports IMEI pool health — counts by status (available/in_use/retired/blocked), flags SIMs with no IMEI, flags gateway slots where DB IMEI doesn't match device IMEI.

**Why:** IMEI mismatches are a root cause of AT&T suspensions. An audit skill makes it easy to catch drift before it causes problems.

### 9. `rotation-health`
**What:** Reports MDN rotation health for today — how many SIMs were rotated, how many failed, how many are overdue, any `last_rotation_error` values.

**Why:** The cron runs unattended. Knowing whether it's working requires querying the DB. A skill makes the daily check a one-liner.

### 10. `onboarding-tour`
**What:** Walks through the system architecture, worker by worker, with the actual current code. For when context is completely cold.

**Why:** If the `.claude/` memory is lost or this is a fresh session with no context, this skill rebuilds orientation in one pass without reading agent/ files manually.

---

## Notes on Skill Design

- Skills that touch the dashboard should always enforce the CRLF/escaping constraint internally.
- Skills that modify schema should always create a migration file, not just run SQL.
- Skills that deploy workers should always run syntax-check first if the worker was edited.
- Skills should be short (< 50 lines of instructions), opinionated, and not ask the user unnecessary questions.
