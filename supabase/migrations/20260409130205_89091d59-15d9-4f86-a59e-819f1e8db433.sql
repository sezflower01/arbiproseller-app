-- Add preserved_since column to track when preservation started
ALTER TABLE public.inventory
ADD COLUMN preserved_since TIMESTAMPTZ DEFAULT NULL;

-- Backfill: for items currently in preserved state, set preserved_since to their last sync time
-- This ensures existing stuck items start their 48h countdown immediately
UPDATE public.inventory
SET preserved_since = last_inventory_sync_at
WHERE source IN ('preserved_db', 'history_restore')
  AND COALESCE(available, 0) + COALESCE(reserved, 0) > 0
  AND preserved_since IS NULL;

-- Index for efficient lookup of preserved items
CREATE INDEX idx_inventory_preserved_since ON public.inventory (preserved_since)
WHERE preserved_since IS NOT NULL;