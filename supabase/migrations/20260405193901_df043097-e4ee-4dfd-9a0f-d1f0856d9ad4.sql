ALTER TABLE public.smart_engine_review_batches 
ADD COLUMN trigger_type text NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN public.smart_engine_review_batches.trigger_type IS 'manual or automated';