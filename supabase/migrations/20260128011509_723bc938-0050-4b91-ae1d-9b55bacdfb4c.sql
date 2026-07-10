-- Add columns to track scheduler state for hybrid monitoring
ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS last_sp_api_check_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS next_rainforest_check_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS last_applied_price NUMERIC,
ADD COLUMN IF NOT EXISTS last_applied_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS auto_apply_enabled BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS apply_error TEXT;

-- Add scheduler status columns to settings
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS scheduler_enabled BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS last_scheduler_run_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS scheduler_status TEXT DEFAULT 'idle';

-- Create index for scheduler queries (find enabled assignments that need checking)
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_scheduler 
ON public.repricer_assignments (user_id, is_enabled, last_sp_api_check_at)
WHERE is_enabled = true AND rule_id IS NOT NULL;