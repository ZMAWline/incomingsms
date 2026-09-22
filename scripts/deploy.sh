#!/usr/bin/env bash
# Safe deploy -- refuses to ship a worker if tests or the DB-constraint
# drift check fail. This is the guard that would have caught the PR-B
# malformed-query deploy (2026-05-20, a full night of lost rotations).
#
# It also refuses to ship PRODUCTION from a stale or non-main checkout.
# See "The stale-deploy guard" below and agent/BOOTSTRAP.md rule 8.
#
# Usage:
#   scripts/deploy.sh <worker-name>            # deploy to production
#   scripts/deploy.sh <worker-name> --env test # deploy to the -test preview
#   scripts/deploy.sh --all-test               # deploy ALL workers to -test
#   ... --allow-var-drop                       # deploy even if it deletes live vars
#
# <worker-name> is a directory under src/ (e.g. dashboard, mdn-rotator).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKERS_DIR="$ROOT/src"

# ---------------------------------------------------------------------------
# The stale-deploy guard
#
# WHY THIS EXISTS: `wrangler deploy` REPLACES the whole worker with this
# working copy. It is not a patch. So deploying from a branch that is behind
# main silently reverts every commit this checkout never saw -- tests still
# pass, nothing errors, a working feature just stops working. That is the
# 2026-06-12 RENTAL_CAPTURE_ENABLED revert (see agent/current-state.md).
#
# Rule: build in worktrees, deploy production from an up-to-date main.
#
# Emergency override (prints loudly, use only when you mean it):
#   ALLOW_UNSAFE_DEPLOY=1 scripts/deploy.sh <worker>
# ---------------------------------------------------------------------------
guard_production_source() {
  local branch behind dirty
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo UNKNOWN)"

  if ! git fetch origin main --quiet 2>/dev/null; then
    echo "WARNING: could not reach origin to check freshness -- continuing on local refs." >&2
  fi

  behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
  dirty="$(git status --porcelain -- src/ | wc -l | tr -d ' ')"

  local failed=0

  if [[ "$branch" != "main" ]]; then
    echo "REFUSING TO DEPLOY TO PRODUCTION" >&2
    echo "  You are on branch '$branch', not main." >&2
    echo "  Production is deployed from main only." >&2
    echo "  Do this instead:" >&2
    echo "    git fetch origin && git rebase origin/main   # pull others' work in" >&2
    echo "    npm test                                     # re-test the combination" >&2
    echo "    # then merge to main, and deploy from a main checkout" >&2
    echo "  To test THIS branch without touching production:" >&2
    echo "    scripts/deploy.sh <worker> --env test" >&2
    failed=1
  elif [[ "$behind" -gt 0 ]]; then
    echo "REFUSING TO DEPLOY TO PRODUCTION" >&2
    echo "  You are on main, but $behind commit(s) behind origin/main." >&2
    echo "  Deploying now would revert those $behind commit(s) in production." >&2
    echo "  Fix: git pull --ff-only origin main" >&2
    failed=1
  fi

  if [[ "$dirty" -gt 0 ]]; then
    echo "WARNING: $dirty uncommitted change(s) under src/ -- production will get code" >&2
    echo "         that is not committed anywhere. Commit first if this is real work." >&2
    git status --short -- src/ >&2
  fi

  if [[ "$failed" -eq 1 ]]; then
    if [[ "${ALLOW_UNSAFE_DEPLOY:-0}" == "1" ]]; then
      echo "" >&2
      echo "!!! ALLOW_UNSAFE_DEPLOY=1 -- bypassing the guard above. !!!" >&2
      echo "!!! You may be reverting other work in production.      !!!" >&2
      echo "" >&2
      sleep 3
    else
      exit 1
    fi
  fi
}

# A deploy is "production" unless an explicit non-empty --env was passed.
is_production_deploy() {
  local prev="" a
  for a in "$@"; do
    if [[ "$prev" == "--env" && -n "$a" ]]; then return 1; fi
    if [[ "$a" == --env=?* ]]; then return 1; fi
    prev="$a"
  done
  return 0
}

run_checks() {
  echo "==> Running test suite"
  npm test
  echo "==> Running DB constraint drift check"
  npm run check:db-constraints
}

# ---------------------------------------------------------------------------
# The live-var guard
#
# WHY THIS EXISTS: a plain var set with `--var` lives only until the next
# deploy that does not repeat it. On 2026-09-22 the offline-lifecycle dry-run
# flags were dropped this way by three routine deploys. Plain vars belong in
# wrangler.toml [vars]; this refuses a deploy that would delete one that is
# live but not in the toml. Non-fatal if the Cloudflare API cannot be read.
# ---------------------------------------------------------------------------
guard_live_vars() {
  local dir="$1"; shift
  local env_name="" var_names=() prev="" a
  for a in "$@"; do
    if [[ "$prev" == "--env" ]]; then env_name="$a"; fi
    if [[ "$a" == --env=* ]]; then env_name="${a#--env=}"; fi
    if [[ "$prev" == "--var" ]]; then var_names+=("${a%%:*}"); fi
    if [[ "$a" == --var=* ]]; then a="${a#--var=}"; var_names+=("${a%%:*}"); fi
    prev="$a"
  done
  if ! python3 "$ROOT/scripts/check_live_vars.py" "$dir" "$env_name" "${var_names[@]}"; then
    if [[ "$ALLOW_VAR_DROP" == "1" ]]; then
      echo "!!! --allow-var-drop -- deploying anyway; the vars above will be deleted. !!!" >&2
    else
      exit 1
    fi
  fi
}

deploy_one() {
  local worker="$1"; shift
  local dir="$WORKERS_DIR/$worker"
  if [[ ! -f "$dir/wrangler.toml" ]]; then
    echo "ERROR: no wrangler.toml in src/$worker -- not a deployable worker" >&2
    exit 1
  fi
  guard_live_vars "$dir" "$@"
  echo "==> Deploying $worker $*"
  (cd "$dir" && npx wrangler deploy "$@")
}

ALLOW_VAR_DROP=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--allow-var-drop" ]]; then ALLOW_VAR_DROP=1; else ARGS+=("$a"); fi
done
set -- "${ARGS[@]}"

if [[ "${1:-}" == "--all-test" ]]; then
  run_checks
  for toml in "$WORKERS_DIR"/*/wrangler.toml; do
    worker="$(basename "$(dirname "$toml")")"
    deploy_one "$worker" --env test
  done
  echo "==> All workers deployed to test environment"
  exit 0
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/deploy.sh <worker-name> [--env test] | --all-test" >&2
  exit 1
fi

WORKER="$1"; shift

if is_production_deploy "$@"; then
  guard_production_source
fi

run_checks
deploy_one "$WORKER" "$@"
echo "==> Done. Remember: production cron/queue changes need explicit operator approval."

