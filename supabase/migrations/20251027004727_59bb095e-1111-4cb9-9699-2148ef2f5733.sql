-- Create asin_upload table to store unique ASINs
CREATE TABLE public.asin_upload (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  asin TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.asin_upload ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Admins can manage all asin uploads"
ON public.asin_upload
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated users can view asin uploads"
ON public.asin_upload
FOR SELECT
USING (auth.role() = 'authenticated'::text);

-- Create index for faster lookups
CREATE INDEX idx_asin_upload_asin ON public.asin_upload(asin);

-- Create trigger to update timestamps
CREATE TRIGGER update_asin_upload_updated_at
BEFORE UPDATE ON public.asin_upload
FOR EACH ROW
EXECUTE FUNCTION public.update_modified_column();