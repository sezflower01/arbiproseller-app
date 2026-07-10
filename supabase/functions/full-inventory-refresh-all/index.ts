// Mirrors the mobile/desktop "Manual SP-API Refresh" button, but for EVERY user.
// Uses EdgeRuntime.waitUntil() to survive past the HTTP response.
// Parallel batched fan-out of rescue-inventory-asin (mirrors what the button does in the browser).
//
// Triggered by pg_cron every 2h. Auth: x-internal-secret OR service-role bearer.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const PARALLEL_BATCH = 60;       // Concurrent rescue-inventory-asin calls (high to fit in wall-time)
const BATCH_PAUSE_MS = 0;        // No pause between waves
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function processAll(req_body: any) {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const supabase = createClient(SUPABASE_URL, serviceRoleKey);
  const startedAt = Date.now();
  const onlyUserId: string | null = req_body?.user_id || null;
  const runTag = `run_${Date.now().toString(36)}`;

  console.log(`[full-inventory-refresh-all] ${runTag} START scope=${onlyUserId ? 'single_user:' + onlyUserId : 'all_users'}`);

  // Resolve users
  let userIds: string[] = [];
  if (onlyUserId) {
    userIds = [onlyUserId];
  } else {
    const seen = new Set<string>();
    let from = 0;
    const PAGE = 1000;
    for (let i = 0; i < 200; i++) {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('user_id')
        .eq('is_enabled', true)
        .range(from, from + PAGE - 1);
      if (error) { console.error(`[${runTag}] users query error: ${error.message}`); break; }
      if (!data || data.length === 0) break;
      for (const r of data) if (r.user_id) seen.add(r.user_id);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    userIds = Array.from(seen);
  }
  console.log(`[${runTag}] users to process: ${userIds.length}`);

  let grandChecked = 0, grandOk = 0, grandErr = 0;

  for (const userId of userIds) {
    // Pull all inventory rows
    const rows: any[] = [];
    let from = 0;
    const PAGE = 1000;
    for (let i = 0; i < 200; i++) {
      const { data, error } = await supabase
        .from('inventory')
        .select('asin, sku, listing_status, source')
        .eq('user_id', userId)
        .range(from, from + PAGE - 1);
      if (error) { console.error(`[${runTag}] ${userId} inventory query error: ${error.message}`); break; }
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    const seen = new Set<string>();
    const items = rows.filter((r: any) => {
      const status = String(r.listing_status || '').toUpperCase();
      if (r.source === 'created_listing' || status === 'DELETED' || !r.asin || !r.sku) return false;
      const k = `${r.asin}::${r.sku}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    console.log(`[${runTag}] user=${userId} items=${items.length} (raw_rows=${rows.length})`);

    let checked = 0, ok = 0, err = 0;
    const userStart = Date.now();

    // Parallel waves
    for (let i = 0; i < items.length; i += PARALLEL_BATCH) {
      const wave = items.slice(i, i + PARALLEL_BATCH);
      const results = await Promise.allSettled(wave.map((item) =>
        fetch(`${SUPABASE_URL}/functions/v1/rescue-inventory-asin`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`,
            'x-internal-secret': internalSecret,
          },
          body: JSON.stringify({ asin: item.asin, sku: item.sku, user_id: userId }),
        }).then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          await resp.json().catch(() => ({}));
          return true;
        })
      ));
      checked += wave.length;
      for (const r of results) (r.status === 'fulfilled' ? ok++ : err++);

      // Heartbeat every 10 waves (~80 items)
      if ((i / PARALLEL_BATCH) % 10 === 0) {
        console.log(`[${runTag}] user=${userId} progress checked=${checked}/${items.length} ok=${ok} err=${err} elapsed=${Math.round((Date.now()-userStart)/1000)}s`);
      }
      await sleep(BATCH_PAUSE_MS);
    }

    grandChecked += checked; grandOk += ok; grandErr += err;
    console.log(`[${runTag}] user=${userId} DONE checked=${checked} ok=${ok} err=${err} duration_s=${Math.round((Date.now()-userStart)/1000)}`);
  }

  console.log(`[${runTag}] FINISHED users=${userIds.length} checked=${grandChecked} ok=${grandOk} err=${grandErr} total_s=${Math.round((Date.now()-startedAt)/1000)}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const auth = req.headers.get('authorization') || '';
  const okSecret = internalSecret && providedSecret && providedSecret === internalSecret;
  const okBearer = serviceRoleKey && auth === `Bearer ${serviceRoleKey}`;
  if (!okSecret && !okBearer) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  // Survive past HTTP response — keeps worker alive for the long loop
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(processAll(body).catch((e) => console.error('[full-inventory-refresh-all] fatal', e)));

  return new Response(JSON.stringify({ ok: true, accepted: true, scope: body?.user_id ? 'single_user' : 'all_users' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 202,
  });
});
