UPDATE sales_orders 
SET item_price = 19.90, sold_price = 19.90, total_sale_amount = 19.90, price_source = 'manual_correction', updated_at = now()
WHERE order_id = '113-6701359-2402657' AND asin = 'B00DWWER9I'