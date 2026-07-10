import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Background worker that drains pending/failed bounds syncs to Amazon.
 * Designed to be called by pg_cron every minute.
 * Processes up to BATCH_SIZE rows per run with throttling.
 */

const BATCH_SIZE = 30;
const THROTTLE_MS = 800;
const EXTRA_PAUSE_EVERY = 5;
const EXTRA_PAUSE_MS = 1500;
const MAX_RETRY_ATTEMPTS = 5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Recover stuck 'processing' rows (older than 3 minutes) back to pending
    const stuckThreshold = new Date(Date.now() - 3 * 60_000).toISOString();
    await supabase
      .from('repricer_assignments')
      .update({ bounds_sync_status: 'pending' })
      .eq('bounds_sync_status', 'processing')
      .lt('updated_at', stuckThreshold);

    // Fetch pending or retryable-failed rows across all users
    const { data: rows, error: fetchErr } = await supabase
      .from('repricer_assignments')
      .select('id, user_id, asin, sku, marketplace, min_price_override, max_price_override, bounds_sync_attempts')
      .eq('is_enabled', true)
      .not('min_price_override', 'is', null)
      .or('bounds_sync_status.eq.pending,and(bounds_sync_status.eq.failed,next_bounds_sync_at.lte.' + new Date().toISOString() + ')')
      .lt('bounds_sync_attempts', MAX_RETRY_ATTEMPTS)
      .order('bounds_last_requested_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);

    if (fetchErr) throw fetchErr;

    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ drained: 0, message: 'No pending bounds to sync' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[drain-bounds-sync] Processing ${rows.length} pending rows`);

    let synced = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Mark as processing
      await supabase
        .from('repricer_assignments')
        .update({ bounds_sync_status: 'processing' })
        .eq('id', row.id);

      try {
        const pushBody: Record<string, any> = {
          user_id: row.user_id,
          asin: row.asin,
          sku: row.sku,
          marketplace: row.marketplace,
          newMinPrice: row.min_price_override,
          updateMinMaxOnly: true,
          internal: true,
        };
        if (row.max_price_override != null) {
          pushBody.newMaxPrice = row.max_price_override;
        }

        const resp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify(pushBody),
        });

        const result = await resp.json().catch(() => null);

        if (resp.ok && result?.success) {
          synced++;
          await supabase
            .from('repricer_assignments')
            .update({
              bounds_synced_at: new Date().toISOString(),
              bounds_sync_status: 'synced',
              bounds_sync_attempts: 0,
              last_bounds_sync_error: null,
              next_bounds_sync_at: null,
            })
            .eq('id', row.id);
          console.log(`[drain-bounds-sync] ✅ ${row.asin}/${row.sku}/${row.marketplace}: synced`);
        } else {
          const errMsg = result?.error || `HTTP ${resp.status}`;
          failed++;
          const attempts = (row.bounds_sync_attempts || 0) + 1;
          const backoffMs = Math.min(attempts * 120_000, 600_000); // 2min, 4min, 6min, 8min, 10min max
          await supabase
            .from('repricer_assignments')
            .update({
              bounds_sync_status: attempts >= MAX_RETRY_ATTEMPTS ? 'failed' : 'failed',
              bounds_sync_attempts: attempts,
              last_bounds_sync_error: errMsg.slice(0, 500),
              next_bounds_sync_at: new Date(Date.now() + backoffMs).toISOString(),
            })
            .eq('id', row.id);
          console.warn(`[drain-bounds-sync] ❌ ${row.asin}/${row.marketplace}: ${errMsg} (attempt ${attempts})`);
        }
      } catch (e: any) {
        failed++;
        const attempts = (row.bounds_sync_attempts || 0) + 1;
        await supabase
          .from('repricer_assignments')
          .update({
            bounds_sync_status: 'failed',
            bounds_sync_attempts: attempts,
            last_bounds_sync_error: ((e as Error).message || 'unknown').slice(0, 500),
            next_bounds_sync_at: new Date(Date.now() + 120_000).toISOString(),
          })
          .eq('id', row.id);
        console.warn(`[drain-bounds-sync] ❌ ${row.asin}/${row.marketplace}: EXCEPTION ${(e as Error).message}`);
      }

      // Throttle
      await new Promise(r => setTimeout(r, THROTTLE_MS));
      if ((i + 1) % EXTRA_PAUSE_EVERY === 0) {
        await new Promise(r => setTimeout(r, EXTRA_PAUSE_MS));
      }
    }

    // Check remaining
    const { count: remaining } = await supabase
      .from('repricer_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('is_enabled', true)
      .not('min_price_override', 'is', null)
      .in('bounds_sync_status', ['pending', 'failed']);

    console.log(`[drain-bounds-sync] Done: ${synced} synced, ${failed} failed, ${remaining ?? '?'} remaining`);

    return new Response(
      JSON.stringify({ synced, failed, remaining: remaining ?? 0 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('[drain-bounds-sync] Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'drain-bounds-sync failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});