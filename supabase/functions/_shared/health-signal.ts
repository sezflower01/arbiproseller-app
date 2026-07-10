// Shared helper for emitting structured Business Health signals.
// Writes to business_health_issues via RPC (dedupes server-side).
// Fire-and-forget — never throws into caller flow.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

export type HealthModule =
  | 'sales_pnl' | 'inventory' | 'repricer' | 'shipments'
  | 'amazon_api' | 'auth' | 'gmail' | 'extension' | 'database' | 'billing';

export type HealthSeverity = 'critical' | 'warning' | 'info' | 'healthy';
export type HealthConfidence = 'high' | 'medium' | 'low';

export interface HealthSignal {
  user_id: string;
  module: HealthModule;
  severity: HealthSeverity;
  confidence: HealthConfidence;
  pattern: string;                                // dedupe key seed (template, not per-instance)
  title: string;
  impact: string;
  recommended_fix: string;
  auto_fix_action?: string | null;
  entity?: { asin?: string; sku?: string; order_id?: string; marketplace?: string } | null;
  route?: string | null;
  function_name?: string | null;
  source?: string | null;                         // log table / origin tag
  raw_message?: string | null;
}

function fingerprint(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join('|').toLowerCase().slice(0, 240);
}

let _client: any = null;
function client() {
  if (_client) return _client;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/**
 * Emit a structured business-health signal. Fire-and-forget.
 * Safe to call from any edge function — never throws.
 */
export async function logHealthSignal(s: HealthSignal): Promise<void> {
  try {
    const c = client();
    if (!c || !s.user_id) return;
    const fp = fingerprint([s.module, s.pattern, s.route, s.function_name]);
    await c.rpc('upsert_business_health_issue', {
      _user_id: s.user_id,
      _fingerprint: fp,
      _module: s.module,
      _severity: s.severity,
      _confidence: s.confidence,
      _title: s.title.slice(0, 200),
      _impact: (s.impact || '').slice(0, 500),
      _recommended_fix: (s.recommended_fix || '').slice(0, 500),
      _auto_fix_action: s.auto_fix_action ?? null,
      _entity: s.entity ?? null,
      _route: s.route ?? null,
      _function_name: s.function_name ?? null,
      _source: s.source ?? null,
      _raw_message: (s.raw_message || '').slice(0, 1000) || null,
    });
  } catch (_e) {
    // Never break caller flow on health logging failure.
  }
}

// ---------- Convenience builders for the most common patterns ----------

export const HealthSignals = {
  orderItemsRateLimited: (user_id: string, function_name: string, order_id?: string) =>
    logHealthSignal({
      user_id, module: 'amazon_api', severity: 'warning', confidence: 'high',
      pattern: 'order_items_rate_limited',
      title: 'Amazon Order Items API throttled',
      impact: 'Some orders are queued for retry while Amazon quota recovers. Prices/fees may be temporarily pending.',
      recommended_fix: 'Wait for the token bucket to refill or trigger enrich-pending-orders.',
      auto_fix_action: 'enrich-pending-orders',
      entity: order_id ? { order_id } : null,
      function_name, source: 'edge_runtime',
      raw_message: 'fetchOrderItems rate limited',
    }),

  feesApiThrottled: (user_id: string, function_name: string, asin?: string) =>
    logHealthSignal({
      user_id, module: 'amazon_api', severity: 'warning', confidence: 'high',
      pattern: 'fees_api_throttled',
      title: 'Amazon Fees API throttled',
      impact: 'ROI may show as pending for affected orders until the Fees API quota recovers.',
      recommended_fix: 'No action needed; the global fees_api token bucket will retry automatically.',
      auto_fix_action: 'calculate-roi-range',
      entity: asin ? { asin } : null,
      function_name, source: 'edge_runtime',
      raw_message: 'fees_api_waiting_token / 429',
    }),

  costInvalidUnitsZero: (user_id: string, function_name: string, order_id?: string, asin?: string) =>
    logHealthSignal({
      user_id, module: 'sales_pnl', severity: 'critical', confidence: 'high',
      pattern: 'cost_invalid_units_zero',
      title: 'Order cost rejected — units = 0',
      impact: 'Unit cost was not written; ROI is hidden until inventory/units are corrected.',
      recommended_fix: 'Verify the order quantity and re-run sync-sales-orders for the day.',
      auto_fix_action: 'sync-sales-orders',
      entity: { order_id, asin },
      function_name, source: 'cost_contract',
      raw_message: 'units<=0',
    }),

  spApiAuthError: (user_id: string, function_name: string, raw?: string) =>
    logHealthSignal({
      user_id, module: 'auth', severity: 'critical', confidence: 'high',
      pattern: 'sp_api_auth_failure',
      title: 'Amazon SP-API authentication failure',
      impact: 'Sync, repricer, and inventory operations cannot reach Amazon until the connection is restored.',
      recommended_fix: 'Reconnect Amazon account in Settings → Connections.',
      auto_fix_action: 'monitor-spapi-health',
      function_name, source: 'edge_runtime', raw_message: raw,
    }),

  inventoryStale: (user_id: string, function_name: string, asin?: string, sku?: string, marketplace?: string) =>
    logHealthSignal({
      user_id, module: 'inventory', severity: 'warning', confidence: 'high',
      pattern: 'inventory_stale',
      title: 'Inventory row stale or missing — preserved',
      impact: 'Stock is not auto-zeroed; repricer continues from last positive stock until confirmed.',
      recommended_fix: 'Run rescue-inventory-asin or confirm stock in Inventory > Review.',
      auto_fix_action: 'rescue-inventory-asin',
      entity: { asin, sku, marketplace },
      function_name, source: 'edge_runtime',
    }),

  repricerEvalFailure: (user_id: string, function_name: string, asin: string | undefined, raw: string) =>
    logHealthSignal({
      user_id, module: 'repricer', severity: 'warning', confidence: 'high',
      pattern: 'repricer_eval_failure',
      title: 'Repricer evaluation failed',
      impact: 'One or more listings were not re-priced this cycle.',
      recommended_fix: 'Open Repricer > Diagnostics on the affected ASIN.',
      auto_fix_action: 'repricer-evaluate',
      entity: asin ? { asin } : null,
      function_name, source: 'edge_runtime', raw_message: raw,
    }),

  amazonPriceUpdateFailed: (user_id: string, function_name: string, asin: string | undefined, raw: string) =>
    logHealthSignal({
      user_id, module: 'amazon_api', severity: 'warning', confidence: 'high',
      pattern: 'amazon_price_update_failed',
      title: 'Amazon price update rejected',
      impact: 'Submitted price did not reach Amazon; the listing keeps its previous price.',
      recommended_fix: 'Check listing eligibility and Amazon Automate Pricing min/max rules.',
      auto_fix_action: 'repricer-reconcile',
      entity: asin ? { asin } : null,
      function_name, source: 'edge_runtime', raw_message: raw,
    }),

  inboundPlanError: (user_id: string, function_name: string, raw: string) =>
    logHealthSignal({
      user_id, module: 'shipments', severity: 'critical', confidence: 'high',
      pattern: 'inbound_plan_error',
      title: 'Inbound plan errored at Amazon',
      impact: 'Shipment cannot proceed until the plan is fixed or recreated.',
      recommended_fix: 'Open Shipment Builder and review plan errors.',
      auto_fix_action: 'create-inbound-plan',
      function_name, source: 'edge_runtime', raw_message: raw,
    }),

  settlementSyncError: (user_id: string, function_name: string, raw: string) =>
    logHealthSignal({
      user_id, module: 'sales_pnl', severity: 'warning', confidence: 'high',
      pattern: 'settlement_sync_error',
      title: 'Settlement / Refund sync error',
      impact: 'P&L totals may drift until the settlement report is re-fetched.',
      recommended_fix: 'Re-run fetch-settlements or sync-refunds for the affected window.',
      auto_fix_action: 'fetch-settlements',
      function_name, source: 'edge_runtime', raw_message: raw,
    }),

  enrichmentRequeued: (user_id: string, function_name: string, reason: string, order_id?: string) =>
    logHealthSignal({
      user_id, module: 'sales_pnl', severity: 'warning', confidence: 'high',
      pattern: `enrichment_requeued:${reason}`,
      title: reason === 'rate_limited'
        ? 'Enrichment requeued — Amazon API throttled'
        : 'Enrichment requeued — no price returned',
      impact: 'Order is queued for retry; ROI/profit shown as pending in the meantime.',
      recommended_fix: 'Wait for next enrichment cycle or run enrich-pending-orders.',
      auto_fix_action: 'enrich-pending-orders',
      entity: order_id ? { order_id } : null,
      function_name, source: 'edge_runtime',
    }),
};
