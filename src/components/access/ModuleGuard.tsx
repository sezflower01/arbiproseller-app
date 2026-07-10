import { ReactNode, useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useModuleAccess, type AppModule, type AppAction } from '@/hooks/useModuleAccess';
import { Card } from '@/components/ui/card';
import { Lock } from 'lucide-react';

interface ModuleGuardProps {
  module: AppModule;
  /** If omitted, only checks that user has ANY action on the module */
  action?: AppAction;
  children: ReactNode;
  /** What to render when access is denied. Defaults to a friendly card. */
  fallback?: ReactNode;
  /** If set, redirect to this path instead of showing fallback */
  redirectTo?: string;
  /** If set together with redirectTo, fires this toast once before redirect. */
  redirectToast?: string;
}

/**
 * Wrap any route or component to enforce module-level access.
 *
 * Examples:
 *   <ModuleGuard module="personalhour" redirectTo="/tools" redirectToast="Access restricted">
 *     <PersonalHourPage />
 *   </ModuleGuard>
 *   <ModuleGuard module="repricer" action="run"><RunButton /></ModuleGuard>
 */
export function ModuleGuard({
  module,
  action,
  children,
  fallback,
  redirectTo,
  redirectToast,
}: ModuleGuardProps) {
  const { loading, can, canSeeModule } = useModuleAccess();
  const toastFiredRef = useRef(false);

  const allowed = !loading && (action ? can(module, action) : canSeeModule(module));
  const willRedirect = !loading && !allowed && !!redirectTo;

  useEffect(() => {
    if (willRedirect && redirectToast && !toastFiredRef.current) {
      toastFiredRef.current = true;
      toast.error(redirectToast);
    }
  }, [willRedirect, redirectToast]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        Checking access…
      </div>
    );
  }

  if (allowed) return <>{children}</>;

  if (redirectTo) return <Navigate to={redirectTo} replace />;

  if (fallback) return <>{fallback}</>;

  return (
    <div className="flex items-center justify-center p-8">
      <Card className="max-w-md p-6 text-center">
        <Lock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-semibold">Access restricted</h2>
        <p className="text-sm text-muted-foreground">
          You don't have permission to access this section. Contact an administrator
          if you believe this is a mistake.
        </p>
      </Card>
    </div>
  );
}
