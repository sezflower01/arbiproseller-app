// Cross-function Keepa rate gate. Coordinates via the keepa_daily_usage
// table's last_called_at claim -- the SAME table and claim pattern as
// repricer-sp-api-pricing's inline acquireKeepaGlobalSlot, so a new Keepa
// caller (e.g. check-seller-watchlist) shares awareness of the account's
// single 5-tokens/min plan instead of burning through it independently.
// Deliberately a standalone copy rather than importing repricer's inline
// version -- that function is live/critical and this avoids touching it.
const KEEPA_GUARD_LIMIT = 4; // plan: 5 tokens/min; guard at 4 to avoid 429 spikes
const KEEPA_GUARD_INTERVAL_MS = Math.ceil(60_000 / KEEPA_GUARD_LIMIT);

export async function acquireKeepaGlobalSlot(supabase: any): Promise<{ ok: boolean; waitSeconds: number }> {
  const usageDate = new Date().toISOString().split('T')[0];
  const now = new Date();
  const nowIso = now.toISOString();
  const guardThresholdIso = new Date(now.getTime() - KEEPA_GUARD_INTERVAL_MS).toISOString();

  const tryClaimExisting = async () => {
    const claimOld = await supabase
      .from('keepa_daily_usage')
      .update({ last_called_at: nowIso })
      .eq('usage_date', usageDate)
      .lt('last_called_at', guardThresholdIso)
      .select('usage_date')
      .maybeSingle();

    if (claimOld.data) return true;

    const claimNull = await supabase
      .from('keepa_daily_usage')
      .update({ last_called_at: nowIso })
      .eq('usage_date', usageDate)
      .is('last_called_at', null)
      .select('usage_date')
      .maybeSingle();

    return !!claimNull.data;
  };

  const insertAttempt = await supabase
    .from('keepa_daily_usage')
    .insert({ usage_date: usageDate, call_count: 0, last_called_at: nowIso })
    .select('usage_date')
    .maybeSingle();

  if (insertAttempt.data) {
    return { ok: true, waitSeconds: 0 };
  }

  if (insertAttempt.error && insertAttempt.error.code !== '23505') {
    console.warn('[Keepa] Failed to initialize usage row for guard:', insertAttempt.error);
    return { ok: false, waitSeconds: Math.ceil(KEEPA_GUARD_INTERVAL_MS / 1000) };
  }

  const claimed = await tryClaimExisting();
  if (claimed) {
    return { ok: true, waitSeconds: 0 };
  }

  const { data: latest } = await supabase
    .from('keepa_daily_usage')
    .select('last_called_at')
    .eq('usage_date', usageDate)
    .maybeSingle();

  const elapsedMs = latest?.last_called_at ? now.getTime() - new Date(latest.last_called_at).getTime() : 0;
  const waitMs = Math.max(1_000, KEEPA_GUARD_INTERVAL_MS - Math.max(0, elapsedMs));

  return { ok: false, waitSeconds: Math.ceil(waitMs / 1000) };
}
