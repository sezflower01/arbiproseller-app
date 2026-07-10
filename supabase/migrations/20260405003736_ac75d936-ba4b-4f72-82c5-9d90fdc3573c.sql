
-- User sync status table for tracking onboarding readiness
CREATE TABLE public.user_sync_status (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  amazon_connected BOOLEAN NOT NULL DEFAULT false,
  inventory_synced BOOLEAN NOT NULL DEFAULT false,
  fnsku_mapped BOOLEAN NOT NULL DEFAULT false,
  recent_sales_synced BOOLEAN NOT NULL DEFAULT false,
  fee_cache_seeded BOOLEAN NOT NULL DEFAULT false,
  repricer_ready BOOLEAN NOT NULL DEFAULT false,
  history_syncing BOOLEAN NOT NULL DEFAULT false,
  history_complete BOOLEAN NOT NULL DEFAULT false,
  pl_ready BOOLEAN NOT NULL DEFAULT false,
  inventory_sync_started_at TIMESTAMPTZ,
  inventory_sync_completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_sync_status ENABLE ROW LEVEL SECURITY;

-- Users can read their own sync status
CREATE POLICY "Users can read own sync status"
  ON public.user_sync_status FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Users can insert their own sync status
CREATE POLICY "Users can insert own sync status"
  ON public.user_sync_status FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own sync status
CREATE POLICY "Users can update own sync status"
  ON public.user_sync_status FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role can manage all (for edge functions)
CREATE POLICY "Service role full access"
  ON public.user_sync_status FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Auto-update updated_at
CREATE TRIGGER update_user_sync_status_updated_at
  BEFORE UPDATE ON public.user_sync_status
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
