
CREATE TABLE public.prewarm_pl_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  users_processed int NOT NULL DEFAULT 0,
  months_refreshed int NOT NULL DEFAULT 0,
  users_errored int NOT NULL DEFAULT 0,
  throttled boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.prewarm_pl_runs TO authenticated;
GRANT ALL ON public.prewarm_pl_runs TO service_role;

ALTER TABLE public.prewarm_pl_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view prewarm runs"
ON public.prewarm_pl_runs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX prewarm_pl_runs_started_at_idx ON public.prewarm_pl_runs (started_at DESC);
