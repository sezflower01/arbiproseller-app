import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, Package, DollarSign, Truck, RefreshCw, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface PlanData {
  id: string;
  name: string;
  listing_limit: number;
  monthly_price: number;
  annual_price: number;
  sort_order: number;
  stripe_price_id?: string;
  stripe_annual_price_id?: string;
}

interface ChoosePlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const HIGHLIGHTS: Record<string, string> = {
  "250": "Most Popular",
  "1000": "Best Value",
};

export default function ChoosePlanDialog({ open, onOpenChange }: ChoosePlanDialogProps) {
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [loading, setLoading] = useState(true);
  const [billingCycle, setBillingCycle] = useState<"annual" | "monthly">("monthly");
  const [checkoutLoadingId, setCheckoutLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const fetchPlans = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("subscription_plans")
        .select("id, name, listing_limit, monthly_price, annual_price, sort_order, stripe_price_id, stripe_annual_price_id")
        .neq("id", "unlimited")
        .order("sort_order");
      if (data) setPlans(data as PlanData[]);
      setLoading(false);
    };
    fetchPlans();
  }, [open]);

  const sorted = useMemo(() => [...plans].sort((a, b) => a.sort_order - b.sort_order), [plans]);

  const handleSubscribe = async (plan: PlanData) => {
    const priceId = billingCycle === "annual" ? plan.stripe_annual_price_id : plan.stripe_price_id;
    if (!priceId) {
      toast.error("This plan is not yet available for purchase");
      return;
    }
    setCheckoutLoadingId(plan.id);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout", {
        body: { price_id: priceId },
      });
      if (error) throw error;
      if (data?.updated) {
        toast.success(`Subscription updated to ${plan.name}`);
        onOpenChange(false);
        return;
      }
      if (data?.url) {
        window.open(data.url, "_blank");
        toast.success("Stripe checkout opened in a new tab");
      }
    } catch (err: any) {
      console.error("Checkout error:", err);
      toast.error(err.message || "Failed to start checkout");
    } finally {
      setCheckoutLoadingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto bg-[hsl(222,84%,4.9%)] border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-2xl">Choose your subscription plan</DialogTitle>
          <DialogDescription className="text-gray-400">
            Every plan unlocks the full Inventory S.P.R.I.N.T. platform — pick the size that fits your catalog.
          </DialogDescription>
        </DialogHeader>

        {/* What's included */}
        <div className="rounded-xl border border-blue-500/20 bg-gradient-to-br from-blue-500/10 to-purple-500/5 p-5 my-4">
          <div className="flex items-center gap-2 mb-4">
            <Check className="h-4 w-4 text-green-400" />
            <h3 className="text-sm font-semibold text-white uppercase tracking-wide">
              All plans include the complete platform
            </h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: Package, color: "text-blue-400", title: "Inventory", count: "5 modules",
                items: ["Inventory Valuation", "Inventory Write-Off", "Disposition Management", "Product Library", "Create Listing"],
              },
              {
                icon: DollarSign, color: "text-green-400", title: "Finance & Accounting", count: "4 modules",
                items: ["Profit & Loss", "Settlement", "My Expenses", "Shipment P&L"],
              },
              {
                icon: Truck, color: "text-amber-400", title: "Shipments & Logistics", count: "3 modules",
                items: ["FBA Shipment Builder", "Shipment Tracking", "Label Printing"],
              },
              {
                icon: RefreshCw, color: "text-purple-400", title: "Repricing & Pricing", count: "1 module",
                items: ["Smart Repricer (full automation)"],
              },
              {
                icon: Search, color: "text-pink-400", title: "Sourcing & Research", count: "2 modules",
                items: ["Scan History", "Need to Buy Again"],
              },
            ].map((cat) => {
              const Icon = cat.icon;
              return (
                <div key={cat.title} className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <Icon className={cn("h-4 w-4", cat.color)} />
                      <span className="text-sm font-semibold text-white">{cat.title}</span>
                    </div>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-white/20 text-gray-400">
                      {cat.count}
                    </Badge>
                  </div>
                  <ul className="space-y-1">
                    {cat.items.map((item) => (
                      <li key={item} className="flex items-start gap-1.5 text-xs text-gray-300">
                        <Check className="h-3 w-3 text-green-400 mt-0.5 flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-center text-gray-400 mt-4">
            ✨ No feature gating — every plan gets the entire suite. Plans differ only by managed-listing size.
          </p>
        </div>

        {/* Billing toggle */}
        <div className="flex justify-center my-4">
          <div className="flex rounded-lg border border-white/20 overflow-hidden">
            <button
              onClick={() => setBillingCycle("annual")}
              className={cn(
                "px-5 py-2 text-sm font-medium transition-colors",
                billingCycle === "annual" ? "bg-blue-600 text-white" : "bg-white/5 text-gray-400 hover:bg-white/10"
              )}
            >
              Annual <span className="text-xs opacity-80 ml-1">Save ~18%</span>
            </button>
            <button
              onClick={() => setBillingCycle("monthly")}
              className={cn(
                "px-5 py-2 text-sm font-medium transition-colors",
                billingCycle === "monthly" ? "bg-blue-600 text-white" : "bg-white/5 text-gray-400 hover:bg-white/10"
              )}
            >
              Monthly
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 py-2">
            {sorted.map((plan) => {
              const price = billingCycle === "annual" ? plan.annual_price : plan.monthly_price;
              const annualBilled = plan.annual_price * 12;
              const perAsin = (price / plan.listing_limit).toFixed(2);
              const highlight = HIGHLIGHTS[String(plan.listing_limit)];
              const isPopular = highlight === "Most Popular";
              const isBestValue = highlight === "Best Value";

              return (
                <div
                  key={plan.id}
                  className={cn(
                    "relative rounded-xl border bg-white/5 backdrop-blur-sm p-5 flex flex-col",
                    isPopular && "border-blue-500/60 ring-1 ring-blue-500/40",
                    isBestValue && "border-green-500/60 ring-1 ring-green-500/40",
                    !highlight && "border-white/10"
                  )}
                >
                  {highlight && (
                    <Badge
                      className={cn(
                        "absolute -top-2 left-1/2 -translate-x-1/2 text-[10px]",
                        isPopular ? "bg-blue-600" : "bg-green-600"
                      )}
                    >
                      {highlight}
                    </Badge>
                  )}

                  <div className="text-center mb-3">
                    <h3 className="text-lg font-bold text-white">{plan.name}</h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {plan.listing_limit.toLocaleString()} listings
                    </p>
                  </div>

                  <div className="text-center mb-3">
                    <div className="text-3xl font-bold text-white">
                      ${price}
                      <span className="text-sm font-normal text-gray-400">/mo</span>
                    </div>
                    {billingCycle === "annual" && (
                      <p className="text-xs text-green-400 mt-1">Billed ${annualBilled.toLocaleString()}/yr</p>
                    )}
                    <p className="text-[11px] text-gray-500 mt-0.5">${perAsin} per active listing</p>
                  </div>

                  <Button
                    className="w-full mt-auto"
                    disabled={checkoutLoadingId !== null}
                    onClick={() => handleSubscribe(plan)}
                  >
                    {checkoutLoadingId === plan.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Start 60-Day Free Trial"
                    )}
                  </Button>
                  <p className="text-[10px] text-center text-gray-500 mt-2">
                    No card required • Cancel anytime
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
