import { useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Search, DollarSign, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface MarketplaceFees {
  referralFeeLocal: number;
  fbaFeeLocal: number;
  totalFeesLocal: number;
  referralFeeUsd: number;
  fbaFeeUsd: number;
  totalFeesUsd: number;
  feeCurrency: string;
  feeSource: string;
}

interface MarketplacePrice {
  marketplace: string;
  marketplaceId: string;
  currency: string;
  listingPrice: number | null;
  buyBoxPrice: number | null;
  landedPrice: number | null;
  shippingPrice: number | null;
  condition: string | null;
  fxRate: number;
  listingPriceUsd: number | null;
  buyBoxPriceUsd: number | null;
  landedPriceUsd: number | null;
  fees: MarketplaceFees | null;
  error?: string;
}

interface PriceResult {
  success: boolean;
  asin: string;
  productTitle: string | null;
  fxRates: Record<string, number>;
  prices: MarketplacePrice[];
  error?: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  CAD: 'C$',
  MXN: 'MX$',
  BRL: 'R$',
};

const MARKETPLACE_FLAGS: Record<string, string> = {
  US: '🇺🇸',
  CA: '🇨🇦',
  MX: '🇲🇽',
  BR: '🇧🇷',
};

// Helper to compute proportional fees at a custom sold price
const computeAdjustedFees = (
  fees: MarketplaceFees,
  referencePrice: number,
  soldPrice: number
): MarketplaceFees => {
  // Referral is percentage-based - calculate the rate and apply to sold price
  const referralRate = referencePrice > 0 ? fees.referralFeeLocal / referencePrice : 0;
  const adjustedReferralLocal = soldPrice * referralRate;
  const fxRate = fees.referralFeeLocal > 0 ? fees.referralFeeUsd / (fees.referralFeeLocal || 1) : 1;
  
  return {
    ...fees,
    referralFeeLocal: adjustedReferralLocal,
    referralFeeUsd: adjustedReferralLocal * fxRate,
    // FBA stays fixed
    fbaFeeLocal: fees.fbaFeeLocal,
    fbaFeeUsd: fees.fbaFeeUsd,
    totalFeesLocal: adjustedReferralLocal + fees.fbaFeeLocal,
    totalFeesUsd: (adjustedReferralLocal * fxRate) + fees.fbaFeeUsd,
  };
};

const FetchListingPrice = () => {
  const [asin, setAsin] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PriceResult | null>(null);
  // Optional sold prices per marketplace (in local currency)
  const [soldPrices, setSoldPrices] = useState<Record<string, string>>({});

  const handleSearch = async () => {
    const cleanAsin = asin.trim().toUpperCase();
    if (!cleanAsin || !/^[A-Z0-9]{10}$/.test(cleanAsin)) {
      toast.error("Please enter a valid 10-character ASIN");
      return;
    }

    setLoading(true);
    setResult(null);
    setSoldPrices({});

    try {
      const { data, error } = await supabase.functions.invoke('fetch-listing-prices', {
        body: { asin: cleanAsin },
      });

      if (error) throw error;

      if (data?.success) {
        setResult(data);
      } else {
        toast.error(data?.error || "Failed to fetch prices");
      }
    } catch (err: any) {
      console.error("Error fetching prices:", err);
      toast.error(err.message || "Failed to fetch prices");
    } finally {
      setLoading(false);
    }
  };

  // Get adjusted fees for a marketplace if user entered a sold price
  const getDisplayFees = (price: MarketplacePrice): MarketplaceFees | null => {
    if (!price.fees) return null;
    
    const soldPriceStr = soldPrices[price.marketplace];
    if (soldPriceStr) {
      const soldPriceNum = parseFloat(soldPriceStr);
      if (soldPriceNum > 0 && price.listingPrice) {
        return computeAdjustedFees(price.fees, price.listingPrice, soldPriceNum);
      }
    }
    return price.fees;
  };

  const formatPrice = (price: number | null, currency: string) => {
    if (price === null) return "—";
    const symbol = CURRENCY_SYMBOLS[currency] || currency;
    return `${symbol}${price.toFixed(2)}`;
  };

  const getUsdPriceColor = (prices: MarketplacePrice[], current: MarketplacePrice) => {
    const validPrices = prices.filter(p => p.listingPriceUsd !== null).map(p => p.listingPriceUsd!);
    if (validPrices.length === 0 || current.listingPriceUsd === null) return "";
    
    const min = Math.min(...validPrices);
    const max = Math.max(...validPrices);
    
    if (current.listingPriceUsd === min) return "text-green-600 font-semibold";
    if (current.listingPriceUsd === max) return "text-red-600 font-semibold";
    return "";
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Fetch Listing Price | ArbiProSeller</title>
        <meta name="description" content="Compare Amazon listing prices across US, Canada, Mexico, and Brazil marketplaces" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4">Fetch Listing Price</h1>
          <p className="text-xl text-muted-foreground mb-8">
            Compare listing prices across all your marketplaces (US, CA, MX, BR)
          </p>
          
          {/* Search Input */}
          <div className="max-w-xl mx-auto mb-8">
            <div className="flex gap-3">
              <Input
                placeholder="Enter ASIN (e.g., B0CLLR8K8Q)"
                value={asin}
                onChange={(e) => setAsin(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="text-lg"
                maxLength={10}
              />
              <Button onClick={handleSearch} disabled={loading} size="lg">
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    <Search className="h-5 w-5 mr-2" />
                    Search
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Results */}
          {result && (
            <div className="max-w-4xl mx-auto">
              {/* Product Title */}
              {result.productTitle && (
                <Card className="mb-6">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <DollarSign className="h-5 w-5 text-primary" />
                      {result.asin}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground line-clamp-2">{result.productTitle}</p>
                  </CardContent>
                </Card>
              )}

              {/* Price Comparison Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {result.prices.map((price) => (
                  <Card 
                    key={price.marketplace} 
                    className={`${price.error ? 'border-destructive/50 bg-destructive/5' : ''}`}
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xl flex items-center gap-2">
                        <span className="text-2xl">{MARKETPLACE_FLAGS[price.marketplace]}</span>
                        {price.marketplace}
                        <span className="text-sm font-normal text-muted-foreground ml-auto">
                          {price.currency}
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {price.error ? (
                        <div className="flex items-center gap-2 text-destructive">
                          <AlertCircle className="h-4 w-4" />
                          <span className="text-sm">{price.error}</span>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {/* Listing Price with USD conversion */}
                          <div>
                            <div className="flex justify-between items-center">
                              <span className="text-sm text-muted-foreground">Listing:</span>
                              <span className="text-lg">
                                {formatPrice(price.listingPrice, price.currency)}
                              </span>
                            </div>
                            {price.listingPriceUsd !== null && price.currency !== 'USD' && (
                              <div className={`text-right text-sm ${getUsdPriceColor(result.prices, price)}`}>
                                ≈ ${price.listingPriceUsd.toFixed(2)} USD
                              </div>
                            )}
                            {price.currency === 'USD' && (
                              <div className={`text-right text-sm ${getUsdPriceColor(result.prices, price)}`}>
                                ${price.listingPriceUsd?.toFixed(2)} USD
                              </div>
                            )}
                          </div>

                          {/* Buy Box Price with USD conversion */}
                          <div>
                            <div className="flex justify-between items-center">
                              <span className="text-sm text-muted-foreground">Buy Box:</span>
                              <span className="text-lg">
                                {formatPrice(price.buyBoxPrice, price.currency)}
                              </span>
                            </div>
                            {price.buyBoxPriceUsd !== null && price.currency !== 'USD' && (
                              <div className="text-right text-sm text-muted-foreground">
                                ≈ ${price.buyBoxPriceUsd.toFixed(2)} USD
                              </div>
                            )}
                          </div>

                          {/* Landed Price */}
                          <div className="flex justify-between items-center">
                            <span className="text-sm text-muted-foreground">Landed:</span>
                            <div className="text-right">
                              <span className="text-sm">
                                {formatPrice(price.landedPrice, price.currency)}
                              </span>
                              {price.landedPriceUsd !== null && price.currency !== 'USD' && (
                                <div className="text-xs text-muted-foreground">
                                  ≈ ${price.landedPriceUsd.toFixed(2)}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Sold Price Input for Fee Adjustment */}
                          <div className="border-t pt-2 mt-2">
                            <label className="text-xs font-medium text-muted-foreground block mb-1">
                              Actual Sold Price ({price.currency}):
                            </label>
                            <Input
                              type="number"
                              placeholder={`e.g., ${price.listingPrice?.toFixed(2) || '0.00'}`}
                              value={soldPrices[price.marketplace] || ''}
                              onChange={(e) => setSoldPrices(prev => ({
                                ...prev,
                                [price.marketplace]: e.target.value
                              }))}
                              className="h-8 text-sm"
                            />
                          </div>

                          {/* Fees Section - now uses adjusted fees if sold price entered */}
                          {(() => {
                            const displayFees = getDisplayFees(price);
                            const hasSoldPrice = !!soldPrices[price.marketplace];
                            return displayFees ? (
                              <div className="border-t pt-2 mt-2 space-y-1">
                                <div className="text-xs font-medium text-muted-foreground mb-1">
                                  {hasSoldPrice ? '✓ Adjusted Fees:' : 'Estimated Fees (at listing price):'}
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                  <span className="text-muted-foreground">Referral:</span>
                                  <div className="text-right">
                                    <span className={hasSoldPrice ? 'text-green-600 font-medium' : ''}>
                                      {formatPrice(displayFees.referralFeeLocal, price.currency)}
                                    </span>
                                    {price.currency !== 'USD' && (
                                      <span className="text-xs text-muted-foreground ml-1">
                                        (${displayFees.referralFeeUsd.toFixed(2)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                  <span className="text-muted-foreground">FBA (fixed):</span>
                                  <div className="text-right">
                                    <span>{formatPrice(displayFees.fbaFeeLocal, price.currency)}</span>
                                    {price.currency !== 'USD' && (
                                      <span className="text-xs text-muted-foreground ml-1">
                                        (${displayFees.fbaFeeUsd.toFixed(2)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex justify-between items-center text-sm font-medium border-t pt-1 mt-1">
                                  <span className="text-muted-foreground">Total Fees:</span>
                                  <div className={`text-right ${hasSoldPrice ? 'text-green-600' : 'text-orange-600'}`}>
                                    <span>{formatPrice(displayFees.totalFeesLocal, price.currency)}</span>
                                    {price.currency !== 'USD' && (
                                      <span className="text-xs ml-1">
                                        (${displayFees.totalFeesUsd.toFixed(2)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : price.buyBoxPrice ? (
                              <div className="border-t pt-2 mt-2">
                                <div className="text-xs text-muted-foreground italic">
                                  Fees unavailable
                                </div>
                              </div>
                            ) : null;
                          })()}

                          {/* FX Rate indicator */}
                          {price.currency !== 'USD' && (
                            <div className="text-xs text-muted-foreground border-t pt-2 mt-2">
                              Rate: 1 USD = {price.fxRate.toFixed(4)} {price.currency}
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Summary */}
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle className="text-lg">Price Summary (USD Comparison)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-3">Marketplace</th>
                          <th className="text-right py-2 px-3">Local Price</th>
                          <th className="text-right py-2 px-3">USD Equiv.</th>
                          <th className="text-right py-2 px-3">Buy Box (USD)</th>
                          <th className="text-right py-2 px-3">Fees (USD)</th>
                          <th className="text-right py-2 px-3">FX Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.prices.map((price) => {
                          const displayFees = getDisplayFees(price);
                          const hasSoldPrice = !!soldPrices[price.marketplace];
                          return (
                            <tr key={price.marketplace} className="border-b last:border-0">
                              <td className="py-2 px-3">
                                {MARKETPLACE_FLAGS[price.marketplace]} {price.marketplace}
                                {hasSoldPrice && <span className="text-green-600 ml-1">✓</span>}
                              </td>
                              <td className="text-right py-2 px-3">
                                {price.error ? '—' : formatPrice(price.listingPrice, price.currency)}
                              </td>
                              <td className={`text-right py-2 px-3 ${getUsdPriceColor(result.prices, price)}`}>
                                {price.error || price.listingPriceUsd === null ? '—' : `$${price.listingPriceUsd.toFixed(2)}`}
                              </td>
                              <td className="text-right py-2 px-3">
                                {price.error || price.buyBoxPriceUsd === null ? '—' : `$${price.buyBoxPriceUsd.toFixed(2)}`}
                              </td>
                              <td className={`text-right py-2 px-3 ${hasSoldPrice ? 'text-green-600' : 'text-orange-600'}`}>
                                {price.error || !displayFees ? '—' : `$${displayFees.totalFeesUsd.toFixed(2)}`}
                              </td>
                              <td className="text-right py-2 px-3 text-muted-foreground">
                                {price.currency === 'USD' ? '1.0000' : price.fxRate.toFixed(4)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </main>
      
      <Footer />
    </div>
  );
};

export default FetchListingPrice;
