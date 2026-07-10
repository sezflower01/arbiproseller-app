
CREATE TABLE IF NOT EXISTS public.keepa_simple_products (
  asin text NOT NULL,
  title text,
  brand text,
  category text,
  image_url text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asin)
);

CREATE INDEX idx_ksp_title ON public.keepa_simple_products USING gin(to_tsvector('english', coalesce(title, '')));
CREATE INDEX idx_ksp_brand ON public.keepa_simple_products(brand);
CREATE INDEX idx_ksp_category ON public.keepa_simple_products(category);

ALTER TABLE public.keepa_simple_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read keepa_simple_products"
  ON public.keepa_simple_products FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage keepa_simple_products"
  ON public.keepa_simple_products FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
