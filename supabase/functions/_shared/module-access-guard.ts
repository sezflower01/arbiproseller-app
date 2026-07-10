/**
 * Server-side module-permission guard for edge functions.
 *
 * Mirrors the client-side useModuleAccess hook so frontend visibility and
 * backend enforcement use the same source of truth: the SQL function
 * public.has_module_access(user_id, module, action).
 *
 * Precedence:
 *   1. Admins (user_roles.role = 'admin') always pass.
 *   2. Otherwise, user must have a matching row in user_module_access.
 *
 * Usage:
 *   const guard = await checkModuleAccess(supabase, userId, 'personalhour', 'view');
 *   if (!guard.allowed) {
 *     return new Response(JSON.stringify({ error: guard.reason }), {
 *       status: 403,
 *       headers: { ...corsHeaders, 'Content-Type': 'application/json' },
 *     });
 *   }
 */

export type AppModule =
  | 'repricer'
  | 'inventory'
  | 'reports'
  | 'supplier_discovery'
  | 'product_library'
  | 'personalhour'
  | 'settings'
  | 'admin_panel'
  | 'fba_builder'
  | 'profit_loss'
  | 'buy_again'
  | 'still_thinking'
  | 'mobile_live_sales'
  | 'mobile_inventory_valuation'
  | 'upc_scanner'
  | 'scan_history';

export type AppAction = 'view' | 'run' | 'edit' | 'admin';

export interface ModuleAccessResult {
  allowed: boolean;
  isAdmin: boolean;
  reason?: string;
}

/**
 * Authoritative permission check. Calls the SQL helper so logic stays in one
 * place. Service-role client is required (RLS would otherwise block the
 * lookup against another user's rows when admin acts on behalf of someone).
 */
export async function checkModuleAccess(
  supabase: any,
  userId: string,
  module: AppModule,
  action: AppAction,
): Promise<ModuleAccessResult> {
  if (!userId) {
    return { allowed: false, isAdmin: false, reason: 'MODULE_ACCESS_DENIED: missing user' };
  }

  // Admin shortcut + RPC fallback (kept resilient if RPC ever fails)
  const [adminRes, rpcRes] = await Promise.all([
    supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .maybeSingle(),
    supabase.rpc('has_module_access', {
      _user_id: userId,
      _module: module,
      _action: action,
    }),
  ]);

  const isAdmin = !!adminRes.data;
  if (isAdmin) return { allowed: true, isAdmin: true };

  if (rpcRes.error) {
    console.warn('[module-access-guard] RPC error, falling back to direct lookup:', rpcRes.error.message);
    const { data } = await supabase
      .from('user_module_access')
      .select('action')
      .eq('user_id', userId)
      .eq('module', module)
      .eq('action', action)
      .maybeSingle();
    if (data) return { allowed: true, isAdmin: false };
    return {
      allowed: false,
      isAdmin: false,
      reason: `MODULE_ACCESS_DENIED: missing ${module}:${action}`,
    };
  }

  if (rpcRes.data === true) return { allowed: true, isAdmin: false };

  return {
    allowed: false,
    isAdmin: false,
    reason: `MODULE_ACCESS_DENIED: missing ${module}:${action}`,
  };
}

/**
 * Resolve a userId from the incoming Authorization header. Returns null if
 * the request is unauthenticated or the token is invalid.
 */
export async function getUserIdFromAuth(
  supabase: any,
  authHeader: string | null,
): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}
