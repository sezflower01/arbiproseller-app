// Automation Trust Score — single number 0..100 derived from existing
// outcome history. Calm, plain-language indicator users can trust.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Shield } from "lucide-react";

type Props = { compact?: boolean };

export default function AutomationTrustBadge({ compact = false }: Props) {
  const { user } = useAuth();
  const [score, setScore] = useState<number | null>(null);
  const [sample, setSample] = useState(0);

  useEffect(() => {
    const load = async () => {
      if (!user) return;
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data } = await supabase
        .from("repricer_action_outcomes")
        .select("outcome_label")
        .eq("user_id", user.id)
        .gte("evaluated_at", since)
        .limit(20000);
      const rows = data ?? [];
      setSample(rows.length);
      if (rows.length === 0) {
        setScore(null);
        return;
      }
      let pts = 0;
      for (const r of rows) {
        switch (r.outcome_label) {
          case "successful":
            pts += 1;
            break;
          case "partial":
            pts += 0.5;
            break;
          case "neutral":
            pts += 0.25;
            break;
          case "failed":
            pts += 0;
            break;
          case "reversed":
            pts += -0.5;
            break;
        }
      }
      // Confidence weighting: small samples pulled toward 70 baseline
      const raw = pts / rows.length; // -0.5 .. 1
      const norm = Math.max(0, Math.min(1, (raw + 0.5) / 1.5));
      const confidence = Math.min(1, rows.length / 50);
      const blended = norm * confidence + 0.7 * (1 - confidence);
      setScore(Math.round(blended * 100));
    };
    load();
  }, [user]);

  const tone =
    score == null
      ? "text-muted-foreground"
      : score >= 85
        ? "text-emerald-400"
        : score >= 65
          ? "text-amber-400"
          : "text-red-400";
  const label = score == null ? "—" : `${score}%`;

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs ${tone}`}>
        <Shield className="h-3.5 w-3.5" /> Trust {label}
      </span>
    );
  }
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
        <Shield className="h-3.5 w-3.5" />
        Automation trust
      </div>
      <div className={`text-2xl font-bold ${tone}`}>{label}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">
        {sample === 0
          ? "Learning your business…"
          : `Based on ${sample.toLocaleString()} recent decisions (last 30 days)`}
      </div>
    </div>
  );
}
