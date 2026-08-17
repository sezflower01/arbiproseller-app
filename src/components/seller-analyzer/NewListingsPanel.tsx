import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Loader2, ExternalLink, Package, Store, Check, X, Trash2 } from "lucide-react";
import { useSellerNewListings, type SourceCandidate } from "@/hooks/use-seller-new-listings";
import EligibilityBadge from "@/components/common/EligibilityBadge";
import { useToast } from "@/hooks/use-toast";

const MARKETPLACE_DOMAIN: Record<string, string> = {
  US: "amazon.com", CA: "amazon.ca", MX: "amazon.com.mx", BR: "amazon.com.br",
  UK: "amazon.co.uk", GB: "amazon.co.uk", DE: "amazon.de", FR: "amazon.fr",
  IT: "amazon.it", ES: "amazon.es", JP: "amazon.co.jp", IN: "amazon.in",
};
function amazonListingUrl(asin: string, marketplace: string): string {
  const host = MARKETPLACE_DOMAIN[marketplace.toUpperCase()] || "amazon.com";
  return `https://www.${host}/dp/${asin}`;
}

/**
 * The seller's STOREFRONT (their listings), not their profile page.
 *
 * Two shapes exist in this codebase: send-email uses `/sp?seller=` (the
 * profile, with feedback and business details) and OffersTable uses
 * merchant-items (their actual catalogue). From a new-listing row the useful
 * destination is what else they are selling, so this follows OffersTable --
 * but marketplace-aware, where that one hardcodes amazon.com and a US
 * marketplace id.
 */
function amazonStorefrontUrl(sellerId: string, marketplace: string): string {
  const host = MARKETPLACE_DOMAIN[marketplace.toUpperCase()] || "amazon.com";
  return `https://www.${host}/s?i=merchant-items&me=${encodeURIComponent(sellerId)}`;
}

