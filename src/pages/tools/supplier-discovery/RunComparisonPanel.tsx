import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { GitCompare, ArrowRight, ArrowUp, ArrowDown, Minus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  Candidate, DiscoveryRun, RunDiff, diffRuns, fmtPrice, toneClass,
} from "./shared";

interface Props {
  currentRun: DiscoveryRun;
  currentCandidates: Candidate[];
}

export default function RunComparisonPanel({ currentRun, currentCandidates }: Props) {
  const [prevRun, setPrevRun] = useState<DiscoveryRun | null>(null);
  const [prevCands, setPrevCands] = useState<Candidate[]>([]);
  const [diff, setDiff] = useState<RunDiff | null>(null);

  useEffect(() => {
    const id = currentRun.previous_run_id;
    if (!id) { setPrevRun(null); setPrevCands([]); setDiff(null); return; }
    (async () => {
      const [{ data: r }, { data: c }] = await Promise.all([
        supabase.from("source_discovery_runs").select("*").eq("id", id).maybeSingle(),
        supabase.from("source_candidates").select("*").eq("run_id", id),
      ]);
      if (r) {
        setPrevRun(r as DiscoveryRun);
        setPrevCands((c as Candidate[]) || []);
        setDiff(diffRuns(
          { run: r as DiscoveryRun, candidates: (c as Candidate[]) || [] },
          { run: currentRun, candidates: currentCandidates },
        ));
      }
    })();
  }, [currentRun, currentCandidates]);

  if (!currentRun.previous_run_id || !prevRun || !diff) return null;

  const priceArrow = diff.topPriceDelta == null ? <Minus className="h-3 w-3" />
    : diff.topPriceDelta > 0 ? <ArrowUp className="h-3 w-3 text-rose-400" />
    : diff.topPriceDelta < 0 ? <ArrowDown className="h-3 w-3 text-emerald-400" />
    : <Minus className="h-3 w-3" />;

  return (
    <Card className="p-5 bg-card/50 backdrop-blur border-border/50 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-white">Compared to previous run</h2>
        </div>
        <Link
          to={`/tools/supplier-discovery/runs/${prevRun.id}`}
          className="text-xs text-muted-foreground hover:text-white inline-flex items-center gap-1"
        >
          Open previous run <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
        <div>
          <div className="text-xs text-muted-foreground mb-1">Best candidate</div>
          {diff.bestChanged ? (
            <Badge variant="outline" className={toneClass("ai")}>Changed</Badge>
          ) : (
            <Badge variant="outline" className={toneClass("ok")}>Same</Badge>
          )}
          <div className="text-xs text-muted-foreground mt-2 break-all">
            <span className="text-muted-foreground">Was: </span>
            {diff.prevBestUrl ? <a className="text-white hover:text-primary" href={diff.prevBestUrl} target="_blank" rel="noopener noreferrer">{diff.prevBestUrl}</a> : "—"}
          </div>
          <div className="text-xs text-muted-foreground mt-1 break-all">
            <span className="text-muted-foreground">Now: </span>
            {diff.newBestUrl ? <a className="text-white hover:text-primary" href={diff.newBestUrl} target="_blank" rel="noopener noreferrer">{diff.newBestUrl}</a> : "—"}
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">Top valid price</div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-muted-foreground">{fmtPrice(diff.prevTopPrice, "USD")}</span>
            {priceArrow}
            <span className="font-mono text-white">{fmtPrice(diff.newTopPrice, "USD")}</span>
            {diff.topPriceDelta != null && diff.topPriceDelta !== 0 && (
              <span className={`text-xs font-mono ${diff.topPriceDelta < 0 ? "text-emerald-400" : "text-rose-400"}`}>
                ({diff.topPriceDelta > 0 ? "+" : ""}{diff.topPriceDelta.toFixed(2)})
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <DomainList title="Newly discovered" items={diff.newDomains} tone="good" />
        <DomainList title="No longer present" items={diff.lostDomains} tone="ai" />
        <DomainList title="Newly working" items={diff.newlyWorkingDomains} tone="good" />
        <DomainList title="Newly blocked" items={diff.newlyBlockedDomains} tone="bad" />
      </div>
    </Card>
  );
}

function DomainList({ title, items, tone }: { title: string; items: string[]; tone: "good" | "ai" | "bad" }) {
  const cls = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-amber-300";
  return (
    <div>
      <h4 className="text-xs text-muted-foreground mb-1">{title}</h4>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">None</div>
      ) : (
        <div className="space-y-0.5">
          {items.slice(0, 6).map((d) => <div key={d} className={`text-xs font-mono ${cls}`}>{d}</div>)}
          {items.length > 6 && <div className="text-xs text-muted-foreground">+{items.length - 6} more</div>}
        </div>
      )}
    </div>
  );
}
