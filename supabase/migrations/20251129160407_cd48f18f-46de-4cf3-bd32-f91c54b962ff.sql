-- Create table to track FNSKU sync history
CREATE TABLE IF NOT EXISTS fnsku_sync_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  seller_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  sync_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_completed_at TIMESTAMPTZ,
  status TEXT NOT NULL, -- 'in_progress', 'completed', 'failed'
  processed_rows INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE fnsku_sync_history ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own sync history
CREATE POLICY "Users can view their own sync history"
ON fnsku_sync_history
FOR SELECT
USING (auth.uid() = user_id);

-- Policy: Users can insert their own sync records
CREATE POLICY "Users can insert their own sync records"
ON fnsku_sync_history
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own sync records
CREATE POLICY "Users can update their own sync records"
ON fnsku_sync_history
FOR UPDATE
USING (auth.uid() = user_id);

-- Index for fast lookups
CREATE INDEX idx_fnsku_sync_history_user_seller ON fnsku_sync_history(user_id, seller_id, marketplace_id, sync_started_at DESC);