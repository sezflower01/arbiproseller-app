// Auto-lower-min coverage control for the repricer header.
//
// Turns `auto_lower_min_price` on or off PER RULE for the current marketplace,
// and shows how many listings the automation actually covers.
//
// WHY PER RULE, NOT ONE SWITCH
// The rules mean different things. "Momentum Builder" chases the Buy Box;
// "Equal No minimum Floor" is defined by not having a floor at all, so letting
// something lower its minimum automatically may be flatly wrong. A single
// all-or-nothing toggle would have enabled 678 US listings across eight
// strategies in one click, which does not match how the rest of this system
// works — per-marketplace ROI floors, per-ASIN exhaustion counters. Coverage is
// a decision per strategy, so the control is too.
//
// WHY A COVERAGE COUNT AND NOT JUST STATE
// The flag was populated once, by migration 20260323152317, for Momentum
// Builder US rows with a valid cost basis. Nothing has set it since — so
// coverage decays silently as listings are added. On 2026-08-18 it stood at 206
// automated out of 678 workable US assignments, and nothing in the product said
// so. Showing the ratio per rule is how that stays visible.
//
// DEFAULT IS OFF, DELIBERATELY
// `auto_lower_min_price` is `DEFAULT false` at the column level and this
// component never overrides it. Automated floor-lowering moves real prices on a
// multi-tenant platform, so it is opt-in rather than something that starts
// happening to sellers who never asked.
//
// ON THE 30% BASELINE
// The cumulative cap measures against `manual_min_price`, which has no trigger
// maintaining it. Rather than have this component copy a column — which
// PostgREST cannot express as `SET a = b` without a bespoke RPC — the worker
// anchors it on a listing's first adjustment, using the floor as it stood
// before that adjustment. One owner for the rule, and it cannot be bypassed by
// a future caller that forgets. See repricer-auto-lower-min.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDown, Loader2, ShieldCheck, TrendingDown } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Props {
  userId: string | undefined;
  marketplace: string;
  /** Fired after a successful change so the table can refetch. */
  onChanged?: () => void;
}

interface RuleCoverage {
  ruleId: string;
  ruleName: string;
  /** Active assignments on this rule — everything the automation could cover. */
  workable: number;
  /** Of those, how many carry the flag. */
  automated: number;
}

