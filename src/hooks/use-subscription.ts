import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface SubscriptionPlan {
  id: string;
  name: string;
  listing_limit: number;
  monthly_price: number;
  annual_price: number;
  sort_order: number;
  stripe_price_id?: string;
  stripe_product_id?: string;
  stripe_annual_price_id?: string;
}

export interface UserSubscription {
  plan_id: string;
  billing_interval: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: string;
  stripe_subscription_id?: string;
  trial_end_date?: string;
}

export interface AdminOverride {
  override_enabled: boolean;
  override_plan_id: string | null;
}


export function useSubscription() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [override, setOverride] = useState<AdminOverride | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [activeListings, setActiveListings] = useState(0);
  const [marketplaceCounts, setMarketplaceCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [listingsLoading, setListingsLoading] = useState(true);

  const effectivePlanId = override?.override_enabled && override?.override_plan_id
    ? override.override_plan_id
    : subscription?.plan_id ?? 'tier_100';

  const effectivePlan = plans.find(p => p.id === effectivePlanId);

  // Trial & subscription status helpers
  const isTrial = subscription?.status === 'trial';
  const isExpired = subscription?.status === 'expired' || subscription?.status === 'cancelled' || subscription?.status === 'canceled';
  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing';
  const trialEndDate = subscription?.trial_end_date ? new Date(subscription.trial_end_date) : null;
  const trialDaysRemaining = trialEndDate ? Math.max(0, Math.ceil((trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : null;
  const canUseRepricer = isActive || (isTrial && trialDaysRemaining !== null && trialDaysRemaining > 0) || isAdmin;

  const fetchAll = async () => {
    if (!user) {
      setPlans([]);
      setSubscription(null);
      setOverride(null);
      setIsAdmin(false);
      setActiveListings(0);
      setMarketplaceCounts({});
      setLoading(false);
      setListingsLoading(false);
      return;
    }

    setLoading(true);
    setListingsLoading(true);

    try {
      const [plansRes, subRes, overrideRes, adminRes] = await Promise.all([
        supabase.from('subscription_plans').select('*').order('sort_order'),
        supabase
          .from('user_subscriptions')
          .select('plan_id, billing_interval, status, cancel_at_period_end, current_period_end, stripe_subscription_id, trial_end_date')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('admin_subscription_override')
          .select('override_enabled, override_plan_id')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle(),
      ]);

      setPlans((plansRes.data as SubscriptionPlan[]) || []);
      setSubscription((subRes.data as UserSubscription | null) || null);
      setOverride((overrideRes.data as AdminOverride | null) || null);
      setIsAdmin(!!adminRes.data);
    } catch {
      setPlans([]);
      setSubscription(null);
      setOverride(null);
      setIsAdmin(false);
      setActiveListings(0);
      setMarketplaceCounts({});
      setListingsLoading(false);
      return;
    } finally {
      setLoading(false);
    }

    try {
      const { data, error } = await supabase.rpc('get_managed_listings_counts', {
        p_user_id: user.id,
      });

      if (error || !data) {
        setActiveListings(0);
        setMarketplaceCounts({});
      } else {
        const result = data as { total: number; per_marketplace: Record<string, number> };
        setActiveListings(result.total || 0);
        setMarketplaceCounts(result.per_marketplace || {});
      }
    } catch {
      setActiveListings(0);
      setMarketplaceCounts({});
    } finally {
      setListingsLoading(false);
    }
  };

  useEffect(() => {
    void fetchAll();
  }, [user]);

  const switchOverridePlan = async (planId: string) => {
    if (!user) return;
    const { error } = await supabase
      .from('admin_subscription_override')
      .upsert({ user_id: user.id, override_enabled: true, override_plan_id: planId }, { onConflict: 'user_id' });
    if (!error) {
      setOverride({ override_enabled: true, override_plan_id: planId });
    }
    return error;
  };

  const toggleOverride = async (enabled: boolean) => {
    if (!user) return;
    const { error } = await supabase
      .from('admin_subscription_override')
      .upsert({ user_id: user.id, override_enabled: enabled, override_plan_id: override?.override_plan_id ?? 'advanced' }, { onConflict: 'user_id' });
    if (!error) {
      setOverride(prev => prev ? { ...prev, override_enabled: enabled } : { override_enabled: enabled, override_plan_id: 'advanced' });
    }
    return error;
  };

  const switchPlan = async (planId: string) => {
    if (!user) return;
    const { error } = await supabase
      .from('user_subscriptions')
      .upsert({ user_id: user.id, plan_id: planId, billing_interval: subscription?.billing_interval ?? 'monthly', status: 'active' }, { onConflict: 'user_id' });
    if (!error) {
      setSubscription(prev => prev ? { ...prev, plan_id: planId } : { plan_id: planId, billing_interval: 'monthly', status: 'active' });
    }
    return error;
  };

  return {
    plans,
    subscription,
    override,
    isAdmin,
    activeListings,
    marketplaceCounts,
    loading,
    listingsLoading,
    effectivePlanId,
    effectivePlan,
    isTrial,
    isExpired,
    isActive,
    canUseRepricer,
    trialEndDate,
    trialDaysRemaining,
    switchOverridePlan,
    toggleOverride,
    switchPlan,
    refetch: fetchAll,
  };
}
