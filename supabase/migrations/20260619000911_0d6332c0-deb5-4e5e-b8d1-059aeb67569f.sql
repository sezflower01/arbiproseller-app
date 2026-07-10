DELETE FROM public.live_sales_period_cache WHERE marketplace = 'BR' OR marketplace IS NULL OR marketplace = 'ALL';
DELETE FROM public.sales_period_totals_cache WHERE TRUE;
DELETE FROM public.live_sales_summary WHERE EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.user_id = live_sales_summary.user_id AND so.marketplace = 'BR');