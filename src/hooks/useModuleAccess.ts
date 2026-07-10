import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

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

interface ModuleGrant {
  module: AppModule;
  action: AppAction;
}

interface UseModuleAccessResult {
  loading: boolean;
  isAdmin: boolean;
  grants: ModuleGrant[];
  /** Check exact module + action permission */
  can: (module: AppModule, action: AppAction) => boolean;
  /** Check if user has ANY action on a module (good for menu visibility) */
  canSeeModule: (module: AppModule) => boolean;
}

interface ModuleAccessCacheEntry {
  isAdmin: boolean;
  grants: ModuleGrant[];
}

let moduleAccessCache: { userId: string; entry: ModuleAccessCacheEntry } | null = null;

/**
 * Loads the signed-in user's module-level permissions once on mount.
 * Admins always pass every check. Everyone else needs an explicit grant
 * row in `user_module_access`.
 */
export function useModuleAccess(): UseModuleAccessResult {
  const { user, loading: authLoading } = useAuth();
  const cachedEntry = user && moduleAccessCache?.userId === user.id ? moduleAccessCache.entry : null;
  const [loading, setLoading] = useState(() => !cachedEntry);
  const [isAdmin, setIsAdmin] = useState(() => cachedEntry?.isAdmin ?? false);
  const [grants, setGrants] = useState<ModuleGrant[]>(() => cachedEntry?.grants ?? []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setIsAdmin(false);
      setGrants([]);
      setLoading(false);
      moduleAccessCache = null;
      return;
    }

    const cached = moduleAccessCache?.userId === user.id ? moduleAccessCache.entry : null;
    if (cached) {
      setIsAdmin(cached.isAdmin);
      setGrants(cached.grants);
      setLoading(false);
    }

    let cancelled = false;
    (async () => {
      if (!cached) setLoading(true);

      const [rolesRes, accessRes] = await Promise.all([
        supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', user.id)
          .eq('role', 'admin')
          .maybeSingle(),
        supabase
          .from('user_module_access')
          .select('module, action')
          .eq('user_id', user.id),
      ]);

      if (cancelled) return;

      const nextEntry = {
        isAdmin: Boolean(rolesRes.data),
        grants: (accessRes.data ?? []) as ModuleGrant[],
      };
      moduleAccessCache = { userId: user.id, entry: nextEntry };
      setIsAdmin(nextEntry.isAdmin);
      setGrants(nextEntry.grants);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  const can = (module: AppModule, action: AppAction): boolean => {
    if (isAdmin) return true;
    return grants.some((g) => g.module === module && g.action === action);
  };

  const canSeeModule = (module: AppModule): boolean => {
    if (isAdmin) return true;
    return grants.some((g) => g.module === module);
  };

  return { loading, isAdmin, grants, can, canSeeModule };
}
