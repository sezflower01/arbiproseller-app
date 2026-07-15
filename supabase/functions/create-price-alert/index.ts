// CREATE-PRICE-ALERT
// Called from the extension's What-if Amazon Price Simulator "Send
// Notification" button. Saves a pending price alert (any notify_email the
// user typed, NOT required to match their account email) and sends a
// confirm-first email — the alert never goes active without that click,
// so this can't be used to spam an arbitrary stranger's inbox.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const asin = String(body.asin || '').toUpperCase().trim();
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const targetPrice = Number(body.targetPrice);
    const notifyEmail = String(body.notifyEmail || '').trim();

    if (!/^[A-Z0-9]{10}$/.test(asin)) return jsonResponse({ error: 'Invalid ASIN' }, 400);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return jsonResponse({ error: 'Invalid target price' }, 400);
    if (!EMAIL_RE.test(notifyEmail)) return jsonResponse({ error: 'Invalid email address' }, 400);

    const { data: row, error: insertErr } = await admin
      .from('price_alerts')
      .insert({
        user_id: userRes.user.id,
        asin,
        marketplace,
        target_price: targetPrice,
        // Fires when Amazon's price rises TO or ABOVE the Desired Price
        // (watching for a price recovery/increase), not a price-drop alert.
        direction: 'at_or_above',
        notify_email: notifyEmail,
      })
      .select('id, confirm_token')
      .single();
    if (insertErr || !row) {
      console.error('[create-price-alert] insert failed', insertErr?.message);
      return jsonResponse({ error: 'Could not create price alert' }, 500);
    }

    const confirmUrl = `${SUPABASE_URL}/functions/v1/confirm-price-alert?token=${row.confirm_token}`;
    try {
      const emailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({
          to: notifyEmail,
          name: 'there',
          emailType: 'price-alert-confirm',
          priceAlert: { asin, marketplace, targetPrice, confirmUrl },
        }),
      });
      if (!emailRes.ok) console.error('[create-price-alert] confirm email send failed', await emailRes.text());
    } catch (e) {
      console.error('[create-price-alert] confirm email send error', (e as Error).message);
    }

    return jsonResponse({ ok: true, id: row.id, message: `Confirmation email sent to ${notifyEmail}` });
  } catch (e) {
    console.error('[create-price-alert] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
