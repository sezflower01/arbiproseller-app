import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, PieChart, Pie, Cell, Legend } from "recharts";
import type { SellerProductCard } from "@/hooks/use-seller-snapshot";

const COLORS = ["hsl(var(--primary))", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#0ea5e9", "#f97316"];

export default function SellerCharts({
  topBrands,
  topCategories,
  items,
}: {
  topBrands: { name: string; count: number }[];
  topCategories: { name: string; count: number }[];
  items: SellerProductCard[];
}) {
  // Price-band histogram
  const bands = [
    { label: "<$10", min: 0, max: 10 },
    { label: "$10-25", min: 10, max: 25 },
    { label: "$25-50", min: 25, max: 50 },
    { label: "$50-100", min: 50, max: 100 },
    { label: "$100+", min: 100, max: Infinity },
  ];
  const histo = bands.map((b) => ({
    band: b.label,
    count: items.filter((i) => (i.buyBox ?? i.newPrice ?? 0) >= b.min && (i.buyBox ?? i.newPrice ?? 0) < b.max).length,
  }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Top Brands</CardTitle></CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topBrands} layout="vertical" margin={{ left: 10, right: 10 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Categories</CardTitle></CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={topCategories} dataKey="count" nameKey="name" outerRadius={80} innerRadius={40}>
                {topCategories.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 10 }} />
            </PieChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Price bands (this page)</CardTitle></CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={histo}>
              <XAxis dataKey="band" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
