
-- Categories admins curate; users select from these to browse pre-scanned data
CREATE TABLE public.scan_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  supplier_domain TEXT NOT NULL,
  urls TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scan_categories_supplier ON public.scan_categories(supplier_domain) WHERE is_active = true;
CREATE INDEX idx_scan_categories_active ON public.scan_categories(is_active);

ALTER TABLE public.scan_categories ENABLE ROW LEVEL SECURITY;

-- Admins manage everything
CREATE POLICY "Admins manage scan_categories"
  ON public.scan_categories
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Any authenticated user can read active categories
CREATE POLICY "Authenticated read active scan_categories"
  ON public.scan_categories
  FOR SELECT
  TO authenticated
  USING (is_active = true OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER scan_categories_updated_at
  BEFORE UPDATE ON public.scan_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Link runs to category so we can filter results per category
ALTER TABLE public.store_scan_runs
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES public.scan_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_store_scan_runs_category ON public.store_scan_runs(category_id);
