import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * Sync Historical Settled Data — v3
 * 
 * mode=plan  → returns months needing sync (instant)
 * mode=execute → fires fetch-profit-loss in background via waitUntil,
 *                returns 202 immediately. Frontend polls checkpoints table.
 */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const userId = user.id;
  let months = 12, force = false, mode = 'plan', monthKey = '';
  try {
    const body = await req.json();
    months = Math.min(Math.max(1, body.months || 12), 24);
    force = body.force === true;
    mode = body.mode || 'plan';
    monthKey = body.month_key || '';
  } catch { /* defaults */ }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Build month keys
  const today = new Date();
  const monthKeys: { key: string; start: string; end: string; label: string }[] = [];
  for (let i = 1; i <= months; i++) {
    const ms = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const me = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
    const key = `${ms.getFullYear()}-${String(ms.getMonth() + 1).padStart(2, '0')}`;
    monthKeys.push({
      key,
      start: ms.toISOString().split('T')[0],
      end: me.toISOString().split('T')[0],
      label: ms.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    });
  }

  // Check existing checkpoints
  const { data: existingCheckpoints } = await supabase
    .from('historical_sync_checkpoints')
    .select('month_key, status')
    .eq('user_id', userId)
    .eq('sync_type', 'settled');

  const completedMonths = new Set(
    (existingCheckpoints || [])
      .filter(cp => cp.status === 'done' && !force)
      .map(cp => cp.month_key)
  );

  const monthsToProcess = monthKeys.filter(m => !completedMonths.has(m.key));

  // === PLAN MODE ===
  if (mode === 'plan') {
    console.log(`[sync-historical-settled] Plan: ${monthsToProcess.length} months to process`);
    return new Response(JSON.stringify({
      success: true,
      totalMonths: monthKeys.length,
      skippedAlreadyDone: monthKeys.length - monthsToProcess.length,
      monthsToProcess: monthsToProcess.map(m => ({ key: m.key, label: m.label, start: m.start, end: m.end })),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // === EXECUTE MODE ===
  if (mode === 'execute') {
    // Derive month info directly from monthKey (YYYY-MM) instead of searching the array
    // This allows syncing any month, including the current one
    let month: { key: string; start: string; end: string; label: string } | undefined;
    
    if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
      const [yearStr, monthStr] = monthKey.split('-');
      const y = parseInt(yearStr, 10);
      const m = parseInt(monthStr, 10) - 1; // 0-indexed
      const ms = new Date(y, m, 1);
      const me = new Date(y, m + 1, 0);
      month = {
        key: monthKey,
        start: ms.toISOString().split('T')[0],
        end: me.toISOString().split('T')[0],
        label: ms.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      };
    } else {
      month = monthKeys.find(mk => mk.key === monthKey);
    }

    if (!month) {
      return new Response(JSON.stringify({ error: `Invalid month key: ${monthKey}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[sync-historical-settled] Execute: ${month.label} (${month.start} to ${month.end})`);

    // Mark checkpoint as running immediately
    await supabase.from('historical_sync_checkpoints').upsert({
      user_id: userId,
      sync_type: 'settled',
      month_key: month.key,
      status: 'running',
      started_at: new Date().toISOString(),
      completed_at: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,sync_type,month_key' });

    // Fire background work via waitUntil — return 200 immediately
    const response = new Response(JSON.stringify({ 
      success: true, 
      month: month.key, 
      status: 'running',
      message: `Started syncing ${month.label}`,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

    (globalThis as any).EdgeRuntime?.waitUntil((async () => {
      try {
        const fetchResponse = await fetch(
          `${supabaseUrl}/functions/v1/fetch-profit-loss`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': authHeader,
            },
            body: JSON.stringify({
              startDate: `${month.start}T00:00:00.000Z`,
              endDate: `${month.end}T23:59:59.999Z`,
              forceRefresh: true,
            }),
          }
        );

        if (!fetchResponse.ok) {
          const errorText = await fetchResponse.text();
          console.error(`[sync-historical-settled] ❌ ${month.label} failed:`, errorText);
          await supabase.from('historical_sync_checkpoints').upsert({
            user_id: userId, sync_type: 'settled', month_key: month.key,
            status: 'error', error_message: errorText.substring(0, 500),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id,sync_type,month_key' });
          return;
        }

        const data = await fetchResponse.json();

        // Poll sub-progress if needed
        if (data.progressId) {
          const startWait = Date.now();
          while (Date.now() - startWait < 240_000) {
            await new Promise(r => setTimeout(r, 3000));
            const { data: pr } = await supabase
              .from('pl_sync_progress')
              .select('status')
              .eq('id', data.progressId)
              .maybeSingle();
            if (pr?.status && pr.status !== 'running' && pr.status !== 'continue') break;
          }
        }

        // WRITE VERIFICATION: Don't mark "done" unless FEC rows actually exist
        const { count: fecCount } = await supabase
          .from('financial_events_cache')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gte('event_date', month.start)
          .lte('event_date', month.end);

        if (!fecCount || fecCount === 0) {
          console.error(`[sync-historical-settled] ❌ ${month.label} — fetch-profit-loss returned ok but 0 FEC rows written. Marking as error.`);
          await supabase.from('historical_sync_checkpoints').upsert({
            user_id: userId, sync_type: 'settled', month_key: month.key,
            status: 'error', error_message: 'Sync completed but no financial data was written. This may indicate an API issue.',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id,sync_type,month_key' });
          return;
        }

        await supabase.from('historical_sync_checkpoints').upsert({
          user_id: userId, sync_type: 'settled', month_key: month.key,
          status: 'done', completed_at: new Date().toISOString(),
          error_message: null, updated_at: new Date().toISOString(),
          orders_processed: fecCount,
        }, { onConflict: 'user_id,sync_type,month_key' });

        console.log(`[sync-historical-settled] ✅ ${month.label} done (${fecCount} FEC rows verified)`);

        // STEP 2: Trigger Orders API backfill into sales_orders
        // FEC only populates financial_events_cache (settled data).
        // The Live Sales graph reads sales_orders by purchase date (order_date).
        // Without this step, purchase-date gaps remain even after FEC sync succeeds.
        try {
          console.log(`[sync-historical-settled] 📦 Triggering sales_orders backfill for ${month.start} → ${month.end}`);
          const ordersResponse = await fetch(
            `${supabaseUrl}/functions/v1/sync-sales-orders`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader,
              },
              body: JSON.stringify({
                startDate: month.start,
                endDate: month.end,
                include_orders: true,
              }),
            }
          );

          if (ordersResponse.ok) {
            console.log(`[sync-historical-settled] 📦 sales_orders backfill triggered for ${month.label}`);

            // POST-SYNC VALIDATION: Wait briefly then verify SO rows exist
            await new Promise(r => setTimeout(r, 5000));
            const { count: soCount } = await supabase
              .from('sales_orders')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', userId)
              .gte('order_date', month.start)
              .lte('order_date', month.end);

            const soVerified = (soCount ?? 0) > 0;

            if (!soVerified && fecCount && fecCount > 5) {
              // FEC has data but SO has nothing — flag as partial
              console.warn(`[sync-historical-settled] ⚠️ SO VALIDATION FAILED for ${month.label}: FEC=${fecCount}, SO=${soCount ?? 0}. Marking checkpoint as partial.`);
              await supabase.from('historical_sync_checkpoints').upsert({
                user_id: userId, sync_type: 'settled', month_key: month.key,
                status: 'partial',
                error_message: `FEC synced (${fecCount} rows) but sales_orders has 0 rows — graph source incomplete.`,
                updated_at: new Date().toISOString(),
                orders_processed: fecCount,
              }, { onConflict: 'user_id,sync_type,month_key' });

              // Log to parity system for auto-repair pickup
              await supabase.from('sync_parity_log').upsert({
                user_id: userId,
                check_date: month.start,
                marketplace: 'US',
                so_count: soCount ?? 0,
                fec_count: fecCount,
                gap_type: 'so_missing',
                repair_status: 'queued',
                repair_triggered_at: new Date().toISOString(),
              }, { onConflict: 'user_id,check_date,marketplace' });
            } else {
              console.log(`[sync-historical-settled] ✅ SO VALIDATION PASSED for ${month.label}: FEC=${fecCount}, SO=${soCount ?? 0}`);
            }
          } else {
            const errText = await ordersResponse.text();
            console.warn(`[sync-historical-settled] ⚠️ sales_orders backfill failed (non-blocking): ${errText.substring(0, 200)}`);
          }
        } catch (ordersErr: any) {
          console.warn(`[sync-historical-settled] ⚠️ sales_orders backfill error (non-blocking): ${ordersErr?.message}`);
        }

        // STEP 3: Reconcile fees/revenue/ROI directly from the FEC rows just
        // verified above — same data already fetched in this operation, no
        // separate reconciliation pass or extra SP-API call. The Orders-API
        // backfill in Step 2 only estimates fees (learned-history fallback);
        // this overwrites those estimates with the authoritative settled
        // referral/FBA/closing fees and sales amount for orders that have an
        // exact match in financial_events_cache.
        try {
          const { data: fecRowsForMonth, error: fecReconErr } = await supabase
            .from('financial_events_cache')
            .select('amazon_order_id, sales, referral_fees, fba_fees, fixed_closing_fees, variable_closing_fees')
            .eq('user_id', userId)
            .eq('event_type', 'shipment')
            .gte('event_date', month.start)
            .lte('event_date', month.end)
            .not('amazon_order_id', 'is', null)
            .neq('amazon_order_id', '');

          if (fecReconErr) {
            console.warn(`[sync-historical-settled] ⚠️ FEC_RECONCILE fetch error (non-blocking): ${fecReconErr.message}`);
          } else if (fecRowsForMonth && fecRowsForMonth.length > 0) {
            const fecByOrder = new Map<string, typeof fecRowsForMonth>();
            for (const row of fecRowsForMonth) {
              const key = String(row.amazon_order_id || '').trim();
              if (!key) continue;
              const list = fecByOrder.get(key) || [];
              list.push(row);
              fecByOrder.set(key, list);
            }

            let reconciledCount = 0;
            let reconcileFailed = 0;
            for (const [orderId, fecRows] of fecByOrder) {
              const salesUsd = fecRows.reduce((s, r) => s + Math.abs(Number(r.sales) || 0), 0);
              const referralUsd = fecRows.reduce((s, r) => s + Math.abs(Number(r.referral_fees) || 0), 0);
              const fbaUsd = fecRows.reduce((s, r) => s + Math.abs(Number(r.fba_fees) || 0), 0);
              const closingUsd = fecRows.reduce((s, r) => {
                const variable = Math.abs(Number(r.variable_closing_fees) || 0);
                const fixed = Math.abs(Number(r.fixed_closing_fees) || 0);
                return s + (variable > 0 ? variable : fixed);
              }, 0);
              const totalFeesUsd = referralUsd + fbaUsd + closingUsd;
              if (salesUsd <= 0) continue;

              const { data: soRows, error: soFetchErr } = await supabase
                .from('sales_orders')
                .select('id, quantity, unit_cost')
                .eq('user_id', userId)
                .eq('order_id', orderId)
                .not('order_id', 'like', '%-REFUND');

              if (soFetchErr || !soRows || soRows.length === 0) continue;

              const totalQty = soRows.reduce((s, r) => s + Math.max(1, Number(r.quantity || 0)), 0) || 1;

              for (const so of soRows) {
                const qty = Math.max(1, Number(so.quantity || 0));
                const share = soRows.length === 1 ? 1 : qty / totalQty;
                const orderSalesUsd = salesUsd * share;
                const orderTotalFees = totalFeesUsd * share;
                const orderReferralFee = referralUsd * share;
                const orderFbaFee = fbaUsd * share;
                const orderClosingFee = closingUsd * share;
                const soldPriceUsd = orderSalesUsd / qty;
                const unitCost = Number(so.unit_cost || 0);
                const totalCost = unitCost * qty;
                const roi = totalCost > 0
                  ? Math.round(((orderSalesUsd - orderTotalFees - totalCost) / totalCost) * 1000) / 10
                  : null;

                const { error: updateErr } = await supabase
                  .from('sales_orders')
                  .update({
                    sold_price: Number(soldPriceUsd.toFixed(2)),
                    item_price: Number(soldPriceUsd.toFixed(2)),
                    total_sale_amount: Number(orderSalesUsd.toFixed(2)),
                    referral_fee: Number(orderReferralFee.toFixed(2)),
                    fba_fee: Number(orderFbaFee.toFixed(2)),
                    closing_fee: Number(orderClosingFee.toFixed(2)),
                    total_fees: Number(orderTotalFees.toFixed(2)),
                    roi,
                    price_source: 'reconciled_fec',
                    fees_source: 'financial_events',
                    price_confidence: 'CONFIRMED',
                    status: 'settled',
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', so.id);

                if (updateErr) reconcileFailed++;
                else reconciledCount++;
              }
            }
            console.log(`[sync-historical-settled] 🔄 FEC_RECONCILE: ${month.label} — reconciled ${reconciledCount} sales_orders row(s) from ${fecByOrder.size} FEC order(s), ${reconcileFailed} failed`);
          }
        } catch (reconcileErr: any) {
          console.warn(`[sync-historical-settled] ⚠️ FEC_RECONCILE error (non-blocking): ${reconcileErr?.message}`);
        }
      } catch (err: any) {
        console.error(`[sync-historical-settled] ❌ ${month.label} error:`, (err as Error).message);
        await supabase.from('historical_sync_checkpoints').upsert({
          user_id: userId, sync_type: 'settled', month_key: month.key,
          status: 'error', error_message: (err as Error).message?.substring(0, 500),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,sync_type,month_key' });
      }
    })());

    return response;
  }

  return new Response(JSON.stringify({ error: 'Invalid mode' }), {
    status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
