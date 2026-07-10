import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Bot, Zap, Shield, TrendingUp } from "lucide-react";

interface RepricerRule {
  id: string;
  name: string;
  strategy: string;
}

interface AutoSettings {
  auto_assign_enabled: boolean;
  auto_assign_rule_id: string | null;
  auto_assign_require_price: boolean;
  auto_assign_require_inbound: boolean;
  auto_assign_skip_existing: boolean;
  auto_minmax_enabled: boolean;
  auto_min_strategy: string;
  auto_max_strategy: string;
  auto_min_buffer_pct: number;
  auto_max_buffer_pct: number;
  auto_require_cost: boolean;
  auto_skip_manual_minmax: boolean;
  auto_raise_roi_floor_us: boolean;
  auto_raise_roi_floor_ca: boolean;
  auto_raise_roi_floor_mx: boolean;
  auto_raise_roi_floor_br: boolean;
}

const defaults: AutoSettings = {
  auto_assign_enabled: true,
  auto_assign_rule_id: null,
  auto_assign_require_price: true,
  auto_assign_require_inbound: true,
  auto_assign_skip_existing: true,
  auto_minmax_enabled: true,
  auto_min_strategy: "price_buffer",
  auto_max_strategy: "price_buffer",
  auto_min_buffer_pct: 15,
  auto_max_buffer_pct: 30,
  auto_require_cost: true,
  auto_skip_manual_minmax: true,
  auto_raise_roi_floor_us: false,
  auto_raise_roi_floor_ca: false,
  auto_raise_roi_floor_mx: false,
  auto_raise_roi_floor_br: false,
};

