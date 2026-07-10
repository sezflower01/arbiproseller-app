-- Add audit columns to preserve original Amazon-reported sellable qty
-- when the user reclassifies sellable units as unsellable (e.g. restricted ASINs).
ALTER TABLE public.inventory_dispositions
  ADD COLUMN IF NOT EXISTS original_sellable_qty integer,
  ADD COLUMN IF NOT EXISTS original_unsellable_qty integer,
  ADD COLUMN IF NOT EXISTS reclassified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reclassified_reason text;