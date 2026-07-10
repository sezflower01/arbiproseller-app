
-- Create organization_settings table
CREATE TABLE public.organization_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  organization_name TEXT,
  address TEXT,
  tax_id TEXT,
  phone_number TEXT,
  logo_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

-- Users can view their own org settings
CREATE POLICY "Users can view own org settings"
  ON public.organization_settings FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own org settings
CREATE POLICY "Users can insert own org settings"
  ON public.organization_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own org settings
CREATE POLICY "Users can update own org settings"
  ON public.organization_settings FOR UPDATE
  USING (auth.uid() = user_id);

-- Timestamp trigger
CREATE TRIGGER update_organization_settings_updated_at
  BEFORE UPDATE ON public.organization_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create storage bucket for org logos
INSERT INTO storage.buckets (id, name, public) VALUES ('org-logos', 'org-logos', true);

-- Storage policies for org logos
CREATE POLICY "Org logos are publicly accessible"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'org-logos');

CREATE POLICY "Users can upload their own org logo"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'org-logos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update their own org logo"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'org-logos' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own org logo"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'org-logos' AND auth.uid()::text = (storage.foldername(name))[1]);
