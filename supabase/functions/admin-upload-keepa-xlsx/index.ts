import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

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

    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { raw: false });

    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: 'No data found in Excel file' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create batch
    const { data: batch, error: batchError } = await supabase
      .from('keepa_batches')
      .insert({
        user_id: user.id,
        filename: file.name,
        total_rows: rows.length,
        status: 'queued',
      })
      .select()
      .single();

    if (batchError) {
      console.error('Batch creation error:', batchError);
      return new Response(JSON.stringify({ error: batchError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse and insert items
    const items = rows.map((row: any, idx: number) => {
      const asin = row.ASIN || row.asin || row.Asin || '';
      const title = row.Title || row.title || row.TITLE || '';
      
      return {
        batch_id: batch.id,
        idx: idx + 1,
        asin: asin.trim(),
        title: title.trim(),
        status: 'queued',
      };
    }).filter(item => item.asin || item.title);

    const { error: itemsError } = await supabase
      .from('keepa_items')
      .insert(items);

    if (itemsError) {
      console.error('Items insertion error:', itemsError);
      await supabase.from('keepa_batches').delete().eq('id', batch.id);
      return new Response(JSON.stringify({ error: itemsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      batch_id: batch.id,
      total_rows: items.length,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Upload error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? (error as Error).message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});