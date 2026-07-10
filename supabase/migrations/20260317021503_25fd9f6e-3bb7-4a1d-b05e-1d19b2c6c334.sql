
CREATE TABLE public.amazon_categories (
  id bigint PRIMARY KEY,
  marketplace text NOT NULL DEFAULT 'US',
  name text NOT NULL,
  context_free_name text,
  parent_id bigint REFERENCES public.amazon_categories(id),
  is_root boolean NOT NULL DEFAULT false,
  depth int NOT NULL DEFAULT 0,
  path text,
  children_count int NOT NULL DEFAULT 0,
  product_count bigint DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_amazon_categories_marketplace ON public.amazon_categories(marketplace);
CREATE INDEX idx_amazon_categories_parent ON public.amazon_categories(parent_id);
CREATE INDEX idx_amazon_categories_name ON public.amazon_categories(marketplace, name);
CREATE INDEX idx_amazon_categories_root ON public.amazon_categories(marketplace, is_root) WHERE is_root = true;

ALTER TABLE public.amazon_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read categories"
  ON public.amazon_categories FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage categories"
  ON public.amazon_categories FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
