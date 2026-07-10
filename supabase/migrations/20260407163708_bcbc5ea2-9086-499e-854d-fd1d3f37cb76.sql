
-- Create a sync lock table to prevent overlapping inventory syncs
CREATE TABLE IF NOT EXISTS public.sync_locks (
  lock_name TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Function to acquire a sync lock (returns true if acquired)
CREATE OR REPLACE FUNCTION public.acquire_sync_lock(
  p_lock_name TEXT,
  p_locked_by TEXT DEFAULT 'unknown',
  p_ttl_seconds INTEGER DEFAULT 600
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_expires_at TIMESTAMPTZ;
BEGIN
  v_expires_at := now() + (p_ttl_seconds || ' seconds')::interval;
  
  -- Delete expired locks first
  DELETE FROM sync_locks WHERE expires_at < now();
  
  -- Try to insert the lock
  INSERT INTO sync_locks (lock_name, locked_at, locked_by, expires_at)
  VALUES (p_lock_name, now(), p_locked_by, v_expires_at)
  ON CONFLICT (lock_name) DO NOTHING;
  
  -- Check if we got it
  RETURN EXISTS (
    SELECT 1 FROM sync_locks
    WHERE lock_name = p_lock_name AND locked_by = p_locked_by
  );
END;
$$;

-- Function to release a sync lock
CREATE OR REPLACE FUNCTION public.release_sync_lock(p_lock_name TEXT, p_locked_by TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM sync_locks WHERE lock_name = p_lock_name AND locked_by = p_locked_by;
END;
$$;
