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

    const { name, batchSize = 1000, filters } = await req.json();

    // Check if user has admin role OR enough credits
    const { data: roles } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    const isAdmin = !!roles;
    
    if (!isAdmin) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('credits')
        .eq('id', user.id)
        .single();

      const creditsPerItem = 1;
      const requiredCredits = batchSize * creditsPerItem;

      if (!profile || profile.credits < requiredCredits) {
        return new Response(JSON.stringify({ 
          error: 'Insufficient credits', 
          required: requiredCredits,
          available: profile?.credits || 0 
        }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Create automation run
    const { data: run, error: runError } = await supabase
      .from('automation_runs')
      .insert({
        user_id: user.id,
        name: name || `Run ${new Date().toISOString()}`,
        source_filter: filters || {},
        total: batchSize,
        status: 'queued'
      })
      .select()
      .single();

    if (runError) {
      console.error('Run creation error:', runError);
      return new Response(JSON.stringify({ error: runError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Initialize cursor
    await supabase
      .from('automation_run_cursor')
      .insert({ run_id: run.id, last_seen_id: null });

    return new Response(JSON.stringify({ run_id: run.id, status: 'queued' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Start automation error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? (error as Error).message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});