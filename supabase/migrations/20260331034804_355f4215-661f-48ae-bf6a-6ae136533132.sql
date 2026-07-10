INSERT INTO subscription_plans (id, name, listing_limit, monthly_price, annual_price, sort_order) VALUES
  ('enterprise_5k', 'Enterprise 5K', 5000, 119, 99, 6),
  ('enterprise_10k', 'Enterprise 10K', 10000, 199, 169, 7),
  ('enterprise_20k', 'Enterprise 20K', 20000, 349, 299, 8),
  ('enterprise_30k', 'Enterprise 30K', 30000, 479, 409, 9),
  ('enterprise_40k', 'Enterprise 40K', 40000, 599, 509, 10),
  ('enterprise_50k', 'Enterprise 50K', 50000, 699, 599, 11)
ON CONFLICT (id) DO NOTHING;