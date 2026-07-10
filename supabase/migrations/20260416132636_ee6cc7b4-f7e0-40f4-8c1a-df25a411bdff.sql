DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'historical_sync_checkpoints' AND policyname = 'Users can view own checkpoints'
  ) THEN
    CREATE POLICY "Users can view own checkpoints"
    ON public.historical_sync_checkpoints
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'historical_sync_checkpoints' AND policyname = 'Users can update own checkpoints'
  ) THEN
    CREATE POLICY "Users can update own checkpoints"
    ON public.historical_sync_checkpoints
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;