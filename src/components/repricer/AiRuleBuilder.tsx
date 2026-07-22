import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sparkles, Zap, TrendingUp, Shield, Info, Star, DollarSign, Clock, ArrowUp, Package, Eye, EyeOff, AlertTriangle, Play, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Behavior-by-scenario (when_only_seller, when_buybox_suppressed, etc.) used to
// be user-configurable here, but every existing rule uses the same recommended
// values (CUSTOM_PRICE / AI_REPRICE / MIN_PRICE per scenario — verified across
// all rules) and the dropdowns were already admin-only and disabled, so the
// section was removed. The recommended values are still saved for every rule
// via the hardcoded fallbacks in RuleBuilder.tsx's save logic.

export type SmartProfile = 'VELOCITY_DOMINATOR' | 'MOMENTUM_BUILDER' | 'PROFIT_EXTRACTOR';

// Profiles hidden by default (advanced/high-risk) — unlockable via toggle
const ADVANCED_PROFILES: SmartProfile[] = ['VELOCITY_DOMINATOR'];
const DEFAULT_PROFILES: SmartProfile[] = ['MOMENTUM_BUILDER', 'PROFIT_EXTRACTOR'];

// Behavior metrics per profile for the summary card
const PROFILE_BEHAVIOR: Record<SmartProfile, { salesSpeed: number; marginProtection: number; raiseAggression: number; bbDefense: number; riskLevel: number; tags: string[] }> = {
  VELOCITY_DOMINATOR: { salesSpeed: 5, marginProtection: 1, raiseAggression: 0, bbDefense: 0, riskLevel: 9, tags: ['Clearance', 'Rank building', 'Cash flow'] },
  MOMENTUM_BUILDER: { salesSpeed: 4, marginProtection: 3, raiseAggression: 3, bbDefense: 3, riskLevel: 4, tags: ['OA / Arbitrage', 'Competitive wholesale', 'Growth phase'] },
  PROFIT_EXTRACTOR: { salesSpeed: 2, marginProtection: 5, raiseAggression: 5, bbDefense: 3, riskLevel: 8, tags: ['Private label', 'Low competition', 'Ceiling discovery'] },
};

export const SMART_PROFILES: { value: SmartProfile; label: string; description: string; bestFor: string; salesStars: number; profitStars: number; icon: string; recommended?: boolean; advanced?: boolean; badge?: string; badgeColor?: string; microLabel?: string; keyDiff?: string; legacy?: boolean; safetyScore?: number; salesImpactLabel?: string; salesImpactDesc?: string; salesImpactLevel?: 'strong' | 'balanced' | 'lower' | 'clearance' }[] = [
  { value: 'VELOCITY_DOMINATOR', label: 'Aggressive Capture', description: 'Win more often with lower profit per sale.', bestFor: 'Heavy competition & fast-moving items', salesStars: 5, profitStars: 1, icon: '🚀', safetyScore: 3, salesImpactLabel: 'Strong Sales', salesImpactDesc: 'Wins the Buy Box often, but may reduce profit', salesImpactLevel: 'strong', microLabel: 'Get more sales fast' },
  { value: 'MOMENTUM_BUILDER', label: 'Momentum Builder', description: 'Stay competitive while protecting your margins.', bestFor: 'Arbitrage, wholesale, most products', salesStars: 4, profitStars: 2, icon: '📈', recommended: true, safetyScore: 7, salesImpactLabel: 'Strong Sales', salesImpactDesc: 'Wins the Buy Box often while keeping strong sales volume', salesImpactLevel: 'strong', microLabel: 'Best balance of sales and profit' },
  { value: 'PROFIT_EXTRACTOR', label: 'Profit Extractor', description: 'Raises prices to capture more profit, but may reduce sales.', bestFor: 'Private label & exclusive products', salesStars: 1, profitStars: 5, icon: '🏆', safetyScore: 7, salesImpactLabel: 'Lower Sales', salesImpactDesc: 'May lose Buy Box and reduce sales if prices increase', salesImpactLevel: 'lower', microLabel: 'Maximize profit when competition is low' },
];

// Profile key → UI label mapping (canonical source of truth)
export const PROFILE_KEY_TO_LABEL: Record<string, string> = {
  VELOCITY_DOMINATOR: 'Aggressive Capture',
  MOMENTUM_BUILDER: 'Momentum Builder',
  PROFIT_EXTRACTOR: 'Profit Extractor',
};

// Profile preset configurations - these override specific settings
export const PROFILE_PRESETS: Record<SmartProfile, Partial<AiRuleSettings>> = {
  VELOCITY_DOMINATOR: {
    undercut_amount: 0.02,
    enable_smart_raise: true,        // ← Was false. Limited raise to recover margin after winning.
    enable_monopoly_mode: false,
    monopoly_mode_type: 'aggressive',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 5,
    skip_lower_when_bb_owner: false,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    raise_trigger_percent: 3,        // ← Modest raise trigger (was never used before)
    max_raise_step_dollars: 0.30,    // ← Small raise caps to keep it aggressive-first
    max_raise_step_percent: 2,
    // Aggressive Capture is the "compete on price" profile — Strict Match
    // (exact-match-anchor, no undercut) would defeat the point of it, so
    // this is the one profile that turns it OFF.
    strict_match_mode: false,
  },
  MOMENTUM_BUILDER: {
    undercut_amount: 0.01,
    enable_smart_raise: true,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 1.00,
    max_raise_step_percent: 5,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 15,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    strict_match_mode: true,
  },
  PROFIT_EXTRACTOR: {
    undercut_amount: 0.00,
    enable_smart_raise: true,
    raise_trigger_percent: 1,
    max_raise_step_dollars: 1.50,
    max_raise_step_percent: 6,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'aggressive',
    monopoly_cooldown_minutes: 45,
    use_ai_tuning: true,
    cooldown_minutes: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: false,
    strict_match_mode: true,
  },
};

export interface AiRuleSettings {
  // Smart Engine Profile
  smart_profile: SmartProfile;
  // Scenario behaviors
  when_only_seller: string;
  when_not_buybox_eligible: string;
  when_buybox_suppressed: string;
  when_condition_used: string;
  when_backordered: string;
  when_below_min_price: string;
  // Competition settings
  compete_with_amazon: boolean;
  compete_with_fba: boolean;
  compete_with_fbm: boolean;
  fulfillment_filter: "FBA" | "FBM" | "BOTH"; // New dropdown field
  // Price limits
  min_price: number | null;
  max_price: number | null;
  undercut_amount: number;
  fbm_undercut_amount?: number | null;
  suppressed_bb_undercut: number | null;
  undercut_mode: 'managed' | 'custom';
  // Strict Match Mode — force exact match with anchor; bypass all undercut overrides
  strict_match_mode?: boolean;
  // Safety guards
  max_step_amount: number;
  max_step_percent: number;
  cooldown_minutes: number;
  // AI tuning
  use_ai_tuning: boolean;
  // Profit Guard settings
  enable_profit_guard: boolean;
  min_profit_dollars: number | null;
  min_roi_percent: number | null;
  min_roi_percent_base: number | null;
  min_roi_percent_high_risk: number | null;
  high_risk_seller_count_threshold: number;
  enable_dynamic_roi: boolean;
  include_fees_in_floor: boolean;
  block_auto_apply_if_cost_missing: boolean;
  profit_guard_mode: 'strict' | 'respect_min_max' | 'off';
  // Auto-Exit/Reenter settings
  enable_auto_exit_reenter: boolean;
  reenter_buffer_percent: number;
  cooldown_minutes_on_floor: number;
  max_drop_per_run_cents: number;
  // Snapshot TTL (cost control)
  snapshot_ttl_minutes: number;
  // Smart Raise settings
  enable_smart_raise: boolean;
  raise_trigger_percent: number;
  max_raise_step_dollars: number;
  max_raise_step_percent: number;
  only_raise_when_buybox_owner: boolean;
  // Buy Box Owner Protection
  skip_lower_when_bb_owner: boolean;
  // Monopoly Mode - proactive price raising when only FBA
  enable_monopoly_mode: boolean;
  monopoly_raise_step_dollars: number;
  monopoly_raise_step_percent: number;
  monopoly_cooldown_minutes: number;
  monopoly_mode_type: 'conservative' | 'aggressive';
  // FBM Handling
  ignore_fbm_unless_buybox_owner: boolean;
  fbm_competition_mode?: 'fba_priority' | 'all_sellers' | 'lowest_seller';
  // Target Price Anchor
  target_anchor: 'buybox' | 'lowest_fba' | 'lowest_offer' | 'smart' | 'smart_recapture';
  // Competitor Quality Filtering (NEW - beats BQool)
  min_seller_rating: number;
  max_handling_days: number;
  ships_from_filter: 'US_ONLY' | 'DOMESTIC' | 'ANY';
  top_n_competitors: number;
  competitor_quality_preset: 'conservative' | 'balanced' | 'aggressive' | 'custom';
  // Stock-Aware Aggression Overlay
  stock_overlay_enabled: boolean;
  velocity_weight_7d: number;
  velocity_weight_30d: number;
  stock_threshold_critical: number;
  stock_threshold_low: number;
  stock_threshold_healthy_max: number;
  stock_threshold_heavy: number;
  stock_modifier_critical: number;
  stock_modifier_low: number;
  stock_modifier_normal: number;
  stock_modifier_heavy: number;
  stock_modifier_overstock: number;
  // Oscillation Handling
  oscillation_mode: 'auto' | 'safe' | 'balanced' | 'aggressive';
  oscillation_ai_style?: 'conservative' | 'balanced' | 'aggressive';
  oscillation_cooldown_minutes: number;
  oscillation_max_reactions: number;
  oscillation_bb_loss_limit: number;
  // Auto Floor (per-rule)
  enable_auto_floor: boolean;
  // Price War Protection — delay auto-floor activation
  war_protection_minutes: number;
  // Min ROI Protection — optional user-facing ROI floor.
  // min_roi_enabled is the legacy global on/off switch, kept only as a
  // fallback for marketplaces that don't yet have their own entry in
  // min_roi_enabled_marketplace_overrides (per-marketplace on/off).
  min_roi_enabled: boolean;
  min_roi_enabled_marketplace_overrides: Record<string, boolean>;
  min_roi_marketplace_overrides: Record<string, number>;
  // Strategy Engine — Dynamic Floor Relaxation (Milestone B). Default OFF.
  enable_dynamic_floor_relaxation?: boolean;
}

