import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, Check, Clock, ExternalLink, User, Server, RefreshCw, Trash2, Activity, Database, Users, TrendingUp, Gauge, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { isDbPressureActive, getBackoffMultiplier } from '@/hooks/use-db-pressure';

interface ErrorReport {
  id: string;
  user_email: string | null;
  error_message: string;
  error_context: string | null;
  page_url: string | null;
  resolved: boolean;
  created_at: string;
  source: 'frontend' | 'repricer' | 'edge_function';
  user_id_ref?: string;
  isInfrastructure?: boolean;
  isAmazonThrottle?: boolean;
}

interface InfraMetrics {
  activeUsers1h: number;
  totalErrors4h: number;
  timeoutErrors4h: number;
  repricerErrors4h: number;
  edgeFnErrors4h: number;
  pressureActive: boolean;
  backoffMultiplier: number;
  severity: 'healthy' | 'elevated' | 'critical';
  recommendation: string | null;
}

// Real infra errors — DB / edge fn / network layer. These SHOULD raise severity
// and can indicate a genuine Supabase compute problem.
const INFRA_ERROR_PATTERNS = [
  'timeout', '504', '503', '502',
  'connection timed out', 'upstream request timeout',
  'failed to fetch', 'connection refused',
  'too many connections', 'remaining connection slots',
  'could not serialize access', 'deadlock detected',
  'out of memory', 'disk full',
];

// Amazon SP-API rate limits — external, self-recovering (Retry-After header),
// NOT an infrastructure problem. Kept in its own bucket so it doesn't trigger
// the "upgrade Supabase compute" recommendation.
const AMAZON_THROTTLE_PATTERNS = [
  'rate limit exceeded',
  'retry after',
  'quotaexceeded',
  'sp-api throttl',
  'throttled by amazon',
  'x-amzn-ratelimit',
];

function isAmazonThrottleError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return AMAZON_THROTTLE_PATTERNS.some(p => lower.includes(p));
}

function isInfrastructureError(msg: string): boolean {
  if (isAmazonThrottleError(msg)) return false; // Amazon throttles are NOT infra
  const lower = msg.toLowerCase();
  return INFRA_ERROR_PATTERNS.some(p => lower.includes(p));
}

