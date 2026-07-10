
-- Phase 1: shared source-of-truth view for "active" Created Listings.
-- Combines Phase C validation gating with the ghost-inventory rule so no
-- caller has to open-code `.or('validation_status.is.null,validation_status.eq.ACTIVE')`
-- alongside its own ghost filter ever again.

-- Helper: pure validation gate (mirrors UI .or filter).
CREATE OR REPLACE FUNCTION public.is_active_created_listing(_validation_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT _validation_status IS NULL OR _validation_status = 'ACTIVE';
$$;

-- View: active_created_listings = validation-passing AND not a ghost (when inv row exists).
-- security_invoker so RLS on the underlying tables is preserved.
CREATE OR REPLACE VIEW public.active_created_listings
WITH (security_invoker = true) AS
SELECT cl.*
FROM public.created_listings cl
LEFT JOIN LATERAL (
  SELECT i.listing_status, i.sku, i.available, i.reserved, i.inbound, i.unfulfilled
  FROM public.inventory i
  WHERE i.user_id = cl.user_id
    AND i.asin    = cl.asin
    AND i.sku     = cl.sku
  LIMIT 1
) inv ON TRUE
WHERE public.is_active_created_listing(cl.validation_status)
  AND (
    inv.listing_status IS NULL  -- no matching inventory row → not a ghost
    OR NOT public.is_ghost_inventory_row(
      inv.listing_status,
      inv.sku,
      COALESCE(inv.available, 0)::numeric,
      COALESCE(inv.reserved, 0)::numeric,
      COALESCE(inv.inbound, 0)::numeric,
      COALESCE(inv.unfulfilled, 0)::numeric
    )
  );

GRANT SELECT ON public.active_created_listings TO authenticated, anon, service_role;

COMMENT ON VIEW public.active_created_listings IS
'Phase 1 single source of truth: created_listings rows that pass Phase C validation gating AND are not ghost inventory. All web/edge callers (repricer, NTBA, Shipment Builder, Print Label, Add Purchase, auto-assign-bulk, repricer-evaluate, update-amazon-price, ASIN inventory lookup, and both extensions) MUST read from here instead of duplicating the OR filter.';

COMMENT ON FUNCTION public.is_active_created_listing(text) IS
'Phase 1 helper: returns true when validation_status passes the Phase C gate (NULL or ACTIVE). Use in edge functions where a view join is awkward.';
