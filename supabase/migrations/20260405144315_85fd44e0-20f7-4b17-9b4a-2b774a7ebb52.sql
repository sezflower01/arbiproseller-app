-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Authenticated users can view error logs" ON public.error_logs;

-- Only admins can view all error logs
CREATE POLICY "Admins can view all error logs"
  ON public.error_logs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));