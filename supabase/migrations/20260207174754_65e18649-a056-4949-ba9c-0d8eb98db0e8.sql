
-- Step 1: Add 'monitor' to the app_role enum (must be its own transaction)
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'monitor';
