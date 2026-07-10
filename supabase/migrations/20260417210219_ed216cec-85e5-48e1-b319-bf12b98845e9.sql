-- 1. Extend scan_categories with tier + scheduling
ALTER TABLE public.scan_categories
  ADD COLUMN IF NOT EXISTS scan_tier text NOT NULL DEFAULT 'normal'
    CHECK (scan_tier IN ('hot', 'normal', 'slow')),
  ADD COLUMN IF NOT EXISTS next_scan_due_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_scan_categories_next_due
  ON public.scan_categories (next_scan_due_at)
  WHERE is_active = true;

-- 2. category_products — per-product state per category
CREATE TABLE IF NOT EXISTS public.category_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.scan_categories(id) ON DELETE CASCADE,
  supplier_domain text NOT NULL,
  url_key text NOT NULL,
  product_url text NOT NULL,
  supplier_product_id text,
  current_title text,
  current_price numeric(12,2),
  current_currency text DEFAULT 'USD',
  current_image text,
  availability text,
  fingerprint text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed', 'stale')),
  miss_count integer NOT NULL DEFAULT 0,
  pending_pdp_refresh boolean NOT NULL DEFAULT false,
  pdp_refresh_reason text
    CHECK (pdp_refresh_reason IS NULL OR pdp_refresh_reason IN ('new_product', 'fingerprint_changed', 'stale_refresh')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_pdp_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, url_key)
);

CREATE INDEX IF NOT EXISTS idx_category_products_category ON public.category_products (category_id);
CREATE INDEX IF NOT EXISTS idx_category_products_status ON public.category_products (status);
CREATE INDEX IF NOT EXISTS idx_category_products_pending ON public.category_products (pending_pdp_refresh) WHERE pending_pdp_refresh = true;
CREATE INDEX IF NOT EXISTS idx_category_products_supplier_domain ON public.category_products (supplier_domain);

ALTER TABLE public.category_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read category_products"
  ON public.category_products FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert category_products"
  ON public.category_products FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update category_products"
  ON public.category_products FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete category_products"
  ON public.category_products FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_category_products_updated_at
  BEFORE UPDATE ON public.category_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. product_change_log — append-only log of price/title/availability changes
CREATE TABLE IF NOT EXISTS public.product_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.category_products(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.scan_categories(id) ON DELETE CASCADE,
  changed_field text NOT NULL CHECK (changed_field IN ('price', 'title', 'availability')),
  old_value text,
  new_value text,
  scan_job_id uuid,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_change_log_product ON public.product_change_log (product_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_change_log_category ON public.product_change_log (category_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_change_log_scan_job ON public.product_change_log (scan_job_id);

ALTER TABLE public.product_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read product_change_log"
  ON public.product_change_log FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert product_change_log"
  ON public.product_change_log FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 4. category_scan_jobs — audit + per-category scan lock
CREATE TABLE IF NOT EXISTS public.category_scan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.scan_categories(id) ON DELETE CASCADE,
  scan_type text NOT NULL CHECK (scan_type IN ('full_seed', 'diff', 'pdp_refresh')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  triggered_by text NOT NULL DEFAULT 'manual'
    CHECK (triggered_by IN ('manual', 'scheduler', 'api')),
  triggered_by_user uuid,
  added_count integer NOT NULL DEFAULT 0,
  removed_count integer NOT NULL DEFAULT 0,
  changed_count integer NOT NULL DEFAULT 0,
  unchanged_count integer NOT NULL DEFAULT 0,
  fetch_failed_count integer NOT NULL DEFAULT 0,
  parse_failed_count integer NOT NULL DEFAULT 0,
  pdp_queued_count integer NOT NULL DEFAULT 0,
  duration_ms integer,
  estimated_cost numeric(10,4) NOT NULL DEFAULT 0,
  scraper_provider text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  lock_expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_category_scan_jobs_category ON public.category_scan_jobs (category_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_category_scan_jobs_status ON public.category_scan_jobs (status);
-- Partial unique index: only one running job per category at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_scan_jobs_running_lock
  ON public.category_scan_jobs (category_id)
  WHERE status = 'running';

ALTER TABLE public.category_scan_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read category_scan_jobs"
  ON public.category_scan_jobs FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert category_scan_jobs"
  ON public.category_scan_jobs FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update category_scan_jobs"
  ON public.category_scan_jobs FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));