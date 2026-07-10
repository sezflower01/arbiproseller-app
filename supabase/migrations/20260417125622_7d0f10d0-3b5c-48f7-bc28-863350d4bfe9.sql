-- Phase 2: Store Scan minimal schema
-- supplier_scan_profiles: admin-curated per-supplier crawl/extract config
CREATE TABLE public.supplier_scan_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  sitemap_urls TEXT[] DEFAULT ARRAY[]::TEXT[],
  category_urls TEXT[] DEFAULT ARRAY[]::TEXT[],
  pagination_type TEXT NOT NULL DEFAULT 'query_param', -- 'query_param' | 'path' | 'none'
  pagination_param TEXT DEFAULT 'page',
  product_link_selector TEXT,
  product_title_selector TEXT,
  product_price_selector TEXT,
  product_image_selector TEXT,
  product_upc_selector TEXT,
  max_pages_per_run INTEGER NOT NULL DEFAULT 5,
  max_products_per_run INTEGER NOT NULL DEFAULT 100,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.supplier_scan_profiles ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read enabled profiles (curated catalog)
CREATE POLICY "Authenticated users can view enabled scan profiles"
  ON public.supplier_scan_profiles FOR SELECT
  TO authenticated
  USING (is_enabled = true OR public.has_role(auth.uid(), 'admin'));

-- Only admins manage profiles
CREATE POLICY "Admins can insert scan profiles"
  ON public.supplier_scan_profiles FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update scan profiles"
  ON public.supplier_scan_profiles FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete scan profiles"
  ON public.supplier_scan_profiles FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_supplier_scan_profiles_updated_at
  BEFORE UPDATE ON public.supplier_scan_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- store_scan_runs: per-user scan job tracking
CREATE TABLE public.store_scan_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  profile_id UUID REFERENCES public.supplier_scan_profiles(id) ON DELETE SET NULL,
  supplier_domain TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'category_url', -- 'category_url' | 'sitemap' | 'entire_store' (future)
  scope_urls TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'pending', -- pending|crawling|extracting|matching|done|error
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  products_found INTEGER NOT NULL DEFAULT 0,
  products_extracted INTEGER NOT NULL DEFAULT 0,
  products_matched INTEGER NOT NULL DEFAULT 0,
  max_products_cap INTEGER NOT NULL DEFAULT 100,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.store_scan_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own store scan runs"
  ON public.store_scan_runs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users create own store scan runs"
  ON public.store_scan_runs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own store scan runs"
  ON public.store_scan_runs FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own store scan runs"
  ON public.store_scan_runs FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX idx_store_scan_runs_user_created ON public.store_scan_runs(user_id, created_at DESC);

CREATE TRIGGER trg_store_scan_runs_updated_at
  BEFORE UPDATE ON public.store_scan_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- store_scan_items: extracted products + Amazon match results
CREATE TABLE public.store_scan_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.store_scan_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  source_url TEXT NOT NULL,
  source_title TEXT,
  source_price NUMERIC,
  source_currency TEXT DEFAULT 'USD',
  source_image_url TEXT,
  source_upc TEXT,
  source_brand TEXT,
  source_availability TEXT,
  matched_asin TEXT,
  amz_title TEXT,
  amz_price NUMERIC,
  amz_image_url TEXT,
  match_score NUMERIC,
  match_method TEXT, -- 'upc' | 'title' | 'image' | 'none'
  fees_json JSONB,
  roi NUMERIC,
  margin_pct NUMERIC,
  status TEXT NOT NULL DEFAULT 'extracted', -- extracted|matched|no_match|error
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.store_scan_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own store scan items"
  ON public.store_scan_items FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users create own store scan items"
  ON public.store_scan_items FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own store scan items"
  ON public.store_scan_items FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own store scan items"
  ON public.store_scan_items FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX idx_store_scan_items_run ON public.store_scan_items(run_id);
CREATE INDEX idx_store_scan_items_user ON public.store_scan_items(user_id, created_at DESC);

-- Seed pilot suppliers (admin-curated)
INSERT INTO public.supplier_scan_profiles (domain, display_name, sitemap_urls, pagination_type, pagination_param, max_pages_per_run, max_products_per_run, notes) VALUES
  ('target.com', 'Target', ARRAY['https://www.target.com/sitemap_index.xml'], 'query_param', 'Nao', 5, 100, 'Pilot supplier'),
  ('walmart.com', 'Walmart', ARRAY['https://www.walmart.com/sitemap_browse.xml'], 'query_param', 'page', 5, 100, 'Pilot supplier'),
  ('costco.com', 'Costco', ARRAY['https://www.costco.com/sitemap_l1_index.xml'], 'query_param', 'currentPage', 5, 100, 'Pilot supplier — membership may block'),
  ('bestbuy.com', 'Best Buy', ARRAY['https://www.bestbuy.com/sitemap_index.xml'], 'query_param', 'cp', 5, 100, 'Pilot supplier'),
  ('homedepot.com', 'Home Depot', ARRAY['https://www.homedepot.com/sitemap.xml'], 'path', 'Nao', 5, 100, 'Pilot supplier');
