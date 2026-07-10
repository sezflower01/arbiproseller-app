CREATE TABLE public.still_thinking_listings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  title TEXT,
  image_url TEXT,
  supplier_url TEXT,
  supplier_domain TEXT,
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  marketplace TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'thinking',
  converted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX still_thinking_user_asin_active_uidx
  ON public.still_thinking_listings (user_id, asin)
  WHERE status = 'thinking';

CREATE INDEX still_thinking_user_created_idx
  ON public.still_thinking_listings (user_id, created_at DESC);

ALTER TABLE public.still_thinking_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own still_thinking"
  ON public.still_thinking_listings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own still_thinking"
  ON public.still_thinking_listings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own still_thinking"
  ON public.still_thinking_listings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own still_thinking"
  ON public.still_thinking_listings FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER set_still_thinking_updated_at
  BEFORE UPDATE ON public.still_thinking_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();