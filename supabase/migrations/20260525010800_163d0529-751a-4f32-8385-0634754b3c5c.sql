CREATE TABLE IF NOT EXISTS public.module_usage (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  path TEXT NOT NULL,
  label TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  last_used TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_module_usage_user ON public.module_usage(user_id, count DESC, last_used DESC);

ALTER TABLE public.module_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own module usage"
  ON public.module_usage FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own module usage"
  ON public.module_usage FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own module usage"
  ON public.module_usage FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own module usage"
  ON public.module_usage FOR DELETE
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.record_module_usage(_path TEXT, _label TEXT DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.module_usage (user_id, path, label, count, last_used, updated_at)
  VALUES (auth.uid(), _path, _label, 1, now(), now())
  ON CONFLICT (user_id, path) DO UPDATE
    SET count = public.module_usage.count + 1,
        last_used = now(),
        updated_at = now(),
        label = COALESCE(EXCLUDED.label, public.module_usage.label);
END;
$$;