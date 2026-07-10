-- Add validation_so_count column to track post-repair verification results
ALTER TABLE public.sync_parity_log
ADD COLUMN IF NOT EXISTS validation_so_count integer DEFAULT NULL;

-- Add comment for clarity
COMMENT ON COLUMN public.sync_parity_log.validation_so_count IS 'SO row count after repair attempt — used to verify repair actually wrote data';