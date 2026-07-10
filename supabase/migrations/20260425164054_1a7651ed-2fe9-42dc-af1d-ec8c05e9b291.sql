-- Reorder planning settings (per user) for Need to Buy Again
CREATE TABLE IF NOT EXISTS public.reorder_planning_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  coverage_days INTEGER NOT NULL DEFAULT 30 CHECK (coverage_days >= 0 AND coverage_days <= 365),
  supplier_lead_time_days INTEGER NOT NULL DEFAULT 7 CHECK (supplier_lead_time_days >= 0 AND supplier_lead_time_days <= 365),
  prep_days INTEGER NOT NULL DEFAULT 2 CHECK (prep_days >= 0 AND prep_days <= 90),
  shipping_to_amazon_days INTEGER NOT NULL DEFAULT 5 CHECK (shipping_to_amazon_days >= 0 AND shipping_to_amazon_days <= 90),
  amazon_receiving_days INTEGER NOT NULL DEFAULT 7 CHECK (amazon_receiving_days >= 0 AND amazon_receiving_days <= 90),
  safety_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (safety_percent >= 0 AND safety_percent <= 200),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.reorder_planning_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own reorder planning settings"
  ON public.reorder_planning_settings
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own reorder planning settings"
  ON public.reorder_planning_settings
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own reorder planning settings"
  ON public.reorder_planning_settings
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_reorder_planning_settings_updated_at
  BEFORE UPDATE ON public.reorder_planning_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();