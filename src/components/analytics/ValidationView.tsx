import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Play, Copy } from "lucide-react";
import { toast } from "sonner";

const VALIDATION_QUERIES = [
  {
    name: "Before vs After (72h)",
    sql: `WITH recent AS (
  SELECT * FROM repricer_price_actions WHERE user_id = auth.uid() AND created_at >= NOW() - INTERVAL '36 hours'
), prior AS (
  SELECT * FROM repricer_price_actions WHERE user_id = auth.uid() AND created_at >= NOW() - INTERVAL '72 hours' AND created_at < NOW() - INTERVAL '36 hours'
)
SELECT 'Last 36h' AS period, COUNT(*) AS total, COUNT(*) FILTER (WHERE action_type = 'price_changed') AS writes, COUNT(*) FILTER (WHERE action_type = 'no_change') AS holds, COUNT(*) FILTER (WHERE action_type = 'blocked_by_profit_guard') AS profit_guard, ROUND(100.0 * COUNT(*) FILTER (WHERE action_type = 'price_changed') / NULLIF(COUNT(*), 0), 1) AS write_pct FROM recent
UNION ALL
SELECT 'Prior 36h', COUNT(*), COUNT(*) FILTER (WHERE action_type = 'price_changed'), COUNT(*) FILTER (WHERE action_type = 'no_change'), COUNT(*) FILTER (WHERE action_type = 'blocked_by_profit_guard'), ROUND(100.0 * COUNT(*) FILTER (WHERE action_type = 'price_changed') / NULLIF(COUNT(*), 0), 1) FROM prior`,
  },
  {
    name: "BB Win/Loss Now",
    sql: `SELECT COALESCE(last_buybox_status, 'unknown') AS status, COUNT(*) AS count FROM repricer_assignments WHERE is_enabled = true AND rule_id IS NOT NULL GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Top Constraints (72h)",
    sql: `SELECT
  CASE
    WHEN reason ILIKE '%min_price%' THEN 'Min Floor'
    WHEN reason ILIKE '%profit_guard%' OR reason ILIKE '%blocked_by_profit%' THEN 'Profit Guard'
    WHEN reason ILIKE '%BB owner protection%' THEN 'BB Owner Hold'
    WHEN reason ILIKE '%cooldown%' THEN 'Cooldown'
    WHEN reason ILIKE '%No eligible%' THEN 'No Competitors'
    ELSE 'Other'
  END AS constraint_type, COUNT(*) AS count
FROM repricer_price_actions
WHERE user_id = auth.uid() AND created_at >= NOW() - INTERVAL '72 hours' AND action_type IN ('no_change', 'blocked_by_profit_guard', 'oscillation_guard')
GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Price Movement (72h)",
    sql: `SELECT
  CASE WHEN new_price > old_price THEN 'Raised' WHEN new_price < old_price THEN 'Lowered' ELSE 'Unchanged' END AS direction,
  COUNT(*) AS count,
  ROUND(AVG(ABS(new_price - old_price))::numeric, 2) AS avg_delta
FROM repricer_price_actions
WHERE user_id = auth.uid() AND created_at >= NOW() - INTERVAL '72 hours' AND action_type = 'price_changed' AND old_price > 0
GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Error Count (72h)",
    sql: `SELECT COUNT(*) FILTER (WHERE action_type = 'price_change_failed') AS failed, COUNT(*) FILTER (WHERE action_type = 'oscillation_guard') AS osc_guard, COUNT(*) AS total FROM repricer_price_actions WHERE user_id = auth.uid() AND created_at >= NOW() - INTERVAL '72 hours'`,
  },
];

export default function ValidationView() {
  const [results, setResults] = useState<Record<string, any[] | null>>({});
  const [loading, setLoading] = useState(false);

  const runAll = async () => {
    setLoading(true);
    setResults({});
    const newResults: Record<string, any[] | null> = {};

    for (const q of VALIDATION_QUERIES) {
      try {
        const { data, error } = await supabase.rpc("run_analytics_query" as any, { query_text: q.sql });
        if (error) {
          console.error(`[Validation] ${q.name} error:`, error);
          newResults[q.name] = null;
          continue;
        }
        newResults[q.name] = Array.isArray(data) ? data : data ? [data] : [];
      } catch {
        newResults[q.name] = null;
      }
    }

    setResults(newResults);
    setLoading(false);
    toast.success("Validation complete");
  };

  const copyAll = () => {
    const lines = Object.entries(results).map(([name, rows]) => {
      if (!rows) return `## ${name}\nError\n`;
      return `## ${name}\n${JSON.stringify(rows, null, 2)}\n`;
    });
    navigator.clipboard.writeText(`# 72h Validation Report\n${new Date().toISOString()}\n\n${lines.join("\n")}`);
    toast.success("Report copied");
  };

  return (
    <Card className="border-border/40 mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">72h Post-Deploy Validation</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Run all key queries at once to compare before/after engine changes</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-xs gap-1" onClick={runAll} disabled={loading}>
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run All
            </Button>
            {Object.keys(results).length > 0 && (
              <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={copyAll}>
                <Copy className="h-3 w-3" /> Copy Report
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {Object.entries(results).map(([name, rows]) => (
          <div key={name} className="space-y-1">
            <h4 className="text-xs font-medium">{name}</h4>
            {rows === null ? (
              <p className="text-xs text-destructive">Query failed</p>
            ) : rows.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No results</p>
            ) : (
              <div className="overflow-x-auto rounded border border-border/30">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/30 bg-muted/20">
                      {Object.keys(rows[0]).map((k) => (
                        <th key={k} className="text-left px-2 py-1 font-medium text-muted-foreground whitespace-nowrap">{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-border/10">
                        {Object.values(row).map((v: any, j) => (
                          <td key={j} className="px-2 py-1 whitespace-nowrap font-mono">
                            {v === null ? <span className="text-muted-foreground/50">null</span> : String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        {Object.keys(results).length === 0 && !loading && (
          <p className="text-xs text-muted-foreground text-center py-4">Press "Run All" to generate the 72h validation report</p>
        )}
      </CardContent>
    </Card>
  );
}
