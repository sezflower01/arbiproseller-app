-- =====================================================================
-- Milestone B: Strategy Engine
-- =====================================================================

-- 1. Strategy state enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'repricer_strategy_state') THEN
    CREATE TYPE public.repricer_strategy_state AS ENUM (
      'profit_max',
      'competitive_recovery',
      'inventory_liquidation',
      'buybox_defense',
      'velocity_boost',
      'aged_pressure',
      'clearance'
    );
  END IF;
END$$;

-- 2. Strategy states table
CREATE TABLE IF NOT EXISTS public.repricer_strategy_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace_id text NOT NULL DEFAULT 'ATVPDKIKX0DER',
  state public.repricer_strategy_state NOT NULL DEFAULT 'profit_max',
  reason_business text,
  reason_technical text,
  signals jsonb DEFAULT '{}'::jsonb,
  entered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repricer_strategy_states_user_asin_mp UNIQUE (user_id, asin, marketplace_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_states_user_state ON public.repricer_strategy_states (user_id, state);
CREATE INDEX IF NOT EXISTS idx_strategy_states_expires ON public.repricer_strategy_states (expires_at);

ALTER TABLE public.repricer_strategy_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own strategy states" ON public.repricer_strategy_states;
CREATE POLICY "Users can view own strategy states"
  ON public.repricer_strategy_states FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own strategy states" ON public.repricer_strategy_states;
CREATE POLICY "Users can insert own strategy states"
  ON public.repricer_strategy_states FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own strategy states" ON public.repricer_strategy_states;
CREATE POLICY "Users can update own strategy states"
  ON public.repricer_strategy_states FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access strategy states" ON public.repricer_strategy_states;
CREATE POLICY "Service role full access strategy states"
  ON public.repricer_strategy_states FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- 3. Per-rule opt-in for dynamic floor relaxation (default OFF)
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS enable_dynamic_floor_relaxation boolean NOT NULL DEFAULT false;

-- 4. New audit columns on eval acks
ALTER TABLE public.repricer_eval_acks
  ADD COLUMN IF NOT EXISTS reason_business text,
  ADD COLUMN IF NOT EXISTS strategy_state public.repricer_strategy_state,
  ADD COLUMN IF NOT EXISTS floor_used numeric,
  ADD COLUMN IF NOT EXISTS floor_relaxed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS floor_relaxed_reason text,
  ADD COLUMN IF NOT EXISTS before_price numeric,
  ADD COLUMN IF NOT EXISTS target_price numeric;

CREATE INDEX IF NOT EXISTS idx_eval_acks_strategy_state ON public.repricer_eval_acks (user_id, strategy_state);

-- 5. Helper: translate engine code → business language
CREATE OR REPLACE FUNCTION public.repricer_translate_reason(_reason text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _reason IS NULL THEN NULL
    WHEN _reason ~* 'AT_MIN_FLOOR|MIN_FLOOR|clamped to Min floor|at floor' THEN 'Hit your minimum price'
    WHEN _reason ~* 'PROFIT_GUARD|MIN_PROFIT' THEN 'Profit protection active'
    WHEN _reason ~* 'ROI_GUARD|MIN_ROI' THEN 'ROI protection active'
    WHEN _reason ~* 'OSCILLATION_DETECTED|RAPID_PRICE_INSTABILITY' THEN 'Market is unstable — pausing changes'
    WHEN _reason ~* 'BB_OWNER_HOLD|Buy Box Owner Protection|Buy Box Suppressed' THEN 'You own the Buy Box — holding price'
    WHEN _reason ~* 'BUYBOX_SUPPRESSED' THEN 'Amazon hid the Buy Box'
    WHEN _reason ~* 'No eligible competitors|NO_COMPETITORS' THEN 'No competitors to react to'
    WHEN _reason ~* 'NOT_BB_ELIGIBLE|not buy box eligible' THEN 'Not Buy Box eligible right now'
    WHEN _reason ~* 'MARKET_STABLE|Market stable' THEN 'Market is calm — no change needed'
    WHEN _reason ~* 'DELTA_TOO_SMALL|delta too small|below threshold|too small' THEN 'Change too small to matter'
    WHEN _reason ~* 'MONOPOLY_COOLDOWN' THEN 'Cooling down (no competition)'
    WHEN _reason ~* 'COOLDOWN' THEN 'Cooling down after a recent change'
    WHEN _reason ~* 'SAFEGUARD|Safeguard' THEN 'Safety limit applied'
    WHEN _reason ~* 'INVENTORY_PRESSURE|inventory_pressure' THEN 'Adjusting for slow-moving inventory'
    WHEN _reason ~* 'changed' THEN 'Price updated'
    WHEN _reason ~* 'AMAZON_(MIN|MAX)_PRICE_BLOCK' THEN 'Amazon Automate Pricing limit hit — adjust limits in Seller Central'
    ELSE _reason
  END;
$$;

-- 6. Trigger to auto-fill reason_business if caller didn't
CREATE OR REPLACE FUNCTION public.repricer_eval_acks_autofill_business_reason()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.reason_business IS NULL AND NEW.reason IS NOT NULL THEN
    NEW.reason_business := public.repricer_translate_reason(NEW.reason);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_eval_acks_autofill_business ON public.repricer_eval_acks;
CREATE TRIGGER trg_eval_acks_autofill_business
  BEFORE INSERT OR UPDATE OF reason ON public.repricer_eval_acks
  FOR EACH ROW
  EXECUTE FUNCTION public.repricer_eval_acks_autofill_business_reason();

-- 7. Lookup helper (used by evaluator)
CREATE OR REPLACE FUNCTION public.get_active_strategy_state(
  _user_id uuid,
  _asin text,
  _marketplace_id text DEFAULT 'ATVPDKIKX0DER'
)
RETURNS public.repricer_strategy_state
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT state FROM public.repricer_strategy_states
      WHERE user_id = _user_id
        AND asin = _asin
        AND marketplace_id = _marketplace_id
        AND expires_at > now()
      LIMIT 1
    ),
    'profit_max'::public.repricer_strategy_state
  );
