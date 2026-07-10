import React from 'react';
import { RefreshCw, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSalesSync } from '@/contexts/SalesSyncContext';
import { useAuth } from '@/contexts/AuthContext';
import { useSubscription } from '@/hooks/use-subscription';
import { cn } from '@/lib/utils';

const SalesSyncButton: React.FC = () => {
  const { user } = useAuth();
  const { isAdmin } = useSubscription();
  const { syncState, startBackgroundSync, isSyncing, isRecentlySynced } = useSalesSync();

  // Only show for admin users
  if (!user || !isAdmin) return null;

  const handleClick = () => {
    startBackgroundSync({ force: true });
  };

  // Format relative time
  const getRelativeTime = (date: Date | null) => {
    if (!date) return '';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  const getButtonContent = () => {
    if (isSyncing) {
      return (
        <>
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="hidden sm:inline ml-1">Syncing…</span>
        </>
      );
    }

    if (syncState.status === 'error') {
      return (
        <>
          <AlertCircle className="h-4 w-4 text-destructive" />
          <span className="hidden sm:inline ml-1">Sync Failed</span>
        </>
      );
    }

    if (syncState.status === 'success' && syncState.lastSyncAt) {
      return (
        <>
          <Check className="h-4 w-4 text-green-500" />
          <span className="hidden sm:inline ml-1">{getRelativeTime(syncState.lastSyncAt)}</span>
        </>
      );
    }

    return (
      <>
        <RefreshCw className="h-4 w-4" />
        <span className="hidden sm:inline ml-1">Sync Sales</span>
      </>
    );
  };

  const getTooltipContent = () => {
    if (isSyncing) {
      return syncState.message || 'Syncing sales data...';
    }

    if (syncState.status === 'error') {
      return `Sync failed: ${syncState.lastError || 'Unknown error'}. Click to retry.`;
    }

    if (syncState.status === 'success' && syncState.lastSyncAt) {
      const info = [];
      info.push(`Last synced: ${getRelativeTime(syncState.lastSyncAt)}`);
      if (syncState.ordersCount > 0) {
        info.push(`${syncState.ordersCount} orders`);
      }
      if (isRecentlySynced) {
        info.push('Data is fresh');
      }
      return info.join(' • ');
    }

    return 'Click to sync sales data from Amazon';
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClick}
            disabled={isSyncing}
            className={cn(
              "flex items-center gap-1 px-2",
              syncState.status === 'error' && "text-destructive hover:text-destructive",
              syncState.status === 'success' && isRecentlySynced && "text-green-600 hover:text-green-700"
            )}
          >
            {getButtonContent()}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <p>{getTooltipContent()}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default SalesSyncButton;
