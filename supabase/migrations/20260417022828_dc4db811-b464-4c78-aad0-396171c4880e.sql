
-- ─── Phase 1: Trust + Manual Cost ───

-- 1. Per-domain trusted retailers (global per user)
CREATE TABLE IF NOT EXISTS public.trusted_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  domain text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, domain)
);

ALTER TABLE public.trusted_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their trusted domains"
ON public.trusted_domains
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_trusted_domains_user ON public.trusted_domains(user_id);

-- 2. Per-ASIN trust + manual cost on saved_sources
ALTER TABLE public.saved_sources
  ADD COLUMN IF NOT EXISTS is_trusted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_cost numeric(12,2),
  ADD COLUMN IF NOT EXISTS manual_cost_currency text DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS manual_cost_note text;
