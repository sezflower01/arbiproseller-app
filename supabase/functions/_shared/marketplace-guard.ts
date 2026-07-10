/**
 * Server-side marketplace guard for edge functions.
 * 
 * Ensures non-admin users can only operate on their home marketplace.
 * Admins bypass all marketplace restrictions.
 * 
 * Usage in edge functions:
 *   const guard = await checkMarketplaceAccess(supabase, userId, requestedMarketplace);
 *   if (!guard.allowed) return new Response(JSON.stringify({ error: guard.reason }), { status: 403 });
 */

export interface MarketplaceGuardResult {
  allowed: boolean;
  reason?: string;
  homeMarketplace: string;
  homeCurrency: string;
  isAdmin: boolean;
}

/**
 * Check if a user is allowed to access a specific marketplace.
 * 
 * Rules:
 * - Admins can access any marketplace
 * - Non-admins can only access their home marketplace
 * 
 * Resolution order for home marketplace:
 * 1. repricer_settings.primary_marketplace
 * 2. Fallback: "US"
 */
export async function checkMarketplaceAccess(
  supabase: any,
  userId: string,
  requestedMarketplace: string,
): Promise<MarketplaceGuardResult> {
  // Fetch admin status and settings in parallel
  const [adminRes, settingsRes] = await Promise.all([
    supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .maybeSingle(),
    supabase
      .from('repricer_settings')
      .select('primary_marketplace, home_currency')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  const isAdmin = !!adminRes.data;
  const homeMarketplace = settingsRes.data?.primary_marketplace || 'US';
  const homeCurrency = settingsRes.data?.home_currency || 'USD';

  // Admins can access any marketplace
  if (isAdmin) {
    return { allowed: true, homeMarketplace, homeCurrency, isAdmin };
  }

  // Non-admins: only their home marketplace
  if (requestedMarketplace !== homeMarketplace) {
    return {
      allowed: false,
      reason: `MARKETPLACE_ACCESS_DENIED: User is restricted to ${homeMarketplace}. Requested: ${requestedMarketplace}`,
      homeMarketplace,
      homeCurrency,
      isAdmin,
    };
  }

  return { allowed: true, homeMarketplace, homeCurrency, isAdmin };
}

/**
 * Lightweight check: is this user an admin?
 * Use when you don't need the full marketplace guard.
 */
export async function isUserAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .maybeSingle();
  return !!data;
}
