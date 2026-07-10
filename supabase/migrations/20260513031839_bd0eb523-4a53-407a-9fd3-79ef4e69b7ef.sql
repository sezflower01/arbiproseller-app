
CREATE TABLE IF NOT EXISTS public.cron_run_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  status text NOT NULL,                 -- started | success | failed | skipped_locked
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  items_processed integer DEFAULT 0,
  error text,
  detail jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_cron_history_job_time
  ON public.cron_run_history(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_history_recent
  ON public.cron_run_history(started_at DESC);

ALTER TABLE public.cron_run_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read cron history"
  ON public.cron_run_history FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role manages cron history"
  ON public.cron_run_history FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.record_cron_run(
  p_job_name text,
  p_status text,
  p_duration_ms integer,
  p_items_processed integer,
  p_error text,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.cron_run_history(
    job_name, status, finished_at, duration_ms, items_processed, error, detail
  ) VALUES (
    p_job_name, p_status, now(), p_duration_ms, p_items_processed, p_error, COALESCE(p_detail, '{}'::jsonb)
  )
  RETURNING id;
$$;
