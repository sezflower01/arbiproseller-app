-- Create retailers table (similar to categories)
CREATE TABLE IF NOT EXISTS public.retailers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.retailers ENABLE ROW LEVEL SECURITY;

-- RLS policies for retailers
CREATE POLICY "Everyone can view retailers"
  ON public.retailers
  FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage retailers"
  ON public.retailers
  FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_retailers_name ON public.retailers(name);