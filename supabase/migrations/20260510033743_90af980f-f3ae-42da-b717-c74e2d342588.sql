-- Per-user cached Keepa seller storefront summary
CREATE TABLE public.seller_storefront_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  seller_id TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  store JSONB NOT NULL,
  asin_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_brands JSONB NOT NULL DEFAULT '[]'::jsonb,
  top_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, seller_id, marketplace)
);

CREATE INDEX idx_seller_storefront_cache_lookup
  ON public.seller_storefront_cache (user_id, seller_id, marketplace);

ALTER TABLE public.seller_storefront_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own seller cache"
  ON public.seller_storefront_cache FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own seller cache"
  ON public.seller_storefront_cache FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own seller cache"
  ON public.seller_storefront_cache FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own seller cache"
  ON public.seller_storefront_cache FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_seller_storefront_cache_updated
  BEFORE UPDATE ON public.seller_storefront_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Per-user cached page details
CREATE TABLE public.seller_storefront_page_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  seller_id TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  page INT NOT NULL,
  page_size INT NOT NULL,
  page_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, seller_id, marketplace, page, page_size)
);

CREATE INDEX idx_seller_storefront_page_cache_lookup
  ON public.seller_storefront_page_cache (user_id, seller_id, marketplace, page, page_size);

ALTER TABLE public.seller_storefront_page_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own seller page cache"
  ON public.seller_storefront_page_cache FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own seller page cache"
  ON public.seller_storefront_page_cache FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own seller page cache"
  ON public.seller_storefront_page_cache FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own seller page cache"
  ON public.seller_storefront_page_cache FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_seller_storefront_page_cache_updated
  BEFORE UPDATE ON public.seller_storefront_page_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();