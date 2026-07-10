
-- Replenishment orders (header)
CREATE TABLE public.replenishment_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT,
  total_units INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.replenishment_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own replenishment orders"
  ON public.replenishment_orders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own replenishment orders"
  ON public.replenishment_orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own replenishment orders"
  ON public.replenishment_orders FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own replenishment orders"
  ON public.replenishment_orders FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_replenishment_orders_updated_at
  BEFORE UPDATE ON public.replenishment_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Replenishment order items (line items)
CREATE TABLE public.replenishment_order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  replenishment_order_id UUID NOT NULL REFERENCES public.replenishment_orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  listing_id UUID REFERENCES public.created_listings(id) ON DELETE SET NULL,
  asin TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  image_url TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cost NUMERIC,
  supplier_link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.replenishment_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own replenishment items"
  ON public.replenishment_order_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own replenishment items"
  ON public.replenishment_order_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own replenishment items"
  ON public.replenishment_order_items FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own replenishment items"
  ON public.replenishment_order_items FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_replenishment_order_items_order_id ON public.replenishment_order_items(replenishment_order_id);
CREATE INDEX idx_replenishment_orders_user_id ON public.replenishment_orders(user_id);
