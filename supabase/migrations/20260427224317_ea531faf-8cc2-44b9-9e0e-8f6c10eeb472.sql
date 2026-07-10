-- Disposition type enum
DO $$ BEGIN
  CREATE TYPE public.disposition_type AS ENUM ('removal', 'disposal', 'liquidation', 'mfn_return');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.disposition_status AS ENUM ('pending_review', 'accepted', 'ignored', 'adjusted');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE public.disposition_source AS ENUM ('amazon_report', 'manual', 'csv_import');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS public.inventory_dispositions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  disposition_date DATE NOT NULL,
  disposition_type public.disposition_type NOT NULL,
  amazon_order_id TEXT,
  removal_order_id TEXT,
  asin TEXT,
  msku TEXT,
  fnsku TEXT,
  title TEXT,
  sellable_qty INTEGER NOT NULL DEFAULT 0,
  unsellable_qty INTEGER NOT NULL DEFAULT 0,
  total_qty INTEGER NOT NULL DEFAULT 0,
  unit_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
  cost_adjustment NUMERIC(12,4) NOT NULL DEFAULT 0,
  returned_to_inventory_qty INTEGER NOT NULL DEFAULT 0,
  recovery_amount NUMERIC(12,4) NOT NULL DEFAULT 0,
  status public.disposition_status NOT NULL DEFAULT 'pending_review',
  source public.disposition_source NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disp_user_date ON public.inventory_dispositions(user_id, disposition_date DESC);
CREATE INDEX IF NOT EXISTS idx_disp_user_asin ON public.inventory_dispositions(user_id, asin);
CREATE INDEX IF NOT EXISTS idx_disp_user_msku ON public.inventory_dispositions(user_id, msku);
CREATE INDEX IF NOT EXISTS idx_disp_user_status ON public.inventory_dispositions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_disp_user_type ON public.inventory_dispositions(user_id, disposition_type);

-- Dedupe key for Amazon imports (avoid duplicate rows on re-import)
CREATE UNIQUE INDEX IF NOT EXISTS uq_disp_import
  ON public.inventory_dispositions(user_id, disposition_date, disposition_type, COALESCE(removal_order_id, ''), COALESCE(msku, ''), COALESCE(asin, ''))
  WHERE source = 'amazon_report';

ALTER TABLE public.inventory_dispositions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own dispositions"
  ON public.inventory_dispositions FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users insert own dispositions"
  ON public.inventory_dispositions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own dispositions"
  ON public.inventory_dispositions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own dispositions"
  ON public.inventory_dispositions FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_disp_updated_at
  BEFORE UPDATE ON public.inventory_dispositions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();