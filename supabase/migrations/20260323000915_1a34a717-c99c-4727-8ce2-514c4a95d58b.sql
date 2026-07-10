
-- Suggestion log table for applied/skipped suggestion audit trail
CREATE TABLE public.repricer_suggestion_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  rule_name TEXT,
  assignment_id UUID,
  old_min NUMERIC,
  suggested_min NUMERIC,
  applied_min NUMERIC,
  old_price NUMERIC,
  new_price NUMERIC,
  roi_before NUMERIC,
  roi_after NUMERIC,
  bb_status TEXT,
  decision TEXT NOT NULL DEFAULT 'applied',  -- 'applied' | 'skipped'
  skip_reason TEXT,
  source TEXT DEFAULT 'auto_suggestion',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Performance index for querying user's suggestion history
CREATE INDEX idx_suggestion_log_user_asin_created
  ON public.repricer_suggestion_log (user_id, asin, created_at DESC);

-- Enable RLS
ALTER TABLE public.repricer_suggestion_log ENABLE ROW LEVEL SECURITY;

-- Users can only see their own logs
CREATE POLICY "Users can view own suggestion logs"
  ON public.repricer_suggestion_log
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users can insert their own logs
CREATE POLICY "Users can insert own suggestion logs"
  ON public.repricer_suggestion_log
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());
