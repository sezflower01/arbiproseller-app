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

    const url = new URL(req.url);
    const batch_id = url.searchParams.get('batch_id');
    const min_score = parseInt(url.searchParams.get('min_score') || '0');
    const min_roi = parseInt(url.searchParams.get('min_roi') || '0');

    if (!batch_id) {
      return new Response(JSON.stringify({ error: 'batch_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let query = supabaseClient
      .from('asin_items')
      .select('*')
      .eq('batch_id', batch_id)
      .order('idx');

    if (min_score > 0) {
      query = query.gte('match_score', min_score);
    }

    if (min_roi > 0) {
      query = query.gte('roi', min_roi);
    }

    const { data: items, error } = await query;

    if (error) throw error;

    // CSV headers
    const headers = [
      'idx', 'asin', 'amz_title', 'amz_price', 'amz_link', 'amz_image',
      'g_store', 'g_title', 'g_price', 'g_link', 'g_image', 'source',
      'title_score', 'image_score', 'match_score', 'roi', 'margin_pct'
    ];

    let csv = headers.join(',') + '\n';

    for (const item of items || []) {
      const row = [
        item.idx,
        item.asin || '',
        `"${(item.amz_title || '').replace(/"/g, '""')}"`,
        item.amz_price || '',
        item.amz_link || '',
        item.amz_image || '',
        item.g_store || '',
        `"${(item.g_title || '').replace(/"/g, '""')}"`,
        item.g_price || '',
        item.g_link || '',
        item.g_image || '',
        item.source || '',
        item.title_score || '',
        item.image_score || '',
        item.match_score || '',
        item.roi || '',
        item.margin_pct || '',
      ];
      csv += row.join(',') + '\n';
    }

    return new Response(csv, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="asin_batch_${batch_id}.csv"`,
      },
    });
  } catch (error: any) {
    console.error('Export error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? (error as Error).message : String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
