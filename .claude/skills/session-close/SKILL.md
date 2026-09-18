---
name: session-close
description: End-of-session checklist. Verifies all work is committed, pushed, and documented, and updates agent/current-state.md. Branch-aware - in a task worktree it pushes the branch and NEVER deploys; in the main checkout it verifies deployments. Use at the end of any working session. Triggers on: "wrap up", "I'm done for now", "end session", "close out", "let's wrap", "session close", "that's it for today".
---

# Session Close Skill

Run this checklist at the end of every session. Be thorough - the next session starts cold.

## Step 0 - Find out where you are (this decides everything else)

```bash
git rev-parse --abbrev-ref HEAD
```

- Branch is **not `main`** -> you are in a task worktree. Follow **Path A**. You will not deploy anything.
- Branch **is `main`** -> you are in the deploy checkout. Follow **Path B**.

State which path you are on in your first line of output, so the user knows where they are.

## Step 1 - Check git status (both paths)

Run `git status` and `git diff --stat HEAD`.

- If there are **uncommitted changes**: ask the user if they want to commit before closing. If yes, stage the relevant files and commit with a clear message.
- If there are **untracked new files** that look intentional (new workers, scripts that were used): ask if they should be committed.
- Scratch patch scripts (`_fix_*.js`, `fix*.js`) are usually safe to leave untracked - do not commit them automatically.
- `pnpm-lock.yaml` is noise left by the worktree setup script. Never commit it. This repo uses npm.

## Step 2 - Dashboard syntax checks (both paths, only if the dashboard was touched)

If `src/dashboard/index.js` or `src/dashboard/public/index.html` changed in this session, run BOTH:

```bash
node --input-type=module --check < src/dashboard/index.js   # Worker module
node _check_frontend_js.js                                  # inline <script> blocks
```

Check 1 alone is insufficient. If either fails, flag it immediately and do not close out quietly.

## Path A - task worktree (branch is not `main`)

**Do not deploy. Do not offer to deploy. Do not run `scripts/deploy.sh`**, not even with `--env test`, unless the user explicitly asks for a preview in this session.

Why: `wrangler deploy` replaces the whole Worker with this working copy, and this copy does not contain whatever landed on `main` while this task was open. Deploying from here silently reverts that work. See `agent/BOOTSTRAP.md` rule 8. `scripts/deploy.sh` will refuse a production deploy from here anyway - do not reach for `ALLOW_UNSAFE_DEPLOY=1` to get around it.

1. Commit the work (Step 1).
2. Update `agent/current-state.md` (Step 3) and `agent/decision-log.md` if warranted (Step 4), then commit those.
3. Push the branch: `git push -u origin HEAD`
4. Work out which workers this branch touched, for the handoff line:
   ```bash
   git diff --name-only origin/main...HEAD | grep '^src/' | cut -d/ -f2 | sort -u
   ```
5. Report with the Path A summary format.

## Path B - main checkout (branch is `main`)

1. Pull first: `git pull --ff-only origin main`
2. For every `src/<worker>/` modified since the last deploy, confirm it was actually deployed.
3. If anything is merged but not deployed, do not deploy it ad hoc here - tell the user to run the **`main-deploy`** skill, which handles ordering, tests, migrations and the deploy marker.
4. Report with the Path B summary format.

## Step 3 - Update `agent/current-state.md`

Read the current `agent/current-state.md`. Then update it:

**Add to "Recent Significant Changes"** (if something meaningful was done today):
```
| <today's date> | <what changed, 1 line> | <worker(s) affected> |
```

**Update "In Progress / Pending Work"**:
- If something was completed, remove it or mark it done
- If new work was started but not finished, add a clear entry describing what remains
- Be specific: "X was done; Y still needs Z before it works"

**Update "Known Issues"**:
- If a bug was fixed, remove it
- If a new issue was discovered, add it

On Path A, say in the entry that the work is on a branch and not yet deployed, and name the branch.

Use the `Write` or `Edit` tool to update the file directly.

## Step 4 - Check for decision-log entries

Did this session involve a non-obvious architectural decision? Examples:
- A new pattern for how workers communicate
- A reason why something was built a non-obvious way
- A constraint discovered that wasn't previously documented
- A deliberate choice to NOT do something (and why)

If yes, add an entry to `agent/decision-log.md`:
```
## <date> - <short title>
**Decision:** <what was decided>
**Why:** <rationale>
**Consequence:** <what not to undo / what this affects>
```

## Step 5 - Final commit and push

If `agent/current-state.md` or `agent/decision-log.md` were updated:
```bash
git add agent/current-state.md agent/decision-log.md
git commit -m "agent: update state and decisions after <session topic>"
git push
```

On Path A this push also publishes the branch, which is what makes the work visible outside this worktree. Do not close out a Path A session without pushing - unpushed finished work is invisible and has cost real money before (see the `fix/atomic-portin-finalizer-record` entry in `agent/current-state.md`).

## Step 6 - Session summary

**Path A format:**
```
## Session Closed - task worktree

**Branch:** <branch> (pushed)
**Done today:**
- <item>
**Still pending:**
- <item> - <what remains>
**Files changed vs main:** <n> files - <list them if under 10>
**Workers touched:** <list, or "none - documentation only">
**Deployed:** nothing, by design (task worktree)

**Your next step:** switch to the `main` workspace and say "deploy". The `main-deploy` skill merges this branch into `main` and ships whatever needs shipping. Do not merge from here.
```

**Path B format:**
```
## Session Closed - main checkout

**Done today:**
- <item>
**Still pending:**
- <item> - <what remains>
**Deployed:** <worker list> or "nothing deployed"
**Merged but not yet deployed:** <list> or "none"
**State file updated:** yes/no

**Next session should start with:** <one sentence>
```

## What NOT to do at close

- **Never deploy from a task worktree, and never offer to.** Route it through merge + `main-deploy`.
- Do not use `ALLOW_UNSAFE_DEPLOY=1` to get past a refusal. It exists for a production emergency the user has explicitly called.
- Do not commit scratch scripts (`_fix_*.js`, test files, rendered HTML) or `pnpm-lock.yaml` unless the user asks.
- Do not deploy workers that weren't changed in this session.
- Do not delete untracked files - the user may want them.
- Do not mark things "done" in `current-state.md` if they haven't been tested in production.

