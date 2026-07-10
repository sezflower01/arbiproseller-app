-- Defense-in-depth: revoke direct client access to encrypted SP-API secret
-- columns. Even though values are encrypted at rest, ciphertext should not
-- reach the browser. Edge functions continue to access via service_role.
REVOKE SELECT (lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc)
  ON public.user_spapi_credentials FROM anon;
REVOKE SELECT (lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc)
  ON public.user_spapi_credentials FROM authenticated;

REVOKE UPDATE (lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc)
  ON public.user_spapi_credentials FROM anon;
REVOKE UPDATE (lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc)
  ON public.user_spapi_credentials FROM authenticated;
REVOKE INSERT (lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc)
  ON public.user_spapi_credentials FROM anon;
REVOKE INSERT (lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc)
  ON public.user_spapi_credentials FROM authenticated;