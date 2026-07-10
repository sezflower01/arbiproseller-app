/**
 * Tiny badge showing the age of the cached Sales Report stat for the
 * currently selected period+mode.
 *
 * States:
 *   - "Updating…"          → a background revalidation is in flight
 *   - "Updated just now"   → < 5s after a fresh write
 *   - "Cached 42s ago"     → otherwise
 *   - hidden               → no cache entry exists yet (initial load)
 */
import { useEffect, useState } from "react";
import { RefreshCw, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import * as periodStatsCache from "@/lib/sales/periodStatsCache";

interface Props {
  cacheKey: string | null;
  isRefreshing: boolean;
  /** bumped externally when the cache changes; forces re-render */
  cacheTick: number;
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 5) return "Updated just now";
  if (s < 60) return `Cached ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Cached ${m}m ago`;
  const h = Math.floor(m / 60);
  return `Cached ${h}h ago`;
}

export default function CacheAgeBadge({ cacheKey, isRefreshing, cacheTick }: Props) {
  // Re-render every 10s so "42s ago" stays accurate.
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  if (!cacheKey) return null;
  const age = periodStatsCache.getCacheAge(cacheKey);
  if (age == null && !isRefreshing) return null;

  // Touch cacheTick so React tracks it as a dep without lint complaint.
  void cacheTick;

  const label = isRefreshing ? "Updating…" : formatAge(age ?? 0);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] text-muted-foreground px-2 py-0.5 rounded-md bg-muted/40",
        isRefreshing && "text-primary"
      )}
      title={isRefreshing ? "Refreshing in the background" : "Showing cached result; will refresh when stale"}
    >
      {isRefreshing ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <Clock className="h-3 w-3" />
      )}
      {label}
    </span>
  );
}
