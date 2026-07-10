-- Update default-grant trigger to include 'edit' alongside 'view' and 'run'
-- for inventory, repricer, and product_library.
-- The existence guard is preserved: if the user already has ANY grants,
-- the trigger does nothing (manual revocations are still respected).
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
    (NEW.id, 'inventory', 'edit'),
    (NEW.id, 'repricer', 'view'),
    (NEW.id, 'repricer', 'run'),
    (NEW.id, 'repricer', 'edit'),
    (NEW.id, 'product_library', 'view'),
    (NEW.id, 'product_library', 'run'),
    (NEW.id, 'product_library', 'edit')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;