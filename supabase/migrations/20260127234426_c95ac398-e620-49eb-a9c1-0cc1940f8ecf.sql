-- =============================================
-- ADVANCED REPRICER SCHEMA
-- Phase 1: Tables for rules, assignments, competitor snapshots, and price actions
-- =============================================

-- ENUM types for strategy, floor source, and action status
CREATE TYPE repricer_strategy AS ENUM (
  'MATCH_LOWEST_FBA_MINUS',
  'MATCH_LOWEST_OVERALL_MINUS',
  'STAY_WITHIN_BUYBOX_RANGE',
  'BEAT_BUYBOX_MINUS',
  'BEAT_SPECIFIC_SELLER_MINUS',
  'MIN_PROFIT_GUARD'
);

CREATE TYPE repricer_floor_source AS ENUM (
  'manual',
  'cost_plus',
  'roi_based'
);

CREATE TYPE repricer_fulfillment_scope AS ENUM (
  'FBA',
  'FBM',
  'BOTH'
);

CREATE TYPE repricer_condition_scope AS ENUM (
  'New',
  'Used',
  'Any'
);

CREATE TYPE repricer_action_status AS ENUM (
  'queued',
  'applied',
  'failed',
  'skipped'
);

-- =============================================
-- 1. REPRICER_RULES - Define pricing strategies
-- =============================================
CREATE TABLE public.repricer_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  marketplaces TEXT[] NOT NULL DEFAULT ARRAY['US'],
  fulfillment_scope repricer_fulfillment_scope NOT NULL DEFAULT 'FBA',
  condition_scope repricer_condition_scope NOT NULL DEFAULT 'New',
  strategy repricer_strategy NOT NULL DEFAULT 'MATCH_LOWEST_FBA_MINUS',
  undercut_amount NUMERIC NOT NULL DEFAULT 0.01,
  min_price NUMERIC,
  min_profit NUMERIC,
  min_roi NUMERIC,
  max_price NUMERIC,
  floor_source repricer_floor_source NOT NULL DEFAULT 'manual',
  excluded_sellers TEXT[] DEFAULT ARRAY[]::TEXT[],
  target_seller_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  max_change_percent NUMERIC DEFAULT 10,
  min_change_threshold NUMERIC DEFAULT 0.01,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repricer_rules ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can manage their own repricer rules"
  ON public.repricer_rules
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for user lookups
CREATE INDEX idx_repricer_rules_user_id ON public.repricer_rules(user_id);

-- Trigger for updated_at
CREATE TRIGGER update_repricer_rules_updated_at
  BEFORE UPDATE ON public.repricer_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 2. REPRICER_ASSIGNMENTS - Link ASINs to rules
-- =============================================
CREATE TABLE public.repricer_assignments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  rule_id UUID REFERENCES public.repricer_rules(id) ON DELETE SET NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  min_price_override NUMERIC,
  max_price_override NUMERIC,
  last_evaluated_at TIMESTAMP WITH TIME ZONE,
  last_recommended_price NUMERIC,
  last_recommendation_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repricer_assignments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can manage their own repricer assignments"
  ON public.repricer_assignments
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_repricer_assignments_user_id ON public.repricer_assignments(user_id);
CREATE INDEX idx_repricer_assignments_asin ON public.repricer_assignments(asin);
CREATE INDEX idx_repricer_assignments_rule_id ON public.repricer_assignments(rule_id);
CREATE UNIQUE INDEX idx_repricer_assignments_unique ON public.repricer_assignments(user_id, asin, marketplace);

-- Trigger for updated_at
CREATE TRIGGER update_repricer_assignments_updated_at
  BEFORE UPDATE ON public.repricer_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- 3. REPRICER_COMPETITOR_SNAPSHOTS - Store competitor data from Rainforest
-- =============================================
CREATE TABLE public.repricer_competitor_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  buybox_price NUMERIC,
  buybox_is_fba BOOLEAN,
  buybox_seller_id TEXT,
  buybox_seller_name TEXT,
  lowest_fba_price NUMERIC,
  lowest_fbm_price NUMERIC,
  lowest_overall_price NUMERIC,
  offers_count INTEGER DEFAULT 0,
  offers_json JSONB DEFAULT '[]'::jsonb,
  credits_used INTEGER DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'rainforest',
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repricer_competitor_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can manage their own competitor snapshots"
  ON public.repricer_competitor_snapshots
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes for efficient lookups
CREATE INDEX idx_repricer_snapshots_user_asin_marketplace ON public.repricer_competitor_snapshots(user_id, asin, marketplace);
CREATE INDEX idx_repricer_snapshots_fetched_at ON public.repricer_competitor_snapshots(fetched_at DESC);
CREATE INDEX idx_repricer_snapshots_user_fetched ON public.repricer_competitor_snapshots(user_id, fetched_at DESC);

-- =============================================
-- 4. REPRICER_PRICE_ACTIONS - Log all pricing decisions
-- =============================================
CREATE TABLE public.repricer_price_actions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  old_price NUMERIC,
  new_price NUMERIC,
  rule_id UUID REFERENCES public.repricer_rules(id) ON DELETE SET NULL,
  reason TEXT,
  status repricer_action_status NOT NULL DEFAULT 'queued',
  error TEXT,
  snapshot_id UUID REFERENCES public.repricer_competitor_snapshots(id) ON DELETE SET NULL,
  applied_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repricer_price_actions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can manage their own price actions"
  ON public.repricer_price_actions
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_repricer_actions_user_id ON public.repricer_price_actions(user_id);
CREATE INDEX idx_repricer_actions_asin ON public.repricer_price_actions(asin);
CREATE INDEX idx_repricer_actions_created_at ON public.repricer_price_actions(created_at DESC);
CREATE INDEX idx_repricer_actions_status ON public.repricer_price_actions(status);

-- =============================================
-- 5. REPRICER_SETTINGS - User-level configuration
-- =============================================
CREATE TABLE public.repricer_settings (
  user_id UUID NOT NULL PRIMARY KEY,
  auto_apply BOOLEAN NOT NULL DEFAULT false,
  sp_api_check_interval_minutes INTEGER NOT NULL DEFAULT 30,
  rainforest_snapshot_ttl_minutes INTEGER NOT NULL DEFAULT 60,
  daily_credit_cap INTEGER NOT NULL DEFAULT 100,
  credits_used_today INTEGER NOT NULL DEFAULT 0,
  credits_reset_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repricer_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can manage their own repricer settings"
  ON public.repricer_settings
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER update_repricer_settings_updated_at
  BEFORE UPDATE ON public.repricer_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();