ALTER TABLE public.repricer_assignments 
  ADD COLUMN IF NOT EXISTS floor_blocked_cycles integer DEFAULT 0;

ALTER TABLE public.repricer_assignments 
  ADD COLUMN IF NOT EXISTS bb_recovery_escalation integer DEFAULT 0;