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
import { Loader2, ExternalLink, Package, Search, Trash2, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useSellerNewListings, type NewListing } from "@/hooks/use-seller-new-listings";
import EligibilityBadge from "@/components/common/EligibilityBadge";
import { useToast } from "@/hooks/use-toast";

/**
 * Manual source search, replacing the automated pipeline removed 2026-08-19.
 *
 * TITLE ONLY, deliberately -- not the UPC. Measured: UPC search is precise but
 * low-recall, because most retail pages show the product NAME prominently and
 * never print the raw UPC in indexable text. On a live check a UPC query matched
 * only two foreign resellers while the title alone found walmart.com and
 * bathandbodyworks.com directly.
 *
 * Opens in a new tab. rel="noopener" matters: without it the opened page gets a
 * handle back to this one via window.opener.
 */
function googleSearchUrl(title: string | null): string | null {
  const q = (title ?? "").trim();
  if (!q) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/** Amazon sell price, captured during detection by a Keepa call that already runs. */
function formatAmazonPrice(l: NewListing): string | null {
  const cents = l.new_price_cents ?? l.amazon_price_cents;
  if (typeof cents !== "number" || cents <= 0) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

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

/**
 * Turn a stored disqualified_reason into something a person can act on.
 *
 * The raw values carry a payload after a colon (`excluded_group:dvd`,
 * `rank_over_500000:1254159`) because the worker records what it actually saw
 * rather than a generic label -- that detail is the difference between "some
 * rule blocked this" and "this is rank 1.2M, far past your ceiling".
 */
function formatDisqualifiedReason(raw: string | null): string {
  if (!raw) return "Not searchable";
  const [kind, detail] = raw.split(":");
  switch (kind) {
    case "restricted":
      return "Restricted — cannot be sold";
    case "needs_approval_excluded":
      return "Needs approval — excluded by your setting";
    case "no_upc":
      return "No UPC — nothing to search with";
    case "excluded_group":
      return `Excluded category${detail ? `: ${detail}` : ""}`;
    case "rank_over_500000":
      return detail
        ? `Sales rank ${Number(detail).toLocaleString()} — over the 500,000 limit`
        : "Sales rank over the limit";
    case "expired":
      return "Expired unsearched after 5 days";
    default:
      return raw;
  }
}


export default function NewListingsPanel() {
  const { done, pending, doneTotal, pendingTotal, loading, eligibility, sellerNames, deleteListings, deleteByStatus } = useSellerNewListings();
  const [tab, setTab] = useState("done");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const { toast } = useToast();

  // Selection is cleared when the tab changes. One Set backs both tabs, and a
  // "Remove 40" that silently included rows from the tab you are not looking at
  // is exactly the kind of surprise a delete button must never spring.
  const changeTab = (v: string) => {
    setTab(v);
    setSelected(new Set());
  };

  const toggleAll = (ids: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
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

  const purge = async (statuses: Parameters<typeof deleteByStatus>[0], label: string) => {
    setRemoving(true);
    try {
      const n = await deleteByStatus(statuses);
      setSelected(new Set());
      toast({ title: `Deleted ${n.toLocaleString()} ${label}` });
    } catch (e) {
      toast({ title: "Could not delete listings", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRemoving(false);
    }
  };

  // Deliberately NOT returning null when empty. The panel used to vanish
  // entirely with no listings, which made the ROI filter look unbuilt rather
  // than un-fed -- and "empty" is the EXPECTED state for days after re-seeding
  // a watchlist, since a seller's first check records a baseline and produces
  // no listings by design. The controls stay visible and the content area says
  // what is actually happening.
  const isEmpty = !loading && done.length === 0 && pending.length === 0;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">New listings</h2>
        </div>

        <Tabs value={tab} onValueChange={changeTab}>
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
            const isDone = key === "done";
            const rows = isDone ? done : pending;
            const total = isDone ? doneTotal : pendingTotal;
            // A row with qualified === false will NEVER be searched -- the
            // auto-source worker filters on .eq('qualified', true). Listing it
            // as "Queued" promised work that was never going to happen, which
            // is what made a DVD-heavy seller look like it was flooding the
            // search budget when in fact none of those rows were reachable.
            // Measured 2026-08-17: 2,383 of 2,484 rows are disqualified.
            //
            // Separated rather than hidden: "why is this listing not being
            // searched" is a real question, and disqualified_reason has been
            // stored on every row all along without ever being shown.
            const blocked = isDone ? [] : rows.filter((l) => l.qualified === false);
            let shown = isDone ? rows : rows.filter((l) => l.qualified !== false);

            const ids = rows.map((l) => l.id);
            const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
            // Only the loaded rows can ever be selected, so the label says so
            // rather than letting "Select all" imply it reached all of them.
            const truncated = total > rows.length;
            return (
              <TabsContent key={key} value={key} className="mt-0 space-y-3">
                {rows.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(v) => toggleAll(ids, v === true)}
                        aria-label="Select all listings shown"
                      />
                      <span>
                        Select all shown ({rows.length.toLocaleString()})
                        {truncated && (
                          <span className="text-muted-foreground">
                            {" "}of {total.toLocaleString()}
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
                                {isDone
                                  ? "Permanently deleted, along with their source candidates."
                                  : "Permanently deleted before they are searched, so they will not spend any of your daily source-search budget."}
                                {" "}They will not come back on the next seller check — detection
                                compares against each seller's known-ASIN baseline, which already
                                includes them. This cannot be undone.
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

                {/* Clearing a backlog by predicate, not by selection. These act
                    on every matching row in the database, so they are unaffected
                    by how many are loaded -- which is the whole point: selecting
                    rows first would mean loading hundreds of the fattest rows in
                    the table purely to delete them. */}
                {/* Clear the whole queue by predicate, independent of what is
                    loaded. Deleting queued rows also reclaims search budget --
                    each one the worker never reaches is a search not spent. */}
                {!isDone && pendingTotal > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Clear in bulk:</span>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={removing}>
                          Everything queued ({pendingTotal.toLocaleString()})
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete all {pendingTotal.toLocaleString()} queued listing{pendingTotal === 1 ? "" : "s"}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            None of these have been searched yet, so nothing found is lost and none
                            of your daily search budget is spent on them. Finished results on the
                            Done tab are not affected. Permanent, and they will not be re-detected.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => purge(["unsourced", "sourcing"], "queued listings")}>
                            Delete {pendingTotal.toLocaleString()}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}

                {isDone && doneTotal > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Clear in bulk:</span>


                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={removing}>
                          Everything done ({doneTotal.toLocaleString()})
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete all {doneTotal.toLocaleString()} finished listing{doneTotal === 1 ? "" : "s"}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This includes listings with source candidates and any you marked as
                            sourced — their saved sources go too. Permanent, and they will not be
                            re-detected. Queued listings on the Searching tab are not affected.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => purge(["candidates_found", "sourced", "no_candidates"], "finished listings")}>
                            Delete {doneTotal.toLocaleString()}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}

                {truncated && (
                  <p className="text-xs text-muted-foreground">
                    Showing the {rows.length} most recent of {total.toLocaleString()}. Remove these
                    to reveal older ones, or use the bulk clear above.
                  </p>
                )}

                {rows.length === 0 && (
                  <div className="py-8 text-center text-xs text-muted-foreground space-y-1">
                    {isEmpty ? (
                      <>
                        <p className="font-medium text-foreground">No listings yet — seeding in progress</p>
                        <p>
                          A seller's first check records what they already sell; only the SECOND
                          check can show something new. Monitoring runs midnight–6am Pacific.
                        </p>
                        <p>The filter above is live and will apply as soon as listings arrive.</p>
                      </>
                    ) : (
                      <p>
                        {key === "done"
                          ? "No completed searches yet. Results appear here once the worker has looked for sources."
                          : "Nothing queued — every detected listing has been searched."}
                      </p>
                    )}
                  </div>
                )}
                {shown.map((listing) => {

            return (
              <div key={listing.id} className="border-b last:border-b-0 pb-3 last:pb-0">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={selected.has(listing.id)}
                    onCheckedChange={(v) => toggleOne(listing.id, v === true)}
                    aria-label={`Select ${listing.title || listing.asin}`}
                    className="shrink-0"
                  />
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
                    {/* Amazon sell price, kept from the automated era because
                        it costs nothing -- check-seller-watchlist captures it
                        from a Keepa call it already makes. It is the quick
                        "is this worth clicking" signal now that ROI is judged
                        manually after opening the search. */}
                    {formatAmazonPrice(listing) && (
                      <div className="text-xs">
                        <span className="font-medium">{formatAmazonPrice(listing)}</span>
                        <span className="text-muted-foreground"> on Amazon</span>
                      </div>
                    )}
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
                  {/* Manual search, replacing the automated pipeline. Title
                      only -- see googleSearchUrl. Disabled rather than hidden
                      when there is no title yet, so the row does not silently
                      lose its action: SP-API sometimes resolves the title a
                      cycle after detection. */}
                  {googleSearchUrl(listing.title) ? (
                    <Button asChild type="button" size="sm" variant="outline" className="shrink-0">
                      <a
                        href={googleSearchUrl(listing.title)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Search Google for this product title"
                      >
                        <Search className="h-3.5 w-3.5 mr-1" /> Search on Google
                      </a>
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0" title="No title captured yet">
                      No title yet
                    </span>
                  )}

                  {/* Single-row delete. No confirm: one row is cheap to lose and
                      the bulk path is where an accident would actually hurt. */}
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
                </div>

              </div>
                );
                })}

                {blocked.length > 0 && (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50"
                      >
                        <span>
                          {blocked.length.toLocaleString()} not searchable — these will never be
                          searched
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2 divide-y rounded-md border">
                      {/* Compact deliberately: a row that will never be searched
                          has no candidates to show and no source to mark, so the
                          full layout would be mostly empty controls. */}
                      {blocked.map((listing) => (
                        <div key={listing.id} className="flex items-center gap-3 px-3 py-2">
                          <Checkbox
                            checked={selected.has(listing.id)}
                            onCheckedChange={(v) => toggleOne(listing.id, v === true)}
                            aria-label={`Select ${listing.title || listing.asin}`}
                            className="shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate text-sm">{listing.title || listing.asin}</span>
                              <EligibilityBadge status={eligibility[listing.asin]} />
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              <a
                                href={amazonListingUrl(listing.asin, listing.marketplace)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                              >
                                {listing.asin}
                              </a>
                              {" "}· {formatDisqualifiedReason(listing.disqualified_reason)}
                            </div>
                          </div>
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
                        </div>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
