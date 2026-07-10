ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS auto_assign_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assign_rule_id uuid REFERENCES public.repricer_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_assign_require_price boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_assign_require_inbound boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assign_skip_existing boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_minmax_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_min_strategy text NOT NULL DEFAULT 'cost_buffer',
  ADD COLUMN IF NOT EXISTS auto_max_strategy text NOT NULL DEFAULT 'price_buffer',
  ADD COLUMN IF NOT EXISTS auto_min_buffer_pct numeric NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS auto_max_buffer_pct numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS auto_require_cost boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_skip_manual_minmax boolean NOT NULL DEFAULT true