CREATE TABLE IF NOT EXISTS public.shipment_backfill_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  backfill_year INTEGER NOT NULL,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  shipment_status TEXT NOT NULL,
  next_page INTEGER NOT NULL DEFAULT 1,
  next_token TEXT,
  pages_processed INTEGER NOT NULL DEFAULT 0,
  shipments_found INTEGER NOT NULL DEFAULT 0,
  shipments_upserted INTEGER NOT NULL DEFAULT 0,
  items_upserted INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, backfill_year, window_start, window_end, shipment_status)
);

ALTER TABLE public.shipment_backfill_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own shipment backfill progress" ON public.shipment_backfill_progress;
CREATE POLICY "Users can view their own shipment backfill progress"
ON public.shipment_backfill_progress
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own shipment backfill progress" ON public.shipment_backfill_progress;
CREATE POLICY "Users can create their own shipment backfill progress"
ON public.shipment_backfill_progress
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own shipment backfill progress" ON public.shipment_backfill_progress;
CREATE POLICY "Users can update their own shipment backfill progress"
ON public.shipment_backfill_progress
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own shipment backfill progress" ON public.shipment_backfill_progress;
CREATE POLICY "Users can delete their own shipment backfill progress"
ON public.shipment_backfill_progress
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS update_shipment_backfill_progress_updated_at ON public.shipment_backfill_progress;
CREATE TRIGGER update_shipment_backfill_progress_updated_at
BEFORE UPDATE ON public.shipment_backfill_progress
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_shipment_backfill_progress_user_year
ON public.shipment_backfill_progress(user_id, backfill_year, window_start, shipment_status);

CREATE INDEX IF NOT EXISTS idx_shipment_backfill_progress_user_state
ON public.shipment_backfill_progress(user_id, state, updated_at DESC);

CREATE OR REPLACE FUNCTION public.get_shipment_backfill_status(p_year integer)
RETURNS TABLE (
  window_start date,
  window_end date,
  shipment_status text,
  next_page integer,
  pages_processed integer,
  shipments_found integer,
  shipments_upserted integer,
  items_upserted integer,
  state text,
  last_error text,
  updated_at timestamptz,
  completed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    p.window_start,
    p.window_end,
    p.shipment_status,
    p.next_page,
    p.pages_processed,
    p.shipments_found,
    p.shipments_upserted,
    p.items_upserted,
    p.state,
    p.last_error,
    p.updated_at,
    p.completed_at
  FROM public.shipment_backfill_progress p
  WHERE p.user_id = auth.uid()
    AND p.backfill_year = p_year
  ORDER BY p.window_start ASC, p.shipment_status ASC;
$$;