function CandidateRow({
  candidate,
  isSourced,
  onMarkAsSourced,
  onReject,
}: {
  candidate: SourceCandidate;
  isSourced: boolean;
  onMarkAsSourced: () => void;
  onReject: () => void;
}) {
  const badgeClass = candidate.confidence >= 60
    ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-transparent"
    : "bg-muted text-muted-foreground border-transparent";

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center text-muted-foreground shrink-0 overflow-hidden">
        {candidate.imageUrl ? (
          <img src={candidate.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Store className="h-4 w-4" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{candidate.domain}</div>
        <div className="text-xs text-muted-foreground">
          {candidate.price != null ? `$${candidate.price.toFixed(2)}` : "Price not confirmed"} · {candidate.reason}
        </div>
      </div>
      <Badge className={badgeClass}>{candidate.label} · {candidate.confidence}%</Badge>
      <a href={candidate.url} target="_blank" rel="noreferrer" className="text-primary shrink-0" aria-label="View listing">
        <ExternalLink className="h-4 w-4" />
      </a>
      {isSourced ? (
        <Button type="button" size="sm" variant="secondary" disabled className="shrink-0">
          <Check className="h-4 w-4 mr-1" /> Source
        </Button>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <Button type="button" size="sm" variant="outline" onClick={onMarkAsSourced}>
            Mark as source
          </Button>
          {/* Ruling a candidate OUT is the more common judgement, and it is one
              the scorer cannot make: "right product, wrong seller" still scores
              as a strong text and image match. */}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={onReject}
            title="Not a source — hide this and exclude it from future searches"
            aria-label="Not a source"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default function NewListingsPanel() {
  const { done, pending, doneTotal, loading, monthlySearchCount, eligibility, sellerNames, markAsSourced, rejectCandidate, deleteListings } = useSellerNewListings();
  const [tab, setTab] = useState("done");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const { toast } = useToast();

  const doneIds = done.map((l) => l.id);
  const allDoneSelected = doneIds.length > 0 && doneIds.every((id) => selected.has(id));
  // Only the 50 loaded rows can ever be selected, so the panel says so rather
  // than letting "Select all" imply it reached all 213.
  const doneTruncated = doneTotal > done.length;

  const toggleAllDone = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of doneIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const removeIds = async (ids: string[], label: string) => {
    setRemoving(true);
    try {
      const n = await deleteListings(ids);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      toast({ title: `${label} ${n.toLocaleString()} listing${n === 1 ? "" : "s"}` });
    } catch (e) {
      toast({ title: "Could not remove listings", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRemoving(false);
    }
  };

  if (!loading && done.length === 0 && pending.length === 0) return null;

  const onReject = async (listingId: string, candidate: SourceCandidate) => {
    try {
      await rejectCandidate(listingId, candidate);
      toast({ title: "Marked as not a source", description: `${candidate.domain} won't be suggested again for this listing.` });
    } catch (e: any) {
      toast({ title: "Could not update", description: e.message, variant: "destructive" });
    }
  };

  const onMarkAsSourced = async (listingId: string, candidate: SourceCandidate) => {
    try {
      await markAsSourced(listingId, candidate);
      toast({ title: "Source saved" });
    } catch (e: any) {
      toast({ title: "Could not save source", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">New listings</h2>
          <div className="text-xs text-muted-foreground">{monthlySearchCount} source search{monthlySearchCount === 1 ? "" : "es"} used this month</div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-3">
            <TabsTrigger value="done" className="gap-2">
              Done
              {done.length > 0 && <Badge variant="secondary">{done.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="searching" className="gap-2">
              Searching
              {pending.length > 0 && <Badge variant="secondary">{pending.length}</Badge>}
            </TabsTrigger>
          </TabsList>

          {(["done", "searching"] as const).map((key) => {
            const rows = key === "done" ? done : pending;
            return (
              <TabsContent key={key} value={key} className="mt-0 space-y-3">
                {/* Bulk clearing is a Done-tab action. Deleting a queued row
                    would also stop it ever being searched, which is a different
                    decision from discarding a finished result. */}
                {key === "done" && rows.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <Checkbox
                        checked={allDoneSelected}
                        onCheckedChange={(v) => toggleAllDone(v === true)}
                        aria-label="Select all listings shown"
                      />
                      <span>
                        Select all shown ({done.length.toLocaleString()})
                        {doneTruncated && (
                          <span className="text-muted-foreground">
                            {" "}of {doneTotal.toLocaleString()}
                          </span>
                        )}
                      </span>
                    </label>

                    {selected.size > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{selected.size.toLocaleString()} selected</span>
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>
                          Clear
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="destructive" size="sm" className="h-7 text-xs" disabled={removing}>
                              {removing && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                              Remove {selected.size.toLocaleString()}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Delete {selected.size.toLocaleString()} listing{selected.size === 1 ? "" : "s"}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                Permanently deleted, along with their source candidates. They will not
                                come back on the next seller check — detection compares against each
                                seller's known-ASIN baseline, which already includes them. This cannot
                                be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => removeIds(Array.from(selected), "Deleted")}>
                                Delete {selected.size.toLocaleString()}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>
                )}

                {key === "done" && doneTruncated && (
                  <p className="text-xs text-muted-foreground">
                    Showing the {done.length} most recent of {doneTotal.toLocaleString()}. Remove these
                    to reveal older ones.
                  </p>
                )}

                {rows.length === 0 && (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    {key === "done"
                      ? "No completed searches yet. Results appear here once the worker has looked for sources."
                      : "Nothing queued — every detected listing has been searched."}
                  </p>
                )}
                {rows.map((listing) => {
            const showCandidates = listing.source_status === "candidates_found" || listing.source_status === "sourced";
            const showNoCandidates = listing.source_status === "no_candidates";

            return (
              <div key={listing.id} className="border-b last:border-b-0 pb-3 last:pb-0">
                <div className="flex items-center gap-3">
                  {key === "done" && (
                    <Checkbox
                      checked={selected.has(listing.id)}
                      onCheckedChange={(v) => toggleOne(listing.id, v === true)}
                      aria-label={`Select ${listing.title || listing.asin}`}
                      className="shrink-0"
                    />
                  )}
                  <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-muted-foreground shrink-0 overflow-hidden">
                    {listing.image_url ? (
                      <img src={listing.image_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Package className="h-4 w-4" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">{listing.title || listing.asin}</span>
                      {/* Gating is the first triage question -- a restricted
                          ASIN is worth nothing however good the source is --
                          so it sits beside the title, not below the fold. */}
                      <EligibilityBadge status={eligibility[listing.asin]} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <a
                        href={amazonListingUrl(listing.asin, listing.marketplace)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {listing.asin}
                      </a>
                      {" "}· detected {new Date(listing.detected_at).toLocaleString()}
                    </div>
                    {/* Which seller listed it. With hundreds of watched
                        sellers the row is otherwise anonymous, and "who is
                        selling this" is the first thing needed to judge it --
                        falls back to the raw id when the name has not been
                        filled in yet. */}
                    <div className="text-xs text-muted-foreground">
                      from{" "}
                      <a
                        href={amazonStorefrontUrl(listing.seller_id, listing.marketplace)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                        title="Open this seller's storefront on Amazon"
                      >
                        <Store className="h-3 w-3" />
                        {sellerNames[`${listing.seller_id}|${listing.marketplace}`] || listing.seller_id}
                      </a>
                      {" "}({listing.marketplace})
                    </div>
                  </div>
                  {/* Searches run automatically on a separate worker; there is
                      no manual trigger. A listing sitting at 'unsourced' is
                      queued, not stuck -- saying so is the difference between
                      waiting and wondering. */}
                  {!showCandidates && !showNoCandidates && (
                    listing.source_status === "sourcing" ? (
                      <span className="text-xs text-muted-foreground shrink-0 inline-flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                      </span>
                    ) : (
                      // 'unsourced' means waiting for a slot, not in flight. A
                      // spinner here claimed work that was not happening --
                      // with 204 rows behind a daily cap, most of these will
                      // wait hours or expire unsearched.
                      <span className="text-xs text-muted-foreground shrink-0">Queued</span>
                    )
                  )}

                  {/* Single-row delete. No confirm: one row is cheap to lose and
                      the bulk path is where an accident would actually hurt. */}
                  {key === "done" && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={removing}
                      onClick={() => removeIds([listing.id], "Deleted")}
                      title="Delete this listing permanently"
                      aria-label={`Delete ${listing.title || listing.asin}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {showNoCandidates && (
                  <div className="mt-3 text-xs text-muted-foreground">
                    No likely sources found — this may be a private-label or exclusive listing.
                  </div>
                )}

                {showCandidates && listing.candidates && listing.candidates.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {listing.candidates.map((c) => (
                      <CandidateRow
                        key={c.url}
                        candidate={c}
                        isSourced={listing.source_status === "sourced" && listing.sourced_candidate?.url === c.url}
                        onMarkAsSourced={() => onMarkAsSourced(listing.id, c)}
                        onReject={() => onReject(listing.id, c)}
                      />
                    ))}
                    <div className="text-xs text-muted-foreground">
                      Confidence is AI-assisted and capped below 100%. Open the listing and check price and stock before buying.
                    </div>
                  </div>
                )}
              </div>
                );
                })}
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
