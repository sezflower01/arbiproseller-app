import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Globe, ChevronDown, Zap, Clock, Moon, AlertTriangle } from "lucide-react";
import { MARKETPLACE_CONFIGS } from "@/lib/marketplaceCurrency";

export type MarketplaceRole = "primary" | "secondary" | "maintenance";

export interface MarketplaceScheduleConfig {
  role: MarketplaceRole;
  budget_share_pct: number;
  schedule_window_start: string; // HH:MM
  schedule_window_end: string;   // HH:MM
  cadence_minutes: number;
  exception_triggers: {
    lost_buybox: boolean;
    recent_sale: boolean;
    large_competitor_move: boolean;
    starred: boolean;
    significant_gap: boolean;
  };
}

export type MarketplaceScheduleMap = Record<string, MarketplaceScheduleConfig>;

const ROLE_CONFIG: Record<MarketplaceRole, { label: string; color: string; icon: React.ReactNode; description: string }> = {
  primary: {
    label: "Primary",
    color: "bg-green-500/10 text-green-700 border-green-500/30",
    icon: <Zap className="h-3.5 w-3.5" />,
    description: "Near-continuous, highest priority, largest budget share",
  },
  secondary: {
    label: "Secondary",
    color: "bg-yellow-500/10 text-yellow-700 border-yellow-500/30",
    icon: <Clock className="h-3.5 w-3.5" />,
    description: "Evaluated continuously all day, no fixed window — lower priority than Primary, so it only uses capacity Primary isn't using",
  },
  maintenance: {
    label: "Maintenance",
    color: "bg-blue-500/10 text-blue-700 border-blue-500/30",
    icon: <Moon className="h-3.5 w-3.5" />,
    description: "Only evaluated in its scheduled window (at the configured cadence) + urgent exceptions",
  },
};

// Sourced from the shared marketplace config so new marketplaces (e.g. EU
// expansion) only need to be added in one place (src/lib/marketplaceCurrency).
const MARKETPLACE_FLAGS: Record<string, string> = Object.fromEntries(
  Object.values(MARKETPLACE_CONFIGS).map((m) => [m.id, m.flag])
);

// The other five presets that used to live here (US-First, CA-First,
// Balanced, Overnight International, Sequenced Intl) all hardcoded an
// assumption about *which marketplace is primary* — either by name or by
// array position. That assumption no longer holds: primary marketplace is
// now auto-detected from real sales volume at the account level, can be
// any marketplace, and a rule's role field can't actually grant the
// dedicated always-on pool to a marketplace that isn't the real detected
// primary anyway (getMarketplaceRole checks the account setting first).
// Clicking one of those presets could set a rule's role to "primary" for
// a marketplace that isn't actually primary — a confusing mismatch with no
// real effect. Only "All Scheduled" survives: it doesn't assume who's
// primary, since the true primary is exempt from windowing regardless of
// what the rule says.
const PRESETS: { label: string; description: string; config: (marketplaces: string[]) => MarketplaceScheduleMap }[] = [
  {
    label: "All Scheduled",
    description: "Non-primary markets each get their own scheduled window — your primary marketplace always stays continuous",
    config: (mps) => {
      const result: MarketplaceScheduleMap = {};
      const share = Math.floor(100 / mps.length);
      mps.forEach((mp, i) => {
        const startHour = 6 + i * 3; // 1st=06:00-09:00, 2nd=09:00-12:00, 3rd=12:00-15:00, etc.
        const endHour = startHour + 3;
        result[mp] = {
          role: "maintenance",
          budget_share_pct: share,
          schedule_window_start: `${String(startHour % 24).padStart(2, "0")}:00`,
          schedule_window_end: `${String(endHour % 24).padStart(2, "0")}:00`,
          cadence_minutes: 15,
          exception_triggers: { lost_buybox: true, recent_sale: true, large_competitor_move: true, starred: true, significant_gap: true },
        };
      });
      return result;
    },
  },
];

function defaultPrimary(budget: number): MarketplaceScheduleConfig {
  return {
    role: "primary",
    budget_share_pct: budget,
    schedule_window_start: "00:00",
    schedule_window_end: "23:59",
    cadence_minutes: 5,
    exception_triggers: { lost_buybox: true, recent_sale: true, large_competitor_move: true, starred: true, significant_gap: true },
  };
}

function defaultSecondary(budget: number): MarketplaceScheduleConfig {
  return {
    role: "secondary",
    budget_share_pct: budget,
    schedule_window_start: "06:00",
    schedule_window_end: "22:00",
    cadence_minutes: 30,
    exception_triggers: { lost_buybox: true, recent_sale: true, large_competitor_move: true, starred: true, significant_gap: false },
  };
}

