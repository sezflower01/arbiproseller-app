ALTER TABLE public.repricer_rules
ADD COLUMN IF NOT EXISTS strict_match_mode BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.repricer_rules.strict_match_mode IS 'When true, the engine forces final price to match the anchor exactly. Disables ALL undercut multipliers, AI win-sales boosters, intel adjustments, oscillation-mode undercuts, and minimum-undercut fallbacks. Also allows corrective raises back to anchor regardless of cooldown.';