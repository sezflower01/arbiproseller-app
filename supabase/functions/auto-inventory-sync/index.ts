import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";
import { requireInternalOrUser } from '../_shared/require-internal.ts';

/**
 * AUTO-INVENTORY-SYNC (hardened)
 *
 * Mirrors the manual "Live Inventory Sync" button but loops over EVERY user.
 * Designed to be GENTLE on SP-API and YIELD to the repricer.
 *
 * INBOUND OWNERSHIP:
 *   • Summaries API (this function via rescue-inventory-asin) → available, reserved, INBOUND (receiving+shipped; working excluded)
 *   • FBA Inventory Report (sync-inventory-report)            → secondary inbound writer / reconciliation
 *   priorInbound is only restored as a fallback when rescue does not return a valid inbound number.
 *
 * Hardening rules (all 7):
 *   1. Empty/partial/throttled responses → skip, never write zero.
 *   2. Exponential backoff on 429: 2s → 4s → 8s, then give up that ASIN.
 *   3. One ASIN at a time, 600ms inter-call delay, 2s pause every 5.
 *   4. Default max_per_user = 125, processing the stalest SKUs first so each cron advances.
 *   5. Yield to repricer: peek `repricer_change_log`; if hot, sleep 5s.
 *   6. Per-user advisory lock so runs cannot overlap for the same user.
 *   7. Rich result counts: updated / skipped_throttled / skipped_empty /
 *      skipped_recent_manual / skipped_tombstoned / errors.
 *
 * Auth: service-role bearer OR x-internal-secret header.
 * Body (optional): { user_id?: string, max_per_user?: number, dry_run?: boolean }
 *
 * NOT scheduled by default. Schedule via pg_cron only after dry-run + single-user test.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const INTER_CALL_DELAY_MS = 600;       // gentler than manual button (was 250ms)
const BATCH_SIZE = 5;
const BATCH_PAUSE_MS = 2000;
const DEFAULT_MAX_PER_USER = 400;      // rotate large accounts in ≤4 cron cycles (~16h) instead of ~42h
const RECENT_MANUAL_SKIP_MS = 30 * 60 * 1000; // 30 min
const REPRICER_HOT_WINDOW_MS = 60 * 1000;     // last 60s
const REPRICER_HOT_THRESHOLD = 10;            // >10 changes in 60s = hot
const REPRICER_YIELD_MS = 5000;               // pause 5s when hot
const BACKOFF_MS = [2000, 4000, 8000];        // 429 retry schedule

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchInventoryBySkuChunks(supabase: any, userId: string, skus: string[]): Promise<Map<string, any>> {
  const rows: any[] = [];
  for (let i = 0; i < skus.length; i += 400) {
    const chunk = skus.slice(i, i + 400);
    const { data, error } = await supabase
      .from('inventory')
      .select('sku, last_inventory_sync_at, last_summaries_at, listing_status, inbound, inbound_working, inbound_receiving, inbound_shipped, available, reserved')
      .eq('user_id', userId)
      .in('sku', chunk);
    if (error) throw new Error(`inventory query: ${error.message}`);
    rows.push(...(data || []));
  }
  return new Map(rows.map((r: any) => [r.sku, r]));
}

function inventoryFreshnessMs(row: any): number {
  const stamp = row?.last_summaries_at || row?.last_inventory_sync_at || null;
  const parsed = stamp ? Date.parse(stamp) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

// Stable hash of user_id → bigint for pg_advisory_lock
function hashUuidToBigint(uuid: string): string {
  let h = 0n;
  for (const ch of uuid) {
    h = (h * 131n + BigInt(ch.charCodeAt(0))) & 0x7fffffffffffffffn;
  }
  return h.toString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  const t0 = Date.now();
  let topStep = 'boot';
  let runId: string | null = null;
  let runLogClient: any = null;
  try {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

  // Auth
  const authHeader = req.headers.get('Authorization') || '';
  const reqSecret = req.headers.get('x-internal-secret') || '';
  const isServiceRole = authHeader.includes(serviceKey.slice(0, 20));
  const isInternal = internalSecret && reqSecret === internalSecret;
  if (!isServiceRole && !isInternal) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const targetUserId: string | undefined = body?.user_id;
  const maxPerUser: number = Math.min(2000, Math.max(1, body?.max_per_user || DEFAULT_MAX_PER_USER));
  const dryRun: boolean = !!body?.dry_run;

  topStep = 'create_client';
  const supabase = createClient(supabaseUrl, serviceKey);
  topStep = 'discover_users';

  // Discover users
  let userIds: string[] = [];
  if (targetUserId) {
    userIds = [targetUserId];
  } else {
    const { data: rows, error } = await supabase
      .from('repricer_assignments')
      .select('user_id')
      .eq('is_enabled', true)
      .limit(10000);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    userIds = Array.from(new Set((rows || []).map((r: any) => r.user_id))).filter(Boolean);
  }

  console.log(`[auto-inventory-sync] users=${userIds.length} maxPerUser=${maxPerUser} dryRun=${dryRun}`);

  // Insert run-log row so admins can see the cron is firing
  runLogClient = supabase;
  try {
    const { data: logRow } = await supabase
      .from('auto_inventory_sync_runs')
      .insert({
        triggered_by: body?.triggered_by || (targetUserId ? 'manual' : 'cron'),
        users_count: userIds.length,
      })
      .select('id')
      .single();
    runId = logRow?.id || null;
  } catch (e) {
    console.warn('[auto-inventory-sync] could not create run log row:', (e as Error)?.message);
  }

  const recentCutoffIso = new Date(Date.now() - RECENT_MANUAL_SKIP_MS).toISOString();
  const summary: any[] = [];

  for (const uid of userIds) {
    let currentStep = 'init';
    let currentAsin: string | null = null;
    let currentSku: string | null = null;
    let lockAcquired = false;

    try {
      // ── Real Postgres advisory lock (Option B) ────────────────────────
      currentStep = 'acquire_lock';
      // Table-based lock with TTL (connection-pool safe). TTL = 10 min;
      // even if this function crashes/times out, the lock auto-expires.
      const lockRes = await supabase.rpc('try_user_sync_lock', { uid, ttl_seconds: 600 });
      if (lockRes?.error) {
        console.error(`[auto-inventory-sync] lock RPC error user=${uid}:`, lockRes.error.message);
        summary.push({ user_id: uid, error: `lock RPC: ${lockRes.error.message}`, failed_step: currentStep });
        continue;
      }
      if (lockRes?.data !== true) {
        console.log(`[auto-inventory-sync] user=${uid} skipped — another run holds the lock`);
        summary.push({
          user_id: uid,
          processed: 0,
          updated: 0,
          skipped_throttled: 0,
          skipped_empty: 0,
          skipped_recent_manual: 0,
          skipped_tombstoned: 0,
          skipped_locked: 1,
          errors: 0,
        });
        continue;
      }
      lockAcquired = true;

      currentStep = 'fetch_assignments';
      const assignmentsRes = await supabase
        .from('repricer_assignments')
        .select('asin, sku')
        .eq('user_id', uid)
        .eq('is_enabled', true)
        .limit(10000);
      if (assignmentsRes?.error) throw new Error(`assignments query: ${assignmentsRes.error.message}`);
      const assignments = assignmentsRes?.data ?? [];

      const seen = new Set<string>();
      const items = assignments.filter((a: any) => {
        if (!a?.asin || !a?.sku) return false;
        const key = `${a.asin}::${a.sku}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (items.length === 0) {
        summary.push({ user_id: uid, processed: 0, updated: 0, skipped_throttled: 0, skipped_empty: 0, skipped_recent_manual: 0, skipped_tombstoned: 0, errors: 0 });
        continue;
      }

      currentStep = 'fetch_inventory';
      const skus = items.map((i: any) => i.sku);
      const invMap = await fetchInventoryBySkuChunks(supabase, uid, skus);

      let skippedRecentManual = 0;
      let skippedTombstoned = 0;

      const eligiblePool = items.filter((it: any) => {
        const row = invMap.get(it.sku);
        if (!row) return true;
        if (row.listing_status === 'NOT_IN_CATALOG' || row.listing_status === 'DELETED') {
          skippedTombstoned++;
          return false;
        }
        if (row.last_inventory_sync_at && row.last_inventory_sync_at > recentCutoffIso) {
          skippedRecentManual++;
          return false;
        }
        return true;
      });
      const eligible = eligiblePool
        .sort((a: any, b: any) => inventoryFreshnessMs(invMap.get(a.sku)) - inventoryFreshnessMs(invMap.get(b.sku)))
        .slice(0, maxPerUser);

      let updated = 0;
      let skippedThrottled = 0;
      let skippedEmpty = 0;
      let skippedSuspiciousZero = 0;
      let errors = 0;

      if (dryRun) {
        summary.push({
          user_id: uid, processed: 0, eligible: eligible.length, eligible_pool: eligiblePool.length, total_assignments: items.length,
          updated: 0, skipped_throttled: 0, skipped_empty: 0,
          skipped_suspicious_zero: 0,
          skipped_recent_manual: skippedRecentManual,
          skipped_tombstoned: skippedTombstoned,
          errors: 0, dry_run: true,
        });
        continue;
      }

      for (let i = 0; i < eligible.length; i++) {
        const it = eligible[i];
        currentAsin = it?.asin ?? null;
        currentSku = it?.sku ?? null;

        try {
          // ── Rule 5: yield to repricer when it's hot ─────────────────────
          currentStep = 'repricer_hot_check';
          const hotSince = new Date(Date.now() - REPRICER_HOT_WINDOW_MS).toISOString();
          const hotRes = await supabase
            .from('repricer_change_log')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', uid)
            .gte('created_at', hotSince);
          const recentChanges = hotRes?.count ?? 0;
          if (recentChanges > REPRICER_HOT_THRESHOLD) {
            await sleep(REPRICER_YIELD_MS);
          }

          const priorInbound = invMap.get(it.sku)?.inbound ?? null;
          const priorInboundWorking = invMap.get(it.sku)?.inbound_working ?? null;
          const priorInboundReceiving = invMap.get(it.sku)?.inbound_receiving ?? null;
          const priorInboundShipped = invMap.get(it.sku)?.inbound_shipped ?? null;

          // ── Rules 1 + 2: call with retry/backoff, classify response ─────
          currentStep = 'rescue_call';
          let outcome: 'updated' | 'throttled' | 'empty' | 'error' = 'error';
          let liveStock: any = null;
          let lastResponseShape: any = null;

          for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
            try {
              const res = await fetch(`${supabaseUrl}/functions/v1/rescue-inventory-asin`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${serviceKey}`,
                  'x-internal-secret': internalSecret,
                  'x-target-user-id': uid,
                },
                body: JSON.stringify({ asin: it.asin, sku: it.sku, user_id: uid }),
              });

              if (!res || typeof res.status !== 'number') {
                console.warn(`[auto-inventory-sync] ${uid} ${it?.asin}/${it?.sku} loop=${i} step=${currentStep} attempt=${attempt} undefined response`);
                outcome = 'error';
                break;
              }

              if (res.status === 429 || res.status === 503) {
                if (attempt < BACKOFF_MS.length) {
                  await sleep(BACKOFF_MS[attempt]);
                  continue;
                }
                outcome = 'throttled';
                break;
              }

              if (!res.ok) {
                const errText = await res.text().catch(() => '');
                console.warn(`[auto-inventory-sync] ${uid} ${it?.asin}/${it?.sku} loop=${i} rescue HTTP ${res.status}: ${errText.slice(0, 200)}`);
                outcome = 'error';
                break;
              }

              const j = await res.json().catch((parseErr) => {
                console.warn(`[auto-inventory-sync] ${uid} ${it?.asin}/${it?.sku} loop=${i} json parse failed: ${(parseErr as Error)?.message}`);
                return {} as any;
              });
              lastResponseShape = j ? Object.keys(j) : null;
              liveStock = j?.live_stock ?? null;

              if (!liveStock || (liveStock.available == null && liveStock.reserved == null)) {
                console.log(`[auto-inventory-sync] ${uid} ${it?.asin}/${it?.sku} loop=${i} empty live_stock; response keys=${JSON.stringify(lastResponseShape)}`);
                outcome = 'empty';
                break;
              }
              outcome = 'updated';
              break;
            } catch (e) {
              if (attempt < BACKOFF_MS.length) {
                await sleep(BACKOFF_MS[attempt]);
                continue;
              }
              console.warn(`[auto-inventory-sync] ${uid} ${it?.asin}/${it?.sku} loop=${i} step=${currentStep} fetch failed: ${(e as Error)?.message}`);
              outcome = 'error';
              break;
            }
          }

          if (outcome === 'updated') {
            // ── Option B: suspicious-zero guard ─────────────────────────────
            // If the existing DB row had positive stock and the new live
            // response is 0/0, treat as a transient Amazon zero (FC transfer,
            // reallocation, etc.) and REVERT the write. Auto-sync only.
            const priorRow = invMap.get(it.sku) || {};
            const priorAvail = Number(priorRow.available ?? 0) || 0;
            const priorRes = Number(priorRow.reserved ?? 0) || 0;
            const newAvail = Number(liveStock?.available ?? 0) || 0;
            const newRes = Number(liveStock?.reserved ?? 0) || 0;
            const priorTotal = priorAvail + priorRes;
            const newTotal = newAvail + newRes;

            if (priorTotal > 0 && newTotal === 0) {
              // Revert: rescue-inventory-asin already wrote 0/0. Restore prior
              // available/reserved AND prior inbound. Do NOT bump
              // last_inventory_sync_at so the next eligible window will retry.
              skippedSuspiciousZero++;
              currentStep = 'revert_suspicious_zero';
              HealthSignals.inventoryStale(uid, 'auto-inventory-sync', it.asin, it.sku);
              const revert = await supabase
                .from('inventory')
                .update({
                  available: priorAvail,
                  reserved: priorRes,
                  inbound: priorInbound ?? 0,
                  inbound_working: priorInboundWorking ?? 0,
                  inbound_receiving: priorInboundReceiving ?? 0,
                  inbound_shipped: priorInboundShipped ?? 0,
                })
                .eq('user_id', uid)
                .eq('sku', it.sku);
              if (revert?.error) {
                console.warn(`[auto-inventory-sync] ${uid} ${it.asin}/${it.sku} revert error:`, revert.error.message);
              }
              console.log(`[auto-inventory-sync][TRACE] ${uid} asin=${it.asin} sku=${it.sku} SUSPICIOUS_ZERO prior=${priorAvail}/${priorRes}/in=${priorInbound ?? 'n'} new=0/0 reverted`);
            } else {
              updated++;
              // Inbound is now OWNED by Summaries via rescue-inventory-asin
              // (receiving + shipped; working excluded). Only fall back to
              // priorInbound if rescue did NOT return a valid inbound number,
              // so we never zero out a real inbound plan with a missing field.
              const liveInbound = liveStock?.inbound;
              const liveInboundValid = liveInbound !== null && liveInbound !== undefined && !Number.isNaN(Number(liveInbound));
              const liveWorking = Number(liveStock?.inbound_working ?? 0) || 0;
              const liveReceiving = Number(liveStock?.inbound_receiving ?? 0) || 0;
              const liveShipped = Number(liveStock?.inbound_shipped ?? 0) || 0;
              let fallbackTriggered = false;
              if (!liveInboundValid && priorInbound !== null && priorInbound !== undefined) {
                fallbackTriggered = true;
                currentStep = 'restore_inbound_fallback';
                const upd = await supabase
                  .from('inventory')
                  .update({ inbound: priorInbound })
                  .eq('user_id', uid)
                  .eq('sku', it.sku);
                if (upd?.error) {
                  console.warn(`[auto-inventory-sync] ${uid} ${it.asin}/${it.sku} inbound fallback error:`, upd.error.message);
                }
              }
              // Per-item debug trace (asin, sku, breakdown, prior, fallback)
              console.log(`[auto-inventory-sync][TRACE] ${uid} asin=${it.asin} sku=${it.sku} ` +
                `prior(a=${priorAvail}/r=${priorRes}/in=${priorInbound ?? 'n'}/w=${priorInboundWorking ?? 'n'}/recv=${priorInboundReceiving ?? 'n'}/ship=${priorInboundShipped ?? 'n'}) ` +
                `live(a=${newAvail}/r=${newRes}/in=${liveInbound ?? 'n'}/w=${liveWorking}/recv=${liveReceiving}/ship=${liveShipped}) ` +
                `fallback=${fallbackTriggered} suspicious_zero=false write=ok`);
            }
          } else if (outcome === 'throttled') {
            skippedThrottled++;
            console.log(`[auto-inventory-sync] ${uid} ${it.asin} throttled — skipped`);
          } else if (outcome === 'empty') {
            skippedEmpty++;
            console.log(`[auto-inventory-sync] ${uid} ${it.asin} empty response — skipped (no write)`);
          } else {
            errors++;
          }
        } catch (perItemErr) {
          errors++;
          console.error(`[auto-inventory-sync] per-item crash user=${uid} asin=${currentAsin} sku=${currentSku} step=${currentStep}:`, (perItemErr as Error)?.message, (perItemErr as Error)?.stack);
        }

        // ── Rule 3: pacing ──────────────────────────────────────────────
        await sleep(INTER_CALL_DELAY_MS);
        if ((i + 1) % BATCH_SIZE === 0 && i + 1 < eligible.length) {
          await sleep(BATCH_PAUSE_MS);
        }
      }

      console.log(`[auto-inventory-sync] user=${uid} processed=${eligible.length} updated=${updated} throttled=${skippedThrottled} empty=${skippedEmpty} suspicious_zero=${skippedSuspiciousZero} recent=${skippedRecentManual} tomb=${skippedTombstoned} errors=${errors}`);
      summary.push({
        user_id: uid,
        processed: eligible.length,
        eligible_pool: eligiblePool.length,
        total_assignments: items.length,
        updated,
        skipped_throttled: skippedThrottled,
        skipped_empty: skippedEmpty,
        skipped_suspicious_zero: skippedSuspiciousZero,
        skipped_recent_manual: skippedRecentManual,
        skipped_tombstoned: skippedTombstoned,
        errors,
      });
    } catch (userErr) {
      const msg = (userErr as Error)?.message || String(userErr);
      const stack = (userErr as Error)?.stack || null;
      console.error(`[auto-inventory-sync] user=${uid} crashed at step=${currentStep} asin=${currentAsin} sku=${currentSku}: ${msg}`, stack);
      summary.push({
        user_id: uid,
        error: msg,
        failed_step: currentStep,
        failed_asin: currentAsin,
        failed_sku: currentSku,
      });
    } finally {
      // Always release the per-user lock if we acquired it, even on error.
      if (lockAcquired) {
        try {
          const rel = await supabase.rpc('release_user_sync_lock', { uid });
          if (rel?.error) {
            console.warn(`[auto-inventory-sync] release_user_sync_lock error user=${uid}:`, rel.error.message);
          }
        } catch (relErr) {
          console.warn(`[auto-inventory-sync] release_user_sync_lock threw user=${uid}:`, (relErr as Error)?.message);
        }
      }
    }
  }

  const totals = (summary as any[]).reduce((acc, s) => ({
    attempted: acc.attempted + (s.processed || 0) + (s.errors || 0) + (s.skipped_throttled || 0) + (s.skipped_empty || 0) + (s.skipped_recent_manual || 0) + (s.skipped_tombstoned || 0) + (s.skipped_suspicious_zero || 0),
    updated: acc.updated + (s.updated || 0),
    skipped: acc.skipped + (s.skipped_throttled || 0) + (s.skipped_empty || 0) + (s.skipped_recent_manual || 0) + (s.skipped_tombstoned || 0) + (s.skipped_suspicious_zero || 0),
    errors: acc.errors + (s.errors || 0),
  }), { attempted: 0, updated: 0, skipped: 0, errors: 0 });

  const elapsed_ms = Date.now() - t0;

  if (runId && runLogClient) {
    try {
      await runLogClient.from('auto_inventory_sync_runs').update({
        completed_at: new Date().toISOString(),
        attempted: totals.attempted,
        updated: totals.updated,
        skipped: totals.skipped,
        errors: totals.errors,
        elapsed_ms,
        ok: true,
        summary: summary as any,
      }).eq('id', runId);
    } catch (e) {
      console.warn('[auto-inventory-sync] could not finalize run log:', (e as Error)?.message);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    users: userIds.length,
    elapsed_ms,
    fields_written: ['available', 'reserved', 'inbound', 'last_summaries_at', 'last_inventory_sync_at'],
    fields_preserved: ['unfulfilled'],
    hardening: {
      one_at_a_time: true,
      inter_call_delay_ms: INTER_CALL_DELAY_MS,
      batch_pause_ms: BATCH_PAUSE_MS,
      max_per_user: maxPerUser,
      backoff_ms: BACKOFF_MS,
      repricer_yield: { hot_threshold: REPRICER_HOT_THRESHOLD, window_ms: REPRICER_HOT_WINDOW_MS, sleep_ms: REPRICER_YIELD_MS },
      per_user_lock: true,
      suspicious_zero_guard: true,
    },
    summary,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (topErr) {
    const msg = (topErr as Error)?.message || String(topErr);
    const stack = (topErr as Error)?.stack || null;
    console.error(`[auto-inventory-sync] TOP-LEVEL crash step=${topStep} elapsed_ms=${Date.now() - t0}: ${msg}`, stack);
    if (runId && runLogClient) {
      try {
        await runLogClient.from('auto_inventory_sync_runs').update({
          completed_at: new Date().toISOString(),
          ok: false,
          error_message: `step=${topStep}: ${msg}`,
          elapsed_ms: Date.now() - t0,
        }).eq('id', runId);
      } catch { /* noop */ }
    }
    return new Response(JSON.stringify({
      ok: false,
      error: msg,
      failed_step: topStep,
      elapsed_ms: Date.now() - t0,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
