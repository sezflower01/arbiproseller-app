import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Settings, Zap, Clock, DollarSign, Save, Play, RefreshCw, CheckCircle, XCircle, AlertTriangle, Info, PauseCircle, PlayCircle, SlidersHorizontal, Star, Copy, X, RotateCw } from "lucide-react";
import { calculateOptimizedSettings } from "@/lib/repricerOptimizer";
import TurboHistoryPanel from "./TurboHistoryPanel";
import { getDeviceNickname, setDeviceNickname } from "@/lib/repricerChangeLog";

function DeviceNicknameInput() {
  const [nickname, setNickname] = useState(getDeviceNickname());
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-2 border rounded-lg p-4 bg-muted/30">
      <Label className="text-sm font-medium">Device Nickname (for Change History)</Label>
      <p className="text-xs text-muted-foreground">
        Give this computer a name so you can identify it in the audit trail (e.g. "Office PC", "Home Laptop").
      </p>
      <div className="flex gap-2">
        <Input
          value={nickname}
          onChange={(e) => { setNickname(e.target.value); setSaved(false); }}
          placeholder="e.g. Office PC"
          className="max-w-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => { setDeviceNickname(nickname); setSaved(true); toast.success("Device nickname saved"); }}
        >
          {saved ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Save className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

interface RunResult {
  status: 'success' | 'failed' | 'warning';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: {
    evaluated: number;
    applied: number;
    skipped: number;
    errors: number;
    rainforestCreditsUsed: number;
  };
  exitReason?: string;
  details?: Array<{
    asin: string;
    sku?: string;
    action: string;
    reason: string;
  }>;
}

interface RepricerSettingsData {
  user_id: string;
  auto_apply: boolean;
  sp_api_check_interval_minutes: number;
  rainforest_snapshot_ttl_minutes: number;
  daily_credit_cap: number;
  credits_used_today: number;
  credits_reset_at: string;
  scheduler_enabled: boolean;
  scheduler_status: string | null;
  last_scheduler_run_at: string | null;
  // Queue state
  queue_paused: boolean;
  queue_pause_reason: string | null;
  queue_auto_resume_at: string | null;
  // Safety settings
  absolute_min_price_floor: number;
  max_price_change_percent_per_day: number;
  max_minmax_changes_per_day: number;
  require_cost_for_min_calc: boolean;
}

interface RepricerSettingsProps {
  onSettingsChange?: () => void;
  isAdmin?: boolean;
}

export default function RepricerSettings({ onSettingsChange, isAdmin = false }: RepricerSettingsProps) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<RepricerSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningScheduler, setRunningScheduler] = useState(false);
  const [resumingQueue, setResumingQueue] = useState(false);
  const [lastRunResult, setLastRunResult] = useState<RunResult | null>(null);
  const [activeAsinCount, setActiveAsinCount] = useState(500);
  const [detectedEligible, setDetectedEligible] = useState<number | null>(null);
  const [repricingMode, setRepricingMode] = useState<'speed' | 'balanced' | 'scale'>('speed');
  const [showManualOverride, setShowManualOverride] = useState(false);

  // Live activity source state
  const [liveActivity, setLiveActivity] = useState<{
    lastEvalAt: string | null;
    writes24h: number;
    evals24h: number;
    bySource: Record<string, { writes: number; evals: number; lastAt: string | null }>;
  } | null>(null);
  
  // Priority queue state
  const [starredItems, setStarredItems] = useState<Array<{ id: string; asin: string; sku: string; marketplace: string; last_priority_check_at: string | null }>>([]);
  const [starredLoading, setStarredLoading] = useState(false);

  // Auto-turbo state
  const [userRules, setUserRules] = useState<Array<{ id: string; name: string }>>([]);
  const [autoTurboForm, setAutoTurboForm] = useState({
    enabled: false,
    duration_minutes: 30,
    rule_id: "" as string,
  });
  const [autoTurboBatch, setAutoTurboBatch] = useState<any[]>([]);
  const [autoTurboLastRotation, setAutoTurboLastRotation] = useState<string | null>(null);
  const [autoTurboPool, setAutoTurboPool] = useState<string[]>([]);
  const [autoTurboCursor, setAutoTurboCursor] = useState(0);

  // Sequential sweep state
  const [sweepForm, setSweepForm] = useState({
    enabled: false,
    batch_size: 10,
    interval_minutes: 3,
  });
  const [sweepStats, setSweepStats] = useState({
    last_run_at: null as string | null,
    checked_this_pass: 0,
    total_eligible: 0,
    pass_started_at: null as string | null,
    passes_completed: 0,
  });

  const [formData, setFormData] = useState({
    auto_apply: false,
    scheduler_enabled: true,
    continuous_mode: false,
    sp_api_check_interval_minutes: 10,
    rainforest_snapshot_ttl_minutes: 60,
    daily_credit_cap: 100,
    scheduler_batch_size: 100,
    // Safety settings
    absolute_min_price_floor: 5.00,
    max_price_change_percent_per_day: 50,
    max_minmax_changes_per_day: 10,
    require_cost_for_min_calc: true,
    // Momentum settings
    momentum_check_enabled: true,
    momentum_threshold_pct: 50,
  });

  // Auto-calculate optimal settings based on active ASIN count
  const optimizedSettings = useMemo(() => calculateOptimizedSettings(activeAsinCount), [activeAsinCount]);

  // Sync optimized values into formData when slider changes
  useEffect(() => {
    setFormData(prev => ({
      ...prev,
      scheduler_batch_size: optimizedSettings.batchSize,
      sp_api_check_interval_minutes: optimizedSettings.interval,
      rainforest_snapshot_ttl_minutes: optimizedSettings.snapshotTtl,
    }));
  }, [optimizedSettings]);

  const fetchStarredItems = useCallback(async () => {
    if (!user) return;
    setStarredLoading(true);
    try {
      const { data, error } = await supabase
        .from("repricer_assignments")
        .select("id, asin, sku, marketplace, last_priority_check_at")
        .eq("user_id", user.id)
        .eq("is_priority", true)
        .eq("is_enabled", true)
        .order("asin");
      if (!error) setStarredItems(data || []);
    } catch (e) {
      console.error("Error fetching starred items:", e);
    } finally {
      setStarredLoading(false);
    }
  }, [user]);

  const fetchLiveActivity = useCallback(async () => {
    if (!user) return;
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: acks } = await supabase
        .from("repricer_eval_acks")
        .select("result, trigger_source, acked_at")
        .eq("user_id", user.id)
        .gte("acked_at", twentyFourHoursAgo)
        .order("acked_at", { ascending: false })
        .limit(3000);

      if (!acks) return;

      const bySource: Record<string, { writes: number; evals: number; lastAt: string | null }> = {};
      let writes24h = 0;
      let lastEvalAt: string | null = acks.length > 0 ? acks[0].acked_at : null;

      for (const ack of acks) {
        const source = ack.trigger_source || "unknown";
        if (!bySource[source]) bySource[source] = { writes: 0, evals: 0, lastAt: null };
        bySource[source].evals++;
        if (!bySource[source].lastAt) bySource[source].lastAt = ack.acked_at;
        if (ack.result === "changed") {
          bySource[source].writes++;
          writes24h++;
        }
      }

      setLiveActivity({ lastEvalAt, writes24h, evals24h: acks.length, bySource });
    } catch (err) {
      console.error("Live activity fetch error:", err);
    }
  }, [user]);

  // Auto-detect eligible ASIN count and set mode accordingly
  const fetchEligibleCount = useCallback(async () => {
    if (!user) return;
    try {
      const { count } = await supabase
        .from("repricer_assignments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("is_enabled", true);
      
      if (count !== null) {
        setDetectedEligible(count);
        // Auto-determine mode and ASIN count if not manually overridden
        if (!showManualOverride) {
          let autoMode: 'speed' | 'balanced' | 'scale';
          let autoCount: number;
          if (count <= 500) {
            autoMode = 'speed'; autoCount = Math.max(50, Math.ceil(count / 50) * 50);
          } else if (count <= 1500) {
            autoMode = 'balanced'; autoCount = Math.ceil(count / 100) * 100;
          } else {
            autoMode = 'scale'; autoCount = Math.ceil(count / 100) * 100;
          }
          setRepricingMode(autoMode);
          setActiveAsinCount(Math.max(50, Math.min(6000, autoCount)));
        }
      }
    } catch (err) {
      console.error("Error fetching eligible count:", err);
    }
  }, [user, showManualOverride]);

  // Auto-refresh settings every 30s to keep status/timestamps current
  useEffect(() => {
    if (user) {
      fetchSettings();
      fetchStarredItems();
      fetchUserRules();
      fetchLiveActivity();
      fetchEligibleCount();
      const refreshInterval = setInterval(() => { fetchSettings(); fetchLiveActivity(); }, 30_000);
      return () => clearInterval(refreshInterval);
    }
  }, [user]);

  const fetchUserRules = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("repricer_rules")
      .select("id, name")
      .order("name");
    if (data) setUserRules(data);
  };

  const fetchSettings = async () => {
    try {
      setLoading(true);
      let { data, error } = await supabase
        .from("repricer_settings")
        .select("*")
        .eq("user_id", user?.id)
        .maybeSingle();

      if (error && error.code !== "PGRST116") throw error;

      // Create default settings if none exist
      if (!data) {
        const { data: newData, error: insertError } = await supabase
          .from("repricer_settings")
          .insert({ user_id: user?.id })
          .select()
          .single();

        if (insertError) throw insertError;
        data = newData;
      }

      // Reset credits if new day
      const today = new Date().toISOString().split("T")[0];
      if (data && data.credits_reset_at !== today) {
        await supabase
          .from("repricer_settings")
          .update({ credits_used_today: 0, credits_reset_at: today })
          .eq("user_id", user?.id);
        data.credits_used_today = 0;
        data.credits_reset_at = today;
      }

      if (data) {
        setSettings(data);

        // Auto-detect and persist user's timezone if not yet set or different
        const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const storedTz = (data as any).schedule_timezone;
        if (!storedTz || storedTz === 'America/Chicago' && detectedTz !== 'America/Chicago') {
          // Only auto-update if it's still the default and user is elsewhere
          await supabase.from("repricer_settings").update({ schedule_timezone: detectedTz } as any).eq("user_id", user?.id);
          (data as any).schedule_timezone = detectedTz;
        }
        setFormData({
          auto_apply: data.auto_apply,
          scheduler_enabled: data.scheduler_enabled ?? false,
          continuous_mode: (data as any).continuous_mode ?? false,
          sp_api_check_interval_minutes: data.sp_api_check_interval_minutes,
          rainforest_snapshot_ttl_minutes: data.rainforest_snapshot_ttl_minutes,
          daily_credit_cap: data.daily_credit_cap,
          scheduler_batch_size: (data as any).scheduler_batch_size ?? 100,
          // Safety settings
          absolute_min_price_floor: data.absolute_min_price_floor ?? 0.99,
          max_price_change_percent_per_day: data.max_price_change_percent_per_day ?? 50,
          max_minmax_changes_per_day: data.max_minmax_changes_per_day ?? 10,
          require_cost_for_min_calc: data.require_cost_for_min_calc ?? true,
          // Momentum settings
          momentum_check_enabled: (data as any).momentum_check_enabled ?? true,
          momentum_threshold_pct: (data as any).momentum_threshold_pct ?? 50,
        });
        // Auto-turbo settings
        setAutoTurboForm({
          enabled: (data as any).auto_turbo_enabled ?? false,
          duration_minutes: (data as any).auto_turbo_duration_minutes ?? 30,
          rule_id: (data as any).auto_turbo_rule_id ?? "",
        });
        setAutoTurboBatch((data as any).auto_turbo_current_batch || []);
        setAutoTurboLastRotation((data as any).auto_turbo_last_rotation_at || null);
        setAutoTurboPool((data as any).auto_turbo_rotation_pool || []);
        setAutoTurboCursor((data as any).auto_turbo_rotation_cursor || 0);
        // Sequential sweep settings
        setSweepForm({
          enabled: (data as any).sequential_sweep_enabled ?? false,
          batch_size: (data as any).sequential_sweep_batch_size ?? 10,
          interval_minutes: (data as any).sequential_sweep_interval_minutes ?? 3,
        });
        setSweepStats({
          last_run_at: (data as any).sequential_sweep_last_run_at || null,
          checked_this_pass: (data as any).sequential_sweep_checked_this_pass || 0,
          total_eligible: (data as any).sequential_sweep_total_eligible || 0,
          pass_started_at: (data as any).sequential_sweep_pass_started_at || null,
          passes_completed: (data as any).sequential_sweep_passes_completed || 0,
        });
      }
    } catch (error: any) {
      console.error("Error fetching settings:", error);
      toast.error("Failed to load settings");
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      const { error } = await supabase
        .from("repricer_settings")
        .update({
          auto_apply: formData.auto_apply,
          scheduler_enabled: formData.scheduler_enabled,
          continuous_mode: formData.continuous_mode,
          sp_api_check_interval_minutes: formData.sp_api_check_interval_minutes,
          rainforest_snapshot_ttl_minutes: formData.rainforest_snapshot_ttl_minutes,
          daily_credit_cap: formData.daily_credit_cap,
          scheduler_batch_size: formData.scheduler_batch_size,
          // Safety settings
          absolute_min_price_floor: formData.absolute_min_price_floor,
          max_price_change_percent_per_day: formData.max_price_change_percent_per_day,
          max_minmax_changes_per_day: formData.max_minmax_changes_per_day,
          require_cost_for_min_calc: formData.require_cost_for_min_calc,
          // Momentum settings
          momentum_check_enabled: formData.momentum_check_enabled,
          momentum_threshold_pct: formData.momentum_threshold_pct,
          // Auto-turbo settings
          auto_turbo_enabled: autoTurboForm.enabled,
          auto_turbo_duration_minutes: autoTurboForm.duration_minutes,
          auto_turbo_rule_id: autoTurboForm.rule_id || null,
          // Sequential sweep settings
          sequential_sweep_enabled: sweepForm.enabled,
          sequential_sweep_batch_size: sweepForm.batch_size,
          sequential_sweep_interval_minutes: sweepForm.interval_minutes,
        } as any)
        .eq("user_id", user?.id);

      if (error) throw error;

      toast.success("Settings saved");
      fetchSettings();
      onSettingsChange?.();
    } catch (error: any) {
      toast.error("Failed to save: " + error.message);
    } finally {
      setSaving(false);
    }
  };

  const runSchedulerManually = async () => {
    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    
    try {
      setRunningScheduler(true);
      setLastRunResult(null);
      toast.info("Running scheduler...");

      const result = await (await import("@/lib/edgeFunctionClient")).invokeEdgeFunction({
        functionName: "repricer-scheduler",
        body: { dry_run: false },
        maxRetries: 1,
        context: { source: "settings_run" },
      });

      const data = result.data;
      const error = result.ok ? null : { message: `${result.errorCategory}: ${result.errorMessage}` };

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;

      if (error) {
        setLastRunResult({
          status: 'failed',
          startedAt,
          finishedAt,
          durationMs,
          summary: { evaluated: 0, applied: 0, skipped: 0, errors: 1, rainforestCreditsUsed: 0 },
          exitReason: error.message || 'Unknown error'
        });
        throw error;
      }

      const summary = data.summary || { evaluated: 0, applied: 0, skipped: 0, errors: 0, rainforestCreditsUsed: 0 };
      const results = data.results || [];
      
      // Determine exit reason
      let exitReason = 'SUCCESS';
      if (summary.evaluated === 0 && summary.applied === 0) {
        if (data.message === 'Scheduler disabled') {
          exitReason = 'SCHEDULER_DISABLED';
        } else if (results.length === 0) {
          exitReason = 'NO_ASSIGNMENTS';
        } else {
          exitReason = 'NO_ITEMS_MATCHED';
        }
      } else if (summary.errors > 0) {
        exitReason = 'PARTIAL_SUCCESS';
      }

      const runResult: RunResult = {
        status: summary.errors > 0 ? 'warning' : (summary.evaluated === 0 ? 'warning' : 'success'),
        startedAt,
        finishedAt,
        durationMs,
        summary: {
          evaluated: summary.evaluated || 0,
          applied: summary.applied || 0,
          skipped: summary.skipped || results.filter((r: any) => r.action === 'skipped').length || 0,
          errors: summary.errors || results.filter((r: any) => r.action === 'error').length || 0,
          rainforestCreditsUsed: summary.rainforestCreditsUsed || 0
        },
        exitReason,
        details: results.slice(0, 10) // Show first 10 for UI
      };

      setLastRunResult(runResult);
      
      if (exitReason === 'NO_ASSIGNMENTS') {
        toast.warning("No enabled assignments found. Enable repricing on items in the Assignments tab.", { duration: 6000 });
      } else if (exitReason === 'SCHEDULER_DISABLED') {
        toast.warning("Scheduler is disabled. Enable it above to run.", { duration: 6000 });
      } else {
        toast.success(
          `Complete: ${summary.evaluated} evaluated, ${summary.applied} applied, ${summary.rainforestCreditsUsed} credits used`,
          { duration: 6000 }
        );
      }
      
      fetchSettings();
    } catch (error: any) {
      toast.error("Scheduler failed: " + error.message);
    } finally {
    setRunningScheduler(false);
    }
  };

  const resumeQueue = async () => {
    try {
      setResumingQueue(true);
      const { error } = await supabase
        .from("repricer_settings")
        .update({
          queue_paused: false,
          queue_pause_reason: null,
          queue_auto_resume_at: null,
        })
        .eq("user_id", user?.id);

      if (error) throw error;

      toast.success("Queue resumed");
      fetchSettings();
    } catch (error: any) {
      toast.error("Failed to resume: " + error.message);
    } finally {
      setResumingQueue(false);
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const creditsUsed = settings?.credits_used_today || 0;
  const creditsCap = settings?.daily_credit_cap || 100;
  const creditsRemaining = Math.max(0, creditsCap - creditsUsed);
  const creditsPercent = (creditsUsed / creditsCap) * 100;
  const rawSchedulerStatus = settings?.scheduler_status || 'idle';
  const lastRunDate = settings?.last_scheduler_run_at ? new Date(settings.last_scheduler_run_at) : null;
  const lastRun = lastRunDate ? lastRunDate.toLocaleString() : 'Never';
  
  // Use live eval activity to determine true system status (not just stale scheduler timestamp)
  const lastEvalDate = liveActivity?.lastEvalAt ? new Date(liveActivity.lastEvalAt) : null;
  const trueLastActivity = lastEvalDate && lastRunDate
    ? (lastEvalDate > lastRunDate ? lastEvalDate : lastRunDate)
    : lastEvalDate || lastRunDate;
  const isRecentlyActive = trueLastActivity && (Date.now() - trueLastActivity.getTime()) < 20 * 60 * 1000;

  const effectiveStatus = rawSchedulerStatus === 'running' 
    ? 'running' 
    : settings?.queue_paused 
      ? 'paused'
      : formData.scheduler_enabled && isRecentlyActive
        ? (formData.continuous_mode ? 'active_continuous' : 'active')
        : formData.scheduler_enabled
          ? 'scheduled'
          : 'idle';
  
  const statusLabel: Record<string, string> = {
    running: '⚡ Running Now',
    active_continuous: '🔄 Active (Continuous)',
    active: '✅ Active',
    scheduled: '⏳ Scheduled (Waiting)',
    paused: '⏸ Paused',
    idle: 'Idle',
  };
  const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    running: 'default',
    active_continuous: 'default',
    active: 'default',
    scheduled: 'secondary',
    paused: 'destructive',
    idle: 'secondary',
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading settings...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Repricer Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">

        {/* ═══════════════════════════════════════════ */}
        {/* 📡 OPERATIONS GROUP                         */}
        {/* ═══════════════════════════════════════════ */}
        {isAdmin && (
          <div className="flex items-center gap-2 pt-2">
            <Badge variant="outline" className="text-xs font-semibold tracking-wide uppercase px-3 py-1">
              📡 Operations
            </Badge>
            <div className="flex-1 border-t border-border" />
          </div>
        )}

        {/* Queue Pause/Resume Panel */}
        {settings?.queue_paused && (
          <div className="p-4 border rounded-lg border-red-500 bg-red-500/10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <PauseCircle className="h-5 w-5 text-red-500" />
                <span className="font-medium text-red-700 dark:text-red-300">Queue Paused</span>
              </div>
              <Badge variant="destructive">Paused</Badge>
            </div>
            <div className="space-y-2">
              {settings.queue_pause_reason && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  <strong>Reason:</strong> {settings.queue_pause_reason}
                </p>
              )}
              {settings.queue_auto_resume_at && (
                <p className="text-xs text-muted-foreground">
                  Auto-resume scheduled: {new Date(settings.queue_auto_resume_at).toLocaleString()}
                </p>
              )}
              <div className="flex gap-2 mt-2">
                <Button 
                  size="sm" 
                  variant="outline"
                  onClick={resumeQueue}
                  disabled={resumingQueue}
                  className="border-red-500 text-red-600 hover:bg-red-100 dark:hover:bg-red-900"
                >
                  {resumingQueue ? (
                    <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <PlayCircle className="h-3 w-3 mr-1" />
                  )}
                  Resume Queue
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Primary Marketplace Selector */}
        <div className="p-4 border rounded-lg bg-muted/30">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                <span className="font-medium text-sm">Primary Marketplace</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your main market gets near-continuous coverage. Other markets follow rule-level scheduling policies.
              </p>
            </div>
          </div>
          <Select
            value={(settings as any)?.primary_marketplace || "US"}
            onValueChange={async (val) => {
              try {
                await supabase.from("repricer_settings").update({ primary_marketplace: val } as any).eq("user_id", user?.id);
                toast.success(`Primary marketplace set to ${val}`);
                fetchSettings();
              } catch (e: any) {
                toast.error("Failed to update: " + e.message);
              }
            }}
          >
            <SelectTrigger className="w-48 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="US">🇺🇸 United States</SelectItem>
              <SelectItem value="CA">🇨🇦 Canada</SelectItem>
              <SelectItem value="MX">🇲🇽 Mexico</SelectItem>
              <SelectItem value="BR">🇧🇷 Brazil</SelectItem>
              <SelectItem value="UK">🇬🇧 United Kingdom</SelectItem>
              <SelectItem value="DE">🇩🇪 Germany</SelectItem>
              <SelectItem value="ES">🇪🇸 Spain</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Scheduler Status */}
        <div className="p-4 border rounded-lg bg-muted/30">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-blue-500" />
              <span className="font-medium">Automation Status</span>
            </div>
            <Badge variant={statusVariant[effectiveStatus] || 'secondary'}>
              {statusLabel[effectiveStatus] || 'Idle'}
            </Badge>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <div>
                {lastEvalDate && (
                  <div className="flex items-center gap-1">
                    <CheckCircle className="h-3 w-3 text-green-500" />
                    <span className="text-xs text-foreground font-medium">
                      Last activity: {lastEvalDate.toLocaleString()}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({Math.round((Date.now() - lastEvalDate.getTime()) / 60000)} min ago)
                    </span>
                  </div>
                )}
                {isAdmin && lastRunDate && lastEvalDate && lastRunDate < lastEvalDate && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                    <span className="text-[10px] text-muted-foreground">
                       Legacy scheduler idle. Unified dispatch is currently driving repricer activity.
                     </span>
                  </div>
                )}
                {!lastEvalDate && (
                  <div>
                    <span className="text-xs text-muted-foreground">Last scheduler run: {lastRun}</span>
                    {lastRunDate && (
                      <span className="text-xs text-muted-foreground ml-2">
                        ({Math.round((Date.now() - lastRunDate.getTime()) / 60000)} min ago)
                      </span>
                    )}
                  </div>
                )}
              </div>
              {isAdmin && (
              <Button 
                size="sm" 
                variant="outline"
                onClick={runSchedulerManually}
                disabled={runningScheduler || settings?.queue_paused}
              >
                {runningScheduler ? (
                  <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                Run Now
              </Button>
              )}
            </div>

            {isAdmin && liveActivity && (
              <div className="mt-2 pt-2 border-t text-xs">
                <div className="flex gap-4 text-muted-foreground">
                  <span><strong className="text-foreground">{liveActivity.writes24h}</strong> writes (24h)</span>
                  <span><strong className="text-foreground">{liveActivity.evals24h}</strong> evals (24h)</span>
                </div>
              </div>
            )}
          </div>

          {isAdmin && (
            <>
          {/* Continuous Mode Toggle */}
          <div className="mt-3 pt-3 border-t flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                <Label className="text-sm font-medium">Continuous Mode</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Auto-chain batches when idle — up to 3× faster full-cycle rotation
              </p>
            </div>
            <Switch
              checked={formData.continuous_mode}
              onCheckedChange={(checked) => setFormData(prev => ({ ...prev, continuous_mode: checked }))}
            />
          </div>
          
          {/* Last Run Result Details */}
          {lastRunResult && (
            <div className="mt-3 p-3 border rounded-lg bg-background/50 text-xs space-y-2">
              <div className="flex items-center gap-2 font-medium">
                {lastRunResult.status === 'success' && <CheckCircle className="h-4 w-4 text-green-500" />}
                {lastRunResult.status === 'failed' && <XCircle className="h-4 w-4 text-destructive" />}
                {lastRunResult.status === 'warning' && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                <span>
                  {lastRunResult.exitReason === 'SUCCESS' && 'Run completed successfully'}
                  {lastRunResult.exitReason === 'NO_ASSIGNMENTS' && 'No enabled assignments found'}
                  {lastRunResult.exitReason === 'NO_ITEMS_MATCHED' && 'No items matched criteria'}
                  {lastRunResult.exitReason === 'SCHEDULER_DISABLED' && 'Scheduler is disabled'}
                  {lastRunResult.exitReason === 'PARTIAL_SUCCESS' && 'Completed with some errors'}
                  {lastRunResult.exitReason === 'QUEUE_PAUSED' && 'Queue is paused'}
                  {!['SUCCESS', 'NO_ASSIGNMENTS', 'NO_ITEMS_MATCHED', 'SCHEDULER_DISABLED', 'PARTIAL_SUCCESS', 'QUEUE_PAUSED'].includes(lastRunResult.exitReason || '') && lastRunResult.exitReason}
                </span>
              </div>
              
              <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                <div>Started: {new Date(lastRunResult.startedAt).toLocaleTimeString()}</div>
                <div>Duration: {formatDuration(lastRunResult.durationMs)}</div>
              </div>
              
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="text-xs">
                  <Info className="h-3 w-3 mr-1" />
                  {lastRunResult.summary.evaluated} evaluated
                </Badge>
                <Badge variant={lastRunResult.summary.applied > 0 ? "default" : "secondary"} className="text-xs">
                  {lastRunResult.summary.applied} applied
                </Badge>
                <Badge variant="secondary" className="text-xs">
                  {lastRunResult.summary.skipped} skipped
                </Badge>
                {lastRunResult.summary.errors > 0 && (
                  <Badge variant="destructive" className="text-xs">
                    {lastRunResult.summary.errors} errors
                  </Badge>
                )}
                <Badge variant="outline" className="text-xs">
                  <Zap className="h-3 w-3 mr-1" />
                  {lastRunResult.summary.rainforestCreditsUsed} credits
                </Badge>
              </div>
              
              {lastRunResult.details && lastRunResult.details.length > 0 && (
                <div className="mt-2 pt-2 border-t">
                  <div className="font-medium mb-1">Details (first {lastRunResult.details.length}):</div>
                  <div className="max-h-24 overflow-y-auto space-y-1">
                    {lastRunResult.details.map((d, i) => (
                      <div key={i} className="flex gap-2 items-start">
                        <span className="font-mono text-[10px] bg-muted px-1 rounded">{d.asin}</span>
                        <Badge variant={
                          d.action === 'applied' ? 'default' :
                          d.action === 'error' ? 'destructive' :
                          d.action === 'skipped' ? 'secondary' : 'outline'
                        } className="text-[10px] h-4">
                          {d.action}
                        </Badge>
                        <span className="text-muted-foreground truncate flex-1">{d.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
            </>
          )}
        </div>

        {/* Live Activity Source — admin only */}
        {isAdmin && liveActivity && Object.keys(liveActivity.bySource).length > 0 && (
          <div className="p-4 border rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm">Live Activity Source (24h)</span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Shows which subsystem is actually generating evaluations and writes right now.
            </p>
            <div className="space-y-1.5">
              {Object.entries(liveActivity.bySource)
                .sort(([, a], [, b]) => b.evals - a.evals)
                .map(([source, stats]) => {
                  const sourceLabels: Record<string, string> = {
                    cron: "⏰ Cron Scheduler",
                    sweep: "🔄 Sequential Sweep",
                    turbo: "⚡ Turbo / Priority",
                    manual: "👤 Manual Run",
                    bb_alert: "🔔 Buy Box Alert",
                    dispatch: "📡 Unified Dispatch",
                    unknown: "❓ Unknown",
                  };
                  const label = sourceLabels[source] || `📡 ${source}`;
                  const lastAt = stats.lastAt ? new Date(stats.lastAt) : null;
                  const minutesAgo = lastAt ? Math.round((Date.now() - lastAt.getTime()) / 60000) : null;

                  return (
                    <div key={source} className="flex items-center justify-between p-2 rounded border bg-background text-xs">
                      <span className="font-medium">{label}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground">
                          <strong className="text-foreground">{stats.writes}</strong> writes
                        </span>
                        <span className="text-muted-foreground">
                          <strong className="text-foreground">{stats.evals}</strong> evals
                        </span>
                        {minutesAgo !== null && (
                          <span className={`text-[10px] ${minutesAgo < 20 ? "text-green-600" : minutesAgo < 60 ? "text-amber-600" : "text-muted-foreground"}`}>
                            {minutesAgo}m ago
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {isAdmin && (<>
        {/* Priority Queue Panel */}
        <div className="p-4 border rounded-lg bg-muted/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
              <span className="font-medium">Priority Queue</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={starredItems.length >= 5 ? "destructive" : "secondary"}>
                Starred: {starredItems.length}/5
              </Badge>
              <span className="text-xs text-muted-foreground">· Evaluated every ~1 min</span>
            </div>
          </div>

          {starredLoading ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : starredItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No ASINs in Turbo mode. Star items from the Assignments tab.</p>
          ) : (
            <div className="space-y-2">
              {starredItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between p-2 rounded border bg-background text-sm">
                  <div className="flex items-center gap-3 min-w-0">
                    <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500 shrink-0" />
                    <span className="font-mono font-medium">{item.asin}</span>
                    <span className="text-xs text-muted-foreground truncate">{item.sku}</span>
                    {item.marketplace !== "US" && (
                      <Badge variant="outline" className="text-[10px] h-4">{item.marketplace}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      title="Copy ASIN"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(item.asin);
                          toast.success("ASIN copied!");
                        } catch { toast.error("Failed to copy"); }
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      title="Remove from Turbo"
                      onClick={async () => {
                        const { error } = await supabase
                          .from("repricer_assignments")
                          .update({ is_priority: false })
                          .eq("id", item.id);
                        if (error) { toast.error("Failed"); return; }
                        setStarredItems(prev => prev.filter(i => i.id !== item.id));
                        toast.success(`${item.asin} removed from Turbo`);
                      }}
                    >
                      <X className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              ))}

              {/* Copy All ASINs */}
              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs mt-1"
                onClick={async () => {
                  const asins = starredItems.map(i => i.asin).join(", ");
                  try {
                    await navigator.clipboard.writeText(asins);
                    toast.success(`${starredItems.length} ASINs copied!`);
                  } catch { toast.error("Failed to copy"); }
                }}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy All ASINs
              </Button>
            </div>
          )}
        </div>

        {/* Auto-Turbo Rotation Panel */}
        <div className="p-4 border rounded-lg bg-muted/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <RotateCw className="h-4 w-4 text-primary" />
              <span className="font-medium">Auto-Turbo Rotation</span>
            </div>
            <Switch
              checked={autoTurboForm.enabled}
              onCheckedChange={(checked) =>
                setAutoTurboForm({ ...autoTurboForm, enabled: checked })
              }
            />
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Automatically rotates BB price alert ASINs (highest drop first) into Turbo mode in batches of 5, 
            overriding their rule for the chosen duration, then reverting and moving to the next batch.
          </p>

          {autoTurboForm.enabled && (
            <div className="space-y-4">
              {/* Duration selector */}
              <div className="space-y-2">
                <Label>Turbo Duration per Batch</Label>
                <Select
                  value={String(autoTurboForm.duration_minutes)}
                  onValueChange={(val) =>
                    setAutoTurboForm({ ...autoTurboForm, duration_minutes: Number(val) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 10, 15, 20, 25, 30].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} minutes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Each batch of 5 ASINs stays in Turbo for this duration before rotating to the next 5.
                </p>
              </div>

              {/* Rule selector */}
              <div className="space-y-2">
                <Label>Turbo Rule Override</Label>
                <Select
                  value={autoTurboForm.rule_id || "none"}
                  onValueChange={(val) =>
                    setAutoTurboForm({ ...autoTurboForm, rule_id: val === "none" ? "" : val })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a rule..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Keep existing rule</SelectItem>
                    {userRules.map((rule) => (
                      <SelectItem key={rule.id} value={rule.id}>
                        {rule.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Temporarily assign this rule during turbo. Original rule is restored after the duration.
                </p>
              </div>

              {/* Current batch status */}
              {autoTurboBatch.length > 0 && (
                <div className="p-3 border rounded-lg bg-background/50 space-y-2">
                  <div className="flex items-center gap-2">
                    <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />
                    <span className="text-sm font-medium">Active Turbo Batch ({autoTurboBatch.length}/5)</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {autoTurboBatch.map((item: any, i: number) => (
                      <Badge key={i} variant="outline" className="font-mono text-xs">
                        {item.asin}
                      </Badge>
                    ))}
                  </div>
                  {autoTurboLastRotation && (
                    <p className="text-[10px] text-muted-foreground">
                      Last rotation: {new Date(autoTurboLastRotation).toLocaleString()}
                    </p>
                  )}
                </div>
              )}

              {/* Rotation Pool Info */}
              <div className="p-3 border rounded-lg bg-background/50 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <RotateCw className="h-3.5 w-3.5 text-primary" />
                    <span className="text-sm font-medium">Rotation Pool</span>
                  </div>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {autoTurboPool.length} ASINs
                  </Badge>
                </div>
                {autoTurboPool.length > 0 ? (
                  <>
                    <Progress 
                      value={(autoTurboCursor / autoTurboPool.length) * 100} 
                      className="h-2" 
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Position: {autoTurboCursor}/{autoTurboPool.length} · 
                      Full cycle: ~{Math.ceil(autoTurboPool.length / 5)} rotations · 
                      Est. {Math.ceil(autoTurboPool.length / 5) * autoTurboForm.duration_minutes} min
                    </p>
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        View all {autoTurboPool.length} ASINs in pool
                      </summary>
                      <div className="flex flex-wrap gap-1 mt-2 max-h-32 overflow-y-auto">
                        {autoTurboPool.map((asin: string, i: number) => (
                          <Badge 
                            key={i} 
                            variant={i >= autoTurboCursor && i < autoTurboCursor + 5 ? "default" : "outline"} 
                            className="font-mono text-[10px]"
                          >
                            {asin}
                          </Badge>
                        ))}
                      </div>
                    </details>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Pool will auto-populate from BB alerts and in-stock assignments on next rotation.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Turbo History */}
        <TurboHistoryPanel />
        </>)}

        {isAdmin && (
        /* Sequential Sweep Mode */
        <div className="border-t pt-4 mt-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-primary" />
              <span className="font-medium">Sequential Sweep Mode</span>
            </div>
            <Switch
              checked={sweepForm.enabled}
              onCheckedChange={(checked) =>
                setSweepForm({ ...sweepForm, enabled: checked })
              }
            />
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Low-priority background lane that processes active listings in small batches (10 at a time), 
            rotating through the entire catalog. Skips starred/turbo ASINs and respects all rate limits.
          </p>

          {sweepForm.enabled && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Batch Size</Label>
                  <Select
                    value={String(sweepForm.batch_size)}
                    onValueChange={(val) =>
                      setSweepForm({ ...sweepForm, batch_size: Number(val) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[5, 10, 15, 20, 25].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} ASINs
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Interval</Label>
                  <Select
                    value={String(sweepForm.interval_minutes)}
                    onValueChange={(val) =>
                      setSweepForm({ ...sweepForm, interval_minutes: Number(val) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 5, 10].map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          Every {m} min
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Sweep Progress */}
              <div className="p-3 border rounded-lg bg-background/50 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Sweep Progress</span>
                  <Badge variant="secondary" className="font-mono text-xs">
                    Pass #{sweepStats.passes_completed + 1}
                  </Badge>
                </div>
                {sweepStats.total_eligible > 0 ? (
                  <>
                    <Progress 
                      value={(sweepStats.checked_this_pass / sweepStats.total_eligible) * 100} 
                      className="h-2" 
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>{sweepStats.checked_this_pass} / {sweepStats.total_eligible} checked this pass</span>
                      <span>
                        {sweepStats.total_eligible > 0 
                          ? `~${Math.ceil((sweepStats.total_eligible - sweepStats.checked_this_pass) / sweepForm.batch_size * sweepForm.interval_minutes)} min remaining`
                          : ''}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground space-y-0.5">
                      <p>
                        Full sweep: ~{Math.ceil(sweepStats.total_eligible / sweepForm.batch_size * sweepForm.interval_minutes)} min 
                        ({Math.ceil(sweepStats.total_eligible / sweepForm.batch_size)} batches)
                      </p>
                      <p>
                        SP-API impact: ~{sweepForm.batch_size} calls every {sweepForm.interval_minutes} min 
                        ({Math.round(sweepForm.batch_size / sweepForm.interval_minutes * 10) / 10}/min avg)
                      </p>
                      {sweepStats.passes_completed > 0 && (
                        <p>Completed passes: {sweepStats.passes_completed}</p>
                      )}
                      {sweepStats.last_run_at && (
                        <p>Last run: {new Date(sweepStats.last_run_at).toLocaleString()}</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Stats will populate after the first sweep run.
                  </p>
                )}
              </div>

              {/* Rate impact warning */}
              {sweepForm.batch_size / sweepForm.interval_minutes > 5 && (
                <div className="p-3 border rounded-lg border-yellow-500/50 bg-yellow-500/10">
                  <p className="text-xs text-yellow-700 dark:text-yellow-300">
                    ⚠️ High sweep rate ({Math.round(sweepForm.batch_size / sweepForm.interval_minutes * 10) / 10} calls/min). 
                    This may compete with cron/turbo for SP-API budget. Consider reducing batch size or increasing interval.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        )}

        {/* ═══════════════════════════════════════════ */}
        {/* ⚡ SCALING GROUP                             */}
        {/* ═══════════════════════════════════════════ */}
        {isAdmin && (
          <div className="flex items-center gap-2 pt-4">
            <Badge variant="outline" className="text-xs font-semibold tracking-wide uppercase px-3 py-1">
              ⚡ Scaling
            </Badge>
            <div className="flex-1 border-t border-border" />
          </div>
        )}

        {/* Enable 24/7 Scheduler — admin only */}
        {isAdmin && (
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Enable 24/7 Scheduler</Label>
              <p className="text-sm text-muted-foreground">
                Automatically monitor and reprice assignments on schedule (requires cron setup)
              </p>
            </div>
            <Switch
              checked={formData.scheduler_enabled}
              onCheckedChange={(checked) =>
                setFormData({ ...formData, scheduler_enabled: checked })
              }
            />
          </div>
        )}

        {/* Auto-Apply Prices — admin only */}
        {isAdmin && (
          <>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Auto-Apply Prices</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically update Amazon listing prices when recommendations are generated
                </p>
              </div>
              <Switch
                checked={formData.auto_apply}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, auto_apply: checked })
                }
              />
            </div>

            {formData.auto_apply && (
              <div className="p-3 border rounded-lg border-yellow-500 bg-yellow-500/10">
                <p className="text-sm text-yellow-700 dark:text-yellow-300">
                  ⚠️ Auto-apply is enabled. Price changes will be sent to Amazon automatically.
                </p>
              </div>
            )}
          </>
        )}

        {/* Repricing Mode — Admin only */}
        {isAdmin && (
        <div className="p-4 border rounded-lg bg-muted/30 space-y-4">
          <div className="space-y-1">
            <Label className="text-base flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4" />
              Repricing Mode
            </Label>
            <p className="text-xs text-muted-foreground">
              Auto-detected from your {detectedEligible !== null ? <strong>{detectedEligible}</strong> : '...'} active assignments. 
              Choose the mode that matches your priority.
            </p>
          </div>

          {/* Mode Cards */}
          <div className="grid grid-cols-3 gap-3">
            {([
              {
                key: 'speed' as const,
                icon: '🔥',
                label: 'Speed',
                desc: 'Fastest reaction. Best for arbitrage & Buy Box defense.',
                cycle: calculateOptimizedSettings(Math.max(50, Math.min(500, detectedEligible || 500))),
                asinTarget: Math.max(50, Math.min(500, detectedEligible || 500)),
              },
              {
                key: 'balanced' as const,
                icon: '⚖️',
                label: 'Balanced',
                desc: 'Good speed with moderate API usage.',
                cycle: calculateOptimizedSettings(Math.max(500, Math.min(1500, detectedEligible || 1000))),
                asinTarget: Math.max(500, Math.min(1500, detectedEligible || 1000)),
              },
              {
                key: 'scale' as const,
                icon: '📦',
                label: 'Scale',
                desc: 'For large catalogs (2000+ SKUs). Slower per-ASIN attention.',
                cycle: calculateOptimizedSettings(Math.max(2000, detectedEligible || 4000)),
                asinTarget: Math.max(2000, detectedEligible || 4000),
              },
            ]).map((mode) => {
              const isSelected = repricingMode === mode.key;
              const isRecommended = (
                (mode.key === 'speed' && (detectedEligible || 500) <= 500) ||
                (mode.key === 'balanced' && (detectedEligible || 500) > 500 && (detectedEligible || 500) <= 1500) ||
                (mode.key === 'scale' && (detectedEligible || 500) > 1500)
              );
              return (
                <button
                  key={mode.key}
                  type="button"
                  onClick={() => {
                    setRepricingMode(mode.key);
                    setActiveAsinCount(mode.asinTarget);
                    setShowManualOverride(false);
                  }}
                  className={`relative text-left p-3 rounded-lg border-2 transition-all ${
                    isSelected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border hover:border-primary/40 bg-background'
                  }`}
                >
                  {isRecommended && (
                    <Badge className="absolute -top-2 right-2 text-[9px] px-1.5 py-0 h-4 bg-green-600">
                      Recommended
                    </Badge>
                  )}
                  <div className="text-lg mb-1">{mode.icon}</div>
                  <div className="font-semibold text-sm">{mode.label}</div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{mode.desc}</p>
                  <div className="mt-2 pt-2 border-t text-[10px] text-muted-foreground space-y-0.5">
                    <div>Cycle: <strong className="text-foreground">{mode.cycle.cycleLabel}</strong></div>
                    <div>Checks: <strong className="text-foreground">~{mode.cycle.repricingsPerDay}×/day</strong></div>
                    <div>Batch: <strong className="text-foreground">{mode.cycle.batchSize}</strong></div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Performance summary */}
          <div className="flex items-center gap-3 p-2 rounded-md bg-primary/10 border border-primary/20">
            <Info className="h-4 w-4 text-primary shrink-0" />
            <p className="text-xs">
              Full cycle: <strong>{optimizedSettings.cycleLabel}</strong> · 
              Each SKU repriced <strong>~{optimizedSettings.repricingsPerDay}×/day</strong> · 
              Tuned for <strong>{activeAsinCount.toLocaleString()}</strong> ASINs
            </p>
          </div>

          {isAdmin && (
          /* Advanced: Manual Override */
          <div className="border-t pt-3">
            <button
              type="button"
              onClick={() => setShowManualOverride(!showManualOverride)}
              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Settings className="h-3 w-3" />
              {showManualOverride ? 'Hide' : 'Show'} Advanced Tuning
            </button>

            {showManualOverride && (
              <div className="mt-3 space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">
                    Manual Active ASINs: <span className="text-primary font-bold">{activeAsinCount.toLocaleString()}</span>
                  </Label>
                  <Slider
                    value={[activeAsinCount]}
                    onValueChange={(val) => setActiveAsinCount(val[0])}
                    min={50}
                    max={6000}
                    step={50}
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>50</span>
                    <span>1,000</span>
                    <span>2,000</span>
                    <span>4,000</span>
                    <span>6,000</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> Interval
                    </Label>
                    <Input value={`${optimizedSettings.interval} min`} readOnly className="bg-muted/50 cursor-not-allowed font-mono text-sm h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Zap className="h-3 w-3" /> Batch Size
                    </Label>
                    <Input value={optimizedSettings.batchSize} readOnly className="bg-muted/50 cursor-not-allowed font-mono text-sm h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> TTL
                    </Label>
                    <Input value={`${optimizedSettings.snapshotTtl} min`} readOnly className="bg-muted/50 cursor-not-allowed font-mono text-sm h-8" />
                  </div>
                </div>
              </div>
            )}
          </div>
          )}
        </div>
        )}

        {isAdmin && (
        /* Daily Credit Cap */
        <div className="space-y-2">
          <Label htmlFor="creditCap" className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Daily Credit Cap
          </Label>
          <Input
            id="creditCap"
            type="number"
            min="10"
            max="1000"
            value={formData.daily_credit_cap}
            onChange={(e) =>
              setFormData({
                ...formData,
                daily_credit_cap: parseInt(e.target.value) || 100,
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Maximum Rainforest API calls per day (1 call = 1 credit per ASIN)
          </p>
        </div>
        )}

        {isAdmin && (
        /* Momentum Check Section */
        <div className="border-t pt-4 mt-4">
          <h3 className="font-medium mb-4 flex items-center gap-2">
            ⚡ Today Momentum Check
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            Detects when today's sales drop below your recent average AND the market price dropped. 
            Prevents unnecessary price cuts on normal slow days.
          </p>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <Label>Enable Momentum Check</Label>
                <p className="text-xs text-muted-foreground">
                  Boost aggression when sales AND market price drop together
                </p>
              </div>
              <Switch
                checked={formData.momentum_check_enabled}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, momentum_check_enabled: checked })
                }
              />
            </div>

            {formData.momentum_check_enabled && (
              <div className="space-y-3 p-3 border rounded-lg bg-muted/30">
                <Label className="flex items-center justify-between">
                  <span>Sales Drop Threshold</span>
                  <span className="text-primary font-bold">&lt; {formData.momentum_threshold_pct}% of 7d ADS</span>
                </Label>
                <Slider
                  value={[formData.momentum_threshold_pct]}
                  onValueChange={(val) => setFormData({ ...formData, momentum_threshold_pct: val[0] })}
                  min={10}
                  max={90}
                  step={5}
                  className="w-full"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>10% (very sensitive)</span>
                  <span>50% (default)</span>
                  <span>90% (conservative)</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Triggers when today's units are below this % of your 7-day average daily sales, 
                  <strong> only if</strong> the Buy Box price also dropped vs. the previous snapshot.
                </p>
              </div>
            )}
          </div>
        </div>
        )}

        {/* ═══════════════════════════════════════════ */}
        {/* 🛡️ SAFETY GROUP                              */}
        {/* ═══════════════════════════════════════════ */}
        {isAdmin && (
          <div className="flex items-center gap-2 pt-4">
            <Badge variant="outline" className="text-xs font-semibold tracking-wide uppercase px-3 py-1">
              🛡️ Safety
            </Badge>
            <div className="flex-1 border-t border-border" />
          </div>
        )}

        {/* Safety Settings Section */}
        <div className="pt-4">
          <h3 className="font-medium mb-4 flex items-center gap-2">
            🛡️ Safety Guardrails
          </h3>
          
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="space-y-2">
              <Label htmlFor="absoluteFloor">Absolute Min Price Floor ($)</Label>
              <Input
                id="absoluteFloor"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={formData.absolute_min_price_floor}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    absolute_min_price_floor: parseFloat(e.target.value) || 0.99,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Never set min price below this (even if AI recommends it)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="maxChangePercent">Max Price Change % / Day</Label>
              <Input
                id="maxChangePercent"
                type="number"
                min="5"
                max="100"
                value={formData.max_price_change_percent_per_day}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    max_price_change_percent_per_day: parseInt(e.target.value) || 50,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Skip price changes exceeding this % in one day
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="space-y-2">
              <Label htmlFor="maxMinMaxChanges">Max Min/Max Changes / Day</Label>
              <Input
                id="maxMinMaxChanges"
                type="number"
                min="1"
                max="50"
                value={formData.max_minmax_changes_per_day}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    max_minmax_changes_per_day: parseInt(e.target.value) || 10,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Limit min/max boundary changes per SKU daily
              </p>
            </div>

            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <Label>Require Cost for Min Calc</Label>
                <p className="text-xs text-muted-foreground">
                  Only auto-set min if unit cost is known
                </p>
              </div>
              <Switch
                checked={formData.require_cost_for_min_calc}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, require_cost_for_min_calc: checked })
                }
              />
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════════ */}
        {/* 🔧 SYSTEM GROUP                              */}
        {/* ═══════════════════════════════════════════ */}
        {isAdmin && (
          <div className="flex items-center gap-2 pt-4">
            <Badge variant="outline" className="text-xs font-semibold tracking-wide uppercase px-3 py-1">
              🔧 System
            </Badge>
            <div className="flex-1 border-t border-border" />
          </div>
        )}

        {/* Device Nickname for Change History audit trail */}
        {isAdmin && <DeviceNicknameInput />}

        {/* Parallel Dispatcher Worker Shard — admin only */}
        {isAdmin && (
          <div className="space-y-2 border rounded-lg p-4 bg-muted/30">
            <Label className="text-sm font-medium">Dispatch Worker Shard</Label>
            <p className="text-xs text-muted-foreground">
              Assign this user to a parallel dispatcher worker. Workers A and B run independently to increase throughput.
            </p>
            <Select
              value={(settings as any)?.dispatch_worker_shard || 'A'}
              onValueChange={async (val) => {
                try {
                  await supabase.from("repricer_settings").update({ dispatch_worker_shard: val } as any).eq("user_id", user?.id);
                  toast.success(`Worker shard set to ${val}`);
                  fetchSettings();
                } catch (e: any) {
                  toast.error("Failed: " + e.message);
                }
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="A">Worker A</SelectItem>
                <SelectItem value="B">Worker B</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Save Button */}
        <Button onClick={saveSettings} disabled={saving} className="w-full">
          {saving ? (
            "Saving..."
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Save Settings
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
