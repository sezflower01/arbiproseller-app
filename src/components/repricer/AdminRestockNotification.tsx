import { useState, useEffect, useCallback, useRef } from 'react';
import { PackageCheck, RefreshCw, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

type RestockEventType =
  | 'detected'
  | 'snapback_applied'
  | 'skipped_stale'
  | 'skipped_competitive'
  | 'completed'
  | 'expired'
  | 'blocked_floor';

interface RestockEvent {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  oldPrice: number | null;
  newPrice: number | null;
  anchor: string | null;
  eventType: RestockEventType;
  reason: string;
  timestamp: string;
  seen: boolean;
}

function parseGuards(guards: string[]): { eventType: RestockEventType; anchor: string | null } {
  let eventType: RestockEventType = 'detected';
  let anchor: string | null = null;

  for (const g of guards) {
    if (g.startsWith('restock_anchor=')) anchor = g.replace('restock_anchor=', '');
    if (g === 'restock_snapback_applied') eventType = 'snapback_applied';
    if (g === 'restock_snapback_skipped_stale_anchor') eventType = 'skipped_stale';
    if (g === 'restock_snapback_skipped_already_competitive') eventType = 'skipped_competitive';
    if (g === 'restock_reentry_completed') eventType = 'completed';
    if (g === 'restock_reentry_expired') eventType = 'expired';
    if (g === 'restock_snapback_blocked_floor') eventType = 'blocked_floor';
  }

  return { eventType, anchor };
}

const ANCHOR_DISPLAY: Record<string, string> = {
  buy_box: 'Buy Box',
  lowest_fba: 'Lowest FBA',
  lowest_filtered: 'Lowest Filtered',
  lowest_overall: 'Lowest Overall',
};

const EVENT_LABELS: Record<RestockEventType, { label: string; color: string }> = {
  detected: { label: 'Detected', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  snapback_applied: { label: 'Snap-back Applied', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  skipped_stale: { label: 'Skipped (Stale)', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  skipped_competitive: { label: 'Already Competitive', color: 'bg-sky-500/20 text-sky-400 border-sky-500/30' },
  completed: { label: 'Completed', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  expired: { label: 'Expired', color: 'bg-muted text-muted-foreground border-border' },
  blocked_floor: { label: 'Blocked (Floor)', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

const ALL_FILTERS: RestockEventType[] = ['detected', 'snapback_applied', 'skipped_stale', 'skipped_competitive', 'completed', 'expired', 'blocked_floor'];

function timeAgo(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatTimeFull(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const AdminRestockNotification = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [events, setEvents] = useState<RestockEvent[]>([]);
  const [open, setOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<RestockEventType>>(new Set(ALL_FILTERS));
  const [loading, setLoading] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    supabase.rpc('has_role', { _user_id: user.id, _role: 'admin' }).then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  const fetchEvents = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      // Scope to last 7 days so the (created_at DESC) index is used.
      // Without this, both ILIKE-OR and JSONB @> do a full scan of the
      // ~900k-row repricer_price_actions table and hit statement timeout (500).
      const sinceISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const [{ data: d1 }, { data: d2 }] = await Promise.all([
        supabase
          .from('repricer_price_actions')
          .select('id, asin, sku, marketplace, old_price, new_price, reason, intelligence_factors, created_at')
          .gte('created_at', sinceISO)
          .or('reason.ilike.%restock%,reason.ilike.%snap-back%,reason.ilike.%snap_back%')
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('repricer_price_actions')
          .select('id, asin, sku, marketplace, old_price, new_price, reason, intelligence_factors, created_at')
          .gte('created_at', sinceISO)
          .filter('intelligence_factors', 'cs', '{"guardsApplied":["restock_reentry_detected"]}')
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      const seen = new Set<string>();
      const unique = [...(d1 || []), ...(d2 || [])].filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });

      const parsed: RestockEvent[] = unique.map(row => {
        const factors = row.intelligence_factors as any;
        const guards: string[] = factors?.guardsApplied || [];
        const { eventType, anchor } = parseGuards(guards);
        return {
          id: row.id, asin: row.asin, sku: row.sku, marketplace: row.marketplace,
          oldPrice: row.old_price, newPrice: row.new_price, anchor, eventType,
          reason: row.reason || '', timestamp: row.created_at,
          seen: seenIdsRef.current.has(row.id),
        };
      });

      parsed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setEvents(parsed);
    } catch (err) {
      console.error('[AdminRestockNotification] unexpected error:', err);
    }
    setLoading(false);
  }, [isAdmin]);

  const [pendingRestocks, setPendingRestocks] = useState<{ asin: string; marketplace: string; restock_reentry_at: string }[]>([]);

  const fetchPending = useCallback(async () => {
    if (!isAdmin) return;
    const { data } = await supabase
      .from('repricer_assignments')
      .select('asin, marketplace, restock_reentry_at')
      .not('restock_reentry_at', 'is', null)
      .limit(20);
    setPendingRestocks(data || []);
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchEvents();
    fetchPending();
    const interval = setInterval(() => { fetchEvents(); fetchPending(); }, 30000);
    return () => clearInterval(interval);
  }, [isAdmin, fetchEvents, fetchPending]);

  const markAllSeen = () => {
    events.forEach(e => seenIdsRef.current.add(e.id));
    setEvents(prev => prev.map(e => ({ ...e, seen: true })));
  };

  useEffect(() => {
    if (open) markAllSeen();
  }, [open]);

  if (!isAdmin) return null;

  const unseenCount = events.filter(e => !e.seen).length + pendingRestocks.length;
  const filtered = events.filter(e => activeFilters.has(e.eventType));

  const toggleFilter = (f: RestockEventType) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  const handleAsinClick = (asin: string) => {
    setOpen(false);
    navigate(`/tools/repricer?search=${asin}`);
  };

  return (
    <div className="fixed bottom-4 left-20 z-50">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              'relative rounded-full h-10 w-10 border-border bg-background shadow-lg',
              unseenCount > 0 && 'border-emerald-500/50 animate-pulse'
            )}
          >
            <PackageCheck className="h-5 w-5 text-emerald-500" />
            {unseenCount > 0 && (
              <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-emerald-500 text-[10px] font-bold text-white flex items-center justify-center">
                {unseenCount > 9 ? '9+' : unseenCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-[440px] p-0 bg-background border-border" side="top" align="start">
          {/* Header */}
          <div className="flex items-center justify-between p-3 border-b border-border">
            <div className="flex items-center gap-2">
              <PackageCheck className="h-4 w-4 text-emerald-500" />
              <span className="font-semibold text-sm text-foreground">Restock Events</span>
              {pendingRestocks.length > 0 && (
                <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
                  {pendingRestocks.length} pending
                </Badge>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { fetchEvents(); fetchPending(); }}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-border">
            {ALL_FILTERS.map(f => (
              <button
                key={f}
                onClick={() => toggleFilter(f)}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded-full border transition-all',
                  activeFilters.has(f) ? EVENT_LABELS[f].color : 'bg-muted/30 text-muted-foreground/50 border-transparent'
                )}
              >
                {EVENT_LABELS[f].label}
              </button>
            ))}
          </div>

          {/* Pending restocks */}
          {pendingRestocks.length > 0 && (
            <div className="px-3 py-2 border-b border-border bg-amber-500/5">
              <div className="text-[10px] font-semibold text-amber-400 mb-1">⏳ Awaiting Snap-back</div>
              {pendingRestocks.map((p, i) => (
                <div key={i} className="text-[11px] text-muted-foreground flex items-center gap-2 py-0.5">
                  <button
                    onClick={() => handleAsinClick(p.asin)}
                    className="font-mono text-foreground hover:text-emerald-400 hover:underline cursor-pointer transition-colors"
                  >
                    {p.asin}
                  </button>
                  <Badge variant="outline" className="text-[9px] h-4">{p.marketplace}</Badge>
                  <span className="text-muted-foreground/60" title={formatTimeFull(p.restock_reentry_at)}>
                    flagged {timeAgo(p.restock_reentry_at)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Events list */}
          <ScrollArea className="max-h-[350px]">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No restock events yet.
                <br />
                <span className="text-xs">Events appear when ASINs transition from 0 → positive stock.</span>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map(event => (
                  <div key={event.id} className="px-3 py-2.5 hover:bg-muted/30 transition-colors">
                    {/* Row 1: ASIN + time */}
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleAsinClick(event.asin)}
                          className="font-mono text-xs font-semibold text-foreground hover:text-emerald-400 hover:underline cursor-pointer transition-colors flex items-center gap-1"
                        >
                          {event.asin}
                          <ExternalLink className="h-2.5 w-2.5 opacity-50" />
                        </button>
                        <Badge variant="outline" className="text-[9px] h-4">{event.marketplace}</Badge>
                        {event.sku && <span className="text-[9px] text-muted-foreground/50 font-mono">{event.sku}</span>}
                      </div>
                      <span className="text-[10px] text-muted-foreground" title={formatTimeFull(event.timestamp)}>
                        {timeAgo(event.timestamp)}
                      </span>
                    </div>

                    {/* Row 2: Event badge + anchor */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className={cn('text-[10px] px-2 py-0.5 rounded-full border', EVENT_LABELS[event.eventType].color)}>
                        {EVENT_LABELS[event.eventType].label}
                      </span>
                      {event.anchor && (
                        <span className="text-[10px] text-muted-foreground">
                          anchor: <span className="text-foreground font-semibold">{ANCHOR_DISPLAY[event.anchor] || event.anchor}</span>
                        </span>
                      )}
                    </div>

                    {/* Row 3: Price change */}
                    {(event.oldPrice != null || event.newPrice != null) && (
                      <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                        {event.oldPrice != null && <span className="font-mono">${event.oldPrice.toFixed(2)}</span>}
                        {event.oldPrice != null && event.newPrice != null && <span className="mx-0.5">→</span>}
                        {event.newPrice != null && (
                          <span className={cn(
                            'font-mono font-semibold',
                            event.newPrice < (event.oldPrice || 0) ? 'text-red-400' : 'text-emerald-400'
                          )}>
                            ${event.newPrice.toFixed(2)}
                          </span>
                        )}
                        {event.oldPrice != null && event.newPrice != null && event.oldPrice !== 0 && (
                          <span className="text-muted-foreground/50 text-[9px] ml-1">
                            ({((event.newPrice! - event.oldPrice) / event.oldPrice * 100).toFixed(1)}%)
                          </span>
                        )}
                      </div>
                    )}

                    {/* Row 4: Reason */}
                    {event.reason && (
                      <div className="text-[10px] text-muted-foreground/60 mt-0.5 line-clamp-2">{event.reason}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default AdminRestockNotification;
