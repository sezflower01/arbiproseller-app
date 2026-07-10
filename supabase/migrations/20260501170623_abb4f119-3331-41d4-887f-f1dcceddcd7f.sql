-- Phase 1: Manual cost overrides with effective dates
-- Append-only audit trail. Powers P&L (forward-only) and Repricer ROI floor.

CREATE TABLE public.asin_cost_overrides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  unit_cost NUMERIC(12, 4) NOT NULL CHECK (unit_cost >= 0),
  effective_from DATE NOT NULL,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asin_cost_overrides_unique_per_date UNIQUE (user_id, asin, effective_from)
);

-- Indexes for the resolver lookup pattern: (user, asin) ordered by effective_from desc
CREATE INDEX idx_asin_cost_overrides_lookup
  ON public.asin_cost_overrides (user_id, asin, effective_from DESC);

CREATE INDEX idx_asin_cost_overrides_user
  ON public.asin_cost_overrides (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security (append-only model)
-- ---------------------------------------------------------------------------
ALTER TABLE public.asin_cost_overrides ENABLE ROW LEVEL SECURITY;

-- Users can view their own overrides; admins can view all
CREATE POLICY "Users view own cost overrides"
  ON public.asin_cost_overrides
  FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'admin')
  );

-- Users can insert overrides only for themselves; admins can insert for anyone
CREATE POLICY "Users insert own cost overrides"
  ON public.asin_cost_overrides
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'admin')
  );

-- APPEND-ONLY: only admins can update (for corrections)
CREATE POLICY "Only admins can update cost overrides"
  ON public.asin_cost_overrides
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- APPEND-ONLY: only admins can delete (for corrections)
CREATE POLICY "Only admins can delete cost overrides"
  ON public.asin_cost_overrides
  FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- Resolver function
-- Returns the unit_cost from the most recent override where
-- effective_from <= on_date, or NULL when no override applies.
--
-- IMPORTANT: This function MUST be called AFTER any sales_orders.cost_of_goods
-- snapshot check. Snapshots are frozen — never override existing snapshots.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_cog_for_date(
  p_user_id UUID,
  p_asin TEXT,
  p_on_date DATE
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT unit_cost
  FROM public.asin_cost_overrides
  WHERE user_id = p_user_id
    AND asin = p_asin
    AND effective_from <= p_on_date
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.resolve_cog_for_date(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_cog_for_date(UUID, TEXT, DATE) TO service_role;

COMMENT ON TABLE public.asin_cost_overrides IS
  'Append-only manual cost overrides per ASIN with effective dates. Used by P&L (forward-only, never overrides snapshots) and Repricer ROI floor.';

COMMENT ON FUNCTION public.resolve_cog_for_date(UUID, TEXT, DATE) IS
  'Returns the unit_cost from the most recent override effective on or before p_on_date. MUST be called AFTER any sales_orders.cost_of_goods snapshot check — snapshots are frozen.';