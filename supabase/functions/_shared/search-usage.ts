// Per-query counters for the search providers.
//
// Counted per QUERY rather than per search, deliberately. One Find Source run
// issues a UPC query and a title query, and the fallback pass adds another
// pair -- so a search is 1-4 CSE queries. Google CSE's free tier is 100
// QUERIES/day, so a search-based number would understate usage by up to 4x,
// in the direction that matters on a dashboard about approaching a limit.
//
// Observation only: gates nothing, changes no behaviour.

export type SearchProvider = 'google_cse' | 'serpapi';

/** Never throws -- observability must not break the thing it observes. */
export async function recordSearchApiCall(
  supabase: unknown,
  provider: SearchProvider,
  ok: boolean,
  empty: boolean,
  status: number | undefined,
): Promise<void> {
  if (!ok) {
    console.warn(`[search-usage] ${provider} failed status=${status ?? 'none'}`);
  }
  const client = supabase as { rpc?: (n: string, p: Record<string, unknown>) => Promise<{ error: unknown }> } | null;
  if (!client?.rpc) return;
  try {
    await client.rpc('record_search_api_call', {
      p_provider: provider,
      p_ok: ok,
      p_empty: empty,
      p_status: typeof status === 'number' ? status : null,
    });
  } catch (e) {
    console.warn('[search-usage] failed to record call:', (e as Error).message);
  }
}
