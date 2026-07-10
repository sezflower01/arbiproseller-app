CREATE OR REPLACE FUNCTION public.list_shipments_needing_date_sync(p_user_id uuid, p_limit integer DEFAULT 25)
 RETURNS TABLE(shipment_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Pick shipments that need dates pulled from SP-API:
  --  • never synced (dates_synced_at IS NULL), OR
  --  • flagged unresolved AND last attempt was >1h ago (so a single Sync Dates
  --    click does ONE retry pass instead of looping forever on the same rows).
  SELECT sh.shipment_id
  FROM public.fba_shipments sh
  WHERE sh.user_id = p_user_id
    AND (
      sh.dates_synced_at IS NULL
      OR (sh.unresolved_date = true AND sh.dates_synced_at < now() - interval '1 hour')
    )
  ORDER BY
    sh.dates_synced_at NULLS FIRST,
    sh.created_at ASC
  LIMIT GREATEST(p_limit, 1);
$function$;