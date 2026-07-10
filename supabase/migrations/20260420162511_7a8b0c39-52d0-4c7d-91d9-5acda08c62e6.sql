-- ============================================================
-- personalhour_orders: lock to owner + admin
-- ============================================================
DROP POLICY IF EXISTS "All authenticated users can view all orders" ON public.personalhour_orders;
DROP POLICY IF EXISTS "All authenticated users can insert orders" ON public.personalhour_orders;
DROP POLICY IF EXISTS "All authenticated users can update orders" ON public.personalhour_orders;
DROP POLICY IF EXISTS "All authenticated users can delete orders" ON public.personalhour_orders;

ALTER TABLE public.personalhour_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view their personalhour orders"
ON public.personalhour_orders
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Owners can insert their personalhour orders"
ON public.personalhour_orders
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Owners can update their personalhour orders"
ON public.personalhour_orders
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'))
WITH CHECK (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Owners can delete their personalhour orders"
ON public.personalhour_orders
FOR DELETE
TO authenticated
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- customers: lock to admin role + service_role
-- ============================================================
DROP POLICY IF EXISTS "allow_customer_select" ON public.customers;
DROP POLICY IF EXISTS "allow_customer_insert" ON public.customers;
DROP POLICY IF EXISTS "allow_customer_update" ON public.customers;
DROP POLICY IF EXISTS "Users can view own customer data" ON public.customers;
DROP POLICY IF EXISTS "Users can insert their own customer data" ON public.customers;
DROP POLICY IF EXISTS "Users can update own customer data" ON public.customers;
-- Keep "Service role can manage all customer data" intact for edge functions

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view customers"
ON public.customers
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert customers"
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update customers"
ON public.customers
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete customers"
ON public.customers
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));