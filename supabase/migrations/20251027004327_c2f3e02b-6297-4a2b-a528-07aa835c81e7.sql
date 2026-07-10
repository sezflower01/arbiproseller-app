-- Replace restrictive policy on asin_items to include admins
DROP POLICY IF EXISTS "Users can manage items in their asin batches" ON public.asin_items;
CREATE POLICY "Users and admins can manage asin items"
ON public.asin_items
FOR ALL
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.asin_batches b
    WHERE b.id = asin_items.batch_id AND b.user_id = auth.uid()
  )
)
WITH CHECK (
  has_role(auth.uid(), 'admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.asin_batches b
    WHERE b.id = asin_items.batch_id AND b.user_id = auth.uid()
  )
);

-- Replace restrictive policy on keepa_items to include admins
DROP POLICY IF EXISTS "Users can manage items in their batches" ON public.keepa_items;
CREATE POLICY "Users and admins can manage keepa items"
ON public.keepa_items
FOR ALL
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.keepa_batches b
    WHERE b.id = keepa_items.batch_id AND b.user_id = auth.uid()
  )
)
WITH CHECK (
  has_role(auth.uid(), 'admin'::app_role)
  OR EXISTS (
    SELECT 1 FROM public.keepa_batches b
    WHERE b.id = keepa_items.batch_id AND b.user_id = auth.uid()
  )
);