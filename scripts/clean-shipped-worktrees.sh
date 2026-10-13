#!/usr/bin/env bash
# Removes task worktrees whose work is already in main.
# Run from the main checkout after a production deploy:
#   scripts/clean-shipped-worktrees.sh
#
# A worktree is removed only when all of these hold:
#   - its branch has commits of its own (a fresh worktree branched off main
#     and not yet committed to is kept)
#   - merging its branch into HEAD would change nothing (works for squash merges)
#   - it has no uncommitted changes to tracked files
#   - its only untracked files are pnpm noise (pnpm-lock.yaml, pnpm-workspace.yaml)
#   - no process (such as a Claude session) is running inside it
# Anything else is reported as KEPT with the reason, and left alone.

set -euo pipefail

main_root="$(git rev-parse --show-toplevel)"
head_tree="$(git rev-parse 'HEAD^{tree}')"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "Refusing: run from the main checkout." >&2
  exit 1
fi

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

  tracked="$(git -C "$path" status --porcelain --untracked-files=no)"
  if [ -n "$tracked" ]; then
    echo "KEPT    $path ($branch): uncommitted changes:"
    echo "$tracked" | sed 's/^/          /'
    continue
  fi

  untracked="$(git -C "$path" ls-files --others --exclude-standard \
    | grep -vx -e 'pnpm-lock.yaml' -e 'pnpm-workspace.yaml' || true)"
  if [ -n "$untracked" ]; then
    echo "KEPT    $path ($branch): untracked files:"
    echo "$untracked" | sed 's/^/          /'
    continue
  fi

  pids=""
  for proc in /proc/[0-9]*; do
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    case "$cwd" in "$path"|"$path"/*) pids="$pids ${proc#/proc/}" ;; esac
  done
  if [ -n "$pids" ]; then
    echo "KEPT    $path ($branch): processes running inside it, pids:$pids"
    continue
  fi

  git worktree remove --force "$path"
  git branch -D "$branch" >/dev/null
  echo "REMOVED $path ($branch)"
done
