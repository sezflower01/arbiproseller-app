import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { quote } = await req.json();

    if (!quote) {
      // Return all rates
      const { data, error } = await supabase
        .from('fx_rates')
        .select('*')
        .eq('base', 'USD');

      if (error) throw error;

      return new Response(JSON.stringify({ rates: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Return specific rate
    const { data, error } = await supabase
      .from('fx_rates')
      .select('*')
      .eq('base', 'USD')
      .eq('quote', quote)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return new Response(JSON.stringify({ 
        error: 'Rate not found',
        rate: null 
      }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ rate: data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error fetching FX rates:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
