// Aggregates analyzer_decision_log across ALL users for a given brand, so
// the extension can show "here's what the community has seen scanning
// other ASINs from this brand" instead of only judging the one ASIN loaded
// right now.
//
// Privacy contract: this NEVER returns another user's raw row — no cost,
// profit, margin, ASIN-level detail, or user identity. Only aggregate
// counts (distinct-ASIN total, Private-Label Risk distribution, final
// decision distribution), gated behind a minimum sample size so a single
// other user's one scan is never distinguishable in the response.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MIN_OTHER_ASINS = 2;
const MAX_ROWS_SCANNED = 2000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);

    // Any signed-in user may call this — it only ever returns aggregate
    // counts pooled across users, never another user's raw scan data.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const brand = String(body?.brand || '').trim();
    const currentAsin = String(body?.asin || '').trim().toUpperCase();
    if (!brand) return json({ error: 'brand required' }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    // ilike with no wildcards = case-insensitive exact match — tolerates
    // "Acme" vs "ACME" vs "acme" across different scans/users without
    // needing a normalized brand column.
    const { data: rows, error } = await admin
      .from('analyzer_decision_log')
      .select('asin, marketplace, pl_risk, final_decision, scanned_at')
      .ilike('brand', brand)
      .order('scanned_at', { ascending: false })
      .limit(MAX_ROWS_SCANNED);
    if (error) throw error;

    // Most-recent scan per ASIN+marketplace only — a user re-scanning the
    // same ASIN five times must not count as five data points.
    const seen = new Set<string>();
    const latestPerAsin: { asin: string; marketplace: string; pl_risk: string | null; final_decision: string | null }[] = [];
    for (const r of rows || []) {
      const key = `${r.asin}::${r.marketplace}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latestPerAsin.push(r as any);
    }

    const others = latestPerAsin.filter(r => r.asin.toUpperCase() !== currentAsin);

    if (others.length < MIN_OTHER_ASINS) {
      return json({ brand, hasEnoughData: false, distinctAsins: others.length });
    }

    const plRiskCounts: Record<string, number> = {};
    const decisionCounts: Record<string, number> = {};
    for (const r of others) {
      const pl = r.pl_risk || 'Unknown';
      plRiskCounts[pl] = (plRiskCounts[pl] || 0) + 1;
      const d = r.final_decision || 'Unknown';
      decisionCounts[d] = (decisionCounts[d] || 0) + 1;
    }

    return json({
      brand,
      hasEnoughData: true,
      distinctAsins: others.length,
      plRiskCounts,
      decisionCounts,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
