// Health Center Aggregator — Phase 1 (read-only)
// Translates raw logs + DB correctness flags into deduped Business Health issues.
// Returns sample/grouped JSON; no UI yet, no new tables yet.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Severity = 'critical' | 'warning' | 'info' | 'healthy';
type Confidence = 'high' | 'medium' | 'low';
type Module =
  | 'sales_pnl' | 'inventory' | 'repricer' | 'shipments'
  | 'amazon_api' | 'auth' | 'gmail' | 'extension' | 'database' | 'billing';

interface RawSignal {
  module: Module;
  severity: Severity;
  confidence: Confidence;
  pattern: string;              // dedupe key seed (template, not per-instance text)
  title: string;                // user-facing title
  impact: string;               // business impact sentence
  recommended_fix: string;
  auto_fix_action?: string | null; // edge function name
  entity?: { asin?: string; sku?: string; order_id?: string; marketplace?: string };
  route?: string;               // for UI-origin
  function_name?: string;       // for edge-fn-origin
  source_table: string;         // where it came from
  detected_at: string;          // ISO
}

interface HealthIssue {
  fingerprint: string;
  module: Module;
  severity: Severity;
  confidence: Confidence;
  title: string;
  impact: string;
  recommended_fix: string;
  auto_fix_action: string | null;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  affected_entities: Array<{ asin?: string; sku?: string; order_id?: string; marketplace?: string }>;
  unique_orders_count: number;
  unique_asins_count: number;
  routes: string[];
  functions: string[];
  sources: string[];
  status: 'open';
}

// Canonical key for an entity so we can dedupe across signals/runs.
function entityKey(e?: { asin?: string; sku?: string; order_id?: string; marketplace?: string }): string {
  if (!e) return '';
  return [e.order_id || '', e.asin || '', e.sku || '', e.marketplace || ''].join('|').toLowerCase();
}

function fingerprint(parts: (string | undefined | null)[]): string {
  return parts.filter(Boolean).join('|').toLowerCase().slice(0, 240);
}

function classifyUiError(msg: string): { module: Module; pattern: string; severity: Severity } {
  const m = msg.toLowerCase();
  if (m.includes('non-2xx')) return { module: 'amazon_api', pattern: 'edge_non_2xx', severity: 'warning' };
  if (m.includes('quota') || m.includes('429') || m.includes('rate limit')) return { module: 'amazon_api', pattern: 'amazon_quota', severity: 'warning' };
  if (m.includes('fees')) return { module: 'amazon_api', pattern: 'fees_api_failure', severity: 'warning' };
  if (m.includes('repricer')) return { module: 'repricer', pattern: 'repricer_ui_error', severity: 'warning' };
  if (m.includes('inventory')) return { module: 'inventory', pattern: 'inventory_ui_error', severity: 'warning' };
  if (m.includes('shipment') || m.includes('inbound')) return { module: 'shipments', pattern: 'shipment_ui_error', severity: 'warning' };
  if (m.includes('gmail')) return { module: 'gmail', pattern: 'gmail_ui_error', severity: 'warning' };
  if (m.includes('auth') || m.includes('unauthorized') || m.includes('login')) return { module: 'auth', pattern: 'auth_ui_error', severity: 'warning' };
  if (m.includes('sales') || m.includes('order') || m.includes('roi') || m.includes('profit')) return { module: 'sales_pnl', pattern: 'sales_ui_error', severity: 'warning' };
  return { module: 'database', pattern: 'generic_ui_error', severity: 'info' };
}

