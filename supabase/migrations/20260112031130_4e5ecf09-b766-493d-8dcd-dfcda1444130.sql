-- Delete numbered refund duplicates (-REFUND-1, -REFUND-2, etc.)
-- These were created by a bug and duplicate the -REFUND records
DELETE FROM sales_orders 
WHERE order_id ~ '-REFUND-[0-9]+$';

-- Clear refund fields on original orders where a -REFUND record exists
-- This prevents double-counting refunds
UPDATE sales_orders AS orig
SET 
  refund_quantity = 0,
  refund_amount = 0,
  updated_at = now()
WHERE 
  orig.refund_quantity > 0
  AND orig.order_id NOT LIKE '%-REFUND%'
  AND EXISTS (
    SELECT 1 FROM sales_orders AS ref
    WHERE ref.order_id LIKE orig.order_id || '-REFUND%'
    AND ref.user_id = orig.user_id
  );