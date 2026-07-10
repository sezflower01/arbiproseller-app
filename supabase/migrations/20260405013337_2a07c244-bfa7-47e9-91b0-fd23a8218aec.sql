-- Add account status fields to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS account_status_reason text,
  ADD COLUMN IF NOT EXISTS account_status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS account_status_changed_by uuid;

-- Index for quick lookups of non-active accounts
CREATE INDEX IF NOT EXISTS idx_profiles_account_status ON public.profiles(account_status) WHERE account_status != 'active';