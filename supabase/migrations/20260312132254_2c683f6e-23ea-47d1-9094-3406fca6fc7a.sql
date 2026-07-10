
-- Lane budget tracking: store per-lane SP-API usage counters (reset daily)
ALTER TABLE public.repricer_settings
  ADD COLUMN IF NOT EXISTS sp_api_lane_usage jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sp_api_lane_usage_date text DEFAULT '';

-- Track stale promotion effectiveness on assignments
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS stale_promoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS stale_promoted_from text,
  ADD COLUMN IF NOT EXISTS stale_promotion_evaluated boolean DEFAULT false;
