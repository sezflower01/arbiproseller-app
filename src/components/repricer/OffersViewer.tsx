import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { RefreshCw, ExternalLink, Award, Package, Star, Clock, MapPin } from "lucide-react";

interface Offer {
  seller_id: string;
  seller_name: string;
  price: number;
  shipping: number;
  total_price: number;
  is_fba: boolean;
  is_buybox_winner: boolean;
  condition: string;
  rating?: number;
  rating_count?: number;
  handling_days?: number | null;
  ships_from?: string | null;
}

interface Snapshot {
  id: string;
  asin: string;
  marketplace: string;
  fetched_at: string;
  buybox_price: number | null;
  buybox_is_fba: boolean | null;
  buybox_seller_id: string | null;
  buybox_seller_name: string | null;
  lowest_fba_price: number | null;
  lowest_fbm_price: number | null;
  lowest_overall_price: number | null;
  offers_count: number;
  offers_json: Offer[];
  credits_used: number;
  source: string;
}

interface OffersViewerProps {
  asin: string | null;
  marketplace: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function OffersViewer({
  asin,
  marketplace,
  open,
  onOpenChange,
}: OffersViewerProps) {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userSellerId, setUserSellerId] = useState<string | null>(null);

  useEffect(() => {
    if (open && asin) {
      fetchSnapshot();
      fetchUserSellerId();
    }
  }, [open, asin, marketplace]);

  const fetchUserSellerId = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("seller_authorizations")
      .select("selling_partner_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (data) setUserSellerId(data.selling_partner_id);
  };

