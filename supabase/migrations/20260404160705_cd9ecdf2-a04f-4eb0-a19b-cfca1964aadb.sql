
CREATE TABLE public.error_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email TEXT,
  error_message TEXT NOT NULL,
  error_context TEXT,
  page_url TEXT,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.error_reports ENABLE ROW LEVEL SECURITY;

-- Admins can see all error reports
CREATE POLICY "Admins can view all error reports"
ON public.error_reports FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Any authenticated user can insert error reports
CREATE POLICY "Users can insert error reports"
ON public.error_reports FOR INSERT TO authenticated
WITH CHECK (true);

-- Admins can update (resolve) error reports
CREATE POLICY "Admins can update error reports"
ON public.error_reports FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
