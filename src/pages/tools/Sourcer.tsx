import { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Search, Package, History, BarChart3, ExternalLink, ShieldCheck, ShieldX, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RTooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from "recharts";

interface SearchItem {
  asin: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
}

interface RoiData {
  asin: string;
  title?: string;
  imageUrl?: string;
  link?: string;
  price?: number;
  priceSource?: string;
  calculation?: {
    referralFee: number;
    fbaFee: number;
    variableClosingFee: number;
    otherFees: number;
    totalFees: number;
    profit: number;
    roi: number;
    margin: number;
  };
}

interface Offer {
  seller_name: string;
  price: number;
  shipping: number;
  total_price: number;
  is_fba: boolean;
  is_buybox_winner: boolean;
  condition: string;
}

interface OffersData {
  offers: Offer[];
  buybox_price: number | null;
  lowest_fba_price: number | null;
  lowest_fbm_price: number | null;
  offers_count: number;
  fba_offer_count?: number | null;
  fbm_offer_count?: number | null;
}

const CONDITION_COLORS: Record<string, string> = {
  New: "hsl(217 91% 60%)",
  Used: "hsl(38 92% 50%)",
  FBA: "hsl(142 71% 45%)",
  FBM: "hsl(280 65% 60%)",
};

const STORAGE_KEY = "sourcer:state:v1";

const loadPersisted = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const Sourcer = () => {
  const persisted = typeof window !== "undefined" ? loadPersisted() : null;

  const [query, setQuery] = useState<string>(persisted?.query ?? "");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchItem[]>(persisted?.results ?? []);
  const [selected, setSelected] = useState<SearchItem | null>(persisted?.selected ?? null);

  const [roiLoading, setRoiLoading] = useState(false);
  const [roi, setRoi] = useState<RoiData | null>(persisted?.roi ?? null);
  const [cost, setCost] = useState<string>(persisted?.cost ?? "");

  const [offersLoading, setOffersLoading] = useState(false);
  const [offers, setOffers] = useState<OffersData | null>(persisted?.offers ?? null);

  const [history, setHistory] = useState<any[] | null>(persisted?.history ?? null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [priceHistory, setPriceHistory] = useState<Array<{ date: string; buybox: number | null; lowest: number | null }> | null>(persisted?.priceHistory ?? null);
  const [priceHistoryLoading, setPriceHistoryLoading] = useState(false);

  type EligibilityStatus = 'checking' | 'approved' | 'restricted' | 'approval_required' | 'error';
  const [eligibilityMap, setEligibilityMap] = useState<Record<string, EligibilityStatus>>(persisted?.eligibilityMap ?? {});

  const checkEligibility = async (asins: string[]) => {
    const unique = Array.from(new Set(asins.filter(Boolean)));
    if (unique.length === 0) return;
    setEligibilityMap(prev => {
      const next = { ...prev };
      unique.forEach(a => { if (!next[a] || next[a] === 'error') next[a] = 'checking'; });
      return next;
    });
    const BATCH = 20;
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH);
      try {
        const { data, error } = await supabase.functions.invoke('check-product-eligibility', {
          body: { marketplace: 'US', asins: batch, force_rescan: false },
        });
        if (error) {
          setEligibilityMap(prev => {
            const next = { ...prev };
            batch.forEach(a => { next[a] = 'error'; });
            return next;
          });
          continue;
        }
        const results: { asin: string; status: string }[] = data?.results || [];
        setEligibilityMap(prev => {
          const next = { ...prev };
          for (const r of results) {
            next[r.asin] = r.status === 'approved' ? 'approved'
              : r.status === 'approval_required' ? 'approval_required'
              : r.status === 'restricted' ? 'restricted'
              : 'error';
          }
          for (const a of batch) {
            if (!next[a] || next[a] === 'checking') next[a] = 'error';
          }
          return next;
        });
      } catch {
        setEligibilityMap(prev => {
          const next = { ...prev };
          batch.forEach(a => { next[a] = 'error'; });
          return next;
        });
      }
    }
  };

  const renderEligibilityBadge = (asin: string) => {
    const status = eligibilityMap[asin];
    if (!status) return null;
    switch (status) {
      case 'checking':
        return (
          <Badge variant="outline" className="text-[10px] px-1.5 animate-pulse">
            <Loader2 className="h-3 w-3 mr-0.5 animate-spin" /> Checking
          </Badge>
        );
      case 'approved':
        return (
          <Badge className="text-[10px] px-1.5 bg-emerald-600 hover:bg-emerald-700 text-white">
            <ShieldCheck className="h-3 w-3 mr-0.5" /> Approved
          </Badge>
        );
      case 'restricted':
        return (
          <Badge variant="destructive" className="text-[10px] px-1.5">
            <ShieldX className="h-3 w-3 mr-0.5" /> Restricted
          </Badge>
        );
      case 'approval_required':
        return (
          <Badge variant="secondary" className="text-[10px] px-1.5 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3 mr-0.5" /> Needs Approval
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="secondary" className="text-[10px] px-1.5 text-muted-foreground">
            Eligibility N/A
          </Badge>
        );
      default:
        return null;
    }
  };

  // Persist state across navigation (sessionStorage = survives page changes within the tab)
  useEffect(() => {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          query,
          results,
          selected,
          roi,
          cost,
          offers,
          history,
          priceHistory,
          eligibilityMap,
        })
      );
    } catch {
      // ignore quota errors
    }
  }, [query, results, selected, roi, cost, offers, history, priceHistory, eligibilityMap]);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) {
      toast.error("Enter an ASIN, UPC, or keywords");
      return;
    }
    setSearching(true);
    setResults([]);
    setSelected(null);
    setRoi(null);
    setOffers(null);
    setHistory(null);
    setPriceHistory(null);
    try {
      const { data, error } = await supabase.functions.invoke("sourcer-search-catalog", {
        body: { query: q, marketplace: "US" },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Search failed");
      setResults(data.items || []);
      // Kick off eligibility check for all results
      const asinList = (data.items || []).map((it: SearchItem) => it.asin).filter(Boolean);
      if (asinList.length > 0) checkEligibility(asinList);
      if ((data.items || []).length === 0) {
        toast.info("No products found");
      } else if ((data.items || []).length === 1) {
        // Auto-select if there's only one result (e.g. ASIN search)
        handleSelect(data.items[0]);
      }
    } catch (err: any) {
      console.error("[Sourcer] search error", err);
      toast.error(err?.message || "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleSelect = async (item: SearchItem) => {
    setSelected(item);
    if (!eligibilityMap[item.asin]) checkEligibility([item.asin]);
    setRoi(null);
    setOffers(null);
    setHistory(null);
    setPriceHistory(null);
    setCost("");
    // Scroll to detail card so user sees the cost input area
    setTimeout(() => {
      document.getElementById("sourcer-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);

    // Fetch ROI (price + fees) and Offers in parallel
    setRoiLoading(true);
    setOffersLoading(true);
    try {
      const [roiResp, offersResp] = await Promise.all([
        supabase.functions.invoke("calculate-roi", { body: { asin: item.asin } }),
        supabase.functions.invoke("sourcer-fetch-offers", {
          body: { asin: item.asin, marketplace: "US" },
        }),
      ]);

      if (roiResp.error) {
        console.error("[Sourcer] roi error", roiResp.error);
      } else {
        setRoi(roiResp.data);
      }

      if (offersResp.error) {
        console.warn("[Sourcer] offers error", offersResp.error);
      } else {
        setOffers(offersResp.data);
      }
    } catch (err: any) {
      console.error("[Sourcer] select error", err);
      toast.error("Failed to load product data");
    } finally {
      setRoiLoading(false);
      setOffersLoading(false);
    }
  };

  const recalcWithCost = async () => {
    if (!selected || !cost || parseFloat(cost) <= 0) return;
    setRoiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("calculate-roi", {
        body: { asin: selected.asin, cost: parseFloat(cost) },
      });
      if (error) throw error;
      setRoi(data);
    } catch (err: any) {
      toast.error("Failed to recalc");
    } finally {
      setRoiLoading(false);
    }
  };

  // Tab data loaders
  const loadHistory = async () => {
    if (!selected || history !== null) return;
    setHistoryLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase
        .from("sales_orders")
        .select("order_date, quantity, sold_price, total_sale_amount, total_fees, marketplace")
        .eq("user_id", user.id)
        .eq("asin", selected.asin)
        .order("order_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      setHistory(data || []);
    } catch (err: any) {
      console.error("[Sourcer] history error", err);
      toast.error("Failed to load sales history");
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadPriceHistory = async () => {
    if (!selected || priceHistory !== null) return;
    setPriceHistoryLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase
        .from("repricer_competitor_snapshots")
        .select("fetched_at, buybox_price, lowest_fba_price, lowest_overall_price")
        .eq("user_id", user.id)
        .eq("asin", selected.asin)
        .eq("marketplace", "US")
        .order("fetched_at", { ascending: true })
        .limit(500);
      if (error) throw error;
      const pts = (data || []).map((r: any) => ({
        date: new Date(r.fetched_at).toLocaleDateString(),
        buybox: r.buybox_price ? Number(r.buybox_price) : null,
        lowest: r.lowest_fba_price
          ? Number(r.lowest_fba_price)
          : r.lowest_overall_price
            ? Number(r.lowest_overall_price)
            : null,
      }));
      setPriceHistory(pts);
    } catch (err: any) {
      console.error("[Sourcer] price history error", err);
      setPriceHistory([]);
    } finally {
      setPriceHistoryLoading(false);
    }
  };

  // Offers breakdown for donut + condition list
  const offerStats = useMemo(() => {
    if (!offers) return null;
    const offerList = offers.offers || [];
    const fba = offers.fba_offer_count ?? offerList.filter((o) => o.is_fba).length;
    const fbm = offers.fbm_offer_count ?? offerList.filter((o) => !o.is_fba).length;
    const total = offers.offers_count ?? offerList.length ?? fba + fbm;
    const newCount = offerList.length > 0 ? offerList.filter((o) => /new/i.test(o.condition)).length : total;
    const used = Math.max(0, total - newCount);
    return { total, fba, fbm, newCount, used };
  }, [offers]);

  const donutData = useMemo(() => {
    if (!offerStats) return [];
    return [
      { name: "FBA", value: offerStats.fba },
      { name: "FBM", value: offerStats.fbm },
    ].filter((d) => d.value > 0);
  }, [offerStats]);

  const profit = useMemo(() => {
    if (!roi?.price || !roi.calculation) return null;
    return roi.calculation;
  }, [roi]);

  const historyTotals = useMemo(() => {
    if (!history) return null;
    const units = history.reduce((s, r) => s + Number(r.quantity || 0), 0);
    const revenue = history.reduce((s, r) => s + Number(r.total_sale_amount || (r.sold_price || 0) * (r.quantity || 0) || 0), 0);
    const fees = history.reduce((s, r) => s + Number(r.total_fees || 0), 0);
    return { units, revenue, fees };
  }, [history]);

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Sourcer — Find Profitable Products | ArbiProSeller</title>
        <meta
          name="description"
          content="Search Amazon by ASIN, UPC, or keywords. See live price, real fees, profit, ROI, offers, sales history, and price trend."
        />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl font-bold mb-2">Sourcer</h1>
          <p className="text-muted-foreground mb-6">
            Search Amazon by title, keyword, ASIN, or UPC. Pick a product to see live profit math, offers, history, and price trends.
          </p>

          {/* Search bar */}
          <div className="flex gap-2 max-w-3xl mb-6">
            <Input
              placeholder="Search by title, keyword, ASIN, or UPC (e.g. 'funko', B0BBYX1H6C)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="text-base"
            />
            <Button onClick={handleSearch} disabled={searching} size="lg" className="bg-blue-600 hover:bg-blue-700">
              {searching ? <Loader2 className="h-5 w-5 animate-spin" /> : <><Search className="h-5 w-5 mr-2" />Search</>}
            </Button>
          </div>

          {/* Results list */}
          {results.length > 1 && (
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Results ({results.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {results.map((it) => (
                  <button
                    key={it.asin}
                    onClick={() => handleSelect(it)}
                    className={`w-full flex items-center gap-3 p-2 rounded-md text-left hover:bg-muted transition ${
                      selected?.asin === it.asin ? "bg-muted ring-2 ring-blue-500" : ""
                    }`}
                  >
                    {it.imageUrl ? (
                      <img src={it.imageUrl} alt="" className="min-w-12 w-12 h-12 object-cover rounded" />
                    ) : (
                      <div className="min-w-12 w-12 h-12 bg-muted rounded flex items-center justify-center">
                        <Package className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium line-clamp-2">{it.title}</div>
                      <div className="text-xs text-muted-foreground flex gap-2 items-center flex-wrap">
                        <span className="font-mono">{it.asin}</span>
                        {it.brand && <span>· {it.brand}</span>}
                        {renderEligibilityBadge(it.asin)}
                      </div>
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Selected product detail */}
          {selected && (
            <Card id="sourcer-detail">

              <CardHeader>
                <div className="flex gap-4 items-start">
                  {selected.imageUrl ? (
                    <img src={selected.imageUrl} alt="" className="min-w-20 w-20 h-20 object-cover rounded" />
                  ) : (
                    <div className="min-w-20 w-20 h-20 bg-muted rounded flex items-center justify-center">
                      <Package className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-lg leading-tight">{selected.title}</CardTitle>
                    <div className="text-sm text-muted-foreground mt-1 flex gap-3 items-center flex-wrap">
                      <span className="font-mono">{selected.asin}</span>
                      {selected.brand && <span>{selected.brand}</span>}
                      {renderEligibilityBadge(selected.asin)}
                      <a
                        href={`https://www.amazon.com/dp/${selected.asin}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline inline-flex items-center gap-1"
                      >
                        View on Amazon <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="overview" onValueChange={(v) => {
                  if (v === "history") loadHistory();
                  if (v === "trend") loadPriceHistory();
                }}>
                  <TabsList>
                    <TabsTrigger value="overview"><Package className="h-4 w-4 mr-1" />Overview</TabsTrigger>
                    <TabsTrigger value="history"><History className="h-4 w-4 mr-1" />History</TabsTrigger>
                    <TabsTrigger value="trend"><BarChart3 className="h-4 w-4 mr-1" />Price Trend</TabsTrigger>
                  </TabsList>

                  {/* OVERVIEW */}
                  <TabsContent value="overview" className="mt-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      {/* Profit calculator */}
                      <Card>
                        <CardHeader className="pb-2"><CardTitle className="text-base">Profit Calculator</CardTitle></CardHeader>
                        <CardContent className="space-y-3">
                          {roiLoading ? (
                            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading live data…</div>
                          ) : roi ? (
                            <>
                              <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                  <div className="text-muted-foreground text-xs">Live Amazon Price</div>
                                  <div className="text-xl font-semibold">${roi.price?.toFixed(2) ?? "—"}</div>
                                  <div className="text-xs text-muted-foreground">{roi.priceSource}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground text-xs">Total Fees</div>
                                  <div className="text-xl font-semibold text-orange-600">${roi.calculation?.totalFees.toFixed(2) ?? "—"}</div>
                                </div>
                              </div>
                              <div className="text-xs space-y-0.5">
                                <div className="flex justify-between"><span className="text-muted-foreground">Referral fee</span><span>${roi.calculation?.referralFee.toFixed(2)}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">FBA fee</span><span>${roi.calculation?.fbaFee.toFixed(2)}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Variable closing</span><span>${roi.calculation?.variableClosingFee.toFixed(2)}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Other</span><span>${roi.calculation?.otherFees.toFixed(2)}</span></div>
                              </div>

                              <div className="border-t pt-3">
                                <label className="text-xs font-medium mb-1 block">Your Cost / Unit ($)</label>
                                <div className="flex gap-2">
                                  <Input
                                    type="number"
                                    placeholder="0.00"
                                    value={cost}
                                    step="0.01"
                                    onChange={(e) => setCost(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && recalcWithCost()}
                                  />
                                  <Button onClick={recalcWithCost} disabled={roiLoading || !cost}>Calculate</Button>
                                </div>
                              </div>

                              {profit && parseFloat(cost) > 0 && (
                                <>
                                  <div className="grid grid-cols-3 gap-2 pt-2 border-t">
                                    <div className="text-center">
                                      <div className="text-xs text-muted-foreground">Net Profit</div>
                                      <div className={`text-lg font-bold ${profit.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                                        ${profit.profit.toFixed(2)}
                                      </div>
                                    </div>
                                    <div className="text-center">
                                      <div className="text-xs text-muted-foreground">ROI</div>
                                      <div className={`text-lg font-bold ${profit.roi >= 0 ? "text-green-600" : "text-red-600"}`}>
                                        {profit.roi.toFixed(1)}%
                                      </div>
                                    </div>
                                    <div className="text-center">
                                      <div className="text-xs text-muted-foreground">Margin</div>
                                      <div className="text-lg font-bold">{profit.margin.toFixed(1)}%</div>
                                    </div>
                                  </div>

                                  {/* Price Breakdown Donut */}
                                  {(() => {
                                    const costNum = parseFloat(cost) || 0;
                                    const feesNum = roi.calculation?.totalFees ?? 0;
                                    const profitNum = Math.max(profit.profit, 0);
                                    const priceNum = roi.price ?? (costNum + feesNum + profit.profit);
                                    const breakdown = [
                                      { name: "Your Cost", value: costNum, color: "hsl(217 91% 60%)" },
                                      { name: "Amazon Fees", value: feesNum, color: "hsl(25 95% 53%)" },
                                      {
                                        name: profit.profit >= 0 ? "Net Profit" : "Loss",
                                        value: Math.abs(profit.profit),
                                        color: profit.profit >= 0 ? "hsl(142 71% 45%)" : "hsl(0 84% 60%)",
                                      },
                                    ];
                                    return (
                                      <div className="pt-3 border-t">
                                        <div className="text-xs font-medium mb-2 text-muted-foreground">
                                          Price Breakdown (${priceNum.toFixed(2)})
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 items-center">
                                          <div className="h-36 relative">
                                            <ResponsiveContainer width="100%" height="100%">
                                              <PieChart>
                                                <Pie
                                                  data={breakdown}
                                                  dataKey="value"
                                                  innerRadius={38}
                                                  outerRadius={62}
                                                  paddingAngle={2}
                                                  stroke="none"
                                                >
                                                  {breakdown.map((entry, i) => (
                                                    <Cell key={i} fill={entry.color} />
                                                  ))}
                                                </Pie>
                                                <RTooltip
                                                  formatter={(v: number, n: string) => [`$${v.toFixed(2)}`, n]}
                                                />
                                              </PieChart>
                                            </ResponsiveContainer>
                                            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                                              <div className="text-[10px] text-muted-foreground">Profit</div>
                                              <div className={`text-sm font-bold ${profit.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                                                {priceNum > 0 ? ((profit.profit / priceNum) * 100).toFixed(0) : 0}%
                                              </div>
                                            </div>
                                          </div>
                                          <div className="space-y-1.5 text-xs">
                                            {breakdown.map((b) => (
                                              <div key={b.name} className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-1.5 min-w-0">
                                                  <span
                                                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                                                    style={{ backgroundColor: b.color }}
                                                  />
                                                  <span className="truncate">{b.name}</span>
                                                </div>
                                                <div className="text-right shrink-0">
                                                  <div className="font-semibold">${b.value.toFixed(2)}</div>
                                                  <div className="text-[10px] text-muted-foreground">
                                                    {priceNum > 0 ? ((b.value / priceNum) * 100).toFixed(1) : 0}%
                                                  </div>
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })()}
                                </>
                              )}
                            </>
                          ) : (
                            <div className="text-sm text-muted-foreground">No live pricing available.</div>
                          )}
                        </CardContent>
                      </Card>

                      {/* Offers donut + breakdown */}
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-base">Offers {offerStats && `(${offerStats.total})`}</CardTitle>
                        </CardHeader>
                        <CardContent>
                          {offersLoading ? (
                            <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading offers…</div>
                          ) : offerStats && offerStats.total > 0 ? (
                            <div className="grid grid-cols-2 gap-3">
                              <div className="h-40">
                                <ResponsiveContainer width="100%" height="100%">
                                  <PieChart>
                                    <Pie data={donutData} dataKey="value" innerRadius={35} outerRadius={60} paddingAngle={2}>
                                      {donutData.map((d) => (
                                        <Cell key={d.name} fill={CONDITION_COLORS[d.name] || "hsl(var(--muted))"} />
                                      ))}
                                    </Pie>
                                    <RTooltip />
                                  </PieChart>
                                </ResponsiveContainer>
                              </div>
                              <div className="text-sm space-y-1">
                                <div className="flex justify-between"><span className="text-muted-foreground">FBA offers</span><span className="font-medium">{offerStats.fba}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">FBM offers</span><span className="font-medium">{offerStats.fbm}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">New</span><span className="font-medium">{offerStats.newCount}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Used</span><span className="font-medium">{offerStats.used}</span></div>
                                <div className="flex justify-between border-t pt-1"><span className="text-muted-foreground">Buy Box</span><span className="font-medium">${offers?.buybox_price?.toFixed(2) ?? "—"}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Lowest FBA</span><span className="font-medium">${offers?.lowest_fba_price?.toFixed(2) ?? "—"}</span></div>
                                <div className="flex justify-between"><span className="text-muted-foreground">Lowest FBM</span><span className="font-medium">${offers?.lowest_fbm_price?.toFixed(2) ?? "—"}</span></div>
                              </div>
                            </div>
                          ) : (
                            <div className="text-sm text-muted-foreground">No offers data.</div>
                          )}

                          {/* Offer prices strip */}
                          {offers?.offers && offers.offers.length > 0 && (
                            <div className="mt-3 pt-3 border-t">
                              <div className="text-xs text-muted-foreground mb-1">All offer prices</div>
                              <div className="flex flex-wrap gap-1">
                                {offers.offers
                                  .slice()
                                  .sort((a, b) => a.total_price - b.total_price)
                                  .map((o, i) => (
                                    <span
                                      key={i}
                                      className={`text-xs px-1.5 py-0.5 rounded ${
                                        o.is_buybox_winner
                                          ? "bg-blue-600 text-white font-semibold"
                                          : o.is_fba
                                            ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                                            : "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                                      }`}
                                      title={`${o.seller_name} · ${o.is_fba ? "FBA" : "FBM"} · ${o.condition}`}
                                    >
                                      {o.total_price.toFixed(2)}
                                    </span>
                                  ))}
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  </TabsContent>

                  {/* HISTORY */}
                  <TabsContent value="history" className="mt-4">
                    {historyLoading ? (
                      <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading sales…</div>
                    ) : !history || history.length === 0 ? (
                      <div className="text-sm text-muted-foreground p-4 text-center">No sales recorded for this ASIN yet.</div>
                    ) : (
                      <>
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground">Units sold</div><div className="text-2xl font-bold">{historyTotals?.units}</div></CardContent></Card>
                          <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground">Revenue</div><div className="text-2xl font-bold">${historyTotals?.revenue.toFixed(2)}</div></CardContent></Card>
                          <Card><CardContent className="pt-4"><div className="text-xs text-muted-foreground">Fees</div><div className="text-2xl font-bold text-orange-600">${historyTotals?.fees.toFixed(2)}</div></CardContent></Card>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b text-left">
                                <th className="py-2 px-3">Date</th>
                                <th className="py-2 px-3">Marketplace</th>
                                <th className="text-right py-2 px-3">Qty</th>
                                <th className="text-right py-2 px-3">Sold $</th>
                                <th className="text-right py-2 px-3">Total $</th>
                                <th className="text-right py-2 px-3">Fees $</th>
                              </tr>
                            </thead>
                            <tbody>
                              {history.slice(0, 100).map((r, i) => (
                                <tr key={i} className="border-b last:border-0 hover:bg-muted/40">
                                  <td className="py-1.5 px-3">{new Date(r.order_date).toLocaleDateString()}</td>
                                  <td className="py-1.5 px-3">{r.marketplace || "US"}</td>
                                  <td className="text-right py-1.5 px-3">{r.quantity}</td>
                                  <td className="text-right py-1.5 px-3">${Number(r.sold_price || 0).toFixed(2)}</td>
                                  <td className="text-right py-1.5 px-3">${Number(r.total_sale_amount || 0).toFixed(2)}</td>
                                  <td className="text-right py-1.5 px-3 text-orange-600">${Number(r.total_fees || 0).toFixed(2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {history.length > 100 && (
                            <div className="text-xs text-muted-foreground p-2">Showing first 100 of {history.length}</div>
                          )}
                        </div>
                      </>
                    )}
                  </TabsContent>

                  {/* PRICE TREND */}
                  <TabsContent value="trend" className="mt-4">
                    {priceHistoryLoading ? (
                      <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading price trend…</div>
                    ) : !priceHistory || priceHistory.length === 0 ? (
                      <div className="text-sm text-muted-foreground p-4 text-center">No tracked price history for this ASIN yet. Add it to the repricer to start tracking.</div>
                    ) : (
                      <div className="h-80">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={priceHistory}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="date" />
                            <YAxis />
                            <RTooltip />
                            <Legend />
                            <Line type="monotone" dataKey="buybox" stroke="hsl(217 91% 60%)" name="Buy Box" dot={false} />
                            <Line type="monotone" dataKey="lowest" stroke="hsl(142 71% 45%)" name="Lowest FBA" dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default Sourcer;