  const fetchSnapshot = async () => {
    if (!asin) return;

    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("repricer_competitor_snapshots")
        .select("*")
        .eq("asin", asin)
        .eq("marketplace", marketplace)
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setSnapshot({
          ...data,
          offers_json: (data.offers_json as unknown as Offer[]) || [],
        });
      } else {
        setSnapshot(null);
      }
    } catch (error: any) {
      console.error("Error fetching snapshot:", error);
    } finally {
      setLoading(false);
    }
  };

  const refreshOffers = async () => {
    if (!asin) return;

    try {
      setRefreshing(true);
      const result = await (await import("@/lib/edgeFunctionClient")).invokeEdgeFunction({
        functionName: "repricer-fetch-offers",
        body: { asin, marketplace, forceRefresh: true },
        context: { asin: asin || "" },
      });

      if (!result.ok) throw new Error(result.errorMessage || "Failed to refresh offers");

      toast.success(`Fetched ${result.data.offers_count} offers (${result.data.credits_used} credit${result.data.credits_used > 1 ? "s" : ""} used)`);
      fetchSnapshot();
    } catch (error: any) {
      toast.error("Failed to refresh: " + error.message);
    } finally {
      setRefreshing(false);
    }
  };

  const offers = snapshot?.offers_json || [];
  const hasDetailedOffers = offers.length > 0;
  const snapshotAge = snapshot?.fetched_at
    ? Math.floor((Date.now() - new Date(snapshot.fetched_at).getTime()) / 60000)
    : null;

  const isYourOffer = (offer: Offer) => userSellerId && offer.seller_id === userSellerId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Competitor Analysis — {asin}
              <Badge variant="outline">{marketplace}</Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshOffers}
              disabled={refreshing}
            >
              {refreshing ? (
                <RefreshCw className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1" />
              )}
              Refresh (1 credit)
            </Button>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : !snapshot ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">
              No competitor data available. Click refresh to fetch offers.
            </p>
            <Button onClick={refreshOffers} disabled={refreshing}>
              {refreshing ? "Fetching..." : "Fetch Offers (1 credit)"}
            </Button>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-xs text-muted-foreground mb-1">Buy Box</div>
                  <div className="text-lg font-bold">
                    {snapshot.buybox_price != null ? `$${snapshot.buybox_price.toFixed(2)}` : "—"}
                  </div>
                  {snapshot.buybox_is_fba && (
                    <Badge variant="secondary" className="text-xs mt-1">FBA</Badge>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-xs text-muted-foreground mb-1">Lowest FBA</div>
                  <div className="text-lg font-bold">
                    {snapshot.lowest_fba_price != null ? `$${snapshot.lowest_fba_price.toFixed(2)}` : "—"}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-xs text-muted-foreground mb-1">Lowest FBM</div>
                  <div className="text-lg font-bold">
                    {snapshot.lowest_fbm_price != null ? `$${snapshot.lowest_fbm_price.toFixed(2)}` : "—"}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <div className="text-xs text-muted-foreground mb-1">Total Offers</div>
                  <div className="text-lg font-bold">{snapshot.offers_count}</div>
                  {snapshotAge !== null && (
                    <div className="text-xs text-muted-foreground mt-1">
                      {snapshotAge < 60 ? `${snapshotAge}m ago` : `${Math.floor(snapshotAge / 60)}h ago`}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Offers Table - BQool Style */}
            {hasDetailedOffers ? (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="text-xs">
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Competitor</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Price + Shipping</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Condition</TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Clock className="h-3 w-3" /> Handling
                        </div>
                      </TableHead>
                      <TableHead>Rating</TableHead>
                      <TableHead>
                        <div className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" /> Ships From
                        </div>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {offers.map((offer, idx) => {
                      const isYou = isYourOffer(offer);
                      return (
                        <TableRow
                          key={`${offer.seller_id}-${idx}`}
                          className={
                            isYou
                              ? "bg-blue-50 dark:bg-blue-950/30 font-medium"
                              : offer.is_buybox_winner
                              ? "bg-yellow-50 dark:bg-yellow-950/20"
                              : ""
                          }
                        >
                          <TableCell className="text-muted-foreground text-xs">{idx + 1}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {offer.is_buybox_winner && (
                                <Award className="h-4 w-4 text-yellow-500 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <div className="font-medium text-xs truncate max-w-[180px]">
                                  {isYou ? (
                                    <span className="text-blue-600 dark:text-blue-400">Your Price</span>
                                  ) : (
                                    offer.seller_name
                                  )}
                                  {offer.is_buybox_winner && (
                                    <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0 text-yellow-600 border-yellow-400">
                                      Buy Box
                                    </Badge>
                                  )}
                                </div>
                                <a
                                  href={`https://www.amazon.com/sp?seller=${offer.seller_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10px] text-primary font-mono hover:underline inline-flex items-center gap-0.5"
                                >
                                  {offer.seller_id}
                                  <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono font-medium text-xs">
                            ${offer.total_price.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground font-mono">
                            ${offer.price.toFixed(2)} + {offer.shipping > 0 ? `$${offer.shipping.toFixed(2)}` : "$0.00"}
                          </TableCell>
                          <TableCell>
                            <Badge 
                              variant={offer.is_fba ? "default" : "outline"} 
                              className="text-[10px] px-1.5 py-0"
                            >
                              {offer.is_fba ? "FBA" : "FBM"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">{offer.condition}</TableCell>
                          <TableCell className="text-center text-xs">
                            {offer.handling_days != null ? (
                              <span>{offer.handling_days}d</span>
                            ) : offer.is_fba ? (
                              <span className="text-muted-foreground">0d</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {offer.rating != null ? (
                              <div className="flex items-center gap-1 text-xs">
                                <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                                <span>{Math.round(offer.rating)}%</span>
                                {offer.rating_count != null && (
                                  <span className="text-muted-foreground text-[10px]">
                                    ({offer.rating_count.toLocaleString()})
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {offer.ships_from || (offer.is_fba ? "US" : "—")}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              /* No detailed offers - SP-API snapshot only has aggregates */
              <div className="text-center py-6 border rounded-lg bg-muted/30">
                <p className="text-muted-foreground mb-1 text-sm">
                  Scheduled sync captured {snapshot.offers_count} offers (aggregates only).
                </p>
                <p className="text-muted-foreground text-xs mb-4">
                  Click below to fetch detailed competitor breakdown.
                </p>
                <Button onClick={refreshOffers} disabled={refreshing} size="sm">
                  {refreshing ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" />
                      Fetching...
                    </>
                  ) : (
                    "Fetch Detailed Offers (1 credit)"
                  )}
                </Button>
              </div>
            )}

            {/* Source + Date info */}
            <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Source: {snapshot.source === "rainforest" ? "Rainforest API" : "SP-API"} · {snapshotAge !== null && (snapshotAge < 60 ? `${snapshotAge}m ago` : `${Math.floor(snapshotAge / 60)}h ago`)}
              </span>
              <a
                href={`https://www.amazon.com/dp/${asin}?th=1&psc=1#aod-sticky-pinned-offer`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                View on Amazon
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
