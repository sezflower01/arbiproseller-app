-- Assign admin role to sezflower01@gmail.com
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::app_role
FROM profiles
WHERE email = 'sezflower01@gmail.com'
ON CONFLICT (user_id, role) DO NOTHING;

-- Update credits to 100000 for this admin user
UPDATE public.profiles
SET credits = 100000
WHERE email = 'sezflower01@gmail.com';