$$;

-- 8. Floor relaxation factor — strict, bounded, safe.
-- Returns a multiplier (0.85 - 1.00) applied ONLY to the manual_min_price portion.
-- Hard floor MAX($5, roiFloor) is enforced separately in evaluator code.
CREATE OR REPLACE FUNCTION public.repricer_floor_relaxation_factor(
  _state public.repricer_strategy_state,
  _days_since_sale integer DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE _state
    WHEN 'aged_pressure'         THEN 0.95   -- 5 % softer
    WHEN 'inventory_liquidation' THEN 0.92   -- 8 %
    WHEN 'velocity_boost'        THEN 0.93   -- 7 %
    WHEN 'clearance'             THEN 0.85   -- 15 % (max relaxation)
    ELSE 1.00                                -- profit_max / recovery / defense → no change
  END;
$$;

-- 9. Cooldown multiplier helper (advisory — evaluator may use)
CREATE OR REPLACE FUNCTION public.repricer_cooldown_multiplier(_state public.repricer_strategy_state)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE _state
    WHEN 'competitive_recovery'  THEN 0.5  -- react twice as fast
    WHEN 'velocity_boost'        THEN 0.6
    WHEN 'buybox_defense'        THEN 0.7
    WHEN 'clearance'             THEN 0.5
    WHEN 'aged_pressure'         THEN 0.8
    WHEN 'inventory_liquidation' THEN 0.7
    ELSE 1.00
  END;
$$;

-- 10. Updated_at trigger
CREATE OR REPLACE FUNCTION public.repricer_strategy_states_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_strategy_states_touch ON public.repricer_strategy_states;
CREATE TRIGGER trg_strategy_states_touch
  BEFORE UPDATE ON public.repricer_strategy_states
  FOR EACH ROW EXECUTE FUNCTION public.repricer_strategy_states_touch();