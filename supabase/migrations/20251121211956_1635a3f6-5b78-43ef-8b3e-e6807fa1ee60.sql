-- Drop the restrictive SELECT policy
DROP POLICY IF EXISTS "Users can view their own orders" ON public.personalhour_orders;

-- Create new policy allowing all authenticated users to view all orders
CREATE POLICY "All authenticated users can view all orders"
ON public.personalhour_orders
FOR SELECT
TO authenticated
USING (true);