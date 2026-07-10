-- First insert new plans
INSERT INTO subscription_plans (id, name, listing_limit, monthly_price, annual_price, sort_order) VALUES
  ('tier_100',   '100 ASINs',    100,   19,  15, 1),
  ('tier_250',   '250 ASINs',    250,   29,  24, 2),
  ('tier_500',   '500 ASINs',    500,   49,  41, 3),
  ('tier_1000',  '1,000 ASINs', 1000,   79,  66, 4),
  ('tier_2000',  '2,000 ASINs', 2000,  129, 108, 5),
  ('tier_3000',  '3,000 ASINs', 3000,  179, 149, 6),
  ('tier_5000',  '5,000 ASINs', 5000,  249, 209, 7),
  ('tier_10000', '10,000 ASINs',10000,  399, 339, 8),
  ('tier_20000', '20,000 ASINs',20000,  599, 509, 9),
  ('tier_50000', '50,000 ASINs',50000,  999, 849, 10)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  listing_limit = EXCLUDED.listing_limit,
  monthly_price = EXCLUDED.monthly_price,
  annual_price = EXCLUDED.annual_price,
  sort_order = EXCLUDED.sort_order;

-- Update references BEFORE deleting old plans
UPDATE user_subscriptions SET plan_id = 'tier_1000' WHERE plan_id = 'starter';
UPDATE user_subscriptions SET plan_id = 'tier_2000' WHERE plan_id = 'growth';
UPDATE user_subscriptions SET plan_id = 'tier_3000' WHERE plan_id = 'pro';
UPDATE user_subscriptions SET plan_id = 'tier_5000' WHERE plan_id = 'advanced';
UPDATE user_subscriptions SET plan_id = 'tier_5000' WHERE plan_id = 'enterprise_5k';
UPDATE user_subscriptions SET plan_id = 'tier_10000' WHERE plan_id = 'enterprise_10k';
UPDATE user_subscriptions SET plan_id = 'tier_20000' WHERE plan_id = 'enterprise_20k';
UPDATE user_subscriptions SET plan_id = 'tier_50000' WHERE plan_id IN ('enterprise_30k', 'enterprise_40k', 'enterprise_50k');

UPDATE admin_subscription_override SET override_plan_id = 'tier_1000' WHERE override_plan_id = 'starter';
UPDATE admin_subscription_override SET override_plan_id = 'tier_2000' WHERE override_plan_id = 'growth';
UPDATE admin_subscription_override SET override_plan_id = 'tier_3000' WHERE override_plan_id = 'pro';
UPDATE admin_subscription_override SET override_plan_id = 'tier_5000' WHERE override_plan_id = 'advanced';
UPDATE admin_subscription_override SET override_plan_id = 'tier_5000' WHERE override_plan_id = 'enterprise_5k';
UPDATE admin_subscription_override SET override_plan_id = 'tier_10000' WHERE override_plan_id = 'enterprise_10k';
UPDATE admin_subscription_override SET override_plan_id = 'tier_20000' WHERE override_plan_id = 'enterprise_20k';
UPDATE admin_subscription_override SET override_plan_id = 'tier_50000' WHERE override_plan_id IN ('enterprise_30k', 'enterprise_40k', 'enterprise_50k');

-- NOW safe to delete old plans
DELETE FROM subscription_plans WHERE id IN ('starter', 'growth', 'pro', 'advanced', 'enterprise_5k', 'enterprise_10k', 'enterprise_20k', 'enterprise_30k', 'enterprise_40k', 'enterprise_50k');
