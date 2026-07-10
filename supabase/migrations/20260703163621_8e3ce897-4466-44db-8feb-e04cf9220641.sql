-- Defense-in-depth: prevent browser sessions from reading raw OAuth/SP-API tokens
-- even when RLS would allow the row (owner reads own row). Server-side callers
-- run as postgres (SECURITY DEFINER functions) or service_role (edge functions)
-- and are unaffected. Client code already uses explicit safe column lists on
-- these tables; this REVOKE enforces that convention at the database layer.

REVOKE SELECT (access_token, refresh_token, mws_auth_token)
  ON public.seller_authorizations FROM anon, authenticated;

REVOKE SELECT (access_token, refresh_token)
  ON public.gmail_connections FROM anon, authenticated;

REVOKE SELECT (lwa_client_secret_enc, refresh_token_enc)
  ON public.user_spapi_credentials FROM anon, authenticated;