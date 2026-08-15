-- Seller Storefront Monitoring: user watches a specific Amazon seller ID,
-- system periodically re-pulls their storefront ASIN list (via Keepa, same
-- mechanism as seller-storefront-snapshot) and emails the user when new
-- ASINs appear. Modeled directly on price_alerts / check-price-alerts —
-- same double opt-in (arbitrary notify_email, confirm-first) so this can't
-- be used to spam a stranger's inbox.
CREATE TABLE IF NOT EXISTS public.seller_watchlist (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  seller_name TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  notify_email TEXT NOT NULL,
  confirm_token UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation', 'active', 'cancelled')),
  -- NULL means "not yet seeded" -- the first check-seller-watchlist run
  -- adopts the seller's current ASIN list as the baseline silently (no
  -- alert) instead of treating their entire existing catalog as new.
  known_asin_list JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_alert_at TIMESTAMPTZ
);

ALTER TABLE public.seller_watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own seller watches"
  ON public.seller_watchlist FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_seller_watchlist_active
  ON public.seller_watchlist (seller_id, marketplace) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_seller_watchlist_confirm_token
  ON public.seller_watchlist (confirm_token);
CREATE INDEX IF NOT EXISTS idx_seller_watchlist_user
  ON public.seller_watchlist (user_id);

-- One active/pending watch per user+seller+marketplace; re-subscribing
-- after a cancel is fine (excluded from the uniqueness check).
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_watchlist_unique_live
  ON public.seller_watchlist (user_id, seller_id, marketplace)
  WHERE status <> 'cancelled';

-- Hourly check, offset 15 minutes from check-price-alerts-hourly so the two
-- Keepa-consuming cron jobs don't both burst in the same :00 minute.
SELECT cron.schedule(
  'check-seller-watchlist-hourly',
  '15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-seller-watchlist',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-seller-watchlist-hourly', 'time', now()::text),
    timeout_milliseconds := 120000
  );
  $cron$
);
