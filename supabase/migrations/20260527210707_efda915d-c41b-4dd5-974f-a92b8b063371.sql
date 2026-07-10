
-- 1. New column for UI visual split
ALTER TABLE public.business_health_issues
  ADD COLUMN IF NOT EXISTS display_category TEXT NOT NULL DEFAULT 'generic';

-- Backfill display_category from existing fingerprints
UPDATE public.business_health_issues SET display_category =
  CASE
    WHEN stuck_reason IN ('stuck_missing_price','stuck_missing_fees')
      OR fingerprint LIKE '%enrichment_requeued%' OR fingerprint LIKE '%enrich:%'
      OR fingerprint LIKE '%fees_api_throttled%' OR fingerprint LIKE '%order_items_rate_limited%'
      THEN 'awaiting_amazon'
    WHEN stuck_reason IN ('stuck_auth','stuck_missing_quantity','stuck_missing_cost')
      OR fingerprint LIKE '%sp_api_auth%' OR fingerprint LIKE '%cost_invalid%'
      OR fingerprint LIKE '%amazon_price_update_failed%' OR fingerprint LIKE '%inbound_plan_error%'
      THEN 'action_needed'
    ELSE 'generic'
  END
WHERE display_category = 'generic';

-- 2. Worker runs observability
CREATE TABLE IF NOT EXISTS public.health_retry_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  processed INTEGER NOT NULL DEFAULT 0,
  advanced INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  moved_to_stuck INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
GRANT SELECT ON public.health_retry_runs TO authenticated;
GRANT ALL ON public.health_retry_runs TO service_role;
ALTER TABLE public.health_retry_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "health_retry_runs admin read"
  ON public.health_retry_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 3. Classifier: display_category for severity & UI split
