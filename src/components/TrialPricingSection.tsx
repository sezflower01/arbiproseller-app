
import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Check, Zap, TrendingUp, Shield, Rocket, Clock, Gift, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

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

const FEATURES = [
  'Smart Repricing Engine',
  'Instant Repricing Speed',
  'Buy Box Optimization',
  'Conditional Repricing',
  'Price & Profit Calculator',
  'Schedule Repricing',
  'Sales Dashboard & Reports',
  'Bulk ROI Settings',
  'Download Sales Reports',
  'Multiple Users Login (10 Users)',
];

const TrialPricingSection = () => {
  const navigate = useNavigate();
  const [billingCycle, setBillingCycle] = useState<'annual' | 'monthly'>('monthly');
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [sliderIndex, setSliderIndex] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPlans = async () => {
      const { data } = await supabase
        .from('subscription_plans')
        .select('id, name, listing_limit, monthly_price, annual_price, sort_order, stripe_price_id, stripe_annual_price_id')
        .neq('id', 'unlimited')
        .order('sort_order');
      if (data) setPlans(data as PlanData[]);
      setLoading(false);
    };
    fetchPlans();
  }, []);

  const selectedPlan = plans[sliderIndex];

  const selectedPrice = selectedPlan
    ? (billingCycle === 'annual' ? selectedPlan.annual_price : selectedPlan.monthly_price)
    : 0;

  const perAsinCost = selectedPlan
    ? ((billingCycle === 'annual' ? selectedPlan.annual_price : selectedPlan.monthly_price) / selectedPlan.listing_limit).toFixed(2)
    : '0';

  if (loading || plans.length === 0) return null;

  return (
    <section id="pricing" className="py-20 bg-gradient-to-b from-[hsl(222,84%,4.9%)] to-[hsl(230,50%,8%)]">
      <div className="container mx-auto px-4 max-w-4xl">
        {/* Trial Banner */}
        <Card className="mb-8 border-green-400/30 bg-white/5 backdrop-blur-sm overflow-hidden relative">
          <div className="absolute top-0 right-0 w-32 h-32 bg-green-500/10 rounded-full -translate-y-1/2 translate-x-1/2" />
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="bg-green-500/15 rounded-xl p-3 flex-shrink-0">
                <Gift className="h-8 w-8 text-green-400" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-xl font-bold text-white">60-Day Autopilot Trial</h3>
                  <Badge className="bg-green-500 text-white text-xs">FREE</Badge>
                </div>
                <p className="text-sm text-muted-foreground mb-3">
                  Run your repricer on full autopilot for 60 days. <span className="font-semibold text-white">Choose any plan size</span> during your trial.
                </p>
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Rocket className="h-3.5 w-3.5 text-green-400" />Any plan size — up to 50K managed listings</span>
                  <span className="flex items-center gap-1.5"><Shield className="h-3.5 w-3.5 text-green-400" />Full Smart Engine</span>
                  <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-green-400" />Cancel anytime</span>
                  <span className="flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-green-400" />All marketplaces included</span>
                  <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-green-400" />Full automation — no limits during your trial</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Billing toggle */}
        <div className="flex items-center justify-between mb-6">
          <span className="text-sm font-medium text-white">Choose your plan size</span>
          <div className="flex rounded-lg border border-white/20 overflow-hidden">
            <button
              onClick={() => setBillingCycle('annual')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                billingCycle === 'annual' ? 'bg-blue-600 text-white' : 'bg-white/5 text-muted-foreground hover:bg-white/10'
              }`}
            >
              Annual <span className="text-xs opacity-80">Save ~17%</span>
            </button>
            <button
              onClick={() => setBillingCycle('monthly')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                billingCycle === 'monthly' ? 'bg-blue-600 text-white' : 'bg-white/5 text-muted-foreground hover:bg-white/10'
              }`}
            >
              Monthly
            </button>
          </div>
        </div>

        {/* Slider Pricing Card */}
        {selectedPlan && (
          <Card className="mb-8 border-blue-500/20 bg-white/5 backdrop-blur-sm shadow-lg">
            <CardContent className="p-8">
              <div className="text-center mb-8">
                <div className="text-5xl font-bold text-white mb-1">
                  ${selectedPrice}
                  <span className="text-lg font-normal text-muted-foreground"> / mo</span>
                </div>
                {billingCycle === 'annual' && (
                  <p className="text-sm text-green-600">
                    Billed ${selectedPrice * 12}/yr — save ${((selectedPlan.monthly_price - selectedPlan.annual_price) * 12).toLocaleString()}/yr
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  ${perAsinCost} per active listing / month
                </p>
              </div>

              <div className="text-center mb-4">
                <span className="text-3xl font-bold text-primary">{selectedPlan.listing_limit.toLocaleString()}</span>
                <span className="text-lg text-muted-foreground ml-2">Managed Listings</span>
              </div>

              <div className="px-4 mb-4">
                <Slider
                  min={0}
                  max={plans.length - 1}
                  step={1}
                  value={[sliderIndex]}
                  onValueChange={(v) => setSliderIndex(v[0])}
                  className="w-full"
                />
              </div>

              <div className="flex justify-between text-xs text-gray-500 px-2 mb-8">
                {plans.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => setSliderIndex(i)}
                    className={`transition-colors ${
                      i === sliderIndex ? 'text-blue-400 font-semibold' : 'hover:text-white'
                    }`}
                  >
                    {p.listing_limit >= 1000
                      ? `${(p.listing_limit / 1000).toFixed(0)}K`
                      : p.listing_limit}
                  </button>
                ))}
              </div>

              <div className="text-center">
                <Button
                  className="w-full max-w-sm"
                  onClick={() => navigate('/signup')}
                >
                  Start 60-Day Free Trial
                </Button>
                <p className="text-xs text-green-600 mt-2 font-medium">
                  60 days free — then ${selectedPrice}/mo
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* All Plans Include */}
        <Card className="border-white/10 bg-white/5 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-lg text-white flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-400" />
              All Plans Include
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Every plan uses our full Smart Repricing engine — no feature gating.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {FEATURES.map(f => (
                <div key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                  {f}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Why 60 days */}
        <Card className="mt-6 border-white/10 bg-white/5 backdrop-blur-sm">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <Clock className="h-4 w-4 text-blue-400" />
              Why 60 days?
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-muted-foreground">
              <div className="bg-white/5 rounded-lg p-3">
                <p className="font-semibold text-white mb-1">Week 1–2</p>
                <p>System learns your catalog, sets intelligent floors, and begins protecting profit.</p>
              </div>
              <div className="bg-white/5 rounded-lg p-3">
                <p className="font-semibold text-white mb-1">Week 3–4</p>
                <p>You start trusting the autopilot — fewer manual interventions, stable margins.</p>
              </div>
              <div className="bg-white/5 rounded-lg p-3">
                <p className="font-semibold text-white mb-1">Week 5–8</p>
                <p>Real results: consistent profit, no price crashes, smart adaptive pricing.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

export default TrialPricingSection;
