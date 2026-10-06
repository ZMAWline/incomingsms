-- Serialize removals of active dashboard administrators across transactions.
-- The guard row also forces a serialization failure under REPEATABLE READ,
-- where an advisory lock alone could leave the transaction using stale counts.
CREATE TABLE IF NOT EXISTS public.dashboard_admin_guard (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO public.dashboard_admin_guard (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.dashboard_admin_guard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dashboard_admin_guard FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preserve_last_dashboard_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (SELECT count(*) FROM old_users WHERE role = 'admin' AND status = 'active')
       <= (SELECT count(*) FROM new_users WHERE role = 'admin' AND status = 'active') THEN
      RETURN NULL;
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM old_users WHERE role = 'admin' AND status = 'active') THEN
      RETURN NULL;
    END IF;
  END IF;

  -- All destructive admin statements contend on this one row. At READ
  -- COMMITTED, the count below sees the preceding holder's committed update.
  UPDATE public.dashboard_admin_guard SET revision = revision + 1 WHERE id = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dashboard_admin_guard_missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.dashboard_users WHERE role = 'admin' AND status = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'last_active_dashboard_admin';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.preserve_last_dashboard_admin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS preserve_last_dashboard_admin_update ON public.dashboard_users;
CREATE TRIGGER preserve_last_dashboard_admin_update
AFTER UPDATE ON public.dashboard_users
REFERENCING OLD TABLE AS old_users NEW TABLE AS new_users
FOR EACH STATEMENT EXECUTE FUNCTION public.preserve_last_dashboard_admin();

DROP TRIGGER IF EXISTS preserve_last_dashboard_admin_delete ON public.dashboard_users;
CREATE TRIGGER preserve_last_dashboard_admin_delete
AFTER DELETE ON public.dashboard_users
REFERENCING OLD TABLE AS old_users
FOR EACH STATEMENT EXECUTE FUNCTION public.preserve_last_dashboard_admin();
