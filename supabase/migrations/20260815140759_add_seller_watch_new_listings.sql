-- Find Source: persists each new ASIN detected by check-seller-watchlist so
-- the UI has a durable "New listings" feed to act on (the cron worker
-- previously only emailed and discarded this). Also tracks per-user monthly
-- Find Source usage as a cost-visibility counter -- this is intentionally a
-- user-triggered, per-click action (not automatic on every detection), so
-- cost scales with intentional use, not total listings discovered.
CREATE TABLE IF NOT EXISTS public.seller_watch_new_listings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  watch_id UUID NOT NULL REFERENCES public.seller_watchlist(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  asin TEXT NOT NULL,
  title TEXT,
  brand TEXT,
  image_url TEXT,
  upc TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'sourcing' lets the UI show a spinner if the user reloads mid-search.
  -- 'candidates_found' means a search ran and returned candidates the user
  -- hasn't manually confirmed yet -- only the user's own "Mark as source"
  -- click ever sets 'sourced', never the search itself.
  source_status TEXT NOT NULL DEFAULT 'unsourced'
    CHECK (source_status IN ('unsourced', 'sourcing', 'candidates_found', 'sourced', 'no_candidates')),
  -- Ranked candidates from the last find-source-candidates run (each with a
  -- capped confidence score -- never a "confirmed source").
  candidates JSONB,
  last_searched_at TIMESTAMPTZ,
  sourced_at TIMESTAMPTZ,
  -- Which candidate the USER manually picked as their source -- this is the
  -- user's own confirmation, the system never sets this on its own.
  sourced_candidate JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.seller_watch_new_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own new-listing rows"
  ON public.seller_watch_new_listings FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_seller_watch_new_listings_user
  ON public.seller_watch_new_listings (user_id, detected_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_watch_new_listings_unique
  ON public.seller_watch_new_listings (watch_id, asin);

-- Monthly Find Source usage counter, one row per user per calendar month.
-- Read-only to users (visibility only, no self-service reset); the
-- find-source-candidates function increments it with the service role.
CREATE TABLE IF NOT EXISTS public.find_source_usage (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  search_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month_key)
);

ALTER TABLE public.find_source_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own Find Source usage"
  ON public.find_source_usage FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage Find Source usage"
  ON public.find_source_usage FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
