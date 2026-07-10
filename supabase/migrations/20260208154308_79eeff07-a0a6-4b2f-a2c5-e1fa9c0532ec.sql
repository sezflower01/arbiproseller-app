-- Fix B07PPCC1BP: amazon_price was 218.1 (MXN unconverted), real US price is 5.61
UPDATE sales_orders 
SET sold_price = 5.61, 
    total_sale_amount = 5.61 * quantity,
    estimated_price = 5.61,
    referral_fee = ROUND((5.61 * quantity * 0.17)::numeric, 2),
    total_fees = ROUND((3.8 * quantity + 5.61 * quantity * 0.17)::numeric, 2),
    price_source = 'data_repair',
    updated_at = now()
WHERE asin = 'B07PPCC1BP' 
AND sold_price = 218.1
AND marketplace IS DISTINCT FROM 'MX';

-- Fix B0CSLVQN6V: amazon_price was 700 (MXN unconverted), real US price is 19
UPDATE sales_orders 
SET sold_price = 19, 
    total_sale_amount = 19 * quantity,
    estimated_price = 19,
    price_source = 'data_repair',
    updated_at = now()
WHERE asin = 'B0CSLVQN6V' 
AND sold_price = 700
AND marketplace IS DISTINCT FROM 'MX';

-- Also fix the inventory.amazon_price to prevent future contamination
-- These stored MXN values as if they were USD
UPDATE inventory 
SET amazon_price = NULL,
    updated_at = now()
WHERE asin IN ('B07PPCC1BP', 'B0CSLVQN6V', 'B007P1ZO94')
AND amazon_price > price * 5
AND price > 0;