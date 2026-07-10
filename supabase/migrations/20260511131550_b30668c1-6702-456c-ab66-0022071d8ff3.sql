-- Shared "is this row a ghost?" rule. Single source of truth.
-- Ghost when ANY of:
--  * listing_status in ('NOT_IN_CATALOG','DELETED')
--  * sku starts with 'amzn.gr.' (Amazon-grading auto-SKUs are inherently ghost-prone;
--    callers that have live confirmation may bypass this view)
--  * total stock = 0 AND listing_status is not 'ACTIVE'
CREATE OR REPLACE FUNCTION public.is_ghost_inventory_row(
  p_listing_status text,
  p_sku text,
  p_available numeric,
  p_reserved numeric,
  p_inbound numeric,
  p_unfulfilled numeric
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    upper(coalesce(p_listing_status, '')) IN ('NOT_IN_CATALOG', 'DELETED')
    OR lower(coalesce(p_sku, '')) LIKE 'amzn.gr.%'
    OR (
      coalesce(p_available, 0)
      + coalesce(p_reserved, 0)
      + coalesce(p_inbound, 0)
      + coalesce(p_unfulfilled, 0) <= 0
      AND upper(coalesce(p_listing_status, '')) <> 'ACTIVE'
    );
$$;

-- Active inventory view — used by Repricer/Need to Buy Again/Shipment Builder/etc.
-- Note: "unfulfilled" doesn't exist on inventory; we treat it as 0.
CREATE OR REPLACE VIEW public.active_inventory AS
SELECT i.*
FROM public.inventory i
WHERE NOT public.is_ghost_inventory_row(
  i.listing_status,
  i.sku,
  i.available,
  i.reserved,
  i.inbound,
  0
);

-- Nightly ghost cleanup run log (admin-only).
CREATE TABLE IF NOT EXISTS public.ghost_cleanup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  checked integer NOT NULL DEFAULT 0,
  archived integer NOT NULL DEFAULT 0,
  skipped_active integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  marketplace text,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.ghost_cleanup_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read ghost_cleanup_runs" ON public.ghost_cleanup_runs;
CREATE POLICY "Admins can read ghost_cleanup_runs"
  ON public.ghost_cleanup_runs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS idx_ghost_cleanup_runs_started_at
  ON public.ghost_cleanup_runs (started_at DESC);
