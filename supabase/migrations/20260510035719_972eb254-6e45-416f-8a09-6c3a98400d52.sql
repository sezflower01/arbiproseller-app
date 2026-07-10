CREATE TABLE IF NOT EXISTS public.product_analyzer_snapshot_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  snapshot JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_product_analyzer_snapshot_cache_lookup
  ON public.product_analyzer_snapshot_cache (user_id, asin, marketplace);

CREATE INDEX IF NOT EXISTS idx_product_analyzer_snapshot_cache_expires
  ON public.product_analyzer_snapshot_cache (expires_at);

ALTER TABLE public.product_analyzer_snapshot_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_analyzer_snapshot_cache'
      AND policyname = 'Users view own product analyzer cache'
  ) THEN
    CREATE POLICY "Users view own product analyzer cache"
      ON public.product_analyzer_snapshot_cache FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_analyzer_snapshot_cache'
      AND policyname = 'Users insert own product analyzer cache'
  ) THEN
    CREATE POLICY "Users insert own product analyzer cache"
      ON public.product_analyzer_snapshot_cache FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_analyzer_snapshot_cache'
      AND policyname = 'Users update own product analyzer cache'
  ) THEN
    CREATE POLICY "Users update own product analyzer cache"
      ON public.product_analyzer_snapshot_cache FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'product_analyzer_snapshot_cache'
      AND policyname = 'Users delete own product analyzer cache'
  ) THEN
    CREATE POLICY "Users delete own product analyzer cache"
      ON public.product_analyzer_snapshot_cache FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_product_analyzer_snapshot_cache_updated'
  ) THEN
    CREATE TRIGGER trg_product_analyzer_snapshot_cache_updated
      BEFORE UPDATE ON public.product_analyzer_snapshot_cache
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;