export default function AutoLowerMinToggle({ userId, marketplace, onChanged }: Props) {
  const [rules, setRules] = useState<RuleCoverage[] | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ rule: RuleCoverage; enable: boolean } | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      // Aggregated client-side: PostgREST has no GROUP BY, and the row set here
      // is small (one row per active assignment in one marketplace).
      const { data: rows, error } = await supabase
        .from("repricer_assignments")
        .select("rule_id, auto_lower_min_price")
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .eq("is_enabled", true)
        .eq("status", "active")
        .not("rule_id", "is", null)
        .limit(20000);
      if (error) throw error;

      const tally = new Map<string, { workable: number; automated: number }>();
      for (const r of rows ?? []) {
        const id = (r as { rule_id: string }).rule_id;
        const on = !!(r as { auto_lower_min_price: boolean | null }).auto_lower_min_price;
        const t = tally.get(id) ?? { workable: 0, automated: 0 };
        t.workable += 1;
        if (on) t.automated += 1;
        tally.set(id, t);
      }
      if (tally.size === 0) {
        setRules([]);
        return;
      }

      const { data: ruleRows } = await supabase
        .from("repricer_rules")
        .select("id, name")
        .in("id", [...tally.keys()]);
      const nameById = new Map((ruleRows ?? []).map((r) => [r.id as string, r.name as string]));

      setRules(
        [...tally.entries()]
          .map(([ruleId, t]) => ({
            ruleId,
            ruleName: nameById.get(ruleId) ?? "Unnamed rule",
            workable: t.workable,
            automated: t.automated,
          }))
          .sort((a, b) => b.workable - a.workable),
      );
    } catch (e) {
      console.warn("[auto-lower-min] coverage load failed:", e);
      setRules([]);
    }
  }, [userId, marketplace]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const workable = (rules ?? []).reduce((n, r) => n + r.workable, 0);
    const automated = (rules ?? []).reduce((n, r) => n + r.automated, 0);
    return { workable, automated };
  }, [rules]);

  const apply = async (rule: RuleCoverage, enable: boolean) => {
    if (!userId) return;
    setBusyRuleId(rule.ruleId);
    try {
      const { error } = await supabase
        .from("repricer_assignments")
        .update({ auto_lower_min_price: enable })
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .eq("is_enabled", true)
        .eq("status", "active")
        .eq("rule_id", rule.ruleId);
      if (error) throw error;

      toast.success(
        enable
          ? `Auto-lower minimum on for ${rule.ruleName} (${rule.workable} ${marketplace} listings)`
          : `Auto-lower minimum off for ${rule.ruleName}`,
      );
      await load();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Could not update ${rule.ruleName}: ${msg}`);
    } finally {
      setBusyRuleId(null);
      setPending(null);
    }
  };

  if (!rules || rules.length === 0) return null;

  const { workable, automated } = totals;
  const partial = automated > 0 && automated < workable;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-auto py-1.5 px-3 gap-2 shrink-0 bg-card/50 backdrop-blur-sm"
          >
            <TrendingDown className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="flex flex-col items-start leading-tight">
              <span className="text-xs font-medium whitespace-nowrap">Auto-lower min</span>
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                {automated} of {workable} listings
              </span>
            </span>
            {partial && (
              <Badge
                variant="outline"
                className="text-[9px] px-1 py-0 h-4 border-amber-500/40 text-amber-500"
              >
                Partial
              </Badge>
            )}
            {automated === 0 && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 text-muted-foreground">
                Off
              </Badge>
            )}
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-[340px] p-0">
          <div className="px-3 py-2.5 border-b border-border">
            <p className="text-sm font-medium">Automatic minimum lowering</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Choose which strategies may lower their own floor to stay competitive.
              Applies to {marketplace} only.
            </p>
          </div>

          <ScrollArea className="max-h-[280px]">
            <div className="p-1.5">
              {rules.map((rule) => {
                const allOn = rule.automated === rule.workable;
                const some = rule.automated > 0 && !allOn;
                return (
                  <div
                    key={rule.ruleId}
                    className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-muted/60"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{rule.ruleName}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {rule.automated} of {rule.workable} automated
                        {some ? " · partial" : ""}
                      </p>
                    </div>
                    {busyRuleId === rule.ruleId ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={allOn}
                        onCheckedChange={(next) => setPending({ rule, enable: next })}
                        aria-label={`Automatic minimum lowering for ${rule.ruleName}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          <div className="px-3 py-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Never below break-even, never more than 30% under your original floor,
              never more than 30% in one step, never more than five times per listing.
              Listings already winning the Buy Box or the lowest price are left alone.
            </p>
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              {pending?.enable ? "Enable" : "Disable"} for {pending?.rule.ruleName}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {pending?.enable ? (
                  <>
                    <p>
                      The repricer may lower your minimum price on{" "}
                      <strong>{pending.rule.workable}</strong> {marketplace} listing
                      {pending.rule.workable === 1 ? "" : "s"} using{" "}
                      <strong>{pending.rule.ruleName}</strong>, so it can compete when
                      your own floor is what blocks it.
                    </p>
                    <p className="text-muted-foreground">
                      Each adjustment stays bounded: never below break-even, never more
                      than 30% below your original floor, never more than 30% in one
                      step, and never more than five times per listing. Listings where
                      you already hold the Buy Box or the lowest price are skipped.
                    </p>
                    <p className="text-muted-foreground">
                      Your minimum as it stands today becomes the baseline, so the 30%
                      limit is measured from where you set it — not from wherever it
                      drifts to.
                    </p>
                  </>
                ) : (
                  <p>
                    Minimum prices on <strong>{pending?.rule.automated}</strong>{" "}
                    {marketplace} listing
                    {pending?.rule.automated === 1 ? "" : "s"} using{" "}
                    <strong>{pending?.rule.ruleName}</strong> will stop adjusting
                    automatically. Prices already lowered stay where they are — turning
                    this off does not put them back.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busyRuleId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busyRuleId}
              onClick={() => pending && void apply(pending.rule, pending.enable)}
            >
              {pending?.enable ? "Enable" : "Disable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
