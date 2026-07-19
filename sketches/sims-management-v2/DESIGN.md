# Sims Management v2 — First-Principles Design Direction

**Date:** 2026-07-19 · **Branch:** `redesign/sims-table-v2` · **Status:** design exploration only — nothing here is implemented or deployed.

Prior context: the Stage-1 "sims v2" work (server-side query, record drawer, guarded edits) shipped to dashboard-test and was judged **too incremental — same design, patched**. This doc restarts from the data, the actions, and the operator's jobs, using the Double Diamond process. The current table layout is deliberately NOT an input, only the existing data model and action set are.

---

## 1. DISCOVER (Double Diamond, diamond 1, divergent)

### The raw material (facts, not UI)

**Data:** 5,344 SIMs. Two independent provenance axes that must never be conflated:
- **Service provider** (`vendor`): atomic (337) · wing_iot (270) · helix (625) · teltik (4,112) — who provides cell service.
- **Host** (`gateway_host`): skyline | teltik — whose server the SIM physically sits on. 310 active Atomic SIMs are Teltik-hosted.

Plus: identity (id, iccid, msisdn), lifecycle (status: provisioning/active/suspended/canceled/error + status_reason), placement (gateway/port/slot — skyline only), commercial link (reseller, mainly TrustOTP), rotation config/state, SMS liveness (sms_24h, last_sms_at), and four audit streams (sim_status_history, sim_edit_log, system_errors, webhook_deliveries).

**Actions:** rotate, suspend/restore, cancel/activate, assign/unassign reseller, rotation eligibility, guarded field correction (compare-and-set, audited), delete, OTA refresh, IMEI check, test SMS, Teltik reconcile.

**Attention signals already computable server-side:** any_error, stuck_provisioning, not_notified, not_rotated_today, no_reseller, auto_paused.

### Operator persona (ux-personas — single real user, not invented demographics)