async function collectSignals(supabase: any, userId: string, sinceISO: string): Promise<RawSignal[]> {
  const out: RawSignal[] = [];

  // ---- 1. UI errors (error_reports) — LOW confidence, dedupe by pattern + route ----
  const { data: uiErrors } = await supabase
    .from('error_reports')
    .select('error_message, page_url, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: false })
    .limit(2000);
  for (const r of uiErrors || []) {
    const cls = classifyUiError(r.error_message || '');
    out.push({
      module: cls.module,
      severity: cls.severity,
      confidence: 'low',
      pattern: cls.pattern,
      title: cls.pattern === 'edge_non_2xx'
        ? 'Backend call returned an error in the UI'
        : `UI issue: ${cls.pattern.replace(/_/g, ' ')}`,
      impact: 'A user-facing action failed. Repeated occurrences usually point to a backend health issue translated below.',
      recommended_fix: 'Cross-check the matching backend issue (higher confidence). If none, retry the action.',
      auto_fix_action: null,
      route: r.page_url || undefined,
      source_table: 'error_reports',
      detected_at: r.created_at,
    });
  }

  // ---- 2. Backend errors (error_logs) — MEDIUM confidence ----
  const { data: backendErrors } = await supabase
    .from('error_logs')
    .select('message, module, created_at')
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: false })
    .limit(2000);
  for (const r of backendErrors || []) {
    const mod = (r.module || 'database') as Module;
    out.push({
      module: (['sales_pnl','inventory','repricer','shipments','amazon_api','auth','gmail','extension','database','billing'].includes(mod) ? mod : 'database') as Module,
      severity: 'warning',
      confidence: 'medium',
      pattern: `backend:${(r.message || '').slice(0, 80)}`,
      title: r.message?.slice(0, 120) || 'Backend error',
      impact: 'A backend operation failed. Repeated occurrences indicate a systemic problem.',
      recommended_fix: 'Review module log; if pattern repeats, escalate.',
      auto_fix_action: null,
      function_name: r.module || undefined,
      source_table: 'error_logs',
      detected_at: r.created_at,
    });
  }

  // ---- 3. Enrichment failures — HIGH confidence (structured) ----
  const { data: enrich } = await supabase
    .from('enrichment_logs')
    .select('asin, order_id, seller_sku, enrichment_type, status, error_message, attempts, created_at')
    .eq('user_id', userId)
    .in('status', ['failed', 'rate_limited', 'requeued'])
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: false })
    .limit(2000);
  for (const r of enrich || []) {
    const isRl = (r.error_message || '').toLowerCase().includes('rate') || r.status === 'rate_limited';
    out.push({
      module: 'sales_pnl',
      severity: isRl ? 'warning' : 'critical',
      confidence: 'high',
      pattern: `enrich:${r.enrichment_type || 'order'}:${r.status}`,
      title: isRl
        ? 'Order Items API throttled — enrichment requeued'
        : `Enrichment failed: ${r.enrichment_type || 'order'}`,
      impact: isRl
        ? 'Some orders are waiting for Amazon Order Items API quota to recover. Prices/fees may be temporarily pending.'
        : 'Order could not be enriched after retries; ROI/profit shown as pending until resolved.',
      recommended_fix: isRl
        ? 'Wait for token bucket to refill, then re-run enrichment.'
        : 'Manually requeue this order or trigger sync-sales-orders with force_price_update.',
      auto_fix_action: 'enrich-pending-orders',
      entity: { asin: r.asin || undefined, order_id: r.order_id || undefined, sku: r.seller_sku || undefined },
      source_table: 'enrichment_logs',
      detected_at: r.created_at,
    });
  }

  // ---- 4. SP-API health alerts — HIGH ----
  const { data: spapi } = await supabase
    .from('spapi_health_alerts')
    .select('issue_type, error_message, status, first_detected_at, last_detected_at, notify_count')
    .eq('user_id', userId)
    .neq('status', 'resolved')
    .gte('last_detected_at', sinceISO)
    .limit(500);
  for (const r of spapi || []) {
    out.push({
      module: 'amazon_api',
      severity: 'critical',
      confidence: 'high',
      pattern: `spapi:${r.issue_type}`,
      title: `SP-API: ${r.issue_type}`,
      impact: r.error_message || 'Amazon SP-API health alert is open.',
      recommended_fix: 'Reconnect Amazon account or wait for quota window.',
      auto_fix_action: 'monitor-spapi-health',
      source_table: 'spapi_health_alerts',
      detected_at: r.last_detected_at,
    });
  }

  // ---- 5. Inventory needs-review queue — HIGH ----
  const { data: invRev } = await supabase
    .from('inventory_missing_review')
    .select('asin, sku, marketplace, reason, occurrences, last_missing_at, status')
    .eq('user_id', userId)
    .eq('status', 'needs_review')
    .gte('last_missing_at', sinceISO)
    .limit(2000);
  for (const r of invRev || []) {
    out.push({
      module: 'inventory',
      severity: 'warning',
      confidence: 'high',
      pattern: `inv_review:${r.reason}`,
      title: 'Inventory row missing from Amazon report — needs review',
      impact: 'Stock not auto-zeroed to prevent ghosting. Repricer continues from last positive stock until you confirm.',
      recommended_fix: 'Open Inventory > Review to confirm stock; rescue-inventory-asin can re-check.',
      auto_fix_action: 'rescue-inventory-asin',
      entity: { asin: r.asin, sku: r.sku || undefined, marketplace: r.marketplace },
      source_table: 'inventory_missing_review',
      detected_at: r.last_missing_at,
    });
  }

  // ---- 6. Sales correctness flags — HIGH ----
  const { data: bad } = await supabase
    .from('sales_orders')
    .select('order_id, asin, marketplace, cost_invalid, fees_invalid, needs_price_enrich, pending_enrich_last_error, pending_enrich_attempts, updated_at')
    .eq('user_id', userId)
    .or('cost_invalid.eq.true,fees_invalid.eq.true,needs_price_enrich.eq.true')
    .gte('updated_at', sinceISO)
    .limit(3000);
  for (const r of bad || []) {
    if (r.cost_invalid) {
      out.push({
        module: 'sales_pnl', severity: 'critical', confidence: 'high',
        pattern: 'sales:cost_invalid',
        title: 'Order has invalid cost — ROI hidden',
        impact: 'Profit/ROI cannot be trusted; row excluded from financial totals.',
        recommended_fix: 'Set a real unit cost on the inventory/listing row, then resync.',
        auto_fix_action: 'backfill-orders-cost',
        entity: { order_id: r.order_id, asin: r.asin || undefined, marketplace: r.marketplace || undefined },
        function_name: 'sync-sales-orders',
        source_table: 'sales_orders.cost_invalid', detected_at: r.updated_at,
      });
    }
    if (r.fees_invalid) {
      out.push({
        module: 'sales_pnl', severity: 'info', confidence: 'high',
        pattern: 'sales:fees_invalid',
        title: 'ROI pending — waiting for Amazon settled fees',
        impact: 'Estimated fees looked too high vs sale price (common for refunds and low-priced items), so ROI is shown as pending until Amazon’s settlement report arrives (usually within 7–14 days). No action needed.',
        recommended_fix: 'No action needed — settled fees will overwrite the estimate automatically. Only trigger reconcile-settlement if it persists past 14 days.',
        auto_fix_action: 'reconcile-settlement',
        entity: { order_id: r.order_id, asin: r.asin || undefined, marketplace: r.marketplace || undefined },
        function_name: 'sync-sales-orders',
        source_table: 'sales_orders.fees_invalid', detected_at: r.updated_at,
      });
    }
    if (r.needs_price_enrich) {
      const isRl = (r.pending_enrich_last_error || '').includes('RATE_LIMITED');
      out.push({
        module: 'sales_pnl', severity: 'warning', confidence: 'high',
        pattern: isRl ? 'sales:requeued_rate_limited' : 'sales:requeued_no_price',
        title: isRl ? 'Order requeued — Amazon Order Items API throttled' : 'Order requeued — no price returned',
        impact: 'Price/ROI temporarily pending. Will retry on next enrichment cycle.',
        recommended_fix: 'Wait for next enrichment, or run enrich-pending-orders.',
        auto_fix_action: 'enrich-pending-orders',
        entity: { order_id: r.order_id, asin: r.asin || undefined, marketplace: r.marketplace || undefined },
        function_name: 'enrich-pending-orders',
        source_table: 'sales_orders.needs_price_enrich', detected_at: r.updated_at,
      });
    }
  }

  // ---- 7. Database maintenance alerts — HIGH ----
  const { data: dbm } = await supabase
    .from('database_maintenance_alerts')
    .select('kind, severity, message, created_at')
    .is('acknowledged_at', null)
    .gte('created_at', sinceISO)
    .limit(500);
  for (const r of dbm || []) {
    out.push({
      module: 'database',
      severity: (r.severity as Severity) || 'warning',
      confidence: 'high',
      pattern: `db:${r.kind}`,
      title: `Database maintenance: ${r.kind}`,
      impact: r.message || 'Database health alert is open.',
      recommended_fix: 'Open /tools/database-maintenance to review.',
      auto_fix_action: null,
      source_table: 'database_maintenance_alerts',
      detected_at: r.created_at,
    });
  }

  // ---- 8. Sync parity (Live vs FEC) — HIGH ----
  const { data: par } = await supabase
    .from('sync_parity_log')
    .select('marketplace, gap_type, so_count, fec_count, repair_status, created_at')
    .eq('user_id', userId)
    .neq('repair_status', 'repaired')
    .gte('created_at', sinceISO)
    .limit(500);
  for (const r of par || []) {
    out.push({
      module: 'sales_pnl', severity: 'warning', confidence: 'high',
      pattern: `parity:${r.gap_type}`,
      title: `Sales parity gap (${r.marketplace}): ${r.gap_type}`,
      impact: `Live orders (${r.so_count}) ≠ FEC orders (${r.fec_count}). Totals may drift until repaired.`,
      recommended_fix: 'Run sync-sales-orders with include_orders=true for the affected day.',
      auto_fix_action: 'sync-sales-orders',
      entity: { marketplace: r.marketplace },
      source_table: 'sync_parity_log', detected_at: r.created_at,
    });
  }

  // ---- 9. API rate limit buckets — INFO (live state) ----
  const { data: rl } = await supabase.from('api_rate_limits').select('*');
  for (const r of rl || []) {
    const pct = r.capacity > 0 ? r.tokens_available / r.capacity : 1;
    if (pct < 0.25) {
      out.push({
        module: 'amazon_api', severity: 'warning', confidence: 'high',
        pattern: `bucket:${r.bucket}`,
        title: `${r.bucket} token bucket low (${Math.round(pct * 100)}%)`,
        impact: 'Amazon API calls in this bucket will wait for tokens; some operations slow temporarily.',
        recommended_fix: 'No action needed; bucket refills automatically at the configured rate.',
        auto_fix_action: null,
        source_table: 'api_rate_limits', detected_at: r.updated_at,
      });
    }
  }

  return out;
}

