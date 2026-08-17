import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, Plus, X } from "lucide-react";
import { useExcludedDomains } from "@/hooks/use-excluded-domains";
import { useToast } from "@/hooks/use-toast";

/**
 * Domains Find Source must never return.
 *
 * Applies to both search passes — the allowlist pass and the trusted-supplier
 * fallback — because the filter lives in the shared search step rather than
 * being repeated per pass.
 */
export default function ExcludedDomainsPanel() {
  const { domains, staleCount, loading, busy, addDomain, removeDomain, purgeStale } = useExcludedDomains();
  const [newDomain, setNewDomain] = useState("");
  const { toast } = useToast();

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    try {
      await addDomain(newDomain);
      setNewDomain("");
    } catch (err) {
      toast({ title: "Could not exclude domain", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handlePurge = async () => {
    try {
      const n = await purgeStale();
      toast({ title: `Removed ${n.toLocaleString()} listing${n === 1 ? "" : "s"}` });
    } catch (err) {
      toast({ title: "Could not clean up", description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Never search these</h2>
          <span className="text-xs text-muted-foreground">{domains.length} excluded</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Blocked in both the retailer search and the trusted-supplier fallback. A domain listed
          here is excluded even if it also appears in your retailers above.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : domains.length === 0 ? (
          <p className="text-xs text-muted-foreground py-3">
            Nothing excluded. Resale marketplaces are the usual candidates.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <Badge key={d.id} variant="secondary" className="gap-1 pr-1 font-normal">
                {d.label || d.domain}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    removeDomain(d.id).catch((e) =>
                      toast({ title: "Could not remove", description: (e as Error).message, variant: "destructive" }),
                    )
                  }
                  className="rounded-sm hover:text-destructive disabled:opacity-50"
                  aria-label={`Stop excluding ${d.domain}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <form onSubmit={handleAdd} className="flex gap-2">
          <Input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="exclude a site, e.g. depop.com"
            className="h-9 text-sm"
            disabled={busy}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !newDomain.trim()}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Exclude
          </Button>
        </form>

        {/* Adding an exclusion only changes FUTURE searches -- results already
            stored keep showing the links they were saved with. This is the
            catch-up pass, and it appears only when there is something to
            catch up on. */}
        {staleCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground min-w-0">
              {staleCount.toLocaleString()} saved result{staleCount === 1 ? " has" : "s have"} only
              excluded sources.
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={busy}>
                  {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  Clean up {staleCount.toLocaleString()}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Delete {staleCount.toLocaleString()} listing{staleCount === 1 ? "" : "s"}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Every candidate on these came from a domain you now exclude, so nothing usable
                    is left on them. Listings with at least one allowed candidate are kept, and
                    anything you marked as sourced is never touched. Permanent, and they will not
                    be re-detected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handlePurge}>
                    Delete {staleCount.toLocaleString()}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
