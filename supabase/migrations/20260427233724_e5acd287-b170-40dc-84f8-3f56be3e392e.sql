-- Dedup unique key for auto-synced Amazon dispositions.
-- Uses COALESCE-friendly partial indexes since some fields may be null.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_dispositions_amazon_dedup
  ON public.inventory_dispositions (
    user_id,
    COALESCE(removal_order_id, ''),
    COALESCE(asin, ''),
    COALESCE(msku, ''),
    disposition_date
  )
  WHERE source = 'amazon_report';

-- Track last successful Amazon disposition sync per user (for "Last synced" UI + dedup window).
CREATE TABLE IF NOT EXISTS public.disposition_sync_state (
  user_id uuid PRIMARY KEY,
  last_synced_at timestamptz,
  last_amazon_report_id text,
  last_rows_inserted integer NOT NULL DEFAULT 0,
  last_rows_skipped integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.disposition_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own disposition sync state"
  ON public.disposition_sync_state FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users manage own disposition sync state"
  ON public.disposition_sync_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);