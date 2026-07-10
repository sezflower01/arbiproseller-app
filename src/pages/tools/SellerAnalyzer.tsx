import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, RefreshCw, Search, Store, ExternalLink } from "lucide-react";
import { useSellerSnapshot } from "@/hooks/use-seller-snapshot";
import StoreDetailsCard from "@/components/seller-analyzer/StoreDetailsCard";
import TopListTable from "@/components/seller-analyzer/TopListTable";
import SellerCharts from "@/components/seller-analyzer/SellerCharts";
import StorefrontListingCard from "@/components/seller-analyzer/StorefrontListingCard";
import { Helmet } from "react-helmet-async";

const MARKETS = ["US", "CA", "MX", "GB", "DE", "FR", "IT", "ES", "JP", "IN", "BR"];

function parseSellerInput(raw: string): { sellerId: string; marketplace?: string } {
  const t = raw.trim();
  const me = t.match(/[?&]me=([A-Z0-9]+)/i);
  if (me) return { sellerId: me[1] };
  return { sellerId: t };
}

export default function SellerAnalyzer() {
  const [params, setParams] = useSearchParams();
  const initialSeller = params.get("sellerId") || params.get("url") || "";
  const initialMarket = (params.get("marketplace") || "US").toUpperCase();
  const [input, setInput] = useState(initialSeller);
  const [marketplace, setMarketplace] = useState(initialMarket);
  const [page, setPage] = useState(0);

  const { data, loading, error, load } = useSellerSnapshot();

  useEffect(() => {
    if (initialSeller) {
      const { sellerId } = parseSellerInput(initialSeller);
      if (sellerId) load(sellerId, initialMarket, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const { sellerId } = parseSellerInput(input);
    if (!sellerId) return;
    setPage(0);
    setParams({ sellerId, marketplace });
    load(sellerId, marketplace, 0);
  };

  const goPage = (p: number) => {
    if (!data) return;
    setPage(p);
    load(data.store.sellerId, marketplace, p, { prev: data });
  };

  const refresh = () => {
    if (!data) return;
    load(data.store.sellerId, marketplace, page, { forceRefresh: true });
  };

  const cachedLabel = data?.cachedAt
    ? `Cached result · Last fetched: ${new Date(data.cachedAt).toLocaleString()}`
    : null;

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Seller Storefront Analyzer | ArbiProSeller</title>
        <meta name="description" content="Analyze any Amazon seller storefront — brands, categories, listings and live offers." />
      </Helmet>

      {/* Header */}
      <div className="bg-[#0f1c3f] text-white border-b">
        <div className="max-w-[1600px] mx-auto px-4 py-4">
          <div className="flex items-center gap-3 mb-3">
            <Store className="h-5 w-5" />
            <h1 className="text-xl font-semibold">Seller Storefront Analyzer</h1>
          </div>
          <form onSubmit={submit} className="flex flex-col md:flex-row items-stretch md:items-center gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Seller ID (e.g. A1B0EBOAJDDILW) or full storefront URL"
              className="bg-white/10 border-white/20 text-white placeholder:text-white/60 md:max-w-xl"
            />
            <Select value={marketplace} onValueChange={setMarketplace}>
              <SelectTrigger className="bg-white/10 border-white/20 text-white md:w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MARKETS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={loading} className="bg-primary hover:bg-primary/90">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              <span className="ml-2">Analyze</span>
            </Button>
            {data && (
              <>
                <Button type="button" variant="outline" className="text-foreground" onClick={refresh} disabled={loading}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh from Keepa
                </Button>
                <Button asChild type="button" variant="outline" className="text-foreground">
                  <a href={`https://www.amazon.com/s?i=merchant-items&me=${data.store.sellerId}&marketplaceID=ATVPDKIKX0DER`} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4 mr-2" /> Open on Amazon
                  </a>
                </Button>
              </>
            )}
          </form>
          {cachedLabel && (
            <div className="mt-2 text-xs text-white/70">{cachedLabel}</div>
          )}
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-4 py-6 space-y-6">
        {error && (
          <Card><CardContent className="p-4 text-rose-600 dark:text-rose-400">{error}</CardContent></Card>
        )}

        {!data && !loading && !error && (
          <Card><CardContent className="p-10 text-center text-muted-foreground">
            Enter a seller ID or paste a storefront URL to begin.
          </CardContent></Card>
        )}

        {loading && !data && (
          <Card><CardContent className="p-10 flex items-center justify-center text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Fetching storefront…
          </CardContent></Card>
        )}

        {data && (
          <>
            <StoreDetailsCard store={data.store} marketplace={marketplace} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TopListTable title="Top Brands (page)" labelHeader="Brand" rows={data.topBrands} />
              <TopListTable title="Top Categories (page)" labelHeader="Category" rows={data.topCategories} />
            </div>

            <SellerCharts topBrands={data.topBrands} topCategories={data.topCategories} items={data.pageItems} />

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Storefront Listings</h2>
                <div className="text-sm text-muted-foreground">
                  Page {data.page + 1} of {data.totalPages} · {data.asinList.length.toLocaleString()} ASINs
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {data.pageItems.map((p) => (
                  <StorefrontListingCard key={p.asin} p={p} marketplace={marketplace} />
                ))}
                {data.pageItems.length === 0 && (
                  <Card className="md:col-span-2 xl:col-span-3"><CardContent className="p-6 text-center text-muted-foreground">No items on this page.</CardContent></Card>
                )}
              </div>
              {data.totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-4">
                  <Button variant="outline" size="sm" disabled={page === 0 || loading} onClick={() => goPage(page - 1)}>Previous</Button>
                  <span className="text-sm text-muted-foreground">Page {page + 1} / {data.totalPages}</span>
                  <Button variant="outline" size="sm" disabled={page >= data.totalPages - 1 || loading} onClick={() => goPage(page + 1)}>Next</Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
