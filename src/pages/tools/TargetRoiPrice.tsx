import { Helmet } from "react-helmet-async";
import { useState, useEffect, useMemo } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Target, DollarSign, TrendingUp, Globe, RefreshCw, Calculator, ExternalLink } from "lucide-react";
import { format } from "date-fns";

interface ProductData {
  asin: string;
  title: string;
  imageUrl: string;
  price: number;
  priceSource?: string;
  link: string;
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

interface FxRate {
  base: string;
  quote: string;
  rate: number;
  as_of: string;
  source: string | null;
}

const MARKETPLACES = [
  { code: "USD", name: "United States", flag: "🇺🇸", symbol: "$", locale: "en-US" },
  { code: "CAD", name: "Canada", flag: "🇨🇦", symbol: "C$", locale: "en-CA" },
  { code: "MXN", name: "Mexico", flag: "🇲🇽", symbol: "MX$", locale: "es-MX" },
  { code: "BRL", name: "Brazil", flag: "🇧🇷", symbol: "R$", locale: "pt-BR" },
];

const TargetRoiPrice = () => {
  const [asin, setAsin] = useState("");
  const [cost, setCost] = useState("");
  const [loading, setLoading] = useState(false);
  const [productData, setProductData] = useState<ProductData | null>(null);
  const [marketplace, setMarketplace] = useState("USD");
  const [minRoi, setMinRoi] = useState([30]);
  const [fxRates, setFxRates] = useState<FxRate[]>([]);
  const [fxLoading, setFxLoading] = useState(false);

  // Load FX rates on mount
  useEffect(() => {
    loadFxRates();
  }, []);

  const loadFxRates = async () => {
    setFxLoading(true);
    try {
      const { data, error } = await supabase
        .from("fx_rates")
        .select("*")
        .eq("base", "USD");

      if (error) throw error;
      setFxRates(data || []);
    } catch (error) {
      console.error("Error loading FX rates:", error);
      toast.error("Failed to load exchange rates");
    } finally {
      setFxLoading(false);
    }
  };

  const refreshFxRates = async () => {
    setFxLoading(true);
    try {
      const { error } = await supabase.functions.invoke("refresh-fx-rates");
      if (error) throw error;
      await loadFxRates();
      toast.success("Exchange rates refreshed");
    } catch (error) {
      console.error("Error refreshing FX rates:", error);
      toast.error("Failed to refresh exchange rates");
    } finally {
      setFxLoading(false);
    }
  };

  const handleFetchProduct = async () => {
    if (!asin.trim()) {
      toast.error("Please enter an ASIN");
      return;
    }

    setLoading(true);
    try {
      // Fetch product data from Amazon SP-API
      const { data, error } = await supabase.functions.invoke("calculate-roi", {
        body: { asin: asin.trim() },
      });

      if (error) throw error;

      setProductData(data);

      // Also try to retrieve cost from database — Contract A via shared helpers
      const { getListingUnitCost, getInventoryUnitCost } = await import("@/lib/cost-contract");
      const asinUpper = asin.trim().toUpperCase();

      // Try created_listings first (authoritative source for cost)
      const { data: listingData } = await supabase
        .from("created_listings")
        .select("cost, units, amount")
        .eq("asin", asinUpper)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const listingUnit = listingData ? getListingUnitCost(listingData) : null;
      if (listingUnit !== null) {
        setCost(listingUnit.toFixed(2));
        toast.success("Product data and cost retrieved successfully");
        return;
      }

      // Fallback to inventory table (Contract A: inventory.cost = UNIT)
      const { data: inventoryData } = await supabase
        .from("inventory")
        .select("cost, amount, units")
        .eq("asin", asinUpper)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const invUnit = inventoryData ? getInventoryUnitCost(inventoryData) : null;
      if (invUnit !== null && invUnit > 0) {
        setCost(invUnit.toFixed(2));
        toast.success("Product data and cost retrieved successfully");
        return;
      }

      toast.success("Product data retrieved (no cost found in database - enter manually)");
    } catch (error) {
      console.error("Error fetching product:", error);
      toast.error("Failed to fetch product data");
    } finally {
      setLoading(false);
    }
  };

  const handleCalculateROI = async () => {
    if (!productData) {
      toast.error("Please fetch product data first");
      return;
    }

    if (!cost || parseFloat(cost) <= 0) {
      toast.error("Please enter a valid cost");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("calculate-roi", {
        body: { asin: productData.asin, cost: parseFloat(cost) },
      });

      if (error) throw error;

      setProductData(data);
      toast.success("ROI calculated successfully");
    } catch (error) {
      console.error("Error calculating ROI:", error);
      toast.error("Failed to calculate ROI");
    } finally {
      setLoading(false);
    }
  };

  const selectedMarketplace = MARKETPLACES.find((m) => m.code === marketplace) || MARKETPLACES[0];
  const currentFxRate = fxRates.find((r) => r.quote === marketplace);
  const fxRate = currentFxRate?.rate || 1;

  // Calculate target prices based on min ROI
  const targetPricing = useMemo(() => {
    if (!productData?.calculation || !cost) return null;

    const costNum = parseFloat(cost);
    if (costNum <= 0) return null;

    const { referralFee, fbaFee, variableClosingFee, otherFees, totalFees } = productData.calculation;

    // Required profit based on min ROI
    const requiredProfitUsd = costNum * (minRoi[0] / 100);

    // Target sell price in USD = cost + required profit + fees
    const targetSellPriceUsd = costNum + requiredProfitUsd + totalFees;

    // Convert to local currency
    const targetSellPriceLocal = targetSellPriceUsd * fxRate;

    // Convert fees to local currency
    const feesLocal = {
      referralFee: referralFee * fxRate,
      fbaFee: fbaFee * fxRate,
      variableClosingFee: variableClosingFee * fxRate,
      otherFees: otherFees * fxRate,
      totalFees: totalFees * fxRate,
    };

    // Current Amazon price in local currency
    const amazonPriceLocal = productData.price * fxRate;

    // Current profit in local currency
    const currentProfitLocal = amazonPriceLocal - costNum * fxRate - feesLocal.totalFees;
    const currentRoi = costNum > 0 ? (currentProfitLocal / (costNum * fxRate)) * 100 : 0;

    return {
      targetSellPriceUsd,
      targetSellPriceLocal,
      requiredProfitUsd,
      requiredProfitLocal: requiredProfitUsd * fxRate,
      feesLocal,
      amazonPriceLocal,
      currentProfitLocal,
      currentRoi,
      costLocal: costNum * fxRate,
    };
  }, [productData, cost, minRoi, fxRate]);

  const formatCurrency = (amount: number, currencyCode: string) => {
    const mp = MARKETPLACES.find((m) => m.code === currencyCode);
    try {
      return new Intl.NumberFormat(mp?.locale || "en-US", {
        style: "currency",
        currency: currencyCode,
        minimumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${mp?.symbol || "$"}${amount.toFixed(2)}`;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-background via-background to-primary/5">
      <Helmet>
        <title>Target ROI Price Calculator | ArbiProSeller</title>
        <meta
          name="description"
          content="Multi-currency ROI target calculator for Amazon FBA products across USA, Canada, Mexico, and Brazil"
        />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-20 pb-8">
        <div className="container mx-auto px-4 max-w-[1600px]">
          {/* Header - Compact */}
          <div className="flex items-center gap-4 mb-6">
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/30">
              <Target className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold">Target ROI Price Calculator</h1>
              <p className="text-sm text-muted-foreground">
                Calculate required selling price across multiple Amazon marketplaces
              </p>
            </div>
          </div>

          {/* Main Grid Layout - 3 columns */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Left Column - Input & Product Info */}
            <div className="lg:col-span-4 space-y-4">
              {/* ASIN Input Card */}
              <Card className="border-2 hover:border-primary/30 transition-colors shadow-md">
                <CardHeader className="bg-gradient-to-r from-primary/5 to-transparent py-3 px-4">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Calculator className="h-4 w-4 text-primary" />
                    Enter Product ASIN
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 p-4">
                  <div>
                    <Label htmlFor="asin" className="text-xs">ASIN</Label>
                    <Input
                      id="asin"
                      placeholder="e.g., B08N5WRWNW"
                      value={asin}
                      onChange={(e) => setAsin(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === "Enter" && handleFetchProduct()}
                      className="font-mono tracking-wider"
                    />
                  </div>
                  <Button onClick={handleFetchProduct} disabled={loading} className="w-full shadow-md">
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      "Fetch Product"
                    )}
                  </Button>
                </CardContent>
              </Card>

              {/* Product Info Card */}
              {productData && (
                <Card className="border-2 hover:border-primary/30 transition-colors shadow-md overflow-hidden">
                  <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-transparent py-3 px-4">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <TrendingUp className="h-4 w-4 text-emerald-600" />
                      Product Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="flex gap-3">
                      <img
                        src={productData.imageUrl}
                        alt={productData.title}
                        className="w-20 h-20 object-contain border rounded-lg shadow-sm bg-white p-1 flex-shrink-0"
                      />
                      <div className="flex-1 space-y-1 min-w-0">
                        <h3 className="font-semibold text-sm line-clamp-2">{productData.title}</h3>
                        <p className="text-xs text-muted-foreground font-mono">ASIN: {productData.asin}</p>
                        {productData.price > 0 ? (
                          <>
                            <p className="text-lg font-bold text-primary">${productData.price.toFixed(2)} USD</p>
                            {productData.priceSource && (
                              <p className="text-xs text-muted-foreground">
                                {productData.priceSource === "buybox" && "✓ Buy Box"}
                                {productData.priceSource === "lowest_new" && "✓ Lowest New"}
                                {productData.priceSource === "seller_offer" && "✓ Seller Offer"}
                                {productData.priceSource === "competitive_pricing" && "✓ Competitive"}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-amber-600 font-medium">⚠️ No price available</p>
                        )}
                        <a
                          href={productData.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline text-xs inline-flex items-center gap-1"
                        >
                          View on Amazon <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Middle Column - Settings */}
            <div className="lg:col-span-4 space-y-4">
              {productData && (
                <Card className="border-2 hover:border-primary/30 transition-colors shadow-md">
                  <CardHeader className="bg-gradient-to-r from-blue-500/10 to-transparent py-3 px-4">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Globe className="h-4 w-4 text-blue-600" />
                      Marketplace & ROI Settings
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4 p-4">
                    {/* Marketplace */}
                    <div>
                      <Label className="text-xs">Target Marketplace</Label>
                      <Select value={marketplace} onValueChange={setMarketplace}>
                        <SelectTrigger className="mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover">
                          {MARKETPLACES.map((mp) => (
                            <SelectItem key={mp.code} value={mp.code}>
                              <span className="flex items-center gap-2">
                                <span>{mp.flag}</span>
                                <span>{mp.name}</span>
                                <span className="text-muted-foreground">({mp.code})</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Cost */}
                    <div>
                      <Label className="text-xs">Your Cost (USD)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="e.g., 25.00"
                        value={cost}
                        onChange={(e) => setCost(e.target.value)}
                        className="mt-1"
                      />
                    </div>

                    {/* FX Rate Display */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
                      <div>
                        <p className="text-xs text-muted-foreground">Exchange Rate</p>
                        <p className="text-sm font-semibold font-mono">
                          1 USD = {fxRate.toFixed(4)} {marketplace}
                        </p>
                        {currentFxRate?.as_of && (
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(currentFxRate.as_of), "MMM d, h:mm a")}
                          </p>
                        )}
                      </div>
                      <Button variant="outline" size="sm" onClick={refreshFxRates} disabled={fxLoading}>
                        <RefreshCw className={`h-3 w-3 ${fxLoading ? "animate-spin" : ""}`} />
                      </Button>
                    </div>

                    {/* Min ROI Slider */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">Minimum ROI Target</Label>
                        <span className="text-2xl font-bold text-primary">{minRoi[0]}%</span>
                      </div>
                      <Slider value={minRoi} onValueChange={setMinRoi} min={0} max={200} step={1} className="py-2" />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>0%</span>
                        <span>100%</span>
                        <span>200%</span>
                      </div>
                    </div>

                    <Button onClick={handleCalculateROI} disabled={loading} className="w-full shadow-md">
                      {loading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Calculating...
                        </>
                      ) : (
                        <>
                          <Calculator className="mr-2 h-4 w-4" />
                          Calculate Target Price
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right Column - Results */}
            <div className="lg:col-span-4">
              {productData?.calculation && targetPricing && (
                <Card className="border-2 border-emerald-500/30 shadow-lg overflow-hidden h-full">
                  <CardHeader className="bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-transparent py-3 px-4">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Target className="h-4 w-4 text-emerald-600" />
                      {selectedMarketplace.flag} Results
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-4">
                    {/* Target Price Hero */}
                    <div className="text-center p-4 rounded-xl bg-gradient-to-br from-emerald-500/15 to-teal-500/10 border border-emerald-500/20">
                      <p className="text-xs text-muted-foreground mb-1">
                        Required Sell Price ({minRoi[0]}% ROI)
                      </p>
                      <p className="text-3xl font-bold text-emerald-600">
                        {formatCurrency(targetPricing.targetSellPriceLocal, marketplace)}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        ≈ ${targetPricing.targetSellPriceUsd.toFixed(2)} USD
                      </p>
                    </div>

                    {/* Quick Stats Grid */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2 rounded-lg bg-muted/50 border text-center">
                        <p className="text-xs text-muted-foreground">Amazon Price</p>
                        <p className="text-sm font-semibold">{formatCurrency(targetPricing.amazonPriceLocal, marketplace)}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-muted/50 border text-center">
                        <p className="text-xs text-muted-foreground">Your Cost</p>
                        <p className="text-sm font-semibold">{formatCurrency(targetPricing.costLocal, marketplace)}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-muted/50 border text-center">
                        <p className="text-xs text-muted-foreground">Current Profit</p>
                        <p className={`text-sm font-semibold ${targetPricing.currentProfitLocal >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {formatCurrency(targetPricing.currentProfitLocal, marketplace)}
                        </p>
                      </div>
                      <div className="p-2 rounded-lg bg-muted/50 border text-center">
                        <p className="text-xs text-muted-foreground">Current ROI</p>
                        <p className={`text-sm font-semibold ${targetPricing.currentRoi >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {targetPricing.currentRoi.toFixed(1)}%
                        </p>
                      </div>
                    </div>

                    {/* Amazon Fees */}
                    <div className="space-y-2">
                      <h4 className="font-semibold text-sm flex items-center gap-2">
                        <DollarSign className="h-4 w-4 text-primary" />
                        Amazon Fees ({marketplace})
                      </h4>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between p-2 rounded bg-muted/30">
                          <span className="text-muted-foreground">Referral Fee</span>
                          <span className="font-medium">{formatCurrency(targetPricing.feesLocal.referralFee, marketplace)}</span>
                        </div>
                        <div className="flex justify-between p-2 rounded bg-muted/30">
                          <span className="text-muted-foreground">FBA Fee</span>
                          <span className="font-medium">{formatCurrency(targetPricing.feesLocal.fbaFee, marketplace)}</span>
                        </div>
                        <div className="flex justify-between p-2 rounded bg-muted/30">
                          <span className="text-muted-foreground">Closing Fee</span>
                          <span className="font-medium">{formatCurrency(targetPricing.feesLocal.variableClosingFee, marketplace)}</span>
                        </div>
                        <div className="flex justify-between p-2 rounded bg-muted/30">
                          <span className="text-muted-foreground">Other Fees</span>
                          <span className="font-medium">{formatCurrency(targetPricing.feesLocal.otherFees, marketplace)}</span>
                        </div>
                        <div className="flex justify-between p-3 rounded-lg bg-primary/10 border border-primary/20">
                          <span className="font-semibold">Total Fees</span>
                          <span className="font-bold text-primary">
                            {formatCurrency(targetPricing.feesLocal.totalFees, marketplace)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Summary */}
                    <div className="grid grid-cols-3 gap-2 pt-2 border-t">
                      <div className="text-center p-2 rounded-lg bg-emerald-500/10">
                        <p className="text-xs text-muted-foreground">Req. Profit</p>
                        <p className="text-sm font-bold text-emerald-600">
                          {formatCurrency(targetPricing.requiredProfitLocal, marketplace)}
                        </p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-blue-500/10">
                        <p className="text-xs text-muted-foreground">Target ROI</p>
                        <p className="text-sm font-bold text-blue-600">{minRoi[0]}%</p>
                      </div>
                      <div className="text-center p-2 rounded-lg bg-purple-500/10">
                        <p className="text-xs text-muted-foreground">Margin</p>
                        <p className="text-sm font-bold text-purple-600">
                          {((targetPricing.requiredProfitLocal / targetPricing.targetSellPriceLocal) * 100).toFixed(1)}%
                        </p>
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground text-center">
                      * Fees from Amazon SP-API with live FX rates
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* Placeholder when no results */}
              {productData && !productData.calculation && (
                <Card className="border-2 border-dashed border-muted-foreground/20 h-full flex items-center justify-center">
                  <CardContent className="text-center py-12">
                    <Target className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-muted-foreground">Enter cost and click Calculate</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default TargetRoiPrice;
