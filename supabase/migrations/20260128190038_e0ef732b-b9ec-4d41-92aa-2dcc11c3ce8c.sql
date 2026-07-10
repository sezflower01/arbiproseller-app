-- Fix repricer assignment upsert: PostgREST ON CONFLICT requires a non-partial UNIQUE constraint
-- Current state has a partial unique index (WHERE sku IS NOT NULL), which does not satisfy ON CONFLICT(user_id,sku,marketplace)

BEGIN;

-- Ensure key columns are non-null (existing data already has no nulls)
ALTER TABLE public.repricer_assignments
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN sku SET NOT NULL,
  ALTER COLUMN marketplace SET NOT NULL;

-- Add a proper UNIQUE constraint for (user_id, sku, marketplace)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname='public'
      AND t.relname='repricer_assignments'
      AND c.contype='u'
      AND c.conname='repricer_assignments_user_sku_marketplace_key'
  ) THEN
    ALTER TABLE public.repricer_assignments
      ADD CONSTRAINT repricer_assignments_user_sku_marketplace_key
      UNIQUE (user_id, sku, marketplace);
  END IF;
END $$;

-- Drop the old partial unique index if it exists (no longer needed)
DROP INDEX IF EXISTS public.idx_repricer_assignments_unique;

COMMIT;