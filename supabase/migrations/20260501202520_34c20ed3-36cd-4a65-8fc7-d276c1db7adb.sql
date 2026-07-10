-- Review queue for SKUs missing from the FBA Inventory Report
CREATE TABLE IF NOT EXISTS public.inventory_missing_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT NOT NULL,
  marketplace TEXT,
  prior_available INTEGER NOT NULL DEFAULT 0,
  prior_reserved INTEGER NOT NULL DEFAULT 0,
  prior_inbound INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  detection_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_review',
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_missing_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_missing_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_missing_review_user_status
  ON public.inventory_missing_review (user_id, status);

ALTER TABLE public.inventory_missing_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own missing-review rows"
  ON public.inventory_missing_review FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can update their own missing-review rows"
  ON public.inventory_missing_review FOR UPDATE
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can delete their own missing-review rows"
  ON public.inventory_missing_review FOR DELETE
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- Inserts come from edge functions using the service role; no insert policy needed.

CREATE TRIGGER trg_inventory_missing_review_updated_at
  BEFORE UPDATE ON public.inventory_missing_review
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();