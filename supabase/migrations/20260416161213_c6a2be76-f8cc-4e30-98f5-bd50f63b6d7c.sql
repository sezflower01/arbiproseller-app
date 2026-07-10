
-- 1. Global catalog table (admin-fed from Keepa)
CREATE TABLE public.keepa_catalog_products (
  asin TEXT PRIMARY KEY,
  title TEXT,
  brand TEXT,
  category TEXT,
  image_url TEXT,
  buy_box_price NUMERIC,
  sales_rank_current INTEGER,
  monthly_sold INTEGER,
  new_offer_count INTEGER,
  fba_offer_count INTEGER,
  amazon_on_listing BOOLEAN DEFAULT false,
  rating NUMERIC,
  review_count INTEGER,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.keepa_catalog_products ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read catalog
CREATE POLICY "Authenticated users can read catalog"
  ON public.keepa_catalog_products FOR SELECT
  TO authenticated USING (true);

-- Only admins can insert/update/delete catalog
CREATE POLICY "Admins can insert catalog"
  ON public.keepa_catalog_products FOR INSERT
  TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update catalog"
  ON public.keepa_catalog_products FOR UPDATE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete catalog"
  ON public.keepa_catalog_products FOR DELETE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Index for common filters
CREATE INDEX idx_keepa_catalog_brand ON public.keepa_catalog_products (brand);
CREATE INDEX idx_keepa_catalog_category ON public.keepa_catalog_products (category);
CREATE INDEX idx_keepa_catalog_rank ON public.keepa_catalog_products (sales_rank_current);
CREATE INDEX idx_keepa_catalog_monthly_sold ON public.keepa_catalog_products (monthly_sold);

-- Auto-update timestamp
CREATE TRIGGER update_keepa_catalog_updated_at
  BEFORE UPDATE ON public.keepa_catalog_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Per-user approved products
CREATE TABLE public.user_approved_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  approval_status TEXT NOT NULL DEFAULT 'approved',
  checked_at TIMESTAMPTZ,
  score NUMERIC,
  batch_no INTEGER,
  hidden BOOLEAN NOT NULL DEFAULT false,
  saved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, marketplace)
);

ALTER TABLE public.user_approved_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own approved products"
  ON public.user_approved_products FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own approved products"
  ON public.user_approved_products FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own approved products"
  ON public.user_approved_products FOR UPDATE
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own approved products"
  ON public.user_approved_products FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- Admins can also manage all approved products
CREATE POLICY "Admins can read all approved products"
  ON public.user_approved_products FOR SELECT
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert approved products"
  ON public.user_approved_products FOR INSERT
  TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update approved products"
  ON public.user_approved_products FOR UPDATE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete approved products"
  ON public.user_approved_products FOR DELETE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_user_approved_user ON public.user_approved_products (user_id);
CREATE INDEX idx_user_approved_asin ON public.user_approved_products (asin);
CREATE INDEX idx_user_approved_batch ON public.user_approved_products (user_id, batch_no);

CREATE TRIGGER update_user_approved_updated_at
  BEFORE UPDATE ON public.user_approved_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Joined view for the user page
CREATE OR REPLACE VIEW public.user_approved_products_view AS
SELECT
  uap.id,
  uap.user_id,
  uap.asin,
  uap.marketplace,
  uap.approval_status,
  uap.checked_at,
  uap.score,
  uap.batch_no,
  uap.hidden,
  uap.saved,
  uap.created_at,
  uap.updated_at,
  kcp.title,
  kcp.brand,
  kcp.category,
  kcp.image_url,
  kcp.buy_box_price,
  kcp.sales_rank_current,
  kcp.monthly_sold,
  kcp.new_offer_count,
  kcp.fba_offer_count,
  kcp.amazon_on_listing,
  kcp.rating,
  kcp.review_count
FROM public.user_approved_products uap
LEFT JOIN public.keepa_catalog_products kcp ON kcp.asin = uap.asin;
