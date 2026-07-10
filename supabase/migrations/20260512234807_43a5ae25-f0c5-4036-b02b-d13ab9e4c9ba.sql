-- Milestone A: add UI mode preference to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ui_mode text NOT NULL DEFAULT 'simple'
  CHECK (ui_mode IN ('simple', 'advanced'));

-- Default admins to advanced mode (one-time backfill)
UPDATE public.profiles p
SET ui_mode = 'advanced'
WHERE EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = p.id AND ur.role = 'admin'
)
AND ui_mode = 'simple';