// reconcile-settlement
// Returns per-month, per-category comparison: FinancialEvents total vs Settlement total vs Difference.
// Read-only audit endpoint.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const year = body.year || new Date().getFullYear();

    const { data, error } = await supabase
      .from('v_pl_reconciliation')
      .select('*')
      .eq('user_id', user.id)
      .eq('period_year', year)
      .order('period_month', { ascending: true })
      .order('category', { ascending: true });

    if (error) throw new Error(error.message);

    // Also pull settlement_reports summary
    const { data: reports } = await supabase
      .from('settlement_reports')
      .select('amazon_report_id, settlement_id, settlement_start_date, settlement_end_date, deposit_date, total_amount, currency, status, rows_parsed, error_message, parsed_at')
      .eq('user_id', user.id)
      .gte('settlement_end_date', `${year}-01-01`)
      .lt('settlement_end_date', `${year + 1}-01-01`)
      .order('settlement_end_date', { ascending: false });

    return new Response(JSON.stringify({
      ok: true,
      year,
      reconciliation: data || [],
      reports: reports || [],
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('reconcile-settlement fatal:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
