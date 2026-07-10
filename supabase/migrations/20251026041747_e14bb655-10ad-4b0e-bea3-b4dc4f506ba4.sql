-- Create app role enum for admin access
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

-- Create user_roles table for secure role checking
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security definer function to check roles (prevents RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- RLS policies for user_roles
CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all roles"
  ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Add credits and plan to profiles table
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;

-- Product catalog table (stores millions of titles/ASINs)
CREATE TABLE IF NOT EXISTS public.product_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asin TEXT,
  title TEXT NOT NULL,
  image_url TEXT,
  brand TEXT,
  price NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.product_catalog ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can view catalog
CREATE POLICY "Authenticated users can view catalog"
  ON public.product_catalog FOR SELECT
  USING (auth.role() = 'authenticated');

-- Admins can manage catalog
CREATE POLICY "Admins can manage catalog"
  ON public.product_catalog FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Create index for efficient pagination
CREATE INDEX idx_product_catalog_id ON public.product_catalog(id);
CREATE INDEX idx_product_catalog_title ON public.product_catalog(title);

-- Automation runs table
CREATE TABLE public.automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  name TEXT,
  source_filter JSONB,
  total INTEGER DEFAULT 0,
  processed INTEGER DEFAULT 0,
  matched INTEGER DEFAULT 0,
  status TEXT DEFAULT 'queued',
  error TEXT,
  avg_roi NUMERIC(10,2)
);

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own runs"
  ON public.automation_runs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all runs"
  ON public.automation_runs FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- Cursor table for pagination
CREATE TABLE public.automation_run_cursor (
  run_id UUID PRIMARY KEY REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  last_seen_id UUID,
  last_updated TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.automation_run_cursor ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage cursors for their runs"
  ON public.automation_run_cursor FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.automation_runs r 
    WHERE r.id = run_id AND r.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.automation_runs r 
    WHERE r.id = run_id AND r.user_id = auth.uid()
  ));

-- Results table
CREATE TABLE public.automation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.automation_runs(id) ON DELETE CASCADE,
  catalog_id UUID REFERENCES public.product_catalog(id) ON DELETE CASCADE,
  input_title TEXT,
  input_asin TEXT,
  g_store TEXT,
  g_title TEXT,
  g_price NUMERIC(10,2),
  g_link TEXT,
  g_image TEXT,
  amz_asin TEXT,
  amz_title TEXT,
  amz_price NUMERIC(10,2),
  amz_link TEXT,
  amz_image TEXT,
  title_score INTEGER,
  image_score INTEGER,
  match_score INTEGER,
  roi NUMERIC(10,2),
  margin_pct NUMERIC(5,2),
  fees_json JSONB,
  status TEXT DEFAULT 'done',
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(run_id, catalog_id)
);

ALTER TABLE public.automation_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view results for their runs"
  ON public.automation_results FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.automation_runs r 
    WHERE r.id = run_id AND r.user_id = auth.uid()
  ));

CREATE POLICY "Users can insert results for their runs"
  ON public.automation_results FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.automation_runs r 
    WHERE r.id = run_id AND r.user_id = auth.uid()
  ));

CREATE POLICY "Admins can view all results"
  ON public.automation_results FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_runs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_results;

-- Set replica identity for realtime
ALTER TABLE public.automation_runs REPLICA IDENTITY FULL;
ALTER TABLE public.automation_results REPLICA IDENTITY FULL;

-- Trigger to update automation_runs stats
CREATE OR REPLACE FUNCTION update_automation_run_stats()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.automation_runs
  SET 
    processed = (SELECT COUNT(*) FROM public.automation_results WHERE run_id = NEW.run_id),
    matched = (SELECT COUNT(*) FROM public.automation_results WHERE run_id = NEW.run_id AND match_score >= 70),
    avg_roi = (SELECT AVG(roi) FROM public.automation_results WHERE run_id = NEW.run_id AND roi IS NOT NULL)
  WHERE id = NEW.run_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER update_run_stats_on_result
AFTER INSERT OR UPDATE ON public.automation_results
FOR EACH ROW
EXECUTE FUNCTION update_automation_run_stats();