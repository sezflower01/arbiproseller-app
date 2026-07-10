-- Update tier_100: $19 → $9/mo, $15 → $7/mo annual, new Stripe price IDs, rename
UPDATE subscription_plans
SET monthly_price = 9,
    annual_price = 7,
    name = '100 Active Listings',
    stripe_price_id = 'price_1TJ39SHbbOMAX8kOotnWkfLX',
    stripe_annual_price_id = 'price_1TJ3A0HbbOMAX8kOFOVnsz5S'
WHERE id = 'tier_100';

-- Update tier_250: $29 → $19/mo, $24 → $16/mo annual, new Stripe price IDs, rename
UPDATE subscription_plans
SET monthly_price = 19,
    annual_price = 16,
    name = '250 Active Listings',
    stripe_price_id = 'price_1TJ39jHbbOMAX8kO7oLPNr5c',
    stripe_annual_price_id = 'price_1TJ3AEHbbOMAX8kOYc2aDaEY'
WHERE id = 'tier_250';

-- Rename remaining tiers from "ASINs" to "Active Listings"
UPDATE subscription_plans SET name = '500 Active Listings' WHERE id = 'tier_500';
UPDATE subscription_plans SET name = '1,000 Active Listings' WHERE id = 'tier_1000';
UPDATE subscription_plans SET name = '2,000 Active Listings' WHERE id = 'tier_2000';
UPDATE subscription_plans SET name = '3,000 Active Listings' WHERE id = 'tier_3000';
UPDATE subscription_plans SET name = '5,000 Active Listings' WHERE id = 'tier_5000';
UPDATE subscription_plans SET name = '10,000 Active Listings' WHERE id = 'tier_10000';
UPDATE subscription_plans SET name = '20,000 Active Listings' WHERE id = 'tier_20000';
UPDATE subscription_plans SET name = '50,000 Active Listings' WHERE id = 'tier_50000';