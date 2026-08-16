import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Store, BellPlus, Bell, BellOff } from "lucide-react";
import { useSellerWatchlist, formatDuration, type SellerWatch, type WatchTiming } from "@/hooks/use-seller-watchlist";
import { useToast } from "@/hooks/use-toast";
import NewListingsPanel from "@/components/seller-analyzer/NewListingsPanel";
import BulkAddPanel from "@/components/seller-analyzer/BulkAddPanel";
import { Helmet } from "react-helmet-async";

const MARKETS = ["US", "CA", "MX", "GB", "DE", "FR", "IT", "ES", "JP", "IN", "BR"];

function parseSellerInput(raw: string): { sellerId: string } {
  const t = raw.trim();
  const me = t.match(/[?&]me=([A-Z0-9]+)/i);
  if (me) return { sellerId: me[1] };
  return { sellerId: t };
}

/**
 * Row status. Every watch used to render an identical "Watching" badge, which
 * made three genuinely different states indistinguishable: seeded and quiet,
 * never checked yet, and (before the fair-rotation fix) never going to be
 * checked at all. At scale the queue is legitimately days deep, so the wait
 * has to be visible and explained or a working watch looks broken for a week.
 */
function WatchStatus({ watch, timing }: { watch: SellerWatch; timing: WatchTiming }) {
  // last_checked_at and known_asin_list are written together by the worker's
  // first pass, so a null here means "no baseline yet".
  if (!watch.last_checked_at) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> Seeding
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          first alert possible in {formatDuration(timing.daysToFirstAlert)}
        </span>
      </div>
    );
  }

  const checkedAgoMs = Date.now() - new Date(watch.last_checked_at).getTime();
  const checkedAgoDays = checkedAgoMs / 86_400_000;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Badge className="gap-1">
        <Bell className="h-3 w-3" /> Watching
      </Badge>
      <span className="text-[11px] text-muted-foreground">
        checked {formatDuration(checkedAgoDays)} ago
      </span>
    </div>
  );
}

export default function SellerAnalyzer() {
  const [input, setInput] = useState("");
  const [marketplace, setMarketplace] = useState("US");
  const [tab, setTab] = useState("add");

  const { toast } = useToast();
  const { watches, createWatch, cancelWatch, bulkAddWatches, timing } = useSellerWatchlist();
  const [watchToggling, setWatchToggling] = useState(false);

  const typedSellerId = parseSellerInput(input).sellerId;
  const currentWatch = typedSellerId
    ? watches.find((w) => w.seller_id === typedSellerId && w.marketplace === marketplace)
    : undefined;

  // After a successful commit, move to Results so the newly added sellers are
  // visible immediately. Previews stay put -- switching tabs mid-review would
  // yank the summary away before it has been read.
  const handleBulkAdd: typeof bulkAddWatches = async (text, mkt, mode) => {
    const result = await bulkAddWatches(text, mkt, mode);
    if (mode === "commit" && !result.partial) setTab("results");
    return result;
  };

  const addWatch = async () => {
    if (!typedSellerId) return;
    setWatchToggling(true);
    try {
      await createWatch(typedSellerId, null, marketplace);
      toast({ title: `Now watching ${typedSellerId}` });
      setInput("");
      setTab("results");
    } catch (e: any) {
      toast({ title: "Could not watch seller", description: e.message, variant: "destructive" });
    } finally {
      setWatchToggling(false);
    }
  };

  const removeWatch = async (id: string) => {
    try {
      await cancelWatch(id);
      toast({ title: "Watch cancelled" });
    } catch (e: any) {
      toast({ title: "Could not cancel watch", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Seller Storefront Monitor | InventorySprint</title>
        <meta name="description" content="Watch Amazon seller storefronts and get alerted when they list something new." />
      </Helmet>

      {/* Header — title only. The entry controls moved into the Add tab so
          "what I put in" and "what came back" are never on screen competing
          for the same attention. */}
      <div className="bg-[#0f1c3f] text-white border-b">
        <div className="max-w-[1600px] mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Store className="h-5 w-5" />
            <h1 className="text-xl font-semibold">Seller Storefront Monitor</h1>
          </div>
          <p className="text-sm text-white/70 mt-1">
            Watch Amazon storefronts and get alerted when they list something new.
          </p>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="add" className="gap-2">
              <BellPlus className="h-4 w-4" /> Add sellers
            </TabsTrigger>
            <TabsTrigger value="results" className="gap-2">
              <Bell className="h-4 w-4" /> Results
              {watches.length > 0 && (
                <Badge variant="secondary" className="ml-1">{watches.length.toLocaleString()}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ---- INPUTS ---- */}
          <TabsContent value="add" className="space-y-6 mt-0">
            <Card>
              <CardContent className="p-4">
                <h2 className="text-sm font-semibold mb-3">Watch a single seller</h2>
                <form
                  onSubmit={(e) => { e.preventDefault(); addWatch(); }}
                  className="flex flex-col md:flex-row items-stretch md:items-center gap-2"
                >
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Seller ID (e.g. A1B0EBOAJDDILW) or full storefront URL"
                    className="md:max-w-xl"
                  />
                  <Select value={marketplace} onValueChange={setMarketplace}>
                    <SelectTrigger className="md:w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MARKETS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {currentWatch ? (
                    <Button type="button" variant="outline" onClick={() => removeWatch(currentWatch.id)}>
                      <Bell className="h-4 w-4 mr-2 text-emerald-500" /> Watching
                    </Button>
                  ) : (
                    <Button type="submit" disabled={watchToggling || !typedSellerId}>
                      {watchToggling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BellPlus className="h-4 w-4 mr-2" />}
                      Watch
                    </Button>
                  )}
                </form>
                <p className="mt-2 text-xs text-muted-foreground">
                  The marketplace chosen here also applies to bulk uploads below.
                </p>
              </CardContent>
            </Card>

            <BulkAddPanel
              marketplace={marketplace}
              currentWatchCount={watches.length}
              onBulkAdd={handleBulkAdd}
            />
          </TabsContent>

          {/* ---- RESULTS ---- */}
          <TabsContent value="results" className="space-y-6 mt-0">
            <NewListingsPanel />

            {watches.length > 0 ? (
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-baseline justify-between gap-2 mb-3">
                    <h2 className="text-sm font-semibold">Watched Sellers</h2>
                    <span className="text-xs text-muted-foreground">
                      {watches.length} watched · full rotation {formatDuration(timing.rotationDays)}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {watches.map((w) => (
                      <div key={w.id} className="flex items-center justify-between gap-2 text-sm border-b last:border-b-0 pb-2 last:pb-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate">{w.seller_name || w.seller_id}</span>
                          <span className="text-muted-foreground shrink-0">({w.marketplace})</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <WatchStatus watch={w} timing={timing} />
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeWatch(w.id)}>
                            <BellOff className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Sellers are checked oldest-first, so every watch is reached in turn. New listings
                    usually take days to appear anyway — a seller has to source and ship to FBA before
                    the listing goes live.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card><CardContent className="p-10 text-center text-muted-foreground">
                Nothing watched yet — add sellers on the <strong>Add sellers</strong> tab.
              </CardContent></Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
