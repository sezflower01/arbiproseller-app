CREATE TABLE IF NOT EXISTS public.shipment_box_defaults (
  user_id UUID NOT NULL PRIMARY KEY,
  length NUMERIC NOT NULL DEFAULT 27,
  width NUMERIC NOT NULL DEFAULT 17,
  height NUMERIC NOT NULL DEFAULT 15,
  dimension_unit TEXT NOT NULL DEFAULT 'in',
  weight NUMERIC NOT NULL DEFAULT 50,
  weight_unit TEXT NOT NULL DEFAULT 'lb',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.shipment_box_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own box defaults"
  ON public.shipment_box_defaults FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users insert own box defaults"
  ON public.shipment_box_defaults FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own box defaults"
  ON public.shipment_box_defaults FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own box defaults"
  ON public.shipment_box_defaults FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_shipment_box_defaults_updated
  BEFORE UPDATE ON public.shipment_box_defaults
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();