**Zalmen — owner-operator.** Expert; runs the whole fleet alone; interleaves this work with everything else, so sessions are short and interrupt-driven. High domain knowledge, low patience for hunting through UI. Works after incidents (reseller reports line down) and proactively (morning health check). Deepest fear, evidenced by history: **the database silently becoming wrong** (SIM #639 vendor clobber) — trust in the data matters more than speed. Comfortable with keyboards, SQL, APIs; the dashboard must beat a psql session or it loses.

### Jobs to be done (ranked by frequency × stakes)

| # | Job | Frequency | Stakes |
|---|-----|-----------|--------|
| J1 | "Show me what's broken right now, and let me fix it item by item" (errors, stuck provisioning, not notified, line-down reports) | Daily | High — revenue/reseller trust |
| J2 | Find one specific SIM fast (by ICCID / number / id) and act on it | Daily | Medium |
| J3 | Investigate one SIM deeply: what touched it, when, by whom — then correct fields **safely** | Weekly, spikes after incidents | Very high — wrong correction = data damage |
| J4 | Bulk hygiene ops: assign reseller to a batch, rotate a set, suspend a set, delete junk rows | Weekly | High — bulk mistakes multiply |
| J5 | Reconcile reality vs DB (Teltik all-lines vs sims; Atomic-on-Teltik hosting) | After migrations/imports | High |
| J6 | Browse/slice inventory (counts by vendor/host/reseller/status) for planning | Occasional | Low |

### Journey map (journey-mapping — actor: Zalmen; scenario: "reseller says a line is down", today's flow)

| Phase | Action today | Mindset | Pain |
|---|---|---|---|
| Trigger | Reseller message with an MDN | "which SIM is this" | Search is one box on a huge table; must land on right tab first |
| Locate | Search, scan row | "is it even alive" | Liveness (sms_24h, last SMS) is 2 of 14 columns; signal buried |
| Diagnose | Open modal, click through 5 sub-tabs, maybe check Errors tab elsewhere | "what happened to it" | Evidence scattered across tabs/surfaces; no single timeline was the norm until Stage 1 |
| Fix | Pick from scattered buttons; confirm dialogs vary | "will this make it worse" | Emotional low point — actions feel riskier than they are, corrections feel safer than they are |
| Verify | Re-search, re-open, eyeball | "did it work" | No push feedback; must re-poll |

**Emotional low = Diagnose→Fix boundary.** The redesign should move the most design weight there.

## 2. DEFINE (diamond 1, convergent)

### Problem statement

> Zalmen needs to move from *signal* ("something is wrong with SIM X / N SIMs") to *verified fix* in one continuous surface, with the evidence trail and the safety rails in the same place as the action — because today diagnosis, action, and audit live in different UI locations, which is slow at best and (as SIM #639 proved) data-corrupting at worst.

### Design principles (derived, and used as judging criteria later)

1. **Attention before inventory.** The default view answers "what needs me?" — not "here are 5,344 rows". (cognitive-load: don't make the operator compute the worklist mentally.)
2. **Evidence next to action.** Any destructive/corrective control sits beside the timeline that justifies it. (ux-heuristics: recognition over recall; visibility of system status.)
3. **Provenance is bicameral.** Service provider and Host are two badges, two visual styles, everywhere a SIM identity appears. Never one column that could be misread as the other. (Root cause of the worst historical incident.)
4. **Corrections are guarded conversations, not writes.** Old→new named in the confirm; compare-and-set fails loudly; every change audited and visible in the timeline immediately. (ai-governors/trust-builders applied to automation too: import jobs are "agents" that must leave footprints and must not overwrite — the guard is already in the backend; the UI must *show* it.)
5. **Bulk = dry-run first.** Any multi-row action previews exact scope and per-row skips before commit. Reversible ops get undo; irreversible get typed confirmation. (Calibrated friction.)
6. **Keyboard-grade for an expert of one.** Palette, shortcuts, dense mode. (ux-heuristics: flexibility & efficiency of use.)
7. **Accessible by construction:** semantic controls, AA contrast, focus-visible, Esc-dismissable layers — cheap now, expensive later.

## 3. DEVELOP (diamond 2, divergent) — three deliberately different IAs

Same data, same actions, three different answers to "what is the primary object on screen?"

| | **A — Command Center** | **B — Power Grid** | **C — Investigator** |
|---|---|---|---|
| Primary object | **Work queue** (attention items with reasons + recommended actions) | **The grid itself** (dense, inline-editable, facet-filtered) | **One SIM's dossier** (unified timeline + guarded record card), master-detail |
| Serves best | J1 triage, J6 health glance | J4 bulk, J6 slicing, J2 find | J3 investigation, J2 find, J5 reconcile evidence |
| Weakest at | J4 heavy bulk, ad-hoc slicing | J1 (queue is just a saved view), J3 (peek strip, no dossier) | J4/J6 (list pane is narrow) |
| Character | Mission control: health strip → queues → process-next | Airtable/Linear-grade spreadsheet: facets, saved views, inline CAS edit, dry-run bulk | Case file: search-first left pane, timeline as hero, type-to-confirm corrections |

Files: `variant-a-command-center.html` · `variant-b-power-grid.html` · `variant-c-investigator.html` (self-contained, fake data, working interactions). See `README.md` for the comparison, scoring, and recommendation.

### Feature prioritization (feature-prioritization: operator impact × build effort, given Stage-1 backend already exists)

- **Do first:** attention queues over existing presets · unified timeline as record centerpiece · SP/Host bicameral badges · CAS edit dialog naming old→new · bulk dry-run preview.
- **Plan carefully:** inline cell editing (accident surface; needs CAS UX polish) · process-next triage mode · batch server endpoints (Stage 3 already planned).
- **Quick wins:** density toggle, saved-view chips, palette (exist from Stage 1 — restyle, don't rebuild).
- **Deprioritize:** row virtualization, facet counts on every filter (Stage-4 spec item), multi-operator sharing.

## 4. DELIVER (diamond 2, convergent) — planned, not executed

Gate: operator reviews the three sketches (open `index.html`) → pick a direction (or hybrid) → then an implementation plan targeting **dashboard-test only**, reusing the Stage-1 backend (`/api/sims/query`, `/api/sim-history`, `/api/update-sim`) which already supports all three IAs unchanged. No prod deploy without explicit instruction.
