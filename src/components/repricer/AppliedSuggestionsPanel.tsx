import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Check, X, History, Filter, ShieldCheck, ShieldX, AlertTriangle } from "lucide-react";
import BbStatusBadge from "./BbStatusBadge";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import { format } from "date-fns";

interface SuggestionLogRow {
  id: string;
  asin: string;
  sku: string | null;
  title: string | null;
  marketplace: string;
  rule_name: string | null;
  old_min: number | null;
  suggested_min: number | null;
  applied_min: number | null;
  old_price: number | null;
  new_price: number | null;
  roi_before: number | null;
  roi_after: number | null;
  bb_status: string | null;
  decision: string;
  skip_reason: string | null;
  source: string | null;
  created_at: string;
}

type FilterValue = "all" | "applied" | "skipped" | "losing_bb" | "above_fba" | "negative_roi" | "temporary";

// Classify skip reasons
const POLICY_REASONS = ["Losing Buy Box", "Negative ROI", "above lowest FBA"];
const TEMPORARY_REASONS = ["missing snapshot", "stale fee", "unknown BB", "no data"];

function classifySkip(reason: string | null): "policy" | "temporary" | "unknown" {
  if (!reason) return "unknown";
  const lower = reason.toLowerCase();
  if (POLICY_REASONS.some(p => lower.includes(p.toLowerCase()))) return "policy";
  if (TEMPORARY_REASONS.some(t => lower.includes(t.toLowerCase()))) return "temporary";
  return "policy"; // default to policy for unrecognized reasons
}

function isSafeToRetry(row: SuggestionLogRow): boolean {
  if (row.decision === "applied") return false;
  return classifySkip(row.skip_reason) === "temporary";
}

function getSkipCategory(reason: string | null): string {
  if (!reason) return "Other";
  const lower = reason.toLowerCase();
  if (lower.includes("losing buy box")) return "Losing BB";
  if (lower.includes("above lowest fba")) return "Above FBA";
  if (lower.includes("negative roi")) return "Negative ROI";
  if (lower.includes("missing") || lower.includes("stale") || lower.includes("unknown")) return "Temporary";
  if (lower.includes("only winning")) return "Not Eligible";
  return "Other";
}

interface AppliedSuggestionsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
}

