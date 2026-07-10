import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Upload, Plus, Trash2, Pencil, CheckCircle2, XCircle, Filter, Download, RefreshCw, Ban, CalendarRange, ChevronDown } from "lucide-react";

type DispoType = "removal" | "disposal" | "liquidation" | "mfn_return";
type DispoStatus = "pending_review" | "accepted" | "ignored" | "adjusted";
type DispoSource = "amazon_report" | "manual" | "csv_import";
type DispoOutcome =
  | "pending"
  | "returned_to_inventory"
  | "sold_elsewhere"
  | "disposed"
  | "partial_recovery"
  | "restricted_unsold";

interface DispoRow {
  id: string;
  user_id: string;
  disposition_date: string;
  disposition_type: DispoType;
  amazon_order_id: string | null;
  removal_order_id: string | null;
  asin: string | null;
  msku: string | null;
  fnsku: string | null;
  title: string | null;
  sellable_qty: number;
  unsellable_qty: number;
  total_qty: number;
  unit_cost: number;
  cost_adjustment: number;
  returned_to_inventory_qty: number;
  recovery_amount: number;
  status: DispoStatus;
  source: DispoSource;
  notes: string | null;
  outcome: DispoOutcome;
  recovery_channel: string | null;
  recovery_notes: string | null;
  outcome_recorded_at: string | null;
  original_sellable_qty: number | null;
  original_unsellable_qty: number | null;
  reclassified_at: string | null;
  reclassified_reason: string | null;
}

const fmtUSD = (n: number) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Amazon Loss — InventoryLab parity: we treat ALL unsellable units as a business
 * loss (the seller eats it). Kept as a stub returning 0 so existing UI references
 * remain valid; the field is no longer surfaced in KPIs.
 */
const calcAmazonLoss = (_r: Pick<DispoRow, "unsellable_qty" | "unit_cost" | "recovery_amount" | "outcome">) => 0;

/**
 * Business Loss — matches InventoryLab: unsellable units × unit cost, net of any
 * recovery (e.g., liquidation proceeds). Applies to every row, regardless of
 * outcome status. Sellable units returned to inventory are NOT a loss.
 */
const calcBusinessLoss = (r: Pick<DispoRow, "unsellable_qty" | "unit_cost" | "recovery_amount">) => {
  const cost = (Number(r.unsellable_qty) || 0) * (Number(r.unit_cost) || 0);
  return Math.max(0, cost - (Number(r.recovery_amount) || 0));
};

/** Total P&L impact for a row (Amazon + Business). */
const calcTotalLoss = (r: DispoRow | (Pick<DispoRow, "sellable_qty" | "unsellable_qty" | "unit_cost" | "recovery_amount" | "outcome">)) =>
  calcAmazonLoss(r as any) + calcBusinessLoss(r as any);

const TYPE_LABEL: Record<DispoType, string> = {
  removal: "Removal",
  disposal: "Disposal",
  liquidation: "Liquidation",
  mfn_return: "MFN Return",
};

const STATUS_BADGE: Record<DispoStatus, string> = {
  pending_review: "bg-amber-500/15 text-amber-200 border-amber-500/40",
  accepted: "bg-emerald-500/15 text-emerald-200 border-emerald-500/40",
  ignored: "bg-zinc-500/15 text-zinc-200 border-zinc-500/40",
  adjusted: "bg-blue-500/15 text-blue-200 border-blue-500/40",
};

const OUTCOME_LABEL: Record<DispoOutcome, string> = {
  pending: "Outcome pending",
  returned_to_inventory: "Returned to inventory",
  sold_elsewhere: "Sold elsewhere",
  disposed: "Disposed (full loss)",
  partial_recovery: "Partial recovery",
  restricted_unsold: "Restricted / unsold",
};

const OUTCOME_BADGE: Record<DispoOutcome, string> = {
  pending: "bg-zinc-500/15 text-zinc-200 border-zinc-500/40",
  returned_to_inventory: "bg-emerald-500/15 text-emerald-200 border-emerald-500/40",
  sold_elsewhere: "bg-blue-500/15 text-blue-200 border-blue-500/40",
  disposed: "bg-red-500/15 text-red-200 border-red-500/40",
  partial_recovery: "bg-amber-500/15 text-amber-200 border-amber-500/40",
  restricted_unsold: "bg-orange-500/15 text-orange-200 border-orange-500/40",
};

const emptyDraft = (): Partial<DispoRow> => ({
  disposition_date: today(),
  disposition_type: "removal",
  status: "pending_review",
  source: "manual",
  sellable_qty: 0,
  unsellable_qty: 0,
  total_qty: 0,
  unit_cost: 0,
  recovery_amount: 0,
  returned_to_inventory_qty: 0,
  outcome: "pending",
  recovery_channel: null,
  recovery_notes: null,
});

