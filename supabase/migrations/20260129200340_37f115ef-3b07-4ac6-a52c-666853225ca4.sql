-- Add production-readiness fields to repricer_assignments for error tracking and auto-pause
ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
ADD COLUMN IF NOT EXISTS last_error_type text,
ADD COLUMN IF NOT EXISTS last_error_message text,
ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS paused_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS pause_reason text,
ADD COLUMN IF NOT EXISTS last_failure_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS amazon_min_price numeric,
ADD COLUMN IF NOT EXISTS amazon_max_price numeric,
ADD COLUMN IF NOT EXISTS amazon_bounds_synced_at timestamp with time zone;

-- Add index for filtering by status
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_status ON public.repricer_assignments(status);

-- Add queue management fields to repricer_settings
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS queue_paused boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS queue_pause_reason text,
ADD COLUMN IF NOT EXISTS queue_paused_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS queue_auto_resume_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS queue_last_error_type text,
ADD COLUMN IF NOT EXISTS queue_last_error_message text,
ADD COLUMN IF NOT EXISTS queue_consecutive_failures integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS queue_last_failure_at timestamp with time zone;

-- Add error classification to repricer_price_actions for better tracking
ALTER TABLE public.repricer_price_actions
ADD COLUMN IF NOT EXISTS error_type text,
ADD COLUMN IF NOT EXISTS amazon_error_code text,
ADD COLUMN IF NOT EXISTS amazon_min_from_api numeric,
ADD COLUMN IF NOT EXISTS amazon_max_from_api numeric;

-- Create index for error type filtering
CREATE INDEX IF NOT EXISTS idx_repricer_price_actions_error_type ON public.repricer_price_actions(error_type);

-- Comment on new columns
COMMENT ON COLUMN public.repricer_assignments.status IS 'active, needs_attention, or paused';
COMMENT ON COLUMN public.repricer_assignments.last_error_type IS 'rate_limit, auth_expired, min_max_mismatch, price_rejected, listing_suppressed, unknown';
COMMENT ON COLUMN public.repricer_assignments.consecutive_failures IS 'Auto-pause after 5 consecutive failures';
COMMENT ON COLUMN public.repricer_assignments.amazon_min_price IS 'Min price bounds from Amazon (synced via Listings API)';
COMMENT ON COLUMN public.repricer_assignments.amazon_max_price IS 'Max price bounds from Amazon (synced via Listings API)';
COMMENT ON COLUMN public.repricer_settings.queue_paused IS 'If true, scheduler will not process any assignments';
COMMENT ON COLUMN public.repricer_settings.queue_pause_reason IS 'Why the queue is paused: rate_limit, auth_expired, too_many_failures, manual';