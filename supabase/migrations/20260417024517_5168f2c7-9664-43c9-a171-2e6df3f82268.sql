-- Supplier Registry: per-user curated supplier network for Supplier Discovery ranking
CREATE TABLE IF NOT EXISTS public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  domain text NOT NULL,
  supplier_name text,
  supplier_type text NOT NULL DEFAULT 'unknown',
  trust_level text NOT NULL DEFAULT 'unknown',
  source_origin text NOT NULL DEFAULT 'user_added',
  supports_scraping boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_supplier_type_chk
    CHECK (supplier_type IN ('retail','wholesale','distributor','unknown')),
  CONSTRAINT suppliers_trust_level_chk
    CHECK (trust_level IN ('unknown','trusted','verified')),
  CONSTRAINT suppliers_source_origin_chk
    CHECK (source_origin IN ('curated','tactical_arbitrage','user_added'))
);

-- Domain normalization: enforce lowercase, no leading www.
CREATE OR REPLACE FUNCTION public.fn_normalize_supplier_domain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.domain IS NOT NULL THEN
    NEW.domain := lower(trim(NEW.domain));
    NEW.domain := regexp_replace(NEW.domain, '^https?://', '');
    NEW.domain := regexp_replace(NEW.domain, '^www\.', '');
    NEW.domain := regexp_replace(NEW.domain, '/.*$', '');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_suppliers_normalize ON public.suppliers;
CREATE TRIGGER trg_suppliers_normalize
BEFORE INSERT OR UPDATE ON public.suppliers
FOR EACH ROW EXECUTE FUNCTION public.fn_normalize_supplier_domain();

-- Unique per user + domain
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_user_domain_uidx
  ON public.suppliers(user_id, domain);

-- Fast lookup by user during ranking
CREATE INDEX IF NOT EXISTS suppliers_user_idx
  ON public.suppliers(user_id);

-- RLS
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own suppliers"
ON public.suppliers FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own suppliers"
ON public.suppliers FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own suppliers"
ON public.suppliers FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own suppliers"
ON public.suppliers FOR DELETE
USING (auth.uid() = user_id);