-- Durable staging table for sync-fnsku-report. Previously the entire sync
-- (2 SP-API report cycles with polling, an external-API enrichment loop,
-- and 3 separate per-record DB-update loops) ran as ONE continuous
-- EdgeRuntime.waitUntil() background execution. Live-captured proof
-- (2026-07-31): a real run stalled at 2200/3672 records into the
-- "update existing inventory quantities" loop after ~140s of continuous
-- execution, with no error ever thrown -- matching 759 historical rows
-- stuck 'in_progress' forever. This table lets each phase persist its
-- parsed work once and resume via a cursor (enriched/applied/backfill_
-- checked flags) instead of re-parsing the report from scratch, so the
-- sync can be broken into multiple bounded invocations that each finish
-- well under the real ~150s ceiling.
CREATE TABLE IF NOT EXISTS public.fnsku_sync_report_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_id uuid NOT NULL REFERENCES public.fnsku_sync_history(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('fba', 'fbm')),
  asin text NOT NULL,
  sku text NOT NULL,
  fnsku text,
  condition text,
  title text,
  units integer,
  available integer,
  reserved integer,
  inbound integer,
  unfulfilled integer,
  is_new boolean,
  enriched boolean NOT NULL DEFAULT false,
  enrichment_title text,
  enrichment_image_url text,
  enrichment_price numeric,
  applied boolean NOT NULL DEFAULT false,
  backfill_checked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fnsku_sync_rows_sync_enrich
  ON public.fnsku_sync_report_rows (sync_id, report_type, enriched);
CREATE INDEX IF NOT EXISTS idx_fnsku_sync_rows_sync_apply
  ON public.fnsku_sync_report_rows (sync_id, report_type, applied);
CREATE INDEX IF NOT EXISTS idx_fnsku_sync_rows_sync_backfill
  ON public.fnsku_sync_report_rows (sync_id, report_type, backfill_checked);
CREATE INDEX IF NOT EXISTS idx_fnsku_sync_rows_asin
  ON public.fnsku_sync_report_rows (sync_id, asin);

ALTER TABLE public.fnsku_sync_report_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own sync report rows"
ON public.fnsku_sync_report_rows
FOR SELECT
USING (auth.uid() = user_id);

-- Service role (edge functions) does all writes; no user-facing insert/update needed.
GRANT ALL ON public.fnsku_sync_report_rows TO service_role;
