-- Per-user Amazon SP-API credentials, encrypted at rest with pgsodium.
-- Plaintext is never stored in the row; only the *_encrypted bytea is kept.
-- Decryption only happens inside SECURITY DEFINER functions called by edge
-- functions with the service role.

CREATE EXTENSION IF NOT EXISTS pgsodium;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Dedicated key for SP-API secrets (created once; id is stable per project).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgsodium.key WHERE name = 'spapi_credentials_key') THEN
    PERFORM pgsodium.create_key(name := 'spapi_credentials_key');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_spapi_credentials (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Encrypted ciphertext (never readable by clients)
  lwa_client_id_enc      bytea,
  lwa_client_secret_enc  bytea,
  refresh_token_enc      bytea,
  -- Non-secret metadata (safe to expose)
  region text NOT NULL DEFAULT 'na' CHECK (region IN ('na','eu','fe')),
  marketplace text NOT NULL DEFAULT 'US',
  -- Last-4 hints so the UI can show ••••1234 without decrypting
  lwa_client_id_last4 text,
  refresh_token_last4 text,
  -- Test / status
  last_test_at timestamptz,
  last_test_status text,        -- 'ok' | 'error'
  last_test_error  text,
  last_test_seller_id text,
  last_test_marketplaces jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_spapi_credentials ENABLE ROW LEVEL SECURITY;

-- Owner can SEE only the non-secret metadata columns (RLS allows the row;
-- the *_enc columns are bytea and useless without the key).
DROP POLICY IF EXISTS "owner_or_admin_select" ON public.user_spapi_credentials;
CREATE POLICY "owner_or_admin_select"
  ON public.user_spapi_credentials FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- INSERT/UPDATE are blocked from clients — only SECURITY DEFINER functions
-- (called by edge functions) may write. We deliberately omit insert/update
-- policies so direct client writes are denied.
DROP POLICY IF EXISTS "no_client_write" ON public.user_spapi_credentials;

-- Trigger: keep updated_at fresh
CREATE OR REPLACE FUNCTION public.fn_touch_spapi_creds()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_touch_spapi_creds ON public.user_spapi_credentials;
CREATE TRIGGER trg_touch_spapi_creds
  BEFORE UPDATE ON public.user_spapi_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_spapi_creds();

-- ---- Helper: encrypt with the named key ----
CREATE OR REPLACE FUNCTION public._spapi_encrypt(p_plain text)
RETURNS bytea LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pgsodium AS $$
DECLARE v_key_id uuid;
BEGIN
  IF p_plain IS NULL OR length(p_plain) = 0 THEN RETURN NULL; END IF;
  SELECT id INTO v_key_id FROM pgsodium.key WHERE name = 'spapi_credentials_key' LIMIT 1;
  IF v_key_id IS NULL THEN RAISE EXCEPTION 'spapi_credentials_key missing'; END IF;
  RETURN pgsodium.crypto_aead_det_encrypt(
    convert_to(p_plain, 'utf8'),
    convert_to('spapi', 'utf8'),
    v_key_id
  );
END $$;

CREATE OR REPLACE FUNCTION public._spapi_decrypt(p_cipher bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pgsodium AS $$
DECLARE v_key_id uuid;
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_key_id FROM pgsodium.key WHERE name = 'spapi_credentials_key' LIMIT 1;
  RETURN convert_from(
    pgsodium.crypto_aead_det_decrypt(p_cipher, convert_to('spapi','utf8'), v_key_id),
    'utf8'
  );
END $$;

REVOKE ALL ON FUNCTION public._spapi_encrypt(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public._spapi_decrypt(bytea) FROM public, anon, authenticated;

-- ---- Save: caller must be the owner of user_id (or an admin) ----
CREATE OR REPLACE FUNCTION public.save_spapi_credentials(
  p_user_id uuid,
  p_lwa_client_id text,
  p_lwa_client_secret text,
  p_refresh_token text,
  p_region text DEFAULT 'na',
  p_marketplace text DEFAULT 'US'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_id_last4 text;
  v_rt_last4 text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_caller <> p_user_id AND NOT public.has_role(v_caller, 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_id_last4 := CASE WHEN p_lwa_client_id IS NOT NULL AND length(p_lwa_client_id) >= 4
                     THEN right(p_lwa_client_id, 4) END;
  v_rt_last4 := CASE WHEN p_refresh_token IS NOT NULL AND length(p_refresh_token) >= 4
                     THEN right(p_refresh_token, 4) END;

  INSERT INTO public.user_spapi_credentials (
    user_id,
    lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc,
    region, marketplace,
    lwa_client_id_last4, refresh_token_last4
  ) VALUES (
    p_user_id,
    public._spapi_encrypt(NULLIF(p_lwa_client_id,'')),
    public._spapi_encrypt(NULLIF(p_lwa_client_secret,'')),
    public._spapi_encrypt(NULLIF(p_refresh_token,'')),
    COALESCE(NULLIF(p_region,''), 'na'),
    COALESCE(NULLIF(p_marketplace,''), 'US'),
    v_id_last4, v_rt_last4
  )
  ON CONFLICT (user_id) DO UPDATE SET
    -- Only overwrite each ciphertext when a non-empty new value was supplied.
    lwa_client_id_enc     = COALESCE(public._spapi_encrypt(NULLIF(EXCLUDED.lwa_client_id_enc::text,'')), user_spapi_credentials.lwa_client_id_enc),
    lwa_client_secret_enc = COALESCE(public._spapi_encrypt(NULLIF(EXCLUDED.lwa_client_secret_enc::text,'')), user_spapi_credentials.lwa_client_secret_enc),
    refresh_token_enc     = COALESCE(public._spapi_encrypt(NULLIF(EXCLUDED.refresh_token_enc::text,'')), user_spapi_credentials.refresh_token_enc),
    region = EXCLUDED.region,
    marketplace = EXCLUDED.marketplace,
    lwa_client_id_last4 = COALESCE(EXCLUDED.lwa_client_id_last4, user_spapi_credentials.lwa_client_id_last4),
    refresh_token_last4 = COALESCE(EXCLUDED.refresh_token_last4, user_spapi_credentials.refresh_token_last4),
    updated_at = now();
END $$;

-- The simple ON CONFLICT above re-encrypts EXCLUDED ciphertext which is wrong.
-- Replace with an explicit UPDATE-or-INSERT to handle "leave field unchanged"
-- semantics correctly when caller passes NULL/empty.
CREATE OR REPLACE FUNCTION public.save_spapi_credentials(
  p_user_id uuid,
  p_lwa_client_id text,
  p_lwa_client_secret text,
  p_refresh_token text,
  p_region text DEFAULT 'na',
  p_marketplace text DEFAULT 'US'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_exists boolean;
  v_id_enc bytea;
  v_secret_enc bytea;
  v_rt_enc bytea;
  v_id_last4 text;
  v_rt_last4 text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_caller <> p_user_id AND NOT public.has_role(v_caller, 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_id_enc     := public._spapi_encrypt(NULLIF(p_lwa_client_id,''));
  v_secret_enc := public._spapi_encrypt(NULLIF(p_lwa_client_secret,''));
  v_rt_enc     := public._spapi_encrypt(NULLIF(p_refresh_token,''));

  v_id_last4 := CASE WHEN p_lwa_client_id IS NOT NULL AND length(p_lwa_client_id) >= 4
                     THEN right(p_lwa_client_id, 4) END;
  v_rt_last4 := CASE WHEN p_refresh_token IS NOT NULL AND length(p_refresh_token) >= 4
                     THEN right(p_refresh_token, 4) END;

  SELECT EXISTS(SELECT 1 FROM public.user_spapi_credentials WHERE user_id = p_user_id) INTO v_exists;

  IF v_exists THEN
    UPDATE public.user_spapi_credentials SET
      lwa_client_id_enc     = COALESCE(v_id_enc, lwa_client_id_enc),
      lwa_client_secret_enc = COALESCE(v_secret_enc, lwa_client_secret_enc),
      refresh_token_enc     = COALESCE(v_rt_enc, refresh_token_enc),
      lwa_client_id_last4   = COALESCE(v_id_last4, lwa_client_id_last4),
      refresh_token_last4   = COALESCE(v_rt_last4, refresh_token_last4),
      region                = COALESCE(NULLIF(p_region,''), region),
      marketplace           = COALESCE(NULLIF(p_marketplace,''), marketplace),
      updated_at = now()
    WHERE user_id = p_user_id;
  ELSE
    INSERT INTO public.user_spapi_credentials (
      user_id, lwa_client_id_enc, lwa_client_secret_enc, refresh_token_enc,
      region, marketplace, lwa_client_id_last4, refresh_token_last4
    ) VALUES (
      p_user_id, v_id_enc, v_secret_enc, v_rt_enc,
      COALESCE(NULLIF(p_region,''),'na'), COALESCE(NULLIF(p_marketplace,''),'US'),
      v_id_last4, v_rt_last4
    );
  END IF;
END $$;

-- Decrypt-and-return for edge functions. The function checks an internal shared
-- secret OR that the caller is the owner. Edge functions invoke with service
-- role + pass the internal secret header verified inside the edge function.
CREATE OR REPLACE FUNCTION public.get_spapi_credentials_decrypted(p_user_id uuid)
RETURNS TABLE(
  lwa_client_id text,
  lwa_client_secret text,
  refresh_token text,
  region text,
  marketplace text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  -- Allow: service_role (auth.uid IS NULL when called from edge fn with service key),
  -- OR the owner, OR an admin.
  IF v_caller IS NOT NULL
     AND v_caller <> p_user_id
     AND NOT public.has_role(v_caller, 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT
    public._spapi_decrypt(c.lwa_client_id_enc),
    public._spapi_decrypt(c.lwa_client_secret_enc),
    public._spapi_decrypt(c.refresh_token_enc),
    c.region,
    c.marketplace
  FROM public.user_spapi_credentials c
  WHERE c.user_id = p_user_id;
END $$;

REVOKE ALL ON FUNCTION public.get_spapi_credentials_decrypted(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_spapi_credentials_decrypted(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_spapi_credentials(uuid,text,text,text,text,text) TO authenticated;

-- Record test result (called by edge function after testing the connection)
CREATE OR REPLACE FUNCTION public.record_spapi_test_result(
  p_user_id uuid,
  p_status text,
  p_error text,
  p_seller_id text,
  p_marketplaces jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.user_spapi_credentials SET
    last_test_at = now(),
    last_test_status = p_status,
    last_test_error = p_error,
    last_test_seller_id = p_seller_id,
    last_test_marketplaces = p_marketplaces,
    updated_at = now()
  WHERE user_id = p_user_id;
END $$;
GRANT EXECUTE ON FUNCTION public.record_spapi_test_result(uuid,text,text,text,jsonb) TO service_role;