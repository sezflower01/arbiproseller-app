import { Helmet } from "react-helmet-async";
import { useState } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, TrendingUp } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const MARKETPLACES = [
  { code: "US", label: "🇺🇸 United States (amazon.com)", currency: "USD", symbol: "$" },
  { code: "CA", label: "🇨🇦 Canada (amazon.ca)", currency: "CAD", symbol: "CA$" },
  { code: "MX", label: "🇲🇽 Mexico (amazon.com.mx)", currency: "MXN", symbol: "MX$" },
  { code: "BR", label: "🇧🇷 Brazil (amazon.com.br)", currency: "BRL", symbol: "R$" },
] as const;
type MarketplaceCode = typeof MARKETPLACES[number]["code"];

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
  priceHistory?: Array<{ date: string; price: number }>;
}

const RoiCalculator = () => {
  const [asin, setAsin] = useState("");
  const [cost, setCost] = useState("");
  const [marketplace, setMarketplace] = useState<MarketplaceCode>("US");
  const [loading, setLoading] = useState(false);
  const [productData, setProductData] = useState<ProductData | null>(null);

  const currentMkt = MARKETPLACES.find((m) => m.code === marketplace)!;

  const handleFetchProduct = async () => {
    if (!asin.trim()) {
      toast.error("Please enter an ASIN");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("calculate-roi", {
        body: { asin: asin.trim(), marketplace },
      });

      if (error) throw error;

      setProductData(data);
      toast.success("Product data retrieved successfully");
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
        body: { asin: productData.asin, cost: parseFloat(cost), marketplace },
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

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>ROI Calculator | ArbiProSeller</title>
        <meta name="description" content="Calculate your return on investment for Amazon FBA products" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4">ROI Calculator</h1>
          <p className="text-xl text-muted-foreground mb-8">
            Calculate your return on investment for Amazon FBA products
          </p>
          
          <div className="max-w-4xl mx-auto space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Enter Product ASIN</CardTitle>
                <CardDescription>
                  Enter an Amazon ASIN to retrieve product information
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="marketplace">Marketplace</Label>
                  <Select value={marketplace} onValueChange={(v) => { setMarketplace(v as MarketplaceCode); setProductData(null); }}>
                    <SelectTrigger id="marketplace">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MARKETPLACES.map((m) => (
                        <SelectItem key={m.code} value={m.code}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Fees and price will be fetched from Amazon {marketplace} ({currentMkt.currency}).
                  </p>
                </div>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <Label htmlFor="asin">ASIN</Label>
                    <Input
                      id="asin"
                      placeholder="e.g., B08N5WRWNW"
                      value={asin}
                      onChange={(e) => setAsin(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleFetchProduct()}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button onClick={handleFetchProduct} disabled={loading}>
                      {loading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        "Fetch Product"
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {productData && (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>Product Information</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-6">
                      <img
                        src={productData.imageUrl}
                        alt={productData.title}
                        className="w-32 h-32 object-contain border rounded"
                      />
                      <div className="flex-1 space-y-2">
                        <h3 className="font-semibold">{productData.title}</h3>
                        <p className="text-sm text-muted-foreground">ASIN: {productData.asin}</p>
                        {productData.price > 0 ? (
                          <>
                            <p className="text-lg font-bold">
                              Amazon Price: {currentMkt.symbol}{productData.price.toFixed(2)} <span className="text-xs font-normal text-muted-foreground">{currentMkt.currency}</span>
                            </p>
                            {productData.priceSource && (
                              <p className="text-xs text-muted-foreground">
                                {productData.priceSource === "buybox" && "✓ Buy Box Price"}
                                {productData.priceSource === "lowest_new" && "✓ Lowest New Offer"}
                                {productData.priceSource === "seller_offer" && "✓ Lowest Seller Offer"}
                                {productData.priceSource === "competitive_pricing" && "✓ Competitive Pricing (Lowest)"}
                                {productData.priceSource === "offer_listing" && "✓ Offer Listing (Lowest)"}
                                {productData.priceSource === "rainforest_lowest_new" && "✓ Lowest New Offer (Fallback)"}
                                {!["buybox","lowest_new","seller_offer","competitive_pricing","offer_listing","rainforest_lowest_new"].includes(productData.priceSource) && `Price source: ${productData.priceSource}`}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-sm text-amber-600 font-medium">
                            ⚠️ No price available - Product may not have active offers or is "Price higher than typical"
                          </p>
                        )}
                        <a
                          href={productData.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline text-sm"
                        >
                          View on Amazon
                        </a>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Calculate ROI</CardTitle>
                    <CardDescription>
                      Enter your product cost to calculate profitability
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-4">
                      <div className="flex-1">
                        <Label htmlFor="cost">Your Cost ({currentMkt.symbol} {currentMkt.currency})</Label>
                        <Input
                          id="cost"
                          type="number"
                          step="0.01"
                          placeholder="e.g., 25.00"
                          value={cost}
                          onChange={(e) => setCost(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleCalculateROI()}
                        />
                      </div>
                      <div className="flex items-end">
                        <Button onClick={handleCalculateROI} disabled={loading}>
                          {loading ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Calculating...
                            </>
                          ) : (
                            "Calculate"
                          )}
                        </Button>
                      </div>
                    </div>

                    {productData.calculation && (
                      <div className="mt-6 p-4 border rounded-lg bg-muted/50 space-y-3">
                        <h4 className="font-semibold text-lg mb-4">Calculation Results</h4>
                        
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-muted-foreground">Amazon Price</p>
                            <p className="text-lg font-semibold">{currentMkt.symbol}{productData.price.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">Your Cost</p>
                            <p className="text-lg font-semibold">{currentMkt.symbol}{parseFloat(cost).toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">Amazon Referral Fee</p>
                            <p className="text-lg font-semibold">{currentMkt.symbol}{productData.calculation.referralFee.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">FBA Fulfillment Fee</p>
                            <p className="text-lg font-semibold">{currentMkt.symbol}{productData.calculation.fbaFee.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">Variable Closing Fee</p>
                            <p className="text-lg font-semibold">{currentMkt.symbol}{productData.calculation.variableClosingFee.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">Other Amazon Fees</p>
                            <p className="text-lg font-semibold">{currentMkt.symbol}{productData.calculation.otherFees.toFixed(2)}</p>
                          </div>
                          <div className="col-span-2 border-t pt-3">
                            <p className="text-sm text-muted-foreground">Total Fees</p>
                            <p className="text-xl font-bold">{currentMkt.symbol}{productData.calculation.totalFees.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">Net Profit</p>
                            <p className={`text-lg font-semibold ${productData.calculation.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {currentMkt.symbol}{productData.calculation.profit.toFixed(2)}
                            </p>
                          </div>
                          <div className="col-span-2 border-t pt-3">
                            <div className="flex justify-between items-center">
                              <div>
                                <p className="text-sm text-muted-foreground">ROI</p>
                                <p className={`text-2xl font-bold ${productData.calculation.roi >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                  {productData.calculation.roi.toFixed(2)}%
                                </p>
                              </div>
                              <div>
                                <p className="text-sm text-muted-foreground">Profit Margin</p>
                                <p className={`text-2xl font-bold ${productData.calculation.margin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                  {productData.calculation.margin.toFixed(2)}%
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
                          * Fees retrieved from Amazon SP-API based on actual product category, size, and weight
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {productData.priceHistory && productData.priceHistory.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <TrendingUp className="h-5 w-5" />
                        Buy Box Price History
                      </CardTitle>
                      <CardDescription>
                        Historical Buy Box pricing over the last 90 days (Keepa-style data)
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[350px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={productData.priceHistory} margin={{ top: 5, right: 30, left: 20, bottom: 60 }}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                            <XAxis 
                              dataKey="date" 
                              tick={{ fontSize: 11 }}
                              angle={-45}
                              textAnchor="end"
                              height={80}
                            />
                            <YAxis 
                              tick={{ fontSize: 11 }}
                              label={{ value: 'Price ($)', angle: -90, position: 'insideLeft', style: { fontSize: 12 } }}
                              domain={['dataMin - 1', 'dataMax + 1']}
                            />
                            <Tooltip 
                              formatter={(value: number) => [`$${value.toFixed(2)}`, 'Buy Box Price']}
                              labelFormatter={(label) => `Date: ${label}`}
                              contentStyle={{ 
                                backgroundColor: 'hsl(var(--background))', 
                                border: '1px solid hsl(var(--border))',
                                borderRadius: '6px'
                              }}
                            />
                            <Line 
                              type="monotone" 
                              dataKey="price" 
                              stroke="hsl(var(--primary))" 
                              strokeWidth={2}
                              dot={{ r: 3, fill: 'hsl(var(--primary))' }}
                              activeDot={{ r: 5 }}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="mt-4 text-sm text-muted-foreground space-y-1">
                        <p>
                          📊 Showing {productData.priceHistory.length} price points
                        </p>
                        <p>
                          📅 From {productData.priceHistory[0]?.date} to {productData.priceHistory[productData.priceHistory.length - 1]?.date}
                        </p>
                        <p className="text-xs mt-2 pt-2 border-t">
                          * Historical data sourced from Rainforest API (similar to Keepa tracking)
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      </main>
      
      <Footer />
    </div>
  );
};

export default RoiCalculator;
