#!/usr/bin/env bash
# Removes task worktrees whose work is merged into main and deployed, and
# closes the chat sessions and shells still open inside them.
# Run from the main checkout after a production deploy:
#   scripts/clean-shipped-worktrees.sh
#
# A worktree is removed only when all of these hold:
#   - its branch has commits of its own (a fresh worktree branched off main
#     and not yet committed to is kept)
#   - merging its branch into HEAD would change nothing (works for squash merges)
#   - production runs main's worker code: nothing under src/ differs between
#     the deployed/prod tag and HEAD
#   - it has no uncommitted changes to tracked files
#   - its only untracked files are pnpm noise (pnpm-lock.yaml, pnpm-workspace.yaml)
# Processes running inside it (such as a Claude session) are then stopped,
# TERM first and KILL after 5 seconds, and the clean checks run again before
# removal. Anything else is reported as KEPT with the reason, and left alone.

set -euo pipefail

main_root="$(git rev-parse --show-toplevel)"
head_tree="$(git rev-parse 'HEAD^{tree}')"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "Refusing: run from the main checkout." >&2
  exit 1
fi

git fetch origin 'refs/tags/deployed/prod:refs/tags/deployed/prod' --force >/dev/null 2>&1 || true
undeployed=""
if ! git rev-parse --verify --quiet deployed/prod >/dev/null; then
  undeployed="no deployed/prod tag"
elif ! git diff --quiet deployed/prod HEAD -- src/; then
  undeployed="main has worker code not deployed yet"
fi

# Prints why a worktree is not clean, or nothing when it is.
dirty_reason() {
  local path="$1" tracked untracked
  tracked="$(git -C "$path" status --porcelain --untracked-files=no)"
  if [ -n "$tracked" ]; then
    echo "uncommitted changes:"
    echo "$tracked" | sed 's/^/          /'
    return
  fi
  untracked="$(git -C "$path" ls-files --others --exclude-standard \
    | grep -vx -e 'pnpm-lock.yaml' -e 'pnpm-workspace.yaml' || true)"
  if [ -n "$untracked" ]; then
    echo "untracked files:"
    echo "$untracked" | sed 's/^/          /'
  fi
}

# Prints the pids of processes whose working directory is inside the path.
pids_in() {
  local path="$1" proc cwd
  for proc in /proc/[0-9]*; do
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    case "$cwd" in "$path"|"$path"/*) echo "${proc#/proc/}" ;; esac
  done
}

git worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10) }
  /^branch /   { print path "\t" substr($0, 19) }
' | while IFS=$'\t' read -r path branch; do
  [ "$path" = "$main_root" ] && continue

  # grep without -q reads all input, so rev-list never dies of SIGPIPE under pipefail.
  if git rev-list --first-parent HEAD | grep -x "$(git rev-parse "$branch")" >/dev/null; then
    echo "KEPT    $path ($branch): no commits of its own yet"
    continue
  fi

  merged_tree="$(git merge-tree --write-tree HEAD "$branch" 2>/dev/null | head -1 || true)"
  if [ "$merged_tree" != "$head_tree" ]; then
    echo "KEPT    $path ($branch): has work that is not in main"
    continue
  fi

  if [ -n "$undeployed" ]; then
    echo "KEPT    $path ($branch): merged but not deployed ($undeployed)"
    continue
  fi

  reason="$(dirty_reason "$path")"
  if [ -n "$reason" ]; then
    echo "KEPT    $path ($branch): $reason"
    continue
  fi

  pids="$(pids_in "$path" | tr '\n' ' ')"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      [ -z "$(pids_in "$path")" ] && break
      sleep 1
    done
    left="$(pids_in "$path" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    [ -n "$left" ] && kill -9 $left 2>/dev/null || true
    sleep 1
    echo "CLOSED  $path ($branch): stopped pids: $pids"

    # A session may have written something just before it stopped.
    reason="$(dirty_reason "$path")"
    if [ -n "$reason" ]; then
      echo "KEPT    $path ($branch): $reason"
      continue
    fi
  fi

  git worktree remove --force "$path"
  git branch -D "$branch" >/dev/null
  echo "REMOVED $path ($branch)"
done
