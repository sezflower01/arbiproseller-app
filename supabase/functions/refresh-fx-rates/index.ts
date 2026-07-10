import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CURRENCIES = ['CAD', 'MXN', 'BRL'];

async function fetchExchangeRates(): Promise<Record<string, number>> {
  // Using exchangerate-api.com free tier (or similar)
  // Fallback to frankfurter.app which is free and reliable
  const rates: Record<string, number> = { USD: 1 };

  try {
    // Try Frankfurter API first (free, no API key needed)
    const response = await fetch(
      `https://api.frankfurter.app/latest?from=USD&to=${CURRENCIES.join(',')}`
    );

    if (!response.ok) {
      throw new Error(`Frankfurter API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('Frankfurter API response:', data);

    for (const currency of CURRENCIES) {
      if (data.rates && data.rates[currency]) {
        rates[currency] = data.rates[currency];
      }
    }

    return rates;
  } catch (error) {
    console.error('Frankfurter API failed, trying backup:', error);

    // Backup: Use exchangerate.host (also free)
    try {
      const backupResponse = await fetch(
        `https://api.exchangerate.host/latest?base=USD&symbols=${CURRENCIES.join(',')}`
      );

      if (!backupResponse.ok) {
        throw new Error(`Backup API error: ${backupResponse.status}`);
      }

      const backupData = await backupResponse.json();
      console.log('Backup API response:', backupData);

      for (const currency of CURRENCIES) {
        if (backupData.rates && backupData.rates[currency]) {
          rates[currency] = backupData.rates[currency];
        }
      }

      return rates;
    } catch (backupError) {
      console.error('Backup API also failed:', backupError);
      throw new Error('All FX API sources failed');
    }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log('Starting FX rate refresh...');

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    let rates: Record<string, number>;
    let source = 'frankfurter.app';

    try {
      rates = await fetchExchangeRates();
      console.log('Fetched rates:', rates);
    } catch (error) {
      console.error('Failed to fetch rates, keeping existing:', error);
      
      // Return existing rates without updating
      const { data: existingRates } = await supabase
        .from('fx_rates')
        .select('*')
        .eq('base', 'USD');

      return new Response(JSON.stringify({ 
        success: false, 
        message: 'API failed, kept existing rates',
        rates: existingRates 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update rates in database
    const now = new Date().toISOString();
    const updates = [];

    // Always include USD = 1
    updates.push({
      base: 'USD',
      quote: 'USD',
      rate: 1,
      as_of: now,
      source: 'static',
    });

    for (const currency of CURRENCIES) {
      if (rates[currency]) {
        updates.push({
          base: 'USD',
          quote: currency,
          rate: rates[currency],
          as_of: now,
          source,
        });
      }
    }

    console.log('Upserting rates:', updates);

    const { data, error } = await supabase
      .from('fx_rates')
      .upsert(updates, { onConflict: 'base,quote' })
      .select();

    if (error) throw error;

    console.log('FX rates updated successfully:', data);

    return new Response(JSON.stringify({ 
      success: true, 
      rates: data,
      updatedAt: now 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error refreshing FX rates:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: (error as Error).message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
