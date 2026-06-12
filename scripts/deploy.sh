#!/usr/bin/env bash
# Safe deploy — refuses to ship a worker if tests or the DB-constraint
# drift check fail. This is the guard that would have caught the PR-B
# malformed-query deploy (2026-05-20, a full night of lost rotations).
#
# Usage:
#   scripts/deploy.sh <worker-name>            # deploy to production
#   scripts/deploy.sh <worker-name> --env test # deploy to the -test preview
#   scripts/deploy.sh --all-test               # deploy ALL workers to -test
#
# <worker-name> is a directory under src/ (e.g. dashboard, mdn-rotator).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKERS_DIR="$ROOT/src"

run_checks() {
  echo "==> Running test suite"
  npm test
  echo "==> Running DB constraint drift check"
  npm run check:db-constraints
}

deploy_one() {
  local worker="$1"; shift
  local dir="$WORKERS_DIR/$worker"
  if [[ ! -f "$dir/wrangler.toml" ]]; then
    echo "ERROR: no wrangler.toml in src/$worker — not a deployable worker" >&2
    exit 1
  fi
  echo "==> Deploying $worker $*"
  (cd "$dir" && npx wrangler deploy "$@")
}

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
run_checks
deploy_one "$WORKER" "$@"
echo "==> Done. Remember: production cron/queue changes need explicit operator approval."
