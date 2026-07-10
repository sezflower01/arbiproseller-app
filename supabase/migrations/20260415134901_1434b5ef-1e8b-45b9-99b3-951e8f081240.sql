
-- Update plan names and pricing
UPDATE subscription_plans SET name = 'Starter', monthly_price = 19, annual_price = 16 WHERE id = 'tier_100';
UPDATE subscription_plans SET name = 'Growth', monthly_price = 45, annual_price = 37 WHERE id = 'tier_250';
UPDATE subscription_plans SET name = 'Scale', monthly_price = 85, annual_price = 71 WHERE id = 'tier_500';
UPDATE subscription_plans SET name = 'Pro', monthly_price = 160, annual_price = 133 WHERE id = 'tier_1000';
UPDATE subscription_plans SET name = 'Business', monthly_price = 300, annual_price = 249 WHERE id = 'tier_2000';
UPDATE subscription_plans SET name = 'Advanced', monthly_price = 700, annual_price = 581 WHERE id = 'tier_5000';
UPDATE subscription_plans SET name = 'Elite', monthly_price = 1300, annual_price = 1079 WHERE id = 'tier_10000';
UPDATE subscription_plans SET name = 'Enterprise', monthly_price = 2400, annual_price = 1992 WHERE id = 'tier_20000';
UPDATE subscription_plans SET name = 'Enterprise+', monthly_price = 5500, annual_price = 4565 WHERE id = 'tier_50000';

-- Remove tier_3000 (no longer in pricing)
DELETE FROM subscription_plans WHERE id = 'tier_3000';

-- Fix sort_order
UPDATE subscription_plans SET sort_order = 1 WHERE id = 'tier_100';
UPDATE subscription_plans SET sort_order = 2 WHERE id = 'tier_250';
UPDATE subscription_plans SET sort_order = 3 WHERE id = 'tier_500';
UPDATE subscription_plans SET sort_order = 4 WHERE id = 'tier_1000';
UPDATE subscription_plans SET sort_order = 5 WHERE id = 'tier_2000';
UPDATE subscription_plans SET sort_order = 6 WHERE id = 'tier_5000';
UPDATE subscription_plans SET sort_order = 7 WHERE id = 'tier_10000';
UPDATE subscription_plans SET sort_order = 8 WHERE id = 'tier_20000';
UPDATE subscription_plans SET sort_order = 9 WHERE id = 'tier_50000';
UPDATE subscription_plans SET sort_order = 99 WHERE id = 'unlimited';
