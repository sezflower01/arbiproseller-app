-- Create access_requests table to store signup requests
CREATE TABLE public.access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  processed_at timestamp with time zone,
  notes text
);

-- Enable RLS
ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert (submit a request)
CREATE POLICY "Anyone can submit access request"
ON public.access_requests
FOR INSERT
WITH CHECK (true);

-- Only admins can view all requests
CREATE POLICY "Admins can view all access requests"
ON public.access_requests
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Only admins can update requests
CREATE POLICY "Admins can update access requests"
ON public.access_requests
FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

-- Only admins can delete requests
CREATE POLICY "Admins can delete access requests"
ON public.access_requests
FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));