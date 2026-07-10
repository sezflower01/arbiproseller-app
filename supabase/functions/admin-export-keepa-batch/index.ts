import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isAdmin(email: string): boolean {
  const adminEmails = Deno.env.get('ADMIN_EMAILS')?.split(',').map(e => e.trim().toLowerCase()) || [];
  return adminEmails.includes(email.toLowerCase());
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization')!;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!isAdmin(user.email!)) {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);
    const batchId = url.searchParams.get('batch_id');
    const minScore = parseInt(url.searchParams.get('min_score') || '0');
    const minRoi = parseFloat(url.searchParams.get('min_roi') || '0');

    if (!batchId) {
      return new Response(JSON.stringify({ error: 'batch_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let query = supabase
      .from('keepa_items')
      .select('*')
      .eq('batch_id', batchId)
      .order('idx');

    if (minScore > 0) {
      query = query.gte('match_score', minScore);
    }

    if (minRoi > 0) {
      query = query.gte('roi', minRoi);
    }

    const { data: items, error: itemsError } = await query;

    if (itemsError) {
      return new Response(JSON.stringify({ error: itemsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate CSV
    const headers = [
      'idx', 'asin', 'title', 'g_store', 'g_title', 'g_price', 'g_link', 'g_image',
      'amz_asin', 'amz_title', 'amz_price', 'amz_link', 'amz_image',
      'title_score', 'image_score', 'match_score', 'roi', 'margin_pct', 'status'
    ];

    const escapeCSV = (val: any) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const csvRows = [headers.join(',')];
    
    for (const item of items || []) {
      const row = headers.map(h => escapeCSV(item[h]));
      csvRows.push(row.join(','));
    }

    const csv = csvRows.join('\n');

    return new Response(csv, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="keepa_batch_${batchId}.csv"`,
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? (error as Error).message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});