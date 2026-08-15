// BULK-CREATE-SELLER-WATCHES
// Adds many seller watches in one shot, from a pasted list or an uploaded
// CSV. Same direct-add semantics as create-seller-watch: rows go straight to
// 'active' with no confirmation step, because notify_email is always the
// caller's own already-verified account email.
//
// TWO MODES over the same parsing path, so the preview cannot disagree with
// what the commit actually does:
//   mode: 'preview'  -- classify every input, write nothing
//   mode: 'commit'   -- classify, then insert/reactivate
// The preview matters at this scale: pasting 1000 IDs and discovering
// afterwards that 300 were malformed is a bad way to find out.
//
// Classification per input:
//   valid          -- parses, not already watched -> will be added
//   alreadyWatched -- an active watch already exists for this seller+market
//   reactivating   -- a cancelled watch exists; adding revives it
//   duplicate      -- appears more than once in this upload
//   invalid        -- fails the seller-ID shape check
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { classifyInput, splitInputLines } from './parse.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_PER_UPLOAD = 1000;

// Guard against a pasted novel: 1000 IDs is ~15KB, so this is generous while
// still bounding what gets parsed.
const MAX_INPUT_CHARS = 2_000_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

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

    const userId = userRes.user.id;
    const notifyEmail = userRes.user.email || '';
    if (!notifyEmail) return jsonResponse({ error: 'Your account has no email on file' }, 400);

    // Reject a malformed body outright rather than falling back to {} -- a
    // mangled payload silently becoming "commit nothing" (or worse, an
    // unintended write) is exactly the foot-gun plan mode hit earlier.
    const rawBody = await req.text().catch(() => '');
    let body: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ error: 'Request body was not valid JSON. Nothing was written.' }, 400);
      }
    }

    const mode = body.mode === 'commit' ? 'commit' : 'preview';
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const text = String(body.text ?? '');

    if (!text.trim()) return jsonResponse({ error: 'No seller IDs provided.' }, 400);
    if (text.length > MAX_INPUT_CHARS) {
      return jsonResponse({ error: 'Input is too large. Split it into smaller uploads.' }, 413);
    }

    // --- Parse and classify ------------------------------------------------
    // Shared with the test suite via ./parse.ts, so preview and commit cannot
    // disagree about what an input line means.
    const lines = splitInputLines(text);
    const { parsed, invalid, duplicates } = classifyInput(text);

    const overCap = parsed.length > MAX_PER_UPLOAD;
    const accepted = overCap ? parsed.slice(0, MAX_PER_UPLOAD) : parsed;

    // Existing watches for these sellers, so preview can distinguish "new"
    // from "already watching" from "will be reactivated".
    const existingBySeller = new Map<string, string>();
    if (accepted.length) {
      const { data: existing, error: exErr } = await admin
        .from('seller_watchlist')
        .select('seller_id, status')
        .eq('user_id', userId)
        .eq('marketplace', marketplace)
        .in('seller_id', accepted);
      if (exErr) return jsonResponse({ error: exErr.message }, 500);
      for (const row of existing || []) existingBySeller.set(row.seller_id, row.status);
    }

    const toAdd: string[] = [];
    const toReactivate: string[] = [];
    const alreadyWatched: string[] = [];
    for (const sellerId of accepted) {
      const status = existingBySeller.get(sellerId);
      if (status === 'active') alreadyWatched.push(sellerId);
      else if (status === 'cancelled') toReactivate.push(sellerId);
      else toAdd.push(sellerId);
    }

    const summary = {
      mode,
      marketplace,
      linesRead: lines.length,
      willAdd: toAdd.length,
      willReactivate: toReactivate.length,
      alreadyWatched: alreadyWatched.length,
      duplicatesInUpload: duplicates.length,
      invalidLines: invalid.length,
      overCap,
      cap: MAX_PER_UPLOAD,
      droppedOverCap: overCap ? parsed.length - MAX_PER_UPLOAD : 0,
      samples: {
        invalid: invalid.slice(0, 10),
        duplicates: duplicates.slice(0, 10),
        alreadyWatched: alreadyWatched.slice(0, 10),
      },
    };

    if (mode === 'preview') {
      return jsonResponse({ ok: true, ...summary, committed: false });
    }

    // --- Commit ------------------------------------------------------------
    const nowIso = new Date().toISOString();
    let added = 0;
    let reactivated = 0;

    if (toAdd.length) {
      // Chunked so one oversized statement cannot blow the request. New rows
      // get known_asin_list NULL, which both seeds silently on first check and
      // sorts them to the head of the rotation queue (NULLS FIRST).
      const CHUNK = 200;
      for (let i = 0; i < toAdd.length; i += CHUNK) {
        const chunk = toAdd.slice(i, i + CHUNK).map((sellerId) => ({
          user_id: userId,
          seller_id: sellerId,
          seller_name: null,
          marketplace,
          notify_email: notifyEmail,
          status: 'active',
          confirmed_at: nowIso,
        }));
        const { data, error: insErr } = await admin
          .from('seller_watchlist')
          .insert(chunk)
          .select('id');
        if (insErr) {
          console.error('[bulk-create-seller-watches] insert chunk failed', insErr.message);
          return jsonResponse({
            error: `Added ${added} before failing: ${insErr.message}`,
            ...summary,
            added,
            reactivated,
            committed: true,
            partial: true,
          }, 500);
        }
        added += data?.length ?? chunk.length;
      }
    }

    if (toReactivate.length) {
      // Reset known_asin_list so a revived watch re-seeds rather than
      // reporting everything listed while it was cancelled as brand new.
      const { data, error: reErr } = await admin
        .from('seller_watchlist')
        .update({
          status: 'active',
          known_asin_list: null,
          confirmed_at: nowIso,
          cancelled_at: null,
          notify_email: notifyEmail,
        })
        .eq('user_id', userId)
        .eq('marketplace', marketplace)
        .in('seller_id', toReactivate)
        .select('id');
      if (reErr) {
        console.error('[bulk-create-seller-watches] reactivate failed', reErr.message);
        return jsonResponse({ error: reErr.message, ...summary, added, reactivated, committed: true, partial: true }, 500);
      }
      reactivated = data?.length ?? 0;
    }

    return jsonResponse({ ok: true, ...summary, added, reactivated, committed: true });
  } catch (e) {
    console.error('[bulk-create-seller-watches] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
