CREATE TABLE public.cogs_adjustments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  label TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT cogs_adjustments_period_valid CHECK (period_end >= period_start)
);

CREATE INDEX idx_cogs_adjustments_user_period
  ON public.cogs_adjustments (user_id, period_start, period_end);

ALTER TABLE public.cogs_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own COGS adjustments"
  ON public.cogs_adjustments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own COGS adjustments"
  ON public.cogs_adjustments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own COGS adjustments"
  ON public.cogs_adjustments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own COGS adjustments"
  ON public.cogs_adjustments FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_cogs_adjustments_updated_at
  BEFORE UPDATE ON public.cogs_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();