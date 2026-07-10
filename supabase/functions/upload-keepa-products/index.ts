import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

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

    const authHeader = req.headers.get('Authorization')!;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
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
    
    // Detect CSV vs XLSX
    let rows: any[];
    const fileName = file.name.toLowerCase();
    if (fileName.endsWith('.csv')) {
      const text = new TextDecoder().decode(arrayBuffer);
      const workbook = XLSX.read(text, { type: 'string' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(firstSheet, { raw: false });
    } else {
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(firstSheet, { raw: false });
    }

    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: 'No data found in file' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Processing ${rows.length} rows. Sample keys:`, Object.keys(rows[0]));

    let inserted = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process in batches of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const records = batch.map((row: any, idx: number) => {
        // Flexible column mapping for Keepa exports
        const asin = (row['ASIN'] || row['asin'] || row['Asin'] || '').toString().trim();
        if (!asin) return null;

        const title = (row['Title'] || row['title'] || '').toString().trim();
        const brand = (row['Brand'] || row['brand'] || '').toString().trim();
        const category = (
          row['Categories: Root'] || row['categories: root'] ||
          row['Category'] || row['category'] || ''
        ).toString().trim();
        
        // Image: Keepa exports an "Image" column with a URL
        const image = (
          row['Image'] || row['image'] || row['ImageLink'] ||
          row['image_url'] || row['Locale Image'] || ''
        ).toString().trim();

        // Competitor counts (optional — Keepa columns vary)
        const parseInt0 = (v: any): number | null => {
          if (v === null || v === undefined || v === '') return null;
          const s = String(v).replace(/[^\d-]/g, '');
          if (!s) return null;
          const n = parseInt(s, 10);
          return Number.isFinite(n) && n >= 0 ? n : null;
        };

        const newOfferCount = parseInt0(
          row['New Offer Count: Current'] ?? row['New Offer Count'] ??
          row['new_offer_count'] ?? row['Count of retrieved live offers: New'] ??
          row['Offer Count: New']
        );
        const fbaOfferCount = parseInt0(
          row['New FBA Offer Count: Current'] ?? row['New FBA Offer Count'] ??
          row['fba_offer_count'] ?? row['Count of retrieved live offers: New, FBA'] ??
          row['Offer Count: FBA']
        );
        const fbmOfferCount = parseInt0(
          row['New FBM Offer Count: Current'] ?? row['New FBM Offer Count'] ??
          row['fbm_offer_count'] ?? row['Count of retrieved live offers: New, FBM'] ??
          row['Offer Count: FBM']
        );

        return {
          asin,
          title: title || null,
          brand: brand || null,
          category: category || null,
          image_url: image || null,
          new_offer_count: newOfferCount,
          fba_offer_count: fbaOfferCount,
          fbm_offer_count: fbmOfferCount,
          updated_at: new Date().toISOString(),
        };
      }).filter(Boolean);

      if (records.length === 0) continue;

      const { error: upsertError } = await supabase
        .from('keepa_simple_products')
        .upsert(records as any[], { onConflict: 'asin', ignoreDuplicates: false });

      if (upsertError) {
        console.error(`Batch ${i} error:`, upsertError);
        errors.push(`Batch starting row ${i + 1}: ${upsertError.message}`);
        failed += records.length;
      } else {
        // We can't distinguish insert vs update from upsert, so count all as processed
        inserted += records.length;
      }
    }

    console.log(`Import complete: ${inserted} processed, ${failed} failed`);

    return new Response(JSON.stringify({
      total: rows.length,
      processed: inserted,
      failed,
      errors: errors.slice(0, 5),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

