
-- Phase 1 (revised): inventory_valuation_summary — server-cached totals so
-- 5+ browser tabs share one tiny row instead of each scanning the full
-- inventory + created_listings tables. UI output is preserved; only the
-- data source for the totals changes (fallback to live compute is kept).

CREATE TABLE IF NOT EXISTS public.inventory_valuation_summary (
  user_id              UUID PRIMARY KEY,
  -- Totals (mirrors InventoryValuationTotals in src/lib/inventory-valuation.ts)
  value                NUMERIC NOT NULL DEFAULT 0,
  units                INTEGER NOT NULL DEFAULT 0,
  skus                 INTEGER NOT NULL DEFAULT 0,
  available            INTEGER NOT NULL DEFAULT 0,
  reserved             INTEGER NOT NULL DEFAULT 0,
  inbound              INTEGER NOT NULL DEFAULT 0,
  unfulfilled          INTEGER NOT NULL DEFAULT 0,
  available_value      NUMERIC NOT NULL DEFAULT 0,
  reserved_value       NUMERIC NOT NULL DEFAULT 0,
  inbound_value        NUMERIC NOT NULL DEFAULT 0,
  unfulfilled_value    NUMERIC NOT NULL DEFAULT 0,
  low_stock            INTEGER NOT NULL DEFAULT 0,
  total_rows           INTEGER NOT NULL DEFAULT 0,
  rows_stale_24h       INTEGER NOT NULL DEFAULT 0,
  most_recent_sync     TIMESTAMPTZ,
  -- Bookkeeping
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source               TEXT NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual' | 'backfill'
  compute_ms           INTEGER
);

GRANT SELECT ON public.inventory_valuation_summary TO authenticated;
GRANT ALL ON public.inventory_valuation_summary TO service_role;

ALTER TABLE public.inventory_valuation_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own inventory_valuation_summary"
  ON public.inventory_valuation_summary
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::app_role));

-- Per-user writer lock (mirrors live_sales_summary_lock pattern).
CREATE TABLE IF NOT EXISTS public.inventory_valuation_summary_lock (
  user_id     UUID PRIMARY KEY,
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by   TEXT
);
GRANT ALL ON public.inventory_valuation_summary_lock TO service_role;
ALTER TABLE public.inventory_valuation_summary_lock ENABLE ROW LEVEL SECURITY;
-- Service-role only; no policies for anon/authenticated.

CREATE OR REPLACE FUNCTION public.try_acquire_inv_valuation_summary_lock(
  p_user_id UUID, p_caller TEXT, p_max_age_seconds INT DEFAULT 180
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.inventory_valuation_summary_lock
   WHERE user_id = p_user_id
     AND locked_at < now() - make_interval(secs => p_max_age_seconds);

  BEGIN
    INSERT INTO public.inventory_valuation_summary_lock (user_id, locked_at, locked_by)
    VALUES (p_user_id, now(), p_caller);
    RETURN TRUE;
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;
END $$;

CREATE OR REPLACE FUNCTION public.release_inv_valuation_summary_lock(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.inventory_valuation_summary_lock WHERE user_id = p_user_id;
$$;

-- Schedule the writer every 10 minutes. Fan-out is done inside the edge fn.
SELECT cron.schedule(
  'inventory-valuation-summary-refresh-10min',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/refresh-inventory-valuation-summary-all',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 120000
  ) AS request_id;
  $cron$
);

-- Optional: unschedule the unused live_sales summary cron created earlier in
-- this phase — we paused that work. Safe no-op if it does not exist.
DO $$
BEGIN
  PERFORM cron.unschedule('live-sales-summary-refresh-3min');
EXCEPTION WHEN OTHERS THEN
  -- ignore (cron job may not exist or be owned by another role)
  NULL;
END $$;
