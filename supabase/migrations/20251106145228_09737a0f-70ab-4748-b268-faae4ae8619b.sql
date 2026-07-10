-- Create function for updating updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create table to store seller authorization tokens
CREATE TABLE IF NOT EXISTS public.seller_authorizations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  token_expires_at TIMESTAMPTZ,
  selling_partner_id TEXT,
  mws_auth_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(seller_id, marketplace_id)
);

-- Enable RLS
ALTER TABLE public.seller_authorizations ENABLE ROW LEVEL SECURITY;

-- Users can view their own authorizations
CREATE POLICY "Users can view their own seller authorizations"
ON public.seller_authorizations
FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert their own authorizations
CREATE POLICY "Users can insert their own seller authorizations"
ON public.seller_authorizations
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can update their own authorizations
CREATE POLICY "Users can update their own seller authorizations"
ON public.seller_authorizations
FOR UPDATE
USING (auth.uid() = user_id);

-- Users can delete their own authorizations
CREATE POLICY "Users can delete their own seller authorizations"
ON public.seller_authorizations
FOR DELETE
USING (auth.uid() = user_id);

-- Create trigger for updated_at
CREATE TRIGGER update_seller_authorizations_updated_at
BEFORE UPDATE ON public.seller_authorizations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create indexes for faster lookups
CREATE INDEX idx_seller_authorizations_user_id ON public.seller_authorizations(user_id);
CREATE INDEX idx_seller_authorizations_seller_id ON public.seller_authorizations(seller_id);