const AdminErrorNotification = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [errors, setErrors] = useState<ErrorReport[]>([]);
  const [open, setOpen] = useState(false);
  const [userEmails, setUserEmails] = useState<Record<string, string>>({});
  const [infraMetrics, setInfraMetrics] = useState<InfraMetrics>({
    activeUsers1h: 0,
    totalErrors4h: 0,
    timeoutErrors4h: 0,
    repricerErrors4h: 0,
    edgeFnErrors4h: 0,
    pressureActive: false,
    backoffMultiplier: 1,
    severity: 'healthy',
    recommendation: null,
  });

  useEffect(() => {
    if (!user) return;
    supabase.rpc('has_role', { _user_id: user.id, _role: 'admin' }).then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  // Resolve user_ids to emails for display
  const resolveUserEmails = useCallback(async (userIds: string[]) => {
    const unknownIds = userIds.filter(id => id && !userEmails[id]);
    if (unknownIds.length === 0) return;
    
    const { data } = await supabase
      .from('profiles' as any)
      .select('id, email')
      .in('id', unknownIds);
    
    if (!data) {
      const map: Record<string, string> = { ...userEmails };
      unknownIds.forEach(id => { map[id] = id.slice(0, 8) + '…'; });
      setUserEmails(map);
      return;
    }
    
    const map: Record<string, string> = { ...userEmails };
    (data as any[]).forEach((p: any) => { map[p.id] = p.email || p.id.slice(0, 8) + '…'; });
    unknownIds.forEach(id => { if (!map[id]) map[id] = id.slice(0, 8) + '…'; });
    setUserEmails(map);
  }, [userEmails]);

  const fetchErrors = useCallback(async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    // 1. Frontend error reports (all users, last 4 hours — match badge window)
    const { data: frontendErrors } = await supabase
      .from('error_reports')
      .select('id, user_id, user_email, error_message, error_context, page_url, resolved, created_at')
      .eq('resolved', false)
      .gte('created_at', fourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(50);

    const feList: ErrorReport[] = (frontendErrors || []).map(e => ({
      ...e,
      source: 'frontend' as const,
      user_id_ref: (e as any).user_id,
      isInfrastructure: isInfrastructureError(e.error_message || ''),
      isAmazonThrottle: isAmazonThrottleError(e.error_message || ''),
    }));

    // 2. Repricer backend errors (all users, last 4 hours)
    const { data: repricerErrors } = await supabase
      .from('repricer_price_actions')
      .select('id, user_id, asin, marketplace, reason, created_at')
      .eq('action_type', 'price_change_failed')
      .gte('created_at', fourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(50);

    // Group repricer errors by user_id + reason pattern
    const repricerGroups = new Map<string, { count: number; asins: string[]; latest: any; userId: string }>();
    for (const r of repricerErrors || []) {
      const reasonKey = `${r.user_id}::${(r.reason || '').slice(0, 80)}`;
      const existing = repricerGroups.get(reasonKey);
      if (existing) {
        existing.count++;
        if (existing.asins.length < 3) existing.asins.push(r.asin);
      } else {
        repricerGroups.set(reasonKey, { count: 1, asins: [r.asin], latest: r, userId: r.user_id });
      }
    }

    const repricerList: ErrorReport[] = [];
    for (const [, group] of repricerGroups) {
      const r = group.latest;
      const msg = r.reason || 'Unknown error';
      repricerList.push({
        id: r.id,
        user_email: null,
        error_message: `[Repricer] ${msg}`,
        error_context: `${group.count}× in 4h | ASINs: ${group.asins.join(', ')}${group.count > 3 ? ` +${group.count - 3} more` : ''} | ${r.marketplace}`,
        page_url: '/tools/repricer',
        resolved: false,
        created_at: r.created_at,
        source: 'repricer',
        user_id_ref: group.userId,
        isInfrastructure: isInfrastructureError(msg),
        isAmazonThrottle: isAmazonThrottleError(msg),
      });
    }

    // 3. Edge function errors (all users, last 4 hours) 
    const { data: edgeFnErrors } = await supabase
      .from('error_logs')
      .select('id, user_id, module, message, timestamp')
      .gte('timestamp', fourHoursAgo)
      .order('timestamp', { ascending: false })
      .limit(20);

    const efGroups = new Map<string, { count: number; latest: any; userId: string | null }>();
    for (const e of edgeFnErrors || []) {
      const key = `${e.module}::${(e.message || '').slice(0, 60)}`;
      const existing = efGroups.get(key);
      if (existing) {
        existing.count++;
      } else {
        efGroups.set(key, { count: 1, latest: e, userId: e.user_id });
      }
    }

    const efList: ErrorReport[] = [];
    for (const [, group] of efGroups) {
      const e = group.latest;
      const msg = e.message || 'Unknown error';
      efList.push({
        id: e.id,
        user_email: null,
        error_message: `[${e.module || 'Edge Function'}] ${msg}`,
        error_context: `${group.count}× in 4h`,
        page_url: null,
        resolved: false,
        created_at: e.timestamp,
        source: 'edge_function',
        user_id_ref: group.userId,
        isInfrastructure: isInfrastructureError(msg),
        isAmazonThrottle: isAmazonThrottleError(msg),
      });
    }

    const allErrors = [...repricerList, ...feList, ...efList]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setErrors(allErrors);

    // --- Infrastructure Metrics ---
    // Count distinct active users in the last hour via RPC (was a 39k-call/day full table scan).
    const { data: activeCount } = await supabase.rpc('count_active_repricer_users_1h' as any);
    const uniqueActiveUsers = typeof activeCount === 'number' ? activeCount : 0;

    // Count timeout/infrastructure errors
    const totalErrors = allErrors.length;
    const timeoutCount = allErrors.filter(e => e.isInfrastructure).length;
    const pressureActive = isDbPressureActive();
    const backoff = getBackoffMultiplier();

    // Severity calculation
    let severity: InfraMetrics['severity'] = 'healthy';
    let recommendation: string | null = null;

    if (timeoutCount >= 5 || pressureActive) {
      severity = 'critical';
      recommendation = '⚠️ High database pressure detected — consider upgrading Supabase compute tier (Settings → Compute Add-ons) to handle current load.';
    } else if (timeoutCount >= 2 || totalErrors >= 8) {
      severity = 'elevated';
      recommendation = '📊 Elevated error rate — monitor closely. If timeouts persist, upgrading from Micro to Small compute may help.';
    }

    setInfraMetrics({
      activeUsers1h: uniqueActiveUsers,
      totalErrors4h: totalErrors,
      timeoutErrors4h: timeoutCount,
      repricerErrors4h: repricerList.length,
      edgeFnErrors4h: efList.length,
      pressureActive,
      backoffMultiplier: backoff,
      severity,
      recommendation,
    });

    // Resolve user emails
    const allUserIds = allErrors
      .map(e => e.user_id_ref)
      .filter((id): id is string => !!id);
    if (allUserIds.length > 0) {
      resolveUserEmails([...new Set(allUserIds)]);
    }
  }, [resolveUserEmails]);

  // Throttled refetch — realtime bursts (failed-price-action storms) only trigger one refetch per 30s.
  const lastFetchRef = useRef(0);
  const throttledFetch = useCallback(() => {
    const now = Date.now();
    if (now - lastFetchRef.current < 30_000) return;
    lastFetchRef.current = now;
    fetchErrors();
  }, [fetchErrors]);

  useEffect(() => {
    if (!isAdmin) return;
    if (document.hidden) return; // initial gate; visibility handler will run it
    fetchErrors();
    lastFetchRef.current = Date.now();
    // 60s → 300s: this panel triggers an admin-only RPC + a few small queries; 5min is plenty.
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchErrors();
      lastFetchRef.current = Date.now();
    }, 300_000);
    const onVis = () => {
      if (!document.hidden && Date.now() - lastFetchRef.current > 60_000) {
        fetchErrors();
        lastFetchRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [isAdmin, fetchErrors]);

  useEffect(() => {
    if (!isAdmin) return;
    const ch = supabase
      .channel('admin-error-reports')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'error_reports' }, () => throttledFetch())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [isAdmin, throttledFetch]);

  useEffect(() => {
    if (!isAdmin) return;
    const ch = supabase
      .channel('admin-repricer-errors')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'repricer_price_actions',
        filter: 'action_type=eq.price_change_failed',
      }, () => throttledFetch())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [isAdmin, throttledFetch]);

  const resolveError = async (id: string, source: string) => {
    if (!user) return;
    if (source === 'frontend') {
      await supabase
        .from('error_reports')
        .update({ resolved: true, resolved_by: user.id, resolved_at: new Date().toISOString() })
        .eq('id', id);
    }
    setErrors(prev => prev.filter(e => e.id !== id));
  };

  if (!isAdmin) return null;

  const timeAgo = (iso: string) => {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  const sourceIcon = (source: string) => {
    switch (source) {
      case 'repricer': return <Server className="h-3 w-3" />;
      case 'edge_function': return <Server className="h-3 w-3" />;
      default: return <User className="h-3 w-3" />;
    }
  };

  const sourceColor = (source: string) => {
    switch (source) {
      case 'repricer': return 'text-orange-600 bg-orange-50 border-orange-200';
      case 'edge_function': return 'text-purple-600 bg-purple-50 border-purple-200';
      default: return 'text-destructive bg-destructive/10 border-destructive/20';
    }
  };

  const severityColor = infraMetrics.severity === 'critical'
    ? 'text-red-400 bg-red-500/10 border-red-500/30'
    : infraMetrics.severity === 'elevated'
    ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
    : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';

  const severityLabel = infraMetrics.severity === 'critical'
    ? '🔴 Critical'
    : infraMetrics.severity === 'elevated'
    ? '🟡 Elevated'
    : '🟢 Healthy';

  const infraErrors = errors.filter(e => e.isInfrastructure);
  const amazonThrottleErrors = errors.filter(e => e.isAmazonThrottle);
  const appErrors = errors.filter(e => !e.isInfrastructure && !e.isAmazonThrottle);

  return (
    <div className="fixed top-4 left-40 z-[60]">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="relative flex items-center gap-1.5 rounded-full bg-card border border-border shadow-md px-3 py-1.5 hover:bg-accent transition-colors">
            {infraMetrics.severity === 'critical' ? (
              <Activity className="h-4 w-4 text-red-500 animate-pulse" />
            ) : infraMetrics.severity === 'elevated' ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            )}
            {errors.length > 0 && (
              <span className={`absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full text-[10px] font-bold flex items-center justify-center ${
                infraMetrics.severity === 'critical' ? 'bg-red-500 text-white animate-pulse' : 'bg-destructive text-destructive-foreground'
              }`}>
                {errors.length}
              </span>
            )}
            <span className="text-xs font-medium text-foreground">System</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[480px] p-0" align="start" sideOffset={8}>
          {/* Header */}
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <h4 className="font-semibold text-sm text-foreground">System Health & Errors</h4>
              <p className="text-xs text-muted-foreground">
                {errors.length} errors · {infraMetrics.activeUsers1h} active user{infraMetrics.activeUsers1h !== 1 ? 's' : ''} (1h)
              </p>
            </div>
            <div className="flex items-center gap-1">
              {errors.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    const frontendIds = errors.filter(e => e.source === 'frontend').map(e => e.id);
                    if (frontendIds.length > 0 && user) {
                      await supabase
                        .from('error_reports')
                        .update({ resolved: true, resolved_by: user.id, resolved_at: new Date().toISOString() })
                        .in('id', frontendIds);
                    }
                    setErrors([]);
                  }}
                  title="Clear all errors"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Clear All
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={fetchErrors} title="Refresh">
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-primary hover:text-primary gap-1"
                onClick={() => { setOpen(false); navigate('/tools/error-log'); }}
                title="View full error log"
              >
                View All <ArrowRight className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {/* Infrastructure Status Panel */}
          <div className={`mx-3 mt-3 mb-2 rounded-lg border p-3 ${severityColor}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4" />
                <span className="text-xs font-bold">Infrastructure Status</span>
              </div>
              <Badge variant="outline" className={`text-[10px] ${severityColor}`}>
                {severityLabel}
              </Badge>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <div className="flex items-center justify-center gap-1 mb-0.5">
                  <Users className="h-3 w-3 opacity-70" />
                </div>
                <div className="text-sm font-bold">{infraMetrics.activeUsers1h}</div>
                <div className="text-[9px] opacity-70">Active Users</div>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1 mb-0.5">
                  <Database className="h-3 w-3 opacity-70" />
                </div>
                <div className="text-sm font-bold">{infraMetrics.timeoutErrors4h}</div>
                <div className="text-[9px] opacity-70">Timeouts (4h)</div>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1 mb-0.5">
                  <Server className="h-3 w-3 opacity-70" />
                </div>
                <div className="text-sm font-bold">{infraMetrics.totalErrors4h}</div>
                <div className="text-[9px] opacity-70">Total Errors</div>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1 mb-0.5">
                  <TrendingUp className="h-3 w-3 opacity-70" />
                </div>
                <div className="text-sm font-bold">{infraMetrics.backoffMultiplier}×</div>
                <div className="text-[9px] opacity-70">Backoff</div>
              </div>
            </div>
            {infraMetrics.pressureActive && (
              <div className="mt-2 text-[10px] font-medium bg-red-500/20 rounded px-2 py-1">
                ⚡ DB Pressure Mode ACTIVE — optional queries suspended, polling intervals increased
              </div>
            )}
            {infraMetrics.recommendation && (
              <div className="mt-2 text-[10px] leading-relaxed bg-black/10 rounded px-2 py-1">
                {infraMetrics.recommendation}
              </div>
            )}
          </div>

          {/* Error List */}
          {errors.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No errors reported 🎉</div>
          ) : (
            <ScrollArea className="max-h-[400px]">
              <div className="divide-y divide-border">
                {/* Infrastructure errors first */}
                {infraErrors.length > 0 && (
                  <div className="px-4 py-2 bg-red-500/5">
                    <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">
                      🏗️ Infrastructure ({infraErrors.length}) — May require Supabase upgrade
                    </span>
                  </div>
                )}
                {infraErrors.map((e) => renderError(e, timeAgo, sourceIcon, sourceColor, userEmails, resolveError))}
                
                {/* Amazon SP-API rate limits — external, self-recovering, informational only */}
                {amazonThrottleErrors.length > 0 && (
                  <div className="px-4 py-2 bg-sky-500/5">
                    <span className="text-[10px] font-bold text-sky-400 uppercase tracking-wider">
                      🛒 Amazon Rate Limits ({amazonThrottleErrors.length}) — External throttling, self-recovers via Retry-After. No action needed.
                    </span>
                  </div>
                )}
                {amazonThrottleErrors.map((e) => renderError(e, timeAgo, sourceIcon, sourceColor, userEmails, resolveError))}
                
                {/* Application errors */}
                {appErrors.length > 0 && (
                  <div className="px-4 py-2 bg-muted/30">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                      📋 Application ({appErrors.length}) — Code / API issues
                    </span>
                  </div>
                )}
                {appErrors.map((e) => renderError(e, timeAgo, sourceIcon, sourceColor, userEmails, resolveError))}
              </div>
            </ScrollArea>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
};

function renderError(
  e: ErrorReport,
  timeAgo: (iso: string) => string,
  sourceIcon: (source: string) => React.ReactNode,
  sourceColor: (source: string) => string,
  userEmails: Record<string, string>,
  resolveError: (id: string, source: string) => void,
) {
  return (
    <div key={e.id} className="px-4 py-3 hover:bg-accent/50 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <Badge variant="outline" className={`text-[10px] h-4 px-1.5 gap-0.5 ${sourceColor(e.source)}`}>
              {sourceIcon(e.source)}
              {e.source === 'frontend' ? 'UI' : e.source === 'repricer' ? 'Repricer' : 'Backend'}
            </Badge>
            {e.isInfrastructure && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 gap-0.5 text-red-500 bg-red-500/10 border-red-500/20">
                <Database className="h-2.5 w-2.5" />
                Infra
              </Badge>
            )}
            {(e.user_email || (e.user_id_ref && userEmails[e.user_id_ref])) && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 gap-0.5">
                <User className="h-2.5 w-2.5" />
                {e.user_email || userEmails[e.user_id_ref!] || ''}
              </Badge>
            )}
          </div>
          <p className="text-xs font-medium text-foreground line-clamp-2 break-all">{e.error_message}</p>
          {e.error_context && (
            <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-3 break-all bg-muted/50 rounded px-1.5 py-1">{e.error_context}</p>
          )}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {e.page_url && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 gap-0.5">
                <ExternalLink className="h-2.5 w-2.5" />
                {e.page_url}
              </Badge>
            )}
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <Clock className="h-2.5 w-2.5" />
              {timeAgo(e.created_at)}
            </span>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
          onClick={() => resolveError(e.id, e.source)}
          title="Dismiss"
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default AdminErrorNotification;