interface AiRuleBuilderProps {
  settings: AiRuleSettings;
  onChange: (settings: AiRuleSettings) => void;
  hideProfileSelector?: boolean;
  ruleId?: string | null;
}

export const defaultAiRuleSettings: AiRuleSettings = {
  smart_profile: 'MOMENTUM_BUILDER',
  when_only_seller: "CUSTOM_PRICE",
  when_not_buybox_eligible: "CUSTOM_PRICE",
  when_buybox_suppressed: "AI_REPRICE",
  when_condition_used: "AI_REPRICE",
  when_backordered: "MIN_PRICE",
  when_below_min_price: "MIN_PRICE",
  compete_with_amazon: false,
  compete_with_fba: true,
  compete_with_fbm: false,
  fulfillment_filter: "FBA", // Default to FBA
  min_price: null,
  max_price: null,
  undercut_amount: 0.01,
  fbm_undercut_amount: null,
  suppressed_bb_undercut: null,
  undercut_mode: 'managed',
  // ON by default — most users shouldn't need to reason about this directly.
  // Aggressive Capture (VELOCITY_DOMINATOR) is the one profile that turns it off.
  strict_match_mode: true,
  max_step_amount: 0.50,
  max_step_percent: 5,
  cooldown_minutes: 15,
  use_ai_tuning: true,
  // Profit Guard defaults — always enabled, Respect Min/Max
  enable_profit_guard: true,
  min_profit_dollars: null,
  min_roi_percent: null,
  min_roi_percent_base: 20,
  min_roi_percent_high_risk: 35,
  high_risk_seller_count_threshold: 8,
  enable_dynamic_roi: false,
  include_fees_in_floor: true,
  block_auto_apply_if_cost_missing: true,
  profit_guard_mode: 'respect_min_max',
  // Auto-Exit/Reenter defaults — OFF (tied to Profit Guard)
  enable_auto_exit_reenter: false,
  reenter_buffer_percent: 2,
  cooldown_minutes_on_floor: 360, // 6 hours
  max_drop_per_run_cents: 30, // $0.30
  // Snapshot TTL default (6 hours = 360 min)
  snapshot_ttl_minutes: 360,
  // Smart Raise defaults
  enable_smart_raise: true,
  raise_trigger_percent: 2,
  max_raise_step_dollars: 0.25,
  max_raise_step_percent: 2,
  only_raise_when_buybox_owner: true,
  // Buy Box Owner Protection - ON by default to preserve margin
  skip_lower_when_bb_owner: true,
  // Monopoly Mode - proactive price raising when only FBA
  enable_monopoly_mode: true, // ON by default - profit-seeking automation
  monopoly_raise_step_dollars: 0.10,
  monopoly_raise_step_percent: 1,
  monopoly_cooldown_minutes: 60, // 1 hour between raises
  monopoly_mode_type: 'conservative', // Start conservative
  // FBM Handling - compete with all sellers (aggressive mode by default)
  ignore_fbm_unless_buybox_owner: false, // All Sellers (Aggressive) is default
  fbm_competition_mode: 'all_sellers',
  // Target Price Anchor
  target_anchor: 'smart_recapture' as const, // Smart + Lowest FBA Recapture by default
  // Competitor Quality Filtering - clean inputs, eliminate noise (beats BQool)
  min_seller_rating: 80, // Ignore sellers with <80% rating
  max_handling_days: 2, // Ignore slow shippers (>2 days)
  ships_from_filter: 'ANY', // US_ONLY, DOMESTIC, or ANY
  top_n_competitors: 8, // Only consider top 8 competitors (like BQool)
  competitor_quality_preset: 'balanced',
  // Stock-Aware Aggression Overlay — OFF by default
  stock_overlay_enabled: true,
  velocity_weight_7d: 0.6,
  velocity_weight_30d: 0.4,
  stock_threshold_critical: 7,
  stock_threshold_low: 30,
  stock_threshold_healthy_max: 90,
  stock_threshold_heavy: 180,
  stock_modifier_critical: 0.75,
  stock_modifier_low: 0.85,
  stock_modifier_normal: 1.0,
  stock_modifier_heavy: 1.10,
  stock_modifier_overstock: 1.30,
  // Oscillation Handling — Auto (AI) by default
  oscillation_mode: 'auto',
  oscillation_ai_style: 'balanced',
  oscillation_cooldown_minutes: 20,
  oscillation_max_reactions: 0,
  oscillation_bb_loss_limit: 1,
  // Auto Floor — ON by default
  enable_auto_floor: true,
  // Price War Protection — 30 min delay by default
  war_protection_minutes: 30,
  // Min ROI Protection — OFF by default
  min_roi_enabled: false,
  min_roi_enabled_marketplace_overrides: {},
  min_roi_marketplace_overrides: {},
};