function defaultMaintenance(budget: number): MarketplaceScheduleConfig {
  return {
    role: "maintenance",
    budget_share_pct: budget,
    schedule_window_start: "02:00",
    schedule_window_end: "04:00",
    cadence_minutes: 60,
    exception_triggers: { lost_buybox: true, recent_sale: true, large_competitor_move: true, starred: true, significant_gap: false },
  };
}

function getDefaultForRole(role: MarketplaceRole, budget: number): MarketplaceScheduleConfig {
  if (role === "primary") return defaultPrimary(budget);
  if (role === "secondary") return defaultSecondary(budget);
  return defaultMaintenance(budget);
}

interface MarketplaceScheduleEditorProps {
  marketplaces: string[];
  schedule: MarketplaceScheduleMap;
  onChange: (schedule: MarketplaceScheduleMap) => void;
  userTimezone?: string;
}

export default function MarketplaceScheduleEditor({ marketplaces, schedule, onChange, userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone }: MarketplaceScheduleEditorProps) {
  const [expandedMp, setExpandedMp] = useState<string | null>(null);
  // Most sellers never need to touch budget share, cadence, or exception
  // triggers — an even split across intl marketplaces already works well
  // in practice. Default to a simple continuous-vs-scheduled choice per
  // marketplace (matching how other commercial repricers present this),
  // and tuck the underlying knobs behind an explicit "Advanced" toggle.
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Ensure all selected marketplaces have a config
  const ensuredSchedule: MarketplaceScheduleMap = { ...schedule };
  marketplaces.forEach((mp, i) => {
    if (!ensuredSchedule[mp]) {
      ensuredSchedule[mp] = i === 0 ? defaultPrimary(80) : defaultSecondary(Math.floor(20 / Math.max(marketplaces.length - 1, 1)));
    }
  });

  const totalBudget = marketplaces.reduce((sum, mp) => sum + (ensuredSchedule[mp]?.budget_share_pct || 0), 0);

  const updateMp = (mp: string, partial: Partial<MarketplaceScheduleConfig>) => {
    const updated = { ...ensuredSchedule, [mp]: { ...ensuredSchedule[mp], ...partial } };
    onChange(updated);
  };

  const applyPreset = (preset: typeof PRESETS[number]) => {
    onChange(preset.config(marketplaces));
  };

  if (marketplaces.length <= 1) {
    return null; // No scheduling needed for single marketplace
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2 text-sm font-semibold">
          <Globe className="h-4 w-4 text-primary" />
          Marketplace Scheduling Policy
          <span className="text-[10px] font-normal text-muted-foreground">({userTimezone})</span>
        </Label>
        <div className="flex items-center gap-2">
          {showAdvanced && (
            <Badge
              variant="outline"
              className={totalBudget === 100 ? "text-green-600 border-green-500/30" : "text-destructive border-destructive/30"}
            >
              Budget: {totalBudget}%
            </Badge>
          )}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
          </Button>
        </div>
      </div>

      {/* Presets */}
      <div className="flex gap-1.5 flex-wrap">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => applyPreset(preset)}
            title={preset.description}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      {showAdvanced && totalBudget !== 100 && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20 rounded px-2 py-1">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          Budget shares should total 100% (currently {totalBudget}%)
        </div>
      )}

      {/* Per-marketplace config */}
      <div className="space-y-2">
        {marketplaces.map((mp) => {
          const config = ensuredSchedule[mp];
          const roleInfo = ROLE_CONFIG[config.role];
          const isExpanded = expandedMp === mp;

          // ── SIMPLE MODE ──
          // A plain continuous-vs-scheduled choice, no roles/budget/cadence
          // jargon. Primary marketplaces aren't editable here at all — that
          // designation lives in account settings, not per-rule.
          if (!showAdvanced) {
            if (config.role === "primary") {
              return (
                <Card key={mp} className="overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{MARKETPLACE_FLAGS[mp] || "🌐"}</span>
                      <span className="font-medium text-sm">{mp}</span>
                      <Badge variant="outline" className={`text-xs ${ROLE_CONFIG.primary.color}`}>
                        {ROLE_CONFIG.primary.icon}
                        <span className="ml-1">Primary</span>
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">Always evaluated continuously</span>
                  </div>
                </Card>
              );
            }

            const isContinuous = config.role === "secondary";
            return (
              <Card key={mp} className="overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{MARKETPLACE_FLAGS[mp] || "🌐"}</span>
                    <span className="font-medium text-sm">{mp}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{isContinuous ? "Runs continuously" : "Runs on a schedule"}</span>
                    <Switch
                      checked={isContinuous}
                      onCheckedChange={(checked) =>
                        updateMp(mp, checked ? defaultSecondary(config.budget_share_pct) : defaultMaintenance(config.budget_share_pct))
                      }
                    />
                  </div>
                </div>
                {!isContinuous && (
                  <div className="grid grid-cols-2 gap-3 px-3 pb-3">
                    <div>
                      <Label className="text-xs">Runs from</Label>
                      <Input
                        type="time"
                        value={config.schedule_window_start}
                        onChange={(e) => updateMp(mp, { schedule_window_start: e.target.value })}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Until</Label>
                      <Input
                        type="time"
                        value={config.schedule_window_end}
                        onChange={(e) => updateMp(mp, { schedule_window_end: e.target.value })}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                )}
              </Card>
            );
          }

          // ── ADVANCED MODE ── full role/budget/cadence/exception controls
          return (
            <Collapsible key={mp} open={isExpanded} onOpenChange={(open) => setExpandedMp(open ? mp : null)}>
              <Card className="overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-muted/50 transition-colors text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{MARKETPLACE_FLAGS[mp] || "🌐"}</span>
                      <span className="font-medium text-sm">{mp}</span>
                      <Badge variant="outline" className={`text-xs ${roleInfo.color}`}>
                        {roleInfo.icon}
                        <span className="ml-1">{roleInfo.label}</span>
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {config.role === "primary"
                          ? "Continuous"
                          : config.role === "secondary"
                          ? `${config.budget_share_pct}% budget • continuous`
                          : `${config.budget_share_pct}% budget • ${config.cadence_minutes}min`}
                      </span>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                    </div>
                  </button>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <CardContent className="pt-0 pb-3 px-3 space-y-3 border-t">
                    {/* Role Selector */}
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      <div>
                        <Label className="text-xs">Role</Label>
                        <Select
                          value={config.role}
                          onValueChange={(val: MarketplaceRole) => {
                            const newConfig = getDefaultForRole(val, config.budget_share_pct);
                            updateMp(mp, newConfig);
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="primary">🟢 Primary — Continuous</SelectItem>
                            <SelectItem value="secondary">🟡 Secondary — Signal-driven</SelectItem>
                            <SelectItem value="maintenance">🔵 Maintenance — Scheduled window</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{roleInfo.description}</p>
                      </div>
                      <div>
                        <Label className="text-xs">Budget Share (%)</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={config.budget_share_pct}
                          onChange={(e) => updateMp(mp, { budget_share_pct: parseInt(e.target.value) || 0 })}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>

                    {/* Schedule Window & Cadence — only meaningful for Maintenance.
                        Primary is always eligible (never window/cadence-gated) and
                        Secondary is eligible all day by design, so these fields do
                        nothing for either — showing them as editable was misleading. */}
                    {config.role === "maintenance" ? (
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <Label className="text-xs">Window Start</Label>
                          <Input
                            type="time"
                            value={config.schedule_window_start}
                            onChange={(e) => updateMp(mp, { schedule_window_start: e.target.value })}
                            className="h-8 text-xs"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Window End</Label>
                          <Input
                            type="time"
                            value={config.schedule_window_end}
                            onChange={(e) => updateMp(mp, { schedule_window_end: e.target.value })}
                            className="h-8 text-xs"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Cadence (min)</Label>
                          <Input
                            type="number"
                            min={1}
                            max={1440}
                            value={config.cadence_minutes}
                            onChange={(e) => updateMp(mp, { cadence_minutes: parseInt(e.target.value) || 5 })}
                            className="h-8 text-xs"
                          />
                        </div>
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
                        {config.role === "primary"
                          ? "Primary is always evaluated continuously — no window or cadence to configure."
                          : "Secondary is evaluated continuously all day — no fixed window or cadence to configure."}
                      </p>
                    )}

                    {/* Exception Triggers — only read for Maintenance (the signals
                        that can wake it early, outside its window). Primary is
                        never window-gated and Secondary is never window-gated
                        either, so these switches have no effect for either role. */}
                    {config.role === "maintenance" && (
                      <div>
                        <Label className="text-xs font-medium mb-1.5 block">Exception Triggers (wake outside window)</Label>
                        <div className="grid grid-cols-2 gap-y-1.5 gap-x-4">
                          {([
                            ["lost_buybox", "Lost Buy Box"],
                            ["recent_sale", "Recent Sale"],
                            ["large_competitor_move", "Large Competitor Move"],
                            ["starred", "Starred / Turbo"],
                            ["significant_gap", "Significant Pricing Gap"],
                          ] as const).map(([key, label]) => (
                            <label key={key} className="flex items-center gap-2 text-xs cursor-pointer">
                              <Switch
                                checked={config.exception_triggers[key]}
                                onCheckedChange={(checked) =>
                                  updateMp(mp, {
                                    exception_triggers: { ...config.exception_triggers, [key]: checked },
                                  })
                                }
                                className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 data-[state=checked]:[&>span]:translate-x-3"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}
