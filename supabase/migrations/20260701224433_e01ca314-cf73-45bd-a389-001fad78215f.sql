-- Admin-gated signup approvals

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_approved boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid;

-- All existing rows keep is_approved=true (backfilled by DEFAULT). Flip default so
-- every new profile created by the auth trigger / OAuth upsert lands as pending.
ALTER TABLE public.profiles ALTER COLUMN is_approved SET DEFAULT false;

-- Self-check RPC: admin always OK, else read own profile flag.
CREATE OR REPLACE FUNCTION public.is_self_approved()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.has_role(auth.uid(), 'admin'::app_role), false)
      OR COALESCE((SELECT is_approved FROM public.profiles WHERE id = auth.uid()), false);
$$;

GRANT EXECUTE ON FUNCTION public.is_self_approved() TO authenticated;

-- Admin approve / reject helpers
CREATE OR REPLACE FUNCTION public.admin_approve_user(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only admins can approve users';
  END IF;
  UPDATE public.profiles
     SET is_approved = true,
         approved_at = now(),
         approved_by = auth.uid()
   WHERE id = _user_id;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_approve_user(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_revoke_user(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only admins can revoke users';
  END IF;
  UPDATE public.profiles
     SET is_approved = false,
         approved_at = NULL,
         approved_by = auth.uid()
   WHERE id = _user_id;
END $$;

GRANT EXECUTE ON FUNCTION public.admin_revoke_user(uuid) TO authenticated;

-- Admin list of pending accounts (safe read of profiles + auth email fallback via profiles.email).
CREATE OR REPLACE FUNCTION public.admin_list_pending_users()
RETURNS TABLE (
  id uuid,
  email text,
  first_name text,
  last_name text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.email, p.first_name, p.last_name, p.created_at
    FROM public.profiles p
   WHERE p.is_approved = false
     AND public.has_role(auth.uid(), 'admin'::app_role)
   ORDER BY p.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_pending_users() TO authenticated;
