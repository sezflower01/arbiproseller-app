UPDATE public.sales_orders
SET order_type = 'Replacement',
    sold_price = 0,
    item_price = 0,
    shipping_price = 0,
    total_sale_amount = 0,
    referral_fee = 0,
    closing_fee = 0,
    estimated_price = 0,
    total_fees = ROUND((COALESCE(fba_fee, 0) + COALESCE(shipping_label_fee, 0))::numeric, 2),
    price_source = 'replacement_detected'
WHERE order_id = '113-5673336-6619445';