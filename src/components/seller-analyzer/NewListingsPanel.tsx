import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, ExternalLink, Package, Store, Check } from "lucide-react";
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

function CandidateRow({
  candidate,
  isSourced,
  onMarkAsSourced,
}: {
  candidate: SourceCandidate;
  isSourced: boolean;
  onMarkAsSourced: () => void;
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
        <Button type="button" size="sm" variant="outline" onClick={onMarkAsSourced} className="shrink-0">
          Mark as source
        </Button>
      )}
    </div>
  );
}

export default function NewListingsPanel() {
  const { listings, loading, searchingId, monthlySearchCount, eligibility, findSource, markAsSourced } = useSellerNewListings();
  const { toast } = useToast();

  if (!loading && listings.length === 0) return null;

  const onFindSource = async (listingId: string) => {
    try {
      const result = await findSource(listingId);
      if (result.status === "no_candidates") {
        toast({ title: "No likely sources found", description: "This may be a private-label or exclusive listing." });
      }
    } catch (e: any) {
      toast({ title: "Search failed", description: e.message, variant: "destructive" });
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

        <div className="space-y-3">
          {listings.map((listing) => {
            const isSearching = searchingId === listing.id || listing.source_status === "sourcing";
            const showCandidates = listing.source_status === "candidates_found" || listing.source_status === "sourced";
            const showNoCandidates = listing.source_status === "no_candidates";

            return (
              <div key={listing.id} className="border-b last:border-b-0 pb-3 last:pb-0">
                <div className="flex items-center gap-3">
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
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={showCandidates || showNoCandidates ? "outline" : "default"}
                    disabled={isSearching}
                    onClick={() => onFindSource(listing.id)}
                    className="shrink-0"
                  >
                    {isSearching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                    {showCandidates || showNoCandidates ? "Search again" : "Find source"}
                  </Button>
                </div>

                {isSearching && (
                  <div className="mt-3 text-xs text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin" /> Searching for sources…
                  </div>
                )}

                {showNoCandidates && !isSearching && (
                  <div className="mt-3 text-xs text-muted-foreground">
                    No likely sources found — this may be a private-label or exclusive listing.
                  </div>
                )}

                {showCandidates && !isSearching && listing.candidates && listing.candidates.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {listing.candidates.map((c) => (
                      <CandidateRow
                        key={c.url}
                        candidate={c}
                        isSourced={listing.source_status === "sourced" && listing.sourced_candidate?.url === c.url}
                        onMarkAsSourced={() => onMarkAsSourced(listing.id, c)}
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
        </div>
      </CardContent>
    </Card>
  );
}
