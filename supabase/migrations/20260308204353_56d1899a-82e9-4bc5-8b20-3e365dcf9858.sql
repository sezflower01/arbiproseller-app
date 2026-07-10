
-- Fix sync_traces RLS to allow service role (edge functions) to insert
-- The existing policy requires auth.uid() match which doesn't work for service role calls
DROP POLICY IF EXISTS "Service can insert sync traces" ON public.sync_traces;

-- Service role bypasses RLS, so we just need a policy for authenticated users
-- to insert their own traces (for client-side calls if any)
CREATE POLICY "Users can insert own sync traces"
  ON public.sync_traces FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Allow service role to update sync traces
CREATE POLICY "Users can update own sync traces"
  ON public.sync_traces FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
