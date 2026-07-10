-- ============================================================================
-- Phase 2: Repricer module-permission RLS enforcement
-- ============================================================================
-- Replaces the single "manage your own" policies on repricer tables with a
-- two-condition model: ownership (user_id = auth.uid()) AND module permission
-- (has_module_access). Admins bypass via has_module_access. Monitor read-only
-- policies are preserved.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- repricer_assignments
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage their own repricer assignments" ON public.repricer_assignments;

CREATE POLICY "Users view own repricer assignments"
ON public.repricer_assignments
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'view'::app_action)
);

CREATE POLICY "Users insert own repricer assignments"
ON public.repricer_assignments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

CREATE POLICY "Users update own repricer assignments"
ON public.repricer_assignments
FOR UPDATE
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
)
WITH CHECK (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

CREATE POLICY "Users delete own repricer assignments"
ON public.repricer_assignments
FOR DELETE
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

-- ---------------------------------------------------------------------------
-- repricer_rules
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage their own repricer rules" ON public.repricer_rules;

CREATE POLICY "Users view own repricer rules"
ON public.repricer_rules
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'view'::app_action)
);

CREATE POLICY "Users insert own repricer rules"
ON public.repricer_rules
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

CREATE POLICY "Users update own repricer rules"
ON public.repricer_rules
FOR UPDATE
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
)
WITH CHECK (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

CREATE POLICY "Users delete own repricer rules"
ON public.repricer_rules
FOR DELETE
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

-- ---------------------------------------------------------------------------
-- repricer_settings
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage their own repricer settings" ON public.repricer_settings;

CREATE POLICY "Users view own repricer settings"
ON public.repricer_settings
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'view'::app_action)
);

CREATE POLICY "Users insert own repricer settings"
ON public.repricer_settings
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

CREATE POLICY "Users update own repricer settings"
ON public.repricer_settings
FOR UPDATE
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
)
WITH CHECK (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'edit'::app_action)
);

-- DELETE on settings is admin-only (deleting your settings row is rare/elevated)
CREATE POLICY "Users delete own repricer settings (admin action)"
ON public.repricer_settings
FOR DELETE
TO authenticated
USING (
  auth.uid() = user_id
  AND public.has_module_access(auth.uid(), 'repricer'::app_module, 'admin'::app_action)
);