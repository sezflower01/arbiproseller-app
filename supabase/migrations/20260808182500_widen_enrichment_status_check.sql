-- enrich-pending-orders and repair-pending-prices both log an in-flight
-- attempt with status='started' before the outcome is known, but 'started'
-- was never in the allowed list -- every one of those inserts has been
-- failing 23514.
ALTER TABLE public.enrichment_logs
  DROP CONSTRAINT IF EXISTS enrichment_logs_status_check;

ALTER TABLE public.enrichment_logs
  ADD CONSTRAINT enrichment_logs_status_check
  CHECK (status IN ('pending', 'started', 'success', 'failed', 'rate_limited', 'timeout'));
