-- Rename Wing Bill Verification → Billing Audit (vendor-agnostic, non-prorated).
-- Already applied via Supabase MCP on 2026-04-28; this file is for record-keeping.

ALTER TABLE public.wing_bill_uploads RENAME TO bill_audit_uploads;
ALTER TABLE public.wing_bill_lines RENAME TO bill_audit_lines;

ALTER INDEX IF EXISTS idx_wing_bill_lines_upload_id RENAME TO idx_bill_audit_lines_upload_id;
ALTER INDEX IF EXISTS idx_wing_bill_lines_iccid RENAME TO idx_bill_audit_lines_iccid;
ALTER INDEX IF EXISTS idx_wing_bill_lines_discrepancy RENAME TO idx_bill_audit_lines_discrepancy;

ALTER TABLE public.bill_audit_uploads
  ADD COLUMN IF NOT EXISTS vendor text NOT NULL DEFAULT 'wing';

ALTER TABLE public.bill_audit_lines
  ADD COLUMN IF NOT EXISTS vendor text NOT NULL DEFAULT 'wing',
  ADD COLUMN IF NOT EXISTS bypassed_plan_id text;

ALTER TABLE public.bill_audit_lines DROP COLUMN IF EXISTS billable_days;
ALTER TABLE public.bill_audit_lines DROP COLUMN IF EXISTS total_days;

CREATE INDEX IF NOT EXISTS idx_bill_audit_lines_plan_id
  ON public.bill_audit_lines(bypassed_plan_id);

GRANT ALL ON TABLE public.bill_audit_uploads TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.bill_audit_lines TO postgres, anon, authenticated, service_role;
