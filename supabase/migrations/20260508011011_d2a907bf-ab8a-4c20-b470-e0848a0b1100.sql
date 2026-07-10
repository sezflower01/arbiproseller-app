CREATE TABLE IF NOT EXISTS public.auto_inventory_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  triggered_by text,
  users_count int DEFAULT 0,
  attempted int DEFAULT 0,
  updated int DEFAULT 0,
  skipped int DEFAULT 0,
  errors int DEFAULT 0,
  elapsed_ms int,
  ok boolean,
  summary jsonb,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_auto_inventory_sync_runs_started ON public.auto_inventory_sync_runs (started_at DESC);

ALTER TABLE public.auto_inventory_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read sync runs"
ON public.auto_inventory_sync_runs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));