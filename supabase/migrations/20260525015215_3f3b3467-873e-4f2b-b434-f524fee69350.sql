INSERT INTO public.repricer_assignments (user_id, asin, sku, marketplace, rule_id, is_enabled, fulfillment_type, item_condition, status)
VALUES ('020dd71f-78ce-4bc2-9117-dc997c533ab9','B0G15SJPW9','GNC-AK0-7ZU5','MX','60b80c70-51e9-4424-9fa5-14840984f4db', true, 'FBA','New','active')
ON CONFLICT (user_id, sku, marketplace) DO NOTHING;