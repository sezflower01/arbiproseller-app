ALTER TABLE public.repricer_rules DROP CONSTRAINT IF EXISTS check_oscillation_mode;

ALTER TABLE public.repricer_rules
ADD CONSTRAINT check_oscillation_mode
CHECK (oscillation_mode IN ('auto', 'safe', 'balanced', 'aggressive'));