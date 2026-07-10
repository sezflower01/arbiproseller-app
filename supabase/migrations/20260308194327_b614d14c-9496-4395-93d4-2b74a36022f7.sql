
-- ============================================================
-- Phase 1: Duplicate Prevention & Data Integrity Hardening
-- ============================================================

-- 1. Add unique constraint on order_price_snapshots to prevent duplicate snapshots
-- Currently only has a non-unique index. Same order+asin could get multiple snapshots on retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_price_snapshots_unique
  ON public.order_price_snapshots(user_id, order_id, asin);

-- 2. Add a unique constraint for historical sync checkpoint tracking
CREATE TABLE IF NOT EXISTS public.historical_sync_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  sync_type text NOT NULL DEFAULT 'settled',
  month_key text NOT NULL, -- e.g. '2025-06'
  status text NOT NULL DEFAULT 'pending', -- pending, running, done, error
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  orders_processed integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT historical_sync_checkpoints_unique UNIQUE (user_id, sync_type, month_key)
);

ALTER TABLE public.historical_sync_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own checkpoints"
  ON public.historical_sync_checkpoints
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own checkpoints"
  ON public.historical_sync_checkpoints
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own checkpoints"
  ON public.historical_sync_checkpoints
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

-- 3. Add a sync_trace_id column to sales_orders for tracking which sync run created/updated a row
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS sync_trace_id text;

-- 4. Add a sync_trace_id column to financial_events_cache  
ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS sync_trace_id text;
