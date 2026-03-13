# Working SOP — IncomingSMS

## Starting a Session

1. If Claude seems disoriented, say: **"Read agent/BOOTSTRAP.md first"**
2. If picking up from previous work: **"Check agent/current-state.md — what's pending?"**
3. Otherwise just describe what you want — the agent reads memory automatically

---

## During Work

**Be specific.** Instead of "fix the SIM issue", say "SIM 47 is suspended — diagnose it."

**Use the skills:**

| Say this | Skill triggered |
|----------|----------------|
| `/sim-triage SIM 47` | Full diagnostic report |
| `/patch-dashboard` + describe the change | Safe dashboard edit workflow |
| `/session-close` | End-of-session checklist |

**Dashboard changes:** Always let the `patch-dashboard` skill handle it. Don't let Claude edit `src/dashboard/index.js` directly — it will break.

**After a deploy:** Claude should commit automatically. If it doesn't, say "commit and push."

---

## Ending a Session

Always run `/session-close` before you leave. This:
- Confirms everything is committed and deployed
- Updates `agent/current-state.md` so the next session knows where things stand
- Captures any decisions that were made

---

## Key Habits

- **Something broke in prod?** Say "add it to current-state.md" immediately
- **Non-obvious decision made?** Say "log that decision" — it goes in `agent/decision-log.md`
- **Starting a new feature?** Ask "check current-state.md for anything related first"
- **Root getting cluttered?** Delete used patch scripts after each feature

---

## What Lives Where

| What | Where |
|------|-------|
| Architecture, worker list, data flows | `agent/project-map.md` |
| Hard rules and gotchas | `agent/constraints.md` |
| Why things are built a certain way | `agent/decision-log.md` |
| What's broken / in progress | `agent/current-state.md` |
| How to do common operations | `agent/workflows.md` |
| Skills to build next | `agent/skills-wanted.md` |
