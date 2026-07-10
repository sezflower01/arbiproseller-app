DROP POLICY IF EXISTS "Users can manage their own inventory" ON public.inventory;
DROP POLICY IF EXISTS "Users can view own inventory and admins view all" ON public.inventory;
DROP POLICY IF EXISTS "Users can create their own inventory" ON public.inventory;
DROP POLICY IF EXISTS "Users can update their own inventory" ON public.inventory;
DROP POLICY IF EXISTS "Users can delete their own inventory" ON public.inventory;

CREATE POLICY "Users can view own inventory and admins view all"
ON public.inventory
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR public.has_role(auth.uid(), 'admin'::public.app_role)
);

CREATE POLICY "Users can create their own inventory"
ON public.inventory
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own inventory"
ON public.inventory
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own inventory"
ON public.inventory
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);