CREATE OR REPLACE FUNCTION public.classify_health_display_category(_fingerprint TEXT, _stuck_reason TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN _stuck_reason IN ('stuck_missing_price','stuck_missing_fees') THEN 'awaiting_amazon'
    WHEN _stuck_reason IN ('stuck_auth','stuck_missing_quantity','stuck_missing_cost') THEN 'action_needed'
    WHEN _fingerprint LIKE '%enrichment_requeued%' OR _fingerprint LIKE '%enrich:%'
      OR _fingerprint LIKE '%fees_api_throttled%' OR _fingerprint LIKE '%order_items_rate_limited%'
      OR _fingerprint LIKE '%sales:requeued%' THEN 'awaiting_amazon'
    WHEN _fingerprint LIKE '%sp_api_auth%' OR _fingerprint LIKE '%cost_invalid%'
      OR _fingerprint LIKE '%amazon_price_update_failed%' OR _fingerprint LIKE '%inbound_plan_error%'
      OR _fingerprint LIKE '%fees_invalid%' THEN 'action_needed'
    ELSE 'generic'
  END;
$$;

-- 4. Severity downgrade by lifecycle
-- awaiting_amazon: critical (attempt 0-1) → warning (2-3) → info (4+/stuck)
-- action_needed: always critical
-- generic: keep emitter's severity
CREATE OR REPLACE FUNCTION public.derive_health_severity(
  _emitted_severity TEXT, _attempt INTEGER, _display_category TEXT, _is_stuck BOOLEAN
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN _display_category = 'action_needed' THEN
      CASE WHEN _emitted_severity = 'critical' THEN 'critical' ELSE _emitted_severity END
    WHEN _display_category = 'awaiting_amazon' THEN
      CASE
        WHEN _is_stuck OR _attempt >= 4 THEN 'info'
        WHEN _attempt >= 2 THEN 'warning'
        ELSE _emitted_severity
      END
    ELSE _emitted_severity
  END;
$$;

-- 5. Updated upsert: retry-inflation guard + severity downgrade + display_category
CREATE OR REPLACE FUNCTION public.upsert_business_health_issue(
  _user_id uuid, _fingerprint text, _module text, _severity text, _confidence text,
  _title text, _impact text, _recommended_fix text, _auto_fix_action text,
  _entity jsonb, _route text, _function_name text, _source text, _raw_message text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _id UUID;
  _is_retryable BOOLEAN;
  _category TEXT;
  _initial_severity TEXT;
BEGIN
  _is_retryable := (_module IN ('sales_pnl','amazon_api','inventory','auth','shipments'));
  _category := public.classify_health_display_category(_fingerprint, NULL);
  _initial_severity := public.derive_health_severity(_severity, 0, _category, false);

  INSERT INTO public.business_health_issues
    (user_id, fingerprint, module, severity, confidence, title, impact, recommended_fix,
     auto_fix_action, affected_entities, routes, functions, sources, last_raw_message,
     occurrence_count, first_seen, last_seen, status,
     retry_attempts, last_retry_at, next_retry_at, retryable, stuck_reason, display_category)
  VALUES
    (_user_id, _fingerprint, _module, _initial_severity, _confidence, _title, _impact, _recommended_fix,
     _auto_fix_action,
     CASE WHEN _entity IS NULL OR _entity = 'null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(_entity) END,
     CASE WHEN _route IS NULL THEN '{}' ELSE ARRAY[_route] END,
     CASE WHEN _function_name IS NULL THEN '{}' ELSE ARRAY[_function_name] END,
     CASE WHEN _source IS NULL THEN '{}' ELSE ARRAY[_source] END,
     _raw_message, 1, now(), now(), 'open',
     0, NULL,
     CASE WHEN _is_retryable THEN public.compute_next_retry_at(1) ELSE NULL END,
     _is_retryable, NULL, _category)
  ON CONFLICT (user_id, fingerprint) DO UPDATE SET
    occurrence_count = public.business_health_issues.occurrence_count + 1,
    last_seen = now(),
    confidence = CASE
      WHEN (CASE EXCLUDED.confidence WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END)
         > (CASE public.business_health_issues.confidence WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END)
      THEN EXCLUDED.confidence ELSE public.business_health_issues.confidence END,
    affected_entities = CASE
      WHEN _entity IS NULL OR _entity = 'null'::jsonb THEN public.business_health_issues.affected_entities
      WHEN public.business_health_issues.affected_entities @> jsonb_build_array(_entity) THEN public.business_health_issues.affected_entities
      WHEN jsonb_array_length(public.business_health_issues.affected_entities) >= 25 THEN public.business_health_issues.affected_entities
      ELSE public.business_health_issues.affected_entities || jsonb_build_array(_entity)
    END,
    routes = CASE
      WHEN _route IS NULL OR _route = ANY(public.business_health_issues.routes) THEN public.business_health_issues.routes
      ELSE public.business_health_issues.routes || _route END,
    functions = CASE
      WHEN _function_name IS NULL OR _function_name = ANY(public.business_health_issues.functions) THEN public.business_health_issues.functions
      ELSE public.business_health_issues.functions || _function_name END,
    sources = CASE
      WHEN _source IS NULL OR _source = ANY(public.business_health_issues.sources) THEN public.business_health_issues.sources
      ELSE public.business_health_issues.sources || _source END,
    last_raw_message = COALESCE(_raw_message, public.business_health_issues.last_raw_message),
    -- INFLATION GUARD: only advance retry_attempts when the retry window has actually elapsed.
    retry_attempts = CASE
      WHEN NOT _is_retryable THEN public.business_health_issues.retry_attempts
      WHEN public.business_health_issues.next_retry_at IS NULL THEN public.business_health_issues.retry_attempts
      WHEN now() < public.business_health_issues.next_retry_at THEN public.business_health_issues.retry_attempts
      ELSE LEAST(public.business_health_issues.retry_attempts + 1, 5)
    END,
    last_retry_at = CASE
      WHEN NOT _is_retryable THEN public.business_health_issues.last_retry_at
      WHEN public.business_health_issues.next_retry_at IS NULL THEN public.business_health_issues.last_retry_at
      WHEN now() < public.business_health_issues.next_retry_at THEN public.business_health_issues.last_retry_at
      ELSE now()
    END,
    next_retry_at = CASE
      WHEN NOT _is_retryable THEN NULL
      WHEN public.business_health_issues.next_retry_at IS NULL THEN NULL
      WHEN now() < public.business_health_issues.next_retry_at THEN public.business_health_issues.next_retry_at
      WHEN public.business_health_issues.retry_attempts + 1 >= 5 THEN NULL
      ELSE public.compute_next_retry_at(public.business_health_issues.retry_attempts + 1)
    END,
    retryable = _is_retryable AND (
      public.business_health_issues.next_retry_at IS NULL
      OR now() < public.business_health_issues.next_retry_at
      OR public.business_health_issues.retry_attempts + 1 < 5
    ),
    stuck_reason = CASE
      WHEN _is_retryable AND public.business_health_issues.next_retry_at IS NOT NULL
           AND now() >= public.business_health_issues.next_retry_at
           AND public.business_health_issues.retry_attempts + 1 >= 5
        THEN public.classify_health_stuck_reason(public.business_health_issues.fingerprint, _fingerprint)
      ELSE public.business_health_issues.stuck_reason
    END,
    status = CASE
      WHEN public.business_health_issues.status = 'ignored' AND public.business_health_issues.ignored_until > now() THEN 'ignored'
      WHEN public.business_health_issues.status = 'resolved' THEN 'open'
      WHEN _is_retryable AND public.business_health_issues.next_retry_at IS NOT NULL
           AND now() >= public.business_health_issues.next_retry_at
           AND public.business_health_issues.retry_attempts + 1 >= 5 THEN 'stuck'
      WHEN _is_retryable THEN 'retrying'
      ELSE public.business_health_issues.status
    END,
    -- severity downgrade by lifecycle
    severity = public.derive_health_severity(
      EXCLUDED.severity,
      CASE
        WHEN NOT _is_retryable THEN public.business_health_issues.retry_attempts
        WHEN public.business_health_issues.next_retry_at IS NULL THEN public.business_health_issues.retry_attempts
        WHEN now() < public.business_health_issues.next_retry_at THEN public.business_health_issues.retry_attempts
        ELSE LEAST(public.business_health_issues.retry_attempts + 1, 5)
      END,
      public.business_health_issues.display_category,
      _is_retryable AND public.business_health_issues.next_retry_at IS NOT NULL
        AND now() >= public.business_health_issues.next_retry_at
        AND public.business_health_issues.retry_attempts + 1 >= 5
    ),
    resolved_at = CASE WHEN public.business_health_issues.status = 'resolved' THEN NULL ELSE public.business_health_issues.resolved_at END,
    resolved_reason = CASE WHEN public.business_health_issues.status = 'resolved' THEN NULL ELSE public.business_health_issues.resolved_reason END
  RETURNING id INTO _id;

  RETURN _id;
END;
$function$;

-- 6. Worker RPC: claim due retries with row locking
CREATE OR REPLACE FUNCTION public.claim_due_health_retries(_limit INT DEFAULT 50)
RETURNS TABLE (
  id UUID, user_id UUID, fingerprint TEXT, module TEXT, auto_fix_action TEXT,
  affected_entities JSONB, retry_attempts INTEGER, display_category TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT b.id
      FROM public.business_health_issues b
     WHERE b.status IN ('open','retrying','requeued')
       AND b.retryable = true
       AND b.next_retry_at IS NOT NULL
       AND b.next_retry_at <= now()
     ORDER BY b.next_retry_at ASC
     LIMIT _limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.business_health_issues b
     SET last_retry_at = now()
    FROM due
   WHERE b.id = due.id
   RETURNING b.id, b.user_id, b.fingerprint, b.module, b.auto_fix_action,
             b.affected_entities, b.retry_attempts, b.display_category;
END;
$$;

-- 7. Worker RPC: finalize attempt outcome
CREATE OR REPLACE FUNCTION public.record_health_retry_outcome(
  _issue_id UUID, _success BOOLEAN, _note TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _row public.business_health_issues%ROWTYPE;
  _new_attempts INTEGER;
  _new_next TIMESTAMPTZ;
  _new_status TEXT;
  _new_stuck TEXT;
BEGIN
  SELECT * INTO _row FROM public.business_health_issues WHERE id = _issue_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF _success THEN
    -- worker thinks it ran cleanly; let auto_resolve verify DB truth on next sweep
    UPDATE public.business_health_issues SET last_retry_at = now() WHERE id = _issue_id;
    RETURN;
  END IF;

  _new_attempts := LEAST(_row.retry_attempts + 1, 5);
  IF _new_attempts >= 5 THEN
    _new_next := NULL;
    _new_status := 'stuck';
    _new_stuck := public.classify_health_stuck_reason(_row.fingerprint, _row.fingerprint);
  ELSE
    _new_next := public.compute_next_retry_at(_new_attempts);
    _new_status := 'retrying';
    _new_stuck := _row.stuck_reason;
  END IF;

  UPDATE public.business_health_issues
     SET retry_attempts = _new_attempts,
         last_retry_at = now(),
         next_retry_at = _new_next,
         status = _new_status,
         stuck_reason = _new_stuck,
         severity = public.derive_health_severity(_row.severity, _new_attempts, _row.display_category, _new_attempts >= 5),
         last_raw_message = COALESCE(_note, _row.last_raw_message),
         retryable = (_new_attempts < 5)
   WHERE id = _issue_id;
END;
$$;
