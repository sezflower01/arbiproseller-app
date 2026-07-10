import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Copy, Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface QueryPreset {
  name: string;
  description: string;
  category: "health" | "optimization" | "outcome";
  sql: string;
  /** Function to build the actual SQL with time range substituted */
  buildSql?: (range: string) => string;
  /** Friendly message when query returns no results (healthy empty state) */
  emptyMessage?: string;
}

interface QueryPresetCardProps {
  preset: QueryPreset;
}

const RANGES: Record<string, string> = {
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
  "3d": "3 days",
  "7d": "7 days",
  "30d": "30 days",
};

export default function QueryPresetCard({ preset }: QueryPresetCardProps) {
  const [range, setRange] = useState("24h");
  const [results, setResults] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);

  const activeSql = preset.buildSql
    ? preset.buildSql(RANGES[range])
    : preset.sql.replace(/:range/g, RANGES[range]);

  const handleRun = async () => {
    setLoading(true);
    setResults(null);
    try {
      const { data, error } = await supabase.rpc("run_analytics_query" as any, {
        query_text: activeSql,
      });
      if (error) {
        console.error("[Analytics] RPC error:", error);
        throw error;
      }
      // run_analytics_query returns jsonb — could be an array or null
      const rows = Array.isArray(data) ? data : (data ? [data] : []);
      setResults(rows);
      if (rows.length === 0) {
        toast.info("Query returned no results");
      }
    } catch (err: any) {
      console.error("[Analytics] Query failed:", err);
      toast.error(`Query failed: ${err.message || "Unknown error"}`);
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(activeSql);
    setCopied(true);
    toast.success("SQL copied");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyResults = () => {
    if (!results) return;
    const text = JSON.stringify(results, null, 2);
    navigator.clipboard.writeText(text);
    toast.success("Results copied");
  };

  return (
    <Card className="border-border/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base">{preset.name}</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">{preset.description}</p>
          </div>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {preset.category}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="w-[100px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RANGES).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 text-xs gap-1" onClick={handleRun} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={handleCopy}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            SQL
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs gap-1"
            onClick={() => setShowSql(!showSql)}
          >
            {showSql ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showSql ? "Hide" : "Show"} SQL
          </Button>
        </div>

        {/* SQL preview */}
        {showSql && (
          <pre className="text-[11px] bg-muted/30 rounded p-3 overflow-x-auto whitespace-pre-wrap font-mono text-muted-foreground max-h-48 overflow-y-auto">
            {activeSql}
          </pre>
        )}

        {/* Results */}
        {results && results.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{results.length} row(s)</span>
              <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={handleCopyResults}>
                <Copy className="h-3 w-3 mr-1" /> Copy
              </Button>
            </div>
            <div className="overflow-x-auto rounded border border-border/30">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/30 bg-muted/20">
                    {Object.keys(results[0]).map((k) => (
                      <th key={k} className="text-left px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap">
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.slice(0, 50).map((row, i) => (
                    <tr key={i} className="border-b border-border/10 hover:bg-muted/10">
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
            {results.length > 50 && (
              <p className="text-[10px] text-muted-foreground">Showing 50 of {results.length} rows</p>
            )}
          </div>
        )}

        {results && results.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            {preset.emptyMessage || "No results"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
