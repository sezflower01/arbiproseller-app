import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, RefreshCw,
  Activity, Shield, Database, Wifi, ShieldAlert, Package, DollarSign,
  Zap, EyeOff, ExternalLink, Wrench, Users,
} from "lucide-react";
import { toast } from "sonner";
import { onMonitorRefresh } from "@/lib/monitor/refreshBus";

type Severity = "critical" | "warning" | "info" | "healthy";
type Confidence = "high" | "medium" | "low";
type Status = "open" | "retrying" | "requeued" | "stuck" | "resolved" | "ignored";

interface Issue {
  id: string;
  user_id: string;
  fingerprint: string;
  module: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  impact: string;
  recommended_fix: string;
  auto_fix_action: string | null;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  affected_entities: any;
  routes: string[] | null;
  functions: string[] | null;
  sources: string[] | null;
  status: Status;
  last_raw_message: string | null;
  resolved_at: string | null;
  resolved_reason: string | null;
  ignored_until: string | null;
  retry_attempts: number | null;
  last_retry_at: string | null;
  next_retry_at: string | null;
  stuck_reason: string | null;
  retryable: boolean | null;
  display_category: "awaiting_amazon" | "action_needed" | "generic" | null;
}

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  awaiting_amazon: { label: "Awaiting Amazon", color: "text-sky-300 bg-sky-500/10 border-sky-500/40" },
  action_needed: { label: "Action Needed", color: "text-red-300 bg-red-500/10 border-red-500/40" },
  generic: { label: "", color: "" },
};

function fmtRelativeFuture(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

const MODULES = [
  "sales_pnl", "inventory", "repricer", "shipments", "customer_intelligence",
  "amazon_api", "auth", "gmail", "extension", "database", "billing",
];

const MODULE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  sales_pnl: { label: "Sales / P&L", icon: <DollarSign className="h-3.5 w-3.5" /> },
  inventory: { label: "Inventory", icon: <Package className="h-3.5 w-3.5" /> },
  repricer: { label: "Repricer", icon: <Activity className="h-3.5 w-3.5" /> },
  shipments: { label: "Shipments", icon: <Package className="h-3.5 w-3.5" /> },
  customer_intelligence: { label: "Customer Intelligence", icon: <Users className="h-3.5 w-3.5" /> },
  amazon_api: { label: "Amazon API", icon: <Wifi className="h-3.5 w-3.5" /> },
  auth: { label: "Auth", icon: <ShieldAlert className="h-3.5 w-3.5" /> },
  gmail: { label: "Gmail", icon: <Wifi className="h-3.5 w-3.5" /> },
  extension: { label: "Extension", icon: <Zap className="h-3.5 w-3.5" /> },
  database: { label: "Database", icon: <Database className="h-3.5 w-3.5" /> },
  billing: { label: "Billing", icon: <DollarSign className="h-3.5 w-3.5" /> },
};

const SEV_META: Record<Severity, { label: string; color: string; rank: number }> = {
  critical: { label: "Critical", color: "text-red-400 bg-red-500/15 border-red-500/40", rank: 0 },
  warning: { label: "Warning", color: "text-amber-400 bg-amber-500/15 border-amber-500/40", rank: 1 },
  info: { label: "Info", color: "text-sky-400 bg-sky-500/15 border-sky-500/40", rank: 2 },
  healthy: { label: "Healthy", color: "text-emerald-400 bg-emerald-500/15 border-emerald-500/40", rank: 3 },
};

const CONF_META: Record<Confidence, { label: string; color: string; rank: number }> = {
  high: { label: "Verified", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30", rank: 0 },
  medium: { label: "Inferred", color: "text-sky-400 bg-sky-500/10 border-sky-500/30", rank: 1 },
  low: { label: "Generic", color: "text-zinc-400 bg-zinc-500/10 border-zinc-500/30", rank: 2 },
};

function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const EDGE_AUTO_FIXES = new Set([
  "enrich-pending-orders", "calculate-roi-range", "rescue-inventory-asin",
  "refresh-stale-inventory", "repricer-evaluate", "repricer-reconcile",
  "check-inbound-plan-status", "fetch-settlements", "sync-refunds",
  "sync-sales-orders", "monitor-spapi-health",
]);

/** affected_entities is a jsonb array of {asin?,sku?,order_id?,marketplace?,shipment_id?}.
 *  Collapse to the most recent non-empty entity for display + actions. */
function primaryEntity(raw: any): Record<string, string> {
  if (!raw) return {};
  const arr = Array.isArray(raw) ? raw : [raw];
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e && typeof e === "object" && Object.values(e).some(Boolean)) return e;
  }
  return {};
}

