
-- Track alert state per user/issue to prevent spamming
CREATE TABLE IF NOT EXISTS public.spapi_health_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_email TEXT,
  issue_type TEXT NOT NULL, -- 'invalid_grant' | 'invalid_client' | 'unauthorized' | 'forbidden' | 'missing_credentials' | 'other'
  error_message TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved'
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMPTZ,
  notify_count INT NOT NULL DEFAULT 0,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spapi_health_alerts_user_open
  ON public.spapi_health_alerts(user_id, status) WHERE status = 'open';

ALTER TABLE public.spapi_health_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view all spapi alerts" ON public.spapi_health_alerts;
CREATE POLICY "Admins can view all spapi alerts"
  ON public.spapi_health_alerts FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Users can view their own spapi alerts" ON public.spapi_health_alerts;
CREATE POLICY "Users can view their own spapi alerts"
  ON public.spapi_health_alerts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
