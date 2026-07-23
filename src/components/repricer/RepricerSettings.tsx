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
import { Settings, Zap, Clock, DollarSign, Save, RefreshCw, CheckCircle, AlertTriangle, Info, PauseCircle, PlayCircle, SlidersHorizontal, Star, Copy, X, RotateCw } from "lucide-react";
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

interface RepricerSettingsData {
  user_id: string;
  sp_api_check_interval_minutes: number;
  rainforest_snapshot_ttl_minutes: number;
  daily_credit_cap: number;
  credits_used_today: number;
  credits_reset_at: string;
  scheduler_enabled: boolean;
  // Queue state
  queue_paused: boolean;
  queue_pause_reason: string | null;
  queue_auto_resume_at: string | null;
  // Safety settings
  absolute_min_price_floor: number;
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
  const [resumingQueue, setResumingQueue] = useState(false);
  const [activeAsinCount, setActiveAsinCount] = useState(500);
  const [detectedEligible, setDetectedEligible] = useState<number | null>(null);
  const [repricingMode, setRepricingMode] = useState<'speed' | 'balanced' | 'scale'>('speed');
  const [showManualOverride, setShowManualOverride] = useState(false);

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

  const [formData, setFormData] = useState({
    scheduler_enabled: true,
    sp_api_check_interval_minutes: 10,
    rainforest_snapshot_ttl_minutes: 60,
    daily_credit_cap: 100,
    // Safety settings
    absolute_min_price_floor: 5.00,
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
      fetchEligibleCount();
      const refreshInterval = setInterval(() => { fetchSettings(); fetchEligibleCount(); }, 30_000);
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
          scheduler_enabled: data.scheduler_enabled ?? false,
          sp_api_check_interval_minutes: data.sp_api_check_interval_minutes,
          rainforest_snapshot_ttl_minutes: data.rainforest_snapshot_ttl_minutes,
          daily_credit_cap: data.daily_credit_cap,
          // Safety settings
          absolute_min_price_floor: data.absolute_min_price_floor ?? 0.99,
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
          scheduler_enabled: formData.scheduler_enabled,
          sp_api_check_interval_minutes: formData.sp_api_check_interval_minutes,
          rainforest_snapshot_ttl_minutes: formData.rainforest_snapshot_ttl_minutes,
          daily_credit_cap: formData.daily_credit_cap,
          // Safety settings
          absolute_min_price_floor: formData.absolute_min_price_floor,
          // Momentum settings
          momentum_check_enabled: formData.momentum_check_enabled,
          momentum_threshold_pct: formData.momentum_threshold_pct,
          // Auto-turbo settings
          auto_turbo_enabled: autoTurboForm.enabled,
          auto_turbo_duration_minutes: autoTurboForm.duration_minutes,
          auto_turbo_rule_id: autoTurboForm.rule_id || null,
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

  const creditsUsed = settings?.credits_used_today || 0;
  const creditsCap = settings?.daily_credit_cap || 100;
  const creditsRemaining = Math.max(0, creditsCap - creditsUsed);
  const creditsPercent = (creditsUsed / creditsCap) * 100;
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

        {/* Automation Status is now its own tab next to Assignments/Rules/Settings */}

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

        {/* Repricing Mode — Admin only */}
        {isAdmin && (
        <div className="p-4 border rounded-lg bg-muted/30 space-y-4">
          <div className="space-y-1">
            <Label className="text-base flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4" />
              Repricing Mode
            </Label>
            <p className="text-xs text-muted-foreground">
              Automatically selected based on your {detectedEligible !== null ? <strong>{detectedEligible}</strong> : '...'} active assignments.
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
              return (
                <div
                  key={mode.key}
                  className={`relative text-left p-3 rounded-lg border-2 ${
                    isSelected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'border-border bg-background opacity-60'
                  }`}
                >
                  {isSelected && (
                    <Badge className="absolute -top-2 right-2 text-[9px] px-1.5 py-0 h-4 bg-green-600">
                      Active
                    </Badge>
                  )}
                  <div className="text-lg mb-1">{mode.icon}</div>
                  <div className="font-semibold text-sm">{mode.label}</div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{mode.desc}</p>
                  <div className="mt-2 pt-2 border-t text-[10px] text-muted-foreground space-y-0.5">
                    <div>Cycle: <strong className="text-foreground">{mode.cycle.cycleLabel}</strong></div>
                    <div>Checks: <strong className="text-foreground">~{mode.cycle.repricingsPerDay}×/day</strong></div>
                  </div>
                </div>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> Interval
                    </Label>
                    <Input value={`${optimizedSettings.interval} min`} readOnly className="bg-muted/50 cursor-not-allowed font-mono text-sm h-8" />
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
