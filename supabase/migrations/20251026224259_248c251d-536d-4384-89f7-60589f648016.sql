-- Create storage bucket for ASIN uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'asin-uploads',
  'asin-uploads',
  false,
  52428800, -- 50MB limit
  ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv']
);

-- Add storage policies for asin-uploads bucket
CREATE POLICY "Admins can upload ASIN files"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'asin-uploads' 
  AND EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

CREATE POLICY "Admins can read ASIN files"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'asin-uploads' 
  AND EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = auth.uid() AND role = 'admin'
  )
);

-- Add file_path column to asin_batches to store the uploaded file location
ALTER TABLE public.asin_batches
ADD COLUMN file_path TEXT;

-- Add skipped_duplicates column to track how many duplicates were skipped
ALTER TABLE public.asin_batches
ADD COLUMN skipped_duplicates INTEGER DEFAULT 0;