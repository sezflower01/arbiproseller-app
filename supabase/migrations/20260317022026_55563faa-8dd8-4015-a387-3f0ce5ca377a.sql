
CREATE TABLE public.keepa_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asin text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  title text,
  brand text,
  manufacturer text,
  category text,
  image_url text,
  sales_rank int,
  buy_box_price numeric,
  amazon_price numeric,
  new_price numeric,
  fba_price numeric,
  fbm_price numeric,
  drops_30 int DEFAULT 0,
  drops_90 int DEFAULT 0,
  monthly_sold int,
  new_offer_count int DEFAULT 0,
  fba_offer_count int DEFAULT 0,
  fbm_offer_count int DEFAULT 0,
  rating numeric,
  rating_count int,
  is_hazmat boolean DEFAULT false,
  is_adult_product boolean DEFAULT false,
  is_meltable boolean DEFAULT false,
  amazon_link text,
  category_id bigint,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(asin, marketplace)
);

CREATE INDEX idx_keepa_products_marketplace ON public.keepa_products(marketplace);
CREATE INDEX idx_keepa_products_title ON public.keepa_products USING gin(to_tsvector('english', coalesce(title, '')));
CREATE INDEX idx_keepa_products_brand ON public.keepa_products(marketplace, brand);
CREATE INDEX idx_keepa_products_category ON public.keepa_products(marketplace, category_id);
CREATE INDEX idx_keepa_products_rank ON public.keepa_products(marketplace, sales_rank);
CREATE INDEX idx_keepa_products_bbprice ON public.keepa_products(marketplace, buy_box_price);
CREATE INDEX idx_keepa_products_drops30 ON public.keepa_products(marketplace, drops_30);

ALTER TABLE public.keepa_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read keepa_products"
  ON public.keepa_products FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage keepa_products"
  ON public.keepa_products FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
