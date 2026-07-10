-- Allow admins to SELECT all repricer_price_actions (for error log)
CREATE POLICY "Admins can view all price actions"
ON public.repricer_price_actions
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Allow admins to DELETE error_logs (for "Fix" button)
CREATE POLICY "Admins can delete error logs"
ON public.error_logs
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Allow admins to DELETE error_reports (for clearing)
CREATE POLICY "Admins can delete error reports"
ON public.error_reports
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));