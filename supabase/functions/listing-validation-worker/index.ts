// Listing Validation Worker (Phase C2 + C3)
// -----------------------------------------------------------------------------
// Polls listing_validation_queue and advances each listing through its
// validation pipeline:
//
//   await_fnsku  →  item_preview  →  ACTIVE / FAILED_VALIDATION
//
// C2: poll SP-API Inventory Summaries until FNSKU is propagated.
// C3: after FNSKU is found, run itemPreview (FBA inbound eligibility) +
//     hazmat + prep checks via the existing `check-fba-listing-eligibility`
//     function (which writes to fba_readiness_cache + fba_readiness_audit).
//
// Outcome rules:
//   - fba_eligibility blocked  → FAILED  (ITEM_PREVIEW_INELIGIBLE)
//   - hazmat blocked           → FAILED  (HAZMAT_BLOCKED)
//   - prep blocked             → FAILED  (PREP_BLOCKED)
//   - any stage = unknown      → retry up to 3 times, then promote ACTIVE
//                                with a `validation_warning` recorded
//   - all ok / warn            → ACTIVE
//
// C4 (not yet implemented) will add `inbound_dry_run` after item_preview ok.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const BATCH_SIZE = 25;
const MAX_FNSKU_ATTEMPTS = 7;
const FNSKU_BACKOFF_MIN = [1, 2, 5, 10, 20, 30, 60];
const MAX_PREVIEW_ATTEMPTS = 4; // 1 initial + 3 retries on UNKNOWN
const PREVIEW_BACKOFF_MIN = [2, 5, 15, 30];

const MARKETPLACE_TO_ID: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

interface QueueRow {
  id: string;
  listing_id: string;
  user_id: string;
  asin: string;
  sku: string;
  marketplace: string;
  next_stage: string;
  attempts: number;
}

type SbClient = ReturnType<typeof createClient>;

async function audit(
  supabase: SbClient,
  row: QueueRow,
  status: string,
  reason: string | null,
  raw: unknown,
  stageOverride?: string,
) {
  await supabase.from('listing_validation_audit').insert({
    user_id: row.user_id,
    listing_id: row.listing_id,
    asin: row.asin,
    sku: row.sku,
    marketplace: row.marketplace,
    stage: stageOverride ?? row.next_stage,
    status,
    reason,
    raw: raw as never,
    source: 'listing-validation-worker@c3',
  });
}

// ─── SP-API helpers ─────────────────────────────────────────────────

