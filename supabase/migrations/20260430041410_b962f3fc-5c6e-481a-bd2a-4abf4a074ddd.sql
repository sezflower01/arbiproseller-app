CREATE TABLE public.gmail_saved_filters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  label TEXT NOT NULL,
  query TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.gmail_saved_filters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own gmail filters" ON public.gmail_saved_filters
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own gmail filters" ON public.gmail_saved_filters
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own gmail filters" ON public.gmail_saved_filters
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own gmail filters" ON public.gmail_saved_filters
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_gmail_saved_filters_user ON public.gmail_saved_filters(user_id, sort_order);