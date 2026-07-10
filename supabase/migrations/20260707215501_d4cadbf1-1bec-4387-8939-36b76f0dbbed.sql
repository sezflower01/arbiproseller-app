-- Revoke client-side SELECT on Gmail OAuth token columns.
-- Owner-scoped RLS on the row is preserved; only the two secret columns are gated.
-- Edge functions using service_role are unaffected.

REVOKE SELECT (access_token) ON public.gmail_connections FROM anon, authenticated;
REVOKE SELECT (refresh_token) ON public.gmail_connections FROM anon, authenticated;

-- Explicit grants for every non-secret column so `select('*')` from the owner still returns useful data.
GRANT SELECT (
  id,
  user_id,
  email,
  scope,
  token_expires_at,
  created_at,
  updated_at
) ON public.gmail_connections TO authenticated;

-- service_role retains full access implicitly; no change needed.