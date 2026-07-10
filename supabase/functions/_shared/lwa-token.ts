// Shared LWA token exchanger.
// Prefers per-user stored LWA Client ID/Secret (from user_spapi_credentials, decrypted via
// get_spapi_credentials_decrypted) so that refresh tokens minted under the user's own
// Develop-Apps client work on EVERY marketplace (US/CA/MX/BR/EU/FE), not just the marketplace
// whose refresh token happens to match the global env LWA_CLIENT_ID/SECRET.
//
// Fallback order:
//   1. User-stored LWA app  (per-user, exact match for their refresh_token)
//   2. Env LWA_CLIENT_ID / LWA_CLIENT_SECRET  (preferred shared app)
//   3. Env SPAPI_LWA_CLIENT_ID / SPAPI_LWA_CLIENT_SECRET (legacy OAuth app)
// This matters because older marketplace authorizations may have been minted under the
// SPAPI_* app while newer code preferred LWA_* or user-stored app credentials.

const _userLwaCache = new Map<string, { id: string; secret: string; refresh?: string | null } | null>();
// Sticky per-(user, refreshToken) memo: once a source works, prefer it and skip the failing one.
// Also remembers sources that have already failed with unauthorized_client so we never retry them.
const _winningSource = new Map<string, string>();          // key -> winning source name
const _deadSources = new Map<string, Set<string>>();       // key -> set of sources known to fail
const _sourceKey = (userId: string | null | undefined, refresh: string) => `${userId ?? 'anon'}::${refresh.slice(0, 24)}`;

async function getUserLwaApp(
  supabase: any,
  userId: string | null | undefined,
): Promise<{ id: string; secret: string; refresh?: string | null } | null> {
  if (!userId) return null;
  if (_userLwaCache.has(userId)) return _userLwaCache.get(userId)!;
  try {
    const { data, error } = await supabase.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
    if (error) {
      console.warn('[lwa-token] decrypt RPC failed:', error.message);
      _userLwaCache.set(userId, null);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.lwa_client_id && row?.lwa_client_secret) {
      const app = {
        id: row.lwa_client_id as string,
        secret: row.lwa_client_secret as string,
        refresh: row.refresh_token as string | null,
      };
      _userLwaCache.set(userId, app);
      return app;
    }
  } catch (e) {
    console.warn('[lwa-token] exception:', (e as Error).message);
  }
  _userLwaCache.set(userId, null);
  return null;
}

export async function exchangeLwaToken(
  refreshToken: string,
  supabase?: any,
  userId?: string | null,
): Promise<string> {
  const candidates: Array<{ refresh: string; id: string; secret: string; source: string }> = [];
  const addCandidate = (refresh: string | null | undefined, id: string | null | undefined, secret: string | null | undefined, source: string) => {
    if (!refresh || !id || !secret) return;
    if (candidates.some(c => c.refresh === refresh && c.id === id && c.secret === secret)) return;
    candidates.push({ refresh, id, secret, source });
  };

  if (supabase && userId) {
    const app = await getUserLwaApp(supabase, userId);
    if (app) {
      addCandidate(refreshToken, app.id, app.secret, 'user_stored_auth_token');
      addCandidate(app.refresh, app.id, app.secret, 'user_stored_own_token');
    }
  }
  addCandidate(refreshToken, Deno.env.get('LWA_CLIENT_ID'), Deno.env.get('LWA_CLIENT_SECRET'), 'env_lwa_auth_token');
  addCandidate(refreshToken, Deno.env.get('SPAPI_LWA_CLIENT_ID'), Deno.env.get('SPAPI_LWA_CLIENT_SECRET'), 'env_spapi_lwa_auth_token');
  addCandidate(Deno.env.get('SPAPI_REFRESH_TOKEN'), Deno.env.get('SPAPI_LWA_CLIENT_ID'), Deno.env.get('SPAPI_LWA_CLIENT_SECRET'), 'env_spapi_default_token');

  if (candidates.length === 0) {
    throw new Error('LWA credentials not configured');
  }

  // Apply sticky memo: skip known-dead sources, prioritize known-winner.
  const memoKey = _sourceKey(userId, refreshToken);
  const dead = _deadSources.get(memoKey);
  const winner = _winningSource.get(memoKey);
  let ordered = candidates.filter(c => !dead?.has(c.source));
  if (winner) {
    ordered.sort((a, b) => (a.source === winner ? -1 : b.source === winner ? 1 : 0));
  }
  if (ordered.length === 0) ordered = candidates; // safety net

  const doFetch = async (rt: string, cid: string, secret: string) => {
    return await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt,
        client_id: cid,
        client_secret: secret,
      }),
    });
  };

  const attemptedSources: string[] = [];
  let lastErrorText = '';
  for (const candidate of ordered) {
    attemptedSources.push(candidate.source);
    const resp = await doFetch(candidate.refresh, candidate.id, candidate.secret);
    if (resp.ok) {
      // Remember the winner so future calls skip the failing source silently.
      if (_winningSource.get(memoKey) !== candidate.source) {
        _winningSource.set(memoKey, candidate.source);
      }
      const json = await resp.json();
      return json.access_token as string;
    }

    lastErrorText = await resp.text().catch(() => '');
    // Only log on the very first time we see a failure for this (user, token, source).
    const wasKnownDead = dead?.has(candidate.source) ?? false;
    if (!wasKnownDead) {
      // Downgrade to warn — we have a working fallback path.
      console.warn(`[lwa-token] source=${candidate.source} unauthorized for user=${userId ?? 'n/a'} (will skip on future calls): ${lastErrorText.slice(0, 200)}`);
    }

    // App/token ownership mismatch → mark dead and try next candidate.
    if (lastErrorText.includes('unauthorized_client')) {
      if (!_deadSources.has(memoKey)) _deadSources.set(memoKey, new Set());
      _deadSources.get(memoKey)!.add(candidate.source);
      continue;
    }
    // Other errors (400/429/5xx) → don't mask them by trying another app.
    break;
  }

  throw new Error(`Failed to get access token (attempted=${attemptedSources.join('>') || 'none'}): ${lastErrorText.slice(0, 200)}`);
}
