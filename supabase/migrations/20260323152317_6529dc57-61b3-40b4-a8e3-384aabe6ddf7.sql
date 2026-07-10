-- Step 1: Preserve current min_price as manual_min_price baseline (only where not already set)
UPDATE public.repricer_assignments
SET manual_min_price = min_price_override
WHERE status = 'active'
  AND is_enabled = true
  AND marketplace = 'US'
  AND min_price_override IS NOT NULL
  AND manual_min_price IS NULL
  AND rule_id IS NOT NULL;

-- Step 2: Enable auto_lower_min_price for Momentum Builder US assignments with valid cost basis
UPDATE public.repricer_assignments ra
SET auto_lower_min_price = true
WHERE ra.status = 'active'
  AND ra.is_enabled = true
  AND ra.marketplace = 'US'
  AND ra.min_price_override IS NOT NULL
  AND ra.rule_id IS NOT NULL
  AND ra.auto_lower_min_price = false
  AND EXISTS (
    SELECT 1 FROM public.inventory i
    WHERE i.asin = ra.asin
      AND i.user_id = ra.user_id
      AND i.cost IS NOT NULL
      AND i.cost > 0
  );