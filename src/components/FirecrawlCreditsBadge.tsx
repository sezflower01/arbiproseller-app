import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Zap, Loader2, AlertTriangle } from "lucide-react";

interface CreditsData {
  remaining: number | null;
  plan: number | null;
  period_end: string | null;
}

export const FirecrawlCreditsBadge = () => {
  const [data, setData] = useState<CreditsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: res, error: fnErr } = await supabase.functions.invoke("firecrawl-credits");
      if (fnErr) throw fnErr;
      if (res?.error) throw new Error(res.error);
      setData(res as CreditsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  if (loading && !data) {
    return (
      <Badge variant="outline" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        Firecrawl credits…
      </Badge>
    );
  }

  if (error) {
    return (
      <Badge variant="outline" className="gap-1.5 text-destructive border-destructive/40">
        <AlertTriangle className="h-3 w-3" />
        Firecrawl: {error}
      </Badge>
    );
  }

  const remaining = data?.remaining ?? 0;
  const plan = data?.plan ?? 0;
  const pct = plan > 0 ? (remaining / plan) * 100 : 0;
  const tone =
    remaining <= 0 ? "destructive" :
    pct < 10 ? "destructive" :
    pct < 30 ? "warning" :
    "ok";

  const colorClass =
    tone === "destructive" ? "border-destructive/50 text-destructive" :
    tone === "warning" ? "border-amber-500/50 text-amber-600 dark:text-amber-400" :
    "border-primary/40 text-primary";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={`gap-1.5 cursor-default ${colorClass}`}>
            <Zap className="h-3 w-3" />
            {remaining.toLocaleString()} / {plan.toLocaleString()} credits
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1 text-xs">
            <p><strong>Firecrawl credits</strong></p>
            <p>{remaining.toLocaleString()} of {plan.toLocaleString()} remaining ({pct.toFixed(1)}%).</p>
            {data?.period_end && (
              <p className="text-muted-foreground">Resets {new Date(data.period_end).toLocaleDateString()}</p>
            )}
            <p className="text-muted-foreground pt-1">~1 credit per page (2–5 on stealth-proxied sites like Target).</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
