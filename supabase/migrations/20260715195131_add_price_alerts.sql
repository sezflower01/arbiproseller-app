-- Price alerts: user sets a target Amazon price for an ASIN (via the
-- extension's What-if Amazon Price Simulator) and an arbitrary notify email.
-- The email address is NOT required to match the account's own email and
-- must be confirmed (click-through link) before it goes active, so the
-- feature can't be used to spam arbitrary strangers' inboxes.
CREATE TABLE IF NOT EXISTS public.price_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  target_price NUMERIC NOT NULL,
  direction TEXT NOT NULL DEFAULT 'at_or_below' CHECK (direction IN ('at_or_below', 'at_or_above')),
  notify_email TEXT NOT NULL,
  confirm_token UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation', 'active', 'fired', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  fired_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_price_seen NUMERIC
);

ALTER TABLE public.price_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own price alerts"
  ON public.price_alerts FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_price_alerts_active
  ON public.price_alerts (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_price_alerts_confirm_token
  ON public.price_alerts (confirm_token);

-- Hourly check — reuses the existing INTERNAL_SYNC_SECRET vault secret and
-- net.http_post pattern already established for full-inventory-refresh-2h.
SELECT cron.schedule(
  'check-price-alerts-hourly',
  '0 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/check-price-alerts',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-price-alerts-hourly', 'time', now()::text),
    timeout_milliseconds := 120000
  );
  $cron$
);
