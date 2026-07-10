
-- Add reconciliation retry tracking columns to repricer_price_actions
ALTER TABLE public.repricer_price_actions 
  ADD COLUMN IF NOT EXISTS recon_retry_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recon_first_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS recon_last_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS recon_severity text,
  ADD COLUMN IF NOT EXISTS recon_root_cause text,
  ADD COLUMN IF NOT EXISTS recon_converged_at timestamptz,
  ADD COLUMN IF NOT EXISTS recon_price_submitted numeric;
