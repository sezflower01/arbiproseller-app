-- Delete the incorrectly priced Canada order so it can be re-fetched with correct price
DELETE FROM sales_orders 
WHERE order_id = '701-6613435-3082665' 
  AND user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9';