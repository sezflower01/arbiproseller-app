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
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const authHeader = req.headers.get('Authorization')!;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabaseClient.auth.getUser(token);

    if (!user?.email) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const adminEmails = (Deno.env.get('ADMIN_EMAILS') || '').split(',').map(e => e.trim());
    if (!adminEmails.includes(user.email)) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    
    if (lines.length === 0) {
      return new Response(JSON.stringify({ error: 'Empty file' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Skip header if it exists (case-insensitive "asin")
    let startIdx = 0;
    if (lines[0].toLowerCase().includes('asin')) {
      startIdx = 1;
    }

    const asins = lines.slice(startIdx).filter(line => {
      // Basic ASIN validation: 10 characters alphanumeric
      const asin = line.trim();
      return asin.length === 10 && /^[A-Z0-9]{10}$/i.test(asin);
    });

    if (asins.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid ASINs found' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create batch
    const { data: batch, error: batchError } = await supabaseClient
      .from('asin_batches')
      .insert({
        user_id: user.id,
        filename: file.name,
        total: asins.length,
        status: 'queued',
      })
      .select()
      .single();

    if (batchError) throw batchError;

    // Insert items
    const items = asins.map((asin, idx) => ({
      batch_id: batch.id,
      idx: idx + 1,
      asin: asin.toUpperCase(),
      status: 'queued',
    }));

    const { error: itemsError } = await supabaseClient
      .from('asin_items')
      .insert(items);

    if (itemsError) throw itemsError;

    return new Response(
      JSON.stringify({ batch_id: batch.id, total_rows: asins.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Upload error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
