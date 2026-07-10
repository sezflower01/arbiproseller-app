
-- Audit table to track reconciliation changes
CREATE TABLE public.sales_reconciliation_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  order_id TEXT NOT NULL,
  asin TEXT,
  seller_sku TEXT,
  reconciliation_run_id TEXT NOT NULL,
  previous_sold_price NUMERIC,
  new_sold_price NUMERIC,
  previous_total_sale_amount NUMERIC,
  new_total_sale_amount NUMERIC,
  previous_price_source TEXT,
  new_price_source TEXT,
  fec_settled_amount NUMERIC,
  fec_event_date DATE,
  correction_type TEXT NOT NULL, -- 'single_item', 'multi_item_proportional', 'order_total'
  quantity INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.sales_reconciliation_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own audit records"
ON public.sales_reconciliation_audit
FOR SELECT
USING (auth.uid() = user_id);

CREATE INDEX idx_reconciliation_audit_user_run ON public.sales_reconciliation_audit(user_id, reconciliation_run_id);
CREATE INDEX idx_reconciliation_audit_order ON public.sales_reconciliation_audit(order_id);
