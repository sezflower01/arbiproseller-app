-- Fix financial_events_cache upsert conflicts by normalizing NULL keys to empty strings
-- and removing the expression-based unique index that conflicts with Supabase upsert onConflict.

-- 1) Normalize key columns
ALTER TABLE public.financial_events_cache
  ALTER COLUMN amazon_order_id SET DEFAULT '',
  ALTER COLUMN asin SET DEFAULT '';

UPDATE public.financial_events_cache SET amazon_order_id = '' WHERE amazon_order_id IS NULL;
UPDATE public.financial_events_cache SET asin = '' WHERE asin IS NULL;

ALTER TABLE public.financial_events_cache
  ALTER COLUMN amazon_order_id SET NOT NULL,
  ALTER COLUMN asin SET NOT NULL;

-- 2) Drop expression unique index (cannot be targeted by onConflict)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND tablename='financial_events_cache'
      AND indexname='idx_financial_events_unique'
  ) THEN
    EXECUTE 'DROP INDEX public.idx_financial_events_unique';
  END IF;
END $$;

-- 3) Ensure we have a single unique constraint usable by upsert
DO $$
BEGIN
  -- If the earlier unique constraint exists, keep it; otherwise create it.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'financial_events_cache_unique_key'
      AND conrelid = 'public.financial_events_cache'::regclass
  ) THEN
    ALTER TABLE public.financial_events_cache
      ADD CONSTRAINT financial_events_cache_unique_key
      UNIQUE (user_id, event_type, event_date, amazon_order_id, asin);
  END IF;
END $$;