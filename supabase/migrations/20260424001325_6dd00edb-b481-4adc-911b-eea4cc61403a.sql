-- Phase 7: Operational Cost Override Layer (audit fields)
-- Adds lightweight audit columns to inventory to formalize the existing override mechanism.
-- DOES NOT add a parallel manual_unit_cost column. inventory.cost remains the single
-- effective unit cost. unit_cost_manual remains the override flag.

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS manual_cost_updated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS manual_cost_source TEXT NULL;

COMMENT ON COLUMN public.inventory.manual_cost_updated_at IS
  'Phase 7: timestamp of the last manual unit-cost override. NULL when cost comes from purchase (created_listings).';
COMMENT ON COLUMN public.inventory.manual_cost_source IS
  'Phase 7: who/what set the manual override. Values: user | import | api. NULL when not overridden.';

-- Backfill: for existing manual overrides we don't know the original edit time,
-- so use updated_at as a best-effort historical anchor. Source defaults to 'user'.
UPDATE public.inventory
SET manual_cost_updated_at = COALESCE(manual_cost_updated_at, updated_at, now()),
    manual_cost_source = COALESCE(manual_cost_source, 'user')
WHERE unit_cost_manual = true
  AND manual_cost_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_manual_cost_user
  ON public.inventory (user_id)
  WHERE unit_cost_manual = true;
