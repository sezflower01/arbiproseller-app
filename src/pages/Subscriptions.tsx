import { useState, useMemo, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Check, Zap, ArrowLeft, TrendingUp, Shield, ShieldCheck, Rocket, Clock, Gift, ChevronRight, Loader2, XCircle, Globe, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import { useSubscription } from '@/hooks/use-subscription';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

const CANCELLATION_REASONS = [
  'Too expensive for my current volume',
  'Switching to another repricing tool',
  'Not enough features for my needs',
  'I stopped selling on Amazon',
  'Technical issues or bugs',
  'Customer support experience',
  'Just testing — not ready to commit yet',
  'Other',
];

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

const Subscriptions = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [billingCycle, setBillingCycle] = useState<'annual' | 'monthly'>('monthly');
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const {
    plans, subscription, override, isAdmin, activeListings, marketplaceCounts,
    loading, listingsLoading, effectivePlanId, effectivePlan,
    switchOverridePlan, toggleOverride, switchPlan, refetch,
  } = useSubscription();

  // Stripe subscription state
  const [stripeStatus, setStripeStatus] = useState<{
    subscribed: boolean;
    status?: string;
    price_id?: string;
    product_id?: string;
    subscription_end?: string;
    trial_end?: string;
    subscription_id?: string;
  } | null>(null);
  const [stripeLoading, setStripeLoading] = useState(true);
  const [connectedMarketplaces, setConnectedMarketplaces] = useState<string[]>([]);

  const MARKETPLACE_NAMES: Record<string, string> = {
    ATVPDKIKX0DER: '🇺🇸 US', A2EUQ1WTGCTBG2: '🇨🇦 CA', A1AM78C64UM0Y8: '🇲🇽 MX',
    A2Q3Y263D00KWC: '🇧🇷 BR', A1F83G8C2ARO7P: '🇬🇧 UK', A1PA6795UKMFR9: '🇩🇪 DE',
    A13V1IB3VIYZZH: '🇫🇷 FR', APJ6JRA9NG5V4: '🇮🇹 IT', A1RKKUPIHCS9HS: '🇪🇸 ES',
    A1805IZSGTT6HS: '🇳🇱 NL', A2NODRKZP88ZB9: '🇸🇪 SE', A1C3SOZRARQ6R3: '🇵🇱 PL',
    A39IBJ37TRP1C6: '🇦🇺 AU', A1VC38T7YXB528: '🇯🇵 JP', A21TJRUUN4KGV: '🇮🇳 IN',
    A19VAU5U5O7RUS: '🇸🇬 SG', A2VIGQ35RCS4UG: '🇦🇪 AE', A17E79C6D8DWNP: '🇸🇦 SA',
  };

  const fetchStripeStatus = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        console.warn('No auth session for check-subscription');
        setStripeLoading(false);
        return;
      }
      const { data, error } = await supabase.functions.invoke('check-subscription', {});
      console.log('check-subscription response:', { data, error });
      if (error) throw error;
      setStripeStatus(data);
    } catch (err) {
      console.error('Failed to check Stripe subscription:', err);
    } finally {
      setStripeLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStripeStatus().then(() => refetch());
  }, [fetchStripeStatus]);

  // Auto-refresh subscription status when user returns to this tab
  // (e.g. after completing checkout in the Stripe tab)
  useEffect(() => {
    const onFocus = () => {
      fetchStripeStatus().then(() => refetch());
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onFocus();
    });
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchStripeStatus, refetch]);

  // Fetch connected marketplaces
  useEffect(() => {
    const fetchMarketplaces = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('seller_authorizations')
        .select('marketplace_id')
        .eq('user_id', user.id);
      if (data) {
        setConnectedMarketplaces(data.map(d => d.marketplace_id));
      }
    };
    fetchMarketplaces();
  }, [user]);

  const handleStartCheckout = async (stripePriceId: string, planName: string) => {
    if (!stripePriceId) {
      toast.error('This plan is not yet available for purchase');
      return;
    }
    setCheckoutLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { price_id: stripePriceId },
      });
      if (error) throw error;
      if (data?.updated) {
        toast.success(`Subscription updated to ${planName}`);
        fetchStripeStatus();
        return;
      }
      if (data?.url) {
        window.open(data.url, '_blank');
        toast.success('Stripe checkout opened in a new tab');
      }
    } catch (err: any) {
      console.error('Checkout error:', err);
      toast.error(err.message || 'Failed to start checkout');
    } finally {
      setCheckoutLoading(false);
    }
  };

  const displayPlans = useMemo(() => plans.filter(p => p.id !== 'unlimited').sort((a, b) => a.sort_order - b.sort_order), [plans]);
  const [sliderIndex, setSliderIndex] = useState<number | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelDetails, setCancelDetails] = useState('');
  const [cancelLoading, setCancelLoading] = useState(false);

  const handleCancelSubscription = async () => {
    if (!cancelReason) {
      toast.error('Please select a reason for cancellation');
      return;
    }
    setCancelLoading(true);
    try {
      // Send feedback email
      await supabase.functions.invoke('send-email', {
        body: {
          to: 'support@inventorysprint.com',
          name: 'Subscriber',
          emailType: 'contact-form',
          inquiry: `Cancellation Reason: ${cancelReason}\n\nAdditional details: ${cancelDetails || 'None provided'}`,
        },
      });

      // Cancel via Stripe customer portal (skip for admin testing)
      if (isAdmin && !hasRealSubscription) {
        toast.success('Feedback sent successfully (admin test mode)');
      } else {
        const { data, error } = await supabase.functions.invoke('customer-portal', {});
        if (error) throw error;
        if (data?.url) {
          window.open(data.url, '_blank');
          toast.info('Stripe portal opened — complete cancellation there');
        } else {
          toast.success('Feedback sent. Please contact support to finalize cancellation.');
        }
      }
      setCancelDialogOpen(false);
      setCancelReason('');
      setCancelDetails('');
    } catch (err: any) {
      console.error('Cancel error:', err);
      toast.error(err.message || 'Failed to process cancellation');
    } finally {
      setCancelLoading(false);
    }
  };

  // Set initial slider to current plan index
  const currentPlanIndex = useMemo(() => {
    const idx = displayPlans.findIndex(p => p.id === effectivePlanId);
    return idx >= 0 ? idx : 0;
  }, [displayPlans, effectivePlanId]);

  // Minimum slider index: the lowest tier that can hold the user's active ASINs
  const minSliderIndex = useMemo(() => {
    for (let i = 0; i < displayPlans.length; i++) {
      if (displayPlans[i].listing_limit >= activeListings) return i;
    }
    return displayPlans.length - 1;
  }, [displayPlans, activeListings]);

  const activeSliderIndex = sliderIndex ?? currentPlanIndex;
  const selectedPlan = displayPlans[activeSliderIndex];

  const usagePct = effectivePlan ? Math.min((activeListings / effectivePlan.listing_limit) * 100, 100) : 0;

  const perAsinCost = selectedPlan
    ? ((billingCycle === 'annual' ? selectedPlan.annual_price : selectedPlan.monthly_price) / selectedPlan.listing_limit).toFixed(2)
    : '0';

  const selectedPrice = selectedPlan
    ? (billingCycle === 'annual' ? selectedPlan.annual_price : selectedPlan.monthly_price)
    : 0;

  const hasLocalSubscription = !!subscription && ['active', 'trialing', 'past_due'].includes(subscription.status);
  const hasRealSubscription = stripeStatus?.subscribed === true || hasLocalSubscription;
  // Trial is "used" if the user has any prior subscription record OR a trial_end_date already set.
  // Stripe backend re-verifies this authoritatively before creating the session.
  const trialAlreadyUsed = (!!subscription?.trial_end_date) || (!!subscription && !hasLocalSubscription) || (!!stripeStatus && !stripeStatus.subscribed && !!stripeStatus.subscription_end);
  const isCurrentPlan = hasRealSubscription && selectedPlan?.id === effectivePlanId;
  const isDowngrade = hasRealSubscription && selectedPlan && effectivePlan
    ? selectedPlan.sort_order < effectivePlan.sort_order
    : false;

  if (loading) {
    return (
      <div className="min-h-screen bg-[hsl(222,84%,4.9%)] text-white">
        <Navbar />
        <div className="container mx-auto px-4 py-20 text-center text-gray-400">Loading subscription…</div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[hsl(222,84%,4.9%)] text-white">
      <Navbar />
      <div className="container mx-auto px-4 py-8 max-w-4xl pt-24">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-white">My Subscription</h1>
            <p className="text-gray-400 text-sm">Pay only for active listings — inactive listings are automatically released</p>
          </div>
        </div>

        {/* Admin Override Panel */}
        {isAdmin && (
          <Card className="mb-6 border-amber-500/40 bg-amber-500/10 backdrop-blur-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-amber-600" />
                  <span className="font-semibold text-white">Admin Override</span>
                  <Badge variant="outline" className="text-amber-600 border-amber-500/40 text-xs">Admin</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-400">{override?.override_enabled ? 'Active' : 'Off'}</span>
                  <Switch
                    checked={override?.override_enabled ?? false}
                    onCheckedChange={async (checked) => {
                      const err = await toggleOverride(checked);
                      if (err) toast.error('Failed to toggle override');
                      else toast.success(checked ? 'Override activated' : 'Override deactivated');
                    }}
                  />
                </div>
              </div>
              {override?.override_enabled && (
                <Select value={override.override_plan_id ?? 'tier_1000'} onValueChange={async (val) => {
                  const err = await switchOverridePlan(val);
                  if (err) toast.error('Failed to switch');
                  else toast.success(`Override → ${plans.find(p => p.id === val)?.name}`);
                }}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name} ({p.listing_limit.toLocaleString()})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </CardContent>
          </Card>
        )}

        {/* Usage Card */}
        {effectivePlan && (
          <Card className="mb-8 border-blue-500/30 bg-blue-500/10 backdrop-blur-sm">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <span className="font-semibold text-white">Managed Listings</span>
                </div>
                <Badge variant="outline" className="text-primary border-primary/40">
                  {effectivePlan.listing_limit.toLocaleString()}&nbsp;Managed Listings
                  {override?.override_enabled && <span className="ml-1 text-amber-600">(Override)</span>}
                </Badge>
              </div>
              <Progress value={usagePct} className="h-3 mb-2" />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  <span className="font-bold text-primary">
                    {listingsLoading ? '—' : activeListings.toLocaleString()}
                  </span>
                  <span className="text-muted-foreground"> of {effectivePlan.listing_limit.toLocaleString()}</span> managed listings
                </span>
                <span className="text-gray-400">
                  {listingsLoading ? (
                    'Loading managed listings…'
                  ) : usagePct >= 100 ? (
                    <span className="text-destructive font-medium">
                      Limit reached — upgrade your plan to add more listings
                    </span>
                  ) : usagePct >= 90 ? (
                    <span className="text-amber-400 font-medium">
                      Almost full — upgrade to keep growing
                    </span>
                  ) : usagePct >= 80 ? (
                    <span className="text-amber-300/80 font-medium">
                      {(effectivePlan.listing_limit - activeListings).toLocaleString()} slots left — consider upgrading soon
                    </span>
                  ) : (
                    `${(effectivePlan.listing_limit - activeListings).toLocaleString()} listing slots available`
                  )}
                </span>
              </div>
              {!listingsLoading && Object.keys(marketplaceCounts).length > 0 && (
                <p className="text-xs text-muted-foreground/70 mt-1">
                  {Object.entries(marketplaceCounts)
                    .filter(([, count]) => count > 0)
                    .map(([mp, count]) => `${count} in ${mp}`)
                    .join(' · ')}
                </p>
              )}
            </CardContent>
          </Card>
        )}




        {/* Marketplace Growth Panel - hidden for unsubscribed users with no connections */}
        {(hasRealSubscription || connectedMarketplaces.length > 0) && (
        <Card className="mb-8 border-white/10 bg-white/5 backdrop-blur-sm">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 rounded-lg p-2">
                  <Globe className="h-5 w-5 text-primary" />
                </div>
                <div>
                  {connectedMarketplaces.length === 0 ? (
                    <>
                      <p className="text-sm font-semibold text-white">No Amazon marketplaces connected</p>
                      <p className="text-xs text-gray-400">Connect your Amazon account to activate and manage your listings</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-white">
                        {connectedMarketplaces.length} marketplace{connectedMarketplaces.length > 1 ? 's' : ''} connected
                      </p>
                      <p className="text-xs text-gray-400">
                        {connectedMarketplaces.map(mp => MARKETPLACE_NAMES[mp] || mp).join(' · ')}
                      </p>
                    </>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => navigate('/tools/amazon-connect')}
              >
                {connectedMarketplaces.length === 0 ? (
                  <>Connect Amazon Account <ChevronRight className="h-3.5 w-3.5" /></>
                ) : (
                  <><Plus className="h-3.5 w-3.5" /> Add Marketplace</>
                )}
              </Button>
            </div>
            {connectedMarketplaces.length >= 1 && connectedMarketplaces.length <= 1 && effectivePlan && usagePct < 50 && (
              <p className="text-xs text-primary/80 mt-3 pl-12">
                Connect additional Amazon marketplaces (US, CA, UK, EU) to expand your listings
              </p>
            )}
            {effectivePlan && usagePct >= 90 && (
              <p className="text-xs text-amber-400 mt-3 pl-12">
                Running out of slots? Add another marketplace or upgrade your plan to keep growing
              </p>
            )}
          </CardContent>
        </Card>
        )}

        {/* Active Subscription Status */}
        {!stripeLoading && stripeStatus?.subscribed && (
          <Card className="mb-8 border-green-500/40 bg-green-500/10 backdrop-blur-sm">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-green-500/10 rounded-lg p-2">
                    <ShieldCheck className="h-6 w-6 text-green-600" />
                  </div>
                  <div>
                    <p className="font-semibold text-white">Active Subscription</p>
                    <p className="text-sm text-gray-400">
                      Status: <Badge variant="outline" className="text-green-400 border-green-500/40 ml-1">
                        {stripeStatus.status === 'trialing' ? 'Free Trial — Full Access' : stripeStatus.status === 'active' ? 'Active' : stripeStatus.status}
                      </Badge>
                    </p>
                    {stripeStatus.trial_end && new Date(stripeStatus.trial_end) > new Date() && (
                      <p className="text-xs text-gray-400 mt-1">
                        Trial ends: <span className="font-medium text-white">{new Date(stripeStatus.trial_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                      </p>
                    )}
                    {stripeStatus.subscription_end && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        {stripeStatus.status === 'trialing' ? 'First billing' : 'Renews'}: <span className="font-medium text-white">{new Date(stripeStatus.subscription_end).toLocaleDateString()}</span>
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      const { data, error } = await supabase.functions.invoke('customer-portal', {});
                      if (error) throw error;
                      if (data?.url) window.open(data.url, '_blank');
                    } catch (err: any) {
                      toast.error(err.message || 'Failed to open portal');
                    }
                  }}
                >
                  Manage Billing <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}


        {/* Billing toggle */}
        <div className="flex items-center justify-between mb-6">
          <span className="text-sm font-medium text-white">Choose your plan size</span>
          <div className="flex rounded-lg border border-white/20 overflow-hidden">
            <button
              onClick={() => setBillingCycle('annual')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                billingCycle === 'annual' ? 'bg-blue-600 text-white' : 'bg-white/5 text-gray-400 hover:bg-white/10'
              }`}
            >
              Annual <span className="text-xs opacity-80">Save ~17%</span>
            </button>
            <button
              onClick={() => setBillingCycle('monthly')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                billingCycle === 'monthly' ? 'bg-blue-600 text-white' : 'bg-white/5 text-gray-400 hover:bg-white/10'
              }`}
            >
              Monthly
            </button>
          </div>
        </div>

        {/* SLIDER PRICING CARD */}
        {displayPlans.length > 0 && selectedPlan && (
          <Card className="mb-8 border-blue-500/20 bg-white/5 backdrop-blur-sm shadow-lg">
            <CardContent className="p-8">
              {/* Price display */}
              {(() => {
                const yearlyTotal = selectedPrice * 12;
                return (
                  <div className="text-center mb-8">
                    <div className="flex items-end justify-center gap-3 mb-1">
                      <div className="text-5xl font-bold text-white leading-none">
                        ${selectedPrice}
                        <span className="text-lg font-normal text-gray-400"> / mo</span>
                      </div>
                    </div>
                    {billingCycle === 'annual' ? (
                      <p className="text-sm text-gray-400 font-medium">
                        Billed ${yearlyTotal.toLocaleString()}/yr
                      </p>
                    ) : (
                      <p className="text-sm text-gray-400 font-medium">
                        or ${yearlyTotal.toLocaleString()}/yr
                      </p>
                    )}
                    <p className="text-xs text-gray-400 mt-2">
                      Full Inventory S.P.R.I.N.T. Suite — Repricer + Sourcing + Inventory + Listings + Analytics
                    </p>
                  </div>
                );
              })()}


              {/* Listing count display */}
              <div className="text-center mb-4">
                <span className="text-3xl font-bold text-primary">{selectedPlan.listing_limit.toLocaleString()}</span>
                <span className="text-lg text-gray-400 ml-2">Managed Listings</span>
              </div>

              {/* Slider */}
              <div className="px-4 mb-4">
                <Slider
                  min={0}
                  max={displayPlans.length - 1}
                  step={1}
                  value={[activeSliderIndex]}
                  onValueChange={(v) => setSliderIndex(Math.max(v[0], minSliderIndex))}
                  className="w-full"
                />
              </div>

              {/* Tier labels */}
              <div className="flex justify-between text-xs text-gray-500 px-2 mb-8">
                {displayPlans.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => setSliderIndex(i)}
                    className={`transition-colors ${
                      i === activeSliderIndex ? 'text-blue-400 font-semibold' : 'hover:text-white'
                    }`}
                  >
                    {p.listing_limit >= 1000
                      ? `${(p.listing_limit / 1000).toFixed(0)}K`
                      : p.listing_limit}
                  </button>
                ))}
              </div>

              {/* Action button */}
              <div className="text-center">
                {isCurrentPlan ? (
                  <Button variant="outline" className="w-full max-w-sm" disabled>
                    Current Plan
                  </Button>
                ) : isDowngrade ? (
                  <Button
                    variant="outline"
                    className="w-full max-w-sm"
                    disabled={checkoutLoading}
                    onClick={() => {
                      const priceId = billingCycle === 'annual'
                        ? (selectedPlan.stripe_annual_price_id || selectedPlan.stripe_price_id || '')
                        : (selectedPlan.stripe_price_id || '');
                      handleStartCheckout(priceId, selectedPlan.name);
                    }}
                  >
                    {checkoutLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Switch to {selectedPlan.listing_limit.toLocaleString()} Managed Listings
                  </Button>
                ) : (
                  <div>
                    <Button
                      className="w-full max-w-sm"
                      disabled={checkoutLoading}
                      onClick={() => {
                        const priceId = billingCycle === 'annual'
                          ? (selectedPlan.stripe_annual_price_id || selectedPlan.stripe_price_id || '')
                          : (selectedPlan.stripe_price_id || '');
                        handleStartCheckout(priceId, selectedPlan.name);
                      }}
                    >
                      {checkoutLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                      {trialAlreadyUsed ? 'Subscribe Now' : 'Start 60-Day Free Trial'}
                    </Button>
                    <p className="text-xs text-green-600 mt-2 font-medium">
                      {trialAlreadyUsed
                        ? `Billed immediately — $${selectedPrice}/${billingCycle === 'annual' ? 'mo (billed yearly)' : 'mo'}`
                        : `60 days free — then $${selectedPrice}/${billingCycle === 'annual' ? 'mo (billed yearly)' : 'mo'}`}

                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Key value prop */}
        <Card className="mb-8 border-white/10 bg-white/5 backdrop-blur-sm">
          <CardContent className="p-5">
            <div className="flex items-start gap-3">
              <TrendingUp className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-white mb-1">You only pay for active listings</p>
                <p className="text-xs text-gray-400">
                   Each ASIN per marketplace counts as one listing. Inactive listings are automatically released — no wasted spend on dead inventory. Unlike competitors who charge for unused rules, you only pay for listings actively managed by our Smart Engine.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* What's included */}
        <Card className="border-white/10 bg-white/5 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-lg text-white flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-400" />
              All Plans Include
            </CardTitle>
            <p className="text-sm text-gray-400">
              Every plan uses our full Smart Repricing engine — no feature gating.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {FEATURES.map(f => (
                <div key={f} className="flex items-center gap-2 text-sm text-gray-300">
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-gray-400">
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

        {/* Comparison */}
        <Card className="mt-6 border-white/10 bg-white/5 backdrop-blur-sm">
          <CardContent className="p-5">
            <h3 className="text-sm font-semibold text-white mb-3">ArbiPro vs Competitors</h3>
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div />
              <div className="text-center font-semibold text-blue-400">ArbiPro</div>
              <div className="text-center font-semibold text-gray-500">Others</div>

              <div className="text-gray-400">Pricing model</div>
              <div className="text-center text-white">Per active listing</div>
              <div className="text-center text-gray-500">Per rule slot</div>

              <div className="text-gray-400">Inactive listings</div>
              <div className="text-center text-green-400">Auto-released (free)</div>
              <div className="text-center text-red-400">Still charged</div>

              <div className="text-gray-400">Rule assignment</div>
              <div className="text-center text-white">Automatic</div>
              <div className="text-center text-gray-500">Manual setup</div>

              <div className="text-gray-400">AI repricing</div>
              <div className="text-center text-white">Included</div>
              <div className="text-center text-gray-500">Add-on / none</div>
            </div>
          </CardContent>
        </Card>

        {/* Cancel Subscription */}
        {hasRealSubscription && subscription?.status !== 'expired' && (
          <Card className="mt-6 border-red-500/30 bg-red-500/5 backdrop-blur-sm">
            <CardContent className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <XCircle className="h-5 w-5 text-destructive" />
                <div>
                  <p className="text-sm font-semibold text-white">Cancel Subscription</p>
                  <p className="text-xs text-gray-400">We'd love to know why — your feedback helps us improve.</p>
                </div>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setCancelDialogOpen(true)}>
                Cancel Subscription
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Cancel Dialog */}
        <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>We're sorry to see you go</DialogTitle>
              <DialogDescription>
                Please let us know why you're cancelling so we can improve.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <RadioGroup value={cancelReason} onValueChange={setCancelReason}>
                {CANCELLATION_REASONS.map(reason => (
                  <div key={reason} className="flex items-center space-x-2">
                    <RadioGroupItem value={reason} id={reason} />
                    <Label htmlFor={reason} className="text-sm cursor-pointer">{reason}</Label>
                  </div>
                ))}
              </RadioGroup>
              <Textarea
                placeholder="Any additional details? (optional)"
                value={cancelDetails}
                onChange={(e) => setCancelDetails(e.target.value)}
                className="resize-none"
                rows={3}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setCancelDialogOpen(false)}>
                Keep My Plan
              </Button>
              <Button variant="destructive" onClick={handleCancelSubscription} disabled={cancelLoading || !cancelReason}>
                {cancelLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Confirm Cancellation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <Footer />
    </div>
  );
};

export default Subscriptions;
