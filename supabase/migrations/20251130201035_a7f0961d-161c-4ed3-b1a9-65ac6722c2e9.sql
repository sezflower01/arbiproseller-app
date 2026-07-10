-- Add flag to track manually edited unit cost
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS unit_cost_manual boolean DEFAULT false;

COMMENT ON COLUMN inventory.unit_cost_manual IS 'Flag to indicate if unit_cost was manually edited by user. When true, prevents automatic recalculation from amount/units formula.';