import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, RefreshCw, Trash2, DollarSign, Info, History, AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown, Wrench } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useModuleAccess } from "@/hooks/useModuleAccess";

// ----- Types -----
interface ShipmentRow {
  shipment_id: string;
  shipment_name: string | null;
  shipment_status: string | null;
  shipment_date: string;
  unresolved_date?: boolean;
  units_shipped: number;
  units_received: number;
  cogs: number;
  amazon_inbound_fee: number;
  manual_cost: number;
  total_cost: number;
  estimated_revenue: number | null;
  estimated_profit: number | null;
  revenue_confidence: "Matched" | "Estimated" | "No revenue match" | string;
}

interface UnresolvedShipment {
  shipment_id: string;
  shipment_name: string | null;
  shipment_status: string | null;
  confirmed_need_by_date: string | null;
  created_at: string;
  units_shipped: number;
}

interface ManualCost {
  id: string;
  shipment_id: string;
  amount: number;
  note: string | null;
  cost_date: string;
}

// One row per (window, shipment_status) returned by get_shipment_backfill_status.
interface BackfillProgressRow {
  window_start: string;
  window_end: string;
  shipment_status: string;
  next_page: number;
  pages_processed: number;
  shipments_found: number;
  shipments_upserted: number;
  items_upserted: number;
  state: "pending" | "running" | "complete" | "failed" | string;
  last_error: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

// Statuses we sweep per window during backfill — must match the edge function.
const BACKFILL_STATUSES = [
  "WORKING",
  "SHIPPED",
  "IN_TRANSIT",
  "DELIVERED",
  "CHECKED_IN",
  "RECEIVING",
  "CLOSED",
  "CANCELLED",
  "DELETED",
  "ERROR",
] as const;

// Quarters of the year — UI orchestrator passes one (window, status) at a time.
function buildBackfillWindows(year: number) {
  const todayStr = new Date().toISOString().slice(0, 10);
  return [
    { start: `${year}-01-01`, end: `${year}-04-01`, label: `Jan–Mar ${year}` },
    { start: `${year}-04-01`, end: `${year}-07-01`, label: `Apr–Jun ${year}` },
    { start: `${year}-07-01`, end: `${year}-10-01`, label: `Jul–Sep ${year}` },
    { start: `${year}-10-01`, end: `${year + 1}-01-01`, label: `Oct–Dec ${year}` },
  ].map((w) => ({
    ...w,
    // Cap any future-dated quarter at today so we don't ask SP-API for tomorrow.
    end: w.end > todayStr ? todayStr : w.end,
  }));
}

const fmtUSD = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v || 0);

// Returns "—" for null/undefined so "No revenue match" rows stay blank instead of $0.00.
const fmtMaybeUSD = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : fmtUSD(Number(v));

// US date format MM/DD/YYYY for display. Accepts ISO date strings (YYYY-MM-DD)
// or full timestamps. Returns "—" for null/empty so unresolved rows stay blank.
const fmtUSDate = (v: string | null | undefined) => {
  if (!v) return "—";
  // Parse YYYY-MM-DD as a local date (avoid TZ shift to previous day).
  const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = isoDateOnly ? new Date(`${v}T12:00:00`) : new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

const ConfidenceBadge = ({ value, unitsReceived }: { value: string; unitsReceived?: number }) => {
  // Plain text labels, no emoji. Color-coded via design tokens.
  const cls =
    value === "Matched"
      ? "border-emerald-500/40 text-emerald-500 bg-emerald-500/10"
      : value === "Estimated"
      ? "border-amber-500/40 text-amber-500 bg-amber-500/10"
      : "border-muted-foreground/30 text-muted-foreground bg-muted/40";

  // Tooltip explanations
  let explanation = "";
  if (value === "Matched") {
    explanation =
      "Every ASIN in this shipment had settled revenue matched within its lifetime window. Revenue is allocated proportionally by units across split shipments.";
  } else if (value === "Estimated") {
    if (unitsReceived === 0) {
      explanation =
        "Revenue matched, but shipment has 0 received units. Revenue may belong to other in-stock inventory of the same ASIN.";
    } else {
      explanation =
        "Some ASINs in this shipment had no settled revenue match. Shown revenue is partial.";
    }
  } else {
    explanation =
      "No settled revenue could be matched to this shipment's ASINs within their lifetime windows.";
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`${cls} cursor-help`}>
          {value}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="text-xs">{explanation}</p>
      </TooltipContent>
    </Tooltip>
  );
};

