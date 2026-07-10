-- Inventory write-offs table for warehouse losses (separate from Amazon disposition)
CREATE TABLE public.inventory_writeoffs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  writeoff_date date NOT NULL,
  asin text,
  sku text,
  title text,
  quantity integer NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT 'restricted',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_writeoffs_user_date ON public.inventory_writeoffs(user_id, writeoff_date DESC);
CREATE INDEX idx_inventory_writeoffs_asin ON public.inventory_writeoffs(user_id, asin);

ALTER TABLE public.inventory_writeoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own writeoffs"
  ON public.inventory_writeoffs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own writeoffs"
  ON public.inventory_writeoffs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own writeoffs"
  ON public.inventory_writeoffs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own writeoffs"
  ON public.inventory_writeoffs FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all writeoffs"
  ON public.inventory_writeoffs FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_inventory_writeoffs_updated_at
  BEFORE UPDATE ON public.inventory_writeoffs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();