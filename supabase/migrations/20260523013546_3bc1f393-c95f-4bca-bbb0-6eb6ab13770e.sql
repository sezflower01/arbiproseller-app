-- Phase 5 passive capture: shipment outcome snapshots for future learning.
-- No UI, no reads from this table yet. Pure data collection.
CREATE TABLE IF NOT EXISTS public.shipment_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  draft_id TEXT,
  business_mode TEXT,
  box_count INTEGER,
  sku_count INTEGER,
  total_units INTEGER,
  identical_pct INTEGER,
  variance_pct INTEGER,
  max_delta_lb NUMERIC(8,2),
  placement_risk BOOLEAN,
  split_risk BOOLEAN,
  weight_warn BOOLEAN,
  -- Reserved for future user-entered outcome data; nullable today.
  actual_placement_fees NUMERIC(10,2),
  amazon_split_count INTEGER,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipment_outcomes_user_draft_uidx
  ON public.shipment_outcomes (user_id, draft_id)
  WHERE draft_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS shipment_outcomes_user_captured_idx
  ON public.shipment_outcomes (user_id, captured_at DESC);

ALTER TABLE public.shipment_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own shipment outcomes"
  ON public.shipment_outcomes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own shipment outcomes"
  ON public.shipment_outcomes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own shipment outcomes"
  ON public.shipment_outcomes FOR UPDATE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_shipment_outcomes_updated_at
  BEFORE UPDATE ON public.shipment_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();