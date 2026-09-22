# Brief A — resolve the two conflicting PRs (#88, #84)

Status: OPEN. Owner: Zalmen. Created 2026-09-22 after the main-deploy run.

Two open PRs hold real work but conflict with `main`:
- **PR #88** `feat/messages-search-multi-number` — dashboard Messages search accepts several phone numbers at once.
- **PR #84** `fix/qbo-csv-filenames-rebased` — removes underscores and dashes from QuickBooks invoice CSV filenames.

Do, per PR: rebase the branch onto current `origin/main`, resolve conflicts keeping main's newer code where both changed the same thing, run `npm test` (must stay green; main is at 975 passing), push, get the owner's yes, squash-merge, delete the branch.
Rules: work in a task worktree, never in the main checkout. Do not deploy; deploys run from the main workspace via `/main-deploy`.
Done when: both PRs show MERGED or CLOSED with a reason, and `agent/current-state.md` records it.
