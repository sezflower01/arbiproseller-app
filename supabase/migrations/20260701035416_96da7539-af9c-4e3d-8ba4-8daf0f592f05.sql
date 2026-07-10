
-- 1) Patch auto_resolve_business_health_issues to exclude customer_intelligence
--    from the ui_quiet_24h sweep. Abuse patterns are historical evidence and
--    must stay open until the user acts on them.
CREATE OR REPLACE FUNCTION public.auto_resolve_business_health_issues(_user_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _n INTEGER := 0;
  _r INTEGER;
BEGIN
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:cost_invalid_cleared',
         next_retry_at = NULL, retry_attempts = 0, stuck_reason = NULL
   WHERE b.status IN ('open','retrying','requeued','stuck')
     AND (b.fingerprint LIKE '%sales:cost_invalid%' OR b.fingerprint LIKE '%cost_invalid_units_zero%')
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = b.user_id AND s.cost_invalid = true
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:enrichment_completed',
         next_retry_at = NULL, retry_attempts = 0, stuck_reason = NULL
   WHERE b.status IN ('open','retrying','requeued','stuck')
     AND (b.fingerprint LIKE '%sales:requeued%' OR b.fingerprint LIKE '%enrich:%' OR b.fingerprint LIKE '%enrichment_requeued%')
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = b.user_id AND s.needs_price_enrich = true
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:fees_settled',
         next_retry_at = NULL, retry_attempts = 0, stuck_reason = NULL
   WHERE b.status IN ('open','retrying','requeued','stuck')
     AND b.fingerprint LIKE '%sales:fees_invalid%'
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = b.user_id AND s.fees_invalid = true
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:api_quiet_6h',
         next_retry_at = NULL, retry_attempts = 0, stuck_reason = NULL
   WHERE b.status IN ('open','retrying','requeued','stuck')
     AND b.module = 'amazon_api'
     AND b.last_seen < now() - interval '6 hours'
     AND (_user_id IS NULL OR b.user_id = _user_id);
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  -- Generic UI non-2xx: no new occurrence in 24h
  -- IMPORTANT: exclude customer_intelligence — abuse patterns are historical
  -- evidence and must not be silently closed. detect-abuse-patterns closes its
  -- own rows explicitly with resolved_reason='pattern_no_longer_matches'.
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:ui_quiet_24h',
         next_retry_at = NULL, retry_attempts = 0, stuck_reason = NULL
   WHERE b.status IN ('open','retrying','requeued','stuck')
     AND b.confidence = 'low'
     AND b.module <> 'customer_intelligence'
     AND b.last_seen < now() - interval '24 hours'
     AND (_user_id IS NULL OR b.user_id = _user_id);
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:inventory_fresh',
         next_retry_at = NULL, retry_attempts = 0, stuck_reason = NULL
   WHERE b.status IN ('open','retrying','requeued','stuck')
     AND b.fingerprint LIKE '%inv_review:%'
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.inventory_missing_review r
        WHERE r.user_id = b.user_id AND r.status = 'needs_review'
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  UPDATE public.business_health_issues
     SET status = 'open', ignored_until = NULL
   WHERE status = 'ignored' AND ignored_until IS NOT NULL AND ignored_until < now()
     AND (_user_id IS NULL OR user_id = _user_id);

  RETURN _n;
END;
$function$;

-- 2) Reopen customer_intelligence issues that were incorrectly auto-closed
--    by the ui_quiet_24h sweep. Leave rows explicitly resolved by
--    detect-abuse-patterns (pattern_no_longer_matches) or by user action alone.
UPDATE public.business_health_issues
   SET status = 'open',
       resolved_at = NULL,
       resolved_reason = NULL
 WHERE module = 'customer_intelligence'
   AND status = 'resolved'
   AND resolved_reason = 'auto:ui_quiet_24h';