function dedupe(signals: RawSignal[]): HealthIssue[] {
  const map = new Map<string, HealthIssue & { _entityKeys: Set<string> }>();
  for (const s of signals) {
    const fp = fingerprint([s.module, s.pattern, s.route, s.function_name]);
    const ex = map.get(fp);
    const ek = entityKey(s.entity);
    if (!ex) {
      const seed: HealthIssue & { _entityKeys: Set<string> } = {
        fingerprint: fp,
        module: s.module,
        severity: s.severity,
        confidence: s.confidence,
        title: s.title,
        impact: s.impact,
        recommended_fix: s.recommended_fix,
        auto_fix_action: s.auto_fix_action ?? null,
        occurrence_count: 1,
        first_seen: s.detected_at,
        last_seen: s.detected_at,
        affected_entities: s.entity ? [s.entity] : [],
        unique_orders_count: 0,
        unique_asins_count: 0,
        routes: s.route ? [s.route] : [],
        functions: s.function_name ? [s.function_name] : [],
        sources: [s.source_table],
        status: 'open',
        _entityKeys: ek ? new Set([ek]) : new Set(),
      };
      map.set(fp, seed);
    } else {
      ex.occurrence_count += 1;
      if (s.detected_at < ex.first_seen) ex.first_seen = s.detected_at;
      if (s.detected_at > ex.last_seen) ex.last_seen = s.detected_at;
      if (s.entity && ek && !ex._entityKeys.has(ek) && ex.affected_entities.length < 25) {
        ex.affected_entities.push(s.entity);
        ex._entityKeys.add(ek);
      }
      if (s.route && !ex.routes.includes(s.route) && ex.routes.length < 10) ex.routes.push(s.route);
      if (s.function_name && !ex.functions.includes(s.function_name) && ex.functions.length < 10) ex.functions.push(s.function_name);
      if (!ex.sources.includes(s.source_table)) ex.sources.push(s.source_table);
      const sevRank: Record<Severity, number> = { healthy: 0, info: 1, warning: 2, critical: 3 };
      if (sevRank[s.severity] > sevRank[ex.severity]) ex.severity = s.severity;
      const confRank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
      if (confRank[s.confidence] > confRank[ex.confidence]) ex.confidence = s.confidence;
    }
  }
  // Compute unique counts across ALL signals (not just first 25 entities).
  const allKeysByFp = new Map<string, { orders: Set<string>; asins: Set<string> }>();
  for (const s of signals) {
    const fp = fingerprint([s.module, s.pattern, s.route, s.function_name]);
    let agg = allKeysByFp.get(fp);
    if (!agg) { agg = { orders: new Set(), asins: new Set() }; allKeysByFp.set(fp, agg); }
    if (s.entity?.order_id) agg.orders.add(s.entity.order_id.toLowerCase());
    if (s.entity?.asin) agg.asins.add(s.entity.asin.toLowerCase());
  }
  const out: HealthIssue[] = [];
  for (const ex of map.values()) {
    const agg = allKeysByFp.get(ex.fingerprint);
    ex.unique_orders_count = agg ? agg.orders.size : 0;
    ex.unique_asins_count = agg ? agg.asins.size : 0;
    const { _entityKeys: _drop, ...clean } = ex;
    out.push(clean);
  }
  return out;
}

