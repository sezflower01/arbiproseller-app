CREATE TABLE public.analyzer_notes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  notes TEXT DEFAULT '',
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, marketplace)
);

CREATE INDEX idx_analyzer_notes_user_asin ON public.analyzer_notes(user_id, asin);

ALTER TABLE public.analyzer_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own analyzer notes"
  ON public.analyzer_notes FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users insert own analyzer notes"
  ON public.analyzer_notes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own analyzer notes"
  ON public.analyzer_notes FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own analyzer notes"
  ON public.analyzer_notes FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_analyzer_notes_updated_at
  BEFORE UPDATE ON public.analyzer_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();