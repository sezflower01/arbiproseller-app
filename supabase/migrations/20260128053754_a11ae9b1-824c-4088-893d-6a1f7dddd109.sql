-- Add snapshot_ttl_minutes to repricer_rules (per-rule TTL, default 6 hours)
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS snapshot_ttl_minutes INTEGER DEFAULT 360;

-- Add urgency tracking to repricer_assignments  
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS last_buybox_status TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS buybox_lost_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS snapshot_fetch_reason TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS min_fetch_interval_minutes INTEGER DEFAULT 60;

-- Add fetch tracking to repricer_competitor_snapshots
ALTER TABLE public.repricer_competitor_snapshots
  ADD COLUMN IF NOT EXISTS fetch_reason TEXT DEFAULT 'scheduled';

-- Create index for efficient TTL lookups
CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_ttl_lookup 
  ON public.repricer_competitor_snapshots(user_id, asin, marketplace, fetched_at DESC);

COMMENT ON COLUMN public.repricer_rules.snapshot_ttl_minutes IS 'How long competitor snapshots stay valid before refetch (default 6 hours = 360 min)';
COMMENT ON COLUMN public.repricer_assignments.last_buybox_status IS 'Tracks if we have/lost Buy Box for urgency triggers';
COMMENT ON COLUMN public.repricer_assignments.buybox_lost_at IS 'When Buy Box was lost, triggers urgent refetch';
COMMENT ON COLUMN public.repricer_assignments.snapshot_fetch_reason IS 'Why last fetch happened: ttl_expired, missing, urgent_buybox_lost, manual';
COMMENT ON COLUMN public.repricer_assignments.min_fetch_interval_minutes IS 'Hard throttle: no fetch more than once per this many minutes';