const monthLabels = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function ShipmentAccounting() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const today = new Date();
  const [year, setYear] = useState<number>(today.getFullYear());
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [loadError, setLoadError] = useState<{ kind: "timeout" | "generic"; message: string } | null>(null);

  const [profitFilter, setProfitFilter] = useState<"all" | "profitable" | "loss" | "no_match">("all");
  // Sort state for the per-shipment table. Defaults to most profitable per unit first.
  type SortKey = "date" | "profit_per_unit";
  type SortDir = "asc" | "desc";
  const [sortKey, setSortKey] = useState<SortKey>("profit_per_unit");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible defaults: dates newest-first; profit per unit highest-first.
      setSortDir(key === "date" ? "desc" : "desc");
    }
  };
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<string>("");
  // Per-(window,status) live progress for the summary table.
  const [progressRows, setProgressRows] = useState<BackfillProgressRow[]>([]);
  const [progressLoading, setProgressLoading] = useState(false);
  // Stop flag the user can flip from the UI without losing already-saved progress.
  const [stopRequested, setStopRequested] = useState(false);

  // Date-sync state: pulls real ship/received dates from SP-API in batches.
  // Without this, shipments backfilled in bulk all share the same created_at and
  // get bucketed into the wrong month.
  const [datesSyncing, setDatesSyncing] = useState(false);
  const [datesSyncProgress, setDatesSyncProgress] = useState<string>("");
  const [datesRemaining, setDatesRemaining] = useState<number | null>(null);
  const [stopDateSync, setStopDateSync] = useState(false);

  // Repair-empty-shipments state (admin-only). Re-pulls items from SP-API for
  // shipments where fba_shipment_items count = 0 (typically multi-destination
  // splits where the items endpoint returned nothing during the original sync).
  const { isAdmin } = useModuleAccess();
  const [repairing, setRepairing] = useState(false);
  const [repairProgress, setRepairProgress] = useState<string>("");
  const [missingItemsCount, setMissingItemsCount] = useState<number | null>(null);
  const [stopRepair, setStopRepair] = useState(false);
  const [repairLog, setRepairLog] = useState<Array<{
    shipment_id: string;
    shipment_name: string | null;
    outcome: "repaired" | "still_empty" | "failed";
    items_inserted: number;
    error?: string;
  }>>([]);
  const [repairLogOpen, setRepairLogOpen] = useState(false);

  // Unresolved-date shipments: those for which no reliable ship date could be
  // derived. Excluded from totals by default to avoid silently bucketing them
  // into the wrong year (the Apr-2026 bug we just fixed).
  const [unresolvedCount, setUnresolvedCount] = useState<number>(0);
  const [includeUnresolved, setIncludeUnresolved] = useState<boolean>(false);
  const [unresolvedDialogOpen, setUnresolvedDialogOpen] = useState<boolean>(false);
  const [unresolvedList, setUnresolvedList] = useState<UnresolvedShipment[]>([]);
  const [unresolvedLoading, setUnresolvedLoading] = useState<boolean>(false);
  const [manualDateDraft, setManualDateDraft] = useState<Record<string, string>>({});

  const [costsByShipment, setCostsByShipment] = useState<Record<string, ManualCost[]>>({});
  const [openCostsFor, setOpenCostsFor] = useState<ShipmentRow | null>(null);
  const [newAmount, setNewAmount] = useState<string>("");
  const [newNote, setNewNote] = useState<string>("");
  const [newDate, setNewDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [savingCost, setSavingCost] = useState(false);

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }
    void load();
    void loadProgress();
    void countShipmentsNeedingDates();
    void loadUnresolvedCount();
    void loadMissingItemsCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, year, includeUnresolved]);

  // Pull the resumable backfill summary for the current year.
  const loadProgress = async () => {
    setProgressLoading(true);
    try {
      const { data, error } = await supabase.rpc("get_shipment_backfill_status", {
        p_year: year,
      });
      if (error) throw error;
      setProgressRows(((data as BackfillProgressRow[]) ?? []));
    } catch (e: any) {
      // Non-fatal — the progress panel just shows "no progress yet".
      console.warn("[ShipmentAccounting] loadProgress failed", e);
      setProgressRows([]);
    } finally {
      setProgressLoading(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const start = `${year}-01-01`;
      const end = `${year + 1}-01-01`;
      const { data, error } = await supabase.rpc("get_shipment_accounting_period", {
        p_start: start,
        p_end: end,
        p_include_unresolved: includeUnresolved,
      });
      if (error) throw error;
      setRows((data as ShipmentRow[]) ?? []);
    } catch (e: any) {
      console.error("[ShipmentAccounting] load failed", e);
      const code = e?.code ?? "";
      const msg = String(e?.message ?? "");
      const isTimeout =
        code === "57014" ||
        /statement timeout/i.test(msg) ||
        /canceling statement/i.test(msg) ||
        /timeout/i.test(msg);
      // Clear stale data so users don't see old/zero numbers next to an error.
      setRows([]);
      if (isTimeout) {
        setLoadError({
          kind: "timeout",
          message:
            "Shipment Accounting query timed out. Please retry or narrow the date range.",
        });
        toast.error("Shipment Accounting query timed out");
      } else {
        setLoadError({
          kind: "generic",
          message: msg || "Failed to load accounting data",
        });
        toast.error(msg || "Failed to load accounting data");
      }
    } finally {
      setLoading(false);
    }
  };

  // Resumable historical backfill: orchestrates one (window, status) chunk at a
  // time against backfill-fba-shipments-chunk. Each chunk processes a small page
  // budget and persists progress, so a function shutdown / quota error never
  // erases the work that already completed. The user can stop, refresh, and
  // resume — the function will pick up from the last saved next_token.
  const runHistoricalBackfill = async () => {
    if (backfilling) return;
    const ok = window.confirm(
      `This will fetch all ${year} shipments from Amazon SP-API in resumable chunks. ` +
      "Progress is saved after every page, so you can stop and resume safely. Continue?"
    );
    if (!ok) return;

    setBackfilling(true);
    setStopRequested(false);
    setBackfillProgress("Starting…");

    const windows = buildBackfillWindows(year);
    // Skip future-only quarters entirely.
    const todayStr = new Date().toISOString().slice(0, 10);
    const eligibleWindows = windows.filter((w) => w.start <= todayStr);

    // Sweep order: status-first within each window so the heaviest one
    // (RECEIVING) gets its own dedicated set of small calls.
    const slices: Array<{
      window_start: string;
      window_end: string;
      shipment_status: string;
      label: string;
    }> = [];
    for (const w of eligibleWindows) {
      for (const status of BACKFILL_STATUSES) {
        slices.push({
          window_start: w.start,
          window_end: w.end,
          shipment_status: status,
          label: `${w.label} · ${status}`,
        });
      }
    }

    let failures = 0;
    let totalNew = 0;

    try {
      for (let i = 0; i < slices.length; i++) {
        if (stopRequested) {
          toast.info("Backfill paused. Progress is saved — click Backfill again to resume.");
          break;
        }
        const slice = slices[i];
        setBackfillProgress(`Slice ${i + 1}/${slices.length}: ${slice.label}…`);

        // Each slice may take multiple invocations (one per page batch).
        let safetyHops = 0;
        while (safetyHops < 30) {
          if (stopRequested) break;
          safetyHops++;

          const { data, error } = await supabase.functions.invoke(
            "backfill-fba-shipments-chunk",
            {
              body: {
                year,
                window_start: slice.window_start,
                window_end: slice.window_end,
                shipment_status: slice.shipment_status,
                maxPagesPerCall: 6,
              },
            },
          );

          // Refresh the progress panel after every hop so the user sees movement.
          await loadProgress();

          if (error) {
            // Treat 429 / quota as soft retryable, others as slice-level failure.
            const msg = String(error.message ?? "failed");
            const retryable = /429|quota|throttl/i.test(msg);
            if (retryable && safetyHops < 30) {
              setBackfillProgress(`Throttled — backing off (${slice.label})…`);
              await new Promise((r) => setTimeout(r, 4000));
              continue;
            }
            console.error(`[backfill] ${slice.label} failed`, error);
            toast.error(`${slice.label}: ${msg}`);
            failures++;
            break;
          }

          totalNew += Number(data?.shipmentsUpserted ?? 0);

          if (data?.state === "complete" || data?.hasMore === false) {
            break;
          }
          // Yield to the UI between hops.
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      if (!stopRequested) {
        if (failures === 0) {
          toast.success(
            `Backfill complete for ${year}. ${totalNew} new shipments synced.`,
          );
        } else {
          toast.warning(
            `Backfill finished with ${failures} failed slice(s). See the progress table for details.`,
          );
        }
      }
      await load();
      await loadProgress();
    } catch (e: any) {
      console.error(e);
      toast.error(e.message ?? "Backfill failed");
    } finally {
      setBackfilling(false);
      setBackfillProgress("");
      setStopRequested(false);
    }
  };

  // ---- Real-date sync ----
  // Counts how many shipments still need their actual ship/received dates pulled
  // from SP-API (i.e. dates_synced_at IS NULL). Backfill stores rows with
  // created_at = now(), so without this step shipments get bucketed into the
  // wrong month.
  const countShipmentsNeedingDates = async () => {
    // Count shipments that either were never date-synced OR are flagged as
    // unresolved (so the user can retry them via Sync Dates).
    const { count, error } = await supabase
      .from("fba_shipments")
      .select("shipment_id", { count: "exact", head: true })
      .or("dates_synced_at.is.null,unresolved_date.eq.true");
    if (error) {
      console.warn("[ShipmentAccounting] count needing dates failed", error);
      return;
    }
    setDatesRemaining(count ?? 0);
  };

  // Runs the date sync in batches of 25, looping until done or user stops.
  const runDateSync = async () => {
    if (datesSyncing) return;
    setDatesSyncing(true);
    setStopDateSync(false);
    setDatesSyncProgress("Starting…");

    let totalUpdated = 0;
    let totalProcessed = 0;
    let iter = 0;
    const maxIterations = 200; // safety cap (~5,000 shipments)

    try {
      while (iter < maxIterations) {
        if (stopDateSync) {
          toast.info("Date sync paused. Click Sync Dates to resume.");
          break;
        }
        iter += 1;
        setDatesSyncProgress(`Batch ${iter}…`);
        const { data, error } = await supabase.functions.invoke(
          "sync-fba-shipment-dates",
          { body: { batchSize: 25 } },
        );
        if (error) {
          throw new Error(error.message ?? "edge function error");
        }
        if (!data?.success) {
          throw new Error(data?.error ?? "sync failed");
        }
        totalProcessed += Number(data.processed) || 0;
        totalUpdated += Number(data.updated) || 0;
        setDatesRemaining(Number(data.remaining) || 0);
        setDatesSyncProgress(
          `Batch ${iter}: ${data.processed} processed, ${data.remaining} remaining`,
        );
        if (data.done || (data.processed ?? 0) === 0) break;
        // Small breath between batches
        await new Promise((r) => setTimeout(r, 250));
      }
      toast.success(
        `Date sync complete. ${totalUpdated} shipments updated across ${iter} batches.`,
      );
      await load();
    } catch (e: any) {
      console.error("[ShipmentAccounting] date sync failed", e);
      toast.error(e.message ?? "Date sync failed");
    } finally {
      setDatesSyncing(false);
      setDatesSyncProgress("");
      setStopDateSync(false);
      await countShipmentsNeedingDates();
      await loadUnresolvedCount();
    }
  };

  // ---- Unresolved-date shipments ----
  // These rows have no reliable ship date. We never silently bucket them into
  // a month — the user must explicitly opt in (or assign a date manually).
  const loadUnresolvedCount = async () => {
    const { data, error } = await supabase.rpc("count_unresolved_shipment_dates");
    if (error) {
      console.warn("[ShipmentAccounting] unresolved count failed", error);
      return;
    }
    setUnresolvedCount(Number(data) || 0);
  };

  const loadUnresolvedList = async () => {
    setUnresolvedLoading(true);
    try {
      const { data, error } = await supabase.rpc("list_unresolved_shipments", { p_limit: 500 });
      if (error) throw error;
      setUnresolvedList((data as UnresolvedShipment[]) ?? []);
    } catch (e: any) {
      console.error("[ShipmentAccounting] unresolved list failed", e);
      toast.error(e.message ?? "Failed to load unresolved shipments");
      setUnresolvedList([]);
    } finally {
      setUnresolvedLoading(false);
    }
  };

  const openUnresolvedDialog = async () => {
    setUnresolvedDialogOpen(true);
    await loadUnresolvedList();
  };

  const assignManualDate = async (shipmentId: string) => {
    const draft = manualDateDraft[shipmentId];
    if (!draft) {
      toast.error("Pick a date first");
      return;
    }
    const { error } = await supabase.rpc("set_shipment_manual_ship_date", {
      p_shipment_id: shipmentId,
      p_ship_date: draft,
    });
    if (error) {
      toast.error(error.message ?? "Failed to assign date");
      return;
    }
    toast.success("Ship date assigned");
    setManualDateDraft((prev) => {
      const next = { ...prev };
      delete next[shipmentId];
      return next;
    });
    await loadUnresolvedList();
    await loadUnresolvedCount();
    await load();
  };

  // ---- Repair empty shipments (admin only) ----
  // These are shipments where fba_shipments has a row but fba_shipment_items has
  // ZERO rows — typically multi-destination splits where Amazon's items endpoint
  // returned nothing during the original sync. We re-pull items per shipment.
  const loadMissingItemsCount = async () => {
    if (!isAdmin) {
      setMissingItemsCount(null);
      return;
    }
    const { data, error } = await supabase.rpc("count_shipments_missing_items");
    if (error) {
      console.warn("[ShipmentAccounting] missing items count failed", error);
      return;
    }
    setMissingItemsCount(Number(data) || 0);
  };

  const runRepairMissingItems = async () => {
    if (repairing) return;
    setRepairing(true);
    setStopRepair(false);
    setRepairLog([]);
    setRepairProgress("Starting…");

    let totalChecked = 0;
    let totalRepaired = 0;
    let totalStillEmpty = 0;
    let totalFailed = 0;
    let iter = 0;
    const sessionLog: typeof repairLog = [];

    try {
      while (true) {
        iter++;
        if (stopRepair) {
          toast.info("Repair paused. Click Repair Missing Items to resume.");
          break;
        }
        setRepairProgress(`Batch ${iter}…`);
        const { data, error } = await supabase.functions.invoke(
          "repair-empty-shipments",
          { body: { batchSize: 5 } },
        );
        if (error) throw error;
        if (!data) break;

        totalChecked += Number(data.checked) || 0;
        totalRepaired += Number(data.repaired) || 0;
        totalStillEmpty += Number(data.stillEmpty) || 0;
        totalFailed += Number(data.failed) || 0;
        if (Array.isArray(data.results)) {
          sessionLog.push(...data.results);
          setRepairLog([...sessionLog]);
        }
        const remaining = Number(data.remaining) || 0;
        setMissingItemsCount(remaining);
        setRepairProgress(
          `Checked ${totalChecked} · Repaired ${totalRepaired} · Still empty ${totalStillEmpty} · Failed ${totalFailed} · ${remaining} left`,
        );

        // Stop when the server says we're done OR when nothing in this batch
        // could be repaired (avoid infinite loop on permanently empty rows).
        if (Number(data.checked) === 0) break;
        if (Number(data.repaired) === 0) break;
      }
      toast.success(
        `Repair complete. ${totalRepaired} repaired, ${totalStillEmpty} still empty, ${totalFailed} failed.`,
      );
      setRepairLogOpen(true);
    } catch (e: any) {
      console.error("[ShipmentAccounting] repair failed", e);
      toast.error(e.message ?? "Repair failed");
    } finally {
      setRepairing(false);
      setRepairProgress("");
      setStopRepair(false);
      await loadMissingItemsCount();
      await load();
    }
  };


  const monthly = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, m) => ({
      month: m,
      shipments: 0,
      units_shipped: 0,
      units_received: 0,
      cogs: 0,
      amazon_inbound_fee: 0,
      manual_cost: 0,
      total_cost: 0,
      estimated_revenue: 0,
      estimated_profit: 0,
      // Number of shipments in the month that contributed revenue (for blank handling)
      shipments_with_revenue: 0,
    }));
    for (const r of rows) {
      // Parse YYYY-MM-DD as a local-noon date so timezone offsets never
      // shift the row into the previous month (e.g. "2026-01-01" was being
      // parsed as UTC midnight → Dec 31 in local time → wrong bucket).
      const sd = r.shipment_date;
      if (!sd) continue;
      const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(sd);
      const d = isoDateOnly ? new Date(`${sd}T12:00:00`) : new Date(sd);
      const m = d.getMonth();
      const bucket = months[m];
      if (!bucket) continue;
      bucket.shipments += 1;
      bucket.units_shipped += Number(r.units_shipped) || 0;
      bucket.units_received += Number(r.units_received) || 0;
      bucket.cogs += Number(r.cogs) || 0;
      bucket.amazon_inbound_fee += Number(r.amazon_inbound_fee) || 0;
      bucket.manual_cost += Number(r.manual_cost) || 0;
      bucket.total_cost += Number(r.total_cost) || 0;
      if (r.estimated_revenue !== null && r.estimated_revenue !== undefined) {
        bucket.estimated_revenue += Number(r.estimated_revenue) || 0;
        bucket.estimated_profit += Number(r.estimated_profit) || 0;
        bucket.shipments_with_revenue += 1;
      }
    }
    return months;
  }, [rows]);

  const yearTotals = useMemo(() => {
    return monthly.reduce(
      (acc, m) => {
        acc.cogs += m.cogs;
        acc.amazon_inbound_fee += m.amazon_inbound_fee;
        acc.manual_cost += m.manual_cost;
        acc.total_cost += m.total_cost;
        acc.units_shipped += m.units_shipped;
        acc.units_received += m.units_received;
        acc.shipments += m.shipments;
        acc.estimated_revenue += m.estimated_revenue;
        acc.estimated_profit += m.estimated_profit;
        acc.shipments_with_revenue += m.shipments_with_revenue;
        return acc;
      },
      {
        cogs: 0,
        amazon_inbound_fee: 0,
        manual_cost: 0,
        total_cost: 0,
        units_shipped: 0,
        units_received: 0,
        shipments: 0,
        estimated_revenue: 0,
        estimated_profit: 0,
        shipments_with_revenue: 0,
      },
    );
  }, [monthly]);

  // Filtered + sorted rows for the per-shipment table (Phase 4)
  // Sort key/direction is user-controlled via clickable column headers.
  // Rows with no value for the sort key (e.g. no revenue match) sort to the bottom.
  const filteredRows = useMemo(() => {
    const filtered =
      profitFilter === "all"
        ? rows
        : rows.filter((r) => {
            const hasRev = r.estimated_revenue !== null && r.estimated_revenue !== undefined;
            const profit = Number(r.estimated_profit ?? 0);
            if (profitFilter === "no_match") return !hasRev;
            if (profitFilter === "profitable") return hasRev && profit > 0;
            if (profitFilter === "loss") return hasRev && profit < 0;
            return true;
          });

    const ppu = (r: ShipmentRow): number | null => {
      const hasRev = r.estimated_revenue !== null && r.estimated_revenue !== undefined;
      const units = Number(r.units_shipped) || 0;
      if (!hasRev || units <= 0) return null;
      return Number(r.estimated_profit ?? 0) / units;
    };

    const dateVal = (r: ShipmentRow): number | null => {
      if (!r.shipment_date) return null;
      const t = new Date(`${r.shipment_date}T12:00:00`).getTime();
      return Number.isNaN(t) ? null : t;
    };

    const dirMul = sortDir === "asc" ? 1 : -1;

    return [...filtered].sort((a, b) => {
      const av = sortKey === "date" ? dateVal(a) : ppu(a);
      const bv = sortKey === "date" ? dateVal(b) : ppu(b);
      // Always push nulls to the bottom regardless of direction.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dirMul;
    });
  }, [rows, profitFilter, sortKey, sortDir]);

  // ----- Manual costs dialog -----
  const openCostsDialog = async (row: ShipmentRow) => {
    setOpenCostsFor(row);
    setNewAmount("");
    setNewNote("");
    setNewDate(new Date().toISOString().slice(0, 10));
    if (!costsByShipment[row.shipment_id]) {
      const { data, error } = await supabase
        .from("shipment_costs")
        .select("id, shipment_id, amount, note, cost_date")
        .eq("shipment_id", row.shipment_id)
        .order("cost_date", { ascending: false });
      if (error) {
        toast.error("Failed to load existing costs");
        return;
      }
      setCostsByShipment((prev) => ({ ...prev, [row.shipment_id]: (data as ManualCost[]) ?? [] }));
    }
  };

  const refreshCosts = async (shipmentId: string) => {
    const { data, error } = await supabase
      .from("shipment_costs")
      .select("id, shipment_id, amount, note, cost_date")
      .eq("shipment_id", shipmentId)
      .order("cost_date", { ascending: false });
    if (error) return;
    setCostsByShipment((prev) => ({ ...prev, [shipmentId]: (data as ManualCost[]) ?? [] }));
  };

  const addCost = async () => {
    if (!openCostsFor || !user) return;
    const amount = Number(newAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount > 0");
      return;
    }
    setSavingCost(true);
    try {
      const { error } = await supabase.from("shipment_costs").insert({
        user_id: user.id,
        shipment_id: openCostsFor.shipment_id,
        amount,
        note: newNote || null,
        cost_date: newDate,
      });
      if (error) throw error;
      toast.success("Cost added");
      setNewAmount("");
      setNewNote("");
      await refreshCosts(openCostsFor.shipment_id);
      await load();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to add cost");
    } finally {
      setSavingCost(false);
    }
  };

  const deleteCost = async (id: string, shipmentId: string) => {
    const { error } = await supabase.from("shipment_costs").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete");
      return;
    }
    toast.success("Removed");
    await refreshCosts(shipmentId);
    await load();
  };

  const yearOptions = Array.from({ length: 5 }, (_, i) => today.getFullYear() - i);

  return (
    <TooltipProvider delayDuration={150}>
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8 pt-24">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold">Shipment Accounting</h1>
            <p className="text-muted-foreground mt-1">
              Per-shipment cost & monthly rollup. COGS pulls from Product Library first, then sales orders.
              All amounts in USD.
            </p>
            <p className="text-xs text-muted-foreground mt-2 italic">
              Estimated Profit is informational only — revenue is matched by ASIN from Amazon's settled
              financial events within each shipment's lifetime window. This is <strong>not</strong> final
              accounting profit. Use the Profit & Loss page for settled financials.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={load} disabled={loading || backfilling}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              variant="outline"
              onClick={runHistoricalBackfill}
              disabled={loading || backfilling}
              title="Resumable backfill: pulls all shipments for the selected year from SP-API in small chunks. Progress is saved after every page so you can stop and resume."
            >
              {backfilling ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <History className="h-4 w-4 mr-2" />
              )}
              {backfilling ? (backfillProgress || "Backfilling…") : `Backfill ${year}`}
            </Button>
            {backfilling && (
              <Button
                variant="destructive"
                onClick={() => setStopRequested(true)}
                disabled={stopRequested}
                title="Stop after the current page. Progress is saved — you can resume later."
              >
                {stopRequested ? "Stopping…" : "Stop"}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={runDateSync}
              disabled={loading || backfilling || datesSyncing || datesRemaining === 0}
              title="Pulls real ship/received dates from Amazon SP-API in small batches. Without this, shipments backfilled in bulk get bucketed by sync date instead of actual ship date."
            >
              {datesSyncing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {datesSyncing
                ? (datesSyncProgress || "Syncing dates…")
                : datesRemaining && datesRemaining > 0
                ? `Sync Dates (${datesRemaining} left)`
                : "Sync Dates"}
            </Button>
            {datesSyncing && (
              <Button
                variant="destructive"
                onClick={() => setStopDateSync(true)}
                disabled={stopDateSync}
                title="Stop after the current batch. Progress is saved."
              >
                {stopDateSync ? "Stopping…" : "Stop"}
              </Button>
            )}
            {/* Admin-only: re-pull line items for shipments where the items
                table is empty (typically multi-destination splits). */}
            {isAdmin && (
              <>
                <Button
                  variant="outline"
                  onClick={runRepairMissingItems}
                  disabled={
                    loading ||
                    backfilling ||
                    datesSyncing ||
                    repairing ||
                    missingItemsCount === 0
                  }
                  title="Admin only — re-pulls line items from SP-API for shipments whose items table is empty (e.g. multi-destination splits where the items endpoint returned nothing during the original sync). Never deletes existing items."
                >
                  {repairing ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Wrench className="h-4 w-4 mr-2" />
                  )}
                  {repairing
                    ? (repairProgress || "Repairing…")
                    : missingItemsCount && missingItemsCount > 0
                    ? `Repair Missing Items (${missingItemsCount})`
                    : "Repair Missing Items"}
                </Button>
                {repairing && (
                  <Button
                    variant="destructive"
                    onClick={() => setStopRepair(true)}
                    disabled={stopRepair}
                    title="Stop after the current batch."
                  >
                    {stopRepair ? "Stopping…" : "Stop"}
                  </Button>
                )}
                {!repairing && repairLog.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRepairLogOpen(true)}
                  >
                    View last repair log
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Admin-only alert: shipments missing line items entirely */}
        {isAdmin && missingItemsCount !== null && missingItemsCount > 0 && !repairing && (
          <Alert className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>
              {missingItemsCount} shipment{missingItemsCount === 1 ? "" : "s"} have no line items
            </AlertTitle>
            <AlertDescription>
              These shipments exist in the database but their item lines were never imported
              (typically multi-destination splits). They show 0 units, 0 COGS and no revenue
              match. Click <strong>Repair Missing Items</strong> to re-pull items from Amazon
              SP-API. Existing items are never deleted — only missing rows are inserted.
            </AlertDescription>
          </Alert>
        )}

        {/* Unresolved-date shipments — excluded from totals by default. Better to
            show "needs review" than to silently bucket them in the wrong month. */}
        {unresolvedCount > 0 && (
          <Alert className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>
              {unresolvedCount} shipment{unresolvedCount === 1 ? "" : "s"} need date review
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                These shipments have no reliable ship date from Amazon (no parseable date in
                the shipment name and no confirmed receipt). They are <strong>excluded</strong>{" "}
                from the monthly and yearly totals below — better to show them here than to
                silently place them in the wrong year (which is what happened in the previous
                sync run).
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button size="sm" variant="outline" onClick={openUnresolvedDialog}>
                  Review unresolved shipments
                </Button>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeUnresolved}
                    onChange={(e) => setIncludeUnresolved(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Include unresolved in totals (uses created_at as fallback — may be inaccurate)
                </label>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Secondary alert: shipments still need a Sync Dates pass at least once */}
        {datesRemaining !== null && datesRemaining > 0 && !datesSyncing && (
          <Alert className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{datesRemaining} shipments not yet date-synced</AlertTitle>
            <AlertDescription>
              These shipments have not been processed by Sync Dates yet. Click
              <strong> Sync Dates</strong> to pull real ship/received dates from SP-API.
            </AlertDescription>
          </Alert>
        )}

        {loadError && (
          <Alert variant="destructive" className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>
              {loadError.kind === "timeout"
                ? "Query timed out"
                : "Failed to load Shipment Accounting"}
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{loadError.message}</p>
              <p className="text-xs opacity-80">
                The totals and rows below are <strong>not reliable</strong> while this error is shown
                — they may appear as zero because the database query did not complete. Click Retry,
                pick a smaller year, or try again in a moment.
              </p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={load}
                  disabled={loading}
                  className="mt-1"
                >
                  <RefreshCw className={`h-3 w-3 mr-2 ${loading ? "animate-spin" : ""}`} />
                  Retry
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Backfill progress summary — surfaced so a partial/failed backfill is never confused with real zero data. */}
        {(backfilling || progressRows.length > 0) && (
          <Card className="mb-6">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Backfill Progress — {year}
                  {backfilling && backfillProgress && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      ({backfillProgress})
                    </span>
                  )}
                </CardTitle>
                <Button size="sm" variant="ghost" onClick={loadProgress} disabled={progressLoading}>
                  <RefreshCw className={`h-3 w-3 mr-1 ${progressLoading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {progressRows.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No backfill has run yet for {year}. Click <strong>Backfill {year}</strong> to start.
                  Progress will appear here and persist across page reloads.
                </div>
              ) : (
                <>
                  {(() => {
                    const total = progressRows.length;
                    const complete = progressRows.filter((r) => r.state === "complete").length;
                    const failed = progressRows.filter((r) => r.state === "failed").length;
                    const running = progressRows.filter((r) => r.state === "running").length;
                    const allDone = complete === total && failed === 0;
                    return (
                      <div className="flex flex-wrap gap-2 mb-3 text-xs">
                        <Badge variant="outline">{total} slices</Badge>
                        <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
                          {complete} complete
                        </Badge>
                        {running > 0 && (
                          <Badge variant="outline" className="border-amber-500/40 text-amber-500">
                            {running} running
                          </Badge>
                        )}
                        {failed > 0 && (
                          <Badge variant="outline" className="border-red-500/40 text-red-500">
                            {failed} failed
                          </Badge>
                        )}
                        {!allDone && !backfilling && (
                          <span className="text-muted-foreground italic">
                            Backfill is incomplete — totals below may be missing data. Click Backfill {year} to resume.
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="overflow-x-auto max-h-72 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Window</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Pages</TableHead>
                          <TableHead className="text-right">Shipments</TableHead>
                          <TableHead className="text-right">Items</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead>Last error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {progressRows.map((p) => {
                          const stateColor =
                            p.state === "complete"
                              ? "border-emerald-500/40 text-emerald-500 bg-emerald-500/10"
                              : p.state === "failed"
                              ? "border-red-500/40 text-red-500 bg-red-500/10"
                              : p.state === "running"
                              ? "border-amber-500/40 text-amber-500 bg-amber-500/10"
                              : "border-muted-foreground/30 text-muted-foreground bg-muted/40";
                          return (
                            <TableRow key={`${p.window_start}-${p.shipment_status}`}>
                              <TableCell className="whitespace-nowrap text-xs">
                                {p.window_start} → {p.window_end}
                              </TableCell>
                              <TableCell className="text-xs">{p.shipment_status}</TableCell>
                              <TableCell className="text-right text-xs">{p.pages_processed}</TableCell>
                              <TableCell className="text-right text-xs">{p.shipments_upserted}</TableCell>
                              <TableCell className="text-right text-xs">{p.items_upserted}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className={`${stateColor} text-xs`}>
                                  {p.state}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                                {p.last_error ?? "—"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total COGS</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{fmtUSD(yearTotals.cogs)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Amazon Inbound Fees</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{fmtUSD(yearTotals.amazon_inbound_fee)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Manual Costs</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{fmtUSD(yearTotals.manual_cost)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Cost ({year})</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{fmtUSD(yearTotals.total_cost)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Estimated Revenue</CardTitle></CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {yearTotals.shipments_with_revenue > 0 ? fmtUSD(yearTotals.estimated_revenue) : "—"}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Estimated Profit</CardTitle></CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${
                yearTotals.shipments_with_revenue > 0
                  ? yearTotals.estimated_profit >= 0 ? "text-emerald-500" : "text-red-500"
                  : ""
              }`}>
                {yearTotals.shipments_with_revenue > 0 ? fmtUSD(yearTotals.estimated_profit) : "—"}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Monthly rollup */}
        <Card className="mb-6">
          <CardHeader><CardTitle>Monthly Rollup — {year}</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Shipments</TableHead>
                    <TableHead className="text-right">Units Shipped</TableHead>
                    <TableHead className="text-right">Units Received</TableHead>
                    <TableHead className="text-right">COGS</TableHead>
                    <TableHead className="text-right">Inbound Fees</TableHead>
                    <TableHead className="text-right">Manual</TableHead>
                    <TableHead className="text-right font-semibold">Total Cost</TableHead>
                    <TableHead className="text-right">Est. Revenue</TableHead>
                    <TableHead className="text-right font-semibold">Est. Profit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthly.map((m) => {
                    const hasRev = m.shipments_with_revenue > 0;
                    return (
                      <TableRow key={m.month}>
                        <TableCell>{monthLabels[m.month]}</TableCell>
                        <TableCell className="text-right">{m.shipments}</TableCell>
                        <TableCell className="text-right">{m.units_shipped}</TableCell>
                        <TableCell className="text-right">{m.units_received}</TableCell>
                        <TableCell className="text-right">{fmtUSD(m.cogs)}</TableCell>
                        <TableCell className="text-right">{fmtUSD(m.amazon_inbound_fee)}</TableCell>
                        <TableCell className="text-right">{fmtUSD(m.manual_cost)}</TableCell>
                        <TableCell className="text-right font-semibold">{fmtUSD(m.total_cost)}</TableCell>
                        <TableCell className="text-right">{hasRev ? fmtUSD(m.estimated_revenue) : "—"}</TableCell>
                        <TableCell className={`text-right font-semibold ${
                          hasRev ? (m.estimated_profit >= 0 ? "text-emerald-500" : "text-red-500") : ""
                        }`}>
                          {hasRev ? fmtUSD(m.estimated_profit) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="bg-muted/40">
                    <TableCell className="font-semibold">Year Total</TableCell>
                    <TableCell className="text-right font-semibold">{yearTotals.shipments}</TableCell>
                    <TableCell className="text-right font-semibold">{yearTotals.units_shipped}</TableCell>
                    <TableCell className="text-right font-semibold">{yearTotals.units_received}</TableCell>
                    <TableCell className="text-right font-semibold">{fmtUSD(yearTotals.cogs)}</TableCell>
                    <TableCell className="text-right font-semibold">{fmtUSD(yearTotals.amazon_inbound_fee)}</TableCell>
                    <TableCell className="text-right font-semibold">{fmtUSD(yearTotals.manual_cost)}</TableCell>
                    <TableCell className="text-right font-bold">{fmtUSD(yearTotals.total_cost)}</TableCell>
                    <TableCell className="text-right font-semibold">
                      {yearTotals.shipments_with_revenue > 0 ? fmtUSD(yearTotals.estimated_revenue) : "—"}
                    </TableCell>
                    <TableCell className={`text-right font-bold ${
                      yearTotals.shipments_with_revenue > 0
                        ? yearTotals.estimated_profit >= 0 ? "text-emerald-500" : "text-red-500"
                        : ""
                    }`}>
                      {yearTotals.shipments_with_revenue > 0 ? fmtUSD(yearTotals.estimated_profit) : "—"}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Per-shipment table */}
        <Card>
          <CardHeader>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <CardTitle>Shipments — {year}</CardTitle>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Filter</Label>
                <Select value={profitFilter} onValueChange={(v) => setProfitFilter(v as typeof profitFilter)}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All shipments</SelectItem>
                    <SelectItem value="profitable">Profitable only (Est.)</SelectItem>
                    <SelectItem value="loss">Loss only (Est.)</SelectItem>
                    <SelectItem value="no_match">No revenue match</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {filteredRows.length} of {rows.length}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">No shipments in {year}.</div>
            ) : filteredRows.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                No shipments match the current filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <button
                          type="button"
                          onClick={() => toggleSort("date")}
                          className="flex items-center gap-1 hover:text-foreground transition-colors"
                          aria-label={`Sort by date ${sortKey === "date" && sortDir === "asc" ? "descending" : "ascending"}`}
                        >
                          Date
                          {sortKey === "date" ? (
                            sortDir === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5" />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead>Shipment</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Shipped</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="text-right">COGS</TableHead>
                      <TableHead className="text-right">Inbound Fee</TableHead>
                      <TableHead className="text-right">Manual</TableHead>
                      <TableHead className="text-right font-semibold">Total</TableHead>
                      <TableHead className="text-right">Est. Revenue</TableHead>
                      <TableHead className="text-right font-semibold">Est. Profit</TableHead>
                      <TableHead className="text-right">
                        <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => toggleSort("profit_per_unit")}
                            className="flex items-center gap-1 hover:text-foreground transition-colors"
                            aria-label={`Sort by est. profit per unit ${sortKey === "profit_per_unit" && sortDir === "desc" ? "ascending" : "descending"}`}
                          >
                            Est. Profit/Unit
                            {sortKey === "profit_per_unit" ? (
                              sortDir === "asc" ? (
                                <ArrowUp className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowDown className="h-3.5 w-3.5" />
                              )
                            ) : (
                              <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
                            )}
                          </button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="text-xs">
                                Estimated Profit ÷ Units Shipped. Useful for comparing shipment quality
                                and informing sourcing/reorder decisions. Estimated only — not final profit.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </TableHead>
                      <TableHead>
                        <div className="flex items-center gap-1">
                          Confidence
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">
                              <div className="space-y-2 text-xs">
                                <div>
                                  <span className="font-semibold text-emerald-500">Matched</span> — every ASIN had settled revenue within its lifetime window. Revenue is split proportionally by units across split shipments.
                                </div>
                                <div>
                                  <span className="font-semibold text-amber-500">Estimated</span> — partial revenue match, or shipment has 0 received units (revenue may not be from this stock).
                                </div>
                                <div>
                                  <span className="font-semibold text-muted-foreground">No revenue match</span> — no settled sales found for this shipment's ASINs in their lifetime windows.
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRows.map((r) => {
                      const hasRev = r.estimated_revenue !== null && r.estimated_revenue !== undefined;
                      const profit = r.estimated_profit;
                      const units = Number(r.units_shipped) || 0;
                      const profitPerUnit =
                        hasRev && units > 0 ? Number(profit) / units : null;
                      return (
                        <TableRow key={r.shipment_id}>
                          <TableCell className="whitespace-nowrap">{fmtUSDate(r.shipment_date)}</TableCell>
                          <TableCell>
                            <div className="font-medium">{r.shipment_name || r.shipment_id}</div>
                            <div className="text-xs text-muted-foreground">{r.shipment_id}</div>
                          </TableCell>
                          <TableCell>
                            {r.shipment_status ? <Badge variant="outline">{r.shipment_status}</Badge> : "—"}
                          </TableCell>
                          <TableCell className="text-right">{r.units_shipped}</TableCell>
                          <TableCell className="text-right">{r.units_received}</TableCell>
                          <TableCell className="text-right">{fmtUSD(Number(r.cogs))}</TableCell>
                          <TableCell className="text-right">{fmtUSD(Number(r.amazon_inbound_fee))}</TableCell>
                          <TableCell className="text-right">{fmtUSD(Number(r.manual_cost))}</TableCell>
                          <TableCell className="text-right font-semibold">{fmtUSD(Number(r.total_cost))}</TableCell>
                          <TableCell className="text-right">{fmtMaybeUSD(r.estimated_revenue)}</TableCell>
                          <TableCell className={`text-right font-semibold ${
                            hasRev ? (Number(profit) >= 0 ? "text-emerald-500" : "text-red-500") : ""
                          }`}>
                            {fmtMaybeUSD(profit)}
                          </TableCell>
                          <TableCell className={`text-right ${
                            profitPerUnit !== null
                              ? profitPerUnit >= 0 ? "text-emerald-500" : "text-red-500"
                              : ""
                          }`}>
                            {profitPerUnit !== null ? fmtUSD(profitPerUnit) : "—"}
                          </TableCell>
                          <TableCell>
                            <ConfidenceBadge value={r.revenue_confidence} unitsReceived={Number(r.units_received) || 0} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" onClick={() => openCostsDialog(r)}>
                              <DollarSign className="h-4 w-4 mr-1" /> Costs
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Manual cost dialog */}
      <Dialog open={!!openCostsFor} onOpenChange={(o) => !o && setOpenCostsFor(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Manual Costs — {openCostsFor?.shipment_name || openCostsFor?.shipment_id}</DialogTitle>
            <DialogDescription>
              Add prep, supplies, freight, fuel, or any other out-of-pocket cost for this shipment.
            </DialogDescription>
          </DialogHeader>

          {/* Per-shipment cost breakdown — pulled live from rows so add/delete updates instantly */}
          {openCostsFor && (() => {
            const live = rows.find((r) => r.shipment_id === openCostsFor.shipment_id) ?? openCostsFor;
            return (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 rounded-md bg-muted/40 border">
                <div>
                  <div className="text-xs text-muted-foreground">COGS</div>
                  <div className="text-lg font-semibold">{fmtUSD(Number(live.cogs))}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Amazon Inbound Fees</div>
                  <div className="text-lg font-semibold">{fmtUSD(Number(live.amazon_inbound_fee))}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Manual Costs</div>
                  <div className="text-lg font-semibold">{fmtUSD(Number(live.manual_cost))}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Total</div>
                  <div className="text-lg font-bold">{fmtUSD(Number(live.total_cost))}</div>
                </div>
              </div>
            );
          })()}

          {/* Add form */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label>Amount (USD)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </div>
            <div className="md:col-span-1 flex items-end">
              <Button onClick={addCost} disabled={savingCost} className="w-full">
                {savingCost ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                Add Cost
              </Button>
            </div>
            <div className="md:col-span-3">
              <Label>Note (optional)</Label>
              <Textarea
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="e.g. Prep service for 50 units, $0.40/unit"
                rows={2}
              />
            </div>
          </div>

          {/* Existing costs */}
          <div className="mt-4">
            <h4 className="text-sm font-semibold mb-2">Existing Costs</h4>
            {(costsByShipment[openCostsFor?.shipment_id ?? ""] ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">No manual costs yet.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(costsByShipment[openCostsFor?.shipment_id ?? ""] ?? []).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{fmtUSDate(c.cost_date)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.note || "—"}</TableCell>
                      <TableCell className="text-right">{fmtUSD(Number(c.amount))}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteCost(c.id, c.shipment_id)}
                          aria-label="Delete cost"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCostsFor(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unresolved-date review dialog: lets the user (or admin) manually
          assign a real ship date to shipments where SP-API + name parsing failed. */}
      <Dialog open={unresolvedDialogOpen} onOpenChange={setUnresolvedDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Unresolved shipment dates ({unresolvedCount})</DialogTitle>
            <DialogDescription>
              These shipments have no reliable ship date from Amazon. Assign a date manually
              (e.g. from a packing slip or shipping confirmation) to include them in monthly
              and yearly totals. Until then they are excluded from the report by default.
            </DialogDescription>
          </DialogHeader>

          {unresolvedLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
              Loading…
            </div>
          ) : unresolvedList.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No unresolved shipments. 🎉
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead>Synced</TableHead>
                  <TableHead>Assign date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unresolvedList.map((s) => (
                  <TableRow key={s.shipment_id}>
                    <TableCell className="text-sm">
                      <div className="font-mono text-xs">{s.shipment_id}</div>
                      {s.shipment_name && (
                        <div className="text-muted-foreground text-xs truncate max-w-[260px]">
                          {s.shipment_name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{s.shipment_status || "—"}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{s.units_shipped}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmtUSDate(s.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Input
                          type="date"
                          value={manualDateDraft[s.shipment_id] ?? ""}
                          onChange={(e) =>
                            setManualDateDraft((prev) => ({
                              ...prev,
                              [s.shipment_id]: e.target.value,
                            }))
                          }
                          className="h-8 text-xs w-36"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => assignManualDate(s.shipment_id)}
                          disabled={!manualDateDraft[s.shipment_id]}
                        >
                          Save
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setUnresolvedDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin: per-shipment repair log from the most recent run */}
      <Dialog open={repairLogOpen} onOpenChange={setRepairLogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Repair Missing Items — last run ({repairLog.length})</DialogTitle>
            <DialogDescription>
              Per-shipment outcome from the most recent repair pass. Repaired = items
              re-pulled from SP-API and inserted. Still empty = Amazon returned no items
              (shipment may have been cancelled or never had items). Failed = SP-API error.
            </DialogDescription>
          </DialogHeader>
          {repairLog.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No repair has been run yet in this session.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Items inserted</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repairLog.map((r, i) => (
                  <TableRow key={`${r.shipment_id}-${i}`}>
                    <TableCell className="text-sm">
                      <div className="font-mono text-xs">{r.shipment_id}</div>
                      {r.shipment_name && (
                        <div className="text-muted-foreground text-xs truncate max-w-[260px]">
                          {r.shipment_name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          r.outcome === "repaired"
                            ? "text-emerald-500"
                            : r.outcome === "failed"
                            ? "text-red-500"
                            : "text-muted-foreground"
                        }
                      >
                        {r.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{r.items_inserted}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[260px] truncate">
                      {r.error || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepairLogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
