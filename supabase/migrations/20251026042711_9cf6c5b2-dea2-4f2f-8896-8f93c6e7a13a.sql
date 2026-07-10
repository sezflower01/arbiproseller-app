-- Give admin users 100000 credits
UPDATE public.profiles
SET credits = 100000
WHERE id IN (
  SELECT user_id 
  FROM public.user_roles 
  WHERE role = 'admin'
);