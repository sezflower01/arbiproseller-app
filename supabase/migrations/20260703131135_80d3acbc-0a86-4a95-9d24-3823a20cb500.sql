
-- SW1-guard: physical-plausibility hard reject on refund writes.
-- Independent of SW1-fix (aggregation dedup); safe to ship without reproduction.
-- Fires on INSERT and UPDATE of sales_orders. Rejects any write that would
-- CREATE or INCREASE refund_quantity beyond parent order's quantity, or
-- refund_amount beyond 1.5x parent total_sale_amount (generous tax/shipping margin).
--
-- Does NOT retroactively reject existing corrupted rows (Panduit, STIHL, 5-batch):
-- UPDATE writes are only blocked when refund_quantity or refund_amount would
-- INCREASE. Corrections/decreases are always allowed. Manual quarantine flips
-- (status='refund' vs 'settled') do not touch these columns and pass through.
--
-- Out-of-order sync (refund row lands before parent): allowed with NOTICE log,
-- not rejected — otherwise ingestion pipeline could deadlock on arrival order.

CREATE OR REPLACE FUNCTION public.refund_physical_plausibility_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parent_order_id TEXT;
  parent_qty NUMERIC;
  parent_total NUMERIC;
BEGIN
  -- Only guard rows that assert a refund (positive refund_quantity).
  IF NEW.refund_quantity IS NULL OR NEW.refund_quantity <= 0 THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only enforce when a refund field is being introduced or increased.
  -- Decreasing / correcting a previously-corrupted row must always be allowed.
  IF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.refund_quantity, 0) <= COALESCE(OLD.refund_quantity, 0)
       AND COALESCE(NEW.refund_amount, 0) <= COALESCE(OLD.refund_amount, 0) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Derive parent order_id (refund rows use "<order_id>-REFUND" convention).
  IF NEW.order_id LIKE '%-REFUND' THEN
    parent_order_id := regexp_replace(NEW.order_id, '-REFUND$', '');
  ELSE
    parent_order_id := NEW.order_id;
  END IF;

  -- Look up parent shipment row (same user + asin, non-refund).
  SELECT quantity, total_sale_amount
    INTO parent_qty, parent_total
  FROM public.sales_orders
  WHERE user_id = NEW.user_id
    AND order_id = parent_order_id
    AND asin = NEW.asin
    AND (refund_quantity IS NULL OR refund_quantity = 0)
  LIMIT 1;

  -- Out-of-order sync: parent hasn't arrived yet. Allow, don't block ingestion.
  IF parent_qty IS NULL THEN
    RAISE NOTICE 'refund_guard: no parent yet for order=% asin=% user=% — allowing (out-of-order sync)',
      parent_order_id, NEW.asin, NEW.user_id;
    RETURN NEW;
  END IF;

  -- HARD REJECT #1: refund_quantity > parent quantity (physical impossibility).
  IF NEW.refund_quantity > parent_qty THEN
    RAISE EXCEPTION 'refund_guard_qty_exceeds_parent: order=% asin=% refund_qty=% > parent_qty=% — write blocked (SW1-guard)',
      parent_order_id, NEW.asin, NEW.refund_quantity, parent_qty
      USING ERRCODE = 'check_violation';
  END IF;

  -- HARD REJECT #2: refund_amount > 1.5x parent total (allows tax + shipping + promo margin).
  IF NEW.refund_amount IS NOT NULL
     AND parent_total IS NOT NULL
     AND parent_total > 0
     AND NEW.refund_amount > parent_total * 1.5 THEN
    RAISE EXCEPTION 'refund_guard_amount_exceeds_parent: order=% asin=% refund_amount=% > 1.5x parent_total=% — write blocked (SW1-guard)',
      parent_order_id, NEW.asin, NEW.refund_amount, parent_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_refund_physical_plausibility_guard ON public.sales_orders;

CREATE TRIGGER trg_refund_physical_plausibility_guard
BEFORE INSERT OR UPDATE ON public.sales_orders
FOR EACH ROW
EXECUTE FUNCTION public.refund_physical_plausibility_guard();

COMMENT ON FUNCTION public.refund_physical_plausibility_guard() IS
  'SW1-guard: rejects any INSERT/UPDATE on sales_orders that would introduce or increase refund_quantity beyond parent order quantity, or refund_amount beyond 1.5x parent total. Corrections and decreases are always allowed. Out-of-order sync (parent not yet present) is allowed with a NOTICE. See .lovable/saas-readiness-tracker.md.';
