import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Nightly Parity Check — v2
 *
 * Compares sales_orders vs financial_events_cache for all active users.
 * Detects gaps and auto-triggers targeted repair for missing purchase-date data.
 *
 * Auth: accepts INTERNAL_SYNC_SECRET header (for cron/service calls) OR admin JWT.
 * The cron job uses vault.decrypted_secrets to inject the internal secret — 
 * NO plaintext tokens are embedded in the cron SQL.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Auth: accept internal secret OR admin JWT
  const internalHeader = req.headers.get('x-internal-secret');
  const authHeader = req.headers.get('Authorization');

  let isAuthorized = false;
  if (internalSecret && internalHeader === internalSecret) {
    isAuthorized = true;
  } else if (authHeader) {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (user) {
      const { data: hasAdmin } = await supabase.rpc('has_role', { _user_id: user.id, _role: 'admin' });
      isAuthorized = !!hasAdmin;
    }
  }

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let daysBack = 30;
  let autoRepair = true;
  try {
    const body = await req.json();
    daysBack = body.days_back || 30;
    autoRepair = body.auto_repair !== false;
  } catch { /* defaults */ }

  console.log(`[nightly-parity] Starting parity check for last ${daysBack} days, autoRepair=${autoRepair}`);

  // Get all active users (users with recent sales activity)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  const cutoff = cutoffDate.toISOString().split('T')[0];

  const { data: activeUsers } = await supabase
    .from('financial_events_cache')
    .select('user_id')
    .gte('event_date', cutoff)
    .limit(1000);

  const uniqueUserIds = [...new Set((activeUsers || []).map(u => u.user_id))];
  console.log(`[nightly-parity] Found ${uniqueUserIds.length} active users`);

  const summary = {
    users_checked: uniqueUserIds.length,
    total_gaps_found: 0,
    repairs_triggered: 0,
    gap_details: [] as Array<{ user_id: string; date: string; marketplace: string; gap_type: string; so_count: number; fec_count: number }>,
  };

  for (const userId of uniqueUserIds) {
    try {
      // Run the parity check function
      const { data: gaps, error } = await supabase.rpc('check_sync_parity', {
        p_user_id: userId,
        p_days: daysBack,
      });

      if (error) {
        console.warn(`[nightly-parity] Error checking user ${userId}: ${(error as Error).message}`);
        continue;
      }

      if (!gaps || gaps.length === 0) continue;

      console.log(`[nightly-parity] User ${userId}: ${gaps.length} gap(s) found`);
      summary.total_gaps_found += gaps.length;

      // Log gaps to sync_parity_log
      for (const gap of gaps) {
        summary.gap_details.push({
          user_id: userId,
          date: gap.check_date,
          marketplace: gap.marketplace,
          gap_type: gap.gap_type,
          so_count: Number(gap.so_count),
          fec_count: Number(gap.fec_count),
        });

        await supabase.from('sync_parity_log').upsert({
          user_id: userId,
          check_date: gap.check_date,
          marketplace: gap.marketplace,
          so_count: Number(gap.so_count),
          fec_count: Number(gap.fec_count),
          gap_type: gap.gap_type,
          repair_status: autoRepair ? 'queued' : 'pending',
          repair_triggered_at: autoRepair ? new Date().toISOString() : null,
        }, { onConflict: 'user_id,check_date,marketplace' });
      }

      // Auto-repair: trigger sync-sales-orders using service-role + internal secret
      if (autoRepair) {
        const soMissingGaps = gaps.filter((g: any) => g.gap_type === 'so_missing');
        if (soMissingGaps.length > 0) {
          const dates = soMissingGaps.map((g: any) => g.check_date).sort();
          const startDate = dates[0];
          const endDate = dates[dates.length - 1];

          console.log(`[nightly-parity] 🔧 Auto-repairing SO gaps for user ${userId}: ${startDate} → ${endDate}`);

          try {
            // Use service-role key + internal secret for server-to-server auth
            // No user JWT needed — the target function accepts internal secret auth
            const repairResponse = await fetch(
              `${supabaseUrl}/functions/v1/sync-sales-orders`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${serviceKey}`,
                  'x-internal-secret': internalSecret || '',
                  'x-repair-user-id': userId,
                },
                body: JSON.stringify({
                  startDate,
                  endDate,
                  include_orders: true,
                  user_id: userId,
                  internal_secret: internalSecret,
                }),
              }
            );

            if (repairResponse.ok) {
              summary.repairs_triggered++;
              console.log(`[nightly-parity] ✅ Repair triggered for user ${userId}`);

              // Post-repair validation: verify rows were actually written
              const { count: soCountAfter } = await supabase
                .from('sales_orders')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('order_date', startDate)
                .lte('order_date', endDate);

              const repairVerified = (soCountAfter ?? 0) > 0;
              const finalStatus = repairVerified ? 'repaired' : 'repair_unverified';

              console.log(`[nightly-parity] ${repairVerified ? '✅' : '⚠️'} Post-repair validation for user ${userId}: ${soCountAfter ?? 0} SO rows (status: ${finalStatus})`);

              for (const gap of soMissingGaps) {
                await supabase.from('sync_parity_log')
                  .update({
                    repair_status: finalStatus,
                    repaired_at: new Date().toISOString(),
                    validation_so_count: soCountAfter ?? 0,
                  })
                  .eq('user_id', userId)
                  .eq('check_date', gap.check_date)
                  .eq('marketplace', gap.marketplace);
              }
            } else {
              const errText = await repairResponse.text();
              console.warn(`[nightly-parity] ⚠️ Repair failed for user ${userId}: ${errText.substring(0, 200)}`);
            }
          } catch (repairErr: any) {
            console.warn(`[nightly-parity] ⚠️ Repair error for user ${userId}: ${repairErr?.message}`);
          }
        }
      }
    } catch (userErr: any) {
      console.error(`[nightly-parity] Error processing user ${userId}: ${userErr?.message}`);
    }
  }

  console.log(`[nightly-parity] ✅ Complete: ${summary.users_checked} users, ${summary.total_gaps_found} gaps, ${summary.repairs_triggered} repairs`);

  return new Response(JSON.stringify({
    success: true,
    ...summary,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});