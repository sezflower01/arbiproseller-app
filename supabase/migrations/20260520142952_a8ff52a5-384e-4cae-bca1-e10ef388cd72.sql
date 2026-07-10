-- Ghost audit columns on inventory: record WHY/HOW/WHEN a row was ghosted
-- so users can review historical ghosts and we never lose the reason again.
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS ghost_reason TEXT,
  ADD COLUMN IF NOT EXISTS ghosted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ghost_source TEXT,
  ADD COLUMN IF NOT EXISTS deleted_by UUID,
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT;

-- Partial index for fast "show ghosts" queries per user
CREATE INDEX IF NOT EXISTS idx_inventory_ghosts_per_user
  ON public.inventory (user_id, ghosted_at DESC)
  WHERE listing_status IN ('NOT_IN_CATALOG','DELETED') OR ghosted_at IS NOT NULL;

-- Backfill ghosted_at for existing tombstoned rows (best-effort: use updated_at)
UPDATE public.inventory
SET ghosted_at = COALESCE(ghosted_at, updated_at),
    ghost_reason = COALESCE(ghost_reason,
      CASE
        WHEN listing_status = 'NOT_IN_CATALOG' THEN 'not_in_catalog_legacy'
        WHEN listing_status = 'DELETED' THEN 'deleted_legacy'
        ELSE NULL
      END),
    ghost_source = COALESCE(ghost_source, 'backfill_2026_05_20')
WHERE listing_status IN ('NOT_IN_CATALOG','DELETED')
  AND ghosted_at IS NULL;
