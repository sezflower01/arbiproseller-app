
-- Add source column to financial_events_cache to prevent double-counting
ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'financial_events';

CREATE INDEX IF NOT EXISTS idx_fec_user_source_date
  ON public.financial_events_cache(user_id, source, event_date);

-- Settlement reports (one row per Amazon settlement)
CREATE TABLE IF NOT EXISTS public.settlement_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amazon_report_id text NOT NULL,
  amazon_report_document_id text,
  marketplace_id text,
  marketplace text,
  settlement_id text,
  settlement_start_date date,
  settlement_end_date date,
  deposit_date date,
  total_amount numeric DEFAULT 0,
  currency text,
  status text NOT NULL DEFAULT 'pending', -- pending, downloading, parsed, error
  rows_parsed integer DEFAULT 0,
  error_message text,
  raw_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  parsed_at timestamptz,
  UNIQUE (user_id, amazon_report_id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_reports_user_period
  ON public.settlement_reports(user_id, settlement_end_date DESC);

-- Individual line items from each settlement report
CREATE TABLE IF NOT EXISTS public.settlement_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  settlement_report_id uuid NOT NULL REFERENCES public.settlement_reports(id) ON DELETE CASCADE,
  amazon_report_id text NOT NULL,
  posted_date date,
  transaction_type text,
  order_id text,
  shipment_id text,
  marketplace_name text,
  amount_type text,
  amount_description text,
  amount numeric DEFAULT 0,
  fulfillment_id text, -- AFN or MFN
  sku text,
  asin text,
  quantity_purchased integer,
  fee_type text,
  category text, -- mapped P&L category (sales, refunds, fba_fees, removal_fees, disposal_fees, etc.)
  raw_row jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlement_line_items_user_date
  ON public.settlement_line_items(user_id, posted_date);
CREATE INDEX IF NOT EXISTS idx_settlement_line_items_user_category_date
  ON public.settlement_line_items(user_id, category, posted_date);
CREATE INDEX IF NOT EXISTS idx_settlement_line_items_report
  ON public.settlement_line_items(settlement_report_id);

-- Pre-aggregated monthly totals per category for fast P&L reads
CREATE TABLE IF NOT EXISTS public.settlement_category_totals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_year integer NOT NULL,
  period_month integer NOT NULL,
  marketplace text NOT NULL DEFAULT 'ALL',
  category text NOT NULL,
  total_amount numeric NOT NULL DEFAULT 0,
  row_count integer NOT NULL DEFAULT 0,
  last_recomputed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_year, period_month, marketplace, category)
);

CREATE INDEX IF NOT EXISTS idx_settlement_totals_user_period
  ON public.settlement_category_totals(user_id, period_year, period_month);

-- RLS
ALTER TABLE public.settlement_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_category_totals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their settlement reports"
  ON public.settlement_reports FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their settlement line items"
  ON public.settlement_line_items FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage their settlement totals"
  ON public.settlement_category_totals FOR ALL
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id);

-- updated_at triggers
CREATE TRIGGER trg_settlement_reports_updated
  BEFORE UPDATE ON public.settlement_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_settlement_totals_updated
  BEFORE UPDATE ON public.settlement_category_totals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Reconciliation view: compares FinancialEvents vs Settlement per (user, year, month, category)
CREATE OR REPLACE VIEW public.v_pl_reconciliation AS
WITH fec_monthly AS (
  SELECT
    user_id,
    EXTRACT(YEAR FROM event_date)::int AS period_year,
    EXTRACT(MONTH FROM event_date)::int AS period_month,
    'sales' AS category,
    SUM(ABS(COALESCE(sales,0))) FILTER (WHERE event_type='shipment') AS total
  FROM public.financial_events_cache
  WHERE source = 'financial_events'
  GROUP BY 1,2,3
  UNION ALL
  SELECT user_id,
    EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_storage_fees', SUM(ABS(COALESCE(fba_storage_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id,
    EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_removal_fees', SUM(ABS(COALESCE(fba_removal_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id,
    EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_disposal_fees', SUM(ABS(COALESCE(fba_disposal_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id,
    EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_long_term_storage_fees', SUM(ABS(COALESCE(fba_long_term_storage_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id,
    EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'liquidations', SUM(ABS(COALESCE(liquidations,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
)
SELECT
  COALESCE(f.user_id, s.user_id) AS user_id,
  COALESCE(f.period_year, s.period_year) AS period_year,
  COALESCE(f.period_month, s.period_month) AS period_month,
  COALESCE(f.category, s.category) AS category,
  COALESCE(f.total, 0) AS fec_total,
  COALESCE(s.total_amount, 0) AS settlement_total,
  COALESCE(s.total_amount, 0) - COALESCE(f.total, 0) AS difference,
  CASE
    WHEN COALESCE(s.total_amount, 0) > 0 THEN 'settlement'
    WHEN COALESCE(f.total, 0) > 0 THEN 'financial_events'
    ELSE 'none'
  END AS authoritative_source
FROM fec_monthly f
FULL OUTER JOIN public.settlement_category_totals s
  ON s.user_id = f.user_id
  AND s.period_year = f.period_year
  AND s.period_month = f.period_month
  AND s.category = f.category
  AND s.marketplace = 'ALL';
