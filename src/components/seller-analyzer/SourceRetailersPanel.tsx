import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, X } from "lucide-react";
import { useSourceRetailers } from "@/hooks/use-source-retailers";
import { useToast } from "@/hooks/use-toast";

interface Props {
  fallbackEnabled: boolean;
  fallbackSaving: boolean;
  onFallbackChange: (v: boolean) => void;
}

/**
 * Which retailers Find Source searches, and how well each performs.
 *
 * The hit-rate column is the point of the panel: the seed list is a starting
 * guess, and the only honest way to decide whether a retailer earns its slot is
 * to watch how often it actually yields a price. Rates are shown only once a
 * domain has been tried, so an untouched retailer reads as "no data" rather
 * than a misleading 0%.
 */
export default function SourceRetailersPanel({ fallbackEnabled, fallbackSaving, onFallbackChange }: Props) {
  const { retailers, loading, busy, setEnabled, addRetailer, removeRetailer } = useSourceRetailers();
  const [newDomain, setNewDomain] = useState("");
  const { toast } = useToast();

  const enabledCount = retailers.filter((r) => r.enabled).length;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    try {
      await addRetailer(newDomain);
      setNewDomain("");
    } catch (err) {
      toast({ title: "Could not add retailer", description: (err as Error).message, variant: "destructive" });
    }
  };

  const guard = (p: Promise<unknown>) =>
    p.catch((err) => toast({ title: "Could not save", description: (err as Error).message, variant: "destructive" }));

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Retailers to search</h2>
          <span className="text-xs text-muted-foreground">{enabledCount} active</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Source searches are restricted to these sites first. Turn one off to stop searching it
          without losing its history.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading retailers…
          </div>
        ) : retailers.length === 0 ? (
          <p className="text-xs text-muted-foreground py-3">
            No retailers configured — every search will use the fallback below.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {retailers.map((r) => {
              const tried = r.price_attempts;
              const pct = tried > 0 ? Math.round((r.price_success / tried) * 100) : null;
              return (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                  <Switch
                    checked={r.enabled}
                    disabled={busy}
                    onCheckedChange={(v) => guard(setEnabled(r.id, v))}
                    aria-label={`Search ${r.domain}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{r.label || r.domain}</div>
                    <div className="truncate text-xs text-muted-foreground">{r.domain}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    {pct === null ? (
                      <span className="text-xs text-muted-foreground">no data</span>
                    ) : (
                      <Badge variant={pct >= 60 ? "default" : pct >= 25 ? "secondary" : "outline"}>
                        {pct}% price
                      </Badge>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {r.search_hits} found{tried > 0 ? ` · ${r.price_success}/${tried} priced` : ""}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    disabled={busy}
                    onClick={() => guard(removeRetailer(r.id))}
                    aria-label={`Remove ${r.domain}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={handleAdd} className="flex gap-2">
          <Input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="add a retailer, e.g. zoro.com"
            className="h-9 text-sm"
            disabled={busy}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !newDomain.trim()}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </form>

        <div className="flex items-start justify-between gap-4 border-t pt-3">
          <div className="min-w-0">
            <div className="text-sm">Fall back to trusted suppliers</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              When none of the retailers above stock a product, search more widely and keep only
              results from your curated supplier list. Turn this off to search the retailers above
              and nothing else.
            </p>
          </div>
          <Switch
            checked={fallbackEnabled}
            disabled={fallbackSaving}
            onCheckedChange={onFallbackChange}
            aria-label="Fall back to trusted suppliers"
          />
        </div>
      </CardContent>
    </Card>
  );
}
