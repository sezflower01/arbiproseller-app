ALTER TABLE public.live_sales_summary
  ADD COLUMN IF NOT EXISTS revenue_with_fallback numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_with_fallback    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_with_fallback    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profit_with_fallback  numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS units_with_fallback   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orders_with_fallback  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_estimate_revenue numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed_count       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS high_confidence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS low_confidence_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fallback_count        integer NOT NULL DEFAULT 0;

ALTER TABLE public.live_sales_today_by_asin
  ADD COLUMN IF NOT EXISTS revenue_with_fallback_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_estimate_usd      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS units_with_fallback       integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.live_sales_summary.revenue       IS 'CONFIRMED ONLY: sum of total_sale_amount / sold_price*qty (settled P&L truth).';
COMMENT ON COLUMN public.live_sales_summary.revenue_with_fallback IS 'Matches Live Sales KPI: confirmed -> estimated_price -> historical same-ASIN USD unit -> listings/inventory price.';
COMMENT ON COLUMN public.live_sales_summary.pending_estimate_revenue IS 'Subset of revenue_with_fallback: rows with no confirmed price, surfaced as "Pending Estimate" in UI.';