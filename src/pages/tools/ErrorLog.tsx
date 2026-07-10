import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle, Server, User, Database, RefreshCw, Clock, CheckCircle2,
  Wifi, ShieldAlert, Bug, Gauge, Activity, Trash2, ChevronDown, ChevronUp,
  ExternalLink, Users, HeartPulse,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import BusinessHealthTab from "@/components/monitor/BusinessHealthTab";
import { isDbPressureActive, getBackoffMultiplier } from "@/hooks/use-db-pressure";
import Navbar from "@/components/Navbar";

/* ── Error classification ────────────────────────────────── */

interface ClassifiedError {
  id: string;
  source: "ui" | "repricer" | "edge_function";
  category: "infrastructure" | "api" | "application" | "auth" | "data";
  severity: "critical" | "warning" | "info";
  userEmail: string;
  userId: string;
  message: string;
  context: string | null;
  pageUrl: string | null;
  createdAt: string;
  count: number;
  asins: string[];
  howToFix: string;
  isResolvable: boolean;
}

const INFRA_PATTERNS = [
  "timeout", "504", "503", "502", "connection timed out",
  "upstream request timeout", "failed to fetch", "connection refused",
  "too many connections", "remaining connection slots", "disk full",
  "out of memory",
];
const API_PATTERNS = [
  "throttl", "429", "rate limit", "QuotaExceeded", "RequestThrottled",
  "sp-api", "sellingpartnerapi", "amazon",
];
const AUTH_PATTERNS = [
  "auth", "token", "refresh_token", "unauthorized", "403", "jwt",
  "session expired",
];
const DATA_PATTERNS = [
  "undefined", "null", "NaN", "cannot read properties",
  "violates row-level", "duplicate key",
];

function classifyError(msg: string, source: string): {
  category: ClassifiedError["category"];
  severity: ClassifiedError["severity"];
  howToFix: string;
} {
  const lower = msg.toLowerCase();

  // Infrastructure errors
  if (INFRA_PATTERNS.some(p => lower.includes(p))) {
    const isCritical = lower.includes("504") || lower.includes("too many connections") || lower.includes("out of memory");
    return {
      category: "infrastructure",
      severity: isCritical ? "critical" : "warning",
      howToFix: isCritical
        ? "Database is under heavy load. Go to Supabase Dashboard → Settings → Compute Add-ons and upgrade from Micro to Small (or higher). Also check if there are runaway queries or missing indexes."
        : "Transient network timeout — usually resolves on its own. If recurring, consider upgrading Supabase compute tier or checking for slow queries in the SQL Editor → Query Performance.",
    };
  }

  // API / Amazon errors
  if (API_PATTERNS.some(p => lower.includes(p))) {
    if (lower.includes("throttl") || lower.includes("429") || lower.includes("rate limit")) {
      return {
        category: "api",
        severity: "warning",
        howToFix: "Amazon SP-API is throttling requests. The system automatically backs off and retries. If persistent across many ASINs, reduce the repricer sweep frequency or increase the dispatch interval.",
      };
    }
    if (lower.includes("connection timed out")) {
      return {
        category: "api",
        severity: "info",
        howToFix: "Amazon's server didn't respond in time. This is transient and not a code bug — the system will retry automatically on the next cycle. No action needed unless it happens repeatedly for the same ASIN.",
      };
    }
    return {
      category: "api",
      severity: "warning",
      howToFix: "Amazon API returned an error. Check if the seller's SP-API authorization is still valid (Amazon Connect page). If the error mentions a specific ASIN, the listing may have been removed or restricted by Amazon.",
    };
  }

  // Auth errors
  if (AUTH_PATTERNS.some(p => lower.includes(p))) {
    return {
      category: "auth",
      severity: "warning",
      howToFix: "Authentication issue detected. The user may need to re-authorize their Amazon account (Settings → Amazon Connect) or their session may have expired. Check the seller_authorizations table for expired tokens.",
    };
  }

  // Data / code errors
  if (DATA_PATTERNS.some(p => lower.includes(p))) {
    return {
      category: "data",
      severity: "warning",
      howToFix: "A code-level data error occurred — likely a missing field or unexpected null value. Check the stack trace in the error context for the exact location. This may require a code fix if it's systematic.",
    };
  }

  // Default: application error
  return {
    category: "application",
    severity: source === "repricer" ? "warning" : "info",
    howToFix: "Application-level error. Review the error message and stack trace for details. If it's a one-off, it may be safe to dismiss. If recurring, investigate the specific component or edge function.",
  };
}

