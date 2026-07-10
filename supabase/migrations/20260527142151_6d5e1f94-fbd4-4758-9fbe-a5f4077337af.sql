
-- Clear fees_invalid on rows that were flagged purely against estimated_price
-- (sold_price=0). New guard only fires when sold_price>0, so these rows do
-- not satisfy the invalid condition anymore. Rows with sold_price>0 and
-- genuinely high fees stay flagged — they are real.
DO $$
DECLARE v_uid uuid := '020dd71f-78ce-4bc2-9117-dc997c533ab9'; v_cleared int;
BEGIN
  UPDATE sales_orders
  SET fees_invalid = false
  WHERE user_id = v_uid
    AND fees_invalid = true
    AND COALESCE(sold_price, 0) = 0;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  RAISE NOTICE 'fees_invalid_cleared_estimate_only=%', v_cleared;

  PERFORM auto_resolve_business_health_issues(v_uid);
END $$;
