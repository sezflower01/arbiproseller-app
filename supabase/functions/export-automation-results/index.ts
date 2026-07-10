import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);
    const run_id = url.searchParams.get('run_id');
    const min_score = parseInt(url.searchParams.get('min_score') || '0');
    const min_roi = parseFloat(url.searchParams.get('min_roi') || '0');

    if (!run_id) {
      return new Response(JSON.stringify({ error: 'run_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify user owns this run
    const { data: run } = await supabase
      .from('automation_runs')
      .select('user_id')
      .eq('id', run_id)
      .single();

    if (!run || run.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Run not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch results
    let query = supabase
      .from('automation_results')
      .select('*')
      .eq('run_id', run_id)
      .order('created_at');

    if (min_score > 0) {
      query = query.gte('match_score', min_score);
    }
    if (min_roi > 0) {
      query = query.gte('roi', min_roi);
    }

    const { data: results, error: resultsError } = await query;

    if (resultsError) {
      return new Response(JSON.stringify({ error: resultsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate CSV
    const headers = [
      'Input Title', 'Input ASIN', 'Retailer', 'Retailer Title', 'Retailer Price', 'Retailer Link',
      'Amazon ASIN', 'Amazon Title', 'Amazon Price', 'Amazon Link',
      'Title Score', 'Match Score', 'ROI %', 'Margin %', 'Status'
    ];

    const rows = results.map(r => [
      r.input_title || '',
      r.input_asin || '',
      r.g_store || '',
      r.g_title || '',
      r.g_price || '',
      r.g_link || '',
      r.amz_asin || '',
      r.amz_title || '',
      r.amz_price || '',
      r.amz_link || '',
      r.title_score || '',
      r.match_score || '',
      r.roi || '',
      r.margin_pct || '',
      r.status || ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    // Upload to storage
    const fileName = `automation-results-${run_id}-${Date.now()}.csv`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('installers')
      .upload(fileName, csvContent, {
        contentType: 'text/csv',
        upsert: false
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return new Response(JSON.stringify({ error: uploadError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get signed URL
    const { data: signedUrl } = await supabase.storage
      .from('installers')
      .createSignedUrl(fileName, 3600); // 1 hour

    return new Response(JSON.stringify({ 
      download_url: signedUrl?.signedUrl,
      filename: fileName,
      count: results.length
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Export error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? (error as Error).message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});