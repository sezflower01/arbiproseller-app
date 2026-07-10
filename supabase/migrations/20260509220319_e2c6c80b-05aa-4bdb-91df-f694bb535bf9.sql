CREATE OR REPLACE FUNCTION public.enqueue_full_inventory_refresh(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_internal_secret text;
  v_supabase_url text := 'https://mstibdszibcheodvnprm.supabase.co';
  v_count int := 0;
  r record;
BEGIN
  SELECT decrypted_secret INTO v_internal_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  IF v_internal_secret IS NULL OR v_internal_secret = '' THEN
    RAISE EXCEPTION 'INTERNAL_SYNC_SECRET missing from vault';
  END IF;

  FOR r IN (
    SELECT DISTINCT ON (asin, sku) asin, sku
    FROM inventory
    WHERE user_id = p_user_id
      AND asin IS NOT NULL
      AND sku IS NOT NULL
      AND COALESCE(source, '') <> 'created_listing'
      AND COALESCE(UPPER(listing_status), '') <> 'DELETED'
  ) LOOP
    PERFORM net.http_post(
      url := v_supabase_url || '/functions/v1/rescue-inventory-asin',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-internal-secret', v_internal_secret
      ),
      body := jsonb_build_object(
        'asin', r.asin,
        'sku', r.sku,
        'user_id', p_user_id
      ),
      timeout_milliseconds := 30000
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('user_id', p_user_id, 'enqueued', v_count, 'enqueued_at', now());
END;
$$;