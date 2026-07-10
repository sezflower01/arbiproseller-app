-- Delete duplicate orders, keeping only the most recent one for each (user_id, order_id)
-- This cleans up existing duplicates that were inserted before proper upsert handling
WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, order_id 
           ORDER BY updated_at DESC, created_at DESC
         ) as rn
  FROM sales_orders
)
DELETE FROM sales_orders
WHERE id IN (
  SELECT id FROM duplicates WHERE rn > 1
);