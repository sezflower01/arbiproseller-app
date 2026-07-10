
CREATE TABLE IF NOT EXISTS public.shipment_purchase_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  draft_id text NOT NULL,
  shipment_id text,
  created_listing_id uuid NOT NULL REFERENCES public.created_listings(id) ON DELETE CASCADE,
  asin text NOT NULL,
  sku text,
  units_allocated integer NOT NULL DEFAULT 0,
  units_shipped integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipment_purchase_allocations_unique UNIQUE (user_id, draft_id, created_listing_id)
);

CREATE INDEX IF NOT EXISTS idx_spa_user_asin ON public.shipment_purchase_allocations(user_id, asin);
CREATE INDEX IF NOT EXISTS idx_spa_user_draft ON public.shipment_purchase_allocations(user_id, draft_id);

ALTER TABLE public.shipment_purchase_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "spa_select_own" ON public.shipment_purchase_allocations
  FOR SELECT USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "spa_insert_own" ON public.shipment_purchase_allocations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "spa_update_own" ON public.shipment_purchase_allocations
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "spa_delete_own" ON public.shipment_purchase_allocations
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER spa_updated_at
  BEFORE UPDATE ON public.shipment_purchase_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
