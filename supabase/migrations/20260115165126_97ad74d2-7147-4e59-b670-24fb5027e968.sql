-- Reset closing_fee to 0 for all pending/non-settled orders
-- These had incorrect $1.80 estimates applied before the fix
UPDATE sales_orders 
SET closing_fee = 0, updated_at = now()
WHERE (status IS NULL OR status != 'settled')
  AND closing_fee > 0;