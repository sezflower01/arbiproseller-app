// Stabilization & Validation panel — read-only operator-action telemetry.
// No new intelligence; surfaces existing repricer_operator_actions data so the
// platform can be tuned based on real operator behavior.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

interface ActionRow {
  action: string;
  suggested_action: string | null;
  created_at: string;
}

const WINDOW_DAYS = 7;

export default function ValidationPanel() {
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const since = new Date(
        Date.now() - WINDOW_DAYS * 24 * 3600 * 1000,
      ).toISOString();
      const { data } = await supabase
        .from("repricer_operator_actions")
        .select("action, suggested_action, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5000);
      setRows((data as ActionRow[]) ?? []);
      setLoading(false);
    })();
  }, []);

  const stats = useMemo(() => {
    const total = rows.length;
    const by: Record<string, number> = {};
    const ignoredPatterns: Record<string, number> = {};
    for (const r of rows) {
      by[r.action] = (by[r.action] ?? 0) + 1;
      if (r.action === "ignored" && r.suggested_action) {
        const key = r.suggested_action.slice(0, 80);
        ignoredPatterns[key] = (ignoredPatterns[key] ?? 0) + 1;
      }
    }
    const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
    const topIgnored = Object.entries(ignoredPatterns)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    return {
      total,
      approved: by.approved ?? 0,
      ignored: by.ignored ?? 0,
      autofix: by.auto_fixed ?? 0,
      escalated: by.escalated ?? 0,
      acceptance: pct((by.approved ?? 0) + (by.auto_fixed ?? 0)),
      ignoreRate: pct(by.ignored ?? 0),
      escalationRate: pct(by.escalated ?? 0),
      topIgnored,
    };
  }, [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Validation & tuning
          <Badge variant="outline" className="text-[10px]">
            Last {WINDOW_DAYS} days
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Real-world operator behaviour. Use this to tune confidence thresholds
          and reduce weak suggestions.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : stats.total === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No operator actions in the last {WINDOW_DAYS} days yet.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Stat label="Recommendations acted on" value={stats.total} />
              <Stat
                label="Acceptance rate"
                value={`${stats.acceptance}%`}
                tone={
                  stats.acceptance >= 60
                    ? "good"
                    : stats.acceptance >= 30
                      ? "ok"
                      : "weak"
                }
                hint={`${stats.approved} approved · ${stats.autofix} auto-fixed`}
              />
              <Stat
                label="Snooze / ignore rate"
                value={`${stats.ignoreRate}%`}
                tone={stats.ignoreRate > 50 ? "weak" : "ok"}
                hint={`${stats.ignored} snoozed`}
              />
              <Stat
                label="Escalation rate"
                value={`${stats.escalationRate}%`}
                tone={stats.escalationRate > 10 ? "weak" : "good"}
                hint={`${stats.escalated} escalated`}
              />
            </div>

            {stats.topIgnored.length > 0 && (
              <div>
                <div className="text-xs uppercase text-muted-foreground mb-2">
                  Most-ignored suggestion patterns
                </div>
                <ul className="text-sm space-y-1">
                  {stats.topIgnored.map(([pattern, count]) => (
                    <li
                      key={pattern}
                      className="flex items-start justify-between gap-3 border-b border-border/40 pb-1"
                    >
                      <span className="text-foreground/90 truncate">
                        {pattern}
                      </span>
                      <span className="text-muted-foreground tabular-nums shrink-0">
                        {count}×
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Patterns ignored repeatedly are candidates for confidence
                  threshold or scoring tweaks — not new features.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = "ok",
  hint,
}: {
  label: string;
  value: string | number;
  tone?: "good" | "ok" | "weak";
  hint?: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "weak"
        ? "text-amber-400"
        : "text-foreground";
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-3">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {hint && (
        <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>
      )}
    </div>
  );
}