export default function AutoOnboardingSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AutoSettings>(defaults);
  const [saved, setSaved] = useState<AutoSettings>(defaults);
  const [rules, setRules] = useState<RepricerRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasPersistedRow, setHasPersistedRow] = useState(false);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const [settingsRes, rulesRes] = await Promise.all([
        supabase
          .from("user_settings")
          .select("auto_assign_enabled, auto_assign_rule_id, auto_assign_require_price, auto_assign_require_inbound, auto_assign_skip_existing, auto_minmax_enabled, auto_min_strategy, auto_max_strategy, auto_min_buffer_pct, auto_max_buffer_pct, auto_require_cost, auto_skip_manual_minmax, auto_raise_roi_floor_us, auto_raise_roi_floor_ca, auto_raise_roi_floor_mx, auto_raise_roi_floor_br")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("repricer_rules")
          .select("id, name, strategy")
          .order("name"),
      ]);

      const loadedRules = (rulesRes.data as RepricerRule[]) || [];
      setRules(loadedRules);

      if (settingsRes.data) {
        const s = { ...defaults, ...settingsRes.data } as AutoSettings;
        setSettings(s);
        setSaved(s);
        setHasPersistedRow(true);
      } else if (loadedRules.length > 0) {
        // No settings row yet — apply defaults with first available rule
        const s = { ...defaults, auto_assign_rule_id: loadedRules[0].id };
        setSettings(s);
        // Don't set saved = s, so hasChanges is true and Save button is enabled
      }
      setLoading(false);
    };
    load();
  }, [user]);

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(saved);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: user.id, ...settings }, { onConflict: "user_id" });

    if (error) {
      toast.error("Failed to save automation settings");
      console.error(error);
    } else {
      setSaved({ ...settings });
      setHasPersistedRow(true);
      toast.success("Automation settings saved");
    }
    setSaving(false);
  };

  const update = <K extends keyof AutoSettings>(key: K, val: AutoSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: val }));

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Loading...
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Rule Assignment */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Automatic Rule Assignment</CardTitle>
          </div>
          <CardDescription>
            Automatically assign a default repricer rule to new listings during inventory sync.
            No human intervention needed for normal cases.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <Label htmlFor="auto-assign">Enable automated rule assignment</Label>
            <Switch
              id="auto-assign"
              checked={settings.auto_assign_enabled}
              onCheckedChange={(v) => update("auto_assign_enabled", v)}
            />
          </div>

          {settings.auto_assign_enabled && (
            <>
              <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <Label className="flex items-center gap-2 text-sm">
                  ⭐ Default Rule
                </Label>
                <p className="text-xs text-muted-foreground">
                  The default rule is now managed in <strong>Repricer → Rules</strong>. Click the ⭐ star next to any rule to make it the default for new ASINs. Auto-Onboarding will automatically follow that selection — no need to update it here.
                </p>
                {settings.auto_assign_rule_id && (
                  <p className="text-[11px] text-muted-foreground/80 italic">
                    Currently using: <strong>{rules.find((r) => r.id === settings.auto_assign_rule_id)?.name ?? "(legacy selection — set a Default rule in the Rules tab)"}</strong>
                  </p>
                )}
              </div>


              <div className="space-y-3 border-t pt-4">
                <p className="text-sm font-medium">Eligibility Requirements</p>

                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="req-price">Require valid current price</Label>
                    <p className="text-xs text-muted-foreground">Only assign when ASIN has a known price</p>
                  </div>
                  <Switch
                    id="req-price"
                    checked={settings.auto_assign_require_price}
                    onCheckedChange={(v) => update("auto_assign_require_price", v)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="req-inbound">Require inbound / inventory detected</Label>
                    <p className="text-xs text-muted-foreground">Only assign when stock is inbound or available</p>
                  </div>
                  <Switch
                    id="req-inbound"
                    checked={settings.auto_assign_require_inbound}
                    onCheckedChange={(v) => update("auto_assign_require_inbound", v)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="skip-existing">Skip if rule already assigned</Label>
                    <p className="text-xs text-muted-foreground">Don't overwrite existing manual rule assignments</p>
                  </div>
                  <Switch
                    id="skip-existing"
                    checked={settings.auto_assign_skip_existing}
                    onCheckedChange={(v) => update("auto_assign_skip_existing", v)}
                  />
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Min/Max Automation */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Automatic Min / Max Setup</CardTitle>
          </div>
          <CardDescription>
            Auto-generate min and max price bounds for newly assigned listings so they're immediately repricer-ready.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <Label htmlFor="auto-minmax">Enable automated min/max</Label>
            <Switch
              id="auto-minmax"
              checked={settings.auto_minmax_enabled}
              onCheckedChange={(v) => update("auto_minmax_enabled", v)}
            />
          </div>

          {settings.auto_minmax_enabled && (
            <>
              <div className="space-y-2">
                <Label>Min Price Strategy</Label>
                <Select
                  value={settings.auto_min_strategy}
                  onValueChange={(v) => update("auto_min_strategy", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cost_buffer">Cost + Buffer %</SelectItem>
                    <SelectItem value="price_buffer">Current Price − Buffer %</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Min Buffer</Label>
                  <Badge variant="outline" className="font-bold">
                    {settings.auto_min_buffer_pct}%
                  </Badge>
                </div>
                <Slider
                  value={[settings.auto_min_buffer_pct]}
                  onValueChange={([v]) => update("auto_min_buffer_pct", v)}
                  min={5}
                  max={50}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">
                  {settings.auto_min_strategy === "cost_buffer"
                    ? `Min = Unit Cost + ${settings.auto_min_buffer_pct}% margin`
                    : `Min = Current Price − ${settings.auto_min_buffer_pct}%`}
                </p>
              </div>

              <div className="space-y-2">
                <Label>Max Price Strategy</Label>
                <Select
                  value={settings.auto_max_strategy}
                  onValueChange={(v) => update("auto_max_strategy", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="price_buffer">Current Price + Buffer %</SelectItem>
                    <SelectItem value="buybox_buffer">Buy Box + Buffer %</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Max Buffer</Label>
                  <Badge variant="outline" className="font-bold">
                    {settings.auto_max_buffer_pct}%
                  </Badge>
                </div>
                <Slider
                  value={[settings.auto_max_buffer_pct]}
                  onValueChange={([v]) => update("auto_max_buffer_pct", v)}
                  min={10}
                  max={100}
                  step={5}
                />
                <p className="text-xs text-muted-foreground">
                  {settings.auto_max_strategy === "price_buffer"
                    ? `Max = Current Price + ${settings.auto_max_buffer_pct}%`
                    : `Max = Buy Box + ${settings.auto_max_buffer_pct}%`}
                </p>
              </div>

              <div className="space-y-3 border-t pt-4">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Shield className="h-4 w-4" /> Safety Guards
                </p>

                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="req-cost">Require unit cost before onboarding</Label>
                    <p className="text-xs text-muted-foreground">Skip listing entirely if cost is unknown — prevents unsafe repricing</p>
                  </div>
                  <Switch
                    id="req-cost"
                    checked={settings.auto_require_cost}
                    onCheckedChange={(v) => update("auto_require_cost", v)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="skip-manual">Never overwrite manual min/max</Label>
                    <p className="text-xs text-muted-foreground">Respect user-set bounds on existing assignments</p>
                  </div>
                  <Switch
                    id="skip-manual"
                    checked={settings.auto_skip_manual_minmax}
                    onCheckedChange={(v) => update("auto_skip_manual_minmax", v)}
                  />
                </div>
              </div>

              {/* ROI Protection on Assignment */}
              <div className="space-y-3 border-t pt-4">
                <p className="text-sm font-medium flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" /> Auto Raise to ROI Floor on Assignment
                </p>
                <p className="text-xs text-muted-foreground">
                  When enabled, newly auto-assigned listings will immediately raise their live price to the ROI-safe minimum if the current price is too low. Only applies during first-time assignment.
                </p>

                {([
                  { key: "auto_raise_roi_floor_us" as const, label: "🇺🇸 US", desc: "Raise to ROI-safe floor on first assignment" },
                  { key: "auto_raise_roi_floor_ca" as const, label: "🇨🇦 CA", desc: "Raise to ROI-safe floor on first assignment" },
                  { key: "auto_raise_roi_floor_mx" as const, label: "🇲🇽 MX", desc: "Raise to ROI-safe floor on first assignment" },
                  { key: "auto_raise_roi_floor_br" as const, label: "🇧🇷 BR", desc: "Raise to ROI-safe floor on first assignment" },
                ]).map(({ key, label, desc }) => (
                  <div key={key} className="flex items-center justify-between">
                    <div>
                      <Label htmlFor={key}>{label}</Label>
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                    <Switch
                      id={key}
                      checked={settings[key]}
                      onCheckedChange={(v) => update(key, v)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? "Saving..." : "Save Automation Settings"}
        </Button>
      </div>
    </div>
  );
}
