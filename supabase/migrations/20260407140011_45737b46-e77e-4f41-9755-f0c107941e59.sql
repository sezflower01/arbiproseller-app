CREATE TABLE public.inventory_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT NOT NULL,
  available INTEGER DEFAULT 0,
  reserved INTEGER DEFAULT 0,
  inbound INTEGER DEFAULT 0,
  listing_status TEXT,
  source TEXT,
  sync_trace_id TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_history_user_asin ON public.inventory_history (user_id, asin, captured_at DESC);
CREATE INDEX idx_inventory_history_captured ON public.inventory_history (captured_at);

ALTER TABLE public.inventory_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own inventory history"
  ON public.inventory_history FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.fn_capture_inventory_history()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  IF (OLD.available IS DISTINCT FROM NEW.available)
     OR (OLD.reserved IS DISTINCT FROM NEW.reserved)
     OR (OLD.inbound IS DISTINCT FROM NEW.inbound)
     OR (OLD.listing_status IS DISTINCT FROM NEW.listing_status) THEN
    INSERT INTO public.inventory_history (user_id, asin, sku, available, reserved, inbound, listing_status, source)
    VALUES (NEW.user_id, NEW.asin, NEW.sku, NEW.available, NEW.reserved, NEW.inbound, NEW.listing_status, NEW.source);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_history
  AFTER UPDATE ON public.inventory
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_capture_inventory_history();