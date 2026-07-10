-- Revoke direct read access to sensitive SP-API token columns from client roles.
-- Edge functions continue to access these via the service_role key.
REVOKE SELECT (access_token, refresh_token, mws_auth_token)
  ON public.seller_authorizations FROM anon;
REVOKE SELECT (access_token, refresh_token, mws_auth_token)
  ON public.seller_authorizations FROM authenticated;

-- Also revoke UPDATE on those columns from client roles (writes happen server-side via OAuth callback).
REVOKE UPDATE (access_token, refresh_token, mws_auth_token)
  ON public.seller_authorizations FROM anon;
REVOKE UPDATE (access_token, refresh_token, mws_auth_token)
  ON public.seller_authorizations FROM authenticated;