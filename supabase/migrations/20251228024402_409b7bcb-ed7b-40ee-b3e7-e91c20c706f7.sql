-- Cache for live refunds results (per user + date range)
CREATE TABLE IF NOT EXISTS public.live_refunds_cache (
  user_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  refunds jsonb NOT NULL DEFAULT '[]'::jsonb,
  cached_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'complete',
  error text,
  PRIMARY KEY (user_id, start_date, end_date)
);

ALTER TABLE public.live_refunds_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own live refunds cache"
ON public.live_refunds_cache
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert their own live refunds cache"
ON public.live_refunds_cache
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own live refunds cache"
ON public.live_refunds_cache
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_live_refunds_cache_user_date
ON public.live_refunds_cache (user_id, start_date, end_date);
