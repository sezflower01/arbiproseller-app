-- Unschedule old cron
SELECT cron.unschedule('full-inventory-refresh-2h') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='full-inventory-refresh-2h');

-- Wrapper that loops every enabled user and enqueues their refresh
CREATE OR REPLACE FUNCTION public.enqueue_full_inventory_refresh_all_users()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_total_users int := 0;
  v_total_enqueued int := 0;
  v_result jsonb;
BEGIN
  FOR v_user IN (
    SELECT DISTINCT user_id FROM repricer_assignments WHERE is_enabled = true AND user_id IS NOT NULL
  ) LOOP
    BEGIN
      v_result := public.enqueue_full_inventory_refresh(v_user);
      v_total_users := v_total_users + 1;
      v_total_enqueued := v_total_enqueued + COALESCE((v_result->>'enqueued')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG '[enqueue_full_inventory_refresh_all_users] user=% error=%', v_user, SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object('users', v_total_users, 'enqueued', v_total_enqueued, 'at', now());
END;
$$;

-- Reschedule to call the SQL function directly (no edge function involved)
SELECT cron.schedule(
  'full-inventory-refresh-2h',
  '15 */2 * * *',
  $$ SELECT public.enqueue_full_inventory_refresh_all_users(); $$
);