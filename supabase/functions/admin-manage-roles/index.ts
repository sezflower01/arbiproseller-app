const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'No auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Verify caller is admin
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: isAdmin } = await adminClient.rpc('has_role', { _user_id: user.id, _role: 'admin' });
    if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin only' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { action, email, role } = await req.json();

    if (action === 'lookup') {
      // Find user by email
      const { data: { users }, error } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
      if (error) throw error;
      const found = users?.find(u => u.email?.toLowerCase() === email?.toLowerCase());
      if (!found) return new Response(JSON.stringify({ error: 'User not found. They must sign up first.' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ user_id: found.id, email: found.email }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'add_role') {
      // Look up user
      const { data: { users } } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
      const found = users?.find(u => u.email?.toLowerCase() === email?.toLowerCase());
      if (!found) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const { error: insertErr } = await adminClient.from('user_roles').insert({ user_id: found.id, role: role || 'admin' });
      if (insertErr && insertErr.code === '23505') {
        return new Response(JSON.stringify({ message: 'User already has this role' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (insertErr) throw insertErr;

      // Create admin profile entry
      await adminClient.from('admin_profiles').upsert({ user_id: found.id, display_name: found.email?.split('@')[0] || '' }, { onConflict: 'user_id' });

      return new Response(JSON.stringify({ success: true, user_id: found.id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'remove_role') {
      const { data: { users } } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
      const found = users?.find(u => u.email?.toLowerCase() === email?.toLowerCase());
      if (!found) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      // Don't let admin remove themselves
      if (found.id === user.id) return new Response(JSON.stringify({ error: 'Cannot remove your own admin role' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      await adminClient.from('user_roles').delete().eq('user_id', found.id).eq('role', role || 'admin');
      await adminClient.from('admin_profiles').delete().eq('user_id', found.id);
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'list_admins') {
      const { data: roles } = await adminClient.from('user_roles').select('user_id, role').eq('role', 'admin');
      if (!roles?.length) return new Response(JSON.stringify({ admins: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const { data: profiles } = await adminClient.from('admin_profiles').select('user_id, display_name, avatar_url');
      const { data: { users } } = await adminClient.auth.admin.listUsers({ perPage: 1000 });

      const admins = roles.map(r => {
        const u = users?.find(u => u.id === r.user_id);
        const p = profiles?.find(p => p.user_id === r.user_id);
        return {
          user_id: r.user_id,
          email: u?.email || 'unknown',
          display_name: p?.display_name || '',
          avatar_url: p?.avatar_url || null,
        };
      });
      return new Response(JSON.stringify({ admins }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? (err as Error).message : String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
