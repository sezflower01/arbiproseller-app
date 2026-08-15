// CREATE-SELLER-WATCH
// Called from Seller Analyzer's "Watch this seller" action. Activates
// immediately -- no confirm-email step. That double opt-in made sense for
// price_alerts, where notify_email can be an arbitrary address someone
// typed in (so confirmation proves they own it). Here notify_email is
// always the caller's own already-verified Supabase account email, so
// there's nothing to confirm; gating it behind an email round-trip was
// pure friction with no anti-spam benefit.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const SELLER_ID_RE = /^[A-Z0-9]{6,20}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const auth = req.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return jsonResponse({ error: 'Unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const token = auth.replace('Bearer ', '').trim();
    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userRes?.user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    let sellerId = String(body.sellerId || '').trim();
    const meMatch = sellerId.match(/[?&]me=([A-Z0-9]+)/i);
    if (meMatch) sellerId = meMatch[1];
    const sellerName = body.sellerName ? String(body.sellerName).slice(0, 200) : null;
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const notifyEmail = userRes.user.email || '';

    if (!SELLER_ID_RE.test(sellerId)) return jsonResponse({ error: 'Invalid seller ID' }, 400);
    if (!notifyEmail) return jsonResponse({ error: 'Your account has no email on file' }, 400);

    const nowIso = new Date().toISOString();

    // Reactivate a cancelled watch instead of erroring on the unique index.
    const { data: existing } = await admin
      .from('seller_watchlist')
      .select('id, status')
      .eq('user_id', userRes.user.id)
      .eq('seller_id', sellerId)
      .eq('marketplace', marketplace)
      .maybeSingle();

    if (existing && existing.status === 'active') {
      return jsonResponse({ error: "You're already watching this seller." }, 409);
    }

    let rowId: string;
    if (existing) {
      const { data: updated, error: updateErr } = await admin
        .from('seller_watchlist')
        .update({
          seller_name: sellerName,
          notify_email: notifyEmail,
          status: 'active',
          known_asin_list: null,
          confirmed_at: nowIso,
          cancelled_at: null,
        })
        .eq('id', existing.id)
        .select('id')
        .single();
      if (updateErr || !updated) {
        console.error('[create-seller-watch] reactivate failed', updateErr?.message);
        return jsonResponse({ error: 'Could not create seller watch' }, 500);
      }
      rowId = updated.id;
    } else {
      const { data: inserted, error: insertErr } = await admin
        .from('seller_watchlist')
        .insert({
          user_id: userRes.user.id,
          seller_id: sellerId,
          seller_name: sellerName,
          marketplace,
          notify_email: notifyEmail,
          status: 'active',
          confirmed_at: nowIso,
        })
        .select('id')
        .single();
      if (insertErr || !inserted) {
        console.error('[create-seller-watch] insert failed', insertErr?.message);
        return jsonResponse({ error: 'Could not create seller watch' }, 500);
      }
      rowId = inserted.id;
    }

    return jsonResponse({ ok: true, id: rowId, message: `Now watching ${sellerName || sellerId}` });
  } catch (e) {
    console.error('[create-seller-watch] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
