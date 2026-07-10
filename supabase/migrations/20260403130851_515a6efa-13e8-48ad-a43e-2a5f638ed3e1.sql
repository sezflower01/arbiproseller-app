CREATE INDEX IF NOT EXISTS idx_rpa_user_marketplace_created
  ON public.repricer_price_actions (user_id, marketplace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rpa_sku
  ON public.repricer_price_actions (sku) WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rpa_rule_name
  ON public.repricer_price_actions (rule_name) WHERE rule_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rpa_action_type
  ON public.repricer_price_actions (action_type);