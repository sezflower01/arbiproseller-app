-- Backfill 'edit' for existing non-admin users who already have 'view'
-- on inventory, repricer, or product_library. This brings existing users
-- in line with the new defaults (view + run + edit) without overriding
-- any explicit revocation pattern.
INSERT INTO public.user_module_access (user_id, module, action)
SELECT u.id, m.module::app_module, 'edit'::app_action
FROM auth.users u
CROSS JOIN (VALUES ('inventory'), ('repricer'), ('product_library')) AS m(module)
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = u.id AND ur.role = 'admin'
)
AND EXISTS (
  SELECT 1 FROM public.user_module_access uma
  WHERE uma.user_id = u.id
    AND uma.module = m.module::app_module
    AND uma.action = 'view'
)
AND NOT EXISTS (
  SELECT 1 FROM public.user_module_access uma
  WHERE uma.user_id = u.id
    AND uma.module = m.module::app_module
    AND uma.action = 'edit'
)
ON CONFLICT DO NOTHING;