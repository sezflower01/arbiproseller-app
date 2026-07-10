import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe, AlertTriangle } from "lucide-react";
import type { MarketplaceCoverage } from "@/hooks/use-monitor-data";
import { Progress } from "@/components/ui/progress";

interface Props {
  breakdown: MarketplaceCoverage[];
}

const MARKETPLACE_LABELS: Record<string, string> = {
  US: "🇺🇸 United States",
  CA: "🇨🇦 Canada",
  MX: "🇲🇽 Mexico",
  BR: "🇧🇷 Brazil",
  UK: "🇬🇧 United Kingdom",
  DE: "🇩🇪 Germany",
  ES: "🇪🇸 Spain",
};

export default function MarketplaceCoveragePanel({ breakdown }: Props) {
  if (!breakdown || breakdown.length === 0) return null;

  const hasIntlGap = breakdown.some(
    m => m.marketplace !== "US" && m.active > 0 && m.coveragePct < 10
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Globe className="h-5 w-5 text-primary" />
          Coverage by Marketplace
          {hasIntlGap && (
            <Badge variant="outline" className="ml-auto text-xs border-destructive text-destructive">
              International Gap Detected
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hasIntlGap && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-destructive/50 bg-destructive/10 mb-4">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-destructive">International assignments are not being evaluated.</span>{" "}
              Low overall coverage may be caused by international SKUs counted in the denominator but not checked by SP-API.
              The scheduler may need separate marketplace queues or the cron-trigger needs to dispatch international chains.
            </p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-muted-foreground text-xs">
                <th className="text-left py-2 pr-4">Marketplace</th>
                <th className="text-right py-2 px-2">Active</th>
                <th className="text-right py-2 px-2">Checked</th>
                <th className="text-right py-2 px-2 min-w-[120px]">Coverage</th>
                <th className="text-right py-2 px-2">Actions</th>
                <th className="text-right py-2 px-2">Price Δ</th>
                <th className="text-right py-2 px-2">Snapshots</th>
                <th className="text-right py-2 px-2">Empty %</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map(m => (
                <tr key={m.marketplace} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium">
                    {MARKETPLACE_LABELS[m.marketplace] || m.marketplace}
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.active}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.checked}</td>
                  <td className="text-right py-2 px-2">
                    <div className="flex items-center gap-2 justify-end">
                      <Progress
                        value={m.coveragePct}
                        className="h-2 w-16"
                      />
                      <span className={`tabular-nums font-medium text-xs ${
                        m.coveragePct >= 70 ? "text-green-600" :
                        m.coveragePct >= 40 ? "text-yellow-600" :
                        m.active === 0 ? "text-muted-foreground" :
                        "text-destructive"
                      }`}>
                        {m.coveragePct}%
                      </span>
                    </div>
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.withActions}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{m.priceChanges}</td>
                  <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">{m.totalSnapshots}</td>
                  <td className="text-right py-2 px-2">
                    <span className={`tabular-nums text-xs font-medium ${
                      m.emptyPct > 25 ? "text-destructive" :
                      m.emptyPct > 15 ? "text-yellow-600" :
                      "text-green-600"
                    }`}>
                      {m.totalSnapshots > 0 ? `${m.emptyPct}%` : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
