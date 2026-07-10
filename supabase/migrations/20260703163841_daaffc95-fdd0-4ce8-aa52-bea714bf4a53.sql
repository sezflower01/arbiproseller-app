-- Defense-in-depth (correct implementation).
-- Postgres rule: column-level REVOKE cannot subtract from table-level SELECT.
-- Correct pattern: REVOKE table-level SELECT, then GRANT SELECT column-by-column
-- on only the safe columns. Sensitive columns receive NO grant, so browser
-- sessions cannot read them under any query shape.
--
-- SECURITY DEFINER functions run as postgres and are unaffected.
-- Edge functions use service_role and are unaffected.
-- INSERT/UPDATE/DELETE grants are left intact (existing flows depend on them).

-- ================= seller_authorizations =================
REVOKE SELECT ON public.seller_authorizations FROM anon, authenticated;

GRANT SELECT (
  id, user_id, seller_id, marketplace_id, token_expires_at,
  selling_partner_id, created_at, updated_at,
  is_active, deactivated_at, deactivation_reason
) ON public.seller_authorizations TO authenticated;
-- anon gets nothing — this table is never legitimately read without auth.

-- ================= gmail_connections =================
REVOKE SELECT ON public.gmail_connections FROM anon, authenticated;

GRANT SELECT (
  id, user_id, email, token_expires_at, scope, created_at, updated_at
) ON public.gmail_connections TO authenticated;

-- ================= user_spapi_credentials =================
REVOKE SELECT ON public.user_spapi_credentials FROM anon, authenticated;

GRANT SELECT (
  user_id, region, marketplace,
  lwa_client_id_last4, refresh_token_last4,
  last_test_at, last_test_status, last_test_error,
  last_test_seller_id, last_test_marketplaces,
  created_at, updated_at
) ON public.user_spapi_credentials TO authenticated;
-- lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc: no grant.
-- Even though these are already encrypted at rest, no browser session should
-- have any reason to fetch the ciphertext.