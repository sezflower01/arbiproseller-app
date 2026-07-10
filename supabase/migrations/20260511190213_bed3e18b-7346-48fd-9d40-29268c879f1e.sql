
-- ─────────────────────────────────────────────────────────────────
-- Phase C2: validation queue table (service-role only)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.listing_validation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.created_listings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  asin text NOT NULL,
  sku text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  next_stage text NOT NULL DEFAULT 'await_fnsku',
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_validation_queue_due
  ON public.listing_validation_queue(next_stage, next_run_at)
  WHERE next_stage IS NOT NULL;

ALTER TABLE public.listing_validation_queue ENABLE ROW LEVEL SECURITY;

-- Read-only visibility for owners (so UI can show queue position if needed)
DROP POLICY IF EXISTS "Users view own validation queue" ON public.listing_validation_queue;
CREATE POLICY "Users view own validation queue"
  ON public.listing_validation_queue
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policies — service role only via edge functions.

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_listing_validation_queue_updated_at ON public.listing_validation_queue;
CREATE TRIGGER trg_listing_validation_queue_updated_at
  BEFORE UPDATE ON public.listing_validation_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
