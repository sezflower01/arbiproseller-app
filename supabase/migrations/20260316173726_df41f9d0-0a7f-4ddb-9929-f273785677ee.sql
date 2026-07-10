
CREATE TABLE public.repricer_reaction_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  our_price_change_at timestamptz NOT NULL,
  our_old_price numeric,
  our_new_price numeric,
  competitor_price_before numeric,
  competitor_price_after numeric,
  reaction_time_seconds integer,
  competitor_type text DEFAULT 'buybox',
  detected_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.repricer_reaction_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own reaction logs"
  ON public.repricer_reaction_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service role can insert reaction logs"
  ON public.repricer_reaction_log FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_reaction_log_user_asin ON public.repricer_reaction_log (user_id, asin, marketplace);
CREATE INDEX idx_reaction_log_detected ON public.repricer_reaction_log (detected_at DESC);
