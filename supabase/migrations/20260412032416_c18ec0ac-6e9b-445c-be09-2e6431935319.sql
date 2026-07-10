
-- Table to track per-user live verify scheduling
CREATE TABLE public.live_verify_schedule (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_runtime_seconds INTEGER,
  active_sku_count INTEGER DEFAULT 0,
  computed_interval_hours INTEGER NOT NULL DEFAULT 4,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  total_runs INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.live_verify_schedule ENABLE ROW LEVEL SECURITY;

-- Users can read their own schedule
CREATE POLICY "Users can view own verify schedule"
  ON public.live_verify_schedule
  FOR SELECT
  USING (auth.uid() = user_id);

-- Only service role can insert/update (edge functions)
CREATE POLICY "Service role manages verify schedule"
  ON public.live_verify_schedule
  FOR ALL
  USING (auth.role() = 'service_role');

-- Auto-update timestamp
CREATE TRIGGER update_live_verify_schedule_updated_at
  BEFORE UPDATE ON public.live_verify_schedule
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create schedule row when a user gets their first inventory
CREATE OR REPLACE FUNCTION public.fn_auto_create_verify_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.live_verify_schedule (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger on inventory insert to auto-create schedule
CREATE TRIGGER trg_auto_create_verify_schedule
  AFTER INSERT ON public.inventory
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_auto_create_verify_schedule();
