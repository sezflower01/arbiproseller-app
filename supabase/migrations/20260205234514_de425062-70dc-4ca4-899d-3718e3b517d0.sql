UPDATE public.sales_orders
SET order_type = 'Replacement',
    sold_price = 0,
    item_price = 0,
    shipping_price = 0,
    total_sale_amount = 0,
    referral_fee = 0,
    closing_fee = 0,
    total_fees = ROUND((COALESCE(fba_fee, 0) + COALESCE(shipping_label_fee, 0))::numeric, 2),
    price_source = 'replacement_detected'
WHERE id = '1cca3072-5c43-4491-997e-eadcdc40389e';