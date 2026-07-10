-- AI verification cache for store-scan candidate matches.
-- Globally shared per (source_url, asin) because verdict is product-identity only.
-- NEVER store user-specific economics here (no ROI, no fees, no marketplace profitability).

CREATE TABLE IF NOT EXISTS public.store_scan_ai_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url text NOT NULL,
  source_url_norm text NOT NULL,
  asin text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('exact_match','likely_match','not_match')),
  confidence integer NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Versioning so cache can be invalidated cleanly when logic changes
  verification_version integer NOT NULL DEFAULT 1,
  prompt_version integer NOT NULL DEFAULT 1,
  model_used text NOT NULL,
  -- Material-change detection fingerprints (optional; null when unknown)
  source_fingerprint text,
  amazon_fingerprint text,
  -- Audit trail
  rule_block text,        -- non-null when Layer 3 rejected without AI (e.g., 'pack_conflict')
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_verif_pair UNIQUE (source_url_norm, asin, verification_version, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_ai_verif_lookup
  ON public.store_scan_ai_verifications (source_url_norm, asin);

CREATE INDEX IF NOT EXISTS idx_ai_verif_asin
  ON public.store_scan_ai_verifications (asin);

ALTER TABLE public.store_scan_ai_verifications ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read the shared cache
CREATE POLICY "ai_verif_read_all_authenticated"
  ON public.store_scan_ai_verifications
  FOR SELECT
  TO authenticated
  USING (true);

-- Writes only via service role (edge function)
CREATE POLICY "ai_verif_write_service_only"
  ON public.store_scan_ai_verifications
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER trg_ai_verif_updated_at
  BEFORE UPDATE ON public.store_scan_ai_verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();