export default function AiRuleBuilder({ settings, onChange, hideProfileSelector, ruleId }: AiRuleBuilderProps) {
  const [advancedMode, setAdvancedMode] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [connectedMarketplaces, setConnectedMarketplaces] = useState<string[]>(["US"]);
  const [applyingMarketplace, setApplyingMarketplace] = useState<string | null>(null);
  const [showAdvancedStrategies, setShowAdvancedStrategies] = useState(() => {
    try { return localStorage.getItem('repricer_advanced_strategies') === 'true'; } catch { return false; }
  });
  const [showAdvancedWarning, setShowAdvancedWarning] = useState(false);
  // Whether the FBM-specific undercut override is expanded. Derived from
  // whether this rule already has one set, so existing overrides stay
  // visible; defaults collapsed for everyone else since leaving it blank
  // (reusing the shared Undercut Amount) is the common case.
  const [showFbmOverride, setShowFbmOverride] = useState(() => settings.fbm_undercut_amount != null);
  useEffect(() => {
    setShowFbmOverride(settings.fbm_undercut_amount != null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      // Fetch admin role and connected marketplaces in parallel
      const [roleRes, authRes] = await Promise.all([
        supabase.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle(),
        supabase.from('seller_authorizations').select('marketplace_id').eq('user_id', user.id),
      ]);
      if (cancelled) return;
      setIsAdmin(!!roleRes.data);
      if (authRes.data && authRes.data.length > 0) {
        const { getMarketplaceFromId, NA_MARKETPLACES } = await import("@/lib/marketplaceCurrency");
        const directCodes = [...new Set(authRes.data.map((d: any) => getMarketplaceFromId(d.marketplace_id)))];
        const hasNA = directCodes.some(c => NA_MARKETPLACES.includes(c));
        const expanded = hasNA ? [...new Set([...directCodes, ...NA_MARKETPLACES])] : directCodes;
        const ordered = ["US", "CA", "MX", "BR"].filter(mp => expanded.includes(mp));
        if (!cancelled) setConnectedMarketplaces(ordered.length > 0 ? ordered : ["US"]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleApplyMinRoi = useCallback(async (marketplace: string) => {
    if (!ruleId) {
      toast.error("Save the rule first before applying ROI");
      return;
    }
    const roiValue = settings.min_roi_marketplace_overrides?.[marketplace];
    if (roiValue == null) {
      toast.error(`Set a ROI % for ${marketplace} first`);
      return;
    }
    setApplyingMarketplace(marketplace);
    try {
      const { data, error } = await supabase.functions.invoke('apply-min-roi', {
        body: { rule_id: ruleId, marketplace, min_roi_percent: roiValue },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const protectedCount = (data.results || []).filter((r: any) => r.reason === 'manual_floor_protected').length;
      const skipMsg = data.skipped > 0 ? `, ${data.skipped} skipped` : '';
      const protectMsg = protectedCount > 0 ? ` (${protectedCount} kept manual min)` : '';
      toast.success(`${marketplace}: Updated ${data.updated} assignments${skipMsg}${protectMsg}`);
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setApplyingMarketplace(null);
    }
  }, [ruleId, settings.min_roi_marketplace_overrides]);

  const updateSetting = <K extends keyof AiRuleSettings>(
    key: K,
    value: AiRuleSettings[K]
  ) => {
    onChange({ ...settings, [key]: value });
  };

  // "Respect minimum ROI" is now toggled per marketplace. A marketplace with
  // no explicit entry yet falls back to the legacy global min_roi_enabled,
  // so existing rules keep working exactly as before until touched here.
  const isRoiEnabledForMarketplace = (mp: string): boolean => {
    const overrides = settings.min_roi_enabled_marketplace_overrides || {};
    if (Object.prototype.hasOwnProperty.call(overrides, mp)) return overrides[mp];
    return settings.min_roi_enabled ?? false;
  };

  const setRoiEnabledForMarketplace = (mp: string, enabled: boolean) => {
    const overrides = { ...(settings.min_roi_enabled_marketplace_overrides || {}), [mp]: enabled };
    onChange({ ...settings, min_roi_enabled_marketplace_overrides: overrides });
  };

  const handleProfileChange = (profileValue: SmartProfile) => {
    const preset = PROFILE_PRESETS[profileValue];
    onChange({ ...settings, ...preset, smart_profile: profileValue });
  };

  const handleToggleAdvancedStrategies = (enabled: boolean) => {
    if (enabled) {
      setShowAdvancedWarning(true);
    } else {
      setShowAdvancedStrategies(false);
      localStorage.setItem('repricer_advanced_strategies', 'false');
      // If current profile is advanced, switch to Momentum Builder
      if (ADVANCED_PROFILES.includes(settings.smart_profile)) {
        handleProfileChange('MOMENTUM_BUILDER');
      }
    }
  };

  const confirmAdvancedStrategies = () => {
    setShowAdvancedStrategies(true);
    localStorage.setItem('repricer_advanced_strategies', 'true');
    setShowAdvancedWarning(false);
  };

  // Filter visible profiles: show default + advanced if enabled + always show current if it's advanced (legacy)
  const visibleProfiles = SMART_PROFILES.filter(p => {
    // Never show legacy profiles in the selector (they are deprecated)
    if (p.legacy) {
      // Exception: show if currently selected (existing rule)
      return settings.smart_profile === p.value;
    }
    if (DEFAULT_PROFILES.includes(p.value)) return true;
    if (showAdvancedStrategies) return true;
    // Legacy: show if currently selected (existing rule)
    if (settings.smart_profile === p.value) return true;
    return false;
  });

  const isLegacyProfile = ADVANCED_PROFILES.includes(settings.smart_profile) && !showAdvancedStrategies;

  const activeProfile = SMART_PROFILES.find(p => p.value === settings.smart_profile) || SMART_PROFILES.find(p => p.value === 'MOMENTUM_BUILDER')!;

  return (
    <div className="space-y-6">
      {/* Advanced Mode Toggle — admin only */}
      {!hideProfileSelector && isAdmin && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdvancedMode(!advancedMode)}
            className="text-xs text-muted-foreground hover:text-foreground gap-1.5"
          >
            {advancedMode ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {advancedMode ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
          </Button>
        </div>
      )}
      {/* Advanced Strategies Warning Dialog */}
      {!hideProfileSelector && showAdvancedWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <h3 className="font-semibold text-lg">Enable Advanced Strategies?</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              You are enabling advanced strategies that can increase risk (price wars, margin loss). These profiles are designed for experienced users who understand the trade-offs.
            </p>
            <ul className="text-sm text-muted-foreground mb-4 space-y-1">
              <li className="flex items-center gap-2">🚀 <strong>Aggressive Capture</strong> — No raises, no BB protection, fast margin erosion</li>
              <li className="flex items-center gap-2">💰 <strong>Margin Protection</strong> — Very slow reactions, may lose BB in fast markets</li>
            </ul>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowAdvancedWarning(false)}>Cancel</Button>
              <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white" onClick={confirmAdvancedStrategies}>Enable Advanced</Button>
            </div>
          </div>
        </div>
      )}



      {advancedMode && !hideProfileSelector && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" />
              {activeProfile.icon} {activeProfile.label} — Preset Settings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const preset = PROFILE_PRESETS[settings.smart_profile];
              if (!preset) return null;
              const rows: { label: string; value: string }[] = [
                { label: 'Undercut', value: settings.undercut_mode === 'managed' ? '🤖 Managed' : `$${(preset.undercut_amount ?? 0.01).toFixed(2)}` },
                { label: 'Compete With', value: (preset.fulfillment_filter ?? settings.fulfillment_filter ?? 'FBA') === 'BOTH' ? 'FBA + FBM' : (preset.fulfillment_filter ?? settings.fulfillment_filter ?? 'FBA') },
                { label: 'Ignore FBM unless BB owner', value: preset.ignore_fbm_unless_buybox_owner !== undefined ? (preset.ignore_fbm_unless_buybox_owner ? 'Yes' : 'No') : (settings.ignore_fbm_unless_buybox_owner ? 'Yes' : 'No') },
                { label: 'Smart Raise', value: preset.enable_smart_raise ? `ON (trigger ${preset.raise_trigger_percent ?? settings.raise_trigger_percent}%)` : 'OFF' },
                { label: 'Max Raise Step', value: `$${(preset.max_raise_step_dollars ?? settings.max_raise_step_dollars).toFixed(2)} / ${preset.max_raise_step_percent ?? settings.max_raise_step_percent}%` },
                { label: 'Only Raise when BB Owner', value: (preset.only_raise_when_buybox_owner ?? settings.only_raise_when_buybox_owner) ? 'Yes' : 'No' },
                { label: 'Skip Lower when BB Owner', value: (preset.skip_lower_when_bb_owner ?? settings.skip_lower_when_bb_owner) ? 'Yes' : 'No' },
                { label: 'Monopoly Mode', value: preset.enable_monopoly_mode ? `ON — ${preset.monopoly_mode_type ?? 'conservative'}` : 'OFF' },
                { label: 'Monopoly Cooldown', value: `${preset.monopoly_cooldown_minutes ?? settings.monopoly_cooldown_minutes} min` },
                { label: 'Cooldown', value: `${preset.cooldown_minutes ?? settings.cooldown_minutes} min` },
                { label: 'Stock Overlay', value: (preset.stock_overlay_enabled ?? settings.stock_overlay_enabled) ? 'ON' : 'OFF' },
              ];
              return (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
                  {rows.map((r) => (
                    <div key={r.label} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span className="font-medium text-foreground">{r.value}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Dynamic Rule Header based on profile */}
      {!hideProfileSelector && (
      <div className="flex items-center gap-3 p-4 bg-gradient-to-r from-purple-500/10 to-blue-500/10 rounded-lg border border-purple-500/20">
        <div className="p-2 bg-purple-500/20 rounded-lg">
          <span className="text-xl">{activeProfile.icon}</span>
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            Smart Engine: {activeProfile.label}
          </h3>
          <p className="text-sm text-muted-foreground">
            {activeProfile.description}
          </p>
        </div>
        {activeProfile.salesStars > 0 && (
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-1">
              <TrendingUp className="h-4 w-4 text-green-500" />
              <span>Sales</span>
              <div className="flex">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className={`h-3 w-3 ${i < activeProfile.salesStars ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Shield className="h-4 w-4 text-blue-500" />
              <span>Profit</span>
              <div className="flex">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className={`h-3 w-3 ${i < activeProfile.profitStars ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Profile Risk Warnings */}
      {settings.smart_profile === 'VELOCITY_DOMINATOR' && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-orange-500/30 bg-orange-500/5 text-sm">
          <AlertTriangle className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-medium text-orange-600">Margin Erosion Warning:</span>{' '}
            <span className="text-muted-foreground">This profile aggressively lowers prices with no raise mechanism. Prices will trend toward your floor. Best for short-term clearance — not recommended as a permanent strategy.</span>
          </div>
        </div>
      )}
      {settings.smart_profile === 'PROFIT_EXTRACTOR' && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-medium text-amber-600">Competitive Listing Warning:</span>{' '}
            <span className="text-muted-foreground">This profile aggressively raises prices and never undercuts. Only use on listings you control (PL, low-competition). On competitive listings, you risk losing Buy Box permanently.</span>
          </div>
        </div>
      )}

      {/* Competition & FBM Settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-500" />
            Competition
          </CardTitle>
          <CardDescription>
            Select which seller types to compete against and how to handle FBM sellers
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Buy Box Winners to Compete Against */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Buy Box Winners to Compete Against</Label>
            <div className="flex flex-wrap gap-6 items-center">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="compete-amazon"
                  checked={settings.compete_with_amazon}
                  onCheckedChange={(checked) =>
                    updateSetting("compete_with_amazon", checked === true)
                  }
                />
                <Label htmlFor="compete-amazon" className="flex items-center gap-2 cursor-pointer">
                  <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-500/20">
                    Amazon
                  </Badge>
                </Label>
              </div>
              
               {/* Compete With Dropdown */}
               <div className="flex items-center gap-2">
                <Label className="text-sm text-muted-foreground">Compete with:</Label>
                <Badge variant="outline" className={`text-xs ${
                  (settings.fulfillment_filter || "FBA") === "BOTH" 
                    ? "bg-purple-500/10 text-purple-600 border-purple-500/20" 
                    : "bg-blue-500/10 text-blue-600 border-blue-500/20"
                }`}>
                  {(settings.fulfillment_filter || "FBA") === "BOTH" ? "FBA + FBM" : "FBA"}
                </Badge>
               </div>
             </div>
           </div>

          <div className="border-t border-border" />

          {/* FBM Handling Strategy */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">FBM Competition Mode</Label>
            <Select
              value={
                (settings as any).fbm_competition_mode
                  ?? (settings.ignore_fbm_unless_buybox_owner ? "fba_priority" : "all_sellers")
              }
              onValueChange={(v) => {
                const mode = v as 'fba_priority' | 'all_sellers' | 'lowest_seller';
                const isFbaPriority = mode === 'fba_priority';
                onChange({
                  ...settings,
                  fbm_competition_mode: mode,
                  // Keep legacy boolean in sync as a fallback for older code paths
                  ignore_fbm_unless_buybox_owner: isFbaPriority,
                  compete_with_fba: true,
                  compete_with_fbm: !isFbaPriority,
                  fulfillment_filter: isFbaPriority ? "FBA" : "BOTH",
                } as any);
              }}
              disabled
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fba_priority">
                  🛡️ FBA Priority — Ignore FBM Unless They Own Buy Box
                </SelectItem>
                <SelectItem value="all_sellers">
                  ⚡ All Sellers (Aggressive) — Treat FBM Same as FBA
                </SelectItem>
                <SelectItem value="lowest_seller">
                  🥊 Lowest Seller — Always chase the cheapest seller (no BB requirement)
                </SelectItem>
              </SelectContent>
            </Select>
            <div className="p-3 border rounded-lg border-blue-500/30 bg-blue-500/5">
              {(settings as any).fbm_competition_mode === 'lowest_seller' ? (
                <p className="text-xs text-muted-foreground">
                  🥊 <strong>Lowest Seller:</strong> For an FBM listing, always anchor to the lowest external FBM seller (even if they don't own the Buy Box) and undercut using <strong>FBM Undercut</strong>. While a lower FBM seller exists, the engine will not smart-raise, will not run eligible-gap recovery, and will not fall back to the FBA Buy Box.
                </p>
              ) : settings.ignore_fbm_unless_buybox_owner ? (
                <p className="text-xs text-muted-foreground">
                  💡 <strong>FBA Priority:</strong> Amazon rarely gives Buy Box to FBM just for having a lower price.
                  FBM must have significantly better metrics + shipping to win. You won't get dragged
                  into a price war with FBM sellers who can't actually take the Buy Box from you.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  ⚡ <strong>All Sellers:</strong> FBM sellers are treated as real competitors — same as FBA.
                  The engine will undercut FBM prices using the same logic. Use this when you want maximum
                  sales velocity or when FBM sellers are winning Buy Box in your category.
                  Min price, profit guard, and max step still apply.
                </p>
              )}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* FBA wants to compete with FBM */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">FBA Seller: Compete Against FBM</Label>
            <div className="flex items-start gap-3 p-3 border rounded-lg border-blue-500/30 bg-blue-500/5">
              <Checkbox
                id="fba-compete-with-fbm"
                checked={
                  ((settings as any).fbm_competition_mode
                    ?? (settings.ignore_fbm_unless_buybox_owner ? "fba_priority" : "all_sellers")) !== "fba_priority"
                }
                onCheckedChange={(checked) => {
                  const wantsFbm = checked === true;
                  const mode: 'fba_priority' | 'all_sellers' = wantsFbm ? 'all_sellers' : 'fba_priority';
                  onChange({
                    ...settings,
                    fbm_competition_mode: mode,
                    ignore_fbm_unless_buybox_owner: !wantsFbm,
                    compete_with_fba: true,
                    compete_with_fbm: wantsFbm,
                    fulfillment_filter: wantsFbm ? "BOTH" : "FBA",
                  } as any);
                }}
              />
              <Label htmlFor="fba-compete-with-fbm" className="cursor-pointer text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Yes — as an FBA seller, compete with FBM too.</span>
                <br />
                Enabling this treats FBM offers as real competitors and mirrors <strong>All Sellers (Aggressive)</strong> mode above.
                Leave off to keep <strong>FBA Priority</strong> — ignoring FBM unless they own the Buy Box.
              </Label>
            </div>
          </div>

          <div className="border-t border-border" />

          {/* FBM seller competes against all */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">FBM Seller: Compete Against All</Label>
            <div className="flex items-start gap-3 p-3 border rounded-lg border-blue-500/30 bg-blue-500/5">
              <Checkbox
                id="fbm-compete-against-all"
                checked={
                  ((settings as any).fbm_competition_mode
                    ?? (settings.ignore_fbm_unless_buybox_owner ? "fba_priority" : "all_sellers")) === "all_sellers"
                }
                onCheckedChange={(checked) => {
                  const wantsAll = checked === true;
                  const mode: 'all_sellers' | 'lowest_seller' = wantsAll ? 'all_sellers' : 'lowest_seller';
                  onChange({
                    ...settings,
                    fbm_competition_mode: mode,
                    ignore_fbm_unless_buybox_owner: false,
                    compete_with_fba: true,
                    compete_with_fbm: true,
                    fulfillment_filter: "BOTH",
                    fbm_competes_against_all: wantsAll,
                  } as any);
                }}
              />
              <Label htmlFor="fbm-compete-against-all" className="cursor-pointer text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Yes — as an FBM seller, compete against all sellers (FBA + FBM).</span>
                <br />
                Enabling this treats every FBA and FBM offer as a real competitor for your FBM listings.
                Leave off to only compete against other FBM sellers.
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Undercut — Managed vs Custom for all profiles */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Undercut</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Undercut Mode</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={settings.undercut_mode === 'managed' ? 'default' : 'outline'}
                  onClick={() => updateSetting('undercut_mode', 'managed')}
                  className="gap-1.5"
                >
                  🤖 Managed
                  {settings.undercut_mode === 'managed' && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-1">Recommended</Badge>
                  )}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={settings.undercut_mode === 'custom' ? 'default' : 'outline'}
                  onClick={() => updateSetting('undercut_mode', 'custom')}
                  className="gap-1.5"
                >
                  ✏️ Custom
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-1 opacity-60">Advanced</Badge>
                </Button>
              </div>

              {/* Strict Match Mode toggle — forces exact match with anchor, blocks all undercut overrides.
                  ON by default for every profile except Aggressive Capture; hidden from the regular
                  rule-creation flow behind Advanced Settings since most users shouldn't need to reason
                  about it directly. */}
              {advancedMode && (
                <div className="flex items-start justify-between gap-4 p-3 rounded-lg border border-border/60 bg-muted/20">
                  <div className="space-y-1">
                    <Label htmlFor="strict-match-mode" className="text-sm font-semibold flex items-center gap-2">
                      🔒 Strict Match Mode
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">Match anchor exactly</Badge>
                    </Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      When ON, the engine matches the anchor price <span className="font-semibold">exactly</span> and disables ALL undercut multipliers, AI win-sales boosters, enhanced tuning, suppressed-BB minimum-undercut overrides, and oscillation undercuts. Corrective raises back to the anchor bypass cooldown.
                    </p>
                  </div>
                  <Switch
                    id="strict-match-mode"
                    checked={settings.strict_match_mode === true}
                    onCheckedChange={(checked) => updateSetting('strict_match_mode' as any, checked)}
                  />
                </div>
              )}

              {settings.undercut_mode === 'managed' ? (
                <p className="text-xs text-muted-foreground">
                  Engine automatically adjusts undercut based on competition, oscillation level, and market pressure
                </p>
              ) : (
                <div className="space-y-3 mt-2">
                  <div className="space-y-2">
                    <Label htmlFor="undercut">Undercut Amount ($)</Label>
                    <p className="text-xs text-muted-foreground">
                      Used for FBA listings, and for FBM listings too unless you set a different amount below.
                    </p>
                    <Input
                      id="undercut"
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={settings.undercut_amount}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        updateSetting("undercut_amount", isNaN(v) ? 0 : v);
                      }}
                      className={settings.undercut_amount > 0.05 ? "border-yellow-500/50" : settings.undercut_amount > 0.10 ? "border-red-500/50" : ""}
                    />
                    {settings.undercut_amount > 0.10 && (
                      <p className="text-xs text-red-400 flex items-center gap-1">
                        ⚠️ High undercut — significant risk of price wars and margin erosion
                      </p>
                    )}
                    {settings.undercut_amount > 0.05 && settings.undercut_amount <= 0.10 && (
                      <p className="text-xs text-yellow-400 flex items-center gap-1">
                        ⚠️ Aggressive undercut — monitor margins closely
                      </p>
                    )}
                  </div>

                  {/* "Set a different amount for FBM listings" only makes sense when FBM
                      competition is actually turned on somewhere (FBA Seller: Compete Against
                      FBM, or FBM Seller: Compete Against All) — if both are off, FBM offers
                      aren't being competed against at all, so an FBM-specific undercut has
                      nothing to apply to. */}
                  {((settings as any).fbm_competition_mode
                    ?? (settings.ignore_fbm_unless_buybox_owner ? "fba_priority" : "all_sellers")) !== "fba_priority" && (
                    <>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="fbm-undercut-toggle"
                          checked={showFbmOverride}
                          onCheckedChange={(checked) => {
                            const wantsOverride = checked === true;
                            setShowFbmOverride(wantsOverride);
                            if (!wantsOverride) {
                              updateSetting("fbm_undercut_amount" as any, null as any);
                            }
                          }}
                        />
                        <Label htmlFor="fbm-undercut-toggle" className="text-xs font-normal text-muted-foreground cursor-pointer">
                          Set a different amount for FBM listings
                        </Label>
                      </div>

                      {showFbmOverride && (
                        <div className="space-y-2">
                          <Label htmlFor="fbm-undercut">FBM Undercut Amount ($)</Label>
                          <p className="text-xs text-muted-foreground">
                            Applied only when your listing is <strong>FBM</strong> and competing against the lowest FBM seller. Enter <code>0.00</code> to match exactly.
                          </p>
                          <Input
                            id="fbm-undercut"
                            type="number"
                            step="0.01"
                            min="0"
                            max="1"
                            value={settings.fbm_undercut_amount == null ? "" : settings.fbm_undercut_amount}
                            onChange={(e) => {
                              if (e.target.value === "") {
                                updateSetting("fbm_undercut_amount" as any, null as any);
                                return;
                              }
                              const v = parseFloat(e.target.value);
                              updateSetting("fbm_undercut_amount" as any, (isNaN(v) ? null : Math.max(0, v)) as any);
                            }}
                          />
                        </div>
                      )}
                    </>
                  )}

                </div>
              )}

              {/* Suppressed Buy Box Undercut — ALWAYS visible (managed or custom) */}
              <div className="space-y-2 mt-4 p-4 rounded-lg border-2 border-blue-500/40 bg-blue-950/30">
                <Label htmlFor="suppressed-bb-undercut-main" className="text-sm font-bold flex items-center gap-2">
                  🚫 Suppressed Buy Box Undercut ($) <span className="text-xs font-normal text-amber-400">— required</span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  When the Amazon Buy Box is <strong>suppressed</strong> (no Featured Offer), undercut the lowest valid competitor by this amount. <strong>You decide</strong> — there is no default. Enter <code>0.00</code> to match exactly.
                </p>
                <Input
                  id="suppressed-bb-undercut-main"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Enter amount (e.g. 0.01 or 0.00)"
                  value={settings.suppressed_bb_undercut == null ? "" : settings.suppressed_bb_undercut}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      updateSetting("suppressed_bb_undercut" as any, null as any);
                      return;
                    }
                    const v = parseFloat(raw);
                    updateSetting("suppressed_bb_undercut", isNaN(v) ? (null as any) : Math.max(0, v));
                  }}
                />
                {(settings.suppressed_bb_undercut == null || (settings.suppressed_bb_undercut as any) === "") && (
                  <p className="text-xs text-amber-400">⚠️ Required — suppressed-BB pricing will be skipped until you set a value.</p>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Min/Max prices are set per-assignment in the Assignments tab
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Smart Profit Guard — admin only */}
      {advancedMode && (<Card className="border-green-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-green-500" />
            Smart Profit Guard
            <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 text-xs">
              No Human Required
            </Badge>
          </CardTitle>
          <CardDescription>
            Your Min/Max prices are the absolute floor and ceiling — the repricer will never go outside them
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 p-3 bg-gradient-to-r from-green-500/10 to-emerald-500/10 rounded-lg border border-green-500/20">
            <Badge className="bg-green-600 text-white text-xs">Active</Badge>
            <p className="text-sm text-muted-foreground">
              Min/Max prices set per-assignment are always enforced as hard limits
            </p>
          </div>

          {advancedMode && (<>
            {/* Dynamic ROI — admin only */}
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div>
                <p className="font-medium text-sm">Enable Dynamic ROI</p>
                <p className="text-xs text-muted-foreground">
                  Use higher ROI floor when many sellers are competing
                </p>
              </div>
              <Switch
                checked={settings.enable_dynamic_roi}
                onCheckedChange={(checked) => updateSetting("enable_dynamic_roi", checked)}
              />
            </div>

            {settings.enable_dynamic_roi && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-4 border-l-2 border-green-500/30">
                <div className="space-y-2">
                  <Label htmlFor="min-roi-high-risk">High-Risk Min ROI (%)</Label>
                  <Input
                    id="min-roi-high-risk"
                    type="number"
                    step="1"
                    min="0"
                    max="500"
                    value={settings.min_roi_percent_high_risk ?? ""}
                    onChange={(e) =>
                      updateSetting("min_roi_percent_high_risk", e.target.value ? parseFloat(e.target.value) : null)
                    }
                    placeholder="e.g. 35"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="high-risk-threshold">High-Risk Seller Threshold</Label>
                  <Input
                    id="high-risk-threshold"
                    type="number"
                    step="1"
                    min="2"
                    max="50"
                    value={settings.high_risk_seller_count_threshold}
                    onChange={(e) =>
                      updateSetting("high_risk_seller_count_threshold", parseInt(e.target.value) || 8)
                    }
                  />
                </div>
              </div>
            )}

            {/* Auto-Exit/Reenter — admin only */}
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div>
                <p className="font-medium text-sm flex items-center gap-2">
                  Auto-Exit & Auto-Reenter
                  <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-xs">
                    Zero Human
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  Pause when below floor, auto-resume when market recovers
                </p>
              </div>
              <Switch
                checked={settings.enable_auto_exit_reenter}
                onCheckedChange={(checked) => updateSetting("enable_auto_exit_reenter", checked)}
              />
            </div>

            {settings.enable_auto_exit_reenter && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-4 border-l-2 border-blue-500/30">
                <div className="space-y-2">
                  <Label htmlFor="reenter-buffer">Re-entry Buffer (%)</Label>
                  <Input
                    id="reenter-buffer"
                    type="number"
                    step="0.5"
                    min="0"
                    max="20"
                    value={settings.reenter_buffer_percent}
                    onChange={(e) =>
                      updateSetting("reenter_buffer_percent", parseFloat(e.target.value) || 2)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="floor-cooldown">Floor Recheck (minutes)</Label>
                  <Select
                    value={String(settings.cooldown_minutes_on_floor)}
                    onValueChange={(v) => updateSetting("cooldown_minutes_on_floor", parseInt(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="60">1 hour</SelectItem>
                      <SelectItem value="120">2 hours</SelectItem>
                      <SelectItem value="240">4 hours</SelectItem>
                      <SelectItem value="360">6 hours (default)</SelectItem>
                      <SelectItem value="720">12 hours</SelectItem>
                      <SelectItem value="1440">24 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Other toggles — admin only */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">Include Fees in Floor Calculation</p>
                  <p className="text-xs text-muted-foreground">
                    Add estimated FBA + referral fees when calculating profit floor
                  </p>
                </div>
                <Switch
                  checked={settings.include_fees_in_floor}
                  onCheckedChange={(checked) => updateSetting("include_fees_in_floor", checked)}
                />
              </div>
              
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">Block Auto-Apply if Cost Missing</p>
                  <p className="text-xs text-muted-foreground">
                    Prevent automatic price changes when unit cost is unknown
                  </p>
                </div>
                <Switch
                  checked={settings.block_auto_apply_if_cost_missing}
                  onCheckedChange={(checked) => updateSetting("block_auto_apply_if_cost_missing", checked)}
                />
              </div>
            </div>
          </>)}
        </CardContent>
      </Card>)}

      {/* Min ROI Protection — visible to ALL users */}
      <Card className="border-amber-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-amber-500" />
            Min ROI Protection
            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-xs">
              Optional
            </Badge>
          </CardTitle>
          <CardDescription>
            Set a minimum ROI % floor — the repricer will never price below this threshold and will raise your price if it's already too low
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Min ROI % per Marketplace</Label>
              <p className="text-xs text-muted-foreground">
                ROI = (Price - Cost - Fees) / Cost. Each marketplace has its own switch — turn it on to set a minimum ROI floor for that marketplace only.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {connectedMarketplaces.map((mp) => {
                const roiEnabled = isRoiEnabledForMarketplace(mp);
                return (
                  <div key={mp} className="p-3 bg-muted/50 rounded-lg space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm">{mp} — Respect minimum ROI for your price?</p>
                      <Switch
                        checked={roiEnabled}
                        onCheckedChange={(checked) => setRoiEnabledForMarketplace(mp, checked)}
                      />
                    </div>
                    {roiEnabled && (
                      <div className="space-y-1">
                        <Label htmlFor={`roi-${mp}`} className="text-xs text-muted-foreground">{mp} ROI %</Label>
                        <div className="flex gap-1">
                          <Input
                            id={`roi-${mp}`}
                            type="number"
                            step="1"
                            min="0"
                            max="500"
                            value={settings.min_roi_marketplace_overrides?.[mp] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value ? parseFloat(e.target.value) : undefined;
                              const overrides = { ...settings.min_roi_marketplace_overrides };
                              if (val !== undefined) {
                                overrides[mp] = val;
                              } else {
                                delete overrides[mp];
                              }
                              // Use a single onChange call to avoid the second call overwriting the first
                              const updated: Partial<AiRuleSettings> = { min_roi_marketplace_overrides: overrides };
                              if (mp === "US") {
                                updated.min_roi_percent = val ?? null;
                              }
                              onChange({ ...settings, ...updated });
                            }}
                            placeholder="e.g. 30"
                            className="flex-1"
                          />
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="outline"
                                  className="h-9 w-9 shrink-0"
                                  disabled={!ruleId || !settings.min_roi_marketplace_overrides?.[mp] || applyingMarketplace === mp}
                                  onClick={() => handleApplyMinRoi(mp)}
                                >
                                  {applyingMarketplace === mp ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Apply {mp} ROI to all assignments now</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">ROI will not lower prices below your manual minimum.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {connectedMarketplaces.some(isRoiEnabledForMarketplace) && (
             <div className="space-y-4 pl-4 border-l-2 border-amber-500/30">
              <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
                <p className="text-xs text-muted-foreground">
                  <strong>How it works:</strong> If your target ROI is 30% and based on cost + fees the minimum valid price is $18.40, 
                  the repricer will never go below $18.40. If your current price is $17.90, it will raise it to at least $18.40.
                  If the ROI floor exceeds Max Price, the engine uses a temporary higher max during that evaluation (your saved Max is not overwritten).
                </p>
              </div>

              <div className="p-3 bg-orange-500/10 rounded-lg border border-orange-500/20">
                <p className="text-xs text-muted-foreground">
                  ⚠️ <strong>Liquidation rules bypass Min ROI protection.</strong> If a rule uses the Liquidation strategy, 
                  this ROI floor will not be enforced — liquidation prioritizes sell-through over margins.
                </p>
              </div>

              <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-500/20">
                <p className="text-xs text-muted-foreground">
                  📊 <strong>Missing data:</strong> If cost or fee data is unavailable, the repricer will hold your current price 
                  instead of lowering — protecting you from unintended losses. Check the Action Log for "MIN_ROI_DATA_MISSING" tags.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Strategy Engine — Dynamic Floor Relaxation (Milestone B) */}
      {advancedMode && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Strategy Engine — Dynamic Floor Relaxation
            </CardTitle>
            <CardDescription>
              Lets the engine soften your minimum-price floor for slow-moving or aged stock,
              based on the listing's current commercial state. The hard floors
              (your ROI floor and the platform $5 minimum) are <strong>always preserved</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="space-y-1 pr-4">
                <p className="font-medium text-sm">Allow strategy-driven floor softening?</p>
                <p className="text-xs text-muted-foreground">
                  When ON: aged (5%), velocity-boost (7%), liquidation (8%), and clearance (15%)
                  states may soften the floor. Profit Max / Buy Box Defense / Recovery never relax it.
                  When OFF: behavior is unchanged from before — the floor is fixed.
                </p>
              </div>
              <Switch
                checked={settings.enable_dynamic_floor_relaxation === true}
                onCheckedChange={(checked) => updateSetting("enable_dynamic_floor_relaxation" as any, checked)}
              />
            </div>
          </CardContent>
        </Card>
      )}
      {advancedMode && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Safety Guards
          </CardTitle>
          <CardDescription>
            Prevent drastic price changes and control update frequency
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="max-step-amount">Max Change Per Step ($)</Label>
              <Input
                id="max-step-amount"
                type="number"
                step="0.10"
                min="0.10"
                value={settings.max_step_amount}
                onChange={(e) =>
                  updateSetting("max_step_amount", parseFloat(e.target.value) || 0.50)
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="max-step-percent">Max Change Per Step (%)</Label>
              <Input
                id="max-step-percent"
                type="number"
                step="1"
                min="1"
                max="50"
                value={settings.max_step_percent}
                onChange={(e) =>
                  updateSetting("max_step_percent", parseFloat(e.target.value) || 5)
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cooldown">Cooldown (minutes)</Label>
              <Input
                id="cooldown"
                type="number"
                step="1"
                min="0"
                value={settings.cooldown_minutes}
                onChange={(e) =>
                  updateSetting("cooldown_minutes", parseInt(e.target.value) || 15)
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="snapshot-ttl" className="flex items-center gap-1">
                Snapshot TTL (hours)
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      How often to refresh competitor data from Rainforest API. 
                      Higher = fewer API calls = lower cost. Default: 6 hours.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Select
                value={String(settings.snapshot_ttl_minutes)}
                onValueChange={(v) => updateSetting("snapshot_ttl_minutes", parseInt(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="120">2 hours</SelectItem>
                  <SelectItem value="240">4 hours</SelectItem>
                  <SelectItem value="360">6 hours (recommended)</SelectItem>
                  <SelectItem value="720">12 hours</SelectItem>
                  <SelectItem value="1440">24 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <div className="mt-4 p-3 border rounded-lg border-blue-500/30 bg-blue-500/5">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <strong>Cost Control:</strong> At 6-hour TTL with 1,000 SKUs, you'll use ~4 Rainforest calls/day per SKU = ~120K/month instead of 2.88M/month with 15-min polling.
            </p>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Buy Box Owner Protection + Smart Raise */}
      <Card className="border-emerald-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowUp className="h-4 w-4 text-emerald-500" />
            Smart Price Protection
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-xs">
              Maximize Profit
            </Badge>
          </CardTitle>
          <CardDescription>
            Protect your margin when you own the Buy Box & raise prices when the market goes up
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Don't Lower When BB Owner - NEW PRIMARY TOGGLE */}
          <div className="flex items-center justify-between p-3 bg-gradient-to-r from-emerald-500/10 to-green-500/10 rounded-lg border border-emerald-500/20">
            <div>
              <p className="font-medium flex items-center gap-2">
                Don't Lower When You Own Buy Box
                <Badge className="bg-emerald-600 text-white text-xs">Recommended</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                Keep your price when you're already winning — only lower after losing Buy Box
              </p>
            </div>
            <Switch
              checked={settings.skip_lower_when_bb_owner}
              onCheckedChange={(checked) => updateSetting("skip_lower_when_bb_owner", checked)}
            />
          </div>

          {/* Auto Floor (per-rule) */}
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border border-amber-500/20">
            <div>
              <p className="font-medium flex items-center gap-2">
                Auto Lowering (Soft Floor)
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3.5 w-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      When enabled, the system can temporarily lower the min price below your set floor to compete for Buy Box. When disabled, the min floor is strictly respected and never lowered.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </p>
              <p className="text-sm text-muted-foreground">
                Allow the system to temporarily lower min price to win Buy Box
              </p>
            </div>
            <Switch
              checked={settings.enable_auto_floor}
              onCheckedChange={(checked) => updateSetting("enable_auto_floor", checked)}
            />
          </div>

          {/* Price War Protection — only show when auto floor is enabled */}
          {settings.enable_auto_floor && (
            <div className="p-3 bg-muted/50 rounded-lg border border-blue-500/20 space-y-2">
              <p className="font-medium flex items-center gap-2">
                🛡️ Price War Protection
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3.5 w-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p className="font-medium mb-1">Delay auto-floor activation during price wars</p>
                      <p>When competitors suddenly drop prices, the system will HOLD your price for this duration before allowing the soft floor to lower. This protects you from temporary price wars while still adapting to real market shifts.</p>
                      <p className="mt-1 text-xs">• Short drop → HOLD (protect margin)</p>
                      <p className="text-xs">• Sustained drop → ADAPT (soft floor activates)</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </p>
              <p className="text-sm text-muted-foreground">
                Wait before lowering floor — ignore temporary price wars
              </p>
              <div className="flex items-center gap-3 mt-1">
                <Label className="text-sm whitespace-nowrap">Hold for:</Label>
                <Select
                  value={String(settings.war_protection_minutes)}
                  onValueChange={(val) => updateSetting("war_protection_minutes", parseInt(val))}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">No delay (immediate)</SelectItem>
                    <SelectItem value="15">15 minutes</SelectItem>
                    <SelectItem value="30">30 minutes ✦ Recommended</SelectItem>
                    <SelectItem value="60">1 hour</SelectItem>
                    <SelectItem value="120">2 hours</SelectItem>
                    <SelectItem value="240">4 hours (conservative)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                💡 30 min is recommended — filters out most price wars while adapting quickly to real market changes.
              </p>
            </div>
          )}
          
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
            <div>
              <p className="font-medium">Enable Smart Raise</p>
              <p className="text-sm text-muted-foreground">
                Raise prices when Buy Box / market prices increase
              </p>
            </div>
            <Switch
              checked={settings.enable_smart_raise}
              onCheckedChange={(checked) => updateSetting("enable_smart_raise", checked)}
            />
          </div>
          
          {settings.enable_smart_raise && advancedMode && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="raise-trigger" className="flex items-center gap-1">
                    Raise Trigger (%)
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-3 w-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          Minimum % increase in Buy Box price to trigger a raise (default 2%)
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Label>
                  <Input
                    id="raise-trigger"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="20"
                    value={settings.raise_trigger_percent}
                    onChange={(e) =>
                      updateSetting("raise_trigger_percent", parseFloat(e.target.value) || 2)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max-raise-dollars">Max Raise Per Step ($)</Label>
                  <Input
                    id="max-raise-dollars"
                    type="number"
                    step="0.05"
                    min="0.05"
                    value={settings.max_raise_step_dollars}
                    onChange={(e) =>
                      updateSetting("max_raise_step_dollars", parseFloat(e.target.value) || 0.25)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max-raise-percent">Max Raise Per Step (%)</Label>
                  <Input
                    id="max-raise-percent"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="20"
                    value={settings.max_raise_step_percent}
                    onChange={(e) =>
                      updateSetting("max_raise_step_percent", parseFloat(e.target.value) || 2)
                    }
                  />
                </div>
              </div>
              
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">Only Raise When You Own Buy Box</p>
                  <p className="text-xs text-muted-foreground">
                    Safer: only raise prices when you're already winning (recommended)
                  </p>
                </div>
                <Switch
                  checked={settings.only_raise_when_buybox_owner}
                  onCheckedChange={(checked) => updateSetting("only_raise_when_buybox_owner", checked)}
                />
              </div>
              
              <div className="p-3 border rounded-lg border-emerald-500/30 bg-emerald-500/5">
                <p className="text-xs text-muted-foreground">
                  💡 <strong>How it works:</strong> When Buy Box price rises by ≥{settings.raise_trigger_percent}%, 
                  the repricer raises your price toward the new market level (up to ${settings.max_raise_step_dollars} or {settings.max_raise_step_percent}% per step). 
                  This maximizes profit when competitors raise prices or leave the market.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Monopoly Mode - Proactive Price Raising */}
      <Card className="border-yellow-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-yellow-500" />
            Monopoly Mode
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20 text-xs">
              Profit Maximizer
            </Badge>
          </CardTitle>
          <CardDescription>
            When you're the only FBA seller, proactively raise prices to find your profit ceiling
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-gradient-to-r from-yellow-500/10 to-orange-500/10 rounded-lg border border-yellow-500/20">
            <div>
              <p className="font-medium flex items-center gap-2">
                Enable Monopoly Mode
                <Badge className="bg-yellow-600 text-white text-xs">Recommended</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                When you're the only FBA + own Buy Box → raise prices incrementally to maximize profit
              </p>
            </div>
            <Switch
              checked={settings.enable_monopoly_mode}
              onCheckedChange={(checked) => updateSetting("enable_monopoly_mode", checked)}
            />
          </div>
          
          {settings.enable_monopoly_mode && advancedMode && (
            <>
              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  Monopoly Strategy
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <Info className="h-3 w-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        Conservative: Small, safe steps. Protects sales velocity. 
                        Aggressive: Larger steps to find ceiling faster.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
                <Select
                  value={settings.monopoly_mode_type}
                  onValueChange={(v: 'conservative' | 'aggressive') => updateSetting("monopoly_mode_type", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="conservative">
                      🐢 Conservative - Slow & safe (recommended for fast movers)
                    </SelectItem>
                    <SelectItem value="aggressive">
                      🚀 Aggressive - Find ceiling faster (for slow/high-ROI items)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="monopoly-raise-dollars" className="flex items-center gap-1">
                    Raise Step ($)
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-3 w-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          How much to raise per cycle in monopoly mode
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Label>
                  <Input
                    id="monopoly-raise-dollars"
                    type="number"
                    step="0.05"
                    min="0.01"
                    value={settings.monopoly_raise_step_dollars}
                    onChange={(e) =>
                      updateSetting("monopoly_raise_step_dollars", parseFloat(e.target.value) || 0.10)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="monopoly-raise-percent" className="flex items-center gap-1">
                    Raise Step (%)
                  </Label>
                  <Input
                    id="monopoly-raise-percent"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="10"
                    value={settings.monopoly_raise_step_percent}
                    onChange={(e) =>
                      updateSetting("monopoly_raise_step_percent", parseFloat(e.target.value) || 1)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="monopoly-cooldown" className="flex items-center gap-1">
                    Cooldown (minutes)
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <Info className="h-3 w-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          Wait time between raises (default 60 min = 1 hour)
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Label>
                  <Select
                    value={String(settings.monopoly_cooldown_minutes)}
                    onValueChange={(v) => updateSetting("monopoly_cooldown_minutes", parseInt(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">30 minutes</SelectItem>
                      <SelectItem value="60">1 hour (recommended)</SelectItem>
                      <SelectItem value="120">2 hours</SelectItem>
                      <SelectItem value="240">4 hours</SelectItem>
                      <SelectItem value="360">6 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              
              <div className="p-3 border rounded-lg border-yellow-500/30 bg-yellow-500/5">
                <p className="text-xs text-muted-foreground">
                  💡 <strong>How it works:</strong> When you're the only FBA seller and own the Buy Box, 
                  the repricer raises your price by ${settings.monopoly_raise_step_dollars} (or {settings.monopoly_raise_step_percent}%) every {settings.monopoly_cooldown_minutes} minutes. 
                  It stops when hitting your Max Price or if you lose the Buy Box/another FBA appears.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Target Price Anchor — Admin only */}
      {isAdmin && <Card className="border-cyan-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-cyan-500" />
            Target Price Anchor
          </CardTitle>
          <CardDescription>
            Choose which competitor price the engine anchors to when calculating your target price
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select
            value={settings.target_anchor || "smart"}
            onValueChange={(val) => updateSetting("target_anchor", val as AiRuleSettings['target_anchor'])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smart">Smart (recommended)</SelectItem>
              <SelectItem value="smart_recapture">Smart + Lowest FBA Recapture</SelectItem>
              <SelectItem value="buybox">Buy Box</SelectItem>
              <SelectItem value="lowest_fba">Lowest FBA</SelectItem>
              <SelectItem value="lowest_offer">Lowest Offer</SelectItem>
            </SelectContent>
          </Select>
          <div className="p-3 border rounded-lg border-cyan-500/30 bg-cyan-500/5">
            <p className="text-xs text-muted-foreground">
              {settings.target_anchor === "buybox" && "💰 Anchor to Buy Box price — best for profit margin. Won't chase lower prices unnecessarily."}
              {settings.target_anchor === "smart_recapture" && "🎯 Smart when you're already lowest; switches to Lowest FBA when a cheaper FBA competitor exists. Best for ASINs where you keep losing to lower FBA sellers."}
              {settings.target_anchor === "lowest_fba" && "📦 Anchor to lowest FBA offer — ignores FBM sellers completely. Good for FBA-focused competition."}
              {settings.target_anchor === "lowest_offer" && "⚡ Anchor to absolute lowest offer (FBA + FBM) — most aggressive. May reduce margins."}
              {(!settings.target_anchor || settings.target_anchor === "smart") && "🧠 Smart: Uses Buy Box when available and reliable, falls back to Lowest FBA. This is what top repricers use."}
            </p>
          </div>
        </CardContent>
      </Card>}


      {/* Competitor Quality Filtering - Advanced only */}
      {advancedMode && (
      <Card className="border-green-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-green-500" />
            Competitor Quality Filter
            <Badge className="bg-green-600 text-white text-xs">NEW</Badge>
          </CardTitle>
          <CardDescription>
            Filter out low-quality competitors before pricing - this is what makes us better than BQool
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Preset Selector */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              Quality Preset
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Quickly set all quality filters to recommended levels
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </Label>
            <Select
              value={settings.competitor_quality_preset}
              onValueChange={(v: 'conservative' | 'balanced' | 'aggressive' | 'custom') => {
                updateSetting("competitor_quality_preset", v);
                // Apply preset values
                if (v === 'conservative') {
                  updateSetting("min_seller_rating", 90);
                  updateSetting("max_handling_days", 1);
                } else if (v === 'balanced') {
                  updateSetting("min_seller_rating", 80);
                  updateSetting("max_handling_days", 2);
                } else if (v === 'aggressive') {
                  updateSetting("min_seller_rating", 70);
                  updateSetting("max_handling_days", 3);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">🛡️ Conservative (≥90% rating, ≤1 day handling)</SelectItem>
                <SelectItem value="balanced">⚖️ Balanced (≥80% rating, ≤2 days handling)</SelectItem>
                <SelectItem value="aggressive">⚡ Aggressive (≥70% rating, ≤3 days handling)</SelectItem>
                <SelectItem value="custom">🔧 Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Min Seller Rating */}
            <div className="space-y-2">
              <Label htmlFor="min-seller-rating" className="flex items-center gap-1">
                Min Rating %
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Ignore sellers below this positive feedback percentage
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="min-seller-rating"
                type="number"
                min="0"
                max="100"
                value={settings.min_seller_rating}
                onChange={(e) => {
                  updateSetting("min_seller_rating", parseInt(e.target.value) || 0);
                  updateSetting("competitor_quality_preset", "custom");
                }}
              />
            </div>

            {/* Max Handling Days */}
            <div className="space-y-2">
              <Label htmlFor="max-handling-days" className="flex items-center gap-1">
                Max Handling Days
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Ignore sellers with longer handling times
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="max-handling-days"
                type="number"
                min="0"
                max="14"
                value={settings.max_handling_days}
                onChange={(e) => {
                  updateSetting("max_handling_days", parseInt(e.target.value) || 0);
                  updateSetting("competitor_quality_preset", "custom");
                }}
              />
            </div>

            {/* Ships From Filter */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                Ships From
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Filter by seller location
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Select
                value={settings.ships_from_filter}
                onValueChange={(v: 'US_ONLY' | 'DOMESTIC' | 'ANY') => 
                  updateSetting("ships_from_filter", v)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ANY">Any Location</SelectItem>
                  <SelectItem value="DOMESTIC">Domestic Only</SelectItem>
                  <SelectItem value="US_ONLY">US Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Top N Competitors */}
            <div className="space-y-2">
              <Label htmlFor="top-n-competitors" className="flex items-center gap-1">
                Top N Limit
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Only consider top N competitors by price (0 = no limit)
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <Input
                id="top-n-competitors"
                type="number"
                min="0"
                max="50"
                value={settings.top_n_competitors}
                onChange={(e) =>
                  updateSetting("top_n_competitors", parseInt(e.target.value) || 0)
                }
              />
            </div>
          </div>
          
          <div className="p-3 border rounded-lg border-green-500/30 bg-green-500/5">
            <p className="text-xs text-muted-foreground">
              💡 <strong>Why this matters:</strong> BQool filters by seller quality (rating, handling time, ships-from) before pricing.
              This prevents chasing low-quality sellers who don't pose a real Buy Box threat. 
              With {settings.competitor_quality_preset} preset: ignoring sellers with {"<"}{settings.min_seller_rating}% rating or {">"}{settings.max_handling_days} day handling.
            </p>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Smart Engine Toggle - Advanced only */}
      {advancedMode && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4 text-green-500" />
            Smart Engine
          </CardTitle>
          <CardDescription>
            Deterministic intelligence engine that adjusts aggressiveness based on market signals — zero AI cost
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
            <div>
              <p className="font-medium">Enable Smart Repricing Engine</p>
              <p className="text-sm text-muted-foreground">
                Analyzes sales velocity, Buy Box win rate, urgency &amp; competition to tune undercut (0.5x – 1.5x) — $0 per evaluation
              </p>
            </div>
            <Switch
              checked={settings.use_ai_tuning}
              onCheckedChange={(checked) => updateSetting("use_ai_tuning", checked)}
            />
          </div>
        </CardContent>
      </Card>
      )}

      {/* Stock-Aware Aggression Overlay */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4 text-cyan-500" />
            Stock-Aware Aggression Overlay
            <Badge className="bg-cyan-600 text-white text-xs">NEW</Badge>
          </CardTitle>
          <CardDescription>
            Adjusts aggression based on YOUR inventory levels — high stock = more aggressive, low stock = protect margins
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
            <div>
              <p className="font-medium">Enable Stock Overlay</p>
              <p className="text-sm text-muted-foreground">
                Uses weighted 7d/30d sales velocity + your FBA stock to calculate Days of Stock and adjust undercut multiplier
              </p>
            </div>
            <Switch
              checked={settings.stock_overlay_enabled}
              onCheckedChange={(checked) => updateSetting("stock_overlay_enabled", checked)}
            />
          </div>

          {settings.stock_overlay_enabled && (
            <div className="space-y-4">
              {/* Simple explanation for all users */}
              <div className="p-3 border rounded-lg border-cyan-500/30 bg-cyan-500/5">
                <p className="text-xs text-muted-foreground">
                  💡 <strong>How it works:</strong> Automatically adjusts pricing aggression based on your inventory levels — low stock protects margins, high stock pushes for sales. Uses your recent sales velocity to calculate days of stock remaining. Stacks with other Smart Engine signals and always respects min/max and ROI guards.
                </p>
              </div>

              {/* Advanced tuning — Admin only */}
              {isAdmin && (
                <div className="space-y-4">
                  {/* Velocity Weighting */}
                  <div className="p-3 border rounded-lg">
                    <h5 className="text-sm font-medium mb-3">Velocity Weighting (7d vs 30d)</h5>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-xs">7-day weight ({(settings.velocity_weight_7d * 100).toFixed(0)}%)</Label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0"
                          max="1"
                          value={settings.velocity_weight_7d}
                          onChange={(e) => {
                            const w7 = parseFloat(e.target.value) || 0.6;
                            updateSetting("velocity_weight_7d", w7);
                            updateSetting("velocity_weight_30d", Math.round((1 - w7) * 100) / 100);
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">30-day weight ({(settings.velocity_weight_30d * 100).toFixed(0)}%)</Label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0"
                          max="1"
                          value={settings.velocity_weight_30d}
                          onChange={(e) => {
                            const w30 = parseFloat(e.target.value) || 0.4;
                            updateSetting("velocity_weight_30d", w30);
                            updateSetting("velocity_weight_7d", Math.round((1 - w30) * 100) / 100);
                          }}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Higher 7d weight reacts faster to recent trends. Default: 60/40 blend.
                    </p>
                  </div>

                  {/* Days-of-Stock Thresholds */}
                  <div className="p-3 border rounded-lg">
                    <h5 className="text-sm font-medium mb-3">Days-of-Stock Thresholds</h5>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div>
                        <Label className="text-xs">Critical (days)</Label>
                        <Input
                          type="number"
                          value={settings.stock_threshold_critical}
                          onChange={(e) => updateSetting("stock_threshold_critical", parseInt(e.target.value) || 7)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">{"<"}{settings.stock_threshold_critical}d → least aggressive</p>
                      </div>
                      <div>
                        <Label className="text-xs">Low (days)</Label>
                        <Input
                          type="number"
                          value={settings.stock_threshold_low}
                          onChange={(e) => updateSetting("stock_threshold_low", parseInt(e.target.value) || 30)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">{"<"}{settings.stock_threshold_low}d → less aggressive</p>
                      </div>
                      <div>
                        <Label className="text-xs">Healthy Max (days)</Label>
                        <Input
                          type="number"
                          value={settings.stock_threshold_healthy_max}
                          onChange={(e) => updateSetting("stock_threshold_healthy_max", parseInt(e.target.value) || 90)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">{settings.stock_threshold_low}–{settings.stock_threshold_healthy_max}d → neutral</p>
                      </div>
                      <div>
                        <Label className="text-xs">Heavy (days)</Label>
                        <Input
                          type="number"
                          value={settings.stock_threshold_heavy}
                          onChange={(e) => updateSetting("stock_threshold_heavy", parseInt(e.target.value) || 180)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">{">"}{settings.stock_threshold_heavy}d → most aggressive</p>
                      </div>
                    </div>
                  </div>

                  {/* Aggression Modifiers */}
                  <div className="p-3 border rounded-lg">
                    <h5 className="text-sm font-medium mb-3">Aggression Modifiers (multiplier)</h5>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      <div>
                        <Label className="text-xs">Critical ({`<${settings.stock_threshold_critical}d`})</Label>
                        <Input
                          type="number"
                          step="0.05"
                          value={settings.stock_modifier_critical}
                          onChange={(e) => updateSetting("stock_modifier_critical", parseFloat(e.target.value) || 0.75)}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Low ({`<${settings.stock_threshold_low}d`})</Label>
                        <Input
                          type="number"
                          step="0.05"
                          value={settings.stock_modifier_low}
                          onChange={(e) => updateSetting("stock_modifier_low", parseFloat(e.target.value) || 0.85)}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Normal</Label>
                        <Input
                          type="number"
                          step="0.05"
                          value={settings.stock_modifier_normal}
                          onChange={(e) => updateSetting("stock_modifier_normal", parseFloat(e.target.value) || 1.0)}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Heavy ({`>${settings.stock_threshold_healthy_max}d`})</Label>
                        <Input
                          type="number"
                          step="0.05"
                          value={settings.stock_modifier_heavy}
                          onChange={(e) => updateSetting("stock_modifier_heavy", parseFloat(e.target.value) || 1.10)}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Overstock ({`>${settings.stock_threshold_heavy}d`})</Label>
                        <Input
                          type="number"
                          step="0.05"
                          value={settings.stock_modifier_overstock}
                          onChange={(e) => updateSetting("stock_modifier_overstock", parseFloat(e.target.value) || 1.30)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {/* Oscillation Handling — Admin only */}
      {isAdmin && <Card className="border-orange-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-orange-500" />
            Oscillation Handling
            <Badge variant="outline" className="bg-orange-500/10 text-orange-600 border-orange-500/20 text-xs">
              Price War Protection
            </Badge>
          </CardTitle>
          <CardDescription>
            Choose how the repricer behaves when the market is unstable (multiple bots fighting).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* AI vs Manual toggle */}
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                {settings.oscillation_mode === 'auto' ? '🧠 Intelligent Mode' : '⚙️ Manual Mode'}
              </span>
              <span className="text-xs text-muted-foreground">
                {settings.oscillation_mode === 'auto' 
                  ? 'Automatically adapts to market conditions' 
                  : 'You control oscillation behavior'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Manual</Label>
              <Switch
                checked={settings.oscillation_mode === 'auto'}
                onCheckedChange={(checked) => {
                  if (checked) {
                    onChange({
                      ...settings,
                      oscillation_mode: 'auto',
                      oscillation_ai_style: settings.oscillation_ai_style || 'balanced',
                    });
                  } else {
                    onChange({
                      ...settings,
                      oscillation_mode: 'safe',
                      oscillation_cooldown_minutes: 20,
                      oscillation_max_reactions: 0,
                      oscillation_bb_loss_limit: 1,
                    });
                  }
                }}
              />
              <Label className="text-xs text-muted-foreground">Intelligent</Label>
            </div>
          </div>

          {/* AI Mode content */}
          {settings.oscillation_mode === 'auto' && (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20">
                <p className="text-sm text-foreground">
                  🧠 <strong>Adaptive Intelligence</strong> — The repricer reads live market signals and automatically switches behavior per ASIN:
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div className="flex items-center gap-1.5 p-1.5 rounded bg-green-500/10 border border-green-500/20">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span><strong>Stable</strong> — Competes normally</span>
                  </div>
                  <div className="flex items-center gap-1.5 p-1.5 rounded bg-yellow-500/10 border border-yellow-500/20">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span><strong>Volatile</strong> — Limited reactions</span>
                  </div>
                  <div className="flex items-center gap-1.5 p-1.5 rounded bg-red-500/10 border border-red-500/20">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <span><strong>Price War</strong> — Protects floor</span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">AI Style Preference</Label>
                <Select
                  value={settings.oscillation_ai_style || 'balanced'}
                  onValueChange={(val) => onChange({ ...settings, oscillation_ai_style: val as 'conservative' | 'balanced' | 'aggressive' })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="conservative">
                      <div className="flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-green-500" />
                        🛡️ Conservative — Protect profit more
                      </div>
                    </SelectItem>
                    <SelectItem value="balanced">
                      <div className="flex items-center gap-2">
                        <Zap className="h-3.5 w-3.5 text-yellow-500" />
                        ⚖️ Balanced — Default
                      </div>
                    </SelectItem>
                    <SelectItem value="aggressive">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-3.5 w-3.5 text-red-500" />
                        ⚡ Aggressive — Maximize Buy Box wins
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Influences how quickly the AI switches to defensive or aggressive behavior. The AI still decides per-ASIN based on live signals.
                </p>
              </div>
            </div>
          )}

          {/* Manual Mode content */}
          {settings.oscillation_mode !== 'auto' && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Oscillation Mode</Label>
              <Select
                value={settings.oscillation_mode}
                onValueChange={(val) => {
                  const mode = val as 'safe' | 'balanced' | 'aggressive';
                  const defaults: Record<string, { cooldown: number; maxReactions: number; bbLossLimit: number }> = {
                    safe: { cooldown: 20, maxReactions: 0, bbLossLimit: 1 },
                    balanced: { cooldown: 10, maxReactions: 2, bbLossLimit: 2 },
                    aggressive: { cooldown: 5, maxReactions: 999, bbLossLimit: 3 },
                  };
                  const d = defaults[mode];
                  onChange({
                    ...settings,
                    oscillation_mode: mode,
                    oscillation_cooldown_minutes: d.cooldown,
                    oscillation_max_reactions: d.maxReactions,
                    oscillation_bb_loss_limit: d.bbLossLimit,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="safe">
                    <div className="flex items-center gap-2">
                      <Shield className="h-3.5 w-3.5 text-green-500" />
                      Avoid Price Wars (Safe)
                    </div>
                  </SelectItem>
                  <SelectItem value="balanced">
                    <div className="flex items-center gap-2">
                      <Zap className="h-3.5 w-3.5 text-yellow-500" />
                      Limited Reaction (Balanced)
                    </div>
                  </SelectItem>
                  <SelectItem value="aggressive">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3.5 w-3.5 text-red-500" />
                      Continue Competing (Aggressive)
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>

              {settings.oscillation_mode === 'safe' && (
                <p className="text-xs text-muted-foreground">
                  🛡️ When price instability is detected, the repricer will <strong>hold your price</strong> and wait for the market to stabilize. Safest option — protects margin from price wars.
                </p>
              )}
              {settings.oscillation_mode === 'balanced' && (
                <p className="text-xs text-muted-foreground">
                  ⚖️ The repricer will make a <strong>limited number of reactions</strong> during unstable markets, then enter a cooldown. Good balance between competitiveness and safety.
                </p>
              )}
              {settings.oscillation_mode === 'aggressive' && (
                <p className="text-xs text-muted-foreground">
                  ⚡ The repricer will <strong>keep competing</strong> even during price oscillation. Still respects min price, profit guard, and max step. Only pauses after repeated Buy Box losses after raises.
                </p>
              )}

              {/* Advanced oscillation settings */}
              {advancedMode && (
                <div className="space-y-4 pt-2 border-t">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-xs flex items-center gap-1">
                              Cooldown (min) <Info className="h-3 w-3" />
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent>How long to pause repricing after oscillation is detected or reaction limit is reached</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Input
                        type="number"
                        min={0}
                        value={settings.oscillation_cooldown_minutes}
                        onChange={(e) => updateSetting('oscillation_cooldown_minutes', parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-xs flex items-center gap-1">
                              Max Reactions <Info className="h-3 w-3" />
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent>Maximum price changes allowed during an oscillation window before entering cooldown (0 = no reactions in safe mode)</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Input
                        type="number"
                        min={0}
                        value={settings.oscillation_max_reactions}
                        onChange={(e) => updateSetting('oscillation_max_reactions', parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Label className="text-xs flex items-center gap-1">
                              BB Loss Limit <Info className="h-3 w-3" />
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent>After this many Buy Box losses following raises, enter cooldown even in aggressive mode</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <Input
                        type="number"
                        min={1}
                        value={settings.oscillation_bb_loss_limit}
                        onChange={(e) => updateSetting('oscillation_bb_loss_limit', parseInt(e.target.value) || 1)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>}
    </div>
  );
}
