-- ============================================================
-- 1. Module + action enums
-- ============================================================
CREATE TYPE public.app_module AS ENUM (
  'repricer',
  'inventory',
  'reports',
  'supplier_discovery',
  'product_library',
  'personalhour',
  'settings',
  'admin_panel'
);

CREATE TYPE public.app_action AS ENUM (
  'view',
  'run',
  'edit',
  'admin'
);

-- ============================================================
-- 2. Per-user module access table
-- ============================================================
CREATE TABLE public.user_module_access (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module public.app_module NOT NULL,
  action public.app_action NOT NULL,
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  UNIQUE (user_id, module, action)
);

CREATE INDEX idx_user_module_access_user ON public.user_module_access(user_id);
CREATE INDEX idx_user_module_access_lookup ON public.user_module_access(user_id, module, action);

ALTER TABLE public.user_module_access ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. Permission check helper (security definer to avoid recursion)
-- ============================================================
CREATE OR REPLACE FUNCTION public.has_module_access(
  _user_id UUID,
  _module public.app_module,
  _action public.app_action
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Admins always pass
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'admin'
  )
  OR EXISTS (
    SELECT 1 FROM public.user_module_access
    WHERE user_id = _user_id
      AND module = _module
      AND action = _action
  );
$$;

-- Convenience: check if user has ANY action on a module (for menu visibility)
CREATE OR REPLACE FUNCTION public.has_any_module_access(
  _user_id UUID,
  _module public.app_module
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'admin'
  )
  OR EXISTS (
    SELECT 1 FROM public.user_module_access
    WHERE user_id = _user_id AND module = _module
  );
$$;

-- ============================================================
-- 4. RLS for user_module_access table itself
-- ============================================================
-- Users can see their own permissions
CREATE POLICY "Users can view their own module access"
ON public.user_module_access
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Admins can see all
CREATE POLICY "Admins can view all module access"
ON public.user_module_access
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Only admins can grant/revoke
CREATE POLICY "Admins can insert module access"
ON public.user_module_access
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update module access"
ON public.user_module_access
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete module access"
ON public.user_module_access
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));