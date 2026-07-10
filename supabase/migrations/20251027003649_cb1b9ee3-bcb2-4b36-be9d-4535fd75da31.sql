-- Add policy to allow admins to view all asin_items
CREATE POLICY "Admins can view all asin items" 
ON public.asin_items 
FOR SELECT 
USING (has_role(auth.uid(), 'admin'::app_role));

-- Add policy to allow admins to insert asin_items for any batch
CREATE POLICY "Admins can insert asin items" 
ON public.asin_items 
FOR INSERT 
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Add policy to allow admins to update all asin_items
CREATE POLICY "Admins can update all asin items" 
ON public.asin_items 
FOR UPDATE 
USING (has_role(auth.uid(), 'admin'::app_role));