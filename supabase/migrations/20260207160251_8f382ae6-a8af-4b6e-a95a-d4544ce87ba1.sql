
-- Table to track feed submissions and per-SKU results
CREATE TABLE public.repricer_feed_submissions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  feed_document_id TEXT,
  feed_id TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  status TEXT NOT NULL DEFAULT 'pending',
  sku_count INTEGER NOT NULL DEFAULT 0,
  skus_succeeded INTEGER DEFAULT 0,
  skus_failed INTEGER DEFAULT 0,
  feed_payload JSONB,
  feed_result JSONB,
  error_message TEXT,
  submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repricer_feed_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own feed submissions"
ON public.repricer_feed_submissions
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add update_method column to repricer_price_actions for FEED vs PATCH tracking
ALTER TABLE public.repricer_price_actions
ADD COLUMN IF NOT EXISTS update_method TEXT DEFAULT 'PATCH',
ADD COLUMN IF NOT EXISTS feed_id TEXT;

-- Index for quick lookups
CREATE INDEX idx_feed_submissions_user_status ON public.repricer_feed_submissions(user_id, status);
CREATE INDEX idx_feed_submissions_feed_id ON public.repricer_feed_submissions(feed_id);
CREATE INDEX idx_price_actions_feed_id ON public.repricer_price_actions(feed_id) WHERE feed_id IS NOT NULL;
