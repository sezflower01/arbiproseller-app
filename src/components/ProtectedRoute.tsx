import { Navigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useSubscription } from '@/hooks/use-subscription';
import { Loader2 } from 'lucide-react';
import { SubscriptionBanner } from '@/components/subscription/SubscriptionBanner';

function SessionCheckingScreen() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 2000);
    const t2 = setTimeout(() => setPhase(2), 5000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  const messages = [
    'Checking your secure session…',
    'Almost there — finishing sign-in…',
    'Still working — if this persists, try refreshing the page.',
  ];
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-[#0f1c3f] text-white">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm text-white/70 transition-opacity">{messages[phase]}</p>
    </div>
  );
}


// Paths an expired/locked user can still access (billing + account essentials)
const ALLOWED_WHEN_EXPIRED = [
  '/subscriptions',
  '/settings',
  '/support',
  '/contact',
  '/auth',
  '/signed-in',
];

function isAllowedWhenExpired(pathname: string) {
  return ALLOWED_WHEN_EXPIRED.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export default function ProtectedRoute({ children }: { children: JSX.Element }) {
  const { user, emailVerified, loading } = useAuth();
  const { isExpired, isAdmin, loading: subLoading } = useSubscription();
  const location = useLocation();
  const toastFiredRef = useRef(false);

  const locked = !subLoading && isExpired && !isAdmin && !isAllowedWhenExpired(location.pathname);

  useEffect(() => {
    if (locked && !toastFiredRef.current) {
      toastFiredRef.current = true;
      toast.error('Your subscription has expired. Subscribe to continue using the app.');
    }
    if (!locked) toastFiredRef.current = false;
  }, [locked]);

  if (loading) {
    return <SessionCheckingScreen />;
  }

  if (!user || !emailVerified) {
    const redirectPath = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirectPath}`} replace />;
  }

  if (locked) {
    return <Navigate to="/subscriptions" replace />;
  }

  return (
    <>
      <SubscriptionBanner />
      {children}
    </>
  );
}
