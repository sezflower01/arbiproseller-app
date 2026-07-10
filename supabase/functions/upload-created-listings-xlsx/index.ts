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
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
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
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet);

    console.log(`Processing ${rows.length} rows from Excel file`);

    const successful: string[] = [];
    const failed: Array<{ row: number; error: string; asin?: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row: any = rows[i];
      
      try {
        // Map Access database columns to web app schema
        // ImageLink -> image_url
        // DateCreated -> created_at (optional, will use now() by default)
        // ASIN -> asin
        // Title (in Access) -> supplier_links (supplier URL)
        // Link -> title (actual product title)
        // Discount Amount -> amount (Total Cost)
        // Supplier -> will be extracted from supplier link domain
        // Units -> units
        // Unit Cost -> cost

        const asin = row['ASIN']?.toString().trim();
        const imageUrl = row['ImageLink']?.toString().trim() || null;
        const title = row['Link']?.toString().trim() || '';
        const supplierUrl = row['Title']?.toString().trim() || '';
        const totalCost = parseFloat(row['Discount Amount'] || row['DiscountAmount'] || '0');
        const units = parseInt(row['Units'] || '1', 10);
        const unitCost = parseFloat(row['Unit Cost'] || row['UnitCost'] || '0');

        if (!asin || !title) {
          failed.push({
            row: i + 2,
            error: 'Missing required fields (ASIN or Title)',
            asin: asin || 'N/A',
          });
          continue;
        }

        // Generate SKU (will be synced from Amazon later, but we need something unique)
        const generateSKU = () => {
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          const randomChar = () => chars.charAt(Math.floor(Math.random() * chars.length));
          const part1 = Array.from({ length: 3 }, randomChar).join('');
          const part2 = Array.from({ length: 3 }, randomChar).join('');
          const part3 = Array.from({ length: 4 }, randomChar).join('');
          return `${part1}-${part2}-${part3}`;
        };

        // Build supplier_links array
        const supplierLinks = supplierUrl ? [{ link: supplierUrl, discount_code: '' }] : [];

        const listingData = {
          user_id: user.id,
          asin,
          sku: generateSKU(),
          title,
          image_url: imageUrl,
          price: null, // Will be fetched from Amazon later
          cost: totalCost, // Total Cost
          amount: unitCost, // Unit Cost
          units,
          supplier_links: supplierLinks,
          fnsku: null,
        };

        const { error: insertError } = await supabaseClient
          .from('created_listings')
          .insert(listingData);

        if (insertError) {
          console.error(`Error inserting row ${i + 2}:`, insertError);
          failed.push({
            row: i + 2,
            error: insertError.message,
            asin,
          });
        } else {
          successful.push(asin);
        }
      } catch (error) {
        console.error(`Error processing row ${i + 2}:`, error);
        failed.push({
          row: i + 2,
          error: (error as Error).message || 'Unknown error',
          asin: row['ASIN'] || 'N/A',
        });
      }
    }

    console.log(`Import complete: ${successful.length} successful, ${failed.length} failed`);

    return new Response(
      JSON.stringify({
        message: 'Import complete',
        successful: successful.length,
        failed: failed.length,
        totalRows: rows.length,
        errors: failed,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in upload-created-listings-xlsx:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'Internal server error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
