
-- Phase 2: derive_repricer_eligibility() — READ-ONLY proof function + audit population RPC
-- No writer ever flips is_enabled. This function only derives what eligibility SHOULD be.

CREATE OR REPLACE FUNCTION public.derive_repricer_eligibility(_assignment_id uuid)
RETURNS TABLE (
  assignment_id uuid,
  asin text,
  sku text,
  marketplace text,
  current_is_enabled boolean,
  derived_repricer_eligible boolean,
  derived_status_kind text,
  derived_reason text,
  confidence text,
  source_timestamps jsonb,
  factors jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a record;
  inv record;
  v_available int;
  v_reserved int;
  v_inbound int;
  v_listing_state text;
  v_inv_conf text;
  v_intl_conf text;
  v_kind text;
  v_reason text;
  v_eligible boolean;
  v_conf text;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO a FROM public.repricer_assignments WHERE id = _assignment_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Pull matching inventory facts for US marketplace; intl rows use intl_* cols.
  SELECT available_quantity, reserved_quantity, inbound_quantity, last_summaries_at, listing_status
    INTO inv
  FROM public.inventory
  WHERE user_id = a.user_id
    AND asin = a.asin
    AND COALESCE(seller_sku, sku) = a.sku
  ORDER BY last_summaries_at DESC NULLS LAST
  LIMIT 1;

  IF a.marketplace IS NOT NULL AND a.marketplace <> 'US' THEN
    v_available := COALESCE(a.intl_available, 0);
    v_reserved  := COALESCE(a.intl_reserved, 0);
    v_inbound   := COALESCE(a.intl_inbound, 0);
  ELSE
    v_available := COALESCE(inv.available_quantity, 0);
    v_reserved  := COALESCE(inv.reserved_quantity, 0);
    v_inbound   := COALESCE(inv.inbound_quantity, 0);
  END IF;

  v_listing_state := COALESCE(NULLIF(a.amazon_listing_state, ''), 'UNKNOWN');
  v_inv_conf := COALESCE(a.inventory_confidence, 'UNKNOWN');
  v_intl_conf := COALESCE(a.intl_qty_confidence, 'UNKNOWN');

  -- Decision tree (mirror of TS deriveAssignmentStatus, server-side proof).
  IF a.manual_paused IS TRUE THEN
    v_kind := 'manually_paused';
    v_reason := 'MANUAL_PAUSE';
    v_eligible := false;
    v_conf := 'HIGH';
  ELSIF a.rule_id IS NULL THEN
    v_kind := 'no_rule';
    v_reason := 'NO_RULE';
    v_eligible := false;
    v_conf := 'HIGH';
  ELSIF UPPER(COALESCE(a.auto_suspended_reason,'')) = 'LEGACY_UNAUDITED' THEN
    v_kind := 'needs_review';
    v_reason := 'LEGACY_UNAUDITED';
    v_eligible := false;
    v_conf := 'LOW';
  ELSIF UPPER(COALESCE(a.auto_suspended_reason,'')) IN
        ('INBOUND_ONLY_INACTIVE','LISTING_INACTIVE','NO_STOCK','INTL_STALE','MARKETPLACE_NOT_SELLABLE') THEN
    v_kind := 'auto_suspended_' || LOWER(a.auto_suspended_reason);
    v_reason := a.auto_suspended_reason;
    v_eligible := false;
    v_conf := 'HIGH';
  ELSIF a.marketplace <> 'US' AND v_intl_conf = 'STALE' THEN
    v_kind := 'auto_suspended_intl_stale';
    v_reason := 'INTL_STALE';
    v_eligible := false;
    v_conf := 'MEDIUM';
  ELSIF v_listing_state IN ('INACTIVE','SUPPRESSED','NOT_FOUND') AND v_available = 0 AND v_inbound > 0 THEN
    v_kind := 'auto_suspended_inbound_only_inactive';
    v_reason := 'INBOUND_ONLY_INACTIVE';
    v_eligible := false;
    v_conf := 'HIGH';
  ELSIF v_listing_state IN ('INACTIVE','SUPPRESSED','NOT_FOUND') THEN
    v_kind := 'auto_suspended_listing_inactive';
    v_reason := 'LISTING_' || v_listing_state;
    v_eligible := false;
    v_conf := 'HIGH';
  ELSIF v_available = 0 AND v_reserved = 0 AND v_inbound = 0 THEN
    v_kind := 'auto_suspended_no_stock';
    v_reason := 'NO_STOCK';
    v_eligible := false;
    v_conf := CASE WHEN v_inv_conf = 'STALE' THEN 'LOW' ELSE 'HIGH' END;
  ELSIF v_listing_state = 'UNKNOWN' THEN
    v_kind := 'unknown_pending_verification';
    v_reason := 'PENDING_LISTING_VERIFICATION';
    v_eligible := false;
    v_conf := 'LOW';
  ELSIF v_inv_conf = 'STALE' THEN
    v_kind := 'auto_suspended_inventory_stale';
    v_reason := 'INVENTORY_STALE';
    v_eligible := false;
    v_conf := 'MEDIUM';
  ELSE
    v_kind := 'eligible_active';
    v_reason := 'OK';
    v_eligible := true;
    v_conf := 'HIGH';
  END IF;

  RETURN QUERY SELECT
    a.id,
    a.asin,
    a.sku,
    a.marketplace,
    COALESCE(a.is_enabled, false),
    v_eligible,
    v_kind,
    v_reason,
    v_conf,
    jsonb_build_object(
      'last_summaries_at', inv.last_summaries_at,
      'last_listing_check_at', a.last_listing_check_at,
      'intl_qty_fetched_at', a.intl_qty_fetched_at,
      'auto_suspended_at', a.auto_suspended_at,
      'last_disabled_at', a.last_disabled_at,
      'observed_at', v_now
    ),
    jsonb_build_object(
      'available', v_available,
      'reserved', v_reserved,
      'inbound', v_inbound,
      'amazon_listing_state', v_listing_state,
      'inventory_confidence', v_inv_conf,
      'intl_qty_confidence', v_intl_conf,
      'manual_paused', COALESCE(a.manual_paused,false),
      'auto_suspended_reason', a.auto_suspended_reason,
      'marketplace_sellable', a.marketplace_sellable,
      'rule_id', a.rule_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.derive_repricer_eligibility(uuid) TO authenticated, service_role;

-- Snapshot RPC: derive eligibility for a batch (or all) and insert mismatch / interesting rows
-- into repricer_eligibility_audit. Read-only on repricer_assignments.
CREATE OR REPLACE FUNCTION public.snapshot_repricer_eligibility(_limit int DEFAULT 500)
RETURNS TABLE (inserted_count int, mismatch_count int, scanned_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  d record;
  v_scanned int := 0;
  v_mismatch int := 0;
  v_inserted int := 0;
  v_interesting boolean;
BEGIN
  FOR r IN
    SELECT id FROM public.repricer_assignments
    WHERE deleted_by IS NULL
    ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST
    LIMIT _limit
  LOOP
    v_scanned := v_scanned + 1;
    SELECT * INTO d FROM public.derive_repricer_eligibility(r.id);
    IF NOT FOUND THEN CONTINUE; END IF;

    v_interesting := (d.current_is_enabled <> d.derived_repricer_eligible)
                  OR (d.confidence = 'LOW')
                  OR (d.derived_status_kind = 'needs_review')
                  OR (d.derived_status_kind = 'unknown_pending_verification');

    IF d.current_is_enabled <> d.derived_repricer_eligible THEN
      v_mismatch := v_mismatch + 1;
    END IF;

    IF v_interesting THEN
      INSERT INTO public.repricer_eligibility_audit
        (assignment_id, user_id, asin, marketplace_id, is_enabled_actual,
         derived_eligible, derived_reason, factors, matched)
      SELECT d.assignment_id, a.user_id, d.asin, d.marketplace,
             d.current_is_enabled, d.derived_repricer_eligible, d.derived_reason,
             jsonb_build_object(
               'status_kind', d.derived_status_kind,
               'confidence', d.confidence,
               'source_timestamps', d.source_timestamps,
               'factors', d.factors
             ),
             (d.current_is_enabled = d.derived_repricer_eligible)
      FROM public.repricer_assignments a WHERE a.id = d.assignment_id;
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_mismatch, v_scanned;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_repricer_eligibility(int) TO authenticated, service_role;

-- Admin view: latest derived row per assignment + mismatch summary.
CREATE OR REPLACE VIEW public.v_repricer_eligibility_mismatches AS
SELECT DISTINCT ON (assignment_id)
  assignment_id, user_id, asin, marketplace_id,
  is_enabled_actual, derived_eligible, derived_reason,
  factors, matched, observed_at
FROM public.repricer_eligibility_audit
ORDER BY assignment_id, observed_at DESC;

GRANT SELECT ON public.v_repricer_eligibility_mismatches TO authenticated, service_role;
