# Project Context

## Cross-profile context fallback

If this project profile is missing context, uncertain about recent history, or sees signs that past Telegram group work was handled by the main/default profile, it must ask the main/default profile for context before guessing. Keep the request specific: project, group/chat, date range, and the decision or task that needs clarification.

## Recent context backfill from default profile

**IMEI mismatch investigation & reprovisioning (2026-08-26 to 08-29)**
- Root cause found: prior IMEI audits used a static sheet export (single snapshot date), not real history — corrected by pulling from Supabase `carrier_api_logs` (query timestamps 2026-04-23 → 2026-08-26).
- Confirmed: IMEI list originally given to Teltik matched **billing IMEI** for 155/344 SIMs but **network IMEI for 0**. 156 matched neither; 33 were in cloud but missing from the given list.
- User generated a new IMEI list, had Shlomo/Teltik reprovision, then had Atomic side updated + OTA refresh run (`t_42d5fd02`) for 344 ICCID+IMEI pairs: **173 success, 145 fail, 26 skip**.
  - Dominant failure: Atomic error **948** `PricePlan/offeringCode Not Supported` — device/TAC not allowed under current plan/SOC. Retried one sample line, failed again with same error.
  - Live-verify of the 173 successful swaps: all 173 active on Atomic/carrier side, but only 61 fully online; 107 still offline at the Teltik host/port layer — likely needs a **Teltik port reset** for those 107.
- Key artifacts live under `/root/projects/incomingsms/imei-audit/` (audit CSVs, master history XLSX/CSV, cloud master report, comparison files, Shlomo pair files, retry/verify JSON+CSV/summary files).

**Hosting port check cron (2026-08-31)**
- Existing `su12h` cron (`0 */12 * * *`) only sweeps a rotating batch of **200 SIMs per run**, so with >1000 eligible SIMs a given line may only get checked every ~60h, not every 12h.
- User wants **all eligible hosted-active lines checked every 12h**, not capped at 200/run. Tracked as `t_ae1c1ec4`: remove the 200-per-run cap, use app-level fan-out/drain if needed, preserve provider-vs-host rules and history/logs, add a test proving >200 eligible SIMs are all attempted in one 12h cycle, open PR. Worker crashed once after ~1h and needs another run once the profile frees up.

**Atomic SIM → Google Sheet export (2026-08-31)**
- Task `t_0b74092c`: live read-only query of all Atomic SIMs, one row per SIM, every returned field its own column, plus Teltik hosted port status. Explicitly no carrier writes/activation/rotation/IMEI swap/reset/SMS/DB changes.
- Read-only CSV export completed (348 SIMs selected), but **Google Sheet creation is blocked — the incomingsms Hermes profile has no Google OAuth token**. User pointed out Google access should go through Composio instead — this is the open blocker to resolve.

**Weekly TrustOTP invoice (2026-08-28)**
- Kanban had marked it done, but no actual cron/runner for the weekly QuickBooks invoice was found in the repo. Follow-up task `t_81e68aff` opened to verify/fix the automation; status was unresolved as of last check.

**Operational notes**
- IncomingSMS project worker profile has a **per-profile cap of 1 running task**, so new tasks queue/defer behind whatever is currently running (observed with the Sheet export queuing behind the 12h-sweep fix, and vice versa).
- Google Sheet source for the reprovisioning IMEI list is under the **zmaw** Google account; sharing/permission issues have blocked direct Sheets API access before.
