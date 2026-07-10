-- 1. Backfill: only for non-admin users who currently have ZERO grants
INSERT INTO public.user_module_access (user_id, module, action)
SELECT u.id, m.module::app_module, a.action::app_action
FROM auth.users u
CROSS JOIN (VALUES ('inventory'), ('repricer'), ('product_library')) AS m(module)
CROSS JOIN (VALUES ('view'), ('run')) AS a(action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = u.id AND ur.role = 'admin'
)
AND NOT EXISTS (
  SELECT 1 FROM public.user_module_access uma
  WHERE uma.user_id = u.id
)
ON CONFLICT DO NOTHING;

-- 2. Trigger function: auto-grant defaults on signup (only if no grants exist yet)
CREATE OR REPLACE FUNCTION public.fn_grant_default_module_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Skip if user already has any grants (prevents re-grant after revoke)
  IF EXISTS (SELECT 1 FROM public.user_module_access WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Skip if user is admin (they bypass checks anyway)
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id AND role = 'admin') THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_module_access (user_id, module, action) VALUES
    (NEW.id, 'inventory', 'view'),
    (NEW.id, 'inventory', 'run'),
    (NEW.id, 'repricer', 'view'),
    (NEW.id, 'repricer', 'run'),
    (NEW.id, 'product_library', 'view'),
    (NEW.id, 'product_library', 'run')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- 3. Attach trigger to auth.users
DROP TRIGGER IF EXISTS trg_grant_default_module_access ON auth.users;
CREATE TRIGGER trg_grant_default_module_access
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_grant_default_module_access();