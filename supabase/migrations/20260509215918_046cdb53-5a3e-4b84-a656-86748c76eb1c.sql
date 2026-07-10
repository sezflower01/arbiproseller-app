SELECT net.http_post(
  url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/full-inventory-refresh-all',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-internal-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1), '')
  ),
  body := jsonb_build_object('user_id', '020dd71f-78ce-4bc2-9117-dc997c533ab9', 'triggered_by', 'manual_proof_v4_parallel60'),
  timeout_milliseconds := 30000
) AS request_id;