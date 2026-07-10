-- Zero out closing_fee for all pending orders (orders without settled financial events)
-- Pending orders are those where total_fees = 0 or NULL (not yet settled by Amazon)
UPDATE public.sales_orders
SET closing_fee = 0
WHERE closing_fee IS NOT NULL 
  AND closing_fee > 0
  AND (total_fees IS NULL OR total_fees = 0);