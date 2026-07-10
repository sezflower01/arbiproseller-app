
-- ============ business_health_issues ============
CREATE TABLE public.business_health_issues (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  module TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  confidence TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT '',
  recommended_fix TEXT NOT NULL DEFAULT '',
  auto_fix_action TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  affected_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  routes TEXT[] NOT NULL DEFAULT '{}',
  functions TEXT[] NOT NULL DEFAULT '{}',
  sources TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TIMESTAMPTZ,
  resolved_reason TEXT,
  ignored_until TIMESTAMPTZ,
  last_raw_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bhi_user_fp_unique UNIQUE (user_id, fingerprint)
);

CREATE INDEX bhi_user_status_idx     ON public.business_health_issues (user_id, status, last_seen DESC);
CREATE INDEX bhi_user_module_idx     ON public.business_health_issues (user_id, module, last_seen DESC);
CREATE INDEX bhi_user_severity_idx   ON public.business_health_issues (user_id, severity, last_seen DESC);
CREATE INDEX bhi_last_seen_idx       ON public.business_health_issues (last_seen DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_health_issues TO authenticated;
GRANT ALL ON public.business_health_issues TO service_role;

ALTER TABLE public.business_health_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bhi_select_own" ON public.business_health_issues
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "bhi_update_own" ON public.business_health_issues
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "bhi_insert_own" ON public.business_health_issues
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "bhi_delete_own" ON public.business_health_issues
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER bhi_set_updated_at
BEFORE UPDATE ON public.business_health_issues
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Upsert RPC ============
CREATE OR REPLACE FUNCTION public.upsert_business_health_issue(
  _user_id UUID,
  _fingerprint TEXT,
  _module TEXT,
  _severity TEXT,
  _confidence TEXT,
  _title TEXT,
  _impact TEXT,
  _recommended_fix TEXT,
  _auto_fix_action TEXT,
  _entity JSONB,
  _route TEXT,
  _function_name TEXT,
  _source TEXT,
  _raw_message TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id UUID;
  _sev_rank_new INT;
  _sev_rank_old INT;
  _conf_rank_new INT;
  _conf_rank_old INT;
BEGIN
  _sev_rank_new := CASE _severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END;
  _conf_rank_new := CASE _confidence WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END;

  INSERT INTO public.business_health_issues
    (user_id, fingerprint, module, severity, confidence, title, impact, recommended_fix,
     auto_fix_action, affected_entities, routes, functions, sources, last_raw_message,
     occurrence_count, first_seen, last_seen, status)
  VALUES
    (_user_id, _fingerprint, _module, _severity, _confidence, _title, _impact, _recommended_fix,
     _auto_fix_action,
     CASE WHEN _entity IS NULL OR _entity = 'null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(_entity) END,
     CASE WHEN _route IS NULL THEN '{}' ELSE ARRAY[_route] END,
     CASE WHEN _function_name IS NULL THEN '{}' ELSE ARRAY[_function_name] END,
     CASE WHEN _source IS NULL THEN '{}' ELSE ARRAY[_source] END,
     _raw_message, 1, now(), now(), 'open')
  ON CONFLICT (user_id, fingerprint) DO UPDATE SET
    occurrence_count = public.business_health_issues.occurrence_count + 1,
    last_seen = now(),
    severity = CASE
      WHEN (CASE EXCLUDED.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END)
         > (CASE public.business_health_issues.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END)
      THEN EXCLUDED.severity ELSE public.business_health_issues.severity END,
    confidence = CASE
      WHEN (CASE EXCLUDED.confidence WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END)
         > (CASE public.business_health_issues.confidence WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END)
      THEN EXCLUDED.confidence ELSE public.business_health_issues.confidence END,
    affected_entities = CASE
      WHEN _entity IS NULL OR _entity = 'null'::jsonb THEN public.business_health_issues.affected_entities
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
    status = CASE
      WHEN public.business_health_issues.status IN ('ignored') AND public.business_health_issues.ignored_until > now() THEN 'ignored'
      WHEN public.business_health_issues.status = 'resolved' THEN 'open'
      ELSE public.business_health_issues.status
    END,
    resolved_at = CASE WHEN public.business_health_issues.status = 'resolved' THEN NULL ELSE public.business_health_issues.resolved_at END,
    resolved_reason = CASE WHEN public.business_health_issues.status = 'resolved' THEN NULL ELSE public.business_health_issues.resolved_reason END
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_business_health_issue(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role;

-- ============ Auto-resolve RPC ============
CREATE OR REPLACE FUNCTION public.auto_resolve_business_health_issues(_user_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n INTEGER := 0;
  _r INTEGER;
BEGIN
  -- cost_invalid: resolve when no matching unresolved cost_invalid rows remain
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:cost_invalid_cleared'
   WHERE b.status IN ('open','retrying','requeued')
     AND b.fingerprint LIKE '%sales:cost_invalid%'
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = b.user_id AND s.cost_invalid = true
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  -- needs_price_enrich: resolve when none remain
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:enrichment_completed'
   WHERE b.status IN ('open','retrying','requeued')
     AND (b.fingerprint LIKE '%sales:requeued%' OR b.fingerprint LIKE '%enrich:%')
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = b.user_id AND s.needs_price_enrich = true
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  -- fees_invalid: resolve when none remain
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:fees_settled'
   WHERE b.status IN ('open','retrying','requeued')
     AND b.fingerprint LIKE '%sales:fees_invalid%'
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders s
        WHERE s.user_id = b.user_id AND s.fees_invalid = true
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  -- API throttling: no new occurrence in 6h
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:api_quiet_6h'
   WHERE b.status IN ('open','retrying','requeued')
     AND b.module = 'amazon_api'
     AND b.last_seen < now() - interval '6 hours'
     AND (_user_id IS NULL OR b.user_id = _user_id);
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  -- Generic UI non-2xx: no new occurrence in 24h
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:ui_quiet_24h'
   WHERE b.status IN ('open','retrying','requeued')
     AND b.confidence = 'low'
     AND b.last_seen < now() - interval '24 hours'
     AND (_user_id IS NULL OR b.user_id = _user_id);
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  -- Inventory stale: resolve when freshness recovered
  UPDATE public.business_health_issues b
     SET status = 'resolved', resolved_at = now(), resolved_reason = 'auto:inventory_fresh'
   WHERE b.status IN ('open','retrying','requeued')
     AND b.fingerprint LIKE '%inv_review:%'
     AND (_user_id IS NULL OR b.user_id = _user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.inventory_missing_review r
        WHERE r.user_id = b.user_id AND r.status = 'needs_review'
     );
  GET DIAGNOSTICS _r = ROW_COUNT; _n := _n + _r;

  -- Clear expired ignores
  UPDATE public.business_health_issues
     SET status = 'open', ignored_until = NULL
   WHERE status = 'ignored' AND ignored_until IS NOT NULL AND ignored_until < now()
     AND (_user_id IS NULL OR user_id = _user_id);

  RETURN _n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_resolve_business_health_issues(UUID) TO authenticated, service_role;
