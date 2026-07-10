CREATE POLICY "Users can delete their own setting changes"
  ON public.repricer_setting_changes
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);