
-- ============================================================
-- Inventory Age Overlay — Phase 1 (Manual entry + overlay logic)
-- ============================================================

-- 1) Add age/expiration columns to inventory table
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS first_received_at date,
  ADD COLUMN IF NOT EXISTS expiration_date date,
  ADD COLUMN IF NOT EXISTS estimated_age_days integer,
  ADD COLUMN IF NOT EXISTS days_to_expiration integer,
  ADD COLUMN IF NOT EXISTS age_confidence text DEFAULT 'manual';

-- 2) Add age overlay settings to repricer_rules
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS age_overlay_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS age_overlay_mode text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS dump_age_days integer DEFAULT 365,
  ADD COLUMN IF NOT EXISTS extra_undercut_181 numeric DEFAULT 0.02,
  ADD COLUMN IF NOT EXISTS extra_undercut_271 numeric DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS extra_undercut_365 numeric DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS expiration_undercut_30 numeric DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS expiration_undercut_14 numeric DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS expiration_undercut_7 numeric DEFAULT 0.30;

-- 3) Add overlay audit fields to repricer_price_actions
ALTER TABLE public.repricer_price_actions
  ADD COLUMN IF NOT EXISTS base_price numeric,
  ADD COLUMN IF NOT EXISTS overlay_tag text,
  ADD COLUMN IF NOT EXISTS age_days integer,
  ADD COLUMN IF NOT EXISTS days_to_expiration integer;
