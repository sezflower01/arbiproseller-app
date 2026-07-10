// repricer-classify-strategy
// Hourly classifier: assigns each active assignment a commercial strategy state.
// States: profit_max | competitive_recovery | inventory_liquidation |
//         buybox_defense | velocity_boost | aged_pressure | clearance
//
// Safety: this function ONLY writes to public.repricer_strategy_states.
// It NEVER mutates prices, floors, or rules. The evaluator reads the
// resulting state and adjusts cooldown / floor relaxation accordingly.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

type State =
  | 'profit_max'
  | 'competitive_recovery'
  | 'inventory_liquidation'
  | 'buybox_defense'
  | 'velocity_boost'
  | 'aged_pressure'
  | 'clearance';

const BUSINESS_REASON: Record<State, string> = {
  profit_max:            'Healthy listing — maximizing profit',
  competitive_recovery:  'Falling behind competitors — recovering price',
  inventory_liquidation: 'Heavy stock — pushing for sales',
  buybox_defense:        'Defending the Buy Box',
  velocity_boost:        'Sales slowing — boosting visibility',
  aged_pressure:         'Stock aging — softening price',
  clearance:             'Clearance — must move stock',
};

interface Signals {
  available: number;
  reserved: number;
  inbound: number;
  daysSinceLastSale: number | null;
  ownsBuyBox: boolean;
  bbPrice: number | null;
  myPrice: number | null;
  daysOfStock: number | null;
}

function classify(s: Signals): { state: State; technical: string } {
  const onHand = s.available + s.reserved;
  const dsls = s.daysSinceLastSale ?? 9999;
  const dos = s.daysOfStock ?? null;

  // Clearance: very aged + heavy stock
  if (dsls >= 60 && onHand >= 5) {
    return { state: 'clearance', technical: `clearance: dsls=${dsls}, on_hand=${onHand}` };
  }
  // Aged pressure: 30-60 days no sale
  if (dsls >= 30) {
    return { state: 'aged_pressure', technical: `aged: dsls=${dsls}` };
  }
  // Inventory liquidation: very high days-of-stock OR very high stock
  if ((dos !== null && dos > 180) || onHand > 50) {
    return { state: 'inventory_liquidation', technical: `liquidation: dos=${dos}, on_hand=${onHand}` };
  }
  // Velocity boost: 14-30 days no sale with stock available
  if (dsls >= 14 && onHand > 0) {
    return { state: 'velocity_boost', technical: `velocity_boost: dsls=${dsls}` };
  }
  // Buy Box defense: own BB and competitive (someone close)
  if (s.ownsBuyBox && s.bbPrice && s.myPrice && Math.abs(s.bbPrice - s.myPrice) < 0.50) {
    return { state: 'buybox_defense', technical: `bb_defense: own=true, gap<$0.50` };
  }
  // Competitive recovery: not own BB and we're priced higher than BB
  if (!s.ownsBuyBox && s.bbPrice && s.myPrice && s.myPrice > s.bbPrice * 1.02) {
    return { state: 'competitive_recovery', technical: `recovery: my=${s.myPrice}, bb=${s.bbPrice}` };
  }
  return { state: 'profit_max', technical: 'healthy: default' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const targetUserId: string | null = body.user_id ?? null;
    const limit: number = Math.min(Math.max(body.limit ?? 5000, 1), 20000);

    const runCore = async () => {
      let q = supabase
        .from('repricer_assignments')
        .select('user_id, asin, marketplace, last_applied_price, last_buybox_price, last_buybox_status, last_evaluated_at')
        .eq('is_enabled', true)
        .limit(limit);
      if (targetUserId) q = q.eq('user_id', targetUserId);

      const { data: assignments, error: aErr } = await q;
      if (aErr) throw aErr;

      let upserts = 0;
      let errors = 0;

      for (const a of assignments ?? []) {
        try {
          const { data: snap } = await supabase
            .from('repricer_market_snapshots')
            .select('buybox_price, my_price')
            .eq('user_id', a.user_id)
            .eq('asin', a.asin)
            .eq('marketplace', a.marketplace)
            .order('fetched_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const { data: inv } = await supabase
            .from('inventory')
            .select('available, reserved, inbound, last_sale_at, monthly_sales')
            .eq('user_id', a.user_id)
            .eq('asin', a.asin)
            .maybeSingle();

          const available = Number(inv?.available ?? 0);
          const reserved = Number(inv?.reserved ?? 0);
          const inbound = Number(inv?.inbound ?? 0);
          const monthlySales = Number(inv?.monthly_sales ?? 0);
          const lastSaleAt = inv?.last_sale_at ? new Date(inv.last_sale_at) : null;
          const dsls = lastSaleAt
            ? Math.floor((Date.now() - lastSaleAt.getTime()) / (1000 * 60 * 60 * 24))
            : null;
          const dailySales = monthlySales / 30;
          const dos = dailySales > 0 ? Math.round((available + reserved) / dailySales) : null;

          const signals: Signals = {
            available,
            reserved,
            inbound,
            daysSinceLastSale: dsls,
            ownsBuyBox: a.last_buybox_status === 'winning',
            bbPrice: snap?.buybox_price ?? a.last_buybox_price ?? null,
            myPrice: snap?.my_price ?? a.last_applied_price ?? null,
            daysOfStock: dos,
          };

          const { state, technical } = classify(signals);

          const { error: upErr } = await supabase
            .from('repricer_strategy_states')
            .upsert(
              {
                user_id: a.user_id,
                asin: a.asin,
                marketplace_id: a.marketplace,
                state,
                reason_business: BUSINESS_REASON[state],
                reason_technical: technical,
                signals: signals as any,
                entered_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'user_id,asin,marketplace_id' },
            );
          if (upErr) {
            errors++;
            console.error('[classify] upsert err', a.asin, upErr.message);
          } else {
            upserts++;
          }
        } catch (e: any) {
          errors++;
          console.error('[classify] error for', a.asin, e?.message);
        }
      }
      return { upserts, errors, total: assignments?.length ?? 0 };
    };

    // Cron mode (no targetUserId) → wrap with lock + history
    if (!targetUserId) {
      const { withCronLock } = await import('../_shared/cron-lock.ts');
      const outcome = await withCronLock(supabase as any, 'repricer-classify-strategy-hourly', 1500, async () => {
        const r = await runCore();
        return { items_processed: r.upserts, detail: r };
      });
      return new Response(
        JSON.stringify({ success: outcome.status !== 'failed', ...outcome }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const r = await runCore();
    return new Response(
      JSON.stringify({ success: true, classified: r.upserts, errors: r.errors, total: r.total }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e: any) {
    console.error('[classify] fatal', e?.message);
    return new Response(JSON.stringify({ success: false, error: e?.message ?? 'failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
