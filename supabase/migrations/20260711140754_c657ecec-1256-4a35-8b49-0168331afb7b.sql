-- Step 1: flip 3 views with no callers to security_invoker=true
ALTER VIEW public.active_inventory              SET (security_invoker = true);
ALTER VIEW public.smart_engine_tuning_lift      SET (security_invoker = true);
ALTER VIEW public.user_approved_products_view   SET (security_invoker = true);

-- Step 2a: add admin bypass policy on repricer_eligibility_audit
--          so RepricerEligibilityDiagnostics.tsx (admin-only) keeps seeing
--          cross-user mismatches after the view is flipped.
CREATE POLICY "Admins can read all eligibility audits"
  ON public.repricer_eligibility_audit
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Step 2b: flip the admin diagnostic view
ALTER VIEW public.v_repricer_eligibility_mismatches SET (security_invoker = true);