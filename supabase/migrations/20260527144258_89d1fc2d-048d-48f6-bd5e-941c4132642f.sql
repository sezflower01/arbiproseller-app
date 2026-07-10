
DO $$
DECLARE
  uid uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9';
  a_cleared int; b_cleared int; c_cleared int;
  before_count int; after_count int;
BEGIN
  SELECT COUNT(*) INTO before_count FROM sales_orders WHERE user_id=uid AND fees_invalid=true;

  -- Bucket A: learned_pollution (clear total_fees + requeue)
  WITH upd AS (
    UPDATE sales_orders
       SET total_fees = NULL,
           fba_fee = NULL,
           referral_fee = NULL,
           closing_fee = NULL,
           fees_invalid = false,
           fees_source = 'cleared:learned_pollution_2026_05',
           needs_fee_enrich = true,
           updated_at = now()
     WHERE user_id = uid
       AND fees_invalid = true
       AND settlement_date IS NULL
       AND fees_source ILIKE '%learn%'
     RETURNING 1
  ) SELECT COUNT(*) INTO a_cleared FROM upd;

  -- Bucket B: fees_api/from_cache + qty>1 (multiplication-bug fingerprint)
  WITH upd AS (
    UPDATE sales_orders
       SET total_fees = NULL,
           fba_fee = NULL,
           referral_fee = NULL,
           closing_fee = NULL,
           fees_invalid = false,
           fees_source = 'cleared:qty_gt1_multiplication_bug',
           needs_fee_enrich = true,
           updated_at = now()
     WHERE user_id = uid
       AND fees_invalid = true
       AND settlement_date IS NULL
       AND fees_source IN ('fees_api','from_cache')
       AND COALESCE(quantity,1) > 1
     RETURNING 1
  ) SELECT COUNT(*) INTO b_cleared FROM upd;

  -- Bucket C: refund rows (clear flag only, do NOT touch totals)
  WITH upd AS (
    UPDATE sales_orders
       SET fees_invalid = false,
           updated_at = now()
     WHERE user_id = uid
       AND fees_invalid = true
       AND order_id LIKE '%-REFUND'
     RETURNING 1
  ) SELECT COUNT(*) INTO c_cleared FROM upd;

  SELECT COUNT(*) INTO after_count FROM sales_orders WHERE user_id=uid AND fees_invalid=true;

  RAISE NOTICE 'before=% a=% b=% c=% after=%', before_count, a_cleared, b_cleared, c_cleared, after_count;

  -- Re-run health resolver so the dashboard reflects DB truth
  PERFORM public.auto_resolve_business_health_issues(uid);
END $$;
