-- Quieter alerts: auto-acknowledge prior unacknowledged alerts of the same kind
CREATE OR REPLACE FUNCTION public._raise_maintenance_alert(_severity text, _kind text, _msg text, _ctx jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_exists BIGINT;
BEGIN
  SELECT count(*) INTO v_exists FROM public.database_maintenance_alerts
   WHERE kind = _kind AND acknowledged_at IS NULL AND created_at > now() - interval '6 hours';
  IF v_exists = 0 THEN
    -- Auto-ack older unacknowledged alerts of the same kind so only the freshest one stays open
    UPDATE public.database_maintenance_alerts
       SET acknowledged_at = now()
     WHERE kind = _kind AND acknowledged_at IS NULL;
    INSERT INTO public.database_maintenance_alerts(severity, kind, message, context)
    VALUES (_severity, _kind, _msg, COALESCE(_ctx, '{}'::jsonb));
  END IF;
END; $function$;

-- One-time cleanup: the dispatch_metrics critical was resolved in the prior migration
UPDATE public.database_maintenance_alerts
   SET acknowledged_at = now()
 WHERE acknowledged_at IS NULL
   AND kind = 'nightly_cleanup_failed'
   AND (context->>'table_key') = 'repricer_dispatch_metrics';

-- Collapse duplicate db_size_warn / pg_cron_history_large / cron_failures alerts to the newest only
WITH ranked AS (
  SELECT id, kind,
         row_number() OVER (PARTITION BY kind ORDER BY created_at DESC) AS rn
    FROM public.database_maintenance_alerts
   WHERE acknowledged_at IS NULL
     AND kind IN ('db_size_warn','pg_cron_history_large','cron_failures')
)
UPDATE public.database_maintenance_alerts a
   SET acknowledged_at = now()
  FROM ranked r
 WHERE a.id = r.id AND r.rn > 1;