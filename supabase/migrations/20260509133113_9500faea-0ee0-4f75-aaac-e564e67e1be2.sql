
CREATE TABLE IF NOT EXISTS public.fbm_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  triggered_by text NOT NULL DEFAULT 'unknown',
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  elapsed_ms integer,
  report_id text,
  report_status text,
  report_poll_ms integer,
  rows_in_report integer DEFAULT 0,
  fbm_rows integer DEFAULT 0,
  fba_rows integer DEFAULT 0,
  active_listings integer DEFAULT 0,
  inactive_listings integer DEFAULT 0,
  inserts integer DEFAULT 0,
  updates integer DEFAULT 0,
  deletions integer DEFAULT 0,
  enriched integer DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fbm_sync_runs_user_started
  ON public.fbm_sync_runs (user_id, started_at DESC);

ALTER TABLE public.fbm_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own fbm_sync_runs" ON public.fbm_sync_runs;
CREATE POLICY "Users view own fbm_sync_runs"
  ON public.fbm_sync_runs FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
