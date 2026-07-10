
-- Simulation runs table
CREATE TABLE public.repricer_simulation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  scenario text NOT NULL DEFAULT 'normal',
  item_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.repricer_simulation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own simulation runs"
  ON public.repricer_simulation_runs
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Simulation items table
CREATE TABLE public.repricer_simulation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.repricer_simulation_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  tier text NOT NULL DEFAULT 'COLD',
  is_dispatchable boolean NOT NULL DEFAULT true,
  block_reason text,
  is_bb_owner boolean NOT NULL DEFAULT false,
  current_price numeric DEFAULT 25.00,
  bb_price numeric DEFAULT 24.99,
  next_competitor_price numeric,
  min_price numeric DEFAULT 15.00,
  max_price numeric DEFAULT 50.00,
  last_evaluated_at timestamptz,
  became_hot_at timestamptz,
  eval_result text DEFAULT 'no_change',
  constraint_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.repricer_simulation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own simulation items"
  ON public.repricer_simulation_items
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_sim_items_run ON public.repricer_simulation_items(run_id);
CREATE INDEX idx_sim_items_user ON public.repricer_simulation_items(user_id);
