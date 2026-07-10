
-- Phase 1: live_sales_summary — server-cached "Today" totals so 5+ browser
-- tabs read one tiny row instead of each re-aggregating sales_orders +
-- financial_events_cache. UI output is preserved; only the data source for
-- the Today totals card changes.

CREATE TABLE IF NOT EXISTS public.live_sales_summary (
  user_id            UUID NOT NULL,
  business_date      DATE NOT NULL,
  marketplace_id     TEXT NOT NULL DEFAULT 'ALL',
  -- Today aggregated totals (mirrors MobileLiveSalesSnapshot.todaySummary)
  units              NUMERIC NOT NULL DEFAULT 0,
  orders             INTEGER NOT NULL DEFAULT 0,
  revenue            NUMERIC NOT NULL DEFAULT 0,
  fees               NUMERIC NOT NULL DEFAULT 0,
  cost               NUMERIC NOT NULL DEFAULT 0,
  profit             NUMERIC NOT NULL DEFAULT 0,
  roi                NUMERIC NOT NULL DEFAULT 0,
  -- Refund totals from financial_events_cache (mirrors todayRefunds)
  refund_amount      NUMERIC NOT NULL DEFAULT 0,
  refund_count       INTEGER NOT NULL DEFAULT 0,
  -- Bookkeeping
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source             TEXT NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual' | 'backfill'
  PRIMARY KEY (user_id, business_date, marketplace_id)
);

CREATE INDEX IF NOT EXISTS idx_live_sales_summary_user_date
  ON public.live_sales_summary (user_id, business_date DESC);

GRANT SELECT ON public.live_sales_summary TO authenticated;
GRANT ALL ON public.live_sales_summary TO service_role;

ALTER TABLE public.live_sales_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own live_sales_summary"
  ON public.live_sales_summary
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::app_role));

-- Lock table so the writer cannot double-run per user, even across 5 clients
-- hitting manual Refresh at the same time.
CREATE TABLE IF NOT EXISTS public.live_sales_summary_lock (
  user_id     UUID PRIMARY KEY,
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by   TEXT
);
GRANT ALL ON public.live_sales_summary_lock TO service_role;
ALTER TABLE public.live_sales_summary_lock ENABLE ROW LEVEL SECURITY;
-- Service-role only; no policies for anon/authenticated.

-- Acquire / release helpers used by the writer edge function.
CREATE OR REPLACE FUNCTION public.try_acquire_live_sales_summary_lock(
  p_user_id UUID, p_caller TEXT, p_max_age_seconds INT DEFAULT 120
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Clear stale locks first
  DELETE FROM public.live_sales_summary_lock
   WHERE user_id = p_user_id
     AND locked_at < now() - make_interval(secs => p_max_age_seconds);

  BEGIN
    INSERT INTO public.live_sales_summary_lock (user_id, locked_at, locked_by)
    VALUES (p_user_id, now(), p_caller);
    RETURN TRUE;
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;
END $$;

CREATE OR REPLACE FUNCTION public.release_live_sales_summary_lock(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.live_sales_summary_lock WHERE user_id = p_user_id;
$$;

-- Schedule the writer every 3 minutes. The function itself fans out across
-- active users; cron just nudges it.
SELECT cron.schedule(
  'live-sales-summary-refresh-3min',
  '*/3 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/refresh-live-sales-summary-all',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc'
    ),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 60000
  ) AS request_id;
  $cron$
);
