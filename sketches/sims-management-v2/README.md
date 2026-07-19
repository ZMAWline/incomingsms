# Sims Management v2 — Design Sketches

Three substantially different information architectures for the same data + action set. Fake data, self-contained HTML, working interactions. **Nothing here is deployed or wired to the dashboard.**

**How to review:** open `index.html` in a browser (or any variant file directly). Each sketch is keyboard-friendly; try Ctrl/⌘-K, row clicks, edit pencils, bulk selection. Process + rationale in `DESIGN.md`.

| File | Direction | Primary object |
|---|---|---|
| `variant-a-command-center.html` | **A — Command Center** | Work queues: health strip → attention queues with reasons + recommended actions → process-next triage |
| `variant-b-power-grid.html` | **B — Power Grid** | The grid: facet rail + saved views, inline compare-and-set editing, dry-run bulk, keyboard nav |
| `variant-c-investigator.html` | **C — Investigator** | One SIM's dossier: search-first master list + unified timeline + guarded record card (built around the SIM #639 story) |

Screenshots: `screenshots/variant-{a,b,c}-*.png` (1440×900 viewport + full-page).

## Comparison against the jobs (see DESIGN.md §1 for the JTBD list)

| Job | A Command Center | B Power Grid | C Investigator |
|---|---|---|---|
| J1 Daily triage "what's broken" | **Excellent** — the whole point | OK (saved view "Needs attention") | OK (queue piped into left list) |
| J2 Find one SIM fast | OK (palette) | Good (search + grid) | **Excellent** — search-first |
| J3 Investigate + correct safely | Good (inline history on card) | Weak (peek strip only) | **Excellent** — timeline beside guarded edits |
| J4 Bulk hygiene ops | Weak (queue-scoped only) | **Excellent** — selection scope, dry-run, typed delete | Weak |
| J5 Reconcile hosting reality vs DB | Good (queues can host reconcile diffs) | Good (facet "Atomic on Teltik · 310") | Good (evidence trail) |
| J6 Slice/browse inventory | Weak (Fleet is secondary) | **Excellent** | Weak |
| Safety posture (SIM #639 class) | Good | Good (CAS inline, 409 state) | **Best** — provenance block, flagged clobber event, type-to-confirm |

## Recommendation

**Hybrid: A as the home, C as the record, B's machinery as the Fleet view.**

- No single variant wins every job, but the jobs split cleanly by frequency: the operator *arrives* for triage (J1) and *drills into* one SIM for the risky work (J3). That is exactly A's shell plus C's dossier.
- B's strongest ideas — facet rail with live counts, dry-run bulk preview, inline CAS edit with 409 state — are enhancements to a browse view that Stage 1 already largely built (server-side query/filter/pagination exists). B as a whole is the least different from the rejected incremental direction; adopted alone it would repeat the "same design, patched" outcome.
- C's unified-timeline-beside-guarded-edit is the single highest-safety-value pattern of the three: evidence and correction on one screen. Stage 1's `/api/sim-history` + `/api/update-sim` already power it — the redesign is where they live, not what they call.

Concretely, the proposed target IA:

1. **SIMs home = Command Center** (variant A): health strip + attention queues. Fleet grid demoted to a tab.
2. **Record surface = Investigator dossier** (variant C): full-page (not drawer) master-detail with pinned/recent, timeline hero, guarded record card. Deep-linkable `/sims/639`.
3. **Fleet tab = existing Stage-1 server grid**, upgraded incrementally with B's facet counts, dry-run bulk modal, and bulk-bar scope sentence. No inline cell editing initially (accident surface; the dossier owns edits).

## Implementation plan (proposed — TEST env only, gated on operator approval)

Backend: **no new endpoints needed** for phase 1 — `/api/sims/query` (presets = queues), `/api/sim-history`, `/api/update-sim` cover A+C. Later: facet-count endpoint (one grouped query) and batch dry-run endpoint (Stage 3 in the existing spec).

1. **Phase 1 — Command Center home** (frontend only): queue rail from existing presets, health strip from existing `/api/stats` + preset counts, queue worklists = `/api/sims/query?preset=…` with reason strings composed client-side from row fields. Fleet tab keeps current Stage-1 grid untouched. Deploy to `dashboard-test`.
2. **Phase 2 — Dossier**: promote the Stage-1 drawer to the C layout (route `/sims/:id`, pinned/recent in localStorage, timeline filter chips, provenance block, type-to-confirm on vendor/host edits). Deploy to `dashboard-test`.
3. **Phase 3 — Fleet upgrades**: facet counts endpoint, bulk dry-run preview, scope sentence on bulk bar.
4. Each phase: operator review on `dashboard-test` before the next. **Prod (Stage 2 merge/deploy) only on explicit instruction.**

Estimated diff scope: phases 1–2 touch `src/dashboard/public/index.html` only.