/* ── Component ───────────────────────────────────────────── */

const ErrorLog = ({ embedded = false }: { embedded?: boolean }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<ClassifiedError[]>([]);
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [userEmails, setUserEmails] = useState<Record<string, string>>({});
  const [activeUserCount, setActiveUserCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }).then(({ data }) => {
      const admin = !!data;
      setIsAdmin(admin);
      if (!admin && !embedded) navigate("/");
    });
  }, [user, navigate, embedded]);

  const resolveUserEmails = useCallback(async (userIds: string[]) => {
    const unknownIds = userIds.filter(id => id && !userEmails[id]);
    if (unknownIds.length === 0) return;
    const { data } = await supabase.from("profiles" as any).select("id, email").in("id", unknownIds);
    const map: Record<string, string> = { ...userEmails };
    if (data) {
      (data as any[]).forEach((p: any) => { map[p.id] = p.email || p.id.slice(0, 8) + "…"; });
    }
    unknownIds.forEach(id => { if (!map[id]) map[id] = id.slice(0, 8) + "…"; });
    setUserEmails(map);
  }, [userEmails]);

  const fetchErrors = useCallback(async () => {
    setLoading(true);
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    // Frontend errors
    const { data: feData } = await supabase
      .from("error_reports")
      .select("id, user_id, user_email, error_message, error_context, page_url, resolved, created_at")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(100);

    const feList: ClassifiedError[] = (feData || []).map(e => {
      const cls = classifyError(e.error_message || "", "frontend");
      return {
        id: e.id,
        source: "ui",
        ...cls,
        userEmail: e.user_email || "",
        userId: (e as any).user_id || "",
        message: e.error_message || "",
        context: e.error_context || null,
        pageUrl: e.page_url || null,
        createdAt: e.created_at,
        count: 1,
        asins: [],
        isResolvable: true,
      };
    });

    // Repricer errors
    const { data: rpData } = await supabase
      .from("repricer_price_actions")
      .select("id, user_id, asin, marketplace, reason, created_at")
      .eq("action_type", "price_change_failed")
      .gte("created_at", fourHoursAgo)
      .order("created_at", { ascending: false })
      .limit(200);

    const rpGroups = new Map<string, { count: number; asins: string[]; latest: any; userId: string }>();
    for (const r of rpData || []) {
      const key = `${r.user_id}::${(r.reason || "").slice(0, 80)}`;
      const existing = rpGroups.get(key);
      if (existing) { existing.count++; if (existing.asins.length < 5) existing.asins.push(r.asin); }
      else rpGroups.set(key, { count: 1, asins: [r.asin], latest: r, userId: r.user_id });
    }

    const rpList: ClassifiedError[] = [];
    for (const [, g] of rpGroups) {
      const msg = g.latest.reason || "Unknown error";
      const cls = classifyError(msg, "repricer");
      rpList.push({
        id: g.latest.id, source: "repricer", ...cls,
        userEmail: "", userId: g.userId,
        message: msg,
        context: `${g.count}× in 4h | ASINs: ${g.asins.join(", ")}${g.count > 5 ? ` +${g.count - 5} more` : ""} | ${g.latest.marketplace}`,
        pageUrl: "/tools/repricer",
        createdAt: g.latest.created_at,
        count: g.count, asins: g.asins, isResolvable: false,
      });
    }

    // Edge function errors
    const { data: efData } = await supabase
      .from("error_logs")
      .select("id, user_id, module, message, timestamp")
      .gte("timestamp", fourHoursAgo)
      .order("timestamp", { ascending: false })
      .limit(50);

    const efGroups = new Map<string, { count: number; latest: any; userId: string | null }>();
    for (const e of efData || []) {
      const key = `${e.module}::${(e.message || "").slice(0, 60)}`;
      const existing = efGroups.get(key);
      if (existing) existing.count++;
      else efGroups.set(key, { count: 1, latest: e, userId: e.user_id });
    }

    const efList: ClassifiedError[] = [];
    for (const [, g] of efGroups) {
      const msg = `[${g.latest.module || "Edge Fn"}] ${g.latest.message || "Unknown"}`;
      const cls = classifyError(msg, "edge_function");
      efList.push({
        id: g.latest.id, source: "edge_function", ...cls,
        userEmail: "", userId: g.userId || "",
        message: msg, context: `${g.count}× in 4h`,
        pageUrl: null, createdAt: g.latest.timestamp,
        count: g.count, asins: [], isResolvable: false,
      });
    }

    const all = [...rpList, ...feList, ...efList]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    setErrors(all);
    setLoading(false);

    // Count active users (distinct user_ids with repricer activity in last 1h)
    // Uses count_active_repricer_users_1h() RPC instead of scanning
    // repricer_price_actions.user_id — the old scan was ~4% of DB CPU.
    const { data: activeCount } = await supabase.rpc(
      "count_active_repricer_users_1h" as any,
    );
    if (typeof activeCount === "number") {
      setActiveUserCount(activeCount);
    }

    const ids = [...new Set(all.map(e => e.userId).filter(Boolean))];
    if (ids.length) resolveUserEmails(ids);
  }, [resolveUserEmails]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchErrors();
    const iv = setInterval(fetchErrors, 60_000);
    return () => clearInterval(iv);
  }, [isAdmin, fetchErrors]);

  const resolveError = async (id: string, source: string) => {
    if (!user) return;
    if (source === "ui") {
      await supabase.from("error_reports")
        .update({ resolved: true, resolved_by: user.id, resolved_at: new Date().toISOString() })
        .eq("id", id);
    } else if (source === "edge_function") {
      // Remove from error_logs (no resolved column, just delete)
      await supabase.from("error_logs").delete().eq("id", id);
    }
    // For repricer source or any source, remove from local state
    setErrors(prev => prev.filter(e => e.id !== id));
  };

  const clearAll = async () => {
    if (!user) return;
    const feIds = errors.filter(e => e.source === "ui").map(e => e.id);
    if (feIds.length) {
      await supabase.from("error_reports")
        .update({ resolved: true, resolved_by: user.id, resolved_at: new Date().toISOString() })
        .in("id", feIds);
    }
    setErrors([]);
  };

  if (!isAdmin) return null;

  const pressureActive = isDbPressureActive();
  const backoff = getBackoffMultiplier();

  const filtered = errors.filter(e => {
    if (filterCategory !== "all" && e.category !== filterCategory) return false;
    if (filterSeverity !== "all" && e.severity !== filterSeverity) return false;
    return true;
  });

  const categoryCounts = {
    infrastructure: errors.filter(e => e.category === "infrastructure").length,
    api: errors.filter(e => e.category === "api").length,
    application: errors.filter(e => e.category === "application").length,
    auth: errors.filter(e => e.category === "auth").length,
    data: errors.filter(e => e.category === "data").length,
  };

  const severityCounts = {
    critical: errors.filter(e => e.severity === "critical").length,
    warning: errors.filter(e => e.severity === "warning").length,
    info: errors.filter(e => e.severity === "info").length,
  };

  const timeAgo = (iso: string) => {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  const categoryMeta: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
    infrastructure: { icon: <Database className="h-3.5 w-3.5" />, label: "Infrastructure", color: "text-red-400 bg-red-500/10 border-red-500/30" },
    api: { icon: <Wifi className="h-3.5 w-3.5" />, label: "API / Amazon", color: "text-orange-400 bg-orange-500/10 border-orange-500/30" },
    application: { icon: <Bug className="h-3.5 w-3.5" />, label: "Application", color: "text-blue-400 bg-blue-500/10 border-blue-500/30" },
    auth: { icon: <ShieldAlert className="h-3.5 w-3.5" />, label: "Authentication", color: "text-purple-400 bg-purple-500/10 border-purple-500/30" },
    data: { icon: <AlertTriangle className="h-3.5 w-3.5" />, label: "Data / Code", color: "text-amber-400 bg-amber-500/10 border-amber-500/30" },
  };

  const severityMeta: Record<string, { label: string; color: string }> = {
    critical: { label: "Critical", color: "text-red-400 bg-red-500/15 border-red-500/40" },
    warning: { label: "Warning", color: "text-amber-400 bg-amber-500/15 border-amber-500/40" },
    info: { label: "Info", color: "text-sky-400 bg-sky-500/15 border-sky-500/40" },
  };

  const sourceMeta: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
    ui: { icon: <User className="h-3 w-3" />, label: "UI", color: "text-rose-400 bg-rose-500/10 border-rose-500/30" },
    repricer: { icon: <Server className="h-3 w-3" />, label: "Repricer", color: "text-orange-400 bg-orange-500/10 border-orange-500/30" },
    edge_function: { icon: <Server className="h-3 w-3" />, label: "Backend", color: "text-violet-400 bg-violet-500/10 border-violet-500/30" },
  };

  const content = (
    <>

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" />
              System Error Log
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              All system errors classified by type with actionable fix suggestions
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={fetchErrors} className="gap-1 border-border text-foreground">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            {errors.length > 0 && (
              <Button size="sm" variant="destructive" onClick={clearAll} className="gap-1">
                <Trash2 className="h-3.5 w-3.5" /> Clear All
              </Button>
            )}
          </div>
        </div>

        <Tabs defaultValue="business" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="business" className="gap-1.5">
              <HeartPulse className="h-3.5 w-3.5" /> Business Health
            </TabsTrigger>
            <TabsTrigger value="raw" className="gap-1.5">
              <Bug className="h-3.5 w-3.5" /> Raw Logs
            </TabsTrigger>
          </TabsList>

          <TabsContent value="business">
            <BusinessHealthTab />
          </TabsContent>

          <TabsContent value="raw">

        {/* Infrastructure Status Bar */}
        <Card className={`mb-6 border ${pressureActive ? "border-red-500/50 bg-red-500/5" : "border-border bg-card/80"}`}>
          <CardContent className="py-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                <Gauge className={`h-5 w-5 ${pressureActive ? "text-red-400 animate-pulse" : "text-emerald-400"}`} />
                <div>
                  <span className="text-sm font-semibold text-foreground">
                    DB Pressure: {pressureActive ? "🔴 ACTIVE" : "🟢 Normal"}
                  </span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Active Users (1h): <span className="font-semibold text-foreground">{activeUserCount}</span> · Backoff: {backoff}× · Infra Errors: {categoryCounts.infrastructure} · API Errors: {categoryCounts.api}
                  </span>
                </div>
              </div>
              {pressureActive && (
                <Badge variant="outline" className="text-red-400 border-red-500/40 bg-red-500/10 text-xs">
                  ⚡ Optional queries suspended — upgrade Supabase compute to resolve
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {Object.entries(categoryCounts).map(([cat, count]) => {
            const meta = categoryMeta[cat];
            return (
              <Card
                key={cat}
                className={`cursor-pointer border transition-all ${filterCategory === cat ? "ring-2 ring-primary" : ""} ${meta.color}`}
                onClick={() => setFilterCategory(filterCategory === cat ? "all" : cat)}
              >
                <CardContent className="py-3 px-4 flex items-center gap-3">
                  {meta.icon}
                  <div>
                    <div className="text-lg font-bold">{count}</div>
                    <div className="text-[10px] font-medium opacity-80">{meta.label}</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-[160px] h-8 bg-card border-border text-foreground">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              <SelectItem value="all">All Categories</SelectItem>
              <SelectItem value="infrastructure">🏗️ Infrastructure</SelectItem>
              <SelectItem value="api">🌐 API / Amazon</SelectItem>
              <SelectItem value="application">🐛 Application</SelectItem>
              <SelectItem value="auth">🔐 Authentication</SelectItem>
              <SelectItem value="data">📊 Data / Code</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterSeverity} onValueChange={setFilterSeverity}>
            <SelectTrigger className="w-[140px] h-8 bg-card border-border text-foreground">
              <SelectValue placeholder="All Severity" />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              <SelectItem value="all">All Severity</SelectItem>
              <SelectItem value="critical">🔴 Critical ({severityCounts.critical})</SelectItem>
              <SelectItem value="warning">🟡 Warning ({severityCounts.warning})</SelectItem>
              <SelectItem value="info">🔵 Info ({severityCounts.info})</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground ml-auto">
            Showing {filtered.length} of {errors.length} errors
          </span>
        </div>

        {/* Error Table */}
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">Loading errors...</div>
        ) : filtered.length === 0 ? (
          <Card className="border-border bg-card/80">
            <CardContent className="py-12 text-center">
              <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
              <h3 className="text-lg font-semibold text-foreground">All Clear</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {errors.length === 0 ? "No errors reported 🎉" : "No errors match your filters"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="border border-border rounded-lg bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="text-xs text-muted-foreground hover:bg-muted/50 border-b border-border">
                  <TableHead className="w-[100px]">Severity</TableHead>
                  <TableHead className="w-[120px]">Type</TableHead>
                  <TableHead className="w-[80px]">Source</TableHead>
                  <TableHead className="w-[140px]">User</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="w-[80px]">When</TableHead>
                  <TableHead className="w-[60px]">×</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e, i) => {
                  const catMeta = categoryMeta[e.category];
                  const sevMeta = severityMeta[e.severity];
                  const srcMeta = sourceMeta[e.source];
                  const isExpanded = expandedId === e.id;
                  const email = e.userEmail || userEmails[e.userId] || "";

                  return (
                    <>
                      <TableRow
                        key={e.id}
                        className={`text-xs border-b border-border hover:bg-accent/30 transition-colors cursor-pointer ${i % 2 === 0 ? "bg-card" : "bg-muted/20"}`}
                        onClick={() => setExpandedId(isExpanded ? null : e.id)}
                      >
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] ${sevMeta.color}`}>{sevMeta.label}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] gap-1 ${catMeta.color}`}>
                            {catMeta.icon} {catMeta.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] gap-0.5 ${srcMeta.color}`}>
                            {srcMeta.icon} {srcMeta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-foreground truncate max-w-[140px]" title={email}>{email}</TableCell>
                        <TableCell className="text-foreground">
                          <div className="flex items-center gap-1">
                            <span className="line-clamp-1 break-all">{e.message}</span>
                            {isExpanded ? <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">
                          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{timeAgo(e.createdAt)}</span>
                        </TableCell>
                        <TableCell className="text-foreground font-medium">{e.count > 1 ? `${e.count}×` : ""}</TableCell>
                        <TableCell>
                            <Button
                              size="sm" variant="ghost"
                              className="h-6 px-1.5 gap-1 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10 text-[10px]"
                              onClick={(ev) => { ev.stopPropagation(); resolveError(e.id, e.source); }}
                              title="Mark as fixed"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" /> Fix
                            </Button>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${e.id}-detail`} className="bg-muted/30 border-b border-border">
                          <TableCell colSpan={8} className="p-4">
                            <div className="space-y-3">
                              {/* How to Fix */}
                              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                                  <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">How to Fix</span>
                                </div>
                                <p className="text-sm text-foreground leading-relaxed">{e.howToFix}</p>
                              </div>

                              {/* Full error message */}
                              <div>
                                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Full Error</span>
                                <p className="text-xs text-foreground mt-1 break-all bg-background/50 rounded p-2 font-mono">{e.message}</p>
                              </div>

                              {/* Context / stack trace */}
                              {e.context && (
                                <div>
                                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Context</span>
                                  <p className="text-xs text-muted-foreground mt-1 break-all bg-background/50 rounded p-2 font-mono">{e.context}</p>
                                </div>
                              )}

                              {/* ASINs */}
                              {e.asins.length > 0 && (
                                <div>
                                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Affected ASINs</span>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {e.asins.map(asin => (
                                      <Badge key={asin} variant="outline" className="text-[10px] font-mono">{asin}</Badge>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Page URL */}
                              {e.pageUrl && (
                                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <ExternalLink className="h-3 w-3" /> {e.pageUrl}
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
          </TabsContent>
        </Tabs>
    </>

  );

  if (embedded) return content;

  return (
    <div className="min-h-screen bg-[hsl(221,50%,8%)]">
      <Navbar />
      <div className="container mx-auto px-4 py-8 pt-24 max-w-7xl">
        {content}
      </div>
    </div>
  );
};

export default ErrorLog;
