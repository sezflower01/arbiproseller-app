/**
 * AdminRefreshControl — admin-only controls for SP-API inventory refresh.
 *
 * Two features (no business logic — purely orchestration around the existing
 * Manual SP-API Refresh handler and the `admin-trigger-refresh` edge function):
 *
 *  1. **Self auto-refresh** — repeats the existing Manual SP-API Refresh
 *     handler (`onSelfRefresh`) at a configurable interval (10–60 min) on the
 *     admin's own browser tab. Same logic the button uses; nothing new.
 *
 *  2. **Remote single-user refresh** — calls `admin-trigger-refresh` with a
 *     target user_id. Runs server-side and works even if that user is
 *     offline. Protected by cron lock + 10-min cooldown after scheduled cron.
 *
 * Shows the last 10 audit rows from `admin_refresh_runs`.
 *
 * Renders nothing for non-admins.
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Shield,
  RefreshCw,
  Zap,
  Clock,
  CheckCircle,
  AlertTriangle,
  PauseCircle,
} from "lucide-react";
import { toast } from "sonner";

interface AdminRefreshControlProps {
  /** The existing Manual SP-API Refresh handler from SyncedInventory. */
  onSelfRefresh: () => Promise<void> | void;
  /** True while the manual refresh is currently running in this tab. */
  selfRefreshInProgress: boolean;
}

interface RunRow {
  id: string;
  triggered_by_email: string | null;
  target_user_id: string;
  target_email: string | null;
  scope: string;
  source: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  skipped_reason: string | null;
  error_message: string | null;
}

interface UserOption {
  id: string;
  email: string | null;
}

// Self auto-refresh fires ONCE per scheduled cron cycle, 1 HOUR AFTER cron.
// Scheduled cron: `full-inventory-refresh-2h` = '15 */2 * * *' (UTC) — every
// 2 hours at minute :15 (00:15, 02:15, 04:15, ... UTC). We fire at
// HH:15 on the next odd UTC hour (01:15, 03:15, 05:15, ...) = cron + 60 min.
const OFFSET_MIN = 60; // minutes after cron
const CRON_HOUR_STEP = 2; // every 2 hours
const CRON_MINUTE = 15; // at minute :15 UTC
const LS_KEY_ENABLED = "admin_self_auto_refresh_enabled";

/** Returns the next UTC Date when (now >= cron_time + OFFSET_MIN). */
function computeNextRunAfterCron(from: Date = new Date()): Date {
  const d = new Date(from.getTime());
  // Iterate forward at most 25 hours to find the next slot.
  for (let i = 0; i < 1500; i++) {
    const candidate = new Date(Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      0, 0, 0,
    ));
    // align to even UTC hour
    if (candidate.getUTCHours() % CRON_HOUR_STEP === 0) {
      const fire = new Date(candidate.getTime() + (CRON_MINUTE + OFFSET_MIN) * 60_000);
      if (fire.getTime() > from.getTime()) return fire;
    }
    d.setTime(d.getTime() + 60 * 60_000); // +1h
  }
  return new Date(from.getTime() + 2 * 60 * 60_000);
}

/**
 * Compute the previous and next fire times (in UTC) of a cron expression
 * shaped `M H * * *` where M is a literal minute and H is either `*` or
 * `*​/N` (every N hours). Sufficient for our two inventory crons.
 */
function nextCronFire(minute: number, hourStep: number, from: Date = new Date()): { last: Date; next: Date } {
  // Walk back/forward by hour, find aligned slots.
  const base = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), 0, 0, 0));
  let next: Date | null = null;
  for (let i = 0; i < 30; i++) {
    const d = new Date(base.getTime() + i * 3600_000);
    if (d.getUTCHours() % hourStep === 0) {
      const fire = new Date(d.getTime() + minute * 60_000);
      if (fire.getTime() > from.getTime()) { next = fire; break; }
    }
  }
  let last: Date | null = null;
  for (let i = 0; i < 30; i++) {
    const d = new Date(base.getTime() - i * 3600_000);
    if (d.getUTCHours() % hourStep === 0) {
      const fire = new Date(d.getTime() + minute * 60_000);
      if (fire.getTime() <= from.getTime()) { last = fire; break; }
    }
  }
  return {
    last: last ?? new Date(from.getTime() - hourStep * 3600_000),
    next: next ?? new Date(from.getTime() + hourStep * 3600_000),
  };
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function statusBadge(status: string) {
  if (status === "success")
    return (
      <Badge variant="outline" className="border-green-500/40 text-green-600 text-[10px]">
        success
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="outline" className="border-red-500/40 text-red-600 text-[10px]">
        failed
      </Badge>
    );
  if (status === "running")
    return (
      <Badge variant="outline" className="border-blue-500/40 text-blue-600 text-[10px]">
        running
      </Badge>
    );
  if (status.startsWith("skipped"))
    return (
      <Badge variant="outline" className="border-yellow-500/40 text-yellow-700 text-[10px]">
        {status.replace("skipped_", "skip:")}
      </Badge>
    );
  return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
}

