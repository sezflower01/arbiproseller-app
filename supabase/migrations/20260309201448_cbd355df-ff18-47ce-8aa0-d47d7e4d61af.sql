-- Performance indexes for top sequential scan offenders

-- created_listings: DISTINCT ON (asin) ORDER BY updated_at DESC pattern
-- in period totals functions (875K seq scans, 5.1B rows read)
CREATE INDEX IF NOT EXISTS idx_cl_user_asin_updated
  ON public.created_listings (user_id, asin, updated_at DESC);

-- sales_orders: period totals filter pattern with status/cancelled filters
CREATE INDEX IF NOT EXISTS idx_so_user_date_status
  ON public.sales_orders (user_id, order_date, is_cancelled, order_status);

-- sales_orders: order_id lookups for refund resolution and enrichment
CREATE INDEX IF NOT EXISTS idx_so_order_id
  ON public.sales_orders (order_id);

-- financial_events_cache: event_type filter in period totals
CREATE INDEX IF NOT EXISTS idx_fec_user_date_type
  ON public.financial_events_cache (user_id, event_date, event_type);

-- repricer_feed_submissions: monitor/feed lookups (69K seq scans)
CREATE INDEX IF NOT EXISTS idx_rfs_user_submitted
  ON public.repricer_feed_submissions (user_id, submitted_at DESC);