-- Reconciliation columns for the TrustOTP weekly invoice automation
-- (src/shared/trustotp-weekly-invoice.mjs). The automation creates AND sends
-- the invoice through the native `quickbooks` Worker, then reads the result
-- back; these columns let it identify, on the next run, exactly which QBO
-- invoice a week maps to and whether it has already been emailed, so a retry
-- can never create or send a duplicate.
--
-- Additive + nullable. Rows created before this migration (draft/CSV-download
-- invoices) have doc_number/email_status/sent_at = NULL.
ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS doc_number TEXT;
ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS email_status TEXT;
ALTER TABLE qbo_invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

COMMENT ON COLUMN qbo_invoices.doc_number IS 'QuickBooks Invoice.DocNumber, e.g. INV-20260821-20260827. Used as the cross-system duplicate-guard key.';
COMMENT ON COLUMN qbo_invoices.email_status IS 'QuickBooks Invoice.EmailStatus as of the last read-back (e.g. NotSet, EmailSent).';
COMMENT ON COLUMN qbo_invoices.sent_at IS 'When the automation successfully called /invoice/:id/send for this row. NULL until sent.';