export default function DispositionManagement() {
  const { user } = useAuth();
  const [rows, setRows] = useState<DispoRow[]>([]);
  const [loading, setLoading] = useState(false);

  // filters
  const CURRENT_YEAR = new Date().getFullYear();
  const YEAR_OPTIONS = [2024, 2025, 2026, 2027, 2028];
  const [year, setYear] = useState<number>(CURRENT_YEAR);
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;
  const [typeFilter, setTypeFilter] = useState<"all" | DispoType>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | DispoStatus>("all");
  const [sellabilityFilter, setSellabilityFilter] = useState<"all" | "sellable" | "unsellable">("all");
  const [search, setSearch] = useState("");
  const [groupByMonth, setGroupByMonth] = useState(false);

  // Report tab state (InventoryLab-style)
  const [reportTypeFilter, setReportTypeFilter] = useState<"all" | "removal" | "disposal" | "liquidation">("all");
  const [reportPageSize, setReportPageSize] = useState<number | "all">(50);
  const [reportSearch, setReportSearch] = useState("");

  type SortKey = "date" | "sellable" | "unsellable" | "unit_cost" | "recovery" | "loss";
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "date" ? "desc" : "desc"); }
  };

  // Amazon auto-sync
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  // Backfill year (month-by-month chunks)
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ year: number; month: number; total: number; inserted: number; skipped: number; errors: number } | null>(null);

  // edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<DispoRow>>(emptyDraft());

  // Bulk selection (detail table)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });

  const fileRef = useRef<HTMLInputElement>(null);

  const fetchRows = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("inventory_dispositions")
        .select("*")
        .gte("disposition_date", fromDate)
        .lte("disposition_date", toDate)
        .order("disposition_date", { ascending: false })
        .limit(2000);
      if (error) throw error;
      setRows((data || []) as DispoRow[]);
    } catch (e: any) {
      toast.error(`Failed to load: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [user?.id, fromDate, toDate]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // Load last Amazon sync time
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await supabase
        .from("disposition_sync_state")
        .select("last_synced_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data?.last_synced_at) setLastSyncedAt(data.last_synced_at);
    })();
  }, [user?.id]);

  const syncFromAmazon = async () => {
    if (!user?.id) return;
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-amazon-dispositions", {
        body: { days_back: 7, force_fresh: true, include_mfn_returns: false },
      });
      if (error) throw error;
      const inserted = data?.inserted ?? 0;
      const skipped = data?.skipped_duplicates ?? 0;
      const errCount = data?.errors ?? 0;
      const parsed = data?.parsed_rows ?? 0;
      const d = data?.diagnostics || {};
      const reportError: string | null = data?.report_error ?? null;
      const statuses = data?.report_statuses || {};

      // Source of truth: Amazon SP-API + ArbiProSeller cost contract.
      // CSV imports are now historical backfill only.
      if (reportError) {
        toast.error(`Amazon sync issue: ${reportError}`, {
          description:
            statuses?.removal?.status === 'forbidden'
              ? "Re-authorize Amazon with the Reports + Inventory roles in Settings → Amazon Connection."
              : "Check Edge Function logs for details.",
        });
      } else if (errCount > 0) {
        toast.error(
          `Amazon sync: ${inserted} new · ${skipped} duplicates · ${errCount} errors`,
          { description: "Check Edge Function logs for details. Some rows could not be saved." }
        );
      } else if (inserted === 0 && skipped === 0 && parsed === 0) {
        const removalEmpty = statuses?.removal?.status === 'empty';
        toast.message(
          removalEmpty
            ? "Amazon sync done — Amazon reports no removal activity in the last 60 days."
            : "Amazon sync done — no new removal activity."
        );
      } else if (inserted === 0 && skipped > 0) {
        toast.success(`Amazon sync: 0 new · ${skipped} already imported`);
      } else {
        toast.success(`Amazon sync: ${inserted} new · ${skipped} duplicates skipped`);
      }
      if (parsed > 0) {
        toast.message(
          `Raw report: ${d.total_rows ?? 0} rows · sellable=${d.sellable ?? 0} · unsellable=${d.unsellable ?? 0} · unknown=${d.unknown_disposition ?? 0}`,
          { description: `Order types — return=${d.order_type_return ?? 0}, disposal=${d.order_type_disposal ?? 0}, liquidation=${d.order_type_liquidation ?? 0}, other=${d.order_type_other ?? 0}` }
        );
        console.log('[disposition-sync] diagnostics', d);
      }
      setLastSyncedAt(new Date().toISOString());
      await fetchRows();
    } catch (e: any) {
      toast.error(`Amazon sync failed: ${e.message || e}`, {
        description: "Verify your Amazon connection in Settings → Amazon Connection.",
      });
    } finally {
      setSyncing(false);
    }
  };

  /**
   * Backfill an entire year by sending one SP-API report request per calendar month.
   * Amazon caps removal-report windows at ~31 days, so monthly chunks are the safe size.
   * Each chunk dedups via the unique index on (user_id, removal_order_id, asin, msku, disposition_date).
   */
  const backfillYear = async (year: number) => {
    if (!user?.id) return;
    if (backfilling) return;
    setBackfilling(true);
    const totals = { inserted: 0, skipped: 0, errors: 0 };
    setBackfillProgress({ year, month: 0, total: 12, ...totals });
    const today = new Date();
    const tId = toast.loading(`Backfilling ${year}: starting…`);

    try {
      for (let m = 0; m < 12; m++) {
        const start = new Date(Date.UTC(year, m, 1, 0, 0, 0));
        const end = new Date(Date.UTC(year, m + 1, 1, 0, 0, 0));
        if (start > today) {
          setBackfillProgress({ year, month: m + 1, total: 12, ...totals });
          continue;
        }
        const monthLabel = start.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        toast.loading(`Backfilling ${year} — ${monthLabel} (${m + 1}/12)…`, { id: tId });

        try {
          const { data, error } = await supabase.functions.invoke("sync-amazon-dispositions", {
            body: { start_date: start.toISOString(), end_date: end.toISOString() },
          });
          if (error) throw error;
          totals.inserted += data?.inserted ?? 0;
          totals.skipped += data?.skipped_duplicates ?? 0;
          totals.errors += data?.errors ?? 0;
        } catch (e: any) {
          totals.errors += 1;
          console.error(`[backfill] ${year}-${m + 1} failed:`, e?.message || e);
        }

        setBackfillProgress({ year, month: m + 1, total: 12, ...totals });
        await new Promise((res) => setTimeout(res, 1500));
      }

      if (totals.errors > 0) {
        toast.error(
          `Backfill ${year} done with errors: ${totals.inserted} new · ${totals.skipped} duplicates · ${totals.errors} errors`,
          { id: tId, description: "Some monthly chunks failed. Check Edge Function logs." }
        );
      } else {
        toast.success(
          `Backfill ${year} complete: ${totals.inserted} new · ${totals.skipped} duplicates skipped`,
          { id: tId }
        );
      }
      await fetchRows();
    } catch (e: any) {
      toast.error(`Backfill ${year} failed: ${e?.message || e}`, { id: tId });
    } finally {
      setBackfilling(false);
      setBackfillProgress(null);
    }
  };

  const filtered = useMemo(() => {
    const list = rows.filter(r => {
      if (typeFilter !== "all" && r.disposition_type !== typeFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (sellabilityFilter === "sellable" && (r.sellable_qty || 0) <= 0) return false;
      if (sellabilityFilter === "unsellable" && (r.unsellable_qty || 0) <= 0) return false;
      if (search) {
        const s = search.toLowerCase();
        const blob = `${r.asin || ""} ${r.msku || ""} ${r.fnsku || ""} ${r.title || ""} ${r.removal_order_id || ""}`.toLowerCase();
        if (!blob.includes(s)) return false;
      }
      return true;
    });
    const getVal = (r: DispoRow): number | string => {
      switch (sortKey) {
        case "date": return r.disposition_date || "";
        case "sellable": return Number(r.sellable_qty) || 0;
        case "unsellable": return Number(r.unsellable_qty) || 0;
        case "unit_cost": return Number(r.unit_cost) || 0;
        case "recovery": return Number(r.recovery_amount) || 0;
        case "loss": return calcTotalLoss(r);
      }
    };
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = getVal(a); const bv = getVal(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, typeFilter, statusFilter, sellabilityFilter, search, sortKey, sortDir]);

  const totals = useMemo(() => {
    let units = 0, sellable = 0, unsellable = 0, amazonLoss = 0, businessLoss = 0, recovery = 0, pendingOutcomes = 0, unsellableCost = 0, pendingLoss = 0, pendingUnsellableRows = 0;
    for (const r of filtered) {
      units += r.total_qty || ((r.sellable_qty || 0) + (r.unsellable_qty || 0));
      sellable += r.sellable_qty || 0;
      unsellable += r.unsellable_qty || 0;
      const rowUnsellableCost = (Number(r.unsellable_qty) || 0) * (Number(r.unit_cost) || 0);
      // Gross unsellable cost across all visible rows
      unsellableCost += rowUnsellableCost;
      const o = r.outcome || "pending";
      if (o === "pending" && (r.sellable_qty || 0) > 0) pendingOutcomes += 1;
      // KPI matches P&L: only accepted/adjusted rows contribute to Business Loss
      if (r.status === "accepted" || r.status === "adjusted") {
        amazonLoss += calcAmazonLoss(r);
        businessLoss += calcBusinessLoss(r);
        recovery += r.recovery_amount || 0;
      } else if (r.status === "pending_review" && (r.unsellable_qty || 0) > 0) {
        pendingLoss += Math.max(0, rowUnsellableCost - (Number(r.recovery_amount) || 0));
        pendingUnsellableRows += 1;
      }
    }
    return { units, sellable, unsellable, unsellableCost, amazonLoss, businessLoss, loss: amazonLoss + businessLoss, recovery, pendingOutcomes, pendingLoss, pendingUnsellableRows };
  }, [filtered]);


  /** Accounting period (YYYY-MM) derived from disposition_date */
  const periodOf = (date: string) => (date || "").slice(0, 7) || "—";

  /** Monthly aggregation respecting current filters; loss matches P&L (accepted/adjusted only) */
  const monthly = useMemo(() => {
    const map = new Map<string, { period: string; rows: number; sellable: number; unsellable: number; loss: number; recovery: number }>();
    for (const r of filtered) {
      const p = periodOf(r.disposition_date);
      const m = map.get(p) || { period: p, rows: 0, sellable: 0, unsellable: 0, loss: 0, recovery: 0 };
      m.rows += 1;
      m.sellable += r.sellable_qty || 0;
      m.unsellable += r.unsellable_qty || 0;
      if (r.status === "accepted" || r.status === "adjusted") {
        m.loss += calcTotalLoss(r);
        m.recovery += r.recovery_amount || 0;
      }
      map.set(p, m);
    }
    return Array.from(map.values()).sort((a, b) => b.period.localeCompare(a.period));
  }, [filtered]);

  const openNew = () => { setDraft(emptyDraft()); setEditOpen(true); };
  const openEdit = (r: DispoRow) => { setDraft({ ...r }); setEditOpen(true); };

  const saveDraft = async () => {
    if (!user?.id) return;
    const sellable = Number(draft.sellable_qty || 0);
    const unsellable = Number(draft.unsellable_qty || 0);
    const total = Number(draft.total_qty || 0) || (sellable + unsellable);
    const unit_cost = Number(draft.unit_cost || 0);
    const recovery = Number(draft.recovery_amount || 0);
    const cost_adjustment = Math.max(0, unsellable * unit_cost - recovery);

    const payload: any = {
      user_id: user.id,
      disposition_date: draft.disposition_date || today(),
      disposition_type: (draft.disposition_type || "removal") as DispoType,
      amazon_order_id: draft.amazon_order_id || null,
      removal_order_id: draft.removal_order_id || null,
      asin: draft.asin || null,
      msku: draft.msku || null,
      fnsku: draft.fnsku || null,
      title: draft.title || null,
      sellable_qty: sellable,
      unsellable_qty: unsellable,
      total_qty: total,
      unit_cost,
      cost_adjustment,
      returned_to_inventory_qty: Number(draft.returned_to_inventory_qty || 0),
      recovery_amount: recovery,
      status: (draft.status || "pending_review") as DispoStatus,
      source: (draft.source || "manual") as DispoSource,
      notes: draft.notes || null,
      outcome: (draft.outcome || "pending") as DispoOutcome,
      recovery_channel: draft.recovery_channel || null,
      recovery_notes: draft.recovery_notes || null,
      outcome_recorded_at: (draft.outcome && draft.outcome !== "pending") ? new Date().toISOString() : (draft.outcome_recorded_at || null),
    };

    try {
      let err;
      if (draft.id) {
        ({ error: err } = await supabase.from("inventory_dispositions").update(payload).eq("id", draft.id));
      } else {
        ({ error: err } = await supabase.from("inventory_dispositions").insert(payload));
      }
      if (err) throw err;
      toast.success(draft.id ? "Disposition updated" : "Disposition added");
      setEditOpen(false);
      await fetchRows();
    } catch (e: any) {
      toast.error(`Save failed: ${e.message || e}`);
    }
  };

  const updateRow = async (id: string, patch: Partial<DispoRow>) => {
    try {
      const { error } = await supabase.from("inventory_dispositions").update(patch).eq("id", id);
      if (error) throw error;
      await fetchRows();
    } catch (e: any) {
      toast.error(`Update failed: ${e.message || e}`);
    }
  };

  const removeRow = async (id: string) => {
    if (!confirm("Delete this disposition row?")) return;
    try {
      const { error } = await supabase.from("inventory_dispositions").delete().eq("id", id);
      if (error) throw error;
      toast.success("Deleted");
      await fetchRows();
    } catch (e: any) {
      toast.error(`Delete failed: ${e.message || e}`);
    }
  };

  /**
   * Mark rows as Unsellable (Restricted): moves sellable_qty → unsellable_qty so
   * the units count as a real business loss in P&L. Preserves Amazon's original
   * counts in original_sellable_qty / original_unsellable_qty for audit.
   */
  const markRestricted = async (ids: string[], reason = "Restricted") => {
    if (!ids.length) return;
    const targets = rows.filter(r => ids.includes(r.id));
    const eligible = targets.filter(r => (r.sellable_qty || 0) > 0);
    const skipped = targets.length - eligible.length;
    if (!eligible.length) {
      toast.info("Nothing to reclassify (no sellable units in selection).");
      return;
    }
    const totalUnits = eligible.reduce((s, r) => s + (r.sellable_qty || 0), 0);
    const msg = ids.length === 1
      ? `Move ${totalUnits} sellable unit(s) → unsellable for this row?\n\nThis records the full cost as a business loss and sets recovery to $0.`
      : `Reclassify ${eligible.length} row(s), ${totalUnits} unit(s) total, as Unsellable (Restricted)?${skipped ? `\n\n${skipped} row(s) with 0 sellable will be skipped.` : ""}\n\nThis records the full cost as a business loss and sets recovery to $0.`;
    if (!confirm(msg)) return;

    const tId = toast.loading(`Reclassifying ${eligible.length} row(s)…`);

    // Bulk-fetch unit costs from created_listings (Product Library) for any row missing a cost.
    // Contract A: amount = unit cost; otherwise derive cost/units.
    const asinsNeedingCost = Array.from(new Set(
      eligible.filter(r => (!r.unit_cost || r.unit_cost <= 0) && r.asin).map(r => r.asin as string)
    ));
    const costByAsin: Record<string, number> = {};
    if (asinsNeedingCost.length && user?.id) {
      const { data: cl } = await supabase
        .from("created_listings")
        .select("asin, amount, cost, units, updated_at")
        .eq("user_id", user.id)
        .in("asin", asinsNeedingCost)
        .order("updated_at", { ascending: false });
      for (const row of (cl || []) as any[]) {
        if (!row.asin || costByAsin[row.asin] != null) continue;
        let unit = 0;
        if (row.amount != null && Number(row.amount) >= 0) unit = Number(row.amount);
        else if (Number(row.cost) > 0 && Number(row.units) > 0) unit = Number(row.cost) / Number(row.units);
        if (unit > 0) costByAsin[row.asin] = unit;
      }
    }

    let ok = 0, fail = 0, costFilled = 0, costMissing = 0;
    for (const r of eligible) {
      const newUnsellable = (r.unsellable_qty || 0) + (r.sellable_qty || 0);
      let unitCost = Number(r.unit_cost) || 0;
      if (unitCost <= 0 && r.asin && costByAsin[r.asin]) {
        unitCost = costByAsin[r.asin];
        costFilled++;
      } else if (unitCost <= 0) {
        costMissing++;
      }
      const patch: any = {
        original_sellable_qty: r.original_sellable_qty ?? r.sellable_qty,
        original_unsellable_qty: r.original_unsellable_qty ?? r.unsellable_qty,
        sellable_qty: 0,
        unsellable_qty: newUnsellable,
        unit_cost: unitCost,
        cost_adjustment: Math.max(0, newUnsellable * unitCost),
        recovery_amount: 0,
        recovery_channel: null,
        outcome: "restricted_unsold",
        outcome_recorded_at: new Date().toISOString(),
        status: "accepted",
        reclassified_at: new Date().toISOString(),
        reclassified_reason: reason,
      };
      const { error } = await supabase.from("inventory_dispositions").update(patch).eq("id", r.id);
      if (error) fail++; else ok++;
    }
    if (costFilled) toast.message(`Filled unit cost from Product Library on ${costFilled} row(s).`);
    if (costMissing) toast.warning(`${costMissing} row(s) had no cost in Product Library — loss will show $0 until cost is set.`);
    toast.dismiss(tId);
    if (fail) toast.error(`Reclassified ${ok}, failed ${fail}`);
    else toast.success(`Reclassified ${ok} row(s) as Unsellable (Restricted).`);
    setSelectedIds(new Set());
    await fetchRows();
  };

  /**
   * Backfill unit_cost on currently-visible (filtered) rows that have $0 cost,
   * by looking up the latest unit cost in created_listings (Product Library).
   */
  const backfillCosts = async () => {
    if (!user?.id) return;
    const candidates = filtered.filter(r => (!r.unit_cost || r.unit_cost <= 0) && r.asin);
    if (!candidates.length) {
      toast.info("No rows in view need a cost backfill.");
      return;
    }
    if (!confirm(`Backfill unit cost on ${candidates.length} row(s) from your Product Library?`)) return;

    const tId = toast.loading(`Looking up costs for ${candidates.length} row(s)…`);
    const asins = Array.from(new Set(candidates.map(r => r.asin as string)));
    const costByAsin: Record<string, number> = {};
    for (let i = 0; i < asins.length; i += 200) {
      const chunk = asins.slice(i, i + 200);
      const { data: cl } = await supabase
        .from("created_listings")
        .select("asin, amount, cost, units, updated_at")
        .eq("user_id", user.id)
        .in("asin", chunk)
        .order("updated_at", { ascending: false });
      for (const row of (cl || []) as any[]) {
        if (!row.asin || costByAsin[row.asin] != null) continue;
        let unit = 0;
        if (row.amount != null && Number(row.amount) >= 0) unit = Number(row.amount);
        else if (Number(row.cost) > 0 && Number(row.units) > 0) unit = Number(row.cost) / Number(row.units);
        if (unit > 0) costByAsin[row.asin] = unit;
      }
    }

    let ok = 0, fail = 0, missing = 0;
    for (const r of candidates) {
      const unit = costByAsin[r.asin as string];
      if (!unit) { missing++; continue; }
      const { error } = await supabase
        .from("inventory_dispositions")
        .update({
          unit_cost: unit,
          cost_adjustment: Math.max(0, (r.unsellable_qty || 0) * unit),
        })
        .eq("id", r.id);
      if (error) fail++; else ok++;
    }
    toast.dismiss(tId);
    if (fail) toast.error(`Backfilled ${ok}, failed ${fail}, missing ${missing}`);
    else if (missing) toast.warning(`Backfilled ${ok}. ${missing} ASIN(s) had no cost in Product Library.`);
    else toast.success(`Backfilled cost on ${ok} row(s).`);
    await fetchRows();
  };

  /**
   * Bulk-accept all pending_review rows that have unsellable units.
   * Safe — sellable rows in pending_review are intentionally NOT touched
   * (they require manual review or markRestricted).
   */
  const acceptPendingUnsellable = async () => {
    if (!user?.id) return;
    const candidates = filtered.filter(
      r => r.status === "pending_review" && (r.unsellable_qty || 0) > 0
    );
    if (!candidates.length) {
      toast.info("No pending unsellable rows to accept in this view.");
      return;
    }
    const totalUnits = candidates.reduce((s, r) => s + (r.unsellable_qty || 0), 0);
    if (!confirm(
      `Accept ${candidates.length} pending row(s) (${totalUnits} unsellable unit(s)) into your P&L?\n\n` +
      `Sellable rows in pending_review are intentionally skipped — review them manually.`
    )) return;

    const tId = toast.loading(`Accepting ${candidates.length} row(s)…`);
    let ok = 0, fail = 0;
    const nowIso = new Date().toISOString();
    // Chunk updates to keep requests small
    for (let i = 0; i < candidates.length; i += 50) {
      const chunk = candidates.slice(i, i + 50);
      const ids = chunk.map(r => r.id);
      const { error } = await supabase
        .from("inventory_dispositions")
        .update({ status: "accepted", outcome_recorded_at: nowIso })
        .in("id", ids);
      if (error) fail += chunk.length; else ok += chunk.length;
    }
    toast.dismiss(tId);
    if (fail) toast.error(`Accepted ${ok}, failed ${fail}`);
    else toast.success(`Accepted ${ok} row(s) into P&L.`);
    await fetchRows();
  };

  // CSV import — flexible header matching for Amazon "Removal Order Detail" / InventoryLab exports
  const handleImport = async (file: File) => {
    if (!user?.id) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) { toast.error("Empty CSV"); return; }
    const splitCsv = (line: string) => {
      const out: string[] = []; let cur = ""; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { q = !q; continue; }
        if (c === "," && !q) { out.push(cur); cur = ""; continue; }
        cur += c;
      }
      out.push(cur);
      return out.map(s => s.trim());
    };
    const headers = splitCsv(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, "_"));
    const idx = (names: string[]) => {
      for (const n of names) {
        const i = headers.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const iDate = idx(["request_date", "date", "disposition_date", "removal_date"]);
    const iType = idx(["disposition", "disposition_type", "type", "request_type", "order_type"]);
    const iOrder = idx(["order_id", "removal_order_id", "request_id"]);
    const iAsin = idx(["asin"]);
    const iMsku = idx(["sku", "msku", "merchant_sku"]);
    const iFnsku = idx(["fnsku"]);
    const iTitle = idx(["title", "product_name", "item_name"]);
    const iSellable = idx(["sellable_quantity", "sellable", "shipped_quantity"]);
    const iUnsellable = idx(["unsellable_quantity", "unsellable", "damaged_quantity"]);
    const iCost = idx(["unit_cost", "cost"]);

    const normType = (s: string): DispoType => {
      const v = (s || "").toLowerCase();
      if (v.includes("dispos")) return "disposal";
      if (v.includes("liquid")) return "liquidation";
      if (v.includes("mfn") || v.includes("return")) return "mfn_return";
      return "removal";
    };
    const parseDate = (s: string): string => {
      if (!s) return today();
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return today();
    };

    const payload: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const c = splitCsv(lines[i]);
      const sellable = Number(c[iSellable] || 0) || 0;
      const unsellable = Number(c[iUnsellable] || 0) || 0;
      const unit_cost = Number(c[iCost] || 0) || 0;
      payload.push({
        user_id: user.id,
        disposition_date: parseDate(c[iDate] || ""),
        disposition_type: normType(c[iType] || ""),
        removal_order_id: c[iOrder] || null,
        asin: c[iAsin] || null,
        msku: c[iMsku] || null,
        fnsku: c[iFnsku] || null,
        title: c[iTitle] || null,
        sellable_qty: sellable,
        unsellable_qty: unsellable,
        total_qty: sellable + unsellable,
        unit_cost,
        cost_adjustment: Math.max(0, unsellable * unit_cost),
        recovery_amount: 0,
        returned_to_inventory_qty: 0,
        status: "pending_review",
        source: "amazon_report",
        notes: null,
      });
    }
    if (!payload.length) { toast.error("No rows parsed"); return; }

    try {
      // Chunked upsert with onConflict on dedupe key
      const chunkSize = 500;
      let imported = 0;
      for (let i = 0; i < payload.length; i += chunkSize) {
        const chunk = payload.slice(i, i + chunkSize);
        const { error } = await supabase
          .from("inventory_dispositions")
          .upsert(chunk, { onConflict: "user_id,disposition_date,disposition_type,removal_order_id,msku,asin", ignoreDuplicates: true });
        if (error) throw error;
        imported += chunk.length;
      }
      toast.success(`Imported ${imported} rows`);
      await fetchRows();
    } catch (e: any) {
      toast.error(`Import failed: ${e.message || e}`);
    }
  };

  const exportCsv = () => {
    const headers = ["date","type","status","source","asin","msku","fnsku","title","sellable","unsellable","total","unit_cost","recovery","loss","removal_order_id"];
    const lines = [headers.join(",")];
    for (const r of filtered) {
      lines.push([
        r.disposition_date, r.disposition_type, r.status, r.source,
        r.asin || "", r.msku || "", r.fnsku || "", `"${(r.title || "").replace(/"/g, '""')}"`,
        r.sellable_qty, r.unsellable_qty, r.total_qty, r.unit_cost, r.recovery_amount, calcTotalLoss(r).toFixed(2),
        r.removal_order_id || "",
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `dispositions_${fromDate}_${toDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#0f1c3f] text-white">
      <Navbar />
      <main className="max-w-[1400px] mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Disposition Management</h1>
          <p className="text-sm text-white/60">
            Track Amazon removals, disposals, liquidations, and MFN returns — plus the real <span className="font-semibold text-orange-300">business outcome</span> for each removed batch (returned, sold elsewhere, disposed, restricted/unsold). Both Amazon-reported loss and business loss flow into the P&amp;L under <span className="font-semibold">Inventory Disposition Loss</span>.
          </p>
        </div>

        <Tabs defaultValue="manage" className="w-full">
          <TabsList className="bg-white/5 border border-white/10">
            <TabsTrigger value="manage" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white">Manage</TabsTrigger>
            <TabsTrigger value="report" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white">Removals & Disposals Report</TabsTrigger>
          </TabsList>

          <TabsContent value="manage" className="space-y-6 mt-4">

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
          <KPI label="Rows" value={String(filtered.length)} />
          <KPI label="Total Units" value={String(totals.units)} />
          <KPI label="Sellable" value={String(totals.sellable)} accent="text-emerald-300" />
          <KPI label="Unsellable" value={String(totals.unsellable)} accent="text-red-300" />
          <KPI label="Unsellable Cost (all visible)" value={fmtUSD(totals.unsellableCost)} accent="text-red-300" />
          <KPI label="Business Loss (in P&L)" value={fmtUSD(totals.businessLoss)} accent="text-red-400" />
          <KPI label="Pending Loss (not in P&L)" value={fmtUSD(totals.pendingLoss)} accent="text-amber-300" />
        </div>
        <p className="text-xs text-white/50 -mt-2">
          <span className="text-red-300">Unsellable Cost</span> = gross cost of every visible unsellable unit. 
          <span className="text-red-400 ml-1">Business Loss</span> = only rows with status <span className="font-mono">accepted/adjusted</span> (already in your P&amp;L). 
          <span className="text-amber-300 ml-1">Pending Loss</span> = unsellable cost on <span className="font-mono">pending_review</span> rows — accept them before filing taxes.
        </p>

        {/* Toolbar */}
        <Card className="bg-white/5 border-white/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center gap-2">
              <Filter className="h-4 w-4" /> Filters
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-2">
              <Label className="text-xs text-white/70">Year</Label>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="bg-white/10 border-white/20 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {YEAR_OPTIONS.map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs text-white/70">Type</Label>
              <Select value={typeFilter} onValueChange={(v: any) => setTypeFilter(v)}>
                <SelectTrigger className="bg-white/10 border-white/20 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="removal">Removal</SelectItem>
                  <SelectItem value="disposal">Disposal</SelectItem>
                  <SelectItem value="liquidation">Liquidation</SelectItem>
                  <SelectItem value="mfn_return">MFN Return</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs text-white/70">Status</Label>
              <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
                <SelectTrigger className="bg-white/10 border-white/20 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending_review">Pending review</SelectItem>
                  <SelectItem value="accepted">Accepted</SelectItem>
                  <SelectItem value="adjusted">Adjusted</SelectItem>
                  <SelectItem value="ignored">Ignored</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs text-white/70">Sellability</Label>
              <Select value={sellabilityFilter} onValueChange={(v: any) => setSellabilityFilter(v)}>
                <SelectTrigger className="bg-white/10 border-white/20 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="sellable">Sellable &gt; 0</SelectItem>
                  <SelectItem value="unsellable">Unsellable &gt; 0</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs text-white/70">Search ASIN / MSKU / Title</Label>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="B0..." className="bg-white/10 border-white/20 text-white" />
            </div>

            <div className="md:col-span-12 flex flex-wrap items-center gap-2 pt-2">
              <Button onClick={syncFromAmazon} disabled={syncing} className="bg-emerald-600 hover:bg-emerald-700">
                <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing from Amazon…" : "Sync Now"}
              </Button>
              <Button onClick={openNew} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="h-4 w-4 mr-1" /> Add disposition
              </Button>
              <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4 mr-1" /> Import CSV
              </Button>
              <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0]; if (f) handleImport(f); e.currentTarget.value = "";
              }} />
              <Button variant="secondary" onClick={exportCsv}>
                <Download className="h-4 w-4 mr-1" /> Export view
              </Button>
              <Button variant="secondary" onClick={backfillCosts} className="bg-amber-600/80 hover:bg-amber-600 text-white">
                Backfill costs from Library
              </Button>
              <Button
                variant="secondary"
                onClick={acceptPendingUnsellable}
                className="bg-emerald-600/80 hover:bg-emerald-600 text-white"
                title="Move all pending_review rows that have unsellable units into your P&L. Sellable pending rows are skipped."
              >
                Accept pending unsellable ({totals.pendingUnsellableRows})
              </Button>
              <Button variant="ghost" onClick={fetchRows} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button
                variant={groupByMonth ? "default" : "secondary"}
                onClick={() => setGroupByMonth(v => !v)}
                className={groupByMonth ? "bg-blue-600 hover:bg-blue-700" : ""}
              >
                <Filter className="h-4 w-4 mr-1" /> {groupByMonth ? "Showing: Group by Month" : "Group by Month"}
              </Button>
              {lastSyncedAt && (
                <span className="text-xs text-white/60 ml-auto">
                  Last Amazon sync: {new Date(lastSyncedAt).toLocaleString()}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Monthly summary view */}
        {groupByMonth ? (
          <Card className="bg-white/5 border-white/10">
            <CardHeader className="pb-2">
              <CardTitle className="text-white text-base">Monthly Breakdown</CardTitle>
              <p className="text-xs text-white/60">
                Loss column reflects P&amp;L-impacting rows only (status = accepted or adjusted).
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-white/10">
                    <TableHead className="text-white/70">Accounting Period</TableHead>
                    <TableHead className="text-white/70 text-right">Rows</TableHead>
                    <TableHead className="text-white/70 text-right">Sellable</TableHead>
                    <TableHead className="text-white/70 text-right">Unsellable</TableHead>
                    <TableHead className="text-white/70 text-right">Recovery</TableHead>
                    <TableHead className="text-white/70 text-right">Disposition Loss (P&amp;L)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthly.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-white/60 py-10">
                        No disposition rows in this period.
                      </TableCell>
                    </TableRow>
                  )}
                  {monthly.map(m => (
                    <TableRow key={m.period} className="border-white/10 hover:bg-white/5">
                      <TableCell className="text-white font-mono">{m.period}</TableCell>
                      <TableCell className="text-right text-white/80">{m.rows}</TableCell>
                      <TableCell className="text-right text-emerald-300">{m.sellable}</TableCell>
                      <TableCell className="text-right text-red-300">{m.unsellable}</TableCell>
                      <TableCell className="text-right font-mono">{fmtUSD(m.recovery)}</TableCell>
                      <TableCell className="text-right font-mono text-red-300">{fmtUSD(m.loss)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
        /* Detail table */
        <Card className="bg-white/5 border-white/10">
          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/10 bg-orange-500/10">
              <div className="text-sm text-white/90">
                <span className="font-semibold">{selectedIds.size}</span> row(s) selected
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="bg-orange-600 hover:bg-orange-700"
                  onClick={() => markRestricted(Array.from(selectedIds))}
                >
                  <Ban className="h-4 w-4 mr-1" /> Mark as Unsellable (Restricted)
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
          )}
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-white/10">
                  <TableHead className="text-white/70 w-[36px]">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={filtered.length > 0 && filtered.every(r => selectedIds.has(r.id))}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedIds(new Set(filtered.map(r => r.id)));
                        else setSelectedIds(new Set());
                      }}
                    />
                  </TableHead>
                  <TableHead className="text-white/70 cursor-pointer select-none" onClick={() => toggleSort("date")}>
                    Date {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </TableHead>
                  <TableHead className="text-white/70">Period</TableHead>
                  <TableHead className="text-white/70">Type</TableHead>
                  <TableHead className="text-white/70">Item</TableHead>
                  <TableHead className="text-white/70 text-right cursor-pointer select-none" onClick={() => toggleSort("sellable")}>
                    Sellable {sortKey === "sellable" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </TableHead>
                  <TableHead className="text-white/70 text-right cursor-pointer select-none" onClick={() => toggleSort("unsellable")}>
                    Unsellable {sortKey === "unsellable" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </TableHead>
                  <TableHead className="text-white/70 text-right cursor-pointer select-none" onClick={() => toggleSort("unit_cost")}>
                    Unit Cost {sortKey === "unit_cost" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </TableHead>
                  <TableHead className="text-white/70 text-right cursor-pointer select-none" onClick={() => toggleSort("recovery")}>
                    Recovery {sortKey === "recovery" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </TableHead>
                  <TableHead className="text-white/70 text-right cursor-pointer select-none" onClick={() => toggleSort("loss")}>
                    Loss {sortKey === "loss" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                  </TableHead>
                  <TableHead className="text-white/70">Status</TableHead>
                  <TableHead className="text-white/70">Outcome</TableHead>
                  <TableHead className="text-white/70 w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={13} className="text-center text-white/60 py-10">
                      No disposition rows in this period. Import a CSV or add one manually.
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map(r => (
                  <TableRow key={r.id} className="border-white/10 hover:bg-white/5">
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        checked={selectedIds.has(r.id)}
                        onChange={() => toggleSelect(r.id)}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-white/80">{r.disposition_date}</TableCell>
                    <TableCell className="text-xs font-mono text-white/70">{periodOf(r.disposition_date)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-white/20 text-white/90">{TYPE_LABEL[r.disposition_type]}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[360px]">
                      <div className="text-sm text-white truncate">{r.title || r.asin || r.msku || "—"}</div>
                      <div className="text-[11px] text-white/50">
                        {r.asin || "—"} · {r.msku || "—"} {r.removal_order_id ? `· ${r.removal_order_id}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-emerald-300">{r.sellable_qty}</TableCell>
                    <TableCell className="text-right text-red-300">{r.unsellable_qty}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUSD(r.unit_cost)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUSD(r.recovery_amount)}</TableCell>
                    <TableCell className="text-right font-mono text-red-300">{fmtUSD(calcTotalLoss(r))}</TableCell>
                    <TableCell>
                      <Badge className={`border ${STATUS_BADGE[r.status]}`}>{r.status.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={r.outcome || "pending"}
                        onValueChange={(v: any) => updateRow(r.id, { outcome: v, outcome_recorded_at: v === "pending" ? null : new Date().toISOString() } as any)}
                      >
                        <SelectTrigger className={`h-7 text-xs border ${OUTCOME_BADGE[r.outcome || "pending"]} w-[170px]`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pending">Outcome pending</SelectItem>
                          <SelectItem value="returned_to_inventory">Returned to inventory</SelectItem>
                          <SelectItem value="sold_elsewhere">Sold elsewhere</SelectItem>
                          <SelectItem value="partial_recovery">Partial recovery</SelectItem>
                          <SelectItem value="disposed">Disposed (full loss)</SelectItem>
                          <SelectItem value="restricted_unsold">Restricted / unsold</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" title="Edit" onClick={() => openEdit(r)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Mark reviewed (accept)" onClick={() => updateRow(r.id, { status: "accepted" })}>
                          <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Mark as Unsellable (Restricted) — moves sellable units to unsellable, recovery $0, full business loss"
                          onClick={() => markRestricted([r.id])}
                        >
                          <Ban className="h-4 w-4 text-orange-400" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Ignore" onClick={() => updateRow(r.id, { status: "ignored" })}>
                          <XCircle className="h-4 w-4 text-zinc-300" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Delete" onClick={() => removeRow(r.id)}>
                          <Trash2 className="h-4 w-4 text-red-400" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        )}

          </TabsContent>

          <TabsContent value="report" className="space-y-4 mt-4">
            <ReportTab
              rows={rows}
              year={year}
              setYear={setYear}
              YEAR_OPTIONS={YEAR_OPTIONS}
              reportTypeFilter={reportTypeFilter}
              setReportTypeFilter={setReportTypeFilter}
              reportPageSize={reportPageSize}
              setReportPageSize={setReportPageSize}
              reportSearch={reportSearch}
              setReportSearch={setReportSearch}
              lastSyncedAt={lastSyncedAt}
            />
          </TabsContent>
        </Tabs>
      </main>

      {/* Edit / Add dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft.id ? "Edit disposition" : "Add disposition"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <Input type="date" value={draft.disposition_date || today()} onChange={(e) => setDraft({ ...draft, disposition_date: e.target.value })} />
            </Field>
            <Field label="Type">
              <Select value={(draft.disposition_type as string) || "removal"} onValueChange={(v: any) => setDraft({ ...draft, disposition_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="removal">Removal</SelectItem>
                  <SelectItem value="disposal">Disposal</SelectItem>
                  <SelectItem value="liquidation">Liquidation</SelectItem>
                  <SelectItem value="mfn_return">MFN Return</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="ASIN"><Input value={draft.asin || ""} onChange={(e) => setDraft({ ...draft, asin: e.target.value })} /></Field>
            <Field label="MSKU"><Input value={draft.msku || ""} onChange={(e) => setDraft({ ...draft, msku: e.target.value })} /></Field>
            <Field label="FNSKU"><Input value={draft.fnsku || ""} onChange={(e) => setDraft({ ...draft, fnsku: e.target.value })} /></Field>
            <Field label="Removal / Order ID"><Input value={draft.removal_order_id || ""} onChange={(e) => setDraft({ ...draft, removal_order_id: e.target.value })} /></Field>
            <Field label="Title" full><Input value={draft.title || ""} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field>
            <Field label="Sellable qty"><Input type="number" value={draft.sellable_qty ?? 0} onChange={(e) => setDraft({ ...draft, sellable_qty: Number(e.target.value) })} /></Field>
            <Field label="Unsellable qty"><Input type="number" value={draft.unsellable_qty ?? 0} onChange={(e) => setDraft({ ...draft, unsellable_qty: Number(e.target.value) })} /></Field>
            <Field label="Unit cost ($)"><Input type="number" step="0.01" value={draft.unit_cost ?? 0} onChange={(e) => setDraft({ ...draft, unit_cost: Number(e.target.value) })} /></Field>
            <Field label="Recovery amount ($)"><Input type="number" step="0.01" value={draft.recovery_amount ?? 0} onChange={(e) => setDraft({ ...draft, recovery_amount: Number(e.target.value) })} /></Field>
            <Field label="Returned to inventory qty"><Input type="number" value={draft.returned_to_inventory_qty ?? 0} onChange={(e) => setDraft({ ...draft, returned_to_inventory_qty: Number(e.target.value) })} /></Field>
            <Field label="Status">
              <Select value={(draft.status as string) || "pending_review"} onValueChange={(v: any) => setDraft({ ...draft, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending_review">Pending review</SelectItem>
                  <SelectItem value="accepted">Accepted</SelectItem>
                  <SelectItem value="adjusted">Adjusted</SelectItem>
                  <SelectItem value="ignored">Ignored</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Business Outcome" full>
              <Select value={(draft.outcome as string) || "pending"} onValueChange={(v: any) => setDraft({ ...draft, outcome: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Outcome pending</SelectItem>
                  <SelectItem value="returned_to_inventory">Returned to inventory (no loss)</SelectItem>
                  <SelectItem value="sold_elsewhere">Sold elsewhere (eBay/Walmart) — enter recovery</SelectItem>
                  <SelectItem value="partial_recovery">Partial recovery — enter recovery</SelectItem>
                  <SelectItem value="disposed">Disposed (full loss)</SelectItem>
                  <SelectItem value="restricted_unsold">Restricted / unsold (full loss)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Recovery channel (eBay, Walmart, local…)"><Input value={draft.recovery_channel || ""} onChange={(e) => setDraft({ ...draft, recovery_channel: e.target.value })} /></Field>
            <Field label="Recovery notes"><Input value={draft.recovery_notes || ""} onChange={(e) => setDraft({ ...draft, recovery_notes: e.target.value })} /></Field>
            <Field label="Notes" full><Input value={draft.notes || ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>
            <div className="col-span-2 text-xs text-muted-foreground space-y-1">
              <div>
                Amazon loss: <span className="font-semibold text-red-500">{fmtUSD(calcAmazonLoss({ unsellable_qty: Number(draft.unsellable_qty || 0), unit_cost: Number(draft.unit_cost || 0), recovery_amount: Number(draft.recovery_amount || 0), outcome: (draft.outcome as DispoOutcome) || "pending" } as any))}</span>
                <span className="ml-2">= unsellable × unit_cost − recovery</span>
              </div>
              <div>
                Business loss: <span className="font-semibold text-orange-500">{fmtUSD(calcBusinessLoss({ sellable_qty: Number(draft.sellable_qty || 0), unsellable_qty: Number(draft.unsellable_qty || 0), unit_cost: Number(draft.unit_cost || 0), recovery_amount: Number(draft.recovery_amount || 0), outcome: (draft.outcome as DispoOutcome) || "pending" } as any))}</span>
                <span className="ml-2">applies when outcome = disposed / sold elsewhere / partial / restricted</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={saveDraft}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KPI({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg bg-white/5 border border-white/10 p-3">
      <div className="text-xs text-white/60">{label}</div>
      <div className={`text-xl font-semibold ${accent || "text-white"}`}>{value}</div>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Tab — InventoryLab-style read-only Removals / Disposals / Liquidated.
// ─────────────────────────────────────────────────────────────────────────────
function ReportTab(props: {
  rows: DispoRow[];
  year: number;
  setYear: (y: number) => void;
  YEAR_OPTIONS: number[];
  reportTypeFilter: "all" | "removal" | "disposal" | "liquidation";
  setReportTypeFilter: (v: "all" | "removal" | "disposal" | "liquidation") => void;
  reportPageSize: number | "all";
  setReportPageSize: (n: number | "all") => void;
  reportSearch: string;
  setReportSearch: (s: string) => void;
  lastSyncedAt: string | null;
}) {
  const {
    rows, year, setYear, YEAR_OPTIONS,
    reportTypeFilter, setReportTypeFilter,
    reportPageSize, setReportPageSize,
    reportSearch, setReportSearch,
    lastSyncedAt,
  } = props;

  const baseRows = rows.filter(r => r.disposition_type !== "mfn_return");
  const counts = {
    all: baseRows.length,
    removal: baseRows.filter(r => r.disposition_type === "removal").length,
    disposal: baseRows.filter(r => r.disposition_type === "disposal").length,
    liquidation: baseRows.filter(r => r.disposition_type === "liquidation").length,
  };

  let view = baseRows;
  if (reportTypeFilter !== "all") view = view.filter(r => r.disposition_type === reportTypeFilter);
  if (reportSearch.trim()) {
    const q = reportSearch.trim().toLowerCase();
    view = view.filter(r =>
      (r.title || "").toLowerCase().includes(q) ||
      (r.asin || "").toLowerCase().includes(q) ||
      (r.msku || "").toLowerCase().includes(q) ||
      (r.removal_order_id || "").toLowerCase().includes(q)
    );
  }
  view = [...view].sort((a, b) => (b.disposition_date || "").localeCompare(a.disposition_date || ""));

  const total = view.length;
  const sliced = reportPageSize === "all" ? view : view.slice(0, reportPageSize);

  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
    if (isNaN(d.getTime())) return iso;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${mm}/${dd}/${yy}`;
  };

  // "Total Fees" = net business cost = unsellable_qty × unit_cost − recovery_amount.
  // Amazon's per-unit removal/disposal fee is not yet tracked separately in the schema.
  const calcFees = (r: DispoRow) =>
    Math.max(0, (r.unsellable_qty || 0) * (Number(r.unit_cost) || 0) - (Number(r.recovery_amount) || 0));

  const TYPE_PILL: Record<string, string> = {
    removal: "bg-blue-500/15 text-blue-200 border-blue-500/40",
    disposal: "bg-red-500/15 text-red-200 border-red-500/40",
    liquidation: "bg-amber-500/15 text-amber-200 border-amber-500/40",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-white">Reports — Removals & Disposals</h2>
          <p className="text-xs text-white/60">
            Read-only settlement-based report. Filter by year, type, and search. "Total Fees" is the net business cost (unsellable cost − recovery).
          </p>
        </div>
        {lastSyncedAt && (
          <span className="text-[11px] text-white/50">
            Last Updated: {new Date(lastSyncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap border-b border-white/10 pb-2">
        {(["all", "removal", "disposal", "liquidation"] as const).map(t => {
          const labels = { all: "All", removal: "Removals", disposal: "Disposals", liquidation: "Liquidated" } as const;
          const active = reportTypeFilter === t;
          return (
            <button
              key={t}
              onClick={() => setReportTypeFilter(t)}
              className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                active ? "bg-blue-600 text-white border-blue-500" : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10"
              }`}
            >
              {labels[t]} <span className="text-[11px] opacity-70 ml-1">{counts[t]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-white/70">Year</Label>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="bg-white/10 border-white/20 text-white h-8 w-[110px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {YEAR_OPTIONS.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <Input
          placeholder="Search ASIN, MSKU, Title, Order ID…"
          value={reportSearch}
          onChange={(e) => setReportSearch(e.target.value)}
          className="bg-white/10 border-white/20 text-white h-8 max-w-xs"
        />

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-white/60">Viewing {sliced.length} of {total} Removals/Disposals</span>
          <span className="text-xs text-white/60">Show</span>
          {[50, 100, 200, "all"].map(opt => (
            <button
              key={String(opt)}
              onClick={() => setReportPageSize(opt as any)}
              className={`px-2 py-1 text-xs rounded border ${
                reportPageSize === opt ? "bg-blue-600 text-white border-blue-500" : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10"
              }`}
            >
              {opt === "all" ? "All" : opt}
            </button>
          ))}
        </div>
      </div>

      <Card className="bg-white/5 border-white/10">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-white/10">
                <TableHead className="text-white/70">Order ID</TableHead>
                <TableHead className="text-white/70">Title</TableHead>
                <TableHead className="text-white/70">Type</TableHead>
                <TableHead className="text-white/70">Status</TableHead>
                <TableHead className="text-white/70">ASIN</TableHead>
                <TableHead className="text-white/70">Sellable?</TableHead>
                <TableHead className="text-white text-right">Requested</TableHead>
                <TableHead className="text-white text-right">Cancelled</TableHead>
                <TableHead className="text-white text-right">Completed</TableHead>
                <TableHead className="text-white text-right">Total Fees</TableHead>
                <TableHead className="text-white/70">Requested</TableHead>
                <TableHead className="text-white/70">Last Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sliced.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-white/60 py-10">
                    No removals or disposals in this period.
                  </TableCell>
                </TableRow>
              )}
              {sliced.map(r => {
                const requested = (r.sellable_qty || 0) + (r.unsellable_qty || 0);
                const completed = r.status === "accepted" || r.status === "adjusted" ? requested : 0;
                const cancelled = r.status === "ignored" ? requested : 0;
                const sellable = (r.sellable_qty || 0) > 0;
                return (
                  <TableRow key={r.id} className="border-white/10 hover:bg-white/5">
                    <TableCell className="font-mono text-xs text-white/80 whitespace-nowrap">
                      {r.removal_order_id || "—"}
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <div className="text-sm text-white truncate">{r.title || "—"}</div>
                      {r.msku && <div className="text-[11px] text-white/50">MSKU: {r.msku}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge className={`border ${TYPE_PILL[r.disposition_type] || "border-white/20"}`}>
                        {TYPE_LABEL[r.disposition_type]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={`border ${STATUS_BADGE[r.status]}`}>{r.status.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-white/80">{r.asin || "—"}</TableCell>
                    <TableCell className={sellable ? "text-emerald-300" : "text-white/50"}>{sellable ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-right">{requested}</TableCell>
                    <TableCell className="text-right">{cancelled}</TableCell>
                    <TableCell className="text-right">{completed}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUSD(calcFees(r))}</TableCell>
                    <TableCell className="text-xs text-white/70 whitespace-nowrap">{fmtDate(r.disposition_date)}</TableCell>
                    <TableCell className="text-xs text-white/70 whitespace-nowrap">{fmtDate(r.outcome_recorded_at || r.disposition_date)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
