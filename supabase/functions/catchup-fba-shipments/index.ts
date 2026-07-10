// Weekly catch-up: re-sync the trailing 13 months of FBA shipments for every
// user that has a seller authorization. Uses the internal-secret auth path on
// sync-fba-shipments. Triggered by pg_cron (see migration).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const internalSecret = req.headers.get('x-internal-secret');
    const expectedSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    if (!internalSecret || !expectedSecret || internalSecret !== expectedSecret) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Build a trailing 13-month window, split into ~3-month chunks. A single
    // 13-month call OOMs the sync worker (HTTP 546 WORKER_RESOURCE_LIMIT), so
    // we page through smaller windows sequentially.
    const end = new Date().toISOString().slice(0, 10);
    const chunks: Array<{ start: string; end: string }> = [];
    {
      const CHUNK_MONTHS = 3;
      const TOTAL_MONTHS = 13;
      for (let offset = TOTAL_MONTHS; offset > 0; offset -= CHUNK_MONTHS) {
        const chunkStart = monthsAgoIso(offset);
        const chunkEndOffset = Math.max(0, offset - CHUNK_MONTHS);
        const chunkEnd = chunkEndOffset === 0 ? end : monthsAgoIso(chunkEndOffset);
        chunks.push({ start: chunkStart, end: chunkEnd });
      }
    }
    const start = chunks[0].start;

    const { data: auths, error: authErr } = await supabase
      .from('seller_authorizations')
      .select('user_id');

    if (authErr) throw authErr;

    const userIds = Array.from(new Set((auths ?? []).map((a: any) => a.user_id).filter(Boolean)));
    console.log(`[catchup-fba-shipments] window=${start}..${end} chunks=${chunks.length} users=${userIds.length}`);

    const results: Array<{ user_id: string; ok: boolean; upserted?: number; items?: number; error?: string; chunks_ok?: number; chunks_failed?: number }> = [];

    for (const userId of userIds) {
      let upserted = 0;
      let items = 0;
      let chunksOk = 0;
      let chunksFailed = 0;
      let lastError: string | undefined;

      for (const { start: cStart, end: cEnd } of chunks) {
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/sync-fba-shipments`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY') ?? ''}`,
              'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? '',
              'x-internal-secret': expectedSecret,
            },
            body: JSON.stringify({
              user_id: userId,
              dateRangeStart: cStart,
              dateRangeEnd: cEnd,
            }),
          });
          const text = await resp.text();
          let payload: any = null;
          try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

          if (!resp.ok) {
            chunksFailed += 1;
            lastError = `HTTP ${resp.status} [${cStart}..${cEnd}]: ${text.slice(0, 160)}`;
          } else {
            chunksOk += 1;
            upserted += payload?.shipmentsUpserted ?? 0;
            items += payload?.itemsUpserted ?? 0;
          }
        } catch (e: any) {
          chunksFailed += 1;
          lastError = `[${cStart}..${cEnd}] ${e?.message ?? String(e)}`;
        }
        // Throttle between chunks to give SP-API + worker a breather.
        await new Promise((r) => setTimeout(r, 2000));
      }

      results.push({
        user_id: userId,
        ok: chunksOk > 0 && chunksFailed === 0,
        upserted,
        items,
        chunks_ok: chunksOk,
        chunks_failed: chunksFailed,
        ...(lastError ? { error: lastError } : {}),
      });

      // Light throttle between users to avoid SP-API rate limits
      await new Promise((r) => setTimeout(r, 1500));
    }

    const summary = {
      window: { start, end },
      chunks: chunks.length,
      users: userIds.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      total_upserted: results.reduce((s, r) => s + (r.upserted ?? 0), 0),
      total_items: results.reduce((s, r) => s + (r.items ?? 0), 0),
      results,
    };
    console.log(`[catchup-fba-shipments] done`, JSON.stringify(summary).slice(0, 500));

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[catchup-fba-shipments] error', e);
    return new Response(JSON.stringify({ success: false, error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
