
CREATE TABLE public.repricer_monitor_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  
  -- HOT freshness
  hot_eligible int NOT NULL DEFAULT 0,
  hot_dispatchable int NOT NULL DEFAULT 0,
  hot_blocked int NOT NULL DEFAULT 0,
  hot_truly_stale int NOT NULL DEFAULT 0,
  hot_p50_minutes numeric NOT NULL DEFAULT 0,
  hot_p90_minutes numeric NOT NULL DEFAULT 0,
  
  -- Throughput
  evals_1h int NOT NULL DEFAULT 0,
  writes_1h int NOT NULL DEFAULT 0,
  evals_24h int NOT NULL DEFAULT 0,
  writes_24h int NOT NULL DEFAULT 0,
  
  -- Coverage
  eligible_total int NOT NULL DEFAULT 0,
  eligible_checked_24h int NOT NULL DEFAULT 0,
  coverage_pct numeric NOT NULL DEFAULT 0,
  
  -- Constraint pressure
  constraint_profit_guard int NOT NULL DEFAULT 0,
  constraint_min_bound int NOT NULL DEFAULT 0,
  constraint_market_stable int NOT NULL DEFAULT 0,
  constraint_other int NOT NULL DEFAULT 0,
  
  -- Health score
  health_score numeric NOT NULL DEFAULT 0,
  
  -- BB wins
  bb_winning int NOT NULL DEFAULT 0,
  bb_losing int NOT NULL DEFAULT 0
);

-- Index for fast time-series queries per user
CREATE INDEX idx_monitor_snapshots_user_time 
  ON public.repricer_monitor_snapshots (user_id, captured_at DESC);

-- Auto-cleanup: retention function (called by cron)
CREATE OR REPLACE FUNCTION public.cleanup_old_monitor_snapshots()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  DELETE FROM public.repricer_monitor_snapshots
  WHERE captured_at < now() - interval '30 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- RLS
ALTER TABLE public.repricer_monitor_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own snapshots"
  ON public.repricer_monitor_snapshots
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Service role can insert snapshots"
  ON public.repricer_monitor_snapshots
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Admins can read all snapshots"
  ON public.repricer_monitor_snapshots
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