export default function AdminRefreshControlThemed({
  onSelfRefresh,
  selfRefreshInProgress,
}: AdminRefreshControlProps) {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [userFilter, setUserFilter] = useState("");
  const [bulkTriggering, setBulkTriggering] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);

  // Self auto-refresh state (persisted to localStorage, default ON)
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [nextRunAt, setNextRunAt] = useState<Date | null>(null);
  const lastFiredSlotRef = useRef<number>(0); // epoch ms of the last fired slot
  const prevSelfRefreshRef = useRef<boolean>(false); // detect manual refresh completion
  const autoChainAllRef = useRef<boolean>(true); // when true, completion of manual refresh auto-triggers ALL users

  // -- admin check --
  useEffect(() => {
    if (!user) return;
    supabase
      .rpc("has_role", { _user_id: user.id, _role: "admin" })
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  // -- load persisted prefs (default ON: only OFF when explicitly stored "0") --
  useEffect(() => {
    try {
      const e = localStorage.getItem(LS_KEY_ENABLED);
      setAutoEnabled(e !== "0");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY_ENABLED, autoEnabled ? "1" : "0");
    } catch {}
  }, [autoEnabled]);

  // -- load ALL users (admin-only) via admin-user-permissions edge fn,
  //    which uses service-role auth.admin.listUsers (profiles table is
  //    RLS-restricted and only returns the current user's row). --
  useEffect(() => {
    if (!isAdmin) return;
    supabase.functions
      .invoke("admin-user-permissions", { body: { action: "list_users" } })
      .then(({ data, error }) => {
        if (error || !data?.users) {
          setUsers([]);
          return;
        }
        const opts: UserOption[] = (data.users as Array<{ id: string; email: string | null }>)
          .map((u) => ({ id: u.id, email: u.email }))
          .sort((a, b) => (a.email || "").localeCompare(b.email || ""));
        setUsers(opts);
      });
  }, [isAdmin]);

  // -- load audit history --
  const fetchRuns = useCallback(async () => {
    if (!isAdmin) return;
    setLoadingRuns(true);
    const { data, error } = await supabase
      .from("admin_refresh_runs")
      .select(
        "id, triggered_by_email, target_user_id, target_email, scope, source, status, started_at, completed_at, skipped_reason, error_message",
      )
      .order("started_at", { ascending: false })
      .limit(15);
    if (!error && data) setRuns(data as RunRow[]);
    setLoadingRuns(false);
  }, [isAdmin]);

  useEffect(() => {
    if (isAdmin) fetchRuns();
  }, [isAdmin, fetchRuns]);

  // -- Self auto-refresh loop: fire ONCE per cron cycle, 10 min after cron --
  useEffect(() => {
    if (!isAdmin || !autoEnabled) {
      setNextRunAt(null);
      return;
    }
    let cancelled = false;
    const updateNext = () => {
      const next = computeNextRunAfterCron();
      if (!cancelled) setNextRunAt(next);
      return next;
    };
    updateNext();
    const tick = async () => {
      const next = computeNextRunAfterCron();
      setNextRunAt(next);
      // Determine the "current slot" — the most recent cron slot that has
      // already passed (cron HH:15 UTC on an even hour) plus offset.
      const now = Date.now();
      const slotCandidate = new Date(next.getTime() - CRON_HOUR_STEP * 60 * 60_000);
      // If `slotCandidate` is in the past (i.e. we're within the firing window)
      // and we haven't fired for it yet, fire now.
      if (
        slotCandidate.getTime() <= now &&
        now - slotCandidate.getTime() < 30 * 60_000 && // within 30 min of slot
        lastFiredSlotRef.current !== slotCandidate.getTime() &&
        !selfRefreshInProgress
      ) {
        // Collision guard: don't fire if a cron/admin run is currently in
        // progress, or one started in the last 5 min (still likely running).
        try {
          const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
          const { data: active } = await supabase
            .from("admin_refresh_runs")
            .select("id, status, started_at, source")
            .or(`status.eq.in_progress,started_at.gte.${fiveMinAgo}`)
            .limit(1);
          if (active && active.length > 0) {
            // Skip this slot — cron or another admin run is active.
            // Mark slot as fired so we don't retry every 30s within the window.
            lastFiredSlotRef.current = slotCandidate.getTime();
            return;
          }
        } catch {
          // If the guard query fails, fall through and fire anyway.
        }
        lastFiredSlotRef.current = slotCandidate.getTime();
        try {
          // The self-auto path logs its own row via admin-trigger-refresh below.
          // Tell the completion-effect to NOT also write a manual_self audit row.
          skipNextManualAuditRef.current = true;
          await onSelfRefresh();
          if (user) {
            supabase.functions
              .invoke("admin-trigger-refresh", {
                body: { target_user_id: user.id, source: "self_auto" },
              })
              .catch(() => {});
          }
        } finally {
          fetchRuns();
        }
      }
    };
    // Check every 30s.
    const timer = setInterval(tick, 30_000);
    // Also check immediately on mount.
    tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    isAdmin,
    autoEnabled,
    selfRefreshInProgress,
    onSelfRefresh,
    user,
    fetchRuns,
  ]);

  // -- Bulk trigger for ALL users (sequential, 800ms gap to respect SP-API limits) --
  // `excludeSelf=true` when chained right after the admin's own Manual SP-API Refresh
  // (no point re-triggering themselves — they just ran it locally).
  const handleTriggerAll = useCallback(async (excludeSelf = false) => {
    const targets = excludeSelf && user
      ? users.filter((u) => u.id !== user.id)
      : users;
    if (targets.length === 0) {
      if (!excludeSelf) toast.warning("No users loaded yet");
      return;
    }
    toast.info(`Triggering SP-API refresh for ${targets.length} user${targets.length === 1 ? "" : "s"}…`);
    setBulkTriggering(true);
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      const u = targets[i];
      setBulkProgress({ done: i, total: targets.length, current: u.email ?? u.id.slice(0, 8) });
      try {
        const { data, error } = await supabase.functions.invoke("admin-trigger-refresh", {
          body: { target_user_id: u.id, source: excludeSelf ? "manual_chain" : "manual_all" },
        });
        if (error) failed++;
        else if (data?.accepted === false) skipped++;
        else ok++;
      } catch {
        failed++;
      }
      // 800ms throttle between calls (SP-API + edge-function rate limits)
      if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 800));
    }
    setBulkProgress({ done: targets.length, total: targets.length, current: "done" });
    setBulkTriggering(false);
    toast.success(`Bulk refresh done: ${ok} ok, ${skipped} skipped, ${failed} failed`);
    await fetchRuns();
    setTimeout(() => setBulkProgress(null), 5000);
  }, [users, user, fetchRuns]);

  // -- Auto-chain + manual-click audit logging.
  //    On selfRefreshInProgress false→true: stamp a start time.
  //    On true→false: (a) audit-log the manual click to admin_refresh_runs
  //    so the purple panel shows it, then (b) fan out to all OTHER users.
  //    Skip audit when this completion was triggered by the self-auto slot
  //    (that slot already logs through admin-trigger-refresh non-audit). --
  const manualStartRef = useRef<string | null>(null);
  const skipNextManualAuditRef = useRef<boolean>(false);
  useEffect(() => {
    const wasRunning = prevSelfRefreshRef.current;
    prevSelfRefreshRef.current = selfRefreshInProgress;

    // false → true: record start of a manual click
    if (!wasRunning && selfRefreshInProgress) {
      manualStartRef.current = new Date().toISOString();
    }

    // true → false: completion
    if (
      wasRunning &&
      !selfRefreshInProgress &&
      isAdmin
    ) {
      const startedAt = manualStartRef.current;
      manualStartRef.current = null;

      // Audit-log this manual click (unless self-auto already logged it)
      if (!skipNextManualAuditRef.current && user) {
        supabase.functions
          .invoke("admin-trigger-refresh", {
            body: {
              target_user_id: user.id,
              source: "manual_self",
              audit_only: true,
              audit_status: "success",
              started_at: startedAt,
            },
          })
          .then(() => fetchRuns())
          .catch(() => {});
      }
      skipNextManualAuditRef.current = false;

      // Auto-chain fan-out to ALL OTHER users (existing behavior)
      if (autoChainAllRef.current && !bulkTriggering && users.length > 0) {
        setTimeout(() => handleTriggerAll(true), 500);
      }
    }
  }, [selfRefreshInProgress, isAdmin, bulkTriggering, users.length, handleTriggerAll, user, fetchRuns]);


  if (!isAdmin) return null;

  const filteredUsers = userFilter
    ? users.filter(
        (u) =>
          (u.email || "").toLowerCase().includes(userFilter.toLowerCase()) ||
          u.id.toLowerCase().includes(userFilter.toLowerCase()),
      )
    : users;

  return (
    <Card className="border-dashed border-purple-500/40 bg-purple-50/30 dark:bg-purple-950/10">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Shield className="h-4 w-4 text-purple-500" />
          Admin SP-API Refresh Control
          <Badge variant="outline" className="text-[9px] border-purple-500/40">
            admin-only
          </Badge>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 px-2 text-[10px]"
            onClick={fetchRuns}
            disabled={loadingRuns}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${loadingRuns ? "animate-spin" : ""}`} />
            Refresh log
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 px-4 space-y-4">
        {/* --- Cron Schedule Status (system-side scheduled crons) --- */}
        {(() => {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const fmtLocal = (d: Date) =>
            d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          const crons = [
            {
              name: "full-inventory-refresh-2h",
              label: "Full inventory refresh",
              freq: "every 2 hours @ :15 UTC",
              minute: 15,
              hourStep: 2,
              note: "Mirrors Manual SP-API Refresh for every user. Logs to edge function console only.",
            },
            {
              name: "sync-inventory-report-4h",
              label: "Inventory report sync",
              freq: "every 4 hours @ :00 UTC",
              minute: 0,
              hourStep: 4,
              note: "Reports API inbound stock sync (per-user fan-out).",
            },
          ];
          const now = new Date();
          return (
            <div className="rounded-md border-2 border-indigo-500/30 bg-background/60 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-indigo-500" />
                  Cron schedule status
                </div>
                <span className="text-[10px] text-muted-foreground font-mono">tz: {tz}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {crons.map((c) => {
                  const { last, next } = nextCronFire(c.minute, c.hourStep, now);
                  return (
                    <div
                      key={c.name}
                      className="rounded border border-indigo-500/20 bg-indigo-50/30 dark:bg-indigo-950/10 p-2 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <div className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
                          {c.label}
                        </div>
                        <Badge variant="outline" className="text-[9px] border-indigo-500/40">
                          {c.freq}
                        </Badge>
                      </div>
                      <div className="text-[10px] font-mono text-muted-foreground truncate" title={c.name}>
                        {c.name}
                      </div>
                      <div className="text-[10px] grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                        <span className="text-muted-foreground">Last slot:</span>
                        <span className="font-mono">{fmtLocal(last)} <span className="text-muted-foreground">({ago(last.toISOString())})</span></span>
                        <span className="text-muted-foreground">Next slot:</span>
                        <span className="font-mono">{fmtLocal(next)}</span>
                      </div>
                      <div className="text-[9px] text-muted-foreground italic leading-snug">{c.note}</div>
                    </div>
                  );
                })}
              </div>
              <div className="text-[10px] text-muted-foreground leading-snug border-t border-indigo-500/10 pt-1.5">
                <b>Chain:</b> scheduled cron runs first → <b>Self auto-refresh</b> fires +{OFFSET_MIN} min after the 2h cron (this tab, my account) → <b>ALL users chain</b> kicks off right after self-refresh completes.
              </div>
            </div>
          );
        })()}

        {/* --- Clear timing & status display --- */}
        {(() => {
          const selfRuns = runs.filter(
            (r) => r.target_user_id === user?.id && ["self_auto", "manual_self", "manual"].includes(r.source),
          );
          const allRuns = runs.filter((r) => ["manual_chain", "manual_all"].includes(r.source));
          const lastSelf = selfRuns[0] ?? null;
          const lastAll = allRuns[0] ?? null;
          const nextManual = autoEnabled ? nextRunAt : null;
          // ALL bulk runs ~2 min after manual completes (rough est). Use same slot.
          const nextAll = autoEnabled && nextRunAt
            ? new Date(nextRunAt.getTime() + 2 * 60_000)
            : null;

          let statusLabel = "Idle";
          let statusClass = "border-muted text-muted-foreground";
          let StatusIcon = CheckCircle;
          if (selfRefreshInProgress) {
            statusLabel = "Running — my account";
            statusClass = "border-blue-500/40 text-blue-600";
            StatusIcon = RefreshCw;
          } else if (bulkTriggering) {
            statusLabel = bulkProgress
              ? `Running — all other users (${bulkProgress.done}/${bulkProgress.total})`
              : "Running — all other users";
            statusClass = "border-purple-500/40 text-purple-600";
            StatusIcon = RefreshCw;
          } else {
            const lastAny = runs[0] ?? null;
            if (lastAny?.status === "failed") {
              statusLabel = "Last run failed";
              statusClass = "border-red-500/40 text-red-600";
              StatusIcon = AlertTriangle;
            } else if (lastAny?.status === "skipped_cron_recent") {
              statusLabel = "Skipped — scheduled cron ran recently";
              statusClass = "border-yellow-500/40 text-yellow-700";
              StatusIcon = PauseCircle;
            } else if (lastAny?.status?.startsWith("skipped_locked") || lastAny?.status === "skipped_in_progress") {
              statusLabel = "Skipped — locked / already running";
              statusClass = "border-yellow-500/40 text-yellow-700";
              StatusIcon = PauseCircle;
            } else if (lastAny?.status?.startsWith("skipped")) {
              statusLabel = `Skipped — ${lastAny.status.replace("skipped_", "")}`;
              statusClass = "border-yellow-500/40 text-yellow-700";
              StatusIcon = PauseCircle;
            }
          }

          const fmt = (d: Date | null) =>
            d ? d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) : "—";
          const fmtIso = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }) : "—");
          const resultLabel = (r: RunRow | null) => {
            if (!r) return "—";
            if (r.status === "success") return "✓ success";
            if (r.status === "failed") return `✗ failed${r.error_message ? `: ${r.error_message.slice(0, 40)}` : ""}`;
            if (r.status.startsWith("skipped")) return `⏸ ${r.status.replace("skipped_", "skip: ")}${r.skipped_reason ? ` (${r.skipped_reason.slice(0, 30)})` : ""}`;
            return r.status;
          };

          return (
            <div className="rounded-md border-2 border-purple-500/30 bg-background/60 p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-purple-500" />
                  Refresh schedule & status
                </div>
                <Badge variant="outline" className={`text-[10px] ${statusClass}`}>
                  <StatusIcon className={`h-3 w-3 mr-1 ${selfRefreshInProgress || bulkTriggering ? "animate-spin" : ""}`} />
                  {statusLabel}
                </Badge>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {/* Manual SP-API Refresh column */}
                <div className="rounded border border-blue-500/20 bg-blue-50/30 dark:bg-blue-950/10 p-2 space-y-1">
                  <div className="text-[11px] font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" />
                    Manual SP-API Refresh
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Refreshes <b>my admin account first</b>.
                  </div>
                  <div className="text-[10px] grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    <span className="text-muted-foreground">Next:</span>
                    <span className="font-mono">{autoEnabled ? fmt(nextManual) : "manual only (auto-refresh OFF)"}</span>
                    <span className="text-muted-foreground">Last:</span>
                    <span className="font-mono">{fmtIso(lastSelf?.started_at ?? null)}</span>
                    <span className="text-muted-foreground">Result:</span>
                    <span className="font-mono">{resultLabel(lastSelf)}</span>
                  </div>
                </div>

                {/* ALL users column */}
                <div className="rounded border border-purple-500/20 bg-purple-50/30 dark:bg-purple-950/10 p-2 space-y-1">
                  <div className="text-[11px] font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    ALL users refresh
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Auto-starts <b>after Manual SP-API Refresh completes</b> and refreshes the other users.
                  </div>
                  <div className="text-[10px] grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    <span className="text-muted-foreground">Next:</span>
                    <span className="font-mono">{autoEnabled ? `~${fmt(nextAll)}` : "manual only (auto-refresh OFF)"}</span>
                    <span className="text-muted-foreground">Last:</span>
                    <span className="font-mono">{fmtIso(lastAll?.started_at ?? null)}</span>
                    <span className="text-muted-foreground">Result:</span>
                    <span className="font-mono">{resultLabel(lastAll)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}


        {/* --- Self auto-refresh --- */}
        <div className="rounded border border-purple-500/20 p-3 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Switch
              id="auto-refresh-toggle"
              checked={autoEnabled}
              onCheckedChange={setAutoEnabled}
            />
            <Label htmlFor="auto-refresh-toggle" className="text-xs font-medium">
              Self auto-refresh (this tab, my account)
            </Label>
            <span className="text-[10px] text-muted-foreground">
              (+{OFFSET_MIN} min after each cron)
            </span>
            {autoEnabled && nextRunAt && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                next: {nextRunAt.toLocaleTimeString()}
              </span>
            )}
            {selfRefreshInProgress && (
              <Badge variant="outline" className="text-[10px] border-blue-500/40 text-blue-600">
                <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                running
              </Badge>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Fires the Manual SP-API Refresh <b>once per cron cycle</b>, {OFFSET_MIN} min after
            the scheduled <code>full-inventory-refresh-2h</code> cron (runs every 2h at :15
            UTC) — so it fires at :15 past every odd UTC hour. Only runs while this tab
            stays open. <b>Skipped</b> if any refresh is currently in progress or one
            started in the last 5 minutes (collision guard).
          </p>
        </div>

        {/* --- Remote refresh: ALL users --- */}
        <div className="rounded border border-purple-500/20 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-purple-500" />
              Remote refresh — ALL users ({users.length})
            </Label>
            <Input
              placeholder="Filter list…"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              className="h-7 text-xs w-[180px] ml-auto"
            />
            <Button
              size="sm"
              onClick={() => handleTriggerAll(false)}
              disabled={bulkTriggering || users.length === 0}
              className="h-8"
            >
              {bulkTriggering ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Zap className="h-3.5 w-3.5 mr-1" />
              )}
              Trigger refresh for ALL ({users.length})
            </Button>
          </div>
          {bulkProgress && (
            <div className="text-[10px] text-purple-700 dark:text-purple-300 font-mono">
              {bulkProgress.done}/{bulkProgress.total} — current: {bulkProgress.current}
            </div>
          )}
          <div className="max-h-40 overflow-y-auto rounded border border-purple-500/10 bg-background/50 p-1.5">
            {filteredUsers.length === 0 ? (
              <div className="text-[10px] text-muted-foreground italic px-1 py-0.5">
                {users.length === 0 ? "Loading users…" : "No users match filter"}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                {filteredUsers.map((u) => (
                  <div
                    key={u.id}
                    className="text-[10px] truncate"
                    title={u.id}
                  >
                    <span className="text-muted-foreground">•</span>{" "}
                    {u.email ?? u.id.slice(0, 8)}
                    {u.id === user?.id && (
                      <span className="text-purple-600 ml-1">(me)</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Runs server-side for every user above using stored SP-API tokens. 800ms
            gap between users to respect rate limits. Each call is independently
            blocked if the scheduled cron ran for that user in the last 10 minutes,
            the cron is currently running, or another admin refresh is in flight.
          </p>
        </div>


        {/* --- Audit log --- */}
        <details open className="text-xs">
          <summary className="cursor-pointer text-muted-foreground font-medium">
            Recent admin refresh runs ({runs.length})
          </summary>
          <div className="max-h-64 overflow-y-auto mt-2 space-y-0.5">
            {runs.length === 0 && (
              <div className="text-[10px] text-muted-foreground italic px-2 py-1">
                No runs logged yet.
              </div>
            )}
            {runs.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 text-[10px] py-1 px-2 rounded bg-muted/30"
              >
                <span className="font-mono w-32 shrink-0">
                  {new Date(r.started_at).toLocaleString()}
                </span>
                {statusBadge(r.status)}
                <Badge variant="outline" className="text-[9px] h-4">{r.scope}</Badge>
                <Badge variant="outline" className="text-[9px] h-4">{r.source}</Badge>
                <span className="truncate flex-1" title={r.target_user_id}>
                  → {r.target_email ?? r.target_user_id.slice(0, 8)}
                </span>
                <span className="text-muted-foreground shrink-0">
                  by {r.triggered_by_email ?? "?"}
                </span>
                <span className="shrink-0">
                  {r.status === "success" && <CheckCircle className="h-3 w-3 text-green-500" />}
                  {r.status === "failed" && <AlertTriangle className="h-3 w-3 text-red-500" />}
                  {r.status === "running" && (
                    <RefreshCw className="h-3 w-3 text-blue-500 animate-spin" />
                  )}
                  {r.status.startsWith("skipped") && (
                    <PauseCircle className="h-3 w-3 text-yellow-600" />
                  )}
                </span>
                {(r.skipped_reason || r.error_message) && (
                  <div
                    className="basis-full text-[9px] text-muted-foreground pl-32 truncate"
                    title={r.skipped_reason || r.error_message || ""}
                  >
                    {r.skipped_reason || r.error_message}
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
