// CREATE-SELLER-WATCH
// Called from Seller Analyzer's "Watch this seller" action. Saves a pending
// seller watch (any notify_email the user typed, NOT required to match their
// account email) and sends a confirm-first email -- the watch never goes
// active without that click, mirroring create-price-alert's anti-spam shape.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
    const notifyEmail = String(body.notifyEmail || '').trim();

    if (!SELLER_ID_RE.test(sellerId)) return jsonResponse({ error: 'Invalid seller ID' }, 400);
    if (!EMAIL_RE.test(notifyEmail)) return jsonResponse({ error: 'Invalid email address' }, 400);

    // Reactivate a cancelled watch instead of erroring on the unique index.
    const { data: existing } = await admin
      .from('seller_watchlist')
      .select('id, status')
      .eq('user_id', userRes.user.id)
      .eq('seller_id', sellerId)
      .eq('marketplace', marketplace)
      .maybeSingle();

    let row: { id: string; confirm_token: string } | null = null;
    if (existing && existing.status !== 'cancelled') {
      return jsonResponse({ error: `You're already ${existing.status === 'active' ? 'watching' : 'pending confirmation for'} this seller.` }, 409);
    }

    if (existing) {
      const { data: updated, error: updateErr } = await admin
        .from('seller_watchlist')
        .update({
          seller_name: sellerName,
          notify_email: notifyEmail,
          status: 'pending_confirmation',
          confirm_token: crypto.randomUUID(),
          known_asin_list: null,
          confirmed_at: null,
          cancelled_at: null,
        })
        .eq('id', existing.id)
        .select('id, confirm_token')
        .single();
      if (updateErr || !updated) {
        console.error('[create-seller-watch] reactivate failed', updateErr?.message);
        return jsonResponse({ error: 'Could not create seller watch' }, 500);
      }
      row = updated;
    } else {
      const { data: inserted, error: insertErr } = await admin
        .from('seller_watchlist')
        .insert({
          user_id: userRes.user.id,
          seller_id: sellerId,
          seller_name: sellerName,
          marketplace,
          notify_email: notifyEmail,
        })
        .select('id, confirm_token')
        .single();
      if (insertErr || !inserted) {
        console.error('[create-seller-watch] insert failed', insertErr?.message);
        return jsonResponse({ error: 'Could not create seller watch' }, 500);
      }
      row = inserted;
    }

    const confirmUrl = `${SUPABASE_URL}/functions/v1/confirm-seller-watch?token=${row.confirm_token}`;
    try {
      const emailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({
          to: notifyEmail,
          name: 'there',
          emailType: 'seller-watch-confirm',
          sellerWatch: { sellerId, sellerName, marketplace, confirmUrl },
        }),
      });
      if (!emailRes.ok) console.error('[create-seller-watch] confirm email send failed', await emailRes.text());
    } catch (e) {
      console.error('[create-seller-watch] confirm email send error', (e as Error).message);
    }

    return jsonResponse({ ok: true, id: row.id, message: `Confirmation email sent to ${notifyEmail}` });
  } catch (e) {
    console.error('[create-seller-watch] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
