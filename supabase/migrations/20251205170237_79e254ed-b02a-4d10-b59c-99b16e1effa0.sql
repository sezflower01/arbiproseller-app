-- Add historical sync tracking fields to sales_sync_state
ALTER TABLE public.sales_sync_state 
ADD COLUMN IF NOT EXISTS historical_sync_in_progress boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS historical_sync_started_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS historical_sync_progress text;