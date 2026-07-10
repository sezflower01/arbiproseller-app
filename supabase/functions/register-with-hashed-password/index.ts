
console.log('Register-with-hashed-password function invoked - top level (v7)');

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Define CORS headers here as they are good practice, even if not explicitly in the example.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export default async function handler(req: Request) {
  console.log('Handler invoked:', req.method, req.url);

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    console.log('Handling OPTIONS request');
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { username, email, licensekey } = await req.json();
    console.log('Request body parsed:', { username_present: !!username, email_present: !!email, licensekey_present: !!licensekey });

    if (!username) {
      console.log('Validation failed: Missing username');
      return new Response(JSON.stringify({ error: 'Missing username' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
    console.log('Supabase admin client initialized.');

    // Insert into RegisterUser with only the available columns
    const { error } = await supabaseAdmin
      .from('RegisterUser')
      .insert({
        username: email || username, // Use email if provided, otherwise username
        usedusername: username,
        licensekey: licensekey || null
      });

    if (error) {
      console.error('Error inserting into RegisterUser:', error);
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log('Successfully inserted into RegisterUser.');
    return new Response(JSON.stringify({ message: '✅ User registered successfully' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('Error in handler:', e);
    return new Response(JSON.stringify({ error: 'Internal server error: ' + (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
