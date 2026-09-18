-- Captured from PROD (Supabase project lzjqegxazqlktttyybth) on 2026-09-18 via
-- pg_get_functiondef(). Live in PROD, NO definition anywhere in the repo.
-- Additional missing function found during this audit; not on the original list.
--
-- Called by:
--   src/dashboard/index.js:8581 — POST /rest/v1/rpc/get_ledger_months
--
-- What it does: returns the distinct billing months present in billing_ledger,
-- newest first, as 'YYYY-MM' strings. The dashboard uses it to populate the
-- month picker on the billing view. Read-only.
--
-- TEST DRIFT: this function does NOT exist at all in the TEST project
-- (lwapudjjlwkskijefxdz) as of 2026-09-18.

CREATE OR REPLACE FUNCTION public.get_ledger_months()
 RETURNS TABLE(month text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT DISTINCT to_char(period_start, 'YYYY-MM') AS month
  FROM billing_ledger
  ORDER BY month DESC;
$function$;

-- Live PROD ACL: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.get_ledger_months() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ledger_months() TO anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_months() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ledger_months() TO service_role;
