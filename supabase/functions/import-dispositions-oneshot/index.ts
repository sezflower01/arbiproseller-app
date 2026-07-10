import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const internalSecret = req.headers.get('x-internal-secret');
  if (internalSecret !== Deno.env.get('INTERNAL_SYNC_SECRET')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders });
  }

  const { user_id, rows, replace } = await req.json();
  if (!user_id || !Array.isArray(rows)) {
    return new Response(JSON.stringify({ error: 'bad input' }), { status: 400, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  if (replace) {
    const { error: delErr } = await supabase
      .from('inventory_dispositions')
      .delete()
      .eq('user_id', user_id);
    if (delErr) return new Response(JSON.stringify({ error: 'delete: ' + delErr.message }), { status: 500, headers: corsHeaders });
  }

  const records = rows.map((r: any) => ({ ...r, user_id, source: 'csv_import' }));
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const { error } = await supabase.from('inventory_dispositions').insert(chunk);
    if (error) return new Response(JSON.stringify({ error: error.message, inserted, at: i }), { status: 500, headers: corsHeaders });
    inserted += chunk.length;
  }

  return new Response(JSON.stringify({ ok: true, inserted }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