function summarize(issues: HealthIssue[]) {
  const byModule: Record<string, number> = {};
  const bySeverity: Record<string, number> = { critical: 0, warning: 0, info: 0, healthy: 0 };
  const byConfidence: Record<string, number> = { high: 0, medium: 0, low: 0 };
  for (const i of issues) {
    byModule[i.module] = (byModule[i.module] || 0) + 1;
    bySeverity[i.severity] += 1;
    byConfidence[i.confidence] += 1;
  }
  return { total_issues: issues.length, by_module: byModule, by_severity: bySeverity, by_confidence: byConfidence };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization');
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!user) throw new Error('Unauthorized');

    const url = new URL(req.url);
    const windowHours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours') || '24')));
    const moduleFilter = url.searchParams.get('module'); // optional
    const sinceISO = new Date(Date.now() - windowHours * 3600_000).toISOString();

    const signals = await collectSignals(supabase, user.id, sinceISO);
    let issues = dedupe(signals);
    if (moduleFilter) issues = issues.filter(i => i.module === moduleFilter);

    // ---- Phase 2: PERSIST via upsert RPC (server-side dedupe by fingerprint) ----
    const persist = url.searchParams.get('persist') !== 'false';
    if (persist) {
      for (const s of signals) {
        try {
          await supabase.rpc('upsert_business_health_issue', {
            _user_id: user.id,
            _fingerprint: [s.module, s.pattern, s.route, s.function_name].filter(Boolean).join('|').toLowerCase().slice(0, 240),
            _module: s.module, _severity: s.severity, _confidence: s.confidence,
            _title: s.title.slice(0, 200),
            _impact: (s.impact || '').slice(0, 500),
            _recommended_fix: (s.recommended_fix || '').slice(0, 500),
            _auto_fix_action: s.auto_fix_action ?? null,
            _entity: s.entity ?? null,
            _route: s.route ?? null,
            _function_name: s.function_name ?? null,
            _source: s.source_table ?? null,
            _raw_message: null,
          });
        } catch (_e) { /* never break aggregator on persist error */ }
      }
      // Apply auto-resolve rules for this user
      try { await supabase.rpc('auto_resolve_business_health_issues', { _user_id: user.id }); } catch (_e) {}
    }

    // Sort: critical first, then by occurrence_count desc
    const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2, healthy: 3 };
    issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.occurrence_count - a.occurrence_count);

    return new Response(JSON.stringify({
      window_hours: windowHours,
      since: sinceISO,
      summary: summarize(issues),
      issues,
    }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'aggregator failed' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
