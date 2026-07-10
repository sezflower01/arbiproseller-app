import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import type { AnalyzerSnapshot } from "@/hooks/use-analyzer-snapshot";

const PERIODS: Record<string, number | null> = {
  "30": 30, "90": 90, "180": 180, "All": null,
};

function filter(series: { t: number; v: number }[], days: number | null) {
  if (days == null) return series;
  const cutoff = Date.now() - days * 86_400_000;
  return series.filter((p) => p.t >= cutoff);
}

function fmtDate(t: number) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function AnalyzerCharts({ snap }: { snap: AnalyzerSnapshot }) {
  const [period, setPeriod] = useState<string>("90");
  const days = PERIODS[period];

  const priceData = useMemo(() => {
    const buyBox = filter(snap.series.buyBox, days);
    const amazon = filter(snap.series.amazon, days);
    const fba = filter(snap.series.newFba, days);
    const merged = new Map<number, any>();
    for (const p of buyBox) merged.set(p.t, { ...(merged.get(p.t) ?? { t: p.t }), buyBox: p.v });
    for (const p of amazon) merged.set(p.t, { ...(merged.get(p.t) ?? { t: p.t }), amazon: p.v });
    for (const p of fba) merged.set(p.t, { ...(merged.get(p.t) ?? { t: p.t }), fba: p.v });
    return Array.from(merged.values()).sort((a, b) => a.t - b.t);
  }, [snap, days]);

  const bsrData = useMemo(() => filter(snap.series.bsr, days).map((p) => ({ t: p.t, bsr: p.v })), [snap, days]);
  const offerData = useMemo(() => filter(snap.series.offerCount, days).map((p) => ({ t: p.t, offers: p.v })), [snap, days]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm">Charts</CardTitle>
          <Tabs value={period} onValueChange={setPeriod}>
            <TabsList className="h-8">
              {Object.keys(PERIODS).map((k) => (
                <TabsTrigger key={k} value={k} className="text-xs h-6">{k}{k !== "All" ? "d" : ""}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        <Tabs defaultValue="price">
          <TabsList>
            <TabsTrigger value="price">Price</TabsTrigger>
            <TabsTrigger value="bsr">BSR</TabsTrigger>
            <TabsTrigger value="offers">Offer count</TabsTrigger>
          </TabsList>
          <TabsContent value="price" className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priceData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="t" tickFormatter={fmtDate} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }}
                  labelFormatter={(t: any) => new Date(t).toLocaleDateString()}
                  formatter={(v: any) => `$${Number(v).toFixed(2)}`}
                />
                <Legend />
                <Line type="monotone" dataKey="buyBox" name="Buy Box" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="amazon" name="Amazon" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="fba" name="Lowest FBA" stroke="#10b981" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </TabsContent>
          <TabsContent value="bsr" className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={bsrData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="t" tickFormatter={fmtDate} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis reversed stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }}
                  labelFormatter={(t: any) => new Date(t).toLocaleDateString()}
                  formatter={(v: any) => Number(v).toLocaleString()}
                />
                <Line type="monotone" dataKey="bsr" name="BSR" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </TabsContent>
          <TabsContent value="offers" className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={offerData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="t" tickFormatter={fmtDate} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }}
                  labelFormatter={(t: any) => new Date(t).toLocaleDateString()}
                />
                <Line type="monotone" dataKey="offers" name="New offers" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
