CREATE OR REPLACE FUNCTION public.normalize_store_scan_scope_url(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;

  v := lower(trim(raw));
  IF v = '' THEN
    RETURN NULL;
  END IF;

  v := regexp_replace(v, '#.*$', '');
  v := regexp_replace(v, '^https?://', '');
  v := regexp_replace(v, '^www\.', '');
  v := regexp_replace(v, '\?.*$', '');
  v := regexp_replace(v, '/+$', '');

  IF v = '' THEN
    RETURN NULL;
  END IF;

  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_link_scan_category_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.store_scan_runs r
  SET category_id = NULL,
      updated_at = now()
  WHERE r.category_id = NEW.id
    AND (
      lower(r.supplier_domain) <> lower(NEW.supplier_domain)
      OR NOT EXISTS (
        SELECT 1
        FROM unnest(COALESCE(r.scope_urls, ARRAY[]::text[])) AS run_url
        JOIN unnest(COALESCE(NEW.urls, ARRAY[]::text[])) AS cat_url
          ON public.normalize_store_scan_scope_url(run_url) = public.normalize_store_scan_scope_url(cat_url)
      )
    );

  UPDATE public.store_scan_runs r
  SET category_id = NEW.id,
      updated_at = now()
  WHERE EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = r.user_id
        AND ur.role = 'admin'
    )
    AND lower(r.supplier_domain) = lower(NEW.supplier_domain)
    AND EXISTS (
      SELECT 1
      FROM unnest(COALESCE(r.scope_urls, ARRAY[]::text[])) AS run_url
      JOIN unnest(COALESCE(NEW.urls, ARRAY[]::text[])) AS cat_url
        ON public.normalize_store_scan_scope_url(run_url) = public.normalize_store_scan_scope_url(cat_url)
    )
    AND (r.category_id IS NULL OR r.category_id = NEW.id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_scan_category_runs ON public.scan_categories;
CREATE TRIGGER trg_link_scan_category_runs
AFTER INSERT OR UPDATE OF supplier_domain, urls
ON public.scan_categories
FOR EACH ROW
EXECUTE FUNCTION public.fn_link_scan_category_runs();

DO $$
DECLARE
  cat record;
BEGIN
  FOR cat IN
    SELECT id, supplier_domain, urls
    FROM public.scan_categories
  LOOP
    UPDATE public.store_scan_runs r
    SET category_id = cat.id,
        updated_at = now()
    WHERE EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = r.user_id
          AND ur.role = 'admin'
      )
      AND r.category_id IS NULL
      AND lower(r.supplier_domain) = lower(cat.supplier_domain)
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(r.scope_urls, ARRAY[]::text[])) AS run_url
        JOIN unnest(COALESCE(cat.urls, ARRAY[]::text[])) AS cat_url
          ON public.normalize_store_scan_scope_url(run_url) = public.normalize_store_scan_scope_url(cat_url)
      );
  END LOOP;
END;
$$;