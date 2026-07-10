import { useSubscription } from '@/hooks/use-subscription';
import { AlertTriangle, Clock, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

export function SubscriptionBanner() {
  const { isTrial, isExpired, isAdmin, trialDaysRemaining, loading } = useSubscription();
  const navigate = useNavigate();

  // Admins bypass all subscription banners
  if (loading || isAdmin) return null;

  // Trial warning: show when 14 days or less remaining
  if (isTrial && trialDaysRemaining !== null && trialDaysRemaining <= 14 && trialDaysRemaining > 0) {
    return (
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 flex items-center justify-between gap-4 mx-4 mt-2">
        <div className="flex items-center gap-3">
          <Clock className="h-5 w-5 text-amber-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-200">
              Your free trial ends in {trialDaysRemaining} day{trialDaysRemaining !== 1 ? 's' : ''}
            </p>
            <p className="text-xs text-amber-300/70">
              Subscribe now to keep your repricer running without interruption.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => navigate('/subscriptions')}
          className="bg-amber-500 hover:bg-amber-600 text-black shrink-0"
        >
          <CreditCard className="h-4 w-4 mr-1" />
          Subscribe
        </Button>
      </div>
    );
  }

  // Expired: soft-lock banner
  if (isExpired) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 flex items-center justify-between gap-4 mx-4 mt-2">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-200">
              🔒 Your repricer is paused — subscription required
            </p>
            <p className="text-xs text-red-300/70">
              Your data is safe. Subscribe to resume repricing and keep winning the Buy Box.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => navigate('/subscriptions')}
          className="bg-red-500 hover:bg-red-600 text-white shrink-0"
        >
          <CreditCard className="h-4 w-4 mr-1" />
          Subscribe Now
        </Button>
      </div>
    );
  }

  return null;
}
