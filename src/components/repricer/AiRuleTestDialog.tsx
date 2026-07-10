import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Loader2,
  Sparkles,
  Target,
  TrendingUp,
  TrendingDown,
  Shield,
  AlertTriangle,
  CheckCircle,
  XCircle,
  DollarSign,
  Users,
  Package,
  Zap,
} from "lucide-react";
import type { RepricerRule } from "./RuleBuilder";

interface AiRuleTestDialogProps {
  rule: RepricerRule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface TestResult {
  success: boolean;
  asin: string;
  mode: string;
  currentPrice: number | null;
  recommendedPrice: number | null;
  priceDelta: number | null;
  reason: string;
  aiAggressiveness?: number;
  aiNote?: string;
  guardsApplied: string[];
  snapshot: {
    buybox_price: number | null;
    buybox_seller_type: string | null;
    lowest_fba_price: number | null;
    lowest_fbm_price: number | null;
    lowest_overall_price: number | null;
    offers_count: number | null;
    fetched_at: string | null;
  } | null;
  context: {
    minPrice: number | null;
    maxPrice: number | null;
    undercutAmount: number;
    competeWith: {
      amazon: boolean;
      fba: boolean;
      fbm: boolean;
    };
  };
}

export default function AiRuleTestDialog({
  rule,
  open,
  onOpenChange,
}: AiRuleTestDialogProps) {
  const [asin, setAsin] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = async () => {
    if (!asin.trim() || !rule) {
      toast.error("Please enter an ASIN");
      return;
    }

    try {
      setTesting(true);
      setResult(null);
      setError(null);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // First fetch offers to ensure we have fresh data
      toast.info("Fetching competitor offers...");
      const { data: offersData, error: offersError } = await supabase.functions.invoke(
        "repricer-fetch-offers",
        {
          body: { asin: asin.trim(), marketplace: "US" },
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );

      if (offersError) {
        console.warn("Offers fetch error:", offersError);
      }

      // Run AI evaluation
      toast.info("Running AI evaluation...");
      const { data, error: evalError } = await supabase.functions.invoke(
        "repricer-ai-evaluate",
        {
          body: {
            asin: asin.trim(),
            ruleId: rule.id,
            marketplace: "US",
            testMode: true,
          },
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );

      if (evalError) throw evalError;

      if (!data.success) {
        setError(data.error || "Evaluation failed");
      } else {
        setResult(data);
      }
    } catch (err: any) {
      console.error("Test error:", err);
      setError(err.message || "Test failed");
    } finally {
      setTesting(false);
    }
  };

  const getModeIcon = (mode: string) => {
    switch (mode) {
      case "AI_REPRICE":
        return <Sparkles className="h-4 w-4 text-purple-500" />;
      case "MIN_PRICE":
        return <Shield className="h-4 w-4 text-blue-500" />;
      case "DO_NOT_REPRICE":
        return <XCircle className="h-4 w-4 text-muted-foreground" />;
      case "CUSTOM_PRICE":
        return <Target className="h-4 w-4 text-orange-500" />;
      case "SKIP":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      default:
        return <Target className="h-4 w-4" />;
    }
  };

  const getModeLabel = (mode: string) => {
    switch (mode) {
      case "AI_REPRICE":
        return "AI Repricing";
      case "MIN_PRICE":
        return "Min Price Applied";
      case "DO_NOT_REPRICE":
        return "No Change";
      case "CUSTOM_PRICE":
        return "Custom Price";
      case "SKIP":
        return "Skipped";
      default:
        return mode;
    }
  };

  const formatPrice = (price: number | null | undefined) => {
    if (price === null || price === undefined) return "N/A";
    return `$${price.toFixed(2)}`;
  };

  const formatDelta = (delta: number | null) => {
    if (delta === null) return null;
    const sign = delta > 0 ? "+" : "";
    return `${sign}$${delta.toFixed(2)}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-purple-500" />
            Test AI Rule: {rule?.name}
          </DialogTitle>
          <DialogDescription>
            Enter an ASIN to see how the AI rule would calculate a price
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* ASIN Input */}
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="test-asin" className="sr-only">
                ASIN
              </Label>
              <Input
                id="test-asin"
                placeholder="Enter ASIN (e.g., B00EXAMPLE)"
                value={asin}
                onChange={(e) => setAsin(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && runTest()}
              />
            </div>
            <Button onClick={runTest} disabled={testing || !asin.trim()}>
              {testing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Testing...
                </>
              ) : (
                "Run Test"
              )}
            </Button>
          </div>

          {/* Error Display */}
          {error && (
            <Card className="border-destructive bg-destructive/5">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-destructive">
                  <XCircle className="h-4 w-4" />
                  <span className="font-medium">Error:</span>
                  <span>{error}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Result Display */}
          {result && (
            <div className="space-y-4">
              {/* Mode & Decision */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    {getModeIcon(result.mode)}
                    Decision: {getModeLabel(result.mode)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-4">
                    {result.reason}
                  </p>

                  {/* Price Comparison */}
                  <div className="grid grid-cols-3 gap-4 p-3 bg-muted/50 rounded-lg">
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground">Current</p>
                      <p className="text-lg font-semibold">
                        {formatPrice(result.currentPrice)}
                      </p>
                    </div>
                    <div className="text-center flex flex-col items-center justify-center">
                      {result.priceDelta !== null && (
                        <div
                          className={`flex items-center gap-1 ${
                            result.priceDelta < 0
                              ? "text-green-600"
                              : result.priceDelta > 0
                              ? "text-red-600"
                              : "text-muted-foreground"
                          }`}
                        >
                          {result.priceDelta < 0 ? (
                            <TrendingDown className="h-4 w-4" />
                          ) : result.priceDelta > 0 ? (
                            <TrendingUp className="h-4 w-4" />
                          ) : null}
                          <span className="font-medium">
                            {formatDelta(result.priceDelta)}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground">
                        Recommended
                      </p>
                      <p
                        className={`text-lg font-semibold ${
                          result.recommendedPrice ? "text-purple-600" : ""
                        }`}
                      >
                        {formatPrice(result.recommendedPrice)}
                      </p>
                    </div>
                  </div>

                  {/* Guards Applied */}
                  {result.guardsApplied.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {result.guardsApplied.map((guard) => (
                        <Badge
                          key={guard}
                          variant="secondary"
                          className="text-xs"
                        >
                          <Shield className="h-3 w-3 mr-1" />
                          {guard.replace(/_/g, " ")}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Smart Engine Tuning Info */}
              {result.aiAggressiveness && (
                <Card className="border-green-500/20 bg-green-500/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Zap className="h-4 w-4 text-green-500" />
                      Smart Engine Tuning
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Aggressiveness
                        </p>
                        <p className="text-lg font-semibold text-purple-600">
                          {result.aiAggressiveness.toFixed(2)}x
                        </p>
                      </div>
                      {result.aiNote && (
                        <div className="flex-1">
                          <p className="text-sm text-muted-foreground">
                            "{result.aiNote}"
                          </p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Competitor Snapshot */}
              {result.snapshot && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      Competitor Snapshot
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Buy Box Price
                        </p>
                        <p className="font-semibold">
                          {formatPrice(result.snapshot.buybox_price)}
                        </p>
                        {result.snapshot.buybox_seller_type && (
                          <Badge variant="outline" className="text-xs mt-1">
                            {result.snapshot.buybox_seller_type}
                          </Badge>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Lowest FBA
                        </p>
                        <p className="font-semibold">
                          {formatPrice(result.snapshot.lowest_fba_price)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Lowest FBM
                        </p>
                        <p className="font-semibold">
                          {formatPrice(result.snapshot.lowest_fbm_price)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Total Offers
                        </p>
                        <p className="font-semibold flex items-center gap-1">
                          <Package className="h-4 w-4" />
                          {result.snapshot.offers_count ?? "N/A"}
                        </p>
                      </div>
                    </div>
                    {result.snapshot.fetched_at && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Fetched:{" "}
                        {new Date(result.snapshot.fetched_at).toLocaleString()}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Rule Settings Used */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Rule Settings
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Undercut Amount
                      </p>
                      <p className="font-medium">
                        ${result.context.undercutAmount.toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Min Price</p>
                      <p className="font-medium">
                        {formatPrice(result.context.minPrice)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Max Price</p>
                      <p className="font-medium">
                        {formatPrice(result.context.maxPrice)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">
                        Competing With
                      </p>
                      <div className="flex gap-1 flex-wrap mt-1">
                        {result.context.competeWith.amazon && (
                          <Badge variant="outline" className="text-xs">
                            Amazon
                          </Badge>
                        )}
                        {result.context.competeWith.fba && (
                          <Badge variant="outline" className="text-xs">
                            FBA
                          </Badge>
                        )}
                        {result.context.competeWith.fbm && (
                          <Badge variant="outline" className="text-xs">
                            FBM
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
