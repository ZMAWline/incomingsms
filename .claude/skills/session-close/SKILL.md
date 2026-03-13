---
name: session-close
description: End-of-session checklist. Verifies all work is committed, deployed, and documented. Updates agent/current-state.md with what was done and what remains. Use at the end of any working session. Triggers on: "wrap up", "I'm done for now", "end session", "close out", "let's wrap", "session close", "that's it for today".
---

# Session Close Skill

Run this checklist at the end of every session. Be thorough — the next session starts cold.

## Step 1 — Check Git Status

Run `git status` and `git diff --stat HEAD`.

- If there are **uncommitted changes**: ask the user if they want to commit before closing. If yes, stage the relevant files and commit with a clear message.
- If there are **untracked new files** that look intentional (new workers, scripts that were used): ask if they should be committed.
- Scratch patch scripts (`_fix_*.js`, `fix*.js`) are usually safe to leave untracked — do not commit them automatically.

## Step 2 — Verify Deployments

For every `src/<worker>/index.js` that was modified in this session:
- Confirm it was deployed (`npx wrangler deploy` was run and succeeded)
- If any were edited but not deployed, note it and ask the user if they want to deploy now

For `src/dashboard/index.js` specifically:
- Run `node --input-type=module --check < src/dashboard/index.js`
- If it fails, flag it immediately — do not close the session with a broken dashboard

## Step 3 — Update `agent/current-state.md`

Read the current `agent/current-state.md`. Then update it:

**Add to "Recent Significant Changes"** (if something meaningful was done today):
```
| <today's date> | <what changed, 1 line> | <worker(s) affected> |
```

**Update "In Progress / Pending Work"** section:
- If something was completed, remove it or mark it done
- If new work was started but not finished, add a clear entry describing what remains
- Be specific: "X was done; Y still needs Z before it works"

**Update "Known Issues"** section:
- If a bug was fixed, remove it
- If a new issue was discovered, add it

Use the `Write` tool or `Edit` tool to update the file directly.

## Step 4 — Check for Decision-Log Entries

Ask yourself: did this session involve any non-obvious architectural decision? Examples:
- A new pattern for how workers communicate
- A reason why something was built a non-obvious way
- A constraint discovered that wasn't previously documented
- A deliberate choice to NOT do something (and why)

If yes, add an entry to `agent/decision-log.md` following the format:
```
## <date> — <short title>
**Decision:** <what was decided>
**Why:** <rationale>
**Consequence:** <what not to undo / what this affects>
```

## Step 5 — Final Commit (if needed)

If `agent/current-state.md` or `agent/decision-log.md` were updated:
```bash
git add agent/current-state.md agent/decision-log.md
git commit -m "agent: update state and decisions after <session topic>"
git push
```

## Step 6 — Session Summary

Output a brief closing summary:

```
## Session Closed

**Done today:**
- <item 1>
- <item 2>

**Still pending:**
- <item 1> — <what remains>

**Deployed:**
- <worker list> or "nothing deployed"

**State file updated:** yes/no

**Next session should start with:** <one sentence about where to pick up>
```

## What NOT to Do at Close

- Do not commit scratch scripts (`_fix_*.js`, test files, rendered HTML) unless the user asks
- Do not deploy workers that weren't changed in this session
- Do not delete untracked files — the user may want them
- Do not mark things as "done" in current-state.md if they haven't been tested in production
