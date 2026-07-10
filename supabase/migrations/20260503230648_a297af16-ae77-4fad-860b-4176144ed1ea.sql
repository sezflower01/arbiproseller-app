-- Decision enum for research leads
DO $$ BEGIN
  CREATE TYPE public.research_lead_decision AS ENUM ('UNDECIDED', 'BUY', 'SKIP', 'MAYBE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.research_leads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,

  -- Core
  asin TEXT NOT NULL,
  retail_url TEXT,
  supplier_name TEXT,
  source TEXT DEFAULT 'FBA Lead List',
  date_found TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  processed BOOLEAN NOT NULL DEFAULT false,

  -- Pricing / ROI (optional)
  cost NUMERIC(12,2),
  expected_sell_price NUMERIC(12,2),
  expected_roi NUMERIC(8,2),

  -- Enrichment placeholders
  title TEXT,
  image_url TEXT,

  -- Classification
  decision public.research_lead_decision NOT NULL DEFAULT 'UNDECIDED',
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_research_leads_user_date
  ON public.research_leads (user_id, date_found DESC);
CREATE INDEX IF NOT EXISTS idx_research_leads_asin_lower
  ON public.research_leads (lower(asin));
CREATE INDEX IF NOT EXISTS idx_research_leads_user_processed
  ON public.research_leads (user_id, processed);
CREATE INDEX IF NOT EXISTS idx_research_leads_user_decision
  ON public.research_leads (user_id, decision);

-- Updated-at trigger
DROP TRIGGER IF EXISTS trg_research_leads_updated_at ON public.research_leads;
CREATE TRIGGER trg_research_leads_updated_at
BEFORE UPDATE ON public.research_leads
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.research_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "research_leads_select_own_or_admin" ON public.research_leads;
CREATE POLICY "research_leads_select_own_or_admin"
ON public.research_leads
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "research_leads_insert_own" ON public.research_leads;
CREATE POLICY "research_leads_insert_own"
ON public.research_leads
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "research_leads_update_own_or_admin" ON public.research_leads;
CREATE POLICY "research_leads_update_own_or_admin"
ON public.research_leads
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "research_leads_delete_own_or_admin" ON public.research_leads;
CREATE POLICY "research_leads_delete_own_or_admin"
ON public.research_leads
FOR DELETE
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));