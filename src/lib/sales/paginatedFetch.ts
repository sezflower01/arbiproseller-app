/**
 * Shared paginated Supabase fetch helper.
 *
 * Supabase / PostgREST defaults to 1000 rows per request and silently
 * truncates — no error is raised. For YTD / large-period reports this
 * causes systematic undercounts in totals (revenue, fees, refunds,
 * promotions, etc.). Every Sales / P&L query that touches a large
 * table over a long window MUST go through this helper.
 *
 * Usage:
 *   const rows = await fetchAllPages<MyRow>(() =>
 *     supabase.from('sales_orders')
 *       .select('...')
 *       .eq('user_id', userId)
 *       .gte('order_date', start)
 *       .lte('order_date', end)
 *       .order('order_date', { ascending: true }) // recommended for stable paging
 *   , { label: 'sales_orders YTD' });
 *
 * IMPORTANT: do NOT chain `.range()` or `.limit()` on the builder you pass
 * in — this helper applies pagination itself.
 */

export interface FetchAllPagesOptions {
  pageSize?: number;     // default 1000 (Supabase max per request)
  hardCap?: number;      // default 100_000 (safety brake)
  label?: string;        // for log lines
}

export async function fetchAllPages<T = any>(
  buildQuery: () => any,
  opts: FetchAllPagesOptions = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const hardCap = opts.hardCap ?? 100_000;
  const label = opts.label ?? 'fetchAllPages';
  const all: T[] = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) {
      console.warn(`[${label}] page ${from}-${to} error:`, error.message);
      break;
    }
    const chunk = (data || []) as T[];
    all.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
    if (from >= hardCap) {
      console.warn(`[${label}] hit HARD_CAP ${hardCap}`);
      break;
    }
  }
  return all;
}
