-- Add ignored column to roi_alerts for hiding checked alerts
ALTER TABLE public.roi_alerts 
ADD COLUMN IF NOT EXISTS ignored boolean NOT NULL DEFAULT false;

-- Add index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_roi_alerts_ignored ON public.roi_alerts(user_id, ignored) WHERE ignored = false;