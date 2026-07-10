import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AnalyzerSnapshot } from "@/hooks/use-analyzer-snapshot";

const TONE: Record<string, string> = {
  good: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  bad: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  info: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
};

export default function AlertsPanel({ alerts, dimensions }: { alerts: AnalyzerSnapshot["alerts"]; dimensions: AnalyzerSnapshot["identity"]["packageDimensions"] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Alerts &amp; Diagnostics</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <ul className="divide-y">
          {alerts.filter(a => !["hazmat","dangerous","meltable"].includes(a.key)).map((a) => (
            <li key={a.key} className="flex items-center justify-between py-1.5 text-sm">
              <span className="text-muted-foreground">{a.label}</span>
              <Badge variant="outline" className={TONE[a.status] ?? ""}>{a.value}</Badge>
            </li>
          ))}
          <li className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-muted-foreground">Package (L×W×H · wt)</span>
            <span className="font-medium">
              {dimensions.length && dimensions.width && dimensions.height
                ? `${dimensions.length}×${dimensions.width}×${dimensions.height} in`
                : "Not available"}
              {dimensions.weight ? ` · ${dimensions.weight} lb` : ""}
            </span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