export default function AppliedSuggestionsPanel({
  open,
  onOpenChange,
  marketplace,
}: AppliedSuggestionsPanelProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<SuggestionLogRow[]>([]);
  const [filter, setFilter] = useState<FilterValue>("all");

  const config = getMarketplaceConfig(marketplace);
  const fmt = (v: number | null) =>
    v != null ? `${config.currencySymbol}${v.toFixed(2)}` : "—";

  const fetchLogs = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      let query = (supabase as any)
        .from("repricer_suggestion_log")
        .select("*")
        .eq("user_id", user.id)
        .eq("marketplace", marketplace)
        .order("created_at", { ascending: false })
        .limit(500);

      if (filter === "applied" || filter === "skipped") {
        query = query.eq("decision", filter);
      }

      const { data, error } = await query;
      if (error) throw error;
      setRows(data || []);
    } catch (err: any) {
      console.error("Error fetching suggestion logs:", err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [user, marketplace, filter]);

  useEffect(() => {
    if (open) fetchLogs();
  }, [open, fetchLogs]);

  // Client-side filter for specific skip reasons
  const filteredRows = useMemo(() => {
    if (filter === "losing_bb") return rows.filter(r => r.decision === "skipped" && r.skip_reason?.toLowerCase().includes("losing buy box"));
    if (filter === "above_fba") return rows.filter(r => r.decision === "skipped" && r.skip_reason?.toLowerCase().includes("above lowest fba"));
    if (filter === "negative_roi") return rows.filter(r => r.decision === "skipped" && r.skip_reason?.toLowerCase().includes("negative roi"));
    if (filter === "temporary") return rows.filter(r => r.decision === "skipped" && classifySkip(r.skip_reason) === "temporary");
    return rows;
  }, [rows, filter]);

  // Summary stats
  const stats = useMemo(() => {
    const applied = rows.filter(r => r.decision === "applied").length;
    const skipped = rows.filter(r => r.decision === "skipped").length;
    const reasonCounts: Record<string, number> = {};
    rows.filter(r => r.decision === "skipped").forEach(r => {
      const cat = getSkipCategory(r.skip_reason);
      reasonCounts[cat] = (reasonCounts[cat] || 0) + 1;
    });
    const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
    const temporaryCount = rows.filter(r => r.decision === "skipped" && classifySkip(r.skip_reason) === "temporary").length;
    return { applied, skipped, reasonCounts, topReason, temporaryCount };
  }, [rows]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[90vw] !max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <History className="h-5 w-5 text-primary" />
            Suggestion Decisions
            <Badge variant="outline" className="text-xs font-mono">
              {config.flag} {marketplace}
            </Badge>
            <div className="flex items-center gap-1.5 ml-2">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
                <SelectTrigger className="h-7 w-[160px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="applied">Applied</SelectItem>
                  <SelectItem value="skipped">All Skipped</SelectItem>
                  <SelectItem value="losing_bb">Losing BB Blocked</SelectItem>
                  <SelectItem value="above_fba">Above FBA Blocked</SelectItem>
                  <SelectItem value="negative_roi">ROI Blocked</SelectItem>
                  <SelectItem value="temporary">Temporary Skips</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchLogs}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </DialogTitle>
        </DialogHeader>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
          <Card className="border-green-200 dark:border-green-800">
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">{stats.applied}</div>
              <div className="text-[11px] text-muted-foreground font-medium">Applied</div>
            </CardContent>
          </Card>
          <Card className="border-orange-200 dark:border-orange-800">
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">{stats.skipped}</div>
              <div className="text-[11px] text-muted-foreground font-medium">Skipped</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <div className="text-sm font-semibold truncate">{stats.topReason ? stats.topReason[0] : "—"}</div>
              <div className="text-[11px] text-muted-foreground font-medium">
                Top Skip Reason {stats.topReason ? `(${stats.topReason[1]})` : ""}
              </div>
            </CardContent>
          </Card>
          <Card className="border-amber-200 dark:border-amber-800">
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stats.temporaryCount}</div>
              <div className="text-[11px] text-muted-foreground font-medium">Temporary Skips</div>
            </CardContent>
          </Card>
        </div>

        {/* Skip reason breakdown badges */}
        {Object.keys(stats.reasonCounts).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Object.entries(stats.reasonCounts).sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
              <Badge key={reason} variant="outline" className="text-[10px] font-mono">
                {reason}: {count}
              </Badge>
            ))}
          </div>
        )}

        <ScrollArea className="h-[65vh]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No suggestion history yet
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">ASIN</TableHead>
                  <TableHead className="w-[150px]">Title</TableHead>
                  <TableHead className="text-right w-[70px]">Old Min</TableHead>
                  <TableHead className="text-right w-[70px]">Suggested</TableHead>
                  <TableHead className="text-right w-[70px]">Applied</TableHead>
                  <TableHead className="text-right w-[70px]">Old Price</TableHead>
                  <TableHead className="text-right w-[70px]">New Price</TableHead>
                  <TableHead className="text-right w-[55px]">ROI →</TableHead>
                  <TableHead className="w-[60px]">BB</TableHead>
                  <TableHead className="w-[70px]">Decision</TableHead>
                  <TableHead className="w-[55px]">Type</TableHead>
                  <TableHead className="w-[50px]">Retry?</TableHead>
                  <TableHead className="w-[120px]">Reason / Rule</TableHead>
                  <TableHead className="w-[130px]">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const skipType = classifySkip(row.skip_reason);
                  const retryable = isSafeToRetry(row);
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">
                        {row.asin}
                      </TableCell>
                      <TableCell className="text-xs truncate max-w-[150px]">
                        {row.title || "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {fmt(row.old_min)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-amber-600 dark:text-amber-400">
                        {fmt(row.suggested_min)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs font-semibold">
                        {row.decision === "applied" ? (
                          <span className="text-green-600 dark:text-green-400">
                            {fmt(row.applied_min)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {fmt(row.old_price)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {row.new_price != null ? (
                          <span className="text-primary">{fmt(row.new_price)}</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {row.roi_before != null && row.roi_after != null ? (
                          <span>
                            <span className={row.roi_before >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}>
                              {row.roi_before.toFixed(1)}%
                            </span>
                            <span className="text-muted-foreground mx-0.5">→</span>
                            <span className={row.roi_after >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive"}>
                              {row.roi_after.toFixed(1)}%
                            </span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <BbStatusBadge
                          rawStatus={row.bb_status}
                          myPrice={row.old_price ?? row.new_price}
                          buyboxPrice={null}
                          compact
                        />
                      </TableCell>
                      <TableCell>
                        {row.decision === "applied" ? (
                          <Badge className="text-[10px] bg-green-600">
                            <Check className="h-2.5 w-2.5 mr-0.5" />
                            Applied
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-destructive border-destructive/50">
                            <X className="h-2.5 w-2.5 mr-0.5" />
                            Skipped
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.decision === "skipped" ? (
                          skipType === "policy" ? (
                            <Badge variant="outline" className="text-[10px] border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-400">
                              <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />
                              Policy
                            </Badge>
                          ) : skipType === "temporary" ? (
                            <Badge variant="outline" className="text-[10px] border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400">
                              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                              Temp
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {row.decision === "skipped" ? (
                          retryable ? (
                            <span className="text-green-600 dark:text-green-400 text-xs font-medium">Yes</span>
                          ) : (
                            <span className="text-muted-foreground text-xs">No</span>
                          )
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground truncate max-w-[120px]">
                        {row.skip_reason || row.rule_name || row.source || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(row.created_at), "MMM d, HH:mm")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
