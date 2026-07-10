ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS manual_cost_reason TEXT;

COMMENT ON COLUMN public.inventory.manual_cost_reason IS
  'Phase 7: optional short reason text captured when a user overrides unit cost (e.g. supplier price change, bulk discount, correcting error). Informational only — does not affect cost math.';