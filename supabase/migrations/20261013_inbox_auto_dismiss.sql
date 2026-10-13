-- =========================================================
-- Operator inbox: auto-dismiss items whose problem is already gone.
--
-- Audit 2026-10-12: 1,467 open pending_review_items, none ever read. 1,402
-- were stale — the SIM was canceled, the SIM had rotated successfully since
-- the flag, or every report behind a bad-rental escalation was already
-- closed. The writers (details-finalizer, bad-rental-remediator) only ever
-- insert; nothing closed an item when its cause went away, so the real
-- problems were buried.
--
-- Why pg_cron and not a Worker: same reasoning as migration 010 — the
-- cleanup keeps running whether or not any Worker is deployed or has its
-- crons enabled.
--
-- Rules (an item is dismissed when its cause is gone, never by age):
--   1. SIM-linked item, SIM is canceled.
--   2. SIM-linked item, SIM is active, rotation_status = 'success', and its
--      MDN rotated after the item was created.
--   3. bad_rental_escalation whose operator_escalations row (linked by
--      paperclip_issue_id = 'inbox:<id>') lists no report still open
--      (received / in_triage).
-- Items on SIMs still in rotation_failed/error, or with an open report,
-- stay open. Status uses the table's existing vocabulary ('dismissed');
-- operator_response records which rule fired.
-- =========================================================

CREATE OR REPLACE FUNCTION public.dismiss_stale_review_items()
RETURNS integer
LANGUAGE sql
AS $$
  WITH stale AS (
    SELECT p.id,
           CASE WHEN s.status = 'canceled'
                THEN 'auto-dismissed: SIM canceled'
                ELSE 'auto-dismissed: SIM rotated successfully after this flag'
           END AS note
    FROM public.pending_review_items p
    JOIN public.sims s ON s.id = p.sim_id
    WHERE p.status = 'open'
      AND (s.status = 'canceled'
           OR (s.status = 'active'
               AND s.rotation_status = 'success'
               AND s.last_mdn_rotated_at > p.created_at))
    UNION ALL
    SELECT p.id, 'auto-dismissed: every report in this escalation is closed'
    FROM public.pending_review_items p
    JOIN public.operator_escalations oe ON oe.paperclip_issue_id = 'inbox:' || p.id
    WHERE p.status = 'open'
      AND p.kind = 'bad_rental_escalation'
      AND NOT EXISTS (
        SELECT 1 FROM public.rental_reports r
        WHERE r.id = ANY (oe.report_ids)
          AND r.status IN ('received', 'in_triage'))
  ),
  done AS (
    UPDATE public.pending_review_items p
    SET status = 'dismissed',
        resolved_at = now(),
        responded_by = 'auto-dismiss',
        operator_response = stale.note
    FROM stale
    WHERE p.id = stale.id AND p.status = 'open'
    RETURNING 1
  )
  SELECT count(*)::integer FROM done;
$$;

REVOKE ALL ON FUNCTION public.dismiss_stale_review_items() FROM PUBLIC, anon, authenticated;

-- Every 15 minutes, offset from sweep_stuck_rotations (*/15 on the quarter
-- hour). Re-running this migration re-points the job: pg_cron matches on
-- jobname.
SELECT cron.schedule(
  'dismiss-stale-review-items',
  '7-59/15 * * * *',
  $job$SELECT public.dismiss_stale_review_items();$job$
);
