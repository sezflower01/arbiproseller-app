-- Table-based lock for auto-inventory-sync (replaces session advisory lock).
CREATE TABLE IF NOT EXISTS public.auto_sync_locks (
  user_id     uuid PRIMARY KEY,
  locked_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

ALTER TABLE public.auto_sync_locks ENABLE ROW LEVEL SECURITY;
-- No policies = no anon/authenticated access. service_role bypasses RLS.

-- Drop old session-lock helpers (they were unreliable via PostgREST pooling).
DROP FUNCTION IF EXISTS public.try_user_sync_lock(uuid);
DROP FUNCTION IF EXISTS public.release_user_sync_lock(uuid);

CREATE OR REPLACE FUNCTION public.try_user_sync_lock(uid uuid, ttl_seconds int DEFAULT 600)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted boolean := false;
BEGIN
  -- Atomic: insert OR replace if existing lock has expired.
  WITH up AS (
    INSERT INTO public.auto_sync_locks (user_id, locked_at, expires_at)
    VALUES (uid, now(), now() + make_interval(secs => ttl_seconds))
    ON CONFLICT (user_id) DO UPDATE
      SET locked_at  = EXCLUDED.locked_at,
          expires_at = EXCLUDED.expires_at
      WHERE public.auto_sync_locks.expires_at < now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM up) INTO inserted;
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_user_sync_lock(uid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.auto_sync_locks WHERE user_id = uid;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.try_user_sync_lock(uuid, int)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_user_sync_lock(uuid)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_user_sync_lock(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_user_sync_lock(uuid)  TO service_role;

-- Clear any stale locks left over from the old advisory-lock approach.
DELETE FROM public.auto_sync_locks;