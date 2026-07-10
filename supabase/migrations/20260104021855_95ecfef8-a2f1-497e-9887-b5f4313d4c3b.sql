-- Enable write access for users to persist their own cached financial events
-- (required for fetch-profit-loss upsert into financial_events_cache)

ALTER TABLE public.financial_events_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- INSERT policy
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'financial_events_cache'
      AND policyname = 'Users can insert their own financial events'
  ) THEN
    CREATE POLICY "Users can insert their own financial events"
    ON public.financial_events_cache
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);
  END IF;

  -- UPDATE policy
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'financial_events_cache'
      AND policyname = 'Users can update their own financial events'
  ) THEN
    CREATE POLICY "Users can update their own financial events"
    ON public.financial_events_cache
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
  END IF;

  -- DELETE policy (optional cleanup)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'financial_events_cache'
      AND policyname = 'Users can delete their own financial events'
  ) THEN
    CREATE POLICY "Users can delete their own financial events"
    ON public.financial_events_cache
    FOR DELETE
    USING (auth.uid() = user_id);
  END IF;
END $$;