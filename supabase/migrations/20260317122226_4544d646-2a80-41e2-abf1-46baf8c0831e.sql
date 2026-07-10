CREATE POLICY "Authenticated users can delete keepa_simple_products"
ON public.keepa_simple_products
FOR DELETE
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert keepa_simple_products"
ON public.keepa_simple_products
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update keepa_simple_products"
ON public.keepa_simple_products
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);