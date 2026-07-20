// Drains pricing_suppression_check_queue and invokes check-pricing-suppression-item
// per item. Mirrors inventory-refresh-worker's queue-drain pattern -- built after
// a single bulk detect-pricing-suppressions invocation hit WORKER_RESOURCE_LIMIT
// for an account with 1,723 SKUs eligible for suppression re-check.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const INTERNAL_SECRET = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

const DEFAULT_BATCH = 30; // lower than inventory-refresh-worker's 60 -- each item
                          // here does a full SP-API signed call plus a 220ms throttle
                          // sleep inside checkAndUpdateSuppressionForItem's caller
                          // conventions, so it's heavier per-item than a rescue call.
const CONCURRENCY = 4;
const PER_ITEM_TIMEOUT_MS = 25_000;

async function callCheckItem(item: { user_id: string; asin: string; sku: string; marketplace: string }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_ITEM_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/check-pricing-suppression-item`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE}`,
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({
        user_id: item.user_id,
        asin: item.asin,
        sku: item.sku,
        marketplace: item.marketplace,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `check-item ${res.status}: ${text.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `fetch: ${e?.message || String(e)}` };
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth: allow service-role bearer or matching internal secret
  const auth = req.headers.get('authorization') || '';
  const internal = req.headers.get('x-internal-secret') || '';
  const ok =
    auth.includes(SERVICE_ROLE) ||
    (INTERNAL_SECRET && internal === INTERNAL_SECRET);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let batchSize = DEFAULT_BATCH;
  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (typeof body?.batch_size === 'number') batchSize = Math.max(1, Math.min(60, body.batch_size));
  } catch { /* ignore */ }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { withCronLock } = await import('../_shared/cron-lock.ts');
  const outcome = await withCronLock(supa as any, 'pricing-suppression-worker-1m', 110, async () => {
    const { data: claimed, error: claimErr } = await supa.rpc('dequeue_pricing_suppression_check', { p_limit: batchSize });
    if (claimErr) throw new Error(`dequeue failed: ${claimErr.message}`);

    const items = (claimed || []) as any[];
    if (items.length === 0) {
      return { items_processed: 0, detail: { processed: 0, success: 0, errors: 0, drained: true } };
    }

    let success = 0, errors = 0;
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const idx = cursor++;
        const it = items[idx];
        const r = await callCheckItem(it);
        if (r.ok) {
          success++;
          await supa.rpc('mark_pricing_suppression_check_success', { p_id: it.id });
        } else {
          errors++;
          await supa.rpc('mark_pricing_suppression_check_error', { p_id: it.id, p_error: r.error });
        }
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker());
    await Promise.all(workers);

    return {
      items_processed: items.length,
      detail: { processed: items.length, success, errors, drained: items.length < batchSize },
    };
  });

  return new Response(JSON.stringify({ ...outcome }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
