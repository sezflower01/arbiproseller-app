import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import type { AnalyzerSnapshot } from "@/hooks/use-analyzer-snapshot";

const KEYS: Array<{ key: keyof AnalyzerSnapshot["ranksPrices"]; label: string; price?: boolean }> = [
  { key: "bsr", label: "BSR" },
  { key: "buyBox", label: "Buy Box", price: true },
  { key: "amazon", label: "Amazon", price: true },
  { key: "newFba", label: "Lowest FBA", price: true },
  { key: "offerCount", label: "Offer count" },
];

function fmt(v: number | null, isPrice?: boolean) {
  if (v == null) return "—";
  if (isPrice) return `$${v.toFixed(2)}`;
  return v.toLocaleString();
}

export default function RanksPricesPanel({ snap }: { snap: AnalyzerSnapshot }) {
  const fields: Array<keyof AnalyzerSnapshot["ranksPrices"][keyof AnalyzerSnapshot["ranksPrices"]]> = ["current", "avg30", "avg90", "avg180"];
  const labelFor: Record<string, string> = { current: "Current", avg30: "30d", avg90: "90d", avg180: "180d" };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Ranks &amp; Prices</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs defaultValue="current">
          <TabsList className="mx-3 mt-1">
            {fields.map((f) => (
              <TabsTrigger key={f as string} value={f as string} className="text-xs">{labelFor[f as string]}</TabsTrigger>
            ))}
          </TabsList>
          {fields.map((f) => (
            <TabsContent key={f as string} value={f as string} className="m-0">
              <Table>
                <TableBody>
                  {KEYS.map((k) => (
                    <TableRow key={k.key as string}>
                      <TableCell className="text-muted-foreground">{k.label}</TableCell>
                      <TableCell className="text-right font-medium">
                        {fmt(snap.ranksPrices[k.key][f as keyof AnalyzerSnapshot["ranksPrices"][typeof k.key]] as number | null, k.price)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="text-muted-foreground">Keepa BSR Drops (30d)</TableCell>
                    <TableCell className="text-right font-medium">{snap.quickInfo.bsrDrops30 ?? "—"}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">BB Price Changes (30d)</TableCell>
                    <TableCell className="text-right font-medium">{snap.quickInfo.bbPriceChanges30 ?? "—"}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Estimated Sales</TableCell>
                    <TableCell className="text-right font-medium">{snap.quickInfo.estimatedSales}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-muted-foreground">Last Checked</TableCell>
                    <TableCell className="text-right text-xs">{new Date(snap.fetchedAt).toLocaleString()}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
