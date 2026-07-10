
DO $$
DECLARE v_uid uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9'; v_cleared int;
BEGIN
  UPDATE sales_orders
  SET fees_invalid = false
  WHERE user_id = v_uid
    AND fees_invalid = true
    AND COALESCE(sold_price, 0) > 0
    AND total_fees IS NOT NULL
    AND total_fees <= 0.70 * sold_price * COALESCE(quantity,1);
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  RAISE NOTICE 'stale_fees_invalid_cleared=%', v_cleared;

  PERFORM auto_resolve_business_health_issues(v_uid);
END $$;
