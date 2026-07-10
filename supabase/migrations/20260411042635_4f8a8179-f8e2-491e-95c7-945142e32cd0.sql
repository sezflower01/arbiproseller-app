
-- Enable pg_net if not already
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create the trigger function
CREATE OR REPLACE FUNCTION public.fn_auto_trigger_intl_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_supabase_url text;
  v_internal_secret text;
  v_anon_key text;
  v_has_intl_ca boolean;
  v_has_intl_mx boolean;
  v_has_intl_br boolean;
  v_missing_count int := 0;
BEGIN
  -- Only fire for US marketplace assignments that are enabled
  IF NEW.marketplace != 'US' OR NEW.is_enabled != true THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only fire if is_enabled changed from false to true, or if it's a new insert
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_enabled = true THEN
      RETURN NEW;  -- already enabled, skip
    END IF;
  END IF;

  -- Quick check: does this ASIN already have intl assignments?
  SELECT
    EXISTS(SELECT 1 FROM repricer_assignments WHERE user_id = NEW.user_id AND asin = NEW.asin AND marketplace = 'CA') INTO v_has_intl_ca;
  SELECT
    EXISTS(SELECT 1 FROM repricer_assignments WHERE user_id = NEW.user_id AND asin = NEW.asin AND marketplace = 'MX') INTO v_has_intl_mx;
  SELECT
    EXISTS(SELECT 1 FROM repricer_assignments WHERE user_id = NEW.user_id AND asin = NEW.asin AND marketplace = 'BR') INTO v_has_intl_br;

  IF v_has_intl_ca AND v_has_intl_mx AND v_has_intl_br THEN
    RETURN NEW;  -- all intl assignments exist, skip
  END IF;

  -- Get config from vault/env
  SELECT decrypted_secret INTO v_supabase_url FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL' LIMIT 1;
  SELECT decrypted_secret INTO v_internal_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;
  SELECT decrypted_secret INTO v_anon_key FROM vault.decrypted_secrets WHERE name = 'SUPABASE_ANON_KEY' LIMIT 1;

  IF v_supabase_url IS NULL OR v_internal_secret IS NULL THEN
    RETURN NEW;  -- can't call, skip silently
  END IF;

  -- Fire async HTTP call to sync-intl-asin
  PERFORM net.http_post(
    url := v_supabase_url || '/functions/v1/sync-intl-asin',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(v_anon_key, ''),
      'x-internal-secret', v_internal_secret
    ),
    body := jsonb_build_object(
      'user_id', NEW.user_id,
      'asin', NEW.asin,
      'sku', NEW.sku
    )
  );

  RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS trg_auto_intl_sync ON public.repricer_assignments;
CREATE TRIGGER trg_auto_intl_sync
  AFTER INSERT OR UPDATE OF is_enabled ON public.repricer_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_auto_trigger_intl_sync();