async function getAccessToken(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/refresh-spapi-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchFnsku(
  accessToken: string,
  sku: string,
  marketplaceId: string,
): Promise<{ fnsku: string | null; raw: unknown; transient: boolean }> {
  const url = new URL('https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries');
  url.searchParams.set('granularityType', 'Marketplace');
  url.searchParams.set('granularityId', marketplaceId);
  url.searchParams.set('marketplaceIds', marketplaceId);
  url.searchParams.set('sellerSkus', sku);

  const res = await fetch(url.toString(), {
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
  });
  const transient = res.status >= 500 || res.status === 429;
  let raw: unknown;
  try { raw = await res.json(); } catch { raw = { httpStatus: res.status }; }
  if (!res.ok) return { fnsku: null, raw, transient };
  const summaries =
    (raw as { payload?: { inventorySummaries?: Array<Record<string, unknown>> } })
      ?.payload?.inventorySummaries ?? [];
  const match = summaries.find(
    (s) => String(s.sellerSku ?? '').toLowerCase() === sku.toLowerCase(),
  );
  return { fnsku: match?.fnSku ? String(match.fnSku) : null, raw, transient: false };
}

// ─── Stage handlers ─────────────────────────────────────────────────

async function deferRow(
  supabase: SbClient,
  row: QueueRow,
  delayMin: number,
  reason: string,
  bumpAttempt: boolean,
) {
  const upd: Record<string, unknown> = {
    next_run_at: new Date(Date.now() + delayMin * 60_000).toISOString(),
    last_error: reason,
  };
  if (bumpAttempt) upd.attempts = row.attempts + 1;
  await supabase.from('listing_validation_queue').update(upd).eq('id', row.id);
}

async function failListing(
  supabase: SbClient,
  row: QueueRow,
  code: string,
  reason: string,
) {
  await supabase
    .from('created_listings')
    .update({
      validation_status: 'FAILED_VALIDATION',
      validation_completed_at: new Date().toISOString(),
      validation_failure_code: code,
      validation_failure_reason: reason,
      validation_attempts: row.attempts + 1,
    })
    .eq('id', row.listing_id);
  await supabase.from('listing_validation_queue').delete().eq('id', row.id);
  await audit(supabase, row, 'failed', code, { reason });
  console.warn(`[validation-worker] FAILED listing=${row.listing_id} stage=${row.next_stage} code=${code}`);
}

async function promoteActive(
  supabase: SbClient,
  row: QueueRow,
  warning: string | null,
  raw: unknown,
) {
  const upd: Record<string, unknown> = {
    validation_status: 'ACTIVE',
    validation_completed_at: new Date().toISOString(),
    validation_failure_code: null,
    validation_failure_reason: null,
  };
  if (warning) upd.validation_warning = warning;
  await supabase.from('created_listings').update(upd).eq('id', row.listing_id);
  await supabase.from('listing_validation_queue').delete().eq('id', row.id);
  await audit(supabase, row, 'ok', warning ? `active_with_warning:${warning}` : 'active', raw);
  console.log(`[validation-worker] ACTIVE  listing=${row.listing_id} stage=${row.next_stage}${warning ? ' warn=' + warning : ''}`);
}

async function advanceStage(
  supabase: SbClient,
  row: QueueRow,
  nextStage: string,
  raw: unknown,
) {
  await supabase
    .from('listing_validation_queue')
    .update({
      next_stage: nextStage,
      attempts: 0,
      next_run_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', row.id);
  await audit(supabase, row, 'ok', `advance_to:${nextStage}`, raw);
  console.log(`[validation-worker] ADVANCE listing=${row.listing_id} → ${nextStage}`);
}

// Stage 1: await_fnsku
async function processFnskuStage(supabase: SbClient, row: QueueRow): Promise<void> {
  const marketplaceId = MARKETPLACE_TO_ID[row.marketplace] ?? MARKETPLACE_TO_ID.US;
  const accessToken = await getAccessToken(row.user_id);
  if (!accessToken) {
    await deferRow(supabase, row, 5, 'no_access_token', false);
    await audit(supabase, row, 'transient', 'no_access_token', null);
    return;
  }

  let result: Awaited<ReturnType<typeof fetchFnsku>>;
  try {
    result = await fetchFnsku(accessToken, row.sku, marketplaceId);
  } catch (e) {
    result = { fnsku: null, raw: { error: (e as Error).message }, transient: true };
  }

  if (result.transient) {
    await deferRow(supabase, row, 5, 'transient_spapi', false);
    await audit(supabase, row, 'transient', 'transient_spapi', result.raw);
    return;
  }

  if (result.fnsku) {
    // Save FNSKU but DO NOT promote yet — advance to item_preview.
    await supabase
      .from('created_listings')
      .update({ fnsku: result.fnsku })
      .eq('id', row.listing_id);
    await advanceStage(supabase, row, 'item_preview', { fnsku: result.fnsku });
    return;
  }

  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= MAX_FNSKU_ATTEMPTS) {
    await failListing(supabase, row, 'FNSKU_TIMEOUT',
      `Amazon did not propagate an FNSKU after ${MAX_FNSKU_ATTEMPTS} polling attempts.`);
    return;
  }
  const delayMin = FNSKU_BACKOFF_MIN[Math.min(nextAttempts, FNSKU_BACKOFF_MIN.length - 1)];
  await deferRow(supabase, row, delayMin, 'fnsku_not_yet_available', true);
  await supabase.from('created_listings')
    .update({ validation_attempts: nextAttempts }).eq('id', row.listing_id);
  await audit(supabase, row, 'pending', 'fnsku_not_yet_available', { attempts: nextAttempts, delayMin });
}

// Stage 2: item_preview (calls check-fba-listing-eligibility for stages 3/4/5)
interface StageStatus { stage: string; status: 'ok' | 'warn' | 'blocked' | 'unknown'; reason?: string; raw?: unknown }

async function processItemPreviewStage(supabase: SbClient, row: QueueRow): Promise<void> {
  let payload: { stageStatuses?: StageStatus[]; error?: string } | null = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/check-fba-listing-eligibility`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        user_id: row.user_id,
        asin: row.asin,
        marketplace: row.marketplace,
        force: false,
      }),
    });
    payload = await res.json();
    if (!res.ok) {
      await deferRow(supabase, row, 10, `eligibility_http_${res.status}`, false);
      await audit(supabase, row, 'transient', `eligibility_http_${res.status}`, payload);
      return;
    }
  } catch (e) {
    await deferRow(supabase, row, 10, `eligibility_error:${(e as Error).message}`, false);
    await audit(supabase, row, 'transient', 'eligibility_error', { error: (e as Error).message });
    return;
  }

  const stages = payload?.stageStatuses ?? [];
  const get = (name: string) => stages.find((s) => s.stage === name);
  const fbaElig = get('fba_eligibility');
  const hazmat = get('hazmat');
  const prep = get('prep');

  // Hard blocks → FAILED
  if (fbaElig?.status === 'blocked') {
    await failListing(supabase, row, 'ITEM_PREVIEW_INELIGIBLE',
      fbaElig.reason || 'Amazon reports ASIN not eligible for FBA inbound.');
    return;
  }
  if (hazmat?.status === 'blocked') {
    await failListing(supabase, row, 'HAZMAT_BLOCKED',
      hazmat.reason || 'Item flagged as hazardous / dangerous goods.');
    return;
  }
  if (prep?.status === 'blocked') {
    await failListing(supabase, row, 'PREP_BLOCKED',
      prep.reason || 'Item requires prep that cannot be completed automatically.');
    return;
  }

  // Any UNKNOWN → retry; after MAX_PREVIEW_ATTEMPTS, promote with warning
  const unknowns = [fbaElig, hazmat, prep].filter((s) => s?.status === 'unknown');
  if (unknowns.length > 0) {
    const nextAttempts = row.attempts + 1;
    if (nextAttempts < MAX_PREVIEW_ATTEMPTS) {
      const delayMin = PREVIEW_BACKOFF_MIN[Math.min(nextAttempts, PREVIEW_BACKOFF_MIN.length - 1)];
      await deferRow(supabase, row, delayMin, 'preview_unknown_retry', true);
      await audit(supabase, row, 'pending', 'preview_unknown_retry',
        { attempts: nextAttempts, unknown: unknowns.map((u) => u?.stage) });
      return;
    }
    // Give up retrying — promote ACTIVE with warning so user isn't blocked by an Amazon outage
    const warn = `unknown_after_retries:${unknowns.map((u) => u?.stage).join(',')}`;
    await promoteActive(supabase, row, warn, { stages });
    return;
  }

  // All ok or warn → ACTIVE (warn-only is allowed)
  const warns = [fbaElig, hazmat, prep].filter((s) => s?.status === 'warn').map((s) => s!.stage);
  await promoteActive(supabase, row, warns.length ? `warn:${warns.join(',')}` : null, { stages });
}

async function processRow(supabase: SbClient, row: QueueRow): Promise<void> {
  switch (row.next_stage) {
    case 'await_fnsku':
      return processFnskuStage(supabase, row);
    case 'item_preview':
      return processItemPreviewStage(supabase, row);
    default:
      // C4 stages (inbound_dry_run, etc.) not yet implemented — defer.
      await deferRow(supabase, row, 5, `stage_not_implemented:${row.next_stage}`, false);
      return;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { withCronLock } = await import('../_shared/cron-lock.ts');
  const outcome = await withCronLock(supabase as any, 'listing-validation-worker-1m', 110, async () => {
    const { data: due, error } = await supabase
      .from('listing_validation_queue')
      .select('id, listing_id, user_id, asin, sku, marketplace, next_stage, attempts')
      .lte('next_run_at', new Date().toISOString())
      .order('next_run_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      throw new Error(`queue read failed: ${error.message}`);
    }

    const rows = (due ?? []) as QueueRow[];
    console.log(`[validation-worker] processing ${rows.length} rows`);

    for (const row of rows) {
      try {
        await processRow(supabase, row);
      } catch (e) {
        console.error('[validation-worker] row error', row.id, (e as Error).message);
        await deferRow(supabase, row, 10, `worker_error:${(e as Error).message}`, false);
      }
      await new Promise((r) => setTimeout(r, 800));
    }

    return { items_processed: rows.length, detail: { processed: rows.length } };
  });

  return new Response(JSON.stringify({ ok: outcome.status !== 'failed', ...outcome }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
