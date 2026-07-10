-- Per-user advisory lock helpers for auto-inventory-sync overlap protection.
-- Uses pg_try_advisory_lock with a stable bigint hash of the user_id (uuid).

CREATE OR REPLACE FUNCTION public.try_user_sync_lock(uid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key bigint;
BEGIN
  -- Stable hash uuid -> bigint. hashtextextended returns bigint.
  key := hashtextextended(uid::text, 0);
  RETURN pg_try_advisory_lock(key);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_user_sync_lock(uid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key bigint;
BEGIN
  key := hashtextextended(uid::text, 0);
  RETURN pg_advisory_unlock(key);
END;
$$;

-- Lock down: only service_role (used by edge functions) can call these.
REVOKE ALL ON FUNCTION public.try_user_sync_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_user_sync_lock(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_user_sync_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_user_sync_lock(uuid) TO service_role;