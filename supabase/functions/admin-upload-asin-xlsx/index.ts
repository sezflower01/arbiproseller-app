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

    // Save file to storage first
    const timestamp = new Date().getTime();
    const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${user.id}/${timestamp}_${sanitizedFilename}`;
    
    const arrayBuffer = await file.arrayBuffer();
    
    const { error: uploadError } = await supabase.storage
      .from('asin-uploads')
      .upload(storagePath, arrayBuffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return new Response(JSON.stringify({ error: `Failed to save file: ${uploadError.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('File saved to storage:', storagePath);

    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { raw: false });

    if (!rows || rows.length === 0) {
      // Clean up the uploaded file
      await supabase.storage.from('asin-uploads').remove([storagePath]);
      return new Response(JSON.stringify({ error: 'No data found in Excel file' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse ASINs from rows
    const parsedAsins = rows.map((row: any) => {
      const asin = row.ASIN || row.asin || row.Asin || '';
      return asin.trim();
    }).filter(asin => asin);

    console.log(`Parsed ${parsedAsins.length} ASINs from Excel file with ${rows.length} total rows`);

    if (parsedAsins.length === 0) {
      await supabase.storage.from('asin-uploads').remove([storagePath]);
      return new Response(JSON.stringify({ error: 'No valid ASINs found in file. Make sure there is an ASIN column.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Insert new ASINs into asin_upload table using batch inserts (deduplicated by UNIQUE constraint)
    const batchSize = 500;
    let newUploadedCount = 0;
    
    for (let i = 0; i < parsedAsins.length; i += batchSize) {
      const batch = parsedAsins.slice(i, i + batchSize);
      const { data: inserted, error: uploadInsertError } = await supabase
        .from('asin_upload')
        .insert(batch.map(asin => ({ asin })))
        .select();
      
      if (!uploadInsertError && inserted) {
        newUploadedCount += inserted.length;
      }
      
      console.log(`Processed batch ${Math.floor(i / batchSize) + 1}: ${i + batch.length}/${parsedAsins.length} ASINs`);
    }
    
    console.log(`Inserted ${newUploadedCount} new ASINs into asin_upload table out of ${parsedAsins.length} total`);

    // Check for existing ASINs in current batch items (for batch processing) - batch the queries to avoid header size limits
    const existingAsinSet = new Set<string>();
    const checkBatchSize = 500;
    
    for (let i = 0; i < parsedAsins.length; i += checkBatchSize) {
      const checkBatch = parsedAsins.slice(i, i + checkBatchSize);
      const { data: existingAsins, error: checkError } = await supabase
        .from('asin_items')
        .select('asin')
        .in('asin', checkBatch);

      if (checkError) {
        console.error('Error checking for duplicates:', checkError);
        await supabase.storage.from('asin-uploads').remove([storagePath]);
        return new Response(JSON.stringify({ error: checkError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      existingAsins?.forEach(item => existingAsinSet.add(item.asin));
      console.log(`Checked batch ${Math.floor(i / checkBatchSize) + 1} for duplicates: ${i + checkBatch.length}/${parsedAsins.length} ASINs`);
    }

    const newAsins = parsedAsins.filter(asin => !existingAsinSet.has(asin));
    const skippedCount = parsedAsins.length - newAsins.length;

    console.log(`Total ASINs: ${parsedAsins.length}, New: ${newAsins.length}, Skipped duplicates: ${skippedCount}`);

    // Create batch with file path
    const { data: batch, error: batchError } = await supabase
      .from('asin_batches')
      .insert({
        user_id: user.id,
        filename: file.name,
        file_path: storagePath,
        total: newAsins.length,
        skipped_duplicates: skippedCount,
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

    // Insert only new ASINs
    const items = newAsins.map((asin, idx) => ({
      batch_id: batch.id,
      idx: idx + 1,
      asin: asin,
      status: 'queued',
    }));

    if (items.length > 0) {
      const { error: itemsError } = await supabase
        .from('asin_items')
        .insert(items);

      if (itemsError) {
        console.error('Items insertion error:', itemsError);
        await supabase.from('asin_batches').delete().eq('id', batch.id);
        await supabase.storage.from('asin-uploads').remove([storagePath]);
        return new Response(JSON.stringify({ error: itemsError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({
      batch_id: batch.id,
      total_asins: parsedAsins.length,
      new_asins: newAsins.length,
      skipped_duplicates: skippedCount,
      file_path: storagePath,
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
