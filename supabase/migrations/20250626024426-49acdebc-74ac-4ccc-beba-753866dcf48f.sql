
-- Add RLS policies for the customers table to allow insertions and updates
-- Policy to allow anyone to insert customer data (for payment processing)
CREATE POLICY "allow_customer_insert" ON public.customers
  FOR INSERT
  WITH CHECK (true);

-- Policy to allow anyone to update customer data (for payment status updates)
CREATE POLICY "allow_customer_update" ON public.customers
  FOR UPDATE
  USING (true);

-- Policy to allow users to view customer data (optional, for admin purposes)
CREATE POLICY "allow_customer_select" ON public.customers
  FOR SELECT
  USING (true);
