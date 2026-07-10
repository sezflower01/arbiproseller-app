-- 1. product_finder_runs: one row per Find Products execution
CREATE TABLE public.product_finder_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  filters_json JSONB DEFAULT '{}'::jsonb,
  result_count INTEGER NOT NULL DEFAULT 0,
  run_status TEXT NOT NULL DEFAULT 'completed',
  daily_usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_pfr_user_created ON public.product_finder_runs(user_id, created_at DESC);
CREATE INDEX idx_pfr_user_daily ON public.product_finder_runs(user_id, daily_usage_date);

ALTER TABLE public.product_finder_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own runs" ON public.product_finder_runs
  FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users create own runs" ON public.product_finder_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own runs" ON public.product_finder_runs
  FOR UPDATE USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users delete own runs" ON public.product_finder_runs
  FOR DELETE USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_pfr_updated_at
  BEFORE UPDATE ON public.product_finder_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. product_finder_run_items: ASINs delivered in each run
CREATE TABLE public.product_finder_run_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.product_finder_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  position INTEGER,
  score NUMERIC,
  saved BOOLEAN NOT NULL DEFAULT false,
  dismissed BOOLEAN NOT NULL DEFAULT false,
  clicked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (run_id, asin)
);

CREATE INDEX idx_pfri_user_asin ON public.product_finder_run_items(user_id, asin, marketplace);
CREATE INDEX idx_pfri_run ON public.product_finder_run_items(run_id, position);

ALTER TABLE public.product_finder_run_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own run items" ON public.product_finder_run_items
  FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users create own run items" ON public.product_finder_run_items
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own run items" ON public.product_finder_run_items
  FOR UPDATE USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users delete own run items" ON public.product_finder_run_items
  FOR DELETE USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- 3. user_owned_products: permanent personal ASIN database
CREATE TABLE public.user_owned_products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  title TEXT,
  brand TEXT,
  category TEXT,
  image_url TEXT,
  buy_box_price NUMERIC,
  sales_rank INTEGER,
  monthly_sold INTEGER,
  score NUMERIC,
  run_id UUID REFERENCES public.product_finder_runs(id) ON DELETE SET NULL,
  delivered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, marketplace)
);

CREATE INDEX idx_uop_user_delivered ON public.user_owned_products(user_id, delivered_at DESC);
CREATE INDEX idx_uop_user_asin ON public.user_owned_products(user_id, asin, marketplace);

ALTER TABLE public.user_owned_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own owned products" ON public.user_owned_products
  FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users create own owned products" ON public.user_owned_products
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own owned products" ON public.user_owned_products
  FOR UPDATE USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users delete own owned products" ON public.user_owned_products
  FOR DELETE USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_uop_updated_at
  BEFORE UPDATE ON public.user_owned_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();