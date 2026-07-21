// READ-ONLY scan: detects suspicious inventory cases and populates
// inventory_missing_review. NEVER writes to the inventory table.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { isInternalCaller } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface InventoryRow {
  sku: string | null;
  asin: string | null;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  last_summaries_at: string | null;
  updated_at: string | null;
  listing_status: string | null;
}

const INACTIVE_STATUSES = new Set([
  'NOT_IN_CATALOG',
  'INACTIVE',
  'DELETED',
  'SUPPRESSED',
  'INCOMPLETE',
]);

const STALE_HOURS = 12;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      console.error('[inventory-review-scan] Missing SUPABASE_URL or SERVICE_ROLE');
      return json({ error: 'Server misconfiguration' }, 500);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Missing Authorization' }, 401);
    }
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'Empty bearer token' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Resolve user: trust body.user_id only from a verified internal caller
    // (cron fan-out via inventory-review-scan-all). Everyone else --
    // including the "Scan Now" button -- resolves userId from their own JWT,
    // unchanged from before.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    let userId: string;
    if (isInternalCaller(req) && typeof body?.user_id === 'string' && body.user_id) {
      userId = body.user_id;
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(token);
      if (userErr || !userData?.user?.id) {
        console.error('[inventory-review-scan] auth.getUser failed', userErr?.message);
        return json({ error: 'Unauthorized' }, 401);
      }
      userId = userData.user.id;
    }
    console.log(`[inventory-review-scan] user=${userId}`);

    // Pull current inventory for this user (read only)
    const { data: invRows, error: invErr } = await admin
      .from('inventory')
      .select('sku, asin, available, reserved, inbound, last_summaries_at, updated_at, listing_status')
      .eq('user_id', userId)
      .limit(10000);

    if (invErr) {
      console.error('[inventory-review-scan] inventory read failed', invErr.message);
      return json({ error: `Inventory read failed: ${invErr.message}` }, 500);
    }

    const now = Date.now();
    const staleCutoff = now - STALE_HOURS * 3600 * 1000;
    const nowIso = new Date().toISOString();

    const flagged: Array<{
      asin: string;
      sku: string;
      marketplace: string | null;
      prior_available: number;
      prior_reserved: number;
      prior_inbound: number;
      reason: string;
      detection_source: string;
    }> = [];

    let scanned = 0;
    for (const r of (invRows ?? []) as InventoryRow[]) {
      scanned++;
      const sku = r.sku?.trim();
      const asin = r.asin?.trim();
      if (!sku || !asin) continue;

      const a = r.available ?? 0;
      const res = r.reserved ?? 0;
      const inb = r.inbound ?? 0;
      const total = a + res + inb;
      if (total <= 0) continue;

      const isInactive = !!r.listing_status && INACTIVE_STATUSES.has(r.listing_status.toUpperCase());

      const lastSeen = r.last_summaries_at ? new Date(r.last_summaries_at).getTime() : 0;
      if (!lastSeen) {
        flagged.push({
          asin, sku,
          marketplace: null,
          prior_available: a, prior_reserved: res, prior_inbound: inb,
          reason: isInactive
            ? `Inactive listing cleanup (${r.listing_status}) — leftover stock, not sellable`
            : 'Positive stock but no Summaries snapshot recorded',
          detection_source: isInactive ? 'inactive_listing_cleanup' : 'scan_now',
        });
        continue;
      }

      if (lastSeen < staleCutoff) {
        const hours = Math.round((now - lastSeen) / 3600000);
        flagged.push({
          asin, sku,
          marketplace: null,
          prior_available: a, prior_reserved: res, prior_inbound: inb,
          reason: isInactive
            ? `Inactive listing cleanup (${r.listing_status}) — stale ${hours}h, leftover stock`
            : `Positive stock but Summaries snapshot is stale (${hours}h old)`,
          detection_source: isInactive ? 'inactive_listing_cleanup' : 'scan_now',
        });
      }
    }

    console.log(`[inventory-review-scan] scanned=${scanned} flagged=${flagged.length}`);

    // Upsert into review queue (NEVER touch inventory table)
    let inserted = 0;
    let updated = 0;
    let errors = 0;
    for (const f of flagged) {
      const { data: existing, error: selErr } = await admin
        .from('inventory_missing_review')
        .select('id, occurrences, status')
        .eq('user_id', userId)
        .eq('asin', f.asin)
        .eq('sku', f.sku)
        .maybeSingle();

      if (selErr) {
        console.error('[inventory-review-scan] select existing failed', selErr.message);
        errors++;
        continue;
      }

      if (existing) {
        if (existing.status === 'needs_review') {
          const { error: updErr } = await admin
            .from('inventory_missing_review')
            .update({
              occurrences: (existing.occurrences ?? 1) + 1,
              last_missing_at: nowIso,
              updated_at: nowIso,
              reason: f.reason,
              detection_source: f.detection_source,
            })
            .eq('id', existing.id);
          if (updErr) {
            console.error('[inventory-review-scan] update failed', updErr.message);
            errors++;
          } else {
            updated++;
          }
        }
      } else {
        const { error: insErr } = await admin
          .from('inventory_missing_review')
          .insert({
            user_id: userId,
            asin: f.asin,
            sku: f.sku,
            marketplace: f.marketplace,
            prior_available: f.prior_available,
            prior_reserved: f.prior_reserved,
            prior_inbound: f.prior_inbound,
            reason: f.reason,
            detection_source: f.detection_source,
            status: 'needs_review',
            occurrences: 1,
            first_missing_at: nowIso,
            last_missing_at: nowIso,
          });
        if (insErr) {
          console.error('[inventory-review-scan] insert failed', insErr.message);
          errors++;
        } else {
          inserted++;
        }
      }
    }

    console.log(`[inventory-review-scan] done inserted=${inserted} updated=${updated} errors=${errors}`);

    return json({
      ok: true,
      scanned,
      flagged: flagged.length,
      new_entries: inserted,
      updated,
      errors,
      scanned_at: nowIso,
      note: 'Read-only scan. No inventory rows were modified.',
    }, 200);
  } catch (e) {
    console.error('[inventory-review-scan] fatal', (e as Error).message, (e as Error).stack);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