const AMAZON_DOMAIN: Record<string, string> = {
  US: "www.amazon.com", CA: "www.amazon.ca", MX: "www.amazon.com.mx", BR: "www.amazon.com.br",
  UK: "www.amazon.co.uk", GB: "www.amazon.co.uk", DE: "www.amazon.de", FR: "www.amazon.fr",
  IT: "www.amazon.it", ES: "www.amazon.es", JP: "www.amazon.co.jp", AU: "www.amazon.com.au",
  IN: "www.amazon.in", NL: "www.amazon.nl", SE: "www.amazon.se", PL: "www.amazon.pl",
  TR: "www.amazon.com.tr", AE: "www.amazon.ae", SA: "www.amazon.sa", SG: "www.amazon.sg",
  EG: "www.amazon.eg", BE: "www.amazon.com.be",
};
function amazonAsinUrl(asin: string, marketplace?: string | null): string {
  const domain = AMAZON_DOMAIN[String(marketplace || "US").toUpperCase()] || AMAZON_DOMAIN.US;
  return `https://${domain}/dp/${asin}`;
}

// Seller Central order detail. TLD follows marketplace region; NA sellers use .com.
const SELLER_CENTRAL_TLD: Record<string, string> = {
  US: "amazon.com", CA: "amazon.com", MX: "amazon.com", BR: "amazon.com.br",
  UK: "amazon.co.uk", GB: "amazon.co.uk", DE: "amazon.de", FR: "amazon.fr",
  IT: "amazon.it", ES: "amazon.es", NL: "amazon.nl", SE: "amazon.se",
  PL: "amazon.pl", TR: "amazon.com.tr", JP: "amazon.co.jp", AU: "amazon.com.au",
  SG: "amazon.sg", AE: "amazon.ae", SA: "amazon.sa", IN: "amazon.in",
};
function sellerCentralOrderUrl(orderId: string, marketplace?: string | null): string {
  const tld = SELLER_CENTRAL_TLD[String(marketplace || "US").toUpperCase()] || "amazon.com";
  return `https://sellercentral.${tld}/orders-v3/order/${orderId}`;
}

