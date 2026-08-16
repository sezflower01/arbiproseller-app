-- Automatic Find Source for newly detected listings, with a user-controlled
-- daily ceiling.
--
-- WHY A CAP AT ALL: manual use has been ~17 searches/month. Under full
-- automation the rate becomes (watched sellers) x (how often they list), which
-- at 402 sellers plausibly lands anywhere between ~6 and ~115 detections/day
-- -- a 10x to 200x increase. Nobody can predict which, because the queue has
-- only completed its first rotation. An open-ended automation whose volume is
-- unknowable needs a ceiling its owner sets, not a hope that the rate is low.
--
-- WHY 40/DAY BY DEFAULT: Google Custom Search bills 100 queries/day free and
-- USD 0.005 each after that (confirmed 2026-08-16 in the Cloud console
-- pricing panel). A default under that line means automation cannot silently
-- start costing money, and cannot hit a hard 429 wall if the key's project has
-- no billing enabled. Raise it deliberately once the real detection rate is
-- known.
--
-- Each search also spends Gemini calls (a text verdict plus a vision compare
-- per verified candidate) and one price scrape, so the cap governs several
-- budgets at once, not just CSE.

CREATE TABLE IF NOT EXISTS public.auto_source_config (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  daily_cap integer NOT NULL DEFAULT 40 CHECK (daily_cap >= 0 AND daily_cap <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.auto_source_daily_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day date NOT NULL,
  search_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE public.auto_source_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auto_source_daily_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auto_source_config own" ON public.auto_source_config;
CREATE POLICY "auto_source_config own" ON public.auto_source_config
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "auto_source_config service" ON public.auto_source_config;
CREATE POLICY "auto_source_config service" ON public.auto_source_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Usage is readable by its owner (the UI shows remaining budget) but only the
-- worker may write it -- a client that could edit its own counter is not a cap.
DROP POLICY IF EXISTS "auto_source_usage own read" ON public.auto_source_daily_usage;
CREATE POLICY "auto_source_usage own read" ON public.auto_source_daily_usage
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "auto_source_usage service" ON public.auto_source_daily_usage;
CREATE POLICY "auto_source_usage service" ON public.auto_source_daily_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Claim N searches for today, atomically, refusing to exceed the cap.
-- Returns how many were actually granted, which may be fewer than requested
-- (or zero). Doing this in one statement is what makes the ceiling real:
-- two concurrent worker runs cannot each read "39 used" and both proceed.
CREATE OR REPLACE FUNCTION public.claim_auto_source_budget(
  p_user_id uuid,
  p_wanted integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap integer;
  v_enabled boolean;
  v_used integer;
  v_grant integer;
BEGIN
  SELECT enabled, daily_cap INTO v_enabled, v_cap
    FROM public.auto_source_config WHERE user_id = p_user_id;

  -- No row means the user has never configured it. Default to the table's own
  -- defaults rather than treating absence as "unlimited".
  IF NOT FOUND THEN
    INSERT INTO public.auto_source_config (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;
    SELECT enabled, daily_cap INTO v_enabled, v_cap
      FROM public.auto_source_config WHERE user_id = p_user_id;
  END IF;

  IF NOT COALESCE(v_enabled, false) THEN RETURN 0; END IF;

  INSERT INTO public.auto_source_daily_usage (user_id, day, search_count)
  VALUES (p_user_id, CURRENT_DATE, 0)
  ON CONFLICT (user_id, day) DO NOTHING;

  SELECT search_count INTO v_used
    FROM public.auto_source_daily_usage
   WHERE user_id = p_user_id AND day = CURRENT_DATE
     FOR UPDATE;

  v_grant := LEAST(GREATEST(p_wanted, 0), GREATEST(COALESCE(v_cap, 0) - COALESCE(v_used, 0), 0));
  IF v_grant <= 0 THEN RETURN 0; END IF;

  UPDATE public.auto_source_daily_usage
     SET search_count = COALESCE(search_count, 0) + v_grant,
         updated_at = now()
   WHERE user_id = p_user_id AND day = CURRENT_DATE;

  RETURN v_grant;
END;
$$;

-- Hand budget back when a claimed search did not actually run (worker ran out
-- of wall clock, listing vanished). Without this, a claim that never became a
-- search would quietly shrink the day's real allowance.
CREATE OR REPLACE FUNCTION public.release_auto_source_budget(
  p_user_id uuid,
  p_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(p_count, 0) <= 0 THEN RETURN; END IF;
  UPDATE public.auto_source_daily_usage
     SET search_count = GREATEST(COALESCE(search_count, 0) - p_count, 0),
         updated_at = now()
   WHERE user_id = p_user_id AND day = CURRENT_DATE;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_auto_source_budget(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_auto_source_budget(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_auto_source_budget(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_auto_source_budget(uuid, integer) TO service_role;

-- Find the listings still awaiting a first automatic search.
CREATE INDEX IF NOT EXISTS idx_new_listings_unsourced
  ON public.seller_watch_new_listings (user_id, detected_at DESC)
  WHERE source_status = 'unsourced';

-- Every 10 minutes, offset from check-seller-watchlist's `2-57/5` so the two
-- never start together. This is a SEPARATE worker on purpose: running the
-- search inside the seller sweep would spend that run's 90s budget on Gemini
-- and scraping instead of on Keepa seller checks, stalling the rotation
-- exactly when detection is most productive.
DO $$
BEGIN
  PERFORM cron.unschedule('auto-source-new-listings-10min');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'auto-source-new-listings-10min not scheduled, nothing to unschedule';
END $$;

SELECT cron.schedule(
  'auto-source-new-listings-10min',
  '6-56/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/auto-source-new-listings',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-auto-source-10min', 'time', now()::text),
    timeout_milliseconds := 120000
  );
  $cron$
);
