
DROP VIEW IF EXISTS public.v_pl_reconciliation;

CREATE VIEW public.v_pl_reconciliation
WITH (security_invoker = true) AS
WITH fec_monthly AS (
  SELECT user_id,
    EXTRACT(YEAR FROM event_date)::int AS period_year,
    EXTRACT(MONTH FROM event_date)::int AS period_month,
    'sales' AS category,
    SUM(ABS(COALESCE(sales,0))) FILTER (WHERE event_type='shipment') AS total
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id, EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_storage_fees', SUM(ABS(COALESCE(fba_storage_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id, EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_removal_fees', SUM(ABS(COALESCE(fba_removal_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id, EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_disposal_fees', SUM(ABS(COALESCE(fba_disposal_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id, EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
    'fba_long_term_storage_fees', SUM(ABS(COALESCE(fba_long_term_storage_fees,0)))
  FROM public.financial_events_cache WHERE source='financial_events' GROUP BY 1,2,3
  UNION ALL
  SELECT user_id, EXTRACT(YEAR FROM event_date)::int, EXTRACT(MONTH FROM event_date)::int,
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
