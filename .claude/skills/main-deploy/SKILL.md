---
name: main-deploy
description: Safely deploy everything that has been merged to main but not yet shipped. Runs only from the main checkout, pulls first, finds which workers actually changed since the last deploy, runs the test suite, deploys each changed worker, then moves the deploy marker. Flags unapplied migrations and finished-but-unmerged branches. Triggers on: "deploy", "deploy it", "main deploy", "ship it", "deploy what merged", "I just finished a job, deploy it", "deploy all completed work", "what needs deploying".
---

# Main Deploy Skill

Ships merged work to production. The operator is not a developer - be explicit, refuse rather than guess, and never deploy something you were not asked about.

## Hard rules

- **Runs only from the main checkout.** If `git rev-parse --abbrev-ref HEAD` is not `main`, STOP. Tell the user which folder to switch to (the workspace named `main`, marked `primary` in Orca). Do not deploy from a task worktree, ever.
- **Never use `ALLOW_UNSAFE_DEPLOY=1`.** If `scripts/deploy.sh` refuses, that refusal is the answer. Report it and stop.
- **Deploy only workers that actually changed.** Never bulk-deploy everything - a 2026-06-12 bulk deploy from a stale checkout silently reverted a live feature.
- **Never apply a database migration as part of a deploy.** Flag them and let the user decide (see Step 6).

## Step 1 - Confirm where you are, and get current

```bash
git rev-parse --abbrev-ref HEAD          # must print: main
git status --porcelain -- src/           # must be empty
git fetch origin --prune
git pull --ff-only origin main
```

- Not on `main` -> STOP, tell the user to switch to the `main` workspace.
- Uncommitted changes under `src/` -> STOP. Production would get code that is not committed anywhere. Show the files and ask.
- `git pull --ff-only` fails -> STOP and report. It means local `main` has commits that are not on origin, which needs a human decision.

## Step 2 - Merge finished work into main

Work sitting on a pushed branch is not live, no matter how many times you deploy. Bringing finished branches in is part of shipping, and it happens here - never from a task worktree.

List the candidates:

```bash
git branch -r --no-merged origin/main --sort=-committerdate \
  --format='%(refname:short)  %(committerdate:relative)  %(contents:subject)' | head -15
```

Show that list and ask which branches to merge. **Do not guess and do not merge all of them** - some are abandoned experiments. If the user says something loose like "the job I just finished", match it to the most recent branch, then confirm it by name before touching anything.

For each branch the user confirms:

```bash
git merge --no-ff origin/<branch> -m "merge <branch> into main"
```

- **Merge conflict** -> STOP. Run `git merge --abort`, leave `main` untouched, and tell the user which files conflicted. A conflict needs whoever wrote the branch, not a deploy.
- **After all merges, run `npm test`.** If tests pass on the branch but fail once merged, the change is fine alone and broken in combination. STOP. Do not push, do not deploy, and say exactly that - this is the failure the merge step exists to catch.
- Then `git push origin main`.

If the user says there is nothing to merge, skip ahead and deploy whatever is already on `main` but not yet shipped.


## Step 3 - Work out what has not been deployed

The marker for "what is live" is the git tag `deployed/prod`.

```bash
git fetch origin 'refs/tags/*:refs/tags/*' --force 2>/dev/null
git rev-parse --verify --quiet deployed/prod
```

**If the tag exists**, the workers needing a deploy are the ones whose files changed between it and `HEAD`:

```bash
git diff --name-only deployed/prod..HEAD | grep '^src/' | cut -d/ -f2 | sort -u
```

Also list the commits being shipped, so the user can see what this is:

```bash
git log --oneline deployed/prod..HEAD
```

**If the tag does not exist** (first ever run), do NOT guess. Show the user the workers touched in the last 20 commits on `main`:

```bash
git diff --name-only HEAD~20..HEAD | grep '^src/' | cut -d/ -f2 | sort -u
```

Then ask which of those they actually want deployed now, deploy only those, and create the marker at the end. Say plainly that after this first run it will know by itself.

**If nothing changed**, say "Nothing to deploy - production matches `main`" and stop. Do not deploy anything to prove it works.

## Step 4 - Show the plan and get a yes

Before deploying anything, print:

```
About to deploy to PRODUCTION from main @ <short sha>

Workers changed since last deploy:
  - <worker>   (<n> files)
Commits being shipped:
  - <short sha> <subject>

Not deploying: <workers unchanged>
```

Wait for the user to confirm. One confirmation covers the whole list.

## Step 5 - Pre-flight checks, once

```bash
npm test
npm run check:db-constraints
```

If either fails, STOP. Deploy nothing. Report what failed. A failing test suite on `main` is its own incident - say so.

If `src/dashboard/` is in the deploy list, also run both dashboard checks now:

```bash
node --input-type=module --check < src/dashboard/index.js
node _check_frontend_js.js
```

## Step 6 - Migrations: flag, never apply

```bash
git diff --name-only deployed/prod..HEAD | grep '^supabase/migrations/'
```

If any migration files are new in this range, STOP before deploying and tell the user:

- which migration files are new
- that code expecting a new column or function will fail in production if the migration has not been applied
- that migrations are applied with `mcp__supabase__apply_migration`, never by the deploy

Ask whether they have been applied to PROD. If the user does not know, offer to check the live schema before deploying. Only continue once they say to.

## Step 7 - Deploy, one worker at a time

For each worker in the confirmed list:

```bash
scripts/deploy.sh <worker>
```

For the dashboard specifically, the explicit-env form is required by `agent/constraints.md`:

```bash
scripts/deploy.sh dashboard --env=""
```

Notes:
- `scripts/deploy.sh` re-runs the test suite per worker. That is slow with several workers but it is the sanctioned path - do not bypass it by calling `npx wrangler deploy` directly.
- If a deploy fails, STOP. Do not continue to the next worker. Report which ones already shipped and which did not, so the user knows the real state.

## Step 8 - Move the marker

Only after every worker in the list deployed successfully:

```bash
git tag -f deployed/prod HEAD
git push -f origin deployed/prod
```

If some deploys succeeded and others failed, do NOT move the marker. Leave it where it is and say so - a marker that lies is worse than no marker.

## Step 9 - Report, and name the loose ends

```
## Deployed

**From:** main @ <short sha>
**Workers deployed:** <list>
**Skipped (unchanged):** <count> workers
**Migrations:** none new / <list> (confirmed applied)

## Still not live

**Branches with work not merged into main:**
  - <branch> - <last commit date>
```

Get that last list with:

```bash
git branch -r --no-merged origin/main --sort=-committerdate | head -20
```

That list answers the user's real question - "is all my completed work live?" Work sitting on an unmerged branch is not live no matter how many times you deploy. For each recent one, say whether it looks abandoned or genuinely pending, and let the user decide to merge or delete. Do not merge anything yourself as part of a deploy.

Finally, record the deploy in `agent/current-state.md` per the maintenance protocol in `agent/BOOTSTRAP.md`, commit and push.

## When something goes wrong

- **`scripts/deploy.sh` refuses** -> read the refusal out loud to the user. It means `main` is stale or you are in the wrong folder. Fix that, do not override it.
- **A deploy half-finished** -> report exactly which workers are on the new code and which are on the old. Mixed state is the dangerous state; make it visible.
- **Production breaks after a deploy** -> the previous version is recoverable with `npx wrangler rollback` in that worker's directory, and the last good commit is the old `deployed/prod` tag. Tell the user both options rather than improvising a forward fix under pressure.

