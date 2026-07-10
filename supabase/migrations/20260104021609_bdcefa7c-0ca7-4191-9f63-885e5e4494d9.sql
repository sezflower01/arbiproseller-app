-- Add unique constraint for financial_events_cache upsert
ALTER TABLE public.financial_events_cache 
ADD CONSTRAINT financial_events_cache_unique_key 
UNIQUE (user_id, event_type, event_date, amazon_order_id, asin);