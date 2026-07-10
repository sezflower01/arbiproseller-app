import { useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendingUp, Calculator, BarChart3, Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Category-specific constants for sales estimation
// Based on industry research and marketplace data
const CATEGORY_CONSTANTS: Record<string, { a: number; b: number; name: string }> = {
  "books": { a: 200000, b: 0.85, name: "Books" },
  "electronics": { a: 120000, b: 0.80, name: "Electronics" },
  "home-kitchen": { a: 150000, b: 0.82, name: "Home & Kitchen" },
  "toys-games": { a: 100000, b: 0.78, name: "Toys & Games" },
  "clothing": { a: 180000, b: 0.83, name: "Clothing & Accessories" },
  "sports-outdoors": { a: 90000, b: 0.77, name: "Sports & Outdoors" },
  "health-personal": { a: 130000, b: 0.81, name: "Health & Personal Care" },
  "beauty": { a: 110000, b: 0.79, name: "Beauty" },
  "grocery": { a: 80000, b: 0.75, name: "Grocery & Gourmet" },
  "pet-supplies": { a: 70000, b: 0.74, name: "Pet Supplies" },
  "baby": { a: 85000, b: 0.76, name: "Baby" },
  "office": { a: 95000, b: 0.78, name: "Office Products" },
  "tools": { a: 75000, b: 0.73, name: "Tools & Home Improvement" },
  "automotive": { a: 65000, b: 0.72, name: "Automotive" },
  "garden": { a: 60000, b: 0.71, name: "Patio, Lawn & Garden" },
  "general": { a: 100000, b: 0.78, name: "General / Other" },
};

const MARKETPLACES = [
  { id: "US", name: "United States" },
  { id: "CA", name: "Canada" },
  { id: "MX", name: "Mexico" },
  { id: "UK", name: "United Kingdom" },
  { id: "DE", name: "Germany" },
];

// Marketplace multipliers (relative to US)
const MARKETPLACE_MULTIPLIERS: Record<string, number> = {
  "US": 1.0,
  "CA": 0.12,
  "MX": 0.08,
  "UK": 0.35,
  "DE": 0.30,
};

function estimateMonthlySales(bsr: number, category: string, marketplace: string): number {
  const constants = CATEGORY_CONSTANTS[category] || CATEGORY_CONSTANTS["general"];
  const multiplier = MARKETPLACE_MULTIPLIERS[marketplace] || 1.0;
  
  // Power law formula: Sales = A × BSR^(-B)
  const baseSales = constants.a * Math.pow(bsr, -constants.b);
  return Math.round(baseSales * multiplier);
}

function getSalesRange(sales: number): { low: number; high: number } {
  // ±30% variance for estimation range
  return {
    low: Math.round(sales * 0.7),
    high: Math.round(sales * 1.3),
  };
}

const BsrSalesEstimator = () => {
  const [bsr, setBsr] = useState<string>("");
  const [category, setCategory] = useState<string>("general");
  const [marketplace, setMarketplace] = useState<string>("US");
  const [result, setResult] = useState<{ sales: number; range: { low: number; high: number } } | null>(null);

  const handleCalculate = () => {
    const bsrNum = parseInt(bsr, 10);
    if (isNaN(bsrNum) || bsrNum < 1) {
      return;
    }
    
    const sales = estimateMonthlySales(bsrNum, category, marketplace);
    const range = getSalesRange(sales);
    setResult({ sales, range });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCalculate();
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>BSR to Sales Estimator | ArbiProSeller</title>
        <meta name="description" content="Estimate Amazon sales volume from Best Seller Rank (BSR). Free tool for Amazon sellers to forecast monthly sales by category and marketplace." />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            {/* Header */}
            <div className="text-center mb-10">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
                <TrendingUp className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-4xl font-bold mb-3">BSR → Sales Estimator</h1>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Estimate monthly sales volume from Amazon's Best Seller Rank. 
                Results are based on category-specific algorithms and marketplace data.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Input Card */}
              <Card className="border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calculator className="w-5 h-5 text-primary" />
                    Enter BSR Details
                  </CardTitle>
                  <CardDescription>
                    Provide the BSR, category, and marketplace to estimate sales
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="bsr" className="flex items-center gap-2">
                      Best Seller Rank (BSR)
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <Info className="w-4 h-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p>The BSR can be found on any Amazon product page under "Product Details" or "Product Information".</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </Label>
                    <Input
                      id="bsr"
                      type="number"
                      placeholder="e.g., 5000"
                      value={bsr}
                      onChange={(e) => setBsr(e.target.value)}
                      onKeyPress={handleKeyPress}
                      min="1"
                      className="text-lg"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="category">Product Category</Label>
                    <Select value={category} onValueChange={setCategory}>
                      <SelectTrigger id="category">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(CATEGORY_CONSTANTS).map(([key, val]) => (
                          <SelectItem key={key} value={key}>
                            {val.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="marketplace">Marketplace</Label>
                    <Select value={marketplace} onValueChange={setMarketplace}>
                      <SelectTrigger id="marketplace">
                        <SelectValue placeholder="Select marketplace" />
                      </SelectTrigger>
                      <SelectContent>
                        {MARKETPLACES.map((mp) => (
                          <SelectItem key={mp.id} value={mp.id}>
                            {mp.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <Button 
                    onClick={handleCalculate} 
                    className="w-full mt-4"
                    size="lg"
                    disabled={!bsr || parseInt(bsr) < 1}
                  >
                    <BarChart3 className="w-4 h-4 mr-2" />
                    Estimate Sales
                  </Button>
                </CardContent>
              </Card>

              {/* Results Card */}
              <Card className="border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-primary" />
                    Sales Estimate
                  </CardTitle>
                  <CardDescription>
                    Estimated monthly sales based on BSR
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {result ? (
                    <div className="space-y-6">
                      <div className="text-center p-6 bg-primary/5 rounded-xl border border-primary/20">
                        <p className="text-sm text-muted-foreground mb-2">Estimated Monthly Sales</p>
                        <p className="text-5xl font-bold text-primary">{result.sales.toLocaleString()}</p>
                        <p className="text-sm text-muted-foreground mt-2">units per month</p>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="text-center p-4 bg-muted/50 rounded-lg">
                          <p className="text-xs text-muted-foreground mb-1">Low Estimate</p>
                          <p className="text-2xl font-semibold">{result.range.low.toLocaleString()}</p>
                        </div>
                        <div className="text-center p-4 bg-muted/50 rounded-lg">
                          <p className="text-xs text-muted-foreground mb-1">High Estimate</p>
                          <p className="text-2xl font-semibold">{result.range.high.toLocaleString()}</p>
                        </div>
                      </div>

                      <div className="text-center p-4 bg-muted/30 rounded-lg space-y-1">
                        <p className="text-sm">
                          <span className="text-muted-foreground">Category:</span>{" "}
                          <span className="font-medium">{CATEGORY_CONSTANTS[category]?.name}</span>
                        </p>
                        <p className="text-sm">
                          <span className="text-muted-foreground">Marketplace:</span>{" "}
                          <span className="font-medium">{MARKETPLACES.find(m => m.id === marketplace)?.name}</span>
                        </p>
                        <p className="text-sm">
                          <span className="text-muted-foreground">BSR:</span>{" "}
                          <span className="font-medium">#{parseInt(bsr).toLocaleString()}</span>
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                        <TrendingUp className="w-8 h-8 text-muted-foreground" />
                      </div>
                      <p className="text-muted-foreground">
                        Enter a BSR and click "Estimate Sales" to see the results
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Info Section */}
            <Card className="mt-6 border-border/50">
              <CardContent className="pt-6">
                <div className="flex gap-3">
                  <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                  <div className="text-sm text-muted-foreground space-y-2">
                    <p>
                      <strong className="text-foreground">How it works:</strong> This tool uses a power-law algorithm 
                      that models the relationship between BSR and sales. Lower BSR = higher sales.
                    </p>
                    <p>
                      <strong className="text-foreground">Accuracy:</strong> Estimates are approximations based on 
                      category-specific data. Actual sales can vary by ±30% or more depending on seasonality, 
                      competition, and other factors.
                    </p>
                    <p>
                      <strong className="text-foreground">Tip:</strong> Use this alongside actual product research 
                      tools for more accurate forecasting.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      
      <Footer />
    </div>
  );
};

export default BsrSalesEstimator;
