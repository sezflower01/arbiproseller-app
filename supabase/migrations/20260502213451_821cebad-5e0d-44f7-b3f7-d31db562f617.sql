UPDATE public.subscription_plans SET monthly_price = v.m, annual_price = v.m
FROM (VALUES
  ('tier_100', 199),
  ('tier_250', 225),
  ('tier_500', 265),
  ('tier_1000', 340),
  ('tier_2000', 480),
  ('tier_5000', 880),
  ('tier_10000', 1480),
  ('tier_20000', 2580),
  ('tier_50000', 5680)
) AS v(id, m)
WHERE public.subscription_plans.id = v.id;