CREATE TABLE IF NOT EXISTS public.repricer_executive_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  snapshot_date date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  buybox_control_pct numeric,
  revenue_protected numeric,
  revenue_missed numeric,
  aged_inventory_value numeric,
  asins_needing_action integer,
  recovered_products integer,
  total_active_asins integer,
  top_blockers jsonb DEFAULT '[]'::jsonb,
  strategy_distribution jsonb DEFAULT '{}'::jsonb,
  assumptions jsonb DEFAULT '{}'::jsonb,
  confidence text DEFAULT 'estimated',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_exec_snap_user_date ON public.repricer_executive_snapshots(user_id, snapshot_date DESC);

ALTER TABLE public.repricer_executive_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own exec snapshots"
ON public.repricer_executive_snapshots FOR SELECT
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service role manages exec snapshots"
ON public.repricer_executive_snapshots FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_exec_snap_updated_at
BEFORE UPDATE ON public.repricer_executive_snapshots
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();