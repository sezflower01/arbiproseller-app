import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { Candidate, aggregateDomains } from "./shared";

interface Props {
  candidates: Candidate[];
}

export default function DomainInsights({ candidates }: Props) {
  const { mostExtracted, mostBlockedRate, mostReview, bestYield } = useMemo(() => {
    const all = aggregateDomains(candidates);
    return {
      mostExtracted: [...all]
        .filter((x) => x.valid > 0)
        .sort((a, b) => b.valid - a.valid)
        .slice(0, 6),
      mostBlockedRate: [...all]
        .filter((x) => x.blocked > 0 && x.total >= 2)
        .sort((a, b) => (b.blocked / b.total) - (a.blocked / a.total) || b.blocked - a.blocked)
        .slice(0, 6),
      mostReview: [...all]
        .filter((x) => x.needsReview > 0)
        .sort((a, b) => b.needsReview - a.needsReview)
        .slice(0, 6),
      bestYield: [...all]
        .filter((x) => x.valid > 0 && x.total >= 2)
        .sort((a, b) => (b.valid / b.total) - (a.valid / a.total) || b.valid - a.valid)
        .slice(0, 6),
    };
  }, [candidates]);

  if (candidates.length === 0) return null;

  return (
    <Card className="p-5 bg-card/50 backdrop-blur border-border/50 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-white">Domain insights</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Column
          title="Most extracted (count)"
          tone="good"
          rows={mostExtracted.map((d) => ({ domain: d.domain, value: `${d.valid}` }))}
        />
        <Column
          title="Best valid-price yield"
          tone="good"
          rows={bestYield.map((d) => ({ domain: d.domain, value: `${d.valid}/${d.total} (${Math.round((d.valid / d.total) * 100)}%)` }))}
        />
        <Column
          title="Highest blocked rate"
          tone="bad"
          rows={mostBlockedRate.map((d) => ({ domain: d.domain, value: `${d.blocked}/${d.total} (${Math.round((d.blocked / d.total) * 100)}%)` }))}
        />
        <Column
          title="Most review-needed"
          tone="ai"
          rows={mostReview.map((d) => ({ domain: d.domain, value: `${d.needsReview}` }))}
        />
      </div>
    </Card>
  );
}

function Column({
  title, tone, rows,
}: { title: string; tone: "good" | "bad" | "ai"; rows: Array<{ domain: string; value: string }> }) {
  const cls =
    tone === "good" ? "text-emerald-300"
    : tone === "bad" ? "text-rose-300"
    : "text-amber-300";
  return (
    <div>
      <h4 className="text-xs text-muted-foreground mb-2">{title}</h4>
      <div className="space-y-1">
        {rows.length === 0 && <div className="text-xs text-muted-foreground">None.</div>}
        {rows.map((r) => (
          <div key={r.domain} className="flex justify-between text-sm gap-2">
            <span className="text-white truncate">{r.domain}</span>
            <span className={`font-mono ${cls} text-xs whitespace-nowrap`}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