export default function BusinessHealthTab() {
  const [loading, setLoading] = useState(true);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [fModule, setFModule] = useState<string>("all");
  const [fSeverity, setFSeverity] = useState<string>("all");
  const [fConfidence, setFConfidence] = useState<string>("all");
  const [fStatus, setFStatus] = useState<string>("open");
  const [fRange, setFRange] = useState<string>("7d");
  const [search, setSearch] = useState("");
  const [acting, setActing] = useState<string | null>(null);

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    const since = new Date(Date.now() - (fRange === "24h" ? 1 : fRange === "7d" ? 7 : 30) * 86_400_000).toISOString();
    let q = supabase
      .from("business_health_issues" as any)
      .select("*")
      .gte("last_seen", since)
      .order("last_seen", { ascending: false })
      .limit(500);
    const { data, error } = await q;
    if (error) {
      toast.error(`Failed to load business health: ${error.message}`);
      setLoading(false);
      return;
    }
    setIssues((data || []) as unknown as Issue[]);
    setLoading(false);
  }, [fRange]);

  useEffect(() => {
    fetchIssues();
    const __unsub = onMonitorRefresh(fetchIssues);
    return () => __unsub();
  }, [fetchIssues]);

  // Trigger aggregator on first mount to ensure data is fresh
  useEffect(() => {
    supabase.functions.invoke("health-center-aggregate", { body: {} }).catch(() => {});
  }, []);

  // A "maintenance" issue = database housekeeping (db:*) or a low-confidence
  // generic UI error. These are surfaced in a separate System Maintenance card
  // and hidden from the main business issues table.
  const isMaintenanceIssue = useCallback((i: Issue) => {
    if (i.fingerprint?.startsWith("db:")) return true;
    if (i.module === "database" && i.title?.startsWith("Database maintenance:")) return true;
    if (i.confidence === "low" && (i.title?.toLowerCase().includes("generic ui error") || i.fingerprint?.includes("generic_ui_error"))) return true;
    return false;
  }, []);

  const maintenanceIssues = useMemo(
    () => issues.filter((i) => (i.status === "open" || i.status === "retrying" || i.status === "stuck") && isMaintenanceIssue(i)),
    [issues, isMaintenanceIssue],
  );

  const businessIssues = useMemo(
    () => issues.filter((i) => !isMaintenanceIssue(i)),
    [issues, isMaintenanceIssue],
  );

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return businessIssues
      .filter((i) => {
        if (fModule !== "all" && i.module !== fModule) return false;
        if (fSeverity !== "all" && i.severity !== fSeverity) return false;
        if (fConfidence !== "all" && i.confidence !== fConfidence) return false;
        if (fStatus !== "all" && i.status !== fStatus) return false;
        if (s) {
          const hay = JSON.stringify({
            t: i.title, m: i.last_raw_message, f: i.functions, e: i.affected_entities,
          }).toLowerCase();
          if (!hay.includes(s)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const sevRankA = SEV_META[a.severity]?.rank ?? 99;
        const sevRankB = SEV_META[b.severity]?.rank ?? 99;
        const sevDiff = sevRankA - sevRankB;
        if (sevDiff !== 0) return sevDiff;
        const confRankA = CONF_META[a.confidence]?.rank ?? 99;
        const confRankB = CONF_META[b.confidence]?.rank ?? 99;
        const confDiff = confRankA - confRankB;
        if (confDiff !== 0) return confDiff;
        return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
      });
  }, [businessIssues, fModule, fSeverity, fConfidence, fStatus, search]);

  // Summary cards — business issues only (maintenance excluded from health score)
  const summary = useMemo(() => {
    const open = businessIssues.filter((i) => i.status === "open");
    const critical = open.filter((i) => i.severity === "critical").length;
    const warning = open.filter((i) => i.severity === "warning").length;
    const byMod = (m: string) => open.filter((i) => i.module === m).length;
    const amazon = byMod("amazon_api");
    const inv = byMod("inventory");
    const rep = byMod("repricer");
    const ship = byMod("shipments");
    const sales = byMod("sales_pnl");

    const score = Math.max(0, 100 - critical * 12 - warning * 4);
    const dataCorrectness = Math.max(0, 100 - (sales + inv) * 5 - critical * 8);
    return { score, critical, warning, amazon, inv, rep, ship, sales, dataCorrectness };
  }, [businessIssues]);

  const [runningMaint, setRunningMaint] = useState(false);
  const runMaintenance = async () => {
    setRunningMaint(true);
    try {
      const { error } = await supabase.rpc("run_nightly_maintenance_now" as any);
      if (error) throw error;
      toast.success("Maintenance complete. Cleaning up alerts…");
      await fetchIssues();
    } catch (e: any) {
      toast.error(`Maintenance failed: ${e?.message || e}`);
    } finally {
      setRunningMaint(false);
    }
  };

  const handleAction = async (issue: Issue, action: string) => {
    setActing(issue.id + ":" + action);
    try {
      if (action === "resolve") {
        const { error } = await supabase.rpc("resolve_business_health_issue" as any, {
          _id: issue.id, _reason: "manual",
        });
        if (error) throw error;
        toast.success("Issue marked resolved");
      } else if (action === "ignore") {
        const { error } = await supabase.rpc("ignore_business_health_pattern" as any, {
          _id: issue.id, _hours: 24,
        });
        if (error) throw error;
        toast.success("Pattern snoozed for 24h");
      } else if (action.startsWith("invoke:")) {
        const fn = action.slice("invoke:".length);
        const entity = primaryEntity(issue.affected_entities);
        const body: any = {};
        if (entity.asin) body.asin = entity.asin;
        if (entity.sku) body.sku = entity.sku;
        if (entity.marketplace) body.marketplace = entity.marketplace;
        if (entity.order_id) body.order_id = entity.order_id;
        if (entity.shipment_id) body.shipment_id = entity.shipment_id;
        const { error } = await supabase.functions.invoke(fn, { body });
        if (error) throw error;
        toast.success(`${fn} triggered`);
      }
      await fetchIssues();
    } catch (e: any) {
      toast.error(`Action failed: ${e?.message || e}`);
    } finally {
      setActing(null);
    }
  };

  const openEntity = (issue: Issue) => {
    const e = primaryEntity(issue.affected_entities);
    if (e.asin) window.open(`/tools/asin-lookup?asin=${e.asin}`, "_blank");
    else if (e.order_id) window.open(sellerCentralOrderUrl(e.order_id, e.marketplace), "_blank");
    else if (e.sku) window.open(`/tools/product-library?sku=${e.sku}`, "_blank");
    else if (e.shipment_id) window.open(`/tools/shipment-builder?shipment=${e.shipment_id}`, "_blank");
  };

  const ScoreCard = ({ label, value, icon, tone }: { label: string; value: number | string; icon: React.ReactNode; tone: string }) => (
    <Card className={`border ${tone}`}>
      <CardContent className="py-3 px-4 flex items-center gap-3">
        {icon}
        <div>
          <div className="text-lg font-bold leading-none">{value}</div>
          <div className="text-[10px] font-medium opacity-80 mt-1">{label}</div>
        </div>
      </CardContent>
    </Card>
  );

  const toneFor = (n: number, inverted = false) => {
    const v = inverted ? 100 - n * 10 : n;
    if (v >= 85) return "border-emerald-500/30 bg-emerald-500/5 text-emerald-300";
    if (v >= 65) return "border-sky-500/30 bg-sky-500/5 text-sky-300";
    if (v >= 40) return "border-amber-500/30 bg-amber-500/5 text-amber-300";
    return "border-red-500/40 bg-red-500/10 text-red-300";
  };

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <ScoreCard label="Overall Health" value={summary.score} icon={<Activity className="h-4 w-4" />} tone={toneFor(summary.score)} />
        <ScoreCard label="Critical Open" value={summary.critical} icon={<AlertTriangle className="h-4 w-4" />} tone={summary.critical ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"} />
        <ScoreCard label="Warnings Open" value={summary.warning} icon={<AlertTriangle className="h-4 w-4" />} tone={summary.warning ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"} />
        <ScoreCard label="Amazon API" value={summary.amazon} icon={<Wifi className="h-4 w-4" />} tone={toneFor(summary.amazon, true)} />
        <ScoreCard label="Data Correctness" value={summary.dataCorrectness} icon={<Shield className="h-4 w-4" />} tone={toneFor(summary.dataCorrectness)} />
        <ScoreCard label="Inventory" value={summary.inv} icon={<Package className="h-4 w-4" />} tone={toneFor(summary.inv, true)} />
        <ScoreCard label="Repricer" value={summary.rep} icon={<Activity className="h-4 w-4" />} tone={toneFor(summary.rep, true)} />
        <ScoreCard label="Shipments" value={summary.ship} icon={<Package className="h-4 w-4" />} tone={toneFor(summary.ship, true)} />
        <ScoreCard label="Sales / P&L" value={summary.sales} icon={<DollarSign className="h-4 w-4" />} tone={toneFor(summary.sales, true)} />
        <Card className="border-border bg-card/80">
          <CardContent className="py-3 px-4 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Refresh</span>
            <Button size="sm" variant="outline" className="h-7 gap-1" onClick={fetchIssues}>
              <RefreshCw className="h-3 w-3" />
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* System Maintenance — admin housekeeping surfaced separately */}
      {maintenanceIssues.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="py-3 px-4 flex items-center gap-3">
            <Wrench className="h-4 w-4 text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-amber-200">System Maintenance</div>
              <div className="text-[11px] text-muted-foreground line-clamp-1">
                {maintenanceIssues.length} housekeeping {maintenanceIssues.length === 1 ? "task" : "tasks"} pending
                {" · "}auto-runs nightly · run now to clean up immediately
              </div>
            </div>
            <Button size="sm" className="h-8 gap-1" disabled={runningMaint} onClick={runMaintenance}>
              <Wrench className="h-3.5 w-3.5" />
              {runningMaint ? "Running…" : "Run Maintenance"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">

        <Select value={fModule} onValueChange={setFModule}>
          <SelectTrigger className="w-[160px] h-8"><SelectValue placeholder="Module" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All modules</SelectItem>
            {MODULES.map((m) => (
              <SelectItem key={m} value={m}>{MODULE_META[m]?.label || m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={fSeverity} onValueChange={setFSeverity}>
          <SelectTrigger className="w-[140px] h-8"><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severity</SelectItem>
            <SelectItem value="critical">🔴 Critical</SelectItem>
            <SelectItem value="warning">🟡 Warning</SelectItem>
            <SelectItem value="info">🔵 Info</SelectItem>
            <SelectItem value="healthy">🟢 Healthy</SelectItem>
          </SelectContent>
        </Select>
        <Select value={fConfidence} onValueChange={setFConfidence}>
          <SelectTrigger className="w-[140px] h-8"><SelectValue placeholder="Confidence" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any confidence</SelectItem>
            <SelectItem value="high">High (verified)</SelectItem>
            <SelectItem value="medium">Medium (inferred)</SelectItem>
            <SelectItem value="low">Low (generic)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={fStatus} onValueChange={setFStatus}>
          <SelectTrigger className="w-[140px] h-8"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="retrying">Retrying</SelectItem>
            <SelectItem value="stuck">Stuck</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="ignored">Ignored</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Select value={fRange} onValueChange={setFRange}>
          <SelectTrigger className="w-[120px] h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Last 24h</SelectItem>
            <SelectItem value="7d">Last 7d</SelectItem>
            <SelectItem value="30d">Last 30d</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ASIN / SKU / order / function"
          className="h-8 w-[260px]"
        />
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} of {businessIssues.length} issues
        </span>
      </div>

      {/* Issues */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading business health…</div>
      ) : filtered.length === 0 ? (
        <Card className="border-border bg-card/80">
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
            <h3 className="text-lg font-semibold">All clear</h3>
            <p className="text-sm text-muted-foreground mt-1">No business health issues match your filters.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="border border-border rounded-lg bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="text-xs text-muted-foreground hover:bg-muted/50 border-b border-border">
                <TableHead className="w-[90px]">Severity</TableHead>
                <TableHead className="w-[130px]">Module</TableHead>
                <TableHead>Issue</TableHead>
                <TableHead className="w-[120px]">Entity</TableHead>
                <TableHead className="w-[60px] text-center">Count</TableHead>
                <TableHead className="w-[90px]">Last seen</TableHead>
                <TableHead className="w-[100px]">Confidence</TableHead>
                <TableHead className="w-[80px]">Status</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((i, idx) => {
                const sev = SEV_META[i.severity] ?? { label: String(i.severity ?? "unknown"), color: "text-zinc-400 bg-zinc-500/10 border-zinc-500/30", rank: 99 };
                const conf = CONF_META[i.confidence] ?? { label: String(i.confidence ?? "unknown"), color: "text-zinc-400 bg-zinc-500/10 border-zinc-500/30", rank: 99 };
                const mod = MODULE_META[i.module] || { label: i.module, icon: null };
                const expanded = expandedId === i.id;
                const entity = primaryEntity(i.affected_entities);
                const entityLabel = entity.asin || entity.sku || entity.order_id || entity.shipment_id || entity.marketplace || "—";
                const canInvoke = i.auto_fix_action && EDGE_AUTO_FIXES.has(i.auto_fix_action);
                return (
                  <>
                    <TableRow
                      key={i.id}
                      className={`text-xs border-b border-border hover:bg-accent/30 cursor-pointer ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"}`}
                      onClick={() => setExpandedId(expanded ? null : i.id)}
                    >
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${sev.color}`}>{sev.label}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] gap-1 border-border">
                          {mod.icon} {mod.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-foreground">
                        <div className="flex items-center gap-2">
                          <div className="font-medium line-clamp-1">{i.title}</div>
                          {i.display_category && i.display_category !== "generic" && (
                            <Badge variant="outline" className={`text-[10px] shrink-0 ${CATEGORY_META[i.display_category]?.color || ""}`}>
                              {CATEGORY_META[i.display_category]?.label}
                            </Badge>
                          )}
                        </div>
                        <div className="text-muted-foreground line-clamp-1 text-[11px]">{i.impact}</div>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-foreground truncate max-w-[120px]" title={entityLabel}>
                        {entity.asin ? (
                          <a
                            href={amazonAsinUrl(entity.asin, entity.marketplace)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-sky-400 hover:text-sky-300 hover:underline"
                          >
                            {entity.asin}
                          </a>
                        ) : entity.order_id ? (
                          <a
                            href={sellerCentralOrderUrl(entity.order_id, entity.marketplace)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-sky-400 hover:text-sky-300 hover:underline"
                          >
                            {entity.order_id}
                          </a>
                        ) : (
                          entityLabel
                        )}
                      </TableCell>
                      <TableCell className="text-center font-semibold">{i.occurrence_count}</TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap">{timeAgo(i.last_seen)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${conf.color}`}>{conf.label}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${
                          i.status === "stuck" ? "border-red-500/40 text-red-300" :
                          i.status === "retrying" || i.status === "requeued" ? "border-sky-500/40 text-sky-300" :
                          i.status === "open" ? "border-amber-500/40 text-amber-300" :
                          i.status === "resolved" ? "border-emerald-500/40 text-emerald-300" :
                          "border-zinc-500/40 text-zinc-300"
                        }`}>
                          {i.status}{i.retry_attempts ? ` ${i.retry_attempts}/5` : ""}
                        </Badge>
                      </TableCell>
                      <TableCell>{expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}</TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow key={i.id + "-d"} className="bg-muted/30 border-b border-border">
                        <TableCell colSpan={9} className="p-4">
                          <div className="grid md:grid-cols-2 gap-3">
                            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                              <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider mb-1">Recommended fix</div>
                              <p className="text-sm text-foreground">{i.recommended_fix}</p>
                            </div>
                            <div className="rounded-lg border border-border bg-background/30 p-3">
                              <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Business impact</div>
                              <p className="text-sm text-foreground">{i.impact}</p>
                            </div>
                            <div className="rounded-lg border border-border bg-background/30 p-3">
                              <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Evidence &amp; affected entities</div>
                              {(() => {
                                const ae = i.affected_entities;
                                const isArr = Array.isArray(ae);
                                const isObj = ae && typeof ae === "object" && !isArr;
                                // Customer-intelligence object shape
                                if (isObj && (ae.order_ids || ae.orders_count != null || ae.refund_orders_count != null)) {
                                  const orderIds: string[] = Array.isArray(ae.order_ids) ? ae.order_ids : [];
                                  const mkt = ae.marketplace;
                                  return (
                                    <div className="space-y-2">
                                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                                        {ae.asin && (
                                          <div><span className="text-muted-foreground">ASIN:</span>{" "}
                                            <a href={amazonAsinUrl(ae.asin, mkt)} target="_blank" rel="noreferrer" className="font-mono text-sky-400 hover:text-sky-300 hover:underline">{ae.asin}</a>
                                          </div>
                                        )}
                                        {mkt && <div><span className="text-muted-foreground">Marketplace:</span> <span className="font-mono">{mkt}</span></div>}
                                        {ae.orders_count != null && <div><span className="text-muted-foreground">Orders:</span> <span className="font-mono">{ae.orders_count}</span></div>}
                                        {ae.refund_orders_count != null && <div><span className="text-muted-foreground">Refunds:</span> <span className="font-mono">{ae.refund_orders_count}</span></div>}
                                        {ae.refund_amount_usd != null && <div><span className="text-muted-foreground">Refund $:</span> <span className="font-mono">${Number(ae.refund_amount_usd).toFixed(2)}</span></div>}
                                        {ae.replacement_orders_count != null && <div><span className="text-muted-foreground">Replacements:</span> <span className="font-mono">{ae.replacement_orders_count}</span></div>}
                                        {ae.window_days != null && <div><span className="text-muted-foreground">Window:</span> <span className="font-mono">{ae.window_days}d</span></div>}
                                        <div className="col-span-2"><span className="text-muted-foreground">Date range:</span> <span className="font-mono">{new Date(i.first_seen).toLocaleDateString()} → {new Date(i.last_seen).toLocaleDateString()}</span></div>
                                        {ae.pattern_reason && <div className="col-span-2"><span className="text-muted-foreground">Reason code:</span> <span className="font-mono">{ae.pattern_reason}</span></div>}
                                        <div className="col-span-2">
                                          <span className="text-muted-foreground">Verification:</span>{" "}
                                          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-300">
                                            {ae.buyer_verified ? "PII-verified" : "Pattern-matched only"}
                                          </Badge>
                                          {ae.confidence_label && <span className="ml-2 text-muted-foreground">({ae.confidence_label})</span>}
                                        </div>
                                      </div>
                                      {ae.asin && (
                                        <div className="pt-1">
                                          <a
                                            href={`/tools/sales?asin=${ae.asin}${mkt ? `&marketplace=${mkt}` : ""}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 hover:underline"
                                          >
                                            <ExternalLink className="h-3 w-3" /> Open Sales Report filtered for this ASIN
                                          </a>
                                        </div>
                                      )}
                                      {orderIds.length > 0 && (
                                        <div>
                                          <div className="text-[10px] text-muted-foreground mb-1">Related order IDs ({orderIds.length}):</div>
                                          <div className="flex flex-wrap gap-x-3 gap-y-1 max-h-40 overflow-y-auto">
                                            {orderIds.map((oid) => (
                                              <a
                                                key={oid}
                                                href={sellerCentralOrderUrl(oid, mkt)}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-[11px] font-mono text-sky-400 hover:text-sky-300 hover:underline"
                                              >
                                                {oid}
                                              </a>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                }
                                // Generic array shape
                                if (isArr && ae.length > 0) {
                                  return (
                                    <div className="space-y-1 max-h-64 overflow-y-auto">
                                      {(ae as any[]).map((ent, entIdx) => (
                                        <div key={entIdx} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono">
                                          {ent.asin && (
                                            <a href={amazonAsinUrl(ent.asin, ent.marketplace)} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300 hover:underline">ASIN {ent.asin}</a>
                                          )}
                                          {ent.sku && <span className="text-muted-foreground">SKU {ent.sku}</span>}
                                          {ent.order_id && (
                                            <a href={sellerCentralOrderUrl(ent.order_id, ent.marketplace)} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300 hover:underline">Order {ent.order_id}</a>
                                          )}
                                          {ent.shipment_id && <span className="text-muted-foreground">Shipment {ent.shipment_id}</span>}
                                          {ent.marketplace && <span className="text-muted-foreground">[{ent.marketplace}]</span>}
                                        </div>
                                      ))}
                                    </div>
                                  );
                                }
                                return <div className="text-[11px] text-muted-foreground">—</div>;
                              })()}
                              <div className="text-[10px] text-muted-foreground mt-2">
                                first seen {timeAgo(i.first_seen)} · functions: {(i.functions || []).join(", ") || "—"} · sources: {(i.sources || []).join(", ") || "—"}
                              </div>
                            </div>
                            <div className="rounded-lg border border-border bg-background/30 p-3">
                              <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Raw message</div>
                              <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">{i.last_raw_message || "—"}</pre>
                              <div className="text-[10px] text-muted-foreground mt-2">fingerprint: <span className="font-mono">{i.fingerprint}</span></div>
                            </div>
                            <div className={`rounded-lg border p-3 ${
                              i.status === "stuck" ? "border-red-500/40 bg-red-500/5" :
                              i.retryable === false ? "border-zinc-500/30 bg-background/30" :
                              "border-sky-500/30 bg-sky-500/5"
                            }`}>
                              <div className="text-[10px] font-bold uppercase tracking-wider mb-1 text-foreground">
                                Retry lifecycle
                              </div>
                              <div className="text-[11px] text-foreground space-y-0.5">
                                <div>Attempts: <span className="font-mono">{i.retry_attempts ?? 0} / 5</span></div>
                                <div>Last retry: <span className="font-mono">{i.last_retry_at ? timeAgo(i.last_retry_at) : "—"}</span></div>
                                <div>Next retry: <span className="font-mono">{i.status === "stuck" || i.retryable === false ? "—" : fmtRelativeFuture(i.next_retry_at)}</span></div>
                                <div>Retryable: <span className="font-mono">{i.retryable === false ? "no (permanent)" : "yes"}</span></div>
                                {i.stuck_reason && (
                                  <div className="text-red-300">Stuck reason: <span className="font-mono">{i.stuck_reason}</span></div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2 mt-3">
                            <Button size="sm" variant="outline" className="h-7 gap-1" disabled={acting !== null} onClick={() => handleAction(i, "resolve")}>
                              <CheckCircle2 className="h-3.5 w-3.5" /> Mark resolved
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 gap-1" disabled={acting !== null} onClick={() => handleAction(i, "ignore")}>
                              <EyeOff className="h-3.5 w-3.5" /> Ignore 24h
                            </Button>
                            {canInvoke && (
                              <Button size="sm" variant="outline" className="h-7 gap-1" disabled={acting !== null} onClick={() => handleAction(i, "invoke:" + i.auto_fix_action)}>
                                <Zap className="h-3.5 w-3.5" /> Run {i.auto_fix_action}
                              </Button>
                            )}
                            {(entity.asin || entity.order_id || entity.sku || entity.shipment_id) && (
                              <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => openEntity(i)}>
                                <ExternalLink className="h-3.5 w-3.5" /> Open related
                              </Button>
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
    </div>
  );
}
