-- Tracks which signal actually decided primary_marketplace, so the UI can
-- be honest about it: real sales volume vs. the interim listing-count
-- fallback used before a brand-new account has enough sales history.
ALTER TABLE public.repricer_settings
  ADD COLUMN IF NOT EXISTS primary_marketplace_detection_method text;
