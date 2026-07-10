-- Create table to track incremental sync state per user
CREATE TABLE IF NOT EXISTS public.sales_sync_state (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_orders_sync_at TIMESTAMPTZ,
  last_events_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.sales_sync_state ENABLE ROW LEVEL SECURITY;

-- Users can manage their own sync state
CREATE POLICY "Users can manage their own sync state"
ON public.sales_sync_state
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_sales_sync_state_user_id ON public.sales_sync_state(user_id);