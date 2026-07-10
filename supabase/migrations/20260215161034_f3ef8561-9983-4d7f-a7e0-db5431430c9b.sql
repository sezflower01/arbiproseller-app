
-- Add is_priority flag to repricer_assignments
ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS is_priority boolean NOT NULL DEFAULT false;

-- Add last_priority_check_at for round-robin ordering
ALTER TABLE public.repricer_assignments 
ADD COLUMN IF NOT EXISTS last_priority_check_at timestamp with time zone;

-- Index for quick priority queue lookups
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_priority 
ON public.repricer_assignments (user_id, is_priority, last_priority_check_at ASC NULLS FIRST) 
WHERE is_priority = true;
