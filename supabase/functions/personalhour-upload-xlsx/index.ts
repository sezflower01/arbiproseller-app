import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SALES_TAX_RATE = 0.0825;

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
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { raw: false });

    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: 'No data found in Excel file' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Processing ${rows.length} rows from Excel file`);

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
    };

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row: any = rows[i];
      
      try {
        // Extract data from Excel row (flexible column name matching)
        const asin = (row.ASIN || row.asin || row.Asin || '').trim();
        const orderDate = (row['Order Date'] || row['order_date'] || row.Date || row.date || '').trim();
        const commission = parseFloat(row.Commission || row.commission || '0');
        const buyerName = (row['Buyer Name'] || row['buyer_name'] || row.Buyer || row.buyer || '').trim();
        const shippingCost = parseFloat(row['Shipping Cost'] || row['shipping_cost'] || row.Shipping || row.shipping || '0');

        if (!asin) {
          results.errors.push(`Row ${i + 1}: Missing ASIN`);
          results.failed++;
          continue;
        }

        if (!orderDate) {
          results.errors.push(`Row ${i + 1}: Missing Order Date`);
          results.failed++;
          continue;
        }

        // Parse date (supports MM-DD-YYYY and other formats)
        let formattedDate: string;
        const dateParts = orderDate.split(/[-/]/);
        if (dateParts.length === 3) {
          const [part1, part2, part3] = dateParts;
          // Assume MM-DD-YYYY format
          const month = parseInt(part1, 10);
          const day = parseInt(part2, 10);
          const year = parseInt(part3, 10);
          
          if (isNaN(month) || isNaN(day) || isNaN(year)) {
            results.errors.push(`Row ${i + 1}: Invalid date format for "${orderDate}"`);
            results.failed++;
            continue;
          }
          
          formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        } else {
          results.errors.push(`Row ${i + 1}: Invalid date format for "${orderDate}"`);
          results.failed++;
          continue;
        }

        // Fetch product data from SP-API
        console.log(`Fetching product data for ASIN: ${asin}`);
        const { data: productData, error: productError } = await supabase.functions.invoke(
          'personalhour-product-data',
          {
            body: { asin },
            headers: { Authorization: authHeader }
          }
        );

        if (productError || !productData) {
          results.errors.push(`Row ${i + 1}: Failed to fetch product data for ${asin}`);
          results.failed++;
          continue;
        }

        // Calculate amounts
        const price = productData.price || 0;
        const amazonFee = productData.amazonFeeFbm || 0;
        const salesTax = price * SALES_TAX_RATE;
        const amountOwed = price - shippingCost - amazonFee;

        // Insert order into database
        const { error: insertError } = await supabase
          .from('personalhour_orders')
          .insert({
            user_id: user.id,
            asin: asin.toUpperCase(),
            title: productData.title,
            image_url: productData.imageUrl,
            price: price,
            amazon_fee_fbm: amazonFee,
            order_created_date: formattedDate,
            sales_tax: salesTax,
            commission: commission,
            amount_owed: amountOwed,
            buyer_name: buyerName || null,
            shipping_cost: shippingCost,
          });

        if (insertError) {
          results.errors.push(`Row ${i + 1}: ${insertError.message}`);
          results.failed++;
        } else {
          results.success++;
          console.log(`Successfully imported order for ${asin}`);
        }
      } catch (error: any) {
        results.errors.push(`Row ${i + 1}: ${(error as Error).message}`);
        results.failed++;
      }
    }

    return new Response(JSON.stringify({
      success: results.success,
      failed: results.failed,
      total: rows.length,
      errors: results.errors.slice(0, 10), // Return first 10 errors
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
