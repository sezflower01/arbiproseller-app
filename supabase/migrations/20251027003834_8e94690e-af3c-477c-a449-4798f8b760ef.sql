-- Admin policies for keepa_items to support storage scan across all users
CREATE POLICY "Admins can view all keepa items"
ON public.keepa_items
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can insert keepa items"
ON public.keepa_items
FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update all keepa items"
ON public.keepa_items
FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));