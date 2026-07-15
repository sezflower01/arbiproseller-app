// CONFIRM-PRICE-ALERT
// Public click-through link from the price-alert-confirm email. The
// confirm_token (an unguessable UUID) IS the auth — no user session
// required, since the person clicking may not be signed in on this device.
// Returns a small standalone HTML page (no React app involvement needed).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' };

function page(title: string, message: string, ok: boolean) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; background: #F4F5F7; margin: 0; padding: 48px 16px; display: flex; justify-content: center; }
  .card { max-width: 420px; background: #fff; border-radius: 12px; padding: 32px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1 { font-size: 20px; color: ${ok ? '#059669' : '#DC2626'}; margin: 0 0 12px; }
  p { color: #374151; line-height: 1.5; }
</style></head>
<body><div class="card"><h1>${ok ? '✓ ' : '✗ '}${title}</h1><p>${message}</p></div></body></html>`;
}

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const token = u.searchParams.get('token') || '';
    if (!token) {
      return new Response(page('Invalid link', 'This confirmation link is missing its token.', false), { status: 400, headers: HTML_HEADERS });
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: alert, error } = await admin
      .from('price_alerts')
      .select('id, asin, target_price, status')
      .eq('confirm_token', token)
      .maybeSingle();

    if (error || !alert) {
      return new Response(page('Link not found', 'This confirmation link is invalid or has expired.', false), { status: 404, headers: HTML_HEADERS });
    }
    if (alert.status === 'active' || alert.status === 'fired') {
      return new Response(page('Already confirmed', `This price alert for ${alert.asin} was already confirmed.`, true), { status: 200, headers: HTML_HEADERS });
    }
    if (alert.status === 'cancelled') {
      return new Response(page('Alert cancelled', 'This price alert has been cancelled and can no longer be confirmed.', false), { status: 410, headers: HTML_HEADERS });
    }

    const { error: updateErr } = await admin
      .from('price_alerts')
      .update({ status: 'active', confirmed_at: new Date().toISOString() })
      .eq('id', alert.id)
      .eq('status', 'pending_confirmation');
    if (updateErr) {
      console.error('[confirm-price-alert] update failed', updateErr.message);
      return new Response(page('Something went wrong', 'Could not confirm this alert. Please try again.', false), { status: 500, headers: HTML_HEADERS });
    }

    return new Response(
      page('Price alert confirmed', `We'll email you when ${alert.asin}'s Amazon price reaches your Desired Price of $${Number(alert.target_price).toFixed(2)} or above.`, true),
      { status: 200, headers: HTML_HEADERS },
    );
  } catch (e) {
    return new Response(page('Something went wrong', (e as Error).message, false), { status: 500, headers: HTML_HEADERS });
  }
});
