CREATE TABLE IF NOT EXISTS public.cost_repair_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name TEXT NOT NULL CHECK (table_name IN ('created_listings', 'inventory')),
  row_id UUID NOT NULL,
  user_id UUID NOT NULL,
  asin TEXT,
  sku TEXT,
  repair_category TEXT NOT NULL,
  before_snapshot JSONB NOT NULL,
  after_snapshot JSONB,
  ledger_total NUMERIC,
  ledger_unit_cost NUMERIC,
  ledger_units INTEGER,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  applied BOOLEAN NOT NULL DEFAULT false,
  applied_at TIMESTAMPTZ,
  batch_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_repair_audit_batch ON public.cost_repair_audit(batch_id);
CREATE INDEX IF NOT EXISTS idx_cost_repair_audit_table_row ON public.cost_repair_audit(table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_cost_repair_audit_user ON public.cost_repair_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_cost_repair_audit_category ON public.cost_repair_audit(repair_category);
CREATE INDEX IF NOT EXISTS idx_cost_repair_audit_dry_run ON public.cost_repair_audit(dry_run, applied);

ALTER TABLE public.cost_repair_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view cost repair audit"
ON public.cost_repair_audit FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert cost repair audit"
ON public.cost_repair_audit FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));