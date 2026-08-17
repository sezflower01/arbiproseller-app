// TEMPORARY verification for the qualification work. Deleted when done.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const PROBE_TOKEN = 'n4Bz7pKw9sVc3mLx6Hqt';

Deno.serve(async (req) => {
  if (req.headers.get('x-probe-token') !== PROBE_TOKEN) {
    return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({}));
  const sinceIso = body.since || null;

  const rows: any[] = [];
  for (let from = 0; from < 40000; from += 1000) {
    let q = admin
      .from('seller_watch_new_listings')
      .select('asin, title, product_group, sales_rank, qualified, disqualified_reason, source_status, detected_at')
      .range(from, from + 999);
    if (sinceIso) q = q.gte('detected_at', sinceIso);
    const { data, error } = await q;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const tally = (list: any[], f: (r: any) => string | null) => {
    const m: Record<string, number> = {};
    for (const r of list) { const k = f(r); if (k !== null) m[k] = (m[k] || 0) + 1; }
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 20));
  };

  // Exactly what the Searching tab partitions on.
  const pending = rows.filter((r) => r.source_status === 'unsourced' || r.source_status === 'sourcing');
  const pendingBlocked = pending.filter((r) => r.qualified === false);
  const pendingQueued = pending.filter((r) => r.qualified !== false);

  return new Response(JSON.stringify({
    scope: sinceIso ? `detected_at >= ${sinceIso}` : 'all rows',
    total_rows: rows.length,
    product_group_resolved: rows.filter((r) => r.product_group).length,
    product_group_null: rows.filter((r) => !r.product_group).length,
    resolved_pct: rows.length ? Math.round((rows.filter((r) => r.product_group).length / rows.length) * 100) : 0,
    searching_tab: {
      total: pending.length,
      shown_as_queued: pendingQueued.length,
      in_collapsed_group: pendingBlocked.length,
      collapsed_group_reasons: tally(pendingBlocked, (r) => r.disqualified_reason),
    },
    product_group_values: tally(rows.filter((r) => r.product_group), (r) => r.product_group),
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
});
