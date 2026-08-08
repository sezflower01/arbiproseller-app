-- enrich-pending-orders writes enrichment_type 'repair' and
-- 'pending_asin_backfill', but the live check constraint only ever allowed
-- ('price','fees','both') -- an earlier migration meant to widen this used
-- CREATE TABLE IF NOT EXISTS, which no-op'd since the table already existed,
-- so every 'repair'/'pending_asin_backfill' insert has been failing 23514.
ALTER TABLE public.enrichment_logs
  DROP CONSTRAINT IF EXISTS enrichment_logs_enrichment_type_check;

ALTER TABLE public.enrichment_logs
  ADD CONSTRAINT enrichment_logs_enrichment_type_check
  CHECK (enrichment_type IN ('price', 'fees', 'both', 'repair', 'pending_asin_backfill'));
