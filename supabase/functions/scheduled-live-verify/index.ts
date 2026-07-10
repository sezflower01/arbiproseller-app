import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Scheduled Live Verify — runs via pg_cron every 4 hours.
 * 
 * For each user whose next_run_at <= now() AND is_running = false,
 * it calls bulk-live-verify, measures runtime, and auto-adjusts
 * the next interval using a rolling average.
 *
 * Interval logic (based on rolling avg runtime):
 *   <= 60 min  → every 4 hours
 *   <= 180 min → every 8 hours
 *   > 180 min  → every 24 hours
 *
 * Overlap protection:
 *   - Sets is_running = true + run_started_at before starting
 *   - Skips users already marked is_running
 *   - Auto-releases stale locks older than 2 hours (timeout safety)
 */

const STALE_LOCK_MINUTES = 120; // 2 hours — if a run is stuck longer, force-release

function computeIntervalHours(avgRuntimeSeconds: number): number {
  const mins = avgRuntimeSeconds / 60;
  if (mins <= 60) return 4;
  if (mins <= 180) return 8;
  return 24;
}

/** Compute new rolling average incorporating latest runtime */
function updateRollingAverage(
  currentAvg: number | null,
  historyCount: number,
  newRuntime: number,
  maxSamples = 5
): { avg: number; count: number } {
  if (!currentAvg || historyCount === 0) {
    return { avg: newRuntime, count: 1 };
  }
  // Weighted rolling average capped at maxSamples
  const effectiveCount = Math.min(historyCount, maxSamples);
  const newAvg = Math.round(
    (currentAvg * effectiveCount + newRuntime) / (effectiveCount + 1)
  );
  return { avg: newAvg, count: historyCount + 1 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // ===== KILL SWITCH (user request) =====
  // Scheduled live-verify calls bulk-live-verify, which writes to the
  // inventory table (available/reserved/inbound/listing_status). Until we
  // add stronger safeguards and explicitly approve a narrow auto-refresh,
  // this scheduler is disabled so it cannot mutate inventory quantities.
  // Manual sync buttons in the UI remain fully functional.
  console.log('[scheduled-live-verify] DISABLED by user request — exiting without verifying.');
  return new Response(
    JSON.stringify({ success: true, disabled: true, message: 'Scheduled live verify is disabled.' }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Step 1: Release stale locks (stuck runs older than 2 hours)
    const staleCutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60000).toISOString();
    const { data: staleUsers } = await supabase
      .from('live_verify_schedule')
      .update({
        is_running: false,
        last_error: 'Force-released: exceeded 2h timeout',
      })
      .eq('is_running', true)
      .lt('run_started_at', staleCutoff)
      .select('user_id');

    if (staleUsers && staleUsers.length > 0) {
      console.log(`[SCHEDULED-VERIFY] Released ${staleUsers.length} stale locks`);
    }

    // Step 2: Find users due for verification (not already running)
    const { data: dueUsers, error: fetchErr } = await supabase
      .from('live_verify_schedule')
      .select('user_id, computed_interval_hours, avg_runtime_seconds, run_history_count, total_runs')
      .eq('is_enabled', true)
      .eq('is_running', false)
      .lte('next_run_at', new Date().toISOString())
      .order('next_run_at', { ascending: true })
      .limit(10);

    if (fetchErr) throw fetchErr;
    if (!dueUsers || dueUsers.length === 0) {
      console.log('[SCHEDULED-VERIFY] No users due for verification');
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[SCHEDULED-VERIFY] ${dueUsers.length} users due for verification`);

    const results: { user_id: string; status: string; runtime_s?: number; skus?: number; interval_h?: number }[] = [];

    for (const schedule of dueUsers) {
      // Step 3: Acquire lock (set is_running = true)
      const { error: lockErr } = await supabase
        .from('live_verify_schedule')
        .update({
          is_running: true,
          run_started_at: new Date().toISOString(),
        })
        .eq('user_id', schedule.user_id)
        .eq('is_running', false); // double-check not already locked

      if (lockErr) {
        console.warn(`[SCHEDULED-VERIFY] Failed to lock ${schedule.user_id}, skipping`);
        continue;
      }

      const startTime = Date.now();
      console.log(`[SCHEDULED-VERIFY] Starting for user ${schedule.user_id}`);

      try {
        // Step 4: Call bulk-live-verify
        const verifyResponse = await fetch(`${supabaseUrl}/functions/v1/bulk-live-verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
            'x-internal-secret': internalSecret,
          },
          body: JSON.stringify({
            user_id: schedule.user_id,
            dry_run: false,
            mode: 'full_catalog',
          }),
        });

        const runtimeSeconds = Math.round((Date.now() - startTime) / 1000);

        if (!verifyResponse.ok) {
          const errText = await verifyResponse.text();
          console.error(`[SCHEDULED-VERIFY] Failed for ${schedule.user_id}: ${errText}`);

          await supabase.from('live_verify_schedule').update({
            is_running: false,
            run_started_at: null,
            last_run_at: new Date().toISOString(),
            last_runtime_seconds: runtimeSeconds,
            last_error: errText.slice(0, 500),
            next_run_at: new Date(Date.now() + schedule.computed_interval_hours * 3600000).toISOString(),
          }).eq('user_id', schedule.user_id);

          results.push({ user_id: schedule.user_id, status: 'error', runtime_s: runtimeSeconds });
          continue;
        }

        const verifyData = await verifyResponse.json();
        const skuCount = verifyData?.summary?.total || 0;

        // Step 5: Update rolling average and compute new interval
        const { avg: newAvg, count: newCount } = updateRollingAverage(
          schedule.avg_runtime_seconds,
          schedule.run_history_count,
          runtimeSeconds
        );
        const newInterval = computeIntervalHours(newAvg);

        // Step 6: Release lock + update stats
        await supabase.from('live_verify_schedule').update({
          is_running: false,
          run_started_at: null,
          last_run_at: new Date().toISOString(),
          last_runtime_seconds: runtimeSeconds,
          avg_runtime_seconds: newAvg,
          run_history_count: newCount,
          active_sku_count: skuCount,
          computed_interval_hours: newInterval,
          next_run_at: new Date(Date.now() + newInterval * 3600000).toISOString(),
          last_error: null,
          total_runs: (schedule.total_runs || 0) + 1,
        }).eq('user_id', schedule.user_id);

        console.log(`[SCHEDULED-VERIFY] Done for ${schedule.user_id}: ${skuCount} SKUs in ${runtimeSeconds}s (avg ${newAvg}s) → next in ${newInterval}h`);
        results.push({ user_id: schedule.user_id, status: 'ok', runtime_s: runtimeSeconds, skus: skuCount, interval_h: newInterval });

      } catch (userErr: any) {
        const runtimeSeconds = Math.round((Date.now() - startTime) / 1000);
        console.error(`[SCHEDULED-VERIFY] Error for ${schedule.user_id}:`, userErr.message);

        // Release lock on error
        await supabase.from('live_verify_schedule').update({
          is_running: false,
          run_started_at: null,
          last_run_at: new Date().toISOString(),
          last_runtime_seconds: runtimeSeconds,
          last_error: userErr.message?.slice(0, 500),
          next_run_at: new Date(Date.now() + schedule.computed_interval_hours * 3600000).toISOString(),
        }).eq('user_id', schedule.user_id);

        results.push({ user_id: schedule.user_id, status: 'error', runtime_s: runtimeSeconds });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[SCHEDULED-VERIFY] Fatal error:', (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
