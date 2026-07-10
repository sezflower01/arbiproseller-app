-- Drop the restrictive INSERT, UPDATE, and DELETE policies
DROP POLICY IF EXISTS "Users can insert their own orders" ON public.personalhour_orders;
DROP POLICY IF EXISTS "Users can update their own orders" ON public.personalhour_orders;
DROP POLICY IF EXISTS "Users can delete their own orders" ON public.personalhour_orders;

-- Create new policies allowing all authenticated users to manage all orders
CREATE POLICY "All authenticated users can insert orders"
ON public.personalhour_orders
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "All authenticated users can update orders"
ON public.personalhour_orders
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "All authenticated users can delete orders"
ON public.personalhour_orders
FOR DELETE
TO authenticated
USING (true);