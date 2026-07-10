
CREATE TABLE public.repricer_setting_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  sku text,
  marketplace text NOT NULL DEFAULT 'US',
  change_type text NOT NULL DEFAULT 'manual',
  field_changed text NOT NULL,
  old_value numeric,
  new_value numeric,
  reason text,
  ip_address text,
  source text DEFAULT 'ui',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_repricer_setting_changes_user_id ON public.repricer_setting_changes(user_id);
CREATE INDEX idx_repricer_setting_changes_asin ON public.repricer_setting_changes(asin);
CREATE INDEX idx_repricer_setting_changes_created_at ON public.repricer_setting_changes(created_at DESC);

ALTER TABLE public.repricer_setting_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own setting changes"
  ON public.repricer_setting_changes
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own setting changes"
  ON public.repricer_setting_changes
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);
