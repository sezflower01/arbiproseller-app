
-- 1. Atomic lock acquisition RPC
-- Replaces the check-then-upsert pattern with a single server-side operation
CREATE OR REPLACE FUNCTION public.acquire_repricer_lock(
  p_user_id UUID,
  p_asin TEXT,
  p_marketplace TEXT,
  p_lock_owner TEXT,
  p_ttl_seconds INT DEFAULT 180
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_expires_at TIMESTAMPTZ;
  v_existing_owner TEXT;
BEGIN
  v_expires_at := now() + (p_ttl_seconds || ' seconds')::interval;
  
  -- Delete expired locks first (cheap, index-based)
  DELETE FROM repricer_asin_locks WHERE expires_at < now();
  
  -- Attempt atomic insert. If conflict, check owner.
  INSERT INTO repricer_asin_locks (user_id, asin, marketplace, lock_owner, locked_at, expires_at)
  VALUES (p_user_id, p_asin, p_marketplace, p_lock_owner, now(), v_expires_at)
  ON CONFLICT (user_id, asin, marketplace) DO UPDATE
    SET lock_owner = EXCLUDED.lock_owner,
        locked_at = EXCLUDED.locked_at,
        expires_at = EXCLUDED.expires_at
    WHERE repricer_asin_locks.lock_owner = EXCLUDED.lock_owner
       OR repricer_asin_locks.expires_at < now();
  
  -- Check if our lock is now in place
  SELECT lock_owner INTO v_existing_owner
  FROM repricer_asin_locks
  WHERE user_id = p_user_id AND asin = p_asin AND marketplace = p_marketplace;
  
  RETURN v_existing_owner = p_lock_owner;
END;
$$;

-- 2. Atomic lock release RPC
CREATE OR REPLACE FUNCTION public.release_repricer_lock(
  p_user_id UUID,
  p_asin TEXT,
  p_marketplace TEXT,
  p_lock_owner TEXT
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM repricer_asin_locks
  WHERE user_id = p_user_id
    AND asin = p_asin
    AND marketplace = p_marketplace
    AND lock_owner = p_lock_owner;
END;
$$;

-- 3. Release all locks for a given owner
CREATE OR REPLACE FUNCTION public.release_all_repricer_locks(
  p_user_id UUID,
  p_lock_owner TEXT
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM repricer_asin_locks
  WHERE user_id = p_user_id AND lock_owner = p_lock_owner;
END;
$$;
