
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS stripe_product_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id text;

UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGp3ZfX5eQUzdf', stripe_price_id = 'price_1TIHPXHbbOMAX8kO7WRMtVGx' WHERE id = 'tier_100';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGp6Y6OjMH2C05', stripe_price_id = 'price_1TIHSbHbbOMAX8kOWZ6sITsq' WHERE id = 'tier_250';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpA4EDBDw5Ly9', stripe_price_id = 'price_1TIHWHHbbOMAX8kOFhy72xab' WHERE id = 'tier_500';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpDHEQZizln0i', stripe_price_id = 'price_1TIHYcHbbOMAX8kOjz0Xe43t' WHERE id = 'tier_1000';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpEFLWfvOOjiq', stripe_price_id = 'price_1TIHa2HbbOMAX8kOb6qc3eOr' WHERE id = 'tier_2000';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpFBheyLYYxMW', stripe_price_id = 'price_1TIHaaHbbOMAX8kO7KJKVZgw' WHERE id = 'tier_3000';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpFVn0JTjuazs', stripe_price_id = 'price_1TIHapHbbOMAX8kO83B0LDU8' WHERE id = 'tier_5000';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpFkNOsReMVQ9', stripe_price_id = 'price_1TIHb4HbbOMAX8kOUw5qbg8p' WHERE id = 'tier_10000';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpGRDjumfLZHJ', stripe_price_id = 'price_1TIHbYHbbOMAX8kOqu2Sq6jj' WHERE id = 'tier_20000';
UPDATE public.subscription_plans SET stripe_product_id = 'prod_UGpGP0cWvib3U1', stripe_price_id = 'price_1TIHbnHbbOMAX8kOhpVS01Yv' WHERE id = 'tier_50000';
