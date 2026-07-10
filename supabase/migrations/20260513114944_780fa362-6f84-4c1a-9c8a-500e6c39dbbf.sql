-- =============================================================
-- SECURITY HARDENING PASS — Phase 7
-- Closes 4 supabase_lov findings without breaking production.
-- =============================================================

-- ---------------------------------------------------------------
-- 1) asin_upload — restrict to admins only
-- ---------------------------------------------------------------
-- Drop existing permissive policies (names vary; use IF EXISTS)
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT polname FROM pg_policy WHERE polrelid = 'public.asin_upload'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.asin_upload', pol.polname);
  END LOOP;
END$$;

ALTER TABLE public.asin_upload ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asin_upload admins read"
ON public.asin_upload
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "asin_upload admins write"
ON public.asin_upload
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "asin_upload admins update"
ON public.asin_upload
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "asin_upload admins delete"
ON public.asin_upload
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------
-- 2) gmail_connections — hide token columns from client API
--    Client app only needs `email`. Edge functions use service_role
--    which is unaffected by column-level GRANTs.
-- ---------------------------------------------------------------
REVOKE SELECT (access_token, refresh_token, scope, token_expires_at)
  ON public.gmail_connections FROM authenticated;
REVOKE SELECT (access_token, refresh_token, scope, token_expires_at)
  ON public.gmail_connections FROM anon;

-- Re-grant the safe columns explicitly to authenticated so PostgREST exposes them
GRANT SELECT (id, user_id, email, created_at, updated_at)
  ON public.gmail_connections TO authenticated;

-- ---------------------------------------------------------------
-- 3) realtime.messages — enable RLS + authenticated-only subscriptions
--    Underlying table RLS still gates which rows a user actually sees
--    via postgres_changes. This blocks anonymous role from subscribing
--    to any topic.
-- ---------------------------------------------------------------
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated can use realtime" ON realtime.messages;
CREATE POLICY "authenticated can use realtime"
ON realtime.messages
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "authenticated can broadcast" ON realtime.messages;
CREATE POLICY "authenticated can broadcast"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (true);

-- ---------------------------------------------------------------
-- 4) keepa_daily_usage — restrict to admins (operational metrics)
-- ---------------------------------------------------------------
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT polname FROM pg_policy WHERE polrelid = 'public.keepa_daily_usage'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.keepa_daily_usage', pol.polname);
  END LOOP;
END$$;

ALTER TABLE public.keepa_daily_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "keepa_daily_usage admins read"
ON public.keepa_daily_usage
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Service role retains implicit full access; no INSERT/UPDATE policies
-- needed for client paths because writes happen via edge functions.
